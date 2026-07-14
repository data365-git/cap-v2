import { db } from "@cap/database";
import { authApiKeys, users } from "@cap/database/schema";
import { hashAuthApiKey } from "@cap/web-backend";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
	const bearer = request.headers.get("authorization")?.split(" ")[1];

	// cak_ keys are stored as an HMAC, so look them up by hash. The 36-char branch
	// is the legacy plaintext-UUID format, kept so existing installs keep working.
	// Without the cak_ branch this route 401s every key the extension now mints.
	let lookupId: string | undefined;
	if (bearer?.startsWith("cak_")) {
		lookupId = await hashAuthApiKey(bearer);
	} else if (bearer?.length === 36) {
		lookupId = bearer;
	}

	if (!lookupId) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const res = await db()
		.select()
		.from(users)
		.leftJoin(authApiKeys, eq(users.id, authApiKeys.userId))
		.where(eq(authApiKeys.id, lookupId));

	const user = res[0]?.users;

	if (!user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	return NextResponse.json({ email: user.email });
}
