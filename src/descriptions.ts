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
	query:
		"What you want to know, as a natural-language question or topic — this is semantic " +
		"search, so a full question beats keywords. Search for the CONCEPT, not the words " +
		"the user used: 'database migration decisions' will find a memory written as 'we " +
		"settled on Atlas for schema changes'.",
	query_kind:
		"Which context family to search: 'memory' for stored user memories, " +
		"'knowledge' for ingested documents and sources, or 'all' for both " +
		"(default: 'all'). Leave unset unless you specifically want to exclude one family.",
	max_results:
		"Maximum CHUNKS to return (1-50, default: 10). Chunks, not whole memories or " +
		"documents — several chunks often come from one source. Raise to 20-30 for broad " +
		"coverage of a topic; drop to 3-5 when you want one specific fact and a small " +
		"response.",
	mode:
		"'thinking' (default) runs graph traversal and personalised reranking: a few " +
		"seconds, best recall — use it when the answer matters or the question is about " +
		"the user. 'fast' is plain semantic search and is markedly quicker — use it for a " +
		"lookup you expect to hit, or when issuing several queries in a row. 'auto' lets " +
		"Hydra DB pick based on the query.",
	operator:
		"How to combine the terms in your query: 'or' (default) matches any, 'and' " +
		"requires all, 'phrase' matches the words together in order. Reach for 'phrase' " +
		"when looking up an exact string such as an error message or a config key.",
	expiry_seconds:
		"How long the download link stays valid, in seconds. Only meaningful with " +
		"mode 'url' or 'both'; ignored otherwise.",
	graph_context:
		"Include knowledge-graph relations (default: true). These are the entity paths — " +
		"(Alice)-[prefers]->(Tea) — that connect facts across separate memories, and they " +
		"often carry the answer the matching text alone does not. Set false only when you " +
		"want the raw matching text and nothing else.",
	text:
		"The information to store. Provide EXACTLY ONE of `text` or `turns` — passing " +
		"both is an error, and so is passing neither. Write it standalone: it must still " +
		"make sense months from now with no surrounding conversation, so resolve pronouns " +
		"and relative dates ('in March 2026', not 'last week').",
	ingest_kind:
		"What to write: 'memory' for a personal fact, preference or conversation " +
		"(default), or 'knowledge' to store a document as a searchable source. " +
		"Memory-only options (turns, source_id, infer, is_markdown, user_name) do not " +
		"apply to knowledge and are rejected rather than ignored.",
	title:
		"A short, specific label — always set it. This is the ONLY label shown next to " +
		"this entry in later hydradb_query results, so 'Deployment rollback policy' is " +
		"useful where a generic one tells you nothing. If omitted, a title is derived " +
		"from the first line of the text, which is rarely as good as one you choose.",
	source_id:
		"Optional identifier for this entry. Ingesting again with an existing source_id " +
		"REPLACES everything previously stored under it — it does not add to it. Use a fresh " +
		"id (or leave it unset) for each new fact, and reuse an id only when you deliberately " +
		"mean to overwrite, such as correcting a memory you saved earlier. Leave unset if unsure.",
	overwrite:
		"Whether ingesting with an existing source_id may replace what is stored there " +
		"(default: true). Set false to have the server reject the write instead of " +
		"overwriting, when you expect to be creating something new.",
	infer:
		"Let Hydra DB extract insights and knowledge-graph entities from this text " +
		"(default: true). Keep it true for anything about the user or their work — that " +
		"extraction is what makes the content findable by concept later. Set false only to " +
		"store text verbatim with no interpretation (a config snippet, an exact error " +
		"string, a code block).",
	is_markdown:
		"Set true when `text` contains markdown (headings, lists, code fences) so Hydra DB " +
		"chunks on structure instead of splitting mid-section. Default false.",
	turns: "Array of conversation turns, each with a 'user' and 'assistant' field",
	user_name:
		"What to call the user in the stored conversation (default: 'User'). Set it when " +
		"you know their actual name, so extracted facts read as being about a person " +
		"rather than about an anonymous participant. Applies to `turns` only.",
	kind:
		"Which family to list: 'memory' (stored memories) or 'knowledge' (ingested " +
		"sources). REQUIRED — these are separate corpora with different output, and no " +
		"single listing covers both. Call this twice to see everything.",
	source_ids:
		"Optional array of specific source IDs to filter by. If omitted, lists all sources.",
	page:
		"Which page of results to return, 1-indexed (default: 1). The response reports how " +
		"many of the total it showed; pass the next page to continue rather than assuming " +
		"the first page is everything.",
	page_size:
		"How many items to return per page (1-100). Defaults to the server's page size. " +
		"Raise it to see more at once; lower it to keep the response small.",
	detail:
		"How much of each matching chunk to return. 'compact' (default) trims each " +
		"chunk to its first ~600 characters and omits the surrounding-context blocks — " +
		"enough to judge relevance and pick a source to inspect. 'full' returns every " +
		"chunk whole; use it when the snippets are being cut off mid-answer. Either way " +
		"the response is capped, and hydradb_inspect returns any single source in full.",
	fetch_source_id: "The source ID to fetch content for",
	fetch_mode:
		"'content' (default) returns the text — normally what you want. 'url' returns a " +
		"short-lived presigned download link INSTEAD of the text, for binary sources or " +
		"when handing the user a download. 'both' returns text and link.",
	fetch_offset:
		"Character offset to start reading from (default: 0). Long sources are returned " +
		"in slices; the response says where it stopped and what offset to pass next.",
	fetch_limit:
		"Maximum characters of text to return (default and maximum: 20000). Lower it when " +
		"you only need the beginning of a long document.",
	delete_id: "The ID of the item to delete",
	delete_kind:
		"Which context family the ID belongs to: 'memory' or 'knowledge' (default: 'memory')",
	memory_id: "The ID of the memory to delete",
} as const;

function deprecated(alias: string, body: string): string {
	return `DEPRECATED — use \`${ALIAS_REPLACEMENTS[alias]}\` instead. ${body}`;
}

const SEARCH_BODY = `Search Hydra DB for anything the user has stored: memories (facts, preferences, decisions, past conversations) and ingested knowledge sources (documents, files, playbooks). Returns matching chunks with their source id, a relevance score, and knowledge-graph context — the entity paths and relations that connect facts across separate sources.

CALL THIS BEFORE ANSWERING whenever the answer could depend on the user's history, preferences, prior decisions, project details, or a document they have ingested — including when you are merely unsure. A query that returns nothing costs one call; answering from a blank slate costs the user a correction.

Searches both families by default. Every result carries \`[id: …]\` — pass it to hydradb_inspect for the full source, or to hydradb_delete to remove it.

Examples:
  {"query": "how does the user prefer code review feedback"}
  {"query": "postgres connection pooling decision", "kind": "knowledge"}
  {"query": "deploy checklist", "mode": "fast", "max_results": 5}`;

const STORE_BODY = `Save information to Hydra DB so it outlives this session. Hydra DB extracts insights, preferences and knowledge-graph entities from what you store.

Provide EXACTLY ONE of:
  \`text\`  — a note, fact, decision, or document body
  \`turns\` — user/assistant pairs from a conversation
Passing both is an error; passing neither is an error.

Save proactively: when the user states a preference, makes a decision, corrects you, or reveals a durable fact about themselves or their work, store it without being asked. Store the distilled fact rather than the raw exchange, and always set \`title\` — it is the only label shown next to this entry in later search results. Before saving something you suspect is already stored, query for it first rather than adding a near-duplicate.

Never store secrets, credentials, or anything the user asked you not to keep.

Examples:
  {"text": "Prefers tabs over spaces in every language; rejected two prettier configs that used spaces.", "title": "Indentation preference"}
  {"turns": [{"user": "let's go with Postgres", "assistant": "Agreed, I'll set up the schema."}], "title": "Datastore decision"}
  {"text": "# Runbook\\n\\nRestart order: api, worker, scheduler.", "kind": "knowledge", "title": "Restart runbook"}`;

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

const INSPECT_BODY = `Fetch the full original content of ONE stored item by its id. Use it after hydradb_query or hydradb_list when a truncated chunk or listing row is not enough and you need the whole document.

The id is the value shown as \`[id: …]\` in hydradb_query results and in [brackets] in hydradb_list output. Ids are not guessable — take one from those tools rather than constructing it.

Long sources come back in slices; the response says where it stopped and what offset continues it. Binary sources are never inlined — you get their type and size, and \`mode: "url"\` returns a download link.`;

export const TOOL_DESCRIPTIONS = {
	// --- Canonical tools (CONTRACT §3) ---

	[TOOL_NAMES.QUERY]: {
		title: "Query Hydra DB",
		description: SEARCH_BODY,
		params: {
			query: PARAM.query,
			kind: PARAM.query_kind,
			max_results: PARAM.max_results,
			mode: PARAM.mode,
			graph_context: PARAM.graph_context,
			detail: PARAM.detail,
			operator: PARAM.operator,
		},
	},

	[TOOL_NAMES.INGEST]: {
		title: "Ingest into Hydra DB",
		// STORE_BODY already states the text/turns rule as "exactly one of". The
		// sentence that used to be appended here said "provide `turns` … rather
		// than `text`", which reads as a preference between two allowed options
		// and contradicts it.
		description: STORE_BODY,
		params: {
			text: PARAM.text,
			kind: PARAM.ingest_kind,
			title: PARAM.title,
			source_id: PARAM.source_id,
			infer: PARAM.infer,
			is_markdown: PARAM.is_markdown,
			overwrite: PARAM.overwrite,
			turns:
				"The conversation to ingest, oldest first, as [{user, assistant}, ...]. Provide " +
				"EXACTLY ONE of `text` or `turns` — passing both is an error, and so is passing " +
				"neither. Use this when the exchange itself is worth preserving; when only the " +
				"conclusion matters, prefer `text` with the distilled fact.",
			user_name: PARAM.user_name,
		},
	},

	[TOOL_NAMES.LIST]: {
		title: "List Hydra DB Context",
		description: `Enumerate what is stored in Hydra DB — every memory (kind: "memory") or every knowledge source (kind: "knowledge"). These are SEPARATE corpora and this tool returns one at a time: listing memories tells you nothing about which knowledge sources exist, and vice versa. Call it twice to see everything.

Use it for inventory questions ("what do you remember about me?", "which documents are indexed?") and to obtain ids. For "what do you know about X", use hydradb_query instead — listing everything and reading it is far more expensive and loses relevance ranking.

Results are paginated. The response says how many of the total it showed and how to reach the rest; do not treat the first page as the whole store.

Memory rows come back as [id] content. Knowledge rows as [id] — title (type), with no content — pass an id to hydradb_inspect for the text.`,
		params: {
			kind: PARAM.kind,
			source_ids: PARAM.source_ids,
			page: PARAM.page,
			page_size: PARAM.page_size,
		},
	},

	[TOOL_NAMES.INSPECT]: {
		title: "Inspect Hydra DB Source",
		description: INSPECT_BODY,
		params: {
			source_id: PARAM.fetch_source_id,
			mode: PARAM.fetch_mode,
			offset: PARAM.fetch_offset,
			limit: PARAM.fetch_limit,
			expiry_seconds: PARAM.expiry_seconds,
		},
	},

	[TOOL_NAMES.DELETE]: {
		title: "Delete from Hydra DB",
		description: `Permanently remove one memory or one knowledge source from Hydra DB by id. This cannot be undone; there is no trash.

Take the id from hydradb_query or hydradb_list — never guess one. Confirm with the user before deleting anything they did not name: "forget that I use vim" authorises deleting that memory; "clean up my memories" authorises nothing until they have seen the list.

\`kind\` must match the family the id belongs to. A knowledge source id passed with kind "memory" reports that nothing was deleted while the source is still there.`,
		params: {
			id: PARAM.delete_id,
			kind: PARAM.delete_kind,
		},
	},

	[TOOL_NAMES.STATUS]: {
		title: "Check Hydra DB Indexing Status",
		description:
			"Check whether ingested sources have finished indexing. Ingestion is " +
			"asynchronous: hydradb_ingest returns as soon as the source is queued, and " +
			"the content is not searchable until indexing reaches a terminal state. " +
			"Use this after ingesting when you need to confirm the write landed — " +
			"an empty hydradb_query result shortly after an ingest usually means " +
			"'still indexing', not 'the save failed'.",
		params: {
			ids: "The source IDs to check, as returned by hydradb_ingest.",
		},
	},

	// --- Deprecated aliases ---

	[TOOL_NAMES.SEARCH]: {
		title: "Search Hydra DB Memory (deprecated)",
		description: deprecated(TOOL_NAMES.SEARCH, SEARCH_BODY),
		params: {
			query: PARAM.query,
			kind: PARAM.query_kind,
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
			overwrite: PARAM.overwrite,
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
			offset: PARAM.fetch_offset,
			limit: PARAM.fetch_limit,
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

export const SERVER_INSTRUCTIONS = `Hydra DB is the user's persistent memory across sessions. It holds two separate families: memory (facts, preferences, decisions, past conversations) and knowledge (ingested documents and sources). ${TOOL_NAMES.QUERY} searches both together.

WHEN TO USE IT

- Before answering anything that could depend on the user's history, preferences, prior decisions, project details, or a document they have ingested, call ${TOOL_NAMES.QUERY} FIRST — including when you are merely unsure. One query at the start of a task is cheap; answering from a blank slate costs the user a correction. Never ask the user to repeat something Hydra DB may already hold.
- After the user states a preference, makes a decision, corrects you, or reveals a durable fact about themselves or their work, call ${TOOL_NAMES.INGEST} to save it without being asked. Save the distilled fact, not the transcript: "prefers pnpm over npm in every repo", not "user said maybe we should try pnpm".
- Never store secrets, credentials, one-off task chatter, or anything the user asked you not to keep.
- "Remember this" maps to ${TOOL_NAMES.INGEST}, "forget that" to ${TOOL_NAMES.DELETE}, and "what do you know about me" to ${TOOL_NAMES.QUERY} — do not answer that last one from the current conversation alone.

THE TOOLS

- ${TOOL_NAMES.QUERY} — semantic search across memory and knowledge, with knowledge-graph context. Your default read. Every result carries an id.
- ${TOOL_NAMES.INGEST} — write. A note or document via 'text', or a conversation via 'turns' (exactly one of the two).
- ${TOOL_NAMES.LIST} — the full inventory of ONE family. Use it for "what do you have?"; for "what do you know about X" use ${TOOL_NAMES.QUERY} instead.
- ${TOOL_NAMES.INSPECT} — the complete original content of one source you already have an id for.
- ${TOOL_NAMES.DELETE} — irreversible removal of one item by id.
- ${TOOL_NAMES.STATUS} — whether an ingested source has finished indexing. Ingestion is asynchronous, so a query issued straight after a save can legitimately return nothing.

Ids flow between these: ${TOOL_NAMES.QUERY} and ${TOOL_NAMES.LIST} emit them, ${TOOL_NAMES.INSPECT}, ${TOOL_NAMES.DELETE} and ${TOOL_NAMES.STATUS} accept them. Never invent one.

All tools require HYDRADB_API_KEY and HYDRADB_DATABASE in the environment.`;
