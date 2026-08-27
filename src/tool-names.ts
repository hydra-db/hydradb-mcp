// Single source of truth for MCP tool names.
//
// PRO-1298: adopt the canonical HydraDB vocabulary (CONTRACT.md §3) on every
// surface, while keeping every legacy name working as a DEPRECATED ALIAS. MCP
// tool names live in users' `mcp.json`, so removing a name outright is
// breaking — aliases stay registered (marked deprecated) until a later major.

export const TOOL_NAMES = {
	// Canonical (CONTRACT §3).
	QUERY: "hydradb_query",
	INGEST: "hydradb_ingest",
	LIST: "hydradb_list",
	INSPECT: "hydradb_inspect",
	DELETE: "hydradb_delete",
	STATUS: "hydradb_status",
	// Discovery (1.3.0): which databases this account can address. Exists so an
	// agent told "choose a database" can find the choices without leaving MCP.
	DATABASES: "hydradb_databases",

	// BYOG graph tools (PRO-1681). A separate family with its own prefix: these
	// address graph collections the user models and writes in Cypher, which are
	// a different namespace from the memory/knowledge corpora above. Sharing a
	// name between the two would be the worst possible outcome — a model
	// reaching for `hydradb_query` to run Cypher, or for the graph tool to
	// search memories.
	GRAPH_QUERY: "hydradb_graph_query",
	GRAPH_COLLECTIONS: "hydradb_graph_collections",
	GRAPH_ADMIN: "hydradb_graph_admin",

	// Deprecated aliases — kept working for backward compatibility.
	SEARCH: "hydra_db_search",
	STORE: "hydra_db_store",
	INGEST_CONVERSATION: "hydra_db_ingest_conversation",
	LIST_MEMORIES: "hydra_db_list_memories",
	LIST_SOURCES: "hydra_db_list_sources",
	FETCH_CONTENT: "hydra_db_fetch_content",
	DELETE_MEMORY: "hydra_db_delete_memory",
} as const;

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

export const CANONICAL_TOOL_NAMES = [
	TOOL_NAMES.QUERY,
	TOOL_NAMES.INGEST,
	TOOL_NAMES.LIST,
	TOOL_NAMES.INSPECT,
	TOOL_NAMES.DELETE,
	TOOL_NAMES.STATUS,
	TOOL_NAMES.DATABASES,
] as const;

/** The BYOG graph family, registered together and gated together. */
export const GRAPH_TOOL_NAMES = [
	TOOL_NAMES.GRAPH_QUERY,
	TOOL_NAMES.GRAPH_COLLECTIONS,
	TOOL_NAMES.GRAPH_ADMIN,
] as const;

export const DEPRECATED_TOOL_NAMES = [
	TOOL_NAMES.SEARCH,
	TOOL_NAMES.STORE,
	TOOL_NAMES.INGEST_CONVERSATION,
	TOOL_NAMES.LIST_MEMORIES,
	TOOL_NAMES.LIST_SOURCES,
	TOOL_NAMES.FETCH_CONTENT,
	TOOL_NAMES.DELETE_MEMORY,
] as const;

/** Each deprecated alias mapped to the canonical tool that replaces it. */
export const ALIAS_REPLACEMENTS: Record<string, string> = {
	[TOOL_NAMES.SEARCH]: TOOL_NAMES.QUERY,
	[TOOL_NAMES.STORE]: TOOL_NAMES.INGEST,
	[TOOL_NAMES.INGEST_CONVERSATION]: TOOL_NAMES.INGEST,
	[TOOL_NAMES.LIST_MEMORIES]: TOOL_NAMES.LIST,
	[TOOL_NAMES.LIST_SOURCES]: TOOL_NAMES.LIST,
	[TOOL_NAMES.FETCH_CONTENT]: TOOL_NAMES.INSPECT,
	[TOOL_NAMES.DELETE_MEMORY]: TOOL_NAMES.DELETE,
};
