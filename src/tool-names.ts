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
	UPDATE: "hydradb_update",
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
	// Database management (ENG-3340), named per CONTRACT.md §3 "Databases": noun
	// first, verb last. None of these shipped under another name, so no aliases.
	DATABASE_CREATE: "hydradb_database_create",
	DATABASE_DELETE: "hydradb_database_delete",
	DATABASE_READINESS: "hydradb_database_readiness",
	DATABASE_STATS: "hydradb_database_stats",
	DATABASE_SCHEMA_INSPECT: "hydradb_database_schema_inspect",
	DATABASE_SCHEMA_UPDATE: "hydradb_database_schema_update",
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

	// Connector tools (ENG-3341), named per CONTRACT.md §3 "Connectors": noun
	// first (`connector`, then `provider` or `resource` when the action is on one
	// of those), verb last, so the MCP, CLI and plugin names map one to one.
	// None of these shipped under another name, so there are no aliases.
	CONNECTOR_PROVIDER_LIST: "hydradb_connector_provider_list",
	CONNECTOR_PROVIDER_INSPECT: "hydradb_connector_provider_inspect",
	CONNECTOR_LIST: "hydradb_connector_list",
	CONNECTOR_INSPECT: "hydradb_connector_inspect",
	CONNECTOR_HEALTH: "hydradb_connector_health",
	CONNECTOR_CONNECT: "hydradb_connector_connect",
	CONNECTOR_RECONNECT: "hydradb_connector_reconnect",
	CONNECTOR_UPDATE: "hydradb_connector_update",
	CONNECTOR_DELETE: "hydradb_connector_delete",
	CONNECTOR_SYNC: "hydradb_connector_sync",
	CONNECTOR_PAUSE: "hydradb_connector_pause",
	CONNECTOR_RESUME: "hydradb_connector_resume",
	CONNECTOR_DISCOVER: "hydradb_connector_discover",
	CONNECTOR_RESOURCE_LIST: "hydradb_connector_resource_list",
	CONNECTOR_RESOURCE_ADD: "hydradb_connector_resource_add",
	CONNECTOR_RESOURCE_UPDATE: "hydradb_connector_resource_update",
	CONNECTOR_RESOURCE_DELETE: "hydradb_connector_resource_delete",

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
	TOOL_NAMES.UPDATE,
	TOOL_NAMES.LIST,
	TOOL_NAMES.INSPECT,
	TOOL_NAMES.DELETE,
	TOOL_NAMES.STATUS,
	TOOL_NAMES.SUBGRAPH,
	TOOL_NAMES.RELATIONS,
	TOOL_NAMES.DATABASES,
	TOOL_NAMES.LIST_COLLECTIONS,
	TOOL_NAMES.DELETE_COLLECTION,
	TOOL_NAMES.FEEDBACK,
] as const;

/** Database management, registered together and gated by HYDRADB_MCP_DATABASE_TOOLS. */
export const DATABASE_TOOL_NAMES = [
	TOOL_NAMES.DATABASE_CREATE,
	TOOL_NAMES.DATABASE_DELETE,
	TOOL_NAMES.DATABASE_READINESS,
	TOOL_NAMES.DATABASE_STATS,
	TOOL_NAMES.DATABASE_SCHEMA_INSPECT,
	TOOL_NAMES.DATABASE_SCHEMA_UPDATE,
] as const;

/** The BYOG graph family, registered together and gated together. */
export const GRAPH_TOOL_NAMES = [
	TOOL_NAMES.GRAPH_QUERY,
	TOOL_NAMES.GRAPH_COLLECTIONS,
	TOOL_NAMES.GRAPH_ADMIN,
] as const;

/** Connector tools are a separately gated product family. */
export const CONNECTOR_TOOL_NAMES = [
	TOOL_NAMES.CONNECTOR_PROVIDER_LIST,
	TOOL_NAMES.CONNECTOR_PROVIDER_INSPECT,
	TOOL_NAMES.CONNECTOR_LIST,
	TOOL_NAMES.CONNECTOR_INSPECT,
	TOOL_NAMES.CONNECTOR_HEALTH,
	TOOL_NAMES.CONNECTOR_CONNECT,
	TOOL_NAMES.CONNECTOR_RECONNECT,
	TOOL_NAMES.CONNECTOR_UPDATE,
	TOOL_NAMES.CONNECTOR_DELETE,
	TOOL_NAMES.CONNECTOR_SYNC,
	TOOL_NAMES.CONNECTOR_PAUSE,
	TOOL_NAMES.CONNECTOR_RESUME,
	TOOL_NAMES.CONNECTOR_DISCOVER,
	TOOL_NAMES.CONNECTOR_RESOURCE_LIST,
	TOOL_NAMES.CONNECTOR_RESOURCE_ADD,
	TOOL_NAMES.CONNECTOR_RESOURCE_UPDATE,
	TOOL_NAMES.CONNECTOR_RESOURCE_DELETE,
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
