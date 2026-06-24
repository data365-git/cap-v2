"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { sendEmail } from "@cap/database/emails/config";
import { ShareLink } from "@cap/database/emails/share-link";
import { videos } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function sendShareLinkByEmail({
	videoId,
	recipientEmail,
	message,
}: {
	videoId: Video.VideoId;
	recipientEmail: string;
	message?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
	const user = await getCurrentUser();

	if (!user) {
		return { ok: false, error: "Unauthorized" };
	}

	const normalizedEmail = recipientEmail.trim().toLowerCase();
	if (!EMAIL_REGEX.test(normalizedEmail)) {
		return { ok: false, error: "Invalid email address" };
	}

	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId));

	if (!video || video.ownerId !== user.id) {
		return { ok: false, error: "Forbidden" };
	}

	const shareUrl = `${serverEnv().WEB_URL}/s/${videoId}`;
	const senderName = user.name || user.email || "Someone";

	await sendEmail({
		email: normalizedEmail,
		subject: `${senderName} shared a recording with you`,
		react: ShareLink({
			senderName,
			recipientEmail: normalizedEmail,
			shareUrl,
			videoName: video.name || "Untitled recording",
			message: message?.trim(),
		}),
	});

	return { ok: true };
}
