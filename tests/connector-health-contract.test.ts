import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { HydraDBClient } from "@hydradb/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { HydraDB, type HydraConfig } from "../src/hydra/index.js";
import { createHydraDBServer } from "../src/server.js";

const connectorId = "connector_id_with_under_scores";
const providerError = "Provider echoed a private credential: synthetic-provider-secret";
const extensions = {
	sync_state: "retrying",
	next_attempt_at: "2026-11-23T12:00:00Z",
	last_progress_at: "2026-11-23T11:00:00Z",
	last_successful_sync_at: "2026-11-23T10:00:00Z",
	consecutive_failures: 0,
	failing_since: "2026-11-23T09:00:00Z",
	backfill_status: "active",
	backfill_oldest: "2026-06-01T00:00:00Z",
	backfill_next_chunk_at: "2026-11-23T13:00:00Z",
	backfill_retrying: false,
	backfill_last_error: providerError,
};

function camelFields(value: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
		key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()), entry,
	]));
}

interface Payloads {
	connector: Record<string, unknown>;
	list: Record<string, unknown>;
	status: { connector_id: string; resources: Record<string, unknown>[]; [field: string]: unknown };
	configured: { resources: Record<string, unknown>[] };
}

function payloads(camel = false): Payloads {
	const fields = (value: Record<string, unknown>) => camel ? camelFields(value) : value;
	const connector = { connector_id: connectorId, database: "db-a", collection: "public" };
	return {
		connector,
		list: {
			connectors: [connector, { connector_id: "hidden_connector", database: "db-b", collection: "private" }],
			health: { [connectorId]: "healthy", hidden_connector: "degraded" },
			...fields({ health_counts: {
				[connectorId]: fields({ resources_failing: 0, resources_retrying: 1 }),
				hidden_connector: fields({ resources_failing: 99, resources_retrying: 0 }),
			} }),
		},
		status: {
			connector_id: connectorId,
			...fields({ resources_failing: 0, resources_retrying: 1 }),
			resources: [{ resource_id: "visible", status: "failed", message: providerError, ...fields(extensions), arbitrary_extra: "drop me" }],
		},
		configured: { resources: [{ resource_id: "visible" }] },
	};
}

async function fixture(t: TestContext, bodies = payloads(), config: Partial<HydraConfig> = {}) {
	const calls: URL[] = [];
	const fetchFn: typeof fetch = async (input) => {
		const url = new URL(String(input));
		calls.push(url);
		let data: unknown;
		if (url.pathname === "/connectors") data = bodies.list;
		else if (url.pathname.endsWith("/status")) data = bodies.status;
		else if (url.pathname.endsWith("/resources")) data = bodies.configured;
		else if (url.pathname === `/connectors/${connectorId}`) data = bodies.connector;
		else throw new Error(`Unexpected offline route ${url.pathname}`);
		return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
	};
	const cfg = { token: "synthetic-token", database: "db-a", baseUrl: "https://offline.invalid", maxRetries: 0, ...config };
	const sdk = new HydraDBClient({ token: cfg.token, baseUrl: cfg.baseUrl, fetch: fetchFn, maxRetries: 0, timeoutInSeconds: 1 });
	const hydra = new HydraDB(cfg, sdk);
	const server = createHydraDBServer(hydra);
	const client = new Client({ name: "connector-health-contract", version: "1" });
	const [ct, st] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(st), client.connect(ct)]);
	t.after(async () => { await client.close(); await server.close(); });
	return { hydra, client, calls };
}

async function health(client: Client) {
	const result = await client.callTool({ name: "hydradb_connector_health", arguments: { connector_id: connectorId } });
	assert.equal(result.isError, undefined, JSON.stringify(result));
	return { result, data: z.record(z.unknown()).parse(result.structuredContent) };
}

for (const camel of [false, true]) {
	test(`released SDK retains validated ${camel ? "camel" : "wire snake"} connector health fields through wrapper and MCP`, async (t) => {
		const { hydra, client } = await fixture(t, payloads(camel));
		const list = await hydra.connectors.list({ includeHealth: true });
		assert.deepEqual(list, {
			connectors: [{ connectorId, database: "db-a", collection: "public" }, { connectorId: "hidden_connector", database: "db-b", collection: "private" }],
			health: { [connectorId]: "healthy", hidden_connector: "degraded" },
			healthCounts: { [connectorId]: { resourcesFailing: 0, resourcesRetrying: 1 }, hidden_connector: { resourcesFailing: 99, resourcesRetrying: 0 } },
		});
		const status = await hydra.connectors.health(connectorId);
		assert.deepEqual(status, {
			connectorId, resourcesFailing: 0, resourcesRetrying: 1,
			resources: [{ resourceId: "visible", status: "failed", message: providerError, ...camelFields(extensions) }],
		});
		const listed = await client.callTool({ name: "hydradb_connector_list", arguments: { include_health: true } });
		assert.equal(listed.isError, undefined);
		assert.deepEqual(z.record(z.unknown()).parse(listed.structuredContent).health_counts, {
			[connectorId]: { resources_failing: 0, resources_retrying: 1 },
			hidden_connector: { resources_failing: 99, resources_retrying: 0 },
		});
		const { result, data } = await health(client);
		assert.equal(data.resources_failing, 0);
		assert.equal(data.resources_retrying, 1);
		const { backfill_last_error: _error, ...safeExtensions } = extensions;
		assert.deepEqual(data.resources, [{
			resource_id: "visible", status: "failed", ...safeExtensions,
			action: "Review the connector configuration and the next sync result.",
			has_backfill_error: true, has_acl_warning: false, has_page_acl_warning: false,
		}]);
		assert.doesNotMatch(JSON.stringify(result), /synthetic-provider-secret|Provider echoed|backfill_last_error|arbitrary_extra/);
	});
}

test("absent health extensions stay absent and an empty recorded backfill error yields false", async (t) => {
	const bodies = payloads();
	const { health_counts: _counts, ...oldList } = bodies.list;
	Object.assign(bodies, { list: oldList, status: { connector_id: connectorId, resources: [{ resource_id: "visible" }] } });
	const { hydra, client } = await fixture(t, bodies);
	assert.deepEqual(await hydra.connectors.health(connectorId), { connectorId, resources: [{ resourceId: "visible" }] });
	assert.ok(!("healthCounts" in await hydra.connectors.list()));
	const listed = await client.callTool({ name: "hydradb_connector_list", arguments: { include_health: true } });
	assert.equal(listed.isError, undefined);
	assert.ok(!("health_counts" in z.record(z.unknown()).parse(listed.structuredContent)));
	let output = await health(client);
	assert.ok(!("resources_failing" in output.data));
	assert.ok(!("resources_retrying" in output.data));
	assert.deepEqual(output.data.resources, [{ resource_id: "visible", has_acl_warning: false, has_page_acl_warning: false }]);
	Object.assign(bodies.status.resources[0], { backfill_last_error: "" });
	output = await health(client);
	assert.equal(z.array(z.record(z.unknown())).parse(output.data.resources)[0].has_backfill_error, false);
});

test("canonical aliases win over wire aliases even for zero and false", async (t) => {
	const bodies = payloads();
	Object.assign(bodies.status, { resourcesFailing: 0, resources_failing: 8 });
	Object.assign(bodies.status.resources[0], { consecutiveFailures: 0, consecutive_failures: 8, backfillRetrying: false, backfill_retrying: true });
	Object.assign(bodies.list, { healthCounts: { [connectorId]: { resourcesFailing: 0, resources_failing: 8, resourcesRetrying: 0, arbitrary_extra: "drop me" } } });
	const { hydra } = await fixture(t, bodies);
	assert.deepEqual((await hydra.connectors.list()).healthCounts, { [connectorId]: { resourcesFailing: 0, resourcesRetrying: 0 } });
	assert.deepEqual(await hydra.connectors.health(connectorId), {
		connectorId, resourcesFailing: 0, resourcesRetrying: 1,
		resources: [{ resourceId: "visible", status: "failed", message: providerError, ...camelFields(extensions) }],
	});
});

test("confined connector lists omit health counts without new requests and still scope the health map", async (t) => {
	const { client, calls } = await fixture(t, payloads(), { allowedDatabases: ["db-a"], allowedCollections: ["public"] });
	const result = await client.callTool({ name: "hydradb_connector_list", arguments: { include_health: true } });
	assert.equal(result.isError, undefined);
	const data = z.record(z.unknown()).parse(result.structuredContent);
	assert.ok(!("health_counts" in data));
	assert.deepEqual(data.health, { [connectorId]: "healthy" });
	assert.equal(JSON.stringify(result).includes("hidden_connector"), false);
	assert.equal(calls.length, 1);
});

function scopedPayloads(): Payloads {
	const bodies = payloads();
	Object.assign(bodies.status, {
		resources_failing: 99, resources_retrying: 88,
		resources: [
			{ resource_id: "visible", sync_state: "failing" },
			{ resource_id: "visible-retry", sync_state: "retrying" },
			{ resource_id: "hidden", sync_state: "failing", backfill_last_error: providerError },
			{ resource_id: "unconfigured", sync_state: "retrying" },
		],
	});
	Object.assign(bodies.configured, { resources: [
		{ resource_id: "visible" },
		{ resource_id: "visible-retry", database_override: "db-a", collection_override: "public" },
		{ resource_id: "hidden", database_override: "db-b", collection_override: "private" },
	] });
	return bodies;
}

test("confined status counts only trustworthy visible sync states, including zero", async (t) => {
	const bodies = scopedPayloads();
	const { client } = await fixture(t, bodies, { allowedDatabases: ["db-a"], allowedCollections: ["public"] });
	let output = await health(client);
	assert.equal(output.data.resources_failing, 1);
	assert.equal(output.data.resources_retrying, 1);
	assert.equal(output.data.withheld_resource_count, 2);
	assert.doesNotMatch(JSON.stringify(output.result), /99|88|synthetic-provider-secret|unconfigured/);
	Object.assign(bodies.status.resources[0], { sync_state: "ok" });
	output = await health(client);
	assert.equal(output.data.resources_failing, 0);
	assert.equal(output.data.resources_retrying, 1);
});

for (const syncState of [undefined, "future_state"]) {
	test(`confined status omits global counts when a visible sync state is ${syncState ?? "absent"}`, async (t) => {
		const bodies = scopedPayloads();
		Object.assign(bodies.status.resources[0], { sync_state: syncState });
		const { client } = await fixture(t, bodies, { allowedDatabases: ["db-a"] });
		const { data, result } = await health(client);
		assert.ok(!("resources_failing" in data));
		assert.ok(!("resources_retrying" in data));
		assert.doesNotMatch(JSON.stringify(result), /99|88|synthetic-provider-secret/);
	});
}

test("confined status does not manufacture absent count extensions", async (t) => {
	const bodies = scopedPayloads();
	const { resources_retrying: _retrying, ...partial } = bodies.status;
	Object.assign(bodies, { status: partial });
	const { client } = await fixture(t, bodies, { allowedCollections: ["public"] });
	const { data } = await health(client);
	assert.equal(data.resources_failing, 1);
	assert.ok(!("resources_retrying" in data));
});

test("confined status with no visible state evidence omits counts instead of guessing zeros", async (t) => {
	const bodies = scopedPayloads();
	bodies.configured.resources = [];
	const { client } = await fixture(t, bodies, { allowedDatabases: ["db-a"] });
	const { data } = await health(client);
	assert.deepEqual(data.resources, []);
	assert.ok(!("resources_failing" in data));
	assert.ok(!("resources_retrying" in data));
});

test("new health fields are validated rather than arbitrary extras passed through", async (t) => {
	for (const [key, value] of Object.entries(extensions)) {
		const bodies = payloads();
		Object.assign(bodies.status.resources[0], { [key]: typeof value === "string" ? 42 : "invalid" });
		const { hydra } = await fixture(t, bodies);
		await assert.rejects(hydra.connectors.health(connectorId), /Invalid successful connector health response/);
	}
	for (const invalid of [-1, 0.5, "invalid"]) {
		const bodies = payloads();
		Object.assign(bodies.status, { resources_failing: invalid });
		Object.assign(bodies.list, { health_counts: { [connectorId]: { resources_retrying: invalid } } });
		const { hydra } = await fixture(t, bodies);
		await assert.rejects(hydra.connectors.health(connectorId), /Invalid successful connector health response/);
		await assert.rejects(hydra.connectors.list(), /Invalid successful connector list response/);
	}
});
