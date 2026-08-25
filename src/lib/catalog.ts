import googleData from '../data/google-fonts.json';
import paidData from '../data/paid-fonts.json';
import type { FontCategory, GoogleFont, PaidFont, SlimFreeFont, SlimPaidFont } from './types';

export type { SlimFreeFont, SlimPaidFont };

export const categories: FontCategory[] = ['sans-serif', 'serif', 'display', 'handwriting', 'monospace'];

export const googleFonts = googleData.fonts as GoogleFont[];
export const paidFonts = paidData as PaidFont[];

export const googleIndex = new Map(googleFonts.map((f) => [f.id, f]));
export const paidIndex = new Map(paidFonts.map((f) => [f.id, f]));

export const featuredFonts = googleFonts.filter((f) => f.featured);

export const catalog = { google: googleFonts, paid: paidFonts };

export function getFreeFont(id: string): GoogleFont | undefined {
	return googleIndex.get(id);
}

export function getPaidFont(id: string): PaidFont | undefined {
	return paidIndex.get(id);
}

export function getFont(id: string): GoogleFont | PaidFont | undefined {
	return googleIndex.get(id) ?? paidIndex.get(id);
}

export function idToFamily(id: string): string {
	const free = googleIndex.get(id);
	if (free) return free.family;
	const paid = paidIndex.get(id);
	return paid ? paid.name : id;
}

export function toSlimFree(f: GoogleFont): SlimFreeFont {
	return { id: f.id, family: f.family, category: f.category, popularity: f.popularity };
}

export function toSlimPaid(p: PaidFont): SlimPaidFont {
	return { id: p.id, name: p.name, foundry: p.foundry, price: p.price, category: p.category, freeAlt: p.freeAlt, url: p.url };
}

export function findFontByName(name: string): { id: string; kind: 'free' | 'paid' } | undefined {
	if (!name) return undefined;
	const q = name.toLowerCase().trim();
	if (!q) return undefined;
	for (const f of googleFonts) {
		if (f.family.toLowerCase() === q) return { id: f.id, kind: 'free' };
	}
	for (const p of paidFonts) {
		if (p.name.toLowerCase() === q) return { id: p.id, kind: 'paid' };
	}
	for (const f of googleFonts) {
		if (f.family.toLowerCase().includes(q)) return { id: f.id, kind: 'free' };
	}
	for (const p of paidFonts) {
		if (p.name.toLowerCase().includes(q)) return { id: p.id, kind: 'paid' };
	}
	return undefined;
}

export function buildFreeShortlist(hintCategory: FontCategory | '', hintIds: Set<string>, size = 300): GoogleFont[] {
	const out: GoogleFont[] = [];
	const seen = new Set<string>();
	const push = (f: GoogleFont) => {
		if (seen.has(f.id)) return;
		seen.add(f.id);
		out.push(f);
	};

	for (const f of googleFonts) {
		if (hintIds.has(f.id)) push(f);
	}

	const budget = size - out.length;
	if (budget <= 0) return out.slice(0, size);

	const categoryPool = hintCategory ? googleFonts.filter((f) => f.category === hintCategory) : [];
	const otherPool = hintCategory ? googleFonts.filter((f) => f.category !== hintCategory) : googleFonts;
	const categoryTarget = Math.ceil(budget * 0.75);
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

export function buildPaidCandidates(hintCategory: FontCategory | '', hintIds: Set<string>, cap = 24): PaidFont[] {
	const out: PaidFont[] = [];
	const seen = new Set<string>();
	const push = (p: PaidFont) => {
		if (seen.has(p.id)) return;
		seen.add(p.id);
		out.push(p);
	};

	for (const p of paidFonts) {
		if (hintIds.has(p.id)) push(p);
	}
	if (hintCategory) {
		for (const p of paidFonts) {
			if (p.category === hintCategory) push(p);
		}
	}
	for (const p of paidFonts) {
		if (out.length >= cap) break;
		push(p);
	}

	return out.slice(0, cap);
}
