// Dependency-free sitemap (no @astrojs/sitemap needed): enumerates static
// pages, tool landing pages and every free/paid font page from the data files.
// Prerendered at build time so it ships as a static file on both adapters.
import type { APIRoute } from 'astro';
import { SITE } from '../lib/site';
import googleFontsData from '../data/google-fonts.json';
import paidFontsData from '../data/paid-fonts.json';

export const prerender = true;

const staticPaths = [
	'',
	'/fonts',
	'/tools',
	'/tools/logo-font-identifier',
	'/tools/screenshot-font-finder',
	'/tools/handwriting-font-finder',
	'/tools/pdf-font-detector',
	'/tools/free-font-alternative-finder',
	'/guides',
	'/guides/identify-font-from-image',
	'/guides/free-alternatives-to-commercial-fonts',
	'/guides/font-categories-basics',
	'/guides/use-custom-fonts-on-the-web',
	'/faq',
	'/about',
	'/contact',
	'/privacy',
	'/terms',
];

interface FontRow {
	id: string;
}

const freeFonts = (googleFontsData as { fonts: FontRow[] }).fonts;
const paidFonts = paidFontsData as unknown as FontRow[];

const paths = [
	...staticPaths,
	...freeFonts.map((f) => `/fonts/${f.id}`),
	...paidFonts.map((f) => `/fonts/${f.id}`),
];

export const GET: APIRoute = () => {
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${paths.map((p) => `\t<url><loc>${SITE.url}${p}</loc></url>`).join('\n')}
</urlset>`;
	return new Response(xml, {
		headers: { 'Content-Type': 'application/xml; charset=utf-8' },
	});
};
