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
	// The connected subgraph of one item (PRO-1848): what it links to, what
	// shares its thread, what it is a parent or child of. A read over the
	// memory/knowledge corpora, so it belongs to this family and not to the
	// BYOG graph tools below, which address a different store.
	SUBGRAPH: "hydradb_subgraph",
	// Knowledge-graph relations of one item or a whole collection
	// (GET /context/relations). New capability, so no alias.
	RELATIONS: "hydradb_relations",
	// Discovery: which databases this connection can address. Exists so an
	// agent working across several databases can find their names without
	// asking the user, and so a confined connection can see its own limits.
	DATABASES: "hydradb_databases",
	LIST_COLLECTIONS: "hydradb_list_collections",
	// Feedback about a query that already ran (PRO-1805 / POST /feedback). New
	// capability, so no alias: there is no prior spelling to keep working, the
	// same position hydradb_subgraph is in.
	FEEDBACK: "hydradb_feedback",
	DELETE_COLLECTION: "hydradb_delete_collection",

	// BYOG graph tools (PRO-1681). A separate family with its own prefix: these
	// address graph collections the user models and writes in Cypher, which are
	// a different namespace from the memory/knowledge corpora above. Sharing a
	// name between the two would be the worst possible outcome — a model
	// reaching for `hydradb_query` to run Cypher, or for the graph tool to
	// search memories.
	GRAPH_QUERY: "hydradb_graph_query",
	GRAPH_COLLECTIONS: "hydradb_graph_collections",
	GRAPH_ADMIN: "hydradb_graph_admin",

	// Indexing webhook tools (PRO-3342). One per public /webhooks/indexing
	// endpoint, so an agent can register a callback for indexing events and debug
	// a failed delivery without leaving the session. A separate family with its
	// own gate, like the graph tools above: new capability, no prior spelling, so
	// no alias.
	WEBHOOK_REGISTER: "hydradb_webhook_register",
	WEBHOOK_GET: "hydradb_webhook_get",
	WEBHOOK_DELETE: "hydradb_webhook_delete",
	WEBHOOK_SET_SIGNING_SECRET: "hydradb_webhook_set_signing_secret",
	WEBHOOK_CLEAR_SIGNING_SECRET: "hydradb_webhook_clear_signing_secret",
	WEBHOOK_LIST_DELIVERIES: "hydradb_webhook_list_deliveries",
	WEBHOOK_GET_DELIVERY: "hydradb_webhook_get_delivery",
	WEBHOOK_RETRY_DELIVERY: "hydradb_webhook_retry_delivery",
	WEBHOOK_TEST: "hydradb_webhook_test",

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
	TOOL_NAMES.SUBGRAPH,
	TOOL_NAMES.RELATIONS,
	TOOL_NAMES.LIST_COLLECTIONS,
	TOOL_NAMES.DELETE_COLLECTION,
	TOOL_NAMES.FEEDBACK,
] as const;

/**
 * Registered only for connections established through OAuth, where the user
 * may have confined the app to specific databases and the agent needs to see
 * that. Kept off the canonical list on purpose: an API-key connection's tool
 * surface must not change at all when OAuth ships.
 */
export const OAUTH_TOOL_NAMES = [TOOL_NAMES.DATABASES] as const;

/** The BYOG graph family, registered together and gated together. */
export const GRAPH_TOOL_NAMES = [
	TOOL_NAMES.GRAPH_QUERY,
	TOOL_NAMES.GRAPH_COLLECTIONS,
	TOOL_NAMES.GRAPH_ADMIN,
] as const;

/**
 * The indexing-webhook family (PRO-3342), registered together and gated
 * together. On by default like the graph family — a real product surface no
 * other client exposes — and withheld as a group by HYDRADB_MCP_WEBHOOK_TOOLS=0
 * for callers who do not want the extra manifest.
 */
export const WEBHOOK_TOOL_NAMES = [
	TOOL_NAMES.WEBHOOK_REGISTER,
	TOOL_NAMES.WEBHOOK_GET,
	TOOL_NAMES.WEBHOOK_DELETE,
	TOOL_NAMES.WEBHOOK_SET_SIGNING_SECRET,
	TOOL_NAMES.WEBHOOK_CLEAR_SIGNING_SECRET,
	TOOL_NAMES.WEBHOOK_LIST_DELIVERIES,
	TOOL_NAMES.WEBHOOK_GET_DELIVERY,
	TOOL_NAMES.WEBHOOK_RETRY_DELIVERY,
	TOOL_NAMES.WEBHOOK_TEST,
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
