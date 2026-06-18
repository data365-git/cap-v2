export interface CompletedPartInput {
	ETag: string;
	PartNumber: number;
}

export interface CreateVideoResponse {
	id: string;
	user_id: string;
}

export interface InitiateMultipartResponse {
	uploadId: string;
	provider: string;
}

export interface PresignPartResponse {
	presignedUrl: string;
	provider: string;
}

export interface CompleteMultipartResponse {
	location: string | undefined;
	success: boolean;
	fileKey: string;
}

export interface CapApi {
	createVideo(params: {
		recordingMode: string;
		name?: string;
		extensionContext?: string;
		meetingId?: string;
	}): Promise<CreateVideoResponse>;
	initiateMultipart(params: {
		contentType: string;
		videoId: string;
		subpath?: string;
	}): Promise<InitiateMultipartResponse>;
	presignPart(params: {
		uploadId: string;
		partNumber: number;
		videoId: string;
		subpath?: string;
	}): Promise<PresignPartResponse>;
	completeMultipart(params: {
		uploadId: string;
		parts: Array<{ partNumber: number; etag: string; size: number }>;
		videoId: string;
		subpath?: string;
	}): Promise<CompleteMultipartResponse>;
	recordingComplete(params: { videoId: string }): Promise<void>;
}

async function handleResponse<T>(res: Response, label: string): Promise<T> {
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`[api] ${label} failed ${res.status}: ${body}`);
	}
	return res.json() as Promise<T>;
}

export function createCapApi(baseUrl: string, apiKey: string): CapApi {
	const authHeader = { Authorization: `Bearer ${apiKey}` };

	return {
		async createVideo({ recordingMode, name, extensionContext, meetingId }) {
			const url = new URL(`${baseUrl}/api/desktop/video/create`);
			url.searchParams.set("recordingMode", recordingMode);
			if (name) url.searchParams.set("name", name);
			if (extensionContext)
				url.searchParams.set("extensionContext", extensionContext);
			if (meetingId) url.searchParams.set("meetingId", meetingId);

			const res = await fetch(url.toString(), {
				headers: authHeader,
			});
			return handleResponse<CreateVideoResponse>(res, "createVideo");
		},

		async initiateMultipart({ contentType, videoId, subpath }) {
			const body: Record<string, string> = { contentType, videoId };
			if (subpath) body.subpath = subpath;

			const res = await fetch(`${baseUrl}/api/upload/multipart/initiate`, {
				method: "POST",
				headers: { ...authHeader, "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			return handleResponse<InitiateMultipartResponse>(
				res,
				"initiateMultipart",
			);
		},

		async presignPart({ uploadId, partNumber, videoId, subpath }) {
			const body: Record<string, string | number> = {
				uploadId,
				partNumber,
				videoId,
			};
			if (subpath) body.subpath = subpath;

			const res = await fetch(`${baseUrl}/api/upload/multipart/presign-part`, {
				method: "POST",
				headers: { ...authHeader, "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			return handleResponse<PresignPartResponse>(res, "presignPart");
		},

		async completeMultipart({ uploadId, parts, videoId, subpath }) {
			const body: Record<string, unknown> = { uploadId, parts, videoId };
			if (subpath) body.subpath = subpath;

			const res = await fetch(`${baseUrl}/api/upload/multipart/complete`, {
				method: "POST",
				headers: { ...authHeader, "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			return handleResponse<CompleteMultipartResponse>(
				res,
				"completeMultipart",
			);
		},

		async recordingComplete({ videoId }) {
			const res = await fetch(`${baseUrl}/api/upload/recording-complete/`, {
				method: "POST",
				headers: { ...authHeader, "Content-Type": "application/json" },
				body: JSON.stringify({ videoId }),
			});
			if (res.status === 400 || res.status === 409) {
				return;
			}
			await handleResponse<unknown>(res, "recordingComplete");
		},
	};
}
