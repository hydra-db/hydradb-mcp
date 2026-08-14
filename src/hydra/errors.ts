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

/** Anything past this is not diagnosis, it is payload. */
const MAX_BODY_CHARS = 512;

/**
 * Credential-shaped substrings, scrubbed before an error body is shown.
 *
 * Defence in depth for bodies we did not write. HydraDB's own error path is
 * clean — every 401 message is a static string literal and backend failures
 * collapse to "Internal server error" — but this string also carries whatever a
 * CDN, load balancer, WAF or corporate proxy returns, and those are not ours to
 * vouch for. The SDK already redacts sensitive headers and query params before
 * logging; response bodies are the one place it does not.
 */
const SECRET_PATTERNS: [RegExp, string][] = [
	[/\bBearer\s+\S+/gi, "Bearer [redacted]"],
	[/\b(sk|hdb|key|tok)[-_][A-Za-z0-9_-]{16,}/g, "[redacted]"],
	[
		/("(?:api[-_]?key|token|authorization|password|secret)"\s*:\s*)"[^"]*"/gi,
		'$1"[redacted]"',
	],
];

function scrub(text: string): string {
	let out = text;
	for (const [pattern, replacement] of SECRET_PATTERNS) {
		out = out.replace(pattern, replacement);
	}
	return out;
}

/** Reduce an HTML error page to its readable text, so the cap spends its budget well. */
function stripMarkup(text: string): string {
	if (!/^\s*</.test(text)) return text;
	const title = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
	const stripped = text
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return title ? `${title} — ${stripped}` : stripped;
}

/**
 * The v2 envelope, when the body is one.
 *
 * Rendering `error.code` / `error.message` / `meta.request_id` instead of the
 * whole JSON blob makes the common case both shorter AND more useful: the
 * request id is exactly what a user needs to file a support ticket, and it was
 * previously buried in a stringified object.
 */
function fromEnvelope(body: unknown): string | undefined {
	if (body == null || typeof body !== "object") return undefined;
	const record = body as Record<string, unknown>;
	const error = record.error;
	if (error == null || typeof error !== "object") return undefined;

	const { code, message } = error as { code?: unknown; message?: unknown };
	const parts: string[] = [];
	if (typeof code === "string" && code !== "") parts.push(code);
	if (typeof message === "string" && message !== "") parts.push(message);
	if (parts.length === 0) return undefined;

	const meta = record.meta;
	const requestId =
		meta != null && typeof meta === "object"
			? (meta as { request_id?: unknown }).request_id
			: undefined;
	const trailer =
		typeof requestId === "string" && requestId !== ""
			? ` (request_id: ${requestId})`
			: "";

	return `${parts.join(": ")}${trailer}`;
}

function bodyToString(body: unknown): string {
	if (body == null) return "";

	const structured = fromEnvelope(body);
	if (structured != null) return truncate(scrub(structured));

	let raw: string;
	if (typeof body === "string") {
		raw = body;
	} else {
		try {
			raw = JSON.stringify(body);
		} catch {
			raw = String(body);
		}
	}
	return truncate(scrub(stripMarkup(raw)));
}

function truncate(text: string): string {
	if (text.length <= MAX_BODY_CHARS) return text;
	return `${text.slice(0, MAX_BODY_CHARS)}… (truncated, ${text.length} chars)`;
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
