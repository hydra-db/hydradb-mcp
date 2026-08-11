import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { HydraDBClient } from "@hydradb/sdk";

import { HydraDB } from "../src/hydra/index.js";
import { __resetAliasWarnings, createHydraDBServer } from "../src/server.js";

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

test("hydradb_ingest turns path forwards infer/title/is_markdown (no silent drop)", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);

	await client.callTool({
		name: "hydradb_ingest",
		arguments: {
			turns: [{ user: "hi", assistant: "hello" }],
			source_id: "s1",
			infer: false,
			title: "My conversation",
			is_markdown: true,
		},
	});

	const ingest = calls.find((c) => c.method === "ingest");
	assert.ok(ingest, "wrapper should have called context.ingest");
	const item = (JSON.parse(String(ingest.args.memories)) as Record<string, unknown>[])[0]!;
	assert.equal(item.infer, false, "infer must reach the wrapper, not be hardcoded true");
	assert.equal(item.title, "My conversation", "title must be forwarded");
	assert.equal(item.is_markdown, true, "is_markdown must be forwarded");
	// custom_instructions is omitted when infer is false (preserved v1 behaviour).
	assert.equal(item.custom_instructions, undefined);

	await client.close();
});

test("hydradb_ingest rejects both text and turns rather than dropping one", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);

	const result = await client.callTool({
		name: "hydradb_ingest",
		arguments: {
			text: "a note",
			turns: [{ user: "hi", assistant: "hello" }],
		},
	});

	assert.equal(result.isError, true, "providing both text and turns should error");
	const text = (result.content as { type: string; text: string }[])[0]!.text;
	assert.match(text, /not both/);
	assert.equal(
		calls.filter((c) => c.method === "ingest").length,
		0,
		"no ingest should be issued when the input is ambiguous",
	);

	await client.close();
});

test("deprecated alias warns exactly once per process, across two server instances", async () => {
	__resetAliasWarnings();

	const original = console.error;
	const messages: string[] = [];
	console.error = (...args: unknown[]) => {
		messages.push(args.map(String).join(" "));
	};

	// Two independent server instances in the same process.
	const clientA = await connect(mockHydra().hydra);
	const clientB = await connect(mockHydra().hydra);
	try {
		await clientA.callTool({ name: "hydra_db_search", arguments: { query: "x" } });
		await clientB.callTool({ name: "hydra_db_search", arguments: { query: "y" } });
	} finally {
		console.error = original;
	}

	const warnings = messages.filter((m) => m.includes('"hydra_db_search"'));
	assert.equal(
		warnings.length,
		1,
		"alias warning must fire once per process even across server instances",
	);
	assert.match(warnings[0]!, /deprecated/);
	assert.match(warnings[0]!, /"hydradb_query"/);

	await clientA.close();
	await clientB.close();
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

// Regression: a live knowledge delete came back success:false, and the tool
// answered "Source <id> was not found or already deleted." The caller is told
// the data is gone when the server has in fact declined to remove it.
function mockHydraWithDelete(deleteResponse: Record<string, unknown>): HydraDB {
	const sdk = {
		query: () => Promise.resolve({ data: { chunks: [] }, success: true }),
		context: {
			delete: () => Promise.resolve({ data: deleteResponse, success: true }),
		},
	} as unknown as HydraDBClient;
	return new HydraDB({ token: "t", database: "db_test" }, sdk);
}

async function deleteText(
	deleteResponse: Record<string, unknown>,
	args: Record<string, unknown>,
): Promise<string> {
	const client = await connect(mockHydraWithDelete(deleteResponse));
	const result = await client.callTool({ name: "hydradb_delete", arguments: args });
	const text = (result.content as { type: string; text: string }[])[0]!.text;
	await client.close();
	return text;
}

async function deleteStructured(
	deleteResponse: Record<string, unknown>,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const client = await connect(mockHydraWithDelete(deleteResponse));
	const result = await client.callTool({ name: "hydradb_delete", arguments: args });
	await client.close();
	return result.structuredContent as Record<string, unknown>;
}

test("every tool advertises an output schema", async () => {
	const { hydra } = mockHydra();
	const client = await connect(hydra);

	const { tools } = await client.listTools();
	const missing = tools.filter((t) => !t.outputSchema).map((t) => t.name);
	assert.deepEqual(missing, [], "every tool should declare an outputSchema");

	await client.close();
});

test("hydradb_list returns ids as data, untruncated, alongside the prose", async () => {
	// The prose clips each row to 150 chars, so a caller that scraped it got a
	// mangled id/content pair. The structured half is the whole value.
	const long = "x".repeat(300);
	const sdk = {
		context: {
			list: () =>
				Promise.resolve({
					data: { user_memories: [{ memory_id: "m1", memory_content: long }] },
					success: true,
				}),
		},
	} as unknown as HydraDBClient;
	const client = await connect(new HydraDB({ token: "t", database: "db" }, sdk));

	const result = await client.callTool({ name: "hydradb_list", arguments: {} });

	const text = (result.content as { type: string; text: string }[])[0]!.text;
	assert.match(text, /1 memories:/, "prose output is unchanged");

	assert.deepEqual(result.structuredContent, {
		kind: "memory",
		total: 1,
		items: [{ id: "m1", content: long }],
	});

	await client.close();
});

test("hydradb_delete reports its three outcomes as data, not just wording", async () => {
	assert.deepEqual(
		await deleteStructured({ success: true, userMemoryDeleted: 1 }, { id: "m1" }),
		{ outcome: "removed", id: "m1", kind: "memory" },
	);

	// The distinction the prose makes in words is now machine-readable: a caller
	// can branch on `refused` instead of pattern-matching an English sentence.
	assert.deepEqual(
		await deleteStructured(
			{ success: false, message: "still processing", deletedCount: 0 },
			{ id: "s1", kind: "knowledge" },
		),
		{
			outcome: "refused",
			id: "s1",
			kind: "knowledge",
			reason: "still processing",
		},
	);

	assert.deepEqual(
		await deleteStructured({ success: true, deletedCount: 0 }, { id: "m1" }),
		{ outcome: "absent", id: "m1", kind: "memory" },
	);
});

test("a soft inspect failure is reported as data, not only as prose", async () => {
	const sdk = {
		context: {
			inspect: () =>
				Promise.resolve({ data: { success: false, error: "gone" }, success: true }),
		},
	} as unknown as HydraDBClient;
	const client = await connect(new HydraDB({ token: "t", database: "db" }, sdk));

	const result = await client.callTool({
		name: "hydradb_inspect",
		arguments: { source_id: "s1" },
	});

	// Still a non-error result, matching v1 — but no longer indistinguishable
	// from success without reading the sentence.
	assert.notEqual(result.isError, true);
	assert.deepEqual(result.structuredContent, {
		source_id: "s1",
		success: false,
		error: "gone",
	});

	await client.close();
});

test("hydradb_delete does not claim 'not found' when the server refused", async () => {
	// Verbatim from a live run against api.hydradb.com.
	const text = await deleteText(
		{
			success: false,
			message: "Source is still processing; retry deletion after ingestion completes",
			results: [
				{
					id: "src-1",
					deleted: false,
					error:
						"Source is still processing; retry deletion after ingestion completes",
				},
			],
			deletedCount: 0,
		},
		{ id: "src-1", kind: "knowledge" },
	);

	assert.match(text, /could NOT delete/i);
	assert.match(text, /retry deletion after ingestion completes/);
	assert.match(text, /has not been removed/i);
	assert.doesNotMatch(
		text,
		/not found or already deleted/i,
		"a refusal must not be reported as a missing source",
	);
});

test("hydradb_delete surfaces the per-item error ahead of the summary message", async () => {
	const text = await deleteText(
		{
			success: false,
			message: "delete failed",
			deletedCount: 0,
			results: [{ id: "src-1", error: "source locked by an active ingestion" }],
		},
		{ id: "src-1", kind: "knowledge" },
	);

	assert.match(text, /source locked by an active ingestion/);
});

test("hydradb_delete still reports the benign idempotent case as not found", async () => {
	const text = await deleteText(
		{ success: true, deletedCount: 0 },
		{ id: "mem-1" },
	);

	assert.match(text, /not found or already deleted/i);
	assert.doesNotMatch(text, /refused/i);
});

test("hydradb_delete reports a successful removal unchanged", async () => {
	const text = await deleteText(
		{ success: true, userMemoryDeleted: 1 },
		{ id: "mem-1" },
	);

	assert.equal(text, "Deleted memory: mem-1");
});
