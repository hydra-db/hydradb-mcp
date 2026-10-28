/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions, anti-slop/no-known-value-widening, anti-slop/no-conditional-empty-object-spread -- Test doubles intentionally model dynamic MCP JSON and replace readonly resources. */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import type { HydraDBClient } from "@hydradb/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { HydraDB } from "../src/hydra/index.js";
import { createHydraDBServer } from "../src/server.js";
import { CONNECTOR_TOOL_NAMES, TOOL_NAMES } from "../src/tool-names.js";

type Call = { method: string; args: Record<string, unknown> };

function mockHydra(allowedDatabases?: string[], allowedCollections?: string[]) {
	const calls: Call[] = [];

	const connectors = [
		{ connectorId: "allowed", name: "Allowed", provider: "slack", database: "db-a", collection: "public" },
		{ connectorId: "blocked", name: "Blocked secret", provider: "github", database: "db-b", collection: "private" },
		{ connectorId: "org-wide", name: "Org wide", provider: "notion" },
	];

	const resources = [
		{ connectorId: "allowed", resourceId: "r-a", displayName: "A", databaseOverride: "db-a" },
		{ connectorId: "allowed", resourceId: "r-b", displayName: "B", databaseOverride: "db-b" },
		{ connectorId: "allowed", resourceId: "r-inherited", displayName: "Inherited" },
	];

	const record = <T>(method: string, value: T) => (args: Record<string, unknown> = {}) => {
		calls.push({ method, args });

		return Promise.resolve(value);
	};

	const status = {
		connectorId: "allowed",
		provider: "slack",
		status: "degraded",
		lifecycle: "active",
		syncStatus: "idle",
		lastAttemptedSyncAt: "2026-10-28T18:00:00Z",
		lastSuccessfulSyncAt: "2026-10-28T17:00:00Z",
		error: { message: "provider echoed top-secret-token", retryable: true },
		resources: [
			{ resourceId: "r-a", displayName: "A", status: "failed", retryable: true, message: "secret" },
			{ resourceId: "r-inherited", displayName: "Inherited", status: "ok", aclWarning: "private detail" },
		],
	};

	const connectorApi = {
		listProviders: record("providers", {
			providers: [{ provider: "slack", category: "Communication", supported: true }],
		}),
		list: record("list", {
			connectors,
			health: { allowed: "healthy", blocked: "failed", "org-wide": "checking" },
		}),
		get: async (id: string) => {
			calls.push({ method: "get", args: { id } });

			return connectors.find((connector) => connector.connectorId === id) ?? {};
		},
		status: record("status", status),
		discover: record("discover", {
			provider: "slack",
			resources: [{ id: "r-a", name: "general", resourceType: "channel", metadata: { topic: "safe" } }],
			hasMore: false,
		}),
		listResources: record("resources", { resources }),
		update: record("update", { connectorId: "allowed", customInstructionsUpdated: true }),
		delete: record("delete", { connectorId: "allowed", deleted: true }),
		sync: record("sync", { runId: "run-1", workflowId: "workflow-1" }),
		pause: record("pause", { connectorId: "allowed", paused: true }),
		resume: record("resume", { connectorId: "allowed", paused: false }),
		configure: record("configure", { connectorId: "allowed", configured: 1, backfill: false }),
		createResource: record("add-resource", {
			connectorId: "allowed",
			resourceId: "r-new",
			databaseOverride: "db-a",
			collectionOverride: "public",
		}),
		updateResource: record("update-resource", {
			connectorId: "allowed",
			resourceId: "r-a",
			customInstructionsUpdated: true,
		}),
		deleteResource: record("delete-resource", {
			connectorId: "allowed",
			resourceId: "r-a",
			deleted: true,
		}),
	};

	const sdk = { query: () => Promise.resolve({ success: true, chunks: [] }), context: {} } as unknown as HydraDBClient;

	const hydra = new HydraDB({
		token: "t",
		database: "db-a",
		...(allowedDatabases ? { allowedDatabases } : {}),
		...(allowedCollections ? { allowedCollections } : {}),
	}, sdk);

	(hydra as unknown as { connectors: unknown }).connectors = connectorApi;

	return { hydra, calls, connectorApi, connectors, resources, status };
}

async function connect(hydra: HydraDB) {
	const server = createHydraDBServer(hydra);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "connector-tests", version: "1" });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

	return client;
}

function structured(result: Awaited<ReturnType<Client["callTool"]>>) {
	return result.structuredContent as Record<string, unknown>;
}

function text(result: Awaited<ReturnType<Client["callTool"]>>) {
	return (result.content as { text: string }[]).map((part) => part.text).join("\n");
}

afterEach(() => {
	delete process.env.HYDRADB_MCP_CONNECTOR_TOOLS;
	delete process.env.HYDRADB_DASHBOARD_URL;
});

test("all six connector read tools are registered by default and explicitly read-only", async () => {
	const client = await connect(mockHydra().hydra);
	const { tools } = await client.listTools();

	for (const name of [
		"hydradb_connector_providers",
		"hydradb_connector_list",
		"hydradb_connector_get",
		"hydradb_connector_status",
		"hydradb_connector_discover",
		"hydradb_connector_resources",
	]) {
		const tool = tools.find((candidate) => candidate.name === name);
		assert.ok(tool, `${name} should be registered`);
		assert.deepEqual(tool.annotations, {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		});
	}

	await client.close();
});

test("all ten credential-free connector actions declare explicit write safety annotations", async () => {
	const client = await connect(mockHydra().hydra);
	const { tools } = await client.listTools();

	const additive = new Set([
		"hydradb_connector_create",
		"hydradb_connector_sync",
		"hydradb_connector_pause",
		"hydradb_connector_resume",
		"hydradb_connector_add_resource",
	]);

	const nonIdempotent = new Set([
		"hydradb_connector_sync",
		"hydradb_connector_configure",
		"hydradb_connector_add_resource",
	]);

	for (const name of [
		"hydradb_connector_create",
		"hydradb_connector_update",
		"hydradb_connector_delete",
		"hydradb_connector_sync",
		"hydradb_connector_pause",
		"hydradb_connector_resume",
		"hydradb_connector_configure",
		"hydradb_connector_add_resource",
		"hydradb_connector_update_resource",
		"hydradb_connector_delete_resource",
	]) {
		const tool = tools.find((candidate) => candidate.name === name);
		assert.ok(tool, `${name} should be registered`);
		assert.equal(tool.annotations?.readOnlyHint, false);
		assert.equal(tool.annotations?.destructiveHint, !additive.has(name));
		assert.equal(tool.annotations?.idempotentHint, !nonIdempotent.has(name));
		assert.equal(tool.annotations?.openWorldHint, true);
	}

	await client.close();
});

test("every connector write input field has client-visible help", async () => {
	const client = await connect(mockHydra().hydra);
	const { tools } = await client.listTools();

	const expectedFields: Record<string, string[]> = {
		hydradb_connector_create: ["provider"],
		hydradb_connector_update: ["connector_id", "custom_instructions", "reconnect", "sync_interval_seconds"],
		hydradb_connector_delete: ["connector_id"],
		hydradb_connector_sync: ["connector_id"],
		hydradb_connector_pause: ["connector_id"],
		hydradb_connector_resume: ["connector_id"],
		hydradb_connector_configure: [
			"connector_id",
			"full_visibility_roles",
			"lookback_days",
			"resources",
			"table_configs",
		],
		hydradb_connector_add_resource: [
			"acl",
			"additional_metadata",
			"collection_override",
			"connector_id",
			"custom_instructions",
			"database_override",
			"display_name",
			"filters",
			"metadata",
			"provider_metadata",
			"resource_id",
			"resource_type",
		],
		hydradb_connector_update_resource: ["acl", "connector_id", "custom_instructions", "resource_id"],
		hydradb_connector_delete_resource: ["connector_id", "resource_id"],
	};

	const expectedRequired: Record<string, string[]> = {
		hydradb_connector_create: ["provider"],
		hydradb_connector_update: ["connector_id"],
		hydradb_connector_delete: ["connector_id"],
		hydradb_connector_sync: ["connector_id"],
		hydradb_connector_pause: ["connector_id"],
		hydradb_connector_resume: ["connector_id"],
		hydradb_connector_configure: ["connector_id", "resources"],
		hydradb_connector_add_resource: ["connector_id", "resource_id"],
		hydradb_connector_update_resource: ["connector_id", "resource_id"],
		hydradb_connector_delete_resource: ["connector_id", "resource_id"],
	};

	const missingDescriptions = (schema: unknown, path: string): string[] => {
		if (schema == null || typeof schema !== "object") return [];

		const value = schema as Record<string, unknown>;

		const properties = value.properties && typeof value.properties === "object"
			? value.properties as Record<string, unknown>
			: {};

		const missing = Object.entries(properties).flatMap(([name, property]) => {
			const field = property as Record<string, unknown>;
			const fieldPath = path ? `${path}.${name}` : name;
			const own = typeof field.description === "string" && field.description.length > 0 ? [] : [fieldPath];

			return [...own, ...missingDescriptions(field, fieldPath)];
		});

		return [...missing, ...missingDescriptions(value.items, `${path}[]`)];
	};

	for (const name of CONNECTOR_TOOL_NAMES.slice(6)) {
		const tool = tools.find((candidate) => candidate.name === name);
		assert.ok(tool, `${name} should be registered`);
		assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).sort(), expectedFields[name], `${name} fields`);
		assert.deepEqual([...(tool.inputSchema.required ?? [])].sort(), expectedRequired[name], `${name} required fields`);
		assert.equal(tool.inputSchema.additionalProperties, false, `${name} should reject unknown fields`);
		assert.deepEqual(missingDescriptions(tool.inputSchema, ""), [], `${name} has undocumented fields`);
	}

	await client.close();
});

test("create and reconnect return dashboard completion links without credentials", async () => {
	process.env.HYDRADB_DASHBOARD_URL = "http://127.0.0.1:3000/";
	const fixture = mockHydra();
	const client = await connect(fixture.hydra);
	const { tools } = await client.listTools();
	const createTool = tools.find((tool) => tool.name === "hydradb_connector_create");

	assert.ok(createTool);
	assert.deepEqual(Object.keys(createTool.inputSchema.properties ?? {}), ["provider"]);
	assert.equal(createTool.inputSchema.additionalProperties, false);

	const create = await client.callTool({
		name: "hydradb_connector_create",
		arguments: { provider: "gitlab cloud" },
	});

	assert.equal(create.isError, undefined);
	assert.deepEqual(structured(create), {
		provider: "gitlab cloud",
		completed: false,
		dashboard_url: "http://127.0.0.1:3000/connectors?connect=gitlab+cloud",
	});
	assert.match(text(create), /no connector was created/i);
	assert.match(text(create), /http:\/\/127\.0\.0\.1:3000\/connectors\?connect=gitlab\+cloud/);
	assert.doesNotMatch(text(create), /credential.*:/i);

	const reconnect = await client.callTool({
		name: "hydradb_connector_update",
		arguments: { connector_id: "allowed", reconnect: true },
	});

	assert.equal(reconnect.isError, undefined);
	assert.deepEqual(structured(reconnect), {
		connector_id: "allowed",
		completed: false,
		dashboard_url: "http://127.0.0.1:3000/connectors?open=allowed",
	});
	assert.match(text(reconnect), /select Reconnect/i);
	assert.match(text(reconnect), /http:\/\/127\.0\.0\.1:3000\/connectors\?open=allowed/);
	assert.equal(fixture.calls.some((call) => call.method === "update"), false);

	await client.close();
});

test("reconnect authorizes the connector and stays mutually exclusive with settings", async () => {
	const fixture = mockHydra(["db-a"], ["public"]);
	const client = await connect(fixture.hydra);

	const allowed = await client.callTool({
		name: "hydradb_connector_update",
		arguments: { connector_id: "allowed", reconnect: true },
	});

	assert.equal(allowed.isError, undefined);

	const blocked = await client.callTool({
		name: "hydradb_connector_update",
		arguments: { connector_id: "blocked", reconnect: true },
	});

	assert.equal(blocked.isError, true);
	assert.doesNotMatch(text(blocked), /Blocked secret/);

	const mixed = await client.callTool({
		name: "hydradb_connector_update",
		arguments: { connector_id: "allowed", reconnect: true, custom_instructions: "do not send" },
	});

	assert.equal(mixed.isError, true);
	assert.equal(fixture.calls.some((call) => call.method === "update"), false);

	await client.close();
});

test("HYDRADB_MCP_CONNECTOR_TOOLS=off withholds only the connector family", async () => {
	process.env.HYDRADB_MCP_CONNECTOR_TOOLS = "off";
	const client = await connect(mockHydra().hydra);
	const names = (await client.listTools()).tools.map((tool) => tool.name);

	for (const name of CONNECTOR_TOOL_NAMES) assert.ok(!names.includes(name));
	assert.ok(names.includes(TOOL_NAMES.QUERY));

	await client.close();
});

test("connector input schemas expose no credential-bearing argument", async () => {
	const client = await connect(mockHydra().hydra);

	const tools = (await client.listTools()).tools.filter((tool) =>
		(CONNECTOR_TOOL_NAMES as readonly string[]).includes(tool.name),
	);

	const propertyNames = (schema: unknown): string[] => {
		if (schema == null || typeof schema !== "object") return [];
		const value = schema as Record<string, unknown>;

		const own = value.properties && typeof value.properties === "object"
			? Object.keys(value.properties as Record<string, unknown>)
			: [];

		return [...own, ...Object.values(value).flatMap(propertyNames)];
	};

	for (const tool of tools) {
		const names = propertyNames(tool.inputSchema).map((name) => name.toLowerCase());

		for (const forbidden of ["credentials", "password", "api_key", "token", "client_secret", "headers", "body"]) {
			assert.ok(!names.includes(forbidden), `${tool.name} exposes forbidden argument ${forbidden}`);
		}
	}

	await client.close();
});

test("connector schemas reject unknown fields before an API call", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);

	const result = await client.callTool({
		name: TOOL_NAMES.CONNECTOR_PROVIDERS,
		arguments: { provider: "slack", credentials: { token: "must-not-pass" } },
	});

	assert.equal(result.isError, true);
	assert.equal(calls.length, 0);
	assert.doesNotMatch(text(result), /must-not-pass/);

	await client.close();
});

test("connector write metadata rejects credential-like keys before mutation", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);

	for (const request of [
		{
			name: "hydradb_connector_add_resource",
			arguments: {
				connector_id: "allowed",
				resource_id: "r-new",
				metadata: { access_token: "must-not-pass" },
			},
		},
		{
			name: "hydradb_connector_configure",
			arguments: {
				connector_id: "allowed",
				resources: [{ resource_id: "r-new", metadata: { private_key: "must-not-pass" } }],
			},
		},
		{
			name: "hydradb_connector_add_resource",
			arguments: {
				connector_id: "allowed",
				resource_id: "r-new",
				metadata: { nested: { ssh_key: "must-not-pass" } },
			},
		},
	]) {
		const result = await client.callTool(request);

		assert.equal(result.isError, true);
		assert.doesNotMatch(text(result), /must-not-pass/);
	}

	assert.equal(calls.some((call) => call.method === "add-resource" || call.method === "configure"), false);

	await client.close();
});

test("provider tools return catalog entries and sanitize credential schemas", async () => {
	const { hydra, connectorApi } = mockHydra();
	connectorApi.listProviders = async (provider?: string) => provider
		? {
				provider,
				connectorType: "moveit",
				credentialSchema: {
					type: "object",
					required: ["token"],
					properties: {
						token: { type: "string", description: "Provider token", default: "secret", example: "secret-example" },
					},
				},
				filterableFields: [],
				indexedObjectTypes: ["message"],
				searchableFields: [],
			}
		: { providers: [{ provider: "slack", supported: true }] };
	const client = await connect(hydra);

	const catalog = await client.callTool({ name: TOOL_NAMES.CONNECTOR_PROVIDERS, arguments: {} });
	assert.deepEqual(structured(catalog).providers, [{ provider: "slack", supported: true }]);

	const detail = await client.callTool({ name: TOOL_NAMES.CONNECTOR_PROVIDERS, arguments: { provider: "slack" } });
	const rendered = JSON.stringify(structured(detail));
	assert.match(rendered, /Provider token/);
	assert.doesNotMatch(rendered, /secret-example|"default"|"example"/);

	await client.close();
});

test("confined list hides other databases and org-wide connectors", async () => {
	const client = await connect(mockHydra(["db-a"]).hydra);

	const result = await client.callTool({
		name: TOOL_NAMES.CONNECTOR_LIST,
		arguments: { include_health: true },
	});

	assert.deepEqual(structured(result).connectors, [
		{
			connector_id: "allowed",
			name: "Allowed",
			provider: "slack",
			database: "db-a",
			collection: "public",
		},
	]);
	assert.deepEqual(structured(result).health, { allowed: "healthy" });
	assert.doesNotMatch(text(result), /Blocked secret|Org wide/);

	await client.close();
});

test("every by-ID read preflights the connector and refuses a forbidden database", async () => {
	for (const name of [
		TOOL_NAMES.CONNECTOR_GET,
		TOOL_NAMES.CONNECTOR_STATUS,
		TOOL_NAMES.CONNECTOR_DISCOVER,
		TOOL_NAMES.CONNECTOR_RESOURCES,
	]) {
		const { hydra, calls } = mockHydra(["db-a"]);
		const client = await connect(hydra);
		const result = await client.callTool({ name, arguments: { connector_id: "blocked" } });

		assert.equal(result.isError, true, `${name} should refuse the connector`);
		assert.deepEqual(calls.map((call) => call.method), ["get"]);
		assert.doesNotMatch(text(result), /Blocked secret|github|db-b/);
		await client.close();
	}
});

test("connector status explains sync state without echoing provider errors", async () => {
	const client = await connect(mockHydra(["db-a"]).hydra);

	const result = await client.callTool({
		name: TOOL_NAMES.CONNECTOR_STATUS,
		arguments: { connector_id: "allowed" },
	});

	const rendered = text(result);

	assert.match(rendered, /degraded/i);
	assert.match(rendered, /last successful sync/i);
	assert.match(rendered, /may recover automatically/i);
	assert.match(rendered, /permission warning/i);
	assert.doesNotMatch(rendered, /top-secret-token|private detail|message: secret/i);

	await client.close();
});

test("resource listing filters by each resource's effective destination database", async () => {
	const client = await connect(mockHydra(["db-a"]).hydra);

	const result = await client.callTool({
		name: TOOL_NAMES.CONNECTOR_RESOURCES,
		arguments: { connector_id: "allowed" },
	});

	assert.deepEqual(
		(structured(result).resources as { resource_id: string }[]).map((resource) => resource.resource_id),
		["r-a", "r-inherited"],
	);

	await client.close();
});

test("connector reads enforce collection confinement and resource collection overrides", async () => {
	const fixture = mockHydra(["db-a"], ["public"]);
	fixture.connectors.push({
		connectorId: "private-collection",
		name: "Private collection",
		provider: "slack",
		database: "db-a",
		collection: "private",
	});
	fixture.resources.push({
		connectorId: "allowed",
		resourceId: "r-private",
		displayName: "Private resource",
		databaseOverride: "db-a",
		collectionOverride: "private",
	});
	const client = await connect(fixture.hydra);

	const list = await client.callTool({ name: TOOL_NAMES.CONNECTOR_LIST, arguments: {} });
	assert.deepEqual(
		(structured(list).connectors as { connector_id: string }[]).map((connector) => connector.connector_id),
		["allowed"],
	);

	const denied = await client.callTool({
		name: TOOL_NAMES.CONNECTOR_GET,
		arguments: { connector_id: "private-collection" },
	});

	assert.equal(denied.isError, true);
	assert.doesNotMatch(text(denied), /Private collection|private-collection|private/);

	const resources = await client.callTool({
		name: TOOL_NAMES.CONNECTOR_RESOURCES,
		arguments: { connector_id: "allowed" },
	});

	assert.deepEqual(
		(structured(resources).resources as { resource_id: string }[]).map((resource) => resource.resource_id),
		["r-a", "r-inherited"],
	);

	await client.close();
});

test("connector status filters resources outside the effective database or collection scope", async () => {
	const fixture = mockHydra(["db-a"], ["public"]);
	fixture.resources.push({
		connectorId: "allowed",
		resourceId: "r-private",
		displayName: "Private configured resource",
		databaseOverride: "db-a",
		collectionOverride: "private",
	});
	fixture.status.resources.push({
		resourceId: "r-b",
		displayName: "Forbidden database status",
		status: "failed",
		retryable: false,
	});

	fixture.status.resources.push({
		resourceId: "r-private",
		displayName: "Private status secret",
		status: "failed",
		retryable: false,
	});
	fixture.status.resources.push({
		resourceId: "r-unknown",
		displayName: "Unknown destination secret",
		status: "failed",
		retryable: false,
	});
	const client = await connect(fixture.hydra);

	const result = await client.callTool({
		name: TOOL_NAMES.CONNECTOR_STATUS,
		arguments: { connector_id: "allowed" },
	});

	const rendered = JSON.stringify(structured(result));

	assert.match(rendered, /r-a|r-inherited/);
	assert.doesNotMatch(
		rendered,
		/r-b|Forbidden database status|r-private|Private status secret|r-unknown|Unknown destination secret/,
	);
	assert.doesNotMatch(
		text(result),
		/Forbidden database status|Private status secret|Unknown destination secret/,
	);

	await client.close();
});

test("connector status maps typed failures to fixed credential-safe guidance", async () => {
	const cases = [
		{
			error: { code: "credentials_rejected", message: "secret credential detail", retryable: false },
			kind: "credentials",
			text: /Reconnect the connector/,
		},
		{
			error: { code: "database_missing", message: "secret database detail", retryable: false },
			kind: "destination",
			text: /destination database is missing/i,
		},
		{
			error: { code: "sync_service_failed", failureClass: "internal", message: "internal trace", retryable: false },
			kind: "internal",
			text: /Contact HydraDB support/,
		},
		{
			error: { failureClass: "transient", message: "provider secret", retryable: true },
			kind: "transient",
			text: /HydraDB will retry/,
		},
	];

	for (const item of cases) {
		const fixture = mockHydra(["db-a"]);
		fixture.status.error = item.error;
		const client = await connect(fixture.hydra);

		const result = await client.callTool({
			name: TOOL_NAMES.CONNECTOR_STATUS,
			arguments: { connector_id: "allowed" },
		});

		const error = structured(result).error as { kind: string };

		assert.equal(error.kind, item.kind);
		assert.match(text(result), item.text);
		assert.doesNotMatch(JSON.stringify(structured(result)), /secret|internal trace/);
		await client.close();
	}
});

test("discover validates pagination and forwards allowed calls", async () => {
	const { hydra, calls } = mockHydra(["db-a"]);
	const client = await connect(hydra);

	const invalid = await client.callTool({
		name: TOOL_NAMES.CONNECTOR_DISCOVER,
		arguments: { connector_id: "allowed", limit: 0 },
	});

	assert.equal(invalid.isError, true);

	const result = await client.callTool({
		name: TOOL_NAMES.CONNECTOR_DISCOVER,
		arguments: { connector_id: "allowed", cursor: "next", limit: 25 },
	});

	assert.equal(result.isError, undefined);
	assert.deepEqual(calls.at(-1), {
		method: "discover",
		args: { connectorId: "allowed", cursor: "next", limit: 25 },
	});

	await client.close();
});

test("credential-free connector writes map every public mutation with safe results", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);

	const cases = [
		{
			name: "hydradb_connector_update",
			arguments: { connector_id: "allowed", custom_instructions: "Index decisions", sync_interval_seconds: 300 },
			method: "update",
		},
		{ name: "hydradb_connector_sync", arguments: { connector_id: "allowed" }, method: "sync" },
		{ name: "hydradb_connector_pause", arguments: { connector_id: "allowed" }, method: "pause" },
		{ name: "hydradb_connector_resume", arguments: { connector_id: "allowed" }, method: "resume" },
		{
			name: "hydradb_connector_configure",
			arguments: {
				connector_id: "allowed",
				lookback_days: 30,
				resources: [{ resource_id: "r-a", resource_type: "channel", name: "General", database: "db-a", collection: "public" }],
			},
			method: "configure",
		},
		{
			name: "hydradb_connector_add_resource",
			arguments: {
				connector_id: "allowed",
				resource_id: "r-new",
				resource_type: "channel",
				display_name: "New channel",
				database_override: "db-a",
				collection_override: "public",
				acl: ["user@example.com"],
			},
			method: "add-resource",
		},
		{
			name: "hydradb_connector_update_resource",
			arguments: { connector_id: "allowed", resource_id: "r-a", custom_instructions: "Only decisions" },
			method: "update-resource",
		},
		{
			name: "hydradb_connector_delete_resource",
			arguments: { connector_id: "allowed", resource_id: "r-a" },
			method: "delete-resource",
		},
		{ name: "hydradb_connector_delete", arguments: { connector_id: "allowed" }, method: "delete" },
	];

	for (const item of cases) {
		const result = await client.callTool({ name: item.name, arguments: item.arguments });

		assert.notEqual(result.isError, true, `${item.name} should succeed`);
		assert.ok(calls.some((call) => call.method === item.method), `${item.name} should call ${item.method}`);
		assert.doesNotMatch(JSON.stringify(structured(result)), /top-secret-token|credentials/i);
	}

	await client.close();
});

test("add resource preserves safe warning and verification indicators", async () => {
	const fixture = mockHydra();
	fixture.connectorApi.createResource = async () => ({
		connectorId: "allowed",
		resourceId: "r-new",
		warnings: ["r-new"],
		unverified: ["r-later"],
	});
	const client = await connect(fixture.hydra);

	const result = await client.callTool({
		name: "hydradb_connector_add_resource",
		arguments: { connector_id: "allowed", resource_id: "r-new" },
	});

	assert.deepEqual(structured(result).warning_resource_ids, ["r-new"]);
	assert.deepEqual(structured(result).unverified_resource_ids, ["r-later"]);
	assert.match(text(result), /verification needs review/i);
	await client.close();
});

test("every credential-free connector write redacts representative upstream failures", async () => {
	const cases = [
		["hydradb_connector_update", { connector_id: "allowed", custom_instructions: "safe" }, "update"],
		["hydradb_connector_delete", { connector_id: "allowed" }, "delete"],
		["hydradb_connector_sync", { connector_id: "allowed" }, "sync"],
		["hydradb_connector_pause", { connector_id: "allowed" }, "pause"],
		["hydradb_connector_resume", { connector_id: "allowed" }, "resume"],
		[
			"hydradb_connector_configure",
			{ connector_id: "allowed", resources: [{ resource_id: "r-a" }] },
			"configure",
		],
		["hydradb_connector_add_resource", { connector_id: "allowed", resource_id: "r-new" }, "createResource"],
		[
			"hydradb_connector_update_resource",
			{ connector_id: "allowed", resource_id: "r-a", acl: [] },
			"updateResource",
		],
		[
			"hydradb_connector_delete_resource",
			{ connector_id: "allowed", resource_id: "r-a" },
			"deleteResource",
		],
	] as const;

	for (const [name, arguments_, method] of cases) {
		const fixture = mockHydra();
		(fixture.connectorApi as unknown as Record<string, unknown>)[method] = async () => {
			throw new Error("provider leaked top-secret-token");
		};

		const client = await connect(fixture.hydra);
		const result = await client.callTool({ name, arguments: arguments_ });

		assert.equal(result.isError, true, `${name} should return a tool error`);
		assert.doesNotMatch(text(result), /top-secret-token|provider leaked/);
		await client.close();
	}
});

test("scoped connector writes fail closed before any authorization read or mutation", async () => {
	const { hydra, calls } = mockHydra(["db-a"], ["public"]);
	const client = await connect(hydra);

	const requests = [
		{ name: "hydradb_connector_update", arguments: { connector_id: "allowed", custom_instructions: "safe" } },
		{ name: "hydradb_connector_delete", arguments: { connector_id: "allowed" } },
		{ name: "hydradb_connector_sync", arguments: { connector_id: "allowed" } },
		{ name: "hydradb_connector_pause", arguments: { connector_id: "allowed" } },
		{ name: "hydradb_connector_resume", arguments: { connector_id: "allowed" } },
		{ name: "hydradb_connector_configure", arguments: { connector_id: "allowed", resources: [{ resource_id: "r-a" }] } },
		{ name: "hydradb_connector_add_resource", arguments: { connector_id: "allowed", resource_id: "r-new" } },
		{ name: "hydradb_connector_update_resource", arguments: { connector_id: "allowed", resource_id: "r-a", acl: [] } },
		{ name: "hydradb_connector_delete_resource", arguments: { connector_id: "allowed", resource_id: "r-a" } },
	];

	for (const request of requests) {
		const result = await client.callTool(request);

		assert.equal(result.isError, true, `${request.name} should refuse every scoped mutation`);
		assert.match(text(result), /Scoped OAuth connections cannot modify connectors/);
	}

	assert.deepEqual(calls, [], "scoped mutations must make no connector API request");

	await client.close();
});

test("collection-only confinement also refuses resource mutations", async () => {
	const { hydra, calls } = mockHydra(undefined, ["public"]);
	const client = await connect(hydra);

	const requests = [
		{
			name: "hydradb_connector_add_resource",
			arguments: { connector_id: "allowed", resource_id: "new" },
		},
		{
			name: "hydradb_connector_update_resource",
			arguments: { connector_id: "allowed", resource_id: "r-a", acl: [] },
		},
		{
			name: "hydradb_connector_delete_resource",
			arguments: { connector_id: "allowed", resource_id: "r-b" },
		},
	];

	for (const request of requests) {
		const result = await client.callTool(request);

		assert.equal(result.isError, true, `${request.name} should refuse collection-scoped mutation`);
	}

	for (const method of ["add-resource", "update-resource", "delete-resource"]) {
		assert.equal(calls.some((call) => call.method === method), false, `${method} must not mutate`);
	}

	await client.close();
});

test("database-only confinement refuses configure before mutation", async () => {
	const fixture = mockHydra(["db-a"]);
	const client = await connect(fixture.hydra);

	const result = await client.callTool({
		name: "hydradb_connector_configure",
		arguments: {
			connector_id: "allowed",
			resources: [{ resource_id: "r-new", database: "db-b", collection: "public" }],
		},
	});

	assert.equal(result.isError, true);
	assert.deepEqual(fixture.calls, []);
	await client.close();
});
