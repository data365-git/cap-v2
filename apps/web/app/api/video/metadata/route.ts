import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { patchVideoMetadata } from "@/lib/video-metadata";

const USER_EDITABLE_METADATA_FIELDS = [
	"customCreatedAt",
	"sourceName",
	"titleManuallyEdited",
] as const;

function pickUserEditableMetadata(metadata: unknown) {
	if (
		typeof metadata !== "object" ||
		metadata === null ||
		Array.isArray(metadata)
	) {
		return null;
	}

	const source = metadata as Record<string, unknown>;
	return Object.fromEntries(
		USER_EDITABLE_METADATA_FIELDS.flatMap((field) =>
			Object.hasOwn(source, field) ? [[field, source[field]]] : [],
		),
	);
}

export async function PUT(request: NextRequest) {
	const user = await getCurrentUser();
	const { videoId, metadata } = await request.json();
	const userId = user?.id as string;

	const editableMetadata = pickUserEditableMetadata(metadata);

	if (!user || !videoId || !editableMetadata) {
		console.error("Missing required data in /api/video/metadata/route.ts");

		return Response.json({ error: true }, { status: 401 });
	}

	const query = await db().select().from(videos).where(eq(videos.id, videoId));

	if (query.length === 0) {
		return Response.json({ error: true }, { status: 401 });
	}

	const result = query[0];
	if (!result) {
		return Response.json({ error: true }, { status: 401 });
	}

	if (result.ownerId !== userId) {
		return Response.json({ error: true }, { status: 401 });
	}

	// Atomic row-locked read-modify-write so a user's metadata edit can't clobber
	// a concurrent pipeline write (and vice versa).
	await patchVideoMetadata(
		videoId,
		(current) => ({ ...current, ...editableMetadata }) as VideoMetadata,
	);

	return Response.json(true, { status: 200 });
}
