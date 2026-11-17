// Pings Bing/Yandex/Seznam/NAVER (api.indexnow.org routes them all) about
// changed URLs on spotthatfont.com. Run AFTER a deploy so the key file
// `public/<key>.txt` is live at the site root — that's the ownership proof.
//
// Usage:
//   node scripts/ping-indexnow.mjs            -> submits the priority pages below
//   node scripts/ping-indexnow.mjs --sitemap  -> fetches sitemap.xml and submits every URL
//   node scripts/ping-indexnow.mjs /fonts /tools ...  -> submits the given paths
import { SITE } from '../src/lib/site.ts';

const KEY = '75522f350ad4eeef7ef2ea689198ea45';
const HOST = 'spotthatfont.com';
const endpoint = 'https://api.indexnow.org/indexnow';

const priority = ['', '/fonts', '/tools', '/faq', '/guides'];

const args = process.argv.slice(2);
let urlList;

if (args.includes('--sitemap')) {
	const res = await fetch(`${SITE.url}/sitemap.xml`);
	const xml = await res.text();
	const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
	if (!locs.length) throw new Error('sitemap.xml returned no <loc> entries');
	urlList = locs;
	console.log(`got ${locs.length} urls from sitemap`);
} else if (args.some((a) => a.startsWith('/'))) {
	urlList = args.filter((a) => a.startsWith('/')).map((p) => `${SITE.url}${p}`);
} else {
	urlList = priority.map((p) => `${SITE.url}${p}`);
}

// IndexNow caps at 10,000 urls per POST; chunk defensively
for (let i = 0; i < urlList.length; i += 1000) {
	const chunk = urlList.slice(i, i + 1000);
	const body = JSON.stringify({
		host: HOST,
		key: KEY,
		keyLocation: `${SITE.url}/${KEY}.txt`,
		urlList: chunk,
	});
	const res = await fetch(endpoint, {
		method: 'POST',
		headers: { 'content-type': 'application/json; charset=utf-8' },
		body,
	});
	console.log(`chunk ${i / 1000 + 1}: ${res.status} ${res.statusText} (${chunk.length} urls)`);
	if (res.status !== 200 && res.status !== 202) {
		console.error(await res.text());
	}
}
