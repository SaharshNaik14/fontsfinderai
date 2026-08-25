// Sanity probe for segmentLetters merging: each rendered word must yield
// exactly one component per alphanumeric letter (dots merged into stems,
// punctuation dropped).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GlobalFonts, createCanvas } from '@napi-rs/canvas';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
GlobalFonts.registerFromPath(join(ROOT, '.fonts-cache', 'roboto.woff2'), 'sg-roboto');

function lumMask(d, w, h) {
	const mask = new Uint8ClampedArray(w * h);
	for (let i = 0; i < d.length; i += 4)
		mask[i / 4] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < 128 ? 1 : 0;
	return mask;
}

function renderWordCanvas(text, px) {
	const meas = createCanvas(8, 8).getContext('2d');
	meas.font = `${px}px "sg-roboto"`;
	const tw = Math.ceil(meas.measureText(text).width);
	const c = createCanvas(tw + px, Math.round(px * 1.9));
	const ctx = c.getContext('2d');
	ctx.fillStyle = '#fff';
	ctx.fillRect(0, 0, c.width, c.height);
	ctx.font = `${px}px "sg-roboto"`;
	ctx.textBaseline = 'alphabetic';
	ctx.fillStyle = '#000';
	ctx.fillText(text, px / 2, Math.round(px * 1.3));
	return c;
}

// --- mirrors src/lib/client/measure.ts segmentLetters ---
function segmentLetters(mask, w, h) {
	const visited = new Uint8Array(w * h);
	const rawBoxes = [];
	const minArea = 12;
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
				for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
					const nx = px + dx, ny = py + dy;
					if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
					const ni = ny * w + nx;
					if (!visited[ni] && mask[ni] === 1) { visited[ni] = 1; stack.push(ni); }
				}
			}
			if (count < minArea) continue;
			rawBoxes.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 });
		}
	}
	if (!rawBoxes.length) return [];
	const mergeOnce = (list) => {
		const sorted = [...list].sort((a, b) => a.x - b.x || a.y - b.y);
		const out = [];
		for (const b of sorted) {
			const last = out[out.length - 1];
			if (last) {
				const overlap = Math.min(last.x + last.w, b.x + b.w) - Math.max(last.x, b.x);
				const gapY = Math.max(last.y, b.y) - Math.min(last.y + last.h, b.y + b.h);
				if (overlap > 0 && overlap >= Math.min(last.w, b.w) * 0.55 && gapY < Math.min(last.h, b.h) * 0.4) {
					const x0 = Math.min(last.x, b.x);
					const y0 = Math.min(last.y, b.y);
					last.w = Math.max(last.x + last.w, b.x + b.w) - x0;
					last.h = Math.max(last.y + last.h, b.y + b.h) - y0;
					last.x = x0;
					last.y = y0;
					continue;
				}
			}
			out.push({ ...b });
		}
		return out;
	};
	let boxes = mergeOnce(mergeOnce(rawBoxes));
	const heights = boxes.map((b) => b.h).sort((a, b) => a - b);
	const medianH = heights[Math.floor(heights.length / 2)] || 1;
	boxes = boxes.filter((b) => b.h >= medianH * 0.35 && b.w >= 2);
	return boxes.sort((a, b) => a.x - b.x);
}

const CASES = [
	['Heading', 7],
	['jiggle', 6],      // two dotted letters + descender
	['Handgloves', 10],
	['ABIDE', 5],
	['Mix.', 3],        // period must be dropped
	['illicit', 7],     // three dotted letters
];

for (const [text, expected] of CASES) {
	for (const px of [24, 60]) {
		const c = renderWordCanvas(text, px);
		const mask = lumMask(c.getContext('2d').getImageData(0, 0, c.width, c.height).data, c.width, c.height);
		const comps = segmentLetters(mask, c.width, c.height);
		const ok = comps.length === expected ? 'OK ' : 'FAIL';
		console.log(`${ok} "${text}" @${px}px: ${comps.length} comps (expected ${expected})`);
	}
}
