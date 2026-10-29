import { defineMiddleware } from 'astro:middleware';
import { SITE } from './lib/site';

const productionHost = SITE.domain;
const devHosts = ['localhost', '127.0.0.1'];

export const onRequest = defineMiddleware(async (context, next) => {
	const response = await next();

	const host = context.url.hostname;

	// Allow indexing only on the production domain. Every other host —
	// workers.dev endpoints, preview URLs, etc. — must never be indexed,
	// otherwise Google could see duplicate content before the real
	// domain is live.
	const indexable =
		host === productionHost || host.endsWith(`.${productionHost}`) || devHosts.includes(host);

	if (!indexable) {
		response.headers.set('X-Robots-Tag', 'noindex, nofollow');
	}

	return response;
});