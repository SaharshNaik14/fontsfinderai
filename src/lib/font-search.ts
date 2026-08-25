import type { FontCategory, FreeMatch, IdentifyResponse, PaidMatch, SlimFreeFont, SlimPaidFont } from './types';
import { measureMatch, type MeasureProgress } from './client/measure';

export interface MatchProgress {
	loaded: number;
	total: number;
	current: string;
}

export interface MatchResult {
	free: FreeMatch[];
	paid: PaidMatch[];
}

export async function identifyImage(dataUrl: string, text: string): Promise<IdentifyResponse> {
	const res = await fetch('/api/identify', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ image: dataUrl, text, hp: '' }),
	});
	if (!res.ok) {
		let message = 'Something went wrong. Please try again in a moment.';
		try {
			const body = (await res.json()) as { error?: unknown };
			if (typeof body.error === 'string') message = body.error;
		} catch {
			// keep default message
		}
		const err = new Error(message) as Error & { status?: number };
		err.status = res.status;
		throw err;
	}
	return (await res.json()) as IdentifyResponse;
}

export async function runMatching(
	free: SlimFreeFont[],
	paid: SlimPaidFont[],
	hint: { family: string; confidence: number }[],
	category: FontCategory | '',
	sourceMask: Uint8ClampedArray,
	srcW: number,
	srcH: number,
	confirmedText: string,
	onProgress: (p: MatchProgress) => void,
): Promise<MatchResult> {
	const text = (confirmedText || '').trim();
	const prefer = hint.map((h) => h.family);
	const measured = await measureMatch(free, sourceMask, srcW, srcH, text, prefer, (p: MeasureProgress) => {
		const total = p.stage === 'letters' ? Math.max(1, p.total) : free.length;
		onProgress({ loaded: p.loaded, total, current: p.current });
	});

	const freeMatches: FreeMatch[] = measured.map((m, rank) => {
		const f = free[m.index];
		return {
			id: f.id,
			family: f.family,
			category: f.category,
			confidence: m.score,
			rank,
		};
	});

	const topAltIds = new Set(freeMatches.slice(0, 15).map((m) => m.id));
	const paidMatches: PaidMatch[] = paid.map((p) => {
		const hintMatch = hint.some((h) => h.family.toLowerCase() === p.name.toLowerCase());
		const altRanked = topAltIds.has(p.freeAlt);
		const confidence = altRanked ? 0.85 : hintMatch ? 0.7 : p.category === category ? 0.5 : 0.4;
		return { ...p, confidence };
	});

	return { free: freeMatches, paid: paidMatches };
}