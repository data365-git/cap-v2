export function generateM3U8Playlist(
	urls: {
		url: string;
		duration: string;
		resolution?: string;
		bandwidth?: string;
	}[],
) {
	console.warn("[DEPRECATED] HLS playlist generation removed (P6.3 single-file storage model)");
	return "";
}

export function generateMasterPlaylist(
	resolution: string,
	bandwidth: string,
	videoPlaylistUrl: string,
	audioPlaylistUrl: string | null,
	xStreamInfo?: string,
) {
	console.warn("[DEPRECATED] HLS playlist generation removed (P6.3 single-file storage model)");
	return "";
}
