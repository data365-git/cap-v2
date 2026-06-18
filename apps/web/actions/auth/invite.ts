"use server";

import bcrypt from "bcryptjs";
import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import {
	invites,
	users,
	organizations,
	organizationMembers,
} from "@cap/database/schema";
import { Organisation, User } from "@cap/web-domain";
import { eq } from "drizzle-orm";

export async function validateInviteToken(
	token: string,
): Promise<
	| { valid: true; email: string | null }
	| { valid: false; error: string }
> {
	const [invite] = await db()
		.select({
			id: invites.id,
			email: invites.email,
			usedByUserId: invites.usedByUserId,
			expiresAt: invites.expiresAt,
		})
		.from(invites)
		.where(eq(invites.token, token))
		.limit(1);

	if (!invite) {
		return { valid: false, error: "This invite link is invalid." };
	}

	if (invite.usedByUserId) {
		return { valid: false, error: "This invite link has already been used." };
	}

	if (invite.expiresAt < new Date()) {
		return { valid: false, error: "This invite link has expired." };
	}

	return { valid: true, email: invite.email };
}

export async function redeemInvite(
	token: string,
	name: string,
	email: string,
	password: string,
): Promise<{ success: true } | { success: false; error: string }> {
	// Re-validate the token
	const [invite] = await db()
		.select()
		.from(invites)
		.where(eq(invites.token, token))
		.limit(1);

	if (!invite) {
		return { success: false, error: "This invite link is invalid." };
	}

	if (invite.usedByUserId) {
		return { success: false, error: "This invite link has already been used." };
	}

	if (invite.expiresAt < new Date()) {
		return { success: false, error: "This invite link has expired." };
	}

	// If invite has a pre-set email, verify the submitted email matches
	if (invite.email && invite.email.toLowerCase() !== email.toLowerCase()) {
		return {
			success: false,
			error: "Email does not match the invite.",
		};
	}

	const normalizedEmail = email.trim().toLowerCase();

	// Check if user already exists
	const [existingUser] = await db()
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, normalizedEmail))
		.limit(1);

	if (existingUser) {
		return {
			success: false,
			error: "An account with this email already exists. Please sign in instead.",
		};
	}

	// Hash the password
	const passwordHash = await bcrypt.hash(password, 10);

	const userId = nanoId() as User.UserId;
	const organizationId = Organisation.OrganisationId.make(nanoId());

	// Create the default personal organization first
	await db().insert(organizations).values({
		id: organizationId,
		ownerId: userId,
		name: `${name}'s Organization`,
	});

	// Create the user with the org reference
	await db().insert(users).values({
		id: userId,
		email: normalizedEmail,
		name,
		passwordHash,
		emailVerified: new Date(),
		activeOrganizationId: organizationId,
		defaultOrgId: organizationId,
		inviteQuota: 1,
	});

	// Add user as owner of the organization
	await db().insert(organizationMembers).values({
		id: nanoId(),
		userId,
		organizationId,
		role: "owner",
	});

	// Mark the invite as used
	await db()
		.update(invites)
		.set({ usedByUserId: userId })
		.where(eq(invites.id, invite.id));

	return { success: true };
}
