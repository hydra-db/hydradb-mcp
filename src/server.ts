import { createRequire } from "node:module";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { toAddMemoryResponse, toMemoryList, toRecallResponse, toSourceList } from "./adapters.js";
import type { PageInfo } from "./adapters.js";
import { resolveConfig } from "./config.js";
import { buildRecalledContext } from "./context.js";
import { SERVER_INSTRUCTIONS, TOOL_DESCRIPTIONS } from "./descriptions.js";
import { HydraDB } from "./hydra/index.js";
import type { QueryKind } from "./hydra/index.js";
import { logger } from "./logger.js";
import { ALIAS_REPLACEMENTS, DEPRECATED_TOOL_NAMES, TOOL_NAMES } from "./tool-names.js";
import type { MemoryResultItem } from "./types.js";

// Host-owned default: silently attached to ingest so Hydra DB extracts the kind
// of personal context this server cares about. Injected here (not in the
// portable wrapper) because it is MCP-specific host behaviour.
const INGEST_INSTRUCTIONS =
	"Focus on extracting user preferences, habits, opinions, likes, dislikes, " +
	"goals, and recurring themes. Capture any stated or implied personal context " +
	"that would help personalise future interactions.";

// Read the version from package.json rather than repeating it here: the literal
// this replaces sat at 1.0.0 through the whole 1.x line, so every client saw
// stale version metadata. `../package.json` resolves to the package root from
// both `src/` (tsx) and `dist/` (published build).
const require = createRequire(import.meta.url);
const { version: SERVER_VERSION } = require("../package.json") as {
	version: string;
};

type ToolResult = {
	content: { type: "text"; text: string }[];
};

function textResult(text: string): ToolResult {
	return { content: [{ type: "text" as const, text }] };
}

/**
 * What a query actually searched, for the result strings. A query over `all`
 * must not report "memories" — that phrasing is what taught callers the MCP
 * was memory-only in the first place.
 */
function resultNoun(kind: QueryKind, count?: number): string {
	const one = count === 1;
	if (kind === "memory") return one ? "memory" : "memories";
	if (kind === "knowledge") return one ? "knowledge source" : "knowledge sources";
	return one ? "context item" : "context items";
}

const turnSchema = z.object({
	user: z.string().describe("The user's message"),
	assistant: z.string().describe("The assistant's response"),
});

type ConversationTurn = { user: string; assistant: string };

// Deprecated aliases emit exactly one stderr warning PER PROCESS naming the
// canonical replacement (CONTRACT §3). The dedupe state is module-scoped so the
// guarantee holds across multiple server instances in the same process, and is
// intentionally NOT routed through `logger` — the warning must surface
// regardless of HYDRA_DB_LOG_LEVEL.
const warnedAliases = new Set<string>();
function warnDeprecatedAlias(name: string) {
	if (warnedAliases.has(name)) return;
	warnedAliases.add(name);
	const replacement = ALIAS_REPLACEMENTS[name] ?? "a canonical tool";
	console.error(
		`[hydradb-mcp] Tool "${name}" is deprecated and will be removed in a future major version; use "${replacement}" instead.`,
	);
}

/** Test-only: reset the once-per-process alias warning dedupe. */
export function __resetAliasWarnings() {
	warnedAliases.clear();
}

export function createHydraDBServer(hydraOverride?: HydraDB) {
	const server = new McpServer(
		{
			name: "hydradb-mcp",
			version: SERVER_VERSION,
		},
		{
			instructions: SERVER_INSTRUCTIONS,
		},
	);

	let hydra: HydraDB;
	if (hydraOverride) {
		hydra = hydraOverride;
	} else {
		const config = resolveConfig();
		hydra = new HydraDB({
			token: config.apiKey,
			database: config.database,
			collection: config.collection,
			...(config.baseUrl != null ? { baseUrl: config.baseUrl } : {}),
		});
		logger.info(
			`Hydra DB connected (database=${config.database}, collection=${config.collection})`,
		);
	}

	// --- Handlers (shared by canonical tools and their deprecated aliases) ---

	async function runQuery(args: {
		query: string;
		kind?: QueryKind;
		max_results?: number;
		mode?: "fast" | "thinking";
		graph_context?: boolean;
	}): Promise<ToolResult> {
		// Host-owned default (CONTRACT §2 rule 5): search BOTH families. This tool
		// used to pin `kind: "memory"`, which made every ingested knowledge source
		// unreachable from the MCP — `hydradb_list`/`hydradb_inspect` could browse
		// knowledge but nothing could search it.
		const kind = args.kind ?? "all";
		logger.debug(`${TOOL_NAMES.QUERY}: "${args.query}" (kind=${kind})`);

		const raw = await hydra.context.query({
			query: args.query,
			kind,
			maxResults: args.max_results ?? 10,
			mode: args.mode ?? "thinking",
			graphContext: args.graph_context ?? true,
			alpha: 0.8,
			recencyBias: 0,
		});
		const res = toRecallResponse(raw);

		if (!res.chunks || res.chunks.length === 0) {
			return textResult(`No relevant ${resultNoun(kind)} found in Hydra DB.`);
		}

		const contextStr = buildRecalledContext(res);
		const summary = res.chunks.slice(0, 10).map((c, i) => {
			const score =
				c.relevancy_score != null
					? ` (${Math.round(c.relevancy_score * 100)}%)`
					: "";
			const snippet =
				c.chunk_content.length > 150
					? `${c.chunk_content.slice(0, 150)}...`
					: c.chunk_content;
			return `${i + 1}. [id: ${c.source_id || "unknown"}]${score} ${snippet}`;
		});

		// An id the caller cannot connect to anything is just noise, so name what
		// accepts it. Without this the ids read as internal bookkeeping.
		const legend =
			`\n\n---\nEach [id: …] is a source id: pass one to ${TOOL_NAMES.INSPECT} for that ` +
			`source's full content, or to ${TOOL_NAMES.DELETE} to remove it.`;

		return textResult(
			`Found ${res.chunks.length} ${resultNoun(kind, res.chunks.length)}:\n\n${summary.join("\n")}\n\n---\nFull context:\n${contextStr}${legend}`,
		);
	}

	/**
	 * The id the server assigned to the item it just stored.
	 *
	 * On the memory path the caller may supply `source_id`, but when it does not
	 * the server assigns one — and that value appeared nowhere in the tool result,
	 * so the caller could not later inspect, correct or delete what it had
	 * written. Reads the first successful item; ingest here is always one item.
	 */
	function createdId(res: { results: MemoryResultItem[] }): string | undefined {
		for (const item of res.results) {
			if (item.source_id && !item.error) return item.source_id;
		}
		return undefined;
	}

	/** Keep one server-supplied message from crowding out the rest of the result. */
	function briefly(message: string): string {
		return message.length > 200 ? `${message.slice(0, 200)}…` : message;
	}

	/**
	 * Per-item detail for an ingest that did not fully succeed.
	 *
	 * Two distinct outcomes are worth reporting and neither is visible in the
	 * counts alone:
	 *
	 *   - a failed item, where the caller needs the id and the reason to retry
	 *     just that one rather than re-ingesting everything;
	 *   - an item the server stored but could not extract relations from, which
	 *     is a partial success. It is findable by text and unreachable by graph
	 *     traversal, and `failed_count` stays 0 — so without this line it looks
	 *     identical to a clean ingest.
	 *
	 * Returns "" when there is nothing to say, so the success path stays quiet.
	 */
	function ingestIssues(res: { results: MemoryResultItem[] }): string {
		const lines: string[] = [];
		for (const item of res.results) {
			const label = item.source_id || item.title || "(unnamed item)";
			const failure =
				item.error ?? (item.status === "failed" ? "ingestion failed" : null);
			if (failure) {
				const code = item.error_code ? ` [${item.error_code}]` : "";
				lines.push(`  - ${label}: ${briefly(failure)}${code}`);
			} else if (item.relations_error) {
				lines.push(
					`  - ${label}: stored, but graph extraction failed — ${briefly(item.relations_error)}. ` +
					`It is searchable by text but will not be reached by graph traversal.`,
				);
			}
		}
		return lines.length > 0 ? `\n\nIssues:\n${lines.join("\n")}` : "";
	}

	async function runStore(args: {
		text: string;
		title?: string;
		source_id?: string;
		infer?: boolean;
		is_markdown?: boolean;
	}): Promise<ToolResult> {
		logger.debug(`${TOOL_NAMES.INGEST}: "${args.text.slice(0, 50)}..."`);

		const raw = await hydra.context.ingest({
			kind: "memory",
			text: args.text,
			title: args.title ?? "MCP Memory",
			sourceId: args.source_id,
			infer: args.infer ?? true,
			isMarkdown: args.is_markdown ?? false,
			customInstructions: INGEST_INSTRUCTIONS,
			upsert: true,
		});
		const res = toAddMemoryResponse(raw);

		// Was an 80-char echo of the text the caller had just sent — zero
		// information back to them. The id is the thing they do not have and
		// cannot derive, and it is what makes correcting this memory later
		// possible at all.
		const id = createdId(res) ?? args.source_id;

		return textResult(
			`Saved to Hydra DB${id ? ` (id: ${id})` : ""} ` +
			`(${res.success_count} success, ${res.failed_count} failed).` +
			ingestIssues(res),
		);
	}

	async function runIngestConversation(
		turns: ConversationTurn[],
		sourceId: string,
		opts?: {
			userName?: string;
			infer?: boolean;
			title?: string;
			isMarkdown?: boolean;
		},
	): Promise<ToolResult> {
		logger.debug(
			`${TOOL_NAMES.INGEST}: ${turns.length} turns -> ${sourceId}`,
		);

		const raw = await hydra.context.ingest({
			kind: "memory",
			pairs: turns,
			sourceId,
			userName: opts?.userName ?? "User",
			infer: opts?.infer ?? true,
			title: opts?.title,
			isMarkdown: opts?.isMarkdown,
			customInstructions: INGEST_INSTRUCTIONS,
			upsert: true,
		});
		const res = toAddMemoryResponse(raw);

		return textResult(
			`Ingested ${turns.length} conversation turn(s) into Hydra DB ` +
			`(id: ${createdId(res) ?? sourceId}, success: ${res.success_count}, failed: ${res.failed_count})` +
			ingestIssues(res),
		);
	}

	/**
	 * How much of the corpus this page covered, stated plainly.
	 *
	 * A listing that shows 50 of 4,000 rows and says "50 memories:" is not a
	 * truncated answer, it is a wrong one — the caller reports it as the complete
	 * inventory. Say what was shown, out of what, and how to reach the rest.
	 */
	function coverage(shown: number, page: PageInfo, requestedPage?: number): string {
		const total = page.total ?? shown;
		const current = page.page ?? requestedPage ?? 1;
		if (total <= shown && page.has_next !== true && current === 1) {
			return `${shown}`;
		}
		const more =
			page.has_next === true || total > shown
				? ` — pass page=${current + 1} for more`
				: "";
		return `${shown} of ${total} (page ${current})${more}`;
	}

	async function runListMemories(args: {
		source_ids?: string[];
		page?: number;
		page_size?: number;
	} = {}): Promise<ToolResult> {
		logger.debug(TOOL_NAMES.LIST);

		const raw = await hydra.context.list({
			kind: "memory",
			ids: args.source_ids,
			page: args.page,
			pageSize: args.page_size,
		});
		const { memories, page } = toMemoryList(raw);

		if (memories.length === 0) {
			return textResult(
				args.page != null && args.page > 1
					? `No memories on page ${args.page}.`
					: "No memories stored yet.",
			);
		}

		const lines = memories.map(
			(m, i) => `${i + 1}. [${m.memory_id}] ${m.memory_content.slice(0, 150)}`,
		);

		return textResult(
			`${coverage(memories.length, page, args.page)} memories:\n\n${lines.join("\n")}`,
		);
	}

	async function runListSources(args: {
		source_ids?: string[];
		page?: number;
		page_size?: number;
	}): Promise<ToolResult> {
		logger.debug(TOOL_NAMES.LIST);

		const raw = await hydra.context.list({
			kind: "knowledge",
			ids: args.source_ids,
			page: args.page,
			pageSize: args.page_size,
		});
		const { sources, page } = toSourceList(raw);

		if (sources.length === 0) {
			return textResult(
				args.page != null && args.page > 1
					? `No sources on page ${args.page}.`
					: "No sources found.",
			);
		}

		const lines = sources.map((s, i) => {
			const title = s.title ? ` — ${s.title}` : "";
			const type = s.type ? ` (${s.type})` : "";
			return `${i + 1}. [${s.id}]${title}${type}`;
		});

		// Was `${total} sources:` — the corpus-wide total printed above a single
		// page of rows, so "412 sources:" sat over 50 lines with no marker and no
		// way to reach the other 362.
		return textResult(
			`${coverage(sources.length, page, args.page)} sources:\n\n${lines.join("\n")}`,
		);
	}

	async function runInspect(args: {
		source_id: string;
		mode?: "content" | "url" | "both";
	}): Promise<ToolResult> {
		logger.debug(`${TOOL_NAMES.INSPECT}: ${args.source_id}`);

		const res = await hydra.context.inspect({
			id: args.source_id,
			mode: args.mode ?? "content",
		});

		// Soft failure: return a normal (non-error) text result, matching v1.
		if (!res.success || res.error) {
			return textResult(
				`Could not fetch source ${args.source_id}: ${res.error ?? "unknown error"}`,
			);
		}

		const content = res.content ?? res.contentBase64 ?? "(no text content)";

		return textResult(`Source: ${args.source_id}\n\n${content}`);
	}

	/**
	 * Three outcomes, not two. A delete that removed nothing is either the
	 * benign idempotent case (the server succeeded, there was nothing there) or
	 * a refusal (the server returned success:false and told us why). Collapsing
	 * both into "not found or already deleted" states a cause we did not
	 * observe, and it is the reassuring one: the caller is told their data is
	 * gone when the server just declined to remove it.
	 */
	function deleteReport(
		kind: "memory" | "knowledge",
		id: string,
		res: { success?: boolean; message?: string; results?: unknown },
		removed: boolean,
	): ToolResult {
		const noun = kind === "knowledge" ? "source" : "memory";
		if (removed) {
			return textResult(`Deleted ${noun}: ${id}`);
		}

		if (res.success === false) {
			const reason = deleteFailureReason(res);
			return textResult(
				`Could NOT delete ${noun} ${id} — the server refused the request` +
					`${reason ? `: ${reason}` : " and gave no reason"}. ` +
					`The ${noun} has not been removed.`,
			);
		}

		// The server succeeded and removed nothing, so no such id exists in this
		// database. "or already deleted" was the same mistake the refusal branch
		// above was written to fix: it offers a cause we did not observe, and the
		// reassuring one. A caller that invented an id — the likely case, since
		// until recently nothing emitted one — reads it as confirmation and tells
		// the user their data is gone.
		return textResult(
			`No ${noun} with id ${id} exists in this database — nothing was deleted. ` +
			`Ids come from ${TOOL_NAMES.QUERY} or ${TOOL_NAMES.LIST}; check the id rather than retrying.`,
		);
	}

	/** The server's own explanation, preferring the per-item error over the summary. */
	function deleteFailureReason(res: {
		message?: string;
		results?: unknown;
	}): string | undefined {
		const items = Array.isArray(res.results) ? res.results : [];
		for (const item of items) {
			if (item != null && typeof item === "object") {
				const error = (item as { error?: unknown }).error;
				if (typeof error === "string" && error !== "") return error;
			}
		}
		return res.message !== "" ? res.message : undefined;
	}

	async function runDelete(args: {
		id: string;
		kind?: "memory" | "knowledge";
	}): Promise<ToolResult> {
		const kind = args.kind ?? "memory";
		logger.debug(`${TOOL_NAMES.DELETE}: ${kind} ${args.id}`);

		const res = await hydra.context.delete({ ids: [args.id], kind });
		const removed =
			(res.userMemoryDeleted ?? 0) > 0 || (res.deletedCount ?? 0) > 0;
		if (!removed) {
			logger.warn(
				`${TOOL_NAMES.DELETE}: removed nothing for ${kind} ${args.id}`,
				{ success: res.success, message: res.message, results: res.results },
			);
		}

		return deleteReport(kind, args.id, res, removed);
	}

	// --- Registration helper ---

	function register(
		name: keyof typeof TOOL_DESCRIPTIONS,
		inputSchema: Record<string, unknown>,
		handler: (args: Record<string, unknown>) => Promise<ToolResult>,
		annotations?: {
			readOnlyHint?: boolean;
			openWorldHint?: boolean;
			idempotentHint?: boolean;
		},
	) {
		const desc = TOOL_DESCRIPTIONS[name];
		const isDeprecated = (DEPRECATED_TOOL_NAMES as readonly string[]).includes(name);
		const wrapped = isDeprecated
			? (args: Record<string, unknown>) => {
					warnDeprecatedAlias(name);
					return handler(args);
				}
			: handler;
		server.registerTool(
			name,
			{
				title: desc.title,
				description: desc.description,
				inputSchema: inputSchema as never,
				...(annotations ? { annotations } : {}),
			},
			wrapped as never,
		);
	}

	// --- Input schemas ---

	const querySchema = {
		query: z.string().describe(TOOL_DESCRIPTIONS[TOOL_NAMES.QUERY].params.query),
		kind: z
			.enum(["memory", "knowledge", "all"])
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.QUERY].params.kind),
		max_results: z
			.number()
			.min(1)
			.max(50)
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.QUERY].params.max_results),
		mode: z
			.enum(["fast", "thinking"])
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.QUERY].params.mode),
		graph_context: z
			.boolean()
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.QUERY].params.graph_context),
	};

	const storeSchema = {
		text: z.string().describe(TOOL_DESCRIPTIONS[TOOL_NAMES.STORE].params.text),
		title: z
			.string()
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.STORE].params.title),
		source_id: z
			.string()
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.STORE].params.source_id),
		infer: z
			.boolean()
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.STORE].params.infer),
		is_markdown: z
			.boolean()
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.STORE].params.is_markdown),
	};

	const ingestSchema = {
		...storeSchema,
		// Canonical ingest accepts EITHER `text` or `turns`, so `text` is optional
		// here (the `hydra_db_store` alias keeps it required).
		text: z
			.string()
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.INGEST].params.text),
		turns: z
			.array(turnSchema)
			.min(1)
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.INGEST].params.turns),
		user_name: z
			.string()
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.INGEST].params.user_name),
	};

	const conversationSchema = {
		turns: z
			.array(turnSchema)
			.min(1)
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.INGEST_CONVERSATION].params.turns),
		source_id: z
			.string()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.INGEST_CONVERSATION].params.source_id),
		user_name: z
			.string()
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.INGEST_CONVERSATION].params.user_name),
	};

	const listSchema = {
		kind: z
			.enum(["memory", "knowledge"])
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.LIST].params.kind),
		source_ids: z
			.array(z.string())
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.LIST].params.source_ids),
		page: z
			.number()
			.int()
			.min(1)
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.LIST].params.page),
		page_size: z
			.number()
			.int()
			.min(1)
			.max(100)
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.LIST].params.page_size),
	};

	const listSourcesSchema = {
		source_ids: z
			.array(z.string())
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.LIST_SOURCES].params.source_ids),
	};

	const inspectSchema = {
		source_id: z
			.string()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.INSPECT].params.source_id),
		mode: z
			.enum(["content", "url", "both"])
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.INSPECT].params.mode),
	};

	const deleteSchema = {
		id: z.string().describe(TOOL_DESCRIPTIONS[TOOL_NAMES.DELETE].params.id),
		kind: z
			.enum(["memory", "knowledge"])
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.DELETE].params.kind),
	};

	const deleteMemorySchema = {
		memory_id: z
			.string()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.DELETE_MEMORY].params.memory_id),
	};

	const readOnly = { readOnlyHint: true, idempotentHint: true };
	const searchAnnotations = {
		readOnlyHint: true,
		openWorldHint: true,
		idempotentHint: true,
	};

	// --- Canonical tools ---

	register(
		TOOL_NAMES.QUERY,
		querySchema,
		(args) => runQuery(args as Parameters<typeof runQuery>[0]),
		searchAnnotations,
	);

	register(TOOL_NAMES.INGEST, ingestSchema, async (args) => {
		const a = args as {
			text?: string;
			title?: string;
			source_id?: string;
			infer?: boolean;
			is_markdown?: boolean;
			turns?: ConversationTurn[];
			user_name?: string;
		};
		const hasTurns = a.turns != null && a.turns.length > 0;
		// `text` and `turns` are mutually exclusive — reject rather than silently
		// dropping one (the documented "exactly one" contract).
		if (hasTurns && a.text != null) {
			throw new Error(
				`${TOOL_NAMES.INGEST} accepts either \`text\` (a note) or \`turns\` (a conversation), not both.`,
			);
		}
		if (a.turns != null && a.turns.length > 0) {
			const sourceId = a.source_id ?? `mcp-conversation-${Date.now()}`;
			// Forward every option the canonical schema accepts so none is
			// silently dropped on the conversation path.
			return runIngestConversation(a.turns, sourceId, {
				userName: a.user_name,
				infer: a.infer,
				title: a.title,
				isMarkdown: a.is_markdown,
			});
		}
		if (a.text != null) {
			return runStore({
				text: a.text,
				title: a.title,
				source_id: a.source_id,
				infer: a.infer,
				is_markdown: a.is_markdown,
			});
		}
		throw new Error(
			`${TOOL_NAMES.INGEST} requires either \`text\` (a note) or \`turns\` (a conversation).`,
		);
	});

	register(
		TOOL_NAMES.LIST,
		listSchema,
		(args) => {
			const a = args as {
				kind?: "memory" | "knowledge";
				source_ids?: string[];
				page?: number;
				page_size?: number;
			};
			if ((a.kind ?? "memory") === "knowledge") {
				return runListSources({
					source_ids: a.source_ids,
					page: a.page,
					page_size: a.page_size,
				});
			}
			return runListMemories({
				source_ids: a.source_ids,
				page: a.page,
				page_size: a.page_size,
			});
		},
		readOnly,
	);

	register(
		TOOL_NAMES.INSPECT,
		inspectSchema,
		(args) => runInspect(args as Parameters<typeof runInspect>[0]),
		readOnly,
	);

	register(TOOL_NAMES.DELETE, deleteSchema, (args) =>
		runDelete(args as Parameters<typeof runDelete>[0]),
	);

	// --- Deprecated aliases ---

	register(
		TOOL_NAMES.SEARCH,
		querySchema,
		(args) => runQuery(args as Parameters<typeof runQuery>[0]),
		searchAnnotations,
	);

	register(TOOL_NAMES.STORE, storeSchema, (args) =>
		runStore(args as Parameters<typeof runStore>[0]),
	);

	register(TOOL_NAMES.INGEST_CONVERSATION, conversationSchema, (args) => {
		const a = args as {
			turns: ConversationTurn[];
			source_id: string;
			user_name?: string;
		};
		// The deprecated alias keeps its historical shape (user_name only; infer
		// on, no title/markdown). The canonical hydradb_ingest forwards the rest.
		return runIngestConversation(a.turns, a.source_id, { userName: a.user_name });
	});

	register(TOOL_NAMES.LIST_MEMORIES, {}, () => runListMemories(), readOnly);

	register(
		TOOL_NAMES.LIST_SOURCES,
		listSourcesSchema,
		(args) => runListSources(args as { source_ids?: string[] }),
		readOnly,
	);

	register(
		TOOL_NAMES.FETCH_CONTENT,
		inspectSchema,
		(args) => runInspect(args as Parameters<typeof runInspect>[0]),
		readOnly,
	);

	register(TOOL_NAMES.DELETE_MEMORY, deleteMemorySchema, (args) => {
		const { memory_id } = args as { memory_id: string };
		return runDelete({ id: memory_id, kind: "memory" });
	});

	return server.server;
}
