/**
 * HandlerEnvelope unwrapping.
 *
 * Most `@hydradb/sdk` methods resolve to a `HandlerEnvelope{ data, success, meta,
 * error }` and we want the inner `data`. But not every method is enveloped
 * (`databases.updateMetadataSchema` and most `connectors.*` return bare
 * objects), so we unwrap by *checking the envelope shape* rather than assuming
 * it: a value is an envelope only if it carries a top-level `data` property
 * alongside one of the envelope siblings (`success` / `meta` / `error`).
 *
 * Payload types (e.g. `FetchV2SourceFetchResponse`) may themselves carry a
 * `success` field, but never a top-level `data`, so they are correctly left
 * untouched when they arrive already unwrapped.
 */

import { z } from "zod";

export interface ResponseWarning {
	code: string;
	message: string;
	collections?: string[];
}

export interface ResponseMeta {
	requestId?: string;
	warnings?: ResponseWarning[];
	collection?: string;
}

function isEnvelope(value: unknown): value is { data: unknown } {
	if (value == null || typeof value !== "object") return false;
	if (!("data" in value)) return false;
	return "success" in value || "meta" in value || "error" in value;
}

export function unwrap<T>(value: unknown): T {
	if (isEnvelope(value)) {
		return value.data as T;
	}
	return value as T;
}

/**
 * Pull the request id out of an envelope, or undefined when the response is not
 * enveloped (several SDK methods return bare objects — see above).
 *
 * BOTH spellings are read, and that is not defensiveness. The wire is
 * snake_case, but the SDK camel-cases `meta` on the way through, so an SDK call
 * yields `requestId` while anything read straight off the HTTP response yields
 * `request_id` — which is the spelling errors.ts already handles for the raw
 * transport path. A reader that knows only one of them works on some calls and
 * silently returns undefined on the rest.
 */
const requestMetaEnvelopeSchema = z.object({
	meta: z
		.object({
			requestId: z.unknown().optional(),
			request_id: z.unknown().optional(),
			warnings: z.unknown().optional(),
			collection: z.string().optional(),
		})
		.optional(),
});

export function readRequestId<T>(value: T): string | undefined {
	return readResponseMeta(value).requestId;
}

const responseWarningSchema = z.object({ code: z.string(), message: z.string(), collections: z.array(z.string()).optional() });

export function readResponseMeta(value: unknown): ResponseMeta {
	const parsed = requestMetaEnvelopeSchema.safeParse(value);

	if (!parsed.success) return { requestId: undefined };
	const meta = parsed.data.meta;
	const camelId = z.string().safeParse(meta?.requestId);
	const id = camelId.success ? camelId.data : meta?.request_id;
	const entries = z.array(z.unknown()).safeParse(meta?.warnings);
	const warnings = entries.success ? entries.data.flatMap((entry) => {
		const warning = responseWarningSchema.safeParse(entry);
		return warning.success ? [warning.data] : [];
	}) : [];
	const result: ResponseMeta = { requestId: typeof id === "string" && id !== "" ? id : undefined };

	if (warnings.length) result.warnings = warnings;
	if (meta?.collection != null) result.collection = meta.collection;
	return result;
}
