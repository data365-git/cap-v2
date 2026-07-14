/// <reference path="../types/next-auth.d.ts" />
// The Session.user augmentation (adds `id`/`isAdmin`) lives in a standalone .d.ts.
// Consumer programs (e.g. `next build`, which type-checks this file under
// apps/web's tsconfig) don't include that file via their own `include` globs, so
// reference it explicitly here — otherwise `session.user.id` fails to resolve.
import { User } from "@cap/web-domain";
import { eq, type InferSelectModel } from "drizzle-orm";
import { getServerSession } from "next-auth";
import { cache } from "react";
import { db } from "../";
import { users } from "../schema";
import { authOptions } from "./auth-options";

export const getSession = async () => {
	const session = await getServerSession(authOptions());

	return session;
};

export const getCurrentUser = cache(
	async (): Promise<InferSelectModel<typeof users> | null> => {
		const session = await getServerSession(authOptions());

		if (!session) return null;

		const [currentUser] = await db()
			.select()
			.from(users)
			.where(eq(users.id, User.UserId.make(session.user.id)));

		return currentUser ?? null;
	},
);

export const userSelectProps = users.$inferSelect;
