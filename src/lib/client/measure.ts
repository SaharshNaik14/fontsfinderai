import type { SlimFreeFont } from '../types';
import { loadFontBatch } from './font-loader';
import { renderTextTemplate, inkBBox, scaleBoxTo, extractBox, compareMasks } from './match';

export interface LetterComponent {
	x: number;
	y: number;
	w: number;
	h: number;
	fingerprint: Uint8ClampedArray;
	joined: boolean;
}

export interface MeasuredResult {
	index: number;
	family: string;
	score: number;
	wordSim: number;
	letterSim: number;
	joined: boolean;
}

export interface MeasureProgress {
	stage: 'word' | 'letters';
	loaded: number;
	total: number;
	current: string;
}

const FP_W = 32;
const FP_H = 24;
const PREVIEW_W = 320;
const PREVIEW_H = 96;

function getContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	if (!ctx) throw new Error('Canvas is not supported.');
	return ctx;
}

function binarizeImageData(image: ImageData): Uint8ClampedArray {
	const { data } = image;
	const mask = new Uint8ClampedArray(image.width * image.height);
	for (let i = 0; i < data.length; i += 4) {
		const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
		mask[i / 4] = lum < 140 ? 1 : 0;
	}
	return mask;
}

export function fingerprintOfBox(
	mask: Uint8ClampedArray,
	srcW: number,
	x: number,
	y: number,
	w: number,
	h: number,
): Uint8ClampedArray {
	const out = new Uint8ClampedArray(FP_W * FP_H);
	if (w <= 0 || h <= 0) return out;
	const scale = FP_H / h;
	let dstW = Math.max(1, Math.round(w * scale));
	if (dstW > FP_W) dstW = FP_W;
	const x0 = Math.floor((FP_W - dstW) / 2);
	for (let gy = 0; gy < FP_H; gy++) {
		const sy = Math.min(h - 1, Math.floor((gy * h) / FP_H));
		const row = (y + sy) * srcW;
		for (let gx = 0; gx < dstW; gx++) {
			const sx = Math.min(w - 1, Math.floor((gx * w) / dstW));
			out[gy * FP_W + (x0 + gx)] = mask[row + (x + sx)] === 1 ? 255 : 0;
		}
	}
	return out;
}

interface RawBox {
	x: number;
	y: number;
	w: number;
	h: number;
}

// Merge multi-part glyphs back together: i-dots, accents and diacritics come
// out of the flood fill as separate components, which corrupts letter matching.
// Two boxes merge when they overlap horizontally by ≥55% of the narrower one
// and their vertical gap is <40% of the smaller height.
function mergeOverlappingBoxes(list: RawBox[]): RawBox[] {
	const sorted = [...list].sort((a, b) => a.x - b.x || a.y - b.y);
	const out: RawBox[] = [];
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
}

export function segmentLetters(mask: Uint8ClampedArray, w: number, h: number): LetterComponent[] {
	const visited = new Uint8Array(w * h);
	const rawBoxes: RawBox[] = [];
	// Tiny floor so i-dots and accents survive as components — the merge pass
	// below attaches them to their stems. Noise is removed afterwards by the
	// median-height filter, not here.
	const minArea = 12;

	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = y * w + x;
			if (mask[i] !== 1 || visited[i]) continue;
			const stack = [i];
			visited[i] = 1;
			let count = 0;
			let minX = w;
			let minY = h;
			let maxX = -1;
			let maxY = -1;
			while (stack.length) {
				const p = stack.pop() as number;
				const px = p % w;
				const py = (p / w) | 0;
				count++;
				if (px < minX) minX = px;
				if (px > maxX) maxX = px;
				if (py < minY) minY = py;
				if (py > maxY) maxY = py;
				if (px > 0 && !visited[p - 1] && mask[p - 1] === 1) {
					visited[p - 1] = 1;
					stack.push(p - 1);
				}
				if (px < w - 1 && !visited[p + 1] && mask[p + 1] === 1) {
					visited[p + 1] = 1;
					stack.push(p + 1);
				}
				if (py > 0 && !visited[p - w] && mask[p - w] === 1) {
					visited[p - w] = 1;
					stack.push(p - w);
				}
				if (py < h - 1 && !visited[p + w] && mask[p + w] === 1) {
					visited[p + w] = 1;
					stack.push(p + w);
				}
			}
			if (count < minArea) continue;
			rawBoxes.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 });
		}
	}

	if (rawBoxes.length === 0) return [];

	// Two passes: a first merge can create a new overlap with its neighbour.
	let boxes = mergeOverlappingBoxes(rawBoxes);
	boxes = mergeOverlappingBoxes(boxes);

	// Noise filter: drop specks and stray marks far shorter than typical letters.
	// Punctuation like periods/commas is dropped too — deliberate, since the DB
	// only contains alphanumerics and such shapes would only pollute the vote.
	const heights = boxes.map((b) => b.h).sort((a, b) => a - b);
	const medianH = heights[Math.floor(heights.length / 2)] || 1;
	boxes = boxes.filter((b) => b.h >= medianH * 0.35 && b.w >= 2);

	const comps: LetterComponent[] = boxes.map((b) => ({
		x: b.x,
		y: b.y,
		w: b.w,
		h: b.h,
		fingerprint: fingerprintOfBox(mask, w, b.x, b.y, b.w, b.h),
		joined: false,
	}));

	const sorted = [...comps].sort((a, b) => a.y - b.y);
	const compHeights = comps.map((c) => c.h).sort((a, b) => a - b);
	const medianCompH = compHeights[Math.floor(compHeights.length / 2)] || 1;
	const lines: LetterComponent[][] = [];
	for (const c of sorted) {
		let placed = false;
		for (const line of lines) {
			const ref = line[0];
			const center = c.y + c.h / 2;
			const lineCenter = ref.y + ref.h / 2;
			if (Math.abs(center - lineCenter) <= medianCompH * 1.2) {
				line.push(c);
				placed = true;
				break;
			}
		}
		if (!placed) lines.push([c]);
	}
	const ordered: LetterComponent[] = [];
	for (const line of lines) {
		line.sort((a, b) => a.x - b.x);
		ordered.push(...line);
	}

	const widths = ordered.map((c) => c.w).sort((a, b) => a - b);
	const medianW = widths[Math.floor(widths.length / 2)] || 0;
	for (const c of ordered) {
		if (medianW && c.w > medianW * 1.8) c.joined = true;
	}
	return ordered;
}

interface RenderedGlyph {
	mask: Uint8ClampedArray;
	w: number;
	h: number;
	box: { x: number; y: number; w: number; h: number };
}

export function renderGlyphMask(char: string, family: string, size = 96, cssWeight = 600): RenderedGlyph {
	const canvas = document.createElement('canvas');
	const height = Math.round(size * 1.4);
	canvas.width = size;
	canvas.height = height;
	const ctx = getContext(canvas);
	ctx.fillStyle = '#ffffff';
	ctx.fillRect(0, 0, size, height);
	ctx.font = `${cssWeight} ${size}px "${family}", sans-serif`;
	ctx.textBaseline = 'alphabetic';
	ctx.textAlign = 'left';
	ctx.fillStyle = '#000000';
	ctx.fillText(char, 0, size);
	const mask = binarizeImageData(ctx.getImageData(0, 0, size, height));

	let minX = size;
	let minY = height;
	let maxX = -1;
	let maxY = -1;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < size; x++) {
			if (mask[y * size + x] === 1) {
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
		}
	}
	if (maxX < 0) {
		return { mask, w: size, h: height, box: { x: 0, y: 0, w: size, h: height } };
	}
	return {
		mask,
		w: size,
		h: height,
		box: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
	};
}

export function fingerprintSimilarity(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
	let diff = 0;
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) diff += Math.abs(a[i] - b[i]);
	return Math.max(0, 1 - diff / (len * 255));
}

const GLYPHS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const glyphCache = new Map<string, Uint8ClampedArray[]>();

function glyphFingerprints(family: string, cssWeight = 600): Uint8ClampedArray[] {
	const cacheKey = `${family}|${cssWeight}`;
	const cached = glyphCache.get(cacheKey);
	if (cached) return cached;
	const out: Uint8ClampedArray[] = [];
	for (const ch of GLYPHS) {
		const g = renderGlyphMask(ch, family, 72, cssWeight);
		out.push(fingerprintOfBox(g.mask, g.w, g.box.x, g.box.y, g.box.w, g.box.h));
	}
	glyphCache.set(cacheKey, out);
	return out;
}

function glyphMatch(family: string, comps: LetterComponent[], cssWeight = 600): number {
	const glyphs = glyphFingerprints(family, cssWeight);
	let sum = 0;
	for (const c of comps) {
		let best = 0;
		for (const g of glyphs) {
			const s = fingerprintSimilarity(c.fingerprint, g);
			if (s > best) best = s;
		}
		sum += best;
	}
	return comps.length ? sum / comps.length : 0;
}

function wordMatch(
	sourceMask: Uint8ClampedArray,
	srcW: number,
	srcH: number,
	family: string,
	text: string,
	cssWeight = 600,
): { wordSim: number; aspectSim: number } {
	const template = renderTextTemplate(text, family, cssWeight);
	const tb = inkBBox(template, PREVIEW_W, PREVIEW_H);
	if (!tb) return { wordSim: 0, aspectSim: 0 };
	const sb = inkBBox(sourceMask, srcW, srcH);
	if (!sb) return { wordSim: 0, aspectSim: 0 };
	const scaled = scaleBoxTo(sourceMask, srcW, sb, tb.w, tb.h);
	const tbox = extractBox(template, PREVIEW_W, PREVIEW_H, tb);
	const sim = compareMasks(scaled, tbox);

	// Box-stretching fingerprints (and the stretch above) destroy proportion, so
	// compare aspect ratios explicitly: condensed vs extended faces differ here
	// even when every other signal ties — the single biggest weakness when only
	// one or two letters were detected. Damp rather than replace so the shape
	// comparison stays dominant.
	const srcAspect = sb.w / sb.h;
	const tplAspect = tb.w / tb.h;
	const aspectSim =
		Math.min(srcAspect, tplAspect) / Math.max(srcAspect, tplAspect);
	return { wordSim: sim * (0.8 + 0.2 * aspectSim), aspectSim };
}

const raf = () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

export async function measureMatch(
	free: SlimFreeFont[],
	sourceMask: Uint8ClampedArray,
	srcW: number,
	srcH: number,
	text: string,
	prefer: string[],
	onProgress: (p: MeasureProgress) => void,
	// Per-family CSS weight (400/700) from the Hamming stage's winning weight —
	// candidates are re-rendered in the weight that matched the source text.
	weights?: Map<string, number>,
): Promise<MeasuredResult[]> {
	const batch = 12;
	const word = text.trim().slice(0, 40);
	const preferSet = new Set(prefer.map((f) => f.toLowerCase()));
	const cssWeightOf = (family: string): number => weights?.get(family.toLowerCase()) ?? 600;
	const rows: {
		index: number;
		family: string;
		wordSim: number;
		loaded: boolean;
		glyphSim: number;
		joined: boolean;
	}[] = [];

	onProgress({ stage: 'word', loaded: 0, total: free.length, current: '' });

	for (let i = 0; i < free.length; i += batch) {
		const chunk = free.slice(i, i + batch);
		const loaded = await loadFontBatch(
			chunk.map((f) => f.family),
		);
		for (let j = 0; j < chunk.length; j++) {
			const f = chunk[j];
			const ok = !!loaded[f.family];
			rows.push({
				index: i + j,
				family: f.family,
				wordSim: ok && word ? wordMatch(sourceMask, srcW, srcH, f.family, word, cssWeightOf(f.family)).wordSim : 0,
				loaded: ok,
				glyphSim: 0,
				joined: false,
			});
		}
		onProgress({
			stage: 'word',
			loaded: Math.min(free.length, i + batch),
			total: free.length,
			current: chunk[chunk.length - 1]?.family ?? '',
		});
		await raf();
	}

	rows.sort((a, b) => b.wordSim - a.wordSim);
	const preferred = rows.filter((r) => preferSet.has(r.family.toLowerCase()) && r.loaded);
	const byPreference = new Map(preferred.map((r) => [r.index, r]));
	const top = word
		? [
				...rows.filter((r) => !byPreference.has(r.index)).slice(0, Math.max(40, 60 - preferred.length)),
				...preferred,
			]
		: rows.filter((r) => r.loaded);

	const comps = segmentLetters(sourceMask, srcW, srcH);
	const usable = comps.length >= 2;
	const joinedAny = comps.some((c) => c.joined);

	onProgress({ stage: 'letters', loaded: 0, total: top.length, current: '' });

	for (let k = 0; k < top.length; k++) {
		const r = top[k];
		let glyphSim = r.wordSim;
		if (usable && r.loaded) glyphSim = glyphMatch(r.family, comps, cssWeightOf(r.family));
		r.glyphSim = glyphSim;
		onProgress({
			stage: 'letters',
			loaded: k + 1,
			total: top.length,
			current: r.family,
		});
		await raf();
	}

	const byIndex = new Map(rows.map((r) => [r.index, r]));
	for (const t of top) {
		const row = byIndex.get(t.index);
		if (row) row.glyphSim = t.glyphSim;
	}

	const out: MeasuredResult[] = rows.map((r) => {
		const measured = 0.7 * r.glyphSim + 0.3 * r.wordSim;
		const prior = Math.max(0.3, 0.98 - r.index * 0.002);
		const score = r.loaded ? Math.min(1, 0.95 * measured + 0.05 * prior) : prior * 0.12;
		return {
			index: r.index,
			family: r.family,
			score,
			wordSim: r.wordSim,
			letterSim: r.glyphSim,
			joined: joinedAny,
		};
	});

	out.sort((a, b) => b.score - a.score);
	return out;
}

export function cropMask(mask: Uint8ClampedArray, srcW: number, srcH: number, box: { x: number; y: number; w: number; h: number }): Uint8ClampedArray {
	const x0 = Math.max(0, Math.min(srcW - 1, Math.round(box.x)));
	const y0 = Math.max(0, Math.min(srcH - 1, Math.round(box.y)));
	const w = Math.max(1, Math.min(srcW - x0, Math.round(box.w)));
	const h = Math.max(1, Math.min(srcH - y0, Math.round(box.h)));
	const out = new Uint8ClampedArray(w * h);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			out[y * w + x] = mask[(y0 + y) * srcW + (x0 + x)];
		}
	}
	return out;
}