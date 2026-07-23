import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { toAddMemoryResponse, toMemoryList, toRecallResponse, toSourceList } from "./adapters.js";
import { buildRecalledContext } from "./context.js";
import { SERVER_INSTRUCTIONS, TOOL_DESCRIPTIONS } from "./descriptions.js";
import { HydraDB } from "./hydra/index.js";
import { logger } from "./logger.js";
import { ALIAS_REPLACEMENTS, DEPRECATED_TOOL_NAMES, TOOL_NAMES } from "./tool-names.js";

const DEFAULT_SUB_TENANT = "hydra-db-mcp";

// Host-owned default: silently attached to ingest so Hydra DB extracts the kind
// of personal context this server cares about. Injected here (not in the
// portable wrapper) because it is MCP-specific host behaviour.
const INGEST_INSTRUCTIONS =
	"Focus on extracting user preferences, habits, opinions, likes, dislikes, " +
	"goals, and recurring themes. Capture any stated or implied personal context " +
	"that would help personalise future interactions.";

function getConfig() {
	const apiKey = process.env.HYDRA_DB_API_KEY;
	if (!apiKey) {
		throw new Error("HYDRA_DB_API_KEY environment variable is required");
	}

	const tenantId = process.env.HYDRA_DB_TENANT_ID;
	if (!tenantId) {
		throw new Error("HYDRA_DB_TENANT_ID environment variable is required");
	}

	const subTenantId = process.env.HYDRA_DB_SUB_TENANT_ID || DEFAULT_SUB_TENANT;

	return { apiKey, tenantId, subTenantId };
}

type ToolResult = {
	content: { type: "text"; text: string }[];
};

function textResult(text: string): ToolResult {
	return { content: [{ type: "text" as const, text }] };
}

const turnSchema = z.object({
	user: z.string().describe("The user's message"),
	assistant: z.string().describe("The assistant's response"),
});

type ConversationTurn = { user: string; assistant: string };

export function createHydraDBServer(hydraOverride?: HydraDB) {
	const server = new McpServer(
		{
			name: "hydradb-mcp",
			version: "1.0.0",
		},
		{
			instructions: SERVER_INSTRUCTIONS,
		},
	);

	let hydra: HydraDB;
	if (hydraOverride) {
		hydra = hydraOverride;
	} else {
		const config = getConfig();
		hydra = new HydraDB({
			token: config.apiKey,
			database: config.tenantId,
			collection: config.subTenantId,
		});
		logger.info(
			`Hydra DB connected (database=${config.tenantId}, collection=${config.subTenantId})`,
		);
	}

	// Deprecated aliases emit exactly one stderr warning per process naming the
	// canonical replacement (CONTRACT §3). This is intentionally NOT routed
	// through `logger` — the warning must surface regardless of HYDRA_DB_LOG_LEVEL.
	const warnedAliases = new Set<string>();
	function warnDeprecatedAlias(name: string) {
		if (warnedAliases.has(name)) return;
		warnedAliases.add(name);
		const replacement = ALIAS_REPLACEMENTS[name] ?? "a canonical tool";
		console.error(
			`[hydradb-mcp] Tool "${name}" is deprecated and will be removed in a future major version; use "${replacement}" instead.`,
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
			return textResult("No relevant memories found in Hydra DB.");
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
		);
	}

	async function runIngestConversation(
		turns: ConversationTurn[],
		sourceId: string,
		userName?: string,
	): Promise<ToolResult> {
		logger.debug(
			`${TOOL_NAMES.INGEST}: ${turns.length} turns -> ${sourceId}`,
		);

		const raw = await hydra.context.ingest({
			kind: "memory",
			pairs: turns,
			sourceId,
			userName: userName ?? "User",
			infer: true,
			customInstructions: INGEST_INSTRUCTIONS,
			upsert: true,
		});
		const res = toAddMemoryResponse(raw);

		return textResult(
			`Ingested ${turns.length} conversation turn(s) into Hydra DB (source: ${sourceId}, success: ${res.success_count}, failed: ${res.failed_count})`,
		);
	}

	async function runListMemories(): Promise<ToolResult> {
		logger.debug(TOOL_NAMES.LIST);

		const raw = await hydra.context.list({ kind: "memory" });
		const memories = toMemoryList(raw);

		if (memories.length === 0) {
			return textResult("No memories stored yet.");
		}

		const lines = memories.map(
			(m, i) => `${i + 1}. [${m.memory_id}] ${m.memory_content.slice(0, 150)}`,
		);

		return textResult(`${memories.length} memories:\n\n${lines.join("\n")}`);
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
			return textResult("No sources found.");
		}

		const lines = sources.map((s, i) => {
			const title = s.title ? ` — ${s.title}` : "";
			const type = s.type ? ` (${s.type})` : "";
			return `${i + 1}. [${s.id}]${title}${type}`;
		});

		return textResult(`${total} sources:\n\n${lines.join("\n")}`);
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

	function deleteReport(kind: "memory" | "knowledge", id: string, deleted: boolean): ToolResult {
		const noun = kind === "knowledge" ? "source" : "memory";
		if (deleted) {
			return textResult(`Deleted ${noun}: ${id}`);
		}
		const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
		return textResult(`${Noun} ${id} was not found or already deleted.`);
	}

	async function runDelete(args: {
		id: string;
		kind?: "memory" | "knowledge";
	}): Promise<ToolResult> {
		const kind = args.kind ?? "memory";
		logger.debug(`${TOOL_NAMES.DELETE}: ${kind} ${args.id}`);

		const res = await hydra.context.delete({ ids: [args.id], kind });
		const deleted =
			(res.userMemoryDeleted ?? 0) > 0 || (res.deletedCount ?? 0) > 0;

		return deleteReport(kind, args.id, deleted);
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
			return runIngestConversation(a.turns, sourceId, a.user_name);
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
			const a = args as { kind?: "memory" | "knowledge"; source_ids?: string[] };
			if ((a.kind ?? "memory") === "knowledge") {
				return runListSources({ source_ids: a.source_ids });
			}
			return runListMemories();
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
		return runIngestConversation(a.turns, a.source_id, a.user_name);
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
