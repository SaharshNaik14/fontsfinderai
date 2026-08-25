import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, 'src', 'data');

const full = JSON.parse(readFileSync(join(dataDir, 'google-fonts.json'), 'utf8'));

const slim = (full.fonts || []).map((f) => [
	f.id,
	f.family,
	f.category,
	typeof f.popularity === 'number' ? f.popularity : 9999,
]);

writeFileSync(join(dataDir, 'google-fonts-slim.json'), JSON.stringify(slim));

console.log(`wrote ${slim.length} slim families -> src/data/google-fonts-slim.json`);