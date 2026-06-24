"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { aiUsageEvents, videos } from "@cap/database/schema";
import { Organisation, Video } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { getOrganizationAccess } from "@/actions/organization/authorization";

function currentBillingMonth(): string {
	const now = new Date();
	const year = now.getUTCFullYear();
	const month = String(now.getUTCMonth() + 1).padStart(2, "0");
	return `${year}-${month}`;
}

export interface OperationSpend {
	/** Total cents (success + failed) */
	totalUsdCents: number;
	successUsdCents: number;
	failedUsdCents: number;
	successCount: number;
	failedCount: number;
}

const ZERO_RESULT = {
	totalUsdCents: 0,
	breakdown: {} as Record<string, number>,
	breakdownDetail: {} as Record<string, OperationSpend>,
	totalSuccessUsdCents: 0,
	totalFailedUsdCents: 0,
	capUsdCents: null as number | null,
	percentUsed: 0,
};

export async function getMonthlySpend(scope: {
	type: "user" | "org" | "video";
	id: string;
}): Promise<{
	totalUsdCents: number;
	breakdown: Record<string, number>;
	breakdownDetail: Record<string, OperationSpend>;
	totalSuccessUsdCents: number;
	totalFailedUsdCents: number;
	capUsdCents: number | null;
	percentUsed: number;
}> {
	const user = await getCurrentUser();
	if (!user) return { ...ZERO_RESULT, breakdown: {}, breakdownDetail: {} };

	// Authorization per scope type.
	if (scope.type === "user") {
		if (scope.id !== user.id) return { ...ZERO_RESULT, breakdown: {}, breakdownDetail: {} };
	} else if (scope.type === "org") {
		const access = await getOrganizationAccess(
			user.id,
			Organisation.OrganisationId.make(scope.id),
		);
		if (!access) return { ...ZERO_RESULT, breakdown: {}, breakdownDetail: {} };
	} else {
		// type === "video"
		const [video] = await db()
			.select({ ownerId: videos.ownerId, orgId: videos.orgId })
			.from(videos)
			.where(eq(videos.id, Video.VideoId.make(scope.id)))
			.limit(1);

		if (!video) return { ...ZERO_RESULT, breakdown: {}, breakdownDetail: {} };

		if (video.ownerId !== user.id) {
			const access = video.orgId
				? await getOrganizationAccess(user.id, video.orgId)
				: null;
			if (!access) return { ...ZERO_RESULT, breakdown: {}, breakdownDetail: {} };
		}
	}

	const billingMonth = currentBillingMonth();

	const colMap = {
		user: aiUsageEvents.userId,
		org: aiUsageEvents.orgId,
		video: aiUsageEvents.videoId,
	} as const;

	const col = colMap[scope.type];

	// Fetch rows grouped by operation AND status to split success vs failed.
	const rows = await db()
		.select({
			operation: aiUsageEvents.operation,
			status: aiUsageEvents.status,
			totalMicros: sql<number>`COALESCE(SUM(${aiUsageEvents.costUsdMicros}), 0)`,
			eventCount: sql<number>`COUNT(*)`,
		})
		.from(aiUsageEvents)
		.where(
			and(
				sql`${col} = ${scope.id}`,
				eq(aiUsageEvents.billingMonth, billingMonth),
			),
		)
		.groupBy(aiUsageEvents.operation, aiUsageEvents.status);

	let totalMicros = 0;
	const breakdown: Record<string, number> = {};
	const breakdownDetail: Record<string, OperationSpend> = {};

	for (const row of rows) {
		const micros = Number(row.totalMicros);
		const count = Number(row.eventCount);
		const op = row.operation;
		const isFailed = row.status === "failed";

		if (!breakdownDetail[op]) {
			breakdownDetail[op] = {
				totalUsdCents: 0,
				successUsdCents: 0,
				failedUsdCents: 0,
				successCount: 0,
				failedCount: 0,
			};
		}

		const cents = Math.round(micros / 10_000);
		breakdownDetail[op].totalUsdCents += cents;
		totalMicros += micros;

		if (isFailed) {
			breakdownDetail[op].failedUsdCents += cents;
			breakdownDetail[op].failedCount += count;
		} else {
			// null (legacy) or "success" both count as successful
			breakdownDetail[op].successUsdCents += cents;
			breakdownDetail[op].successCount += count;
		}

		breakdown[op] = (breakdown[op] ?? 0) + cents;
	}

	const totalUsdCents = Math.round(totalMicros / 10_000);

	let totalSuccessUsdCents = 0;
	let totalFailedUsdCents = 0;
	for (const detail of Object.values(breakdownDetail)) {
		totalSuccessUsdCents += detail.successUsdCents;
		totalFailedUsdCents += detail.failedUsdCents;
	}

	const capUsdCents: number | null = null;

	const percentUsed =
		capUsdCents != null && capUsdCents > 0
			? Math.round((totalUsdCents / capUsdCents) * 100)
			: 0;

	return { totalUsdCents, breakdown, breakdownDetail, totalSuccessUsdCents, totalFailedUsdCents, capUsdCents, percentUsed };
}
