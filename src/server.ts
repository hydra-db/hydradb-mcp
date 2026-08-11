import { createRequire } from "node:module";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { toAddMemoryResponse, toMemoryList, toRecallResponse, toSourceList } from "./adapters.js";
import { resolveConfig } from "./config.js";
import { buildRecalledContext } from "./context.js";
import { SERVER_INSTRUCTIONS, TOOL_DESCRIPTIONS } from "./descriptions.js";
import { HydraDB } from "./hydra/index.js";
import { logger } from "./logger.js";
import { ALIAS_REPLACEMENTS, DEPRECATED_TOOL_NAMES, TOOL_NAMES } from "./tool-names.js";

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
	structuredContent?: Record<string, unknown>;
};

/**
 * A tool result carrying the same facts twice: prose for a human reading the
 * transcript, and `structuredContent` for the model, which would otherwise have
 * to parse IDs back out of English. Tools that declare an `outputSchema` must
 * supply the structured half on EVERY non-error path — the MCP SDK rejects a
 * result that has a schema and no structured content — so the empty and
 * soft-failure branches carry it too.
 */
function textResult(
	text: string,
	structured?: Record<string, unknown>,
): ToolResult {
	return {
		content: [{ type: "text" as const, text }],
		...(structured != null ? { structuredContent: structured } : {}),
	};
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
		max_results?: number;
		mode?: "fast" | "thinking";
		graph_context?: boolean;
	}): Promise<ToolResult> {
		logger.debug(`${TOOL_NAMES.QUERY}: "${args.query}"`);

		const raw = await hydra.context.query({
			query: args.query,
			kind: "memory",
			maxResults: args.max_results ?? 10,
			mode: args.mode ?? "thinking",
			graphContext: args.graph_context ?? true,
			alpha: 0.8,
			recencyBias: 0,
		});
		const res = toRecallResponse(raw);

		if (!res.chunks || res.chunks.length === 0) {
			return textResult("No relevant memories found in Hydra DB.", {
				count: 0,
				memories: [],
				context: "",
			});
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
			return `${i + 1}. ${snippet}${score}`;
		});

		return textResult(
			`Found ${res.chunks.length} memories:\n\n${summary.join("\n")}\n\n---\nFull context:\n${contextStr}`,
			{
				count: res.chunks.length,
				// Untruncated and unrounded on purpose: the prose caps the summary at
				// ten entries and clips each to 150 chars for readability, which is
				// exactly the lossiness the structured half exists to avoid.
				memories: res.chunks.map((c) => ({
					content: c.chunk_content,
					...(c.relevancy_score != null ? { score: c.relevancy_score } : {}),
				})),
				context: contextStr,
			},
		);
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

		const preview =
			args.text.length > 80 ? `${args.text.slice(0, 80)}...` : args.text;

		return textResult(
			`Saved to Hydra DB (${res.success_count} success, ${res.failed_count} failed): "${preview}"`,
			{
				success_count: res.success_count,
				failed_count: res.failed_count,
				...(args.source_id != null ? { source_id: args.source_id } : {}),
			},
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
			`Ingested ${turns.length} conversation turn(s) into Hydra DB (source: ${sourceId}, success: ${res.success_count}, failed: ${res.failed_count})`,
			{
				success_count: res.success_count,
				failed_count: res.failed_count,
				source_id: sourceId,
			},
		);
	}

	async function runListMemories(): Promise<ToolResult> {
		logger.debug(TOOL_NAMES.LIST);

		const raw = await hydra.context.list({ kind: "memory" });
		const memories = toMemoryList(raw);

		if (memories.length === 0) {
			return textResult("No memories stored yet.", {
				kind: "memory",
				total: 0,
				items: [],
			});
		}

		const lines = memories.map(
			(m, i) => `${i + 1}. [${m.memory_id}] ${m.memory_content.slice(0, 150)}`,
		);

		return textResult(`${memories.length} memories:\n\n${lines.join("\n")}`, {
			kind: "memory",
			total: memories.length,
			items: memories.map((m) => ({
				id: m.memory_id,
				content: m.memory_content,
			})),
		});
	}

	async function runListSources(args: {
		source_ids?: string[];
	}): Promise<ToolResult> {
		logger.debug(TOOL_NAMES.LIST);

		const raw = await hydra.context.list({
			kind: "knowledge",
			ids: args.source_ids,
		});
		const { sources, total } = toSourceList(raw);

		if (sources.length === 0) {
			return textResult("No sources found.", {
				kind: "knowledge",
				total: 0,
				items: [],
			});
		}

		const lines = sources.map((s, i) => {
			const title = s.title ? ` — ${s.title}` : "";
			const type = s.type ? ` (${s.type})` : "";
			return `${i + 1}. [${s.id}]${title}${type}`;
		});

		return textResult(`${total} sources:\n\n${lines.join("\n")}`, {
			kind: "knowledge",
			total,
			items: sources.map((s) => ({
				id: s.id,
				...(s.title != null ? { title: s.title } : {}),
				...(s.type != null ? { type: s.type } : {}),
			})),
		});
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

		// Soft failure: return a normal (non-error) text result, matching v1. The
		// `success` flag carries that distinction as data, so a caller no longer
		// has to notice the difference in wording.
		if (!res.success || res.error) {
			return textResult(
				`Could not fetch source ${args.source_id}: ${res.error ?? "unknown error"}`,
				{
					source_id: args.source_id,
					success: false,
					...(res.error != null ? { error: res.error } : {}),
				},
			);
		}

		const content = res.content ?? res.contentBase64 ?? "(no text content)";

		return textResult(`Source: ${args.source_id}\n\n${content}`, {
			source_id: args.source_id,
			success: true,
			content,
		});
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
			return textResult(`Deleted ${noun}: ${id}`, {
				outcome: "removed",
				id,
				kind,
			});
		}

		if (res.success === false) {
			const reason = deleteFailureReason(res);
			return textResult(
				`Could NOT delete ${noun} ${id} — the server refused the request` +
					`${reason ? `: ${reason}` : " and gave no reason"}. ` +
					`The ${noun} has not been removed.`,
				{
					outcome: "refused",
					id,
					kind,
					...(reason != null ? { reason } : {}),
				},
			);
		}

		const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
		return textResult(`${Noun} ${id} was not found or already deleted.`, {
			outcome: "absent",
			id,
			kind,
		});
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
		opts?: {
			outputSchema?: Record<string, unknown>;
			annotations?: {
				readOnlyHint?: boolean;
				openWorldHint?: boolean;
				idempotentHint?: boolean;
			};
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
				...(opts?.outputSchema ? { outputSchema: opts.outputSchema as never } : {}),
				...(opts?.annotations ? { annotations: opts.annotations } : {}),
			},
			wrapped as never,
		);
	}

	// --- Input schemas ---

	const querySchema = {
		query: z.string().describe(TOOL_DESCRIPTIONS[TOOL_NAMES.QUERY].params.query),
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

	// --- Output schemas ---
	//
	// One per handler, shared by a canonical tool and its deprecated aliases:
	// the alias deprecates the NAME, not the payload, so both describe the same
	// result. Field names mirror the snake_case the tool inputs already use.

	const queryOutputSchema = {
		count: z.number().describe("How many memories matched"),
		memories: z.array(
			z.object({
				content: z.string(),
				score: z.number().optional().describe("Relevance, 0 to 1"),
			}),
		),
		context: z
			.string()
			.describe("Graph-enriched recall context; empty when nothing matched"),
	};

	const ingestOutputSchema = {
		success_count: z.number(),
		failed_count: z.number(),
		source_id: z
			.string()
			.optional()
			.describe("Identifier the content was stored under, when known"),
	};

	const listOutputSchema = {
		kind: z.enum(["memory", "knowledge"]),
		total: z.number(),
		items: z.array(
			z.object({
				id: z.string().describe("Pass to hydradb_inspect or hydradb_delete"),
				content: z.string().optional().describe("Memory text (memories only)"),
				title: z.string().optional(),
				type: z.string().optional(),
			}),
		),
	};

	const inspectOutputSchema = {
		source_id: z.string(),
		success: z.boolean().describe("False when the source could not be fetched"),
		content: z.string().optional(),
		error: z.string().optional(),
	};

	const deleteOutputSchema = {
		outcome: z
			.enum(["removed", "refused", "absent"])
			.describe(
				"`removed`: deleted. `refused`: the server declined and it is STILL THERE. " +
					"`absent`: there was nothing to delete.",
			),
		id: z.string(),
		kind: z.enum(["memory", "knowledge"]),
		reason: z
			.string()
			.optional()
			.describe("The server's explanation, when it refused"),
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
		{ outputSchema: queryOutputSchema, annotations: searchAnnotations },
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
	}, { outputSchema: ingestOutputSchema });

	register(
		TOOL_NAMES.LIST,
		listSchema,
		(args) => {
			const a = args as { kind?: "memory" | "knowledge"; source_ids?: string[] };
			if ((a.kind ?? "memory") === "knowledge") {
				return runListSources({ source_ids: a.source_ids });
			}
			return runListMemories();
		},
		{ outputSchema: listOutputSchema, annotations: readOnly },
	);

	register(
		TOOL_NAMES.INSPECT,
		inspectSchema,
		(args) => runInspect(args as Parameters<typeof runInspect>[0]),
		{ outputSchema: inspectOutputSchema, annotations: readOnly },
	);

	register(
		TOOL_NAMES.DELETE,
		deleteSchema,
		(args) => runDelete(args as Parameters<typeof runDelete>[0]),
		{ outputSchema: deleteOutputSchema },
	);

	// --- Deprecated aliases ---

	register(
		TOOL_NAMES.SEARCH,
		querySchema,
		(args) => runQuery(args as Parameters<typeof runQuery>[0]),
		{ outputSchema: queryOutputSchema, annotations: searchAnnotations },
	);

	register(
		TOOL_NAMES.STORE,
		storeSchema,
		(args) => runStore(args as Parameters<typeof runStore>[0]),
		{ outputSchema: ingestOutputSchema },
	);

	register(
		TOOL_NAMES.INGEST_CONVERSATION,
		conversationSchema,
		(args) => {
			const a = args as {
				turns: ConversationTurn[];
				source_id: string;
				user_name?: string;
			};
			// The deprecated alias keeps its historical shape (user_name only; infer
			// on, no title/markdown). The canonical hydradb_ingest forwards the rest.
			return runIngestConversation(a.turns, a.source_id, {
				userName: a.user_name,
			});
		},
		{ outputSchema: ingestOutputSchema },
	);

	register(TOOL_NAMES.LIST_MEMORIES, {}, () => runListMemories(), {
		outputSchema: listOutputSchema,
		annotations: readOnly,
	});

	register(
		TOOL_NAMES.LIST_SOURCES,
		listSourcesSchema,
		(args) => runListSources(args as { source_ids?: string[] }),
		{ outputSchema: listOutputSchema, annotations: readOnly },
	);

	register(
		TOOL_NAMES.FETCH_CONTENT,
		inspectSchema,
		(args) => runInspect(args as Parameters<typeof runInspect>[0]),
		{ outputSchema: inspectOutputSchema, annotations: readOnly },
	);

	register(
		TOOL_NAMES.DELETE_MEMORY,
		deleteMemorySchema,
		(args) => {
			const { memory_id } = args as { memory_id: string };
			return runDelete({ id: memory_id, kind: "memory" });
		},
		{ outputSchema: deleteOutputSchema },
	);

	return server.server;
}
