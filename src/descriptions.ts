/**
 * Tool descriptions for the Hydra DB MCP server.
 * Kept in a separate file for easy editing and localisation.
 */

export const TOOL_DESCRIPTIONS = {
	cortex_search: {
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

	cortex_store: {
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
			infer: "Whether Cortex should extract insights and build knowledge graph from this text (default: true)",
			is_markdown:
				"Whether the text is in markdown format (default: false)",
		},
	},

	cortex_ingest_conversation: {
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

	cortex_list_memories: {
		title: "List Memories",
		description:
			"List all stored user memories in Hydra DB. Returns memory IDs and their content. " +
			"Use this to browse what has been stored, verify memories exist, or find memory IDs " +
			"for deletion.",
	},

	cortex_delete_memory: {
		title: "Delete Memory",
		description:
			"Delete a specific user memory from Hydra DB by its memory ID. " +
			"Use cortex_list_memories first to find the memory ID you want to delete. " +
			"This action is irreversible.",
		params: {
			memory_id: "The ID of the memory to delete",
		},
	},

	cortex_fetch_content: {
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

	cortex_list_sources: {
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
	"Use cortex_search to find relevant memories and knowledge graph context. " +
	"Use cortex_store to save important information for future recall. " +
	"Use cortex_ingest_conversation to store conversation history. " +
	"Use cortex_list_memories to browse stored memories. " +
	"Use cortex_delete_memory to remove specific memories. " +
	"Use cortex_fetch_content to retrieve full source content. " +
	"Use cortex_list_sources to see all ingested data sources. " +
	"All tools require a valid Hydra DB API key and tenant ID configured via environment variables.";
