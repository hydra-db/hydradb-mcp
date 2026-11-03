/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions, anti-slop/no-known-value-widening, anti-slop/no-conditional-empty-object-spread -- Test doubles intentionally model dynamic MCP JSON and replace readonly resources. */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { type HydraDBClient, HydraDBError } from "@hydradb/sdk";
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

	const reply = (method: string, value: unknown) => async (args: Record<string, unknown> = {}) => {
		calls.push({ method, args });

		return value;
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

	// The SDK, not our wrapper: tests exercise the wrapper's own response validation.
	const sdk = {
		query: () => Promise.resolve({ success: true, chunks: [] }),
		context: {},
		listProviders: async (args: { id?: string } = {}): Promise<Record<string, unknown>> => {
			calls.push({ method: "listProviders", args });

			return args.id
				? { provider: args.id, connectorType: "classic", filterableFields: [], indexedObjectTypes: [], searchableFields: [] }
				: { providers: [{ provider: "slack", category: "Communication", supported: true }] };
		},
		connectors: {
			list: reply("list", { connectors, health: { allowed: "healthy", blocked: "failed", "org-wide": "checking" } }),
			get: async (args: { id: string }) => {
				calls.push({ method: "get", args });

				return connectors.find((connector) => connector.connectorId === args.id) ?? {};
			},
			status: reply("status", status),
			discover: reply("discover", {
				provider: "slack",
				resources: [{ id: "r-a", name: "general", resourceType: "channel", metadata: { topic: "safe" } }],
				hasMore: false,
			}),
			listResources: reply("listResources", { resources }),
			update: reply("update", { connectorId: "allowed", customInstructionsUpdated: true }),
			delete: reply("delete", { connectorId: "allowed", deleted: true }),
			sync: reply("sync", { runId: "run-1", workflowId: "workflow-1" }),
			pause: reply("pause", { connectorId: "allowed", paused: true }),
			resume: reply("resume", { connectorId: "allowed", paused: false }),
			configure: reply("configure", { connectorId: "allowed", configured: 1, backfill: false }),
			updateResourceAcl: reply("updateResourceAcl", { connectorId: "allowed", resourceId: "r-a", customInstructionsUpdated: true }),
			deleteResource: reply("deleteResource", { connectorId: "allowed", resourceId: "r-a", deleted: true }),
		},
	};

	const hydra = new HydraDB({
		token: "t",
		database: "db-a",
		...(allowedDatabases ? { allowedDatabases } : {}),
		...(allowedCollections ? { allowedCollections } : {}),
	}, sdk as unknown as HydraDBClient);

	return { hydra, calls, sdk, connectors, resources, status };
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
});

test("the 15 connector tools carry the CONTRACT.md §3 names, in noun-then-verb order", () => {
	assert.deepEqual([...CONNECTOR_TOOL_NAMES], [
		"hydradb_connector_provider_list",
		"hydradb_connector_provider_inspect",
		"hydradb_connector_list",
		"hydradb_connector_inspect",
		"hydradb_connector_health",
		"hydradb_connector_update",
		"hydradb_connector_delete",
		"hydradb_connector_sync",
		"hydradb_connector_pause",
		"hydradb_connector_resume",
		"hydradb_connector_discover",
		"hydradb_connector_resource_list",
		"hydradb_connector_resource_add",
		"hydradb_connector_resource_update",
		"hydradb_connector_resource_delete",
	]);
});

test("the retired connector tool names are not registered", async () => {
	const client = await connect(mockHydra().hydra);
	const names = (await client.listTools()).tools.map((tool) => tool.name);

	for (const retired of [
		"hydradb_connector_providers",
		"hydradb_connector_get",
		"hydradb_connector_status",
		"hydradb_connector_resources",
		"hydradb_connector_configure",
		"hydradb_connector_add_resource",
		"hydradb_connector_update_resource",
		"hydradb_connector_delete_resource",
	]) {
		assert.ok(!names.includes(retired), `${retired} should not be registered`);
	}

	await client.close();
});

test("all seven connector read tools are registered by default and explicitly read-only", async () => {
	const client = await connect(mockHydra().hydra);
	const { tools } = await client.listTools();

	for (const name of [
		"hydradb_connector_provider_list",
		"hydradb_connector_provider_inspect",
		"hydradb_connector_list",
		"hydradb_connector_inspect",
		"hydradb_connector_health",
		"hydradb_connector_discover",
		"hydradb_connector_resource_list",
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

test("all eight credential-free write tools declare explicit write safety annotations", async () => {
	const client = await connect(mockHydra().hydra);
	const { tools } = await client.listTools();

	const additive = new Set([
		"hydradb_connector_sync",
		"hydradb_connector_pause",
		"hydradb_connector_resume",
	]);

	const nonIdempotent = new Set([
		"hydradb_connector_sync",
		"hydradb_connector_resource_add",
	]);

	for (const name of [
		"hydradb_connector_update",
		"hydradb_connector_delete",
		"hydradb_connector_sync",
		"hydradb_connector_pause",
		"hydradb_connector_resume",
		"hydradb_connector_resource_add",
		"hydradb_connector_resource_update",
		"hydradb_connector_resource_delete",
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
		hydradb_connector_update: ["connector_id", "custom_instructions", "sync_interval_seconds"],
		hydradb_connector_delete: ["connector_id"],
		hydradb_connector_sync: ["connector_id"],
		hydradb_connector_pause: ["connector_id"],
		hydradb_connector_resume: ["connector_id"],
		hydradb_connector_resource_add: [
			"connector_id",
			"full_visibility_roles",
			"lookback_days",
			"resources",
			"table_configs",
		],
		hydradb_connector_resource_update: ["acl", "connector_id", "custom_instructions", "resource_id"],
		hydradb_connector_resource_delete: ["connector_id", "resource_id"],
	};

	const expectedRequired: Record<string, string[]> = {
		hydradb_connector_update: ["connector_id"],
		hydradb_connector_delete: ["connector_id"],
		hydradb_connector_sync: ["connector_id"],
		hydradb_connector_pause: ["connector_id"],
		hydradb_connector_resume: ["connector_id"],
		hydradb_connector_resource_add: ["connector_id", "resources"],
		hydradb_connector_resource_update: ["connector_id", "resource_id"],
		hydradb_connector_resource_delete: ["connector_id", "resource_id"],
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

	for (const name of Object.keys(expectedFields)) {
		const tool = tools.find((candidate) => candidate.name === name);
		assert.ok(tool, `${name} should be registered`);
		assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).sort(), expectedFields[name], `${name} fields`);
		assert.deepEqual([...(tool.inputSchema.required ?? [])].sort(), expectedRequired[name], `${name} required fields`);
		assert.equal(tool.inputSchema.additionalProperties, false, `${name} should reject unknown fields`);
		assert.deepEqual(missingDescriptions(tool.inputSchema, ""), [], `${name} has undocumented fields`);
	}

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
		name: TOOL_NAMES.CONNECTOR_PROVIDER_INSPECT,
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
			name: "hydradb_connector_resource_add",
			arguments: {
				connector_id: "allowed",
				resources: [{ resource_id: "r-new", metadata: { access_token: "must-not-pass" } }],
			},
		},
		{
			name: "hydradb_connector_resource_add",
			arguments: {
				connector_id: "allowed",
				resources: [{ resource_id: "r-new", additional_metadata: { private_key: "must-not-pass" } }],
			},
		},
		{
			name: "hydradb_connector_resource_add",
			arguments: {
				connector_id: "allowed",
				resources: [{ resource_id: "r-new", metadata: { nested: { ssh_key: "must-not-pass" } } }],
			},
		},
	]) {
		const result = await client.callTool(request);

		assert.equal(result.isError, true);
		assert.doesNotMatch(text(result), /must-not-pass/);
	}

	assert.equal(calls.some((call) => call.method === "configure"), false);

	await client.close();
});

test("provider tools return catalog entries and sanitize credential schemas", async () => {
	const { hydra, sdk, calls } = mockHydra();
	sdk.listProviders = async (args: { id?: string } = {}) => args.id
		? {
				provider: args.id,
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

	const catalog = await client.callTool({ name: TOOL_NAMES.CONNECTOR_PROVIDER_LIST, arguments: {} });
	assert.deepEqual(structured(catalog).providers, [{ provider: "slack", supported: true }]);

	const catalogWithProvider = await client.callTool({
		name: TOOL_NAMES.CONNECTOR_PROVIDER_LIST,
		arguments: { provider: "slack" },
	});

	assert.equal(catalogWithProvider.isError, true, "provider_list takes no provider; that is provider_inspect");

	const missingProvider = await client.callTool({ name: TOOL_NAMES.CONNECTOR_PROVIDER_INSPECT, arguments: {} });
	assert.equal(missingProvider.isError, true, "provider_inspect needs a provider");
	assert.equal(calls.length, 0);

	const detail = await client.callTool({ name: TOOL_NAMES.CONNECTOR_PROVIDER_INSPECT, arguments: { provider: "slack" } });
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
		TOOL_NAMES.CONNECTOR_INSPECT,
		TOOL_NAMES.CONNECTOR_HEALTH,
		TOOL_NAMES.CONNECTOR_DISCOVER,
		TOOL_NAMES.CONNECTOR_RESOURCE_LIST,
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

test("connector health explains sync state without echoing provider errors", async () => {
	const client = await connect(mockHydra(["db-a"]).hydra);

	const result = await client.callTool({
		name: TOOL_NAMES.CONNECTOR_HEALTH,
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
		name: TOOL_NAMES.CONNECTOR_RESOURCE_LIST,
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
		name: TOOL_NAMES.CONNECTOR_INSPECT,
		arguments: { connector_id: "private-collection" },
	});

	assert.equal(denied.isError, true);
	assert.doesNotMatch(text(denied), /Private collection|private-collection|private/);

	const resources = await client.callTool({
		name: TOOL_NAMES.CONNECTOR_RESOURCE_LIST,
		arguments: { connector_id: "allowed" },
	});

	assert.deepEqual(
		(structured(resources).resources as { resource_id: string }[]).map((resource) => resource.resource_id),
		["r-a", "r-inherited"],
	);

	await client.close();
});

test("connector health filters resources outside the effective database or collection scope", async () => {
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
		name: TOOL_NAMES.CONNECTOR_HEALTH,
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
	assert.equal(structured(result).withheld_resource_count, 3);
	assert.match(text(result), /3 resources are outside this connection's databases or collections and not shown/);

	await client.close();
});

test("connector health maps typed failures to fixed credential-safe guidance", async () => {
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
			error: { code: "sync_service_failed", failure_class: "terminal_internal", message: "internal trace", retryable: false },
			kind: "internal",
			text: /Contact HydraDB support/,
		},
		{
			error: { failure_class: "retriable_transient", message: "provider secret", retryable: true },
			kind: "transient",
			text: /HydraDB will retry/,
		},
	];

	for (const item of cases) {
		const fixture = mockHydra(["db-a"]);
		fixture.status.error = item.error;
		const client = await connect(fixture.hydra);

		const result = await client.callTool({
			name: TOOL_NAMES.CONNECTOR_HEALTH,
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
		args: { id: "allowed", cursor: "next", limit: 25 },
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
			name: "hydradb_connector_resource_add",
			arguments: {
				connector_id: "allowed",
				lookback_days: 30,
				resources: [{
					resource_id: "r-new",
					resource_type: "channel",
					display_name: "New channel",
					database_override: "db-a",
					collection_override: "public",
					acl: ["user@example.com"],
				}],
			},
			method: "configure",
		},
		{
			name: "hydradb_connector_resource_update",
			arguments: { connector_id: "allowed", resource_id: "r-a", custom_instructions: "Only decisions" },
			method: "updateResourceAcl",
		},
		{
			name: "hydradb_connector_resource_delete",
			arguments: { connector_id: "allowed", resource_id: "r-a" },
			method: "deleteResource",
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

test("resource_add sends the whole list to the configure endpoint under the API's field names", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);

	const result = await client.callTool({
		name: "hydradb_connector_resource_add",
		arguments: {
			connector_id: "allowed",
			lookback_days: 7,
			full_visibility_roles: ["admin"],
			table_configs: [{ table: "events", replication_key: "updated_at" }],
			resources: [
				{
					resource_id: "C1",
					resource_type: "channel",
					display_name: "general",
					database_override: "db-a",
					collection_override: "public",
					acl: [],
					custom_instructions: "",
					metadata: { team: "ops" },
					additional_metadata: { source: "mcp" },
					sync_mode: "new_only",
				},
				{ resource_id: "C2" },
			],
		},
	});

	assert.notEqual(result.isError, true);
	assert.deepEqual(calls, [{
		method: "configure",
		args: {
			id: "allowed",
			resources: [
				{
					resourceId: "C1",
					resourceType: "channel",
					name: "general",
					database: "db-a",
					collection: "public",
					acl: [],
					customInstructions: "",
					metadata: { team: "ops" },
					additionalMetadata: { source: "mcp" },
					syncMode: "new_only",
				},
				{
					resourceId: "C2",
					resourceType: undefined,
					name: undefined,
					database: undefined,
					collection: undefined,
					acl: undefined,
					customInstructions: undefined,
					metadata: undefined,
					additionalMetadata: undefined,
					syncMode: undefined,
				},
			],
			lookbackDays: 7,
			fullVisibilityRoles: ["admin"],
			tableConfigs: [{ table: "events", replicationKey: "updated_at", changeHistory: undefined }],
		},
	}]);
	assert.deepEqual(structured(result), { connector_id: "allowed", configured: 1, backfill: false });

	const empty = await client.callTool({
		name: "hydradb_connector_resource_add",
		arguments: { connector_id: "allowed", resources: [] },
	});

	assert.equal(empty.isError, true, "resource_add needs at least one resource");

	const bareResourceId = await client.callTool({
		name: "hydradb_connector_resource_add",
		arguments: { connector_id: "allowed", resource_id: "C3" },
	});

	assert.equal(bareResourceId.isError, true, "resources is always a list");

	for (const retiredField of [{ name: "general" }, { database: "db-a" }, { filters: {} }, { provider_metadata: {} }]) {
		const retired = await client.callTool({
			name: "hydradb_connector_resource_add",
			arguments: { connector_id: "allowed", resources: [{ resource_id: "C4", ...retiredField }] },
		});

		assert.equal(retired.isError, true, `${Object.keys(retiredField)[0]} is not a resource_add field`);
	}

	assert.equal(calls.length, 1);
	await client.close();
});

test("resource_add preserves safe warning and verification indicators", async () => {
	const fixture = mockHydra();
	fixture.sdk.connectors.configure = async () => ({
		connectorId: "allowed",
		configured: 1,
		warnings: ["r-new"],
		unverified: ["r-later"],
	});
	const client = await connect(fixture.hydra);

	const result = await client.callTool({
		name: "hydradb_connector_resource_add",
		arguments: { connector_id: "allowed", resources: [{ resource_id: "r-new" }] },
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
			"hydradb_connector_resource_add",
			{ connector_id: "allowed", resources: [{ resource_id: "r-a" }] },
			"configure",
		],
		[
			"hydradb_connector_resource_update",
			{ connector_id: "allowed", resource_id: "r-a", acl: [] },
			"updateResourceAcl",
		],
		[
			"hydradb_connector_resource_delete",
			{ connector_id: "allowed", resource_id: "r-a" },
			"deleteResource",
		],
	] as const;

	for (const [name, arguments_, method] of cases) {
		const fixture = mockHydra();
		fixture.sdk.connectors[method] = async () => {
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
		{ name: "hydradb_connector_resource_add", arguments: { connector_id: "allowed", resources: [{ resource_id: "r-a" }] } },
		{ name: "hydradb_connector_resource_update", arguments: { connector_id: "allowed", resource_id: "r-a", acl: [] } },
		{ name: "hydradb_connector_resource_delete", arguments: { connector_id: "allowed", resource_id: "r-a" } },
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
			name: "hydradb_connector_resource_add",
			arguments: { connector_id: "allowed", resources: [{ resource_id: "new" }] },
		},
		{
			name: "hydradb_connector_resource_update",
			arguments: { connector_id: "allowed", resource_id: "r-a", acl: [] },
		},
		{
			name: "hydradb_connector_resource_delete",
			arguments: { connector_id: "allowed", resource_id: "r-b" },
		},
	];

	for (const request of requests) {
		const result = await client.callTool(request);

		assert.equal(result.isError, true, `${request.name} should refuse collection-scoped mutation`);
	}

	for (const method of ["configure", "updateResourceAcl", "deleteResource"]) {
		assert.equal(calls.some((call) => call.method === method), false, `${method} must not mutate`);
	}

	await client.close();
});

test("database-only confinement refuses resource_add before mutation", async () => {
	const fixture = mockHydra(["db-a"]);
	const client = await connect(fixture.hydra);

	const result = await client.callTool({
		name: "hydradb_connector_resource_add",
		arguments: {
			connector_id: "allowed",
			resources: [{ resource_id: "r-new", database_override: "db-b", collection_override: "public" }],
		},
	});

	assert.equal(result.isError, true);
	assert.deepEqual(fixture.calls, []);
	await client.close();
});

test("connector errors: input mistakes pass through, and API rejections never say retry", async () => {
	const fixture = mockHydra();
	const client = await connect(fixture.hydra);

	const noSettings = await client.callTool({ name: TOOL_NAMES.CONNECTOR_UPDATE, arguments: { connector_id: "allowed" } });

	assert.equal(noSettings.isError, true);
	assert.match(text(noSettings), /Set custom_instructions, sync_interval_seconds, or both/);
	assert.doesNotMatch(text(noSettings), /retry/i);

	const rejections = [
		[422, /rejected the request as invalid/],
		[400, /rejected the request as invalid/],
		[401, /refused this connection's credentials/],
		[403, /refused this connection's credentials/],
	] as const;

	for (const [statusCode, message] of rejections) {
		fixture.sdk.connectors.sync = async () => {
			throw new HydraDBError({ statusCode, body: { message: "provider said top-secret-token" } });
		};

		const result = await client.callTool({ name: TOOL_NAMES.CONNECTOR_SYNC, arguments: { connector_id: "allowed" } });

		assert.equal(result.isError, true);
		assert.match(text(result), message);
		assert.doesNotMatch(text(result), /review connector health and retry|Reconnect the connector or|top-secret-token/i);
	}

	await client.close();
});

test("a write the API answers without its ID is a tool error, not a success under the caller's ID", async () => {
	const fixture = mockHydra();
	fixture.sdk.connectors.delete = async () => ({ deleted: true });
	const client = await connect(fixture.hydra);

	const result = await client.callTool({ name: TOOL_NAMES.CONNECTOR_DELETE, arguments: { connector_id: "allowed" } });

	assert.equal(result.isError, true);
	assert.doesNotMatch(text(result), /was deleted/);
	await client.close();
});

test("text alone carries every id and cursor the next call needs, for clients that drop structuredContent", async () => {
	const { hydra, sdk } = mockHydra();
	sdk.connectors.discover = async () => ({
		provider: "slack",
		resources: [{ id: "C01", name: "general", resourceType: "channel" }, { id: "C02", name: "", resourceType: "channel" }],
		hasMore: true,
		nextCursor: "page-2",
	});
	sdk.listProviders = async () => ({
		provider: "slack",
		connectorType: "classic",
		filterableFields: [],
		indexedObjectTypes: ["message"],
		searchableFields: [],
		setupGuide: ["Install the app.", "Invite the bot."],
	});
	const client = await connect(hydra);
	const read = async (name: string, args: Record<string, unknown> = {}) => text(await client.callTool({ name, arguments: args }));

	assert.equal(
		await read(TOOL_NAMES.CONNECTOR_LIST),
		"Visible connectors (3):\n- Allowed (allowed): unknown lifecycle, healthy\n- Blocked secret (blocked): unknown lifecycle, failed\n- Org wide (org-wide): unknown lifecycle, checking",
	);
	assert.equal(
		await read(TOOL_NAMES.CONNECTOR_DISCOVER, { connector_id: "allowed" }),
		"Discovered 2 resources.\n- general (C01): channel\n- C02: channel\nMore are available: call again with cursor page-2.",
	);
	assert.equal(
		await read(TOOL_NAMES.CONNECTOR_RESOURCE_LIST, { connector_id: "allowed" }),
		"Visible configured resources (3):\n- A (r-a): unknown status\n- B (r-b): unknown status\n- Inherited (r-inherited): unknown status",
	);
	assert.equal(
		await read(TOOL_NAMES.CONNECTOR_PROVIDER_INSPECT, { provider: "slack" }),
		"Provider slack uses connector type classic. Credential fields are schema metadata only; never put credential values in an MCP call.\nIt syncs: message.\nSetup:\n- Install the app.\n- Invite the bot.",
	);
	await client.close();
});

test("a connector call stopped by the call deadline says so, instead of advising a retry", async () => {
	const { sdk } = mockHydra();
	sdk.connectors.sync = (_args: unknown, options?: { abortSignal?: AbortSignal }) =>
		new Promise((_resolve, reject) => options?.abortSignal?.addEventListener("abort", () => reject(new Error("aborted"))));
	const client = await connect(new HydraDB({ token: "t", database: "db-a", timeoutSeconds: 1 }, sdk as unknown as HydraDBClient));

	const result = await client.callTool({ name: TOOL_NAMES.CONNECTOR_SYNC, arguments: { connector_id: "allowed" } });

	assert.equal(result.isError, true);
	assert.match(text(result), /^The connector request got no answer within the 1s deadline for the whole call\. A change may or may not have applied; check connector health before repeating it\.$/);
	await client.close();
});
