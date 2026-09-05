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

import { unwrap } from "./envelope.js";
import { HydraWrapperError, responseError, translateError } from "./errors.js";

/** The SDK's own default, restated so this file does not depend on importing it. */
export const DEFAULT_BASE_URL = "https://api.hydradb.com";

export interface RawTransport {
	token: string;
	baseUrl: string;
	timeoutMs: number;
	maxRetries: number;
	fetchFn?: typeof fetch;
}

export interface RawRequestOptions {
	signal?: AbortSignal;
}

export function newRawTransport(config: {
	token: string;
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
		...(config.fetchFn ? { fetchFn: config.fetchFn } : {}),
	};
}

function isRetryable(status: number): boolean {
	return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Writes whose outcome cannot be inferred from a failure that carried NO HTTP
 * status — a timeout, a dropped socket mid-write. The server may well have
 * applied the request already, so re-sending it creates a second copy rather
 * than replacing the first: a unified ingest without a caller `context_id` has
 * nothing for an upsert to key on, and `POST /databases` has no upsert at all.
 *
 * A status-CARRYING failure on these paths still retries, because the status
 * says the server declined before doing work. A status-less one never does.
 * Reads keep the full budget — replaying one costs nothing but time.
 *
 * Matches openclaw-hydradb's REPLAY_UNSAFE_WRITES so the two clients answer a
 * dying write the same way.
 */
const REPLAY_UNSAFE_WRITES = new Set(["/context/ingest", "/databases"]);

function isReplayUnsafe(method: string, path: string): boolean {
	return method === "POST" && REPLAY_UNSAFE_WRITES.has(path);
}

/** Send with bounded retries on 429/5xx; the caller's abort ends retrying. */
export async function sendRaw<T>(
	t: RawTransport,
	path: string,
	method: "GET" | "POST" | "DELETE",
	body: unknown,
	opts?: RawRequestOptions,
): Promise<T> {
	let lastError: unknown;
	for (let attempt = 0; attempt <= t.maxRetries; attempt++) {
		try {
			return await attemptRaw<T>(t, path, method, body, opts);
		} catch (err) {
			lastError = err;
			const status = err instanceof HydraWrapperError ? err.status : undefined;
			// A caller who cancelled is not waiting for a retry.
			if (opts?.signal?.aborted) throw err;
			if (attempt === t.maxRetries) break;
			if (status != null && !isRetryable(status)) break;
			// No status means the request may already have been applied. Replaying
			// a write that cannot be keyed for dedup would duplicate it.
			if (status == null && isReplayUnsafe(method, path)) break;
			// Exponential backoff. Bounded so a 429 on the last attempt does not
			// hold the MCP host's tool timeout open for its own sake.
			const delay = Math.min(250 * 2 ** attempt, 2_000);
			await new Promise((resolve) => setTimeout(resolve, delay));
			// The caller may have cancelled DURING the backoff. An abort
			// listener registered afterwards never fires for a signal that is
			// already aborted, so without this check the next attempt would
			// run to completion for a caller who has already gone.
			if (opts?.signal?.aborted) {
				throw new HydraWrapperError(`Hydra DB ${path} → ERR: request cancelled by the caller`, path, {
					cause: lastError,
				});
			}
		}
	}
	throw lastError;
}

async function attemptRaw<T>(
	t: RawTransport,
	path: string,
	method: "GET" | "POST" | "DELETE",
	body: unknown,
	opts?: RawRequestOptions,
): Promise<T> {
	// The host's cancellation and our own deadline both have to be able to
	// abort the request, and `AbortSignal.any` is not available on every Node
	// 18 this package supports — so they are combined by hand.
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), t.timeoutMs);
	const onAbort = () => controller.abort();
	opts?.signal?.addEventListener("abort", onAbort, { once: true });
	// An already-aborted signal never fires "abort" again; carry it over so
	// the fetch below is cancelled immediately instead of running for nobody.
	if (opts?.signal?.aborted) controller.abort();
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
			},
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
			signal: controller.signal,
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
			// and all.
			throw responseError(path, response.status, parsed);
		}

		return unwrap<T>(parsed);
	} catch (err) {
		if (err instanceof HydraWrapperError) throw err;

		// Distinguish our own deadline from the caller's cancellation: they
		// need different actions, and "aborted" alone says neither.
		if (err instanceof Error && err.name === "AbortError") {
			if (opts?.signal?.aborted) {
				throw new HydraWrapperError(
					`Hydra DB ${path} → ERR: request cancelled by the caller`,
					path,
					{ cause: err },
				);
			}
			throw new HydraWrapperError(
				`Hydra DB ${path} → ERR: request timed out after ${t.timeoutMs / 1000}s`,
				path,
				{ cause: err },
			);
		}

		throw translateError(path, err);
	} finally {
		clearTimeout(timer);
		opts?.signal?.removeEventListener("abort", onAbort);
	}
}
