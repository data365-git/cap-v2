import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { authApiKeys } from "@cap/database/schema";
import { createAuthApiKeyToken, hashAuthApiKey } from "@cap/web-backend";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

export async function POST() {
	const user = await getCurrentUser();
	if (!user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	// Only the HMAC of the token is stored, so an existing key can never be
	// re-shown. Minting always issues a fresh token and replaces any prior one.
	const token = createAuthApiKeyToken();
	const id = await hashAuthApiKey(token);

	await db().transaction(async (tx) => {
		await tx.delete(authApiKeys).where(eq(authApiKeys.userId, user.id));
		await tx.insert(authApiKeys).values({ id, userId: user.id });
	});

	return NextResponse.json({ token, email: user.email });
}
