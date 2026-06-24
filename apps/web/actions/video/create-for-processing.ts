"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import { videos, videoUploads } from "@cap/database/schema";
import { buildEnv, NODE_ENV, serverEnv } from "@cap/env";
import { dub, userIsPro } from "@cap/utils";
import { Storage as StorageService } from "@cap/web-backend";
import {
	type Folder,
	type Organisation,
	type Storage,
	Video,
} from "@cap/web-domain";
import { Option } from "effect";
import { revalidatePath } from "next/cache";
import { requireOrganizationAccess } from "@/actions/organization/authorization";
import { runPromise } from "@/lib/server";

function mimeFromExt(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'mp4': return 'video/mp4';
    case 'mov': return 'video/quicktime';
    case 'webm': return 'video/webm';
    case 'mkv': return 'video/x-matroska';
    case 'avi': return 'video/x-msvideo';
    case 'm4v': return 'video/x-m4v';
    default: return 'video/mp4';
  }
}

function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
    'video/x-matroska': 'mkv',
    'video/x-msvideo': 'avi',
    'video/x-m4v': 'm4v',
  };
  return map[mime] ?? 'mp4';
}

export interface CreateForProcessingResult {
	id: Video.VideoId;
	rawFileKey: string;
	contentType: string;
	bucketId: string | null;
	storageIntegrationId: string | null;
	uploadTarget: Storage.UploadTarget;
	presignedPostData: {
		url: string;
		fields: Record<string, string>;
	} | null;
}

export async function createVideoForServerProcessing({
	duration,
	resolution,
	folderId,
	orgId,
	context = "instruction",
	fileType,
	fileName,
}: {
	duration?: number;
	resolution?: string;
	folderId?: Folder.FolderId;
	orgId: Organisation.OrganisationId;
	context?: "meeting" | "instruction";
	fileType?: string;
	fileName?: string;
}): Promise<CreateForProcessingResult> {
	const user = await getCurrentUser();

	if (!user) throw new Error("Unauthorized");

	if (!userIsPro(user) && duration && duration > 300) {
		throw new Error("upgrade_required");
	}

	await requireOrganizationAccess(user.id, orgId);

	const videoId = Video.VideoId.make(nanoId());

	const date = new Date();
	const formattedDate = `${date.getDate()} ${date.toLocaleString("default", {
		month: "long",
	})} ${date.getFullYear()}`;

	const contentType = (fileType && fileType !== 'application/octet-stream')
		? fileType
		: mimeFromExt(fileName ?? '');
	const rawFileKey = `${user.id}/${videoId}/raw-upload.${extFromMime(contentType)}`;

	const uploadResult = await StorageService.createUploadTargetForUser(
		user.id,
		rawFileKey,
		{
			contentType,
			method: "put",
			fields: {
				"x-amz-meta-userid": user.id,
				"x-amz-meta-duration": duration?.toString() ?? "",
				"x-amz-meta-resolution": resolution ?? "",
			},
		},
		orgId,
	).pipe(runPromise);

	console.info('[CAP-UPLOAD-PRESIGN]', `presigned video=${videoId} contentType=${contentType} key=${rawFileKey}`);

	await db()
		.insert(videos)
		.values({
			id: videoId,
			name: `Cap Upload - ${formattedDate}`,
			ownerId: user.id,
			orgId,
			source: { type: "webMP4" as const },
			bucket: Option.getOrNull(uploadResult.bucketId),
			storageIntegrationId: Option.getOrNull(uploadResult.storageIntegrationId),
			public: serverEnv().CAP_VIDEOS_DEFAULT_PUBLIC,
			context,
			...(folderId ? { folderId } : {}),
		});

	await db().insert(videoUploads).values({
		videoId,
		mode: "singlepart",
		phase: "uploading",
		processingProgress: 0,
		rawFileKey,
	});

	if (buildEnv.NEXT_PUBLIC_IS_CAP && NODE_ENV === "production") {
		await dub()
			.links.create({
				url: `${serverEnv().WEB_URL}/s/${videoId}`,
				domain: "cap.link",
				key: videoId,
			})
			.catch((err) => {
				console.error("Dub link create failed", err);
			});
	}

	revalidatePath("/dashboard/caps");
	revalidatePath("/dashboard/folder");
	revalidatePath("/dashboard/spaces");

	return {
		id: videoId,
		rawFileKey,
		contentType,
		bucketId: Option.getOrNull(uploadResult.bucketId),
		storageIntegrationId: Option.getOrNull(uploadResult.storageIntegrationId),
		uploadTarget: uploadResult.upload,
		presignedPostData:
			uploadResult.upload.type === "s3Post"
				? {
						url: uploadResult.upload.url,
						fields: uploadResult.upload.fields,
					}
				: null,
	};
}
