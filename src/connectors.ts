/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-known-value-widening, anti-slop/no-conditional-empty-object-spread -- Connector results and provider JSON Schema are dynamic JSON, parsed and projected at this boundary. */
import type {
	ConnectorDiscoverParams,
	ConnectorListParams,
	ConnectorProviderCatalog,
	ConnectorProviderDetail,
	ConnectorResource,
	ConnectorStatus,
	ConnectorView,
	DiscoveredConnectorResources,
	HydraDB,
	RequestOptions,
} from "./hydra/index.js";

export interface ConnectorToolResponse {
	text: string;
	data: Record<string, unknown>;
}

export type ConnectorListInput = ConnectorListParams;

export type ConnectorDiscoverInput = ConnectorDiscoverParams;

/** A connector ID exists, but this OAuth grant cannot prove access to it. */
export class ConnectorScopeNotAllowedError extends Error {
	constructor() {
		super(
			"This connection is confined to specific databases or collections " +
				"and cannot access that connector because its destination is outside that scope or is not set. " +
				"Reconnect with wider database access to use it.",
		);
		this.name = "ConnectorScopeNotAllowedError";
	}
}

function connectorDatabase(connector: ConnectorView): string | undefined {
	const database = connector.database?.trim();

	return database ? database : undefined;
}

function connectorCollection(connector: ConnectorView): string | undefined {
	const collection = connector.collection?.trim();

	return collection ? collection : undefined;
}

function canAccessDatabase(database: string | undefined, allowed: readonly string[] | undefined): boolean {
	return allowed == null || (database != null && allowed.includes(database));
}

function canAccessCollection(collection: string | undefined, allowed: readonly string[] | undefined): boolean {
	return allowed == null || (collection != null && allowed.includes(collection));
}

function canAccessConnector(
	connector: ConnectorView,
	allowedDatabases: readonly string[] | undefined,
	allowedCollections: readonly string[] | undefined,
): boolean {
	return canAccessDatabase(connectorDatabase(connector), allowedDatabases)
		&& canAccessCollection(connectorCollection(connector), allowedCollections);
}

function assertConnectorAllowed(
	connector: ConnectorView,
	allowedDatabases: readonly string[] | undefined,
	allowedCollections: readonly string[] | undefined,
): void {
	if (!canAccessConnector(connector, allowedDatabases, allowedCollections)) {
		throw new ConnectorScopeNotAllowedError();
	}
}

function cleanObject(value: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function projectConnector(connector: ConnectorView): Record<string, unknown> {
	return cleanObject({
		connector_id: connector.connectorId,
		name: connector.name,
		provider: connector.provider,
		database: connector.database,
		collection: connector.collection,
		auth_type: connector.authType,
		provider_account_scope: connector.providerAccountScope,
		lifecycle: connector.lifecycle,
		sync_status: connector.syncStatus,
		paused: connector.paused,
		needs_reauth: connector.needsReauth,
		sync_blocked: connector.syncBlocked,
		active_resource_count: connector.activeResourceCount,
		resources_pending_first_sync: connector.resourcesPendingFirstSync,
		documents_dispatched: connector.documentsDispatched,
		first_data_dispatched_at: connector.firstDataDispatchedAt,
		last_attempted_sync_at: connector.lastAttemptedSyncAt,
		last_successful_sync_at: connector.lastSuccessfulSyncAt,
		next_sync_at: connector.nextSyncAt,
		sync_interval_seconds: connector.syncIntervalSeconds,
		custom_instructions: connector.customInstructions,
	});
}

const JSON_SCHEMA_KEYS = new Set([
	"$schema",
	"type",
	"title",
	"description",
	"properties",
	"required",
	"enum",
	"oneOf",
	"anyOf",
	"allOf",
	"items",
	"format",
	"pattern",
	"minLength",
	"maxLength",
	"minimum",
	"maximum",
	"minItems",
	"maxItems",
	"uniqueItems",
	"additionalProperties",
]);

/** Remove examples, defaults, constants, and provider extensions that can carry credential values. */
export function sanitizeCredentialSchema(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sanitizeCredentialSchema);

	if (value == null || typeof value !== "object") return value;

	const sanitized: Record<string, unknown> = {};

	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (!JSON_SCHEMA_KEYS.has(key)) continue;

		if (key === "properties" && entry != null && typeof entry === "object" && !Array.isArray(entry)) {
			sanitized[key] = Object.fromEntries(
				Object.entries(entry as Record<string, unknown>).map(([name, schema]) => [
					name,
					sanitizeCredentialSchema(schema),
				]),
			);
			continue;
		}

		sanitized[key] = sanitizeCredentialSchema(entry);
	}

	return sanitized;
}

function projectProviderCatalog(catalog: ConnectorProviderCatalog): Record<string, unknown>[] {
	return catalog.providers.map((provider) =>
		cleanObject({
			provider: provider.provider,
			category: provider.category,
			is_alpha: provider.isAlpha,
			is_beta: provider.isBeta,
			moveit_support: provider.moveitSupport,
			rank: provider.rank,
			supported: provider.supported,
			webhook_support: provider.webhookSupport,
			}),
	);
}

function projectProviderDetail(provider: ConnectorProviderDetail): Record<string, unknown> {
	return cleanObject({
		provider: provider.provider,
		connector_type: provider.connectorType,
		credential_schema: provider.credentialSchema
			? sanitizeCredentialSchema(provider.credentialSchema)
			: undefined,
		indexed_object_types: provider.indexedObjectTypes,
		setup_guide: provider.setupGuide,
		token_scopes: provider.tokenScopes,
		token_scopes_note: provider.tokenScopesNote,
	});
}

function projectDiscovered(result: DiscoveredConnectorResources): Record<string, unknown> {
	return cleanObject({
		provider: result.provider,
			resources: result.resources.map((resource) =>
				cleanObject({
					id: resource.id,
					name: resource.name,
					resource_type: resource.resourceType,
					metadata: resource.metadata,
				}),
			),
		has_more: result.hasMore,
		next_cursor: result.nextCursor,
	});
}

function effectiveDatabase(resource: ConnectorResource, connector: ConnectorView): string | undefined {
	return resource.databaseOverride?.trim() || connectorDatabase(connector);
}

function effectiveCollection(resource: ConnectorResource, connector: ConnectorView): string | undefined {
	return resource.collectionOverride?.trim() || connectorCollection(connector);
}

function canAccessResource(resource: ConnectorResource, connector: ConnectorView, hydra: HydraDB): boolean {
	return canAccessDatabase(effectiveDatabase(resource, connector), hydra.allowedDatabases)
		&& canAccessCollection(effectiveCollection(resource, connector), hydra.allowedCollections);
}

function projectResource(resource: ConnectorResource): Record<string, unknown> {
	return cleanObject({
		connector_id: resource.connectorId,
		resource_id: resource.resourceId,
		resource_type: resource.resourceType,
		display_name: resource.displayName,
		status: resource.status,
		database_override: resource.databaseOverride,
		collection_override: resource.collectionOverride,
		acl: resource.acl,
		custom_instructions: resource.customInstructions,
		filters: resource.filters,
		metadata: resource.metadata,
		additional_metadata: resource.additionalMetadata,
		sync_blocked: resource.syncBlocked,
		sync_blocked_at: resource.syncBlockedAt,
		has_acl_warning: resource.aclWarning != null,
		has_page_acl_warning: resource.pageAclWarning != null,
	});
}

function resourceStatusAction(retryable: boolean | undefined): string {
	if (retryable === true) return "HydraDB will retry this failure. Check the next sync result.";

	if (retryable === false) return "User action is required. Review the connector configuration or reconnect it.";

	return "Review the connector configuration and the next sync result.";
}

function resourceAction(resource: ConnectorStatus["resources"][number]): string | undefined {
	if (resource.syncBlocked) {
		return "Syncing stopped after repeated provider refusals. Review access to this resource.";
	}

	if (resource.httpStatus === 401 || resource.httpStatus === 403) {
		return "The provider refused access. Reconnect the connector or grant access to this resource.";
	}

	if (resource.httpStatus === 404) {
		return "The provider no longer exposes this resource. Remove it or restore it at the provider.";
	}

	if (resource.httpStatus === 429) {
		return "The provider rate-limited this sync. HydraDB can retry it.";
	}

	if (resource.httpStatus != null && resource.httpStatus >= 500) {
		return "The provider was unavailable. HydraDB can retry it.";
	}

	if (resource.status === "failed") return resourceStatusAction(resource.retryable);

	return undefined;
}

interface ConnectorFailureGuidance {
	kind: "credentials" | "destination" | "internal" | "transient" | "user_action" | "unknown";
	action: string;
}

function connectorFailureGuidance(
	error: NonNullable<ConnectorStatus["error"]>,
): ConnectorFailureGuidance {
	const code = error.code?.trim().toLowerCase();
	const failureClass = error.failureClass?.trim().toLowerCase();

	if (
		code === "credentials_rejected"
		|| code === "rejected_credentials"
		|| code === "authentication_failed"
		|| code === "reauth_required"
		|| failureClass === "credentials"
		|| failureClass === "authentication"
	) {
		return {
			kind: "credentials",
			action: "The provider rejected the connector credentials. Reconnect the connector.",
		};
	}

	if (
		code === "database_missing"
		|| code === "destination_database_missing"
		|| failureClass === "destination"
		|| failureClass === "database"
	) {
		return {
			kind: "destination",
			action: "The destination database is missing. Restore it, recreate it, or update the connector destination.",
		};
	}

	if (
		code === "sync_service_failed"
		|| code === "internal_failure"
		|| failureClass === "internal"
		|| failureClass === "terminal_internal"
	) {
		return {
			kind: "internal",
			action: error.retryable === true
				? "HydraDB will retry the internal sync failure. Contact HydraDB support if it continues."
				: "The HydraDB sync service failed. Contact HydraDB support; reconnecting will not fix this failure.",
		};
	}

	if (error.retryable === true || failureClass === "transient") {
		return {
			kind: "transient",
			action: "HydraDB will retry this failure. Check the next sync result.",
		};
	}

	if (error.retryable === false) {
		return {
			kind: "user_action",
			action: "User action is required. Review the connector configuration and destination.",
		};
	}

	return {
		kind: "unknown",
		action: "Review the connector configuration and the next sync result.",
	};
}

function projectStatus(status: ConnectorStatus): Record<string, unknown> {
	const failure = status.error ? connectorFailureGuidance(status.error) : undefined;

	return cleanObject({
		connector_id: status.connectorId,
		provider: status.provider,
		status: status.status,
		lifecycle: status.lifecycle,
		sync_status: status.syncStatus,
		last_attempted_sync_at: status.lastAttemptedSyncAt,
		last_successful_sync_at: status.lastSuccessfulSyncAt,
		next_sync_at: status.nextSyncAt,
		plan_cap: status.planCap
			? cleanObject({ meter: status.planCap.meter, plan: status.planCap.plan, message: status.planCap.message })
			: undefined,
		error: status.error
			? cleanObject({
				detected_at: status.error.detectedAt,
				retryable: status.error.retryable,
				kind: failure?.kind,
				action: failure?.action,
			})
			: undefined,
		resources: status.resources.map((resource) =>
			cleanObject({
				resource_id: resource.resourceId,
				display_name: resource.displayName,
				status: resource.status,
				last_row_count: resource.lastRowCount,
				retryable: resource.retryable,
				http_status: resource.httpStatus,
				checked_at: resource.checkedAt,
				sync_blocked: resource.syncBlocked,
					sync_blocked_at: resource.syncBlockedAt,
					action: resourceAction(resource),
					has_acl_warning: resource.aclWarning != null,
					has_page_acl_warning: resource.pageAclWarning != null,
				})),
		});
}

function renderStatus(data: Record<string, unknown>): string {
	const status = String(data.status ?? "unknown");
	const lifecycle = String(data.lifecycle ?? "unknown");
	const sync = String(data.sync_status ?? "unknown");
	const lines = [`Connector health is ${status}; lifecycle is ${lifecycle}; sync activity is ${sync}.`];

	lines.push(
		data.last_successful_sync_at
			? `Last successful sync: ${String(data.last_successful_sync_at)}.`
			: "No successful sync has been recorded.",
	);

	if (data.last_attempted_sync_at) {
		lines.push(`Latest attempted sync: ${String(data.last_attempted_sync_at)}.`);
	}

	if (data.plan_cap) lines.push("A plan limit is stopping connector syncs.");

	const error = data.error as Record<string, unknown> | undefined;

	if (error) {
		lines.push(`The connector has a failure. ${String(error.action)}`);

		if (error.retryable === true) lines.push("The failure may recover automatically.");

		if (error.retryable === false) lines.push("The failure will not recover without user action.");
	}

	for (const resource of (data.resources as Record<string, unknown>[] | undefined) ?? []) {
		const label = String(resource.display_name ?? resource.resource_id ?? "unnamed resource");
		lines.push(`Resource ${label}: ${String(resource.status ?? "unknown")}.`);

		if (resource.action) lines.push(String(resource.action));

		if (resource.has_acl_warning || resource.has_page_acl_warning) {
			lines.push(`Resource ${label} has a permission warning separate from sync health.`);
		}
	}

	return lines.join("\n");
}

/** MCP-facing connector operations, including database confinement and safe projection. */
export class ConnectorTools {
	constructor(private readonly hydra: HydraDB) {}

	private async authorizedConnector(id: string, opts?: RequestOptions): Promise<ConnectorView> {
		const connector = await this.hydra.connectors.get(id, opts);
		assertConnectorAllowed(connector, this.hydra.allowedDatabases, this.hydra.allowedCollections);

		return connector;
	}

	async providers(provider?: string, opts?: RequestOptions): Promise<ConnectorToolResponse> {
		const result = await this.hydra.connectors.listProviders(provider, opts);

		if ("providers" in result) {
			const providers = projectProviderCatalog(result);

			return {
				text: providers.length === 0
					? "No connector providers are available."
					: `Available connector providers: ${providers.map((entry) => String(entry.provider)).join(", ")}.`,
				data: { providers },
			};
		}

		const detail = projectProviderDetail(result);

		return {
			text: `Provider ${result.provider} uses connector type ${result.connectorType}. Credential fields are schema metadata only; never put credential values in an MCP call.`,
			data: detail,
		};
	}

	async list(input: ConnectorListInput, opts?: RequestOptions): Promise<ConnectorToolResponse> {
		const result = await this.hydra.connectors.list(input, opts);

		const visible = result.connectors.filter((connector) =>
			canAccessConnector(connector, this.hydra.allowedDatabases, this.hydra.allowedCollections),
		);

		const connectors = visible.map(projectConnector);
		const visibleIds = new Set(visible.map((connector) => connector.connectorId));

		const health = result.health
			? Object.fromEntries(Object.entries(result.health).filter(([id]) => visibleIds.has(id)))
			: undefined;

		const connectorLimit = result.connectorLimit
			? cleanObject({
				count: result.connectorLimit.count,
				limit: result.connectorLimit.limit,
				message: result.connectorLimit.message,
				plan: result.connectorLimit.plan,
			})
			: undefined;

		const planCap = result.planCap
			? cleanObject({
				meter: result.planCap.meter,
				message: result.planCap.message,
				plan: result.planCap.plan,
			})
			: undefined;

		return {
			text: connectors.length === 0
				? "No connectors are visible to this connection."
				: `Visible connectors (${connectors.length}): ${connectors.map((connector) => String(connector.name ?? connector.connector_id)).join(", ")}.`,
			data: cleanObject({ connectors, health, connector_limit: connectorLimit, plan_cap: planCap }),
		};
	}

	async get(id: string, opts?: RequestOptions): Promise<ConnectorToolResponse> {
		const connector = await this.authorizedConnector(id, opts);
		const data = { connector: projectConnector(connector) };

		return {
			text: `Connector ${String(data.connector.name ?? data.connector.connector_id)} is ${String(data.connector.lifecycle ?? "in an unknown lifecycle state")}.`,
			data,
		};
	}

	async status(id: string, opts?: RequestOptions): Promise<ConnectorToolResponse> {
		const connector = await this.authorizedConnector(id, opts);

		const [status, configured] = await Promise.all([
			this.hydra.connectors.status(id, opts),
			this.hydra.connectors.listResources(id, opts),
		]);

		const visibleResourceIds = new Set(
			configured.resources
				.filter((resource) => canAccessResource(resource, connector, this.hydra))
				.map((resource) => resource.resourceId),
		);

		const data = projectStatus({
			...status,
			resources: status.resources.filter((resource) =>
				resource.resourceId != null && visibleResourceIds.has(resource.resourceId),
			),
		});

		return { text: renderStatus(data), data };
	}

	async discover(input: ConnectorDiscoverInput, opts?: RequestOptions): Promise<ConnectorToolResponse> {
		await this.authorizedConnector(input.connectorId, opts);

		const data = projectDiscovered(
			await this.hydra.connectors.discover(input, opts),
		);

		const count = (data.resources as unknown[]).length;

		return { text: `Discovered ${count} resource${count === 1 ? "" : "s"}.`, data };
	}

	async resources(id: string, opts?: RequestOptions): Promise<ConnectorToolResponse> {
		const connector = await this.authorizedConnector(id, opts);
		const result = await this.hydra.connectors.listResources(id, opts);

		const resources = result.resources
			.filter((resource) => canAccessResource(resource, connector, this.hydra))
			.map(projectResource);

		return {
			text: resources.length === 0
				? "No configured resources are visible to this connection."
				: `Visible configured resources: ${resources.length}.`,
			data: { resources },
		};
	}
}
