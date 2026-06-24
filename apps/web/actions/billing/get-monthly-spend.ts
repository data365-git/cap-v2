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

const ZERO_RESULT = {
	totalUsdCents: 0,
	breakdown: {} as Record<string, number>,
	capUsdCents: null as number | null,
	percentUsed: 0,
};

export async function getMonthlySpend(scope: {
	type: "user" | "org" | "video";
	id: string;
}): Promise<{
	totalUsdCents: number;
	breakdown: Record<string, number>;
	capUsdCents: number | null;
	percentUsed: number;
}> {
	const user = await getCurrentUser();
	if (!user) return { ...ZERO_RESULT, breakdown: {} };

	// Authorization per scope type.
	if (scope.type === "user") {
		if (scope.id !== user.id) return { ...ZERO_RESULT, breakdown: {} };
	} else if (scope.type === "org") {
		const access = await getOrganizationAccess(
			user.id,
			Organisation.OrganisationId.make(scope.id),
		);
		if (!access) return { ...ZERO_RESULT, breakdown: {} };
	} else {
		// type === "video"
		const [video] = await db()
			.select({ ownerId: videos.ownerId, orgId: videos.orgId })
			.from(videos)
			.where(eq(videos.id, Video.VideoId.make(scope.id)))
			.limit(1);

		if (!video) return { ...ZERO_RESULT, breakdown: {} };

		if (video.ownerId !== user.id) {
			const access = video.orgId
				? await getOrganizationAccess(user.id, video.orgId)
				: null;
			if (!access) return { ...ZERO_RESULT, breakdown: {} };
		}
	}

	const billingMonth = currentBillingMonth();

	const colMap = {
		user: aiUsageEvents.userId,
		org: aiUsageEvents.orgId,
		video: aiUsageEvents.videoId,
	} as const;

	const col = colMap[scope.type];

	const rows = await db()
		.select({
			operation: aiUsageEvents.operation,
			totalMicros: sql<number>`COALESCE(SUM(${aiUsageEvents.costUsdMicros}), 0)`,
		})
		.from(aiUsageEvents)
		.where(
			and(
				sql`${col} = ${scope.id}`,
				eq(aiUsageEvents.billingMonth, billingMonth),
			),
		)
		.groupBy(aiUsageEvents.operation);

	let totalMicros = 0;
	const breakdown: Record<string, number> = {};

	for (const row of rows) {
		const micros = Number(row.totalMicros);
		const cents = Math.round(micros / 10_000);
		breakdown[row.operation] = cents;
		totalMicros += micros;
	}

	const totalUsdCents = Math.round(totalMicros / 10_000);

	const capUsdCents: number | null = null;

	const percentUsed =
		capUsdCents != null && capUsdCents > 0
			? Math.round((totalUsdCents / capUsdCents) * 100)
			: 0;

	return { totalUsdCents, breakdown, capUsdCents, percentUsed };
}
