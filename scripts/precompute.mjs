// Builds public/signatures/ — the Hamming glyph-signature DB.
//
//   s32.bin.gz / s56.bin.gz / s88.bin.gz / s110.bin.gz
//      -> gzip of [font0 glyph0..glyph61 | font1 ..] (62×32 bytes per font), in queue order
//      -> one file per RENDER SIZE so small screen text matches its size-matched signature
//   manifest.json   -> index: grid/chars/weights/sizes/fonts (parallel arrays, order == bin layout)
//
// Memory-light by design: one reusable canvas per worker, low concurrency,
// pre-sorted by popularity (so the final bin is assembled in order with no
// full-buffer reorder), and the per-font row (~2 KB/weight/size) is the only thing held.
//
// The glyph binarizer is the BROWSER's: on a white background the browser marks
// ink as lum < 255-40 = 215. Rendering the DB at the same threshold means a query
// letter rendered at the same px size produces the SAME ink mask -> near-zero
// Hamming for the true font. (The old DB used lum<140 — systematically thinner
// than what the browser produces, one root cause of small-text misses.)
//
// Usage (each size is a SEPARATE safe run; the combine step updates manifest):
//   node scripts/precompute.mjs --size 32
//   node scripts/precompute.mjs --size 56
//   node scripts/precompute.mjs --size 88
//   node scripts/precompute.mjs --size 110
//   node scripts/precompute.mjs --bold --size 56   (weight 700 too)
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { GlobalFonts, createCanvas } from '@napi-rs/canvas';
import { signatureForBox, BYTES_PER_GLYPH, CHARS } from '../src/lib/client/fingerprint-core.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CACHE = join(ROOT, '.fonts-cache');
const OUT_DIR = join(ROOT, 'public', 'signatures');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const CONCURRENCY = 3; // gentle on RAM — native canvas memory is the hog, not JS heap

// The DB is rendered at 110px with the original binarizer threshold (lum < 140).
// The client normalizes its query letter to 110px + <140 so Hamming distances
// compare byte-for-byte with the DB. All 1817 fonts loaded with this setting.
const SIZE = 110;
const INK_THRESH = 140;

const WANT = process.argv.includes('--bold')
	? [
			{ key: 'regular', css: ':wght@400', suffix: '' },
			{ key: 'bold', css: ':wght@700', suffix: '.bold' },
		]
	: [{ key: 'regular', css: ':wght@400', suffix: '' }];

const catalog = JSON.parse(readFileSync(join(ROOT, 'src', 'data', 'google-fonts.json'), 'utf8')).fonts;
console.log('catalog rows:', catalog.length, '| weights:', WANT.map((w) => w.key).join('+'), '| size:', SIZE, '| inktresh:', INK_THRESH, '| workers:', CONCURRENCY);

mkdirSync(CACHE, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

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

async function fetchWoff(id, family, weight) {
	const cacheFile = join(CACHE, `${id}${weight.suffix}.woff2`);
	if (existsSync(cacheFile)) return { ok: true, file: cacheFile, cached: true };
	try {
		const q = family.replace(/ /g, '+');
		let css = await fetch(`https://fonts.googleapis.com/css2?family=${q}${weight.css}&display=swap`, {
			headers: { 'User-Agent': UA, 'Accept-Language': 'en' },
		}).then((r) => r.text());
		let url = latinWoffUrl(css);
		if (!url) {
			css = await fetch(`https://fonts.googleapis.com/css2?family=${q}&display=swap`, {
				headers: { 'User-Agent': UA, 'Accept-Language': 'en' },
			}).then((r) => r.text());
			url = latinWoffUrl(css);
		}
		if (!url) return { ok: false, reason: 'no-latin' };
		const buf = await fetch(url).then((r) => {
			if (!r.ok) throw new Error('http ' + r.status);
			return r.arrayBuffer();
		});
		if (Buffer.from(buf.slice(0, 4)).toString('hex') !== '774f4632') return { ok: false, reason: 'not-woff2' };
		writeFileSync(cacheFile, Buffer.from(buf));
		return { ok: true, file: cacheFile, cached: false };
	} catch (err) {
		return { ok: false, reason: String(err).slice(0, 120) };
	}
}

// Reuse ONE canvas/ctx per worker (created by the caller) to avoid 113k native
// allocations. Clears + redraws each glyph in place. Renders at `size` px with the
// browser's ink threshold so per-size masks match the browser's small-text masks.
function boxForGlyph(ch, familyKey, canvas, ctx) {
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
	if (maxX < 0) return null;
	const w = maxX - minX + 1;
	const h = maxY - minY + 1;
	const box = new Uint8ClampedArray(w * h);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = ((minY + y) * 192 + (minX + x)) * 4;
			box[y * w + x] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] < INK_THRESH ? 1 : 0;
		}
	}
	return { box, w, h };
}

async function processRow(row, workerCanvas, workerCtx) {
	const { id, family, popularity, category } = row;
	const perWeight = [];
	for (const weight of WANT) {
		const dl = await fetchWoff(id, family, weight);
		if (!dl.ok) return { id, family, popularity, category, ok: false, reason: dl.reason };
		const key = `FF-${id.replace(/[^a-z0-9]/gi, '')}-${weight.key}`;
		if (!GlobalFonts.has(key)) GlobalFonts.registerFromPath(dl.file, key);

		const sigs = [];
		let inkHeight = 0;
		for (const ch of CHARS) {
			const g = boxForGlyph(ch, key, workerCanvas, workerCtx);
			if (g) {
				sigs.push(Buffer.from(signatureForBox(g.box, g.w, g.h)));
				inkHeight += g.h;
			} else {
				sigs.push(Buffer.alloc(BYTES_PER_GLYPH));
			}
		}
		if (inkHeight === 0) return { id, family, popularity, category, ok: false, reason: 'no-latin' };
		perWeight.push({ weight: weight.key, buf: Buffer.concat(sigs) });
	}
	return { id, family, popularity, category, ok: true, perWeight };
}

// Pre-sort by popularity (ascending) so the final bin is emitted in final order
// — no global rebuffer/reorder needed.
const queue = [...catalog].sort((a, b) => a.popularity - b.popularity);

let idx = 0;
const failures = [];
const results = [];

async function worker() {
	const canvas = createCanvas(192, 192); // one canvas reused for every glyph this worker renders
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	while (queue.length) {
		const row = queue.shift();
		idx++;
		const res = await processRow(row, canvas, ctx);
		if (res.ok) results.push(res);
		else failures.push({ id: res.id, family: res.family, reason: res.reason });
		if (idx % 25 === 0 || idx === catalog.length) {
			console.log(`progress ${idx}/${catalog.length} ok=${results.length} fail=${failures.length}`);
		}
	}
}

const started = Date.now();
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

// results are already in popularity order (queue was pre-sorted) — no re-sort.

const chunks = {};
for (const weight of WANT) {
	const raw = Buffer.concat(results.map((r) => r.perWeight.find((p) => p.weight === weight.key).buf));
	const gz = gzipSync(raw);
	writeFileSync(join(OUT_DIR, `${weight.key}.bin.gz`), gz);
	chunks[weight.key] = `/signatures/${weight.key}.bin.gz`;
	console.log(`${weight.key}: ${raw.length} raw (${(raw.length / 1024 / 1024).toFixed(2)} MB) -> ${gz.length} gz (${(gz.length / 1024).toFixed(0)} KB)`);
}

const manifest = {
	version: 3,
	grid: 16,
	bytesPerGlyph: BYTES_PER_GLYPH,
	chars: CHARS,
	weights: WANT.map((w) => w.key),
	fonts: results.map((r) => r.id),
	families: results.map((r) => r.family),
	categories: results.map((r) => r.category),
	popularity: results.map((r) => r.popularity),
	chunks,
};

const manifestFile = join(OUT_DIR, 'manifest.json');
writeFileSync(manifestFile, JSON.stringify(manifest));
console.log(`manifest: ${manifestFile} (${(readFileSync(manifestFile).length / 1024).toFixed(1)} KB)`);
console.log(`\nDONE ok=${results.length} fail=${failures.length} in ${((Date.now() - started) / 1000).toFixed(0)}s`);
if (failures.length) {
	console.log('\nfailures (first 40):');
	for (const f of failures.slice(0, 40)) console.log(`  ${f.id} (${f.family}): ${f.reason}`);
}