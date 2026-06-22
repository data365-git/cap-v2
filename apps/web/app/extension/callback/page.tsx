import { getCurrentUser } from "@cap/database/auth/session";
import { db } from "@cap/database";
import { authApiKeys } from "@cap/database/schema";
import { desc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { CallbackClient } from "./CallbackClient";

export const dynamic = "force-dynamic";

export default async function ExtensionCallbackPage(props: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const searchParams = await props.searchParams;

	const extensionId =
		typeof searchParams.extensionId === "string"
			? searchParams.extensionId
			: undefined;

	// Auth check server-side — avoids client-side 401 → redirect loop that
	// drops the `next` param and lands the user on /dashboard.
	const user = await getCurrentUser();
	if (!user) {
		const callbackPath = `/extension/callback${extensionId ? `?extensionId=${encodeURIComponent(extensionId)}` : ""}`;
		redirect(`/login?next=${encodeURIComponent(callbackPath)}`);
	}

	// Mint the API key server-side so CallbackClient always receives a token
	// and never needs to call /api/extension/mint-key from the browser.
	const existing = await db()
		.select({ id: authApiKeys.id })
		.from(authApiKeys)
		.where(eq(authApiKeys.userId, user.id))
		.orderBy(desc(authApiKeys.createdAt))
		.limit(1);

	const token =
		existing.length > 0
			? existing[0].id
			: await (async () => {
					const id = crypto.randomUUID();
					await db().insert(authApiKeys).values({ id, userId: user.id });
					return id;
				})();

	return (
		<div className="flex justify-center items-center min-h-screen bg-gray-2">
			<CallbackClient
				extensionId={extensionId}
				email={user.email ?? ""}
				token={token}
			/>
		</div>
	);
}
