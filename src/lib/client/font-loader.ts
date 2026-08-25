const FONT_CSS_URL = 'https://fonts.googleapis.com/css2';

export function css2Url(family: string): string {
	const params = new URLSearchParams({
		family: `${family}:wght@600`,
		display: 'swap',
	});
	return `${FONT_CSS_URL}?${params.toString()}`;
}

export async function loadFontFamily(family: string): Promise<boolean> {
	try {
		const url = css2Url(family);
		const res = await fetch(url, { headers: { accept: 'text/css,*/*' } });
		if (!res.ok) return false;
		const css = await res.text();
		const m = /url\((https:[^)]+)\)/.exec(css);
		if (!m) return false;
		const font = new FontFace(family, `url(${m[1]})`, { weight: '600', style: 'normal' });
		await font.load();
		document.fonts.add(font);
		await document.fonts.load(`600 16px "${family}"`).catch(() => undefined);
		return true;
	} catch {
		return false;
	}
}

export async function loadFontBatch(families: string[]): Promise<Record<string, boolean>> {
	const results: Record<string, boolean> = {};
	await Promise.all(
		families.map(async (family) => {
			results[family] = await loadFontFamily(family);
		}),
	);
	return results;
}
