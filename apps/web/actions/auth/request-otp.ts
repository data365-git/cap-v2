"use server";

import crypto from "node:crypto";
import { db } from "@cap/database";
import { verificationTokens } from "@cap/database/schema";
import { checkAllowedEmail } from "@cap/database/auth/allowed-check";
import {
	createUserFromGenericInvite,
	createUserFromOrgInvite,
} from "@cap/database/auth/create-user-from-invite";
import { and, eq, gt, sql } from "drizzle-orm";

export type RequestOtpResult = { allowed: false } | { allowed: true };

export async function requestOtp(email: string): Promise<RequestOtpResult> {
	const normalized = email.trim().toLowerCase();

	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
		throw new Error("Invalid email address");
	}

	// Gate: only proceed if the email is invited or already a user
	const check = await checkAllowedEmail(normalized);
	if (!check.allowed) {
		return { allowed: false };
	}

	// Auto-create account for invited emails that have no user row yet
	if (!check.existingUser) {
		if (check.source === "orgInvite") {
			await createUserFromOrgInvite(normalized, check.invite);
		} else {
			await createUserFromGenericInvite(normalized, check.invite);
		}
	}

	// Rate-limit: one code per 30 seconds per email
	const recent = await db()
		.select({ identifier: verificationTokens.identifier })
		.from(verificationTokens)
		.where(
			and(
				eq(verificationTokens.identifier, normalized),
				gt(verificationTokens.created_at, sql`NOW() - INTERVAL 30 SECOND`),
			),
		)
		.limit(1);

	if (recent.length > 0) {
		throw new Error("Please wait before requesting a new code.");
	}

	const code = Math.floor(100000 + Math.random() * 900000).toString();
	const hashedCode = crypto.createHash("sha256").update(code).digest("hex");

	await db()
		.delete(verificationTokens)
		.where(eq(verificationTokens.identifier, normalized));

	await db()
		.insert(verificationTokens)
		.values({
			identifier: normalized,
			token: hashedCode,
			expires: new Date(Date.now() + 10 * 60 * 1000),
		});

	// Code is delivered out-of-band (email). Never returned to the caller.
	return { allowed: true };
}
