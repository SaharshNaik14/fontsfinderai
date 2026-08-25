export interface ImageCrop {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface PreparedImage {
	dataUrl: string;
	width: number;
	height: number;
	mask: Uint8ClampedArray;
}

export interface ScoredCandidate {
	index: number;
	score: number;
}

// Working resolution for the matcher. Small-text screenshots are upscaled to
// this so segmentation and fingerprints always see large glyphs — text size in
// the source image stops mattering. Upscale is capped so a tiny crop of a tiny
// word can't be blown into pure blur.
const WORK_DIM = 1280;
const MAX_UPSCALE = 4;
const PREVIEW_W = 320;
const PREVIEW_H = 96;

function loadElement(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error('Could not decode image.'));
		img.src = src;
	});
}

export async function readImageFile(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(new Error('Could not read file.'));
		reader.readAsDataURL(file);
	});
}

function binarizeImageData(image: ImageData, bgLum?: number | null): Uint8ClampedArray {
	const { data } = image;
	const mask = new Uint8ClampedArray(image.width * image.height);
	for (let i = 0; i < data.length; i += 4) {
		const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
		let ink: boolean;
		if (bgLum === undefined || bgLum === null) {
			ink = lum < 140;
		} else {
			// Ink = pixel at least halfway between background and full-contrast
			// foreground (the 50%-coverage contour). The old ±40 margin cut deep
			// into the anti-aliased halo and fattened small-text strokes so they
			// no longer matched the DB — the single biggest small-text accuracy
			// killer (see scripts/test-small-text.mjs). Works for both polarities.
			const span = bgLum >= 128 ? bgLum : 255 - bgLum;
			const cut = Math.max(96, span / 2);
			ink = Math.abs(lum - bgLum) > cut;
		}
		mask[i / 4] = ink ? 1 : 0;
	}
	return mask;
}

function sampleCornerLum(image: ImageData): number {
	const { data, width, height } = image;
	const corners = [
		[0, 0],
		[width - 1, 0],
		[0, height - 1],
		[width - 1, height - 1],
	];
	let sum = 0;
	for (const [x, y] of corners) {
		const i = (y * width + x) * 4;
		sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
	}
	return sum / corners.length;
}

function getContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	if (!ctx) throw new Error('Canvas is not supported.');
	return ctx;
}

export async function prepareImage(dataUrl: string, crop?: ImageCrop): Promise<PreparedImage> {
	const img = await loadElement(dataUrl);
	const src = document.createElement('canvas');
	const srcCtx = getContext(src);
	src.width = img.naturalWidth || img.width;
	src.height = img.naturalHeight || img.height;
	srcCtx.drawImage(img, 0, 0);

	// User-guided crop: work only inside the selected region (natural pixels).
	let work = src;
	if (crop && crop.w >= 8 && crop.h >= 8) {
		const region = document.createElement('canvas');
		region.width = Math.round(crop.w);
		region.height = Math.round(crop.h);
		getContext(region).drawImage(
			src,
			crop.x,
			crop.y,
			region.width,
			region.height,
			0,
			0,
			region.width,
			region.height,
		);
		work = region;
	}

	const cropped = autoCrop(work, getContext(work));
	const fitted = normalizeResolution(cropped.canvas);
	const fitCtx = getContext(fitted.canvas);
	const imageData = fitCtx.getImageData(0, 0, fitted.canvas.width, fitted.canvas.height);
	const mask = binarizeImageData(imageData, sampleCornerLum(imageData));

	const out = document.createElement('canvas');
	out.width = fitted.canvas.width;
	out.height = fitted.canvas.height;
	getContext(out).drawImage(fitted.canvas, 0, 0);
	const encoded = canvasToDataUrl(out, 700 * 1024);

	return { dataUrl: encoded, width: out.width, height: out.height, mask };
}

export function autoCrop(
	src: HTMLCanvasElement,
	ctx: CanvasRenderingContext2D,
): { canvas: HTMLCanvasElement; width: number; height: number } {
	const { width, height } = src;
	const imageData = ctx.getImageData(0, 0, width, height);
	const { data } = imageData;
	const bg = sampleBackground(data, width, height);

	let minX = width;
	let minY = height;
	let maxX = -1;
	let maxY = -1;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4;
			const dist =
				Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]);
			if (dist > 48) {
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
		}
	}
	if (maxX < 0) return { canvas: src, width, height };

	const pad = Math.max(4, Math.round((maxX - minX) * 0.02));
	const w = Math.min(width, maxX - minX + 1 + pad * 2);
	const h = Math.min(height, maxY - minY + 1 + pad * 2);
	const cx = Math.max(0, minX - pad);
	const cy = Math.max(0, minY - pad);

	const canvas = document.createElement('canvas');
	canvas.width = w;
	canvas.height = h;
	getContext(canvas).drawImage(src, cx, cy, w, h, 0, 0, w, h);
	return { canvas, width: w, height: h };
}

function sampleBackground(data: Uint8ClampedArray, width: number, height: number): [number, number, number] {
	const corners = [
		[0, 0],
		[width - 1, 0],
		[0, height - 1],
		[width - 1, height - 1],
	];
	let r = 0;
	let g = 0;
	let b = 0;
	for (const [x, y] of corners) {
		const i = (y * width + x) * 4;
		r += data[i];
		g += data[i + 1];
		b += data[i + 2];
	}
	return [r / corners.length, g / corners.length, b / corners.length];
}

// Normalize the cropped image toward WORK_DIM on its longest side: upscale
// small crops (high-quality smoothing) and downscale huge ones, so every query
// runs at a consistent resolution regardless of the source text size.
function normalizeResolution(
	canvas: HTMLCanvasElement,
): { canvas: HTMLCanvasElement; width: number; height: number } {
	const longest = Math.max(canvas.width, canvas.height);
	if (longest >= WORK_DIM) return downscaleToFit(canvas, WORK_DIM);
	const scale = Math.min(WORK_DIM / longest, MAX_UPSCALE);
	if (scale <= 1.01) return { canvas, width: canvas.width, height: canvas.height };
	const w = Math.max(1, Math.round(canvas.width * scale));
	const h = Math.max(1, Math.round(canvas.height * scale));
	const out = document.createElement('canvas');
	out.width = w;
	out.height = h;
	const ctx = getContext(out);
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = 'high';
	ctx.drawImage(canvas, 0, 0, w, h);
	return { canvas: out, width: w, height: h };
}

export function downscaleToFit(
	canvas: HTMLCanvasElement,
	maxDim: number,
): { canvas: HTMLCanvasElement; width: number; height: number } {
	const scale = Math.min(1, maxDim / Math.max(canvas.width, canvas.height));
	if (scale >= 1) return { canvas, width: canvas.width, height: canvas.height };
	const w = Math.max(1, Math.round(canvas.width * scale));
	const h = Math.max(1, Math.round(canvas.height * scale));
	const out = document.createElement('canvas');
	out.width = w;
	out.height = h;
	getContext(out).drawImage(canvas, 0, 0, w, h);
	return { canvas: out, width: w, height: h };
}

export function canvasToDataUrl(canvas: HTMLCanvasElement, maxBytes: number): string {
	const scale = Math.min(1, Math.sqrt(maxBytes / (canvas.width * canvas.height * 0.75)));
	let width = Math.round(canvas.width * scale);
	let height = Math.round(canvas.height * scale);
	if (scale < 1) {
		const tmp = document.createElement('canvas');
		tmp.width = width;
		tmp.height = height;
		getContext(tmp).drawImage(canvas, 0, 0, width, height);
		canvas = tmp;
	}
	for (const type of ['image/jpeg', 'image/webp', 'image/png']) {
		for (let q = 0.85; q >= 0.5; q -= 0.1) {
			const url = canvas.toDataURL(type, q);
			if (url.length <= maxBytes * 1.34 + 64) return url;
		}
	}
	while (canvas.width > 64) {
		width = Math.round(canvas.width / 2);
		height = Math.round(canvas.height / 2);
		const tmp = document.createElement('canvas');
		tmp.width = width;
		tmp.height = height;
		getContext(tmp).drawImage(canvas, 0, 0, width, height);
		canvas = tmp;
		const url = canvas.toDataURL('image/jpeg', 0.7);
		if (url.length <= maxBytes * 1.34 + 64) return url;
	}
	return canvas.toDataURL('image/jpeg', 0.5);
}

export function renderTextTemplate(text: string, family: string, cssWeight = 600): Uint8ClampedArray {
	const canvas = document.createElement('canvas');
	canvas.width = PREVIEW_W;
	canvas.height = PREVIEW_H;
	const ctx = getContext(canvas);
	ctx.fillStyle = '#ffffff';
	ctx.fillRect(0, 0, PREVIEW_W, PREVIEW_H);
	ctx.font = `${cssWeight} 44px "${family}", sans-serif`;
	ctx.textBaseline = 'middle';
	ctx.textAlign = 'center';
	ctx.fillStyle = '#000000';
	ctx.fillText(text.slice(0, 40), PREVIEW_W / 2, PREVIEW_H / 2);
	return binarizeImageData(ctx.getImageData(0, 0, PREVIEW_W, PREVIEW_H));
}

export function scaleMaskTo(mask: Uint8ClampedArray, srcW: number, srcH: number, dstW: number, dstH: number): Uint8ClampedArray {
	const out = new Uint8ClampedArray(dstW * dstH);
	for (let y = 0; y < dstH; y++) {
		const sy = Math.min(srcH - 1, Math.floor((y * srcH) / dstH));
		for (let x = 0; x < dstW; x++) {
			const sx = Math.min(srcW - 1, Math.floor((x * srcW) / dstW));
			out[y * dstW + x] = mask[sy * srcW + sx];
		}
	}
	return out;
}

export function inkBBox(
	mask: Uint8ClampedArray,
	w: number,
	h: number,
): { x: number; y: number; w: number; h: number } | null {
	let minX = w;
	let minY = h;
	let maxX = -1;
	let maxY = -1;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			if (mask[y * w + x] === 1) {
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
		}
	}
	if (maxX < 0) return null;
	return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

export function extractBox(
	mask: Uint8ClampedArray,
	w: number,
	h: number,
	box: { x: number; y: number; w: number; h: number },
): Uint8ClampedArray {
	const out = new Uint8ClampedArray(box.w * box.h);
	for (let y = 0; y < box.h; y++) {
		const sy = Math.min(h - 1, box.y + y);
		for (let x = 0; x < box.w; x++) {
			const sx = Math.min(w - 1, box.x + x);
			out[y * box.w + x] = mask[sy * w + sx];
		}
	}
	return out;
}

export function scaleBoxTo(
	mask: Uint8ClampedArray,
	srcW: number,
	box: { x: number; y: number; w: number; h: number },
	dstW: number,
	dstH: number,
): Uint8ClampedArray {
	const out = new Uint8ClampedArray(dstW * dstH);
	for (let y = 0; y < dstH; y++) {
		const sy = Math.min(box.h - 1, Math.floor((y * box.h) / dstH));
		for (let x = 0; x < dstW; x++) {
			const sx = Math.min(box.w - 1, Math.floor((x * box.w) / dstW));
			out[y * dstW + x] = mask[(box.y + sy) * srcW + (box.x + sx)];
		}
	}
	return out;
}

export function compareMasks(source: Uint8ClampedArray, template: Uint8ClampedArray): number {
	const len = Math.min(source.length, template.length);
	if (len === 0) return 0;
	let foreground = 0;
	let agree = 0;
	for (let i = 0; i < len; i++) {
		const s = source[i];
		const t = template[i];
		if (s === 1 || t === 1) {
			foreground++;
			if (s === t) agree++;
		}
	}
	if (foreground === 0) return 0;
	return agree / foreground;
}

export function similarityTo(sourceMask: Uint8ClampedArray, srcW: number, srcH: number, family: string, text: string): number {
	const template = renderTextTemplate(text, family);
	const scaled = scaleMaskTo(sourceMask, srcW, srcH, PREVIEW_W, PREVIEW_H);
	return compareMasks(scaled, template);
}