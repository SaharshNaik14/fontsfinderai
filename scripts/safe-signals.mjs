// SAFE signal probe: WHICH FIRST-PASS SIGNAL ranks the true font #1 at SMALL sizes?
// Small, memory-light: ~25 fonts (roboto + the ones that beat it everywhere), fewer renders.
// Runs fresh canvases per glyph, one font at a time, no giant in-memory DBs.
// Answer feeds the engine decision: multi-size bits vs density-profile features.
import { readFileSync } from 'node:fs';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { signatureForBox, hammingDistance, isAllZero, BYTES_PER_GLYPH, CHARS, GRID_BITS } from '../src/lib/client/fingerprint-core.ts';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const _d = dirname(fileURLToPath(import.meta.url));
const ROOT = join(_d, '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'public', 'signatures', 'manifest.json'), 'utf8'));
const glyphs = CHARS.length;

const FONTS = ['roboto', 'roboto-flex', 'heebo', 'vazirmatn', 'ibm-plex-sans', 'ibm-plex-sans-condensed',
  'atkinson-hyperlegible-next', 'encode-sans', 'encode-sans-condensed', 'nata-sans', 'special-gothic',
  'anuphan', 'yantramanav', 'palanquin', 'krub', 'red-hat-text', 'shippori-antique', 'bench-nine',
  'sansita', 'mansalva', 'karla', 'kanit', 'lato', 'open-sans', 'montserrat'];

// --- glyph render -> ink box (browser-consistent binarize = bhresh, DB-style crop) ---
function glyphBox(ch, key, px, thresh) {
  const c = createCanvas(192, 192);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 192, 192);
  ctx.font = `${px}px ${key}`;
  ctx.textBaseline = 'alphabetic'; ctx.fillStyle = '#000';
  ctx.fillText(ch, 8, 150);
  const d = ctx.getImageData(0, 0, 192, 192).data;
  let minX = 192, minY = 192, maxX = -1, maxY = -1;
  for (let y = 0; y < 192; y++) for (let x = 0; x < 192; x++) {
    const i = (y * 192 + x) * 4;
    if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < thresh) {
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  const w = maxX - minX + 1, h = maxY - minY + 1;
  const box = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = ((minY + y) * 192 + (minX + x)) * 4;
    box[y * w + x] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < thresh ? 1 : 0;
  }
  return { box, w, h };
}
const FEAT_LEN = 1 + 12 + 16;
function densityFeatures(box, w, h) {
  const out = new Float32Array(FEAT_LEN);
  out[0] = w / h;
  for (let y = 0; y < h; y++) { const r = Math.min(11, Math.floor((y * 12) / h)); let c = 0; for (let x = 0; x < w; x++) c += box[y * w + x]; out[1 + r] += c / w; }
  for (let x = 0; x < w; x++) { const cc = Math.min(15, Math.floor((x * 16) / w)); let c = 0; for (let y = 0; y < h; y++) c += box[y * w + x]; out[1 + 12 + cc] += c / h; }
  return out;
}
function densityL1(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s; }

// register the 25 fonts under FF-N keys
for (const f of FONTS) {
  try { if (!GlobalFonts.has(`F-${f}`)) GlobalFonts.registerFromPath(join(ROOT, '.fonts-cache', `${f}.woff2`), `F-${f}`); } catch {}
}

// tiny per-font "DB" sets: bits at {32,56,88}, density at {56,110}
async function fontDB(f) {
  const key = `F-${f}`;
  const out = {};
  for (const px of [32, 56, 88]) {
    const b = new Uint8Array(BYTES_PER_GLYPH * glyphs);
    for (let gi = 0; gi < glyphs; gi++) { const g = glyphBox(CHARS[gi], key, px, 215); if (g) b.set(signatureForBox(g.box, g.w, g.h), gi * BYTES_PER_GLYPH); }
    out[`bits${px}`] = b;
  }
  for (const px of [56, 110]) {
    const d = new Float32Array(FEAT_LEN * glyphs);
    for (let gi = 0; gi < glyphs; gi++) { const g = glyphBox(CHARS[gi], key, px, 215); if (g) d.set(densityFeatures(g.box, g.w, g.h), gi * FEAT_LEN); }
    out[`dens${px}`] = d;
  }
  return out;
}

// query segmentation -> {bits[], dens[]} for a rendered word at qpx (lum 215)
function queryFor(f, qpx) {
  const c = createCanvas(640, 120);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 640, 120);
  ctx.font = `${qpx}px F-${f}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#000';
  ctx.fillText('Roboto', 320, 60);
  const d = ctx.getImageData(0, 0, 640, 120).data;
  const m = new Uint8ClampedArray(640 * 120);
  for (let i = 0; i < d.length; i += 4) m[i / 4] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < 215 ? 1 : 0;
  const visited = new Uint8Array(640 * 120);
  const comps = [];
  for (let y = 0; y < 120; y++) for (let x = 0; x < 640; x++) {
    const i = y * 640 + x;
    if (m[i] !== 1 || visited[i]) continue;
    const stack = [i]; visited[i] = 1;
    let c0 = 0, a = 640, b = 120, cc = -1, dd = -1;
    while (stack.length) { const p = stack.pop(); const px2 = p % 640, py = (p / 640) | 0; c0++; if (px2 < a) a = px2; if (px2 > cc) cc = px2; if (py < b) b = py; if (py > dd) dd = py;
      if (px2 > 0 && !visited[p - 1] && m[p - 1] === 1) { visited[p - 1] = 1; stack.push(p - 1); }
      if (px2 < 639 && !visited[p + 1] && m[p + 1] === 1) { visited[p + 1] = 1; stack.push(p + 1); }
      if (py > 0 && !visited[p - 640] && m[p - 640] === 1) { visited[p - 640] = 1; stack.push(p - 640); }
      if (py < 119 && !visited[p + 640] && m[p + 640] === 1) { visited[p + 640] = 1; stack.push(p + 640); }
    }
    if (c0 < 8) continue;
    comps.push({ x: a, y: b, w: cc - a + 1, h: dd - b + 1 });
  }
  comps.sort((a, b) => a.y - b.y || a.x - b.x);
  const sigs = [], dens = [];
  for (const c of comps) {
    const box = new Uint8ClampedArray(c.w * c.h);
    for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) box[y * c.w + x] = m[(c.y + y) * 640 + (c.x + x)];
    const s = signatureForBox(box, c.w, c.h);
    if (isAllZero(s)) continue;
    sigs.push(s); dens.push(densityFeatures(box, c.w, c.h));
  }
  return { sigs, dens };
}
function rankIn(fonts, scoreFn) {
  const arr = fonts.map((f) => ({ f, s: scoreFn(f) })).sort((a, b) => b.s - a.s);
  return { rank: arr.findIndex((x) => x.f === 'roboto') + 1, top: arr.slice(0, 3).map((x) => `${x.f}(${x.s.toFixed(3)})`).join('|') };
}

console.log('fonts:', FONTS.length);
console.log('building per-font DBs (fresh canvas each glyph, one font at a time)...');
const db = new Map();
for (const f of FONTS) { const r = await fontDB(f); db.set(f, r); }
console.log('DBs built. query sizes: 28 40 56 88 | signals: min-bits(32/56/88), best-single-bits, dens@56, dens@110');
console.log('roboto true-font rank among the 25 (smaller = better, 1 = perfect)');

for (const qpx of [28, 40, 56, 88]) {
  const q = queryFor('roboto', qpx);
  if (!q.sigs.length) { console.log(`qpx=${qpx}: no shapes`); continue; }
  const minBits = rankIn(FONTS, (f) => {
    const d = db.get(f);
    let total = 0;
    for (const s of q.sigs) { let best = Infinity; for (const px of [32, 56, 88]) for (let gi = 0; gi < glyphs; gi++) { const hd = hammingDistance(s, d[`bits${px}`], gi * BYTES_PER_GLYPH); if (hd < best) best = hd; } total += best; }
    return 1 - total / q.sigs.length / GRID_BITS;
  });
  const bestSingle = rankIn(FONTS, (f) => {
    const d = db.get(f);
    const bestPx = qpx >= 88 ? 88 : qpx >= 56 ? 56 : qpx >= 40 ? 56 : 32;
    let total = 0;
    for (const s of q.sigs) { let best = Infinity; for (let gi = 0; gi < glyphs; gi++) { const hd = hammingDistance(s, d[`bits${bestPx}`], gi * BYTES_PER_GLYPH); if (hd < best) best = hd; } total += best; }
    return 1 - total / q.sigs.length / GRID_BITS;
  });
  const dens56 = rankIn(FONTS, (f) => {
    const d = db.get(f); let total = 0;
    for (const qd of q.dens) { let best = Infinity; for (let gi = 0; gi < glyphs; gi++) { const dd = densityL1(qd, d.dens56.subarray(gi * FEAT_LEN, (gi + 1) * FEAT_LEN)); if (dd < best) best = dd; } total += best; }
    return -total / q.dens.length;
  });
  const dens110 = rankIn(FONTS, (f) => {
    const d = db.get(f); let total = 0;
    for (const qd of q.dens) { let best = Infinity; for (let gi = 0; gi < glyphs; gi++) { const dd = densityL1(qd, d.dens110.subarray(gi * FEAT_LEN, (gi + 1) * FEAT_LEN)); if (dd < best) best = dd; } total += best; }
    return -total / q.dens.length;
  });
  console.log(`qpx=${String(qpx).padStart(2)}  min-bits: ${String(minBits.rank).padStart(2)} (${minBits.top})  |  single-bits: ${String(bestSingle.rank).padStart(2)}  |  dens@56: ${String(dens56.rank).padStart(2)}  |  dens@110: ${String(dens110.rank).padStart(2)}`);
}