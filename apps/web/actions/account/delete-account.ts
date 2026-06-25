"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	accounts,
	authApiKeys,
	comments,
	messengerMessages,
	notifications,
	organizationMembers,
	organizations,
	sessions,
	users,
	videos,
} from "@cap/database/schema";
import { eq } from "drizzle-orm";

export async function deleteAccount(): Promise<
	{ ok: true } | { ok: false; error: string }
> {
	const user = await getCurrentUser();
	if (!user) return { ok: false, error: "Not authenticated" };

	const ownedOrgs = await db()
		.select({ id: organizations.id, name: organizations.name })
		.from(organizations)
		.where(eq(organizations.ownerId, user.id));

	if (ownedOrgs.length > 0) {
		return {
			ok: false,
			error: `You own ${ownedOrgs.length} organization(s). Transfer ownership or delete them before deleting your account.`,
		};
	}

	await db().transaction(async (tx) => {
		// User-authored content. comments.authorId has no FK cascade, so
		// orphaned authorIds would point at a deleted user — wipe them first.
		await tx.delete(comments).where(eq(comments.authorId, user.id));
		// Anonymise messenger messages instead of cascade-deleting whole
		// conversations (others may have participated). userId is nullable.
		await tx
			.update(messengerMessages)
			.set({ userId: null })
			.where(eq(messengerMessages.userId, user.id));
		await tx
			.delete(notifications)
			.where(eq(notifications.recipientId, user.id));
		await tx.delete(authApiKeys).where(eq(authApiKeys.userId, user.id));
		// Videos owned by this user. The schema cascades comments/sharedVideos
		// off videos.id, so deleting the videos row also clears child rows.
		await tx.delete(videos).where(eq(videos.ownerId, user.id));

		await tx
			.delete(organizationMembers)
			.where(eq(organizationMembers.userId, user.id));
		await tx.delete(sessions).where(eq(sessions.userId, user.id));
		await tx.delete(accounts).where(eq(accounts.userId, user.id));
		await tx.delete(users).where(eq(users.id, user.id));
	});

	return { ok: true };
}
