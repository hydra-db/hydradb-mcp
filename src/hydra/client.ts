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
import { createHash } from "node:crypto";
import { HydraDBClient } from "@hydradb/sdk";
import type { HydraDB as SDK } from "@hydradb/sdk";

import { unwrap } from "./envelope.js";
import { translateError } from "./errors.js";
import { GraphResource } from "./graph.js";

export type ContextKind = "memory" | "knowledge";

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
	/**
	 * Database scope (canonical name for the tenant).
	 *
	 * Optional: when absent, the default database is RESOLVED on first use from
	 * the account the token belongs to (see {@link resolveDefaultDatabase}). A
	 * caller that has exactly one database never has to name it; one with none
	 * gets `default` created; one with several is asked to choose.
	 */
	database?: string;
	/** Collection scope (canonical name for the sub-tenant). */
	collection?: string;
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
	/** Adjacent chunks pulled in alongside each match, for surrounding context. */
	numRelatedChunks?: number;
	/** Per-call collection override. */
	collection?: string;
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
	collection?: string;
	/** Per-call database override. */
	database?: string;
}

export interface InspectParams {
	id: string;
	mode?: string;
	expirySeconds?: number;
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

export interface RelationsParams {
	id?: string;
	kind?: ContextKind;
	limit?: number;
	cursor?: number;
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
	databaseMetadataSchema?: SDK.TenantsCustomPropertyDefinition[];
	embeddingsDimension?: number;
}

type ScopeFields = { database: string; collection?: string };

/** The name given to the database created for an account that has none. */
export const DEFAULT_DATABASE_NAME = "default";

/**
 * The account has more than one database and the caller named none.
 *
 * Guessing here would write one tenant's memories into another's, which is
 * strictly worse than one retry, so the choice is handed back with the options
 * spelled out. The message is written for the agent reading a tool error: it
 * says exactly what to pass.
 */
export class AmbiguousDatabaseError extends Error {
	constructor(readonly databases: string[]) {
		super(
			`This account has ${databases.length} databases and no default is configured: ` +
				`${databases.map((d) => `"${d}"`).join(", ")}. Pass \`database\` on the call ` +
				"(or put it in the connection URL / HYDRADB_DATABASE) to choose one.",
		);
		this.name = "AmbiguousDatabaseError";
	}
}

/**
 * How long to wait for a freshly created database to become ready before
 * handing its name back anyway. Provisioning is asynchronous on the server;
 * the first ingest into a database that is still provisioning fails with a
 * clear server-side message, so giving up here is safe, just slower.
 */
const CREATE_READY_TIMEOUT_MS = 30_000;
const CREATE_READY_POLL_MS = 2_000;

/**
 * Process-wide memo of resolved defaults, keyed by an opaque per-account key.
 *
 * The hosted HTTP server builds a fresh client per request, so without this a
 * caller that never names a database would pay a `databases.list()` round trip
 * on EVERY tool call. Only successes are cached: an ambiguous account keeps
 * being told to choose, and a transient failure is retried next call. Bounded
 * so a flood of distinct keys cannot grow it without limit.
 */
const DEFAULT_DATABASE_TTL_MS = 5 * 60_000;
const DEFAULT_DATABASE_CACHE_MAX = 1_000;
const defaultDatabaseCache = new Map<string, { database: string; expires: number }>();

/** Test-only: forget every memoised default database. */
export function __resetDefaultDatabaseCache(): void {
	defaultDatabaseCache.clear();
}

function cachedDefault(key: string | undefined): string | undefined {
	if (key == null) return undefined;
	const hit = defaultDatabaseCache.get(key);
	if (!hit) return undefined;
	if (hit.expires <= Date.now()) {
		defaultDatabaseCache.delete(key);
		return undefined;
	}
	return hit.database;
}

function rememberDefault(key: string | undefined, database: string): void {
	if (key == null) return;
	if (defaultDatabaseCache.size >= DEFAULT_DATABASE_CACHE_MAX) {
		// Map iterates in insertion order, so the first key is the oldest.
		const oldest = defaultDatabaseCache.keys().next().value;
		if (oldest != null) defaultDatabaseCache.delete(oldest);
	}
	defaultDatabaseCache.set(key, {
		database,
		expires: Date.now() + DEFAULT_DATABASE_TTL_MS,
	});
}

/**
 * Decide which database an unscoped call runs against.
 *
 *   - exactly one database → that one;
 *   - none → create {@link DEFAULT_DATABASE_NAME} and wait (bounded) for it;
 *   - several → {@link AmbiguousDatabaseError}, never a guess.
 *
 * Exported so the rule is testable on its own and reusable by anything else
 * that needs "the obvious database for this account" (the dashboard's connect
 * flow applies the same rule).
 */
export async function resolveDefaultDatabase(
	databases: DatabasesResource,
	cacheKey?: string,
	now: () => number = Date.now,
): Promise<string> {
	const cached = cachedDefault(cacheKey);
	if (cached != null) return cached;

	const listed = await databases.list();
	const names = (listed.databases ?? listed.tenantIds ?? [])
		.map((d) => d?.trim())
		.filter((d): d is string => !!d);

	let database: string;
	if (names.length === 1) {
		database = names[0];
	} else if (names.length === 0) {
		await databases.create({ database: DEFAULT_DATABASE_NAME });
		database = DEFAULT_DATABASE_NAME;
		const deadline = now() + CREATE_READY_TIMEOUT_MS;
		while (now() < deadline) {
			try {
				const status = await databases.readiness(database);
				if (status.infra?.readyForIngestion) break;
			} catch {
				// Still provisioning, or the status endpoint is briefly behind the
				// create. Either way the answer is "not yet"; keep waiting.
			}
			await new Promise((r) => setTimeout(r, CREATE_READY_POLL_MS));
		}
	} else {
		throw new AmbiguousDatabaseError(names);
	}

	rememberDefault(cacheKey, database);
	return database;
}

/**
 * The default database for one client: fixed when configured, otherwise
 * resolved once, lazily, on the first call that needs it.
 *
 * Lazy on purpose. Resolving at construction would put a network round trip
 * (and a possible failure) into server start-up, where an MCP host reports it
 * as "failed to connect" with no detail; resolving on first use surfaces the
 * same failure as a tool error the agent can read and act on.
 */
export class DefaultDatabase {
	private pending?: Promise<string>;
	private resolved?: string;

	constructor(
		private readonly fixed: string | undefined,
		private readonly resolver: () => Promise<string>,
	) {}

	/** The database if it is already known, without triggering resolution. */
	get known(): string | undefined {
		return this.fixed ?? this.resolved;
	}

	resolve(): Promise<string> {
		if (this.fixed != null) return Promise.resolve(this.fixed);
		if (this.resolved != null) return Promise.resolve(this.resolved);
		if (!this.pending) {
			this.pending = this.resolver().then(
				(database) => {
					this.resolved = database;
					return database;
				},
				(err) => {
					// A failed attempt must not poison every later call.
					this.pending = undefined;
					throw err;
				},
			);
		}
		return this.pending;
	}
}

abstract class Resource {
	protected constructor(
		protected readonly sdk: HydraDBClient,
		private readonly database: DefaultDatabase,
		private readonly collection?: string,
	) {}

	protected async scope(override?: string, dbOverride?: string): Promise<ScopeFields> {
		const database = dbOverride?.trim() || (await this.database.resolve());
		const collection = override?.trim() || this.collection;
		return collection != null && collection !== ""
			? { database, collection }
			: { database };
	}

	protected async call<T>(path: string, fn: () => Promise<unknown>): Promise<T> {
		try {
			return unwrap<T>(await fn());
		} catch (err) {
			// Scope resolution runs inside `fn` (it is awaited while building the
			// request), so its one deliberate failure would otherwise be dressed up
			// as a transport error from `path`. It is a decision for the caller,
			// not a failure of the call, and keeps its own type and message.
			if (err instanceof AmbiguousDatabaseError) throw err;
			throw translateError(path, err);
		}
	}
}

export class ContextResource extends Resource {
	// The base constructor is `protected`, so this one is what makes the class
	// instantiable from outside the file. Removing it fails with TS2674.
	// biome-ignore lint/complexity/noUselessConstructor: widens visibility
	constructor(sdk: HydraDBClient, database: DefaultDatabase, collection?: string) {
		super(sdk, database, collection);
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

		return this.call("/query", async () =>
			this.sdk.query({
				...(await this.scope(params.collection, params.database)),
				query: params.query,
				type: params.kind,
				operator: params.operator,
				queryBy,
				maxResults: params.maxResults,
				mode: params.mode,
				graphContext: params.graphContext,
				alpha: params.alpha,
				recencyBias: params.recencyBias,
				ids: params.ids,
				metadataFilters: params.metadataFilters,
				numRelatedChunks: params.numRelatedChunks,
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
	): Promise<SDK.IngestionV2SourceUploadResponse> {
		const request: SDK.IngestContextRequest = {
			...(await this.scope(params.collection, params.database)),
			type: params.kind,
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

	/** List memories or knowledge sources (SDK `context.list`). */
	async list(
		params: ListParams = {},
		opts?: RequestOptions,
	): Promise<SDK.ListV2SourceListResponse> {
		return this.call("/context/list", async () =>
			this.sdk.context.list({
				...(await this.scope(params.collection, params.database)),
				type: params.kind,
				ids: params.ids,
				page: params.page,
				pageSize: params.pageSize,
			}, req(opts)),
		);
	}

	/** Fetch a source's content (SDK `context.inspect`; was "fetch content"). */
	async inspect(
		params: InspectParams,
		opts?: RequestOptions,
	): Promise<SDK.FetchV2SourceFetchResponse> {
		return this.call("/context/inspect", async () =>
			this.sdk.context.inspect({
				...(await this.scope(params.collection, params.database)),
				id: params.id,
				mode: params.mode,
				expirySeconds: params.expirySeconds,
			}, req(opts)),
		);
	}

	/** Per-source indexing progress (SDK `context.status`). */
	async ingestionStatus(
		params: IngestionStatusParams,
		opts?: RequestOptions,
	): Promise<SDK.IngestionV2BatchProcessingStatus> {
		return this.call("/context/status", async () =>
			this.sdk.context.status({
				...(await this.scope(params.collection, params.database)),
				ids: params.ids,
			}, req(opts)),
		);
	}

	/** Knowledge-graph relations (SDK `context.relations`). */
	async relations(
		params: RelationsParams = {},
	): Promise<SDK.GraphGraphRelationsResponse> {
		return this.call("/context/relations", async () =>
			this.sdk.context.relations({
				...(await this.scope(params.collection, params.database)),
				id: params.id,
				type: params.kind,
				limit: params.limit,
				cursor: params.cursor,
			}),
		);
	}

	/** Delete memories or knowledge sources (SDK `context.delete`). */
	async delete(
		params: DeleteParams,
		opts?: RequestOptions,
	): Promise<SDK.SourcesMemoryDeleteResponse> {
		return this.call("/context", async () =>
			this.sdk.context.delete({
				...(await this.scope(params.collection, params.database)),
				ids: params.ids,
				type: params.kind,
			}, req(opts)),
		);
	}
}

export class DatabasesResource extends Resource {
	// The base constructor is `protected`, so this one is what makes the class
	// instantiable from outside the file. Removing it fails with TS2674.
	// biome-ignore lint/complexity/noUselessConstructor: widens visibility
	constructor(sdk: HydraDBClient, database: DefaultDatabase, collection?: string) {
		super(sdk, database, collection);
	}

	create(
		params: CreateDatabaseParams,
	): Promise<SDK.TenantsTenantCreateAcceptedResponse> {
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

	list(): Promise<SDK.TenantsTenantIdsResponse> {
		return this.call("/databases", () => this.sdk.databases.list());
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
	/**
	 * The database unscoped calls run against. Configured, or resolved on first
	 * use from the account (see {@link resolveDefaultDatabase}).
	 */
	readonly database: DefaultDatabase;
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
		const database = config.database?.trim() || undefined;
		// The memo key must not be the token itself: the cache is process-wide
		// and its keys show up in heap dumps. A hash is enough to tell accounts
		// apart and useless to anyone who reads it.
		const cacheKey =
			database == null
				? createHash("sha256")
						.update(`${config.baseUrl ?? ""}\n${config.token}`)
						.digest("hex")
				: undefined;
		this.database = new DefaultDatabase(database, () =>
			resolveDefaultDatabase(this.databases, cacheKey),
		);
		this.context = new ContextResource(client, this.database, config.collection);
		this.databases = new DatabasesResource(
			client,
			this.database,
			config.collection,
		);
		this.graph = new GraphResource({
			token: config.token,
			...(config.baseUrl != null ? { baseUrl: config.baseUrl } : {}),
			timeoutSeconds: config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
			maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
		});
	}
}
