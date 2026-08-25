// Experiments for a discriminative render-refine:
// A) per-letter known-char glyph comparison (letterRefine)
// B) per-letter + word blend
// C) whole-word wordSim
// Uses the SAME source render (150px) and the real cached woff2s.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GlobalFonts, createCanvas } from '@napi-rs/canvas';
import { gunzipSync } from 'node:zlib';
import { signatureForBox, hammingDistance, isAllZero, BYTES_PER_GLYPH, CHARS, GRID_BITS } from '../src/lib/client/fingerprint-core.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'public', 'signatures', 'manifest.json'), 'utf8'));
const raw = gunzipSync(readFileSync(join(ROOT, 'public', 'signatures', 'regular.bin.gz')));
const glyphsPerFont = CHARS.length;
const rowBytes = BYTES_PER_GLYPH * glyphsPerFont;
const FONT_KEY = 'lf';

function lumMask(d, w, h) {
	const mask = new Uint8ClampedArray(w * h);
	for (let i = 0; i < d.length; i += 4) mask[i / 4] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < 140 ? 1 : 0;
	return mask;
}
function renderWordMask(familyKey, text) {
	const c = createCanvas(1200, 240);
	const ctx = c.getContext('2d');
	ctx.fillStyle = '#fff';
	ctx.fillRect(0, 0, 1200, 240);
	ctx.font = `150px ${familyKey}`;
	ctx.textBaseline = 'alphabetic';
	ctx.fillStyle = '#000';
	ctx.fillText(text, 24, 190);
	return lumMask(ctx.getImageData(0, 0, 1200, 240).data, 1200, 240);
}
function segmentLetters(mask, w, h) {
	const visited = new Uint8Array(w * h);
	const comps = [];
	const minArea = Math.max(8, Math.round(w * h * 0.0005));
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
		const i = y * w + x;
		if (mask[i] !== 1 || visited[i]) continue;
		const stack = [i]; visited[i] = 1;
		let c = 0, minX = w, minY = h, maxX = -1, maxY = -1;
		while (stack.length) {
			const p = stack.pop(); const px = p % w, py = (p / w) | 0;
			c++;
			if (px < minX) minX = px;
			if (px > maxX) maxX = px;
			if (py < minY) minY = py;
			if (py > maxY) maxY = py;
			if (px > 0 && !visited[p - 1] && mask[p - 1] === 1) { visited[p - 1] = 1; stack.push(p - 1); }
			if (px < w - 1 && !visited[p + 1] && mask[p + 1] === 1) { visited[p + 1] = 1; stack.push(p + 1); }
			if (py > 0 && !visited[p - w] && mask[p - w] === 1) { visited[p - w] = 1; stack.push(p - w); }
			if (py < h - 1 && !visited[p + w] && mask[p + w] === 1) { visited[p + w] = 1; stack.push(p + w); }
		}
		if (c < minArea) continue;
		comps.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 });
	}
	comps.sort((a, b) => a.y - b.y || a.x - b.x);
	return comps;
}
const extractBox = (m, w, c) => {
	const out = new Uint8ClampedArray(c.w * c.h);
	for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) out[y * c.w + x] = m[(c.y + y) * w + (c.x + x)];
	return out;
};
function inkBBox(m, W, H) {
	let minX = W, minY = H, maxX = -1, maxY = -1;
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (m[y * W + x] === 1) {
		if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
	}
	return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
function scaleBoxTo(m, srcW, box, dstW, dstH) {
	const out = new Uint8ClampedArray(dstW * dstH);
	for (let y = 0; y < dstH; y++) {
		const sy = Math.min(box.h - 1, Math.floor((y * box.h) / dstH));
		for (let x = 0; x < dstW; x++) {
			const sx = Math.min(box.w - 1, Math.floor((x * box.w) / dstW));
			out[y * dstW + x] = m[(box.y + sy) * srcW + (box.x + sx)];
		}
	}
	return out;
}
function compareMasks(a, b) {
	const len = Math.min(a.length, b.length);
	if (!len) return 0;
	let fg = 0, agree = 0;
	for (let i = 0; i < len; i++) if (a[i] === 1 || b[i] === 1) { fg++; if (a[i] === b[i]) agree++; }
	return fg ? agree / fg : 0;
}
function wordSimilarity(mask, srcW, srcH, familyKey, text) {
	const c = createCanvas(320, 96);
	const ctx = c.getContext('2d');
	ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 320, 96);
	ctx.font = `600 44px "${familyKey}", sans-serif`;
	ctx.textBaseline = 'middle'; ctx.textAlign = 'center'; ctx.fillStyle = '#000';
	ctx.fillText(text.slice(0, 40), 160, 48);
	const tpl = lumMask(ctx.getImageData(0, 0, 320, 96).data, 320, 96);
	const tb = inkBBox(tpl, 320, 96); if (!tb) return 0;
	const sb = inkBBox(mask, srcW, srcH); if (!sb) return 0;
	const scaled = scaleBoxTo(mask, srcW, sb, tb.w, tb.h);
	const tbox = extractBox(tpl, 320, tb);
	return compareMasks(scaled, tbox);
}
const FP_W = 32, FP_H = 24;
function fingerprintOfBox(mask, srcW, x, y, w, h) {
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
function fingerprintSimilarity(a, b) {
	let diff = 0;
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) diff += Math.abs(a[i] - b[i]);
	return Math.max(0, 1 - diff / (len * 255));
}
function renderGlyphMask(familyKey, char, size = 96) {
	const height = Math.round(size * 1.4);
	const c = createCanvas(size, height);
	const ctx = c.getContext('2d');
	ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, height);
	ctx.font = `600 ${size}px "${familyKey}", sans-serif`;
	ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left'; ctx.fillStyle = '#000';
	ctx.fillText(char, 0, size);
	const mask = lumMask(ctx.getImageData(0, 0, size, height).data, size, height);
	const b = inkBBox(mask, size, height);
	if (!b) return { mask, w: size, h: height, box: { x: 0, y: 0, w: size, h: height } };
	return { mask, w: size, h: height, box: b };
}
const glyphCache = new Map();
function glyphFingerprints(familyKey) {
	const cached = glyphCache.get(familyKey);
	if (cached) return cached;
	const out = [];
	for (const ch of CHARS) { const g = renderGlyphMask(familyKey, ch, 72); out.push(fingerprintOfBox(g.mask, g.w, g.box.x, g.box.y, g.box.w, g.box.h)); }
	glyphCache.set(familyKey, out);
	return out;
}
// per-letter known-char comparison
function letterRefine(familyKey, comps, mask, srcW, text, useGuess = true) {
	// align comps to chars: assume same count; else fall back to best-of-62
	const glyphs = glyphFingerprints(familyKey);
	const chars = text.slice(0, comps.length);
	const scores = [];
	for (let ci = 0; ci < comps.length; ci++) {
		const c = comps[ci];
		const fp = fingerprintOfBox(mask, srcW, c.x, c.y, c.w, c.h);
		// known-char: only compare to the char at this position
		let s = 0;
		if (ci < text.length) {
			const idx = CHARS.indexOf(text[ci]);
			if (idx >= 0) s = fingerprintSimilarity(fp, glyphs[idx]);
		}
		// fallback if char unknown: best-of-62
		if (s === 0) { for (const g of glyphs) { const x = fingerprintSimilarity(fp, g); if (x > s) s = x; } }
		scores.push(s);
	}
	return scores.reduce((a, b) => a + b, 0) / (scores.length || 1);
}
function hammingRank(mask, w, h, comps) {
	const compSigs = comps.map((c) => signatureForBox(extractBox(mask, w, c), c.w, c.h)).filter((s) => !isAllZero(s));
	const scored = [];
	for (let fi = 0; fi < manifest.fonts.length; fi++) {
		const base = fi * rowBytes;
		let total = 0;
		for (const sig of compSigs) {
			let best = Number.POSITIVE_INFINITY;
			for (let gi = 0; gi < glyphsPerFont; gi++) { const d = hammingDistance(sig, raw, base + gi * BYTES_PER_GLYPH); if (d < best) best = d; }
			total += best;
		}
		scored.push({ id: manifest.fonts[fi], family: manifest.families[fi], score: 1 - total / compSigs.length / GRID_BITS });
	}
	scored.sort((a, b) => b.score - a.score);
	return scored;
}
function readWithGlyphMatch(mask, srcW, comps, candidateKeys) {
	// per comp: each candidate font votes for its best CHAR (via 32x24 fingerprints)
	const votes = comps.map(() => new Array(CHARS.length).fill(0));
	for (const key of candidateKeys) {
		const glyphs = glyphFingerprints(key);
		for (let ci = 0; ci < comps.length; ci++) {
			const c = comps[ci];
			const fp = fingerprintOfBox(mask, srcW, c.x, c.y, c.w, c.h);
			let best = -1, bestIdx = 0;
			for (let gi = 0; gi < glyphs.length; gi++) {
				const s = fingerprintSimilarity(fp, glyphs[gi]);
				if (s > best) { best = s; bestIdx = gi; }
			}
			votes[ci][bestIdx]++;
		}
	}
	const out = comps.map((c, ci) => {
		let w = 0; for (let g = 1; g < CHARS.length; g++) if (votes[ci][g] > votes[ci][w]) w = g;
		return CHARS[w];
	});
	return out.join('');
}
function runCase(familyId, familyName, text) {
	const key = FONT_KEY + familyId;
	try { GlobalFonts.registerFromPath(join(ROOT, '.fonts-cache', familyId + '.woff2'), key); } catch { return; }
	const mask = renderWordMask(key, text);
	const comps = segmentLetters(mask, 1200, 240);
	const ranked = hammingRank(mask, 1200, 240, comps);
	const hRank = ranked.findIndex((r) => r.id === familyId) + 1;
	const top20 = ranked.slice(0, 20);
	for (const s of top20) {
		const rKey = FONT_KEY + s.id;
		if (!GlobalFonts.has(rKey)) { try { GlobalFonts.registerFromPath(join(ROOT, '.fonts-cache', s.id + '.woff2'), rKey); } catch {} }
	}
	// glyph-match reader: votes among top-20 candidate fonts
	const gmRead = readWithGlyphMatch(mask, 1200, comps, top20.filter((s) => GlobalFonts.has(FONT_KEY + s.id)).map((s) => FONT_KEY + s.id));
	console.log(`   glyph-match read: \"${gmRead}\"  (true \"${text}\")`);
	const ws = top20.map((r) => ({ id: r.id, family: r.family, ws: GlobalFonts.has(FONT_KEY + r.id) ? wordSimilarity(mask, 1200, 240, FONT_KEY + r.id, text) : 0 }));
	const lr = top20.map((r) => ({ id: r.id, family: r.family, lr: GlobalFonts.has(FONT_KEY + r.id) ? letterRefine(FONT_KEY + r.id, comps, mask, 1200, text) : 0 }));
	const wsSorted = [...ws].sort((a, b) => b.ws - a.ws);
	const lrSorted = [...lr].sort((a, b) => b.lr - a.lr);
	const trueWs = ws.find((x) => x.id === familyId);
	const trueLr = lr.find((x) => x.id === familyId);
	// blend variants
	const blend = top20.map((r, i) => {
		const w = ws[i]?.ws ?? 0, l = lr[i]?.lr ?? 0;
		return { id: r.id, family: r.family, s: 0.5 * w + 0.5 * l };
	}).sort((a, b) => b.s - a.s);
	console.log(`\n== "${text}" in ${familyName} (${familyId}) == comps=${comps.length}`);
	console.log(`   hamming rank ${hRank}`);
	console.log(`   wordSim rank ${wsSorted.findIndex((x) => x.id === familyId) + 1}  (true=${trueWs?.ws.toFixed(3)}, top=${wsSorted[0]?.family} ${wsSorted[0]?.ws.toFixed(3)})`);
	console.log(`   letterRefine rank ${lrSorted.findIndex((x) => x.id === familyId) + 1}  (true=${trueLr?.lr.toFixed(3)}, top=${lrSorted[0]?.family} ${lrSorted[0]?.lr.toFixed(3)})`);
	console.log(`   0.5/0.5 blend rank ${blend.findIndex((x) => x.id === familyId) + 1}  (top=${blend[0]?.family} ${blend[0]?.s.toFixed(3)})`);
	return { hRank, comps: comps.length };
}
const cases = [
	['roboto', 'Roboto', 'FontFinder'],
	['open-sans', 'Open Sans', 'FontFinder'],
	['montserrat', 'Montserrat', 'Heading'],
	['playfair-display', 'Playfair Display', 'Elegant'],
	['lobster', 'Lobster', 'Script'],
	['oswald', 'Oswald', 'Titles'],
	['lato', 'Lato', 'FontFinder'],
	['poppins', 'Poppins', 'Heading'],
	['merriweather', 'Merriweather', 'Elegant'],
	['anton', 'Anton', 'Titles'],
];
const out = [];
for (const c of cases) { const r = runCase(...c); if (r) out.push(r); }
const avg = (a) => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1);
console.log(`\n=== avg comps=${avg(out.map((o) => o.comps))}  hamming avg rank=${avg(out.map((o) => o.hRank))}`);