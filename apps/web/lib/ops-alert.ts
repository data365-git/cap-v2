/**
 * Sends a Telegram alert for operational events (D7b). Never throws — a
 * failure to alert must not break the caller's actual work (cron sweep, etc).
 */
export async function sendOpsAlert(text: string): Promise<void> {
	const token = process.env.TELEGRAM_BOT_TOKEN;
	const chatId = process.env.TELEGRAM_ALERT_CHAT_ID;

	if (!token || !chatId) {
		console.warn("[ops-alert]", text);
		return;
	}

	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 10_000);
		try {
			await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ chat_id: chatId, text }),
				signal: controller.signal,
			});
		} finally {
			clearTimeout(timeout);
		}
	} catch (error) {
		console.error("[ops-alert] Failed to send Telegram alert:", error);
	}
}
