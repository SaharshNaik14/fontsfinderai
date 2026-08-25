import { segmentLetters } from './measure';
import { extractBox } from './match';
import { signatureForBox, hammingDistance, isAllZero, BYTES_PER_GLYPH, CHARS, GRID_BITS } from './fingerprint-core';
import type { FreeMatch } from '../types';

// Signature-DB manifest (public/signatures/manifest.json). The fonts/families/
// categories/popularity arrays are parallel to the per-weight glyph matrix order,
// so a font's glyph row f lives at (f * chars.length * bytesPerGlyph) in each chunk.
export interface SignatureManifest {
	version: number;
	grid: number;
	bytesPerGlyph: number;
	chars: string;
	weights: string[];
	fonts: string[];
	families: string[];
	categories: string[];
	popularity: number[];
	chunks: Record<string, string>;
}

export interface SignatureDb {
	manifest: SignatureManifest;
	weights: Map<string, Uint8Array>;
}

export interface DbProgress {
	loaded: number;
	total: number;
	current: string;
}

const GLYPHS_PER_FONT = CHARS.length; // 62

let dbPromise: Promise<SignatureDb> | null = null;

async function gunzip(buf: ArrayBuffer): Promise<Uint8Array> {
	const bytes = new Uint8Array(buf);
	// Servers that serve a .gz static file with Content-Encoding: gzip make the
	// browser auto-decompress before fetch resolves — in that case the bytes are
	// already raw and we must NOT run gzip on them a second time. Detect the
	// gzip magic header; skip decompression when it's absent.
	if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
		if (typeof DecompressionStream === 'undefined') {
			throw new Error('This browser cannot decompress the font database.');
		}
		const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
		return new Uint8Array(await new Response(stream).arrayBuffer());
	}
	return bytes;
}

async function loadWeight(url: string): Promise<Uint8Array> {
	const r = await fetch(url);
	if (!r.ok) throw new Error('The font database failed to load.');
	return gunzip(await r.arrayBuffer());
}

export function loadFeatureDb(): Promise<SignatureDb> {
	if (!dbPromise) {
		dbPromise = (async () => {
			try {
				const manifest = await fetch('/signatures/manifest.json').then((r) => {
					if (!r.ok) throw new Error('The font database failed to load.');
					return r.json() as Promise<SignatureManifest>;
				});
				const weights = new Map<string, Uint8Array>();
				await Promise.all(
					manifest.weights.map(async (key) => {
						weights.set(key, await loadWeight(manifest.chunks[key]));
					}),
				);
				return { manifest, weights };
			} catch (err) {
				// Don't cache the failure — allow retries on next call.
				dbPromise = null;
				throw err;
			}
		})();
	}
	return dbPromise;
}

const MIN_SIG_BITS = 4; // skip near-empty components (noise specs, charless crops)

// Shared query-shape builder: segment once, keep non-degenerate components, and
// return their boxes plus level-0 signatures. (A stroke-weight erosion sweep was
// probed in scripts/test-small-text.mjs and measured as pure noise once the
// upscale + 50%-coverage binarizer landed — see that script for the A/B data.)
function queryShapes(mask: Uint8ClampedArray, srcW: number, srcH: number) {
	const comps = segmentLetters(mask, srcW, srcH);
	const zero = new Uint8Array(BYTES_PER_GLYPH);
	const compSigs: Uint8Array[] = [];
	const compBoxes: { x: number; y: number; w: number; h: number }[] = [];
	for (const c of comps) {
		const box = extractBox(mask, srcW, srcH, c);
		const sig = signatureForBox(box, c.w, c.h);
		if (isAllZero(sig) || hammingDistance(sig, zero) < MIN_SIG_BITS) continue;
		compSigs.push(sig);
		compBoxes.push({ x: c.x, y: c.y, w: c.w, h: c.h });
	}
	if (compSigs.length === 0) return null;
	return { boxes: compBoxes, sigs: compSigs };
}

export async function matchAllFonts(
	sourceMask: Uint8ClampedArray,
	srcW: number,
	srcH: number,
	onProgress?: (p: DbProgress) => void,
): Promise<FreeMatch[]> {
	const db = await loadFeatureDb();
	const { manifest } = db;

	const shapes = queryShapes(sourceMask, srcW, srcH);
	if (!shapes) return [];
	const { sigs: compSigs } = shapes;

	const fontCount = manifest.fonts.length;
	const rowBytes = BYTES_PER_GLYPH * GLYPHS_PER_FONT;
	const weights = [...db.weights.entries()];

	const scored: { id: string; family: string; popularity: number; score: number; weight: string }[] = [];
	for (let f = 0; f < fontCount; f++) {
		const base = f * rowBytes;
		// Coherent per-weight totals (never mix weights across components): the
		// winning weight is also reported so refine can render candidates in the
		// same weight as the source text.
		let bestTotal = Number.POSITIVE_INFINITY;
		let bestWeight = manifest.weights[0] ?? 'regular';
		for (const [key, data] of weights) {
			let total = 0;
			for (const sig of compSigs) {
				let best = Number.POSITIVE_INFINITY;
				for (let g = 0; g < GLYPHS_PER_FONT; g++) {
					const d = hammingDistance(sig, data, base + g * BYTES_PER_GLYPH);
					if (d < best) best = d;
				}
				total += best;
			}
			if (total < bestTotal) {
				bestTotal = total;
				bestWeight = key;
			}
		}
		const score = 1 - bestTotal / compSigs.length / GRID_BITS;
		scored.push({ id: manifest.fonts[f], family: manifest.families[f], popularity: manifest.popularity[f], score, weight: bestWeight });
		onProgress?.({ loaded: f + 1, total: fontCount, current: manifest.families[f] });
	}

	scored.sort((a, b) => b.score - a.score || a.popularity - b.popularity);

	const categoryById = new Map(manifest.fonts.map((id, i) => [id, manifest.categories[i]]));
	return scored.map((s, rank) => ({
		id: s.id,
		family: s.family,
		category: (categoryById.get(s.id) ?? 'sans-serif') as FreeMatch['category'],
		confidence: Math.min(1, Math.max(0, s.score)),
		rank,
		weight: s.weight,
	}));
}

export interface SuggestEntry {
	char: string;
	conf: number;
	box: { x: number; y: number; w: number; h: number };
}

export interface SuggestResult {
	text: string;
	avgConf: number;
	entries: SuggestEntry[];
}

// Best-guess the text content of the image: for each letter shape, majority-vote
// the glyph character that the top-matching fonts agree on. Returns the raw guess
// plus per-letter confidence and component boxes so the UI can show an editable
// per-character row (character-correction step before render-refine).
export async function suggestTextDetails(
	sourceMask: Uint8ClampedArray,
	srcW: number,
	srcH: number,
	onProgress?: (p: DbProgress) => void,
): Promise<SuggestResult> {
	const db = await loadFeatureDb();
	const { manifest } = db;

	const shapes = queryShapes(sourceMask, srcW, srcH);
	if (!shapes) return { text: '', avgConf: 0, entries: [] };
	const compSigs = shapes.sigs;

	const weights = [...db.weights.entries()];
	const fontCount = manifest.fonts.length;
	const rowBytes = BYTES_PER_GLYPH * GLYPHS_PER_FONT;

	// Only the top-ranked fonts should vote: a font that matches the whole word
	// poorly has no authority over what a single letter is. Ranking fonts by total
	// distance first, then majority-voting per component among the top-K, makes the
	// guess track the best-matching fonts instead of the full run's bias.
	const TOP_K = 25;
	const fontBests: { total: number; bests: number[] }[] = [];
	for (let f = 0; f < fontCount; f++) {
		const base = f * rowBytes;
		const bests: number[] = [];
		let total = 0;
		for (const sig of compSigs) {
			let best = Number.POSITIVE_INFINITY;
			let bestG = 0;
			for (const [, data] of weights) {
				for (let g = 0; g < GLYPHS_PER_FONT; g++) {
					const d = hammingDistance(sig, data, base + g * BYTES_PER_GLYPH);
					if (d < best) {
						best = d;
						bestG = g;
					}
				}
			}
			bests.push(bestG);
			total += best;
		}
		fontBests.push({ total, bests });
	}
	fontBests.sort((a, b) => a.total - b.total);
	const voters = fontBests.slice(0, TOP_K);

	const out: string[] = [];
	const entries: SuggestEntry[] = [];
	let confidenceSum = 0;
	for (let ci = 0; ci < compSigs.length; ci++) {
		// votes[g] = how many top fonts think this shape is glyph g
		const votes = new Array<number>(GLYPHS_PER_FONT).fill(0);
		for (const v of voters) votes[v.bests[ci]]++;
		// Majority vote wins.
		let winner = 0;
		let second = -1;
		for (let g = 1; g < GLYPHS_PER_FONT; g++) if (votes[g] > votes[winner]) winner = g;
		for (let g = 0; g < GLYPHS_PER_FONT; g++) if (g !== winner && votes[g] > second) second = votes[g];
		out.push(manifest.chars[winner]);
		const share = votes[winner] / TOP_K;
		confidenceSum += share;
		entries.push({ char: manifest.chars[winner], conf: share, box: shapes.boxes[ci] });
		onProgress?.({ loaded: ci + 1, total: compSigs.length, current: manifest.chars[winner] });
	}

	const avgConf = out.length ? confidenceSum / out.length : 0;
	return { text: out.join(''), avgConf, entries };
}

// Gated convenience wrapper: only returns a guess when the vote is confident
// enough (avgConf ≥ 0.5) to drive the refine pass. Weak reads return ''.
export async function suggestText(
	sourceMask: Uint8ClampedArray,
	srcW: number,
	srcH: number,
	onProgress?: (p: DbProgress) => void,
): Promise<string> {
	const r = await suggestTextDetails(sourceMask, srcW, srcH, onProgress);
	return r.avgConf >= 0.5 ? r.text : '';
}