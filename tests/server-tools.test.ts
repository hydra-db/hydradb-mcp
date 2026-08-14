import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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
	assert.equal(names.length, CANONICAL_TOOL_NAMES.length);
});

test("HYDRADB_MCP_LEGACY_TOOLS restores every alias", async () => {
	const names = await listedTools("1");

	for (const alias of DEPRECATED_TOOL_NAMES) {
		assert.ok(names.includes(alias), `${alias} should return when opted in`);
	}
	assert.equal(
		names.length,
		CANONICAL_TOOL_NAMES.length + DEPRECATED_TOOL_NAMES.length,
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
test("hydradb_list requires kind rather than silently picking one", async () => {
	const { hydra, calls } = mockHydra();
	const client = await connect(hydra);

	const result = await client.callTool({ name: "hydradb_list", arguments: {} });

	assert.equal(result.isError, true, "omitting kind must not quietly mean 'memory'");
	assert.equal(
		calls.filter((c) => c.method === "list").length,
		0,
		"no listing should be issued when the corpus is ambiguous",
	);

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
		assert.equal(structured.id, "m1");
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
