import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const FEATURED = [
	'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Poppins', 'Inter', 'Nunito', 'Raleway',
	'Ubuntu', 'Oswald', 'Playfair Display', 'Merriweather', 'Bebas Neue', 'Anton',
	'Archivo', 'Archivo Black', 'Space Grotesk', 'Work Sans', 'DM Sans', 'Plus Jakarta Sans',
	'Manrope', 'Sora', 'Lexend', 'Figtree', 'Outfit', 'Barlow', 'Barlow Condensed',
	'Barlow Semi Condensed', 'Source Sans 3', 'PT Sans', 'Fira Sans', 'Roboto Condensed',
	'Roboto Mono', 'JetBrains Mono', 'Fira Code', 'Source Code Pro', 'Inconsolata',
	'IBM Plex Mono', 'Space Mono', 'DM Mono', 'Geist', 'Geist Mono', 'Saira', 'Chivo',
	'Karla', 'Mulish', 'Nunito Sans', 'Quicksand', 'Josefin Sans', 'Jost', 'Urbanist',
	'Red Hat Display', 'Rubik', 'Titillium Web', 'Exo 2', 'Heebo', 'Assistant', 'Cairo',
	'Tajawal', 'Hind', 'Mukta', 'Sarabun', 'Instrument Sans', 'Bricolage Grotesque',
	'Schibsted Grotesk', 'Hanken Grotesk', 'Onest', 'Geologica', 'Unbounded', 'Baloo 2',
	'Comfortaa', 'Fredoka', 'Exo', 'Abel', 'Varela Round', 'Chakra Petch', 'Rajdhani',
	'Teko', 'Russo One', 'Righteous', 'Questrial', 'Crimson Text', 'Source Serif 4',
	'PT Serif', 'Libre Baskerville', 'Vollkorn', 'Newsreader', 'Fraunces', 'Instrument Serif',
	'DM Serif Display', 'Arvo', 'Bitter', 'Roboto Slab', 'Zilla Slab', 'Spectral',
	'Noto Serif', 'EB Garamond', 'Cormorant Garamond', 'Bungee', 'Press Start 2P',
	'Orbitron', 'Pacifico', 'Dancing Script', 'Caveat', 'Courgette', 'Great Vibes',
	'Satisfy', 'Permanent Marker', 'Shadows Into Light', 'Kalam', 'Lobster', 'Alegreya',
];

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const cat = (c) => {
	const m = { 'sans serif': 'sans-serif', serif: 'serif', display: 'display', handwriting: 'handwriting', monospace: 'monospace' };
	return m[String(c).toLowerCase()] || 'sans-serif';
};

const weightOf = (variants) => {
	const ws = variants
		.map((v) => v.replace(/italic/g, '').replace('regular', '400'))
		.filter((v) => v && v !== '')
		.map((v) => (/^\d+$/.test(v) ? v : '400'));
	const set = [...new Set(ws)];
	return set.length ? set.sort((a, b) => +a - +b).join(' ') : '400';
};

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'src', 'data');

const res = await fetch('https://fonts.google.com/metadata/fonts', {
	headers: { 'user-agent': 'spot-that-font/1.0 (+https://spotthatfont.com)' },
});
if (!res.ok) throw new Error(`metadata/fonts failed: ${res.status}`);
const raw = await res.json();

const fonts = (raw.familyMetadataList || [])
	.filter((f) => Array.isArray(f.subsets) && f.subsets.includes('latin'))
	.map((f) => {
		const variants = f.fonts ? Object.keys(f.fonts) : [];
		return {
			id: slug(f.family),
			family: f.family,
			displayName: f.displayName || f.family,
			category: cat(f.category),
			variants,
			subsets: (f.subsets || []).filter((s) => s !== 'menu'),
			weight: weightOf(variants),
			italic: variants.some((v) => v.includes('italic')),
			variable: Array.isArray(f.axes) && f.axes.length > 0,
			axes: f.axes || [],
			popularity: typeof f.popularity === 'number' ? f.popularity : 9999,
			designer: Array.isArray(f.designers) ? f.designers.join(', ') : f.designers || '',
			dateAdded: f.dateAdded || '',
			featured: FEATURED.includes(f.family),
		};
	})
	.sort((a, b) => Number(b.featured) - Number(a.featured) || a.popularity - b.popularity);

const payload = { generated: new Date().toISOString().slice(0, 10), count: fonts.length, fonts };
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'google-fonts.json'), JSON.stringify(payload, null, 0));

const slim = fonts.map((f) => [f.id, f.family, f.category, f.popularity]);
writeFileSync(join(out, 'google-fonts-slim.json'), JSON.stringify(slim));

const featured = fonts.filter((f) => f.featured).length;
console.log(`wrote ${fonts.length} families (${featured} featured) + slim -> src/data/`);