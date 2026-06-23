// TEMPORARY debug route — token-gated. Reports the DB ownerId for a video and
// whether the configured R2 client can find result.mp4/webm at the DB-derived
// key. DELETE after diagnosis.
import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import {
	HeadObjectCommand,
	ListObjectsV2Command,
	S3Client,
} from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

const TOKEN = "diag-9f3a2c7b";

export async function GET(req: Request) {
	const url = new URL(req.url);
	if (url.searchParams.get("token") !== TOKEN) {
		return Response.json({ error: "forbidden" }, { status: 403 });
	}
	const videoId = url.searchParams.get("videoId") ?? "";
	if (!videoId) return Response.json({ error: "videoId required" }, { status: 400 });

	const [video] = await db()
		.select({ id: videos.id, ownerId: videos.ownerId, source: videos.source })
		.from(videos)
		.where(eq(videos.id, videoId));

	if (!video) return Response.json({ error: "video not found in DB" }, { status: 404 });

	const bucket = process.env.CAP_AWS_BUCKET as string;
	const client = new S3Client({
		endpoint: process.env.S3_INTERNAL_ENDPOINT || process.env.CAP_AWS_ENDPOINT,
		region: process.env.CAP_AWS_REGION,
		credentials: {
			accessKeyId: process.env.CAP_AWS_ACCESS_KEY as string,
			secretAccessKey: process.env.CAP_AWS_SECRET_KEY as string,
		},
		forcePathStyle: true,
	});

	const headKey = async (key: string) => {
		try {
			const h = await client.send(
				new HeadObjectCommand({ Bucket: bucket, Key: key }),
			);
			return { key, exists: true, size: h.ContentLength, contentType: h.ContentType };
		} catch (e: unknown) {
			return { key, exists: false, error: (e as Error).name };
		}
	};

	const prefix = `${video.ownerId}/${video.id}/`;
	let keysUnderOwnerPrefix: { key: string | undefined; size: number | undefined }[] = [];
	try {
		const list = await client.send(
			new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 50 }),
		);
		keysUnderOwnerPrefix = (list.Contents ?? []).map((o) => ({ key: o.Key, size: o.Size }));
	} catch (e: unknown) {
		keysUnderOwnerPrefix = [{ key: `LIST ERROR: ${(e as Error).name}`, size: undefined }];
	}

	return Response.json({
		dbVideoId: video.id,
		dbOwnerId: video.ownerId,
		dbSource: video.source,
		bucket,
		readKeyConstructed: `${prefix}result.mp4`,
		headResultMp4: await headKey(`${prefix}result.mp4`),
		headResultWebm: await headKey(`${prefix}result.webm`),
		keysUnderOwnerPrefix,
	});
}
