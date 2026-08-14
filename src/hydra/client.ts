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
import { translateError } from "./errors.js";

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

function kindToType<K extends QueryKind>(kind: K | undefined): K | undefined {
	return kind;
}

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
	operator?: "or" | "and" | "phrase";
	maxResults?: number;
	mode?: "fast" | "thinking" | "auto";
	graphContext?: boolean;
	alpha?: number;
	recencyBias?: number;
	/** Per-call collection override. */
	collection?: string;
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
	/** Filename to attach when ingesting knowledge text as a document. */
	filename?: string;
	collection?: string;
}

export interface ListParams {
	kind?: ContextKind;
	ids?: string[];
	page?: number;
	pageSize?: number;
	collection?: string;
}

export interface InspectParams {
	id: string;
	mode?: string;
	expirySeconds?: number;
	collection?: string;
}

export interface IngestionStatusParams {
	ids: string | string[];
	collection?: string;
}

export interface RelationsParams {
	id?: string;
	kind?: ContextKind;
	limit?: number;
	cursor?: number;
	collection?: string;
}

export interface DeleteParams {
	ids: string[];
	kind: ContextKind;
	collection?: string;
}

export interface CreateDatabaseParams {
	database: string;
	databaseMetadataSchema?: SDK.TenantsCustomPropertyDefinition[];
	embeddingsDimension?: number;
}

type ScopeFields = { database: string; collection?: string };

abstract class Resource {
	protected constructor(
		protected readonly sdk: HydraDBClient,
		private readonly database: string,
		private readonly collection?: string,
	) {}

	protected scope(override?: string): ScopeFields {
		const collection = override ?? this.collection;
		return collection != null
			? { database: this.database, collection }
			: { database: this.database };
	}

	protected async call<T>(path: string, fn: () => Promise<unknown>): Promise<T> {
		try {
			return unwrap<T>(await fn());
		} catch (err) {
			throw translateError(path, err);
		}
	}
}

export class ContextResource extends Resource {
	constructor(sdk: HydraDBClient, database: string, collection?: string) {
		super(sdk, database, collection);
	}

	/** The single retrieval entry point (SDK `client.query`). */
	query(
		params: QueryParams,
		opts?: RequestOptions,
	): Promise<SDK.SearchV2RetrievalResult> {
		return this.call("/query", () =>
			this.sdk.query({
				...this.scope(params.collection),
				query: params.query,
				type: kindToType(params.kind),
				operator: params.operator,
				maxResults: params.maxResults,
				mode: params.mode,
				graphContext: params.graphContext,
				alpha: params.alpha,
				recencyBias: params.recencyBias,
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
			...this.scope(params.collection),
			type: kindToType(params.kind),
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
	list(
		params: ListParams = {},
		opts?: RequestOptions,
	): Promise<SDK.ListV2SourceListResponse> {
		return this.call("/context/list", () =>
			this.sdk.context.list({
				...this.scope(params.collection),
				type: kindToType(params.kind),
				ids: params.ids,
				page: params.page,
				pageSize: params.pageSize,
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
				...this.scope(params.collection),
				id: params.id,
				mode: params.mode,
				expirySeconds: params.expirySeconds,
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
				...this.scope(params.collection),
				ids: params.ids,
			}, req(opts)),
		);
	}

	/** Knowledge-graph relations (SDK `context.relations`). */
	relations(
		params: RelationsParams = {},
	): Promise<SDK.GraphGraphRelationsResponse> {
		return this.call("/context/relations", () =>
			this.sdk.context.relations({
				...this.scope(params.collection),
				id: params.id,
				type: kindToType(params.kind),
				limit: params.limit,
				cursor: params.cursor,
			}),
		);
	}

	/** Delete memories or knowledge sources (SDK `context.delete`). */
	delete(
		params: DeleteParams,
		opts?: RequestOptions,
	): Promise<SDK.SourcesMemoryDeleteResponse> {
		return this.call("/context", () =>
			this.sdk.context.delete({
				...this.scope(params.collection),
				ids: params.ids,
				type: kindToType(params.kind),
			}, req(opts)),
		);
	}
}

export class DatabasesResource extends Resource {
	constructor(sdk: HydraDBClient, database: string, collection?: string) {
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
			});
		this.context = new ContextResource(client, config.database, config.collection);
		this.databases = new DatabasesResource(
			client,
			config.database,
			config.collection,
		);
	}
}
