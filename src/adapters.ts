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
import { z } from "zod";

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
	external_id?: string;
	provider?: string;
	parent_external_id?: string;
	connector_id?: string;
	/** The `include_fields` the caller asked for, as the server returned them. */
	fields?: ListedFields;
	/** `group_threads`: the comment and reply rows folded under this one. */
	comments?: SourceListItem[];
	/** The server capped `comments`; the thread has more than what is inline. */
	comments_truncated?: boolean;
}

/** Any JSON value, as a projected list field can carry. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Projected fields by name: what `include_fields` returned for one row. */
export type ListedFields = { [name: string]: JsonValue };

export const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
	z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValue), z.record(jsonValue)]),
);

// A field of the wrong type reads as absent rather than failing the row,
// matching `str`'s first-string-wins reading of the same records.
const optionalText = z.string().optional().catch(undefined);

// Read on its own: the row keeps `additional_metadata` whole, because
// `include_fields: ["additional_metadata"]` projects every key of it.
const connectorMetadata = z.object({ connector_id: optionalText });

/**
 * One listed source row. Passthrough keeps the projected fields, which are
 * read by name and parsed as JSON; `comments` are rows of this same kind,
 * parsed one level at a time by `toSourceRow`.
 */
const listedSourceRecord = z
	.object({
		id: optionalText,
		source_id: optionalText,
		title: optionalText,
		type: optionalText,
		source_type: optionalText,
		app_external_id: optionalText,
		appExternalId: optionalText,
		app_provider: optionalText,
		appProvider: optionalText,
		app_parent_id: optionalText,
		appParentId: optionalText,
		comments: z.array(z.unknown()).optional().catch(undefined),
		comments_truncated: z.boolean().optional().catch(undefined),
	})
	.passthrough();

type ListedSourceRecord = z.infer<typeof listedSourceRecord>;

function toSourceRow(record: ListedSourceRecord, fields: readonly string[]): SourceListItem {
	const row: SourceListItem = {
		id: record.id ?? record.source_id ?? "",
		title: record.title,
		type: record.type ?? record.source_type,
	};

	const externalId = record.app_external_id ?? record.appExternalId;

	if (externalId != null) row.external_id = externalId;

	const provider = record.app_provider ?? record.appProvider;

	if (provider != null) row.provider = provider;

	const parentExternalId = record.app_parent_id ?? record.appParentId;

	if (parentExternalId != null) row.parent_external_id = parentExternalId;

	const connectorId = connectorMetadata.safeParse(record.additional_metadata ?? record.additionalMetadata).data?.connector_id;

	if (connectorId != null) row.connector_id = connectorId;

	const picked: ListedFields = {};

	for (const name of fields) {
		const value = jsonValue.safeParse(record[name]);

		if (record[name] !== undefined && value.success) picked[name] = value.data;
	}

	if (Object.keys(picked).length > 0) row.fields = picked;

	if (record.comments != null) {
		row.comments = record.comments.flatMap((comment) => {
			const parsed = listedSourceRecord.safeParse(comment);

			return parsed.success ? [toSourceRow(parsed.data, fields)] : [];
		});
	}

	if (record.comments_truncated === true) row.comments_truncated = true;

	return row;
}

export interface SourceList {
	sources: SourceListItem[];
	total: number;
	page: PageInfo;
}

/**
 * SDK list result → knowledge source rows + total. `fields` names the
 * `include_fields` the caller asked for, carried through on each row.
 */
export function toSourceList(data: SDK.ListV2ListResponse, fields: readonly string[] = []): SourceList {
	// Knowledge listings surface at top-level `sources`, not under `.inner`.
	const d = data as unknown as Record<string, unknown>;
	const container =
		(asRecords(d.sources) ? d : (d.inner as Record<string, unknown>)) ?? d;
	const records =
		asRecords(d.sources) ??
		asRecords((d.inner as Record<string, unknown> | undefined)?.sources) ??
		[];

	const sources = records.map((record) => toSourceRow(listedSourceRecord.safeParse(record).data ?? {}, fields));
	const total =
		d.total ?? (d.inner as Record<string, unknown> | undefined)?.total;
	return {
		sources,
		total: typeof total === "number" ? total : sources.length,
		page: toPageInfo(container, sources.length),
	};
}

export interface RelationEnd {
	name: string | null;
	type: string | null;
	entity_id: string | null;
}

export interface RelationItem {
	source: RelationEnd;
	target: RelationEnd;
	/** canonical_predicate, else raw_predicate, of the first evidence entry. */
	predicate: string | null;
	/** The passage that evidences it, verbatim from the source. */
	context: string | null;
	chunk_id: string | null;
	/** How many evidence entries back this triplet. */
	evidence_count: number;
}

export interface RelationList {
	relations: RelationItem[];
	structural_count: number;
	structural_truncated: boolean;
	is_truncated: boolean;
	next_cursor: number | null;
}

// Both spellings: the SDK hands back camelCase, the raw wire is snake_case.
const relationEndRecord = z.object({
	name: optionalText,
	type: optionalText,
	entity_id: optionalText,
	entityId: optionalText,
});

const relationEvidenceRecord = z.object({
	canonical_predicate: optionalText,
	canonicalPredicate: optionalText,
	raw_predicate: optionalText,
	rawPredicate: optionalText,
	context: optionalText,
	chunk_id: optionalText,
	chunkId: optionalText,
});

const relationTripletRecord = z.object({
	source: relationEndRecord.optional(),
	target: relationEndRecord.optional(),
	chunk_id: optionalText,
	chunkId: optionalText,
	relations: z.array(relationEvidenceRecord).optional(),
});

// Every field is optional on its own, but the API always sends `relations`
// and `is_truncated`: a body with neither (`{}`, an upstream error message)
// is not a relations response and must not read as an empty graph.
const relationsResponseRecord = z.object({
	relations: z.array(relationTripletRecord).nullable().optional(),
	auxiliary_relations: z.array(z.unknown()).optional(),
	auxiliaryRelations: z.array(z.unknown()).optional(),
	auxiliary_truncated: z.boolean().optional(),
	auxiliaryTruncated: z.boolean().optional(),
	is_truncated: z.boolean().optional(),
	isTruncated: z.boolean().optional(),
	next_cursor: z.number().nullable().optional(),
	nextCursor: z.number().nullable().optional(),
}).refine(
	(body) => body.relations != null || body.is_truncated != null || body.isTruncated != null,
	{ message: "expected a relations array or a truncation flag" },
);

function relationEnd(record: z.infer<typeof relationEndRecord> | undefined): RelationEnd {
	return {
		name: record?.name ?? null,
		type: record?.type ?? null,
		entity_id: record?.entity_id ?? record?.entityId ?? null,
	};
}

/**
 * SDK relations result → triplets. A body that is not a relations response
 * throws: a proxy's error page must not read as "no relations".
 */
export function toRelationList(data: SDK.GraphGraphRelationsResponse): RelationList {
	const parsed = relationsResponseRecord.safeParse(data);

	if (!parsed.success) {
		throw new Error(`Invalid relations response: ${parsed.error.issues[0]?.message ?? "unexpected body"}.`);
	}

	const d = parsed.data;

	const relations = (d.relations ?? []).map((triplet) => {
		const evidence = triplet.relations ?? [];
		const first = evidence[0];

		return {
			source: relationEnd(triplet.source),
			target: relationEnd(triplet.target),
			predicate:
				first?.canonical_predicate ?? first?.canonicalPredicate ?? first?.raw_predicate ?? first?.rawPredicate ?? null,
			context: first?.context || null,
			chunk_id: triplet.chunk_id || triplet.chunkId || first?.chunk_id || first?.chunkId || null,
			evidence_count: evidence.length,
		};
	});

	return {
		relations,
		structural_count: (d.auxiliary_relations ?? d.auxiliaryRelations ?? []).length,
		structural_truncated: (d.auxiliary_truncated ?? d.auxiliaryTruncated) === true,
		is_truncated: (d.is_truncated ?? d.isTruncated) === true,
		next_cursor: d.next_cursor ?? d.nextCursor ?? null,
	};
}
