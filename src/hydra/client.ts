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
import { HydraDBClient } from "@hydradb/sdk";
import type { HydraDB as SDK } from "@hydradb/sdk";

import { unwrap } from "./envelope.js";
import { newRawTransport, type RawTransport, sendRaw } from "./transport.js";
import { HydraWrapperError, translateError } from "./errors.js";
import { GraphResource } from "./graph.js";
import { serialization } from "@hydradb/sdk";

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

/**
 * Sized to fit inside a typical MCP host's tool timeout rather than outlast it,
 * so a stalled call fails with a HydraDB diagnostic the caller can act on
 * instead of a generic host-side timeout carrying no information.
 */
export const DEFAULT_TIMEOUT_SECONDS = 30;
export const DEFAULT_MAX_RETRIES = 2;

/**
 * Per-call transport controls, separate from the domain params.
 *
 * `signal` carries the host's cancellation into the SDK. Without it a cancelled
 * MCP tool call leaves the outbound HTTP request in flight: the caller has given
 * up, and the process keeps working and keeps retrying on its behalf.
 */
export interface RequestOptions {
	signal?: AbortSignal;
}

/**
 * Retrieval accepts a third corpus selector the write/list paths do not: `all`,
 * which searches memories and knowledge together. Only `context.query` takes it
 * — ingesting or deleting "all" is meaningless, so those stay `ContextKind`.
 */
export type QueryKind = ContextKind | "all";

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

/** Wrapper options → the SDK's per-request options, omitted when there is nothing to say. */
function req(opts?: RequestOptions): { abortSignal?: AbortSignal } | undefined {
	return opts?.signal ? { abortSignal: opts.signal } : undefined;
}

export interface HydraConfig {
	/** Bearer token (the HydraDB API key). */
	token: string;
	/** Database scope (canonical name for the tenant). */
	database: string;
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
	 * Per-attempt deadline. The SDK's own default is 60s, which combined with its
	 * 2 retries means a persistently failing endpoint can occupy a caller for
	 * ~3 minutes with no output — far longer than any MCP host waits, so in
	 * practice the host times out first and the caller gets a generic error with
	 * no HydraDB diagnostic while this process keeps retrying.
	 */
	timeoutSeconds?: number;
	/** Retries per call. The SDK defaults to 2; set explicitly so it is a choice. */
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
	alpha?: number;
	recencyBias?: number;
	/**
	 * Restrict retrieval to these source ids. A hard pre-filter: the server
	 * returns nothing rather than widening when none match.
	 */
	ids?: string[];
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

export interface IngestParams {
	kind: ContextKind;
	/** Free text to ingest (memory note or knowledge document body). */
	text?: string;
	/** Conversation turns to ingest as a memory. */
	pairs?: ConversationTurn[];
	title?: string;
	sourceId?: string;
	userName?: string;
	infer?: boolean;
	isMarkdown?: boolean;
	/** Passed through only when `infer` is truthy (host-owned default text). */
	customInstructions?: string;
	upsert?: boolean;
	/**
	 * Tenant metadata stored alongside the memory, and matchable later via
	 * `metadataFilters` on query.
	 *
	 * Accepted by the backend (`domain/memories/models.go`) but absent from the
	 * generated SDK request type, which is why the wrapper carries it explicitly
	 * inside the memory item rather than as a typed field.
	 */
	metadata?: Record<string, unknown>;
	/** Document-level metadata, matchable via `additional_metadata`. */
	additionalMetadata?: Record<string, unknown>;
	/** When the fact was true, as opposed to when it was stored (RFC3339 date). */
	observationDate?: string;
	/** Filename to attach when ingesting knowledge text as a document. */
	filename?: string;
	collection?: string;
	/** Per-call database override. */
	database?: string;
}

export interface ListParams {
	kind?: ContextKind;
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
	if (signal.aborted) return Promise.reject(cancelled());
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
	): Promise<T> {
		if (!this.raw) {
			throw new Error(`${what} needs the v2 transport, which this HydraDB instance was built without`);
		}
		const wire = await sendRaw<unknown>(this.raw, path, method, body, signal ? { signal } : undefined);
		return parse(wire, SDK_PARSE_OPTS);
	}

	protected constructor(
		protected readonly sdk: HydraDBClient,
		private readonly database: string,
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

	protected async call<T>(path: string, fn: () => Promise<unknown>): Promise<T> {
		try {
			return unwrap<T>(await fn());
		} catch (err) {
			// A refused database is a decision the user made, not a transport
			// failure from `path`; it keeps its own type and message.
			if (err instanceof ScopeNotAllowedError) throw err;
			throw translateError(path, err);
		}
	}
}

export class ContextResource extends Resource {
	// The base constructor is `protected`, so this one is what makes the class
	// instantiable from outside the file. Removing it fails with TS2674.
	// biome-ignore lint/complexity/noUselessConstructor: widens visibility
	constructor(
		sdk: HydraDBClient,
		database: string,
		collection?: string,
		allowedDatabases?: readonly string[],
		allowedCollections?: readonly string[],
		raw?: RawTransport,
	) {
		super(sdk, database, collection, allowedDatabases, allowedCollections, raw);
	}

	/**
	 * The single retrieval entry point (SDK `client.query`).
	 *
	 * `async` so the operator/retrieval validation below surfaces as a rejection,
	 * for the same reason `ingest` is async.
	 */
	async query(
		params: QueryParams,
		opts?: RequestOptions,
	): Promise<SDK.SearchV2RetrievalResult> {
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

		// `unified` is refused by the pinned SDK's request serializer before
		// anything is sent, so that kind is built by hand and its result parsed
		// with the SDK's own response serializer (PRO-1618).
		if (params.kind === "unified") {
			return this.call("/query", () =>
				this.rawTyped(
					"unified query",
					"POST",
					"/query",
					compact({
						...scope,
						query: params.query,
						type: "unified",
						operator: params.operator,
						query_by: queryBy,
						max_results: params.maxResults,
						mode: params.mode,
						graph_context: params.graphContext,
						alpha: params.alpha,
						recency_bias: params.recencyBias,
						query_apps: params.queryApps,
						ids: params.ids,
						metadata_filters: params.metadataFilters,
						num_related_chunks: params.numRelatedChunks,
						acl: params.acl,
					}),
					serialization.SearchV2RetrievalResult.parseOrThrow,
					opts?.signal,
				),
			);
		}

		return this.call("/query", () =>
			this.sdk.query({
				...scope,
				query: params.query,
				type: params.kind as SDK.SearchSourceType | undefined,
				operator: params.operator,
				queryBy,
				maxResults: params.maxResults,
				mode: params.mode,
				graphContext: params.graphContext,
				alpha: params.alpha,
				recencyBias: params.recencyBias,
				queryApps: params.queryApps,
				ids: params.ids,
				metadataFilters: params.metadataFilters,
				numRelatedChunks: params.numRelatedChunks,
				acl: params.acl,
			}, req(opts)),
		);
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
		if (params.kind === "unified") return this.ingestUnified(params, opts);
		const request: SDK.IngestContextRequest = {
			...this.scope(params.collection, params.database),
			type: params.kind as SDK.IngestContextRequestType,
		};
		if (params.upsert != null) {
			request.upsert = String(params.upsert);
		}

		if (params.kind === "memory") {
			const infer = params.infer ?? true;
			const item: Record<string, unknown> = {};
			if (params.pairs != null) item.user_assistant_pairs = params.pairs;
			if (params.text != null) item.text = params.text;
			item.infer = infer;
			item.is_markdown = params.isMarkdown ?? false;
			// Preserve the v1 omission behaviour: custom_instructions is only
			// attached when inference is enabled.
			if (infer && params.customInstructions != null) {
				item.custom_instructions = params.customInstructions;
			}
			if (params.sourceId != null) item.source_id = params.sourceId;
			if (params.title != null) item.title = params.title;
			if (params.userName != null) item.user_name = params.userName;
			if (params.metadata != null) item.metadata = params.metadata;
			if (params.additionalMetadata != null) {
				item.additional_metadata = params.additionalMetadata;
			}
			if (params.observationDate != null) {
				item.observation_date = params.observationDate;
			}
			request.memories = JSON.stringify([item]);
		} else {
			// The knowledge path can only carry the document itself and its
			// filename. Everything below belongs to the memory item shape and has
			// nowhere to go here — so reject rather than accept and discard. A
			// caller that sets `infer: true` on a knowledge write and is answered
			// "success: 1, failed: 0" has been told its instruction was honoured
			// when it was dropped on the floor.
			const unsupported = (
				[
					["pairs", params.pairs],
					["sourceId", params.sourceId],
					["infer", params.infer],
					["isMarkdown", params.isMarkdown],
					["customInstructions", params.customInstructions],
					["userName", params.userName],
					["metadata", params.metadata],
					["additionalMetadata", params.additionalMetadata],
					["observationDate", params.observationDate],
				] as const
			)
				.filter(([, value]) => value != null)
				.map(([name]) => name);

			if (unsupported.length > 0) {
				throw new Error(
					`Knowledge ingestion does not support ${unsupported.join(", ")} — ` +
					`those apply to memory ingestion only. Pass kind "memory" instead, ` +
					`or drop them.`,
				);
			}

			// Knowledge is multipart with the document as a file part — never the
			// `app_knowledge` JSON field (guards the DX-G-002 class of bug).
			if (params.text != null) {
				request.documents = {
					data: Buffer.from(params.text, "utf-8"),
					// The title rides on the filename; the server's
					// document_metadata does not accept a `title` key.
					filename: params.filename ?? `${params.title ?? "document"}.md`,
					contentType: "text/markdown",
				};
			}
		}

		return this.call("/context/ingest", () =>
			this.sdk.context.ingest(request, req(opts)),
		);
	}

	/**
	 * The unified ingest shape (PRO-1618): one `items[]` array, each item text or
	 * a conversation, no corpus selector. Sent as the JSON body of
	 * `POST /context/ingest`; the memory-item fields map onto the item names the
	 * redesign settled on. On a split database the items land in its memory
	 * corpus, so nothing changes for a caller that has not created a unified one.
	 */
	private ingestUnified(
		params: IngestParams,
		opts?: RequestOptions,
	): Promise<SDK.IngestionV2IngestResponse> {
		const item: Record<string, unknown> = {};
		if (params.text != null) item.text = params.text;
		if (params.pairs != null) {
			item.conversation = params.pairs.flatMap((turn) => [
				{ role: "user", content: turn.user, ...(params.userName ? { name: params.userName } : {}) },
				{ role: "assistant", content: turn.assistant },
			]);
		}
		// `is_markdown` is sent only when the caller said something. The server's
		// field is a plain bool, so omitting it and sending `false` are the same
		// thing, and every other field on this item is conditional too.
		if (params.isMarkdown != null) item.is_markdown = params.isMarkdown;
		// Speaker identity has TWO homes on a unified item and the server reads
		// the finer-grained one first: a conversation names its speaker per turn
		// (set above), and the item-level `user_name` fills in only when the
		// turns supplied none. So it goes on the item for a TEXT item only —
		// sending both would be redundant on the wire, and a client that let the
		// item-level value win would silently discard the per-turn identity that
		// speaker anchoring depends on.
		if (params.pairs == null && params.userName != null) item.user_name = params.userName;
		if (params.sourceId != null) item.context_id = params.sourceId;
		if (params.title != null) item.title = params.title;
		item.enrich = params.infer ?? true;
		if (item.enrich && params.customInstructions != null) {
			item.custom_instructions = params.customInstructions;
		}
		if (params.metadata != null) item.attributes = params.metadata;
		if (params.additionalMetadata != null) item.custom_attributes = params.additionalMetadata;
		if (params.observationDate != null) item.happened_at = params.observationDate;
		const body = {
			...this.scope(params.collection, params.database),
			items: [item],
			...(params.upsert != null ? { upsert: params.upsert } : {}),
		};
		return this.call("/context/ingest", () =>
			this.rawTyped(
				"unified ingest",
				"POST",
				"/context/ingest",
				body,
				serialization.IngestionV2IngestResponse.parseOrThrow,
				opts?.signal,
			),
		);
	}

	/** List memories or knowledge sources (SDK `context.list`). */
	list(
		params: ListParams = {},
		opts?: RequestOptions,
	): Promise<SDK.ListV2ListResponse> {
		// `unified` is refused by the pinned SDK's request serializer, so that
		// kind is built by hand and parsed with the SDK's own response
		// serializer (PRO-1618).
		if (params.kind === "unified") {
			return this.call("/context/list", () =>
				this.rawTyped(
					"unified list",
					"POST",
					"/context/list",
					compact({
						...this.scope(params.collection, params.database),
						type: "unified",
						ids: params.ids,
						page: params.page,
						page_size: params.pageSize,
						acl: params.acl,
					}),
					serialization.ListV2ListResponse.parseOrThrow,
					opts?.signal,
				),
			);
		}
		return this.call("/context/list", () =>
			this.sdk.context.list({
				...this.scope(params.collection, params.database),
				type: params.kind as SDK.ListV2ListContentRequestType | undefined,
				ids: params.ids,
				page: params.page,
				pageSize: params.pageSize,
				acl: params.acl,
			}, req(opts)),
		);
	}

	/** Fetch a source's content (SDK `context.inspect`; was "fetch content"). */
	inspect(
		params: InspectParams,
		opts?: RequestOptions,
	): Promise<SDK.FetchV2SourceFetchResponse> {
		return this.call("/context/inspect", () =>
			this.sdk.context.inspect({
				...this.scope(params.collection, params.database),
				id: params.id,
				mode: params.mode,
				expirySeconds: params.expirySeconds,
				acl: params.acl,
			}, req(opts)),
		);
	}

	/** Per-source indexing progress (SDK `context.status`). */
	ingestionStatus(
		params: IngestionStatusParams,
		opts?: RequestOptions,
	): Promise<SDK.IngestionV2BatchProcessingStatus> {
		return this.call("/context/status", () =>
			this.sdk.context.status({
				...this.scope(params.collection, params.database),
				ids: params.ids,
			}, req(opts)),
		);
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
		if (params.kind) query.set("type", params.kind);
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
	): Promise<SDK.GraphGraphRelationsResponse> {
		if (params.kind === "unified") {
			const scope = this.scope(params.collection, params.database);
			const query = new URLSearchParams();
			for (const [k, v] of Object.entries({
				database: scope.database,
				collection: scope.collection,
				id: params.id,
				type: "unified",
				limit: params.limit,
				cursor: params.cursor,
			}))
				if (v !== undefined) query.set(k, String(v));
			// Same repeated form the SDK path and `subgraph` send (PRO-1684):
			// a unified database enforces document ACLs like any other, so the
			// raw path has to carry the principals or "view as" silently
			// widens to everything on this layout.
			for (const principal of params.acl ?? []) query.append("acl", principal);
			return this.call("/context/relations", () =>
				this.rawTyped(
					"unified relations",
					"GET",
					`/context/relations?${query.toString()}`,
					undefined,
					serialization.GraphGraphRelationsResponse.parseOrThrow,
				),
			);
		}
		return this.call("/context/relations", () =>
			this.sdk.context.relations({
				...this.scope(params.collection, params.database),
				id: params.id,
				type: params.kind as SDK.RelationsContextRequestType | undefined,
				limit: params.limit,
				cursor: params.cursor,
				acl: params.acl,
			}),
		);
	}

	/** Delete memories or knowledge sources (SDK `context.delete`). */
	delete(
		params: DeleteParams,
		opts?: RequestOptions,
	): Promise<SDK.SourcesMemoryDeleteResponse> {
		if (params.kind === "unified") {
			return this.call("/context", () =>
				this.rawTyped(
					"unified delete",
					"DELETE",
					"/context",
					compact({
						...this.scope(params.collection, params.database),
						ids: params.ids,
						type: "unified",
					}),
					serialization.SourcesMemoryDeleteResponse.parseOrThrow,
					opts?.signal,
				),
			);
		}
		return this.call("/context", () =>
			this.sdk.context.delete({
				...this.scope(params.collection, params.database),
				ids: params.ids,
				type: params.kind as SDK.SourcesV2SourceDeleteRequestType,
			}, req(opts)),
		);
	}
}

export class DatabasesResource extends Resource {
	// The base constructor is `protected`, so this one is what makes the class
	// instantiable from outside the file. Removing it fails with TS2674.
	// biome-ignore lint/complexity/noUselessConstructor: widens visibility
	constructor(
		sdk: HydraDBClient,
		database: string,
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

	create(
		params: CreateDatabaseParams,
	): Promise<SDK.TenantsTenantCreateAcceptedResponse> {
		if (params.type != null) {
			// The pinned SDK's create request has no `type`; the generated
			// serializer would drop it and provision a split database in silence.
			return this.call("/databases", () =>
				this.rawTyped(
					"database create with a layout",
					"POST",
					"/databases",
					{
						database: params.database,
						type: params.type,
						...(params.databaseMetadataSchema != null
							? { database_metadata_schema: params.databaseMetadataSchema }
							: {}),
						...(params.embeddingsDimension != null
							? { embeddings_dimension: params.embeddingsDimension }
							: {}),
					},
					serialization.TenantsTenantCreateAcceptedResponse.parseOrThrow,
				),
			);
		}
		return this.call("/databases", () =>
			this.sdk.databases.create({
				database: params.database,
				databaseMetadataSchema: params.databaseMetadataSchema,
				embeddingsDimension: params.embeddingsDimension,
			}),
		);
	}

	delete(database: string): Promise<SDK.TenantsTenantDeleteResponse> {
		return this.call("/databases", () => this.sdk.databases.delete({ database }));
	}

	/**
	 * Every database this key can see (`GET /databases`), INCLUDING the
	 * `details[]` rows that carry each one's storage layout (PRO-1618).
	 *
	 * Hand-rolled rather than the SDK call, and it is the ONE reader of this
	 * endpoint: `layouts()` below goes through it rather than issuing a second,
	 * identical request, so listing databases and reading their layouts is one
	 * round trip instead of two. The wire result is still run through the SDK's
	 * own response serializer, so callers get the same camelCase object the SDK
	 * path returned (`tenantIds`), with `details[]` — a key the pinned model
	 * does not declare — passed through beside it.
	 *
	 * The raw path is not a downgrade here: `sendRaw` retries 429/5xx with
	 * bounded backoff, exactly as the SDK does, and translates failures into
	 * the same `HydraWrapperError`.
	 */
	list(signal?: AbortSignal): Promise<DatabaseListing> {
		return this.call("/databases", () =>
			this.rawTyped(
				"database list",
				"GET",
				"/databases",
				undefined,
				serialization.TenantsTenantIdsResponse.parseOrThrow,
				signal,
			),
		);
	}

	private layoutCache?: Promise<Map<string, Layout>>;

	/**
	 * Layouts learned outside the probe: a defaulted kind the server refused,
	 * which the caller's `unified` retry then satisfied. That answer is as
	 * authoritative as the probe's — the server just told us — and without
	 * recording it a process whose probe failed pays the refused request again
	 * on every defaulted call for the life of the process.
	 */
	private readonly learnedLayouts = new Map<string, Layout>();

	/**
	 * Record a layout the probe did not supply. See `learnedLayouts`.
	 *
	 * Kept in its own map rather than written into `layoutCache`: that cache is
	 * a promise that clears itself on failure, so a write into it races the
	 * clear and can be discarded exactly when it is most needed.
	 */
	recordLayout(database: string, layout: Layout): void {
		this.learnedLayouts.set(database, layout);
	}

	/**
	 * Every database this key can see, with its storage layout (PRO-1618), read
	 * from `GET /databases` `details[]`. Memoised for the life of the process:
	 * a layout is fixed at creation, so it cannot go stale, and the probe is
	 * what lets the tools pick `unified` as a default without a failed request.
	 */
	layouts(signal?: AbortSignal): Promise<Map<string, Layout>> {
		let cache = this.layoutCache;
		if (!cache) {
			// The shared probe deliberately takes NO caller signal: it is
			// bounded by the transport's own deadline, and it serves every
			// tool call that arrives while it is in flight. Binding it to the
			// first caller would let that caller's cancellation fail everyone
			// else's, and the others would then read the database as split.
			// Each caller's own cancellation is honoured below, per waiter.
			cache = this.list().then((listed) => {
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
			});
			this.layoutCache = cache;
		}
		// Merged at READ time, not when the probe resolved: a layout learned
		// after the cache was built still has to be visible here.
		const probed = cache.then((map) =>
			this.learnedLayouts.size === 0 ? map : new Map([...map, ...this.learnedLayouts]),
		);
		return abortable(probed, signal);
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
		const learned = this.learnedLayouts.get(database);
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

	collections(database: string): Promise<SDK.TenantsSubTenantIdsResponse> {
		return this.call("/databases/collections", () =>
			this.sdk.databases.collections({ database }),
		);
	}

	stats(database: string): Promise<SDK.TenantsTenantStatsResponse> {
		return this.call("/databases/stats", () =>
			this.sdk.databases.stats({ database }),
		);
	}

	/** Infra provisioning readiness — renamed away from `status` (SDK `databases.status`). */
	readiness(database: string): Promise<SDK.TenantsInfraStatusResponseV2> {
		return this.call("/databases/status", () =>
			this.sdk.databases.status({ database }),
		);
	}
}

/**
 * The canonical HydraDB client surface. Construct once per process from config;
 * pass an existing `HydraDBClient` as the second argument to inject a mocked
 * SDK transport (used by the conformance runner).
 */
export class HydraDB {
	readonly context: ContextResource;
	readonly databases: DatabasesResource;
	/** The default database every unscoped call uses. */
	readonly database: string;
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

	constructor(config: HydraConfig, sdk?: HydraDBClient) {
		const client =
			sdk ??
			new HydraDBClient({
				token: config.token,
				...(config.baseUrl != null ? { baseUrl: config.baseUrl } : {}),
				// Both are stated rather than inherited. The SDK's defaults (60s,
				// 2 retries) were never chosen by this server, and their product is
				// a ~3 minute worst case on the slowest tool it exposes.
				timeoutInSeconds: config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
				maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
				// Never inherit the SDK's console logger: it writes to stdout, which
				// on stdio transport is the JSON-RPC channel. Only the sink is
				// overridden — level and silencing keep the SDK's own defaults.
				logging: { logger: STDERR_LOGGER },
			});
		this.database = config.database;
		this.collection = config.collection;
		this.allowedDatabases = config.allowedDatabases;
		this.allowedCollections = config.allowedCollections;
		const raw = newRawTransport(config, {
			timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
			maxRetries: DEFAULT_MAX_RETRIES,
		});
		this.context = new ContextResource(
			client,
			config.database,
			config.collection,
			config.allowedDatabases,
			config.allowedCollections,
			raw,
		);
		this.databases = new DatabasesResource(
			client,
			config.database,
			config.collection,
			config.allowedDatabases,
			config.allowedCollections,
			raw,
		);
		this.graph = new GraphResource({
			token: config.token,
			...(config.baseUrl != null ? { baseUrl: config.baseUrl } : {}),
			timeoutSeconds: config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
			maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
		});
	}
}
