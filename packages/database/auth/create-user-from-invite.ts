import { and, eq } from "drizzle-orm";
import { db } from "../index.ts";
import {
	invites,
	organizationInvites,
	organizationMembers,
	organizations,
	users,
} from "../schema.ts";
import { nanoId } from "../helpers.ts";
import { User } from "@cap/web-domain";
import { Organisation } from "@cap/web-domain";

export interface InviteUser {
	id: User.UserId;
	email: string;
	name: string | null;
	image: null;
}

// Infer the drizzle transaction type so callers can pass tx for atomicity.
type DrizzleTx = Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];

/**
 * Idempotent: creates the user if missing, ensures org membership, marks invite consumed.
 * Pass `tx` (from db().transaction()) to make all writes atomic.
 */
export async function createUserFromOrgInvite(
	email: string,
	invite: typeof organizationInvites.$inferSelect,
	tx?: DrizzleTx,
): Promise<InviteUser> {
	const d = tx ?? db();

	let [existing] = await d
		.select({ id: users.id, email: users.email, name: users.name, image: users.image })
		.from(users)
		.where(eq(users.email, email))
		.limit(1);

	if (!existing) {
		const newId = nanoId() as User.UserId;
		await d.insert(users).values({
			id: newId,
			email,
			name: email.split("@")[0],
			emailVerified: new Date(),
			activeOrganizationId: invite.organizationId,
			defaultOrgId: invite.organizationId,
			inviteQuota: 1,
		});
		existing = { id: newId, email, name: email.split("@")[0], image: null };
	}

	const [alreadyMember] = await d
		.select({ id: organizationMembers.id })
		.from(organizationMembers)
		.where(
			and(
				eq(organizationMembers.userId, existing.id),
				eq(organizationMembers.organizationId, invite.organizationId),
			),
		)
		.limit(1);

	if (!alreadyMember) {
		await d.insert(organizationMembers).values({
			id: nanoId(),
			userId: existing.id,
			organizationId: invite.organizationId,
			role: invite.role,
		});
	}

	if (!invite.consumedAt) {
		await d
			.update(organizationInvites)
			.set({ consumedAt: new Date(), status: "accepted" })
			.where(eq(organizationInvites.id, invite.id));
	}

	return { id: existing.id, email: existing.email, name: existing.name, image: null };
}

/**
 * Creates a user from a generic (admin-panel) invite.
 * Generic invites have no org to join — user gets their own personal org.
 */
export async function createUserFromGenericInvite(
	email: string,
	invite: typeof invites.$inferSelect,
): Promise<InviteUser> {
	// Find or create user
	let [existing] = await db()
		.select({ id: users.id, email: users.email, name: users.name, image: users.image })
		.from(users)
		.where(eq(users.email, email))
		.limit(1);

	if (!existing) {
		const newId = nanoId() as User.UserId;
		const orgId = Organisation.OrganisationId.make(nanoId());

		await db().insert(organizations).values({
			id: orgId,
			ownerId: newId,
			name: `${email.split("@")[0]}'s Organization`,
		});

		await db().insert(users).values({
			id: newId,
			email,
			name: email.split("@")[0],
			emailVerified: new Date(),
			activeOrganizationId: orgId,
			defaultOrgId: orgId,
			inviteQuota: 1,
		});

		await db().insert(organizationMembers).values({
			id: nanoId(),
			userId: newId,
			organizationId: orgId,
			role: "owner",
		});

		existing = { id: newId, email, name: email.split("@")[0], image: null };
	}

	// Mark invite used
	if (!invite.usedByUserId) {
		await db()
			.update(invites)
			.set({ usedByUserId: existing.id })
			.where(eq(invites.id, invite.id));
	}

	return { id: existing.id, email: existing.email, name: existing.name, image: null };
}
