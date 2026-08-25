// 16×16 bit-packed glyph signatures for Hamming matching.
// One function set used by BOTH the generator (scripts/precompute.mjs) and the
// client (match-db.ts) so database and query signatures are byte-for-byte comparable.

export const GRID = 16;
export const GRID_BITS = GRID * GRID; // 256
export const BYTES_PER_GLYPH = GRID_BITS / 8; // 32
export const CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; // 62

// Fraction of a 16×16 cell that must be ink for the cell's bit to be set.
const INK_FRAC = 0.5;

// Downsample a binary (0/1) ink box to a row-major 16×16 bitmap, bit-packed
// MSB-first into 32 bytes. Cell (gy,gx) → bit byte[gy*16+gx] : 7-(gx%8).
export function signatureForBox(box: Uint8ClampedArray, w: number, h: number): Uint8Array {
	const out = new Uint8Array(BYTES_PER_GLYPH);
	if (w <= 0 || h <= 0) return out;
	for (let gy = 0; gy < GRID; gy++) {
		const y0 = Math.floor((gy * h) / GRID);
		const y1 = Math.max(y0 + 1, Math.ceil(((gy + 1) * h) / GRID));
		for (let gx = 0; gx < GRID; gx++) {
			const x0 = Math.floor((gx * w) / GRID);
			const x1 = Math.max(x0 + 1, Math.ceil(((gx + 1) * w) / GRID));
			let ink = 0;
			let total = 0;
			for (let y = y0; y < y1 && y < h; y++) {
				const row = y * w;
				for (let x = x0; x < x1 && x < w; x++) {
					total++;
					if (box[row + x] === 1) ink++;
				}
			}
			if (total && ink / total >= INK_FRAC) out[gy * GRID + gx] = 1 << (7 - (gx % 8));
		}
	}
	return out;
}

export function hammingDistance(a: ArrayLike<number>, b: ArrayLike<number>, bOffset = 0, len = BYTES_PER_GLYPH): number {
	let diff = 0;
	for (let i = 0; i < len; i++) {
		let n = a[i] ^ b[bOffset + i];
		while (n) {
			n &= n - 1;
			diff++;
		}
	}
	return diff;
}

export function isAllZero(sig: Uint8Array): boolean {
	for (let i = 0; i < sig.length; i++) if (sig[i]) return false;
	return true;
}