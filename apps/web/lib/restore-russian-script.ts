/**
 * Deterministic post-guard for the "romanized Russian" transcription bug.
 *
 * The transcription prompt orders Gemini to keep Russian words in Cyrillic
 * (любой, сразу…), but the model still occasionally romanizes them ("lyuboy",
 * "srazu"). A prompt is a request; this guard is a guarantee for the words
 * that actually recur in real meetings.
 *
 * Scope is deliberately CONSERVATIVE: only words that are unambiguously
 * spoken Russian and are NOT accepted Uzbek-Latin vocabulary. Never add
 * legitimate Uzbek loanwords here (byudjet, klient, proyekt, dogovor…) —
 * those are correct Uzbek spellings, not romanization mistakes.
 *
 * Applied at the transcript SOURCE (before storage) so every consumer
 * (panels, captions, summaries, translations) sees the corrected text.
 */

// romanized (lowercase) → Cyrillic (lowercase). Variants map to one target.
const ROMANIZED_RUSSIAN: Record<string, string> = {
	lyuboy: "любой",
	lyubaya: "любая",
	lyuboe: "любое",
	lyubie: "любые",
	lyubye: "любые",
	srazu: "сразу",
	seychas: "сейчас",
	sichas: "сейчас",
	konechno: "конечно",
	kanechno: "конечно",
	voobshe: "вообще",
	vapshe: "вообще",
	vaabshe: "вообще",
	vobshem: "в общем",
	prosto: "просто",
	tochno: "точно",
	dazhe: "даже",
	znachit: "значит",
	koroche: "короче",
	kstati: "кстати",
	ladno: "ладно",
	davay: "давай",
	davayte: "давайте",
	uzhe: "уже",
	poka: "пока",
	naprimer: "например",
	obyazatelno: "обязательно",
	abyazatelno: "обязательно",
	poluchaetsya: "получается",
	paluchaetsya: "получается",
	deystvitelno: "действительно",
	naverno: "наверно",
	navernoe: "наверное",
	vsyo: "всё",
	nichego: "ничего",
	nichevo: "ничего",
	pochemu: "почему",
	potomu: "потому",
	chto: "что",
	shto: "что",
	// --- expansion 2026-07-02: high-frequency spoken-Russian discourse words.
	// Same conservative rule: NOTHING that is legitimate Uzbek-Latin or common
	// English. Variants (h/kh/x for х, a for unstressed o) map to one target.
	eto: "это",
	etogo: "этого",
	etomu: "этому",
	esli: "если",
	toest: "то есть",
	tozhe: "тоже",
	toje: "тоже",
	mozhet: "может",
	mojet: "может",
	mozhno: "можно",
	mojno: "можно",
	nelzya: "нельзя",
	nuzhno: "нужно",
	nujno: "нужно",
	nado: "надо",
	budet: "будет",
	budem: "будем",
	budesh: "будешь",
	bylo: "было",
	byli: "были",
	horosho: "хорошо",
	khorosho: "хорошо",
	xorosho: "хорошо",
	harasho: "хорошо",
	xarasho: "хорошо",
	ploho: "плохо",
	plokho: "плохо",
	ploxo: "плохо",
	normalno: "нормально",
	narmalna: "нормально",
	konkretno: "конкретно",
	primerno: "примерно",
	ponyatno: "понятно",
	panyatna: "понятно",
	ponimaesh: "понимаешь",
	panimaesh: "понимаешь",
	ponimaete: "понимаете",
	znaesh: "знаешь",
	znaete: "знаете",
	smotri: "смотри",
	smotrite: "смотрите",
	slushay: "слушай",
	slushayte: "слушайте",
	davno: "давно",
	potom: "потом",
	patom: "потом",
	poetomu: "поэтому",
	teper: "теперь",
	tiper: "теперь",
	segodnya: "сегодня",
	sivodnya: "сегодня",
	zavtra: "завтра",
	vchera: "вчера",
	vchira: "вчера",
	vopros: "вопрос",
	voprosy: "вопросы",
	otvet: "ответ",
	tolko: "только",
	tolka: "только",
	ochen: "очень",
	ochin: "очень",
	bolshe: "больше",
	menshe: "меньше",
	luchshe: "лучше",
	luchche: "лучше",
	vazhno: "важно",
	vajno: "важно",
	interesno: "интересно",
	slozhno: "сложно",
	slojno: "сложно",
	bystro: "быстро",
	gotovo: "готово",
	gotov: "готов",
	gotovy: "готовы",
	otlichno: "отлично",
	atlichna: "отлично",
	soglasen: "согласен",
	soglasna: "согласна",
	soglasny: "согласны",
	kazhetsya: "кажется",
	kajetsya: "кажется",
	dopustim: "допустим",
	predstavlyaesh: "представляешь",
	obshem: "общем",
	obshchem: "общем",
	vaobshe: "вообще",
	pravilno: "правильно",
	nepravilno: "неправильно",
	vmeste: "вместе",
	otdelno: "отдельно",
	postoyanno: "постоянно",
	obychno: "обычно",
	abychna: "обычно",
	chasto: "часто",
	redko: "редко",
	pochti: "почти",
	sovsem: "совсем",
	savsem: "совсем",
	poprobuem: "попробуем",
	poprobuy: "попробуй",
	posmotrim: "посмотрим",
	posmotri: "посмотри",
	proverim: "проверим",
	podozhdi: "подожди",
	podojdi: "подожди",
	podozhdite: "подождите",
	hvatit: "хватит",
	khvatit: "хватит",
	xvatit: "хватит",
	poluchitsya: "получится",
	paluchitsya: "получится",
	poluchilos: "получилось",
	paluchilos: "получилось",
	rabotaet: "работает",
	rabotayet: "работает",
	sdelaem: "сделаем",
	sdelat: "сделать",
	sdelali: "сделали",
	naoborot: "наоборот",
	smysl: "смысл",
	smysle: "смысле",
	// --- observed in the 2026-07-02 live A/B sample (finance-Russian):
	pribil: "прибыль",
	pribyl: "прибыль",
	daxodnost: "доходность",
	dohodnost: "доходность",
	otchyot: "отчёт",
	otchet: "отчёт",
	otchyotnost: "отчётность",
	otchetnost: "отчётность",
};

const PATTERN = new RegExp(
	`\\b(${Object.keys(ROMANIZED_RUSSIAN).join("|")})\\b`,
	"gi",
);

/** Match the source word's capitalization on the Cyrillic replacement. */
function matchCase(source: string, target: string): string {
	if (source === source.toUpperCase() && source.length > 1) {
		return target.toUpperCase();
	}
	if (source[0] === source[0]?.toUpperCase()) {
		return (target[0]?.toUpperCase() ?? "") + target.slice(1);
	}
	return target;
}

/**
 * Replace romanized Russian words with their Cyrillic originals throughout a
 * transcript (VTT or plain text). Word-boundary + case-preserving; leaves all
 * timestamps, markup (`**bold**`, voice tags) and everything else untouched.
 */
export function restoreRussianScript(text: string): string {
	if (!text) return text;
	return text.replace(PATTERN, (match) => {
		const target = ROMANIZED_RUSSIAN[match.toLowerCase()];
		return target ? matchCase(match, target) : match;
	});
}

/**
 * Apply restoreRussianScript to EVERY string inside an arbitrary JSON-like
 * value (AI summary objects, translated summaries...). Non-strings pass through
 * untouched; the input is never mutated. This is how the guard covers the
 * summary/refined/translation surfaces, not just the transcript VTT.
 */
export function restoreRussianScriptDeep<T>(value: T): T {
	if (typeof value === "string") {
		return restoreRussianScript(value) as unknown as T;
	}
	if (Array.isArray(value)) {
		return value.map((item) => restoreRussianScriptDeep(item)) as unknown as T;
	}
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, inner] of Object.entries(value)) {
			out[key] = restoreRussianScriptDeep(inner);
		}
		return out as unknown as T;
	}
	return value;
}
