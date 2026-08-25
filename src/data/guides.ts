export interface Guide {
	slug: string;
	title: string;
	description: string;
	read: string;
	body: string[];
}

// Shared guide content: rendered in full on /guides/<slug> and excerpted on
// /guides. Body strings may contain inline HTML (links, code blocks).
export const guides: Guide[] = [
	{
		slug: 'identify-font-from-image',
		title: 'How to identify a font from an image',
		description:
			'A practical walkthrough for identifying any typeface from a screenshot or photo — cropping, letter detection and judging ranked matches.',
		read: '4 min',
		body: [
			'Font identification is easier than most people think. The trick is feeding the tool a clean image with legible, upright text.',
			'Start with a high-resolution screenshot or photo. Straighten any tilted text — the matcher reads words far more reliably when they are level. Crop out background clutter so only the text remains, and avoid decorative text on curved or heavily styled paths if you can.',
			'<a class="text-link" href="/tools/screenshot-font-finder">Upload your image to the font finder</a> and drag to select just the word you want identified. Tighter crops are the single biggest accuracy lever — one font per crop, three or more letters per crop.',
			'Within seconds you get a ranked list of matches. Look at the match label and, more importantly, eyeball the rendered previews in your own words. A “strong match” badge isn’t worth anything if the letterforms feel wrong to you — trust your eyes.',
			'If the top result is a commercial font, check its free alternative — see our guide to <a class="text-link" href="/guides/free-alternatives-to-commercial-fonts">finding free alternatives to commercial fonts</a>. Most paid typefaces have a remarkably close free lookalike that will serve you just fine.',
		],
	},
	{
		slug: 'free-alternatives-to-commercial-fonts',
		title: 'Finding free alternatives to commercial fonts',
		description:
			'Helvetica, Gotham, Futura — how to find free Google Fonts alternatives that read the same on the page, and what to compare before committing.',
		read: '3 min',
		body: [
			'Commercial fonts like Helvetica, Gotham and Futura are expensive — often $35 or more per family. For most projects, a well-matched free alternative looks indistinguishable to 99% of viewers.',
			'The trick is matching the key visual traits: stroke contrast, x-height, terminal shapes, and overall geometric or humanist character. Helvetica is a neutral neo-grotesque, so Inter and Roboto are its closest free neighbours. Gotham’s clean geometric capitals map nicely to Montserrat. Futura’s perfect circles are captured well by Jost.',
			'On every paid font page in our <a class="text-link" href="/fonts">font catalog</a> you’ll find a recommended free alternative. When the font finder suggests a paid match, it links straight to the free lookalike too.',
			'One honest caveat: free alternatives are rarely perfect clones. Compare uppercase and lowercase side by side, and check the numbers — digits are often the fastest giveaway.',
		],
	},
	{
		slug: 'font-categories-basics',
		title: 'A beginner’s guide to font categories',
		description:
			'Serif, sans-serif, display, handwriting and monospace explained — and how knowing the category makes every font match easier to judge.',
		read: '4 min',
		body: [
			'Understanding the five broad font categories makes the <a class="text-link" href="/">font finder</a> more useful, because you can quickly judge whether a suggested match is even plausible.',
			'<strong>Sans-serif</strong> fonts have no decorative strokes at the end of letters. They feel modern and clean and dominate interfaces today — think Inter, Roboto and Montserrat.',
			'<strong>Serif</strong> fonts carry small lines (serifs) at the ends of strokes. They feel traditional and editorial — think Playfair Display, Merriweather and EB Garamond.',
			'<strong>Display</strong> fonts are built to be big. They’re expressive, decorative, and often unreadable in body text — think Bebas Neue, Bungee and Lobster.',
			'<strong>Handwriting</strong> fonts mimic pen and brush lettering — think Pacifico, Dancing Script and Caveat.',
			'<strong>Monospace</strong> fonts give every character equal width, like a typewriter or code editor — think JetBrains Mono, Fira Code and Space Mono.',
			'Browse each category on the <a class="text-link" href="/fonts">fonts page</a>. When your identification result lands in the wrong category (a handwriting font where you expected a clean sans-serif), treat it as a signal that the match is weak.',
		],
	},
	{
		slug: 'use-custom-fonts-on-the-web',
		title: 'How to use a matched font on your website',
		description:
			'From identification to production: embed a Google Font with two lines of code, keep performance fast, and license correctly for paid faces.',
		read: '3 min',
		body: [
			'Once you’ve identified a font, putting it on your site is a two-line change.',
			'Add the stylesheet link to your HTML head, or import it in your CSS. Google Fonts serves it from a fast global CDN:',
			'<pre class="code-block">&lt;link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&amp;display=swap" rel="stylesheet"&gt;</pre>',
			'Then set the family in CSS:',
			'<pre class="code-block">body { font-family: "Inter", system-ui, sans-serif; }</pre>',
			'Our result cards give you the CSS snippet with one click. For paid fonts, you’ll buy a license from the foundry and self-host the files — never hotlink commercial webfonts.',
			'Keep an eye on performance: load only the weights you actually use, and consider preconnecting to the font CDN. A couple of hundred kilobytes of web font is fine; a dozen families is not.',
		],
	},
];

export const getGuide = (slug: string): Guide | undefined => guides.find((g) => g.slug === slug);
