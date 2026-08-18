import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { HydraDBClient } from "@hydradb/sdk";

import { GraphResource, HydraDB, HydraWrapperError } from "../src/hydra/index.js";
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
 * There is ONE Cypher tool and it is annotated destructive.
 *
 * The previous read/write split promised a host that one of the two never
 * wrote, and that promise rested on classifying Cypher text — a heuristic. A
 * single destructive tool makes no claim it cannot keep.
 */
test("the Cypher tool is annotated destructive, not read-only", async () => {
	const { hydra } = mockGraph();
	const client = await connect(hydra);

	const { tools } = await client.listTools();
	const cypher = tools.find((t) => t.name === TOOL_NAMES.GRAPH_QUERY);

	assert.equal(cypher?.annotations?.readOnlyHint, false);
	assert.equal(cypher?.annotations?.destructiveHint, true);

	await client.close();
});

// --- One tool runs both reads and writes ---

test("the Cypher tool runs a write", async () => {
	const { hydra, calls } = mockGraph(() => [{ created: 1 }]);
	const client = await connect(hydra);

	const result = await client.callTool({
		name: TOOL_NAMES.GRAPH_QUERY,
		arguments: { query: "CREATE (n:Person {name: 'Alice'}) RETURN 1 AS created" },
	});

	assert.notEqual(result.isError, true, "a write must not be refused");
	assert.equal(calls.length, 1);

	await client.close();
});

test("the Cypher tool runs a read", async () => {
	const { hydra, calls } = mockGraph(() => [{ name: "Alice" }]);
	const client = await connect(hydra);

	const result = await client.callTool({
		name: TOOL_NAMES.GRAPH_QUERY,
		arguments: { query: "MATCH (p:Person) RETURN p.name AS name" },
	});

	assert.notEqual(result.isError, true);
	assert.equal(calls.length, 1);

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
 * Zero rows is reported without guessing whether the query read or wrote.
 *
 * Classifying it would mean lexing the Cypher, which this server no longer
 * does. Naming both readings is enough to stop a caller re-running a write that
 * already committed because the result "looked empty".
 */
test("an empty result names both readings rather than guessing", async () => {
	const { hydra } = mockGraph(() => []);
	const client = await connect(hydra);

	const result = await client.callTool({
		name: TOOL_NAMES.GRAPH_QUERY,
		arguments: { query: "MATCH (n:Person) SET n.seen = true" },
	});

	assert.notEqual(result.isError, true);
	assert.match(textOf(result), /returned 0 rows/);
	assert.match(textOf(result), /nothing matched/);
	assert.match(textOf(result), /do not re-run it/);

	await client.close();
});

/**
 * The server rejects unsupported constructs itself, before executing anything —
 * verified live: a query mixing CREATE with a procedure call left the node
 * count unchanged. So the query is sent as written and the server's own message
 * comes back, rather than being pre-empted by a local imitation of its rules.
 */
test("a procedure call is sent to the server rather than judged locally", async () => {
	const { hydra, calls } = mockGraph(() => []);
	const client = await connect(hydra);

	await client.callTool({
		name: TOOL_NAMES.GRAPH_QUERY,
		arguments: { query: "CALL db.labels()" },
	});

	assert.equal(calls.length, 1, "the server is the authority on what it accepts");
	assert.equal(calls[0]!.args.query, "CALL db.labels()", "sent verbatim");

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
		name: TOOL_NAMES.GRAPH_QUERY,
		arguments: { query: "UNWIND $rows AS row CREATE (n:T) SET n = row", params: { rows } },
	});

	assert.equal(result.isError, true);
	assert.match(textOf(result), /256 KiB limit/);
	// The remedy, not just the refusal.
	assert.match(textOf(result), /UNWIND/);
	assert.equal(calls.length, 0, "an oversized body must not be uploaded to be rejected");

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
	assert.match(textOf(result), new RegExp(TOOL_NAMES.GRAPH_QUERY));

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

// --- Transport: response shapes and size accounting ---
//
// These reach the real GraphResource, which the tests above deliberately
// replace. `fetch` is stubbed so no request leaves the process.

function withFetch<T>(
	respond: (url: string, init: RequestInit) => { status?: number; body: unknown },
	run: (graph: GraphResource) => Promise<T>,
): Promise<T> {
	const original = globalThis.fetch;
	globalThis.fetch = (async (url: unknown, init: unknown) => {
		const { status = 200, body } = respond(String(url), init as RequestInit);
		return {
			ok: status >= 200 && status < 300,
			status,
			text: async () => JSON.stringify(body),
		} as Response;
	}) as typeof fetch;
	const graph = new GraphResource({ token: "t", maxRetries: 0 });
	return run(graph).finally(() => {
		globalThis.fetch = original;
	});
}

/**
 * An empty array is an ordinary answer here — a query that matched nothing, or
 * a write with no RETURN. Coercing a malformed response into one would make a
 * broken integration indistinguishable from a true negative, which is the one
 * case a caller cannot debug.
 */
test("a non-array query payload throws rather than reading as no rows", async () => {
	await withFetch(
		() => ({ body: { success: true, data: { unexpected: "object" } } }),
		async (graph) => {
			await assert.rejects(
				() => graph.query({ database: "d", collection: "c", query: "MATCH (n) RETURN n" }),
				(err: unknown) => {
					assert.ok(err instanceof HydraWrapperError);
					assert.match(err.message, /response-shape mismatch, not an empty result/);
					return true;
				},
			);
		},
	);
});

test("a genuinely empty result is still an empty result", async () => {
	// The live API returns `data: []` for a write with no RETURN, so this must
	// stay a success rather than being swept up by the shape check.
	await withFetch(
		() => ({ body: { success: true, data: [] } }),
		async (graph) => {
			assert.deepEqual(
				await graph.query({ database: "d", collection: "c", query: "MATCH (n) SET n.x = 1" }),
				[],
			);
		},
	);
});

/**
 * The container being an array is not enough: `renderRows` calls `Object.keys`
 * on each row, which throws a bare TypeError on `null` and on a string. That
 * surfaces inside a tool handler as an unactionable stack rather than "the
 * response was not what we expected".
 */
test("a malformed row inside the array throws, naming the row", async () => {
	for (const bad of [null, "a string", 5, ["nested"]]) {
		await withFetch(
			() => ({ body: { success: true, data: [{ ok: 1 }, bad] } }),
			async (graph) => {
				await assert.rejects(
					() => graph.query({ database: "d", collection: "c", query: "MATCH (n) RETURN n" }),
					(err: unknown) => {
						assert.ok(err instanceof HydraWrapperError);
						assert.match(err.message, /row 1 is not one/);
						return true;
					},
					`row ${JSON.stringify(bad)} should be rejected`,
				);
			},
		);
	}
});

test("a non-string collection name throws rather than being handed back as scope", async () => {
	await withFetch(
		() => ({ body: { success: true, data: { collections: ["ok", 42] } } }),
		async (graph) => {
			await assert.rejects(
				() => graph.listCollections({ database: "d" }),
				(err: unknown) => {
					assert.ok(err instanceof HydraWrapperError);
					assert.match(err.message, /index 1 is not a string/);
					return true;
				},
			);
		},
	);
});

test("a malformed collections payload throws rather than reading as none", async () => {
	await withFetch(
		() => ({ body: { success: true, data: { wrong: true } } }),
		async (graph) => {
			await assert.rejects(
				() => graph.listCollections({ database: "d" }),
				(err: unknown) => {
					assert.ok(err instanceof HydraWrapperError);
					assert.match(err.message, /collections/);
					return true;
				},
			);
		},
	);
});

test("an empty collections list is still an empty list", async () => {
	await withFetch(
		() => ({ body: { success: true, data: { collections: [] } } }),
		async (graph) => {
			assert.deepEqual(await graph.listCollections({ database: "d" }), []);
		},
	);
});

/**
 * The size check must measure the body the transport actually sends.
 *
 * `database` and `collection` are serialised alongside the query, so a payload
 * sitting just under the cap on `query` + `params` alone passed locally and was
 * rejected remotely with a 413 — after the whole thing had been uploaded, which
 * is the outcome the check exists to avoid.
 */
test("the size check accounts for database and collection, not just the query", async () => {
	const { hydra, calls } = mockGraph();
	const client = await connect(hydra);

	// Sized so query+params alone fit under 256 KiB, but the full body does not.
	const query = "UNWIND $rows AS row CREATE (n:T) SET n = row";
	const longDatabase = "d".repeat(4_000);
	const filler = "x".repeat(262_144 - query.length - 2_200);

	// Guard the guard: if this ever stops holding, the test would pass for the
	// wrong reason — rejecting a payload that was over the cap on the query
	// alone, and proving nothing about the scope fields.
	assert.ok(
		Buffer.byteLength(JSON.stringify({ query, params: { blob: filler } }), "utf8") <
			262_144,
		"query+params alone must fit, or this test proves nothing about scope",
	);

	const result = await client.callTool({
		name: TOOL_NAMES.GRAPH_QUERY,
		arguments: { query, params: { blob: filler }, database: longDatabase, collection: "c" },
	});

	assert.equal(result.isError, true);
	assert.match(textOf(result), /256 KiB limit/);
	assert.equal(calls.length, 0, "an oversized body must not be uploaded to be rejected");

	await client.close();
});
