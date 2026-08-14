// Legacy snake_case domain shapes the MCP render layer still speaks.
//
// The v2 SDK returns camelCase payloads; `src/adapters.ts` maps those back into
// these shapes so `src/context.ts` (the byte-identical recall renderer) and the
// tool output strings stay unchanged. These are NOT wire request types — the
// wrapper owns the SDK request surface.

export type MemoryResultItem = {
	source_id: string;
	title?: string | null;
	status: string;
	error?: string | null;
	/** Machine-readable classification for `error`, when the server sent one. */
	error_code?: string | null;
	/**
	 * Graph extraction can fail on an item the server otherwise accepted. That
	 * item is stored and findable by text, but unreachable by graph traversal —
	 * a partial success that looks identical to a full one unless reported.
	 */
	relations_error?: string | null;
};

export type AddMemoryResponse = {
	success: boolean;
	message: string;
	results: MemoryResultItem[];
	success_count: number;
	failed_count: number;
};

export type VectorChunk = {
	chunk_uuid: string;
	source_id: string;
	chunk_content: string;
	source_type?: string;
	source_upload_time?: string;
	source_title?: string;
	source_last_updated_time?: string;
	relevancy_score?: number | null;
	document_metadata?: Record<string, unknown> | null;
	tenant_metadata?: Record<string, unknown> | null;
	extra_context_ids?: string[] | null;
	layout?: string | null;
};

export type PathTriplet = {
	source: { name: string; type: string; entity_id: string };
	relation: {
		canonical_predicate: string;
		raw_predicate: string;
		context: string;
		confidence?: number;
		chunk_id?: string | null;
		relationship_id: string;
	};
	target: { name: string; type: string; entity_id: string };
};

export type ScoredPath = {
	triplets: PathTriplet[];
	relevancy_score: number;
	combined_context?: string | null;
	group_id?: string | null;
	/**
	 * Chunks this relation path was drawn from. The direct chunk→relation link,
	 * and the mapping the SDK's own renderer prefers; `group_id` plus
	 * `chunk_id_to_group_ids` is the indirect fallback for when this is absent.
	 */
	source_chunk_ids?: string[] | null;
};

export type GraphContext = {
	query_paths: ScoredPath[];
	chunk_relations: ScoredPath[];
	chunk_id_to_group_ids: Record<string, string[]>;
};

export type RecallResponse = {
	chunks: VectorChunk[];
	graph_context?: GraphContext;
	additional_context?: Record<string, VectorChunk>;
};
