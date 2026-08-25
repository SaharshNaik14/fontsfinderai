// Reproduce the user's failure: a REAL screenshot containing Roboto text that
// should rank Roboto in the top 15 but apparently doesn't. Renders realistic
// screenshots (small text, real canvas sizes, bg colors, JPEG compression) and
// runs the EXACT browser pipeline:
//   prepareImage (autoCrop → downscale → corner-lum binarize) →
//   segmentLetters → signatureForBox → Hamming vs 1817-font DB → top-15 report.
import { readFileSync } from 'node:fs';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
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

// --- exact browser pipeline (copied verbatim from match.ts / repro-browser-match.mjs) ---
function getContext(canvas) {
  return canvas.getContext('2d', { willReadFrequently: true });
}
function sampleBackground(data, width, height) {
  const corners = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]];
  let r = 0, g = 0, b = 0;
  for (const [x, y] of corners) { const i = (y * width + x) * 4; r += data[i]; g += data[i + 1]; b += data[i + 2]; }
  return [r / 4, g / 4, b / 4];
}
function autoCrop(src, ctx, x0, y0, w0, h0) {
  const imageData = ctx.getImageData(x0, y0, w0, h0);
  const { data, width, height } = imageData;
  const bg = sampleBackground(data, width, height);
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const dist = Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]);
    if (dist > 48) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
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
  for (const [x, y] of corners) { const i = (y * width + x) * 4; sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; }
  return sum / corners.length;
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
function extractBox(mask, w, c) {
  const out = new Uint8ClampedArray(c.w * c.h);
  for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) out[y * c.w + x] = mask[(c.y + y) * w + (c.x + x)];
  return out;
}

function rank(mask, w, h, label) {
  const comps = segmentLetters(mask, w, h);
  const compSigs = comps.map((c) => signatureForBox(extractBox(mask, w, c), c.w, c.h)).filter((s) => !isAllZero(s));
  console.log(`\n== ${label} ==`);
  console.log(`   case sw/h=${w}x${h}  shapes=${comps.length}  valid sigs=${compSigs.length}`);
  if (compSigs.length === 0) { console.log('   -> NO SHAPES\n'); return; }
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
  const robIdx = scored.findIndex((s) => s.id === 'roboto');
  console.log(`   Roboto rank=${robIdx + 1}  score=${robIdx >= 0 ? scored[robIdx].score.toFixed(3) : '-'}`);
  console.log(`   top15: ${scored.slice(0, 15).map((s) => `${s.family}(${s.score.toFixed(3)})`).join(' | ')}`);
}

// ---- realistic screenshot factory ----
// target: W×H canvas, text centered at px size in a font key (fr[family]), bg color, ink color,
// optional jpeg quality < 1 to simulate compression artifacts, optional extra chrome (nav bar text).
async function renderShot({ W, H, family, text, px, bg = [255, 255, 255], fg = [0, 0, 0], weight = 400, jpeg = 1, baseline = 0.5 }) {
  const c = createCanvas(W, H);
  const ctx = getContext(c);
  ctx.fillStyle = `rgb(${bg[0]},${bg[1]},${bg[2]})`;
  ctx.fillRect(0, 0, W, H);
  ctx.font = `${weight} ${px}px "${family}", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = baseline === 0.5 ? 'middle' : 'alphabetic';
  ctx.fillStyle = `rgb(${fg[0]},${fg[1]},${fg[2]})`;
  if (baseline === 0.5) ctx.fillText(text, W / 2, H / 2);
  else {
    // alphabetic baseline near bottom, like a real layout
    ctx.fillText(text, W / 2, H - Math.round(px * 0.2));
  }
  // Re-encode through an image buffer to reproduce compression artifacts
  // (lossless PNG otherwise). Mirrors the browser canvas→toDataURL round-trip.
  const buf = jpeg && jpeg < 1 ? c.toBuffer('image/jpeg', jpeg) : c.toBuffer('image/png');
  const img = await loadImage(buf);
  const out = createCanvas(W, H);
  getContext(out).drawImage(img, 0, 0);
  return out;
}

const cases = [
  // heading-ish (large), white bg — should be easy
  { W: 800, H: 300, family: 'flf-roboto', text: 'Roboto', px: 80, bg: [255, 255, 255], label: 'Roboto 80px white' },
  // body text (small), white bg — realistic
  { W: 640, H: 120, family: 'flf-roboto', text: 'Roboto', px: 40, bg: [255, 255, 255], label: 'Roboto 40px white' },
  // body text smaller
  { W: 640, H: 90, family: 'flf-roboto', text: 'Roboto', px: 28, bg: [255, 255, 255], label: 'Roboto 28px white' },
  // light gray bg (Material-style card)
  { W: 640, H: 120, family: 'flf-roboto', text: 'Roboto', px: 40, bg: [245, 245, 245], label: 'Roboto 40px #f5f5f5' },
  // dark bg, white text
  { W: 640, H: 120, family: 'flf-roboto', text: 'Roboto', px: 40, bg: [20, 20, 20], fg: [255, 255, 255], label: 'Roboto 40px dark' },
  // jpeg q0.8 artifact (like a screenshot saved as jpg)
  { W: 640, H: 120, family: 'flf-roboto', text: 'Roboto', px: 40, bg: [255, 255, 255], jpeg: 0.85, label: 'Roboto 40px white jpeg0.85' },
  // lowercase + title (what users actually screen-shot)
  { W: 640, H: 140, family: 'flf-roboto', text: 'Roboto Regular', px: 36, bg: [255, 255, 255], label: 'Roboto Regular 36px' },
  // bold weight
  { W: 640, H: 120, family: 'flf-roboto', text: 'Roboto', px: 40, bg: [255, 255, 255], weight: 700, label: 'Roboto 700 40px white' },
  // gray text on white (disabled/body copy)
  { W: 640, H: 120, family: 'flf-roboto', text: 'Roboto', px: 40, bg: [255, 255, 255], fg: [120, 120, 120], label: 'Roboto 40px gray-text' },
];

// register roboto cached woff2
try {
  GlobalFonts.registerFromPath(join(ROOT, '.fonts-cache', 'roboto.woff2'), 'flf-roboto');
} catch (e) {
  console.error('cannot register roboto:', e.message);
  process.exit(1);
}

for (const k of cases) {
  const src = await renderShot(k);
  // full prepareImage path: autoCrop → (downscale only if >1024) → corner-lum binarize
  const cropped = autoCrop(src, getContext(src), 0, 0, src.width, src.height);
  const fitted = cropped.imageData; // {imageData,width,height} — cropped canvas image data
  const bgLum = sampleCornerLum(fitted.data, fitted.width, fitted.height);
  const mask = binarizeImageData(fitted, bgLum);
  rank(mask, fitted.width, fitted.height, `${k.label} | bgLum=${bgLum.toFixed(0)}`);
}