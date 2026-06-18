// Media server removed — all media-client functions are no longer available

/**
 * @deprecated Media server has been removed. Always returns false.
 */
export function isMediaServerConfigured(): boolean {
	return false;
}

/**
 * @deprecated Media server has been removed.
 */
export async function checkMediaServerHealth(): Promise<{
	status: string;
	ffmpeg: { available: boolean; version: string };
}> {
	throw new Error("Media server has been removed");
}

/**
 * @deprecated Media server has been removed.
 */
export async function checkHasAudioTrackViaMediaServer(
	_videoUrl: string,
): Promise<boolean> {
	throw new Error("Media server has been removed — use client-side audio detection");
}

/**
 * @deprecated Media server has been removed.
 */
export async function extractAudioViaMediaServer(
	_videoUrl: string,
): Promise<Buffer> {
	throw new Error("Media server has been removed — use client-side audio extraction");
}

export interface MediaServerProbeResult {
	duration: number;
	width: number;
	height: number;
	fps: number;
	videoCodec: string;
	audioCodec: string | null;
	audioChannels: number | null;
	sampleRate: number | null;
	bitrate: number;
	fileSize: number;
}

/**
 * @deprecated Media server has been removed.
 */
export async function probeVideoViaMediaServer(
	_videoUrl: string,
): Promise<MediaServerProbeResult> {
	throw new Error("Media server has been removed");
}

/**
 * @deprecated Media server has been removed.
 */
export async function convertAudioToMp3ViaMediaServer(
	_audioUrl: string,
): Promise<Buffer> {
	throw new Error("Media server has been removed");
}

/**
 * @deprecated Media server has been removed.
 */
export async function fetchConvertedVideoViaMediaServer(
	_videoUrl: string,
	_inputExtension?: string,
): Promise<Response> {
	throw new Error("Media server has been removed");
}
