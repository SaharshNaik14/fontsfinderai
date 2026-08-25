import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GlobalFonts, createCanvas } from '@napi-rs/canvas';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CACHE = join(ROOT, '.fonts-cache');

const GLYPHS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const SIZES = { a: 1 + 12 + 16, b: 1 + 120, c: 1 + 192, d: 1 + 280, e: 1 + 384 };

function renderGlyph(ch, familyKey, canvas, ctx) {
	ctx.fillStyle = '#fff';
	ctx.fillRect(0, 0, 192, 192);
	ctx.font = `110px ${familyKey}`;
	ctx.textBaseline = 'alphabetic';
	ctx.fillStyle = '#000';
	ctx.fillText(ch, 8, 150);
	const img = ctx.getImageData(0, 0, 192, 192);
	const data = img.data;
	let minX = 192, minY = 192, maxX = -1, maxY = -1;
	for (let y = 0; y < 192; y++) {
		for (let x = 0; x < 192; x++) {
			const i = (y * 192 + x) * 4;
			const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
			if (lum < 140) {
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
		}
	}
	if (maxX < 0) return null;
	const w = maxX - minX + 1;
	const h = maxY - minY + 1;
	const mask = new Uint8ClampedArray(w * h);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = ((minY + y) * 192 + (minX + x)) * 4;
			mask[y * w + x] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] < 140 ? 1 : 0;
		}
	}
	return { mask, w, h };
}

const canvas = createCanvas(192, 192);
const ctx = canvas.getContext('2d');

function featuresA(mask, w, h, out) {
	// aspect + rows12 + cols16 densities
	out[0] = Math.round((w / h) * 128);
	const ROWS = 12, COLS = 16;
	for (let r = 0; r < ROWS; r++) {
		const y0 = (r * h) / ROWS;
		const y1 = ((r + 1) * h) / ROWS;
		let ink = 0, total = 0;
		for (let y = Math.floor(y0); y < Math.min(h, Math.ceil(y1)); y++) {
			const row = y * w;
			for (let x = 0; x < w; x++) { total++; if (mask[row + x]) ink++; }
		}
		out[1 + r] = total ? Math.round((ink / total) * 255) : 0;
	}
	for (let c = 0; c < COLS; c++) {
		const x0 = (c * w) / COLS;
		const x1 = ((c + 1) * w) / COLS;
		let ink = 0, total = 0;
		for (let y = 0; y < h; y++) {
			for (let x = Math.floor(x0); x < Math.min(w, Math.ceil(x1)); x++) { total++; if (mask[y * w + x]) ink++; }
		}
		out[1 + ROWS + c] = total ? Math.round((ink / total) * 255) : 0;
	}
}

function gridDensity(mask, w, h, gw, gh, out) {
	for (let gy = 0; gy < gh; gy++) {
		const y0 = (gy * h) / gh;
		const y1 = ((gy + 1) * h) / gh;
		for (let gx = 0; gx < gw; gx++) {
			const x0 = (gx * w) / gw;
			const x1 = ((gx + 1) * w) / gw;
			let ink = 0, total = 0;
			for (let y = Math.floor(y0); y < Math.min(h, Math.ceil(y1)); y++) {
				for (let x = Math.floor(x0); x < Math.min(w, Math.ceil(x1)); x++) {
					total++;
					if (mask[y * w + x]) ink++;
				}
			}
			out[gy * gw + gx] = total ? ink / total : 0;
		}
	}
}

function featuresD(mask, w, h, gw, gh, out) {
	out[0] = Math.round((w / h) * 128);
	gridDensity(mask, w, h, gw, gh, out.subarray(1));
	for (let i = 1; i < out.length; i++) out[i] = Math.round(out[i] * 255);
}

function distD(a, b) {
	let aspect = Math.abs(a[0] - b[0]) / 255;
	let sum = 0;
	const n = a.length - 1;
	for (let i = 1; i < a.length; i++) sum += Math.abs(a[i] - b[i]) / 255;
	return 2 * aspect + sum / n;
}

const fonts = readdirSync(CACHE).filter((f) => f.endsWith('.woff2'));
console.log('cached fonts:', fonts.length);

const db = {
	a: [], b: [], c: [], d: [], e: [],
};
let fi = 0;
for (const file of fonts) {
	const id = file.replace('.woff2', '');
	const familyKey = `FF-${id}`;
	GlobalFonts.registerFromPath(join(CACHE, file), familyKey);
	const rows = GLYPHS.split('').map((ch) => renderGlyph(ch, familyKey, canvas, ctx));
	db.a.push(rows.map((g) => { const o = new Uint8Array(SIZES.a); if (g) featuresA(g.mask, g.w, g.h, o); return o; }));
	db.b.push(rows.map((g) => { const o = new Uint8Array(SIZES.b); if (g) featuresD(g.mask, g.w, g.h, 12, 10, o); return o; }));
	db.c.push(rows.map((g) => { const o = new Uint8Array(SIZES.c); if (g) featuresD(g.mask, g.w, g.h, 16, 12, o); return o; }));
	db.d.push(rows.map((g) => { const o = new Uint8Array(SIZES.d); if (g) featuresD(g.mask, g.w, g.h, 20, 14, o); return o; }));
	db.e.push(rows.map((g) => { const o = new Uint8Array(SIZES.e); if (g) featuresD(g.mask, g.w, g.h, 24, 16, o); return o; }));
	if (fi % 300 === 0) console.log('db built:', fi);
	fi++;
}

function segment(mask, w, h) {
	const visited = new Uint8Array(w * h);
	const comps = [];
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = y * w + x;
			if (mask[i] !== 1 || visited[i]) continue;
			const stack = [i];
			visited[i] = 1;
			let minX = w, minY = h, maxX = -1, maxY = -1;
			while (stack.length) {
				const p = stack.pop();
				const px = p % w, py = (p / w) | 0;
				if (px < minX) minX = px;
				if (px > maxX) maxX = px;
				if (py < minY) minY = py;
				if (py > maxY) maxY = py;
				if (px > 0 && !visited[p - 1] && mask[p - 1] === 1) { visited[p - 1] = 1; stack.push(p - 1); }
				if (px < w - 1 && !visited[p + 1] && mask[p + 1] === 1) { visited[p + 1] = 1; stack.push(p + 1); }
				if (py > 0 && !visited[p - w] && mask[p - w] === 1) { visited[p - w] = 1; stack.push(p - w); }
				if (py < h - 1 && !visited[p + w] && mask[p + w] === 1) { visited[p + w] = 1; stack.push(p + w); }
			}
			comps.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 });
		}
	}
	return comps;
}

function extractBox(mask, w, c) {
	const box = new Uint8ClampedArray(c.w * c.h);
	for (let y = 0; y < c.h; y++) {
		for (let x = 0; x < c.w; x++) {
			box[y * c.w + x] = mask[(c.y + y) * w + (c.x + x)];
		}
	}
	return box;
}

function renderWord(familyKey, text) {
	const c = createCanvas(1200, 240);
	const g = c.getContext('2d');
	g.fillStyle = '#fff';
	g.fillRect(0, 0, 1200, 240);
	g.font = `150px ${familyKey}`;
	g.textBaseline = 'alphabetic';
	g.fillStyle = '#000';
	g.fillText(text, 24, 190);
	const img = g.getImageData(0, 0, 1200, 240);
	const mask = new Uint8ClampedArray(1200 * 240);
	for (let i = 0; i < img.data.length; i += 4) {
		const lum = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
		mask[i / 4] = lum < 140 ? 1 : 0;
	}
	return { mask, w: 1200, h: 240 };
}

function rankFor(dbKey, makeFeats, comps, expectedId, label) {
	const scored = [];
	for (let fi = 0; fi < db[dbKey].length; fi++) {
		const glyphs = db[dbKey][fi];
		let total = 0;
		for (const cf of comps) {
			let best = Infinity;
			for (const g of glyphs) {
				const d = distD(cf, g);
				if (d < best) best = d;
			}
			total += best;
		}
		scored.push({ id: fonts[fi].replace('.woff2', ''), dist: total / comps.length });
	}
	scored.sort((a, b) => a.dist - b.dist);
	const rank = scored.findIndex((s) => s.id === expectedId) + 1;
	const top3 = scored.slice(0, 3).map((s) => s.id).join(', ');
	console.log(`  ${dbKey}: ${label} rank=${rank} | top3=${top3}`);
	return rank;
}

const words = [
	{ key: 'roboto', text: 'FontFinder', label: 'Roboto/FontFinder' },
	{ key: 'roboto', text: 'SansSerif', label: 'Roboto/SansSerif' },
	{ key: 'open-sans', text: 'FontFinder', label: 'OpenSans/FontFinder' },
	{ key: 'pacifico', text: 'Pacifico', label: 'Pacifico/Pacifico' },
];

const GRIDS = {
	a: null,
	b: [12, 10],
	c: [16, 12],
	d: [20, 14],
	e: [24, 16],
};
const wordCompFeats = {};
for (const wd of words) {
	const familyKey = `FF-${wd.key}`;
	const r = renderWord(familyKey, wd.text);
	const comps = segment(r.mask, r.w, r.h);
	wordCompFeats[wd.label] = comps.map((c) => {
		const box = extractBox(r.mask, r.w, c);
		const all = {};
		for (const key of Object.keys(GRIDS)) {
			const o = new Uint8Array(SIZES[key]);
			if (GRIDS[key]) featuresD(box, c.w, c.h, GRIDS[key][0], GRIDS[key][1], o);
			else featuresA(box, c.w, c.h, o);
			all[key] = o;
		}
		return all;
	});
}

const names = { a: 'row12+col16+aspect', b: 'grid12x10', c: 'grid16x12', d: 'grid20x14', e: 'grid24x16' };
for (const key of ['a', 'b', 'c', 'd', 'e']) {
	console.log(`\n== descriptor ${key} (${names[key]}, ${SIZES[key]}B/glyph) ==`);
	for (const wd of words) {
		const cf = wordCompFeats[wd.label].map((c) => c[key]);
		rankFor(key, null, cf, wd.key, wd.label);
	}
	const perFont = SIZES[key] * 52;
	console.log(`  DB size: ${((perFont * fonts.length) / 1024 / 1024).toFixed(1)} MB raw, ${((perFont * fonts.length * 1.33) / 1024 / 1024).toFixed(1)} MB base64, ~${((perFont * fonts.length / 2 * 1.33) / 1024 / 1024).toFixed(1)} MB nibble-packed`);
}