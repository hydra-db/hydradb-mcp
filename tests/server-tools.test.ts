import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { HydraDBError } from "@hydradb/sdk";
import type { HydraDBClient } from "@hydradb/sdk";

import { HydraDB } from "../src/hydra/index.js";
import {
	__resetAliasWarnings,
	__resetShutdown,
	beginShutdown,
	awaitInFlight,
	createHydraDBServer,
	inFlightCount,
	legacyToolsEnabled,
} from "../src/server.js";
import {
	CANONICAL_TOOL_NAMES,
	DEPRECATED_TOOL_NAMES,
	GRAPH_TOOL_NAMES,
} from "../src/tool-names.js";

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
	// The subgraph read takes the raw HTTP path, not the SDK, so it is stubbed
	// on the resource: without this it throws "no HTTP transport configured".
	// The stub records like every SDK method so dispatch-level tests cover it.
	(hydra.context as unknown as Record<string, unknown>).subgraph = record("subgraph", {
		seed_source_id: "s1",
		sources: [],
		relations: [],
		auxiliary_relations: [],
		is_truncated: false,
		auxiliary_truncated: false,
		max_depth_reached: 0,
		success: true,
		message: "ok",
	});
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
	// Aliases are off by default as of 1.2.0; this test is about their behaviour
	// when a user has explicitly opted back in.
	process.env.HYDRADB_MCP_LEGACY_TOOLS = "1";

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

	delete process.env.HYDRADB_MCP_LEGACY_TOOLS;

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
	// Aliases are off by default as of 1.2.0; opt in to exercise this one.
	process.env.HYDRADB_MCP_LEGACY_TOOLS = "1";
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);

	await client.callTool({
		name: "hydra_db_search",
		arguments: { query: "q", kind: "knowledge" },
	});

	assert.equal(calls.find((c) => c.method === "query")?.args.type, "knowledge");

	delete process.env.HYDRADB_MCP_LEGACY_TOOLS;
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

	// One block now, not two. The id rides in the chunk header alongside the
	// score, which is the only thing the removed summary carried that this did
	// not.
	assert.match(text, /\[id: src-alpha\]/, "chunk header must carry the id");
	assert.match(text, /\(91%\)/, "the score must survive the summary's removal");
	assert.equal(
		text.match(/src-alpha/g)?.length,
		1,
		"the id should appear once, not once per rendering of the same chunk",
	);

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
	const { text } = await listText(
		{
			user_memories: [
				{ memory_id: "m1", memory_content: "prefers tabs" },
				{ memory_id: "m2", memory_content: "deploys Tuesdays" },
			],
			total: 412,
			pagination: { page: 1, page_size: 2, total_pages: 206, has_next: true },
		},
		{ kind: "memory" },
	);

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
	const { text } = await listText(
		{
			user_memories: [{ memory_id: "m1", memory_content: "prefers tabs" }],
			total: 1,
			pagination: { page: 1, page_size: 50, total_pages: 1, has_next: false },
		},
		{ kind: "memory" },
	);

	assert.match(text, /^1 memories:/);
	assert.doesNotMatch(text, /page=/, "no next-page hint when there is no next page");
});

test("hydradb_list distinguishes an empty page from an empty store", async () => {
	const { text } = await listText(
		{ user_memories: [], total: 400 },
		{ kind: "memory", page: 99 },
	);

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

// hydradb_list declared `source_ids` for both families but the memory branch
// called runListMemories() with no arguments, so the filter was dropped in
// silence. Worse than an ordinary no-op: source-to-many-memories fan-out is real
// (that is what source_id does on ingest), so a caller handed 40 unfiltered rows
// has a coherent explanation ready — "those two sources expanded into 40" — and
// reports them as filtered. Nothing in the response contradicts it.
test("hydradb_list honours source_ids when listing memories", async () => {
	const { calls } = await listText(
		{ user_memories: [{ memory_id: "m1", memory_content: "x" }], total: 1 },
		{ kind: "memory", source_ids: ["s1", "s2"] },
	);

	const call = calls.find((c) => c.method === "list");
	assert.ok(call, "list should reach the SDK");
	assert.equal(call.args.type, "memory");
	assert.deepEqual(
		call.args.ids,
		["s1", "s2"],
		"source_ids must reach the wire, not be silently dropped",
	);
});

test("hydradb_list omits ids entirely when source_ids is not given", async () => {
	const { calls } = await listText(
		{ user_memories: [], total: 0 },
		{ kind: "memory" },
	);

	assert.equal(calls.find((c) => c.method === "list")?.args.ids, undefined);
});

// `mcp-conversation-${Date.now()}` collides for two ingests in the same
// millisecond, and because upsert is true the second REPLACES the first while
// reporting success. Nothing surfaces the loss.
test("generated conversation source ids do not collide within a millisecond", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);

	// Issued concurrently so they land in the same millisecond on any machine
	// fast enough to matter — which is the case the old id could not survive.
	await Promise.all(
		Array.from({ length: 20 }, () =>
			client.callTool({
				name: "hydradb_ingest",
				arguments: { turns: [{ user: "hi", assistant: "hello" }] },
			}),
		),
	);

	const ids = calls
		.filter((c) => c.method === "ingest")
		.map((c) => {
			const item = (JSON.parse(String(c.args.memories)) as Record<string, unknown>[])[0]!;
			return String(item.source_id);
		});

	assert.equal(ids.length, 20);
	assert.equal(new Set(ids).size, 20, "every generated source id must be distinct");
	for (const id of ids) {
		assert.match(id, /^mcp-conversation-\d+-[0-9a-f]{8}$/);
	}

	await client.close();
});

test("an explicit source_id is still used verbatim", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);

	await client.callTool({
		name: "hydradb_ingest",
		arguments: {
			turns: [{ user: "hi", assistant: "hello" }],
			source_id: "session-42",
		},
	});

	const item = (
		JSON.parse(String(calls.find((c) => c.method === "ingest")!.args.memories)) as Record<string, unknown>[]
	)[0]!;
	assert.equal(item.source_id, "session-42");

	await client.close();
});

// upsert was hardcoded true with no way to opt out, while PARAM.source_id told
// the caller to reuse a session id — a combination that silently destroys the
// earlier memory. The default stays true (the SDK retries POSTs, and upsert is
// what stops a retry duplicating), but it is now the caller's choice.
test("hydradb_ingest defaults to overwriting, preserving retry safety", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);

	await client.callTool({
		name: "hydradb_ingest",
		arguments: { text: "a note", source_id: "s1" },
	});

	assert.equal(calls.find((c) => c.method === "ingest")?.args.upsert, "true");
	await client.close();
});

test("hydradb_ingest forwards overwrite:false as an opt-out", async () => {
	for (const path of [
		{ text: "a note", source_id: "s1", overwrite: false },
		{
			turns: [{ user: "hi", assistant: "hello" }],
			source_id: "s1",
			overwrite: false,
		},
	]) {
		const { hydra, calls } = mockHydra();
		const client = await connect(hydra);

		await client.callTool({ name: "hydradb_ingest", arguments: path });

		assert.equal(
			calls.find((c) => c.method === "ingest")?.args.upsert,
			"false",
			`overwrite must reach the wire on both ingest paths (${Object.keys(path).join(",")})`,
		);
		await client.close();
	}
});

/** Call hydradb_inspect against a given API response and return the rendered text. */
async function inspectText(
	inspect: unknown,
	args: Record<string, unknown>,
): Promise<string> {
	const { hydra } = mockHydra({ inspect });
	const client = await connect(hydra);
	const result = await client.callTool({ name: "hydradb_inspect", arguments: args });
	await client.close();
	return (result.content as { text: string }[])[0]?.text ?? "";
}

// presignedUrl was never read, so the one mode whose entire purpose is the link
// returned "(no text content)". Documented in the schema and the README, and it
// could not work. There was also no test of runInspect at all.
test("hydradb_inspect returns the download link for mode url", async () => {
	const text = await inspectText(
		{
			success: true,
			presignedUrl: "https://example.invalid/signed",
			content: "the extracted text",
		},
		{ source_id: "s1", mode: "url" },
	);

	assert.match(text, /https:\/\/example\.invalid\/signed/);
	assert.doesNotMatch(
		text,
		/the extracted text/,
		"url mode asks for the link instead of the content",
	);
	assert.doesNotMatch(text, /no text content/);
});

test("hydradb_inspect returns both link and content for mode both", async () => {
	const text = await inspectText(
		{
			success: true,
			presignedUrl: "https://example.invalid/signed",
			content: "the extracted text",
		},
		{ source_id: "s1", mode: "both" },
	);

	assert.match(text, /https:\/\/example\.invalid\/signed/);
	assert.match(text, /the extracted text/);
});

test("hydradb_inspect defaults to content and does not mention a link", async () => {
	const text = await inspectText(
		{
			success: true,
			presignedUrl: "https://example.invalid/signed",
			content: "the extracted text",
		},
		{ source_id: "s1" },
	);

	assert.match(text, /the extracted text/);
	assert.doesNotMatch(text, /example\.invalid/);
});

test("hydradb_inspect says so when a link was asked for and none exists", async () => {
	const text = await inspectText(
		{ success: true, content: "the extracted text" },
		{ source_id: "s1", mode: "url" },
	);

	assert.match(text, /No download URL available/);
});

test("hydradb_inspect reports a soft failure without erroring", async () => {
	const text = await inspectText(
		{ success: false, error: "source not found" },
		{ source_id: "missing" },
	);

	assert.match(text, /Could not fetch source missing/);
	assert.match(text, /source not found/);
});

// hydradb_query searches knowledge, hydradb_list browses it, hydradb_inspect
// reads it and hydradb_delete removes it — and nothing could create it. `kind`
// was pinned to "memory" at both ingest call sites, so the wrapper's entire
// knowledge branch was unreachable. A caller told "index this design doc as
// knowledge" silently produced a memory instead.
test("hydradb_ingest can write knowledge", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);

	const result = await client.callTool({
		name: "hydradb_ingest",
		arguments: { text: "# Design doc\n\nbody", kind: "knowledge", title: "Design" },
	});

	assert.notEqual(result.isError, true);
	const call = calls.find((c) => c.method === "ingest");
	assert.ok(call, "ingest should reach the SDK");
	assert.equal(call.args.type, "knowledge");
	// Knowledge travels as a multipart document, never as a memory item.
	assert.equal(call.args.memories, undefined);
	assert.ok(call.args.documents, "knowledge must be sent as a document part");

	await client.close();
});

test("hydradb_ingest still defaults to memory", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);

	await client.callTool({
		name: "hydradb_ingest",
		arguments: { text: "a note" },
	});

	const call = calls.find((c) => c.method === "ingest");
	assert.equal(call?.args.type, "memory");
	assert.ok(call?.args.memories, "memory must still travel as a memory item");

	await client.close();
});

// The wrapper rejects memory-only params on the knowledge branch; the server
// must not send them itself, or every knowledge write would fail.
test("hydradb_ingest omits memory-only fields when writing knowledge", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);

	const result = await client.callTool({
		name: "hydradb_ingest",
		arguments: { text: "body", kind: "knowledge" },
	});

	assert.notEqual(
		result.isError,
		true,
		"knowledge ingest must not trip the wrapper's memory-only guard",
	);
	await client.close();
});

test("hydradb_ingest refuses to file a conversation as knowledge", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);

	const result = await client.callTool({
		name: "hydradb_ingest",
		arguments: {
			turns: [{ user: "hi", assistant: "hello" }],
			kind: "knowledge",
		},
	});

	assert.equal(result.isError, true);
	assert.match(
		(result.content as { text: string }[])[0]!.text,
		/conversations are memories/,
	);
	assert.equal(calls.filter((c) => c.method === "ingest").length, 0);

	await client.close();
});

// Ingestion is asynchronous — the upload returns when the source is queued, and
// indexing runs through graph extraction for seconds afterwards. A caller that
// saves then immediately queries to confirm gets "No relevant context items
// found" and concludes the save failed, then re-saves — which under upsert
// replaces what it just wrote. The tool result never said any of this.
test("hydradb_ingest warns that indexing is asynchronous", async () => {
	const text = await ingestText(
		{ success: true, successCount: 1, failedCount: 0, message: "", results: [] },
		{ text: "a note" },
	);

	assert.match(text, /asynchronous/i);
	assert.match(text, /hydradb_status/);
});

test("hydradb_status reports per-source indexing state", async () => {
	const { hydra } = mockHydra();
	const client = await connect(hydra);
	// context.status is not part of the Responses override map, so drive it
	// through a purpose-built stub.
	await client.close();

	const sdk = {
		context: {
			status: () =>
				Promise.resolve({
					data: {
						statuses: [
							{ id: "s1", indexingStatus: "completed" },
							{ id: "s2", indexingStatus: "graph_creation" },
							{
								id: "s3",
								indexingStatus: "failed",
								errorMessage: "extraction timed out",
								errorCode: "TIMEOUT",
							},
						],
					},
					success: true,
				}),
		},
	} as unknown as HydraDBClient;
	const client2 = await connect(
		new HydraDB({ token: "t", database: "db_test" }, sdk),
	);

	const result = await client2.callTool({
		name: "hydradb_status",
		arguments: { ids: ["s1", "s2", "s3"] },
	});
	const out = (result.content as { text: string }[])[0]!.text;

	assert.match(out, /s1: completed/);
	assert.match(out, /s2: graph_creation/);
	assert.match(out, /s3: failed .* extraction timed out \[TIMEOUT\]/);
	// graph_creation is not in the SDK's status enum but is a real live value,
	// so it must count as still-in-progress rather than be treated as terminal.
	assert.match(out, /1 still indexing/);

	await client2.close();
});

test("hydradb_status says when everything is settled", async () => {
	const sdk = {
		context: {
			status: () =>
				Promise.resolve({
					data: { statuses: [{ id: "s1", indexingStatus: "completed" }] },
					success: true,
				}),
		},
	} as unknown as HydraDBClient;
	const client = await connect(new HydraDB({ token: "t", database: "db_test" }, sdk));

	const result = await client.callTool({
		name: "hydradb_status",
		arguments: { ids: ["s1"] },
	});

	assert.match(
		(result.content as { text: string }[])[0]!.text,
		/All sources have reached a terminal state/,
	);
	await client.close();
});

// Greptile, PR #46: on a non-first FINAL page, `total > shown` is still true
// (12 shown of 412) and was advertising a page that does not exist.
test("hydradb_list does not advertise a next page on the last page", async () => {
	const { text } = await listText({
		user_memories: Array.from({ length: 12 }, (_, i) => ({
			memory_id: `m${i}`,
			memory_content: "x",
		})),
		total: 412,
		pagination: { page: 9, page_size: 50, total_pages: 9, has_next: false },
	}, { kind: "memory", page: 9 });

	assert.match(text, /12 of 412 \(page 9\)/);
	assert.doesNotMatch(text, /page=10/, "there is no page 10");
	assert.doesNotMatch(text, /for more/);
});

// Same shape, but the server sent no has_next — the page arithmetic has to
// reach the same conclusion.
test("hydradb_list infers the last page from total_pages when has_next is absent", async () => {
	const { text } = await listText({
		user_memories: [{ memory_id: "m1", memory_content: "x" }],
		total: 412,
		pagination: { page: 9, page_size: 50, total_pages: 9 },
	}, { kind: "memory", page: 9 });

	assert.doesNotMatch(text, /for more/);
});

test("hydradb_list still advertises a next page in the middle of a corpus", async () => {
	const { text } = await listText({
		user_memories: Array.from({ length: 50 }, (_, i) => ({
			memory_id: `m${i}`,
			memory_content: "x",
		})),
		total: 412,
		pagination: { page: 2, page_size: 50, total_pages: 9, has_next: true },
	}, { kind: "memory", page: 2 });

	assert.match(text, /page=3 for more/);
});

// `res.content ?? res.contentBase64` with no cap anywhere. contentBase64 is the
// binary fallback and base64 inflates 4/3, so a 1 MB scanned PDF became ~1.4M
// characters in a single call — a whole context window, unrecoverable, from a
// tool annotated readOnlyHint that clients call speculatively.
test("hydradb_inspect never inlines binary content", async () => {
	const text = await inspectText(
		{
			success: true,
			contentBase64: "A".repeat(200_000),
			contentType: "application/pdf",
			sizeBytes: 1_048_576,
			inferredContent: "A scanned quarterly report.",
		},
		{ source_id: "s1" },
	);

	assert.doesNotMatch(text, /A{100}/, "base64 payload must never reach the caller");
	assert.match(text, /binary application\/pdf/);
	assert.match(text, /1048576 bytes/);
	assert.match(text, /mode:"url"/, "must say how to actually get the file");
	// The LLM summary is what the caller usually wanted anyway.
	assert.match(text, /A scanned quarterly report/);
});

test("hydradb_inspect caps long text and says how to continue", async () => {
	const body = "x".repeat(50_000);
	const text = await inspectText(
		{ success: true, content: body },
		{ source_id: "s1" },
	);

	assert.ok(text.length < 25_000, `expected a bounded result, got ${text.length} chars`);
	assert.match(text, /truncated: showing characters 0-20000 of 50000/);
	assert.match(text, /offset=20000/);
});

test("hydradb_inspect honours offset and limit", async () => {
	const body = "abcdefghij".repeat(1000); // 10k chars
	const text = await inspectText(
		{ success: true, content: body },
		{ source_id: "s1", offset: 5000, limit: 100 },
	);

	assert.match(text, /showing characters 5000-5100 of 10000/);
	assert.match(text, /offset=5100/);
});

test("hydradb_inspect returns short content whole, with no truncation noise", async () => {
	const text = await inspectText(
		{ success: true, content: "a short document" },
		{ source_id: "s1" },
	);

	assert.match(text, /a short document/);
	assert.doesNotMatch(text, /truncated/);
});

// text and turns were unbounded. The whole payload is materialised before it is
// sent, so an oversized body is best case a 413 after uploading all of it,
// worst case an OOM in this process.
test("hydradb_ingest rejects oversized text locally", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);

	const result = await client.callTool({
		name: "hydradb_ingest",
		arguments: { text: "x".repeat(1_000_001) },
	});

	assert.equal(result.isError, true);
	assert.match((result.content as { text: string }[])[0]!.text, /at most 1000000 characters/);
	assert.equal(
		calls.filter((c) => c.method === "ingest").length,
		0,
		"an oversized body must not be uploaded before being rejected",
	);

	await client.close();
});

test("hydradb_ingest rejects too many turns locally", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);

	const result = await client.callTool({
		name: "hydradb_ingest",
		arguments: {
			turns: Array.from({ length: 501 }, () => ({ user: "hi", assistant: "hello" })),
		},
	});

	assert.equal(result.isError, true);
	assert.match((result.content as { text: string }[])[0]!.text, /at most 500 turns/);
	assert.equal(calls.filter((c) => c.method === "ingest").length, 0);

	await client.close();
});

test("hydradb_ingest accepts a realistically large document", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);

	const result = await client.callTool({
		name: "hydradb_ingest",
		arguments: { text: "x".repeat(500_000) },
	});

	assert.notEqual(result.isError, true, "the ceiling must not reject ordinary documents");
	assert.equal(calls.filter((c) => c.method === "ingest").length, 1);

	await client.close();
});


/** Call a tool and return both the rendered text and the isError flag. */
async function callRaw(
	responses: Responses,
	name: string,
	args: Record<string, unknown>,
): Promise<{ text: string; isError: unknown }> {
	const { hydra } = mockHydra(responses);
	const client = await connect(hydra);
	const result = await client.callTool({ name, arguments: args });
	await client.close();
	return {
		text: (result.content as { text: string }[])[0]?.text ?? "",
		isError: result.isError,
	};
}

// Three contracts for "it didn't work" used to coexist: thrown errors became
// isError:true, while a failed inspect and a server-REFUSED delete returned
// plain text with isError absent. A client branching on isError read
// "Could NOT delete X - the server refused" as a success.
test("a failed inspect is flagged as an error", async () => {
	const { text, isError } = await callRaw(
		{ inspect: { success: false, error: "source not found" } },
		"hydradb_inspect",
		{ source_id: "missing" },
	);

	assert.equal(isError, true);
	// The wording is deliberate and survives the flag — a thrown error would
	// replace it with something generic.
	assert.match(text, /Could not fetch source missing: source not found/);
});

test("a server-refused delete is flagged as an error", async () => {
	const { text, isError } = await callRaw(
		{
			delete: {
				success: false,
				message: "Source is still processing; retry deletion after ingestion completes",
				deletedCount: 0,
				results: [{ id: "s1", error: "Source is still processing" }],
			},
		},
		"hydradb_delete",
		{ id: "s1", kind: "knowledge" },
	);

	assert.equal(isError, true);
	assert.match(text, /Could NOT delete/);
});

// The benign case is NOT an error: the server succeeded, the id simply is not
// there. Flagging it would push callers to retry something that cannot succeed.
test("a delete that found nothing is not flagged as an error", async () => {
	const { text, isError } = await callRaw(
		{ delete: { success: true, deletedCount: 0 } },
		"hydradb_delete",
		{ id: "mem-1" },
	);

	assert.notEqual(isError, true);
	assert.match(text, /nothing was deleted/i);
});

test("a successful delete is not flagged as an error", async () => {
	const { isError } = await callRaw(
		{ delete: { success: true, userMemoryDeleted: 1 } },
		"hydradb_delete",
		{ id: "mem-1" },
	);

	assert.notEqual(isError, true);
});

// Greptile, PR #47: server.close() tears down the transport but does not wait
// for handlers already running, so SIGTERM during an ingest killed the process
// mid-write — and since a reused source_id replaces, "did it commit?" is not a
// question the caller can settle by retrying.
test("in-flight tool calls are tracked so shutdown can wait for them", async () => {
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});

	const sdk = {
		query: async () => {
			await blocked;
			return { data: { chunks: [] }, success: true };
		},
	} as unknown as HydraDBClient;

	const client = await connect(new HydraDB({ token: "t", database: "db" }, sdk));

	assert.equal(inFlightCount(), 0, "nothing should be in flight before the call");

	const call = client.callTool({ name: "hydradb_query", arguments: { query: "q" } });
	// Let the handler start.
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(inFlightCount(), 1, "the running call must be visible to shutdown");

	// awaitInFlight must not resolve while the handler is still running.
	let drained = false;
	void awaitInFlight().then(() => {
		drained = true;
	});
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(drained, false, "drain resolved while a call was still running");

	release();
	await call;
	await new Promise((r) => setTimeout(r, 10));

	assert.equal(inFlightCount(), 0);
	assert.equal(drained, true, "drain must resolve once the last call finishes");

	await client.close();
});

test("a failing tool call still decrements the in-flight count", async () => {
	const sdk = {
		query: () => Promise.reject(new Error("boom")),
	} as unknown as HydraDBClient;
	const client = await connect(new HydraDB({ token: "t", database: "db" }, sdk));

	await client.callTool({ name: "hydradb_query", arguments: { query: "q" } });

	assert.equal(
		inFlightCount(),
		0,
		"a thrown handler must not leave the process permanently undrainable",
	);
	await client.close();
});

// Greptile, PR #47: the binary branch appended the server's summary without
// applying the budget, so the path that exists to keep this response small
// became its own way of blowing past it.
test("hydradb_inspect bounds the binary summary too", async () => {
	const text = await inspectText(
		{
			success: true,
			contentBase64: "AAAA",
			contentType: "application/pdf",
			sizeBytes: 1024,
			inferredContent: "y".repeat(60_000),
		},
		{ source_id: "s1" },
	);

	assert.ok(text.length < 25_000, `summary must obey the budget, got ${text.length} chars`);
	assert.match(text, /truncated: 60000 chars total/);
});

// Greptile, PR #47: draining alone leaves a window. A call arriving after the
// in-flight counter reaches zero but before the transport closes was accepted
// and then aborted by the close — the caller of an ingest cannot then tell
// whether the write committed, which is exactly what draining exists to prevent.
test("no new tool call is accepted once shutdown has begun", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);

	beginShutdown();
	try {
		const result = await client.callTool({
			name: "hydradb_query",
			arguments: { query: "q" },
		});

		assert.equal(result.isError, true, "a call after shutdown must be refused");
		assert.match(
			(result.content as { text: string }[])[0]!.text,
			/shutting down/i,
		);
		assert.equal(
			calls.length,
			0,
			"a refused call must not reach the API — that write must not happen",
		);
	} finally {
		__resetShutdown();
		await client.close();
	}
});

test("calls are accepted again once the shutdown flag is cleared", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);

	await client.callTool({ name: "hydradb_query", arguments: { query: "q" } });
	assert.equal(calls.length, 1);

	await client.close();
});

/** Tool names advertised by a server built under the given env. */
async function listedTools(legacy: string | undefined): Promise<string[]> {
	const previous = process.env.HYDRADB_MCP_LEGACY_TOOLS;
	if (legacy == null) delete process.env.HYDRADB_MCP_LEGACY_TOOLS;
	else process.env.HYDRADB_MCP_LEGACY_TOOLS = legacy;

	const client = await connect(mockHydra().hydra);
	const { tools } = await client.listTools();
	await client.close();

	if (previous == null) delete process.env.HYDRADB_MCP_LEGACY_TOOLS;
	else process.env.HYDRADB_MCP_LEGACY_TOOLS = previous;
	return tools.map((t) => t.name);
}

// The alias names are systematically better literal matches for how users
// phrase requests than the canonical ones ("search my memory" -> hydra_db_search
// exactly), and picking one costs real capability: hydra_db_ingest_conversation
// cannot set kind, overwrite, title, infer or is_markdown.
test("deprecated aliases are not registered by default", async () => {
	const names = await listedTools(undefined);

	for (const canonical of CANONICAL_TOOL_NAMES) {
		assert.ok(names.includes(canonical), `${canonical} must always be registered`);
	}
	for (const alias of DEPRECATED_TOOL_NAMES) {
		assert.ok(!names.includes(alias), `${alias} must be off by default`);
	}
	// The graph family IS on by default — it is a product surface with no other
	// client exposing it, not a legacy alias.
	assert.equal(
		names.length,
		CANONICAL_TOOL_NAMES.length + GRAPH_TOOL_NAMES.length,
	);
});

test("HYDRADB_MCP_LEGACY_TOOLS restores every alias", async () => {
	const names = await listedTools("1");

	for (const alias of DEPRECATED_TOOL_NAMES) {
		assert.ok(names.includes(alias), `${alias} should return when opted in`);
	}
	assert.equal(
		names.length,
		CANONICAL_TOOL_NAMES.length +
			GRAPH_TOOL_NAMES.length +
			DEPRECATED_TOOL_NAMES.length,
	);
});

test("the legacy opt-in accepts the usual truthy spellings and nothing else", async () => {
	for (const on of ["1", "true", "TRUE", "yes", "on", " 1 "]) {
		assert.ok(legacyToolsEnabled({ HYDRADB_MCP_LEGACY_TOOLS: on }), `"${on}" should enable`);
	}
	for (const off of ["0", "false", "no", "off", "", "maybe"]) {
		assert.ok(
			!legacyToolsEnabled({ HYDRADB_MCP_LEGACY_TOOLS: off }),
			`"${off}" should not enable`,
		);
	}
	assert.ok(!legacyToolsEnabled({}));
});

// The point of the gate is the manifest a client pays for on every conversation.
test("dropping the aliases materially shrinks the tool manifest", async () => {
	const measure = async (legacy: string | undefined) => {
		const previous = process.env.HYDRADB_MCP_LEGACY_TOOLS;
		if (legacy == null) delete process.env.HYDRADB_MCP_LEGACY_TOOLS;
		else process.env.HYDRADB_MCP_LEGACY_TOOLS = legacy;
		const client = await connect(mockHydra().hydra);
		const size = JSON.stringify((await client.listTools()).tools).length;
		await client.close();
		if (previous == null) delete process.env.HYDRADB_MCP_LEGACY_TOOLS;
		else process.env.HYDRADB_MCP_LEGACY_TOOLS = previous;
		return size;
	};

	const lean = await measure(undefined);
	const withAliases = await measure("1");

	assert.ok(
		lean < withAliases * 0.75,
		`expected a substantial reduction, got ${lean} vs ${withAliases} chars`,
	);
});

// `hydradb_list({})` returned memories only and read as the complete inventory,
// so a caller asking "what does Hydra DB have?" never saw the knowledge corpus —
// which hydradb_query searches by default. `kind` also meant three different
// things across three tools (query defaults to `all`, list and delete to
// `memory`), so a model that learned "kind covers everything" from query read an
// empty-of-knowledge listing as proof no knowledge exists.
//
// `kind` is optional again (PRO-1618) because a UNIFIED database has no corpus
// to choose between: requiring one there means naming a kind the server refuses.
// The original fix survives the change — on a SPLIT database an omitted kind
// still lists memories, and now says out loud that it did not cover knowledge,
// so the listing can no longer be read as the complete inventory.
test("hydradb_list without kind lists memories and names the corpus it did not cover", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);

	const result = await client.callTool({ name: "hydradb_list", arguments: {} });

	assert.notEqual(result.isError, true);
	const listCalls = calls.filter((c) => c.method === "list");
	assert.equal(listCalls.length, 1);
	assert.equal(listCalls[0]!.args.type, "memory", "a split database keeps the old default");
	assert.match(
		(result.content as { text: string }[])[0]?.text ?? "",
		/knowledge is a separate corpus/i,
		"a memory-only listing must not read as the whole store",
	);

	await client.close();
});

// The note is for a kind the HOST chose. A caller who asked for memories knows
// what they asked for, and telling them again is noise on every page.
test("hydradb_list does not add the corpus note when the caller named the kind", async () => {
	const { text } = await listText(
		{ user_memories: [{ memory_id: "m1", memory_content: "prefers tabs" }], total: 1 },
		{ kind: "memory" },
	);
	assert.doesNotMatch(text, /separate corpus/i);
});

// The whole point of making it optional: a unified database resolves to its one
// corpus with no failed request and no kind for the model to invent.
test("hydradb_list without kind lists unified on a unified database", async () => {
	const { hydra, raw } = mockHydraWithLayout("unified");
	const client = await connect(hydra);
	const res = await client.callTool({ name: "hydradb_list", arguments: {} });
	assert.notEqual(res.isError, true);
	assert.equal((raw.find((c) => c.path === "/context/list")!.body as { type: string }).type, "unified");
	assert.equal((res.structuredContent as { kind: string }).kind, "unified");
	await client.close();
});

test("hydradb_list still serves each family when kind is given", async () => {
	for (const kind of ["memory", "knowledge"] as const) {
		const { calls } = await listText(
			{ user_memories: [], sources: [], total: 0 },
			{ kind },
		);
		assert.equal(calls.find((c) => c.method === "list")?.args.type, kind);
	}
});

// `title` is the ONLY per-chunk label buildRecalledContext renders, so the old
// constant default meant fifty untitled saves produced fifty recall results all
// reading "Source: MCP Memory" — no way to cite a fact's origin, or to tell two
// chunks apart.
test("hydradb_ingest derives a title instead of stamping a constant", async () => {
	const cases: [string, string][] = [
		["Prefers tabs over spaces in every language.", "Prefers tabs over spaces in every language."],
		["# Restart runbook\n\nRestart order: api, worker.", "Restart runbook"],
		["   \n  \n", "Untitled note"],
	];

	for (const [text, expected] of cases) {
		const { hydra, calls } = mockHydra();
		const client = await connect(hydra);
		await client.callTool({ name: "hydradb_ingest", arguments: { text } });

		const item = (
			JSON.parse(String(calls.find((c) => c.method === "ingest")!.args.memories)) as Record<string, unknown>[]
		)[0]!;
		assert.equal(item.title, expected, `title derived from: ${JSON.stringify(text)}`);
		assert.notEqual(item.title, "MCP Memory");
		await client.close();
	}
});

test("a long first line is truncated rather than used whole as a title", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);
	await client.callTool({
		name: "hydradb_ingest",
		arguments: { text: `${"word ".repeat(40)}\nsecond line` },
	});

	const item = (
		JSON.parse(String(calls.find((c) => c.method === "ingest")!.args.memories)) as Record<string, unknown>[]
	)[0]!;
	assert.ok(String(item.title).length <= 61, `title too long: ${item.title}`);
	assert.match(String(item.title), /…$/);
	await client.close();
});

test("an explicit title always wins", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);
	await client.callTool({
		name: "hydradb_ingest",
		arguments: { text: "# Heading\n\nbody", title: "Deployment rollback policy" },
	});

	const item = (
		JSON.parse(String(calls.find((c) => c.method === "ingest")!.args.memories)) as Record<string, unknown>[]
	)[0]!;
	assert.equal(item.title, "Deployment rollback policy");
	await client.close();
});

// `destructiveHint` was absent from the register() annotations type, so no tool
// could declare it — and the MCP spec defaults it to TRUE for any non-readonly
// tool. A spec-following host therefore read hydradb_ingest as destructive and
// could prompt before every proactive save, killing the behaviour the
// instructions ask for. hydradb_delete meanwhile was destructive only by
// absence, one refactor away from flipping.
test("every tool declares all four behaviour hints explicitly", async () => {
	process.env.HYDRADB_MCP_LEGACY_TOOLS = "1";
	const client = await connect(mockHydra().hydra);
	const { tools } = await client.listTools();
	delete process.env.HYDRADB_MCP_LEGACY_TOOLS;

	for (const tool of tools) {
		const a = tool.annotations ?? {};
		for (const hint of [
			"readOnlyHint",
			"destructiveHint",
			"idempotentHint",
			"openWorldHint",
		] as const) {
			assert.equal(
				typeof a[hint],
				"boolean",
				`${tool.name} must state ${hint} rather than inherit a default`,
			);
		}
	}
	await client.close();
});

test("reads are read-only, writes are not, and only deletes are destructive", async () => {
	process.env.HYDRADB_MCP_LEGACY_TOOLS = "1";
	const client = await connect(mockHydra().hydra);
	const { tools } = await client.listTools();
	delete process.env.HYDRADB_MCP_LEGACY_TOOLS;

	const hint = (name: string) =>
		tools.find((t) => t.name === name)!.annotations as Record<string, boolean>;

	for (const name of [
		"hydradb_query",
		"hydradb_list",
		"hydradb_inspect",
		"hydradb_status",
	]) {
		assert.equal(hint(name).readOnlyHint, true, `${name} should be read-only`);
		assert.equal(hint(name).destructiveHint, false);
	}

	// Ingest writes but never removes; a host must not gate it behind a
	// destructive-action prompt.
	for (const name of ["hydradb_ingest", "hydra_db_store", "hydra_db_ingest_conversation"]) {
		assert.equal(hint(name).readOnlyHint, false, `${name} writes`);
		assert.equal(
			hint(name).destructiveHint,
			false,
			`${name} adds context and must not read as destructive`,
		);
	}

	for (const name of ["hydradb_delete", "hydra_db_delete_memory"]) {
		assert.equal(hint(name).destructiveHint, true, `${name} removes data irreversibly`);
	}

	await client.close();
});

// CONTRACT §1 says a source's identifier field is `id`, but one concept was
// spelled three ways across tools designed to chain: inspect took `source_id`,
// list took `source_ids`, delete took `id`.
test("hydradb_inspect accepts the canonical id and the old spelling", async () => {
	for (const args of [{ id: "s1" }, { source_id: "s1" }]) {
		const { hydra, calls } = mockHydra({ inspect: { success: true, content: "body" } });
		const client = await connect(hydra);
		const result = await client.callTool({ name: "hydradb_inspect", arguments: args });

		assert.notEqual(result.isError, true, `should accept ${JSON.stringify(args)}`);
		assert.equal(calls.find((c) => c.method === "inspect")?.args.id, "s1");
		await client.close();
	}
});

test("hydradb_inspect says where an id comes from when none is given", async () => {
	const { hydra } = mockHydra();
	const client = await connect(hydra);
	const result = await client.callTool({ name: "hydradb_inspect", arguments: {} });

	assert.equal(result.isError, true);
	const text = (result.content as { text: string }[])[0]!.text;
	assert.match(text, /requires `id`/);
	assert.match(text, /hydradb_query|hydradb_list/);
	await client.close();
});

test("hydradb_list accepts ids and the old source_ids spelling", async () => {
	for (const key of ["ids", "source_ids"] as const) {
		const { calls } = await listText(
			{ user_memories: [], total: 0 },
			{ kind: "memory", [key]: ["s1", "s2"] },
		);
		assert.deepEqual(calls.find((c) => c.method === "list")?.args.ids, ["s1", "s2"]);
	}
});

// The query path marks truncation with "..."; the listing did not, so a caller
// read a half sentence as a whole fact.
test("hydradb_list marks a truncated memory row", async () => {
	const { text } = await listText(
		{
			user_memories: [{ memory_id: "m1", memory_content: "x".repeat(300) }],
			total: 1,
		},
		{ kind: "memory" },
	);

	assert.match(text, /x{150}\.\.\./, "a truncated row must say it was truncated");
});

test("hydradb_list does not add an ellipsis to a short row", async () => {
	const { text } = await listText(
		{ user_memories: [{ memory_id: "m1", memory_content: "short fact" }], total: 1 },
		{ kind: "memory" },
	);

	assert.match(text, /\[m1\] short fact/);
	assert.doesNotMatch(text, /short fact\.\.\./);
});

// Every handler returned prose only, so a caller wanting an id had to pull it
// out of a sentence. structuredContent hands the same facts over already parsed.
test("hydradb_list returns structured items alongside the text", async () => {
	const { hydra } = mockHydra({
		list: {
			user_memories: [
				{ memory_id: "m1", memory_content: "prefers tabs" },
				{ memory_id: "m2", memory_content: "deploys Tuesdays" },
			],
			total: 412,
			pagination: { page: 1, page_size: 2, total_pages: 206, has_next: true },
		},
	});
	const client = await connect(hydra);
	const result = await client.callTool({
		name: "hydradb_list",
		arguments: { kind: "memory" },
	});
	await client.close();

	const structured = result.structuredContent as Record<string, unknown>;
	assert.ok(structured, "list should return structuredContent");
	assert.equal(structured.kind, "memory");
	assert.equal(structured.shown, 2);
	assert.equal(structured.total, 412);
	assert.equal(structured.has_more, true);
	assert.deepEqual((structured.items as { id: string }[]).map((i) => i.id), ["m1", "m2"]);

	// The prose must survive for hosts that ignore structured output.
	assert.match((result.content as { text: string }[])[0]!.text, /2 of 412/);
});

test("hydradb_ingest returns the created id as structured data", async () => {
	const { hydra } = mockHydra({
		ingest: {
			success: true,
			successCount: 1,
			failedCount: 0,
			results: [{ id: "srv-9", status: "completed", error: "" }],
		},
	});
	const client = await connect(hydra);
	const result = await client.callTool({
		name: "hydradb_ingest",
		arguments: { text: "a note" },
	});
	await client.close();

	const structured = result.structuredContent as Record<string, unknown>;
	assert.equal(structured.id, "srv-9");
	assert.equal(structured.success_count, 1);
	assert.equal(structured.failed_count, 0);
	// Indexing is asynchronous, so a caller that wants to confirm must poll.
	assert.equal(structured.indexing_pending, true);
});

test("hydradb_delete reports its outcome as structured data", async () => {
	const cases: [Record<string, unknown>, boolean][] = [
		[{ success: true, userMemoryDeleted: 1 }, true],
		[{ success: true, deletedCount: 0 }, false],
	];

	for (const [response, expected] of cases) {
		const { hydra } = mockHydra({ delete: response });
		const client = await connect(hydra);
		const result = await client.callTool({
			name: "hydradb_delete",
			arguments: { id: "m1", kind: "memory" },
		});
		await client.close();

		const structured = result.structuredContent as Record<string, unknown>;
		// `ids` is plural now — delete takes an array, as the SDK always did.
		assert.deepEqual(structured.ids, ["m1"]);
		assert.equal(structured.kind, "memory");
		assert.equal(
			structured.deleted,
			expected,
			`deleted flag for ${JSON.stringify(response)}`,
		);
	}
});

// An empty result is still a result; a caller branching on `items` should not
// have to special-case it.
test("an empty listing still carries structured content", async () => {
	const { hydra } = mockHydra({ list: { user_memories: [], total: 0 } });
	const client = await connect(hydra);
	const result = await client.callTool({
		name: "hydradb_list",
		arguments: { kind: "memory" },
	});
	await client.close();

	const structured = result.structuredContent as Record<string, unknown>;
	assert.deepEqual(structured.items, []);
	assert.equal(structured.has_more, false);
});

// Greptile, PR #48: the structured payload carried every memory_content in
// full while the prose beside it showed 150 characters per row — so a host
// consuming structured output got megabytes from a routine inventory call.
// Structured output is a different encoding of the same answer, not a bypass
// of its limits.
test("structured list items are bounded like the text preview", async () => {
	const { hydra } = mockHydra({
		list: {
			user_memories: Array.from({ length: 20 }, (_, i) => ({
				memory_id: `m${i}`,
				memory_content: "x".repeat(5000),
			})),
			total: 20,
		},
	});
	const client = await connect(hydra);
	const result = await client.callTool({
		name: "hydradb_list",
		arguments: { kind: "memory" },
	});
	await client.close();

	const items = (result.structuredContent as { items: { content: string }[] }).items;
	for (const item of items) {
		assert.ok(
			item.content.length <= 153,
			`structured content must be previewed, got ${item.content.length} chars`,
		);
	}
	assert.ok(JSON.stringify(items).length < 5000, "the whole payload must stay small");
});

// Silently picking one of two conflicting values means acting on a target the
// caller did not ask for — and for delete, that target gets destroyed.
test("hydradb_inspect rejects conflicting id and source_id", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);
	const result = await client.callTool({
		name: "hydradb_inspect",
		arguments: { id: "wanted", source_id: "different" },
	});
	await client.close();

	assert.equal(result.isError, true);
	assert.match((result.content as { text: string }[])[0]!.text, /different values/);
	assert.equal(calls.filter((c) => c.method === "inspect").length, 0);
});

test("matching id and source_id are accepted", async () => {
	const { hydra, calls } = mockHydra({ inspect: { success: true, content: "body" } });
	const client = await connect(hydra);
	const result = await client.callTool({
		name: "hydradb_inspect",
		arguments: { id: "same", source_id: "same" },
	});
	await client.close();

	assert.notEqual(result.isError, true);
	assert.equal(calls.find((c) => c.method === "inspect")?.args.id, "same");
});

test("hydradb_list rejects conflicting ids and source_ids", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);
	const result = await client.callTool({
		name: "hydradb_list",
		arguments: { kind: "memory", ids: ["a"], source_ids: ["b"] },
	});
	await client.close();

	assert.equal(result.isError, true);
	assert.equal(calls.filter((c) => c.method === "list").length, 0);
});

// Greptile, PR #48: `ids` and `source_ids` are filters, so order carries no
// meaning. Comparing them as serialized arrays rejected a request that asked for
// exactly one thing.
test("hydradb_list accepts the same ids in a different order", async () => {
	const { calls } = await listText(
		{ user_memories: [], total: 0 },
		{ kind: "memory", ids: ["a", "b"], source_ids: ["b", "a"] },
	);

	const call = calls.find((c) => c.method === "list");
	assert.ok(call, "an equivalent filter must not be rejected");
	assert.deepEqual(call.args.ids, ["a", "b"]);
});

test("hydradb_list still rejects genuinely different id sets", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);
	const result = await client.callTool({
		name: "hydradb_list",
		arguments: { kind: "memory", ids: ["a", "b"], source_ids: ["a", "c"] },
	});
	await client.close();

	assert.equal(result.isError, true);
	assert.equal(calls.filter((c) => c.method === "list").length, 0);
});

// Greptile, PR #48: comparing lengths and union size called ["a","b"] and
// ["a","a"] equivalent, so the handler silently listed records the deprecated
// filter had excluded.
test("hydradb_list rejects id sets that differ only by repetition", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);
	const result = await client.callTool({
		name: "hydradb_list",
		arguments: { kind: "memory", ids: ["a", "b"], source_ids: ["a", "a"] },
	});
	await client.close();

	assert.equal(result.isError, true, "these filters ask for different things");
	assert.equal(calls.filter((c) => c.method === "list").length, 0);
});

test("a repeated id is still the same filter as the id alone", async () => {
	const { calls } = await listText(
		{ user_memories: [], total: 0 },
		{ kind: "memory", ids: ["a", "a"], source_ids: ["a"] },
	);

	assert.ok(
		calls.find((c) => c.method === "list"),
		"{a} and {a} are the same set and must not be rejected",
	);
});

/** Query against a synthetic result set of `n` long chunks. */
function longChunks(n: number, chars = 3000) {
	return {
		chunks: Array.from({ length: n }, (_, i) => ({
			chunkUuid: `c${i}`,
			id: `s${i}`,
			chunkContent: `body-${i} start. ` + "x".repeat(chars),
			sourceTitle: `Doc ${i}`,
			relevancyScore: 0.9,
			extraContextIds: [`e${i}`],
		})),
		additionalContext: Object.fromEntries(
			Array.from({ length: n }, (_, i) => [
				`e${i}`,
				{ chunkUuid: `e${i}`, id: `x${i}`, chunkContent: `extra ${i} ` + "y".repeat(700) },
			]),
		),
	};
}

async function queryText(args: Record<string, unknown>, chunks = longChunks(10)) {
	const { hydra } = mockHydra({ query: chunks });
	const client = await connect(hydra);
	const result = await client.callTool({ name: "hydradb_query", arguments: args });
	await client.close();
	return (result.content as { text: string }[])[0]!.text;
}

// Chunk bodies were rendered at full length with no cap of any kind.
test("hydradb_query defaults to compact and trims chunk bodies", async () => {
	const text = await queryText({ query: "q" });

	assert.match(text, /chunk truncated/);
	assert.doesNotMatch(text, /Extra Context/, "compact omits surrounding-context blocks");
	// Still shows every chunk — compact trims, it does not drop matches.
	assert.equal(text.match(/Chunk \d+/g)?.length, 10);
});

test("detail:full restores whole chunk bodies and extra context", async () => {
	const text = await queryText({ query: "q", detail: "full" });

	assert.doesNotMatch(text, /chunk truncated/);
	assert.match(text, /Extra Context/);
});

test("compact is materially smaller than full", async () => {
	const compact = await queryText({ query: "q" });
	const full = await queryText({ query: "q", detail: "full" });

	assert.ok(
		compact.length < full.length * 0.4,
		`expected a large reduction, got ${compact.length} vs ${full.length}`,
	);
});

// A per-chunk cap does not bound the whole: many capped chunks still add up.
test("hydradb_query caps the total response even in full detail", async () => {
	const text = await queryText(
		{ query: "q", detail: "full", max_results: 50 },
		longChunks(50, 5000),
	);

	assert.ok(text.length < 45_000, `expected a bounded response, got ${text.length}`);
	assert.match(text, /response truncated: showing \d+ of 50 chunks/);
	assert.match(text, /hydradb_inspect/, "must say how to get a source in full");

	// Greptile, PR #49: the header must count what survived truncation, not what
	// went in — otherwise it promises source ids the body does not contain.
	const announced = Number(text.match(/Found (\d+) /)?.[1]);
	const rendered = (text.match(/^Chunk \d+/gm) ?? []).length;
	assert.equal(announced, rendered, "header must match the chunks actually shown");
	assert.ok(rendered < 50, "the budget should have dropped some chunks");

	// And it must never cut a chunk header in half.
	assert.doesNotMatch(text, /\[id: [^\]]*$/, "a severed id must not be left danging");
});

// A live call with max_results=10 returned 15 chunks, and all 15 were rendered.
test("max_results actually bounds what is rendered", async () => {
	const text = await queryText({ query: "q", max_results: 3 }, longChunks(15, 200));

	assert.equal(
		text.match(/Chunk \d+/g)?.length,
		3,
		"the server may return more than asked for; the tool must not render them",
	);
	assert.match(text, /Found 3 /);
});

// Greptile, PR #49: the header and legend were appended after the renderer had
// applied its ceiling, so the finished response exceeded the documented limit.
test("the whole query response stays within the documented ceiling", async () => {
	const text = await queryText(
		{ query: "q", detail: "full", max_results: 50 },
		longChunks(50, 5000),
	);

	// 40k is the documented ceiling for the response the caller receives, not
	// for one component of it.
	assert.ok(
		text.length <= 40_000,
		`the finished response must fit the ceiling, got ${text.length}`,
	);
	// The framing that has to fit is still present.
	assert.match(text, /^Found \d+ /);
	assert.match(text, /hydradb_inspect/);
});

// Three params the wrapper already forwarded and the tool layer never offered.
test("hydradb_query forwards operator to the wire", async () => {
	for (const operator of ["or", "and", "phrase"] as const) {
		const { hydra, calls } = mockHydra();
		const client = await connect(hydra);
		await client.callTool({
			name: "hydradb_query",
			arguments: { query: "invoice OR receipt", operator },
		});
		assert.equal(calls.find((c) => c.method === "query")?.args.operator, operator);
		await client.close();
	}
});

// Shipped in 1.2.0: `operator` reached the wire without `query_by`, and the API
// answers that combination with
//   400: INVALID_INPUT: operator is only valid with query_by=text
// so every call that set the parameter failed. The operator now carries the
// retrieval method it requires.
test("hydradb_query sends query_by=text whenever an operator is set", async () => {
	for (const operator of ["or", "and", "phrase"] as const) {
		const { hydra, calls } = mockHydra();
		const client = await connect(hydra);
		const result = await client.callTool({
			name: "hydradb_query",
			arguments: { query: "ECONNRESET on deploy", operator },
		});

		assert.notEqual(result.isError, true, `operator ${operator} must be usable`);
		const args = calls.find((c) => c.method === "query")?.args;
		assert.equal(args?.queryBy, "text", `operator ${operator} needs query_by=text`);
		// alpha weighs dense against sparse retrieval in hybrid mode; there is no
		// such balance to strike on a text query, so the host default is not
		// injected there.
		assert.equal(args?.alpha, undefined, "hybrid-only alpha must not ride along");
		await client.close();
	}
});

test("hydradb_query stays on hybrid retrieval when no operator is set", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);
	await client.callTool({ name: "hydradb_query", arguments: { query: "q" } });

	const args = calls.find((c) => c.method === "query")?.args;
	// Omitted, not "hybrid": the API's own default is hybrid, and stating it
	// would make this server the owner of a default it never chose.
	assert.equal(args?.queryBy, undefined, "a plain query must not force text retrieval");
	assert.equal(args?.alpha, 0.8, "the hybrid weighting default still applies");
	await client.close();
});

test("hydradb_query accepts mode auto", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);
	const result = await client.callTool({
		name: "hydradb_query",
		arguments: { query: "q", mode: "auto" },
	});

	assert.notEqual(result.isError, true, "auto is a real SDK mode and must be accepted");
	assert.equal(calls.find((c) => c.method === "query")?.args.mode, "auto");
	await client.close();
});

test("hydradb_inspect forwards expiry_seconds", async () => {
	const { hydra, calls } = mockHydra({
		inspect: { success: true, presignedUrl: "https://example.invalid/x" },
	});
	const client = await connect(hydra);
	await client.callTool({
		name: "hydradb_inspect",
		arguments: { id: "s1", mode: "url", expiry_seconds: 300 },
	});

	assert.equal(calls.find((c) => c.method === "inspect")?.args.expirySeconds, 300);
	await client.close();
});

// The SDK and the wrapper both took `ids: string[]`; only the tool layer
// singularised it, so cleaning up N stale entries cost N round trips.
test("hydradb_delete removes several ids in one call", async () => {
	const { hydra, calls } = mockHydra({
		delete: { success: true, deletedCount: 3 },
	});
	const client = await connect(hydra);
	const result = await client.callTool({
		name: "hydradb_delete",
		arguments: { ids: ["a", "b", "c"], kind: "memory" },
	});
	await client.close();

	assert.deepEqual(calls.find((c) => c.method === "delete")?.args.ids, ["a", "b", "c"]);
	const structured = result.structuredContent as Record<string, unknown>;
	assert.equal(structured.deleted_count, 3);
	assert.notEqual(structured.partial, true);
});

// Saying "Deleted" over a partial result is the overstatement this whole branch
// of work exists to remove.
test("hydradb_delete reports a partial removal as partial", async () => {
	const { hydra } = mockHydra({ delete: { success: true, deletedCount: 1 } });
	const client = await connect(hydra);
	const result = await client.callTool({
		name: "hydradb_delete",
		arguments: { ids: ["a", "b", "c"], kind: "memory" },
	});
	await client.close();

	const text = (result.content as { text: string }[])[0]!.text;
	assert.match(text, /Deleted 1 of 3/);
	assert.match(text, /rest were not found/i);
	assert.equal((result.structuredContent as Record<string, unknown>).partial, true);
});

test("hydradb_delete still accepts a single id", async () => {
	const { hydra, calls } = mockHydra({ delete: { success: true, userMemoryDeleted: 1 } });
	const client = await connect(hydra);
	const result = await client.callTool({
		name: "hydradb_delete",
		arguments: { id: "solo", kind: "memory" },
	});
	await client.close();

	assert.deepEqual(calls.find((c) => c.method === "delete")?.args.ids, ["solo"]);
	assert.match((result.content as { text: string }[])[0]!.text, /Deleted memory: solo/);
});

test("hydradb_delete says where ids come from when given none", async () => {
	const { hydra } = mockHydra();
	const client = await connect(hydra);
	const result = await client.callTool({ name: "hydradb_delete", arguments: {} });
	await client.close();

	assert.equal(result.isError, true);
	const text = (result.content as { text: string }[])[0]!.text;
	assert.match(text, /do not guess one/);
});

// A hard pre-filter: the SDK returns nothing rather than widening when none of
// the ids match, which is what makes "search inside these documents" reliable.
test("hydradb_query forwards source_ids as a retrieval filter", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);
	await client.callTool({
		name: "hydradb_query",
		arguments: { query: "auth flow", source_ids: ["doc-1", "doc-2"] },
	});

	assert.deepEqual(calls.find((c) => c.method === "query")?.args.ids, ["doc-1", "doc-2"]);
	await client.close();
});

test("hydradb_query forwards metadata filters and related-chunk count", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);
	await client.callTool({
		name: "hydradb_query",
		arguments: {
			query: "q",
			metadata_filters: { team: "platform" },
			num_related_chunks: 2,
		},
	});

	const call = calls.find((c) => c.method === "query");
	assert.deepEqual(call?.args.metadataFilters, { team: "platform" });
	assert.equal(call?.args.numRelatedChunks, 2);
	await client.close();
});

// Each related chunk multiplies response size, so the ceiling is deliberate.
test("num_related_chunks is capped", async () => {
	const { hydra } = mockHydra();
	const client = await connect(hydra);
	const result = await client.callTool({
		name: "hydradb_query",
		arguments: { query: "q", num_related_chunks: 50 },
	});

	assert.equal(result.isError, true);
	await client.close();
});

test("none of the new query filters are sent when unset", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);
	await client.callTool({ name: "hydradb_query", arguments: { query: "q" } });

	const call = calls.find((c) => c.method === "query");
	assert.equal(call?.args.ids, undefined);
	assert.equal(call?.args.metadataFilters, undefined);
	assert.equal(call?.args.numRelatedChunks, undefined);
	await client.close();
});

// The backend accepts these on the memory item, and the generated SDK request
// type does not declare them — so they were invisible from the wrapper up.
// A metadata FILTER over keys the caller cannot create is close to useless, so
// this and query's metadata_filters only pay off together.
test("hydradb_ingest sends metadata and observation_date", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);
	await client.callTool({
		name: "hydradb_ingest",
		arguments: {
			text: "Chose Atlas for schema migrations.",
			metadata: { project: "hydradb", kind: "decision" },
			observation_date: "2026-03-14",
		},
	});

	const item = (
		JSON.parse(String(calls.find((c) => c.method === "ingest")!.args.memories)) as Record<string, unknown>[]
	)[0]!;
	assert.deepEqual(item.metadata, { project: "hydradb", kind: "decision" });
	assert.equal(item.observation_date, "2026-03-14");
	await client.close();
});

test("metadata keys are omitted entirely when not provided", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);
	await client.callTool({ name: "hydradb_ingest", arguments: { text: "a note" } });

	const item = (
		JSON.parse(String(calls.find((c) => c.method === "ingest")!.args.memories)) as Record<string, unknown>[]
	)[0]!;
	assert.ok(!("metadata" in item), "an absent field must not be sent as null");
	assert.ok(!("observation_date" in item));
	await client.close();
});

// The tool description used to say "RFC3339", and the API answers a date-time
// with `400 INVALID_INPUT: … is not a valid ISO-8601 date (want YYYY-MM-DD)`.
// A model writing a date in JSON reaches for the date-time form, so the date
// part is kept rather than the whole call being lost to a remote 400.
test("an ISO date-time observation_date is kept as its calendar date", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);
	await client.callTool({
		name: "hydradb_ingest",
		arguments: {
			text: "Shipped the v2 ingest path.",
			observation_date: "2026-08-17T00:00:00Z",
		},
	});

	const item = (
		JSON.parse(String(calls.find((c) => c.method === "ingest")!.args.memories)) as Record<string, unknown>[]
	)[0]!;
	assert.equal(item.observation_date, "2026-08-17");
	await client.close();
});

// Trimming is textual: converting to UTC first would move this to the 18th and
// record a day the caller never named.
test("a date-time with an offset keeps the date the caller wrote", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);
	await client.callTool({
		name: "hydradb_ingest",
		arguments: { text: "a note", observation_date: "2026-08-17T23:00:00-08:00" },
	});

	const item = (
		JSON.parse(String(calls.find((c) => c.method === "ingest")!.args.memories)) as Record<string, unknown>[]
	)[0]!;
	assert.equal(item.observation_date, "2026-08-17");
	await client.close();
});

// Rejected here, not by the API: the caller gets the format in the error and
// nothing leaves the process.
test("a non-date observation_date is rejected before the request goes out", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);
	const result = await client.callTool({
		name: "hydradb_ingest",
		arguments: { text: "a note", observation_date: "last Tuesday" },
	});

	assert.equal(result.isError, true);
	assert.match((result.content as { text: string }[])[0]!.text, /YYYY-MM-DD/);
	assert.equal(
		calls.find((c) => c.method === "ingest"),
		undefined,
		"an invalid date must not reach the API",
	);
	await client.close();
});

// The constraint has to reach the model that is choosing the value, not just
// the handler that receives it.
test("observation_date advertises its format in the input schema", async () => {
	const client = await connect(mockHydra().hydra);
	const { tools } = await client.listTools();
	await client.close();

	const properties = tools.find((t) => t.name === "hydradb_ingest")!.inputSchema
		.properties as Record<string, { pattern?: string; description?: string }>;
	const observationDate = properties.observation_date!;

	assert.ok(
		observationDate.pattern != null,
		"the schema should carry the accepted date pattern",
	);
	const pattern = new RegExp(observationDate.pattern);
	assert.ok(pattern.test("2026-07-04"), "a calendar date is the documented form");
	assert.ok(pattern.test("2026-07-04T00:00:00Z"), "a date-time is accepted too");
	assert.ok(!pattern.test("last Tuesday"));
	assert.match(String(observationDate.description), /YYYY-MM-DD/);
});

// They belong to the memory item shape, so the knowledge branch must reject
// them rather than drop them — same rule as every other memory-only field.
test("knowledge ingest rejects metadata rather than dropping it", async () => {
	const { hydra } = mockHydra();
	const client = await connect(hydra);
	const result = await client.callTool({
		name: "hydradb_ingest",
		arguments: { text: "doc body", kind: "knowledge", metadata: { a: 1 } },
	});

	assert.equal(result.isError, true);
	assert.match((result.content as { text: string }[])[0]!.text, /metadata/);
	await client.close();
});

// Greptile, PR #50: `userMemoryDeleted` is a BOOLEAN, not a count. Treating it
// as 1 turned a successful 3-id delete that reported only that flag into
// "Deleted 1 of 3 … partial" — understating the result exactly as badly as
// claiming success over a partial removal would overstate it.
test("a boolean-only delete response is not reported as partial", async () => {
	const { hydra } = mockHydra({ delete: { success: true, userMemoryDeleted: true } });
	const client = await connect(hydra);
	const result = await client.callTool({
		name: "hydradb_delete",
		arguments: { ids: ["a", "b", "c"], kind: "memory" },
	});
	await client.close();

	const text = (result.content as { text: string }[])[0]!.text;
	const structured = result.structuredContent as Record<string, unknown>;

	assert.doesNotMatch(text, /1 of 3/, "a flag is not a count of one");
	assert.notEqual(structured.partial, true);
	assert.equal(structured.deleted, true);

	// Greptile, PR #50 (second pass): nor is it a count of three. Substituting
	// ids.length overstates a partial removal as complete success, which is the
	// same fabrication in the other direction. An unknown count is reported as
	// unknown.
	assert.equal(structured.deleted_count, undefined, "must not invent a count");
	assert.equal(structured.deleted_count_known, false);
	assert.match(text, /did not say how many/);
	assert.match(text, /hydradb_list/, "must say how to find out");
});

// A real count still drives the partial report.
test("an explicit count still distinguishes partial from complete", async () => {
	for (const [deletedCount, partial] of [
		[3, false],
		[1, true],
	] as const) {
		const { hydra } = mockHydra({ delete: { success: true, deletedCount } });
		const client = await connect(hydra);
		const result = await client.callTool({
			name: "hydradb_delete",
			arguments: { ids: ["a", "b", "c"], kind: "memory" },
		});
		await client.close();

		const structured = result.structuredContent as Record<string, unknown>;
		assert.equal(structured.deleted_count, deletedCount);
		assert.equal(structured.partial === true, partial, `count ${deletedCount}`);
	}
});

// ---------------------------------------------------------------------------
// API failure paths.
//
// No test anywhere exercised a failing API call. That is precisely why the
// unbounded-inspect problem and the broken mode:"url" both shipped — runInspect
// had no coverage at all — and why nobody noticed that a failing call reaches
// the caller as a raw wrapper message.
// ---------------------------------------------------------------------------

/** A client whose every SDK call rejects with the given error. */
async function failingClient(error: unknown) {
	const reject = () => Promise.reject(error);
	const sdk = {
		query: reject,
		context: { ingest: reject, list: reject, inspect: reject, delete: reject, status: reject },
	} as unknown as HydraDBClient;
	return connect(new HydraDB({ token: "t", database: "db" }, sdk));
}

const FAILING_CALLS: [string, Record<string, unknown>][] = [
	["hydradb_query", { query: "q" }],
	["hydradb_ingest", { text: "a note" }],
	["hydradb_list", { kind: "memory" }],
	["hydradb_inspect", { id: "s1" }],
	["hydradb_delete", { ids: ["s1"] }],
	["hydradb_status", { ids: ["s1"] }],
];

for (const status of [401, 403, 429, 500]) {
	test(`every tool reports a ${status} as an error rather than a result`, async () => {
		const client = await failingClient(
			new HydraDBError({ statusCode: status, body: { error: { code: "E", message: "nope" } } }),
		);

		for (const [name, args] of FAILING_CALLS) {
			const result = await client.callTool({ name, arguments: args });
			assert.equal(result.isError, true, `${name} must flag a ${status} as an error`);
			const text = (result.content as { text: string }[])[0]!.text;
			assert.match(text, /Hydra DB/, `${name} should name the upstream`);
			assert.match(text, new RegExp(String(status)), `${name} should carry the status`);
		}

		await client.close();
	});
}

test("a transport failure with no status is still reported", async () => {
	const client = await failingClient(new Error("fetch failed"));

	const result = await client.callTool({ name: "hydradb_query", arguments: { query: "q" } });
	assert.equal(result.isError, true);
	assert.match((result.content as { text: string }[])[0]!.text, /fetch failed/);

	await client.close();
});

// The whole point of the error work: a failing call must not leak an unbounded
// upstream body into the caller's context.
test("a huge upstream error body does not reach the caller whole", async () => {
	const client = await failingClient(
		new HydraDBError({
			statusCode: 502,
			body: `<html><title>502 Bad Gateway</title><body>${"pad ".repeat(20000)}</body></html>`,
		}),
	);

	const result = await client.callTool({ name: "hydradb_query", arguments: { query: "q" } });
	const text = (result.content as { text: string }[])[0]!.text;

	assert.ok(text.length < 1000, `error body must be bounded, got ${text.length} chars`);
	assert.match(text, /502 Bad Gateway/, "the useful part should survive");

	await client.close();
});

test("malformed JSON from the API surfaces as an error, not a crash", async () => {
	const sdk = {
		query: () => Promise.resolve({ data: "this is not the expected shape", success: true }),
	} as unknown as HydraDBClient;
	const client = await connect(new HydraDB({ token: "t", database: "db" }, sdk));

	// Must not throw out of the handler; the tool answers one way or the other.
	const result = await client.callTool({ name: "hydradb_query", arguments: { query: "q" } });
	assert.ok(result.content, "a malformed payload must still produce a tool result");

	await client.close();
});

test("tools accept per-request database and collection overrides", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);

	// 1. hydradb_query override
	await client.callTool({
		name: "hydradb_query",
		arguments: { query: "search test", database: "custom_db", collection: "custom_col" },
	});
	const queryCall = calls.find((c) => c.method === "query");
	assert.ok(queryCall, "query should have been called");
	assert.equal(queryCall.args.database, "custom_db");
	assert.equal(queryCall.args.collection, "custom_col");

	// 2. hydradb_ingest (memory) override
	await client.callTool({
		name: "hydradb_ingest",
		arguments: { text: "fact", kind: "memory", database: "custom_db_ingest", collection: "custom_col_ingest" },
	});
	const ingestCall = calls.find((c) => c.method === "ingest");
	assert.ok(ingestCall, "ingest should have been called");
	assert.equal(ingestCall.args.database, "custom_db_ingest");
	assert.equal(ingestCall.args.collection, "custom_col_ingest");

	// 3. hydradb_list override
	await client.callTool({
		name: "hydradb_list",
		arguments: { kind: "memory", database: "custom_db_list", collection: "custom_col_list" },
	});
	const listCall = calls.find((c) => c.method === "list");
	assert.ok(listCall, "list should have been called");
	assert.equal(listCall.args.database, "custom_db_list");
	assert.equal(listCall.args.collection, "custom_col_list");

	// 4. hydradb_inspect override
	await client.callTool({
		name: "hydradb_inspect",
		arguments: { id: "doc_123", database: "custom_db_inspect", collection: "custom_col_inspect" },
	});
	const inspectCall = calls.find((c) => c.method === "inspect");
	assert.ok(inspectCall, "inspect should have been called");
	assert.equal(inspectCall.args.database, "custom_db_inspect");
	assert.equal(inspectCall.args.collection, "custom_col_inspect");

	// 5. hydradb_status override
	await client.callTool({
		name: "hydradb_status",
		arguments: { ids: ["doc_123"], database: "custom_db_status", collection: "custom_col_status" },
	});
	const statusCall = calls.find((c) => c.method === "status");
	assert.ok(statusCall, "status should have been called");
	assert.equal(statusCall.args.database, "custom_db_status");
	assert.equal(statusCall.args.collection, "custom_col_status");

	// 6. hydradb_delete override
	await client.callTool({
		name: "hydradb_delete",
		arguments: { ids: ["doc_123"], kind: "memory", database: "custom_db_delete", collection: "custom_col_delete" },
	});
	const deleteCall = calls.find((c) => c.method === "delete");
	assert.ok(deleteCall, "delete should have been called");
	assert.equal(deleteCall.args.database, "custom_db_delete");
	assert.equal(deleteCall.args.collection, "custom_col_delete");

	await client.close();
});

test("tools fall back to default database and collection when omitted", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);

	await client.callTool({
		name: "hydradb_query",
		arguments: { query: "search test" },
	});
	const queryCall = calls.find((c) => c.method === "query");
	assert.ok(queryCall, "query should have been called");
	assert.equal(queryCall.args.database, "db_test");
	assert.equal(queryCall.args.collection, "col_test");

	await client.close();
});

test("empty scope overrides are rejected or fall back to default", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);

	// Scope fallback in client directly
	const res = await hydra.context.query({
		query: "search test",
		database: "   ",
		collection: "",
	});
	assert.ok(res);
	const queryCall = calls.find((c) => c.method === "query");
	assert.ok(queryCall);
	assert.equal(queryCall.args.database, "db_test");
	assert.equal(queryCall.args.collection, "col_test");

	await client.close();
});

test("query forwards recency_bias, and still defaults it to 0", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);

	await client.callTool({ name: "hydradb_query", arguments: { query: "q" } });
	assert.equal(
		calls.find((c) => c.method === "query")?.args.recencyBias,
		0,
		"the host default must not change for callers that do not set it",
	);

	calls.length = 0;
	await client.callTool({
		name: "hydradb_query",
		arguments: { query: "q", recency_bias: 0.9 },
	});
	assert.equal(
		calls.find((c) => c.method === "query")?.args.recencyBias,
		0.9,
		"a caller asking for current state must be able to raise it",
	);

	await client.close();
});

test("query forwards query_apps for connector-aware retrieval", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);

	await client.callTool({
		name: "hydradb_query",
		arguments: { query: "q", query_apps: true },
	});

	assert.equal(calls.find((c) => c.method === "query")?.args.queryApps, true);
	await client.close();
});

test("query forwards a multi-collection scope instead of the singular one", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);

	await client.callTool({
		name: "hydradb_query",
		arguments: { query: "q", collections: ["policies", "handbook"] },
	});

	const args = calls.find((c) => c.method === "query")?.args;
	assert.deepEqual(args?.collections, ["policies", "handbook"]);
	// The server refuses both selectors at once, so the configured default
	// collection must not ride along beside the one the caller named.
	assert.equal(args?.collection, undefined);

	await client.close();
});

// ── hydradb_subgraph (PRO-1848) ─────────────────────────────────────────

async function subgraphText(
	result: unknown,
	args: Record<string, unknown>,
): Promise<{ text: string; structured: Record<string, unknown> | undefined; isError: boolean | undefined; calls: unknown[] }> {
	const { hydra } = mockHydra();
	const calls: unknown[] = [];
	// The wrapper method takes the raw HTTP path, not the SDK, so it is stubbed
	// on the resource rather than through the SDK mock.
	(hydra.context as unknown as { subgraph: unknown }).subgraph = async (p: unknown) => {
		calls.push(p);
		return result;
	};
	const client = await connect(hydra);
	const res = await client.callTool({ name: "hydradb_subgraph", arguments: args });
	await client.close();
	return {
		text: (res.content as { text: string }[])[0]?.text ?? "",
		structured: res.structuredContent as Record<string, unknown> | undefined,
		isError: res.isError as boolean | undefined,
		calls,
	};
}

const subgraphOf = (members: Record<string, unknown>[], over: Record<string, unknown> = {}) => ({
	seed_source_id: "thread-root",
	sources: members,
	relations: [
		{ source: { entity_id: "thread-root" }, target: { entity_id: "reply-2" }, relations: [{ canonical_predicate: "same_thread" }] },
		{ source: { entity_id: "reply-2" }, target: { entity_id: "doc-9" }, relations: [{ canonical_predicate: "relates_to" }] },
	],
	auxiliary_relations: [{}, {}, {}],
	auxiliary_truncated: false,
	is_truncated: false,
	max_depth_reached: 1,
	success: true,
	message: "ok",
	...over,
});

test("hydradb_subgraph lists members by depth with ids the other tools accept", async () => {
	const { text, structured, isError, calls } = await subgraphText(
		subgraphOf([
			// discovered_via is the member this one was reached FROM, not a mechanism.
			{ source_id: "reply-2", title: "re: budget", depth: 1, discovered_via: "thread-root", discovered_relation: "same_thread", app_provider: "slack" },
			{ source_id: "thread-root", title: "Q3 budget", depth: 0 },
		]),
		{ id: "thread-root", depth: 3, kind: "knowledge" },
	);
	assert.notEqual(isError, true);
	assert.match(text, /2 items connected to thread-root through 1 hop\b/);
	// Depth order, seed first, each with a composable id.
	const rootAt = text.indexOf("[id: thread-root]");
	const replyAt = text.indexOf("[id: reply-2]");
	assert.ok(rootAt >= 0 && replyAt > rootAt, "seed listed before its reply");
	assert.match(text, /reply-2\] re: budget \(slack\) — depth 1, same_thread from thread-root/);
	assert.match(text, /thread-root\] Q3 budget — depth 0, the item you started from/);
	assert.match(text, /hydradb_inspect/);
	assert.equal(structured?.member_count, 2);
	assert.equal(structured?.truncated, false);
	// structuredContent is ordered the same way the prose is: a client rendering
	// the members must not see a different order from the reader.
	assert.deepEqual((structured?.members as { id: string }[]).map((m) => m.id), ["thread-root", "reply-2"]);
	// The edges come through, so a client can rebuild the graph rather than
	// only the member list; the structural links stay a count plus their flag.
	assert.deepEqual(structured?.relations, [
		{ from: "thread-root", to: "reply-2", type: "same_thread" },
		{ from: "reply-2", to: "doc-9", type: "relates_to" },
	]);
	assert.equal(structured?.structural_link_count, 3);
	assert.equal(structured?.structural_truncated, false);
	// Args reach the wrapper under the wrapper's names.
	assert.deepEqual(calls[0], { id: "thread-root", kind: "knowledge", depth: 3, maxSources: undefined, acl: undefined, database: undefined, collection: undefined });
});

test("hydradb_subgraph says when max_sources clipped the traversal", async () => {
	const { text, structured } = await subgraphText(
		subgraphOf([{ source_id: "a", depth: 0 }, { source_id: "b", depth: 1 }], { is_truncated: true, max_depth_reached: 3 }),
		{ id: "a" },
	);
	assert.match(text, /clipped at max_sources/);
	assert.match(text, /3 hops/);
	assert.equal(structured?.truncated, true);
});

test("hydradb_subgraph distinguishes 'stands alone' from 'not found'", async () => {
	const alone = await subgraphText(subgraphOf([{ source_id: "solo", depth: 0 }], { max_depth_reached: 0 }), { id: "solo" });
	assert.match(alone.text, /stands alone/);
	assert.notEqual(alone.isError, true);

	const missing = await subgraphText(subgraphOf([]), { id: "nope" });
	assert.match(missing.text, /No item with id nope/);
	assert.equal(missing.structured?.member_count, 0);
	assert.notEqual(missing.isError, true, "an unknown id is an answer, not a failure");
});

// One member plus is_truncated means the traversal was cut at max_sources, not
// that the item is isolated. Reporting it as isolated is a wrong answer, not a
// terse one.
test("hydradb_subgraph does not call a clipped result 'stands alone'", async () => {
	const { text, structured } = await subgraphText(
		subgraphOf([{ source_id: "solo", depth: 0 }], { is_truncated: true, max_depth_reached: 0 }),
		{ id: "solo", max_sources: 1 },
	);
	assert.doesNotMatch(text, /stands alone/);
	assert.match(text, /clipped at max_sources/);
	assert.equal(structured?.truncated, true);
});

test("hydradb_subgraph reports clipped structural links", async () => {
	const { text, structured } = await subgraphText(
		subgraphOf([{ source_id: "a", depth: 0 }, { source_id: "b", depth: 1 }], { auxiliary_truncated: true }),
		{ id: "a" },
	);
	assert.match(text, /structural links clipped/);
	assert.equal(structured?.structural_truncated, true);
});

// An empty result carries the same keys as a populated one, so a client never
// has to branch on which shape it got.
test("hydradb_subgraph returns one structured shape whether or not it found anything", async () => {
	const found = await subgraphText(subgraphOf([{ source_id: "a", depth: 0 }, { source_id: "b", depth: 1 }]), { id: "a" });
	const missing = await subgraphText(subgraphOf([]), { id: "nope" });
	assert.deepEqual(Object.keys(missing.structured ?? {}).sort(), Object.keys(found.structured ?? {}).sort());
});

test("hydradb_subgraph flags a server-reported failure", async () => {
	const { text, isError } = await subgraphText(subgraphOf([], { success: false, message: "graph unavailable" }), { id: "x" });
	assert.equal(isError, true);
	assert.match(text, /graph unavailable/);
});

test("hydradb_subgraph requires an id", async () => {
	const { hydra } = mockHydra();
	const client = await connect(hydra);
	const res = await client.callTool({ name: "hydradb_subgraph", arguments: {} });
	assert.equal(res.isError, true);
	await client.close();
});

// ── PRO-1684: acl must survive TOOL DISPATCH, not just the wrapper ───────────
// The first cut of this feature added `acl` to the schemas and to the wrapper,
// and passed its wrapper-level tests, while the list and inspect dispatch paths
// silently dropped the field: they rebuild an explicit argument object from a
// whitelist, so a parameter that is not named there is discarded. The tool then
// ADVERTISED acl and answered unscoped, which is the worst possible shape for a
// permission feature. These tests drive the real tool surface end to end so that
// gap cannot reopen.

test("hydradb_query forwards acl principals through dispatch", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);

	await client.callTool({
		name: "hydradb_query",
		arguments: { query: "roadmap", acl: ["alice@corp.com", "group:google:eng@corp.com"] },
	});

	const call = calls.find((c) => c.method === "query");
	assert.ok(call, "wrapper should have called query");
	assert.deepEqual(call.args.acl, ["alice@corp.com", "group:google:eng@corp.com"]);
	await client.close();
});

test("hydradb_list forwards acl principals through dispatch, both kinds", async () => {
	for (const kind of ["memory", "knowledge"] as const) {
		const { hydra, calls } = mockHydra();
		const client = await connect(hydra);

		await client.callTool({
			name: "hydradb_list",
			arguments: { kind, acl: ["bob@corp.com"] },
		});

		const call = calls.find((c) => c.method === "list");
		assert.ok(call, `wrapper should have called list for ${kind}`);
		assert.deepEqual(call.args.acl, ["bob@corp.com"], `acl dropped on kind=${kind}`);
		await client.close();
	}
});

test("hydradb_inspect forwards acl principals through dispatch", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);

	await client.callTool({
		name: "hydradb_inspect",
		arguments: { id: "s1", acl: ["carol@corp.com"] },
	});

	const call = calls.find((c) => c.method === "inspect");
	assert.ok(call, "wrapper should have called inspect");
	assert.deepEqual(call.args.acl, ["carol@corp.com"]);
	await client.close();
});

test("hydradb_subgraph forwards acl principals through dispatch", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);

	await client.callTool({
		name: "hydradb_subgraph",
		arguments: { id: "s1", acl: ["carol@corp.com"] },
	});

	const call = calls.find((c) => c.method === "subgraph");
	assert.ok(call, "wrapper should have called subgraph");
	assert.deepEqual(call.args.acl, ["carol@corp.com"]);
	await client.close();
});

test("omitting acl sends no acl field rather than an empty list", async () => {
	// Wire hygiene, not semantics: the API treats `acl: []` exactly like an
	// absent acl (verified against staging — both returned 134 sources where an
	// unknown principal returned 130), so [] is NOT a way to ask for "nobody".
	// We still send nothing rather than [] so the request says what the caller
	// said, instead of leaning on that equivalence holding forever.
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);

	await client.callTool({ name: "hydradb_query", arguments: { query: "roadmap" } });
	await client.callTool({ name: "hydradb_list", arguments: { kind: "knowledge" } });
	await client.callTool({ name: "hydradb_inspect", arguments: { id: "s1" } });
	await client.callTool({ name: "hydradb_subgraph", arguments: { id: "s1" } });

	for (const method of ["query", "list", "inspect", "subgraph"]) {
		const call = calls.find((c) => c.method === method);
		assert.ok(call, `wrapper should have called ${method}`);
		assert.equal(call.args.acl, undefined, `${method} must omit acl entirely`);
	}
	await client.close();
});

test("every tool that advertises acl actually forwards it", async () => {
	// Guards the general failure: a schema that accepts a permission parameter
	// the dispatch then ignores. Derived from the advertised schema, so a new
	// acl-bearing tool is covered without editing this test.
	const { hydra } = mockHydra();
	const client = await connect(hydra);
	const { tools } = await client.listTools();

	const advertising = tools
		.filter((t) => (t.inputSchema?.properties as Record<string, unknown> | undefined)?.acl != null)
		.map((t) => t.name);

	assert.ok(
		advertising.includes("hydradb_query")
			&& advertising.includes("hydradb_list")
			&& advertising.includes("hydradb_inspect")
			&& advertising.includes("hydradb_subgraph"),
		`expected the three canonical reads plus subgraph to advertise acl, got: ${advertising.join(", ")}`,
	);

	const args: Record<string, Record<string, unknown>> = {
		hydradb_query: { query: "q" },
		hydradb_list: { kind: "knowledge" },
		hydradb_inspect: { id: "s1" },
		hydradb_subgraph: { id: "s1" },
	};
	const method: Record<string, string> = {
		hydradb_query: "query",
		hydradb_list: "list",
		hydradb_inspect: "inspect",
		hydradb_subgraph: "subgraph",
	};

	for (const name of advertising) {
		if (args[name] == null) continue;
		const fresh = mockHydra();
		const c = await connect(fresh.hydra);
		await c.callTool({ name, arguments: { ...args[name], acl: ["dan@corp.com"] } });
		const call = fresh.calls.find((x) => x.method === method[name]);
		assert.ok(call, `${name} should have reached the wrapper`);
		assert.deepEqual(call.args.acl, ["dan@corp.com"], `${name} advertises acl but drops it`);
		await c.close();
	}
	await client.close();
});

// PRO-1618: on a unified database the host-owned defaults switch to `unified`,
// because `memory`/`knowledge`/`all` are refused there; on a split database
// (every database created before) the defaults are unchanged.
type RawCall = { path: string; method: string; body?: unknown };

/**
 * A fetch that answers the layout probe with the given type and records every
 * other raw v2 call (the ones a unified kind takes instead of the SDK).
 */
function layoutFetch(type: "split" | "unified", raw: RawCall[] = []): typeof fetch {
	return ((url: string | URL | Request, init?: RequestInit) => {
		const path = new URL(String(url)).pathname;
		const method = init?.method ?? "GET";
		if (path !== "/databases") {
			raw.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
		}
		const data =
			path === "/databases"
				? { databases: ["db_test"], details: [{ database: "db_test", type }] }
				: path === "/context/list"
					? { sources: [], total: 0 }
					: path === "/context"
						? { success: true, deleted_count: 1, results: [] }
						: { chunks: [], sources: [] };
		return Promise.resolve(
			new Response(JSON.stringify({ success: true, data }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
	}) as typeof fetch;
}

function mockHydraWithLayout(type: "split" | "unified"): { hydra: HydraDB; calls: RecordedCall[]; raw: RawCall[] } {
	const calls: RecordedCall[] = [];
	const raw: RawCall[] = [];
	const record = (method: string, fallback: unknown) => (args?: Record<string, unknown>) => {
		calls.push({ method, args: args ?? {} });
		return Promise.resolve({ data: fallback, success: true });
	};
	const sdk = {
		query: record("query", { chunks: [] }),
		context: {
			ingest: record("ingest", { success: true, successCount: 1, failedCount: 0 }),
			list: record("list", { inner: { sources: [], total: 0 } }),
			delete: record("delete", { success: true, deletedCount: 1 }),
		},
		databases: {
			list: record("databases.list", { databases: ["db_test"] }),
		},
	} as unknown as HydraDBClient;
	const hydra = new HydraDB(
		{ token: "t", database: "db_test", collection: "col_test", baseUrl: "https://api.test", fetchFn: layoutFetch(type, raw) },
		sdk,
	);
	return { hydra, calls, raw };
}

test("hydradb_query defaults kind to unified on a unified database (raw v2 call) and to all on a split one (SDK)", async () => {
	const unified = mockHydraWithLayout("unified");
	await (await connect(unified.hydra)).callTool({ name: "hydradb_query", arguments: { query: "q" } });
	assert.equal(unified.calls.find((c) => c.method === "query"), undefined, "unified must not use the SDK query serializer");
	const rawQuery = unified.raw.find((c) => c.path === "/query")!;
	assert.equal(rawQuery.method, "POST");
	assert.equal((rawQuery.body as { type: string }).type, "unified");

	const split = mockHydraWithLayout("split");
	await (await connect(split.hydra)).callTool({ name: "hydradb_query", arguments: { query: "q" } });
	assert.equal(split.calls.find((c) => c.method === "query")!.args.type, "all");
	assert.equal(split.raw.length, 0, "a split database keeps every call on the SDK");
});

test("hydradb_delete defaults kind to unified on a unified database", async () => {
	const { hydra, calls, raw } = mockHydraWithLayout("unified");
	const client = await connect(hydra);
	await client.callTool({ name: "hydradb_delete", arguments: { ids: ["x"] } });
	assert.equal(calls.find((c) => c.method === "delete"), undefined);
	const rawDelete = raw.find((c) => c.path === "/context")!;
	assert.equal(rawDelete.method, "DELETE");
	assert.deepEqual(rawDelete.body, { database: "db_test", collection: "col_test", ids: ["x"], type: "unified" });
});

test("hydradb_list kind=unified lists every item in the source shape", async () => {
	const { hydra, raw } = mockHydraWithLayout("unified");
	const client = await connect(hydra);
	const res = await client.callTool({ name: "hydradb_list", arguments: { kind: "unified" } });
	assert.equal((raw.find((c) => c.path === "/context/list")!.body as { type: string }).type, "unified");
	assert.equal((res.structuredContent as { kind: string }).kind, "unified");
});

// The text half of hydradb_ingest resolved the layout; the conversation half
// pinned kind:"memory" outside that resolution, so one tool had one of its two
// input shapes answering a unified database with a 400.
test("hydradb_ingest with turns defaults to unified on a unified database", async () => {
	const { hydra, calls, raw } = mockHydraWithLayout("unified");
	const client = await connect(hydra);

	const res = await client.callTool({
		name: "hydradb_ingest",
		arguments: { turns: [{ user: "i prefer dark mode", assistant: "noted" }], user_name: "Ada" },
	});

	assert.notEqual(res.isError, true, JSON.stringify(res.content));
	assert.equal(calls.find((c) => c.method === "ingest"), undefined, "unified must not use the SDK ingest serializer");
	const body = raw.find((c) => c.path === "/context/ingest")!.body as {
		items: { conversation: { role: string; content: string; name?: string }[] }[];
	};
	assert.deepEqual(body.items[0]!.conversation, [
		{ role: "user", content: "i prefer dark mode", name: "Ada" },
		{ role: "assistant", content: "noted" },
	]);
	await client.close();
});

test("hydradb_ingest with turns keeps the memory path on a split database", async () => {
	const { hydra, calls, raw } = mockHydraWithLayout("split");
	const client = await connect(hydra);
	await client.callTool({
		name: "hydradb_ingest",
		arguments: { turns: [{ user: "hi", assistant: "hello" }] },
	});
	assert.equal(calls.find((c) => c.method === "ingest")?.args.type, "memory");
	assert.equal(raw.length, 0, "a split database keeps every call on the SDK");
	await client.close();
});

test("hydradb_databases names each database's layout", async () => {
	const { hydra } = mockHydraWithLayout("unified");
	// The databases tool is only registered for OAuth connections.
	const server = createHydraDBServer(hydra, undefined, { oauthTools: true });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "0.0.0" });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	const res = await client.callTool({ name: "hydradb_databases", arguments: {} });
	assert.deepEqual((res.structuredContent as { types: Record<string, string> }).types, { db_test: "unified" });
	assert.match(JSON.stringify(res.content), /unified/);
});

test("a defaulted kind refused by a unified database is retried once as unified; an explicit kind is not", async () => {
	// The probe says split (or fails), the server says unified.
	const calls: RecordedCall[] = [];
	const raw: RawCall[] = [];
	const sdk = {
		query: (args: Record<string, unknown>) => {
			calls.push({ method: "query", args });
			return Promise.reject(
				new HydraDBError({ statusCode: 400, body: { error: { message: "type 'all' is not valid on a unified database" } } }),
			);
		},
		context: {},
		databases: { list: () => Promise.resolve({ data: { databases: ["db_test"] }, success: true }) },
	} as unknown as HydraDBClient;
	const hydra = new HydraDB(
		{ token: "t", database: "db_test", collection: "col_test", baseUrl: "https://api.test", fetchFn: layoutFetch("split", raw) },
		sdk,
	);
	const client = await connect(hydra);

	const defaulted = await client.callTool({ name: "hydradb_query", arguments: { query: "q" } });
	assert.equal(calls.length, 1, "the SDK path was tried with the default first");
	assert.equal(raw.filter((c) => c.path === "/query").length, 1, "then retried once as unified over the raw path");
	assert.notEqual(defaulted.isError, true);

	const explicit = await client.callTool({ name: "hydradb_query", arguments: { query: "q", kind: "memory" } });
	assert.equal(explicit.isError, true, "an explicit kind is never rewritten");
	assert.equal(raw.filter((c) => c.path === "/query").length, 1);
});

/**
 * A fetch whose layout probe FAILS, so nothing can be learned from it, and
 * whose SDK-path answers are the server's unified refusal. `message` is the
 * refusal text under test.
 */
function refusingLayout(message: string, code?: string): {
	hydra: HydraDB;
	raw: RawCall[];
	sdkQueries: () => number;
} {
	const raw: RawCall[] = [];
	let sdkQueries = 0;
	const sdk = {
		query: () => {
			sdkQueries += 1;
			return Promise.reject(
				new HydraDBError({
					statusCode: 400,
					body: { error: { message, ...(code != null ? { code } : {}) } },
				}),
			);
		},
		context: {},
	} as unknown as HydraDBClient;
	const fetchFn = ((url: string | URL | Request, init?: RequestInit) => {
		const path = new URL(String(url)).pathname;
		if (path === "/databases") {
			return Promise.resolve(new Response("down", { status: 503 }));
		}
		raw.push({ path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
		return Promise.resolve(
			new Response(JSON.stringify({ success: true, data: { chunks: [], sources: [] } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
	}) as typeof fetch;
	const hydra = new HydraDB(
		{ token: "t", database: "db_test", collection: "col_test", baseUrl: "https://api.test", fetchFn, maxRetries: 0 },
		sdk,
	);
	return { hydra, raw, sdkQueries: () => sdkQueries };
}

// The probe is memoised; its FAILURE was not. So a process whose probe went
// down paid the refused request on every defaulted call thereafter — it had
// already been told the database is unified and threw the answer away.
test("a layout recovered by the unified retry is remembered for the next call", async () => {
	const { hydra, raw, sdkQueries } = refusingLayout("type 'all' is not valid on a unified database");
	const client = await connect(hydra);

	await client.callTool({ name: "hydradb_query", arguments: { query: "one" } });
	assert.equal(sdkQueries(), 1, "the first call learns it the hard way");
	assert.equal(raw.filter((c) => c.path === "/query").length, 1);

	await client.callTool({ name: "hydradb_query", arguments: { query: "two" } });
	assert.equal(sdkQueries(), 1, "the second call must not repeat the refused request");
	assert.equal(raw.filter((c) => c.path === "/query").length, 2, "it goes straight to unified");

	await client.close();
});

// The stable half of the signal. The server gives this refusal a code
// (CORPUS_TYPE_UNSUPPORTED, hydradb-application#870); prose that no pattern here
// has ever seen must still retry when the code says what happened.
test("the structured error code triggers the retry on its own", async () => {
	const { hydra, raw } = refusingLayout("le type demandé n'est pas accepté", "CORPUS_TYPE_UNSUPPORTED");
	const client = await connect(hydra);
	const res = await client.callTool({ name: "hydradb_query", arguments: { query: "q" } });
	assert.notEqual(res.isError, true);
	assert.equal(raw.filter((c) => c.path === "/query").length, 1);
	await client.close();
});

// And it does not fire on a 400 that merely happens to be structured: a
// different code with prose that says nothing about a layout is a real failure.
test("an unrelated structured 400 is not retried as unified", async () => {
	const { hydra, raw } = refusingLayout("max_results must be between 1 and 50", "INVALID_INPUT");
	const client = await connect(hydra);
	const res = await client.callTool({ name: "hydradb_query", arguments: { query: "q" } });
	assert.equal(res.isError, true);
	assert.equal(raw.filter((c) => c.path === "/query").length, 0);
	await client.close();
});

// CORPUS_TYPE_UNSUPPORTED covers four refusals and only one of them is answered
// by retrying as unified. The third below is the dangerous one: it is the
// REVERSE direction, and a client that read the code alone would answer "unified
// is only valid on a unified database" by sending unified again.
test("the sibling refusals that share the code are not retried as unified", async () => {
	const siblings = [
		`invalid type "bogus": must be 'knowledge', 'memory', 'unified' or 'all'`,
		"invalid type 'all': it selects both corpora for reads and deletes, but an ingest must name the one it writes to",
		`type "unified" is only valid on a unified database; this database stores knowledge and memory separately`,
	];
	for (const message of siblings) {
		const { hydra, raw } = refusingLayout(message, "CORPUS_TYPE_UNSUPPORTED");
		const client = await connect(hydra);
		const res = await client.callTool({ name: "hydradb_query", arguments: { query: "q" } });
		assert.equal(res.isError, true, `should not have been retried: ${message}`);
		assert.equal(raw.filter((c) => c.path === "/query").length, 0, message);
		await client.close();
	}
});

// The server has two wordings for this refusal and they put the words the other
// way round: `type 'x' is not valid on a unified database` from the corpus-type
// check, and `this database is unified: send the content as items…` from the
// ingest handler.
//
// Each is checked BOTH ways on purpose. The ingest wording carries no code on
// the current server, so the prose match is the only thing that catches it
// today — but hydradb-application#870 is adding the same code to that site
// next, and the answer has to stay the same when it does. Getting that wrong
// is silent: the retry simply stops happening on a server upgrade.
test("both of the server's unified refusal wordings trigger the retry, coded or not", async () => {
	const wordings = [
		"type 'all' is not valid on a unified database: knowledge and memory are one corpus here",
		"this database is unified: send the content as `items` (a JSON array of text or conversation items)",
	];
	for (const message of wordings) {
		for (const code of [undefined, "CORPUS_TYPE_UNSUPPORTED"]) {
			const { hydra, raw } = refusingLayout(message, code);
			const client = await connect(hydra);
			const res = await client.callTool({ name: "hydradb_query", arguments: { query: "q" } });
			assert.notEqual(res.isError, true, `not retried (code=${code}) for: ${message}`);
			assert.equal(raw.filter((c) => c.path === "/query").length, 1, message);
			await client.close();
		}
	}
});

// runDatabases asked for the same listing twice — once through the SDK for the
// names, once through the layout probe for the types — when one response
// carries both.
test("hydradb_databases issues exactly one GET /databases", async () => {
	let listings = 0;
	const fetchFn = ((url: string | URL | Request) => {
		const path = new URL(String(url)).pathname;
		if (path === "/databases") listings += 1;
		return Promise.resolve(
			new Response(
				JSON.stringify({
					success: true,
					data: { databases: ["db_test", "other"], details: [{ database: "db_test", type: "unified" }] },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);
	}) as typeof fetch;
	const hydra = new HydraDB(
		{ token: "t", database: "db_test", baseUrl: "https://api.test", fetchFn },
		{ databases: { list: () => assert.fail("the SDK list path must not be used") } } as unknown as HydraDBClient,
	);
	const server = createHydraDBServer(hydra, undefined, { oauthTools: true });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "0.0.0" });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

	const res = await client.callTool({ name: "hydradb_databases", arguments: {} });
	assert.equal(listings, 1);
	assert.deepEqual(
		(res.structuredContent as { types: Record<string, string> }).types,
		{ db_test: "unified", other: "split" },
	);
	await client.close();
});
