import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { toAddMemoryResponse, toMemoryList, toRecallResponse, toSourceList } from "./adapters.js";
import type { PageInfo } from "./adapters.js";
import { resolveConfig } from "./config.js";
import { buildRecalledContext } from "./context.js";
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
};

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
		mode?: "fast" | "thinking";
		graph_context?: boolean;
	}, signal?: AbortSignal): Promise<ToolResult> {
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
		}, { signal });
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
					}
				: {};

		const raw = await hydra.context.ingest({
			kind,
			text: args.text,
			title: args.title ?? (kind === "memory" ? "MCP Memory" : undefined),
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

		return textResult(
			`Saved to Hydra DB${id ? ` (id: ${id})` : ""} ` +
			`(${res.success_count} success, ${res.failed_count} failed).` +
			indexingNote(res) +
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

		return textResult(
			`Ingested ${turns.length} conversation turn(s) into Hydra DB ` +
			`(id: ${createdId(res) ?? sourceId}, success: ${res.success_count}, failed: ${res.failed_count})` +
			indexingNote(res) +
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

		// `total > shown` is NOT a usable "more exists" test on its own: on the
		// last page of a large corpus it is still true (12 shown of 412) and would
		// point the caller at a page that does not exist. Prefer what the server
		// stated, then the page arithmetic, and only then the row comparison —
		// which is correct on page 1, the only place it is reached.
		const seen = (current - 1) * (page.page_size ?? shown) + shown;
		const hasMore =
			page.has_next ??
			(page.total_pages != null ? current < page.total_pages : seen < total);

		if (!hasMore && current === 1) return `${shown}`;

		const more = hasMore ? ` — pass page=${current + 1} for more` : "";
		return `${shown} of ${total} (page ${current})${more}`;
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

	/**
	 * How much source text one inspect call may put into the caller's context.
	 *
	 * Roughly 5k tokens. Large enough that ordinary documents come back whole,
	 * small enough that no single call can dominate a conversation.
	 */
	const INSPECT_CHAR_BUDGET = 20_000;

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
				const summary = res.inferredContent
					? `\n\nSummary of the content:\n${res.inferredContent}`
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

	async function runInspect(args: {
		source_id: string;
		mode?: "content" | "url" | "both";
		offset?: number;
		limit?: number;
	}, signal?: AbortSignal): Promise<ToolResult> {
		logger.debug(`${TOOL_NAMES.INSPECT}: ${args.source_id}`);

		const res = await hydra.context.inspect({
			id: args.source_id,
			mode: args.mode ?? "content",
		}, { signal });

		// Soft failure: return a normal (non-error) text result, matching v1.
		if (!res.success || res.error) {
			return textResult(
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
	}, signal?: AbortSignal): Promise<ToolResult> {
		const kind = args.kind ?? "memory";
		logger.debug(`${TOOL_NAMES.DELETE}: ${kind} ${args.id}`);

		const res = await hydra.context.delete({ ids: [args.id], kind }, { signal });
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
		handler: (
			args: Record<string, unknown>,
			extra?: { signal?: AbortSignal },
		) => Promise<ToolResult>,
		annotations?: {
			readOnlyHint?: boolean;
			openWorldHint?: boolean;
			idempotentHint?: boolean;
		},
	) {
		const desc = TOOL_DESCRIPTIONS[name];
		const isDeprecated = (DEPRECATED_TOOL_NAMES as readonly string[]).includes(name);
		const wrapped = isDeprecated
			? (args: Record<string, unknown>, extra?: { signal?: AbortSignal }) => {
					warnDeprecatedAlias(name);
					return handler(args, extra);
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

	const ingestSchema = {
		...storeSchema,
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
	};

	const deleteSchema = {
		id: z.string().describe(TOOL_DESCRIPTIONS[TOOL_NAMES.DELETE].params.id),
		kind: z
			.enum(["memory", "knowledge"])
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.DELETE].params.kind),
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
		(args, extra) => runQuery(args as Parameters<typeof runQuery>[0], extra?.signal),
		searchAnnotations,
	);

	register(TOOL_NAMES.INGEST, ingestSchema, async (args, extra) => {
		const a = args as {
			text?: string;
			kind?: ContextKind;
			title?: string;
			source_id?: string;
			infer?: boolean;
			is_markdown?: boolean;
			overwrite?: boolean;
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
				},
				extra?.signal,
			);
		}
		throw new Error(
			`${TOOL_NAMES.INGEST} requires either \`text\` (a note) or \`turns\` (a conversation).`,
		);
	});

	register(
		TOOL_NAMES.LIST,
		listSchema,
		(args, extra) => {
			const a = args as {
				kind?: "memory" | "knowledge";
				source_ids?: string[];
				page?: number;
				page_size?: number;
			};
			if ((a.kind ?? "memory") === "knowledge") {
				return runListSources(
					{ source_ids: a.source_ids, page: a.page, page_size: a.page_size },
					extra?.signal,
				);
			}
			return runListMemories(
				{ source_ids: a.source_ids, page: a.page, page_size: a.page_size },
				extra?.signal,
			);
		},
		readOnly,
	);

	register(
		TOOL_NAMES.INSPECT,
		inspectSchema,
		(args, extra) =>
			runInspect(args as Parameters<typeof runInspect>[0], extra?.signal),
		readOnly,
	);

	register(TOOL_NAMES.DELETE, deleteSchema, (args, extra) =>
		runDelete(args as Parameters<typeof runDelete>[0], extra?.signal),
	);

	register(
		TOOL_NAMES.STATUS,
		statusSchema,
		(args, extra) => runStatus(args as Parameters<typeof runStatus>[0], extra?.signal),
		readOnly,
	);

	// --- Deprecated aliases ---

	register(
		TOOL_NAMES.SEARCH,
		querySchema,
		(args, extra) => runQuery(args as Parameters<typeof runQuery>[0], extra?.signal),
		searchAnnotations,
	);

	register(TOOL_NAMES.STORE, storeSchema, (args, extra) =>
		runStore(args as Parameters<typeof runStore>[0], extra?.signal),
	);

	register(TOOL_NAMES.INGEST_CONVERSATION, conversationSchema, (args, extra) => {
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
	});

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
		(args, extra) =>
			runInspect(args as Parameters<typeof runInspect>[0], extra?.signal),
		readOnly,
	);

	register(TOOL_NAMES.DELETE_MEMORY, deleteMemorySchema, (args, extra) => {
		const { memory_id } = args as { memory_id: string };
		return runDelete({ id: memory_id, kind: "memory" }, extra?.signal);
	});

	return server.server;
}
