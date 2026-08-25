// Experiment: is whole-word mask comparison size-robust where per-letter Hamming fails?
// Case: a REALISTIC 40px "Roboto" screenshot. Hamming puts Roboto ~rank 222.
// Question: does rendering the word in each font (44px) and comparing to the scaled
// source word mask pull Roboto into the top? Runs wordSim over the FULL 1817-font DB.
import { readFileSync } from 'node:fs';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { gunzipSync } from 'node:zlib';
import { signatureForBox, hammingDistance, isAllZero, BYTES_PER_GLYPH, CHARS, GRID_BITS } from '../src/lib/client/fingerprint-core.ts';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'public', 'signatures', 'manifest.json'), 'utf8'));
const raw = gunzipSync(readFileSync(join(ROOT, 'public', 'signatures', 'regular.bin.gz')));
const glyphsPerFont = CHARS.length;
const rowBytes = BYTES_PER_GLYPH * glyphsPerFont;

// --- build the realistic source: 640x120 canvas, "Roboto" at 40px center, white bg ---
function makeSource() {
  const c = createCanvas(640, 120);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 640, 120);
  ctx.font = '40px rkey';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#000';
  ctx.fillText('Roboto', 320, 60);
  const { data } = ctx.getImageData(0, 0, 640, 120);
  const mask = new Uint8ClampedArray(640 * 120);
  for (let i = 0; i < data.length; i += 4) {
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    mask[i / 4] = lum < 215 ? 1 : 0; // browser polarity on white
  }
  return mask;
}
function inkBBox(m, W, H) {
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (m[y * W + x] === 1) {
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
function extractBox(m, srcW, box) {
  const out = new Uint8ClampedArray(box.w * box.h);
  for (let y = 0; y < box.h; y++) for (let x = 0; x < box.w; x++) out[y * box.w + x] = m[(box.y + y) * srcW + (box.x + x)];
  return out;
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
function wordSim(mask, srcW, srcH, familyKey, text) {
  const c = createCanvas(320, 96);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 320, 96);
  ctx.font = `600 44px "${familyKey}", sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#000';
  ctx.fillText(text, 160, 48);
  const { data } = ctx.getImageData(0, 0, 320, 96);
  const tpl = new Uint8ClampedArray(320 * 96);
  for (let i = 0; i < data.length; i += 4) tpl[i / 4] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] < 140 ? 1 : 0;
  const tb = inkBBox(tpl, 320, 96);
  const sb = inkBBox(mask, srcW, srcH);
  if (!tb || !sb) return 0;
  const scaled = scaleBoxTo(mask, srcW, sb, tb.w, tb.h);
  return compareMasks(scaled, extractBox(tpl, 320, tb));
}

// Hamming first pass
function hammingTop(mask, w, h, topN) {
  // segment letters
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
      c++; if (px < minX) minX = px; if (px > maxX) maxX = px; if (py < minY) minY = py; if (py > maxY) maxY = py;
      if (px > 0 && !visited[p - 1] && mask[p - 1] === 1) { visited[p - 1] = 1; stack.push(p - 1); }
      if (px < w - 1 && !visited[p + 1] && mask[p + 1] === 1) { visited[p + 1] = 1; stack.push(p + 1); }
      if (py > 0 && !visited[p - w] && mask[p - w] === 1) { visited[p - w] = 1; stack.push(p - w); }
      if (py < h - 1 && !visited[p + w] && mask[p + w] === 1) { visited[p + w] = 1; stack.push(p + w); }
    }
    if (c < minArea) continue;
    comps.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 });
  }
  comps.sort((a, b) => a.y - b.y || a.x - b.x);
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
  return scored.slice(0, topN);
}

GlobalFonts.registerFromPath(join(ROOT, '.fonts-cache', 'roboto.woff2'), 'rkey');
const mask = makeSource();
const w = 640, h = 120;
const robH = hammingTop(mask, w, h, 1).find(x => x.id === 'roboto');
const full = hammingTop(mask, w, h, 1817);
const hRank = full.findIndex((s) => s.id === 'roboto') + 1;
console.log(`source: Roboto 40px (lum<215). hamming rank = ${hRank} (top=${full[0].family})`);

// Register ALL fonts (1817 cached woff2s) for wordSim
let ok = 0, fail = 0;
for (const f of manifest.fonts) {
  const p = join(ROOT, '.fonts-cache', `${f}.woff2`);
  try { if (!GlobalFonts.has(`f-${f}`)) GlobalFonts.registerFromPath(p, `f-${f}`); ok++; } catch { fail++; }
}
console.log(`registered ${ok} fonts (fail ${fail})`);

// wordSim over full DB
const ws = [];
for (const f of manifest.fonts) {
  const s = wordSim(mask, w, h, `f-${f}`, 'Roboto');
  ws.push({ id: f, family: manifest.families[manifest.fonts.indexOf(f)], s });
}
ws.sort((a, b) => b.s - a.s);
const robWs = ws.findIndex((x) => x.id === 'roboto') + 1;
console.log(`wordSim rank over ALL ${manifest.fonts.length}: roboto = ${robWs}`);
console.log(`wordSim top15: ${ws.slice(0, 15).map((x) => `${x.family}(${x.s.toFixed(3)})`).join(' | ')}`);

// blend: 0.5 hamming(top-N scaled) + 0.5 wordSim within top-400 pool
const pool = full.slice(0, 400).filter((x) => GlobalFonts.has(`f-${x.id}`));
const blended = pool.map((p) => {
  const wv = ws.find((x) => x.id === p.id);
  return { id: p.id, family: p.family, s: 0.5 * p.score + 0.5 * (wv?.s ?? 0) };
}).sort((a, b) => b.s - a.s);
const robBl = blended.findIndex((x) => x.id === 'roboto') + 1;
console.log(`0.5*ham(top400)+0.5*wordSim: roboto rank = ${robBl}`);
console.log(`blend top15: ${blended.slice(0, 15).map((x) => `${x.family}(${x.s.toFixed(3)})`).join(' | ')}`);