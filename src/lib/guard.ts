export interface ValidRequest {
	imageDataUrl: string;
	mime: 'image/png' | 'image/jpeg' | 'image/webp';
	bytes: Uint8Array;
	text: string;
	ip: string;
}

export type GuardOutcome =
	| { ok: true; data: ValidRequest }
	| { ok: false; status: number; message: string };

const DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/;

export async function parseIdentifyRequest(request: Request, maxImageBytes: number): Promise<GuardOutcome> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return { ok: false, status: 400, message: 'Request body must be valid JSON.' };
	}
	if (typeof body !== 'object' || body === null) {
		return { ok: false, status: 400, message: 'Request body must be a JSON object.' };
	}
	const b = body as Record<string, unknown>;

	const hp = typeof b.hp === 'string' ? b.hp : '';
	if (hp !== '') {
		return { ok: false, status: 403, message: 'Request blocked.' };
	}

	const text = typeof b.text === 'string' ? b.text.trim().slice(0, 200) : '';
	const image = typeof b.image === 'string' ? b.image : '';
	if (!image) {
		return { ok: false, status: 400, message: 'Missing "image" (a base64 data URL).' };
	}
	if (image.length > maxImageBytes * 2) {
		return { ok: false, status: 400, message: 'Image is too large.' };
	}

	const m = DATA_URL_RE.exec(image);
	if (!m) {
		return { ok: false, status: 400, message: 'Image must be a base64 data URL for png, jpeg or webp.' };
	}

	let bytes: Uint8Array;
	try {
		bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
	} catch {
		return { ok: false, status: 400, message: 'Image is not valid base64.' };
	}
	if (bytes.length > maxImageBytes) {
		return { ok: false, status: 400, message: 'Image is too large.' };
	}

	return {
		ok: true,
		data: {
			imageDataUrl: image,
			mime: m[1] as ValidRequest['mime'],
			bytes,
			text,
			ip: clientIp(request),
		},
	};
}

export function clientIp(request: Request): string {
	const cf = (request as unknown as { cf?: { connectingIp?: string } }).cf;
	if (cf?.connectingIp) return cf.connectingIp;
	const fwd = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for');
	if (fwd) return fwd.split(',')[0].trim();
	return 'unknown';
}

const WINDOWS = [
	{ name: 'minute', ms: 60_000, max: 4 },
	{ name: 'hour', ms: 3_600_000, max: 15 },
	{ name: 'day', ms: 86_400_000, max: 40 },
];

const GLOBAL_WINDOW = { name: 'minute', ms: 60_000, max: 24 };

class SlidingWindow {
	private hits = new Map<string, number[]>();
	constructor(private ms: number, private max: number) {}

	tryHit(key: string): boolean {
		const now = Date.now();
		let arr = this.hits.get(key);
		if (!arr) {
			arr = [];
			this.hits.set(key, arr);
		}
		const cutoff = now - this.ms;
		let drop = 0;
		while (drop < arr.length && arr[drop] < cutoff) drop++;
		if (drop > 0) arr.splice(0, drop);
		if (arr.length >= this.max) return false;
		arr.push(now);
		return true;
	}
}

const windows = WINDOWS.map((w) => new SlidingWindow(w.ms, w.max));
const globalWindow = new SlidingWindow(GLOBAL_WINDOW.ms, GLOBAL_WINDOW.max);

export interface RateResult {
	ok: boolean;
	retryAfterMs?: number;
	message?: string;
}

export function consumeRate(ip: string): RateResult {
	for (let i = 0; i < windows.length; i++) {
		if (!windows[i].tryHit(ip)) {
			const w = WINDOWS[i];
			return {
				ok: false,
				retryAfterMs: w.ms,
				message: `Too many requests. Please try again in a minute.`,
			};
		}
	}
	if (!globalWindow.tryHit('__global__')) {
		return {
			ok: false,
			retryAfterMs: GLOBAL_WINDOW.ms,
			message: 'We are busy right now. Please try again in a minute.',
		};
	}
	return { ok: true };
}
