// GRAND: which first-pass signal is robust to real screenshot sizes?
// Builds in-memory DBs for ALL 1817 fonts at multiple render sizes and binarizers,
// then ranks a realistic 40px "Roboto" screenshot (browser binarize = lum<215) under:
//   a) Hamming vs current 110px/lum<140 DB  (baseline; known-bad ~222)
//   b) Hamming vs size-matched render of the SAME binarizer at 40/56/88px
//   c) multi-size min-distance across {40,56,88,110}
//   d) density-profile features (aspect + 12 rows + 16 cols) at 110px, L1
import { readFileSync } from 'node:fs';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { gunzipSync } from 'node:zlib';
import { signatureForBox, hammingDistance, isAllZero, BYTES_PER_GLYPH, CHARS, GRID_BITS } from '../src/lib/client/fingerprint-core.ts';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const _d = dirname(fileURLToPath(import.meta.url));
const ROOT = join(_d, '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'public', 'signatures', 'manifest.json'), 'utf8'));
const raw110 = gunzipSync(readFileSync(join(ROOT, 'public', 'signatures', 'regular.bin.gz')));
const glyphs = CHARS.length;
const rowBytes = BYTES_PER_GLYPH * glyphs;

// --- render one glyph to an ink-box mask with a given binarize threshold ---
// fresh canvas per call: long runs on a reused canvas segfault the native napi-rs
// canvas on Windows. Cost is acceptable (GC reclaims between fonts).
function glyphBox(ch, key, px, thresh) {
  const c2 = createCanvas(192, 192);
  const c2ctx = c2.getContext('2d');
  c2ctx.fillStyle = '#fff'; c2ctx.fillRect(0, 0, 192, 192);
  c2ctx.font = `${px}px ${key}`;
  c2ctx.textBaseline = 'alphabetic'; c2ctx.fillStyle = '#000';
  c2ctx.fillText(ch, 8, 150);
  const d = c2ctx.getImageData(0, 0, 192, 192).data;
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
// density features: aspect + 12 row densities + 16 col densities (old FF system)
const FEAT_LEN = 1 + 12 + 16;
function densityFeatures(box, w, h) {
  const out = new Float32Array(FEAT_LEN);
  out[0] = w / h; // aspect
  for (let y = 0; y < h; y++) { const r = Math.min(11, Math.floor((y * 12) / h)); let c = 0; for (let x = 0; x < w; x++) c += box[y * w + x]; out[1 + r] += c / w; }
  for (let x = 0; x < w; x++) { const cc = Math.min(15, Math.floor((x * 16) / w)); let c = 0; for (let y = 0; y < h; y++) c += box[y * w + x]; out[1 + 12 + cc] += c / h; }
  return out;
}
function densityL1(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s; }

// register all fonts
let reg = 0;
for (const id of manifest.fonts) {
  try { if (!GlobalFonts.has(`f-${id}`)) GlobalFonts.registerFromPath(join(ROOT, '.fonts-cache', `${id}.woff2`), `f-${id}`); reg++; } catch { }
}
console.log(`registered ${reg} fonts`);

// build per-size in-memory DBs
async function buildSizeDB(px, thresh) {
  const bits = new Array(manifest.fonts.length);
  const dens = new Array(manifest.fonts.length);
  for (let fi = 0; fi < manifest.fonts.length; fi++) {
    const key = `f-${manifest.fonts[fi]}`;
    const b = new Uint8Array(BYTES_PER_GLYPH * glyphs);
    const d = new Float32Array(FEAT_LEN * glyphs);
    for (let gi = 0; gi < glyphs; gi++) {
      const g = glyphBox(CHARS[gi], key, px, thresh);
      if (g) {
        b.set(signatureForBox(g.box, g.w, g.h), gi * BYTES_PER_GLYPH);
        d.set(densityFeatures(g.box, g.w, g.h), gi * FEAT_LEN);
      }
    }
    bits[fi] = b; dens[fi] = d;
  }
  return { bits, dens };
}

// realistic 40px Roboto screenshot (browser binarize)
function makeQuery(px, thresh) {
  const c = createCanvas(640, 120);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 640, 120);
  ctx.font = `${px}px f-roboto`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#000';
  ctx.fillText('Roboto', 320, 60);
  const d = ctx.getImageData(0, 0, 640, 120).data;
  const m = new Uint8ClampedArray(640 * 120);
  for (let i = 0; i < d.length; i += 4) m[i / 4] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < thresh ? 1 : 0;
  // segment + signatures + density
  const visited = new Uint8Array(640 * 120);
  const comps = [];
  const minArea = 8;
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
    if (c0 < minArea) continue;
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

function rankByBits(query, db, dbSize) {
  const scored = [];
  for (let fi = 0; fi < manifest.fonts.length; fi++) {
    const base = (fi * dbSize * glyphs);
    let total = 0;
    for (const s of query) {
      let best = Number.POSITIVE_INFINITY;
      for (let gi = 0; gi < glyphs; gi++) { const d = hammingDistance(s, db[fi], gi * dbSize); if (d < best) best = d; }
      total += best;
    }
    scored.push({ id: manifest.fonts[fi], score: 1 - total / query.length / GRID_BITS });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}
function rankByDensity(queryDens, dbDens) {
  const scored = [];
  for (let fi = 0; fi < manifest.fonts.length; fi++) {
    let total = 0;
    for (const qd of queryDens) {
      let best = Number.POSITIVE_INFINITY;
      for (let gi = 0; gi < glyphs; gi++) { const d = densityL1(qd, dbDens[fi].subarray(gi * FEAT_LEN, (gi + 1) * FEAT_LEN)); if (d < best) best = d; }
      total += best;
    }
    scored.push({ id: manifest.fonts[fi], score: -total / queryDens.length });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}
function robRank(list) { const i = list.findIndex((x) => x.id === 'roboto'); return i + 1; }

// existing 110px DB (lum<140) — this is what the site ships today
function rankAgainstShipped(querySigs) {
  const scored = [];
  for (let fi = 0; fi < manifest.fonts.length; fi++) {
    const base = fi * rowBytes;
    let total = 0;
    for (const s of querySigs) {
      let best = Number.POSITIVE_INFINITY;
      for (let gi = 0; gi < glyphs; gi++) { const d = hammingDistance(s, raw110, base + gi * BYTES_PER_GLYPH); if (d < best) best = d; }
      total += best;
    }
    scored.push({ id: manifest.fonts[fi], score: 1 - total / querySigs.length / GRID_BITS });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

const SIZES = [40, 56, 88];
const dbs = {};
for (const px of SIZES) {
  console.log(`building ${px}px db (browser binarize 215)...`);
  dbs[px] = await buildSizeDB(px, 215);
}

for (const qpx of [28, 40, 56, 88]) {
  const q = makeQuery(qpx, 215);
  if (!q.sigs.length) { console.log(`\nqpx=${qpx}: no shapes`); continue; }
  const shipped = rankAgainstShipped(q.sigs);
  const top40 = rankByBits(q.sigs, dbs[40].bits, BYTES_PER_GLYPH);
  const top56 = rankByBits(q.sigs, dbs[56].bits, BYTES_PER_GLYPH);
  const top88 = rankByBits(q.sigs, dbs[88].bits, BYTES_PER_GLYPH);
  // multi-size: min distance across {40,56,88} per font per comp
  const multi = [];
  for (let fi = 0; fi < manifest.fonts.length; fi++) {
    let total = 0;
    for (const s of q.sigs) {
      let best = Number.POSITIVE_INFINITY;
      for (const db of [dbs[40].bits, dbs[56].bits, dbs[88].bits]) for (let gi = 0; gi < glyphs; gi++) {
        const d = hammingDistance(s, db[fi], gi * BYTES_PER_GLYPH); if (d < best) best = d;
      }
      total += best;
    }
    multi.push({ id: manifest.fonts[fi], score: 1 - total / q.sigs.length / GRID_BITS });
  }
  multi.sort((a, b) => b.score - a.score);
  // density at 88px (big, robust)
  const dens88 = rankByDensity(q.dens, dbs[88].dens);
  console.log(`\n=== query Roboto @ ${qpx}px (browser binarize) ===`);
  console.log(`  shipped-110-140 : roboto rank=${robRank(shipped)}  top=${shipped[0].family}(${shipped[0].score.toFixed(4)})`);
  console.log(`  match-40px      : roboto rank=${robRank(top40)}  top=${top40[0].family}(${top40[0].score.toFixed(3)})`);
  console.log(`  match-56px      : roboto rank=${robRank(top56)}  top=${top56[0].family}(${top56[0].score.toFixed(3)})`);
  console.log(`  match-88px      : roboto rank=${robRank(top88)}  top=${top88[0].family}(${top88[0].score.toFixed(3)})`);
  console.log(`  min-40/56/88    : roboto rank=${robRank(multi)}  top=${multi[0].family}(${multi[0].score.toFixed(3)})`);
  console.log(`  density@88      : roboto rank=${robRank(dens88)}  top=${dens88[0].family}(${dens88[0].score.toFixed(3)})`);
}