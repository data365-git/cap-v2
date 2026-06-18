import { cache } from "react";
import { v4 as uuidv4 } from "uuid";

export const generateId = cache(() => {
	const id = uuidv4();
	return id;
});

export interface BootstrapData {
	distinctID: string;
	featureFlags: Record<string, string | boolean>;
}

// PostHog removed — returns empty bootstrap so consumers don't break
export const getBootstrapData = cache(async (): Promise<BootstrapData> => {
	return {
		distinctID: "",
		featureFlags: {},
	};
});
