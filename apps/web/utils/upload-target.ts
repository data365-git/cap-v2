import type { Storage } from "@cap/web-domain";

type UploadTarget =
	| Storage.UploadTarget
	| {
			url: string;
			fields: Record<string, string>;
	  };

type UploadProgress = {
	loaded: number;
	total: number;
};

const isPostTarget = (
	target: UploadTarget,
): target is { url: string; fields: Record<string, string> } =>
	!("type" in target) || target.type === "s3Post";

const isDriveResumableTarget = (
	target: UploadTarget,
): target is Extract<Storage.UploadTarget, { type: "driveResumable" }> =>
	"type" in target && target.type === "driveResumable";

const MAX_RETRIES = 3;

const isRetryable = (status: number) => status === 0 || status >= 500;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// TODO: multipart resume for files >100MB — single PUT restarts from byte 0 on retry

export async function uploadWithTarget({
	target,
	body,
	fileName,
	contentType,
	onProgress,
	onRetry,
	signal,
}: {
	target: UploadTarget;
	body: Blob;
	fileName?: string;
	contentType?: string;
	onProgress?: (progress: UploadProgress) => void;
	onRetry?: (attempt: number) => void;
	signal?: AbortSignal;
}) {
	const attemptUpload = (attempt: number): Promise<void> =>
		new Promise<void>((resolve, reject) => {
			if (signal?.aborted) {
				reject(new DOMException("aborted", "AbortError"));
				return;
			}

			const xhr = new XMLHttpRequest();

			signal?.addEventListener("abort", () => xhr.abort(), { once: true });

			if (isPostTarget(target)) {
				const formData = new FormData();
				Object.entries(target.fields).forEach(([key, value]) => {
					formData.append(key, value);
				});
				formData.append("file", body, fileName);
				xhr.open("POST", target.url);
				xhr.upload.onprogress = (event) => {
					if (event.lengthComputable) {
						onProgress?.({ loaded: event.loaded, total: event.total });
					}
				};
				xhr.onload = () => {
					if (xhr.status >= 200 && xhr.status < 300) {
						resolve();
					} else {
						reject(
							Object.assign(new Error(`Upload failed with status ${xhr.status}`), {
								status: xhr.status,
							}),
						);
					}
				};
				xhr.onerror = () =>
					reject(Object.assign(new Error("Upload failed"), { status: 0 }));
				xhr.onabort = () => reject(new DOMException("aborted", "AbortError"));
				xhr.send(formData);
				return;
			}

			xhr.open("PUT", target.url);
			const headersFromTarget: Record<string, string> = Object.fromEntries(
				Object.entries(target.headers),
			);
			// Ensure Content-Type matches the presigned key. target.headers already
			// includes it, but the caller-supplied contentType acts as a guarantee.
			const resolvedContentType =
				contentType ?? headersFromTarget["Content-Type"] ?? headersFromTarget["content-type"];
			const mergedHeaders = resolvedContentType
				? { ...headersFromTarget, "Content-Type": resolvedContentType }
				: headersFromTarget;
			Object.entries(mergedHeaders).forEach(([key, value]) => {
				xhr.setRequestHeader(key, value);
			});
			if (isDriveResumableTarget(target) && body.size > 0) {
				xhr.setRequestHeader(
					"Content-Range",
					`bytes 0-${body.size - 1}/${body.size}`,
				);
			}
			xhr.upload.onprogress = (event) => {
				if (event.lengthComputable) {
					onProgress?.({ loaded: event.loaded, total: event.total });
				}
			};
			xhr.onload = () => {
				console.info('[CAP-UPLOAD-PUT]', `status=${xhr.status} contentType=${resolvedContentType ?? '(none)'}`);
				if (xhr.status >= 200 && xhr.status < 300) {
					resolve();
				} else {
					reject(
						Object.assign(new Error(`Upload failed with status ${xhr.status}`), {
							status: xhr.status,
						}),
					);
				}
			};
			xhr.onerror = () =>
				reject(Object.assign(new Error("Upload failed"), { status: 0 }));
			xhr.onabort = () => reject(new DOMException("aborted", "AbortError"));
			xhr.send(body);
		});

	for (let i = 0; i < MAX_RETRIES; i++) {
		try {
			await attemptUpload(i);
			return;
		} catch (error) {
			if (error instanceof DOMException && error.name === "AbortError") {
				throw error;
			}
			const status = (error as { status?: number }).status ?? -1;
			if (!isRetryable(status)) {
				throw error;
			}
			if (i === MAX_RETRIES - 1) {
				throw error;
			}
			const delayMs = i === 0 ? 0 : 1000 * 4 ** (i - 1);
			console.warn(
				`[CAP-IMPORT] Upload attempt ${i + 1} failed, retrying in ${delayMs}ms:`,
				error,
			);
			onRetry?.(i + 1);
			if (delayMs > 0) {
				await delay(delayMs);
			}
		}
	}
}
