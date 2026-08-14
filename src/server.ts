import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { toAddMemoryResponse, toMemoryList, toSourceList } from "./adapters.js";
import type { PageInfo } from "./adapters.js";
import { resolveConfig } from "./config.js";
import { renderRecalledContext } from "./context.js";
import { SERVER_INSTRUCTIONS, TOOL_DESCRIPTIONS } from "./descriptions.js";
import { HydraDB } from "./hydra/index.js";
import type { ContextKind, QueryKind } from "./hydra/index.js";
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
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
};

/**
 * A usable title for an entry the caller did not name.
 *
 * The default was the constant "MCP Memory". Since `title` is the ONLY per-chunk
 * label `buildRecalledContext` renders, fifty untitled saves produced fifty
 * recall results all reading `Source: MCP Memory` — the caller could not cite
 * where a fact came from, or tell whether two chunks were the same memory. It
 * also defeats any future filter on title, since every row shares one value.
 *
 * Deriving from the first line is a safety net, not the fix. The fix is the
 * description telling the model to set one; this keeps the failure from being
 * total when it does not.
 */
function defaultTitle(text: string): string {
	const firstLine = (text.trim().split("\n", 1)[0] ?? "").trim();
	if (firstLine === "") return "Untitled note";
	// Ingested documents commonly start with a markdown heading, and the hashes
	// are noise in a label.
	const cleaned = firstLine.replace(/^#+\s*/, "").trim() || firstLine;
	return cleaned.length <= 60 ? cleaned : `${cleaned.slice(0, 57).trimEnd()}…`;
}

/**
 * A source id for a conversation the caller did not name.
 *
 * This was `mcp-conversation-${Date.now()}` — millisecond resolution, no
 * randomness, no process or session identity. Two ingests landing in the same
 * millisecond produced the same id, and because `upsert` is true the second
 * silently REPLACED the first (see the upsert regression test) while reporting
 * "success: 1, failed: 0". Nothing surfaced the loss.
 *
 * The collision window is wider than one agent racing itself: HYDRADB_COLLECTION
 * defaults to the shared literal `hydra-db-mcp`, so every user who does not set
 * it shares one namespace with a low-entropy id.
 *
 * The timestamp prefix is kept because it sorts and reads well; the suffix is
 * what makes it unique.
 */
function generatedSourceId(): string {
	return `mcp-conversation-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

function textResult(text: string): ToolResult {
	return { content: [{ type: "text" as const, text }] };
}

/**
 * A result the caller can read OR parse.
 *
 * Every handler returned prose only, so a caller wanting an id had to pull it
 * out of a sentence. `structuredContent` hands over the same facts already
 * parsed — ids it can pass straight to the next tool, counts it can branch on.
 *
 * `content` stays populated alongside it. The MCP spec requires that for hosts
 * that ignore structured output, and dropping it would break every client that
 * renders the text.
 */
function structuredResult(
	text: string,
	structuredContent: Record<string, unknown>,
): ToolResult {
	return { content: [{ type: "text" as const, text }], structuredContent };
}

/**
 * A failure the caller should treat as a failure, not a result.
 *
 * Three different contracts for "it didn\'t work" used to coexist here: thrown
 * errors became `isError: true`, while a failed inspect and a server-REFUSED
 * delete returned plain text with `isError` absent. A client branching on
 * `isError` therefore read "Could NOT delete X — the server refused" as a
 * success.
 *
 * These stay soft text rather than throws, deliberately — the message is
 * carefully worded and a thrown error would replace it with a generic one — but
 * they are now flagged.
 */
function errorResult(text: string): ToolResult {
	return { content: [{ type: "text" as const, text }], isError: true };
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

/**
 * Input ceilings.
 *
 * `text` and `turns` were unbounded. The whole payload is materialised —
 * `JSON.stringify` on the memory path, a Buffer on the knowledge path — so an
 * oversized body is best case a 413 after uploading all of it, worst case an
 * out-of-memory in this process. Rejecting locally is instant, costs no
 * bandwidth, and names the limit.
 *
 * Sized well above any realistic memory or document this tool is asked to store.
 */
const MAX_TEXT_CHARS = 1_000_000;
const MAX_TURNS = 500;
const MAX_TURN_CHARS = 100_000;

const turnSchema = z.object({
	user: z
		.string()
		.max(MAX_TURN_CHARS, {
			message: `each turn's user message must be at most ${MAX_TURN_CHARS} characters`,
		})
		.describe("The user's message"),
	assistant: z
		.string()
		.max(MAX_TURN_CHARS, {
			message: `each turn's assistant message must be at most ${MAX_TURN_CHARS} characters`,
		})
		.describe("The assistant's response"),
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

/**
 * In-flight tool calls, so shutdown can wait for them.
 *
 * `server.close()` tears down the transport; it does not wait for handlers that
 * are already running. Without this, SIGTERM during an ingest kills the process
 * mid-write and the caller never learns whether it committed — which, since a
 * reused source_id replaces, is not a question they can answer by retrying.
 *
 * Module-scoped so it spans every server instance in the process, matching how
 * the alias-warning dedupe is scoped.
 */
let inFlight = 0;
const idleWaiters: (() => void)[] = [];

/**
 * Set once shutdown begins, so no NEW call is accepted after that point.
 *
 * Draining alone is not enough: a call arriving after the counter reaches zero
 * but before the transport closes would be accepted, then aborted by the close —
 * leaving an ingest caller unable to tell whether the write committed, which is
 * the exact outcome draining exists to prevent.
 */
let shuttingDown = false;

/** Stop accepting tool calls. Idempotent. */
export function beginShutdown(): void {
	shuttingDown = true;
}

/** Test-only: allow a fresh server in the same process after a shutdown test. */
export function __resetShutdown(): void {
	shuttingDown = false;
}

function trackInFlight<T>(work: () => Promise<T>): Promise<T> {
	if (shuttingDown) {
		return Promise.reject(
			new Error(
				"Hydra DB MCP server is shutting down and is not accepting new requests. " +
				"Retry once it has restarted.",
			),
		);
	}
	inFlight++;
	return work().finally(() => {
		inFlight--;
		if (inFlight === 0) {
			while (idleWaiters.length > 0) idleWaiters.pop()?.();
		}
	});
}

/** Resolves once no tool call is running, or immediately if none is. */
export function awaitInFlight(): Promise<void> {
	if (inFlight === 0) return Promise.resolve();
	return new Promise((resolve) => idleWaiters.push(resolve));
}

/** How many tool calls are currently running. Exported for tests and logging. */
export function inFlightCount(): number {
	return inFlight;
}

/**
 * Whether the deprecated tool aliases are registered.
 *
 * Off by default as of 1.2.0. Anyone whose mcp.json still calls the old names
 * sets HYDRADB_MCP_LEGACY_TOOLS=1 to restore them — one env var, no code change,
 * and the opt-in is itself the adoption signal that a later removal needs and
 * that nothing here could previously collect.
 */
export function legacyToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env.HYDRADB_MCP_LEGACY_TOOLS;
	if (raw == null) return false;
	return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
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
			...(config.timeoutSeconds != null
				? { timeoutSeconds: config.timeoutSeconds }
				: {}),
			...(config.maxRetries != null ? { maxRetries: config.maxRetries } : {}),
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
		mode?: "fast" | "thinking" | "auto";
		graph_context?: boolean;
		detail?: "compact" | "full";
		operator?: "or" | "and" | "phrase";
		source_ids?: string[];
		metadata_filters?: Record<string, unknown>;
		num_related_chunks?: number;
	}, signal?: AbortSignal): Promise<ToolResult> {
		// Host-owned default (CONTRACT §2 rule 5): search BOTH families. This tool
		// used to pin `kind: "memory"`, which made every ingested knowledge source
		// unreachable from the MCP — `hydradb_list`/`hydradb_inspect` could browse
		// knowledge but nothing could search it.
		const kind = args.kind ?? "all";
		logger.debug(`${TOOL_NAMES.QUERY}: "${args.query}" (kind=${kind})`);

		const maxResults = args.max_results ?? 10;
		const raw = await hydra.context.query({
			query: args.query,
			kind,
			maxResults,
			mode: args.mode ?? "thinking",
			operator: args.operator,
			ids: args.source_ids,
			metadataFilters: args.metadata_filters,
			numRelatedChunks: args.num_related_chunks,
			graphContext: args.graph_context ?? true,
			alpha: 0.8,
			recencyBias: 0,
		}, { signal });
		// The renderer reads the SDK payload directly; there is no longer a
		// snake_case mirror to convert into.
		const res = raw;

		// The server can return more chunks than were asked for — a live call with
		// max_results=10 came back with 15, and all 15 were rendered. Honour the
		// parameter here so it means what its description says.
		if (res.chunks != null && res.chunks.length > maxResults) {
			res.chunks = res.chunks.slice(0, maxResults);
		}

		if (!res.chunks || res.chunks.length === 0) {
			return textResult(`No relevant ${resultNoun(kind)} found in Hydra DB.`);
		}

		// No separate summary block. It listed the first 10 chunks truncated to 150
		// characters each — text that is a verbatim prefix of what the context
		// block below already renders in full. Every chunk body went to the caller
		// twice, and the only field the summary carried that the context block did
		// not was the score, which now rides in the chunk header.
		//
		// It also disagreed with its own header: `Found ${length}` counted every
		// chunk while the list stopped at 10, so a 15-chunk result announced 15 and
		// showed 10.
		const compact = (args.detail ?? "compact") === "compact";
		// The header and the legend are part of the response the caller pays for,
		// so the renderer gets a budget with room already reserved for them.
		// Adding framing after the ceiling had been applied put the finished
		// response over the documented limit — the same mistake as leaving the
		// entity-path prefix out of the accounting, one layer up.
		const legend =
			`\n\n---\nEach [id: …] is a source id: pass one to ${TOOL_NAMES.INSPECT} for that ` +
			`source's full content, or to ${TOOL_NAMES.DELETE} to remove it.`;
		const headerAllowance = 120;

		const { text: contextStr, shown } = renderRecalledContext(res, {
			// Compact keeps every chunk but trims each body and drops the
			// extra-context blocks; `full` is the unchanged rendering.
			...(compact
				? { maxChunkChars: COMPACT_CHUNK_CHARS, includeExtraContext: false }
				: {}),
			maxTotalChars: QUERY_CHAR_BUDGET - legend.length - headerAllowance,
		});

		return textResult(
			`Found ${shown} ${resultNoun(kind, shown)}:\n\n${contextStr}${legend}`,
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

	/**
	 * Ingestion is asynchronous, and the caller has no way to know that.
	 *
	 * The upload returns as soon as the source is queued; indexing then runs
	 * through graph extraction and takes seconds. A caller that saves and
	 * immediately queries to confirm gets "No relevant context items found" and
	 * reasonably concludes the save failed — then re-saves, which under upsert
	 * replaces what it just wrote.
	 *
	 * The server already says this in its 202 body; the adapter kept the message
	 * so we can pass the server's own words through rather than invent our own.
	 */
	function indexingNote(res: { message: string }): string {
		const said = res.message.trim();
		const mentionsAsync = /asynchron|queued|still processing|not.*indexed/i.test(said);
		return (
			`\n\nIndexing is asynchronous — the content is not searchable until it ` +
			`completes. Use ${TOOL_NAMES.STATUS} to check.` +
			(mentionsAsync ? "" : said ? `\nServer: ${briefly(said)}` : "")
		);
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
		kind?: ContextKind;
		title?: string;
		source_id?: string;
		infer?: boolean;
		is_markdown?: boolean;
		overwrite?: boolean;
		metadata?: Record<string, unknown>;
		observation_date?: string;
	}, signal?: AbortSignal): Promise<ToolResult> {
		const kind = args.kind ?? "memory";
		logger.debug(`${TOOL_NAMES.INGEST}: "${args.text.slice(0, 50)}..." (kind=${kind})`);

		// The memory item shape has no counterpart on the knowledge path, which
		// carries only a document and its filename — so those fields are sent only
		// where they mean something. The wrapper rejects them on the knowledge
		// branch rather than dropping them, and passing them here unconditionally
		// would make every knowledge write fail.
		const memoryOnly =
			kind === "memory"
				? {
						sourceId: args.source_id,
						infer: args.infer ?? true,
						isMarkdown: args.is_markdown ?? false,
						customInstructions: INGEST_INSTRUCTIONS,
						metadata: args.metadata,
						observationDate: args.observation_date,
					}
				: {};

		const raw = await hydra.context.ingest({
			kind,
			text: args.text,
			title: args.title ?? defaultTitle(args.text),
			...memoryOnly,
			// Default stays true. The SDK retries POSTs, so upsert is what keeps a
			// retried ingest from duplicating — flipping this default would trade a
			// silent overwrite for a silent duplicate.
			upsert: args.overwrite ?? true,
		}, { signal });
		const res = toAddMemoryResponse(raw);

		// Was an 80-char echo of the text the caller had just sent — zero
		// information back to them. The id is the thing they do not have and
		// cannot derive, and it is what makes correcting this memory later
		// possible at all.
		const id = createdId(res) ?? args.source_id;

		return structuredResult(
			`Saved to Hydra DB${id ? ` (id: ${id})` : ""} ` +
			`(${res.success_count} success, ${res.failed_count} failed).` +
			indexingNote(res) +
			ingestIssues(res),
			{
				...(id != null ? { id } : {}),
				success_count: res.success_count,
				failed_count: res.failed_count,
				indexing_pending: true,
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
			overwrite?: boolean;
		},
		signal?: AbortSignal,
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
			upsert: opts?.overwrite ?? true,
		}, { signal });
		const res = toAddMemoryResponse(raw);

		const conversationId = createdId(res) ?? sourceId;
		return structuredResult(
			`Ingested ${turns.length} conversation turn(s) into Hydra DB ` +
			`(id: ${conversationId}, success: ${res.success_count}, failed: ${res.failed_count})` +
			indexingNote(res) +
			ingestIssues(res),
			{
				id: conversationId,
				success_count: res.success_count,
				failed_count: res.failed_count,
				indexing_pending: true,
			},
		);
	}

	/**
	 * How much of the corpus this page covered, stated plainly.
	 *
	 * A listing that shows 50 of 4,000 rows and says "50 memories:" is not a
	 * truncated answer, it is a wrong one — the caller reports it as the complete
	 * inventory. Say what was shown, out of what, and how to reach the rest.
	 */
	/**
	 * Whether another page exists.
	 *
	 * `total > shown` is NOT a usable test on its own: on the last page of a large
	 * corpus it is still true (12 shown of 412) and would point the caller at a
	 * page that does not exist. Prefer what the server stated, then the page
	 * arithmetic, and only then the row comparison — which is correct on page 1,
	 * the only place it is reached.
	 */
	function hasMore(shown: number, page: PageInfo, requestedPage?: number): boolean {
		const total = page.total ?? shown;
		const current = page.page ?? requestedPage ?? 1;
		const seen = (current - 1) * (page.page_size ?? shown) + shown;
		return (
			page.has_next ??
			(page.total_pages != null ? current < page.total_pages : seen < total)
		);
	}

	function coverage(shown: number, page: PageInfo, requestedPage?: number): string {
		const total = page.total ?? shown;
		const current = page.page ?? requestedPage ?? 1;
		const more = hasMore(shown, page, requestedPage);

		if (!more && current === 1) return `${shown}`;
		return `${shown} of ${total} (page ${current})${more ? ` — pass page=${current + 1} for more` : ""}`;
	}

	async function runListMemories(args: {
		source_ids?: string[];
		page?: number;
		page_size?: number;
	} = {}, signal?: AbortSignal): Promise<ToolResult> {
		logger.debug(TOOL_NAMES.LIST);

		const raw = await hydra.context.list({
			kind: "memory",
			ids: args.source_ids,
			page: args.page,
			pageSize: args.page_size,
		}, { signal });
		const { memories, page } = toMemoryList(raw);

		if (memories.length === 0) {
			// Declaring an outputSchema obliges EVERY return path to carry structured
			// content, including this one — a caller branching on `items` should not
			// have to special-case the empty result.
			return structuredResult(
				args.page != null && args.page > 1
					? `No memories on page ${args.page}.`
					: "No memories stored yet.",
				{
					kind: "memory",
					items: [],
					shown: 0,
					total: page.total ?? 0,
					page: args.page ?? 1,
					has_more: false,
				},
			);
		}

		const lines = memories.map((m, i) => {
			// The query path appends "..." when it truncates; this one did not, so a
			// half sentence read as a complete fact.
			const content = m.memory_content;
			const snippet =
				content.length > 150 ? `${content.slice(0, 150)}...` : content;
			return `${i + 1}. [${m.memory_id}] ${snippet}`;
		});

		return structuredResult(
			`${coverage(memories.length, page, args.page)} memories:\n\n${lines.join("\n")}`,
			{
				kind: "memory",
				// Bounded like the text preview. The structured payload previously
				// carried every memory_content in full, so a host consuming it got
				// megabytes from a routine inventory call while the prose beside it
				// showed 150 characters per row. Structured output is a different
				// encoding of the same answer, not a bypass of its limits.
				items: memories.map((m) => ({
					id: m.memory_id,
					content: clampPreview(m.memory_content),
				})),
				shown: memories.length,
				total: page.total ?? memories.length,
				page: page.page ?? args.page ?? 1,
				has_more: hasMore(memories.length, page, args.page),
			},
		);
	}

	async function runListSources(args: {
		source_ids?: string[];
		page?: number;
		page_size?: number;
	}, signal?: AbortSignal): Promise<ToolResult> {
		logger.debug(TOOL_NAMES.LIST);

		const raw = await hydra.context.list({
			kind: "knowledge",
			ids: args.source_ids,
			page: args.page,
			pageSize: args.page_size,
		}, { signal });
		const { sources, page } = toSourceList(raw);

		if (sources.length === 0) {
			return structuredResult(
				args.page != null && args.page > 1
					? `No sources on page ${args.page}.`
					: "No sources found.",
				{
					kind: "knowledge",
					items: [],
					shown: 0,
					total: page.total ?? 0,
					page: args.page ?? 1,
					has_more: false,
				},
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
		return structuredResult(
			`${coverage(sources.length, page, args.page)} sources:\n\n${lines.join("\n")}`,
			{
				kind: "knowledge",
				items: sources.map((src) => ({
					id: src.id,
					...(src.title != null ? { title: src.title } : {}),
					...(src.type != null ? { type: src.type } : {}),
				})),
				shown: sources.length,
				total: page.total ?? sources.length,
				page: page.page ?? args.page ?? 1,
				has_more: hasMore(sources.length, page, args.page),
			},
		);
	}

	/**
	 * How much source text one inspect call may put into the caller's context.
	 *
	 * Roughly 5k tokens. Large enough that ordinary documents come back whole,
	 * small enough that no single call can dominate a conversation.
	 */
	const INSPECT_CHAR_BUDGET = 20_000;

	/**
	 * The per-row preview length shared by the text and structured listings.
	 *
	 * They must agree: a caller reading `structuredContent` and a caller reading
	 * the prose should get the same answer, not two different ones.
	 */
	const LIST_PREVIEW_CHARS = 150;

	function clampPreview(text: string): string {
		return text.length > LIST_PREVIEW_CHARS
			? `${text.slice(0, LIST_PREVIEW_CHARS)}...`
			: text;
	}

	/**
	 * Query output ceilings.
	 *
	 * Chunk bodies were rendered at full length with no cap of any kind, so one
	 * query over a corpus of long documents could dominate the caller's context.
	 * `compact` trims each body and drops the extra-context blocks; `full`
	 * restores the previous rendering. The total budget applies either way,
	 * because fifty capped chunks still add up.
	 */
	const COMPACT_CHUNK_CHARS = 600;
	const QUERY_CHAR_BUDGET = 40_000;

	/** Bound any one server-supplied string, marking it when it is shortened. */
	function clamp(text: string, budget: number): string {
		if (text.length <= budget) return text;
		return `${text.slice(0, budget)}\n\n[truncated: ${text.length} chars total]`;
	}

	/**
	 * The readable part of an inspect response, bounded.
	 *
	 * This was `res.content ?? res.contentBase64 ?? "(no text content)"`, with no
	 * cap anywhere between the API and the tool result. Two problems:
	 *
	 *   - unbounded text. A large ingested document arrives whole, and the caller
	 *     cannot un-read it or tell in advance how big it is. The tool is
	 *     annotated readOnlyHint, so clients call it speculatively.
	 *   - base64. `contentBase64` is the binary fallback and base64 inflates 4/3,
	 *     so a 1 MB scanned PDF becomes ~1.4M characters — a whole context window
	 *     in one call. It only fires when text extraction yielded nothing, which
	 *     is precisely the case a user retries by hand when the first call looks
	 *     empty.
	 *
	 * Binary is never inlined. The caller is told what it is, how big, and how to
	 * get it — `mode: "url"` already returns a download link.
	 */
	function inspectBody(
		res: {
			content?: string;
			contentBase64?: string;
			contentType?: string;
			sizeBytes?: number;
			inferredContent?: string;
		},
		offset?: number,
		limit?: number,
	): string {
		if (res.content == null || res.content === "") {
			if (res.contentBase64) {
				const size = res.sizeBytes != null ? `${res.sizeBytes} bytes` : "unknown size";
				// The summary is server-generated and unbounded, so it has to obey
				// the same budget as the content it stands in for — otherwise the
				// binary branch, which exists to keep this response small, becomes
				// its own way of blowing past it.
				const summary = res.inferredContent
					? `\n\nSummary of the content:\n${clamp(res.inferredContent, INSPECT_CHAR_BUDGET)}`
					: "";
				return (
					`(binary ${res.contentType ?? "content"}, ${size} — not shown. ` +
					`Call again with mode:"url" for a download link.)${summary}`
				);
			}
			return "(no text content)";
		}

		const start = Math.max(0, offset ?? 0);
		const budget = Math.min(limit ?? INSPECT_CHAR_BUDGET, INSPECT_CHAR_BUDGET);
		const total = res.content.length;

		if (start === 0 && total <= budget) return res.content;

		const slice = res.content.slice(start, start + budget);
		const end = start + slice.length;
		const more =
			end < total
				? ` Call again with offset=${end} for the next ${Math.min(budget, total - end)}.`
				: "";
		return (
			`${slice}\n\n[truncated: showing characters ${start}-${end} of ${total}.${more}]`
		);
	}

	/** Accept either spelling, and say so when neither is present. */
	function toInspectArgs(args: Record<string, unknown>) {
		const a = args as {
			id?: string;
			source_id?: string;
			mode?: "content" | "url" | "both";
			offset?: number;
			limit?: number;
			expiry_seconds?: number;
		};
		// Reject a conflict rather than picking one. This server rejects `text`
		// AND `turns` on ingest for the same reason: silently choosing between two
		// values the caller deliberately supplied means acting on a target they
		// did not ask for, and here that target can be a DELETE.
		if (a.id != null && a.source_id != null && a.id !== a.source_id) {
			throw new Error(
				`${TOOL_NAMES.INSPECT} received different values for \`id\` (${a.id}) and its ` +
				`deprecated alias \`source_id\` (${a.source_id}). Pass only \`id\`.`,
			);
		}
		const id = a.id ?? a.source_id;
		if (!id) {
			throw new Error(
				`${TOOL_NAMES.INSPECT} requires \`id\` — the value shown as [id: …] in ` +
				`${TOOL_NAMES.QUERY} results or in [brackets] in ${TOOL_NAMES.LIST} output.`,
			);
		}
		return {
			source_id: id,
			mode: a.mode,
			offset: a.offset,
			limit: a.limit,
			expiry_seconds: a.expiry_seconds,
		};
	}

	async function runInspect(args: {
		source_id: string;
		mode?: "content" | "url" | "both";
		offset?: number;
		limit?: number;
		expiry_seconds?: number;
	}, signal?: AbortSignal): Promise<ToolResult> {
		logger.debug(`${TOOL_NAMES.INSPECT}: ${args.source_id}`);

		const res = await hydra.context.inspect({
			id: args.source_id,
			mode: args.mode ?? "content",
			expirySeconds: args.expiry_seconds,
		}, { signal });

		// Soft failure: return a normal (non-error) text result, matching v1.
		if (!res.success || res.error) {
			return errorResult(
				`Could not fetch source ${args.source_id}: ${res.error ?? "unknown error"}`,
			);
		}

		const mode = args.mode ?? "content";
		const parts: string[] = [`Source: ${args.source_id}`];

		// `presignedUrl` was never read, so `mode: "url"` — documented in the
		// schema and the README — returned "(no text content)" and nothing else.
		// The one mode whose entire purpose is the link never emitted the link.
		if (mode === "url" || mode === "both") {
			parts.push(
				res.presignedUrl
					? `Download URL (time-limited): ${res.presignedUrl}`
					: "No download URL available for this source.",
			);
		}

		if (mode === "content" || mode === "both") {
			parts.push(inspectBody(res, args.offset, args.limit));
		}

		return textResult(parts.join("\n\n"));
	}

	async function runStatus(
		args: { ids: string[] },
		signal?: AbortSignal,
	): Promise<ToolResult> {
		logger.debug(`${TOOL_NAMES.STATUS}: ${args.ids.join(", ")}`);

		const res = await hydra.context.ingestionStatus({ ids: args.ids }, { signal });
		const statuses = res.statuses ?? [];

		if (statuses.length === 0) {
			return textResult(
				`No indexing status found for: ${args.ids.join(", ")}. ` +
				`Either the ids are wrong or the sources were never queued.`,
			);
		}

		const lines = statuses.map((s) => {
			const state = s.indexingStatus ?? "unknown";
			const reason = s.errorMessage
				? ` — ${briefly(s.errorMessage)}${s.errorCode ? ` [${s.errorCode}]` : ""}`
				: "";
			return `  - ${s.id ?? "(unknown id)"}: ${state}${reason}`;
		});

		// `completed` and `failed` are terminal; everything else means keep
		// waiting. Deliberately not switched over the SDK's status enum
		// (queued/processing/completed/failed) — a live run returned
		// `graph_creation`, which that enum does not declare.
		const pending = statuses.filter(
			(s) => !["completed", "failed"].includes(String(s.indexingStatus).toLowerCase()),
		);
		const note =
			pending.length > 0
				? `\n\n${pending.length} still indexing — not yet searchable. Check again in a few seconds.`
				: `\n\nAll sources have reached a terminal state.`;

		return textResult(`Indexing status:\n${lines.join("\n")}${note}`);
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
		ids: string[],
		res: { success?: boolean; message?: string; results?: unknown },
		removed: boolean,
		removedCount = 0,
	): ToolResult {
		const noun = kind === "knowledge" ? "source" : "memory";
		const id = ids.join(", ");
		if (removed) {
			// With several ids the server may remove only some of them, and saying
			// "Deleted" over a partial result is the kind of overstatement this
			// whole branch of work exists to remove.
			const partial = ids.length > 1 && removedCount < ids.length;
			return structuredResult(
				partial
					? `Deleted ${removedCount} of ${ids.length} ${noun}s (requested: ${id}). ` +
						`The rest were not found or could not be removed.`
					: `Deleted ${noun}${ids.length > 1 ? "s" : ""}: ${id}`,
				{
					ids,
					kind,
					deleted: true,
					deleted_count: removedCount || ids.length,
					...(partial ? { partial: true } : {}),
				},
			);
		}

		if (res.success === false) {
			const reason = deleteFailureReason(res);
			return {
				...structuredResult(
					`Could NOT delete ${noun} ${id} — the server refused the request` +
						`${reason ? `: ${reason}` : " and gave no reason"}. ` +
						`The ${noun} has not been removed.`,
					{
						ids,
						kind,
						deleted: false,
						deleted_count: 0,
						...(reason ? { reason } : {}),
					},
				),
				isError: true,
			};
		}

		// The server succeeded and removed nothing, so no such id exists in this
		// database. "or already deleted" was the same mistake the refusal branch
		// above was written to fix: it offers a cause we did not observe, and the
		// reassuring one. A caller that invented an id — the likely case, since
		// until recently nothing emitted one — reads it as confirmation and tells
		// the user their data is gone.
		return structuredResult(
			`No ${noun} with id ${id} exists in this database — nothing was deleted. ` +
			`Ids come from ${TOOL_NAMES.QUERY} or ${TOOL_NAMES.LIST}; check the id rather than retrying.`,
			{ ids, kind, deleted: false, deleted_count: 0, reason: "not found" },
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

	/** Accept `ids` or the singular `id`, and say where a real id comes from. */
	function toDeleteArgs(args: Record<string, unknown>) {
		const a = args as { id?: string; ids?: string[]; kind?: "memory" | "knowledge" };
		const ids = a.ids ?? (a.id != null ? [a.id] : []);
		if (ids.length === 0) {
			throw new Error(
				`${TOOL_NAMES.DELETE} requires \`ids\` (or \`id\`). Ids come from ` +
				`${TOOL_NAMES.QUERY} or ${TOOL_NAMES.LIST} — do not guess one.`,
			);
		}
		return { ids, kind: a.kind };
	}

	async function runDelete(args: {
		ids: string[];
		kind?: "memory" | "knowledge";
	}, signal?: AbortSignal): Promise<ToolResult> {
		const kind = args.kind ?? "memory";
		logger.debug(`${TOOL_NAMES.DELETE}: ${kind} ${args.ids.join(", ")}`);

		const res = await hydra.context.delete({ ids: args.ids, kind }, { signal });
		const removedCount =
			(res.deletedCount ?? 0) ||
			// The backend reports a boolean here, not a count; `> 0` coerces true
			// to 1 and false to 0, which happens to be right but is worth stating.
			(res.userMemoryDeleted ? 1 : 0);
		const removed = removedCount > 0;
		if (!removed) {
			logger.warn(
				`${TOOL_NAMES.DELETE}: removed nothing for ${kind} ${args.ids.join(", ")}`,
				{ success: res.success, message: res.message, results: res.results },
			);
		}

		return deleteReport(kind, args.ids, res, removed, removedCount);
	}

	// --- Registration helper ---

	function register(
		name: keyof typeof TOOL_DESCRIPTIONS,
		inputSchema: Record<string, unknown>,
		handler: (
			args: Record<string, unknown>,
			extra?: { signal?: AbortSignal },
		) => Promise<ToolResult>,
		annotations?: {
			readOnlyHint?: boolean;
			destructiveHint?: boolean;
			openWorldHint?: boolean;
			idempotentHint?: boolean;
		},
		outputSchema?: Record<string, unknown>,
	) {
		const desc = TOOL_DESCRIPTIONS[name];
		const isDeprecated = (DEPRECATED_TOOL_NAMES as readonly string[]).includes(name);
		const counted = (
			args: Record<string, unknown>,
			extra?: { signal?: AbortSignal },
		) => trackInFlight(() => handler(args, extra));
		const wrapped = isDeprecated
			? (args: Record<string, unknown>, extra?: { signal?: AbortSignal }) => {
					warnDeprecatedAlias(name);
					return counted(args, extra);
				}
			: counted;
		server.registerTool(
			name,
			{
				title: desc.title,
				description: desc.description,
				inputSchema: inputSchema as never,
				...(outputSchema ? { outputSchema: outputSchema as never } : {}),
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
			.enum(["fast", "thinking", "auto"])
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.QUERY].params.mode),
		graph_context: z
			.boolean()
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.QUERY].params.graph_context),
		detail: z
			.enum(["compact", "full"])
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.QUERY].params.detail),
		operator: z
			.enum(["or", "and", "phrase"])
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.QUERY].params.operator),
		source_ids: z
			.array(z.string())
			.min(1)
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.QUERY].params.source_ids),
		metadata_filters: z
			.record(z.unknown())
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.QUERY].params.metadata_filters),
		num_related_chunks: z
			.number()
			.int()
			.min(0)
			.max(5)
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.QUERY].params.num_related_chunks),
	};

	const storeSchema = {
		text: z
			.string()
			.max(MAX_TEXT_CHARS, {
				message: `text must be at most ${MAX_TEXT_CHARS} characters`,
			})
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.STORE].params.text),
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
		overwrite: z
			.boolean()
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.STORE].params.overwrite),
	};

	const ingestMetadataSchema = {
		metadata: z
			.record(z.unknown())
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.INGEST].params.metadata),
		observation_date: z
			.string()
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.INGEST].params.observation_date),
	};

	const ingestSchema = {
		...storeSchema,
		...ingestMetadataSchema,
		// Canonical ingest accepts EITHER `text` or `turns`, so `text` is optional
		// here (the `hydra_db_store` alias keeps it required).
		text: z
			.string()
			.max(MAX_TEXT_CHARS, {
				message: `text must be at most ${MAX_TEXT_CHARS} characters`,
			})
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.INGEST].params.text),
		kind: z
			.enum(["memory", "knowledge"])
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.INGEST].params.kind),
		turns: z
			.array(turnSchema)
			.min(1)
			.max(MAX_TURNS, { message: `at most ${MAX_TURNS} turns per ingest` })
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.INGEST].params.turns),
		// `text` and `turns` are mutually exclusive and exactly one is required.
		// JSON Schema cannot express that, so the rule lives in three places: the
		// tool description, these two param descriptions, and the handler check
		// below. They must agree — a model that reads "provide turns rather than
		// text" concludes both are allowed and discovers otherwise at runtime.
		user_name: z
			.string()
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.INGEST].params.user_name),
	};

	const conversationSchema = {
		turns: z
			.array(turnSchema)
			.min(1)
			.max(MAX_TURNS, { message: `at most ${MAX_TURNS} turns per ingest` })
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
		// Required, not defaulted. `hydradb_list({})` used to return memories only
		// and read as the complete inventory, so a caller asking "what does Hydra
		// DB have?" never saw the knowledge corpus — which hydradb_query searches
		// by default. Same class of bug as the query `kind` pin, on the list path.
		kind: z
			.enum(["memory", "knowledge"])
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.LIST].params.kind),
		ids: z
			.array(z.string())
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.LIST].params.source_ids),
		source_ids: z
			.array(z.string())
			.optional()
			.describe("Deprecated alias for `ids`."),
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
		// CONTRACT §1 says a source's identifier field is `id`, but this surface
		// spelled one concept three ways across tools meant to chain: inspect took
		// `source_id`, list took `source_ids`, delete took `id`. `id` is canonical
		// here; the old spelling stays accepted so nothing breaks.
		id: z
			.string()
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.INSPECT].params.source_id),
		source_id: z
			.string()
			.optional()
			.describe("Deprecated alias for `id`."),
		mode: z
			.enum(["content", "url", "both"])
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.INSPECT].params.mode),
		offset: z
			.number()
			.int()
			.min(0)
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.INSPECT].params.offset),
		limit: z
			.number()
			.int()
			.min(1)
			.max(INSPECT_CHAR_BUDGET)
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.INSPECT].params.limit),
		expiry_seconds: z
			.number()
			.int()
			.min(1)
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.INSPECT].params.expiry_seconds),
	};

	const deleteSchema = {
		ids: z
			.array(z.string())
			.min(1)
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.DELETE].params.ids),
		id: z
			.string()
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.DELETE].params.id),
		kind: z
			.enum(["memory", "knowledge"])
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.DELETE].params.kind),
	};

	// Output schemas, declared only where the result is genuinely structured.
	// Query stays prose: its payload IS text, and forcing it into fields would
	// duplicate the rendered context rather than replace it.
	const listOutputSchema = {
		kind: z.enum(["memory", "knowledge"]),
		items: z.array(
			z.object({
				id: z.string(),
				title: z.string().optional(),
				type: z.string().optional(),
				content: z.string().optional(),
			}),
		),
		shown: z.number(),
		total: z.number(),
		page: z.number(),
		has_more: z.boolean(),
	};

	const ingestOutputSchema = {
		id: z.string().optional(),
		success_count: z.number(),
		failed_count: z.number(),
		indexing_pending: z.boolean(),
	};

	const deleteOutputSchema = {
		ids: z.array(z.string()),
		kind: z.enum(["memory", "knowledge"]),
		deleted: z.boolean(),
		deleted_count: z.number(),
		partial: z.boolean().optional(),
		reason: z.string().optional(),
	};

	const statusSchema = {
		ids: z
			.array(z.string())
			.min(1)
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.STATUS].params.ids),
	};

	const deleteMemorySchema = {
		memory_id: z
			.string()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.DELETE_MEMORY].params.memory_id),
	};

	// `destructiveHint` was missing from the annotations type, so no tool could
	// declare it — and the MCP spec defaults it to TRUE for any non-readonly
	// tool. A spec-following host therefore read hydradb_ingest as destructive
	// and could prompt the user before every proactive save, which is exactly the
	// behaviour the instructions now ask for. Meanwhile hydradb_delete, which IS
	// destructive, was landing there only by absence — one refactor adding an
	// explicit `readOnlyHint: false` would have flipped it.
	//
	// All four are stated on every tool so none of them depends on a default.
	const readOnly = {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	};
	const searchAnnotations = readOnly;
	/** Adds context; never removes any. Repeating it is not a no-op. */
	const additiveWrite = {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true,
	};
	/** Removes context irreversibly. Repeating it is harmless once it is gone. */
	const destructive = {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
		openWorldHint: true,
	};

	// --- Canonical tools ---

	register(
		TOOL_NAMES.QUERY,
		querySchema,
		(args, extra) => runQuery(args as Parameters<typeof runQuery>[0], extra?.signal),
		searchAnnotations,
	);

	register(
		TOOL_NAMES.INGEST,
		ingestSchema,
		async (args, extra) => {
		const a = args as {
			text?: string;
			kind?: ContextKind;
			title?: string;
			source_id?: string;
			infer?: boolean;
			is_markdown?: boolean;
			overwrite?: boolean;
			metadata?: Record<string, unknown>;
			observation_date?: string;
			turns?: ConversationTurn[];
			user_name?: string;
		};
		const hasTurns = a.turns != null && a.turns.length > 0;

		// A conversation is a memory by definition; there is no knowledge document
		// made of user/assistant pairs. Reject rather than quietly ingesting it as
		// the wrong family.
		if (hasTurns && a.kind === "knowledge") {
			throw new Error(
				`${TOOL_NAMES.INGEST} cannot ingest \`turns\` as knowledge — conversations are memories. ` +
				`Use \`text\` for a knowledge document, or drop \`kind\`.`,
			);
		}

		// The handler strips memory-only fields before calling the wrapper on the
		// knowledge path, which means the wrapper's own guard never sees them —
		// so without this they would be dropped in silence, which is the exact
		// behaviour that guard exists to prevent.
		if (a.kind === "knowledge") {
			const memoryOnlyGiven = (
				[
					["source_id", a.source_id],
					["infer", a.infer],
					["is_markdown", a.is_markdown],
					["user_name", a.user_name],
					["metadata", a.metadata],
					["observation_date", a.observation_date],
				] as const
			)
				.filter(([, value]) => value != null)
				.map(([name]) => name);

			if (memoryOnlyGiven.length > 0) {
				throw new Error(
					`${TOOL_NAMES.INGEST} does not support ${memoryOnlyGiven.join(", ")} for ` +
					`kind "knowledge" — those apply to memory ingestion only. Drop them, or ` +
					`ingest this as a memory.`,
				);
			}
		}
		// `text` and `turns` are mutually exclusive — reject rather than silently
		// dropping one (the documented "exactly one" contract).
		if (hasTurns && a.text != null) {
			throw new Error(
				`${TOOL_NAMES.INGEST} accepts either \`text\` (a note) or \`turns\` (a conversation), not both.`,
			);
		}
		if (a.turns != null && a.turns.length > 0) {
			const sourceId = a.source_id ?? generatedSourceId();
			// Forward every option the canonical schema accepts so none is
			// silently dropped on the conversation path.
			return runIngestConversation(
				a.turns,
				sourceId,
				{
					userName: a.user_name,
					infer: a.infer,
					title: a.title,
					isMarkdown: a.is_markdown,
					overwrite: a.overwrite,
				},
				extra?.signal,
			);
		}
		if (a.text != null) {
			return runStore(
				{
					text: a.text,
					kind: a.kind,
					title: a.title,
					source_id: a.source_id,
					infer: a.infer,
					is_markdown: a.is_markdown,
					overwrite: a.overwrite,
					metadata: a.metadata,
					observation_date: a.observation_date,
				},
				extra?.signal,
			);
		}
			throw new Error(
				`${TOOL_NAMES.INGEST} requires either \`text\` (a note) or \`turns\` (a conversation).`,
			);
		},
		additiveWrite,
		ingestOutputSchema,
	);

	register(
		TOOL_NAMES.LIST,
		listSchema,
		(args, extra) => {
			const a = args as {
				kind?: "memory" | "knowledge";
				ids?: string[];
				source_ids?: string[];
				page?: number;
				page_size?: number;
			};
			// Compare as SETS. These are filters, so order carries no meaning —
			// rejecting ["a","b"] against ["b","a"] refuses a request that asked
			// for exactly one thing, which is worse than the ambiguity the check
			// exists to catch.
			// Compare DISTINCT members. An earlier version compared lengths and
			// union size, which called ["a","b"] and ["a","a"] equivalent — same
			// length, same union size — and then silently listed records the
			// deprecated filter had excluded.
			const sameIds = (x: string[], y: string[]) => {
				const left = new Set(x);
				const right = new Set(y);
				return left.size === right.size && [...left].every((v) => right.has(v));
			};
			if (
				a.ids != null &&
				a.source_ids != null &&
				!sameIds(a.ids, a.source_ids)
			) {
				throw new Error(
					`${TOOL_NAMES.LIST} received different values for \`ids\` and its deprecated ` +
					`alias \`source_ids\`. Pass only \`ids\`.`,
				);
			}
			const ids = a.ids ?? a.source_ids;
			if (a.kind === "knowledge") {
				return runListSources(
					{ source_ids: ids, page: a.page, page_size: a.page_size },
					extra?.signal,
				);
			}
			return runListMemories(
				{ source_ids: ids, page: a.page, page_size: a.page_size },
				extra?.signal,
			);
		},
		readOnly,
		listOutputSchema,
	);

	register(
		TOOL_NAMES.INSPECT,
		inspectSchema,
		(args, extra) => runInspect(toInspectArgs(args), extra?.signal),
		readOnly,
	);

	register(
		TOOL_NAMES.DELETE,
		deleteSchema,
		(args, extra) => runDelete(toDeleteArgs(args), extra?.signal),
		destructive,
		deleteOutputSchema,
	);

	register(
		TOOL_NAMES.STATUS,
		statusSchema,
		(args, extra) => runStatus(args as Parameters<typeof runStatus>[0], extra?.signal),
		readOnly,
	);

	// --- Deprecated aliases ---
	//
	// Registered only when HYDRADB_MCP_LEGACY_TOOLS is set. Off by default.
	//
	// Twelve tools is not the problem; adversarial naming is. The alias names are
	// systematically better literal matches for how users phrase requests than
	// the canonical ones — "search my memory" matches hydra_db_search exactly
	// while hydradb_query needs a synonym step, "list my memories" matches
	// hydra_db_list_memories verbatim while hydradb_list additionally needs
	// `kind` inferred. Every canonical tool has a competitor that wins on surface
	// form AND requires fewer inferential steps to parameterise, against nothing
	// but a "DEPRECATED" prefix — a negative instruction losing to a positive
	// lexical match.
	//
	// The cost of losing that contest is real capability, not just a warning:
	// hydra_db_ingest_conversation cannot set kind, overwrite, title, infer or
	// is_markdown, and hydra_db_store has no path to `turns`. A model that picks
	// the alias because the name matched silently gets the lesser tool.
	//
	// They also cost every conversation ~1,800 tokens of manifest — 55% of it —
	// before a single call is made.
	if (legacyToolsEnabled()) {

	register(
		TOOL_NAMES.SEARCH,
		querySchema,
		(args, extra) => runQuery(args as Parameters<typeof runQuery>[0], extra?.signal),
		searchAnnotations,
	);

	register(
		TOOL_NAMES.STORE,
		storeSchema,
		(args, extra) => runStore(args as Parameters<typeof runStore>[0], extra?.signal),
		additiveWrite,
	);

	register(
		TOOL_NAMES.INGEST_CONVERSATION,
		conversationSchema,
		(args, extra) => {
		const a = args as {
			turns: ConversationTurn[];
			source_id: string;
			user_name?: string;
		};
		// The deprecated alias keeps its historical shape (user_name only; infer
		// on, no title/markdown). The canonical hydradb_ingest forwards the rest.
			return runIngestConversation(
				a.turns,
				a.source_id,
				{ userName: a.user_name },
				extra?.signal,
			);
		},
		additiveWrite,
	);

	register(
		TOOL_NAMES.LIST_MEMORIES,
		{},
		(_args, extra) => runListMemories({}, extra?.signal),
		readOnly,
	);

	register(
		TOOL_NAMES.LIST_SOURCES,
		listSourcesSchema,
		(args, extra) =>
			runListSources(args as { source_ids?: string[] }, extra?.signal),
		readOnly,
	);

	register(
		TOOL_NAMES.FETCH_CONTENT,
		inspectSchema,
		(args, extra) => runInspect(toInspectArgs(args), extra?.signal),
		readOnly,
	);

	register(
		TOOL_NAMES.DELETE_MEMORY,
		deleteMemorySchema,
		(args, extra) => {
			const { memory_id } = args as { memory_id: string };
			return runDelete({ ids: [memory_id], kind: "memory" }, extra?.signal);
		},
		destructive,
	);
	}

	return server.server;
}
