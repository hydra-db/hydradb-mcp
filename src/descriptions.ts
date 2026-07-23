/**
 * Tool descriptions for the Hydra DB MCP server.
 * Kept in a separate file for easy editing and localisation.
 *
 * Every canonical tool (CONTRACT §3) and every deprecated alias has an entry.
 * Alias descriptions are prefixed with a DEPRECATED notice naming the canonical
 * replacement so the model prefers the new name.
 */

import { ALIAS_REPLACEMENTS, TOOL_NAMES } from "./tool-names.js";

// Shared parameter blurbs, reused across canonical tools and their aliases.
const PARAM = {
	query: "The search query to find relevant memories",
	max_results: "Maximum number of memory chunks to return (1-50, default: 10)",
	mode: "Recall mode: 'fast' for quick semantic search, 'thinking' for deeper personalised recall with graph traversal (default: 'thinking')",
	graph_context:
		"Whether to include knowledge graph relations in results (default: true)",
	text: "The information to store in memory",
	title: "Optional title for the memory entry (default: 'MCP Memory')",
	source_id:
		"Optional source identifier to group related memories together. You can use this as " +
		"your session ID or any other unique identifier for a conversation",
	infer: "Whether Hydra DB should extract insights and build knowledge graph from this text (default: true)",
	is_markdown: "Whether the text is in markdown format (default: false)",
	turns: "Array of conversation turns, each with a 'user' and 'assistant' field",
	user_name: "Optional name of the user for personalisation (default: 'User')",
	kind: "Which context family to list: 'memory' or 'knowledge' (default: 'memory')",
	source_ids:
		"Optional array of specific source IDs to filter by. If omitted, lists all sources.",
	fetch_source_id: "The source ID to fetch content for",
	fetch_mode:
		"Fetch mode: 'content' for text, 'url' for presigned URL, 'both' for both (default: 'content')",
	delete_id: "The ID of the item to delete",
	delete_kind:
		"Which context family the ID belongs to: 'memory' or 'knowledge' (default: 'memory')",
	memory_id: "The ID of the memory to delete",
} as const;

function deprecated(alias: string, body: string): string {
	return `DEPRECATED — use \`${ALIAS_REPLACEMENTS[alias]}\` instead. ${body}`;
}

const SEARCH_BODY =
	"Search through Hydra DB State-of-the-art agentic memories. Returns relevant chunks with " +
	"graph-enriched context including entity paths and knowledge graph relations. " +
	"Use this to find previously stored information, past conversations, user preferences, " +
	"or any knowledge that has been ingested into Hydra DB memory. " +
	"Supports both fast semantic search and deeper thinking mode with graph traversal.";

const STORE_BODY =
	"Save important information to Hydra DB State-of-the-art agentic memory. Use this to persist " +
	"facts, preferences, decisions, notes, or any text the user wants remembered across " +
	"sessions. Hydra DB automatically extracts insights, preferences, and builds a knowledge " +
	"graph from the stored content. Supports plain text and markdown.";

const CONVERSATION_BODY =
	"Ingest one or more user-assistant conversation turns into Hydra DB memory. " +
	"Hydra DB will extract insights, preferences, and knowledge graph entities from the " +
	"conversation. Use this to store conversation history so it can be recalled later. " +
	"Each turn is a pair of user message and assistant response.";

const LIST_MEMORIES_BODY =
	"List all stored user memories in Hydra DB. Returns memory IDs and their content. " +
	"Use this to browse what has been stored, verify memories exist, or find memory IDs " +
	"for deletion.";

const LIST_SOURCES_BODY =
	"List all ingested sources in Hydra DB memory. Returns source IDs, titles, types, " +
	"and metadata. Use this to see what data sources have been ingested and to find " +
	"source IDs for fetching content.";

const INSPECT_BODY =
	"Fetch the full content of a specific source by its source ID from Hydra DB. " +
	"Returns the original text content that was ingested. Use this to retrieve " +
	"the complete content of a previously stored source.";

export const TOOL_DESCRIPTIONS = {
	// --- Canonical tools (CONTRACT §3) ---

	[TOOL_NAMES.QUERY]: {
		title: "Query Hydra DB",
		description: SEARCH_BODY,
		params: {
			query: PARAM.query,
			max_results: PARAM.max_results,
			mode: PARAM.mode,
			graph_context: PARAM.graph_context,
		},
	},

	[TOOL_NAMES.INGEST]: {
		title: "Ingest into Hydra DB",
		description:
			STORE_BODY +
			" To ingest a conversation instead of a single note, provide `turns` " +
			"(user/assistant pairs) rather than `text`.",
		params: {
			text: PARAM.text,
			title: PARAM.title,
			source_id: PARAM.source_id,
			infer: PARAM.infer,
			is_markdown: PARAM.is_markdown,
			turns: "Optional conversation turns to ingest instead of `text`; each has a 'user' and 'assistant' field",
			user_name: PARAM.user_name,
		},
	},

	[TOOL_NAMES.LIST]: {
		title: "List Hydra DB Context",
		description:
			"List stored memories or ingested knowledge sources in Hydra DB. " +
			"Use `kind` to choose which family to browse.",
		params: {
			kind: PARAM.kind,
			source_ids: PARAM.source_ids,
		},
	},

	[TOOL_NAMES.INSPECT]: {
		title: "Inspect Hydra DB Source",
		description: INSPECT_BODY,
		params: {
			source_id: PARAM.fetch_source_id,
			mode: PARAM.fetch_mode,
		},
	},

	[TOOL_NAMES.DELETE]: {
		title: "Delete from Hydra DB",
		description:
			"Delete a memory or knowledge source from Hydra DB by its ID. " +
			"Use `kind` to select which family the ID belongs to. This action is irreversible.",
		params: {
			id: PARAM.delete_id,
			kind: PARAM.delete_kind,
		},
	},

	// --- Deprecated aliases ---

	[TOOL_NAMES.SEARCH]: {
		title: "Search Hydra DB Memory (deprecated)",
		description: deprecated(TOOL_NAMES.SEARCH, SEARCH_BODY),
		params: {
			query: PARAM.query,
			max_results: PARAM.max_results,
			mode: PARAM.mode,
			graph_context: PARAM.graph_context,
		},
	},

	[TOOL_NAMES.STORE]: {
		title: "Store to Hydra DB Memory (deprecated)",
		description: deprecated(TOOL_NAMES.STORE, STORE_BODY),
		params: {
			text: PARAM.text,
			title: PARAM.title,
			source_id: PARAM.source_id,
			infer: PARAM.infer,
			is_markdown: PARAM.is_markdown,
		},
	},

	[TOOL_NAMES.INGEST_CONVERSATION]: {
		title: "Ingest Conversation (deprecated)",
		description: deprecated(TOOL_NAMES.INGEST_CONVERSATION, CONVERSATION_BODY),
		params: {
			turns: PARAM.turns,
			source_id:
				"Source identifier to group all turns from the same session together",
			user_name: PARAM.user_name,
		},
	},

	[TOOL_NAMES.LIST_MEMORIES]: {
		title: "List Memories (deprecated)",
		description: deprecated(TOOL_NAMES.LIST_MEMORIES, LIST_MEMORIES_BODY),
	},

	[TOOL_NAMES.LIST_SOURCES]: {
		title: "List Sources (deprecated)",
		description: deprecated(TOOL_NAMES.LIST_SOURCES, LIST_SOURCES_BODY),
		params: {
			source_ids: PARAM.source_ids,
		},
	},

	[TOOL_NAMES.FETCH_CONTENT]: {
		title: "Fetch Source Content (deprecated)",
		description: deprecated(TOOL_NAMES.FETCH_CONTENT, INSPECT_BODY),
		params: {
			source_id: PARAM.fetch_source_id,
			mode: PARAM.fetch_mode,
		},
	},

	[TOOL_NAMES.DELETE_MEMORY]: {
		title: "Delete Memory (deprecated)",
		description: deprecated(
			TOOL_NAMES.DELETE_MEMORY,
			"Delete a specific user memory from Hydra DB by its memory ID. This action is irreversible.",
		),
		params: {
			memory_id: PARAM.memory_id,
		},
	},
} as const;

export const SERVER_INSTRUCTIONS =
	"Hydra DB MCP server for State-of-the-art agentic memory management. " +
	`Use ${TOOL_NAMES.QUERY} to find relevant memories and knowledge graph context. ` +
	`Use ${TOOL_NAMES.INGEST} to save information (a note via 'text', or a conversation via 'turns'). ` +
	`Use ${TOOL_NAMES.LIST} to browse stored memories or knowledge sources. ` +
	`Use ${TOOL_NAMES.INSPECT} to retrieve the full content of a source. ` +
	`Use ${TOOL_NAMES.DELETE} to remove a memory or knowledge source. ` +
	"Deprecated aliases remain available for backward compatibility but should not be used in new integrations: " +
	`${TOOL_NAMES.SEARCH} → ${TOOL_NAMES.QUERY}, ` +
	`${TOOL_NAMES.STORE} → ${TOOL_NAMES.INGEST}, ` +
	`${TOOL_NAMES.INGEST_CONVERSATION} → ${TOOL_NAMES.INGEST}, ` +
	`${TOOL_NAMES.LIST_MEMORIES} → ${TOOL_NAMES.LIST}, ` +
	`${TOOL_NAMES.LIST_SOURCES} → ${TOOL_NAMES.LIST}, ` +
	`${TOOL_NAMES.FETCH_CONTENT} → ${TOOL_NAMES.INSPECT}, ` +
	`${TOOL_NAMES.DELETE_MEMORY} → ${TOOL_NAMES.DELETE}. ` +
	"All tools require a valid Hydra DB API key and tenant ID configured via environment variables.";
