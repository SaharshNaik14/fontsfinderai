import type { APIRoute } from 'astro';
import { SITE } from '../../lib/site';
import { parseIdentifyRequest, consumeRate } from '../../lib/guard';
import { getAppEnv } from '../../lib/env';
import { getAIHint } from '../../lib/ai';
import {
	buildFreeShortlist,
	buildPaidCandidates,
	findFontByName,
	toSlimFree,
	toSlimPaid,
} from '../../lib/catalog';
import type { IdentifyResponse } from '../../lib/types';

const json = (data: unknown, status = 200, extraHeaders: Record<string, string> = {}) =>
	new Response(JSON.stringify(data), {
		status,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
			...extraHeaders,
		},
	});

export const POST: APIRoute = async ({ request }) => {
	const env = getAppEnv();

	const parsed = await parseIdentifyRequest(request, SITE.maxImageBytes);
	if (!parsed.ok) return json({ error: parsed.message }, parsed.status);

	const rate = consumeRate(parsed.data.ip);
	if (!rate.ok) {
		return json(
			{ error: rate.message },
			429,
			rate.retryAfterMs ? { 'retry-after': String(Math.ceil(rate.retryAfterMs / 1000)) } : {},
		);
	}

	const hint = await getAIHint(env, parsed.data.imageDataUrl, parsed.data.text);

	const hintIds = new Set<string>();
	for (const r of hint?.recognized ?? []) {
		const found = findFontByName(r.name);
		if (found) hintIds.add(found.id);
	}

	const free = buildFreeShortlist(hint?.category ?? '', hintIds, 300);
	const paid = buildPaidCandidates(hint?.category ?? '', hintIds, 24);

	const response: IdentifyResponse = {
		transcription: hint?.transcription ?? '',
		category: hint?.category ?? '',
		hint: (hint?.recognized ?? []).map((r) => ({ family: r.name, confidence: r.confidence })),
		free: free.map(toSlimFree),
		paid: paid.map(toSlimPaid),
	};

	return json(response);
};
