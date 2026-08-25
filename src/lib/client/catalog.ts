import googleSlim from '../../data/google-fonts-slim.json';
import paidData from '../../data/paid-fonts.json';
import type { FontCategory, PaidFont, SlimFreeFont, SlimPaidFont } from '../types';

type SlimRow = [string, string, FontCategory, number];

const rows = googleSlim as SlimRow[];
const paid = paidData as PaidFont[];

export const clientGoogleFonts: SlimFreeFont[] = rows.map(([id, family, category, popularity]) => ({
	id,
	family,
	category,
	popularity,
}));

export const clientPaidFonts: SlimPaidFont[] = paid.map((p) => ({
	id: p.id,
	name: p.name,
	foundry: p.foundry,
	price: p.price,
	category: p.category,
	freeAlt: p.freeAlt,
	url: p.url,
}));

export function findClientFontByName(name: string): { id: string; kind: 'free' | 'paid' } | undefined {
	if (!name) return undefined;
	const q = name.toLowerCase().trim();
	if (!q) return undefined;
	for (const f of clientGoogleFonts) {
		if (f.family.toLowerCase() === q) return { id: f.id, kind: 'free' };
	}
	for (const p of clientPaidFonts) {
		if (p.name.toLowerCase() === q) return { id: p.id, kind: 'paid' };
	}
	for (const f of clientGoogleFonts) {
		if (f.family.toLowerCase().includes(q)) return { id: f.id, kind: 'free' };
	}
	for (const p of clientPaidFonts) {
		if (p.name.toLowerCase().includes(q)) return { id: p.id, kind: 'paid' };
	}
	return undefined;
}

export function clientFreeShortlist(
	hintCategory: FontCategory | '',
	hintIds: Set<string>,
	size = 300,
): SlimFreeFont[] {
	const out: SlimFreeFont[] = [];
	const seen = new Set<string>();
	const push = (f: SlimFreeFont) => {
		if (seen.has(f.id)) return;
		seen.add(f.id);
		out.push(f);
	};

	for (const f of clientGoogleFonts) {
		if (hintIds.has(f.id)) push(f);
	}

	const budget = size - out.length;
	if (budget <= 0) return out.slice(0, size);

	const categoryPool = hintCategory
		? clientGoogleFonts.filter((f) => f.category === hintCategory)
		: [];
	const otherPool = hintCategory
		? clientGoogleFonts.filter((f) => f.category !== hintCategory)
		: clientGoogleFonts;
	const categoryTarget = Math.ceil(budget * 0.5);
	let categoryCount = 0;

	for (const f of categoryPool) {
		if (categoryCount >= categoryTarget || out.length >= size) break;
		push(f);
		categoryCount++;
	}
	for (const f of otherPool) {
		if (out.length >= size) break;
		push(f);
	}

	return out.slice(0, size);
}

export function clientPaidCandidates(
	hintCategory: FontCategory | '',
	hintIds: Set<string>,
	cap = 24,
): SlimPaidFont[] {
	const out: SlimPaidFont[] = [];
	const seen = new Set<string>();
	const push = (p: SlimPaidFont) => {
		if (seen.has(p.id)) return;
		seen.add(p.id);
		out.push(p);
	};

	for (const p of clientPaidFonts) {
		if (hintIds.has(p.id)) push(p);
	}
	if (hintCategory) {
		for (const p of clientPaidFonts) {
			if (p.category === hintCategory) push(p);
		}
	}
	for (const p of clientPaidFonts) {
		if (out.length >= cap) break;
		push(p);
	}

	return out.slice(0, cap);
}
