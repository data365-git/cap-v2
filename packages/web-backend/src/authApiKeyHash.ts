import { serverEnv } from "@cap/env";

let hmacKeyCache: CryptoKey | null = null;

async function getHmacKey(): Promise<CryptoKey> {
	if (hmacKeyCache) return hmacKeyCache;
	const secret = serverEnv().NEXTAUTH_SECRET;
	const encoder = new TextEncoder();
	hmacKeyCache = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return hmacKeyCache;
}

/**
 * Mint a new API key token. Only the HMAC of this value is ever persisted — the
 * plaintext is returned to the caller exactly once and is unrecoverable after.
 * The `cak_` prefix is what every auth path uses to tell a hashed key from the
 * legacy 36-char plaintext UUIDs minted before hashing existed.
 */
export function createAuthApiKeyToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return `cak_${Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("")}`;
}

export async function hashAuthApiKey(token: string): Promise<string> {
	const hmacKey = await getHmacKey();
	const encoder = new TextEncoder();
	const signature = await crypto.subtle.sign(
		"HMAC",
		hmacKey,
		encoder.encode(token),
	);
	return Array.from(new Uint8Array(signature))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}
