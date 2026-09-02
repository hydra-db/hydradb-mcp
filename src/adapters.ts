/**
 * Adapters over responses the SDK does not fully type.
 *
 * The recall adapters that used to live here are gone: `src/context.ts` now
 * reads the SDK payload directly, so the snake_case mirror they translated into
 * no longer exists. What remains is the listing layer, which is a different
 * thing entirely — see `toMemoryList` — plus the ingest result, which is read
 * for its per-item errors.
 */

import type { HydraDB as SDK } from "@hydradb/sdk";

import type { AddMemoryResponse, MemoryResultItem } from "./types.js";

/**
 * SDK ingest result item → `MemoryResultItem`.
 *
 * `results` used to be hardcoded empty in `toAddMemoryResponse`, which discarded
 * every per-item `status`/`error`/`errorCode`/`relationsError` the server sent.
 * The caller was left with bare counts — "1 success, 2 failed" with no reason,
 * no code and no way to tell WHICH item failed — so its only rational recovery
 * was to re-ingest everything, which (a reused `source_id` replaces) can destroy
 * the item that succeeded.
 */
function toMemoryResultItem(
	item: SDK.IngestionV2IngestResultItem,
): MemoryResultItem {
	return {
		source_id: item.id ?? "",
		title: item.filename ?? null,
		status: item.status ?? "unknown",
		// The server sends "" rather than omitting these on success; normalise to
		// null so callers can test presence instead of emptiness.
		error: item.error || null,
		error_code: item.errorCode || null,
		relations_error: item.relationsError || null,
	};
}

export function toAddMemoryResponse(
	data: SDK.IngestionV2IngestResponse,
): AddMemoryResponse {
	return {
		success: data.success ?? false,
		message: data.message ?? "",
		results: (data.results ?? []).map(toMemoryResultItem),
		success_count: data.successCount ?? 0,
		failed_count: data.failedCount ?? 0,
	};
}

function str(record: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string") return value;
	}
	return undefined;
}

function asRecords(value: unknown): Record<string, unknown>[] | undefined {
	return Array.isArray(value)
		? (value as Record<string, unknown>[])
		: undefined;
}

export interface MemoryListItem {
	memory_id: string;
	memory_content: string;
}

/**
 * How much of the corpus a listing actually covered.
 *
 * The server returns this alongside every listing and both adapters used to
 * discard it, which is what let one page be presented as the whole store.
 */
export interface PageInfo {
	/** Total rows across all pages, when the server reported one. */
	total?: number;
	page?: number;
	page_size?: number;
	total_pages?: number;
	has_next?: boolean;
}

export interface MemoryList {
	memories: MemoryListItem[];
	page: PageInfo;
}

function num(record: Record<string, unknown>, ...keys: string[]): number | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number") return value;
	}
	return undefined;
}

/**
 * Pagination metadata, read defensively for the same reason the rows are: the
 * SDK types this response as `{ inner?: … }` while the live API returns at top
 * level, and neither shape is guaranteed to carry every field.
 */
function toPageInfo(
	container: Record<string, unknown>,
	rowCount: number,
): PageInfo {
	const meta =
		(container.pagination as Record<string, unknown> | undefined) ?? {};
	const total = num(container, "total") ?? num(meta, "total");
	return {
		total: total ?? rowCount,
		page: num(meta, "page"),
		page_size: num(meta, "page_size", "pageSize"),
		total_pages: num(meta, "total_pages", "totalPages"),
		has_next:
			typeof meta.has_next === "boolean"
				? meta.has_next
				: typeof meta.hasNext === "boolean"
					? meta.hasNext
					: undefined,
	};
}

/** SDK list result → memory rows. Field names vary across v2 records, so read defensively. */
export function toMemoryList(data: SDK.ListV2ListResponse): MemoryList {
	// Memory listings surface at top-level `user_memories` — not under an
	// `.inner` wrapper, and not under `sources` (that is the knowledge shape).
	const d = data as unknown as Record<string, unknown>;
	const container =
		(asRecords(d.user_memories) ? d : (d.inner as Record<string, unknown>)) ?? d;
	const records =
		asRecords(d.user_memories) ??
		asRecords((d.inner as Record<string, unknown> | undefined)?.user_memories) ??
		[];
	const memories = records.map((record) => ({
		memory_id: str(record, "memory_id", "id", "source_id") ?? "",
		memory_content:
			str(record, "memory_content", "content", "text", "memory", "title") ?? "",
	}));
	return { memories, page: toPageInfo(container, memories.length) };
}

export interface SourceListItem {
	id: string;
	title?: string;
	type?: string;
}

export interface SourceList {
	sources: SourceListItem[];
	total: number;
	page: PageInfo;
}

/** SDK list result → knowledge source rows + total. */
export function toSourceList(data: SDK.ListV2ListResponse): SourceList {
	// Knowledge listings surface at top-level `sources`, not under `.inner`.
	const d = data as unknown as Record<string, unknown>;
	const container =
		(asRecords(d.sources) ? d : (d.inner as Record<string, unknown>)) ?? d;
	const records =
		asRecords(d.sources) ??
		asRecords((d.inner as Record<string, unknown> | undefined)?.sources) ??
		[];
	const sources = records.map((record) => ({
		id: str(record, "id", "source_id") ?? "",
		title: str(record, "title"),
		type: str(record, "type", "source_type"),
	}));
	const total =
		d.total ?? (d.inner as Record<string, unknown> | undefined)?.total;
	return {
		sources,
		total: typeof total === "number" ? total : sources.length,
		page: toPageInfo(container, sources.length),
	};
}
