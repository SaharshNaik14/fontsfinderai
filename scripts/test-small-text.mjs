// Small-text accuracy probe: compares the OLD pipeline (match the raw mask,
// no upscaling) against the NEW pipeline (upscale crop toward WORK_DIM, then
// Hamming over stroke-weight erosion levels) — mirroring match.ts/match-db.ts.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GlobalFonts, createCanvas } from '@napi-rs/canvas';
import { gunzipSync } from 'node:zlib';
import {
	signatureForBox,
	hammingDistance,
	isAllZero,
	BYTES_PER_GLYPH,
	CHARS,
	GRID_BITS,
} from '../src/lib/client/fingerprint-core.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'public', 'signatures', 'manifest.json'), 'utf8'));
const raw = gunzipSync(readFileSync(join(ROOT, 'public', 'signatures', 'regular.bin.gz')));
const glyphsPerFont = CHARS.length;
const rowBytes = BYTES_PER_GLYPH * glyphsPerFont;

// --- constants mirrored from match.ts / match-db.ts ---
const WORK_DIM = 1280;
const MAX_UPSCALE = 4;
const MAX_ERODE = 0; // production ships no sweep — see A/B history in this file

function lumMask(d, w, h) {
	const mask = new Uint8ClampedArray(w * h);
	for (let i = 0; i < d.length; i += 4)
		mask[i / 4] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < 140 ? 1 : 0;
	return mask;
}

function renderWordCanvas(familyKey, text, px) {
	const meas = createCanvas(8, 8).getContext('2d');
	meas.font = `${px}px "${familyKey}"`;
	const tw = Math.ceil(meas.measureText(text).width);
	const c = createCanvas(tw + px, Math.round(px * 1.7));
	const ctx = c.getContext('2d');
	ctx.fillStyle = '#fff';
	ctx.fillRect(0, 0, c.width, c.height);
	ctx.font = `${px}px "${familyKey}"`;
	ctx.textBaseline = 'alphabetic';
	ctx.fillStyle = '#000';
	ctx.fillText(text, px / 2, Math.round(px * 1.25));
	return c;
}

// OLD pipeline: use the image at its native (small) resolution.
// NEW pipeline: normalizeResolution() — upscale toward WORK_DIM, capped 4×.
function normalizeResolution(canvas) {
	const longest = Math.max(canvas.width, canvas.height);
	if (longest >= WORK_DIM) return canvas;
	const scale = Math.min(WORK_DIM / longest, MAX_UPSCALE);
	const w = Math.max(1, Math.round(canvas.width * scale));
	const h = Math.max(1, Math.round(canvas.height * scale));
	const out = createCanvas(w, h);
	const ctx = out.getContext('2d');
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = 'high';
	ctx.drawImage(canvas, 0, 0, w, h);
	return out;
}

function segmentLetters(mask, w, h) {
	const visited = new Uint8Array(w * h);
	const comps = [];
	const minArea = Math.max(8, Math.round(w * h * 0.0005));
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = y * w + x;
			if (mask[i] !== 1 || visited[i]) continue;
			const stack = [i];
			visited[i] = 1;
			let count = 0, minX = w, minY = h, maxX = -1, maxY = -1;
			while (stack.length) {
				const p = stack.pop();
				const px2 = p % w, py = (p / w) | 0;
				count++;
				if (px2 < minX) minX = px2;
				if (px2 > maxX) maxX = px2;
				if (py < minY) minY = py;
				if (py > maxY) maxY = py;
				if (px2 > 0 && !visited[p - 1] && mask[p - 1] === 1) { visited[p - 1] = 1; stack.push(p - 1); }
				if (px2 < w - 1 && !visited[p + 1] && mask[p + 1] === 1) { visited[p + 1] = 1; stack.push(p + 1); }
				if (py > 0 && !visited[p - w] && mask[p - w] === 1) { visited[p - w] = 1; stack.push(p - w); }
				if (py < h - 1 && !visited[p + w] && mask[p + w] === 1) { visited[p + w] = 1; stack.push(p + w); }
			}
			if (count >= minArea) comps.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 });
		}
	}
	comps.sort((a, b) => a.x - b.x);
	return comps;
}

const extractBox = (m, w, c) => {
	const out = new Uint8ClampedArray(c.w * c.h);
	for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) out[y * c.w + x] = m[(c.y + y) * w + (c.x + x)];
	return out;
};

function erodeMask(mask, w, h) {
	const out = new Uint8ClampedArray(mask.length);
	let ink = 0;
	for (let y = 1; y < h - 1; y++) {
		const row = y * w;
		for (let x = 1; x < w - 1; x++) {
			const i = row + x;
			if (
				mask[i] === 1 && mask[i - 1] === 1 && mask[i + 1] === 1 &&
				mask[i - w] === 1 && mask[i + w] === 1 &&
				mask[i - w - 1] === 1 && mask[i - w + 1] === 1 &&
				mask[i + w - 1] === 1 && mask[i + w + 1] === 1
			) { out[i] = 1; ink++; }
		}
	}
	return { mask: out, ink };
}

function tightBox(mask, w, box) {
	let minX = box.x + box.w, minY = box.y + box.h, maxX = -1, maxY = -1;
	for (let y = box.y; y < box.y + box.h; y++) {
		const row = y * w;
		for (let x = box.x; x < box.x + box.w; x++) {
			if (mask[row + x] === 1) {
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
		}
	}
	return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

const MIN_SIG_BITS = 4;
function queryShapes(mask, srcW, srcH) {
	const comps = segmentLetters(mask, srcW, srcH);
	const zero = new Uint8Array(BYTES_PER_GLYPH);
	const boxes = [];
	const level0 = [];
	for (const c of comps) {
		const sig = signatureForBox(extractBox(mask, srcW, c), c.w, c.h);
		if (isAllZero(sig) || hammingDistance(sig, zero) < MIN_SIG_BITS) continue;
		level0.push(sig);
		boxes.push({ x: c.x, y: c.y, w: c.w, h: c.h });
	}
	if (boxes.length === 0) return null;
	const levels = [level0];
	let cur = mask;
	let ink = mask.reduce((n, v) => n + (v === 1 ? 1 : 0), 0);
	for (let l = 1; l <= MAX_ERODE; l++) {
		const eroded = erodeMask(cur, srcW, srcH);
		if (eroded.ink === 0 || eroded.ink >= ink) break;
		ink = eroded.ink;
		cur = eroded.mask;
		const lvl = [];
		for (const b of boxes) {
			const tb = tightBox(cur, srcW, b);
			if (!tb || tb.w < 2 || tb.h < 2) { lvl.length = 0; break; }
			lvl.push(signatureForBox(extractBox(cur, srcW, tb), tb.w, tb.h));
		}
		if (lvl.length !== boxes.length) break;
		levels.push(lvl);
	}
	return { boxes, levels };
}

function rankFontsAtLevel(sigs) {
	const scored = [];
	for (let f = 0; f < manifest.fonts.length; f++) {
		const base = f * rowBytes;
		let total = 0;
		for (const sig of sigs) {
			let best = Number.POSITIVE_INFINITY;
			for (let g = 0; g < glyphsPerFont; g++) {
				const d = hammingDistance(sig, raw, base + g * BYTES_PER_GLYPH);
				if (d < best) best = d;
			}
			total += best;
		}
		scored.push({ id: manifest.fonts[f], family: manifest.families[f], score: 1 - total / sigs.length / GRID_BITS });
	}
	scored.sort((a, b) => b.score - a.score);
	return scored;
}

// NEW strategy: rank fonts once PER stroke-weight level, combine by taking each
// font's BEST rank across levels (a font that excels in any coherent view wins).
function rankWithLevels(mask, w, h) {
	const shapes = queryShapes(mask, w, h);
	if (!shapes) return { ranked: [], levels: 0 };
	const perLevel = shapes.levels.map((level) => rankFontsAtLevel(level));
	let levelsUsed = 0;
	const combined = new Map();
	for (const r of perLevel) {
		levelsUsed++;
		r.forEach((entry, i) => {
			const prev = combined.get(entry.id);
			if (prev === undefined || i + 1 < prev.rank) {
				combined.set(entry.id, { ...entry, rank: i + 1 });
			}
		});
	}
	const ranked = [...combined.values()].sort((a, b) => a.rank - b.rank || b.score - a.score);
	return { ranked, levels: levelsUsed };
}

const CASES = [
	['roboto', 'Roboto', 'FontFinder'],
	['open-sans', 'Open Sans', 'Handgloves'],
	['montserrat', 'Montserrat', 'Heading'],
	['playfair-display', 'Playfair Display', 'Elegant'],
];
const SIZES = [16, 24, 36, 150];

for (const [id, fam, text] of CASES) {
	const key = 'st-' + id;
	try { GlobalFonts.registerFromPath(join(ROOT, '.fonts-cache', id + '.woff2'), key); }
	catch { console.log(`! no cached woff for ${fam}, skipping`); continue; }

	console.log(`\n== "${text}" in ${fam} ==`);
	console.log('   px   oldRank   newRank   levels');
	for (const px of SIZES) {
		const small = renderWordCanvas(key, text, px);

		const oldMask = lumMask(small.getContext('2d').getImageData(0, 0, small.width, small.height).data, small.width, small.height);
		// OLD baseline: single level, native resolution.
		const oldComps = segmentLetters(oldMask, small.width, small.height);
		const oldSigs = oldComps
			.map((c) => signatureForBox(extractBox(oldMask, small.width, c), c.w, c.h))
			.filter((s) => !isAllZero(s));
		const oldScored = [];
		for (let f = 0; f < manifest.fonts.length; f++) {
			const base = f * rowBytes;
			let total = 0;
			for (const sig of oldSigs) {
				let best = Number.POSITIVE_INFINITY;
				for (let g = 0; g < glyphsPerFont; g++) {
					const d = hammingDistance(sig, raw, base + g * BYTES_PER_GLYPH);
					if (d < best) best = d;
				}
				total += best;
			}
			oldScored.push({ id: manifest.fonts[f], score: total });
		}
		oldScored.sort((a, b) => a.score - b.score);
		const oldRank = oldScored.findIndex((r) => r.id === id) + 1;

		const big = normalizeResolution(small);
		const bigCtx = big.getContext('2d');
		const bigData = bigCtx.getImageData(0, 0, big.width, big.height).data;
		const newMask = new Uint8ClampedArray(big.width * big.height);
		for (let i = 0; i < bigData.length; i += 4)
			newMask[i / 4] = 0.299 * bigData[i] + 0.587 * bigData[i + 1] + 0.114 * bigData[i + 2] < 128 ? 1 : 0;
		const { ranked: newRanked, levels } = rankWithLevels(newMask, big.width, big.height);
		const newRank = newRanked.findIndex((r) => r.id === id) + 1;

		console.log(`   ${String(px).padEnd(4)} ${String(oldRank).padEnd(9)} ${String(newRank).padEnd(9)} ${levels}`);
	}
}
