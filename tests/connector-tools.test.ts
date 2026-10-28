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
});

test("all six connector read tools are registered by default and explicitly read-only", async () => {
	const client = await connect(mockHydra().hydra);
	const { tools } = await client.listTools();

	for (const name of CONNECTOR_TOOL_NAMES) {
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
