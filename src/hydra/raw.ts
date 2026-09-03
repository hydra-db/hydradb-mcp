/**
 * A minimal JSON transport for the two v2 calls the pinned SDK cannot make yet
 * (PRO-1618): `items` on `POST /context/ingest` and `type` on `POST /databases`,
 * plus the `GET /databases` layout probe. The generated client appends only the
 * multipart fields it knows and strips unknown JSON keys, so until the SDK is
 * regenerated from the new OpenAPI document these go over the wire by hand,
 * through the same envelope unwrap and error translation as everything else.
 *
 * Same shape as the BYOG transport in ./graph.ts; kept separate so that file
 * stays about graphs.
 */

import { unwrap } from "./envelope.js";
import { HydraWrapperError, responseError } from "./errors.js";

const DEFAULT_BASE_URL = "https://api.hydradb.com";

/** Storage layout of a database (PRO-1618): fixed at creation, never changed. */
export type Layout = "split" | "unified";

export interface RawConfig {
	token: string;
	baseUrl?: string;
	timeoutSeconds?: number;
	/** Test seam: a fetch that answers without a network. */
	fetch?: typeof fetch;
}

export class RawHttp {
	private readonly baseUrl: string;
	private readonly timeoutMs: number;
	private readonly fetchImpl: typeof fetch;

	constructor(private readonly config: RawConfig) {
		this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
		this.timeoutMs = (config.timeoutSeconds ?? 30) * 1000;
		this.fetchImpl = config.fetch ?? fetch;
	}

	async request<T>(
		method: "GET" | "POST" | "DELETE",
		path: string,
		body?: unknown,
		signal?: AbortSignal,
	): Promise<T> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
				method,
				headers: {
					Authorization: `Bearer ${this.config.token}`,
					"Content-Type": "application/json",
					// CONTRACT §2 rule 6: every v2 call names its version.
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
			if (!response.ok) throw responseError(path, response.status, parsed);
			return unwrap<T>(parsed);
		} catch (err) {
			if (err instanceof HydraWrapperError) throw err;
			if (err instanceof Error && err.name === "AbortError") {
				throw new HydraWrapperError(
					signal?.aborted
						? `Hydra DB ${path} → ERR: request cancelled by the caller`
						: `Hydra DB ${path} → ERR: timed out after ${this.timeoutMs}ms`,
					path,
					{ cause: err },
				);
			}
			throw new HydraWrapperError(
				`Hydra DB ${path} → ERR: ${err instanceof Error ? err.message : String(err)}`,
				path,
				{ cause: err },
			);
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	}
}
