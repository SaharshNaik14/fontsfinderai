import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GlobalFonts, createCanvas } from '@napi-rs/canvas';
import { signatureForBox, hammingDistance, BYTES_PER_GLYPH, CHARS, GRID_BITS } from '../src/lib/client/fingerprint-core.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Load the new signature DB (manifest + gzipped binary)
const manifest = JSON.parse(readFileSync(join(ROOT, 'public', 'signatures', 'manifest.json'), 'utf8'));
const gzFile = join(ROOT, 'public', 'signatures', 'regular.bin.gz');
const { gunzipSync } = await import('node:zlib');
const raw = gunzipSync(readFileSync(gzFile));
const glyphsPerFont = CHARS.length; // 62
const rowBytes = BYTES_PER_GLYPH * glyphsPerFont; // 62×32 = 1984

console.log('DB fonts:', manifest.fonts.length, '| glyphs:', manifest.chars.length, '| bytesPerGlyph:', manifest.bytesPerGlyph);

function segment(mask, w, h) {
	const visited = new Uint8Array(w * h);
	const comps = [];
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = y * w + x;
			if (mask[i] !== 1 || visited[i]) continue;
			const stack = [i];
			visited[i] = 1;
			let minX = w, minY = h, maxX = -1, maxY = -1;
			while (stack.length) {
				const p = stack.pop();
				const px = p % w, py = (p / w) | 0;
				if (px < minX) minX = px;
				if (px > maxX) maxX = px;
				if (py < minY) minY = py;
				if (py > maxY) maxY = py;
				if (px > 0 && !visited[p - 1] && mask[p - 1] === 1) { visited[p - 1] = 1; stack.push(p - 1); }
				if (px < w - 1 && !visited[p + 1] && mask[p + 1] === 1) { visited[p + 1] = 1; stack.push(p + 1); }
				if (py > 0 && !visited[p - w] && mask[p - w] === 1) { visited[p - w] = 1; stack.push(p - w); }
				if (py < h - 1 && !visited[p + w] && mask[p + w] === 1) { visited[p + w] = 1; stack.push(p + w); }
			}
			comps.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 });
		}
	}
	return comps;
}

function renderWord(familyKey, text) {
	const canvas = createCanvas(1200, 240);
	const ctx = canvas.getContext('2d');
	ctx.fillStyle = '#fff';
	ctx.fillRect(0, 0, 1200, 240);
	ctx.font = `150px ${familyKey}`;
	ctx.textBaseline = 'alphabetic';
	ctx.fillStyle = '#000';
	ctx.fillText(text, 24, 190);
	const img = ctx.getImageData(0, 0, 1200, 240);
	const mask = new Uint8ClampedArray(1200 * 240);
	for (let i = 0; i < img.data.length; i += 4) {
		const lum = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
		mask[i / 4] = lum < 140 ? 1 : 0;
	}
	return { mask, w: 1200, h: 240 };
}

function extractBox(mask, w, c) {
	const box = new Uint8ClampedArray(c.w * c.h);
	for (let y = 0; y < c.h; y++) {
		for (let x = 0; x < c.w; x++) {
			box[y * c.w + x] = mask[(c.y + y) * w + (c.x + x)];
		}
	}
	return box;
}

function match(mask, w, h, expectedId, label) {
	const comps = segment(mask, w, h);
	const compSigs = comps.map((c) => signatureForBox(extractBox(mask, w, c), c.w, c.h));
	console.log(`\n=== ${label}: ${comps.length} letter shapes ===`);
	const scored = [];
	for (let fi = 0; fi < manifest.fonts.length; fi++) {
		const base = fi * rowBytes;
		let total = 0;
		for (const sig of compSigs) {
			let best = Number.POSITIVE_INFINITY;
			for (let gi = 0; gi < glyphsPerFont; gi++) {
				const d = hammingDistance(sig, raw, base + gi * BYTES_PER_GLYPH);
				if (d < best) best = d;
			}
			total += best;
		}
		const score = 1 - total / compSigs.length / GRID_BITS;
		scored.push({ id: manifest.fonts[fi], family: manifest.families[fi], score });
	}
	scored.sort((a, b) => b.score - a.score);
	const top = scored.slice(0, 8).map((s, i) => `${i + 1}. ${s.family} (${s.id}) score=${s.score.toFixed(3)}${s.id === expectedId ? '  <<< EXPECTED' : ''}`);
	console.log(top.join('\n'));
	const rank = scored.findIndex((s) => s.id === expectedId) + 1;
	console.log(`${label}: ${expectedId} rank = ${rank}${rank === 1 ? '  ✔' : '  ✘'}`);
}

const familyKey = 'FF-roboto';
GlobalFonts.registerFromPath(join(ROOT, '.fonts-cache', 'roboto.woff2'), familyKey);
const w = renderWord(familyKey, 'FontFinder');
match(w.mask, w.w, w.h, 'roboto', 'Roboto word');

const w2 = renderWord(familyKey, 'SansSerif');
match(w2.mask, w2.w, w2.h, 'roboto', 'Roboto word 2');

const familyKey2 = 'FF-open-sans';
GlobalFonts.registerFromPath(join(ROOT, '.fonts-cache', 'open-sans.woff2'), familyKey2);
const w3 = renderWord(familyKey2, 'FontFinder');
match(w3.mask, w3.w, w3.h, 'open-sans', 'Open Sans word');