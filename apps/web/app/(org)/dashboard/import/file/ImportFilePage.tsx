"use client";

import { buildEnv } from "@cap/env";
import type { Folder, Organisation } from "@cap/web-domain";
import { faArrowLeft, faUpload } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useStore } from "@tanstack/react-store";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { createVideoForServerProcessing } from "@/actions/video/create-for-processing";
import { triggerVideoProcessing } from "@/actions/video/trigger-processing";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import { sendProgressUpdate } from "@/app/(org)/dashboard/caps/components/sendProgressUpdate";
import {
	type UploadStatus,
	useUploadingContext,
} from "@/app/(org)/dashboard/caps/UploadingContext";
import { PreUploadTrimmer } from "@/components/PreUploadTrimmer";
import { UpgradeModal } from "@/components/UpgradeModal";
import { uploadWithTarget } from "@/utils/upload-target";

export const ImportFilePage = ({
	folderId,
	context = "instruction",
}: {
	folderId?: string;
	context?: "meeting" | "instruction";
}) => {
	const { user, activeOrganization } = useDashboardContext();
	const router = useRouter();
	const inputRef = useRef<HTMLInputElement>(null);
	const { uploadingStore, setUploadStatus, setAbortController } = useUploadingContext();
	const isUploading = useStore(uploadingStore, (s) => !!s.uploadStatus);
	const [upgradeModalOpen, setUpgradeModalOpen] = useState(
		buildEnv.NEXT_PUBLIC_IS_CAP ? !user?.isPro : false,
	);
	const [uploadKind, setUploadKind] = useState<"video" | "audio">("video");
	const [isDragOver, setIsDragOver] = useState(false);
	const [pendingFile, setPendingFile] = useState<File | null>(null);
	const [uploadSpeedLabel, setUploadSpeedLabel] = useState<string | null>(null);

	const processFile = useCallback(
		async (file: File) => {
			if (!user || !activeOrganization) return;

			if (!user.isPro && buildEnv.NEXT_PUBLIC_IS_CAP) {
				setUpgradeModalOpen(true);
				return;
			}

			const ok = await uploadVideoForServerProcessing(
				file,
				folderId ? Folder.FolderId.make(folderId) : undefined,
				activeOrganization.organization.id,
				setUploadStatus,
				context,
				setUploadSpeedLabel,
				uploadKind === "audio",
				setAbortController,
			);
			if (ok)
				router.push(
					folderId ? `/dashboard/folder/${folderId}` : "/dashboard/caps",
				);
		},
		[user, activeOrganization, setUploadStatus, setAbortController, router, folderId, context, uploadKind],
	);

	const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (!file) return;
		if (uploadKind === "audio") {
			// Audio fast-path: skip trim modal, upload immediately
			void processFile(file);
		} else {
			// Video path: open trim modal first
			setPendingFile(file);
		}
		if (inputRef.current) inputRef.current.value = "";
	};

	const handleDrop = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault();
			setIsDragOver(false);
			const file = e.dataTransfer.files[0];
			if (!file) return;

			if (uploadKind === "audio") {
				const isAudioFile =
					file.type.startsWith("audio/") ||
					/\.(mp3|m4a|wav|ogg|opus|flac|aac)$/i.test(file.name);
				if (!isAudioFile) {
					toast.error("Please drop an audio file.");
					return;
				}
				// Audio fast-path: skip trim modal, upload immediately
				void processFile(file);
			} else {
				const isVideo =
					file.type.startsWith("video/") ||
					/\.(mov|mp4|avi|mkv|webm|m4v)$/i.test(file.name);
				if (!isVideo) {
					toast.error("Please drop a video file.");
					return;
				}
				// Video path: open trim modal first
				setPendingFile(file);
			}
		},
		[processFile, uploadKind],
	);

	const handleBrowseClick = () => {
		if (!user) return;

		if (!user.isPro && buildEnv.NEXT_PUBLIC_IS_CAP) {
			setUpgradeModalOpen(true);
			return;
		}

		inputRef.current?.click();
	};

	const uploadStatus = useStore(uploadingStore, (s) => s.uploadStatus);
	const progressPercent =
		uploadStatus && "progress" in uploadStatus
			? Math.round(uploadStatus.progress)
			: null;
	const statusLabel = uploadStatus
		? uploadStatus.status === "parsing"
			? "Analyzing video..."
			: uploadStatus.status === "creating"
				? "Preparing upload..."
				: uploadStatus.status === "uploadingVideo"
					? `Uploading... ${progressPercent ?? 0}%`
					: uploadStatus.status === "serverProcessing"
						? "Processing on server..."
						: "Working..."
		: null;

	return (
		<div className="flex flex-col w-full h-full">
			<div className="mb-8">
				<Link
					href="/dashboard/import"
					className="inline-flex gap-2 items-center text-sm text-gray-10 hover:text-gray-12 transition-colors mb-4"
				>
					<FontAwesomeIcon className="size-3" icon={faArrowLeft} />
					Back to Import
				</Link>
				<h1 className="text-2xl font-medium text-gray-12">Upload File</h1>
				<p className="mt-1 text-sm text-gray-10">
					Upload a video file from your device.
				</p>
			</div>

			<div className="inline-flex items-center gap-1 p-1 rounded-lg bg-gray-3 mb-6 self-start">
				<button
					type="button"
					onClick={() => setUploadKind("video")}
					className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${
						uploadKind === "video"
							? "bg-gray-12 text-gray-1 shadow-sm"
							: "text-gray-10 hover:text-gray-12"
					}`}
				>
					Video
				</button>
				<button
					type="button"
					onClick={() => setUploadKind("audio")}
					className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${
						uploadKind === "audio"
							? "bg-gray-12 text-gray-1 shadow-sm"
							: "text-gray-10 hover:text-gray-12"
					}`}
				>
					Audio
				</button>
			</div>

			<button
				type="button"
				disabled={isUploading}
				onClick={handleBrowseClick}
				onDragOver={(e) => {
					e.preventDefault();
					if (!isUploading) setIsDragOver(true);
				}}
				onDragLeave={() => setIsDragOver(false)}
				onDrop={handleDrop}
				className={`relative flex flex-col items-center justify-center w-full max-w-2xl rounded-xl border-2 border-dashed transition-all duration-200 py-16 px-8 ${
					isUploading
						? "border-gray-4 bg-gray-2 cursor-not-allowed"
						: isDragOver
							? "border-blue-10 bg-blue-3"
							: "border-gray-4 bg-gray-1 hover:border-gray-6 hover:bg-gray-2"
				}`}
			>
				{isUploading ? (
					<span className="flex flex-col items-center gap-4">
						<span className="flex items-center justify-center size-16 rounded-full bg-gray-3">
							<span className="size-6 border-2 border-gray-8 border-t-blue-10 rounded-full animate-spin" />
						</span>
						<span className="flex flex-col items-center gap-1">
							<span className="text-sm font-medium text-gray-12">
								{uploadStatus?.status === "uploadingVideo" && uploadSpeedLabel
									? uploadSpeedLabel
									: statusLabel}
							</span>
							{progressPercent !== null && (
								<span className="w-48 h-1.5 rounded-full bg-gray-4 mt-2 overflow-hidden">
									<span
										className="h-full rounded-full bg-blue-10 transition-all duration-300"
										style={{ width: `${progressPercent}%` }}
									/>
								</span>
							)}
						</span>
					</span>
				) : (
					<span className="flex flex-col items-center gap-4">
						<span className="flex items-center justify-center size-16 rounded-full bg-gray-3 text-gray-10">
							<FontAwesomeIcon className="size-6" icon={faUpload} />
						</span>
						<span className="flex flex-col items-center gap-1">
							<span className="text-sm font-medium text-gray-12">
								{uploadKind === "audio"
									? "Drag and drop your audio here"
									: "Drag and drop your video here"}
							</span>
							<span className="text-xs text-gray-10">
								{uploadKind === "audio"
									? "Audio files: MP3, M4A, WAV, OGG, OPUS, FLAC, AAC"
									: "MP4, MOV, AVI, MKV, WebM up to any size"}
							</span>
						</span>
						<span className="inline-flex items-center justify-center mt-2 h-8 px-3 rounded-full bg-gray-12 text-sm font-medium text-gray-1">
							Browse Files
						</span>
					</span>
				)}
			</button>

			<input
				ref={inputRef}
				type="file"
				accept={
					uploadKind === "audio"
						? "audio/*,.mp3,.m4a,.wav,.ogg,.opus,.flac,.aac"
						: "video/*,.mov,.MOV,.mp4,.MP4,.avi,.AVI,.mkv,.MKV,.webm,.WEBM,.m4v,.M4V"
				}
				onChange={handleFileChange}
				className="hidden"
			/>

			<UpgradeModal
				open={upgradeModalOpen}
				onOpenChange={setUpgradeModalOpen}
			/>

			{pendingFile && (
				<PreUploadTrimmer
					file={pendingFile}
					onConfirm={(trimmed) => {
						setPendingFile(null);
						void processFile(trimmed);
					}}
					onCancel={() => setPendingFile(null)}
				/>
			)}
		</div>
	);
};

async function uploadVideoForServerProcessing(
	file: File,
	folderId: Folder.FolderId | undefined,
	orgId: Organisation.OrganisationId,
	setUploadStatus: (state: UploadStatus | undefined) => void,
	context: "meeting" | "instruction" = "instruction",
	setSpeedLabel: (label: string | null) => void = () => {},
	isAudio = false,
	setAbortController: (c: AbortController | null) => void = () => {},
) {
	try {
		setUploadStatus({ status: "parsing" });

		let duration: number | undefined;
		let resolution: string | undefined;

		try {
			const parser = await import("@remotion/media-parser");
			const metadata = await parser.parseMedia({
				src: file,
				fields: {
					durationInSeconds: true,
					dimensions: true,
				},
			});

			duration = metadata.durationInSeconds
				? Math.round(metadata.durationInSeconds)
				: undefined;
			resolution = metadata.dimensions
				? `${metadata.dimensions.width}x${metadata.dimensions.height}`
				: undefined;
		} catch (parseError) {
			console.warn(
				"Failed to parse video metadata, continuing without it:",
				parseError,
			);
		}

		setUploadStatus({ status: "creating" });
		const videoData = await createVideoForServerProcessing({
			duration,
			resolution,
			folderId,
			orgId,
			context,
			fileType: file.type,
			fileName: file.name,
			isAudio,
		});

		const uploadId = videoData.id;

		setUploadStatus({
			status: "uploadingVideo",
			capId: uploadId,
			progress: 0,
			thumbnailUrl: undefined,
		});

		const controller = new AbortController();
		setAbortController(controller);

		const createProgressTracker = () => {
			const uploadState = {
				videoId: uploadId,
				uploaded: 0,
				total: 0,
				pendingTask: undefined as ReturnType<typeof setTimeout> | undefined,
				lastUpdateTime: Date.now(),
			};

			const scheduleProgressUpdate = (uploaded: number, total: number) => {
				uploadState.uploaded = uploaded;
				uploadState.total = total;
				uploadState.lastUpdateTime = Date.now();

				if (uploadState.pendingTask) {
					clearTimeout(uploadState.pendingTask);
					uploadState.pendingTask = undefined;
				}

				const shouldSendImmediately = uploaded >= total;

				if (!shouldSendImmediately) {
					uploadState.pendingTask = setTimeout(() => {
						if (uploadState.videoId) {
							sendProgressUpdate(
								uploadState.videoId,
								uploadState.uploaded,
								uploadState.total,
							);
						}
						uploadState.pendingTask = undefined;
					}, 2000);
				}
			};

			const cleanup = () => {
				if (uploadState.pendingTask) {
					clearTimeout(uploadState.pendingTask);
					uploadState.pendingTask = undefined;
				}
			};

			const getTotal = () => uploadState.total;
			const didFinishSending = () =>
				uploadState.total > 0 && uploadState.uploaded >= uploadState.total;

			return { scheduleProgressUpdate, cleanup, getTotal, didFinishSending };
		};

		const progressTracker = createProgressTracker();

		const uploadStartTime = Date.now();
		const speedSamples: number[] = [];
		let lastProgressUpdate = 0;

		try {
			await uploadWithTarget({
				target: videoData.uploadTarget,
				body: file,
				fileName: file.name,
				contentType: videoData.contentType,
				signal: controller.signal,
				onProgress: ({ loaded, total }) => {
					const percent = (loaded / total) * 100;
					const now = Date.now();
					const elapsedMs = now - uploadStartTime;

					if (now - lastProgressUpdate >= 500 || loaded >= total) {
						lastProgressUpdate = now;

						if (elapsedMs > 0) {
							const instantSpeed = loaded / (elapsedMs / 1000);
							speedSamples.push(instantSpeed);
							if (speedSamples.length > 3) speedSamples.shift();
						}
						const avgSpeed =
							speedSamples.length > 0
								? speedSamples.reduce((a, b) => a + b, 0) / speedSamples.length
								: 0;

						const remaining = total - loaded;
						const etaSec = avgSpeed > 0 ? remaining / avgSpeed : null;

						const speedStr =
							avgSpeed > 1024 * 1024
								? `${(avgSpeed / (1024 * 1024)).toFixed(1)} MB/s`
								: avgSpeed > 1024
									? `${(avgSpeed / 1024).toFixed(1)} KB/s`
									: `${Math.round(avgSpeed)} B/s`;

						let etaStr = "";
						if (etaSec !== null && loaded < total) {
							if (etaSec < 10) etaStr = " · ~few sec left";
							else if (etaSec < 60) etaStr = ` · ~${Math.round(etaSec)}s left`;
							else if (etaSec < 3600) {
								const m = Math.floor(etaSec / 60);
								const s = Math.round(etaSec % 60);
								etaStr = ` · ~${m}m ${s}s left`;
							} else {
								etaStr = " · more than 1h";
							}
						}

						const label =
							avgSpeed > 0
								? `Uploading ${Math.round(percent)}% · ${speedStr}${etaStr}`
								: `Uploading ${Math.round(percent)}%`;

						console.log(`[CAP-IMPORT] ${label}`);
						setSpeedLabel(label);
					}

					setUploadStatus({
						status: "uploadingVideo",
						capId: uploadId,
						progress: percent,
						thumbnailUrl: undefined,
					});

					progressTracker.scheduleProgressUpdate(loaded, total);
				},
			});
		} catch (uploadError) {
			if (uploadError instanceof DOMException && uploadError.name === "AbortError") {
				progressTracker.cleanup();
				setAbortController(null);
				setUploadStatus(undefined);
				setSpeedLabel(null);
				return false;
			}
			if (!progressTracker.didFinishSending()) {
				progressTracker.cleanup();
				setAbortController(null);
				const reason = uploadError instanceof Error ? uploadError.message : "Network error";
				console.error(`[CAP-IMPORT] Upload failed — ${reason}`, uploadError);
				throw uploadError;
			}

			console.warn(
				"[CAP-IMPORT] Upload request failed after all bytes were sent; verifying object before processing:",
				uploadError,
			);
		}
		progressTracker.cleanup();
		setAbortController(null);
		const total = progressTracker.getTotal() || file.size || 1;
		await sendProgressUpdate(uploadId, total, total);

		setUploadStatus({
			status: "serverProcessing",
			capId: uploadId,
		});

		try {
			await triggerVideoProcessing({
				videoId: uploadId,
				rawFileKey: videoData.rawFileKey,
				bucketId: videoData.bucketId,
			});
		} catch (triggerError) {
			console.error("[CAP-IMPORT] Processing trigger failed:", triggerError);
			toast.error("Upload succeeded but processing failed to start. Please try again.");
			setUploadStatus(undefined);
			setSpeedLabel(null);
			return false;
		}

		setUploadStatus({ status: "processing", capId: uploadId, startedAt: Date.now() });
		setSpeedLabel(null);
		toast.success(
			"Video uploaded! Processing will continue in the background.",
		);
		return true;
	} catch (err) {
		if (err instanceof DOMException && err.name === "AbortError") {
			setAbortController(null);
			setUploadStatus(undefined);
			setSpeedLabel(null);
			return false;
		}
		const reason =
			err instanceof Error ? err.message : "Unknown error";
		console.error(`[CAP-IMPORT] Upload failed — ${reason}`, err);

		if (err instanceof Error && err.message === "upgrade_required") {
			toast.error(
				"Video duration exceeds the limit for free accounts. Please upgrade to Pro.",
			);
		} else {
			toast.error(`Upload failed: ${reason}`);
		}
	}

	setAbortController(null);
	setUploadStatus(undefined);
	setSpeedLabel(null);
	return false;
}
