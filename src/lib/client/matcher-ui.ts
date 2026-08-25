import type { FontCategory, FreeMatch, PaidMatch, SlimFreeFont } from '../types';
import { prepareImage, readImageFile } from './match';
import type { PreparedImage, ImageCrop } from './match';
import { measureMatch, segmentLetters } from './measure';
import type { LetterComponent, MeasureProgress } from './measure';
import { clientGoogleFonts, clientPaidCandidates } from './catalog';
import { matchAllFonts, suggestTextDetails } from './match-db';
import type { SuggestResult } from './match-db';
import { SITE } from '../site';

/**
 * Infer font category from the image characteristics without AI.
 * Analyzes letter component shapes to guess serif/sans-serif/monospace/display.
 */
function inferCategory(comps: LetterComponent[]): FontCategory | '' {
	if (comps.length < 2) return '';

	// --- Monospace detection: all components have very similar widths ---
	const widths = comps.map((c) => c.w);
	const meanW = widths.reduce((a, b) => a + b, 0) / widths.length;
	const varianceW = widths.reduce((s, w) => s + (w - meanW) ** 2, 0) / widths.length;
	const cvW = meanW > 0 ? Math.sqrt(varianceW) / meanW : 1;
	if (cvW < 0.12) return 'monospace';

	// --- Serif vs Sans-serif: analyze stroke complexity of signatures ---
	// Serif fonts tend to have more filled bits in their 16×16 signatures
	// because serifs add small decorative strokes at terminals.
	let totalBits = 0;
	let totalSet = 0;
	for (const c of comps) {
		const sig = c.fingerprint;
		for (let i = 0; i < sig.length; i++) {
			totalBits += 8;
			let v = sig[i];
			while (v) {
				totalSet++;
				v &= v - 1;
			}
		}
	}
	const fillRatio = totalBits > 0 ? totalSet / totalBits : 0;

	// --- Size irregularity: display/handwriting fonts have very irregular component sizes ---
	const heights = comps.map((c) => c.h);
	const meanH = heights.reduce((a, b) => a + b, 0) / heights.length;
	const varianceH = heights.reduce((s, h) => s + (h - meanH) ** 2, 0) / heights.length;
	const cvH = meanH > 0 ? Math.sqrt(varianceH) / meanH : 1;

	if (cvH > 0.45) return 'display';

	// Heuristic thresholds (tuned for typical font screenshots):
	// Serif fonts typically have fill ratio > 0.18 due to decorative strokes
	// Sans-serif fonts are cleaner with fill ratio ~0.12–0.18
	if (fillRatio > 0.20) return 'serif';
	if (fillRatio < 0.14) return 'sans-serif';

	// Default: use the more popular category
	return '';
}

interface MatcherElements {
	root: HTMLElement;
	dropzone: HTMLElement;
	fileInput: HTMLInputElement;
	browse: HTMLElement;
	example: HTMLElement;
	uploaded: HTMLElement;
	previewImg: HTMLImageElement;
	reupload: HTMLElement;
	adjustCrop: HTMLButtonElement;
	cropStage: HTMLElement;
	cropSurface: HTMLElement;
	cropWrap: HTMLElement;
	cropImg: HTMLImageElement;
	cropBox: HTMLElement;
	cropIdentify: HTMLButtonElement;
	cropFull: HTMLButtonElement;
	charEdit: HTMLElement;
	charRow: HTMLElement;
	applyChars: HTMLButtonElement;
	progress: HTMLElement;
	progressText: HTMLElement;
	results: HTMLElement;
	aiSummary: HTMLElement;
	lowEvidence: HTMLElement;
	stickyWord: HTMLElement;
	stickyImg: HTMLElement;
	tabs: HTMLElement;
	freeTab: HTMLElement;
	paidTab: HTMLElement;
	allTab: HTMLElement;
	freeOnly: HTMLInputElement;
	previewTextInput: HTMLInputElement;
	freeList: HTMLElement;
	paidList: HTMLElement;
	error: HTMLElement;
	errorText: HTMLElement;
	stateNote: HTMLElement;
	how: HTMLElement;
	howLetters: HTMLElement;
	howFacts: HTMLElement;
}

type Tab = 'all' | 'free' | 'paid';

const $ = <T extends HTMLElement>(root: ParentNode, id: string): T => {
	const el = root.querySelector<T>(`[data-matcher="${id}"]`);
	if (!el) throw new Error(`Missing matcher element: ${id}`);
	return el;
};

const cssFor = (family: string): string => `font-family: "${family}", sans-serif;`;

const setHidden = (el: HTMLElement, hidden: boolean) => {
	el.classList.toggle('hidden', hidden);
	el.hidden = hidden;
};

const EXAMPLES: { url: string; text: string }[] = [
	{ url: '/samples/sample-1.png', text: 'The quick brown fox' },
	{ url: '/samples/sample-2.png', text: 'QUICK BROWN FOX' },
	{ url: '/samples/sample-3.png', text: 'Good design is obvious' },
];

const loadExample = (item: { url: string; text: string }): Promise<string> =>
	fetch(item.url)
		.then((r) => {
			if (!r.ok) throw new Error('Could not load the example image.');
			return r.blob();
		})
		.then(
			(blob) =>
				new Promise<string>((resolve, reject) => {
					const reader = new FileReader();
					reader.onload = () => resolve(String(reader.result));
					reader.onerror = () => reject(new Error('Could not read the example image.'));
					reader.readAsDataURL(blob);
				}),
		);

export function initMatcher(root: HTMLElement): void {
	const e: MatcherElements = {
		root: root,
		dropzone: $(root, 'dropzone'),
		fileInput: $<HTMLInputElement>(root, 'file-input'),
		browse: $(root, 'browse'),
		example: $(root, 'example'),
		uploaded: $(root, 'uploaded'),
		previewImg: $<HTMLImageElement>(root, 'preview-img'),
		reupload: $(root, 'reupload'),
		adjustCrop: $<HTMLButtonElement>(root, 'adjust-crop'),
		cropStage: $(root, 'crop-stage'),
		cropSurface: $(root, 'crop-surface'),
		cropWrap: $(root, 'crop-wrap'),
		cropImg: $<HTMLImageElement>(root, 'crop-img'),
		cropBox: $(root, 'crop-box'),
		cropIdentify: $<HTMLButtonElement>(root, 'crop-identify'),
		cropFull: $<HTMLButtonElement>(root, 'crop-full'),
		charEdit: $(root, 'char-edit'),
		charRow: $(root, 'char-row'),
		applyChars: $<HTMLButtonElement>(root, 'apply-chars'),
		progress: $(root, 'progress'),
		progressText: $(root, 'progress-text'),
		results: $(root, 'results'),
		aiSummary: $(root, 'ai-summary'),
		lowEvidence: $(root, 'low-evidence'),
		stickyWord: $(root, 'sticky-word'),
		stickyImg: $(root, 'sticky-img'),
		tabs: $(root, 'tabs'),
		freeTab: $(root, 'free-tab'),
		paidTab: $(root, 'paid-tab'),
		allTab: $(root, 'all-tab'),
		freeOnly: $<HTMLInputElement>(root, 'free-only'),
		previewTextInput: $<HTMLInputElement>(root, 'preview-text'),
		freeList: $(root, 'free-list'),
		paidList: $(root, 'paid-list'),
		error: $(root, 'error'),
		errorText: $(root, 'error-text'),
		stateNote: $(root, 'state-note'),
		how: $(root, 'how'),
		howLetters: $(root, 'how-letters'),
		howFacts: $(root, 'how-facts'),
	};

	let prepared: PreparedImage | null = null;
	let sourceMask: Uint8ClampedArray | null = null;
	let sourceW = 0;
	let sourceH = 0;
	let comps: LetterComponent[] = [];
	let busy = false;
	let tab: Tab = 'all';
	let freeOnly = false;
	let freeMatches: FreeMatch[] = [];
	let paidMatches: PaidMatch[] = [];
	let shownFree = 15;
	let exampleIndex = 0;
	let currentDataUrl: string | null = null;
	// User's crop selection in normalized image coordinates (0..1).
	let cropNorm: { x0: number; y0: number; x1: number; y1: number } | null = null;
	// Latest auto-guess entries (char + source box per detected letter) — used by
	// the result-card evidence strips and the character-correction editor.
	let lastGuess: SuggestResult | null = null;

	const setError = (message: string) => {
		e.errorText.textContent = message;
		setHidden(e.error, false);
	};

	const clearError = () => {
		setHidden(e.error, true);
	};

	const setProgress = (label: string, percent: number, hidden = false) => {
		setHidden(e.progress, hidden);
		e.progressText.textContent = label;
		const bar = e.progress.querySelector<HTMLElement>('[data-matcher="progress-bar"]');
		if (bar) bar.style.width = `${Math.round(percent)}%`;
	};

	const showResults = () => {
		setHidden(e.results, false);
	};

	const renderAiSummary = () => {
		e.aiSummary.replaceChildren();
		setHidden(e.aiSummary, true);
	};

	const renderLists = () => {
		e.freeList.replaceChildren();
		e.paidList.replaceChildren();
		const preview = e.previewTextInput.value.trim() || SITE.previewText;

		const showFree = tab === 'all' || tab === 'free';
		const showPaid = !freeOnly && (tab === 'all' || tab === 'paid');

		setHidden(e.freeList, !showFree);
		setHidden(e.paidList, !showPaid);

		if (showFree) {
			for (const m of freeMatches.slice(0, shownFree)) {
				e.freeList.append(freeCard(m, preview));
			}
			if (freeMatches.length > shownFree) {
				e.freeList.append(
					moreButton(() => {
						shownFree += 15;
						renderLists();
					}),
				);
			}
		}
		if (showPaid) {
			for (const m of paidMatches) {
				e.paidList.append(paidCard(m));
			}
		}
	};

	const freeCard = (m: FreeMatch, preview: string): HTMLElement => {
		const li = document.createElement('li');
		li.className = 'result-card';

		const head = document.createElement('div');
		head.className = 'result-head';

		const title = document.createElement('div');
		title.className = 'result-title';
		const name = document.createElement('a');
		name.href = `/fonts/${m.id}`;
		name.className = 'result-name';
		name.textContent = m.family;
		title.append(name);

		const meta = document.createElement('div');
		meta.className = 'result-meta';
		const category = document.createElement('span');
		category.textContent = m.category;
		meta.append(category, confidenceBadge(m.confidence));
		head.append(title, meta);

		const sample = document.createElement('div');
		sample.className = 'result-sample';
		sample.style.cssText = cssFor(m.family);
		sample.textContent = preview;

		// Front end shows only the specimen: the detected word set in each
		// candidate font. Which letters were matched stays internal.

		const actions = document.createElement('div');
		actions.className = 'result-actions';
		const copy = document.createElement('button');
		copy.type = 'button';
		copy.className = 'btn btn-ghost btn-sm';
		copy.textContent = 'Copy CSS';
		copy.addEventListener('click', () => {
			navigator.clipboard?.writeText(cssFor(m.family));
			copy.textContent = 'Copied!';
			setTimeout(() => (copy.textContent = 'Copy CSS'), 1200);
		});
		const detail = document.createElement('a');
		detail.className = 'btn btn-ghost btn-sm';
		detail.href = `/fonts/${m.id}`;
		detail.textContent = 'Details';
		actions.append(copy, detail);

		li.append(head, sample, actions);
		return li;
	};

	const paidCard = (m: PaidMatch): HTMLElement => {
		const li = document.createElement('li');
		li.className = 'result-card result-card-paid';

		const head = document.createElement('div');
		head.className = 'result-head';
		const title = document.createElement('div');
		title.className = 'result-title';
		const name = document.createElement('span');
		name.className = 'result-name';
		name.textContent = m.name;
		title.append(name);
		const meta = document.createElement('div');
		meta.className = 'result-meta';
		meta.append(categoryTag(m.category), confidenceBadge(m.confidence));
		head.append(title, meta);

		const facts = document.createElement('div');
		facts.className = 'result-facts';
		facts.textContent = `${m.foundry} · ${m.price}`;

		const alt = document.createElement('div');
		alt.className = 'result-alt';
		alt.append('Free alternative: ');
		const altLink = document.createElement('a');
		altLink.href = `/fonts/${m.freeAlt}`;
		altLink.textContent = m.freeAlt.replace(/-/g, ' ');
		alt.append(altLink);

		const actions = document.createElement('div');
		actions.className = 'result-actions';
		const buy = document.createElement('a');
		buy.className = 'btn btn-primary btn-sm';
		buy.href = m.url ?? '#';
		buy.target = '_blank';
		buy.rel = 'noopener';
		buy.textContent = 'View & buy';
		actions.append(buy);

		li.append(head, facts, alt, actions);
		return li;
	};

	const moreButton = (onClick: () => void): HTMLElement => {
		const li = document.createElement('li');
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'btn btn-ghost btn-sm';
		btn.textContent = `Show ${Math.min(15, freeMatches.length - shownFree)} more`;
		btn.addEventListener('click', onClick);
		li.append(btn);
		return li;
	};

	// Confidence renders as a tier, not a percentage: raw scores near-tie across
	// dozens of faces, so "48% / 47% / 47%…" looked broken. Tiers say what the
	// number actually means without inventing precision.
	const CONFIDENCE_TIERS: [number, string][] = [
		[0.75, 'Strong match'],
		[0.6, 'Likely match'],
		[0.45, 'Possible match'],
		[0, 'Similar font'],
	];
	const confidenceBadge = (c: number): HTMLElement => {
		const badge = document.createElement('span');
		badge.className = 'confidence';
		badge.textContent = CONFIDENCE_TIERS.find(([t]) => c >= t)?.[1] ?? 'Similar font';
		badge.title =
			'How clearly this font beat the others. "Strong match" means it won by a wide margin; "Similar font" means several faces tied.';
		return badge;
	};

	// Calibrated confidence: raw match scores cluster near 0.95+ so raw percentages
	// were meaningless ("everything is 97%"). Normalize within the visible top-N
	// and damp by the leader's margin — a clear winner reads high, a crowded field
	// reads low.
	const calibrateConfidences = () => {
		if (freeMatches.length === 0) return;
		const N = Math.min(15, freeMatches.length);
		const max = freeMatches[0].confidence;
		const min = freeMatches[N - 1].confidence;
		const range = max - min || 1;
		const margin = max - (freeMatches[1]?.confidence ?? 0);
		const leaderCertainty = Math.min(0.97, 0.5 + margin * 8);
		freeMatches.forEach((m) => {
			const rel = Math.min(1, (max - m.confidence) / range);
			m.confidence = Math.max(0.15, leaderCertainty * (1 - rel));
		});
	};

	const categoryTag = (category: string): HTMLElement => {
		const tag = document.createElement('span');
		tag.className = 'category-tag';
		tag.textContent = category;
		return tag;
	};

	const setTab = (next: Tab) => {
		tab = next;
		e.allTab.classList.toggle('is-active', tab === 'all');
		e.freeTab.classList.toggle('is-active', tab === 'free');
		e.paidTab.classList.toggle('is-active', tab === 'paid');
		renderLists();
	};

	e.allTab.addEventListener('click', () => setTab('all'));
	e.freeTab.addEventListener('click', () => setTab('free'));
	e.paidTab.addEventListener('click', () => setTab('paid'));

	e.freeOnly.addEventListener('change', () => {
		freeOnly = e.freeOnly.checked;
		renderLists();
	});

	e.previewTextInput.addEventListener('input', () => renderLists());

	const handleFile = async (file: File) => {
		if (busy) return;
		if (!file.type.startsWith('image/')) {
			setError('That file is not an image. Please choose a PNG, JPG or WebP.');
			return;
		}
		clearError();
		try {
			const dataUrl = await readImageFile(file);
			await loadImage(dataUrl);
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Could not read that image.');
		}
	};

	const loadImage = async (dataUrl: string) => {
		currentDataUrl = dataUrl;
		cropNorm = null;
		e.previewImg.src = dataUrl;
		e.cropImg.src = dataUrl;
		drawCropBox();
		e.cropIdentify.disabled = true;
		freeMatches = [];
		paidMatches = [];
		shownFree = 15;
		// Fresh scan starts with the standard specimen, not the detected word.
		e.previewTextInput.value = '';
		setHidden(e.dropzone, true);
		setHidden(e.uploaded, false);
		setHidden(e.cropStage, false);
		setHidden(e.adjustCrop, true);
		setHidden(e.results, true);
		setHidden(e.how, true);
		setHidden(e.charEdit, true);
		setHidden(e.aiSummary, true);
		e.stateNote.textContent = 'Select the text to identify — tighter crops are far more accurate.';
	};

	// --- crop selection (pointer events; normalized coords survive resize) ---
	const drawCropBox = () => {
		const img = e.cropImg;
		if (!cropNorm || !img.clientWidth) {
			setHidden(e.cropBox, true);
			return;
		}
		const { x0, y0, x1, y1 } = cropNorm;
		e.cropBox.style.left = `${Math.min(x0, x1) * img.clientWidth}px`;
		e.cropBox.style.top = `${Math.min(y0, y1) * img.clientHeight}px`;
		e.cropBox.style.width = `${Math.abs(x1 - x0) * img.clientWidth}px`;
		e.cropBox.style.height = `${Math.abs(y1 - y0) * img.clientHeight}px`;
		setHidden(e.cropBox, false);
	};

	let dragStart: { x: number; y: number } | null = null;

	const pointerPos = (ev: PointerEvent): { x: number; y: number } => {
		const rect = e.cropImg.getBoundingClientRect();
		return {
			x: Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width)),
			y: Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height)),
		};
	};

	e.cropWrap.addEventListener('pointerdown', (ev) => {
		if (busy || !currentDataUrl) return;
		ev.preventDefault();
		e.cropWrap.setPointerCapture(ev.pointerId);
		dragStart = pointerPos(ev);
		cropNorm = { x0: dragStart.x, y0: dragStart.y, x1: dragStart.x, y1: dragStart.y };
		drawCropBox();
	});
	e.cropWrap.addEventListener('pointermove', (ev) => {
		if (!dragStart) return;
		const p = pointerPos(ev);
		cropNorm = { x0: dragStart.x, y0: dragStart.y, x1: p.x, y1: p.y };
		drawCropBox();
	});
	e.cropWrap.addEventListener('pointerup', () => {
		if (!dragStart || !cropNorm) return;
		dragStart = null;
		const w = Math.abs(cropNorm.x1 - cropNorm.x0);
		const h = Math.abs(cropNorm.y1 - cropNorm.y0);
		if (w < 0.03 || h < 0.03) {
			cropNorm = null; // accidental click — ignore
			drawCropBox();
			e.cropIdentify.disabled = true;
			return;
		}
		e.cropIdentify.disabled = busy;
	});

	const cropToNatural = (): ImageCrop | undefined => {
		const img = e.cropImg;
		if (!cropNorm || !img.naturalWidth) return undefined;
		return {
			x: Math.round(Math.min(cropNorm.x0, cropNorm.x1) * img.naturalWidth),
			y: Math.round(Math.min(cropNorm.y0, cropNorm.y1) * img.naturalHeight),
			w: Math.round(Math.abs(cropNorm.x1 - cropNorm.x0) * img.naturalWidth),
			h: Math.round(Math.abs(cropNorm.y1 - cropNorm.y0) * img.naturalHeight),
		};
	};

	e.example.addEventListener('click', async () => {
		if (busy) return;
		clearError();
		const item = EXAMPLES[exampleIndex % EXAMPLES.length];
		exampleIndex++;
		try {
			const dataUrl = await loadExample(item);
			await loadImage(dataUrl);
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Could not load the example image.');
		}
	});

	e.dropzone.addEventListener('click', () => e.fileInput.click());
	e.dropzone.addEventListener('keydown', (ev) => {
		if (ev.key === 'Enter' || ev.key === ' ') {
			ev.preventDefault();
			e.fileInput.click();
		}
	});
	e.browse.addEventListener('click', (ev) => {
		ev.stopPropagation();
		e.fileInput.click();
	});
	e.fileInput.addEventListener('change', () => {
		const file = e.fileInput.files?.[0];
		if (file) void handleFile(file);
	});

	for (const type of ['dragenter', 'dragover']) {
		e.dropzone.addEventListener(type, (ev) => {
			ev.preventDefault();
			e.dropzone.classList.add('is-dragging');
		});
	}
	for (const type of ['dragleave', 'drop']) {
		e.dropzone.addEventListener(type, (ev) => {
			ev.preventDefault();
			e.dropzone.classList.remove('is-dragging');
		});
	}
	e.dropzone.addEventListener('drop', (ev) => {
		const file = ev.dataTransfer?.files?.[0];
		if (file) void handleFile(file);
	});

	document.addEventListener('paste', (ev) => {
		const item = Array.from(ev.clipboardData?.items ?? []).find((i) => i.type.startsWith('image/'));
		const file = item?.getAsFile();
		if (file) void handleFile(file);
	});

	e.reupload.addEventListener('click', () => {
		prepared = null;
		sourceMask = null;
		currentDataUrl = null;
		cropNorm = null;
		freeMatches = [];
		paidMatches = [];
		shownFree = 15;
		setHidden(e.uploaded, true);
		setHidden(e.cropStage, true);
		setHidden(e.adjustCrop, true);
		setHidden(e.dropzone, false);
		setHidden(e.results, true);
		setHidden(e.how, true);
		setHidden(e.charEdit, true);
		setHidden(e.aiSummary, true);
		e.fileInput.value = '';
	});

	const drawThumb = (c: { x: number; y: number; w: number; h: number }): HTMLCanvasElement => {
		const thumb = document.createElement('canvas');
		thumb.width = 28;
		thumb.height = 28;
		const tctx = thumb.getContext('2d');
		if (tctx && sourceMask) {
			const imageData = tctx.createImageData(28, 28);
			for (let gy = 0; gy < 28; gy++) {
				const sy = Math.min(sourceH - 1, c.y + Math.floor((gy * c.h) / 28));
				for (let gx = 0; gx < 28; gx++) {
					const sx = Math.min(sourceW - 1, c.x + Math.floor((gx * c.w) / 28));
					const ink = sourceMask[sy * sourceW + sx] === 1;
					const idx = (gy * 28 + gx) * 4;
					imageData.data[idx] = 255;
					imageData.data[idx + 1] = 255;
					imageData.data[idx + 2] = 255;
					imageData.data[idx + 3] = ink ? 255 : 0;
				}
			}
			tctx.putImageData(imageData, 0, 0);
		}
		return thumb;
	};

	const renderHow = () => {
		e.howLetters.replaceChildren();
		for (const c of comps) {
			const box = document.createElement('span');
			box.className = 'inline-block overflow-hidden rounded border border-hairline bg-canvas';
			box.append(drawThumb(c));
			e.howLetters.append(box);
		}
		const method = comps.some((c) => c.joined)
			? 'letter shapes detected (letters run together)'
			: `per-letter shape fingerprints (${comps.length} shapes)`;
		e.howFacts.textContent = `${comps.length} letter shapes detected · compared against ${freeMatches.length} free fonts · ${method}`;
		setHidden(e.how, false);
	};

	const boostAiPicks = () => {
		// No AI hints — nothing to boost.
	};

	const charInputs = () =>
		Array.from(e.charRow.querySelectorAll<HTMLInputElement>('input[data-char]'));

	const readEditedText = (): string => charInputs().map((i) => i.value.trim()).join('');

	const renderCharEditor = (guess: SuggestResult | null) => {
		e.charRow.replaceChildren();
		lastGuess = guess;
		if (!guess || guess.entries.length === 0) {
			setHidden(e.charEdit, true);
			return;
		}
		for (const entry of guess.entries) {
			const cell = document.createElement('div');
			cell.className = 'flex flex-col items-center gap-1';
			const box = document.createElement('span');
			box.className = 'inline-block overflow-hidden rounded border border-hairline bg-canvas';
			box.append(drawThumb(entry.box));
			const input = document.createElement('input');
			input.type = 'text';
			input.maxLength = 1;
			input.value = entry.char;
			input.dataset.char = '1';
			input.setAttribute('aria-label', 'Detected letter — edit if wrong');
			input.className =
				'w-8 rounded border border-hairline bg-canvas py-1 text-center text-body-md text-ink focus:border-hairline-strong focus:outline-none';
			cell.append(box, input);
			e.charRow.append(cell);
		}
		setHidden(e.charEdit, false);
	};

	// Render-refine pass: re-rank the Hamming top-N by rendering the word in each
	// candidate font and comparing pixel masks (size-robust word similarity).
	const runRefine = async (text: string): Promise<void> => {
		if (!sourceMask || !text || freeMatches.length === 0) return;
		setProgress('Refining with rendered font comparison…', 90);
		const topCount = Math.min(40, freeMatches.length);
		const topFamilies = freeMatches.slice(0, topCount).map((m) => m.family);
		const preferSet = new Set(topFamilies.map((f) => f.toLowerCase()));
		const subset: SlimFreeFont[] = [];
		for (const f of clientGoogleFonts) {
			if (preferSet.has(f.family.toLowerCase())) subset.push(f);
		}
		if (subset.length === 0) return;

		// Render candidates in the weight that won at the Hamming stage.
		const weightsByFamily = new Map<string, number>();
		for (let i = 0; i < topCount; i++) {
			const m = freeMatches[i];
			weightsByFamily.set(m.family.toLowerCase(), m.weight === 'bold' ? 700 : 400);
		}

		const measured = await measureMatch(
			subset,
			sourceMask,
			sourceW,
			sourceH,
			text,
			[],
			(p: MeasureProgress) => {
				const total = p.stage === 'letters' ? Math.max(1, p.total) : subset.length;
				setProgress(
					`Rendering ${p.stage === 'letters' ? 'letter' : 'word'} shapes for ${p.current || 'fonts'}…`,
					90 + (p.loaded / total) * 9,
				);
			},
			weightsByFamily,
		);
		// Merge: re-rank the refined top-N among themselves (70% rendered score +
		// 30% hamming as a tiebreak), then keep the rest in hamming order behind
		// them. Never let a refined score (~0.85) drop a font below an unrefined
		// one (~0.99+) — that was destroying ranks.
		const refinedIds = new Set(subset.map((s) => s.id));
		const hammingById = new Map(freeMatches.map((m) => [m.id, m.confidence]));
		const blended = measured
			.map((m) => ({
				id: subset[m.index].id,
				score: Math.min(1, 0.7 * m.score + 0.3 * (hammingById.get(subset[m.index].id) ?? 0)),
			}))
			.sort((a, b) => b.score - a.score);
		const orderedRefined = blended
			.map((b) => freeMatches.find((m) => m.id === b.id))
			.filter((m): m is FreeMatch => m !== undefined);
		freeMatches = [
			...orderedRefined,
			...freeMatches.filter((m) => !refinedIds.has(m.id)),
		];
		freeMatches.forEach((m, i) => (m.rank = i));
	};

	const finishResults = () => {
		calibrateConfidences();
		shownFree = 15;
		setProgress('Done', 100, true);
		showResults();
		renderAiSummary();
		renderHow();
		renderLists();
		// Low-evidence guardrail: a match from one or two glyphs leans heavily on
		// priors (popular fonts win ties), so say so instead of looking confident.
		const evidenceCount = lastGuess?.entries.length ?? comps.length;
		if (evidenceCount > 0 && evidenceCount < 3) {
			e.lowEvidence.textContent =
				evidenceCount === 1
					? 'Matched from a single letter — treat these as suggestions. Simple letters like "l" or "o" look alike in hundreds of fonts; a crop with 3 or more letters is far more reliable.'
					: `Matched from only ${evidenceCount} letters — treat these as suggestions. A crop with 3 or more letters is far more reliable.`;
			setHidden(e.lowEvidence, false);
		} else {
			setHidden(e.lowEvidence, true);
		}
		// Sticky side-by-side: keep the processed image pinned above the matches.
		e.stickyImg.replaceChildren();
		if (prepared) {
			const im = document.createElement('img');
			im.src = prepared.dataUrl;
			im.alt = 'The text being identified';
			im.className = 'max-h-16 w-auto';
			e.stickyImg.append(im);
		}
		setHidden(e.stickyWord, false);
		if (cropNorm) setHidden(e.adjustCrop, false);
		e.stateNote.textContent = `Matched against ${freeMatches.length} free fonts.`;
	};

	e.adjustCrop.addEventListener('click', () => {
		setHidden(e.cropStage, false);
		e.cropStage.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
	});

	// Full pipeline — Hamming ranking → auto-guess → character-correction UI →
	// refine when the guess clears the confidence gate. Runs on demand once the
	// user commits to a crop (or the full image).
	const runIdentify = async (crop?: ImageCrop) => {
		if (busy || !currentDataUrl) return;
		busy = true;
		clearError();
		e.cropIdentify.disabled = true;
		e.cropFull.disabled = true;

		try {
			prepared = await prepareImage(currentDataUrl, crop);
			sourceMask = prepared.mask;
			sourceW = prepared.width;
			sourceH = prepared.height;
			comps = segmentLetters(sourceMask, sourceW, sourceH);
			freeMatches = [];
			setHidden(e.cropStage, true);

			const category = inferCategory(comps);
			const hintIds = new Set<string>();

			freeMatches = await matchAllFonts(sourceMask, sourceW, sourceH, (p) => {
				setProgress(
					`Comparing letter shapes against ${p.total} fonts…`,
					4 + (p.loaded / Math.max(1, p.total)) * 76,
				);
			});

			// Auto-guess the word from per-letter shape voting (no typing needed).
			let guess: SuggestResult | null = null;
			if (freeMatches.length > 0 && comps.length > 0) {
				guess = await suggestTextDetails(sourceMask, sourceW, sourceH, (p) => {
					setProgress(
						`Guessing letters… ${p.current || ''}`,
						80 + (p.loaded / Math.max(1, p.total)) * 8,
					);
				});
				renderCharEditor(guess);
			} else {
				renderCharEditor(null);
			}

			// Refine is the default flow whenever the guess is confident enough
			// (avgConf ≥ 0.5). Weak guesses stay Hamming-only until the user fixes
			// the letters in the editor and re-matches.
			if (guess && guess.avgConf >= 0.5 && guess.text) {
				await runRefine(guess.text);
			}

			const topAltIds = new Set(freeMatches.slice(0, 15).map((m) => m.id));
			paidMatches = clientPaidCandidates(category, hintIds, 24).map((p) => {
				const altRanked = topAltIds.has(p.freeAlt);
				const confidence = altRanked ? 0.85 : p.category === category ? 0.5 : 0.4;
				return { ...p, confidence };
			});

			boostAiPicks();
			finishResults();
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'Something went wrong.';
			if (msg.includes('fetch') || msg.includes('network') || msg.includes('Failed to fetch')) {
				setError('Could not connect to the server. Check your internet connection and try again.');
			} else {
				setError(msg || 'Something went wrong. Please try again.');
			}
		} finally {
			busy = false;
			e.cropIdentify.disabled = !cropNorm;
			e.cropFull.disabled = false;
		}
	};

	e.cropIdentify.addEventListener('click', () => void runIdentify(cropToNatural()));
	e.cropFull.addEventListener('click', () => void runIdentify(undefined));

	// Character correction: user edits the detected letters, we re-run the
	// render-refine pass against the corrected text.
	e.applyChars.addEventListener('click', async () => {
		if (busy || !sourceMask) return;
		const text = readEditedText();
		if (!text) {
			setError('Type at least one letter before re-matching.');
			return;
		}
		clearError();
		busy = true;
		e.applyChars.disabled = true;
		try {
			await runRefine(text);
			finishResults();
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
		} finally {
			busy = false;
			e.applyChars.disabled = false;
		}
	});
}
