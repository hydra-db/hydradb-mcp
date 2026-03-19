/**
 * Tool descriptions for the Hydra DB MCP server.
 * Kept in a separate file for easy editing and localisation.
 */

import { TOOL_NAMES } from "./tool-names.js";

export const TOOL_DESCRIPTIONS = {
	[TOOL_NAMES.SEARCH]: {
		title: "Search Hydra DB Memory",
		description:
			"Search through Hydra DB State-of-the-art agentic memories. Returns relevant chunks with " +
			"graph-enriched context including entity paths and knowledge graph relations. " +
			"Use this to find previously stored information, past conversations, user preferences, " +
			"or any knowledge that has been ingested into Hydra DB memory. " +
			"Supports both fast semantic search and deeper thinking mode with graph traversal.",
		params: {
			query: "The search query to find relevant memories",
			max_results:
				"Maximum number of memory chunks to return (1-50, default: 10)",
			mode: "Recall mode: 'fast' for quick semantic search, 'thinking' for deeper personalised recall with graph traversal (default: 'thinking')",
			graph_context:
				"Whether to include knowledge graph relations in results (default: true)",
		},
	},

	[TOOL_NAMES.STORE]: {
		title: "Store to Hydra DB Memory",
		description:
			"Save important information to Hydra DB State-of-the-art agentic memory. Use this to persist " +
			"facts, preferences, decisions, notes, or any text the user wants remembered across " +
			"sessions. Hydra DB automatically extracts insights, preferences, and builds a knowledge " +
			"graph from the stored content. Supports plain text and markdown.",
		params: {
			text: "The information to store in memory",
			title: "Optional title for the memory entry (default: 'MCP Memory')",
			source_id:
				"Optional source identifier to group related memories together. You can use this as " +
				"your session ID or any other unique identifier for a conversation",
			infer: "Whether Hydra DB should extract insights and build knowledge graph from this text (default: true)",
			is_markdown:
				"Whether the text is in markdown format (default: false)",
		},
	},

	[TOOL_NAMES.INGEST_CONVERSATION]: {
		title: "Ingest Conversation",
		description:
			"Ingest one or more user-assistant conversation turns into Hydra DB memory. " +
			"Hydra DB will extract insights, preferences, and knowledge graph entities from the " +
			"conversation. Use this to store conversation history so it can be recalled later. " +
			"Each turn is a pair of user message and assistant response.",
		params: {
			turns: "Array of conversation turns, each with a 'user' and 'assistant' field",
			source_id:
				"Source identifier to group all turns from the same session together",
			user_name:
				"Optional name of the user for personalisation (default: 'User')",
		},
	},

	[TOOL_NAMES.LIST_MEMORIES]: {
		title: "List Memories",
		description:
			"List all stored user memories in Hydra DB. Returns memory IDs and their content. " +
			"Use this to browse what has been stored, verify memories exist, or find memory IDs " +
			"for deletion.",
	},

	[TOOL_NAMES.DELETE_MEMORY]: {
		title: "Delete Memory",
		description:
			"Delete a specific user memory from Hydra DB by its memory ID. " +
			`Use ${TOOL_NAMES.LIST_MEMORIES} first to find the memory ID you want to delete. ` +
			"This action is irreversible.",
		params: {
			memory_id: "The ID of the memory to delete",
		},
	},

	[TOOL_NAMES.FETCH_CONTENT]: {
		title: "Fetch Source Content",
		description:
			"Fetch the full content of a specific source by its source ID from Hydra DB. " +
			"Returns the original text content that was ingested. Use this to retrieve " +
			"the complete content of a previously stored source.",
		params: {
			source_id: "The source ID to fetch content for",
			mode: "Fetch mode: 'content' for text, 'url' for presigned URL, 'both' for both (default: 'content')",
		},
	},

	[TOOL_NAMES.LIST_SOURCES]: {
		title: "List Sources",
		description:
			"List all ingested sources in Hydra DB memory. Returns source IDs, titles, types, " +
			"and metadata. Use this to see what data sources have been ingested and to find " +
			"source IDs for fetching content.",
		params: {
			source_ids:
				"Optional array of specific source IDs to filter by. If omitted, lists all sources.",
		},
	},
} as const;

export const SERVER_INSTRUCTIONS =
	"Hydra DB MCP server for State-of-the-art agentic memory management. " +
	`Use ${TOOL_NAMES.SEARCH} to find relevant memories and knowledge graph context. ` +
	`Use ${TOOL_NAMES.STORE} to save important information for future recall. ` +
	`Use ${TOOL_NAMES.INGEST_CONVERSATION} to store conversation history. ` +
	`Use ${TOOL_NAMES.LIST_MEMORIES} to browse stored memories. ` +
	`Use ${TOOL_NAMES.DELETE_MEMORY} to remove specific memories. ` +
	`Use ${TOOL_NAMES.FETCH_CONTENT} to retrieve full source content. ` +
	`Use ${TOOL_NAMES.LIST_SOURCES} to see all ingested data sources. ` +
	"All tools require a valid Hydra DB API key and tenant ID configured via environment variables.";

	