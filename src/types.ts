export type ConversationTurn = {
	user: string;
	assistant: string;
};

export type MemoryPayload = {
	text?: string;
	user_assistant_pairs?: ConversationTurn[];
	is_markdown?: boolean;
	infer?: boolean;
	custom_instructions?: string;
	user_name?: string;
	source_id?: string;
	title?: string;
	expiry_time?: number;
};

export type AddMemoryRequest = {
	memories: MemoryPayload[];
	tenant_id: string;
	sub_tenant_id?: string;
	upsert?: boolean;
};

export type MemoryResultItem = {
	source_id: string;
	title?: string | null;
	status: string;
	infer: boolean;
	error?: string | null;
};

export type AddMemoryResponse = {
	success: boolean;
	message: string;
	results: MemoryResultItem[];
	success_count: number;
	failed_count: number;
};

export type RecallRequest = {
	tenant_id: string;
	sub_tenant_id?: string;
	query: string;
	max_results?: number;
	mode?: "fast" | "thinking";
	alpha?: number | string;
	recency_bias?: number;
	graph_context?: boolean;
	additional_context?: string;
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

// --- List API ---

export type ListDataRequest = {
	tenant_id: string;
	sub_tenant_id?: string;
	kind?: "knowledge" | "memories";
	source_ids?: string[];
};

export type UserMemory = {
	memory_id: string;
	memory_content: string;
};

export type ListMemoriesResponse = {
	success: boolean;
	user_memories: UserMemory[];
};

export type SourceItem = {
	id: string;
	tenant_id: string;
	sub_tenant_id: string;
	title?: string;
	type?: string;
	description?: string;
	timestamp?: string;
	url?: string;
};

export type ListSourcesResponse = {
	success: boolean;
	message?: string;
	sources: SourceItem[];
	total: number;
};

// --- Delete API ---

export type DeleteMemoryResponse = {
	success: boolean;
	user_memory_deleted: boolean;
};

// --- Fetch Content API ---

export type FetchContentRequest = {
	tenant_id: string;
	sub_tenant_id?: string;
	source_id: string;
	mode?: "content" | "url" | "both";
	expiry_seconds?: number;
};

export type FetchContentResponse = {
	success: boolean;
	source_id: string;
	content?: string | null;
	content_base64?: string | null;
	presigned_url?: string | null;
	content_type?: string | null;
	size_bytes?: number | null;
	message?: string;
	error?: string | null;
};

