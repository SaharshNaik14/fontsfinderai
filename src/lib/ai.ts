import { SITE } from './site';
import type { AIHint, FontCategory } from './types';

export interface AIService {
	run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

const CATEGORIES: FontCategory[] = ['sans-serif', 'serif', 'display', 'handwriting', 'monospace'];

const PROMPT = `You are a typeface identification assistant. Look at the image and respond with a single JSON object and nothing else. No markdown, no commentary.

JSON shape:
{
  "transcription": "the exact text shown in the image, or \"\" if none",
  "category": "sans-serif | serif | display | handwriting | monospace, or \"\" if unknown",
  "confidence": 0.0 to 1.0,
  "recognized": [ { "name": "well-known font family name", "confidence": 0.0 to 1.0 } ]
}

Rules:
- "recognized" may be empty, or list up to 3 candidate typefaces you are reasonably confident about, ordered by confidence.
- Use well-known family names only, e.g. Helvetica, Arial, Roboto, Inter, Montserrat, Poppins, Playfair Display, Times New Roman, Comic Sans MS.
- If the image contains no legible text, return {"transcription": "", "category": "", "confidence": 0, "recognized": []}.`;

const jsonify = (text: string): unknown => {
	const open = text.indexOf('{');
	const close = text.lastIndexOf('}');
	if (open === -1 || close === -1 || close <= open) return null;
	try {
		return JSON.parse(text.slice(open, close + 1));
	} catch {
		return null;
	}
};

const normalize = (raw: unknown): AIHint | null => {
	if (typeof raw !== 'object' || raw === null) return null;
	const r = raw as Record<string, unknown>;

	const transcription = typeof r.transcription === 'string' ? r.transcription.slice(0, 200) : '';
	let category: FontCategory | '' = '';
	if (typeof r.category === 'string' && (CATEGORIES as string[]).includes(r.category)) {
		category = r.category as FontCategory;
	}

	const recognized: { name: string; confidence: number }[] = [];
	if (Array.isArray(r.recognized)) {
		for (const item of r.recognized) {
			if (typeof item === 'object' && item !== null && typeof (item as { name?: unknown }).name === 'string') {
				const name = ((item as { name: string }).name).trim().slice(0, 60);
				const c = (item as { confidence?: unknown }).confidence;
				const confidence = typeof c === 'number' && Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 0.5;
				if (name) recognized.push({ name, confidence });
			}
			if (recognized.length >= 3) break;
		}
	}

	return { transcription, category, recognized };
};

async function runVision(
	ai: AIService,
	input: Record<string, unknown>,
): Promise<unknown> {
	try {
		return await ai.run(SITE.aiModel, input);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (!message.includes('5016') && !/license|agree/i.test(message)) return null;
		try {
			await ai.run(SITE.aiModel, { prompt: 'agree' });
			return await ai.run(SITE.aiModel, input);
		} catch {
			return null;
		}
	}
}

export async function getAIHint(
	env: { AI?: AIService },
	imageDataUrl: string,
	text: string,
): Promise<AIHint | null> {
	const ai = env.AI;
	if (!ai) return null;

	let out: unknown;
	const prompt = text
		? `${PROMPT}\nThe user typed this text. Use it only as a hint — transcribe what actually appears in the image, do not assume: "${text}"`
		: PROMPT;
	out = await runVision(ai, {
		image: imageDataUrl,
		prompt,
		max_tokens: 384,
		temperature: 0.2,
	});
	if (out === null) return null;

	const obj = out as { response?: unknown; text?: unknown } | null;
	const response = obj?.response ?? obj?.text;
	if (typeof response !== 'string' && typeof response !== 'object') return null;
	const rawText = typeof response === 'string' ? response : JSON.stringify(response);
	if (!rawText) return null;

	const parsed = jsonify(rawText);
	const hint = normalize(parsed);
	if (!hint) return null;

	if (!hint.transcription && !hint.category && hint.recognized.length === 0) return null;
	return hint;
}