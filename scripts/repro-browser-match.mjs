// Reproduces the exact in-browser matching pipeline (match.ts prepareImage
// binarization + measure.ts segmentLetters + match-db.ts scoring) against
// the site's own sample images, to see what the user actually experiences.
import { readFileSync } from 'node:fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { signatureForBox, hammingDistance, isAllZero, BYTES_PER_GLYPH, CHARS, GRID_BITS } from '../src/lib/client/fingerprint-core.ts';
import { gunzipSync } from 'node:zlib';

// --- exact copy of match.ts prepareImage helpers ---
function getContext(canvas) {
	return canvas.getContext('2d', { willReadFrequently: true });
}

// FIXED polarity (corrected 2026-08-19: light bg → darker is ink, dark bg → lighter is ink)
function binarizeImageData(image, bgLum) {
	const { data } = image;
	const mask = new Uint8ClampedArray(image.width * image.height);
	for (let i = 0; i < data.length; i += 4) {
		const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
		let ink;
		if (bgLum === undefined || bgLum === null) ink = lum < 140;
		else if (bgLum >= 128) ink = lum < bgLum - 40;
		else ink = lum > bgLum + 40;
		mask[i / 4] = ink ? 1 : 0;
	}
	return mask;
}

function sampleCornerLum(data, width, height) {
	const corners = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]];
	let sum = 0;
	for (const [x, y] of corners) {
		const i = (y * width + x) * 4;
		sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
	}
	return sum / corners.length;
}

function sampleBackground(data, width, height) {
	const corners = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]];
	let r = 0, g = 0, b = 0;
	for (const [x, y] of corners) {
		const i = (y * width + x) * 4;
		r += data[i]; g += data[i + 1]; b += data[i + 2];
	}
	return [r / 4, g / 4, b / 4];
}

function autoCrop(src, ctx, x0, y0, w0, h0) {
	const imageData = ctx.getImageData(x0, y0, w0, h0);
	const { data, width, height } = imageData;
	const bg = sampleBackground(data, width, height);
	let minX = width, minY = height, maxX = -1, maxY = -1;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4;
			const dist = Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]);
			if (dist > 48) {
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
		}
	}
	if (maxX < 0) return { imageData, width, height };
	const pad = Math.max(4, Math.round((maxX - minX) * 0.02));
	const w = Math.min(width, maxX - minX + 1 + pad * 2);
	const h = Math.min(height, maxY - minY + 1 + pad * 2);
	const cx = Math.max(0, minX - pad);
	const cy = Math.max(0, minY - pad);
	const canvas = createCanvas(w, h);
	const cctx = getContext(canvas);
	cctx.drawImage(src, cx + x0, cy + y0, w, h, 0, 0, w, h);
	const croppedData = cctx.getImageData(0, 0, w, h);
	return { imageData: croppedData, width: w, height: h };
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
				const px = p % w, py = (p / w) | 0;
				count++;
				if (px < minX) minX = px;
				if (px > maxX) maxX = px;
				if (py < minY) minY = py;
				if (py > maxY) maxY = py;
				if (px > 0 && !visited[p - 1] && mask[p - 1] === 1) { visited[p - 1] = 1; stack.push(p - 1); }
				if (px < w - 1 && !visited[p + 1] && mask[p + 1] === 1) { visited[p + 1] = 1; stack.push(p + 1); }
				if (py > 0 && !visited[p - w] && mask[p - w] === 1) { visited[p - w] = 1; stack.push(p - w); }
				if (py < h - 1 && !visited[p + w] && mask[p + w] === 1) { visited[p + w] = 1; stack.push(p + w); }
			}
			if (count < minArea) continue;
			comps.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 });
		}
	}
	comps.sort((a, b) => a.y - b.y || a.x - b.x);
	return comps;
}

function extractBox(mask, w, c) {
	const out = new Uint8ClampedArray(c.w * c.h);
	for (let y = 0; y < c.h; y++) {
		for (let x = 0; x < c.w; x++) {
			out[y * c.w + x] = mask[(c.y + y) * w + (c.x + x)];
		}
	}
	return out;
}

// Load the new signature DB
const manifest = JSON.parse(readFileSync('public/signatures/manifest.json', 'utf8'));
const gzFile = 'public/signatures/regular.bin.gz';
const raw = gunzipSync(readFileSync(gzFile));
const glyphsPerFont = CHARS.length; // 62
const rowBytes = BYTES_PER_GLYPH * glyphsPerFont; // 62×32

function run(mask, w, h, label) {
	const comps = segmentLetters(mask, w, h);
	const compSigs = comps.map((c) => signatureForBox(extractBox(mask, w, c), c.w, c.h)).filter((s) => !isAllZero(s));
	console.log(`\n== ${label} ==`);
	console.log(`   letter shapes detected: ${comps.length} | valid sigs: ${compSigs.length}`);
	if (compSigs.length === 0) {
		console.log('   -> NO SHAPES -> matchAllFonts returns [] -> no results shown');
		return;
	}
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
	console.log('   top5:', scored.slice(0, 5).map((s) => `${s.family} (${s.score.toFixed(3)})`).join(' | '));
}

for (const s of ['sample-1', 'sample-2', 'sample-3']) {
	const img = await loadImage('public/samples/' + s + '.png');
	const src = createCanvas(img.width, img.height);
	const srcCtx = getContext(src);
	srcCtx.drawImage(img, 0, 0);

	const cropped = autoCrop(src, srcCtx, 0, 0, img.width, img.height);
	const { data, width, height } = cropped.imageData;
	const bgLum = sampleCornerLum(data, width, height);

	const full = { data, width, height };
	const mask = binarizeImageData(full, bgLum);

	run(mask, width, height, `${s} [bgLum=${bgLum.toFixed(0)}]`);
}