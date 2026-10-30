/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-conditional-empty-object-spread -- Generated SDK payloads and validated connector metadata use dynamic JSON at this boundary; every response is parsed before it leaves the wrapper. */
import type { HydraDBClient } from "@hydradb/sdk";
import { z } from "zod";

import type { RequestOptions } from "./client.js";
import { unwrap } from "./envelope.js";
import { translateError } from "./errors.js";

const nonEmpty = z.string().trim().min(1);

const providerCatalogEntrySchema = z.object({
	provider: nonEmpty,
	category: z.string().optional(),
	isAlpha: z.boolean().optional(),
	isBeta: z.boolean().optional(),
	moveitSupport: z.boolean().optional(),
	rank: z.number().nullable().optional(),
	supported: z.boolean().optional(),
	webhookSupport: z.boolean().optional(),
});

const providerCatalogSchema = z.object({ providers: z.array(providerCatalogEntrySchema) });

const providerDetailSchema = z.object({
	provider: nonEmpty,
	connectorType: nonEmpty,
	credentialSchema: z.record(z.unknown()).optional(),
	filterableFields: z.array(z.unknown()),
	indexedObjectTypes: z.array(z.string()),
	searchableFields: z.array(z.unknown()),
	setupGuide: z.array(z.string()).optional(),
	tokenScopes: z.array(z.unknown()).optional(),
	tokenScopesNote: z.string().optional(),
});

const connectorSchema = z.object({
	activeResourceCount: z.number().optional(),
	authType: z.string().optional(),
	collection: z.string().optional(),
	connectorId: nonEmpty,
	customInstructions: z.string().optional(),
	database: z.string().optional(),
	documentsDispatched: z.number().optional(),
	firstDataDispatchedAt: z.string().optional(),
	lastAttemptedSyncAt: z.string().optional(),
	lastError: z.string().optional(),
	lastSuccessfulSyncAt: z.string().optional(),
	lifecycle: z.string().optional(),
	name: z.string().optional(),
	needsReauth: z.boolean().optional(),
	needsReauthAt: z.string().optional(),
	needsReauthReason: z.string().optional(),
	nextSyncAt: z.string().optional(),
	paused: z.boolean().optional(),
	pausedAt: z.string().optional(),
	provider: z.string().optional(),
	providerAccountScope: z.string().optional(),
	resourcesPendingFirstSync: z.number().optional(),
	status: z.string().optional(),
	syncBlocked: z.boolean().optional(),
	syncBlockedAt: z.string().optional(),
	syncBlockedReason: z.string().optional(),
	syncIntervalSeconds: z.number().optional(),
	syncStatus: z.string().optional(),
});

const planCapSchema = z.object({
	message: z.string().optional(),
	meter: z.string().optional(),
	plan: z.string().optional(),
});

const connectorListSchema = z.object({
	connectors: z.array(connectorSchema),
	health: z.record(z.string()).optional(),
	connectorLimit: z
		.object({
			count: z.number().optional(),
			limit: z.number().optional(),
			message: z.string().optional(),
			plan: z.string().optional(),
		})
		.optional(),
	planCap: planCapSchema.optional(),
});

const statusResourceSchema = z.object({
	aclWarning: z.string().optional(),
	aclWarningAt: z.string().optional(),
	action: z.string().optional(),
	backfillError: z.string().optional(),
	backfillErrorAt: z.string().optional(),
	checkedAt: z.string().optional(),
	displayName: z.string().optional(),
	httpStatus: z.number().optional(),
	lastRowCount: z.number().optional(),
	message: z.string().optional(),
	pageAclWarning: z.string().optional(),
	pageAclWarningAt: z.string().optional(),
	resourceId: z.string().optional(),
	retryable: z.boolean().optional(),
	status: z.string().optional(),
	syncBlocked: z.boolean().optional(),
	syncBlockedAt: z.string().optional(),
	syncBlockedReason: z.string().optional(),
});

const connectorStatusSchema = z.object({
	connectorId: nonEmpty,
	error: z
		.object({
			action: z.string().optional(),
			code: z.string().optional(),
			detectedAt: z.string().optional(),
			failureClass: z.string().optional(),
			message: z.string().optional(),
			retryable: z.boolean().optional(),
		})
		.nullable()
		.optional(),
	lastAttemptedSyncAt: z.string().optional(),
	lastSuccessfulSyncAt: z.string().optional(),
	lifecycle: z.string().optional(),
	nextSyncAt: z.string().optional(),
	planCap: planCapSchema.optional(),
	provider: z.string().optional(),
	resources: z.array(statusResourceSchema),
	status: z.string().optional(),
	syncStatus: z.string().optional(),
});

const discoveredResourceSchema = z.object({
	id: nonEmpty,
	metadata: z.record(z.unknown()).optional(),
	name: z.string(),
	resourceType: nonEmpty,
});

const discoverSchema = z.object({
	provider: nonEmpty,
	resources: z.array(discoveredResourceSchema),
	hasMore: z.boolean().optional(),
	nextCursor: z.string().optional(),
});

const configuredResourceSchema = z.object({
	acl: z.array(z.string()).optional(),
	aclWarning: z.string().optional(),
	aclWarningAt: z.string().optional(),
	additionalMetadata: z.record(z.unknown()).optional(),
	backfillError: z.string().optional(),
	backfillErrorAt: z.string().optional(),
	backfillOldest: z.string().optional(),
	collectionOverride: z.string().optional(),
	connectorId: z.string().optional(),
	customInstructions: z.string().optional(),
	databaseOverride: z.string().optional(),
	displayName: z.string().optional(),
	filters: z.record(z.unknown()).optional(),
	metadata: z.record(z.unknown()).optional(),
	pageAclWarning: z.string().optional(),
	pageAclWarningAt: z.string().optional(),
	providerCursor: z.string().optional(),
	resourceId: nonEmpty,
	resourceType: z.string().optional(),
	status: z.string().optional(),
	syncBlocked: z.boolean().optional(),
	syncBlockedAt: z.string().optional(),
	syncBlockedReason: z.string().optional(),
});

const resourcesSchema = z.object({ resources: z.array(configuredResourceSchema) });

const connectorUpdateSchema = z.object({
	connectorId: z.string().optional(),
	credentialsUpdated: z.boolean().optional(),
	customInstructionsUpdated: z.boolean().optional(),
	maxSyncIntervalSeconds: z.number().optional(),
	minSyncIntervalSeconds: z.number().optional(),
	nextSyncAt: z.string().optional(),
	syncIntervalSeconds: z.number().optional(),
});

const connectorDeleteSchema = z.object({
	connectorId: z.string().optional(),
	deleted: z.boolean().optional(),
});

const connectorSyncSchema = z.object({
	runId: z.string().optional(),
	workflowId: z.string().optional(),
});

const connectorPauseSchema = z.object({
	connectorId: z.string().optional(),
	paused: z.boolean().optional(),
	pausedAt: z.string().optional(),
});

const configureSchema = z.object({
	connectorId: z.string().optional(),
	configured: z.number().optional(),
	backfill: z.boolean().optional(),
	firstSyncAt: z.string().optional(),
	message: z.string().optional(),
	warnings: z.array(z.string()).optional(),
	unverified: z.array(z.string()).optional(),
	meta: z
		.object({
			deprecation: z
				.array(
					z.object({
						deprecated: z.boolean().optional(),
						deprecatedField: z.string().optional(),
						deprecatedSince: z.string().optional(),
						message: z.string().optional(),
						preferredField: z.string().optional(),
					}),
				)
				.optional(),
		})
		.optional(),
});

const resourceCreateSchema = configuredResourceSchema.partial().extend({
	unverified: z.array(z.string()).optional(),
	warnings: z.array(z.string()).optional(),
});

const resourceUpdateSchema = z.object({
	connectorId: z.string().optional(),
	resourceId: z.string().optional(),
	acl: z.array(z.string()).optional(),
	customInstructions: z.string().optional(),
	customInstructionsUpdated: z.boolean().optional(),
});

const resourceDeleteSchema = z.object({
	connectorId: z.string().optional(),
	resourceId: z.string().optional(),
	deleted: z.boolean().optional(),
});

export interface ConnectorUpdateRequest {
	connectorId: string;
	customInstructions?: string;
	syncIntervalSeconds?: number;
}

export interface ConnectorResourceMapping {
	resourceId: string;
	resourceType?: string;
	name?: string;
	acl?: string[];
	additionalMetadata?: Record<string, unknown>;
	collection?: string;
	customInstructions?: string;
	database?: string;
	metadata?: Record<string, unknown>;
	syncMode?: "rescan" | "new_only";
}

export interface ConnectorConfigureRequest {
	connectorId: string;
	resources: ConnectorResourceMapping[];
	fullVisibilityRoles?: string[];
	lookbackDays?: number;
	tableConfigs?: {
		changeHistory?: string;
		replicationKey?: string;
		table?: string;
	}[];
}

export interface ConnectorResourceCreateRequest {
	connectorId: string;
	resourceId: string;
	acl?: string[];
	additionalMetadata?: Record<string, unknown>;
	collectionOverride?: string;
	customInstructions?: string;
	databaseOverride?: string;
	displayName?: string;
	filters?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
	providerMetadata?: Record<string, unknown>;
	resourceType?: string;
}

export interface ConnectorResourceUpdateRequest {
	connectorId: string;
	resourceId: string;
	acl?: string[];
	customInstructions?: string;
}

export type ConnectorUpdateResponse = z.infer<typeof connectorUpdateSchema>;

export type ConnectorDeleteResponse = z.infer<typeof connectorDeleteSchema>;

export type ConnectorSyncResponse = z.infer<typeof connectorSyncSchema>;

export type ConnectorPauseResponse = z.infer<typeof connectorPauseSchema>;

export type ConnectorResumeResponse = z.infer<typeof connectorPauseSchema>;

export type ConnectorConfigureResponse = z.infer<typeof configureSchema>;

export type ConnectorResourceCreateResponse = z.infer<
	typeof resourceCreateSchema
>;

export type ConnectorResourceUpdateResponse = z.infer<
	typeof resourceUpdateSchema
>;

export type ConnectorResourceDeleteResponse = z.infer<
	typeof resourceDeleteSchema
>;

export type ConnectorProviderCatalog = z.infer<typeof providerCatalogSchema>;

export type ConnectorProviderDetail = z.infer<typeof providerDetailSchema>;

export type ConnectorView = z.infer<typeof connectorSchema>;

export type ConnectorList = z.infer<typeof connectorListSchema>;

export type ConnectorStatus = z.infer<typeof connectorStatusSchema>;

export type DiscoveredConnectorResources = z.infer<typeof discoverSchema>;

export type ConnectorResource = z.infer<typeof configuredResourceSchema>;

export type ConnectorResources = z.infer<typeof resourcesSchema>;

export interface ConnectorListParams {
	provider?: string;
	includeHealth?: boolean;
}

export interface ConnectorDiscoverParams {
	connectorId: string;
	cursor?: string;
	limit?: number;
}

function requestOptions(opts?: RequestOptions): { abortSignal?: AbortSignal } | undefined {
	return opts?.signal ? { abortSignal: opts.signal } : undefined;
}

function parse<Schema extends z.ZodTypeAny>(
	schema: Schema,
	label: string,
	value: unknown,
): z.output<Schema> {
	const parsed = schema.safeParse(unwrap<unknown>(value));

	if (!parsed.success) {
		throw new Error(`Invalid successful ${label} response: ${parsed.error.message}`);
	}

	return parsed.data;
}

/** Hand-owned wrapper for the public connector API. */
export class ConnectorsResource {
	constructor(private readonly sdk: HydraDBClient) {}

	private async call<Schema extends z.ZodTypeAny>(
		path: string,
		run: () => Promise<unknown>,
		schema: Schema,
		label: string,
	): Promise<z.output<Schema>> {
		try {
			return parse(schema, label, await run());
		} catch (error) {
			throw translateError(path, error);
		}
	}

	async listProviders(
		provider?: string,
		opts?: RequestOptions,
	): Promise<ConnectorProviderCatalog | ConnectorProviderDetail> {
		if (provider) {
			return this.call(
				"/connectors/providers",
				() => this.sdk.listProviders({ id: provider }, requestOptions(opts)),
				providerDetailSchema,
				"connector provider",
			);
		}

		return this.call(
			"/connectors/providers",
			() => this.sdk.listProviders({}, requestOptions(opts)),
			providerCatalogSchema,
			"connector provider list",
		);
	}

	async list(params: ConnectorListParams = {}, opts?: RequestOptions): Promise<ConnectorList> {
		return this.call(
			"/connectors",
			() =>
				this.sdk.connectors.list(
					{
						...(params.provider ? { provider: params.provider } : {}),
						...(params.includeHealth ? { include: "health" } : {}),
					},
					requestOptions(opts),
				),
			connectorListSchema,
			"connector list",
		);
	}

	async get(id: string, opts?: RequestOptions): Promise<ConnectorView> {
		return this.call(
			`/connectors/${encodeURIComponent(id)}`,
			() => this.sdk.connectors.get({ id }, requestOptions(opts)),
			connectorSchema,
			"connector get",
		);
	}

	async status(id: string, opts?: RequestOptions): Promise<ConnectorStatus> {
		return this.call(
			`/connectors/${encodeURIComponent(id)}/status`,
			() => this.sdk.connectors.status({ id }, requestOptions(opts)),
			connectorStatusSchema,
			"connector status",
		);
	}

	async discover(
		params: ConnectorDiscoverParams,
		opts?: RequestOptions,
	): Promise<DiscoveredConnectorResources> {
		return this.call(
			`/connectors/${encodeURIComponent(params.connectorId)}/discover`,
			() =>
				this.sdk.connectors.discover(
					{
						id: params.connectorId,
						...(params.cursor ? { cursor: params.cursor } : {}),
						...(params.limit != null ? { limit: params.limit } : {}),
					},
					requestOptions(opts),
				),
			discoverSchema,
			"connector discovery",
		);
	}

	async listResources(id: string, opts?: RequestOptions): Promise<ConnectorResources> {
		return this.call(
			`/connectors/${encodeURIComponent(id)}/resources`,
			() => this.sdk.connectors.listResources({ id }, requestOptions(opts)),
			resourcesSchema,
			"connector resources",
		);
	}
	async update(
		params: ConnectorUpdateRequest,
		opts?: RequestOptions,
	): Promise<ConnectorUpdateResponse> {
		const { connectorId, customInstructions, syncIntervalSeconds } = params;

		return this.call(
			`/connectors/${encodeURIComponent(connectorId)}`,
			() =>
				this.sdk.connectors.update(
					{
						id: connectorId,
						...(customInstructions !== undefined ? { customInstructions } : {}),
						...(syncIntervalSeconds !== undefined
							? { syncIntervalSeconds }
							: {}),
					},
					requestOptions(opts),
				),
			connectorUpdateSchema,
			"connector update",
		);
	}

	async delete(
		id: string,
		opts?: RequestOptions,
	): Promise<ConnectorDeleteResponse> {
		return this.call(
			`/connectors/${encodeURIComponent(id)}`,
			() => this.sdk.connectors.delete({ id }, requestOptions(opts)),
			connectorDeleteSchema,
			"connector delete",
		);
	}

	async sync(
		id: string,
		opts?: RequestOptions,
	): Promise<ConnectorSyncResponse> {
		return this.call(
			`/connectors/${encodeURIComponent(id)}/sync`,
			() => this.sdk.connectors.sync({ id }, requestOptions(opts)),
			connectorSyncSchema,
			"connector sync",
		);
	}

	async pause(
		id: string,
		opts?: RequestOptions,
	): Promise<ConnectorPauseResponse> {
		return this.call(
			`/connectors/${encodeURIComponent(id)}/pause`,
			() => this.sdk.connectors.pause({ id }, requestOptions(opts)),
			connectorPauseSchema,
			"connector pause",
		);
	}

	async resume(
		id: string,
		opts?: RequestOptions,
	): Promise<ConnectorPauseResponse> {
		return this.call(
			`/connectors/${encodeURIComponent(id)}/resume`,
			() => this.sdk.connectors.resume({ id }, requestOptions(opts)),
			connectorPauseSchema,
			"connector resume",
		);
	}

	async configure(
		params: ConnectorConfigureRequest,
		opts?: RequestOptions,
	): Promise<ConnectorConfigureResponse> {
		const { connectorId, ...body } = params;

		return this.call(
			`/connectors/${encodeURIComponent(connectorId)}/configure`,
			() =>
				this.sdk.connectors.configure(
					{ ...body, id: connectorId },
					requestOptions(opts),
				),
			configureSchema,
			"connector configure",
		);
	}

	async createResource(
		params: ConnectorResourceCreateRequest,
		opts?: RequestOptions,
	): Promise<ConnectorResourceCreateResponse> {
		const { connectorId, ...body } = params;

		return this.call(
			`/connectors/${encodeURIComponent(connectorId)}/resources`,
			() =>
				this.sdk.connectors.createResource(
					{ ...body, id: connectorId },
					requestOptions(opts),
				),
			resourceCreateSchema,
			"connector resource create",
		);
	}

	async updateResource(
		params: ConnectorResourceUpdateRequest,
		opts?: RequestOptions,
	): Promise<ConnectorResourceUpdateResponse> {
		const { connectorId, ...body } = params;

		return this.call(
			`/connectors/${encodeURIComponent(connectorId)}/resources/${encodeURIComponent(params.resourceId)}`,
			() =>
				this.sdk.connectors.updateResourceAcl(
					{ ...body, id: connectorId },
					requestOptions(opts),
				),
			resourceUpdateSchema,
			"connector resource update",
		);
	}

	async deleteResource(
		id: string,
		resourceId: string,
		opts?: RequestOptions,
	): Promise<ConnectorResourceDeleteResponse> {
		return this.call(
			`/connectors/${encodeURIComponent(id)}/resources/${encodeURIComponent(resourceId)}`,
			() =>
				this.sdk.connectors.deleteResource(
					{ id, resourceId },
					requestOptions(opts),
				),
			resourceDeleteSchema,
			"connector resource delete",
		);
	}
}
