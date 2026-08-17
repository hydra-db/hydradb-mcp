import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { HydraDBClient } from "@hydradb/sdk";

import { HydraDB } from "../src/hydra/index.js";
import type { GraphRow } from "../src/hydra/index.js";
import { createHydraDBServer } from "../src/server.js";
import { GRAPH_TOOL_NAMES, TOOL_NAMES } from "../src/tool-names.js";

type GraphCall = { method: string; args: Record<string, unknown> };

/**
 * A HydraDB whose graph resource records calls instead of making them.
 *
 * `graph` is replaced wholesale rather than mocked at the transport layer: the
 * point of these tests is which requests the tools DECIDE to make, and the
 * guards that matter most are the ones that stop a request being made at all.
 */
function mockGraph(
	rowsFor: (query: string) => GraphRow[] = () => [],
	overrides: Partial<Record<string, unknown>> = {},
) {
	const calls: GraphCall[] = [];

	const graph = {
		query(args: { database: string; collection: string; query: string }) {
			calls.push({ method: "query", args });
			return Promise.resolve(rowsFor(args.query));
		},
		createDatabase(database: string) {
			calls.push({ method: "createDatabase", args: { database } });
			return Promise.resolve({ database, status: "ready" });
		},
		listCollections(args: { database: string }) {
			calls.push({ method: "listCollections", args });
			return Promise.resolve((overrides.collections as string[]) ?? []);
		},
		dropCollection(args: { database: string; collection: string }) {
			calls.push({ method: "dropCollection", args });
			return Promise.resolve({});
		},
		dropDatabase(database: string) {
			calls.push({ method: "dropDatabase", args: { database } });
			return Promise.resolve(
				(overrides.dropDatabase as Record<string, unknown>) ?? {
					deleted: true,
					deleted_collections: ["contacts"],
				},
			);
		},
	};

	const sdk = {
		query: () => Promise.resolve({ data: { chunks: [] }, success: true }),
		context: {},
	} as unknown as HydraDBClient;

	const hydra = new HydraDB({ token: "t", database: "db_test" }, sdk);
	// `graph` is readonly to callers, not to the test that stands in for it.
	(hydra as { graph: unknown }).graph = graph;

	return { hydra, calls };
}

async function connect(hydra: HydraDB, graphOverride?: Record<string, unknown>) {
	const server = createHydraDBServer(hydra, {
		database: "graph_db",
		collection: "graph_col",
		enabled: true,
		readOnly: false,
		...graphOverride,
	});
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "0.0.0" });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return client;
}

function textOf(result: unknown): string {
	return (result as { content: { text: string }[] }).content[0]!.text;
}

// --- Registration and gating ---

test("the graph tools are registered by default", async () => {
	const { hydra } = mockGraph();
	const client = await connect(hydra);

	const { tools } = await client.listTools();
	const names = tools.map((t) => t.name);
	for (const name of GRAPH_TOOL_NAMES) {
		assert.ok(names.includes(name), `${name} should be registered by default`);
	}

	await client.close();
});

test("HYDRADB_MCP_GRAPH_TOOLS=0 withholds the whole family", async () => {
	const { hydra } = mockGraph();
	const client = await connect(hydra, { enabled: false });

	const { tools } = await client.listTools();
	const names = tools.map((t) => t.name);
	for (const name of GRAPH_TOOL_NAMES) {
		assert.ok(!names.includes(name), `${name} should be withheld`);
	}
	// The memory surface is untouched by the graph gate.
	assert.ok(names.includes(TOOL_NAMES.QUERY));

	await client.close();
});

/**
 * Read-only mode withholds the mutating tools rather than refusing them at call
 * time. A tool that is never registered cannot be invoked at all, where a
 * runtime refusal only holds if the check is reached.
 */
test("read-only mode registers the reads and withholds the writes", async () => {
	const { hydra } = mockGraph();
	const client = await connect(hydra, { readOnly: true });

	const names = (await client.listTools()).tools.map((t) => t.name);
	assert.ok(names.includes(TOOL_NAMES.GRAPH_QUERY));
	assert.ok(names.includes(TOOL_NAMES.GRAPH_SCHEMA));
	assert.ok(names.includes(TOOL_NAMES.GRAPH_COLLECTIONS));
	assert.ok(!names.includes(TOOL_NAMES.GRAPH_WRITE), "write tool must be withheld");
	assert.ok(!names.includes(TOOL_NAMES.GRAPH_ADMIN), "admin tool must be withheld");

	await client.close();
});

test("the read tool is annotated read-only and the write tool destructive", async () => {
	const { hydra } = mockGraph();
	const client = await connect(hydra);

	const { tools } = await client.listTools();
	const read = tools.find((t) => t.name === TOOL_NAMES.GRAPH_QUERY);
	const write = tools.find((t) => t.name === TOOL_NAMES.GRAPH_WRITE);

	assert.equal(read?.annotations?.readOnlyHint, true);
	assert.equal(read?.annotations?.destructiveHint, false);
	// Arbitrary Cypher reaches DELETE as easily as CREATE, so a host must be
	// able to gate this one.
	assert.equal(write?.annotations?.readOnlyHint, false);
	assert.equal(write?.annotations?.destructiveHint, true);

	await client.close();
});

// --- The read/write guard ---

test("the read tool refuses a write and issues no request", async () => {
	const { hydra, calls } = mockGraph();
	const client = await connect(hydra);

	const result = await client.callTool({
		name: TOOL_NAMES.GRAPH_QUERY,
		arguments: { query: "CREATE (n:Person {name: 'Alice'})" },
	});

	assert.equal(result.isError, true);
	assert.match(textOf(result), /read-only/);
	assert.match(textOf(result), /CREATE/);
	assert.match(textOf(result), /Nothing was executed/);
	assert.equal(calls.length, 0, "a refused write must never reach the network");

	await client.close();
});

/**
 * The false positive that motivated a literal-aware detector. Verified against
 * the live API: this query is accepted and mutates nothing, but Neo4j's
 * substring scan would refuse it.
 */
test("the read tool allows a write keyword inside a string literal", async () => {
	const { hydra, calls } = mockGraph(() => [{ name: "Alice" }]);
	const client = await connect(hydra);

	const result = await client.callTool({
		name: TOOL_NAMES.GRAPH_QUERY,
		arguments: {
			query: 'MATCH (p:Person) WHERE p.name = "CREATE something" RETURN p.name AS name',
		},
	});

	assert.notEqual(result.isError, true, "a pure read must not be refused");
	assert.equal(calls.length, 1, "the query should have been executed");

	await client.close();
});

test("the write tool refuses a pure read and issues no request", async () => {
	const { hydra, calls } = mockGraph();
	const client = await connect(hydra);

	const result = await client.callTool({
		name: TOOL_NAMES.GRAPH_WRITE,
		arguments: { query: "MATCH (n) RETURN n" },
	});

	assert.equal(result.isError, true);
	assert.match(textOf(result), /no write clause/);
	assert.equal(calls.length, 0);

	await client.close();
});

test("a procedure call is refused locally with the alternative named", async () => {
	const { hydra, calls } = mockGraph();
	const client = await connect(hydra);

	const result = await client.callTool({
		name: TOOL_NAMES.GRAPH_QUERY,
		arguments: { query: "CALL db.labels()" },
	});

	assert.equal(result.isError, true);
	assert.match(textOf(result), /procedure calls/i);
	assert.match(textOf(result), new RegExp(TOOL_NAMES.GRAPH_SCHEMA));
	assert.equal(calls.length, 0, "a rejected construct must not be sent");

	await client.close();
});

test("LOAD CSV is refused locally", async () => {
	const { hydra, calls } = mockGraph();
	const client = await connect(hydra);

	const result = await client.callTool({
		name: TOOL_NAMES.GRAPH_WRITE,
		arguments: { query: "LOAD CSV FROM 'file:///x.csv' AS row CREATE (n {v: row[0]})" },
	});

	assert.equal(result.isError, true);
	assert.match(textOf(result), /LOAD CSV/);
	assert.equal(calls.length, 0);

	await client.close();
});

// --- Scope ---

test("scope defaults to the configured graph database and collection", async () => {
	const { hydra, calls } = mockGraph(() => [{ n: 1 }]);
	const client = await connect(hydra);

	await client.callTool({
		name: TOOL_NAMES.GRAPH_QUERY,
		arguments: { query: "MATCH (n) RETURN n" },
	});

	assert.equal(calls[0]!.args.database, "graph_db");
	assert.equal(calls[0]!.args.collection, "graph_col");

	await client.close();
});

test("per-call scope overrides the configured default", async () => {
	const { hydra, calls } = mockGraph(() => [{ n: 1 }]);
	const client = await connect(hydra);

	await client.callTool({
		name: TOOL_NAMES.GRAPH_QUERY,
		arguments: { query: "MATCH (n) RETURN n", database: "other", collection: "crm" },
	});

	assert.equal(calls[0]!.args.database, "other");
	assert.equal(calls[0]!.args.collection, "crm");

	await client.close();
});

test("an invalid collection name is rejected before the network", async () => {
	const { hydra, calls } = mockGraph();
	const client = await connect(hydra);

	const result = await client.callTool({
		name: TOOL_NAMES.GRAPH_QUERY,
		arguments: { query: "MATCH (n) RETURN n", collection: "has space" },
	});

	assert.equal(result.isError, true);
	// The rule is named, not just the rejection.
	assert.match(textOf(result), /A-Za-z0-9/);
	assert.equal(calls.length, 0);

	await client.close();
});

// --- Result handling ---

test("params are forwarded to the graph resource", async () => {
	const { hydra, calls } = mockGraph(() => [{ name: "Alice" }]);
	const client = await connect(hydra);

	await client.callTool({
		name: TOOL_NAMES.GRAPH_QUERY,
		arguments: {
			query: "MATCH (p:Person {name: $n}) RETURN p.name AS name",
			params: { n: "Alice" },
		},
	});

	assert.deepEqual(calls[0]!.args.params, { n: "Alice" });

	await client.close();
});

/**
 * A write with no RETURN legitimately yields zero rows. Reporting that as "no
 * results" invites the caller to retry a write that already committed.
 */
test("a write returning no rows reads as success, not as an empty result", async () => {
	const { hydra } = mockGraph(() => []);
	const client = await connect(hydra);

	const result = await client.callTool({
		name: TOOL_NAMES.GRAPH_WRITE,
		arguments: { query: "MATCH (n:Person) SET n.seen = true" },
	});

	assert.notEqual(result.isError, true);
	assert.match(textOf(result), /Write completed/);
	assert.match(textOf(result), /expected when it has no RETURN/);

	await client.close();
});

test("rows come back rendered and in structured content", async () => {
	const { hydra } = mockGraph(() => [
		{ p: { id: 0, labels: ["Person"], name: "Alice", role: "admin" } },
	]);
	const client = await connect(hydra);

	const result = await client.callTool({
		name: TOOL_NAMES.GRAPH_QUERY,
		arguments: { query: "MATCH (p:Person) RETURN p" },
	});

	assert.match(textOf(result), /\(:Person \{name: Alice, role: admin\}\)/);
	const structured = (result as { structuredContent: Record<string, unknown> })
		.structuredContent;
	assert.equal(structured.row_count, 1);
	assert.equal(structured.database, "graph_db");

	await client.close();
});

test("an oversized request is refused before the network", async () => {
	const { hydra, calls } = mockGraph();
	const client = await connect(hydra);

	// Over the documented 256 KiB body cap.
	const rows = Array.from({ length: 20_000 }, (_, i) => ({ id: i, pad: "x".repeat(20) }));
	const result = await client.callTool({
		name: TOOL_NAMES.GRAPH_WRITE,
		arguments: { query: "UNWIND $rows AS row CREATE (n:T) SET n = row", params: { rows } },
	});

	assert.equal(result.isError, true);
	assert.match(textOf(result), /256 KiB limit/);
	// The remedy, not just the refusal.
	assert.match(textOf(result), /UNWIND/);
	assert.equal(calls.length, 0, "an oversized body must not be uploaded to be rejected");

	await client.close();
});

// --- Schema ---

test("schema is derived from plain Cypher, with no procedure call", async () => {
	const { hydra, calls } = mockGraph((query) => {
		if (query.includes("UNWIND labels(n) AS label RETURN label")) {
			return [{ label: "Person", count: 2 }];
		}
		if (query.includes("RETURN type(r) AS type, count(*)")) {
			return [{ type: "KNOWS", count: 1 }];
		}
		if (query.includes("UNWIND keys(n) AS key")) {
			return [
				{ label: "Person", key: "name", count: 2 },
				{ label: "Person", key: "role", count: 2 },
			];
		}
		if (query.includes("UNWIND keys(r) AS key")) {
			return [{ type: "KNOWS", key: "since", count: 1 }];
		}
		return [{ start: ["Person"], rel: "KNOWS", end: ["Person"] }];
	});
	const client = await connect(hydra);

	const result = await client.callTool({
		name: TOOL_NAMES.GRAPH_SCHEMA,
		arguments: {},
	});

	const text = textOf(result);
	assert.match(text, /\(:Person\) ×2 — name, role/);
	assert.match(text, /\[:KNOWS\] ×1 — since/);
	assert.match(text, /\(:Person\)-\[:KNOWS\]->\(:Person\)/);
	// A sampled answer must not read as exhaustive.
	assert.match(text, /derived from a sample/);

	for (const call of calls) {
		assert.ok(
			!/\bCALL\s+[a-z]/i.test(String(call.args.query)),
			`schema must not use a procedure call: ${call.args.query}`,
		);
	}

	await client.close();
});

test("an empty collection is reported as empty rather than as a failure", async () => {
	const { hydra } = mockGraph(() => []);
	const client = await connect(hydra);

	const result = await client.callTool({
		name: TOOL_NAMES.GRAPH_SCHEMA,
		arguments: {},
	});

	assert.notEqual(result.isError, true);
	assert.match(textOf(result), /is empty/);
	assert.match(textOf(result), /not an error/);

	await client.close();
});

// --- Collections and admin ---

test("listing collections reports the empty case usefully", async () => {
	const { hydra } = mockGraph();
	const client = await connect(hydra);

	const result = await client.callTool({
		name: TOOL_NAMES.GRAPH_COLLECTIONS,
		arguments: {},
	});

	assert.match(textOf(result), /No graph collections/);
	// Collections auto-create, so the next step is a write, not a create call.
	assert.match(textOf(result), new RegExp(TOOL_NAMES.GRAPH_WRITE));

	await client.close();
});

test("listing collections returns the names", async () => {
	const { hydra } = mockGraph(() => [], { collections: ["contacts", "orgs"] });
	const client = await connect(hydra);

	const result = await client.callTool({
		name: TOOL_NAMES.GRAPH_COLLECTIONS,
		arguments: { database: "crm" },
	});

	assert.match(textOf(result), /contacts/);
	assert.match(textOf(result), /orgs/);

	await client.close();
});

test("create_database reports readiness", async () => {
	const { hydra, calls } = mockGraph();
	const client = await connect(hydra);

	const result = await client.callTool({
		name: TOOL_NAMES.GRAPH_ADMIN,
		arguments: { action: "create_database", database: "crm" },
	});

	assert.match(textOf(result), /Created graph database "crm"/);
	assert.equal(calls[0]!.method, "createDatabase");

	await client.close();
});

test("drop_collection requires a collection and says nothing was deleted without one", async () => {
	const { hydra, calls } = mockGraph();
	const client = await connect(hydra);

	const result = await client.callTool({
		name: TOOL_NAMES.GRAPH_ADMIN,
		arguments: { action: "drop_collection", database: "crm" },
	});

	assert.equal(result.isError, true);
	assert.match(textOf(result), /Nothing was deleted/);
	assert.equal(calls.length, 0);

	await client.close();
});

/**
 * `deleted: false` is a real, different outcome: the database predates BYOG, so
 * only its graph collections went. Reporting it as a full drop would tell the
 * user something is gone that is still there.
 */
test("drop_database distinguishes a partial drop from a full one", async () => {
	const { hydra } = mockGraph(() => [], {
		dropDatabase: { deleted: false, deleted_collections: ["contacts"] },
	});
	const client = await connect(hydra);

	const result = await client.callTool({
		name: TOOL_NAMES.GRAPH_ADMIN,
		arguments: { action: "drop_database", database: "crm" },
	});

	const text = textOf(result);
	assert.match(text, /NOT the database itself/);
	assert.match(text, /contacts/);
	const structured = (result as { structuredContent: Record<string, unknown> })
		.structuredContent;
	assert.equal(structured.database_deleted, false);

	await client.close();
});

test("a full drop reports the database as gone", async () => {
	const { hydra } = mockGraph();
	const client = await connect(hydra);

	const result = await client.callTool({
		name: TOOL_NAMES.GRAPH_ADMIN,
		arguments: { action: "drop_database", database: "crm" },
	});

	assert.match(textOf(result), /Dropped graph database "crm"/);

	await client.close();
});
