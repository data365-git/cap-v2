import { and, gt, isNull, or, eq } from "drizzle-orm";
import { db } from "../index.ts";
import { invites, organizationInvites, users } from "../schema.ts";

export type AllowedEmailResult =
	| { allowed: false }
	| { allowed: true; existingUser: true }
	| {
			allowed: true;
			existingUser: false;
			source: "orgInvite";
			invite: typeof organizationInvites.$inferSelect;
	  }
	| {
			allowed: true;
			existingUser: false;
			source: "genericInvite";
			invite: typeof invites.$inferSelect;
	  };

export async function checkAllowedEmail(
	email: string,
): Promise<AllowedEmailResult> {
	const normalized = email.trim().toLowerCase();
	const now = new Date();

	// (a) existing user
	const [user] = await db()
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, normalized))
		.limit(1);
	if (user) return { allowed: true, existingUser: true };

	// (b) org invite — pending, not consumed, not expired
	const [orgInvite] = await db()
		.select()
		.from(organizationInvites)
		.where(
			and(
				eq(organizationInvites.invitedEmail, normalized),
				eq(organizationInvites.status, "pending"),
				isNull(organizationInvites.consumedAt),
				or(
					isNull(organizationInvites.expiresAt),
					gt(organizationInvites.expiresAt, now),
				),
			),
		)
		.limit(1);
	if (orgInvite)
		return { allowed: true, existingUser: false, source: "orgInvite", invite: orgInvite };

	// (c) generic invite — email-targeted only (null-email rows are excluded by eq)
	const [genericInvite] = await db()
		.select()
		.from(invites)
		.where(
			and(
				eq(invites.email, normalized),
				isNull(invites.usedByUserId),
				gt(invites.expiresAt, now),
			),
		)
		.limit(1);
	if (genericInvite)
		return { allowed: true, existingUser: false, source: "genericInvite", invite: genericInvite };

	return { allowed: false };
}
