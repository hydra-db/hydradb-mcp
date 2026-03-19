// Single source of truth for MCP tool names.

export const TOOL_NAMES = {
	SEARCH: "hydra_db_search",
	STORE: "hydra_db_store",
	INGEST_CONVERSATION: "hydra_db_ingest_conversation",
	LIST_MEMORIES: "hydra_db_list_memories",
	DELETE_MEMORY: "hydra_db_delete_memory",
	FETCH_CONTENT: "hydra_db_fetch_content",
	LIST_SOURCES: "hydra_db_list_sources",
} as const;
