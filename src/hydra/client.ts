/**
 * Thin, hand-owned wrapper around the generated `@hydradb/sdk`.
 *
 * This is the single place the MCP server (and, later, the OpenClaw port of
 * this same pattern) touches the SDK. It:
 *   - owns the SDK at an EXACT pin (see package.json `"@hydradb/sdk": "2.1.2"`),
 *   - exposes the canonical vocabulary from CONTRACT.md §2 (camelCase in TS),
 *   - injects scope (`database` / `collection`) that the SDK reads from no env,
 *   - unwraps the `HandlerEnvelope` by shape (see ./envelope),
 *   - translates SDK errors into a stable host error (see ./errors).
 *
 * Injected DEFAULTS (alpha, recency bias, mode, upsert, ingest instructions)
 * are deliberately NOT baked in here — per CONTRACT §2 rule 5 those are host
 * behaviour and are supplied by the caller, so this wrapper stays portable.
 */

import { Buffer } from "node:buffer";
import { HydraDBClient, HydraDBEnvironment, HydraDBError, serialization } from "@hydradb/sdk";
import type { HydraDB as SDK } from "@hydradb/sdk";
import { z } from "zod";

import type { JsonValue } from "../adapters.js";
import { type IngestRecordType, serializeRecordType } from "../record-type.js";
import { ConnectorsResource } from "./connectors.js";
import { readRequestId, readResponseMeta, type ResponseMeta, unwrap } from "./envelope.js";
import { HydraWrapperError, scrub, translateError } from "./errors.js";
import { type GraphConfig, GraphResource } from "./graph.js";
import {
	type CallBudget,
	DEFAULT_MAX_RETRIES,
	DEFAULT_TIMEOUT_SECONDS,
	type RetrySafety,
	withRetries,
} from "./retry.js";
import { type RawTransport, mcpHeaders, newRawTransport, sendRaw } from "./transport.js";

/** Storage layout of a database (PRO-1618): fixed at creation, never changed. */
export type Layout = "split" | "unified";

/** One `GET /databases` `details[]` row: a database and its storage layout. */
export interface DatabaseDetail {
	database?: string;
	type?: string;
}

/**
 * `GET /databases`, with the `details[]` the pinned SDK's response model does
 * not declare (PRO-1618). Declared here rather than left to `unknown` so a
 * caller reading the layout is type-checked against the shape the server sends.
 */
export type DatabaseListing = SDK.TenantsTenantIdsResponse & {
	details?: DatabaseDetail[];
};

/**
 * `unified` (PRO-1618) names the ONE corpus of a database created with
 * `type: "unified"`, where knowledge and memory are not separate. On such a
 * database it is the only accepted value (and the server default); on a split
 * database it is refused, exactly as `memory`/`knowledge` are refused on a
 * unified one. `databases.layout()` tells the two apart.
 */
export type ContextKind = "memory" | "knowledge" | "unified";

export { DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT_SECONDS };

const MISSING_DATABASE_MESSAGE = "Missing database: pass `database` per call, or set HYDRADB_DATABASE (stdio) / X-HydraDB-Database (HTTP). Use hydradb_databases to list accessible databases.";

/**
 * Per-call transport controls, separate from the domain params.
 *
 * `signal` carries the host's cancellation into the SDK. Without it a cancelled
 * MCP tool call leaves the outbound HTTP request in flight: the caller has given
 * up, and the process keeps working and keeps retrying on its behalf.
 */
export interface RequestOptions {
	signal?: AbortSignal;
	/**
	 * Receives the envelope's `meta` for this one call.
	 *
	 * `unwrap` keeps only `data`, which is right for every caller that just wants
	 * the payload — but it drops `request_id`, and that is the ONLY key
	 * POST /feedback accepts to correlate a submission with the query it is
	 * about. Without it an agent can run a query and then have nothing to say
	 * feedback ON.
	 *
	 * A per-call callback rather than a field on the resource: two tool calls can
	 * be in flight at once, and a `lastRequestId` would hand one of them the
	 * other's id. Opt-in, so no existing caller changes.
	 */
	onMeta?: (meta: ResponseMeta) => void;
}

/**
 * Retrieval accepts a third corpus selector the write/list paths do not: `all`,
 * which searches memories and knowledge together. Only `context.query` takes it
 * — ingesting or deleting "all" is meaningless, so those stay `ContextKind`.
 */
export type QueryKind = ContextKind | "all";

/**
 * Caller-declared relations from one unified item to other context ids
 * (PRO-1618). Wire key `forceful_relations`, ids under `ids`.
 */
export interface ForcefulRelations {
	ids: string[];
	properties?: Record<string, unknown>;
}

// --- The unified `POST /query` response (PRO-1618) ---
//
// The unified structured response includes core `chunks`, `graph`,
// `forceful_relations` and `llm_prompt` fields; additional fields may be present.
// The types below model fields consumed by the unified renderer, using their
// wire names.

export interface UnifiedTemporal {
	content?: string;
	start_date?: string | null;
	end_date?: string | null;
}

export interface UnifiedChunk {
	chunk_id?: string;
	/** The source id (was `id` on the v2 shape). */
	context_id?: string;
	score?: number;
	/** The chunk's own text; enrichment is not concatenated into it. */
	content?: string;
	/** The enrichment text, a plain string; absent when there is none. */
	enrichment?: string;
	/** Present only when the query engaged temporal reasoning. */
	temporal?: UnifiedTemporal[];
}

export interface UnifiedEntity {
	entity_id?: string;
	name?: string;
}

export interface UnifiedEdge {
	predicate?: string;
	context?: string;
	temporal_details?: string;
	relationship_id?: string;
	chunk_id?: string;
}

export interface UnifiedTriplet {
	source?: UnifiedEntity;
	relation?: UnifiedEdge;
	target?: UnifiedEntity;
}

/**
 * Where a graph path came from: `query_path` was grown from the query's own
 * entities; `chunk_relation` is the neighbourhood of a returned chunk, and
 * every hop on it names that chunk in `relation.chunk_id`.
 */
export type UnifiedGraphOrigin = "query_path" | "chunk_relation";

export interface UnifiedGraphPath {
	origin?: UnifiedGraphOrigin;
	triplets?: UnifiedTriplet[];
	path_summary?: string;
}

/**
 * A chunk pulled in because the caller declared `forceful_relations` at
 * ingest, not because it matched the query.
 */
export interface UnifiedForcefulRelation {
	/** `to` is the returned chunk's own context id; `from` may be "". */
	via?: { from?: string; to?: string };
	chunk?: UnifiedChunk;
}

export interface UnifiedQueryResult {
	chunks: UnifiedChunk[];
	/** Query paths first, then chunk expansions; `[]` when graph_context=false. */
	graph: UnifiedGraphPath[];
	/** `[]` when nothing was declared at ingest, or follow_forceful_relations=false. */
	forceful_relations: UnifiedForcefulRelation[];
	/** Server-built, with citation labels [1], [R1], [P1]. Surface it verbatim. */
	llm_prompt: string;
}

/** What `context.query` resolves to: the returned V2 or unified structured response, selected by response shape rather than physical layout alone. */
export type SplitQueryResult = SDK.SearchV2RetrievalResult & {
	additionalGraphContext?: SDK.SearchV2RetrievalResult["additionalContext"];
};
export type QueryResult = SplitQueryResult | UnifiedQueryResult;

/**
 * Whether a `/query` wire body is the unified shape.
 *
 * Decided by shape, not by what was requested (CONTRACT rule 4): stored logs
 * and split databases keep producing the v2 shape, and a server that predates
 * the unified response answers a unified request with it too. The unified
 * shape is `chunks` and `graph` as arrays and `llm_prompt` as a string, with a
 * usable `context_id` on every chunk; `forceful_relations` is optional in the
 * contract, so an absent one reads as none (an array when present). The v2
 * shape carries `graph_context` and per-chunk `chunk_content` instead, and
 * the presence of `graph_context` is what settles a body that has both. A body
 * showing some unified keys but not the whole shape is malformed, not
 * unified — `carriesUnifiedMarkers` is what calls that out so the caller
 * can refuse it rather than let it read as an empty answer.
 */
export function isUnifiedQueryResult(value: unknown): value is UnifiedQueryResult {
	if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if ("graph_context" in record) return false;
	if (typeof record.llm_prompt !== "string") return false;
	if (!Array.isArray(record.chunks)) return false;
	if (!Array.isArray(record.graph)) return false;

	// Optional, but an array when present. The pre-rename `relations` key never
	// shipped and is not read: a body carrying it in place of
	// `forceful_relations` is refused as malformed rather than read as "none".
	if ("forceful_relations" in record) {
		if (!Array.isArray(record.forceful_relations)) return false;
	} else if ("relations" in record) {
		return false;
	}
	// A chunk whose source id is absent or not a string cannot be cited,
	// inspected or deleted — it is a malformed row, not an empty one.
	return record.chunks.every(
		(chunk) =>
			chunk != null &&
			typeof chunk === "object" &&
			typeof (chunk as Record<string, unknown>).context_id === "string" &&
			(chunk as Record<string, unknown>).context_id !== "",
	);
}

/**
 * Structures specific to a unified `/query` body. Shared prompt or relation
 * field names alone do not distinguish it from a rollout-disabled v2 body.
 * A response showing unified structures that fails `isUnifiedQueryResult`
 * is a protocol violation, and routing it to the v2 serializer would quietly
 * produce an empty-looking answer for what was a broken response.
 */
function carriesUnifiedMarkers(wire: unknown): boolean {
	if (wire == null || typeof wire !== "object" || Array.isArray(wire)) return false;
	const record = wire as Record<string, unknown>;
	if ("graph_context" in record || record.graphContext != null) return false;
	return Array.isArray(record.graph) || Array.isArray(record.forceful_relations) ||
		(Array.isArray(record.chunks) && record.chunks.some((chunk) => chunk != null && typeof chunk === "object" &&
			("context_id" in chunk || ("content" in chunk && !("chunk_content" in chunk) && !("chunkContent" in chunk)))));
}

/**
 * How long a probed or learned layout is trusted before `GET /databases` is
 * asked again. Long enough that a busy session probes rarely, short enough
 * that a database deleted and recreated under the other layout is picked up.
 */
const LAYOUT_TTL_MS = 5 * 60_000;

function malformedUnifiedResponse(wire: unknown): HydraWrapperError {
	return new HydraWrapperError(
		"Hydra DB /query → ERR: malformed unified response: expected " +
			"chunks[], graph[], a string llm_prompt, a string context_id on every " +
			"chunk, and forceful_relations[] when present",
		"/query",
		{ body: wire },
	);
}

/**
 * A `/query` answer that came back in the unified shape on a route that asked
 * for `all`, `memory` or `knowledge`.
 *
 * The SDK preserves the unknown unified structures but renames the shared
 * llm_prompt field to llmPrompt. The body is read by structure and that prompt
 * name is normalized. The envelope is kept so `call` still reads the
 * request id. `undefined` means the answer is v2 and the v2 checks apply.
 */
function unifiedFromV2Route(response: unknown): unknown {
	const payload = unwrap<unknown>(response);
	const candidate = payload != null && typeof payload === "object" && !Array.isArray(payload)
		? { ...payload, llm_prompt: (payload as Record<string, unknown>).llm_prompt ?? (payload as Record<string, unknown>).llmPrompt }
		: payload;

	if (!isUnifiedQueryResult(candidate)) {
		if (carriesUnifiedMarkers(candidate)) {
			throw malformedUnifiedResponse(payload);
		}

		return undefined;
	}

	const unified = toUnifiedQueryResult(candidate);

	if (payload === response) return unified;

	// SAFETY: `unwrap` returned something other than its input only because
	// `response` is an envelope object carrying the payload under `data`.
	return { ...(response as Record<string, unknown>), data: unified };
}

/**
 * Normalize the core array fields consumed by the unified renderer.
 * Optional arrays omitted by the server read as empty here.
 */
export function toUnifiedQueryResult(wire: UnifiedQueryResult): UnifiedQueryResult {
	return {
		chunks: Array.isArray(wire.chunks) ? wire.chunks : [],
		graph: Array.isArray(wire.graph) ? wire.graph : [],
		forceful_relations: Array.isArray(wire.forceful_relations) ? wire.forceful_relations : [],
		llm_prompt: typeof wire.llm_prompt === "string" ? wire.llm_prompt : "",
	};
}

/**
 * An SDK logger that cannot corrupt the stdio transport.
 *
 * The SDK's own `ConsoleLogger` implements `debug`/`info` via `console.debug` /
 * `console.info`, which are stdout aliases in Node. On stdio transport stdout IS
 * the JSON-RPC channel, so a single SDK log line would break the session.
 *
 * Not currently live — the SDK's default logger is constructed `silent: true` —
 * but the exposure is one `logging: { level: "debug" }` away, which is precisely
 * what someone debugging a production incident reaches for. Passing an explicit
 * logger pins the safe behaviour instead of inheriting it.
 */
const STDERR_LOGGER = {
	debug: (message: string, ...args: unknown[]) =>
		console.error("[hydradb-sdk]", message, ...args),
	info: (message: string, ...args: unknown[]) =>
		console.error("[hydradb-sdk]", message, ...args),
	warn: (message: string, ...args: unknown[]) =>
		console.error("[hydradb-sdk]", message, ...args),
	error: (message: string, ...args: unknown[]) =>
		console.error("[hydradb-sdk]", message, ...args),
};

/** What each SDK attempt receives: the call's signal, and no SDK-side retries. */
interface SdkRequestOptions {
	abortSignal: AbortSignal;
	maxRetries: 0;
}

/** Generated deserialization is deliberately permissive; reject false empties. */
function validateQueryResponse(response: unknown): void {
	const successful = z.object({ success: z.literal(true).optional(), error: z.null().optional() });
	const payload = unwrap<unknown>(response);
	if (!successful.safeParse(response).success || !successful.extend({
		chunks: z.array(z.object({ id: z.string().trim().min(1) })),
	}).safeParse(payload).success) {
		throw new HydraDBError({ statusCode: 200, body: { error: {
			code: "INVALID_QUERY_RESPONSE",
			message: "Invalid successful query response: expected a chunks array with nonempty source IDs and no failure flag.",
		} } });
	}
}

/** What `sdk.context.list` resolves to: the response envelope. */
type ListResponse = Awaited<ReturnType<HydraDBClient["context"]["list"]>>;

type StatusResponse = Awaited<ReturnType<HydraDBClient["context"]["status"]>>;

type DatabasesResponse = Awaited<ReturnType<HydraDBClient["databases"]["list"]>>;

type ValidatableResponse = ListResponse | StatusResponse | DatabasesResponse;

interface InvalidResponseBody {
	error: { code: string; message: string };
	meta?: { request_id: string };
}

const successfulResponse = z.object({
	success: z.literal(true).optional(),
	error: z.null().optional(),
});

function invalidSuccessfulResponse(
	code: string,
	message: string,
	response: ValidatableResponse,
): HydraDBError {
	const requestId = readRequestId(response);

	const body: InvalidResponseBody = { error: { code, message } };

	if (requestId) body.meta = { request_id: requestId };

	return new HydraDBError({
		statusCode: 200,
		body,
	});
}

const selectableListContainer = z.object({
	inner: z.object({}).passthrough().nullish(),
	userMemories: z.array(z.object({}).passthrough()).optional(),
	user_memories: z.array(z.object({}).passthrough()).optional(),
	sources: z.array(z.object({}).passthrough()).optional(),
}).passthrough();

type SelectableListContainer = z.infer<typeof selectableListContainer>;

/** Select the list container with the same top-level-first precedence as the adapters. */
function selectListPayload(response: ListResponse, kind: ListParams["kind"]): SelectableListContainer | undefined {
	const parsed = selectableListContainer.safeParse(unwrap(response));

	if (!parsed.success) return undefined;

	const topLevelRows = kind === "memory"
		? parsed.data.userMemories ?? parsed.data.user_memories
		: parsed.data.sources;

	return topLevelRows != null ? parsed.data : parsed.data.inner ?? parsed.data;
}

/**
 * A list row with a usable ID, by the list adapters' first-string precedence,
 * so a blank `id` cannot hide behind a valid legacy `source_id`.
 */
function listRow(identityKeys: readonly string[]) {
	return z.object({}).passthrough().refine((row) => {
		const id = identityKeys.map((key) => row[key]).find((value) => z.string().safeParse(value).success);

		return z.string().trim().min(1).safeParse(id).success;
	});
}

/** The rows of one list kind, under the SDK's name or the wire's. */
function listPayload(kind: ListParams["kind"]) {
	if (kind === "memory") {
		const rows = z.array(listRow(["memoryId", "memory_id", "id", "source_id"]));

		return z.union([
			successfulResponse.extend({ userMemories: rows }),
			successfulResponse.extend({ user_memories: rows }),
		]);
	}

	return successfulResponse.extend({ sources: z.array(listRow(["id", "source_id"])) });
}

/**
 * Reject a successful list that is not a real list, bare or enveloped, also
 * accepting the historical `inner` nesting the list adapters understand.
 */
function validateListResponse(response: ListResponse, kind: ListParams["kind"]): void {
	const accepted = listPayload(kind);
	const payload = unwrap(response);
	const selected = selectListPayload(response, kind);

	if (kind === "memory") {
		// The outer payload counts too: its message is lost when `inner` is selected.
		const unavailable = [selected, payload].some((container) => {
			const availability = z.object({ message: z.string().optional() }).safeParse(container);

			return availability.success && availability.data.message === "Memories temporarily unavailable";
		});

		if (unavailable) {
			throw invalidSuccessfulResponse(
				"MEMORY_LIST_UNAVAILABLE",
				"Hydra DB could not read the memory store. This is not an empty database. Retry the list.",
				response,
			);
		}
	}

	if (
		!successfulResponse.safeParse(response).success ||
		!successfulResponse.safeParse(payload).success ||
		!accepted.safeParse(selected).success
	) {
		throw invalidSuccessfulResponse(
			"INVALID_LIST_RESPONSE",
			`Invalid successful list response: expected a ${kind === "memory" ? "user_memories" : "sources"} ` +
				"array with nonempty row IDs and no failure flag.",
			response,
		);
	}
}

function validateStatusResponse(response: StatusResponse): void {
	// The status tool prints each row by its id, so a row that is not an object
	// with an id is a malformed body, not a status to show as "(unknown id)".
	const row = z.object({ id: z.string().trim().min(1) }).passthrough();
	const accepted = successfulResponse.extend({ statuses: z.array(row) });

	if (!successfulResponse.safeParse(response).success || !accepted.safeParse(unwrap(response)).success) {
		throw invalidSuccessfulResponse(
			"INVALID_STATUS_RESPONSE",
			"Invalid successful status response: expected a statuses array of rows with an id and no failure flag.",
			response,
		);
	}
}

function validateDatabasesResponse(response: DatabasesResponse): void {
	const names = z.array(z.string().trim().min(1));

	const accepted = z.union([
		successfulResponse.extend({ databases: names }),
		successfulResponse.extend({ tenantIds: names }),
		successfulResponse.extend({ tenant_ids: names }),
	]);

	if (!successfulResponse.safeParse(response).success || !accepted.safeParse(unwrap(response)).success) {
		throw invalidSuccessfulResponse(
			"INVALID_DATABASES_RESPONSE",
			"Invalid successful databases response: expected a string array and no failure flag.",
			response,
		);
	}
}

const markdownQueryResponse = z.object({ success: z.literal(true).optional(), data: z.string() });

export interface HydraConfig {
	/** Bearer token (the HydraDB API key). */
	token: string;
	/** Set when the caller signed in through OAuth on the hosted server. */
	oauthUserId?: string;
	/** Database scope (canonical name for the tenant). */
	database?: string;
	/** Collection scope (canonical name for the sub-tenant). */
	collection?: string;
	/**
	 * Databases a per-call `database` override may name. Absent means any.
	 * Set from an OAuth grant the user confined to specific databases; the
	 * default `database` is always allowed.
	 */
	allowedDatabases?: string[];
	/** Collections a per-call `collection` override may name. Absent means any. */
	allowedCollections?: string[];
	/** Optional base URL override; defaults to the SDK's environment. */
	baseUrl?: string;
	/**
	 * Deadline for the whole call: every attempt and every wait between them.
	 * The SDK's own 60s applied to each attempt, so with its 2 retries a failing
	 * endpoint could occupy a caller for ~3 minutes — far longer than an MCP
	 * host waits, which then timed out first with no HydraDB diagnostic while
	 * this process kept retrying.
	 */
	timeoutSeconds?: number;
	/** Attempts after the first, inside that deadline. 0 disables retrying. */
	maxRetries?: number;
	/** Test seam for the hand-rolled HTTP path (see ./transport.ts); production never sets it. */
	fetchFn?: typeof fetch;
}

export interface QueryParams {
	query: string;
	kind?: QueryKind;
	/**
	 * How the terms in `query` are combined. Keyword semantics, so it is only
	 * meaningful — and only accepted — under `queryBy: "text"`; see `query`.
	 */
	operator?: "or" | "and" | "phrase";
	/**
	 * Retrieval method. `hybrid` (what the API uses when this is omitted) runs
	 * dense and sparse retrieval together; `text` is keyword matching only.
	 */
	queryBy?: "hybrid" | "text";
	maxResults?: number;
	mode?: "fast" | "thinking" | "auto";
	graphContext?: boolean;
	/**
	 * Hybrid balance between keyword and vector retrieval: 0 to 1, or "auto".
	 * Hybrid only, so it is refused alongside keyword retrieval; see `query`.
	 */
	alpha?: SDK.SearchQueryRequestAlpha;
	recencyBias?: number;
	/** Text prepended to the query to improve retrieval. */
	additionalContext?: string;
	/** In thinking mode, follow relations declared at ingest. */
	queryForcefulRelations?: boolean;
	/** Resolve time-based questions using dated facts. The API defaults it on. */
	temporalReasoning?: boolean;
	/**
	 * `structured` asks the API to leave out its `llm_prompt` rendering. The
	 * Markdown form is a different response shape; see `queryMarkdown`.
	 */
	responseFormat?: "structured";
	/**
	 * Restrict retrieval to these source ids. A hard pre-filter: the server
	 * returns nothing rather than widening when none match.
	 */
	ids?: string[];
	/**
	 * Restrict retrieval to sources whose complete title equals one of these
	 * values, case-insensitively. The API resolves them to source ids before
	 * running the normal query pipeline.
	 */
	titles?: string[];
	/** Exact-match filters over stored metadata. No ranges, no partial matches. */
	metadataFilters?: Record<string, unknown>;
	/**
	 * Principals to answer as (PRO-1684 document ACLs): an email, a
	 * `domain:<host>`, or a `group:<provider>:<id>`. Results are restricted to
	 * documents whose access list admits at least one of them.
	 *
	 * Omitted means NO ACL scoping — every document this key can reach. An empty
	 * array is treated the SAME as omitted by the API (verified against staging:
	 * `acl: []` and no `acl` both returned 134 sources where an unknown
	 * principal returned 130), so it is not a way to ask for "nobody"; the
	 * design doc's rule is that absent and `[]` alike mean unrestricted.
	 *
	 * A principal the deployment does not know fails CLOSED: it matches only
	 * documents carrying no access list of their own, never a restricted one.
	 */
	acl?: string[];
	/** Adjacent chunks pulled in alongside each match, for surrounding context. */
	numRelatedChunks?: number;
	/**
	 * App-aware knowledge retrieval: exact IDs and actors, thread reconstruction,
	 * and parent/child expansion over connector-ingested sources. Applies to
	 * knowledge hybrid queries; the server ignores it elsewhere.
	 */
	queryApps?: boolean;
	/**
	 * Whether chunks declared related at ingest (`forceful_relations`) are
	 * pulled into the result (server default true).
	 */
	followForcefulRelations?: boolean;
	queryExplicitRelations?: boolean;
	additionalGraphContext?: string;
	/** Per-call collection override. */
	collection?: string;
	/**
	 * Multi-collection scope: a list for equal weighting, or a {collection:
	 * weight} object to rank some higher than others. Mutually exclusive with
	 * `collection` — see the guard in `query`.
	 */
	collections?: SDK.SearchQueryRequestCollections;
	/** Per-call database override. */
	database?: string;
}

export interface ConversationTurn {
	user: string;
	assistant: string;
}

export interface IngestGraphEntity {
	name: string;
	type: string;
	namespace?: string;
	identifier?: string;
}

export interface IngestGraphRelation {
	source: string;
	target: string;
	predicate: string;
	context?: string;
	temporal_details?: JsonValue;
}

export interface IngestGraph {
	entities: Record<string, IngestGraphEntity>;
	relations: IngestGraphRelation[];
}

export type AppKnowledgeKind =
	| "email"
	| "message"
	| "ticket"
	| "knowledge_base"
	| "comment"
	| "meeting"
	| "custom";

export interface AppKnowledgeItem {
	id?: string;
	title?: string;
	description?: string;
	url?: string;
	timestamp?: string;
	kind: AppKnowledgeKind;
	provider?: string;
	external_id?: string;
	fields: Record<string, JsonValue>;
	metadata?: Record<string, JsonValue>;
	additional_metadata?: Record<string, JsonValue>;
	attachments?: Array<Record<string, JsonValue>>;
	relations?: { ids: string[]; properties?: Record<string, JsonValue> } | Array<Record<string, JsonValue>>;
	acl?: string[] | null;
}

export interface IngestItem {
	/** Free text to ingest (memory note or knowledge document body). */
	text?: string;
	/** Conversation turns to ingest as a memory. */
	pairs?: ConversationTurn[];
	title?: string;
	sourceId?: string;
	userName?: string;
	infer?: boolean;
	isMarkdown?: boolean;
	/**
	 * Steers enrichment. Passed through only when `infer` is truthy (host-owned
	 * default text). Wire key `custom_instructions` on a split memory item and
	 * `instructions` on a unified item.
	 */
	customInstructions?: string;
	upsert?: boolean;
	/** Unified only (PRO-1618): declared relations to other context ids. Refused on a split database. */
	forcefulRelations?: ForcefulRelations;
	acl?: string[] | null;
	/**
	 * Tenant metadata stored alongside the memory, and matchable later via
	 * `metadataFilters` on query.
	 *
	 * Accepted by the backend (`domain/memories/models.go`) but absent from the
	 * generated SDK request type, which is why the wrapper carries it explicitly
	 * inside the memory item rather than as a typed field.
	 */
	metadata?: Record<string, JsonValue>;
	/** Document-level metadata, matchable via `additional_metadata`. */
	additionalMetadata?: Record<string, JsonValue>;
	/** Explicit forceful relationships attached to this document. */
	relations?: { ids: string[]; properties?: Record<string, JsonValue> };
	/** Caller-declared provenance class for this document. */
	evidenceKind?: "assertion" | "record" | "said" | "done" | "third_party" | "inferred";
	/** Caller-stable handle for the entity this document describes. */
	evidenceSubject?: string;
	/** When the fact was true, as opposed to when it was stored (RFC3339 date). */
	observationDate?: string;
	/** Filename to attach when ingesting knowledge text as a document. */
	filename?: string;
	/** Caller-supplied entities and relations for this item. */
	graph?: IngestGraph;
}

export interface IngestParams extends IngestItem {
	kind: ContextKind;
	/** Several same-kind items to send in one API request. */
	items?: IngestItem[];
	/** Structured app records such as messages, email, tickets, and meetings. */
	appKnowledge?: AppKnowledgeItem[];
	/**
	 * A file to upload as a knowledge document (PDF, DOCX, slides, ...), in
	 * place of all other ingest modes. Its title is its filename.
	 */
	file?: IngestDocument;
	recordType?: IngestRecordType;
	upsert?: boolean;
	collection?: string;
	/** Per-call database override. */
	database?: string;
}

interface MemoryWireItem {
	user_assistant_pairs?: ConversationTurn[];
	text?: string;
	infer: boolean;
	is_markdown: boolean;
	custom_instructions?: string;
	source_id?: string;
	title?: string;
	user_name?: string;
	metadata?: Record<string, JsonValue>;
	additional_metadata?: Record<string, JsonValue>;
	observation_date?: string;
}

/** One uploaded document: its bytes, its name and type, and optionally its id. */
export interface IngestDocument {
	data: Buffer;
	filename: string;
	contentType: string;
	/** The document's id (`document_metadata[].id`); the API assigns one when absent. */
	id?: string;
}

/** Fields accepted by PATCH /context/{id}/metadata. */
export interface UpdateContextParams {
	id: string;
	/** Values merged into the source's schema-controlled database metadata. */
	databaseMetadata?: SDK.HandlerContextMetadataUpdateRequest["databaseMetadata"];
	/** Free-form values merged into the source's additional metadata. */
	additionalMetadata?: SDK.HandlerContextMetadataUpdateRequest["additionalMetadata"];
	/** Full replacement ACL. Omit this property to leave the ACL unchanged. */
	acl?: string[];
	collection?: string;
	/** Per-call database override. */
	database?: string;
}

export interface ListParams {
	/** `all` lists memories and knowledge together, in one page (POST /context/list `type=all`). */
	kind?: QueryKind;
	ids?: string[];
	page?: number;
	pageSize?: number;
	/**
	 * Principals to answer as (PRO-1684 document ACLs): an email, a
	 * `domain:<host>`, or a `group:<provider>:<id>`. Results are restricted to
	 * documents whose access list admits at least one of them.
	 *
	 * Omitted means NO ACL scoping — every document this key can reach. An empty
	 * array is treated the SAME as omitted by the API, so it is not a way to ask
	 * for "nobody" (design doc: absent and `[]` alike mean unrestricted).
	 *
	 * A principal the deployment does not know fails CLOSED: it matches only
	 * documents carrying no access list of their own, never a restricted one.
	 */
	acl?: string[];
	collection?: string;
	/** Per-call database override. */
	database?: string;
	/**
	 * Exact-match constraints on well-known source fields, resolved server-side
	 * before listing (`filters.source_fields` on POST /context/list). Used for
	 * direct lookup by a source's originating-system identity —
	 * `app_external_id`, `url`, `app_provider`. Keys are the API's allow-listed
	 * source-field names; values match exactly (case-sensitive). Empty/absent
	 * means no such narrowing.
	 */
	sourceFields?: Record<string, string>;
	/** Exact originating connector instance, stored in additional_metadata. */
	connectorId?: string;
	/** Exact-match filter on each item's `metadata` (`filters.metadata`). */
	metadata?: MetadataFilter;
	/**
	 * Exact-match filter on each item's `additional_metadata`
	 * (`filters.additional_metadata`). `connectorId` is merged into it.
	 */
	additionalMetadata?: MetadataFilter;
	/** Return only these fields (plus id, database, collection). Knowledge rows only. */
	includeFields?: string[];
	/** Fold comment and reply rows under their parent row as `comments`. */
	groupThreads?: boolean;
}

/** A value an exact-match metadata filter compares a stored value against. */
export type MetadataFilterValue = string | number | boolean | null;

/** `{key: value}` pairs an item's stored metadata must all match exactly. */
export type MetadataFilter = Record<string, MetadataFilterValue>;

/** `filters` on POST /context/list, in wire spelling. */
interface ListFilters {
	source_fields?: Record<string, string>;
	metadata?: MetadataFilter;
	additional_metadata?: MetadataFilter;
}

/** The POST /context/list body the passthrough sends, in wire spelling. */
interface ListRequestBody extends ScopeFields {
	type?: QueryKind;
	ids?: string[];
	page?: number;
	page_size?: number;
	acl?: string[];
	filters?: ListFilters;
	include_fields?: string[];
	group_threads: boolean;
}

/** Whether a filter names at least one key; an empty one is no filter at all. */
export function hasEntries(filter: MetadataFilter | undefined): boolean {
	return filter != null && Object.keys(filter).length > 0;
}

export interface InspectParams {
	id: string;
	mode?: string;
	expirySeconds?: number;
	/**
	 * Principals to answer as (PRO-1684 document ACLs): an email, a
	 * `domain:<host>`, or a `group:<provider>:<id>`. Results are restricted to
	 * documents whose access list admits at least one of them.
	 *
	 * Omitted means NO ACL scoping — every document this key can reach. An empty
	 * array is treated the SAME as omitted by the API, so it is not a way to ask
	 * for "nobody" (design doc: absent and `[]` alike mean unrestricted).
	 *
	 * A principal the deployment does not know fails CLOSED: it matches only
	 * documents carrying no access list of their own, never a restricted one.
	 */
	acl?: string[];
	collection?: string;
	/** Per-call database override. */
	database?: string;
}

export interface IngestionStatusParams {
	ids: string | string[];
	collection?: string;
	/** Per-call database override. */
	database?: string;
}

/** One member of a connected subgraph (wire shape, unchanged from the API). */
export interface SubgraphMember {
	source_id: string;
	title?: string;
	app_kind?: string;
	app_provider?: string;
	app_external_id?: string;
	thread_id?: string;
	/** Hops from the seed; 0 is the seed itself. */
	depth: number;
	hydration?: string;
	discovered_via?: string;
	discovered_relation?: string;
}

/**
 * One edge of the subgraph. `source` and `target` are Source nodes, so their
 * `entity_id` is the member's item id; `relations[0].canonical_predicate` is
 * the edge type (`relates_to`, `same_thread`, `child_of`, ...).
 */
export interface SubgraphRelation {
	source?: { entity_id?: string; name?: string };
	target?: { entity_id?: string; name?: string };
	relations?: { canonical_predicate?: string }[];
}

export interface SubgraphResult {
	seed_source_id: string;
	sources: SubgraphMember[];
	relations: SubgraphRelation[];
	auxiliary_relations: unknown[];
	auxiliary_truncated: boolean;
	is_truncated: boolean;
	max_depth_reached: number;
	success: boolean;
	message: string;
}

export interface SubgraphParams {
	/** The item whose connected subgraph to return. */
	id: string;
	kind?: ContextKind;
	/** Max traversal depth in hops (server default 5). */
	depth?: number;
	/** Max members returned (server default 200). */
	maxSources?: number;
	/**
	 * Principals to answer as (PRO-1684 document ACLs): an email, a
	 * `domain:<host>`, or a `group:<provider>:<id>`. The subgraph contains
	 * only items those principals may see, filtered at every hop.
	 *
	 * Omitted means NO ACL scoping. An empty array is treated the SAME as
	 * omitted by the API, so it is not a way to ask for "nobody".
	 */
	acl?: string[];
	collection?: string;
	/** Per-call database override. */
	database?: string;
}

export interface RelationsParams {
	id?: string;
	kind?: ContextKind;
	limit?: number;
	cursor?: number;
	/**
	 * Principals to answer as (PRO-1684 document ACLs): an email, a
	 * `domain:<host>`, or a `group:<provider>:<id>`. Results are restricted to
	 * documents whose access list admits at least one of them.
	 *
	 * Omitted means NO ACL scoping — every document this key can reach. An empty
	 * array is treated the SAME as omitted by the API, so it is not a way to ask
	 * for "nobody" (design doc: absent and `[]` alike mean unrestricted).
	 *
	 * A principal the deployment does not know fails CLOSED: it matches only
	 * documents carrying no access list of their own, never a restricted one.
	 */
	acl?: string[];
	collection?: string;
	/** Per-call database override. */
	database?: string;
}

export interface DeleteParams {
	ids: string[];
	kind: ContextKind;
	collection?: string;
	/** Per-call database override. */
	database?: string;
}

export interface CreateDatabaseParams {
	database: string;
	/** Storage layout (PRO-1618). Omitted means `split`, the layout every existing database has. */
	type?: Layout;
	databaseMetadataSchema?: SDK.TenantsCustomPropertyDefinition[];
	embeddingsDimension?: number;
}

export interface DeleteCollectionParams {
	database: string;
	collection: string;
}

type ScopeFields = { database: string; collection?: string };

type MultiScopeFields = {
	database: string;
	collections: SDK.SearchQueryRequestCollections;
};

/**
 * A per-call `database` named one the connection is not allowed to touch.
 *
 * Written for the agent that reads it as a tool error: it names what IS
 * allowed and where the choice was made, so the agent can either use an
 * allowed database or tell the user to reconnect with wider access, rather
 * than retrying blindly.
 */
export class ScopeNotAllowedError extends Error {
	constructor(
		readonly kind: "database" | "collection",
		readonly requested: string,
		readonly allowed: readonly string[],
	) {
		super(
			`This connection is confined to ${kind} ${allowed.map((d) => `"${d}"`).join(", ")} ` +
				`and cannot use ${kind} "${requested}". The user chose this when approving the ` +
				`connection; to use another ${kind} they must reconnect and allow it.`,
		);
		this.name = "ScopeNotAllowedError";
	}
}

/** Kept for the name callers already import; the database case of the above. */
export const DatabaseNotAllowedError = ScopeNotAllowedError;

/** Throws unless `database` is one the connection may use. */
export function assertDatabaseAllowed(
	database: string,
	allowed: readonly string[] | undefined,
): void {
	if (allowed && !allowed.includes(database)) {
		throw new ScopeNotAllowedError("database", database, allowed);
	}
}

/**
 * Throws unless `collection` is one the connection may use.
 *
 * Separate from the database check because confinement has to cover both:
 * a caller pinned to one database can otherwise step sideways into a
 * collection the consent screen never showed, and `drop_collection` makes
 * that destructive.
 */
export function assertCollectionAllowed(
	collection: string,
	allowed: readonly string[] | undefined,
): void {
	if (allowed && !allowed.includes(collection)) {
		throw new ScopeNotAllowedError("collection", collection, allowed);
	}
}

/** The options the generated client itself passes to every response parser. */
type SdkParseOptions = NonNullable<
	Parameters<typeof serialization.SearchV2RetrievalResult.parseOrThrow>[1]
>;
const SDK_PARSE_OPTS: SdkParseOptions = {
	unrecognizedObjectKeys: "passthrough",
	allowUnrecognizedUnionMembers: true,
	allowUnrecognizedEnumValues: true,
	skipValidation: true,
	breadcrumbsPrefix: ["response"],
};

/** Drop undefined values so a hand-built wire body carries only what was said. */
function compact(record: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(record)) if (v !== undefined) out[k] = v;
	return out;
}

async function sdkResponseBody(response: Response): Promise<unknown> {
	const text = await response.text();
	try { return text === "" ? null : JSON.parse(text); }
	catch { return text; }
}

function normalizeQueryResult(result: QueryResult): QueryResult {
	if (isUnifiedQueryResult(result)) return result;
	const record = result as Record<string, unknown>;
	const bucket = record.additional_graph_context ?? (record.additionalGraphContext == null ? record.additional_context : undefined);
	const additionalContext = record.additional_graph_context == null && result.additionalGraphContext != null
		? result.additionalGraphContext
		: bucket != null && typeof bucket === "object" && !Array.isArray(bucket)
		? serialization.SearchV2RetrievalResult.parseOrThrow({ chunks: [], additional_context: bucket }, SDK_PARSE_OPTS).additionalContext ?? {}
		: result.additionalContext ?? {};
	return { ...result, additionalContext, additionalGraphContext: additionalContext };
}

/**
 * The unified ingest 202 (PRO-1618), read by hand into the SDK's camelCase
 * result so the tool layer reports it exactly as it reports a split one.
 *
 * Not the SDK serializer: that reads each result's id from a wire `id`, and
 * the unified response names it `source_id` (the item's context id, as the
 * contract says to read it). Run through the serializer, every unified ingest
 * would come back with no id, and the caller could neither inspect nor delete
 * what it had just written.
 */
function parseUnifiedIngestResponse(wire: unknown): SDK.IngestionV2IngestResponse {
	// A 202 whose body is not the documented shape is a protocol violation,
	// not a quiet zero — answering "0 success, 0 failed" for a body that
	// never said so tells the caller a write vanished that may have landed.
	const malformed = (why: string): HydraWrapperError =>
		new HydraWrapperError(
			`Hydra DB /context/ingest → ERR: malformed unified ingest response: ${why}`,
			"/context/ingest",
			{ body: wire },
		);
	if (wire == null || typeof wire !== "object" || Array.isArray(wire)) {
		throw malformed("expected an object");
	}
	const record = wire as Record<string, unknown>;
	const str = (v: unknown) => (typeof v === "string" ? v : undefined);
	const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
	if (!Array.isArray(record.results)) {
		throw malformed("results must be an array");
	}
	if (typeof record.success_count !== "number" || typeof record.failed_count !== "number") {
		throw malformed("success_count and failed_count must be numbers");
	}
	const rows = record.results as unknown[];
	for (const [i, raw] of rows.entries()) {
		if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
			throw malformed(`results[${i}] must be an object`);
		}
		// Every row carries its per-item verdict; one without a status cannot
		// be reported as either a success or a failure, so it is malformed.
		if (typeof (raw as Record<string, unknown>).status !== "string") {
			throw malformed(`results[${i}] must carry a string status`);
		}
	}
	return {
		success: bool(record.success),
		message: str(record.message),
		successCount: record.success_count as number,
		failedCount: record.failed_count as number,
		results: rows.map((raw) => {
			const row = raw as Record<string, unknown>;
			return {
				id: str(row.source_id) ?? str(row.id),
				title: str(row.title),
				status: str(row.status) as SDK.IngestionV2IngestResultItem["status"],
				infer: bool(row.infer),
				error: str(row.error),
				errorCode: str(row.error_code),
			};
		}),
	};
}

/** `?a=b&c=d` from a record, skipping undefined values. */
function queryString(record: Record<string, string | number | undefined>): string {
	const params = new URLSearchParams();
	for (const [k, v] of Object.entries(record)) if (v !== undefined) params.set(k, String(v));
	const encoded = params.toString();
	return encoded === "" ? "" : `?${encoded}`;
}

/**
 * A view of a shared promise that rejects as soon as THIS caller's signal
 * aborts, without cancelling the shared work for anyone else. Used for the
 * memoised layout probe: many tool calls can be waiting on one request, and a
 * host cancelling one of them must not keep it waiting, nor fail the rest.
 */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	const cancelled = () =>
		new HydraWrapperError("Hydra DB /databases → ERR: request cancelled by the caller", "/databases");
	if (signal.aborted) {
		// Take the rejection off `promise` before walking away from it.
		//
		// This waiter is gone, so nothing below ever attaches a handler — and
		// `promise` is the SHARED layout probe, which is allowed to fail. An
		// unrejected failure with no observer is an unhandled rejection, and
		// Node's default for those is to terminate the process. So one host
		// cancelling one tool call, against a database whose probe happens to
		// be failing, could take the whole MCP server down with it.
		//
		// Swallowing here loses nothing: every waiter that still cares gets the
		// same rejection through its own `promise.then` below, and `layout()`
		// turns it into the `split` default.
		void promise.catch(() => {});
		return Promise.reject(cancelled());
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(cancelled());
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(err) => {
				signal.removeEventListener("abort", onAbort);
				reject(err);
			},
		);
	});
}

abstract class Resource {
	/**
	 * A raw v2 call whose wire result is run through the SDK's OWN response
	 * serializer, so the caller gets the same camelCase object the SDK path
	 * returns. Used for `kind: "unified"` (PRO-1618): the pinned SDK's REQUEST
	 * serializers reject that enum value before anything is sent, so the
	 * request is built by hand, but nothing downstream has to know — and for
	 * `GET /databases`, whose `details[]` the pinned RESPONSE model does not
	 * declare.
	 */
	protected async rawTyped<T>(
		what: string,
		method: "GET" | "POST" | "DELETE",
		path: string,
		body: unknown,
		parse: (raw: unknown, opts?: SdkParseOptions) => T,
		signal?: AbortSignal,
		onMeta?: (meta: ResponseMeta) => void,
	): Promise<T> {
		if (!this.raw) {
			throw new Error(`${what} needs the v2 transport, which this HydraDB instance was built without`);
		}
		const wire = await sendRaw<unknown>(this.raw, path, method, body, { signal, onMeta });
		return parse(wire, SDK_PARSE_OPTS);
	}

	/**
	 * A raw v2 call whose unwrapped wire body is returned AS IS, for the
	 * unified endpoints (PRO-1618) whose response shape the pinned SDK has no
	 * serializer for. The caller decides what the body is by looking at it.
	 */
	protected async rawWire(
		what: string,
		method: "GET" | "POST" | "DELETE",
		path: string,
		body: unknown,
		signal?: AbortSignal,
		onMeta?: (meta: ResponseMeta) => void,
	): Promise<unknown> {
		if (!this.raw) {
			throw new Error(`${what} needs the v2 transport, which this HydraDB instance was built without`);
		}
		// `sendRaw` unwraps the envelope before this returns, so `call`'s own
		// onMeta channel would read meta off an object that no longer carries
		// it. The transport fires it instead, while the envelope is still whole.
		return sendRaw<unknown>(
			this.raw,
			path,
			method,
			body,
			{ signal, onMeta, safety: path === "/query" || path === "/context/list" || method === "GET" ? "idempotent" : "unsafe" },
		);
	}

	protected constructor(
		protected readonly sdk: HydraDBClient,
		private readonly database: string | undefined,
		private readonly collection?: string,
		private readonly allowedDatabases?: readonly string[],
		private readonly allowedCollections?: readonly string[],
		/**
		 * The hand-rolled HTTP path, for the endpoints the SDK does not expose
		 * (CONTRACT §2 rule 7). Optional only so tests that inject a fake SDK and
		 * never touch such an endpoint need not build one.
		 */
		protected readonly raw?: RawTransport,
	) {}

	protected scope(override?: string, dbOverride?: string): ScopeFields {
		const database = dbOverride?.trim() || this.database;
		if (!database) throw new Error(MISSING_DATABASE_MESSAGE);

		// Enforced HERE, on the one path every per-call scope takes, so no tool
		// can forget to check. The configured defaults are always allowed.
		if (database !== this.database) assertDatabaseAllowed(database, this.allowedDatabases);
		const collection = override?.trim() || this.collection;

		if (collection && collection !== this.collection) {
			assertCollectionAllowed(collection, this.allowedCollections);
		}

		return collection != null && collection !== ""
			? { database, collection }
			: { database };
	}

	/** Collection allowlist carried by an OAuth grant, when the grant is collection-confined. */
	protected defaultScopeDatabase(): string | undefined { return this.database; }

	protected collectionConfinement(): readonly string[] | undefined {
		return this.allowedCollections;
	}

	/**
	 * Scope for a query that names SEVERAL collections.
	 *
	 * Deliberately does NOT fall back to the configured default collection. The
	 * server folds the singular `collection` into the deprecated `sub_tenant_id`
	 * and refuses any request that carries it alongside a multi-scope selector,
	 * so injecting the default here would turn every `collections` call on a
	 * scoped connection into a 400. Naming the collections IS the scope.
	 *
	 * Confinement is enforced on the same path as `scope`: every named
	 * collection is checked, so a multi-scope selector cannot reach past what an
	 * OAuth connection was confined to.
	 */
	protected multiScope(
		collections: SDK.SearchQueryRequestCollections,
		dbOverride?: string,
	): MultiScopeFields {
		const database = dbOverride?.trim() || this.database;
		if (!database) throw new Error(MISSING_DATABASE_MESSAGE);

		if (database !== this.database) assertDatabaseAllowed(database, this.allowedDatabases);

		const names = Array.isArray(collections)
			? collections
			: Object.keys(collections);

		if (names.length === 0) {
			throw new Error(
				"collections was empty — pass at least one collection name, or omit " +
				"collections to search the connection's default scope.",
			);
		}

		for (const name of names) {
			if (name !== this.collection) {
				assertCollectionAllowed(name, this.allowedCollections);
			}
		}

		return { database, collections };
	}

	/** The whole-call budget, from the connection's transport settings. */
	private budget(): CallBudget {
		return {
			deadlineMs: this.raw?.timeoutMs ?? DEFAULT_TIMEOUT_SECONDS * 1000,
			maxRetries: this.raw?.maxRetries ?? DEFAULT_MAX_RETRIES,
		};
	}

	/**
	 * One SDK call under the shared retry policy (./retry). `fn` is one attempt
	 * and must hand the options it is given to the SDK: they carry the call's
	 * abort signal and turn the SDK's own retries off.
	 */
	protected async call<T, Response>(
		path: string,
		safety: RetrySafety,
		opts: RequestOptions | undefined,
		fn: (sdkOptions: SdkRequestOptions) => Promise<Response>,
	): Promise<T> {
		// The SDK and the raw transport share one token; tests without a raw
		// transport pass none, and an empty credential is never matched.
		const known = [this.raw?.token ?? ""];

		const raw = await withRetries({
			path,
			safety,
			budget: this.budget(),
			signal: opts?.signal,
			known,
			// A refused database is a decision the user made, not a transport
			// failure from `path`; it keeps its own type and message.
			rethrow: (err) => err instanceof ScopeNotAllowedError,
			attempt: (signal) => fn({ abortSignal: signal, maxRetries: 0 }),
		});

		opts?.onMeta?.(readResponseMeta(raw));

		const payload = unwrap<T>(raw);
		return path === "/query" && typeof payload !== "string" ? normalizeQueryResult(payload as QueryResult) as T : payload;
	}
}

export class ContextResource extends Resource {
	// The base constructor is `protected`, so this one is what makes the class
	// instantiable from outside the file. Removing it fails with TS2674.
	// biome-ignore lint/complexity/noUselessConstructor: widens visibility
	constructor(
		sdk: HydraDBClient,
		database: string | undefined,
		collection?: string,
		allowedDatabases?: readonly string[],
		allowedCollections?: readonly string[],
		raw?: RawTransport,
	) {
		super(sdk, database, collection, allowedDatabases, allowedCollections, raw);
	}

	/**
	 * The `/query` request for `params`, refusing combinations the API rejects.
	 *
	 * Throws synchronously; both callers are `async`, so it surfaces as a
	 * rejection, for the same reason `ingest` is async.
	 */
	private queryRequest(params: QueryParams): SDK.SearchQueryRequest {
		// `operator` is keyword syntax, and the API accepts it only when the
		// request also asks for keyword retrieval. On hybrid it does not ignore
		// the field, it refuses the whole call:
		//   Hydra DB /query → 400: INVALID_INPUT: operator is only valid with query_by=text
		// This wrapper forwarded `operator` and never sent `query_by`, so EVERY
		// call that set it 400'd — the parameter could not succeed under any
		// input. An operator therefore carries its retrieval method with it.
		//
		// A caller that states `queryBy` is never overridden: `hybrid` with an
		// operator is a contradiction only they can resolve, so it is rejected
		// here rather than sent to fail on the wire (the same stance the
		// knowledge-ingest path takes toward params it cannot honour).
		if (params.operator != null && params.queryBy === "hybrid") {
			throw new Error(
				`operator "${params.operator}" is only valid with queryBy "text" — ` +
				`hybrid retrieval rejects the request outright. Drop operator to keep ` +
				`hybrid retrieval, or pass queryBy "text" to match on the terms.`,
			);
		}

		const queryBy =
			params.queryBy ?? (params.operator != null ? "text" : undefined);

		// alpha weighs the vector lane against the keyword lane, and keyword
		// retrieval has only one. Sent there it is a hybrid-only knob on a request
		// that is not hybrid, so it is refused like operator on hybrid.
		if (params.alpha != null && queryBy === "text") {
			throw new Error(
				`alpha balances hybrid retrieval and does not apply to keyword ` +
				`retrieval (queryBy "text", or any operator). Drop alpha, or drop ` +
				`operator and queryBy "text" to search hybrid.`,
			);
		}

		// One scope selector per request. The server rejects a multi-scope
		// selector sent alongside the singular one it folds `collection` into, so
		// a caller that sets both has stated two different scopes and only they
		// can say which they meant — the same stance taken on operator/queryBy
		// above, rather than silently dropping one.
		if (params.collections != null && params.collection != null) {
			throw new Error(
				"pass either collection (one scope) or collections (several) — not " +
				"both. Hydra DB refuses a request carrying both selectors.",
			);
		}

		const scope =
			params.collections != null
				? this.multiScope(params.collections, params.database)
				: this.scope(params.collection, params.database);

		return {
			...scope,
			query: params.query,
			type: params.kind === "unified" ? undefined : params.kind,
			operator: params.operator,
			queryBy,
			maxResults: params.maxResults,
			mode: params.mode,
			graphContext: params.graphContext,
			alpha: params.alpha,
			recencyBias: params.recencyBias,
			queryApps: params.queryApps,
			ids: params.ids,
			// An empty list is no filter, not a filter that matches nothing.
			titles: params.titles != null && params.titles.length > 0 ? params.titles : undefined,
			metadataFilters: params.metadataFilters,
			numRelatedChunks: params.numRelatedChunks,
			acl: params.acl,
			additionalContext: params.additionalContext,
			queryForcefulRelations: params.queryForcefulRelations,
			temporalReasoning: params.temporalReasoning,
			responseFormat: params.responseFormat,
		};
	}

	/**
	 * The single retrieval entry point (SDK `client.query`).
	 *
	 * `async` so the operator/retrieval validation surfaces as a rejection,
	 * for the same reason `ingest` is async.
	 */
	async query(
		params: QueryParams,
		opts?: RequestOptions,
	): Promise<QueryResult> {
		const request = this.queryRequest(params);
		const queryExplicitRelations = params.queryExplicitRelations ?? params.followForcefulRelations ?? params.queryForcefulRelations;
		const additionalGraphContext = params.additionalGraphContext ?? params.additionalContext;
		if (params.kind === "unified") {
			const body = await this.rawWire("unified query", "POST", "/query", this.queryWire(request, params), opts?.signal, opts?.onMeta);
			if (isUnifiedQueryResult(body)) return toUnifiedQueryResult(body);
			if (carriesUnifiedMarkers(body)) throw malformedUnifiedResponse(body);
			validateQueryResponse(body);
			return normalizeQueryResult(serialization.SearchV2RetrievalResult.parseOrThrow(body, SDK_PARSE_OPTS));
		}
		return this.call("/query", "idempotent", opts, async (o) => {
			let response: unknown;
			if (queryExplicitRelations != null || additionalGraphContext != null) {
				const result = await this.sdk.fetch("/query", {
					method: "POST", headers: { "API-Version": "2", "Content-Type": "application/json" }, body: JSON.stringify(this.queryWire(request, params)),
				}, o);
				const body = await sdkResponseBody(result);
				if (!result.ok) throw new HydraDBError({ statusCode: result.status, body });
				const unified = unifiedFromV2Route(body);
				if (unified !== undefined) return unified;
				response = serialization.HandlerEnvelopeSearchV2RetrievalResult.parseOrThrow(body, SDK_PARSE_OPTS);
			} else response = await this.sdk.query(request, o);
			const unified = unifiedFromV2Route(response);
			if (unified !== undefined) return unified;
			validateQueryResponse(response);
			return response;
		});
	}

	private queryWire(request: SDK.SearchQueryRequest, params: QueryParams): Record<string, unknown> {
		const body = serialization.SearchQueryRequest.jsonOrThrow(request) as Record<string, unknown>;
		for (const key of Object.keys(body)) if (body[key] == null) delete body[key];
		if (params.kind === "unified") delete body.type;
		const explicitRelations = params.queryExplicitRelations ?? params.followForcefulRelations ?? params.queryForcefulRelations;
		const graphHint = params.additionalGraphContext ?? params.additionalContext;
		// The SDK request carries the legacy names; each setting goes out once,
		// under its new name.
		return compact({ ...body,
			query_forceful_relations: undefined, additional_context: undefined,
			query_explicit_relations: explicitRelations, additional_graph_context: graphHint });
	}

	/**
	 * The same retrieval with `response_format=markdown`: the API's own Markdown
	 * rendering of the results, as one string, instead of the result object.
	 */
	async queryMarkdown(
		params: Omit<QueryParams, "responseFormat">,
		opts?: RequestOptions,
	): Promise<string> {
		const request: SDK.SearchQueryRequest = { ...this.queryRequest(params), responseFormat: "markdown" };

		return this.call("/query", "idempotent", opts, async (o) => {
			let response: unknown;

			if (params.kind === "unified" || params.queryExplicitRelations != null || params.followForcefulRelations != null || params.queryForcefulRelations != null || params.additionalGraphContext != null || params.additionalContext != null) {
				const result = await this.sdk.fetch("/query", {
					method: "POST", headers: { "API-Version": "2", "Content-Type": "application/json" }, body: JSON.stringify(this.queryWire(request, params)),
				}, o);
				response = await sdkResponseBody(result);
				if (!result.ok) throw new HydraDBError({ statusCode: result.status, body: response });
			} else response = await this.sdk.query(request, o);

			// The SDK types `data` as the result object and passes the string
			// through unparsed. Anything else is not a successful Markdown answer.
			if (!markdownQueryResponse.safeParse(response).success) {
				throw new HydraDBError({ statusCode: 200, body: { error: {
					code: "INVALID_QUERY_RESPONSE",
					message: "Invalid successful query response: expected a Markdown string with response_format=markdown.",
				} } });
			}

			return response;
		});
	}

	/**
	 * Ingest a memory or knowledge item (SDK `context.ingest`, multipart).
	 *
	 * `async` so the knowledge-path validation below surfaces as a rejection.
	 * Every other failure in this wrapper rejects, and a caller that only handles
	 * `.catch()` would otherwise see this one escape as a synchronous throw.
	 */
	async ingest(
		params: IngestParams,
		opts?: RequestOptions,
	): Promise<SDK.IngestionV2IngestResponse> {
		if (params.items != null && params.acl !== undefined) throw new Error("acl must be specified per item, not beside items.");
		if (params.kind === "unified") return this.ingestUnified(params, opts);

		// The unified item's own fields (PRO-1618) have no home on either split
		// path: the memory item does not carry them and the knowledge path is a
		// bare document. Refused by name rather than dropped, for the same
		// reason the knowledge branch below refuses memory-only params: a
		// caller answered "success: 1" has been told the relations or the ACL
		// were stored when they were discarded.
		const unifiedOnly = [...new Set([params, ...(params.items ?? [])].flatMap((input) => (
			[["forcefulRelations", input.forcefulRelations]] as const
		).filter(([, value]) => value != null).map(([name]) => name)))];
		if (unifiedOnly.length > 0) {
			throw new Error(
				`${unifiedOnly.join(", ")} ${unifiedOnly.length === 1 ? "applies" : "apply"} to a ` +
				`unified database only (kind "unified"); this request names kind "${params.kind}". ` +
				`Drop ${unifiedOnly.length === 1 ? "it" : "them"}, or pass kind "unified".`,
			);
		}
		if (params.acl !== undefined || params.items?.some((item) => item.acl !== undefined)) {
			throw new Error("acl is not supported by legacy split memory, bare knowledge, or file ingestion. Use appKnowledge item ACLs or an explicitly selected unified context API.");
		}

		const request: SDK.IngestContextRequest = {
			...this.scope(params.collection, params.database),
			type: params.kind as SDK.IngestContextRequestType,
		};

		if (params.upsert != null) {
			request.upsert = String(params.upsert);
		}

		if (params.recordType != null && params.file == null) {
			throw new Error("recordType requires an uploaded file.");
		}

		const flatItemFields = [
			params.text,
			params.pairs,
			params.title,
			params.sourceId,
			params.userName,
			params.infer,
			params.isMarkdown,
			params.customInstructions,
			params.metadata,
			params.additionalMetadata,
			params.relations,
			params.evidenceKind,
			params.evidenceSubject,
			params.observationDate,
			params.filename,
			params.graph,
		];

		const hasFlatItemFields = flatItemFields.some((value) => value != null);

		if (params.appKnowledge != null) {
			if (params.kind !== "knowledge") {
				throw new Error("appKnowledge requires kind knowledge.");
			}

			if (params.appKnowledge.length === 0) {
				throw new Error("appKnowledge requires at least one item.");
			}

			if (params.items != null || params.file != null || hasFlatItemFields) {
				throw new Error("appKnowledge cannot be combined with documents, memories, or items.");
			}

			const appItems = params.appKnowledge.map((item) => {
				const fieldKind = item.fields.kind;

				if (fieldKind != null && fieldKind !== item.kind) {
					throw new Error(
						`appKnowledge fields.kind must equal kind ${item.kind}; received ${String(fieldKind)}.`,
					);
				}

				return {
					...item,
					id: item.id ?? "",
					fields: { ...item.fields, kind: item.kind },
				};
			});

			return this.call("/context/ingest", "unsafe", opts, async (o) => {
				const form = new FormData();
				for (const [key, value] of Object.entries({ database: request.database, collection: request.collection, type: request.type, upsert: request.upsert, app_knowledge: JSON.stringify(appItems) })) {
					if (value != null) form.set(key, value);
				}
				const response = await this.sdk.fetch("/context/ingest", { method: "POST", body: form }, o);
				const body = await sdkResponseBody(response);
				if (!response.ok) throw new HydraDBError({ statusCode: response.status, body });
				return serialization.HandlerEnvelopeIngestionV2IngestResponse.parseOrThrow(body, SDK_PARSE_OPTS);
			});
		}

		if (params.file != null) {
			if (params.kind !== "knowledge") {
				throw new Error("File ingestion requires kind knowledge.");
			}

			if (params.items != null || hasFlatItemFields) {
				throw new Error("File ingestion cannot be combined with text, turns, items, or other item fields.");
			}

			const { data, filename, contentType, id } = params.file;
			request.documents = [{ data, filename, contentType }];

			if (id != null) request.documentMetadata = JSON.stringify([{ id }]);

			// The pinned SDK does not send this preview field. Use the existing
			// authenticated transport until its generated request supports it.
			if (params.recordType != null) {
				if (this.raw == null) throw new Error("File ingestion with recordType requires HTTP transport.");

				const form = new FormData();
				form.set("database", request.database);
				form.set("type", "knowledge");
				form.set("documents", new Blob([Uint8Array.from(data)], { type: contentType }), filename);
				form.set("record_type", serializeRecordType(params.recordType));

				if (request.collection != null) form.set("collection", request.collection);

				if (request.upsert != null) form.set("upsert", request.upsert);

				if (request.documentMetadata != null) form.set("document_metadata", request.documentMetadata);

				const response = await sendRaw<unknown>(this.raw, "/context/ingest", "POST", form, opts);

				return serialization.IngestionV2IngestResponse.parseOrThrow(response, {
					unrecognizedObjectKeys: "passthrough",
				});
			}

			return this.call("/context/ingest", "unsafe", opts, (o) =>
				this.sdk.context.ingest(request, o),
			);
		}

		if (params.items != null && hasFlatItemFields) {
			throw new Error("Ingestion accepts items or flat item fields, not both.");
		}

		const items: IngestItem[] = params.items ?? [params];

		if (items.length === 0) throw new Error("Ingestion requires at least one item.");

		const graphPayload: Record<string, IngestGraph> = Object.create(null);

		if (params.kind === "memory") {
			const memories = items.map((input): MemoryWireItem => {
				const unsupported = (
					[
						["relations", input.relations],
						["evidenceKind", input.evidenceKind],
						["evidenceSubject", input.evidenceSubject],
					] as const
				).flatMap(([name, value]) => value == null ? [] : [name]);

				if (unsupported.length > 0) {
					throw new Error(
						`Memory ingestion does not support ${unsupported.join(", ")} — ` +
						"those apply to knowledge ingestion only. Pass kind \"knowledge\" instead, " +
						"or drop them.",
					);
				}

				const infer = input.infer ?? true;

				if (!infer && input.customInstructions != null) {
					throw new Error("customInstructions cannot be used when infer is false.");
				}

				const item: MemoryWireItem = {
					infer,
					is_markdown: input.isMarkdown ?? false,
				};

				if (input.pairs != null) item.user_assistant_pairs = input.pairs;

				if (input.text != null) item.text = input.text;

				if (input.customInstructions != null) item.custom_instructions = input.customInstructions;

				if (input.sourceId != null) item.source_id = input.sourceId;

				if (input.title != null) item.title = input.title;

				if (input.userName != null) item.user_name = input.userName;

				if (input.metadata != null) item.metadata = input.metadata;

				if (input.additionalMetadata != null) item.additional_metadata = input.additionalMetadata;

				if (input.observationDate != null) item.observation_date = input.observationDate;

				if (input.graph != null) {
					if (input.sourceId == null) throw new Error("A memory graph requires sourceId.");

					graphPayload[input.sourceId] = input.graph;
				}

				return item;
			});

			request.memories = JSON.stringify(memories);
		} else {
			const documentMetadataItems: Array<Record<string, JsonValue>> = [];

			request.documents = items.map((input) => {
				const unsupported = (
					[
						["pairs", input.pairs],
						["customInstructions", input.customInstructions],
						["userName", input.userName],
						["observationDate", input.observationDate],
					] as const
				).flatMap(([name, value]) => value == null ? [] : [name]);

				if (unsupported.length > 0) {
					throw new Error(
						`Knowledge ingestion does not support ${unsupported.join(", ")} — ` +
						`those apply to memory ingestion only. Pass kind "memory" instead, ` +
						`or drop them.`,
					);
				}

				if (input.text == null) throw new Error("A knowledge item requires text.");

				const title = input.title ?? "document";
				const filename = input.filename ?? (/\.md$/i.test(title) ? title : `${title}.md`);
				const metadataItem: Record<string, JsonValue> = {};

				if (input.sourceId != null) metadataItem.id = input.sourceId;

				if (input.title != null) metadataItem.title = input.title;

				if (input.metadata != null) metadataItem.metadata = input.metadata;

				if (input.additionalMetadata != null) {
					metadataItem.additional_metadata = input.additionalMetadata;
				}

				if (input.relations != null) metadataItem.relations = input.relations;

				if (input.infer != null) metadataItem.infer = input.infer;

				if (input.evidenceKind != null) metadataItem.evidence_kind = input.evidenceKind;

				if (input.evidenceSubject != null) metadataItem.evidence_subject = input.evidenceSubject;

				documentMetadataItems.push(metadataItem);

				if (input.graph != null) {
					if (input.sourceId == null) throw new Error("A knowledge graph requires sourceId.");

					graphPayload[input.sourceId] = input.graph;
				}

				return {
					data: Buffer.from(input.text, "utf-8"),
					filename,
					contentType: "text/markdown",
				};
			});
			request.documentMetadata = JSON.stringify(documentMetadataItems);
		}

		if (Object.keys(graphPayload).length > 0) {
			request.graphPayload = JSON.stringify(graphPayload);
		}

		// Not safe to send twice: without a source id a repeat stores a second
		// copy, and memory inference can extract a second set of facts.
		return this.call("/context/ingest", "unsafe", opts, (o) =>
			this.sdk.context.ingest(request, o),
		);
	}

	/** Merge metadata or replace the ACL of one existing context item. */
	async update(
		params: UpdateContextParams,
		opts?: RequestOptions,
	): Promise<SDK.GithubComHydradbHydradbApplicationInternalServiceMetadataEditResult> {
		const databaseMetadataPresent =
			params.databaseMetadata != null && Object.keys(params.databaseMetadata).length > 0;

		const additionalMetadataPresent =
			params.additionalMetadata != null && Object.keys(params.additionalMetadata).length > 0;

		if (!databaseMetadataPresent && !additionalMetadataPresent && params.acl === undefined) {
			throw new Error(
				"Nothing to update: pass database metadata, additional metadata, or a replacement ACL.",
			);
		}

		const scope = this.scope(params.collection, params.database);

		if (scope.collection == null) {
			throw new Error(
				"A collection is required to update context metadata. List collections, then pass one explicitly.",
			);
		}

		const request: SDK.HandlerContextMetadataUpdateRequest = {
			...scope,
			id: params.id,
		};

		if (databaseMetadataPresent) request.databaseMetadata = params.databaseMetadata;

		if (additionalMetadataPresent) request.additionalMetadata = params.additionalMetadata;

		if (params.acl !== undefined) request.acl = params.acl;

		return this.call("/context/{id}/metadata", "idempotent", opts, (o) =>
			this.sdk.context.updateSourceMetadata(request, o),
		);
	}

	/**
	 * The unified ingest body (PRO-1618, CONTRACT.md): one `context[]` array,
	 * each item text or a conversation, no corpus selector. Sent as the JSON
	 * body of `POST /context/ingest`. The wrapper's memory-item params map onto
	 * the item names the contract fixes: `sourceId` is `context_id`, `infer` is
	 * `enrich`, `customInstructions` is `instructions`, `metadata` is
	 * `attributes`, `additionalMetadata` is `custom_attributes`,
	 * `observationDate` is `happened_at`. The server accepts the old names as
	 * aliases; a client sends the documented ones.
	 */
	private ingestUnified(
		params: IngestParams,
		opts?: RequestOptions,
	): Promise<SDK.IngestionV2IngestResponse> {
		if (params.file != null || params.appKnowledge != null) throw new Error("Unified ingestion accepts text or conversation context, not file or appKnowledge payloads.");
		const inputs = params.items ?? [params];
		if (inputs.length === 0) throw new Error("Unified ingestion requires at least one item.");
		const context = inputs.map((input) => {
			for (const [name, value] of Object.entries({ graph: input.graph, relations: input.relations, evidenceKind: input.evidenceKind, evidenceSubject: input.evidenceSubject, filename: input.filename })) {
				if (value != null) throw new Error(`${name} is not supported by unified context ingestion; use its documented context fields.`);
			}
			if ((input.text != null) === (input.pairs != null)) throw new Error("Unified context requires exactly one of text or pairs.");

		const item: Record<string, unknown> = {};
		if (input.sourceId != null) item.context_id = input.sourceId;
		if (input.title != null) item.title = input.title;
		if (input.text != null) item.text = input.text;
		// A turn is exactly `{role, content}`: the server decodes the body
		// strictly and refuses any other key, a per-turn `name` included.
		if (input.pairs != null) {
			item.conversation = input.pairs.flatMap((turn) => [
				{ role: "user", content: turn.user },
				{ role: "assistant", content: turn.assistant },
			]);
		}
		// The speaker lives on the item, for both shapes: a text item is what
		// that person said, and a conversation's user turns are theirs.
		if (input.userName != null) item.user_name = input.userName;
		// `is_markdown` is not part of the unified item and would be refused by
		// the strict decoder, so it is accepted and not forwarded.
		item.enrich = input.infer ?? true;
		if (input.customInstructions != null) {
			item.instructions = input.customInstructions;
		}
		if (input.observationDate != null) item.happened_at = input.observationDate;
		if (input.metadata != null) item.attributes = input.metadata;
		if (input.additionalMetadata != null) item.custom_attributes = input.additionalMetadata;
		if (input.forcefulRelations != null) {
			item.forceful_relations = compact({
				context_ids: input.forcefulRelations.ids,
				properties: input.forcefulRelations.properties,
			});
		}
		if (input.acl !== undefined) item.acl = input.acl;
		if (params.items != null && input.upsert != null) item.upsert = input.upsert;
		return item;
		});
		const body = {
			...this.scope(params.collection, params.database),
			context,
			...(params.upsert != null ? { upsert: params.upsert } : {}),
		};
		return this.rawWire("unified ingest", "POST", "/context/ingest", body, opts?.signal, opts?.onMeta).then(parseUnifiedIngestResponse);
	}

	/** List memories or knowledge sources (SDK `context.list`). */
	list(
		params: ListParams = {},
		opts?: RequestOptions,
	): Promise<SDK.ListV2ListResponse> {
		if (params.kind === "unified") {
			const additionalMetadata = { ...params.additionalMetadata, ...(params.connectorId ? { connector_id: params.connectorId } : {}) };
			const filters = compact({ source_fields: params.sourceFields, metadata: params.metadata,
				additional_metadata: Object.keys(additionalMetadata).length ? additionalMetadata : undefined });
			return this.rawWire("unified list", "POST", "/context/list", compact({
				...this.scope(params.collection, params.database), ids: params.ids, page: params.page, page_size: params.pageSize,
				acl: params.acl, filters: Object.keys(filters).length ? filters : undefined,
				include_fields: params.includeFields, group_threads: params.groupThreads,
			}), opts?.signal, opts?.onMeta).then((data) => {
				validateListResponse({ success: true, data } as ListResponse, "unified");
				return serialization.ListV2ListResponse.parseOrThrow(data, SDK_PARSE_OPTS);
			});
		}
		const hasSourceFields =
			params.sourceFields != null &&
			Object.keys(params.sourceFields).length > 0;

		// Metadata filters, projected fields, nested threads and `all` keep the
		// raw call: the SDK renames row fields (`additional_metadata` comes back
		// as `additionalMetadata`), and a projection is looked up by the names
		// the caller asked for. Plain and source-field lists go through the SDK.
		const projected =
			hasEntries(params.metadata) ||
			hasEntries(params.additionalMetadata) ||
			params.kind === "all" ||
			(params.includeFields?.length ?? 0) > 0 ||
			params.groupThreads === true;

		if (projected) {
			const filters: ListFilters = {};

			if (params.sourceFields != null && hasSourceFields) {
				filters.source_fields = params.sourceFields;
			}

			if (hasEntries(params.metadata)) filters.metadata = params.metadata;

			const additionalMetadata = { ...params.additionalMetadata } satisfies MetadataFilter;

			if (params.connectorId != null) additionalMetadata.connector_id = params.connectorId;

			if (hasEntries(additionalMetadata)) filters.additional_metadata = additionalMetadata;

			const filtered = Object.keys(filters).length > 0;

			const request: ListRequestBody = {
				...this.scope(params.collection, params.database),
				type: params.kind,
				ids: params.ids,
				page: params.page,
				page_size: params.pageSize,
				acl: params.acl,
				group_threads: params.groupThreads ?? false,
			};

			if (filtered) request.filters = filters;

			if (params.includeFields != null && params.includeFields.length > 0) {
				request.include_fields = params.includeFields;
			}

			return this.call<SDK.ListV2ListResponse, unknown>(
				"/context/list",
				"idempotent",
				opts,
				async (o) => {
					const response = await this.sdk.fetch(
						"/context/list",
						{
							method: "POST",
							headers: {
								"API-Version": "2",
								"Content-Type": "application/json",
							},
							body: JSON.stringify(request),
						},
						o,
					);
					const text = await response.text();
					let body: unknown = text;
					try {
						body = text === "" ? null : JSON.parse(text);
					} catch {
						// Preserve a non-JSON proxy response for the shared formatter.
					}
					if (!response.ok) {
						throw new HydraDBError({ statusCode: response.status, body });
					}
					// Unlike the generated method, passthrough does not validate JSON.
					// Validate every list through the same contract so a proxy page or
					// documented degraded-memory response cannot become an empty list.
					// SAFETY: validateListResponse parses this raw HTTP body before use.

					validateListResponse(body as ListResponse, params.kind);

					return body;
				},
			);
		}

		const filtered = hasSourceFields || params.connectorId != null;

		return this.call<SDK.ListV2ListResponse, ListResponse>("/context/list", "idempotent", opts, async (o) => {
			const request: SDK.ListV2ListContentRequest = {
				...this.scope(params.collection, params.database),
				// `all` took the passthrough above; this narrows the type for the SDK.
				type: params.kind === "all" || params.kind === "unified" ? undefined : params.kind,
				ids: params.ids,
				page: params.page,
				pageSize: params.pageSize,
				acl: params.acl,
			};

			if (filtered) {
				const filters: SDK.ListContentFilter = {};

				// The tools build these with their wire names; the serializer maps
				// them to the SDK's, and rejects a key the API does not define.
				if (hasSourceFields) {
					filters.sourceFields = serialization.ListSourceFieldFilters.parseOrThrow(params.sourceFields);
				}

				if (params.connectorId != null) {
					filters.additionalMetadata = { connector_id: params.connectorId };
				}

				request.filters = filters;
				request.groupThreads = false;
			}

			const response = await this.sdk.context.list(request, o);

			// A false empty is wrong on every list path, not only lookups.
			validateListResponse(response, params.kind);

			return response;
		});
	}

	/** Fetch a source's content (SDK `context.inspect`; was "fetch content"). */
	inspect(
		params: InspectParams,
		opts?: RequestOptions,
	): Promise<SDK.FetchV2SourceFetchResponse> {
		return this.call("/context/inspect", "idempotent", opts, (o) =>
			this.sdk.context.inspect({
				...this.scope(params.collection, params.database),
				id: params.id,
				mode: params.mode,
				expirySeconds: params.expirySeconds,
				acl: params.acl,
			}, o),
		);
	}

	/** Per-source indexing progress (SDK `context.status`). */
	ingestionStatus(
		params: IngestionStatusParams,
		opts?: RequestOptions,
	): Promise<SDK.IngestionV2BatchProcessingStatus> {
		return this.call("/context/status", "idempotent", opts, async (o) => {
			const response = await this.sdk.context.status({
				...this.scope(params.collection, params.database),
				ids: params.ids,
			}, o);

			validateStatusResponse(response);

			return response;
		});
	}

	/**
	 * The connected subgraph of one item (`GET /context/{id}/subgraph`): every
	 * item reachable from it through item-level relations — explicit links, a
	 * shared thread, parent/child — plus the relations among the members and
	 * the structural graph around them.
	 *
	 * No SDK resource for this yet, so it takes the raw path (CONTRACT §2 rule
	 * 7): same header, same envelope unwrap, same error type as everything else
	 * here. When the SDK grows `context.subgraph`, only this method changes.
	 */
	async subgraph(params: SubgraphParams, opts?: RequestOptions): Promise<SubgraphResult> {
		// `async` for the same reason `query` and `ingest` are: the scope check
		// below throws, and a caller awaiting this must see a rejection, not a
		// synchronous exception from the call site.
		if (!this.raw) {
			throw new HydraWrapperError(
				"Hydra DB /context/{id}/subgraph → ERR: no HTTP transport configured",
				"/context/{id}/subgraph",
			);
		}

		// Blank is the one id the wrapper rejects locally: it would build
		// "/context//subgraph" and fail as a remote routing error instead of a
		// legible one. Everything else goes out byte for byte — ingest stores a
		// source_id verbatim, so trimming here could address a different item.
		if (params.id.trim() === "") {
			throw new HydraWrapperError(
				"Hydra DB /context/{id}/subgraph → ERR: id must not be empty",
				"/context/{id}/subgraph",
			);
		}

		const query = new URLSearchParams(this.scope(params.collection, params.database));

		// Never `type` on a unified database (PRO-1618): the corpus selector is
		// a split-database concept and the server accepts nothing but silence
		// or "unified" there.
		if (params.kind && params.kind !== "unified") query.set("type", params.kind);
		if (params.depth != null) query.set("depth", String(params.depth));

		if (params.maxSources != null) query.set("max_sources", String(params.maxSources));

		// Repeated params, like the dashboard and the CLI: the API reads both
		// repeated (acl=a&acl=b) and comma-separated forms. An empty array is
		// the same as omitted server-side, so sending nothing keeps the
		// request faithful to what the caller said.
		for (const principal of params.acl ?? []) query.append("acl", principal);
		const path = `/context/${encodeURIComponent(params.id)}/subgraph?${query.toString()}`;

		return sendRaw<SubgraphResult>(this.raw, path, "GET", undefined, opts);
	}

	/** Knowledge-graph relations (SDK `context.relations`). */
	relations(
		params: RelationsParams = {},
		opts?: RequestOptions,
	): Promise<SDK.GraphGraphRelationsResponse> {
		if (params.kind === "unified") {
			const query = new URLSearchParams(this.scope(params.collection, params.database));
			for (const [key, value] of Object.entries({ id: params.id, limit: params.limit, cursor: params.cursor })) {
				if (value != null) query.set(key, String(value));
			}
			for (const principal of params.acl ?? []) query.append("acl", principal);
			return this.rawWire("unified relations", "GET", `/context/relations?${query}`, undefined, opts?.signal, opts?.onMeta)
				.then((data) => serialization.GraphGraphRelationsResponse.parseOrThrow(data, SDK_PARSE_OPTS));
		}
		return this.call("/context/relations", "idempotent", opts, (o) =>
			this.sdk.context.relations({
				...this.scope(params.collection, params.database),
				id: params.id,
				type: params.kind as SDK.RelationsContextRequestType | undefined,
				limit: params.limit,
				cursor: params.cursor,
				acl: params.acl,
			}, o),
		);
	}

	/** Delete memories or knowledge sources (SDK `context.delete`). */
	delete(
		params: DeleteParams,
		opts?: RequestOptions,
	): Promise<SDK.SourcesMemoryDeleteResponse> {
		if (params.kind === "unified") {
			return this.rawWire("unified delete", "DELETE", "/context", {
				...this.scope(params.collection, params.database), ids: params.ids,
			}, opts?.signal, opts?.onMeta).then((data) => serialization.SourcesMemoryDeleteResponse.parseOrThrow(data, SDK_PARSE_OPTS));
		}
		return this.call("/context", "idempotent", opts, (o) =>
			this.sdk.context.delete({
				...this.scope(params.collection, params.database),
				ids: params.ids,
				type: params.kind as SDK.SourcesV2SourceDeleteRequestType,
			}, o),
		);
	}
}

/**
 * A database response with the fields the database tools report. The API
 * always sets them; the generated types mark them optional only because swag
 * never marks a response field required.
 */
type Reported<Response, Field extends keyof Response> = Response & Required<Pick<Response, Field>>;

const reportsDatabase = z.object({ database: z.string().min(1) });

const reportsStatus = reportsDatabase.extend({ status: z.string().min(1) });

const reportsFields = reportsDatabase.extend({ fields: z.array(z.unknown()) });

const reportsAddedFields = reportsDatabase.extend({ addedFields: z.array(z.string()) });

export class DatabasesResource extends Resource {
	// The base constructor is `protected`, so this one is what makes the class
	// instantiable from outside the file. Removing it fails with TS2674.
	// biome-ignore lint/complexity/noUselessConstructor: widens visibility
	constructor(
		sdk: HydraDBClient,
		database: string | undefined,
		collection?: string,
		allowedDatabases?: readonly string[],
		allowedCollections?: readonly string[],
		// The shared raw transport. `create` with a layout and the layout probe
		// both need it: the pinned SDK has neither `type` on create nor
		// `details[]` on the list (PRO-1618).
		raw?: RawTransport,
	) {
		super(sdk, database, collection, allowedDatabases, allowedCollections, raw);
	}

	async create(
		params: CreateDatabaseParams,
		opts?: RequestOptions,
	): Promise<Reported<SDK.TenantsTenantCreateAcceptedResponse, "database" | "status">> {
		const database = this.scope(undefined, params.database).database;
		const allowedCollections = this.collectionConfinement();

		if (allowedCollections) {
			throw new Error(
				`This connection is confined to collection ${allowedCollections
					.map((collection) => `"${collection}"`)
					.join(", ")}, and creating a database changes state outside those collections. ` +
					"Nothing was created. Reconnect without collection confinement before creating a database.",
			);
		}
		this.forgetLayouts();
		if (params.type != null) {
			return this.rawWire("database create with layout", "POST", "/databases", compact({
				database, type: params.type, database_metadata_schema: params.databaseMetadataSchema,
				embeddings_dimension: params.embeddingsDimension,
			}), opts?.signal, opts?.onMeta).then((data) => {
				if (!reportsStatus.safeParse(data).success) throw new Error("Invalid successful database response: expected database and status.");
				return serialization.TenantsTenantCreateAcceptedResponse.parseOrThrow(data, SDK_PARSE_OPTS) as Reported<SDK.TenantsTenantCreateAcceptedResponse, "database" | "status">;
			});
		}

		return this.reported("/databases", "unsafe", opts, reportsStatus, (o) =>
			this.sdk.databases.create({
				database,
				databaseMetadataSchema: params.databaseMetadataSchema,
				embeddingsDimension: params.embeddingsDimension,
			}, o),
		);
	}

	async delete(
		database: string,
		opts?: RequestOptions,
	): Promise<Reported<SDK.TenantsTenantDeleteResponse, "database" | "status">> {
		const scoped = this.scope(undefined, database).database;
		const connectionDefault = this.defaultScopeDatabase();

		if (scoped === connectionDefault) {
			throw new Error(
				`Refusing to delete database "${scoped}" because it is this connection's ` +
					"default database. Connect through a different default database, then retry the deletion.",
			);
		}

		const allowedCollections = this.collectionConfinement();

		if (allowedCollections) {
			throw new Error(
				`This connection is confined to collection ${allowedCollections
					.map((collection) => `"${collection}"`)
					.join(", ")}, and deleting database "${scoped}" removes every collection in it, ` +
					"including ones this connection was not granted. Nothing was deleted. " +
					"Reconnect without collection confinement before deleting a whole database.",
			);
		}

		this.forgetLayouts();
		return this.reported("/databases", "unsafe", opts, reportsStatus, (o) =>
			this.sdk.databases.delete({ database: scoped }, o),
		);
	}

	list(opts?: RequestOptions): Promise<DatabaseListing> {
		return this.call("/databases", "idempotent", opts, async (o) => {
			const response = await this.sdk.databases.list(o);

			validateDatabasesResponse(response);
			const listed = unwrap<DatabaseListing>(response);
			this.layoutCacheAt = Date.now();
			this.layoutCache = Promise.resolve(new Map((listed.details ?? []).flatMap((row) => row.database ? [[row.database, row.type === "unified" ? "unified" : "split"] as const] : [])));

			return response;
		});
	}

	private layoutCache?: Promise<Map<string, Layout>>;
	private layoutController?: AbortController;
	private layoutWaiters = 0;
	private layoutPending = false;

	/**
	 * Layouts learned outside the probe: a defaulted kind the server refused,
	 * which the caller's `unified` retry then satisfied. That answer is as
	 * authoritative as the probe's — the server just told us — and without
	 * recording it a process whose probe failed pays the refused request again
	 * on every defaulted call for the life of the process.
	 */
	private readonly learnedLayouts = new Map<string, { layout: Layout; at: number }>();

	/** When `layoutCache` was built; see LAYOUT_TTL_MS. */
	private layoutCacheAt = 0;

	/**
	 * Drop every cached layout, probed and learned. Called after this client
	 * creates or deletes a database: the name is the cache key, and a name can
	 * be deleted and created again under the other layout.
	 */
	forgetLayouts(): void {
		this.layoutCache = undefined;
		this.learnedLayouts.clear();
	}

	/** A learned layout still inside LAYOUT_TTL_MS, or undefined. */
	private learned(database: string): Layout | undefined {
		const entry = this.learnedLayouts.get(database);
		if (entry == null) return undefined;
		if (Date.now() - entry.at > LAYOUT_TTL_MS) {
			this.learnedLayouts.delete(database);

			return undefined;
		}

		return entry.layout;
	}

	/**
	 * Record a layout the probe did not supply. See `learnedLayouts`.
	 *
	 * Kept in its own map rather than written into `layoutCache`: that cache is
	 * a promise that clears itself on failure, so a write into it races the
	 * clear and can be discarded exactly when it is most needed.
	 */
	recordLayout(database: string, layout: Layout): void {
		this.learnedLayouts.set(database, { layout, at: Date.now() });
	}

	/**
	 * Every database this key can see, with its storage layout (PRO-1618), read
	 * from `GET /databases` `details[]`. Memoised for LAYOUT_TTL_MS: a layout is
	 * fixed for a database's life, but the cache is keyed by NAME, and a name
	 * can be deleted and created again under the other layout while this
	 * process runs (a stdio server lives as long as its host). The probe is what
	 * lets the tools pick `unified` as a default without a failed request.
	 */
	layouts(signal?: AbortSignal): Promise<Map<string, Layout>> {
		if (this.layoutCache && Date.now() - this.layoutCacheAt > LAYOUT_TTL_MS) this.forgetLayouts();

		let cache = this.layoutCache;

		if (!cache) {
			this.layoutController = new AbortController();
			this.layoutPending = true;
			this.layoutCacheAt = Date.now();
			// The shared probe deliberately takes NO caller signal: it is
			// bounded by the transport's own deadline, and it serves every
			// tool call that arrives while it is in flight. Binding it to the
			// first caller would let that caller's cancellation fail everyone
			// else's, and the others would then read the database as split.
			// Each caller's own cancellation is honoured below, per waiter.
			cache = this.rawTyped("database layout", "GET", "/databases", undefined,
				serialization.TenantsTenantIdsResponse.parseOrThrow, this.layoutController.signal).then((response) => {
				const listed = response as DatabaseListing;
				const map = new Map<string, Layout>();
				for (const row of listed.details ?? []) {
					if (row.database) map.set(row.database, row.type === "unified" ? "unified" : "split");
				}
				return map;
			}).catch((err) => {
				// A failed probe must not poison every later call: forget it so
				// the next tool call asks again.
				this.layoutCache = undefined;
				throw err;
			}).finally(() => { this.layoutPending = false; });
			this.layoutCache = cache;
		}
		// Merged at READ time, not when the probe resolved: a layout learned
		// after the cache was built still has to be visible here.
		const probed = cache.then((map) =>
			this.learnedLayouts.size === 0
				? map
				: new Map([...map, ...[...this.learnedLayouts.keys()].flatMap((db) => {
					const layout = this.learned(db);

					return layout ? [[db, layout] as const] : [];
				})]),
		);
		this.layoutWaiters++;
		return abortable(probed, signal).finally(() => {
			this.layoutWaiters--;
			if (this.layoutPending && this.layoutWaiters === 0 && signal?.aborted) this.layoutController?.abort(signal.reason);
		});
	}

	/**
	 * The layout of one database. A database the probe does not list (or a
	 * probe that fails) reads as `split`, which is what every database created
	 * before PRO-1618 is; the worst case is the old default, never a wrong
	 * unified call.
	 */
	async layout(database: string, signal?: AbortSignal): Promise<Layout> {
		// A learned layout answers before the probe is consulted at all, so a
		// process whose probe keeps failing still stops guessing after the
		// first refusal.
		const learned = this.learned(database);
		if (learned != null) return learned;
		try {
			return (await this.layouts(signal)).get(database) ?? "split";
		} catch (err) {
			// A cancelled probe is the caller's decision; propagate it so the
			// tool call ends now rather than running on with a guessed layout.
			if (signal?.aborted) throw err;
			return "split";
		}
	}

	/**
	 * The layout only when it is KNOWN: learned from a refusal, or listed by the
	 * probe. `undefined` when the probe failed or does not list the database —
	 * unlike `layout()`, which reads that as split so defaults stay safe. A
	 * caller that is about to refuse a request needs the difference: refusing
	 * `unified` on a guessed split layout would block a valid call.
	 */
	async knownLayout(database: string, signal?: AbortSignal): Promise<Layout | undefined> {
		const learned = this.learned(database);

		if (learned != null) return learned;

		try {
			return (await this.layouts(signal)).get(database);
		} catch (err) {
			if (signal?.aborted) throw err;

			return undefined;
		}
	}

	collections(
		database: string,
		opts?: RequestOptions,
	): Promise<SDK.TenantsSubTenantIdsResponse> {
		return this.call("/databases/collections", "idempotent", opts, (o) =>
			this.sdk.databases.collections({ database }, o),
		);
	}

	async stats(
		database: string,
		opts?: RequestOptions,
	): Promise<Reported<SDK.TenantsTenantStatsResponse, "database">> {
		const scoped = this.scope(undefined, database).database;

		return this.reported("/databases/stats", "idempotent", opts, reportsDatabase, (o) =>
			this.sdk.databases.stats({ database: scoped }, o),
		);
	}

	/** Infra provisioning readiness — renamed away from `status` (SDK `databases.status`). */
	async readiness(
		database: string,
		opts?: RequestOptions,
	): Promise<Reported<SDK.TenantsInfraStatusResponseV2, "database">> {
		const scoped = this.scope(undefined, database).database;

		return this.reported("/databases/status", "idempotent", opts, reportsDatabase, (o) =>
			this.sdk.databases.status({ database: scoped }, o),
		);
	}

	/** The metadata fields a database declares (SDK `databases.getMetadataSchema`). */
	async inspectMetadataSchema(
		database: string,
		opts?: RequestOptions,
	): Promise<Reported<SDK.TenantsTenantMetadataSchemaResponse, "database" | "fields">> {
		const scoped = this.scope(undefined, database).database;

		return this.reported("/databases/metadata-schema", "idempotent", opts, reportsFields, (o) =>
			this.sdk.databases.getMetadataSchema({ database: scoped }, o),
		);
	}

	async updateMetadataSchema(
		database: string,
		addFields: SDK.TenantsCustomPropertyDefinition[],
		opts?: RequestOptions,
	): Promise<Reported<SDK.HandlerMetadataSchemaUpdateResponse, "database" | "addedFields">> {
		const scoped = this.scope(undefined, database).database;
		const allowedCollections = this.collectionConfinement();

		if (allowedCollections) {
			throw new Error(
				`This connection is confined to collection ${allowedCollections
					.map((collection) => `"${collection}"`)
					.join(", ")}, and adding metadata fields changes the database-wide schema for ` +
					`"${scoped}", including collections this connection was not granted. Nothing was changed. ` +
					"Reconnect without collection confinement before changing a database metadata schema.",
			);
		}

		return this.reported("/databases/metadata-schema", "unsafe", opts, reportsAddedFields, (o) =>
			this.sdk.databases.updateMetadataSchema({ database: scoped, addFields }, o),
		);
	}

	/**
	 * `call`, refusing a successful response that lacks a field the database
	 * tools report, so no caller has to guess it.
	 */
	private reported<T, Response>(
		path: string,
		safety: RetrySafety,
		opts: RequestOptions | undefined,
		expected: z.AnyZodObject,
		fn: (sdkOptions: SdkRequestOptions) => Promise<Response>,
	): Promise<T> {
		return this.call(path, safety, opts, async (o) => {
			const response = await fn(o);

			if (!expected.safeParse(unwrap(response)).success) {
				throw new HydraDBError({ statusCode: 200, body: { error: {
					code: "INVALID_DATABASE_RESPONSE",
					message: `Invalid successful database response: expected ${Object.keys(expected.shape).join(" and ")}.`,
				} } });
			}

			return response;
		});
	}

	/**
	 * Permanently delete one collection and all of its data
	 * (SDK `databases.deleteCollection`).
	 */
	async deleteCollection(
		params: DeleteCollectionParams,
		opts?: RequestOptions,
	): Promise<SDK.TenantsSubTenantDeleteResponse> {
		// A caller who already cancelled is not waiting for the request to go
		// out: reject a pre-aborted signal rather than send and then unwind.
		if (opts?.signal?.aborted) {
			throw translateError(
				"/databases/collections",
				opts.signal.reason ?? new Error("aborted"),
				[this.raw?.token ?? ""],
			);
		}

		if (params.collection.trim() === "") {
			throw new HydraWrapperError(
				"Hydra DB /databases/collections → ERR: collection must not be empty",
				"/databases/collections",
			);
		}

		// scope() resolves the default database, enforces any confinement, and
		// returns the canonical `database`/`collection` names the API expects.
		const { database, collection } = this.scope(params.collection, params.database);

		// A repeat after the first succeeded answers "not found", which would
		// report a deletion that happened as one that failed.
		return this.call("/databases/collections", "unsafe", opts, (o) =>
			this.sdk.databases.deleteCollection(
				{ database, collection: collection ?? params.collection.trim() },
				o,
			),
		);
	}
}

/**
 * The canonical HydraDB client surface. Construct once per process from config;
 * pass an existing `HydraDBClient` as the second argument to inject a mocked
 * SDK transport (used by the conformance runner).
 */
const feedbackRatingSchema = z.enum(["positive", "negative", "neutral"]);

/** Ratings POST /feedback accepts. Absent is its own state: prose with no rating. */
export type FeedbackRating = z.infer<typeof feedbackRatingSchema>;

/**
 * Who authored the feedback. The server defaults this to "user"; this wrapper
 * sends "agent" instead, because everything reaching it came from a model. The
 * two populations are separated at write time — agent feedback is far more
 * voluminous and fails systematically rather than subjectively — so guessing
 * wrong here poisons the analysis it exists to feed.
 */
const feedbackSourceSchema = z.enum(["user", "agent"]);

export type FeedbackSource = z.infer<typeof feedbackSourceSchema>;

/** The server's cap, applied to the DE-DUPLICATED list (internal/domain/feedback). */
export const MAX_GROUND_TRUTH_SOURCE_IDS = 100;

const normalizedGroundTruthSchema = z.object({
	answer: z.string().optional(),
	source_ids: z.array(z.string()).optional(),
});

type NormalizedGroundTruth = z.infer<typeof normalizedGroundTruthSchema>;

const feedbackGroundTruthSchema = z
	.object({
		/** The answer a correct system would have produced. */
		answer: z.string().optional(),
		/** Source ids that actually contain the answer — a recall judgement. */
		sourceIds: z.array(z.string()).optional(),
	})
	.transform((groundTruth): NormalizedGroundTruth | undefined => {
		const answer = groundTruth.answer?.trim() ?? "";

		const sourceIds = Array.from(
			new Set(
				(groundTruth.sourceIds ?? [])
					.map((sourceId) => sourceId.trim())
					.filter((sourceId) => sourceId !== ""),
			),
		);

		if (answer === "" && sourceIds.length === 0) return undefined;

		return normalizedGroundTruthSchema.parse({
			answer: answer || undefined,
			source_ids: sourceIds.length > 0 ? sourceIds : undefined,
		});
	});

export type FeedbackGroundTruth = z.input<typeof feedbackGroundTruthSchema>;

const feedbackParamsSchema = z
	.object({
		requestId: z.string().trim().min(1, {
			message:
				"requestId is required: it is the request_id of the query this feedback is about, " +
				"returned in that query's response meta.",
		}),
		feedback: z.string().transform((feedback) => feedback.trim()).optional(),
		rating: feedbackRatingSchema.optional(),
		source: feedbackSourceSchema.optional(),
		groundTruth: feedbackGroundTruthSchema.optional(),
		database: z.string().optional(),
		collection: z.string().optional(),
		metadata: z.record(z.string()).optional(),
	})
	.superRefine((params, context) => {
		const sourceIds = params.groundTruth?.source_ids ?? [];

		// This limit intentionally runs after the ground-truth transform has
		// trimmed and de-duplicated IDs. A raw `.max(100)` would reject 150 inputs
		// that normalize to 80 distinct sources even though the API accepts them.
		if (sourceIds.length > MAX_GROUND_TRUTH_SOURCE_IDS) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["groundTruth", "sourceIds"],
				message:
					`ground_truth.source_ids has ${sourceIds.length} distinct ids, over the limit of ` +
					`${MAX_GROUND_TRUTH_SOURCE_IDS}. Narrow it to the sources that actually carry the answer.`,
			});
		}

		if ((params.feedback ?? "") === "" && params.groundTruth == null) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "send feedback text, ground_truth, or both — a submission with neither records nothing.",
			});
		}
	});

export type FeedbackParams = z.input<typeof feedbackParamsSchema>;

/**
 * The response exactly as POST /feedback returns it.
 *
 * snake_case because this endpoint takes the raw HTTP path: sendRaw unwraps the
 * envelope without renaming anything, so the keys here are the wire's keys. The
 * SDK would have camel-cased them, and this type was originally written for that
 * path — which made `feedback_id` read as undefined and quietly dropped the id
 * from the tool's output. `SubgraphResult` above declares the same way, for the
 * same reason.
 */
const feedbackResultSchema = z.object({
	recorded: z.boolean().optional(),
	feedback_id: z.string().optional(),
	request_id: z.string().optional(),
	message: z.string().optional(),
	created_at: z.string().optional(),
});

export type FeedbackResult = z.infer<typeof feedbackResultSchema>;

const feedbackRequestBodySchema = z.object({
	request_id: z.string(),
	feedback: z.string().optional(),
	rating: feedbackRatingSchema.optional(),
	source: feedbackSourceSchema,
	ground_truth: normalizedGroundTruthSchema.optional(),
	database: z.string().optional(),
	collection: z.string().optional(),
	metadata: z.record(z.string()).optional(),
});

/**
 * POST /feedback — a signal about a query that ALREADY ran.
 *
 * Correlated only by `request_id`; nothing about the original query is re-sent,
 * so nothing about it has to be trusted from the client. Recording feedback
 * never changes the result of the query it describes.
 */
export class FeedbackResource extends Resource {
	// The base constructor is `protected`, so this one is what makes the class
	// instantiable from outside the file. Removing it fails with TS2674.
	// biome-ignore lint/complexity/noUselessConstructor: widens visibility
	constructor(
		sdk: HydraDBClient,
		database: string | undefined,
		collection?: string,
		allowedDatabases?: readonly string[],
		allowedCollections?: readonly string[],
		raw?: RawTransport,
	) {
		super(sdk, database, collection, allowedDatabases, allowedCollections, raw);
	}

	async submit(params: FeedbackParams, opts?: RequestOptions): Promise<FeedbackResult> {
		const validated = feedbackParamsSchema.parse(params);

		// Scope is optional on /feedback, but a collection cannot be resolved
		// without its database (the server 400s on collection-alone), so this goes
		// through the same scope path every other call takes — which is also what
		// enforces an OAuth connection's confinement.
		const scope =
			validated.database != null || validated.collection != null
				? this.scope(validated.collection, validated.database)
				: {};

		// The SDK cannot express this request. Its generated model for
		// POST /feedback is an undiscriminated union of `{ feedback }` and
		// `{ groundTruth }` — the anyOf in the spec collapsed to the two
		// alternatives and lost every field they share — so its serializer
		// STRIPS request_id, and the server rejects the call it produces:
		//   Hydra DB /feedback -> 400: INVALID_INPUT: request_id is required
		// Verified against prod. So this takes the hand-rolled HTTP path, which
		// exists for exactly this (CONTRACT §2 rule 7), and sends the documented
		// snake_case body. Move back to the SDK once its model carries the whole
		// request.
		if (!this.raw) {
			throw new HydraWrapperError(
				"Hydra DB /feedback → ERR: no HTTP transport configured",
				"/feedback",
			);
		}

		const body = feedbackRequestBodySchema.parse({
			request_id: validated.requestId,
			feedback: validated.feedback || undefined,
			rating: validated.rating,
			source: validated.source ?? "agent",
			ground_truth: validated.groundTruth,
			metadata:
				validated.metadata != null && Object.keys(validated.metadata).length > 0
					? validated.metadata
					: undefined,
			...scope,
		});

		const result = await sendRaw<z.input<typeof feedbackResultSchema>>(
			this.raw,
			"/feedback",
			"POST",
			body,
			opts,
		);

		return feedbackResultSchema.parse(result);
	}
}

export class HydraDB {
	readonly context: ContextResource;
	/** Public connector lifecycle and resource operations. */
	readonly connectors: ConnectorsResource;
	readonly databases: DatabasesResource;
	/** Feedback about a query that already ran (POST /feedback). */
	readonly feedback: FeedbackResource;
	/** The default database every unscoped call uses. */
	readonly defaultDatabase?: string;
	get database(): string {
		if (!this.defaultDatabase) throw new Error(MISSING_DATABASE_MESSAGE);
		return this.defaultDatabase;
	}
	/** Databases a per-call override may name; undefined means any. */
	readonly allowedDatabases?: readonly string[];
	/** Collections a per-call override may name; undefined means any. */
	readonly allowedCollections?: readonly string[];
	/** The default collection every unscoped call uses. */
	readonly collection?: string;
	/**
	 * BYOG graph operations. Not backed by the SDK — see ./graph.ts for why —
	 * but exposed here so callers reach every HydraDB surface through one object.
	 */
	readonly graph: GraphResource;
	/** This connection's credential, kept only so `redact` can remove it. */
	private readonly token: string;
	/** Deadline for one whole tool call, every request and wait inside it. */
	readonly deadlineMs: number;

	constructor(config: HydraConfig, sdk?: HydraDBClient, rawOverride?: RawTransport) {
		const client =
			sdk ??
			new HydraDBClient({
				token: config.token,
				...(config.fetchFn ? { fetch: config.fetchFn } : {}),
				baseUrl: config.baseUrl ?? HydraDBEnvironment.Default,
				// The retry loop in ./retry owns retries and the deadline, so the
				// SDK makes exactly one attempt per call. Its own timer is set past
				// the deadline so that the loop's abort, which says which deadline
				// passed, always fires first.
				timeoutInSeconds: (config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) + 5,
				maxRetries: 0,
				// Never inherit the SDK's console logger: it writes to stdout, which
				// on stdio transport is the JSON-RPC channel. Only the sink is
				// overridden — level and silencing keep the SDK's own defaults.
				logging: { logger: STDERR_LOGGER },
				headers: mcpHeaders(config),
			});

		this.token = config.token;
		this.defaultDatabase = config.database?.trim() || undefined;
		this.collection = config.collection;
		this.allowedDatabases = config.allowedDatabases;
		this.allowedCollections = config.allowedCollections;

		const raw =
			rawOverride ??
			newRawTransport(config, {
				timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
				maxRetries: DEFAULT_MAX_RETRIES,
			});

		this.deadlineMs = raw.timeoutMs;

		this.context = new ContextResource(
			client,
			this.defaultDatabase,
			config.collection,
			config.allowedDatabases,
			config.allowedCollections,
			raw,
		);
		this.connectors = new ConnectorsResource(client);
		this.feedback = new FeedbackResource(
			client,
			this.defaultDatabase,
			config.collection,
			config.allowedDatabases,
			config.allowedCollections,
			raw,
		);
		this.databases = new DatabasesResource(
			client,
			this.defaultDatabase,
			config.collection,
			config.allowedDatabases,
			config.allowedCollections,
			raw,
		);

		const graphConfig: GraphConfig = {
			token: config.token,
			...(config.baseUrl != null ? { baseUrl: config.baseUrl } : {}),
			timeoutSeconds: config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
			maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
		};

		if (config.oauthUserId) graphConfig.oauthUserId = config.oauthUserId;

		this.graph = new GraphResource(graphConfig);
	}

	/**
	 * Remove credentials, including this connection's own key or token in any
	 * format, from text bound for the model.
	 */
	redact(text: string): string {
		return scrub(text, [this.token]);
	}
}
