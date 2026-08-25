// Incrementally adds the bold weight to public/signatures/ WITHOUT re-rendering
// the existing regular chunk:
//   1. reads manifest.json (font order == regular.bin.gz layout — untouched)
//   2. fetches/uses .fonts-cache/<id>.bold.woff2 (:wght@700) per font
//   3. renders 62 glyphs at SIZE px with INK_THRESH (must match precompute.mjs)
//   4. writes bold.bin.gz + updates manifest.weights/chunks
// Zeroed rows keep layout alignment for fonts with no real bold; they simply
// never win best-weight scoring on the client.
//
// Usage: node scripts/precompute-bold.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { GlobalFonts, createCanvas } from '@napi-rs/canvas';
import { signatureForBox, BYTES_PER_GLYPH, CHARS } from '../src/lib/client/fingerprint-core.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CACHE = join(ROOT, '.fonts-cache');
const OUT_DIR = join(ROOT, 'public', 'signatures');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.32';
const CONCURRENCY = 6;

// Must match precompute.mjs exactly.
const SIZE = 110;
const INK_THRESH = 140;

const manifest = JSON.parse(readFileSync(join(OUT_DIR, 'manifest.json'), 'utf8'));
if (manifest.weights.includes('bold')) {
	console.log('bold chunk already present in manifest — nothing to do.');
	process.exit(0);
}

function latinWoffUrl(css) {
	const blocks = css.split('@font-face');
	for (const block of blocks) {
		if (block.includes('U+0000-00FF')) {
			const m = block.match(/url\(([^)]+)\)/);
			if (m) return m[1];
		}
	}
	const m = css.match(/url\(([^)]+)\)/);
	return m ? m[1] : null;
}

async function fetchBoldWoff(id, family) {
	const cacheFile = join(CACHE, `${id}.bold.woff2`);
	if (existsSync(cacheFile)) return cacheFile;
	try {
		const q = family.replace(/ /g, '+');
		let css = await fetch(`https://fonts.googleapis.com/css2?family=${q}:wght@700&display=swap`, {
			headers: { 'User-Agent': UA },
		}).then((r) => r.text());
		let url = latinWoffUrl(css);
		if (!url) {
			css = await fetch(`https://fonts.googleapis.com/css2?family=${q}&display=swap`, {
				headers: { 'User-Agent': UA },
			}).then((r) => r.text());
			url = latinWoffUrl(css);
		}
		if (!url) throw new Error('no-latin');
		const buf = await fetch(url).then((r) => {
			if (!r.ok) throw new Error('http ' + r.status);
			return r.arrayBuffer();
		});
		if (Buffer.from(buf.slice(0, 4)).toString('hex') !== '774f4632') throw new Error('not-woff2');
		writeFileSync(cacheFile, Buffer.from(buf));
		return cacheFile;
	} catch (err) {
		throw new Error(String(err).replace(/^Error:\s*/, '').slice(0, 80));
	}
}

// Same renderer as precompute.mjs boxForGlyph.
function renderSigs(familyKey, canvas, ctx) {
	const sigs = [];
	for (const ch of CHARS) {
		ctx.fillStyle = '#fff';
		ctx.fillRect(0, 0, 192, 192);
		ctx.font = `${SIZE}px ${familyKey}`;
		ctx.textBaseline = 'alphabetic';
		ctx.fillStyle = '#000';
		ctx.fillText(ch, 8, 150);
		const { data } = ctx.getImageData(0, 0, 192, 192);
		let minX = 192, minY = 192, maxX = -1, maxY = -1;
		for (let y = 0; y < 192; y++) {
			for (let x = 0; x < 192; x++) {
				const i = (y * 192 + x) * 4;
				if (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] < INK_THRESH) {
					if (x < minX) minX = x;
					if (x > maxX) maxX = x;
					if (y < minY) minY = y;
					if (y > maxY) maxY = y;
				}
			}
		}
		if (maxX < 0) return null; // glyph missing -> whole font row unusable
		const w = maxX - minX + 1;
		const h = maxY - minY + 1;
		const box = new Uint8ClampedArray(w * h);
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				const i = ((minY + y) * 192 + (minX + x)) * 4;
				box[y * w + x] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] < INK_THRESH ? 1 : 0;
			}
		}
		sigs.push(Buffer.from(signatureForBox(box, w, h)));
	}
	return Buffer.concat(sigs);
}

const queue = [...manifest.fonts]; // manifest order == bin layout
const rows = new Array(manifest.fonts.length).fill(null);
let idx = 0;
let okCount = 0;
const failures = [];

async function worker() {
	const canvas = createCanvas(192, 192);
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	while (queue.length) {
		const id = queue.shift();
		const fi = idx++;
		const family = manifest.families[fi];
		try {
			const file = await fetchBoldWoff(id, family);
			const key = `FFB-${id.replace(/[^a-z0-9]/gi, '')}`;
			if (!GlobalFonts.has(key)) GlobalFonts.registerFromPath(file, key);
			const buf = renderSigs(key, canvas, ctx);
			if (!buf) throw new Error('no-latin-glyphs');
			rows[fi] = buf;
			okCount++;
		} catch (err) {
			failures.push({ id, reason: String(err).slice(0, 80) });
			rows[fi] = null; // zero-filled placeholder keeps layout aligned
		}
		if (idx % 100 === 0 || idx === manifest.fonts.length) {
			console.log(`progress ${idx}/${manifest.fonts.length} ok=${okCount} fail=${failures.length}`);
		}
	}
}

const started = Date.now();
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

// Layout-safe assembly: nulls become zero rows so offsets stay exact.
const ZERO_ROW = Buffer.alloc(BYTES_PER_GLYPH * CHARS.length);
const raw = Buffer.concat(rows.map((r) => r ?? ZERO_ROW));
const gz = gzipSync(raw);
writeFileSync(join(OUT_DIR, 'bold.bin.gz'), gz);

manifest.weights.push('bold');
manifest.chunks.bold = '/signatures/bold.bin.gz';
writeFileSync(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest));

console.log(`bold: ${raw.length} raw (${(raw.length / 1024 / 1024).toFixed(2)} MB) -> ${gz.length} gz (${(gz.length / 1024).toFixed(0)} KB)`);
console.log(`ok=${okCount} zero-filled=${rows.length - okCount} in ${((Date.now() - started) / 1000).toFixed(0)}s`);
console.log('manifest updated:', manifest.weights.join('+'));
if (failures.length) {
	console.log('\nfailures (first 40):');
	for (const f of failures.slice(0, 40)) console.log(`  ${f.id}: ${f.reason}`);
}
