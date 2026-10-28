/**
 * The hand-rolled HTTP path for endpoints the SDK does not expose.
 *
 * CONTRACT §2 rule 7: a call that bypasses the SDK is still the wrapper — same
 * `API-Version: 2` header, same envelope-by-shape unwrap, same translated error
 * type — so a caller cannot tell which methods went through the SDK. This used
 * to live inside GraphResource, where BYOG was the only such surface. The
 * connected-subgraph read (PRO-1848) is the second, and a second copy of the
 * retry/abort/translate logic is exactly what the rule exists to prevent, so
 * it moved here and both resources call it.
 *
 * `fetchFn` is injectable for tests only; production never sets it.
 */

import { createHash } from "node:crypto";

import { SERVER_VERSION } from "../version.js";
import { unwrap } from "./envelope.js";
import { HydraWrapperError, responseError, translateError } from "./errors.js";
import { type RetrySafety, withRetries } from "./retry.js";

/** The SDK's own default, restated so this file does not depend on importing it. */
export const DEFAULT_BASE_URL = "https://api.hydradb.com";

export const SOURCE_HEADERS = { "X-HydraDB-Source": "mcp" } as const;

export interface CallerIdentity {
	token: string;
	oauthUserId?: string;
}

// HydraDB keys are <prefix>_<env>_<id>.<secret>, and only that public id may leave the process.
const HYDRADB_API_KEY_FORMAT = /^([A-Za-z0-9]+_[A-Za-z0-9]+_[A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+$/;

export function apiKeyId(token: string): string {
	const id = HYDRADB_API_KEY_FORMAT.exec(token)?.[1];

	if (id) return id;

	// Anything else (legacy or foreign tokens) is identified by a hash, never by a fragment of it.
	return `sha256-${createHash("sha256").update(token).digest("hex").slice(0, 16)}`;
}

export function mcpUser({ token, oauthUserId }: CallerIdentity): string {
	if (oauthUserId) return `mcp:oauth:${oauthUserId}`;

	return `mcp:apikey:${apiKeyId(token)}`;
}

export function mcpHeaders(identity: CallerIdentity) {
	return {
		...SOURCE_HEADERS,
		"X-HydraDB-MCP-User": mcpUser(identity),
		"X-HydraDB-MCP-Version": SERVER_VERSION,
	};
}

export interface RawTransport {
	token: string;
	baseUrl: string;
	/** Whole-call deadline: every attempt and every wait between them. */
	timeoutMs: number;
	maxRetries: number;
	headers?: Record<string, string>;
	fetchFn?: typeof fetch;
}

export interface RawRequestOptions {
	signal?: AbortSignal;
	/**
	 * Whether the request may be sent twice. Defaults to `idempotent` for GET
	 * and `unsafe` for everything else; see ./retry for what each allows.
	 */
	safety?: RetrySafety;
}

export function newRawTransport(config: {
	token: string;
	oauthUserId?: string;
	baseUrl?: string;
	timeoutSeconds?: number;
	maxRetries?: number;
	fetchFn?: typeof fetch;
}, defaults: { timeoutSeconds: number; maxRetries: number }): RawTransport {
	return {
		token: config.token,
		// Trailing slashes would produce `//byog/query`, which some proxies treat
		// as a different path.
		baseUrl: (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
		timeoutMs: (config.timeoutSeconds ?? defaults.timeoutSeconds) * 1000,
		maxRetries: config.maxRetries ?? defaults.maxRetries,
		headers: mcpHeaders(config),
		...(config.fetchFn ? { fetchFn: config.fetchFn } : {}),
	};
}

/** Send under the shared retry policy (./retry): one deadline, safe retries only. */
export function sendRaw<T>(
	t: RawTransport,
	path: string,
	method: "GET" | "POST" | "DELETE",
	body: unknown,
	opts?: RawRequestOptions,
): Promise<T> {
	return withRetries<T>({
		path,
		safety: opts?.safety ?? (method === "GET" ? "idempotent" : "unsafe"),
		budget: { deadlineMs: t.timeoutMs, maxRetries: t.maxRetries },
		signal: opts?.signal,
		known: [t.token],
		attempt: (signal) => attemptRaw<T>(t, path, method, body, signal),
	});
}

async function attemptRaw<T>(
	t: RawTransport,
	path: string,
	method: "GET" | "POST" | "DELETE",
	body: unknown,
	signal: AbortSignal,
): Promise<T> {
	const doFetch = t.fetchFn ?? fetch;

	try {
		const response = await doFetch(`${t.baseUrl}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${t.token}`,
				"Content-Type": "application/json",
				// CONTRACT §2 rule 6. The SDK sends this on every call; a
				// hand-rolled path that omitted it would silently get v1
				// behaviour from the same endpoints.
				"API-Version": "2",
				...(t.headers ?? SOURCE_HEADERS),
			},
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
			signal,
		});

		const text = await response.text();
		let parsed: unknown;
		try {
			parsed = text === "" ? null : JSON.parse(text);
		} catch {
			parsed = text;
		}

		if (!response.ok) {
			// Hand the parsed envelope to the shared formatter so a raw-path
			// failure reads exactly like an SDK one, error code and request id
			// and all. The headers ride along for `Retry-After`.
			throw responseError(path, response.status, parsed, [t.token], response.headers);
		}

		return unwrap<T>(parsed);
	} catch (err) {
		if (err instanceof HydraWrapperError) throw err;

		// Cancellation and the deadline are reported by the retry loop, which
		// knows which of the two it was.
		throw translateError(path, err, [t.token]);
	}
}
