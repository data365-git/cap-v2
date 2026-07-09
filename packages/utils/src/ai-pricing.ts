// Google Gemini API prices, USD per 1M tokens.
// https://ai.google.dev/gemini-api/docs/pricing
// Audio input is billed at a DIFFERENT (higher) rate than text — the previous
// single-rate table billed audio at the text rate and understated output,
// under-reporting transcription spend by roughly an order of magnitude.
const PRICES: Record<
	string,
	{
		textInputPerMillion: number;
		audioInputPerMillion: number;
		outputPerMillion: number;
	}
> = {
	"gemini-2.5-flash": {
		textInputPerMillion: 0.3,
		audioInputPerMillion: 1.0,
		outputPerMillion: 2.5,
	},
	"gemini-2.5-pro": {
		textInputPerMillion: 1.25,
		audioInputPerMillion: 1.25,
		outputPerMillion: 10.0,
	},
	"gemini-3-flash-preview": {
		textInputPerMillion: 0.5,
		audioInputPerMillion: 1.0,
		outputPerMillion: 3.0,
	},
	"gemini-embedding-001": {
		textInputPerMillion: 0,
		audioInputPerMillion: 0,
		outputPerMillion: 0,
	},
};

const DEFAULT_PRICE = {
	textInputPerMillion: 0.5,
	audioInputPerMillion: 1.0,
	outputPerMillion: 3.0,
};

export function priceForMicros(
	model: string,
	inputTokens: number,
	outputTokens: number,
	opts?: { audio?: boolean },
): number {
	const price = PRICES[model] ?? DEFAULT_PRICE;
	const inputRate = opts?.audio
		? price.audioInputPerMillion
		: price.textInputPerMillion;
	const inputCostUsd = (inputTokens / 1_000_000) * inputRate;
	const outputCostUsd = (outputTokens / 1_000_000) * price.outputPerMillion;
	return Math.round((inputCostUsd + outputCostUsd) * 1_000_000);
}
