// Isolate the TWO suspected causes of the rank collapse on real screenshots:
//   A) binarizer mismatch (DB uses lum<140; browser uses lum<bgLum-40 = <215 on white)
//   B) glyph size mismatch (DB renders at 110px; real text is 28-88px)
// Sweeps font size x binarizer against the CURRENT 110px/lum<140 DB.
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

function lumMask(d, w, h, thresh) {
  const mask = new Uint8ClampedArray(w * h);
  for (let i = 0; i < d.length; i += 4) mask[i / 4] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < thresh ? 1 : 0;
  return mask;
}
function renderWord(familyKey, text, px, thresh) {
  const c = createCanvas(1200, 240);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1200, 240);
  ctx.font = `${px}px ${familyKey}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#000';
  ctx.fillText(text, 24, 195);
  return lumMask(ctx.getImageData(0, 0, 1200, 240).data, 1200, 240, thresh);
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
      if (px < minX) minX = px; if (px > maxX) maxX = px; if (py < minY) minY = py; if (py > maxY) maxY = py;
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
function rank(mask, w, h) {
  const comps = segmentLetters(mask, w, h);
  const compSigs = comps.map((c) => signatureForBox(extractBox(mask, w, c), c.w, c.h)).filter((s) => !isAllZero(s));
  if (!compSigs.length) return -1;
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
    scored.push({ id: manifest.fonts[fi], score: 1 - total / compSigs.length / GRID_BITS });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.findIndex((s) => s.id === 'roboto') + 1;
}

GlobalFonts.registerFromPath(join(ROOT, '.fonts-cache', 'roboto.woff2'), 'rob');
const sizes = [112, 88, 64, 48, 40, 36, 28];
console.log('binarizer A = lum<140 (DB-compatible)   B = lum<215 (browser on white)');
console.log('size |  A   |   B');
for (const px of sizes) {
  const maskA = renderWord('rob', 'Roboto', px, 140);
  const maskB = renderWord('rob', 'Roboto', px, 215);
  const a = rank(maskA, 1200, 240);
  const b = rank(maskB, 1200, 240);
  console.log(`${String(px).padStart(4)} | ${String(a).padStart(4)} | ${String(b).padStart(4)}`);
}