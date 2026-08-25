// Sweep template binarize threshold + weight for wordSim on 40px Roboto source
import { readFileSync } from 'node:fs';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const _d = dirname(fileURLToPath(import.meta.url));
const ROOT = join(_d, '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'public', 'signatures', 'manifest.json'), 'utf8'));

function makeSource(px = 40, thresh = 215) {
  const c = createCanvas(640, 120);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 640, 120);
  ctx.font = `${px}px rkey`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#000'; ctx.fillText('Roboto', 320, 60);
  const d = ctx.getImageData(0, 0, 640, 120).data;
  const m = new Uint8ClampedArray(640 * 120);
  for (let i = 0; i < d.length; i += 4) m[i / 4] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < thresh ? 1 : 0;
  return m;
}
function ink(m, W, H) { let a = W, b = H, c = -1, d = -1; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (m[y*W+x]) { if (x<a)a=x; if (x>c)c=x; if (y<b)b=y; if (y>d)d=y; } return c<0?null:{x:a,y:b,w:c-a+1,h:d-b+1}; }
function ext(m, sw, box) { const o = new Uint8ClampedArray(box.w*box.h); for (let y=0;y<box.h;y++) for (let x=0;x<box.w;x++) o[y*box.w+x]=m[(box.y+y)*sw+(box.x+x)]; return o; }
function scale(m, sw, box, dw, dh) { const o = new Uint8ClampedArray(dw*dh); for (let y=0;y<dh;y++){ const sy=Math.min(box.h-1,Math.floor(y*box.h/dh)); for (let x=0;x<dw;x++){ const sx=Math.min(box.w-1,Math.floor(x*box.w/dw)); o[y*dw+x]=m[(box.y+sy)*sw+(box.x+sx)]; }} return o; }
function cmp(a, b) { const n=Math.min(a.length,b.length); let fg=0,ag=0; for (let i=0;i<n;i++) if (a[i]===1||b[i]===1){fg++; if(a[i]===b[i])ag++;} return fg?ag/fg:0; }
async function wordSim(mask, W, H, familyKey, thresh, weight) {
  const c = createCanvas(320,96); const ctx=c.getContext('2d');
  ctx.fillStyle='#fff'; ctx.fillRect(0,0,320,96);
  ctx.font=`${weight} 44px "${familyKey}", sans-serif`;
  ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillStyle='#000'; ctx.fillText('Roboto',160,48);
  const d=ctx.getImageData(0,0,320,96).data;
  const tpl=new Uint8ClampedArray(320*96);
  for (let i=0;i<d.length;i+=4) tpl[i/4]=0.299*d[i]+0.587*d[i+1]+0.114*d[i+2]<thresh?1:0;
  const tb=ink(tpl,320,96), sb=ink(mask,W,H); if(!tb||!sb) return 0;
  return cmp(scale(mask,W,sb,tb.w,tb.h), ext(tpl,320,tb));
}
GlobalFonts.registerFromPath(join(ROOT, '.fonts-cache', 'roboto.woff2'), 'rkey');
let ok=0;
for (const f of manifest.fonts) { try { if(!GlobalFonts.has(`f-${f}`)) GlobalFonts.registerFromPath(join(ROOT,'.fonts-cache',`${f}.woff2`), `f-${f}`); ok++; } catch {} }
const mask = makeSource(40, 215);
for (const thresh of [140, 180, 215]) {
  for (const weight of [400, 600]) {
    const rows = [];
    for (const f of manifest.fonts) rows.push({ id: f, s: await wordSim(mask, 640, 120, `f-${f}`, thresh, weight) });
    rows.sort((a,b)=>b.s-a.s);
    const r = rows.findIndex(x=>x.id==='roboto')+1;
    console.log(`thresh=${thresh} weight=${weight}: roboto rank=${r} top=${rows.slice(0,3).map(x=>`${x.id}(${x.s.toFixed(3)})`).join(' | ')}`);
  }
}
