/**
 * Error translation for the HydraDB wrapper.
 *
 * The wrapper is the firewall between the generated `@hydradb/sdk` and the host
 * (this MCP server). SDK calls throw `HydraDBError` subclasses; we catch those
 * and re-throw a `HydraWrapperError` whose `message` reproduces the exact
 * template the hand-rolled v1 client used:
 *
 *     Hydra DB ${path} → ${status}: ${body}
 *
 * The MCP runtime surfaces only `error.message` to the model (see
 * `createToolError` in @modelcontextprotocol/sdk), so keeping this template
 * byte-identical keeps model-visible error behaviour unchanged across the
 * v1 → SDK migration. The `path`/`status`/`body` values naturally reflect the
 * v2 endpoint now being called; changing the template text itself is a
 * separate, later, deliberate step.
 */

import { HydraDBError } from "@hydradb/sdk";

export class HydraWrapperError extends Error {
	/** Logical endpoint path the failing call targeted (e.g. `/query`). */
	readonly path: string;
	/** HTTP status code, when the failure carried one. */
	readonly status?: number;
	/** Parsed error body from the SDK, preserved for programmatic handling. */
	readonly body?: unknown;
	/** The original SDK error, preserved as the cause. */
	readonly cause?: unknown;

	constructor(
		message: string,
		path: string,
		opts?: { status?: number; body?: unknown; cause?: unknown },
	) {
		super(message);
		this.name = "HydraWrapperError";
		this.path = path;
		this.status = opts?.status;
		this.body = opts?.body;
		this.cause = opts?.cause;
		Object.setPrototypeOf(this, HydraWrapperError.prototype);
	}
}

function bodyToString(body: unknown): string {
	if (body == null) return "";
	if (typeof body === "string") return body;
	try {
		return JSON.stringify(body);
	} catch {
		return String(body);
	}
}

/**
 * Translate any error thrown by an SDK call into a `HydraWrapperError` carrying
 * the byte-identical `Hydra DB ${path} → ${status}: ${body}` message.
 */
export function translateError(path: string, err: unknown): HydraWrapperError {
	if (err instanceof HydraDBError) {
		const status = err.statusCode;
		const statusText = status != null ? String(status) : "ERR";
		return new HydraWrapperError(
			`Hydra DB ${path} → ${statusText}: ${bodyToString(err.body)}`,
			path,
			{ status, body: err.body, cause: err },
		);
	}

	// Non-SDK failure (network error, aborted request, unexpected throw).
	const message = err instanceof Error ? err.message : String(err);
	return new HydraWrapperError(`Hydra DB ${path} → ERR: ${message}`, path, {
		cause: err,
	});
}
