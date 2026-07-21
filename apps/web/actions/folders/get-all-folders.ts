"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { folders } from "@cap/database/schema";
import { and, eq, isNull } from "drizzle-orm";

export async function getAllUserFolders() {
	const user = await getCurrentUser();
	if (!user || !user.activeOrganizationId)
		throw new Error("Unauthorized or no active organization");

	return db()
		.select({
			id: folders.id,
			name: folders.name,
			color: folders.color,
			parentId: folders.parentId,
			context: folders.context,
		})
		.from(folders)
		.where(
			and(
				eq(folders.organizationId, user.activeOrganizationId),
				eq(folders.createdById, user.id),
				isNull(folders.spaceId),
			),
		);
}
