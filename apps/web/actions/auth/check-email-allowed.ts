"use server";

import { isEmailAllowed } from "@cap/database/auth/allowed-check";

export async function checkEmailAllowed(
	email: string,
): Promise<{ allowed: boolean }> {
	const normalized = email.trim().toLowerCase();
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
		return { allowed: false };
	}
	const result = await isEmailAllowed(normalized);
	return { allowed: result.allowed };
}
