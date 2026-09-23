import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { toAddMemoryResponse, toMemoryList, toSourceList } from "./adapters.js";
import type { PageInfo } from "./adapters.js";
import { resolveConfig, resolveGraphConfig } from "./config.js";
import type { GraphConfig } from "./config.js";
import { boundStructuredContent, fitUnifiedPrompt, renderRecalledContext, unifiedStructuredContent } from "./context.js";
import { COLLECTION_PATTERN, MAX_BODY_BYTES, renderRows } from "./cypher.js";
import { SERVER_INSTRUCTIONS, TOOL_DESCRIPTIONS } from "./descriptions.js";
import {
	assertCollectionAllowed,
	assertDatabaseAllowed,
	HydraDB,
	isUnifiedQueryResult,
} from "./hydra/index.js";
import type { ContextCategory, ContextKind, QueryKind, UnifiedQueryResult } from "./hydra/index.js";
import { HydraWrapperError } from "./hydra/index.js";
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
 * The machine-readable code the server sends when a request's `type` is not one
 * the target database can answer — which on a defaulted kind means the storage
 * layout is not the one this process assumed (PRO-1618,
 * hydradb-application#870, `ErrCodeCorpusTypeUnsupported`).
 *
 * Deciding whether to retry as `unified` used to rest entirely on a regex over
 * the server's English message: it changes with copy edits, and it already had
 * two wordings to match. The code is the stable signal; the prose match
 * survives only as a fallback, for a server that predates the code and for the
 * one refusal that still goes out without it (see `refusedForUnified`).
 */
const UNIFIED_LAYOUT_ERROR_CODE = "CORPUS_TYPE_UNSUPPORTED";

/**
 * The error code an API failure body carries, if any.
 *
 * Reads the v2 envelope's `error.code` first and the deprecated
 * `detail.error_code` second — both are written on the same response, and a
 * client that reads only one is betting on which half a given handler filled
 * in.
 */
function layoutErrorCode(body: unknown): string | undefined {
	if (body == null || typeof body !== "object") return undefined;
	const record = body as { error?: unknown; detail?: unknown };
	const error = record.error;
	if (error != null && typeof error === "object") {
		const { code } = error as { code?: unknown };
		if (typeof code === "string" && code !== "") return code;
	}
	const detail = record.detail;
	if (detail != null && typeof detail === "object") {
		const legacy = (detail as { error_code?: unknown }).error_code;
		if (typeof legacy === "string" && legacy !== "") return legacy;
	}
	return undefined;
}

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
 * A key-order-independent encoding, for telling whether two records the
 * caller sent under two names say the same thing. Only objects are
 * normalised; arrays keep their order because it carries meaning there.
 */
function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, inner: unknown) => {
		if (inner == null || typeof inner !== "object" || Array.isArray(inner)) return inner;
		const record = inner as Record<string, unknown>;
		return Object.fromEntries(Object.keys(record).sort().map((k) => [k, record[k]]));
	});
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
 * The collection names a `/query` refusal says are not searchable, from the
 * API's `sub_tenant_ids do not exist: [a, b]` message. Empty for any other
 * error, so only that refusal can narrow a search.
 */
export function unsearchableCollections(err: unknown): string[] {
	const message = err instanceof Error ? err.message : String(err);
	const match = /(?:sub_tenant_ids|collections) do not exist: \[([^\]]*)\]/.exec(message);

	if (!match) return [];

	return match[1]
		.split(",")
		.map((name) => name.trim().replace(/^["']|["']$/g, ""))
		.filter((name) => name !== "");
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
// POST /feedback's documented bounds (internal/domain/feedback). Encoded here so
// an over-long comment is refused where the caller can still shorten it, rather
// than after a round trip — the same reason MAX_TURN_CHARS below is stated.
const MAX_FEEDBACK_CHARS = 8_000;

const MAX_GROUND_TRUTH_ANSWER_CHARS = 8_000;

const MAX_GROUND_TRUTH_SOURCE_IDS = 100;

const MAX_GROUND_TRUTH_SOURCE_ID_CHARS = 256;

const MAX_FEEDBACK_METADATA_ENTRIES = 20;

const MAX_FEEDBACK_METADATA_KEY_CHARS = 64;

const MAX_FEEDBACK_METADATA_VALUE_CHARS = 512;

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

/**
 * `observation_date` is a CALENDAR date. The server answers anything finer with
 * `400 INVALID_INPUT: observation_date "2026-08-17T00:00:00Z" is not a valid
 * ISO-8601 date (want YYYY-MM-DD)`, and a model writing a date in JSON reaches
 * for the date-time form first — so the date-time is accepted here and trimmed
 * to the date the caller wrote, rather than left to fail as a 400 from a remote
 * service after the request has gone out.
 *
 * Trimming is textual on purpose: it keeps the date as written, where converting
 * to UTC first would move "2026-08-17T23:00:00-08:00" to the 18th and silently
 * record a different day than the caller meant. The time of day is the only
 * thing dropped, and it is the part the server has nowhere to store.
 *
 * Anything that is not a date at all still fails, before the network.
 */
const OBSERVATION_DATE_PATTERN =
	/^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})?)?$/;

const CALENDAR_DATE_LENGTH = "YYYY-MM-DD".length;

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

	// `work()` may throw SYNCHRONOUSLY — a tool handler that rejects an argument
	// combination before it awaits anything (e.g. the list source-selector guard).
	// A bare `work().finally()` would let that throw escape before `.finally` is
	// attached, so `inFlight` would be incremented and never decremented, and a
	// graceful shutdown waiting for it to reach zero would hang forever. Running
	// `work` inside an async wrapper turns a synchronous throw into a rejected
	// promise, so the decrement runs on every exit path.
	return (async () => work())().finally(() => {
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

export interface ServerOptions {
	/**
	 * Register the OAuth-connection tools (currently `hydradb_databases`).
	 * Set by the HTTP transport when the request authenticated with an OAuth
	 * token; never for API keys, so their tool list is unchanged.
	 */
	oauthTools?: boolean;
}


/**
 * How long hydradb_list_collections waits for the optional database-wide row
 * counts before returning the listing without them. Stats has been observed to
 * hang on some deployments, and a discovery tool must not.
 */
let listCollectionsStatsTimeoutMs = 5000;

/** Test hook: shorten the stats wait so the abort path runs in milliseconds. */
export function __setListCollectionsStatsTimeoutForTests(ms: number): void {
	listCollectionsStatsTimeoutMs = ms;
}

/**
 * The most collections a query with no collection named searches at once. The
 * API runs one full retrieval per collection, ten in parallel, so ten is one
 * wave; past that, latency and cost grow with every collection added, and the
 * model is better served by being told to choose.
 */
const QUERY_FANOUT_MAX_COLLECTIONS = 10;

/**
 * How long a query waits for the collection listing before searching the
 * default scope as it always did. The listing has been observed to hang on
 * some deployments, and it must never be the reason a search stalls.
 */
let fanoutListTimeoutMs = 3000;

/** Test hook: shorten the listing wait so the timeout path runs in milliseconds. */
export function __setFanoutListTimeoutForTests(ms: number): void {
	fanoutListTimeoutMs = ms;
}

/** Collection names from a listing payload, or null when it is malformed. */
function collectionNamesOf(res: unknown): string[] | null {
	const raw = res as { collections?: unknown; subTenantIds?: unknown; sub_tenant_ids?: unknown } | null;
	const listed = raw?.collections ?? raw?.subTenantIds ?? raw?.sub_tenant_ids;

	if (!Array.isArray(listed) || listed.some((id) => typeof id !== "string")) return null;

	return listed as string[];
}

export function createHydraDBServer(
	hydraOverride?: HydraDB,
	/**
	 * Graph scope/gating override, for tests and embedders. Without it the graph
	 * config is read from the environment exactly as the rest of the config is.
	 */
	graphOverride?: Partial<GraphConfig>,
	options: ServerOptions = {},
) {
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
	let graphConfig: GraphConfig;

	if (hydraOverride) {
		hydra = hydraOverride;
		graphConfig = { ...resolveGraphConfig(), ...graphOverride };
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
		graphConfig = { ...config.graph, ...graphOverride };
		logger.info(
			`Hydra DB connected (database=${config.database}, collection=${config.collection})`,
		);
	}

	// --- Handlers (shared by canonical tools and their deprecated aliases) ---

	/**
	 * Whether the database a call targets was created with `type: "unified"`
	 * (PRO-1618). On such a database `memory`/`knowledge` are refused by the
	 * server, so every host-owned default below switches to `unified` there;
	 * on a split database (every one created before) nothing changes. One
	 * memoised `GET /databases` probe answers for the whole process.
	 */
	async function isUnifiedDatabase(database?: string, signal?: AbortSignal): Promise<boolean> {
		const target = database?.trim() || hydra.database;
		return (await hydra.databases.layout(target, signal)) === "unified";
	}

	/**
	 * `kind: "unified"` named by the caller on a database KNOWN to be split.
	 * A unified request goes out without `type`, and a split database reads an
	 * absent type as its own default — knowledge for a search, list or delete,
	 * memory for a write — so the call would quietly succeed against a corpus
	 * the caller did not ask for. Refused here instead. Only a known layout is
	 * trusted: when the probe cannot answer, the request goes out and the
	 * server decides, as before.
	 */
	async function refuseUnifiedOnSplit(
		tool: string,
		kind: string | undefined,
		database?: string,
		signal?: AbortSignal,
	): Promise<ToolResult | undefined> {
		if (kind !== "unified") return undefined;
		const target = database?.trim() || hydra.database;

		if ((await hydra.databases.knownLayout(target, signal)) !== "split") return undefined;
		const kinds = tool === TOOL_NAMES.QUERY ? `"memory", "knowledge" or "all"` : `"memory" or "knowledge"`;

		return errorResult(
			`${tool} was called with kind "unified", but database "${target}" is a split database: ` +
				`it keeps memory and knowledge apart, so nothing was sent. Leave \`kind\` out, or pass ${kinds}.`,
		);
	}

	/**
	 * The server names the rule when a split kind reaches a unified database:
	 * `type 'memory' is not valid on a unified database`. When the kind was a
	 * host-owned DEFAULT (not the caller's choice) and the layout probe could
	 * not tell (it failed, or the database is not in the list it saw), that
	 * refusal is the missing answer: retry once as `unified` rather than fail
	 * a valid request over a transient probe. An explicit kind is never
	 * rewritten.
	 */
	function refusedForUnified(err: unknown): boolean {
		if (!(err instanceof HydraWrapperError) || err.status !== 400) return false;
		if (layoutErrorCode(err.body) === UNIFIED_LAYOUT_ERROR_CODE) {
			// The code names the CLASS — "that `type` is not one this request can
			// use" — and FOUR refusals share it, only one of which this retry
			// answers. So the code decides that we are looking at a corpus-type
			// problem, and the line below decides which one. Matching the code
			// alone would turn the other three into a second, equally refused
			// request:
			//   - `invalid type "x": must be 'knowledge', 'memory', …` (unknown value)
			//   - `invalid type 'all': … an ingest must name the one it writes to`
			//   - `type "unified" is only valid on a unified database …` — the
			//     REVERSE direction, where retrying as unified is exactly wrong
			//   - `items cannot be combined with type=knowledge …`
			// The siblings are excluded by name rather than the target being
			// matched by name, so a copy edit to the one wording we do want
			// still retries. That is the whole reason to prefer the code.
			//
			// The `all` refusal ends with layout-aware advice, and on a unified
			// database that advice contains the sentence "This database is
			// unified". The prose fallback below matches that phrase — so this
			// exclusion, keyed on the unchanged `invalid type 'all':` opening,
			// is the only thing keeping a bad `all` from being retried. Pinned
			// by test, both advice variants.
			//
			// Two of these are unreachable from this client (`all` cannot be
			// sent to `context.ingest` at all — it exists only on QueryKind —
			// and the unified body carries no `type`, so items+knowledge cannot
			// be built either). They are excluded anyway: the same list is
			// shared across four clients, unreachable-today is one config change
			// from reachable, and "correct by coincidence" is not worth keeping
			// when the alternative is one alternation.
			//
			// `only SUPPORTED on a unified database` covers one refusal that
			// does not carry THIS code: `context_category is only supported on a
			// unified database … This database is split`. It carries its own
			// `CONTEXT_CATEGORY_UNSUPPORTED` instead, deliberately, because it
			// refuses a different FIELD — the repair is "stop sending
			// context_category", not "retry with another type", and filing it
			// under the corpus code would send a caller round the `type` values
			// forever.
			//
			// So this alternation is belt and braces: that message cannot reach
			// this branch as things stand. It is kept because if anyone ever did
			// reuse the corpus code there, the failure would be a SPLIT
			// database's refusal answered by a retry as unified, in silence.
			return !/invalid type|only (?:valid|supported) on a unified database|items cannot be combined with/i.test(
				err.message,
			);
		}
		// No code: fall back to the server's English prose. Both wordings are
		// covered — `type %q is not valid on a unified database` from the
		// corpus-type check, and `this database is unified: send the content as
		// items…` from the ingest handler, which a bare /unified database/
		// pattern misses because the two words are the other way round. That
		// second one is still the ONLY refusal here that goes out with no code,
		// so this is not dead weight against a current server.
		return /is not valid on a unified database|database is unified/i.test(err.message);
	}

	async function withUnifiedFallback<K extends string, T>(
		defaulted: boolean,
		kind: K,
		run: (kind: K | "unified") => Promise<T>,
		database?: string,
	): Promise<T> {
		try {
			return await run(kind);
		} catch (err) {
			if (defaulted && kind !== "unified" && refusedForUnified(err)) {
				logger.warn("kind was defaulted but the database is unified; retrying as unified");
				const result = await run("unified");
				// The retry succeeding is the answer the probe could not give.
				// Record it, or a process whose probe failed pays the same
				// refused request on every defaulted call for the rest of its
				// life — the probe is memoised, its failure was not.
				hydra.databases.recordLayout(database?.trim() || hydra.database, "unified");
				return result;
			}
			throw err;
		}
	}

	/**
	 * A database's collections, or null when they cannot be listed within
	 * fanoutListTimeoutMs. Never throws: a query must not fail because the
	 * optional widening could not be worked out.
	 *
	 * Listed fresh on every bare query, deliberately. The HTTP server is built
	 * per request and discarded with it, so nothing here could outlive one call
	 * anyway; a cache would only have bought stdio a minute of stale listings,
	 * during which a collection this same session had just written to would
	 * be missed. One extra round-trip, bounded below, is the honest price.
	 */
	async function collectionNamesBounded(
		database: string,
		signal?: AbortSignal,
	): Promise<string[] | null> {
		if (signal?.aborted) return null;
		const ctl = new AbortController();
		const onCallerAbort = () => ctl.abort(signal?.reason);
		signal?.addEventListener("abort", onCallerAbort, { once: true });

		const timer = setTimeout(
			() => ctl.abort(new Error("collections listing timed out")),
			fanoutListTimeoutMs,
		);

		// Bounds the wait even if a transport ignored the signal.
		const aborted = new Promise<never>((_, reject) => {
			ctl.signal.addEventListener("abort", () => reject(ctl.signal.reason), { once: true });
		});

		aborted.catch(() => {});

		try {
			const res = await Promise.race([
				hydra.databases.collections(database, { signal: ctl.signal }),
				aborted,
			]);

			return collectionNamesOf(res);
		} catch {
			return null;
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onCallerAbort);
		}
	}

	function singleScope(args: { database?: string; collection?: string }) {
		return {
			database: args.database?.trim() || hydra.database,
			collection: args.collection?.trim() || hydra.collection || null,
		};
	}

	function scopeText(scope: { database: string; collection?: string | null; collections?: string[] }): string {
		return `Resolved scope: database ${JSON.stringify(scope.database)}, ` +
			(scope.collections ? `collections ${JSON.stringify(scope.collections)}` :
				scope.collection == null ? "workspace default" : `collection ${JSON.stringify(scope.collection)}`) + ".";
	}

	async function runQuery(args: {
		query: string;
		kind?: QueryKind;
		max_results?: number;
		mode?: "fast" | "thinking" | "auto";
		graph_context?: boolean;
		follow_forceful_relations?: boolean;
		detail?: "compact" | "full";
		operator?: "or" | "and" | "phrase";
		source_ids?: string[];
		titles?: string[];
		metadata_filters?: Record<string, unknown>;
		num_related_chunks?: number;
		recency_bias?: number;
		query_apps?: boolean;
		acl?: string[];
		database?: string;
		collection?: string;
		collections?: string[];
	}, signal?: AbortSignal): Promise<ToolResult> {
		// Host-owned default (CONTRACT §2 rule 5): search BOTH families. This tool
		// used to pin `kind: "memory"`, which made every ingested knowledge source
		// unreachable from the MCP — `hydradb_list`/`hydradb_inspect` could browse
		// knowledge but nothing could search it.
		const refused = await refuseUnifiedOnSplit(TOOL_NAMES.QUERY, args.kind, args.database, signal);

		if (refused) return refused;

		let kind: QueryKind =
			args.kind ?? ((await isUnifiedDatabase(args.database, signal)) ? "unified" : "all");
		// `all` on a database known to be unified names the same corpus as
		// `unified` (the server normalises it), so it is sent as `unified`: the
		// request then takes the unified route, and unified-only options such as
		// follow_forceful_relations are not refused for naming "all".

		if (kind === "all" && (await hydra.databases.knownLayout(args.database?.trim() || hydra.database, signal)) === "unified") {
			kind = "unified";
		}
		logger.debug(`${TOOL_NAMES.QUERY}: "${args.query}" (kind=${kind})`);

		const maxResults = args.max_results ?? 10;

		// No collection anywhere: none pinned on the connection, none named on
		// the call. Searching only the database's default partition is how a
		// connection reported "nothing found" over real data, because data
		// routed into named collections never lands there. Search every
		// collection instead, when there are few enough to do it in one wave.
		//
		// This never loses the default partition. The listing is the API's
		// distinct sub_tenant_id over stored sources (TenantHandler.SubTenantIDs
		// -> GetUniqueSubTenantIDs), and a bare ingest stamps the default
		// partition's id on its source row like any other. So the default is
		// listed exactly when it holds data, and searched with the rest; when it
		// is absent from the listing it is empty and nothing is left out.
		// Trimmed, with the connection's database as the fallback: the same
		// value the query client resolves, so every message names the database
		// that was actually searched.
		const database = args.database?.trim() || hydra.database;
		let scopeCollection = args.collection;
		let scopeCollections = args.collections;
		let widened: string[] | undefined;
		let tooManyToWiden: number | undefined;
		let scopeWarning: string | undefined;

		if (hydra.collection == null && args.collection == null && args.collections == null) {
			// Listing is discovery: confined like it, before anything is sent.
			assertDatabaseAllowed(database, hydra.allowedDatabases);
			const names = await collectionNamesBounded(database, signal);
			if (names == null) scopeWarning = "Collection discovery failed; only the workspace default was searched. Named collections may contain additional results.";
			const allowed = hydra.allowedCollections;
			const usable = (names ?? []).filter((n) => !allowed || allowed.includes(n));

			if (usable.length > QUERY_FANOUT_MAX_COLLECTIONS) {
				tooManyToWiden = usable.length;
				scopeWarning = `Only the workspace default was searched; ${usable.length} discovered collections exceeded the automatic search limit. Choose explicit collections for wider coverage.`;
			} else if (usable.length === 1) {
				widened = usable;
				scopeCollection = usable[0];
			} else if (usable.length > 1) {
				widened = usable;
				scopeCollections = usable;
			}
		}

		// Captured per call, not stored on the resource: two tools can be in
		// flight at once and a shared slot would hand one the other's id.
		let requestId: string | undefined;

		// Once the search scope has been chosen, a failed query must remain a
		// failure. Retrying in the workspace default silently changed the corpus
		// and could turn malformed responses or inaccessible partitions into an
		// apparently successful empty/partial answer. The one permitted retry is
		// withUnifiedFallback's kind rewrite, which fires only on the server's
		// own "unified database" refusal and re-sends the same scope.
		const search = () => withUnifiedFallback(args.kind == null, kind, (kindToSend) => hydra.context.query({
			query: args.query,
			kind: kindToSend,
			maxResults,
			mode: args.mode ?? "thinking",
			operator: args.operator,
			ids: args.source_ids,
			titles: args.titles,
			metadataFilters: args.metadata_filters,
			acl: args.acl,
			numRelatedChunks: args.num_related_chunks,
			graphContext: args.graph_context ?? true,
			// Forwarded only as the caller gave it: the server defaults it to
			// true, and the wrapper refuses it on a split request, so a
			// manufactured value here would fail every split query.
			followForcefulRelations: args.follow_forceful_relations,
			queryApps: args.query_apps,
			database: args.database,
			collection: scopeCollection,
			collections: scopeCollections,
			// Host-owned default (CONTRACT §2 rule 5), but only where it means
			// something: alpha balances dense against sparse retrieval in HYBRID
			// mode, and an `operator` switches the query to text retrieval (see
			// the wrapper), where there are no two lanes to weigh. Injecting it
			// there would send a hybrid-only knob on a request that is not hybrid.
			alpha: args.operator != null ? undefined : 0.8,
			// Host-owned default (CONTRACT §2 rule 5), and 0 is also what the API
			// applies when the field is omitted — so the default ranking is
			// unchanged. It stops being a constant here because "what is the
			// current state of X" is a different question from "what matches X",
			// and only a caller that can raise this can ask the first one.
			recencyBias: args.recency_bias ?? 0,
		}, {
			signal,
			onMeta: (meta) => {
				requestId = meta.requestId;
			},
		}), args.database);

		// The one scope change allowed after the scope was chosen: a collection
		// THIS server widened to (never one the caller named) that the API then
		// refuses as not searchable. The collection listing also returns
		// graph-only (BYOG) collections — one hydradb_graph_query write creates
		// `default` — and a search naming one fails whole with "sub_tenant_ids do
		// not exist: [default]". Dropping just the refused names and searching
		// the rest is the same workaround a caller applies by naming the
		// collection, and the answer says which were skipped.
		let raw: Awaited<ReturnType<typeof search>>;

		try {
			raw = await search();
		} catch (err) {
			const refusedNames = widened ? unsearchableCollections(err) : [];
			const remaining = (widened ?? []).filter((n) => !refusedNames.includes(n));

			if (refusedNames.length === 0 || remaining.length === 0 || remaining.length === widened?.length) throw err;
			widened = remaining;

			if (remaining.length === 1) {
				scopeCollection = remaining[0];
				scopeCollections = undefined;
			} else {
				scopeCollections = remaining;
			}

			const skipped = refusedNames.map((n) => JSON.stringify(n)).join(", ");
			scopeWarning =
				`Skipped collection${refusedNames.length === 1 ? "" : "s"} ${skipped}: listed for this database ` +
				`but not searchable (for example a graph-only collection). The other collections were searched.`;
			logger.warn(`${TOOL_NAMES.QUERY}: retrying without unsearchable collection(s) ${skipped}`);
			raw = await search();
		}

		// Seen the unified body on a request that did not name `unified`: the
		// database is unified whatever the probe said, so later calls skip it.
		if (isUnifiedQueryResult(raw) && kind !== "unified") {
			hydra.databases.recordLayout(database, "unified");
		}

		// A unified database (PRO-1618) answers with the four-key body, decided
		// by SHAPE rather than by the kind that was sent: a server that predates
		// the unified response still answers a unified request in v2, and that
		// goes on to the v2 renderer below exactly as before.
		if (isUnifiedQueryResult(raw)) {
			return renderUnifiedQuery(raw, kind, requestId, { detail: args.detail, scopeWarning });
		}

		// The renderer reads the SDK payload directly; there is no longer a
		// snake_case mirror to convert into.
		const res = raw;
		const searchedCollections = scopeCollections != null
			? Array.isArray(scopeCollections) ? scopeCollections : Object.keys(scopeCollections)
			: undefined;
		const resolvedScope = searchedCollections
			? { database, collections: searchedCollections }
			: singleScope({ database, collection: scopeCollection });
		const queryResult = (text: string, extra: Record<string, unknown> = {}) => structuredResult(scopeWarning ? `${text}\n\nScope warning: ${scopeWarning}` : text, {
			resolved_scope: resolvedScope, ...(requestId ? { request_id: requestId } : {}), ...extra,
			...(scopeWarning ? { scope_warning: scopeWarning } : {}),
		});

		// The server can return more chunks than were asked for — a live call with
		// max_results=10 came back with 15, and all 15 were rendered. Honour the
		// parameter here so it means what its description says.
		if (res.chunks != null && res.chunks.length > maxResults) {
			res.chunks = res.chunks.slice(0, maxResults);
		}

		if (!res.chunks || res.chunks.length === 0) {
			// Name WHERE nothing was found. "No results" is ambiguous the moment a
			// database has more than one collection: a pinned collection can be the
			// wrong partition, and the caller has no way to tell an empty collection
			// from an empty database unless the result says which it searched.
			// Point at the discovery tool rather than letting the model conclude
			// the data does not exist.
			if (widened != null && widened.length > 1) {
				return queryResult(
					`No relevant ${resultNoun(kind)} found in any of the ${widened.length} collections of database ` +
						`"${database}" (${widened.join(", ")}). Try rephrasing the question, or pass \`collection\` ` +
						`to search one collection with its full result budget.`,
				);
			}

			// A bare `collections` (several at once) is also an explicit scope;
			// do not report it as though the connection's default was searched.
			const scope =
				scopeCollection ??
				(scopeCollections != null
					? Array.isArray(scopeCollections)
						? scopeCollections.join(", ")
						: Object.keys(scopeCollections).join(", ")
					: hydra.collection);

			const tooMany =
				tooManyToWiden != null
					? ` This database has ${tooManyToWiden} collections, more than the ${QUERY_FANOUT_MAX_COLLECTIONS} searched automatically.`
					: "";

			return queryResult(
				scope != null
					? `No relevant ${resultNoun(kind)} found in collection "${scope}" of database "${database}". ` +
						`The data may live in another collection — call ${TOOL_NAMES.LIST_COLLECTIONS} to list them, ` +
						`then pass \`collection\` (or \`collections\` to search several at once).`
					: `No relevant ${resultNoun(kind)} found in database "${database}" — with no collection ` +
						`named, the search ran in this connection's workspace default. If the data could live ` +
						`elsewhere, call ${TOOL_NAMES.LIST_COLLECTIONS} and pass \`collection\` (or \`collections\` ` +
						`to search several at once).${tooMany}`,
			);
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
		// The request id is the ONLY key POST /feedback correlates on, and it
		// cannot be reconstructed later — if it is not printed here, the feedback
		// tool has nothing to attach a submission to. Rendered on its own line so
		// a model copies it verbatim rather than reformatting it.
		const feedbackLine = requestId
			? `\nWas this useful? Report it with ${TOOL_NAMES.FEEDBACK} using request_id: ${requestId}`
			: "";

		const legend =
			`\n\n---\nEach [id: …] is a source id: pass one to ${TOOL_NAMES.INSPECT} for that ` +
			`source's content, or to ${TOOL_NAMES.DELETE} to remove it. Keep the resolved database, the source's collection, and your ACL on follow-up calls. ` +
			`For a multi-collection result without a source collection, resolve that scope before inspecting; do not guess. ` +
			`Continue inspect slices with next_args until has_more is false; a slice is not the whole document.` +
			feedbackLine;

		const scopeLine = scopeText(resolvedScope);
		const headerAllowance = 120 + scopeLine.length + (scopeWarning?.length ?? 0) + 20;
		const sourceRefs = new Map<string, Record<string, unknown>>();
		const singleCollection = "collection" in resolvedScope
			? resolvedScope.collection
			: searchedCollections?.length === 1 ? searchedCollections[0] : undefined;
		const scopedChunks = (res.chunks ?? []).map((chunk) => {
			const collection = chunk.collection || singleCollection;
			// A multi-collection result needs per-source provenance; an id alone
			// is not unique across partitions. Never remember a shared last scope.
			const scopeKnown = searchedCollections
				? typeof collection === "string" && searchedCollections.includes(collection)
				: "collection" in resolvedScope && collection === resolvedScope.collection;
			const followScope = { database, ...(collection != null ? { collection } : {}), ...(args.acl != null ? { acl: args.acl } : {}) };
			const ref = {
				id: chunk.id, collection: collection ?? null,
				...(chunk.sourceTitle ? { title: chunk.sourceTitle } : {}),
				...(scopeKnown ? {
					inspect_args: { id: chunk.id, ...followScope },
					...(kind !== "all" ? { list_args: { kind, ids: [chunk.id], ...followScope } } : {}),
				} : { scope_unresolved: true }),
			};
			sourceRefs.set(JSON.stringify([collection, chunk.id]), ref);
			return { ...chunk, ...(collection != null ? { collection } : {}) };
		});

		const { text: contextStr, shown } = renderRecalledContext({ ...res, chunks: scopedChunks }, {
			// Compact keeps every chunk but trims each body and drops the
			// extra-context blocks; `full` is the unchanged rendering.
			...(compact
				? { maxChunkChars: COMPACT_CHUNK_CHARS, includeExtraContext: false }
				: {}),
			maxTotalChars: QUERY_CHAR_BUDGET - legend.length - headerAllowance,
		});

		return queryResult(
			`Found ${shown} ${resultNoun(kind, shown)}:\n${scopeLine}\n\n${contextStr}${legend}`,
			{ sources: [...sourceRefs.values()] },
		);
	}

	/**
	 * A unified answer (PRO-1618), rendered the way the contract asks: the
	 * server-built `llm_prompt` verbatim as the text, because it already
	 * carries the context, the forceful relations, the graph paths and the
	 * citation labels a model is meant to cite; and the four keys as
	 * structured content beside it, so a host that parses rather than reads
	 * gets `chunks[].context_id`, `score`, `content`, `enrichment` (a
	 * string), `enrichment_kind`, `graph[].origin`, `graph[].path_summary`,
	 * `forceful_relations[]` and the distinct `sources[]`.
	 *
	 * `max_results` is not re-applied here. The prompt is the server's and
	 * slicing the chunks under it would make the two views disagree; the
	 * server honours the parameter itself.
	 *
	 * Bounded by the same QUERY_CHAR_BUDGET as a split answer, without losing a
	 * citation. An unbounded answer was measured on staging at ~265k characters
	 * (~66k tokens) for one search over a 100 KB document, text and structured
	 * copy together — most of a model's context for a single tool call. The
	 * earlier objection to a budget still holds: a character cut dropped whole
	 * results and left the model citing [1], [R1] and [P1] labels whose text it
	 * never saw. So `fitUnifiedPrompt` never drops a result: every heading, id
	 * and label goes out as the server wrote it, and only long result bodies are
	 * shortened, each with a note naming hydradb_inspect for the full text. A
	 * prompt that already fits goes out byte for byte. `detail: "compact"` caps
	 * every body at COMPACT_CHUNK_CHARS, as it does on a split database. The
	 * structured copy is shortened to the same cap whenever the prompt was, and
	 * held to the same budget on its own (graph triplets and temporal facts are
	 * not in the prompt cut), every cut flagged so a host can tell.
	 */
	function renderUnifiedQuery(
		res: UnifiedQueryResult,
		kind: QueryKind,
		requestId?: string,
		opts: { detail?: "compact" | "full"; scopeWarning?: string } = {},
	): ToolResult {
		const { chunks, graph, forceful_relations: forcefulRelations } = res;
		// The same line and the same structured field as the v2 path above: the
		// request id is the ONLY key POST /feedback correlates on, and an empty
		// answer is still a query the caller may want to rate.
		const feedbackLine = requestId
			? `\nWas this useful? Report it with ${TOOL_NAMES.FEEDBACK} using request_id: ${requestId}`
			: "";

		const warningLine = opts.scopeWarning ? `\n\nScope warning: ${opts.scopeWarning}` : "";
		const warningField = opts.scopeWarning ? { scope_warning: opts.scopeWarning } : {};

		if (chunks.length === 0 && forcefulRelations.length === 0 && graph.length === 0) {
			const text = `No relevant ${resultNoun(kind)} found in Hydra DB.${warningLine}${feedbackLine}`;

			return requestId != null || opts.scopeWarning
				? structuredResult(text, { ...(requestId != null ? { request_id: requestId } : {}), ...warningField })
				: textResult(text);
		}
		const legend =
			`\n\n---\nEach Id above is a source id (context_id in the structured content): pass one ` +
			`to ${TOOL_NAMES.INSPECT} for that source's full content, or to ${TOOL_NAMES.DELETE} to ` +
			`remove it. Results are numbered 1, 2, and so on, forceful relations R1, R2 and related ` +
			`facts P1, P2: cite them in brackets ([1], [R1], [P1]) when you use what they mark.` +
			feedbackLine;
		const extras = [
			forcefulRelations.length > 0
				? `${forcefulRelations.length} forceful relation${forcefulRelations.length === 1 ? "" : "s"}`
				: "",
			graph.length > 0 ? `${graph.length} graph path${graph.length === 1 ? "" : "s"}` : "",
		].filter((s) => s !== "");
		const header =
			`Found ${chunks.length} ${resultNoun(kind, chunks.length)}` +
			`${extras.length > 0 ? ` (${extras.join(", ")})` : ""}:`;

		const fit = fitUnifiedPrompt(res, {
			maxTotalChars: QUERY_CHAR_BUDGET - header.length - legend.length - warningLine.length - 4,
			maxBodyChars: opts.detail === "compact" ? COMPACT_CHUNK_CHARS : undefined,
		});
		const structured = unifiedStructuredContent(res, fit.bodyCap != null ? { maxChunkChars: fit.bodyCap } : {});
		// The structured copy carries graph triplets and temporal facts the
		// prompt cut does not reach, so it gets its own bound.
		const structuredCut = boundStructuredContent(structured, QUERY_CHAR_BUDGET);

		return structuredResult(
			`${header}\n\n${fit.text}${warningLine}${legend}`,
			{
				...structured,
				...(fit.trimmed || structuredCut ? { shortened: true } : {}),
				...warningField,
				...(requestId != null ? { request_id: requestId } : {}),
			},
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
		user_name?: string;
		infer?: boolean;
		is_markdown?: boolean;
		overwrite?: boolean;
		metadata?: Record<string, unknown>;
		observation_date?: string;
		/** Free-form data beside the entry (unified `custom_attributes`, split `additional_metadata`). */
		custom_attributes?: Record<string, unknown>;
		/** Replaces the host's default extraction guidance for this entry. */
		instructions?: string;
		/** Unified only; the wrapper refuses it on a split database. */
		context_category?: ContextCategory;
		/** Unified only; the wrapper refuses it on a split database. */
		forceful_relations?: string[];
		/** Unified only; the wrapper refuses it on a split database. */
		acl?: string[];
		database?: string;
		collection?: string;
	}, signal?: AbortSignal): Promise<ToolResult> {
		const refused = await refuseUnifiedOnSplit(TOOL_NAMES.INGEST, args.kind, args.database, signal);

		if (refused) return refused;
		const kind: ContextKind =
			args.kind ?? ((await isUnifiedDatabase(args.database, signal)) ? "unified" : "memory");
		logger.debug(`${TOOL_NAMES.INGEST}: "${args.text.slice(0, 50)}..." (kind=${kind})`);

		// The unified item's own fields (PRO-1618) are forwarded on EVERY kind:
		// on a split database the wrapper refuses them by name, which is the
		// answer a caller who set them needs, where dropping them here would
		// report "success: 1" for a label or an ACL that was never stored.
		const unifiedOnly = {
			contextCategory: args.context_category,
			forcefulRelations:
				args.forceful_relations != null ? { ids: args.forceful_relations } : undefined,
			acl: args.acl,
		};

		// The memory item shape has no counterpart on the knowledge path, which
		// carries only a document and its filename — so those fields are sent only
		// where they mean something. The wrapper rejects them on the knowledge
		// branch rather than dropping them, and passing them here unconditionally
		// would make every knowledge write fail.
		//
		// `is_markdown` is forwarded ONLY as the caller gave it, never defaulted
		// to false here: the wrapper's memory branch already defaults it, and a
		// unified database has no field for it at all. Sending a manufactured
		// `false` would trip the wrapper's unified guard on every ingest that
		// never asked for markdown — and defaulting it away would silently drop
		// an explicit `is_markdown: true`, which is what that guard exists to
		// prevent.
		const memoryOnly =
			kind !== "knowledge"
				? {
						sourceId: args.source_id,
						userName: args.user_name,
						infer: args.infer ?? true,
						isMarkdown: args.is_markdown,
						// The caller's steering replaces the host default; it is
						// `instructions` on a unified item and `custom_instructions`
						// on a split memory item, and the wrapper picks the key.
						customInstructions: args.instructions ?? INGEST_INSTRUCTIONS,
						metadata: args.metadata,
						additionalMetadata: args.custom_attributes,
						observationDate: args.observation_date,
					}
				: {
						// The knowledge path carries neither, so only what the caller
						// SAID goes through, for the wrapper to refuse by name; the
						// host default is not manufactured here, or every knowledge
						// write would fail on it.
						customInstructions: args.instructions,
						additionalMetadata: args.custom_attributes,
					};

		const raw = await withUnifiedFallback(args.kind == null, kind, (kindToSend) => hydra.context.ingest({
			kind: kindToSend,
			text: args.text,
			title: args.title ?? defaultTitle(args.text),
			...memoryOnly,
			...unifiedOnly,
			database: args.database,
			collection: args.collection,
			// Default stays true. The SDK retries POSTs, so upsert is what keeps a
			// retried ingest from duplicating — flipping this default would trade a
			// silent overwrite for a silent duplicate.
			upsert: args.overwrite ?? true,
		}, { signal }), args.database);

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
			kind?: ContextKind;
			userName?: string;
			infer?: boolean;
			title?: string;
			isMarkdown?: boolean;
			overwrite?: boolean;
			/** The unified item's names (PRO-1618); `attributes`/`happenedAt` map onto the split memory item too. */
			attributes?: Record<string, unknown>;
			happenedAt?: string;
			customAttributes?: Record<string, unknown>;
			instructions?: string;
			contextCategory?: ContextCategory;
			forcefulRelations?: string[];
			acl?: string[];
			database?: string;
			collection?: string;
		},
		signal?: AbortSignal,
	): Promise<ToolResult> {
		// The kind was pinned to "memory" here, outside the layout resolution
		// every sibling handler goes through, so the conversation half of
		// `hydradb_ingest` answered a unified database with a 400 while the text
		// half worked — one tool, one of its two input shapes broken. Resolved
		// and retried exactly as `runStore` does.
		const refused = await refuseUnifiedOnSplit(TOOL_NAMES.INGEST, opts?.kind, opts?.database, signal);

		if (refused) return refused;
		const kind: ContextKind =
			opts?.kind ?? ((await isUnifiedDatabase(opts?.database, signal)) ? "unified" : "memory");
		logger.debug(
			`${TOOL_NAMES.INGEST}: ${turns.length} turns -> ${sourceId} (kind=${kind})`,
		);

		const raw = await withUnifiedFallback(opts?.kind == null, kind, (kindToSend) => hydra.context.ingest({
			kind: kindToSend,
			pairs: turns,
			sourceId,
			// On the unified path this is the item's `user_name`, which is where
			// speaker identity lives there — so it is carried, not dropped.
			userName: opts?.userName ?? "User",
			infer: opts?.infer ?? true,
			title: opts?.title,
			isMarkdown: opts?.isMarkdown,
			customInstructions: opts?.instructions ?? INGEST_INSTRUCTIONS,
			metadata: opts?.attributes,
			observationDate: opts?.happenedAt,
			additionalMetadata: opts?.customAttributes,
			contextCategory: opts?.contextCategory,
			forcefulRelations:
				opts?.forcefulRelations != null ? { ids: opts.forcefulRelations } : undefined,
			acl: opts?.acl,
			upsert: opts?.overwrite ?? true,
			database: opts?.database,
			collection: opts?.collection,
		}, { signal }), opts?.database);

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

	/**
	 * `hydradb_list`, with the corpus resolved the way every other tool
	 * resolves it (PRO-1618).
	 *
	 * `kind` is the caller's when they gave one — an explicit kind is never
	 * rewritten. When they did not, the layout decides: `unified` on a unified
	 * database (which accepts nothing else), `memory` on a split one, and the
	 * same one-shot retry the other tools use covers a layout probe that could
	 * not answer.
	 */
	async function runList(args: {
		kind?: ContextKind;
		source_ids?: string[];
		external_id?: string;
		parent_external_id?: string;
		connector_id?: string;
		url?: string;
		provider?: string;
		page?: number;
		page_size?: number;
		acl?: string[];
		database?: string;
		collection?: string;
	}, signal?: AbortSignal): Promise<ToolResult> {
		const refused = await refuseUnifiedOnSplit(TOOL_NAMES.LIST, args.kind, args.database, signal);

		if (refused) return refused;
		const defaulted = args.kind == null;
		const kind: ContextKind =
			args.kind ?? ((await isUnifiedDatabase(args.database, signal)) ? "unified" : "memory");

		// external_id/url/provider resolve a source by its originating-system
		// identity via /context/list source_fields, which only exist on the
		// source corpus — a split database's memories have no provider
		// identity. A unified database holds every item in the one corpus with
		// the source shape, so the selectors work there too. Checked against
		// the RESOLVED kind, so a defaulted kind on a unified database passes.
		const sourceSelectors = [
			args.external_id != null ? "external_id" : null,
			args.parent_external_id != null ? "parent_external_id" : null,
			args.connector_id != null ? "connector_id" : null,
			args.url != null ? "url" : null,
			args.provider != null ? "provider" : null,
		].filter((s): s is string => s != null);
		if (args.parent_external_id != null && args.provider == null) {
			throw new Error(`${TOOL_NAMES.LIST}: parent_external_id requires provider; parent IDs are not unique across providers.`);
		}
		if (args.parent_external_id != null && args.connector_id == null) {
			throw new Error(`${TOOL_NAMES.LIST}: parent_external_id requires connector_id; provider alone does not identify a site/account. Resolve the parent with external_id first and copy its stored connector_id; never guess it.`);
		}
		if (kind !== "knowledge" && kind !== "unified" && sourceSelectors.length > 0) {
			throw new Error(
				`${TOOL_NAMES.LIST}: ${sourceSelectors.join(", ")} ` +
				`${sourceSelectors.length === 1 ? "is" : "are"} only valid with ` +
				`kind: "knowledge" or "unified" — memories carry no provider identity. ` +
				`Set kind: "knowledge" to look a source up by its provider id or URL.`,
			);
		}

		return withUnifiedFallback(defaulted, kind, (kindToSend) =>
			kindToSend === "memory"
				? runListMemories(
						{
							source_ids: args.source_ids,
							page: args.page,
							page_size: args.page_size,
							acl: args.acl,
							database: args.database,
							collection: args.collection,
						},
						signal,
						// Only when the host chose `memory` for them. A caller who
						// asked for memories already knows knowledge is elsewhere.
						defaulted,
					)
				: runListSources(
						{
							kind: kindToSend,
							source_ids: args.source_ids,
							external_id: args.external_id,
							parent_external_id: args.parent_external_id,
							connector_id: args.connector_id,
							url: args.url,
							provider: args.provider,
							page: args.page,
							page_size: args.page_size,
							acl: args.acl,
							database: args.database,
							collection: args.collection,
						},
						signal,
					),
			args.database,
		);
	}

	/**
	 * `noteOtherCorpus` appends the one thing a memory-only listing cannot say
	 * for itself: that it is not the whole store. Without it a caller who asked
	 * "what does Hydra DB have?" reads a memory page as the complete inventory
	 * and never learns the knowledge corpus exists — the bug that made `kind`
	 * required in the first place.
	 */
	async function runListMemories(args: {
		source_ids?: string[];
		page?: number;
		page_size?: number;
		acl?: string[];
		database?: string;
		collection?: string;
	} = {}, signal?: AbortSignal, noteOtherCorpus = false): Promise<ToolResult> {
		logger.debug(TOOL_NAMES.LIST);
		const corpusNote = noteOtherCorpus
			? `\n\nMemories only — knowledge is a separate corpus on this database and is ` +
				`not listed here. Call ${TOOL_NAMES.LIST} again with kind="knowledge" for it.`
			: "";

		const raw = await hydra.context.list({
			kind: "memory",
			ids: args.source_ids,
			page: args.page,
			pageSize: args.page_size,
			acl: args.acl,
			database: args.database,
			collection: args.collection,
		}, { signal });

		const { memories, page } = toMemoryList(raw);
		const resolvedScope = singleScope(args);

		if (memories.length === 0) {
			// Declaring an outputSchema obliges EVERY return path to carry structured
			// content, including this one — a caller branching on `items` should not
			// have to special-case the empty result.
			return structuredResult(
				(args.page != null && args.page > 1
					? `No memories on page ${args.page}.`
					: emptyListText("memories", args.database, args.collection)) + corpusNote,
				{
					kind: "memory",
					resolved_scope: resolvedScope,
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
			`${coverage(memories.length, page, args.page)} memories:\n${scopeText(resolvedScope)}\n\n${lines.join("\n")}${corpusNote}`,
			{
				kind: "memory",
				resolved_scope: resolvedScope,
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

	/**
	 * An empty listing with no collection named says WHERE it looked. The
	 * default partition is empty whenever data lives in named collections, so
	 * a bare "none found" there read as "this database is empty".
	 */
	function emptyListText(noun: "sources" | "memories", database?: string, collection?: string): string {
		const base = noun === "sources" ? "No sources found." : "No memories stored yet.";

		if (collection != null || hydra.collection != null) return base;

		return (
			`No ${noun} found in the workspace default of database "${database ?? hydra.database}". ` +
			`Data may live in a named collection: call ${TOOL_NAMES.LIST_COLLECTIONS}, then pass \`collection\`.`
		);
	}

	async function runListSources(args: {
		source_ids?: string[];
		external_id?: string;
		parent_external_id?: string;
		connector_id?: string;
		url?: string;
		provider?: string;
		page?: number;
		page_size?: number;
		acl?: string[];
		database?: string;
		collection?: string;
		/** `unified` lists every item of a unified database in one page (PRO-1618); the rows have the source shape. */
		kind?: "knowledge" | "unified";
	}, signal?: AbortSignal): Promise<ToolResult> {
		logger.debug(TOOL_NAMES.LIST);
		// The canonical tool resolves the kind from the layout and always names
		// one (see `runList`). This default is the deprecated
		// `hydradb_list_sources` alias's own meaning — that tool IS the knowledge
		// listing — not a guess standing in for a layout it never checked.
		const listKind = args.kind ?? "knowledge";

		const sourceFields: Record<string, string> = {};
		if (args.external_id != null) sourceFields.app_external_id = args.external_id;
		if (args.parent_external_id != null) sourceFields.app_parent_id = args.parent_external_id;
		if (args.url != null) sourceFields.url = args.url;
		if (args.provider != null) sourceFields.app_provider = args.provider;

		const raw = await hydra.context.list({
			kind: listKind,
			ids: args.source_ids,
			sourceFields: Object.keys(sourceFields).length > 0 ? sourceFields : undefined,
			connectorId: args.connector_id,
			page: args.page,
			pageSize: args.page_size,
			acl: args.acl,
			database: args.database,
			collection: args.collection,
		}, { signal });

		const { sources, page } = toSourceList(raw);
		const resolvedScope = singleScope(args);
		const followScope = { database: resolvedScope.database, ...(resolvedScope.collection != null ? { collection: resolvedScope.collection } : {}), ...(args.acl != null ? { acl: args.acl } : {}) };

		if (sources.length === 0) {
			const collection = args.collection?.trim() || hydra.collection;
			const lookupScope = `database ${JSON.stringify(args.database?.trim() || hydra.database)}, ` +
				(collection == null ? "workspace default" : `collection ${JSON.stringify(collection)}`);
			const emptyText = Object.keys(sourceFields).length > 0 || args.connector_id != null
				? `No visible sources match the supplied source filters on page ${page.page ?? args.page ?? 1} in ${lookupScope}. ` +
					"This does not prove the document was never ingested. Check the scope, page and exact stored identity; keep the caller's ACL unchanged."
				: args.page != null && args.page > 1
					? `No sources on page ${args.page}.`
					: emptyListText("sources", args.database, args.collection);

			return structuredResult(
				emptyText,
				{
					kind: listKind,
					resolved_scope: resolvedScope,
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

			const identity = [s.provider && `provider=${JSON.stringify(s.provider)}`, s.connector_id && `connector_id=${JSON.stringify(s.connector_id)}`, s.external_id && `external_id=${JSON.stringify(s.external_id)}`, s.parent_external_id && `parent_external_id=${JSON.stringify(s.parent_external_id)}`].filter(Boolean).join(", ");
			return `${i + 1}. [${s.id}]${title}${type}${identity ? ` — ${identity}` : ""}`;
		});

		// Was `${total} sources:` — the corpus-wide total printed above a single
		// page of rows, so "412 sources:" sat over 50 lines with no marker and no
		// way to reach the other 362.
		return structuredResult(
			`${coverage(sources.length, page, args.page)} sources:\n${scopeText(resolvedScope)}\n\n${lines.join("\n")}\n\nKeep this scope and your ACL when inspecting these ids.` +
				(args.parent_external_id ? " These are indexed direct children, not proof of the complete provider hierarchy. Paginate all results, then traverse each child's external_id explicitly for descendants." : ""),
			{
				kind: listKind,
				resolved_scope: resolvedScope,
				items: sources.map((src) => ({
					id: src.id,
					...(src.title != null ? { title: src.title } : {}),
					...(src.type != null ? { type: src.type } : {}),
					...(src.external_id != null ? { external_id: src.external_id } : {}),
					...(src.provider != null ? { provider: src.provider } : {}),
					...(src.parent_external_id != null ? { parent_external_id: src.parent_external_id } : {}),
					...(src.connector_id != null ? { connector_id: src.connector_id } : {}),
					...(src.external_id && src.provider && src.connector_id ? {
						children_args: { kind: "knowledge", parent_external_id: src.external_id, provider: src.provider, connector_id: src.connector_id, ...followScope },
					} : {}),
					inspect_args: { id: src.id, ...followScope },
				})),
				shown: sources.length,
				total: page.total ?? sources.length,
				page: page.page ?? args.page ?? 1,
				has_more: hasMore(sources.length, page, args.page),
				...(hasMore(sources.length, page, args.page) ? { next_args: { ...args, kind: "knowledge", ...followScope, page: (page.page ?? args.page ?? 1) + 1 } } : {}),
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
	 * because fifty capped chunks still add up. Both are split-database
	 * ceilings: a unified answer is returned whole (see renderUnifiedQuery).
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
		if (start > total) throw new Error(`Inspect offset ${start} exceeds source length ${total}; restart at offset 0 if the source changed.`);

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
			acl?: string[];
			database?: string;
			collection?: string;
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
			acl: a.acl,
			database: a.database,
			collection: a.collection,
		};
	}

	async function runSubgraph(
		args: {
			id?: string;
			kind?: "memory" | "knowledge";
			depth?: number;
			max_sources?: number;
			acl?: string[];
			database?: string;
			collection?: string;
		},
		signal?: AbortSignal,
	): Promise<ToolResult> {
		// Blank is rejected; anything else is forwarded byte for byte. The
		// server treats an item id as opaque (ingest stores a caller's
		// source_id verbatim), so trimming here could ask about a different
		// item. Same rule as the CLI's `hydradb subgraph`.
		const id = args.id ?? "";

		if (id.trim() === "") {
			throw new Error(
				`${TOOL_NAMES.SUBGRAPH} requires \`id\` — the value shown as [id: …] in ` +
					`${TOOL_NAMES.QUERY} results or in [brackets] in ${TOOL_NAMES.LIST} output.`,
			);
		}

		logger.debug(`${TOOL_NAMES.SUBGRAPH}: ${id}`);

		const res = await hydra.context.subgraph(
			{
				id,
				kind: args.kind,
				depth: args.depth,
				maxSources: args.max_sources,
				acl: args.acl,
				database: args.database,
				collection: args.collection,
			},
			{ signal },
		);

		// Soft failure, like inspect: the server's own message, flagged.
		if (!res.success) {
			return errorResult(`Could not read the subgraph of ${id}: ${res.message || "unknown error"}`);
		}

		const members = res.sources ?? [];

		if (members.length === 0) {
			return structuredResult(
				`No item with id ${id} was found in this collection, so there is no subgraph to show. ` +
					`Ids come from ${TOOL_NAMES.QUERY} or ${TOOL_NAMES.LIST}; check the collection as well as the id.`,
				// Same keys as a populated result: a client reading
				// structuredContent should not have to branch on which shape it got.
				{
					seed_id: id,
					member_count: 0,
					max_depth_reached: 0,
					truncated: false,
					relations: [],
					structural_link_count: 0,
					structural_truncated: false,
					members: [],
				},
			);
		}

		const hops = res.max_depth_reached ?? 0;
		// Sorted once, then used for both the prose and structuredContent: a
		// machine client that renders the members must not get a different
		// order from the one a reader sees.
		const ordered = [...members].sort((a, b) => a.depth - b.depth);

		const lines: string[] = [
			members.length === 1 && !res.is_truncated
				? `${id} stands alone: nothing in the graph links to it yet.`
				: `${members.length} item${members.length === 1 ? "" : "s"} connected to ${id} through ${hops} hop${hops === 1 ? "" : "s"}` +
					(res.is_truncated ? ` (clipped at max_sources; the subgraph continues)` : "") +
					":",
			"",
		];

		// discovered_relation is the MECHANISM (same_thread, parent, child, or a
		// relates_to type); discovered_via is the member this one was reached
		// FROM — another member's id, so the list is also a tree. The parent id
		// is shortened in the prose because it appears in full on its own line
		// and in structuredContent; the relation is what a reader scans for.
		const shortId = (id: string) => (id.length > 14 ? `${id.slice(0, 12)}…` : id);

		for (const m of ordered) {
			const title = m.title?.trim() || m.app_external_id || "(untitled)";

			const reached =
				m.depth === 0
					? "the item you started from"
					: `${m.discovered_relation || "linked"}${m.discovered_via ? ` from ${shortId(m.discovered_via)}` : ""}`;

			const kind = [m.app_provider, m.app_kind].filter(Boolean).join(" ");
			lines.push(`- [id: ${m.source_id}] ${title}${kind ? ` (${kind})` : ""} — depth ${m.depth}, ${reached}`);
		}

		lines.push(
			"",
			`${(res.relations ?? []).length} relation(s) among them; ` +
				`${(res.auxiliary_relations ?? []).length} structural link(s) around them` +
				(res.auxiliary_truncated ? " (structural links clipped)" : "") +
				`. Pass any [id: …] to ${TOOL_NAMES.INSPECT} for its full content.`,
		);

		// The edges make it a graph rather than a list, so structuredContent
		// carries them too, compacted to what a client can act on: both
		// endpoints are Source nodes, so entity_id is the member's id. The
		// structural links are about entities and comments, not members, so
		// they stay a count plus their own clipped flag, exactly as the prose
		// reports them.
		const edges = (res.relations ?? []).map((r) => ({
			from: r.source?.entity_id ?? null,
			to: r.target?.entity_id ?? null,
			type: r.relations?.[0]?.canonical_predicate ?? null,
		}));

		return structuredResult(lines.join("\n"), {
			seed_id: res.seed_source_id || id,
			member_count: members.length,
			max_depth_reached: hops,
			truncated: Boolean(res.is_truncated),
			relations: edges,
			structural_link_count: (res.auxiliary_relations ?? []).length,
			structural_truncated: Boolean(res.auxiliary_truncated),
			members: ordered.map((m) => ({
				id: m.source_id,
				title: m.title ?? null,
				depth: m.depth,
				discovered_via: m.discovered_via ?? null,
				discovered_relation: m.discovered_relation ?? null,
				app_provider: m.app_provider ?? null,
				app_kind: m.app_kind ?? null,
			})),
		});
	}

	async function runInspect(args: {
		source_id: string;
		mode?: "content" | "url" | "both";
		offset?: number;
		limit?: number;
		expiry_seconds?: number;
		acl?: string[];
		database?: string;
		collection?: string;
	}, signal?: AbortSignal): Promise<ToolResult> {
		logger.debug(`${TOOL_NAMES.INSPECT}: ${args.source_id}`);

		const res = await hydra.context.inspect({
			id: args.source_id,
			mode: args.mode ?? "content",
			expirySeconds: args.expiry_seconds,
			acl: args.acl,
			database: args.database,
			collection: args.collection,
		}, { signal });

		// Soft failure: return a normal (non-error) text result, matching v1.
		if (!res.success || res.error) {
			return errorResult(
				`Could not fetch source ${args.source_id}: ${res.error ?? "unknown error"}`,
			);
		}

		const mode = args.mode ?? "content";
		const resolvedScope = singleScope(args);
		const parts: string[] = [`Source: ${args.source_id}`, scopeText(resolvedScope)];

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

		const readsText = mode === "content" || mode === "both";
		const content = readsText && res.content != null && res.content !== "" ? res.content : undefined;
		const offset = args.offset ?? 0;
		const end = content == null ? offset : Math.min(offset + (args.limit ?? INSPECT_CHAR_BUDGET), content.length);
		const hasMoreContent = content != null && end < content.length;
		const contentHash = content != null ? createHash("sha256").update(content).digest("hex") : undefined;
		if (contentHash != null && content != null && (offset > 0 || end < content.length)) {
			parts.push(`Content SHA-256: ${contentHash}. Each slice re-fetches the source; restart at offset 0 if this changes.`);
		}
		return structuredResult(parts.join("\n\n"), {
			id: args.source_id, resolved_scope: resolvedScope,
			...(mode !== "content" && res.presignedUrl ? { download_url: res.presignedUrl } : {}),
			...(readsText ? {
				content: content?.slice(offset, end) ?? null,
				offset, end, total_characters: content?.length ?? null,
				offset_unit: "utf16_code_units",
				has_more: hasMoreContent,
				complete: content != null && offset === 0 && end === content.length,
				...(contentHash != null ? { content_sha256: contentHash } : {}),
				...(hasMoreContent ? {
					next_args: { ...args, source_id: undefined, id: args.source_id, database: resolvedScope.database,
						...(resolvedScope.collection != null ? { collection: resolvedScope.collection } : {}), offset: end },
				} : {}),
			} : {}),
		});
	}

	async function runStatus(
		args: { ids: string[]; database?: string; collection?: string },
		signal?: AbortSignal,
	): Promise<ToolResult> {
		logger.debug(`${TOOL_NAMES.STATUS}: ${args.ids.join(", ")}`);

		const res = await hydra.context.ingestionStatus({
			ids: args.ids,
			database: args.database,
			collection: args.collection,
		}, { signal });

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
		kind: "memory" | "knowledge" | "unified",
		ids: string[],
		res: { success?: boolean; message?: string; results?: unknown },
		removed: boolean,
		/** How many were removed, when the server said. `undefined` means unknown. */
		removedCount?: number,
		/** True when `kind` was defaulted rather than chosen by the caller. */
		kindAssumed = false,
	): ToolResult {
		const noun = kind === "knowledge" ? "source" : "memory";
		const id = ids.join(", ");
		// A delete that finds nothing has two causes that read identically: the id
		// does not exist, or it exists in the OTHER family and we never looked.
		// When the caller did not pick a family we cannot tell them apart, so the
		// message must name the assumption instead of asserting the id is wrong.
		const otherKind = kind === "memory" ? "knowledge" : "memory";
		const otherNoun = otherKind === "knowledge" ? "knowledge source" : "memory";
		const assumedHint = kindAssumed
			? ` \`kind\` was not given, so this looked in ${kind} only. If ` +
				`${ids.length > 1 ? "these ids are" : "this id is"} a ${otherNoun}, ` +
				`re-run with kind: "${otherKind}".`
			: "";

		if (removed) {
			// Three outcomes, and the third is "we were not told".
			const partial =
				removedCount != null && ids.length > 1 && removedCount < ids.length;

			const unknownCount = removedCount == null && ids.length > 1;

			let text: string;

			if (partial) {
				text =
					`Deleted ${removedCount} of ${ids.length} ${noun}s (requested: ${id}). ` +
					`The rest were not found or could not be removed.`;
			} else if (unknownCount) {
				// Do not claim all of them went. The server confirmed a removal and
				// gave no count, so that is exactly what gets reported.
				text =
					`Deleted from Hydra DB (requested: ${id}). The server confirmed a removal ` +
					`but did not say how many of the ${ids.length} ids were removed — ` +
					`use ${TOOL_NAMES.LIST} to confirm which remain.`;
			} else {
				text = `Deleted ${noun}${ids.length > 1 ? "s" : ""}: ${id}`;
			}

			return structuredResult(text, {
				ids,
				kind,
				deleted: true,
				// Omitted rather than guessed when the server did not report it.
				...(removedCount != null ? { deleted_count: removedCount } : {}),
				...(partial ? { partial: true } : {}),
				...(unknownCount ? { deleted_count_known: false } : {}),
			});
		}

		if (res.success === false) {
			const reason = deleteFailureReason(res);

			// A refusal that is ITSELF a not-found carries the same ambiguity as the
			// success-removed-nothing branch below. Any other refusal ("still
			// processing") is about this family and the hint would misdirect.
			const refusalIsNotFound =
				reason != null && /not found|does not exist|no such/i.test(reason);

			return {
				...structuredResult(
					`Could NOT delete ${noun} ${id} — the server refused the request` +
						`${reason ? `: ${reason}` : " and gave no reason"}. ` +
						`The ${noun} has not been removed.` +
						(refusalIsNotFound ? assumedHint : ""),
					{
						ids,
						kind,
						deleted: false,
						deleted_count: 0,
						...(reason ? { reason } : {}),
						...(kindAssumed ? { kind_assumed: true } : {}),
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
			`No ${noun} with id ${id} exists in this database — nothing was deleted.` +
			assumedHint +
			` Ids come from ${TOOL_NAMES.QUERY} or ${TOOL_NAMES.LIST}` +
			(kindAssumed ? "." : "; check the id rather than retrying."),
			{
				ids,
				kind,
				deleted: false,
				deleted_count: 0,
				reason: "not found",
				...(kindAssumed ? { kind_assumed: true } : {}),
			},
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
		const a = args as {
			id?: string;
			ids?: string[];
			kind?: ContextKind;
			database?: string;
			collection?: string;
		};

		const ids = a.ids ?? (a.id != null ? [a.id] : []);

		if (ids.length === 0) {
			throw new Error(
				`${TOOL_NAMES.DELETE} requires \`ids\` (or \`id\`). Ids come from ` +
				`${TOOL_NAMES.QUERY} or ${TOOL_NAMES.LIST} — do not guess one.`,
			);
		}

		return { ids, kind: a.kind, database: a.database, collection: a.collection };
	}

	async function runDelete(args: {
		ids: string[];
		kind?: ContextKind;
		database?: string;
		collection?: string;
	}, signal?: AbortSignal): Promise<ToolResult> {
		// Whether the caller CHOSE memory, or merely got it. A wrong-family delete
		// is silent — the server removes nothing and says so in the vocabulary of
		// the family we asked about — so the report has to know which happened.
		const refused = await refuseUnifiedOnSplit(TOOL_NAMES.DELETE, args.kind, args.database, signal);

		if (refused) return refused;
		const kindAssumed = args.kind == null;
		const kind: ContextKind =
			args.kind ?? ((await isUnifiedDatabase(args.database, signal)) ? "unified" : "memory");
		logger.debug(`${TOOL_NAMES.DELETE}: ${kind}${kindAssumed ? " (assumed)" : ""} ${args.ids.join(", ")}`);

		const res = await withUnifiedFallback(args.kind == null, kind, (kindToSend) => hydra.context.delete({
			ids: args.ids,
			kind: kindToSend,
			database: args.database,
			collection: args.collection,
		}, { signal }), args.database);
		// `userMemoryDeleted` is a COUNT on the v2 wire — a live delete returned
		// `{"deletedCount":1,"userMemoryDeleted":1}` — and the SDK types it as a
		// number. The v1 memory-delete handler returns a boolean for the same
		// concept, so both are handled: a boolean answers "did anything go?" and
		// only a number answers "how many?".
		//
		// The distinction matters for bulk delete. Reading a bare `true` as 1
		// would report a successful 3-id removal as "Deleted 1 of 3 … partial",
		// inventing a failure that did not happen — the mirror image of claiming
		// success over a genuine partial.
		const rawMemoryDeleted = res.userMemoryDeleted as number | boolean | undefined;

		const memoryDeletedCount =
			typeof rawMemoryDeleted === "number" ? rawMemoryDeleted : undefined;

		const reportedCount = res.deletedCount ?? memoryDeletedCount;
		const removed = (reportedCount ?? 0) > 0 || rawMemoryDeleted === true;
		// With no count at all, we do not know how many went — and inventing one
		// is wrong in both directions. Reading the flag as 1 understated a full
		// removal ("Deleted 1 of 3"); substituting ids.length overstates a partial
		// one as complete success. So the count stays UNKNOWN and the report says
		// so, which is the only thing actually observed.
		const removedCount = reportedCount;

		if (!removed) {
			logger.warn(
				`${TOOL_NAMES.DELETE}: removed nothing for ${kind} ${args.ids.join(", ")}`,
				{ success: res.success, message: res.message, results: res.results },
			);
		}

		return deleteReport(kind, args.ids, res, removed, removedCount, kindAssumed);
	}

	/**
	 * Which databases this connection can address, and which is the default.
	 *
	 * A confined connection answers from its allowed list without a network
	 * call: the list IS the answer, and asking the API would only show
	 * databases the connection is not permitted to use.
	 */
	async function runDatabases(signal?: AbortSignal): Promise<ToolResult> {
		const defaultDatabase = hydra.database;
		let databases: string[];
		let confined = false;
		const layouts = new Map<string, string>();
		if (hydra.allowedDatabases) {
			databases = [...hydra.allowedDatabases];
			confined = true;
		} else {
			// ONE `GET /databases`. The names and the layouts come from the same
			// response — asking `layouts()` for them separately issued a second,
			// identical request for a listing already in hand.
			const listed = await hydra.databases.list(signal);
			databases = (listed.databases ?? listed.tenantIds ?? []).filter(Boolean);
			for (const row of listed.details ?? []) {
				if (row.database) layouts.set(row.database, row.type === "unified" ? "unified" : "split");
			}
		}

		if (!databases.includes(defaultDatabase)) databases.unshift(defaultDatabase);
		// Storage layout per database (PRO-1618). A unified database takes no
		// `kind`; naming it here is what lets a caller avoid a refused call. A
		// confined connection keeps answering without a network call, as
		// promised above; its per-call defaults still resolve the layout lazily.
		const types: Record<string, string> = {};
		if (!confined) {
			for (const d of databases) types[d] = layouts.get(d) ?? "split";
		}

		const lines = databases.map(
			(d) =>
				`  - ${d}${types[d] === "unified" ? "  [unified: one corpus, kind not needed]" : ""}` +
				`${d === defaultDatabase ? "  (default for this connection)" : ""}`,
		);

		const note = confined
			? "\nThis connection is confined to the database(s) above; any other name is refused. " +
				"The user chose this when approving the connection."
			: "\nPass `database` on any tool to work in another one.";

		return structuredResult(
			`${databases.length} database(s):\n${lines.join("\n")}${note}`,
			{ databases, default: defaultDatabase, confined, ...(confined ? {} : { types }) },
		);
	}

	async function runListCollections(
		args: { database?: string },
		signal?: AbortSignal,
	): Promise<ToolResult> {
		const database = args.database?.trim() || hydra.database;
		// Scoped like every other per-database tool. Both calls below go straight
		// to the SDK, beneath the resource layer's own confinement check, so
		// without this a database-confined grant could enumerate the collection
		// names and row counts of a database the user never approved.
		assertDatabaseAllowed(database, hydra.allowedDatabases);
		const res = await hydra.databases.collections(database, { signal });
		const listed = collectionNamesOf(res);

		if (listed == null) {
			throw new Error(
				`${TOOL_NAMES.LIST_COLLECTIONS} received a malformed collections payload from the server.`,
			);
		}

		const collections = listed;

		// Database-wide corpus sizes. Informative, not essential — the listing
		// stands alone if stats is slow or unavailable (it has been observed to
		// hang on some deployments, and a discovery tool must not).
		let knowledgeRows: number | undefined;
		let memoryRows: number | undefined;
		// A bare Promise.race only bounded how long we WAITED: the losing request
		// kept running through its own timeout and retries, and repeated discovery
		// against a hanging deployment piled them up. Abort it instead, and chain
		// the caller's cancellation so a cancelled tool call stops it too.
		const statsAbort = new AbortController();
		const onCallerAbort = () => statsAbort.abort(signal?.reason);

		if (signal?.aborted) statsAbort.abort(signal.reason);
		else signal?.addEventListener("abort", onCallerAbort, { once: true });

		const timer = setTimeout(
			() => statsAbort.abort(new Error("stats timed out")),
			listCollectionsStatsTimeoutMs,
		);

		// Bounds the wait even if a transport ignored the signal.
		const aborted = new Promise<never>((_, reject) => {
			statsAbort.signal.addEventListener("abort", () => reject(statsAbort.signal.reason), {
				once: true,
			});
		});

		aborted.catch(() => {});

		try {
			const stats = await Promise.race([
				hydra.databases.stats(database, { signal: statsAbort.signal }),
				aborted,
			]);

			knowledgeRows = stats.knowledgeCollection?.rowCount;
			memoryRows = stats.memoryCollection?.rowCount;
		} catch {
			/* sizes are decoration; never fail the listing on them */
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onCallerAbort);
		}

		// The whole point of this tool's output: which collection calls use when
		// the caller names none, and what to do when the answer is "nothing".
		const def = hydra.collection ?? null;

		const size =
			knowledgeRows != null || memoryRows != null
				? ` Database-wide: ${knowledgeRows ?? "?"} knowledge row(s), ${memoryRows ?? "?"} memory row(s).`
				: "";

		const guidance =
			def != null
				? `Default for this connection: "${def}" — calls use it unless \`collection\` is passed.`
				: "This connection has no default collection. Decide the scope per request: a search that " +
					"names none covers every collection listed here (up to 10); pass `collection` to aim at the " +
					"one whose purpose matches the question, and always name one on writes.";

		if (collections.length === 0) {
			return structuredResult(
				`No collections in ${database}. A collection is created by its first ` +
					`ingest, so pass any name as \`collection\` to start one — or leave it ` +
					`unset and the workspace's default is used.`,
				{ database, default: def, collections: [], count: 0 },
			);
		}

		const lines = collections.map(
			(id) => `- ${id}${id === def ? "  (default for this connection)" : ""}`,
		);

		return structuredResult(
			`${collections.length} collection${collections.length === 1 ? "" : "s"} in ${database}:\n` +
				lines.join("\n") +
				size +
				`\n${guidance}`,
			{
				database,
				default: def,
				collections,
				count: collections.length,
				...(knowledgeRows != null ? { knowledge_rows: knowledgeRows } : {}),
				...(memoryRows != null ? { memory_rows: memoryRows } : {}),
			},
		);
	}

	async function runDeleteCollection(
		args: { database?: string; collection?: string },
		signal?: AbortSignal,
	): Promise<ToolResult> {
		const collection = args.collection?.trim() ?? "";

		if (!collection) {
			throw new Error(
				`${TOOL_NAMES.DELETE_COLLECTION} requires \`collection\`. ` +
					`Take it from ${TOOL_NAMES.LIST_COLLECTIONS} — do not guess one.`,
			);
		}

		const database = args.database?.trim() || hydra.database;

		const res = await hydra.databases.deleteCollection(
			{ database, collection },
			{ signal },
		);

		return structuredResult(
			`Collection "${collection}" in ${database} scheduled for deletion. ` +
				(res.message ?? "Background cleanup is in progress."),
			{
				database,
				collection,
				status: res.status ?? "deletion_scheduled",
				deleted: true,
			},
		);
	}

	// --- BYOG graph handlers ---

	/**
	 * The scope a graph call runs against.
	 *
	 * Resolved per call rather than captured once, so a caller can address a
	 * second graph without reconfiguring the server. The collection name is
	 * validated here because the server's rule is a documented charset and
	 * rejecting locally names it, where the remote failure is a bare 400.
	 */
	/**
	 * The graph database a call runs against, checked against the connection's
	 * allowed set. The graph client does not go through the context client's
	 * scope(), so the same rule is applied here for every graph tool.
	 */
	function graphDatabase(override?: string): string {
		const database = override?.trim() || graphConfig.database;

		if (database && database !== hydra.database) {
			assertDatabaseAllowed(database, hydra.allowedDatabases);
		}

		return database;
	}

	/**
	 * The graph collection a call runs against, checked the same way the
	 * database is. `drop_collection` makes an unchecked override destructive,
	 * so confinement covers both axes or it covers nothing.
	 */
	/**
	 * The irreversible graph-admin actions, on a connection that has nothing to
	 * scope them to.
	 *
	 * "Destroy only within your own collection" is the rule the other guards
	 * enforce, and it needs a collection to name. A confined connection that
	 * has neither a collection allow-list NOR a collection of its own has none,
	 * so every check downstream silently passes and the narrowest grant on the
	 * consent screen ends up permitting the broadest deletions in its database.
	 *
	 * That combination only became reachable when a blank collection started
	 * meaning "the workspace's own" instead of a hardcoded literal: before, a
	 * grant always carried a collection, so this branch could not occur. Refuse
	 * it rather than let an unanswerable check read as approval.
	 */
	function assertDestructiveScopeExists(action: string): void {
		if (!hydra.allowedDatabases) return;

		if (hydra.allowedCollections || hydra.collection) return;
		throw new Error(
			`This connection is confined to database ${hydra.allowedDatabases
				.map((d) => `"${d}"`)
				.join(", ")} and names no collection of its own, so "${action}" has no ` +
			"boundary to respect and would delete data it was never granted. Nothing " +
			"was deleted. Reconnect naming the collection this app should use, or " +
			"without the database confinement.",
		);
	}

	function graphCollection(override?: string): string {
		const collection = override?.trim() || graphConfig.collection;

		if (collection && collection !== hydra.collection) {
			assertCollectionAllowed(collection, hydra.allowedCollections);
		}

		return collection;
	}

	function graphScope(args: { database?: string; collection?: string }): {
		database: string;
		collection: string;
	} {
		const database = graphDatabase(args.database);
		const collection = graphCollection(args.collection);

		if (!database) {
			throw new Error(
				"No graph database configured. Set HYDRADB_GRAPH_DATABASE (or HYDRADB_DATABASE), " +
				"or pass `database` on this call.",
			);
		}

		if (!COLLECTION_PATTERN.test(collection)) {
			throw new Error(
				`Invalid graph collection name "${collection}". Collection names must match ` +
				"[A-Za-z0-9][A-Za-z0-9_-]{0,63} — start with a letter or digit, then letters, " +
				"digits, underscores or hyphens, up to 64 characters.",
			);
		}

		return { database, collection };
	}

	/**
	 * Refuse an oversized request before it goes out.
	 *
	 * The server answers a body over 256 KiB with 413, but only after receiving
	 * all of it — so on the bulk loads where this actually happens, the remote
	 * check is the slowest possible way to learn the batch was too big. Measured
	 * in BYTES, not characters: the cap is on the encoded body, and non-ASCII
	 * property values are where a "small enough" batch stops being one.
	 */
	function assertBodyFits(body: {
		database: string;
		collection: string;
		query: string;
		params?: Record<string, unknown>;
	}): void {
		let bytes: number;

		try {
			// The WHOLE body, not just the caller's two fields. `database` and
			// `collection` are serialised alongside the query, so measuring
			// without them let a payload sitting just under the cap pass here and
			// be rejected remotely with a 413 — after the entire thing had been
			// uploaded, which is the outcome this check exists to avoid.
			bytes = Buffer.byteLength(JSON.stringify(body) ?? "", "utf8");
		} catch {
			throw new Error(
				"`params` could not be serialised to JSON — it must contain only plain " +
				"values (strings, numbers, booleans, null, arrays, objects).",
			);
		}

		if (bytes > MAX_BODY_BYTES) {
			throw new Error(
				`This request is ${Math.round(bytes / 1024)} KiB, over Hydra DB's ` +
				`${MAX_BODY_BYTES / 1024} KiB limit. Split it into batches — send rows in ` +
				"chunks with `UNWIND $rows AS row ...` (about 500 rows per call is a good start).",
			);
		}
	}

	/**
	 * The single Cypher entry point: reads and writes go through one tool.
	 *
	 * This deliberately does NOT inspect the query. An earlier version lexed it
	 * to classify reads vs writes and to pre-reject constructs the server
	 * refuses; both were a client reimplementing the server's rules, able only
	 * to agree with it or to be wrong. The server rejects unsupported
	 * constructs before executing anything and says so more precisely than we
	 * did, so the query goes out as written.
	 */
	async function runGraphCypher(
		args: {
			query: string;
			params?: Record<string, unknown>;
			database?: string;
			collection?: string;
			max_rows?: number;
		},
		signal?: AbortSignal,
	): Promise<ToolResult> {
		const scope = graphScope(args);

		assertBodyFits({ ...scope, query: args.query, params: args.params });

		logger.debug(`${TOOL_NAMES.GRAPH_QUERY}: ${scope.database}/${scope.collection}`);

		const rows = await hydra.graph.query(
			{ ...scope, query: args.query, params: args.params },
			{ signal },
		);

		// A write with no RETURN legitimately yields zero rows. Reporting that as
		// "no results" invites the caller to retry a write that already committed.
		if (rows.length === 0) {
			return structuredResult(
				// Zero rows means one of two things and this does not guess which:
				// a read that matched nothing, or a write with no RETURN clause.
				// Naming both keeps a caller from re-running a write that already
				// committed because the result "looked empty".
				`The query ran against ${scope.database}/${scope.collection} and returned ` +
				"0 rows. For a read that means nothing matched; for a write with no RETURN " +
				"clause it is the expected result and the write has been applied — do not " +
				"re-run it to check.",
				{ database: scope.database, collection: scope.collection, rows: [], row_count: 0 },
			);
		}

		const maxRows = args.max_rows ?? 100;
		const rendered = renderRows(rows, { maxRows });

		return structuredResult(
			`${rows.length} row(s) from ${scope.database}/${scope.collection}:\n\n${rendered}`,
			{
				database: scope.database,
				collection: scope.collection,
				// Bounded the same way the prose is: structured output is a different
				// encoding of the same answer, not a bypass of its limits.
				rows: rows.slice(0, maxRows),
				row_count: rows.length,
			},
		);
	}

	async function runGraphCollections(
		args: { database?: string },
		signal?: AbortSignal,
	): Promise<ToolResult> {
		const database = graphDatabase(args.database);

		if (!database) {
			throw new Error(
				"No graph database configured. Set HYDRADB_GRAPH_DATABASE (or HYDRADB_DATABASE), " +
				"or pass `database` on this call.",
			);
		}

		logger.debug(`${TOOL_NAMES.GRAPH_COLLECTIONS}: ${database}`);

		const collections = await hydra.graph.listCollections({ database }, { signal });

		if (collections.length === 0) {
			return structuredResult(
				`No graph collections in ${database} yet. Collections are created by their ` +
				`first write — run one with ${TOOL_NAMES.GRAPH_QUERY}.`,
				{ database, collections: [], count: 0 },
			);
		}

		return structuredResult(
			`${collections.length} graph collection(s) in ${database}:\n` +
			collections.map((name) => `  - ${name}`).join("\n"),
			{ database, collections, count: collections.length },
		);
	}

	async function runGraphAdmin(
		args: { action: string; database?: string; collection?: string },
		signal?: AbortSignal,
	): Promise<ToolResult> {
		const database = graphDatabase(args.database);

		if (!database) {
			throw new Error(
				"No graph database configured. Set HYDRADB_GRAPH_DATABASE (or HYDRADB_DATABASE), " +
				"or pass `database` on this call.",
			);
		}

		logger.debug(`${TOOL_NAMES.GRAPH_ADMIN}: ${args.action} ${database}`);

		if (args.action === "create_database") {
			const res = await hydra.graph.createDatabase(database, { signal });

			return structuredResult(
				`Created graph database "${database}" (status: ${res.status ?? "ready"}). ` +
				"Collections are created by their first write; there is no create-collection step.",
				{ action: args.action, database, status: res.status ?? "ready", created: true },
			);
		}

		if (args.action === "drop_collection") {
			const collection = args.collection?.trim();

			if (!collection) {
				throw new Error(
					`${TOOL_NAMES.GRAPH_ADMIN} action "drop_collection" requires \`collection\` — ` +
					"the name of the graph to drop. Nothing was deleted.",
				);
			}

			// This action takes its collection directly rather than through
			// graphCollection(), because there is no default to fall back to, so
			// the confinement check has to be stated here as well. It is the one
			// place an unchecked collection would be irreversible.
			if (collection !== hydra.collection) {
				assertDestructiveScopeExists("drop_collection");
				assertCollectionAllowed(collection, hydra.allowedCollections);
			}

			await hydra.graph.dropCollection({ database, collection }, { signal });

			// The endpoint is idempotent and does not report whether anything was
			// there, so this states what was requested rather than claiming a
			// removal that may not have had anything to remove.
			return structuredResult(
				`Dropped graph collection "${collection}" from ${database}, along with all its ` +
				"data. This call is idempotent, so it also succeeds when the collection did " +
				"not exist.",
				{ action: args.action, database, collection, dropped: true },
			);
		}

		if (args.action === "drop_database") {
			// This deletes EVERY graph collection in the database, so on a
			// collection-confined connection it cannot be performed within the
			// confinement: even an allowed database holds collections the user
			// never approved. The per-collection checks elsewhere cannot catch
			// this one, because the call names no collection at all. Refuse the
			// action outright rather than let the broadest destructive operation
			// be the way around the narrowest grant.
			assertDestructiveScopeExists("drop_database");

			if (hydra.allowedCollections) {
				throw new Error(
					`This connection is confined to collection ${hydra.allowedCollections
						.map((c) => `"${c}"`)
						.join(", ")}, and "drop_database" removes every collection in ` +
						`"${database}", including ones it was not granted. Nothing was deleted. ` +
						'Use "drop_collection" for a collection this connection may use, or ' +
						"reconnect with wider access.",
				);
			}

			const res = await hydra.graph.dropDatabase(database, { signal });
			const dropped = res.deleted_collections ?? [];

			const listed =
				dropped.length > 0 ? ` Collections removed: ${dropped.join(", ")}.` : "";

			// Three outcomes, not two, and the third is "we were not told".
			//
			// `deleted: false` is a real, different result — the database predates
			// BYOG, so only its graph collections went and the database itself
			// remains. Reporting that as a full drop tells the user something is
			// gone that is still there.
			//
			// A MISSING `deleted` used to fall into the same branch as `true` and
			// claim a full drop. On a destructive, irreversible call that is the
			// wrong direction to guess in: the server did not establish that
			// outcome, so it is not asserted. Say what is known and how to check.
			let text: string;

			if (res.deleted === true) {
				text = `Dropped graph database "${database}" and everything in it.${listed}`;
			} else if (res.deleted === false) {
				text =
					`Dropped the graph collections in "${database}", but NOT the database itself — ` +
					"it was created through the standard database API, so remove it there." +
					listed;
			} else {
				text =
					`Dropped the graph collections in "${database}".${listed} The server did not ` +
					"report whether the database itself was removed, so that is unconfirmed — " +
					"check with your database listing rather than assuming it is gone.";
			}

			return structuredResult(text, {
				action: args.action,
				database,
				// Omitted rather than guessed when the server did not say, matching
				// how the memory delete path reports an unknown count.
				...(typeof res.deleted === "boolean"
					? { database_deleted: res.deleted }
					: { database_deleted_known: false }),
				deleted_collections: dropped,
			});
		}

		throw new Error(
			`${TOOL_NAMES.GRAPH_ADMIN} received an unknown action "${args.action}". ` +
			'Valid actions are "create_database", "drop_collection" and "drop_database".',
		);
	}

	// --- Feedback ---

	const FEEDBACK_PARAMS = TOOL_DESCRIPTIONS[TOOL_NAMES.FEEDBACK].params;

	async function runFeedback(
		args: {
			request_id?: string;
			feedback?: string;
			rating?: "positive" | "negative" | "neutral";
			ground_truth_answer?: string;
			ground_truth_source_ids?: string[];
			metadata?: Record<string, string>;
			database?: string;
			collection?: string;
		},
		signal?: AbortSignal,
	): Promise<ToolResult> {
		const requestId = args.request_id?.trim() ?? "";

		if (requestId === "") {
			throw new Error(
				`${TOOL_NAMES.FEEDBACK} requires \`request_id\` — the value ` +
				`${TOOL_NAMES.QUERY} prints at the end of its results. It cannot be ` +
				`guessed or reconstructed: run the query again and copy it.`,
			);
		}

		logger.debug(`${TOOL_NAMES.FEEDBACK}: ${requestId}`);

		const groundTruth =
			args.ground_truth_answer != null || args.ground_truth_source_ids != null
				? {
						answer: args.ground_truth_answer,
						sourceIds: args.ground_truth_source_ids,
					}
				: undefined;

		const res = await hydra.feedback.submit(
			{
				requestId,
				feedback: args.feedback,
				rating: args.rating,
				// Everything reaching this server came from a model, so the row is
				// labelled agent rather than taking the server's "user" default.
				source: "agent",
				groundTruth,
				metadata: args.metadata,
				database: args.database,
				collection: args.collection,
			},
			{ signal },
		);

		// `recorded: false` is a real outcome, not an error: the submission was
		// accepted and not durably stored. Saying "recorded" either way would
		// tell an eval harness its run was captured when it was not.
		if (res.recorded === false) {
			return textResult(
				`Feedback for ${requestId} was accepted but not durably stored` +
				(res.message ? `: ${res.message}` : ".") +
				`\nIt will not appear in retrieval-quality analysis; re-send it if that matters.`,
			);
		}

		const parts = [`Feedback recorded for request ${requestId}.`];

		if (res.feedback_id) parts.push(`Feedback id: ${res.feedback_id}.`);

		if (groundTruth?.sourceIds?.length) {
			parts.push(
				`${groundTruth.sourceIds.length} ground-truth source id(s) recorded — these are ` +
				`scored as a retrieval judgement against that query.`,
			);
		}

		return textResult(parts.join(" "));
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

	const scopeSchema = {
		database: z
			.string()
			.min(1)
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.QUERY].params.database),
		collection: z
			.string()
			.min(1)
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.QUERY].params.collection),
	};

	const querySchema = {
		query: z.string().describe(TOOL_DESCRIPTIONS[TOOL_NAMES.QUERY].params.query),
		kind: z
			.enum(["memory", "knowledge", "all", "unified"])
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
		follow_forceful_relations: z
			.boolean()
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.QUERY].params.follow_forceful_relations),
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
		titles: z
			.array(z.string().trim().min(1))
			.min(1)
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.QUERY].params.titles),
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
		recency_bias: z
			.number()
			.min(0)
			.max(1)
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.QUERY].params.recency_bias),
		query_apps: z
			.boolean()
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.QUERY].params.query_apps),
		collections: z
			.array(z.string().min(1))
			.min(1)
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.QUERY].params.collections),
		acl: z
			.array(z.string())
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.QUERY].params.acl),
		...scopeSchema,
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
		...scopeSchema,
	};

	const ingestMetadataSchema = {
		metadata: z
			.record(z.unknown())
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.INGEST].params.metadata),
		observation_date: z
			.string()
			.regex(OBSERVATION_DATE_PATTERN, {
				message:
					"observation_date must be a calendar date as YYYY-MM-DD (e.g. 2026-07-04); " +
					"a date-time is accepted and kept as its date part",
			})
			.transform((value) => value.slice(0, CALENDAR_DATE_LENGTH))
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
			.enum(["memory", "knowledge", "unified"])
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
		// The unified item's names (PRO-1618). `attributes` and `happened_at`
		// are the preferred spellings of `metadata` and `observation_date`, kept
		// side by side so existing callers keep working; the handler folds each
		// pair and refuses a contradiction. The last three exist on a unified
		// item only and the wrapper refuses them on a split database.
		attributes: z
			.record(z.unknown())
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.INGEST].params.attributes),
		custom_attributes: z
			.record(z.unknown())
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.INGEST].params.custom_attributes),
		happened_at: z
			.string()
			.regex(OBSERVATION_DATE_PATTERN, {
				message:
					"happened_at must be a calendar date as YYYY-MM-DD (e.g. 2026-07-04); " +
					"a date-time is accepted and kept as its date part",
			})
			.transform((value) => value.slice(0, CALENDAR_DATE_LENGTH))
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.INGEST].params.happened_at),
		instructions: z
			.string()
			.min(1)
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.INGEST].params.instructions),
		context_category: z
			.enum(["auto", "user_preference", "business_knowledge", "decision_trace"])
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.INGEST].params.context_category),
		forceful_relations: z
			.array(z.string().min(1))
			.min(1)
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.INGEST].params.forceful_relations),
		acl: z
			.array(z.string())
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.INGEST].params.acl),
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
		...scopeSchema,
	};

	const listSchema = {
		// Optional, because a UNIFIED database has no kind to choose (PRO-1618):
		// requiring one there means the caller either guesses and eats a refused
		// request, or is told to name a corpus that does not exist. The host
		// resolves it from the layout instead, exactly as query/ingest/delete do.
		//
		// It was made required to fix a real bug — `hydradb_list({})` returned
		// memories only and read as the complete inventory, so a caller asking
		// "what does Hydra DB have?" never saw the knowledge corpus. That fix is
		// kept without the requirement: on a SPLIT database an omitted kind still
		// lists memories, and the listing now says in as many words that
		// knowledge is a separate corpus it did not cover.
		kind: z
			.enum(["memory", "knowledge", "unified"])
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.LIST].params.kind),
		ids: z
			.array(z.string())
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.LIST].params.source_ids),
		source_ids: z
			.array(z.string())
			.optional()
			.describe("Deprecated alias for `ids`."),
		external_id: z
			.string()
			.trim()
			.min(1)
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.LIST].params.external_id),
		parent_external_id: z
			.string().trim().min(1).optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.LIST].params.parent_external_id),
		connector_id: z
			.string().trim().min(1).optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.LIST].params.connector_id),
		url: z
			.string()
			.trim()
			.min(1)
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.LIST].params.url),
		provider: z
			.string()
			.trim()
			.min(1)
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.LIST].params.provider),
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
		acl: z
			.array(z.string())
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.LIST].params.acl),
		...scopeSchema,
	};

	const listSourcesSchema = {
		source_ids: z
			.array(z.string())
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.LIST_SOURCES].params.source_ids),
		acl: z
			.array(z.string())
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.LIST].params.acl),
		...scopeSchema,
	};

	const listMemoriesSchema = {
		acl: z
			.array(z.string())
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.LIST].params.acl),
		...scopeSchema,
	};

	const subgraphSchema = {
		id: z.string().min(1).describe(TOOL_DESCRIPTIONS[TOOL_NAMES.SUBGRAPH].params.id),
		kind: z
			.enum(["memory", "knowledge"])
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.SUBGRAPH].params.kind),
		depth: z
			.number()
			.int()
			.min(1)
			.max(10)
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.SUBGRAPH].params.depth),
		max_sources: z
			.number()
			.int()
			.min(1)
			.max(1000)
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.SUBGRAPH].params.max_sources),
		acl: z
			.array(z.string())
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.SUBGRAPH].params.acl),
		...scopeSchema,
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
		acl: z
			.array(z.string())
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.INSPECT].params.acl),
		...scopeSchema,
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
			.enum(["memory", "knowledge", "unified"])
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.DELETE].params.kind),
		...scopeSchema,
	};

	// Output schemas, declared only where the result is genuinely structured.
	// Query stays prose: its payload IS text, and forcing it into fields would
	// duplicate the rendered context rather than replace it.
	const listOutputSchema = {
		kind: z.enum(["memory", "knowledge", "unified"]),
		resolved_scope: z.object({ database: z.string(), collection: z.string().nullable() }).optional(),
		items: z.array(
			z.object({
				id: z.string(),
				title: z.string().optional(),
				type: z.string().optional(),
				content: z.string().optional(),
				external_id: z.string().optional(),
				provider: z.string().optional(),
				parent_external_id: z.string().optional(),
				connector_id: z.string().optional(),
				children_args: z.record(z.unknown()).optional(),
				inspect_args: z.object({ id: z.string(), database: z.string(), collection: z.string().optional(), acl: z.array(z.string()).optional() }).optional(),
			}),
		),
		shown: z.number(),
		total: z.number(),
		page: z.number(),
		has_more: z.boolean(),
		next_args: z.record(z.unknown()).optional(),
	};

	const ingestOutputSchema = {
		id: z.string().optional(),
		success_count: z.number(),
		failed_count: z.number(),
		indexing_pending: z.boolean(),
	};

	const deleteOutputSchema = {
		ids: z.array(z.string()),
		kind: z.enum(["memory", "knowledge", "unified"]),
		deleted: z.boolean(),
		/** Absent when the server confirmed a removal without saying how many. */
		deleted_count: z.number().optional(),
		deleted_count_known: z.boolean().optional(),
		partial: z.boolean().optional(),
		reason: z.string().optional(),
	};

	const statusSchema = {
		ids: z
			.array(z.string())
			.min(1)
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.STATUS].params.ids),
		...scopeSchema,
	};

	const deleteMemorySchema = {
		memory_id: z
			.string()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.DELETE_MEMORY].params.memory_id),
		...scopeSchema,
	};

	// --- BYOG graph schemas ---

	const graphScopeSchema = {
		database: z
			.string()
			.min(1)
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.GRAPH_QUERY].params.database),
		collection: z
			.string()
			.min(1)
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.GRAPH_QUERY].params.collection),
	};

	/**
	 * Cypher text is bounded like every other free-text input on this server.
	 * The 256 KiB body cap covers query plus params together and is checked in
	 * the handler; this only stops an absurd query string before it gets there.
	 */
	const MAX_CYPHER_CHARS = 100_000;

	const graphCypherSchema = {
		query: z
			.string()
			.min(1, { message: "query must not be empty" })
			.max(MAX_CYPHER_CHARS, {
				message: `query must be at most ${MAX_CYPHER_CHARS} characters`,
			})
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.GRAPH_QUERY].params.query),
		params: z
			.record(z.unknown())
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.GRAPH_QUERY].params.params),
		...graphScopeSchema,
		max_rows: z
			.number()
			.int()
			.min(1)
			.max(1000)
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.GRAPH_QUERY].params.max_rows),
	};

	const graphCollectionsSchema = {
		database: z
			.string()
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.GRAPH_COLLECTIONS].params.database),
	};

	const graphAdminSchema = {
		action: z
			.enum(["create_database", "drop_collection", "drop_database"])
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.GRAPH_ADMIN].params.action),
		database: z
			.string()
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.GRAPH_ADMIN].params.database),
		collection: z
			.string()
			.optional()
			.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.GRAPH_ADMIN].params.collection),
	};

	const graphRowsOutputSchema = {
		database: z.string(),
		collection: z.string(),
		rows: z.array(z.record(z.unknown())),
		row_count: z.number(),
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
			attributes?: Record<string, unknown>;
			custom_attributes?: Record<string, unknown>;
			happened_at?: string;
			instructions?: string;
			context_category?: ContextCategory;
			forceful_relations?: string[];
			acl?: string[];
			turns?: ConversationTurn[];
			user_name?: string;
			database?: string;
			collection?: string;
		};

		const hasTurns = a.turns != null && a.turns.length > 0;

		// `attributes`/`metadata` and `happened_at`/`observation_date` are one
		// field each under two names (PRO-1618 renamed them). Both are accepted
		// so nothing that worked stops working; a caller that sends both with
		// different values has stated two things and only they can say which,
		// so it is refused rather than one of them silently winning.
		if (
			a.attributes != null &&
			a.metadata != null &&
			canonicalJson(a.attributes) !== canonicalJson(a.metadata)
		) {
			throw new Error(
				`${TOOL_NAMES.INGEST} received different values for \`attributes\` and its ` +
				`older name \`metadata\`. Pass only \`attributes\`.`,
			);
		}
		if (
			a.happened_at != null &&
			a.observation_date != null &&
			a.happened_at !== a.observation_date
		) {
			throw new Error(
				`${TOOL_NAMES.INGEST} received different values for \`happened_at\` and its ` +
				`older name \`observation_date\`. Pass only \`happened_at\`.`,
			);
		}
		const attributes = a.attributes ?? a.metadata;
		const happenedAt = a.happened_at ?? a.observation_date;

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
					["attributes", a.attributes],
					["happened_at", a.happened_at],
					["custom_attributes", a.custom_attributes],
					["instructions", a.instructions],
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
					// Forwarded like every other option on this path: the kind
					// was dropped here, so an explicit one was silently replaced
					// by the pinned "memory" the handler used to send.
					kind: a.kind,
					userName: a.user_name,
					infer: a.infer,
					title: a.title,
					isMarkdown: a.is_markdown,
					overwrite: a.overwrite,
					// The contract's names (PRO-1618) reach the conversation path
					// as they reach the text path, folded with their older
					// spellings the same way: a caller who sent `metadata` or
					// `observation_date` on a conversation had them silently
					// dropped, while the folded value lands on the same wire
					// field either spelling would have used.
					attributes,
					happenedAt,
					customAttributes: a.custom_attributes,
					instructions: a.instructions,
					contextCategory: a.context_category,
					forcefulRelations: a.forceful_relations,
					acl: a.acl,
					database: a.database,
					collection: a.collection,
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
					// Forwarded, not dropped. The schema accepts `user_name` on
					// every non-knowledge ingest, and the memory item shape has a
					// field for it — but the text path used to hand it to nobody,
					// so a caller naming the speaker on a note was answered
					// "success: 1" and had it discarded. On a unified database it
					// has nowhere to go (see the wrapper) and is now refused.
					user_name: a.user_name,
					infer: a.infer,
					is_markdown: a.is_markdown,
					overwrite: a.overwrite,
					metadata: attributes,
					observation_date: happenedAt,
					custom_attributes: a.custom_attributes,
					instructions: a.instructions,
					context_category: a.context_category,
					forceful_relations: a.forceful_relations,
					acl: a.acl,
					database: a.database,
					collection: a.collection,
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
				kind?: "memory" | "knowledge" | "unified";
				ids?: string[];
				source_ids?: string[];
				external_id?: string;
				parent_external_id?: string;
				connector_id?: string;
				url?: string;
				provider?: string;
				page?: number;
				page_size?: number;
				acl?: string[];
				database?: string;
				collection?: string;
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
			return runList(
				{
					kind: a.kind,
					source_ids: ids,
					external_id: a.external_id,
					parent_external_id: a.parent_external_id,
					connector_id: a.connector_id,
					url: a.url,
					provider: a.provider,
					page: a.page,
					page_size: a.page_size,
					acl: a.acl,
					database: a.database,
					collection: a.collection,
				},
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
		TOOL_NAMES.SUBGRAPH,
		subgraphSchema,
		(args, extra) => runSubgraph(args as Parameters<typeof runSubgraph>[0], extra?.signal),
		readOnly,
	);

	register(
		TOOL_NAMES.DELETE,
		deleteSchema,
		(args, extra) => runDelete(toDeleteArgs(args), extra?.signal),
		destructive,
		deleteOutputSchema,
	);

	const feedbackSchema = {
		request_id: z.string().min(1).describe(FEEDBACK_PARAMS.request_id),
		feedback: z
			.string()
			.max(MAX_FEEDBACK_CHARS, {
				message: `feedback must be at most ${MAX_FEEDBACK_CHARS} characters`,
			})
			.optional()
			.describe(FEEDBACK_PARAMS.feedback),
		rating: z
			.enum(["positive", "negative", "neutral"])
			.optional()
			.describe(FEEDBACK_PARAMS.rating),
		ground_truth_answer: z
			.string()
			.max(MAX_GROUND_TRUTH_ANSWER_CHARS, {
				message: `ground_truth_answer must be at most ${MAX_GROUND_TRUTH_ANSWER_CHARS} characters`,
			})
			.optional()
			.describe(FEEDBACK_PARAMS.ground_truth_answer),
		// Each id is bounded here, but the COUNT is not: the server applies its
		// 100-id cap after de-duplicating, so a list of 150 ids that collapses to
		// 80 is valid. Capping the raw array would refuse a request the server
		// accepts, which is worse than the round trip this is avoiding. The count
		// is checked in FeedbackResource.submit, where the de-duplication happens.
		ground_truth_source_ids: z
			.array(
				z.string().max(MAX_GROUND_TRUTH_SOURCE_ID_CHARS, {
					message: `each source id must be at most ${MAX_GROUND_TRUTH_SOURCE_ID_CHARS} characters`,
				}),
			)
			.optional()
			.describe(FEEDBACK_PARAMS.ground_truth_source_ids),
		metadata: z
			.record(
				z.string().max(MAX_FEEDBACK_METADATA_KEY_CHARS, {
					message: `each metadata key must be at most ${MAX_FEEDBACK_METADATA_KEY_CHARS} characters`,
				}),
				z.string().max(MAX_FEEDBACK_METADATA_VALUE_CHARS, {
					message: `each metadata value must be at most ${MAX_FEEDBACK_METADATA_VALUE_CHARS} characters`,
				}),
			)
			.refine((m) => Object.keys(m).length <= MAX_FEEDBACK_METADATA_ENTRIES, {
				message: `metadata must have at most ${MAX_FEEDBACK_METADATA_ENTRIES} entries`,
			})
			.optional()
			.describe(FEEDBACK_PARAMS.metadata),
		...scopeSchema,
	};

	// Not readOnly: it writes a row. Not destructive either — it adds a signal
	// and removes nothing, and re-sending it records a second row rather than
	// overwriting the first, so it is neither idempotent nor safe to retry blindly.
	register(
		TOOL_NAMES.FEEDBACK,
		feedbackSchema,
		(args, extra) => runFeedback(z.object(feedbackSchema).parse(args), extra?.signal),
		additiveWrite,
	);

	register(
		TOOL_NAMES.STATUS,
		statusSchema,
		(args, extra) => runStatus(args as Parameters<typeof runStatus>[0], extra?.signal),
		readOnly,
	);

	// Only an OAuth connection carries a user's database decision, and only
	// there does an agent need a way to see it. Registering this for API-key
	// connections too would change their tool list, which must stay identical.
	if (options.oauthTools) {
		register(TOOL_NAMES.DATABASES, {}, (_args, extra) => runDatabases(extra?.signal), readOnly);
	}

	register(
		TOOL_NAMES.LIST_COLLECTIONS,
		{
			database: z
				.string()
				.min(1)
				.optional()
				.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.LIST_COLLECTIONS].params.database),
		},
		(args, extra) =>
			runListCollections(args as Parameters<typeof runListCollections>[0], extra?.signal),
		readOnly,
		{
			database: z.string(),
			// The connection's default collection, or null when the user chose
			// "no specific collection" — the marker hosts branch on.
			default: z.string().nullable(),
			collections: z.array(z.string()),
			count: z.number(),
			knowledge_rows: z.number().optional(),
			memory_rows: z.number().optional(),
		},
	);

	register(
		TOOL_NAMES.DELETE_COLLECTION,
		{
			collection: z
				.string()
				.min(1)
				.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.DELETE_COLLECTION].params.collection),
			database: z
				.string()
				.min(1)
				.optional()
				.describe(TOOL_DESCRIPTIONS[TOOL_NAMES.DELETE_COLLECTION].params.database),
		},
		(args, extra) =>
			runDeleteCollection(args as Parameters<typeof runDeleteCollection>[0], extra?.signal),
		destructive,
		{
			database: z.string(),
			collection: z.string(),
			status: z.string(),
			deleted: z.boolean(),
		},
	);

	// --- BYOG graph tools (PRO-1681) ---
	//
	// A separate product surface from the memory/knowledge tools above: property
	// graphs the user models and owns, addressed in Cypher. Registered by
	// default so the capability is discoverable — the feature exists today and
	// no client surfaces it — and gated by one switch:
	//
	//   HYDRADB_MCP_GRAPH_TOOLS=0  withholds all three, for memory-only users
	//                              who do not want the manifest cost.
	//
	// There is no read-only mode. It would have to classify Cypher client-side
	// to decide what to refuse, which is a heuristic — offering it would invite
	// operators to trust a guarantee it could not make. Withholding the tools
	// outright is a real guarantee; that is the switch above.
	if (graphConfig.enabled) {
		register(
			TOOL_NAMES.GRAPH_QUERY,
			graphCypherSchema,
			(args, extra) =>
				runGraphCypher(args as Parameters<typeof runGraphCypher>[0], extra?.signal),
			// Destructive, not read-only: this one tool runs arbitrary Cypher, so
			// DELETE is as reachable through it as MATCH. Annotating it any other
			// way would tell a host it is safe to auto-approve, which is exactly
			// the claim the removed read/write split could not actually back.
			destructive,
			graphRowsOutputSchema,
		);

		register(
			TOOL_NAMES.GRAPH_COLLECTIONS,
			graphCollectionsSchema,
			(args, extra) =>
				runGraphCollections(
					args as Parameters<typeof runGraphCollections>[0],
					extra?.signal,
				),
			readOnly,
		);

		register(
			TOOL_NAMES.GRAPH_ADMIN,
			graphAdminSchema,
			(args, extra) =>
				runGraphAdmin(args as Parameters<typeof runGraphAdmin>[0], extra?.signal),
			destructive,
		);
	}

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
			database?: string;
			collection?: string;
		};

		// The deprecated alias keeps its historical shape (user_name only; infer
		// on, no title/markdown). The canonical hydradb_ingest forwards the rest.
			return runIngestConversation(
				a.turns,
				a.source_id,
				{
					userName: a.user_name,
					database: a.database,
					collection: a.collection,
				},
				extra?.signal,
			);
		},
		additiveWrite,
	);

	register(
		TOOL_NAMES.LIST_MEMORIES,
		listMemoriesSchema,
		(args, extra) =>
			runListMemories(
				args as { acl?: string[]; database?: string; collection?: string },
				extra?.signal,
			),
		readOnly,
	);

	register(
		TOOL_NAMES.LIST_SOURCES,
		listSourcesSchema,
		(args, extra) =>
			runListSources(
				args as {
					source_ids?: string[];
					acl?: string[];
					database?: string;
					collection?: string;
				},
				extra?.signal,
			),
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
			const a = args as {
				memory_id: string;
				database?: string;
				collection?: string;
			};

			return runDelete(
				{
					ids: [a.memory_id],
					kind: "memory",
					database: a.database,
					collection: a.collection,
				},
				extra?.signal,
			);
		},
		destructive,
	);
	}

	return server.server;
}
