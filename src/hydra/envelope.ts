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
