import { describe, expect, it, vi } from "vitest";

vi.mock("@cap/env", () => ({
	serverEnv: () => ({ NEXTAUTH_SECRET: "test-secret-for-hmac" }),
}));
vi.mock("server-only", () => ({}));

import {
	createAuthApiKeyToken,
	hashAuthApiKey,
} from "../../../../packages/web-backend/src/authApiKeyHash";

/**
 * API keys are stored as an HMAC, never in plaintext. Two things had gone wrong:
 *
 *  1. The desktop login path still did `id = crypto.randomUUID()` and handed that
 *     same value back as the bearer token — so every desktop key sat in
 *     `authApiKeys` in plaintext.
 *  2. The verifiers (`api/utils.ts`, `extension/me`, `desktop/root`) only accepted
 *     `length === 36`, so the 68-char `cak_` keys the app itself mints were
 *     rejected outright. We minted keys we then refused to honour.
 *
 * The shape of a minted token and the fact that it never equals its stored form
 * are the load-bearing invariants; both are pinned here.
 */
describe("auth API key hashing", () => {
	it("mints a cak_-prefixed token that the verifiers will recognise", () => {
		const token = createAuthApiKeyToken();
		expect(token.startsWith("cak_")).toBe(true);
		// 'cak_' + 32 random bytes as hex
		expect(token).toMatch(/^cak_[0-9a-f]{64}$/);
	});

	it("does NOT mint a 36-char UUID — that was the plaintext format", () => {
		const token = createAuthApiKeyToken();
		expect(token.length).not.toBe(36);
	});

	it("mints a distinct token every time", () => {
		const a = createAuthApiKeyToken();
		const b = createAuthApiKeyToken();
		expect(a).not.toBe(b);
	});

	it("stores a hash that is never the token itself", async () => {
		const token = createAuthApiKeyToken();
		const stored = await hashAuthApiKey(token);
		expect(stored).not.toBe(token);
		expect(stored).not.toContain(token);
		expect(stored).not.toContain("cak_");
		// HMAC-SHA256 as hex
		expect(stored).toMatch(/^[0-9a-f]{64}$/);
	});

	it("is deterministic, so a presented token resolves to its stored row", async () => {
		const token = createAuthApiKeyToken();
		expect(await hashAuthApiKey(token)).toBe(await hashAuthApiKey(token));
	});

	it("maps different tokens to different hashes", async () => {
		const a = await hashAuthApiKey(createAuthApiKeyToken());
		const b = await hashAuthApiKey(createAuthApiKeyToken());
		expect(a).not.toBe(b);
	});
});
