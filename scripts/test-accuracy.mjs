// End-to-end accuracy check mirroring the browser pipeline EXACTLY:
//   1) matchAllFonts Hamming first pass (scored, ranked)
//   2) suggestText auto-guess (majority vote)
//   3) measureMatch render-refine (wordSim + glyphMatch, full blend, candidate fonts registered)
//   4) merge: confidence = 0.7*refined + 0.3*hamming  -> re-rank
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
const FONT_KEY = 'test-font';

function lumMask(d, w, h) {
	const mask = new Uint8ClampedArray(w * h);
	for (let i = 0; i < d.length; i += 4) mask[i / 4] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < 140 ? 1 : 0;
	return mask;
}

// --- render a real word (like a screenshot the user uploads) ---
function renderWordMask(familyKey, text, px = 150) {
	const c = createCanvas(1200, 240);
	const ctx = c.getContext('2d');
	ctx.fillStyle = '#fff';
	ctx.fillRect(0, 0, 1200, 240);
	ctx.font = `${px}px ${familyKey}`;
	ctx.textBaseline = 'alphabetic';
	ctx.fillStyle = '#000';
	ctx.fillText(text, 24, 190);
	return lumMask(ctx.getImageData(0, 0, 1200, 240).data, 1200, 240);
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

const extractBox = (m, w, c) => {
	const out = new Uint8ClampedArray(c.w * c.h);
	for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) out[y * c.w + x] = m[(c.y + y) * w + (c.x + x)];
	return out;
};

// --- fingerprintOfBox (measure.ts, 32x24, width scaled to height, centered) ---
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

// --- measure.ts pixel compare helpers (mirror match.ts) ---
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

// --- renderTextTemplate (match.ts: 320x96, 600 44px, middle/center) ---
const PREVIEW_W = 320, PREVIEW_H = 96;
function renderTextTemplate(familyKey, text) {
	const c = createCanvas(PREVIEW_W, PREVIEW_H);
	const ctx = c.getContext('2d');
	ctx.fillStyle = '#ffffff';
	ctx.fillRect(0, 0, PREVIEW_W, PREVIEW_H);
	ctx.font = `600 44px "${familyKey}", sans-serif`;
	ctx.textBaseline = 'middle';
	ctx.textAlign = 'center';
	ctx.fillStyle = '#000000';
	ctx.fillText(text.slice(0, 40), PREVIEW_W / 2, PREVIEW_H / 2);
	return lumMask(ctx.getImageData(0, 0, PREVIEW_W, PREVIEW_H).data, PREVIEW_W, PREVIEW_H);
}

// --- renderGlyphMask (measure.ts: 96px char canvas) ---
function renderGlyphMask(familyKey, char, size = 96) {
	const height = Math.round(size * 1.4);
	const c = createCanvas(size, height);
	const ctx = c.getContext('2d');
	ctx.fillStyle = '#ffffff';
	ctx.fillRect(0, 0, size, height);
	ctx.font = `600 ${size}px "${familyKey}", sans-serif`;
	ctx.textBaseline = 'alphabetic';
	ctx.textAlign = 'left';
	ctx.fillStyle = '#000000';
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
	for (const ch of CHARS) {
		const g = renderGlyphMask(familyKey, ch, 72);
		out.push(fingerprintOfBox(g.mask, g.w, g.box.x, g.box.y, g.box.w, g.box.h));
	}
	glyphCache.set(familyKey, out);
	return out;
}

function glyphMatch(familyKey, comps, sourceMask, srcW) {
	const glyphs = glyphFingerprints(familyKey);
	let sum = 0;
	for (const c of comps) {
		const fp = fingerprintOfBox(sourceMask, srcW, c.x, c.y, c.w, c.h);
		let best = 0;
		for (const g of glyphs) {
			const s = fingerprintSimilarity(fp, g);
			if (s > best) best = s;
		}
		sum += best;
	}
	return comps.length ? sum / comps.length : 0;
}

function wordSimilarity(sourceMask, srcW, srcH, familyKey, text) {
	const template = renderTextTemplate(familyKey, text);
	const tb = inkBBox(template, PREVIEW_W, PREVIEW_H);
	if (!tb) return 0;
	const sb = inkBBox(sourceMask, srcW, srcH);
	if (!sb) return 0;
	const scaled = scaleBoxTo(sourceMask, srcW, sb, tb.w, tb.h);
	const tbox = extractBox(template, PREVIEW_W, tb);
	return compareMasks(scaled, tbox);
}

// --- Hamming first pass (match-db.ts) ---
function hammingRank(mask, w, h, comps) {
	const compSigs = comps.map((c) => signatureForBox(extractBox(mask, w, c), c.w, c.h)).filter((s) => !isAllZero(s));
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
		scored.push({ id: manifest.fonts[fi], family: manifest.families[fi], score: 1 - total / compSigs.length / GRID_BITS });
	}
	scored.sort((a, b) => b.score - a.score);
	return scored;
}

// --- suggestText (match-db.ts), top-K weighted vote ---
function suggest(mask, w, h, comps, topK = 25) {
	const compSigs = comps.map((c) => signatureForBox(extractBox(mask, w, c), c.w, c.h)).filter((s) => !isAllZero(s));
	// per font: best glyph per comp + total distance
	const fontBest = []; // { total, bests: [g,...] }
	for (let f = 0; f < manifest.fonts.length; f++) {
		const base = f * rowBytes;
		const bests = [];
		let total = 0;
		for (const sig of compSigs) {
			let best = Number.POSITIVE_INFINITY, bestG = 0;
			for (let g = 0; g < glyphsPerFont; g++) {
				const d = hammingDistance(sig, raw, base + g * BYTES_PER_GLYPH);
				if (d < best) { best = d; bestG = g; }
			}
			bests.push(bestG);
			total += best;
		}
		fontBest.push({ total, bests });
	}
	fontBest.sort((a, b) => a.total - b.total);
	const top = fontBest.slice(0, topK);
	const out = [];
	let confSum = 0;
	for (let ci = 0; ci < compSigs.length; ci++) {
		const votes = new Array(glyphsPerFont).fill(0);
		for (const fb of top) votes[fb.bests[ci]]++;
		let winner = 0;
		for (let g = 1; g < glyphsPerFont; g++) if (votes[g] > votes[winner]) winner = g;
		out.push(CHARS[winner]);
		confSum += votes[winner] / topK;
	}
	const avgConf = out.length ? confSum / out.length : 0;
	console.error(`   [suggest] avgConf=${avgConf.toFixed(2)} out=` + out.join(""));
	return avgConf >= 0.5 ? out.join('') : '';
}

// --- measureMatch word stage (subset = top40 hamming) ---
function measureWordStage(mask, w, h, subsetSlim, text) {
	const rows = subsetSlim.map((s, index) => ({
		index,
		id: s.id,
		family: s.family,
		key: FONT_KEY + s.id,
		loaded: GlobalFonts.has(FONT_KEY + s.id),
	}));
	for (const r of rows) {
		r.wordSim = r.loaded && text ? wordSimilarity(mask, w, h, r.key, text) : 0;
		r.glyphSim = 0;
	}
	rows.sort((a, b) => b.wordSim - a.wordSim);
	return rows;
}

function runCase(familyId, familyName, text, useGuess = true) {
	const key = FONT_KEY + familyId;
	const woff = join(ROOT, '.fonts-cache', familyId + '.woff2');
	try { GlobalFonts.registerFromPath(woff, key); } catch { console.log(`   ! no cached woff for ${familyName}, skipping`); return; }

	const mask = renderWordMask(key, text);
	const comps = segmentLetters(mask, 1200, 240);

	// 1. Hamming
	const ranked = hammingRank(mask, 1200, 240, comps);
	const hRank = ranked.findIndex((r) => r.id === familyId) + 1;

	// 2. guess text (browser: auto-guess only when user typed nothing)
	const guess = suggest(mask, 1200, 240, comps);
	// userText models what the user typed. No-typing flow passes '' so refine is
	// skipped (matches the browser gate); TRUE_TEXT models a user who typed it.
	const userText = process.env.TRUE_TEXT ? text : '';
	const refineText = userText || guess;
	const doRefine = !!userText;

	// 3. measureMatch: register top-40 candidates + build subset
	const top40 = ranked.slice(0, 40);
	const subsetSlim = top40.map((r, i) => ({ id: r.id, family: r.family }));
	const missing = [];
	for (const s of subsetSlim) {
		const rKey = FONT_KEY + s.id;
		if (!GlobalFonts.has(rKey)) {
			try { GlobalFonts.registerFromPath(join(ROOT, '.fonts-cache', s.id + '.woff2'), rKey); } catch { missing.push(s.id); }
		}
	}
	for (const m of missing) subsetSlim.splice(subsetSlim.findIndex((s) => s.id === m), 1);

	const rows = doRefine ? measureWordStage(mask, 1200, 240, subsetSlim, refineText) : [];

	// 4. measureMatch letters stage + full score blend (measure.ts lines 321-361)
	const top = doRefine ? rows.filter((r) => r.loaded).slice(0, 40) : [];
	for (const r of top) {
		r.glyphSim = glyphMatch(r.key, comps, mask, 1200);
	}
	if (!doRefine) {
		return { hRank, fRank: hRank, guess, correctGuess: false, fBest: ranked[0].family, noRefine: true };
	}
	// DIAGNOSTICS: ink coverage of rendered templates + per-letter best scores
	if (process.env.DIAG) {
		const diagRows = [...rows].sort((a, b) => b.wordSim - a.wordSim).slice(0, 5).concat(rows.filter((r) => r.id === familyId).map((r) => ({ ...r })));
		for (const r of diagRows) {
			const tpl = renderTextTemplate(r.key, refineText);
			const box = inkBBox(tpl, PREVIEW_W, PREVIEW_H);
			let ink = 0;
			for (let i = 0; i < tpl.length; i++) ink += tpl[i];
			console.log(`      [diag] ${r.family.padEnd(26)} wordSim=${(r.wordSim ?? 0).toFixed(3)} glyphSim=${(r.glyphSim ?? 0).toFixed(3)} ink=${ink} box=${box ? box.w + 'x' + box.h : 'none'}`);
		}
	}
	const byIndex = new Map(rows.map((r) => [r.index, r]));
	for (const t of top) byIndex.get(t.index).glyphSim = t.glyphSim;
	const measuredList = [];
	for (const r of rows) {
		const measured = 0.7 * r.glyphSim + 0.3 * r.wordSim;
		const prior = Math.max(0.3, 0.98 - r.index * 0.002);
		const score = r.loaded ? Math.min(1, 0.95 * measured + 0.05 * prior) : prior * 0.12;
		measuredList.push({ index: r.index, id: r.id, score });
	}

	// 5. merge (mirror matcher-ui): refined top-N first in blend order, rest after
	const refinedIds = new Set(subsetSlim.map((s) => s.id));
	const hammingById = new Map(ranked.map((r) => [r.id, r.score]));
	const blended = measuredList
		.map((m) => ({ id: m.id, score: Math.min(1, 0.7 * m.score + 0.3 * (hammingById.get(m.id) ?? 0)) }))
		.sort((a, b) => b.score - a.score);
	const finals = [
		...blended.map((b) => ranked.find((r) => r.id === b.id)).filter(Boolean),
		...ranked.filter((r) => !refinedIds.has(r.id)),
	];

	const hBest = ranked[0];
	const fBest = finals[0] ?? { family: '-', score: 0 };
	const hDist = hRank;
	const fRank = finals.findIndex((r) => r.id === familyId) + 1;

	console.log(`\n== "${text}" in ${familyName} (${familyId}) ==`);
	console.log(`   shapes=${comps.length}  guessed="${guess}"  guess_ok=${guess === text.toLowerCase()}  refine=${doRefine ? `"${refineText}"` : 'SKIPPED (no text)'}`);
	console.log(`   hamming : rank=${hDist}  top=${hBest.family} (${hBest.score.toFixed(4)})`);
	console.log(`   refined : rank=${fRank}  top=${fBest.family} (${fBest.score.toFixed(4)})  [safe merge: refined-top-N first]`);
	return { hRank: hDist, fRank, guess, correctGuess: guess === text.toLowerCase(), fBest: fBest.family };
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

let hRanks = [], fRanks = [];
for (const [id, fam, text] of cases) {
	const r = runCase(id, fam, text);
	if (r) { hRanks.push(r.hRank); fRanks.push(r.fRank); }
}
if (hRanks.length) {
	const avg = (a) => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1);
	console.log(`\n=== SUMMARY ===`);
	console.log(`hamming avg rank: ${avg(hRanks)}  (top1: ${hRanks.filter((r) => r === 1).length}/${hRanks.length})`);
	console.log(`refined avg rank: ${avg(fRanks)}  (top1: ${fRanks.filter((r) => r === 1).length}/${fRanks.length})`);
}