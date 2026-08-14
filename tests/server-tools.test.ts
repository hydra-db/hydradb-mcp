import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { HydraDBClient } from "@hydradb/sdk";

import { HydraDB } from "../src/hydra/index.js";
import { __resetAliasWarnings, createHydraDBServer } from "../src/server.js";

type RecordedCall = { method: string; args: Record<string, unknown> };

/** Per-method response overrides, for tests that care what the API returned. */
type Responses = Partial<
	Record<"query" | "ingest" | "list" | "inspect" | "delete", unknown>
>;

function mockHydra(responses: Responses = {}): {
	hydra: HydraDB;
	calls: RecordedCall[];
} {
	const calls: RecordedCall[] = [];
	const record =
		(method: string, fallback: unknown) => (args?: Record<string, unknown>) => {
			calls.push({ method, args: args ?? {} });
			const data = method in responses
				? responses[method as keyof Responses]
				: fallback;
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
	assert.equal(text, "No relevant context items found in Hydra DB.");

	await client.close();
});

// Regression (reported by a user): the MCP could ingest and list knowledge but
// never *search* it. runQuery pinned `kind: "memory"` and querySchema exposed no
// selector, so with additionalProperties:false a caller could not widen the
// corpus even by asking. Verified against the live API: for a query matching an
// indexed knowledge doc, type=memory returns 0 chunks and type=all returns it.
test("hydradb_query searches both families by default", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);

	await client.callTool({
		name: "hydradb_query",
		arguments: { query: "the zarnovix lease window" },
	});

	const call = calls.find((c) => c.method === "query");
	assert.ok(call, "query should reach the SDK");
	assert.equal(
		call.args.type,
		"all",
		"an unqualified query must not be pinned to memory",
	);

	await client.close();
});

test("hydradb_query forwards an explicit kind to the wire `type`", async () => {
	for (const kind of ["memory", "knowledge", "all"] as const) {
		const { hydra, calls } = mockHydra();
		const client = await connect(hydra);

		await client.callTool({
			name: "hydradb_query",
			arguments: { query: "q", kind },
		});

		assert.equal(calls.find((c) => c.method === "query")?.args.type, kind);
		await client.close();
	}
});

// The deprecated alias shares runQuery, so it must gain the same reach — a user
// who has not migrated off `hydra_db_search` is exactly who hit this bug.
test("the deprecated hydra_db_search alias also searches knowledge", async () => {
	__resetAliasWarnings();
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);

	await client.callTool({
		name: "hydra_db_search",
		arguments: { query: "q", kind: "knowledge" },
	});

	assert.equal(calls.find((c) => c.method === "query")?.args.type, "knowledge");

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
		/nothing was deleted/i,
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

// The server succeeded and removed nothing: no such id exists. The old wording
// ("not found OR ALREADY DELETED") offered a cause never observed, and the
// reassuring one — a caller that guessed an id read it as confirmation and told
// the user their data was gone.
test("hydradb_delete states only what it observed when nothing was removed", async () => {
	const text = await deleteText(
		{ success: true, deletedCount: 0 },
		{ id: "mem-1" },
	);

	assert.match(text, /no memory with id mem-1 exists/i);
	assert.match(text, /nothing was deleted/i);
	assert.doesNotMatch(text, /refused/i, "the server did not refuse; it succeeded");
	assert.doesNotMatch(
		text,
		/already deleted/i,
		"never claim a prior deletion that was not observed",
	);
	// Point at where a real id comes from, so the caller corrects course instead
	// of retrying the same guess.
	assert.match(text, /hydradb_query|hydradb_list/);
});

test("hydradb_delete reports a successful removal unchanged", async () => {
	const text = await deleteText(
		{ success: true, userMemoryDeleted: 1 },
		{ id: "mem-1" },
	);

	assert.equal(text, "Deleted memory: mem-1");
});

/** Call hydradb_ingest against a given API response and return the rendered text. */
async function ingestText(
	ingest: unknown,
	args: Record<string, unknown>,
): Promise<string> {
	const { hydra } = mockHydra({ ingest });
	const client = await connect(hydra);
	const result = await client.callTool({ name: "hydradb_ingest", arguments: args });
	return ((result.content as { text: string }[])[0]?.text ?? "");
}

test("hydradb_ingest names which item failed and why", async () => {
	const text = await ingestText(
		{
			success: false,
			successCount: 1,
			failedCount: 1,
			results: [
				{ id: "s-ok", status: "completed", error: "" },
				{
					id: "s-bad",
					status: "failed",
					error: "content exceeds maximum size",
					errorCode: "TOO_LARGE",
				},
			],
		},
		{ text: "some note" },
	);

	// Without the id and the reason the caller can only re-ingest everything —
	// which, since a reused source_id replaces, can destroy what did succeed.
	assert.match(text, /s-bad/, "the failed item's id must be reported");
	assert.match(text, /content exceeds maximum size/);
	assert.match(text, /TOO_LARGE/);

	// Scoped to the Issues block: the header legitimately names the created id
	// of the item that succeeded, so a whole-text check would forbid that too.
	const issues = text.slice(text.indexOf("Issues:"));
	assert.doesNotMatch(issues, /s-ok/, "successful items should not be listed as issues");
});

test("hydradb_ingest reports graph extraction failure on a stored item", async () => {
	const text = await ingestText(
		{
			success: true,
			successCount: 1,
			failedCount: 0,
			results: [
				{
					id: "s1",
					status: "completed",
					error: "",
					relationsError: "entity extraction timed out",
				},
			],
		},
		{ text: "some note" },
	);

	// failed_count is 0 here: the item is stored and text-searchable but will
	// never be reached by graph traversal. Silent before this.
	assert.match(text, /0 failed/);
	assert.match(text, /graph extraction failed/i);
	assert.match(text, /entity extraction timed out/);
});

test("hydradb_ingest stays quiet when everything succeeded", async () => {
	const text = await ingestText(
		{
			success: true,
			successCount: 1,
			failedCount: 0,
			results: [{ id: "s1", status: "completed", error: "", errorCode: "" }],
		},
		{ text: "some note" },
	);

	assert.doesNotMatch(text, /Issues:/);
});

// Every audit of this server reached the same finding independently: a recall
// result carried no value that hydradb_inspect or hydradb_delete would accept,
// so a follow-up meant guessing an id or listing everything and matching prose.
// A hallucinated id then hit "not found or already deleted", which reads as
// success. The composition chain has to be closed at the source.
test("hydradb_query emits source ids the other tools accept", async () => {
	const { hydra } = mockHydra({
		query: {
			chunks: [
				{
					chunkUuid: "c1",
					id: "src-alpha",
					chunkContent: "the user prefers tabs",
					sourceTitle: "Prefs",
					relevancyScore: 0.91,
				},
			],
		},
	});
	const client = await connect(hydra);

	const result = await client.callTool({
		name: "hydradb_query",
		arguments: { query: "indentation" },
	});
	const text = (result.content as { text: string }[])[0]!.text;

	// Both halves of the result: the skimmable summary and the block a caller
	// actually reads. An id in only one of them is an id the caller may miss.
	const summary = text.slice(0, text.indexOf("Full context:"));
	const context = text.slice(text.indexOf("Full context:"));
	assert.match(summary, /\[id: src-alpha\]/, "summary line must carry the id");
	assert.match(context, /\[id: src-alpha\]/, "chunk header must carry the id");

	// An id with no stated purpose is noise; name what consumes it.
	assert.match(text, /hydradb_inspect/);
	assert.match(text, /hydradb_delete/);

	await client.close();
});

test("hydradb_ingest returns the id the server assigned", async () => {
	// The caller supplied no source_id, so this value exists nowhere else and
	// cannot be derived — without it the memory can never be corrected.
	const text = await ingestText(
		{
			success: true,
			successCount: 1,
			failedCount: 0,
			results: [{ id: "srv-assigned-9", status: "completed", error: "" }],
		},
		{ text: "a note" },
	);

	assert.match(text, /id: srv-assigned-9/);
	assert.doesNotMatch(text, /"a note"/, "should not echo back the caller's own text");
});

/** Call hydradb_list against a given API response and return the rendered text. */
async function listText(
	list: unknown,
	args: Record<string, unknown> = {},
): Promise<{ text: string; calls: RecordedCall[] }> {
	const { hydra, calls } = mockHydra({ list });
	const client = await connect(hydra);
	const result = await client.callTool({ name: "hydradb_list", arguments: args });
	await client.close();
	return { text: (result.content as { text: string }[])[0]?.text ?? "", calls };
}

// The listing took no paging arguments and rendered its own row count as the
// header, so a user with 4,000 memories asking "what do you know about me?" got
// "50 memories:" and an agent that answered as if that were everything. Page 2
// was unreachable through the MCP at all.
test("hydradb_list says how much of the corpus a memory page covered", async () => {
	const { text } = await listText({
		user_memories: [
			{ memory_id: "m1", memory_content: "prefers tabs" },
			{ memory_id: "m2", memory_content: "deploys Tuesdays" },
		],
		total: 412,
		pagination: { page: 1, page_size: 2, total_pages: 206, has_next: true },
	});

	assert.match(text, /2 of 412/, "must not present one page as the whole store");
	assert.match(text, /page 1/);
	assert.match(text, /page=2/, "must say how to reach the rest");
});

test("hydradb_list forwards page and page_size for memories", async () => {
	const { calls } = await listText(
		{ user_memories: [{ memory_id: "m1", memory_content: "x" }], total: 1 },
		{ kind: "memory", page: 3, page_size: 25 },
	);

	const call = calls.find((c) => c.method === "list");
	assert.ok(call, "list should reach the SDK");
	assert.equal(call.args.page, 3);
	assert.equal(call.args.pageSize, 25);
});

test("hydradb_list stays terse when one page is the whole corpus", async () => {
	const { text } = await listText({
		user_memories: [{ memory_id: "m1", memory_content: "prefers tabs" }],
		total: 1,
		pagination: { page: 1, page_size: 50, total_pages: 1, has_next: false },
	});

	assert.match(text, /^1 memories:/);
	assert.doesNotMatch(text, /page=/, "no next-page hint when there is no next page");
});

test("hydradb_list distinguishes an empty page from an empty store", async () => {
	const { text } = await listText({ user_memories: [], total: 400 }, { page: 99 });

	assert.match(text, /No memories on page 99/);
	assert.doesNotMatch(text, /No memories stored yet/);
});

// The header printed the corpus-wide `total` above a single page of rows:
// "412 sources:" over 50 lines, no truncation marker, no way to reach the rest.
// The count was right about the corpus and wrong about what the caller saw.
test("hydradb_list does not print a corpus total above one page of sources", async () => {
	const { text } = await listText(
		{
			sources: [
				{ id: "s1", title: "Q3 report", type: "file" },
				{ id: "s2", title: "Runbook", type: "file" },
			],
			total: 412,
			pagination: { page: 1, page_size: 2, total_pages: 206, has_next: true },
		},
		{ kind: "knowledge" },
	);

	assert.match(text, /2 of 412/);
	assert.doesNotMatch(
		text,
		/^412 sources:/,
		"the corpus total must not be presented as the number shown",
	);
	assert.match(text, /page=2/);
});

test("hydradb_list forwards page and page_size for knowledge", async () => {
	const { calls } = await listText(
		{ sources: [{ id: "s1" }], total: 1 },
		{ kind: "knowledge", page: 2, page_size: 10 },
	);

	const call = calls.find((c) => c.method === "list");
	assert.ok(call);
	assert.equal(call.args.type, "knowledge");
	assert.equal(call.args.page, 2);
	assert.equal(call.args.pageSize, 10);
});

test("hydradb_list distinguishes an empty source page from an empty corpus", async () => {
	const { text } = await listText(
		{ sources: [], total: 400 },
		{ kind: "knowledge", page: 99 },
	);

	assert.match(text, /No sources on page 99/);
	assert.doesNotMatch(text, /No sources found/);
});
