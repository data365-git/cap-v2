export interface ScribeWord {
	word: string;
	start: number;
	end: number;
}

export interface VttTimingTransferStats {
	shiftedCueCount: number;
	meanShiftSec: number;
	denseMatches: number;
	skeletonAnchors: number;
	identity: boolean;
}

interface Cue {
	lineIdx: number;
	start: number;
	end: number;
	rest: string;
	text: string;
}

interface GeminiWord {
	cueIdx: number;
	wordIdxInCue: number;
	stem: string;
}

interface TimedStem {
	time: number;
	stem: string;
}

interface Anchor {
	g: number;
	w: number;
}

interface Match {
	gIdx: number;
	time: number;
}

const MIN_SKELETON_ANCHORS = 10;
const LCS_CELL_CAP = 250_000;
const OUTLIER_MAX_SEC = 8;
const AVG_WORD_SEC = 0.38;

export function transferVttTiming(
	vttText: string,
	words: ScribeWord[],
): string {
	return transferVttTimingWithStats(vttText, words).vtt;
}

/**
 * Copy corrected cue ranges to a translated VTT without changing its text.
 * Returns null instead of risking a mismatched rewrite when cue counts differ.
 */
export function copyCueTimingsByIndex(
	sourceVtt: string,
	targetVtt: string,
): string | null {
	const rangePattern =
		/^(\s*)(\d{2}:\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[.,]\d{3})(.*)$/;
	const sourceRanges = sourceVtt
		.split(/\r?\n/)
		.map((line) => line.match(rangePattern))
		.filter((match): match is RegExpMatchArray => match !== null);
	const targetLines = targetVtt.split(/\r?\n/);
	const targetIndexes = targetLines
		.map((line, index) => (rangePattern.test(line) ? index : -1))
		.filter((index) => index >= 0);

	if (
		sourceRanges.length === 0 ||
		sourceRanges.length !== targetIndexes.length
	) {
		return null;
	}

	for (let i = 0; i < targetIndexes.length; i++) {
		const lineIndex = targetIndexes[i];
		const source = sourceRanges[i];
		const target =
			lineIndex == null ? null : targetLines[lineIndex]?.match(rangePattern);
		if (lineIndex == null || !source || !target) return null;
		targetLines[lineIndex] =
			`${target[1]}${source[2]} --> ${source[3]}${target[4]}`;
	}

	return targetLines.join("\n");
}

export function transferVttTimingWithStats(
	vttText: string,
	words: ScribeWord[],
): { vtt: string; stats: VttTimingTransferStats } {
	const parsed = parseVtt(vttText);
	if (parsed.cues.length === 0 || words.length === 0) {
		return identityResult(vttText, 0);
	}

	const geminiWords = buildGeminiWordStream(parsed.cues);
	const scribeWords = buildScribeWordStream(words);
	if (geminiWords.length === 0 || scribeWords.length === 0) {
		return identityResult(vttText, 0);
	}

	const skeleton = monotonicAnchors(
		buildSkeletonAnchors(geminiWords, scribeWords),
	);
	if (skeleton.length < MIN_SKELETON_ANCHORS) {
		return identityResult(vttText, skeleton.length);
	}

	const matches = buildDenseMatches(geminiWords, scribeWords, skeleton);
	const filteredMatches = filterOutliers(matches, skeleton, scribeWords);
	if (filteredMatches.length === 0) {
		return identityResult(vttText, skeleton.length);
	}

	const newStarts = buildCueStarts(
		parsed.cues,
		geminiWords,
		filteredMatches,
		totalBound(parsed.cues, words),
	);
	const warped = buildWarpedCueTimes(
		parsed.cues,
		newStarts,
		totalBound(parsed.cues, words),
	);
	const lines = [...parsed.lines];

	for (let i = 0; i < warped.length; i++) {
		const cue = parsed.cues[i];
		const time = warped[i];
		if (!cue || !time) continue;
		lines[cue.lineIdx] =
			`${formatTimestamp(time.start)} --> ${formatTimestamp(time.end)}${cue.rest}`;
	}

	const shifts = parsed.cues.map((cue, i) =>
		Math.abs((warped[i]?.start ?? cue.start) - cue.start),
	);
	const shifted = shifts.filter((shift) => shift > 0.05);
	const mean =
		shifted.length > 0
			? shifted.reduce((sum, shift) => sum + shift, 0) / shifted.length
			: 0;

	return {
		vtt: lines.join("\n"),
		stats: {
			shiftedCueCount: shifted.length,
			meanShiftSec: mean,
			denseMatches: filteredMatches.length,
			skeletonAnchors: skeleton.length,
			identity: false,
		},
	};
}

function identityResult(
	vtt: string,
	skeletonAnchors: number,
): { vtt: string; stats: VttTimingTransferStats } {
	return {
		vtt,
		stats: {
			shiftedCueCount: 0,
			meanShiftSec: 0,
			denseMatches: 0,
			skeletonAnchors,
			identity: true,
		},
	};
}

function parseVtt(vttText: string): { lines: string[]; cues: Cue[] } {
	const lines = vttText.split(/\r?\n/);
	const cues: Cue[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const arrow = line.indexOf("-->");
		if (arrow < 0) continue;

		const start = parseTimestamp(line.slice(0, arrow));
		const afterArrow = line.slice(arrow + 3).trim();
		const endToken = afterArrow.split(/\s+/)[0] ?? "";
		const rest = afterArrow.slice(endToken.length);
		const end = parseTimestamp(endToken);
		if (start == null || end == null) continue;

		let text = "";
		for (
			let j = i + 1;
			j < lines.length &&
			(lines[j] ?? "").trim() !== "" &&
			!(lines[j] ?? "").includes("-->");
			j++
		) {
			text += `${lines[j] ?? ""} `;
		}

		cues.push({
			lineIdx: i,
			start,
			end,
			rest,
			text: text
				.replace(/<[^>]+>/g, " ")
				.replace(/^[^:]{1,25}:\s*/, "")
				.trim(),
		});
	}

	return { lines, cues };
}

function parseTimestamp(value: string): number | null {
	const parts = value.trim().split(":");
	let h = 0;
	let m = 0;
	let s = "0";
	if (parts.length === 3) {
		h = Number(parts[0]);
		m = Number(parts[1]);
		s = parts[2] ?? "0";
	} else if (parts.length === 2) {
		m = Number(parts[0]);
		s = parts[1] ?? "0";
	} else {
		return null;
	}
	const sec = Number.parseFloat(s.replace(",", "."));
	if (Number.isNaN(h) || Number.isNaN(m) || Number.isNaN(sec)) return null;
	return h * 3600 + m * 60 + sec;
}

function formatTimestamp(value: number): string {
	const t = Math.max(0, value);
	const h = Math.floor(t / 3600);
	const m = Math.floor((t % 3600) / 60);
	const s = t % 60;
	return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0")}`;
}

function buildGeminiWordStream(cues: Cue[]): GeminiWord[] {
	const out: GeminiWord[] = [];
	for (let cueIdx = 0; cueIdx < cues.length; cueIdx++) {
		const cue = cues[cueIdx];
		if (!cue) continue;
		let wordIdxInCue = 0;
		for (const word of normalize(cue.text).split(" ")) {
			const wordStem = stem(word);
			if (wordStem) {
				out.push({ cueIdx, wordIdxInCue, stem: wordStem });
			}
			wordIdxInCue++;
		}
	}
	return out;
}

function buildScribeWordStream(words: ScribeWord[]): TimedStem[] {
	const out: TimedStem[] = [];
	for (const word of words) {
		const wordStem = stem(normalize(word.word));
		if (!wordStem) continue;
		out.push({ time: word.start, stem: wordStem });
	}
	return out;
}

function normalize(value: string): string {
	return value
		.toLowerCase()
		.replace(/[ʼ'`‘’]/g, "'")
		.replace(/[^\p{L}\p{N}'\s]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function stem(word: string): string | null {
	return word.length >= 3 ? word.slice(0, 5) : null;
}

function buildSkeletonAnchors(G: GeminiWord[], W: TimedStem[]): Anchor[] {
	const anchorMap = new Map<number, number>();
	for (const n of [3, 2]) {
		const gGrams = grams(G, n);
		const wGrams = grams(W, n);
		for (const [key, gPositions] of gGrams) {
			const wPositions = wGrams.get(key);
			if (
				gPositions.length === 1 &&
				wPositions?.length === 1 &&
				!anchorMap.has(gPositions[0] as number)
			) {
				anchorMap.set(gPositions[0] as number, wPositions[0] as number);
			}
		}
	}
	return [...anchorMap.entries()]
		.map(([g, w]) => ({ g, w }))
		.sort((a, b) => a.g - b.g);
}

function grams<T extends { stem: string }>(
	arr: T[],
	n: number,
): Map<string, number[]> {
	const out = new Map<string, number[]>();
	for (let i = 0; i + n - 1 < arr.length; i++) {
		const key = arr
			.slice(i, i + n)
			.map((item) => item.stem)
			.join("|");
		const positions = out.get(key);
		if (positions) positions.push(i);
		else out.set(key, [i]);
	}
	return out;
}

function monotonicAnchors(anchors: Anchor[]): Anchor[] {
	const tails: number[] = [];
	const prev = new Array<number>(anchors.length).fill(-1);

	for (let i = 0; i < anchors.length; i++) {
		const anchor = anchors[i];
		if (!anchor) continue;
		let lo = 0;
		let hi = tails.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			const tailAnchor = anchors[tails[mid] as number];
			if (tailAnchor && tailAnchor.w < anchor.w) lo = mid + 1;
			else hi = mid;
		}
		if (lo > 0) prev[i] = tails[lo - 1] as number;
		if (lo === tails.length) tails.push(i);
		else tails[lo] = i;
	}

	const result: Anchor[] = [];
	let k = tails.length > 0 ? (tails[tails.length - 1] as number) : -1;
	while (k >= 0) {
		const anchor = anchors[k];
		if (anchor) result.push(anchor);
		k = prev[k] ?? -1;
	}
	return result.reverse();
}

function buildDenseMatches(
	G: GeminiWord[],
	W: TimedStem[],
	skeleton: Anchor[],
): Match[] {
	const matches: Match[] = [];
	let prev = { g: 0, w: 0 };

	for (const anchor of skeleton) {
		lcsAlign(G, W, prev.g, anchor.g, prev.w, anchor.w, matches);
		matches.push({ gIdx: anchor.g, time: W[anchor.w]?.time ?? 0 });
		prev = { g: anchor.g + 1, w: anchor.w + 1 };
	}

	lcsAlign(G, W, prev.g, G.length, prev.w, W.length, matches);
	matches.sort((a, b) => a.gIdx - b.gIdx);
	return matches;
}

function lcsAlign(
	G: GeminiWord[],
	W: TimedStem[],
	g0: number,
	g1: number,
	w0: number,
	w1: number,
	matches: Match[],
): void {
	const n = g1 - g0;
	const m = w1 - w0;
	if (n <= 0 || m <= 0 || n * m > LCS_CELL_CAP) return;

	const width = m + 1;
	const dp = new Uint16Array((n + 1) * width);
	for (let i = 1; i <= n; i++) {
		for (let j = 1; j <= m; j++) {
			const idx = i * width + j;
			if (G[g0 + i - 1]?.stem === W[w0 + j - 1]?.stem) {
				dp[idx] = (dp[(i - 1) * width + j - 1] ?? 0) + 1;
			} else {
				dp[idx] = Math.max(
					dp[(i - 1) * width + j] ?? 0,
					dp[i * width + j - 1] ?? 0,
				);
			}
		}
	}

	let i = n;
	let j = m;
	const segment: Match[] = [];
	while (i > 0 && j > 0) {
		const idx = i * width + j;
		if (
			G[g0 + i - 1]?.stem === W[w0 + j - 1]?.stem &&
			dp[idx] === (dp[(i - 1) * width + j - 1] ?? 0) + 1
		) {
			segment.push({
				gIdx: g0 + i - 1,
				time: W[w0 + j - 1]?.time ?? 0,
			});
			i--;
			j--;
		} else if ((dp[(i - 1) * width + j] ?? 0) >= (dp[i * width + j - 1] ?? 0)) {
			i--;
		} else {
			j--;
		}
	}

	for (let k = segment.length - 1; k >= 0; k--) {
		const match = segment[k];
		if (match) matches.push(match);
	}
}

function filterOutliers(
	matches: Match[],
	skeleton: Anchor[],
	W: TimedStem[],
): Match[] {
	const skeletonG = skeleton.map((anchor) => anchor.g);
	const skeletonTimes = skeleton.map((anchor) => W[anchor.w]?.time ?? 0);
	return matches.filter((match) => {
		const expected = skeletonTimeAt(match.gIdx, skeletonG, skeletonTimes);
		return (
			expected == null || Math.abs(match.time - expected) <= OUTLIER_MAX_SEC
		);
	});
}

function skeletonTimeAt(
	gIdx: number,
	skeletonG: number[],
	skeletonTimes: number[],
): number | null {
	if (skeletonG.length === 0) return null;
	const firstG = skeletonG[0] as number;
	const firstTime = skeletonTimes[0] as number;
	if (gIdx <= firstG) return firstTime;

	const lastIndex = skeletonG.length - 1;
	const lastG = skeletonG[lastIndex] as number;
	const lastTime = skeletonTimes[lastIndex] as number;
	if (gIdx >= lastG) return lastTime;

	let lo = 0;
	let hi = lastIndex;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if ((skeletonG[mid] as number) <= gIdx) lo = mid;
		else hi = mid;
	}
	const gLo = skeletonG[lo] as number;
	const gHi = skeletonG[hi] as number;
	const f = (gIdx - gLo) / (gHi - gLo);
	return (
		(skeletonTimes[lo] as number) +
		f * ((skeletonTimes[hi] as number) - (skeletonTimes[lo] as number))
	);
}

function buildCueStarts(
	cues: Cue[],
	G: GeminiWord[],
	matches: Match[],
	total: number,
): number[] {
	const timeByGIdx = new Map(matches.map((match) => [match.gIdx, match.time]));
	const gIdxsSorted = matches.map((match) => match.gIdx);
	const cueWords = new Map<number, number[]>();

	for (let i = 0; i < G.length; i++) {
		const word = G[i];
		if (!word) continue;
		const existing = cueWords.get(word.cueIdx);
		if (existing) existing.push(i);
		else cueWords.set(word.cueIdx, [i]);
	}

	const newStarts = cues.map((cue, cueIdx) => {
		const wordIdxs = cueWords.get(cueIdx);
		if (!wordIdxs || wordIdxs.length === 0) return cue.start;

		for (const gIdx of wordIdxs) {
			const time = timeByGIdx.get(gIdx);
			if (time != null) {
				const wordOffset = G[gIdx]?.wordIdxInCue ?? 0;
				return Math.max(0, time - wordOffset * AVG_WORD_SEC);
			}
		}

		return interpAt(wordIdxs[0] as number, gIdxsSorted, matches);
	});

	for (let i = 0; i < newStarts.length; i++) {
		const previous = i > 0 ? (newStarts[i - 1] as number) : 0;
		if (i > 0 && (newStarts[i] as number) < previous) {
			newStarts[i] = previous;
		}
		if ((newStarts[i] as number) > total - 0.2) {
			newStarts[i] = Math.max(0, total - 0.2);
		}
	}

	return newStarts;
}

function interpAt(
	gIdx: number,
	gIdxsSorted: number[],
	matches: Match[],
): number {
	if (matches.length === 0) return 0;
	const lastIndex = gIdxsSorted.length - 1;
	if (gIdx <= (gIdxsSorted[0] as number)) return matches[0]?.time ?? 0;
	if (gIdx >= (gIdxsSorted[lastIndex] as number)) {
		return matches[lastIndex]?.time ?? 0;
	}

	let lo = 0;
	let hi = lastIndex;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if ((gIdxsSorted[mid] as number) <= gIdx) lo = mid;
		else hi = mid;
	}
	const f =
		(gIdx - (gIdxsSorted[lo] as number)) /
		((gIdxsSorted[hi] as number) - (gIdxsSorted[lo] as number));
	return (
		(matches[lo]?.time ?? 0) +
		f * ((matches[hi]?.time ?? 0) - (matches[lo]?.time ?? 0))
	);
}

function buildWarpedCueTimes(
	cues: Cue[],
	newStarts: number[],
	total: number,
): Array<{ start: number; end: number }> {
	return cues.map((_cue, i) => {
		const start = newStarts[i] ?? 0;
		const nextStart = newStarts[i + 1];
		const rawEnd =
			nextStart != null
				? Math.max(start + 0.3, Math.min(nextStart, start + 15))
				: Math.min(total, start + 3);
		const end = Math.max(start, Math.min(total, rawEnd));
		return { start, end };
	});
}

function totalBound(cues: Cue[], words: ScribeWord[]): number {
	const cueMax = cues.reduce((max, cue) => Math.max(max, cue.end), 0);
	const wordMax = words.reduce(
		(max, word) => Math.max(max, word.end, word.start),
		0,
	);
	return Math.max(cueMax, wordMax, 0.3);
}
