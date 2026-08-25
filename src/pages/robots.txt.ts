import type { APIRoute } from 'astro';
import { SITE } from '../lib/site';

export const GET: APIRoute = () => {
	const body = `User-agent: *
Allow: /
Disallow: /api/

Sitemap: ${SITE.url}/sitemap.xml
`;
	return new Response(body, {
		headers: { 'content-type': 'text/plain; charset=utf-8' },
	});
};