// Media server removed — this webhook endpoint is kept as a no-op for any stale callbacks
import { type NextRequest, NextResponse } from "next/server";

export async function POST(_request: NextRequest) {
	// Media server has been removed. Return 200 to acknowledge any stale webhook callbacks
	// so they don't trigger retries.
	return NextResponse.json({
		success: true,
		message: "Media server webhook endpoint deprecated — no processing performed",
	});
}
