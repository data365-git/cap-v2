import { trackMetaEvent } from "../Layout/MetaPixel";

export function initAnonymousUser() {
	// PostHog removed — no-op
}

export function identifyUser(_userId: string, _properties?: Record<string, any>) {
	// PostHog removed — no-op
}

export function trackEvent(
	eventName: string,
	properties?: Record<string, any>,
) {
	try {
		const metaEventMap: Record<string, string> = {
			purchase_completed: "Purchase",
			subscription_purchased: "Purchase",
			user_signed_up: "CompleteRegistration",
		};

		const metaEventName = metaEventMap[eventName];
		if (metaEventName) {
			const isSignup = eventName === "user_signed_up";
			const metaParameters = isSignup ? undefined : properties;
			trackMetaEvent(metaEventName, metaParameters, undefined);
		}
	} catch (error) {
		console.error(`Error tracking event ${eventName}:`, error);
	}
}
