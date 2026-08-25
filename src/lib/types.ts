export type FontCategory = 'sans-serif' | 'serif' | 'display' | 'handwriting' | 'monospace';

export interface FontAxis {
	tag: string;
	min: number;
	max: number;
	defaultValue: number;
}

export interface GoogleFont {
	id: string;
	family: string;
	displayName: string;
	category: FontCategory;
	variants: string[];
	subsets: string[];
	weight: string;
	italic: boolean;
	variable: boolean;
	axes: FontAxis[];
	popularity: number;
	designer: string;
	dateAdded: string;
	featured: boolean;
}

export interface PaidFont {
	id: string;
	name: string;
	foundry: string;
	price: string;
	category: FontCategory;
	freeAlt: string;
	url?: string;
}

export type AnyFont = GoogleFont | PaidFont;

export interface SlimFreeFont {
	id: string;
	family: string;
	category: FontCategory;
	popularity: number;
}

export interface SlimPaidFont {
	id: string;
	name: string;
	foundry: string;
	price: string;
	category: FontCategory;
	freeAlt: string;
	url?: string;
}

export interface AIHint {
	transcription: string;
	category: FontCategory | '';
	recognized: { name: string; confidence: number }[];
}

export interface IdentifyResponse {
	transcription: string;
	category: FontCategory | '';
	hint: { family: string; confidence: number }[];
	free: SlimFreeFont[];
	paid: SlimPaidFont[];
}

export interface FreeMatch {
	id: string;
	family: string;
	category: FontCategory;
	confidence: number;
	rank: number;
	// Which DB weight matched best ('regular' | 'bold'). The refine stage uses
	// this to render candidate words in the same weight as the source text.
	weight?: string;
}

export interface PaidMatch {
	id: string;
	name: string;
	foundry: string;
	price: string;
	category: FontCategory;
	freeAlt: string;
	confidence: number;
	url?: string;
}