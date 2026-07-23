/**
 * Adapters from the SDK's (camelCase) response payloads back into the legacy
 * snake_case shapes this server already renders.
 *
 * These live in the MCP layer — NOT the portable wrapper — because they exist
 * only to keep `src/context.ts` (the high-value, byte-identical recall
 * renderer) and the existing tool output strings unchanged across the v1 → SDK
 * migration. The wrapper returns SDK-native `.data`; the server adapts it here.
 *
 * Note: with `skipValidation`, the SDK transforms known fields to camelCase but
 * leaves the untyped triplet innards (`relation`/`source`/`target`) as raw
 * snake_case — which is exactly what `formatTriplet` reads — so triplets pass
 * through untouched.
 */

import type { HydraDB as SDK } from "@hydradb/sdk";

import type {
	AddMemoryResponse,
	RecallResponse,
	ScoredPath,
	VectorChunk,
} from "./types.js";

function toScoredPath(path: SDK.SearchScoredPathResponse): ScoredPath {
	return {
		// Triplet innards are already raw snake_case (untyped in the SDK schema).
		triplets: (path.triplets ?? []) as unknown as ScoredPath["triplets"],
		relevancy_score: path.relevancyScore ?? 0,
		combined_context: path.combinedContext ?? null,
		group_id: path.groupId ?? null,
	};
}

function toVectorChunk(chunk: SDK.SearchV2Chunk): VectorChunk {
	return {
		chunk_uuid: chunk.chunkUuid ?? "",
		source_id: chunk.id ?? "",
		chunk_content: chunk.chunkContent ?? "",
		source_title: chunk.sourceTitle,
		source_type: chunk.sourceType,
		source_upload_time: chunk.sourceUploadTime,
		source_last_updated_time: chunk.sourceLastUpdatedTime,
		relevancy_score: chunk.relevancyScore ?? null,
		document_metadata: chunk.additionalMetadata ?? null,
		tenant_metadata: chunk.metadata ?? null,
		extra_context_ids: chunk.extraContextIds ?? null,
		layout: chunk.layout ?? null,
	};
}

/** SDK retrieval result → the legacy `RecallResponse` fed to `buildRecalledContext`. */
export function toRecallResponse(data: SDK.SearchV2RetrievalResult): RecallResponse {
	const graph = data.graphContext;
	const additional: Record<string, VectorChunk> = {};
	for (const [id, chunk] of Object.entries(data.additionalContext ?? {})) {
		additional[id] = toVectorChunk(chunk);
	}

	return {
		chunks: (data.chunks ?? []).map(toVectorChunk),
		graph_context: graph
			? {
					query_paths: (graph.queryPaths ?? []).map(toScoredPath),
					chunk_relations: (graph.chunkRelations ?? []).map(toScoredPath),
					chunk_id_to_group_ids: graph.chunkIdToGroupIds ?? {},
				}
			: undefined,
		additional_context: additional,
	};
}

/** SDK ingest result → the legacy `AddMemoryResponse` (success/failed counts). */
export function toAddMemoryResponse(
	data: SDK.IngestionV2SourceUploadResponse,
): AddMemoryResponse {
	return {
		success: data.success ?? false,
		message: data.message ?? "",
		results: [],
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

export interface MemoryListItem {
	memory_id: string;
	memory_content: string;
}

/** SDK list result → memory rows. Field names vary across v2 records, so read defensively. */
export function toMemoryList(data: SDK.ListV2SourceListResponse): MemoryListItem[] {
	const records = (data.inner?.sources ?? []) as Record<string, unknown>[];
	return records.map((record) => ({
		memory_id: str(record, "memory_id", "id", "source_id") ?? "",
		memory_content:
			str(record, "memory_content", "content", "text", "memory", "title") ?? "",
	}));
}

export interface SourceListItem {
	id: string;
	title?: string;
	type?: string;
}

export interface SourceList {
	sources: SourceListItem[];
	total: number;
}

/** SDK list result → knowledge source rows + total. */
export function toSourceList(data: SDK.ListV2SourceListResponse): SourceList {
	const records = (data.inner?.sources ?? []) as Record<string, unknown>[];
	const sources = records.map((record) => ({
		id: str(record, "id", "source_id") ?? "",
		title: str(record, "title"),
		type: str(record, "type", "source_type"),
	}));
	return {
		sources,
		total: data.inner?.total ?? sources.length,
	};
}
