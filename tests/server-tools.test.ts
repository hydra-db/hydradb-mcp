import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { HydraDBClient } from "@hydradb/sdk";

import { HydraDB } from "../src/hydra/index.js";
import { createHydraDBServer } from "../src/server.js";

type RecordedCall = { method: string; args: Record<string, unknown> };

function mockHydra(): { hydra: HydraDB; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const record =
		(method: string, data: unknown) => (args?: Record<string, unknown>) => {
			calls.push({ method, args: args ?? {} });
			return Promise.resolve({ data, success: true });
		};

	const sdk = {
		query: record("query", { chunks: [] }),
		context: {
			ingest: record("ingest", { success: true, successCount: 1, failedCount: 0 }),
			list: record("list", { inner: { sources: [], total: 0 } }),
			inspect: record("inspect", { success: true, content: "hi" }),
			delete: record("delete", { success: true, userMemoryDeleted: 1 }),
			relations: record("relations", {}),
			status: record("status", {}),
		},
	} as unknown as HydraDBClient;

	const hydra = new HydraDB(
		{ token: "t", database: "db_test", collection: "col_test" },
		sdk,
	);
	return { hydra, calls };
}

async function connect(hydra: HydraDB) {
	const server = createHydraDBServer(hydra);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "0.0.0" });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return client;
}

test("hydradb_ingest accepts turns-only input (no text)", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);

	const result = await client.callTool({
		name: "hydradb_ingest",
		arguments: {
			turns: [{ user: "hi", assistant: "hello" }],
			source_id: "s1",
		},
	});

	assert.notEqual(result.isError, true, "turns-only ingest should not be rejected");
	const text = (result.content as { type: string; text: string }[])[0]!.text;
	assert.match(text, /Ingested 1 conversation turn/);

	const ingest = calls.find((c) => c.method === "ingest");
	assert.ok(ingest, "wrapper should have called context.ingest");
	const memories = JSON.parse(String(ingest.args.memories)) as Record<string, unknown>[];
	assert.deepEqual(memories[0]!.user_assistant_pairs, [
		{ user: "hi", assistant: "hello" },
	]);

	await client.close();
});

test("invoking a deprecated alias emits exactly one warning naming the canonical tool", async () => {
	const { hydra } = mockHydra();
	const client = await connect(hydra);

	const original = console.error;
	const messages: string[] = [];
	console.error = (...args: unknown[]) => {
		messages.push(args.map(String).join(" "));
	};

	try {
		await client.callTool({ name: "hydra_db_search", arguments: { query: "x" } });
		await client.callTool({ name: "hydra_db_search", arguments: { query: "y" } });
	} finally {
		console.error = original;
	}

	const warnings = messages.filter((m) => m.includes('"hydra_db_search"'));
	assert.equal(warnings.length, 1, "alias warning should fire once per process");
	assert.match(warnings[0]!, /deprecated/);
	assert.match(warnings[0]!, /"hydradb_query"/);

	await client.close();
});

test("canonical hydradb_query still renders the empty-result message", async () => {
	const { hydra } = mockHydra();
	const client = await connect(hydra);

	const result = await client.callTool({
		name: "hydradb_query",
		arguments: { query: "anything" },
	});
	const text = (result.content as { type: string; text: string }[])[0]!.text;
	assert.equal(text, "No relevant memories found in Hydra DB.");

	await client.close();
});
