const KEEPALIVE_ALARM = "cap-keepalive";
const KEEPALIVE_INTERVAL_MINUTES = 1;

export function startKeepAlive(): void {
	chrome.alarms.create(KEEPALIVE_ALARM, {
		periodInMinutes: KEEPALIVE_INTERVAL_MINUTES,
	});
}

export function stopKeepAlive(): void {
	chrome.alarms.clear(KEEPALIVE_ALARM);
}

export function isKeepAliveAlarm(alarmName: string): boolean {
	return alarmName === KEEPALIVE_ALARM;
}
