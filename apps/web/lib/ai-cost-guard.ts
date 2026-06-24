import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import { type AiOperation, aiUsageEvents } from "@cap/database/schema";
import { priceForMicros } from "@cap/utils";
import type { Organisation, User, Video } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";

export class BudgetExceededError extends Error {
	constructor(
		public scope: "user" | "org",
		public currentMicros: number,
		public capMicros: number,
	) {
		super(
			`AI budget exceeded for ${scope}: ${currentMicros} / ${capMicros} microdollars`,
		);
		this.name = "BudgetExceededError";
	}
}

function currentBillingMonth(): string {
	const now = new Date();
	const year = now.getUTCFullYear();
	const month = String(now.getUTCMonth() + 1).padStart(2, "0");
	return `${year}-${month}`;
}

async function getMonthlySpendMicros(
	column: "orgId" | "userId",
	id: string,
	billingMonth: string,
): Promise<number> {
	const col = column === "orgId" ? aiUsageEvents.orgId : aiUsageEvents.userId;

	const [result] = await db()
		.select({
			total: sql<number>`COALESCE(SUM(${aiUsageEvents.costUsdMicros}), 0)`,
		})
		.from(aiUsageEvents)
		.where(and(eq(col, id), eq(aiUsageEvents.billingMonth, billingMonth)));

	return Number(result?.total ?? 0);
}

interface CostGuardOptions<T> {
	orgId: string;
	userId: string;
	videoId?: string;
	operation: AiOperation;
	model: string;
	budgetCapUserMicros?: number | null;
	budgetCapOrgMicros?: number | null;
	/**
	 * Attempt / regeneration number for this operation. Persisted on the usage
	 * event so failed attempts are countable. Null when the caller has no notion
	 * of attempts.
	 */
	attempt?: number | null;
	/**
	 * Inspect the (successful) result and decide whether the outcome should be
	 * recorded as "failed" — e.g. a transcription that RETURNS truncated. When
	 * omitted, a returned result is recorded as "success".
	 */
	determineStatus?: (
		result: T & { inputTokens: number; outputTokens: number },
	) => "success" | "failed";
	fn: () => Promise<T & { inputTokens: number; outputTokens: number }>;
}

/**
 * Best-effort extraction of partial token usage from a thrown error. Some Gemini
 * errors carry usage metadata even when the call ultimately fails; capturing it
 * means a failed attempt is still billed/recorded rather than silently lost.
 */
function tokensFromError(error: unknown): {
	inputTokens: number;
	outputTokens: number;
} {
	const e = error as {
		inputTokens?: number;
		outputTokens?: number;
		usageMetadata?: {
			promptTokenCount?: number;
			candidatesTokenCount?: number;
		};
	} | null;
	const inputTokens =
		Number(e?.inputTokens ?? e?.usageMetadata?.promptTokenCount ?? 0) || 0;
	const outputTokens =
		Number(e?.outputTokens ?? e?.usageMetadata?.candidatesTokenCount ?? 0) || 0;
	return { inputTokens, outputTokens };
}

export async function withCostGuard<T>(
	options: CostGuardOptions<T>,
): Promise<T & { inputTokens: number; outputTokens: number }> {
	const billingMonth = currentBillingMonth();

	if (options.budgetCapUserMicros != null && options.budgetCapUserMicros > 0) {
		const userSpend = await getMonthlySpendMicros(
			"userId",
			options.userId,
			billingMonth,
		);
		if (userSpend >= options.budgetCapUserMicros) {
			throw new BudgetExceededError(
				"user",
				userSpend,
				options.budgetCapUserMicros,
			);
		}
	}

	if (options.budgetCapOrgMicros != null && options.budgetCapOrgMicros > 0) {
		const orgSpend = await getMonthlySpendMicros(
			"orgId",
			options.orgId,
			billingMonth,
		);
		if (orgSpend >= options.budgetCapOrgMicros) {
			throw new BudgetExceededError(
				"org",
				orgSpend,
				options.budgetCapOrgMicros,
			);
		}
	}

	// Run the wrapped call. Every token-consuming outcome — success, a returned
	// result the caller deems failed (truncation), or a throw — gets recorded and
	// tagged so failed attempts are never lost.
	let result: (T & { inputTokens: number; outputTokens: number }) | undefined;
	let inputTokens = 0;
	let outputTokens = 0;
	let status: "success" | "failed" = "success";
	let thrown: unknown;

	try {
		result = await options.fn();
		inputTokens = result.inputTokens;
		outputTokens = result.outputTokens;
		status =
			options.determineStatus != null
				? options.determineStatus(result)
				: "success";
	} catch (error) {
		thrown = error;
		status = "failed";
		const partial = tokensFromError(error);
		inputTokens = partial.inputTokens;
		outputTokens = partial.outputTokens;
	}

	const costUsdMicros = priceForMicros(options.model, inputTokens, outputTokens);

	await db()
		.insert(aiUsageEvents)
		.values({
			id: nanoId(),
			orgId: options.orgId as Organisation.OrganisationId,
			userId: options.userId as User.UserId,
			videoId: (options.videoId as Video.VideoId) ?? null,
			operation: options.operation,
			model: options.model,
			inputTokens,
			outputTokens,
			costUsdMicros,
			billingMonth,
			status,
			attempt: options.attempt ?? null,
		});

	if (thrown !== undefined) {
		throw thrown;
	}

	// Check budget thresholds and create alerts
	if (options.budgetCapUserMicros != null && options.budgetCapUserMicros > 0) {
		const prevSpend = await getMonthlySpendMicros(
			"userId",
			options.userId,
			billingMonth,
		);
		const newSpend = prevSpend + costUsdMicros;

		const prevPct = (prevSpend / options.budgetCapUserMicros) * 100;
		const newPct = (newSpend / options.budgetCapUserMicros) * 100;

		// 100% threshold crossed
		if (prevPct < 100 && newPct >= 100) {
			const amountFormatted = (newSpend / 1_000_000).toFixed(2);
			const budgetFormatted = (options.budgetCapUserMicros / 1_000_000).toFixed(
				2,
			);
			console.log(
				`[BUDGET_ALERT] User ${options.userId}: AI budget exceeded — new AI operations blocked until next month or budget raise ($${amountFormatted} of $${budgetFormatted})`,
			);
		}
		// 80% threshold crossed
		else if (prevPct < 80 && newPct >= 80) {
			const amountFormatted = (newSpend / 1_000_000).toFixed(2);
			const budgetFormatted = (options.budgetCapUserMicros / 1_000_000).toFixed(
				2,
			);
			console.log(
				`[BUDGET_ALERT] User ${options.userId}: AI spend at 80% of monthly budget ($${amountFormatted} of $${budgetFormatted})`,
			);
		}
	}

	if (options.budgetCapOrgMicros != null && options.budgetCapOrgMicros > 0) {
		const prevSpend = await getMonthlySpendMicros(
			"orgId",
			options.orgId,
			billingMonth,
		);
		const newSpend = prevSpend + costUsdMicros;

		const prevPct = (prevSpend / options.budgetCapOrgMicros) * 100;
		const newPct = (newSpend / options.budgetCapOrgMicros) * 100;

		// 100% threshold crossed
		if (prevPct < 100 && newPct >= 100) {
			const amountFormatted = (newSpend / 1_000_000).toFixed(2);
			const budgetFormatted = (options.budgetCapOrgMicros / 1_000_000).toFixed(
				2,
			);
			console.log(
				`[BUDGET_ALERT] Org ${options.orgId}: AI budget exceeded — new AI operations blocked until next month or budget raise ($${amountFormatted} of $${budgetFormatted})`,
			);
		}
		// 80% threshold crossed
		else if (prevPct < 80 && newPct >= 80) {
			const amountFormatted = (newSpend / 1_000_000).toFixed(2);
			const budgetFormatted = (options.budgetCapOrgMicros / 1_000_000).toFixed(
				2,
			);
			console.log(
				`[BUDGET_ALERT] Org ${options.orgId}: AI spend at 80% of monthly budget ($${amountFormatted} of $${budgetFormatted})`,
			);
		}
	}

	// `result` is defined here: the only path that leaves it undefined is a throw,
	// which already rethrew above.
	return result as T & { inputTokens: number; outputTokens: number };
}
