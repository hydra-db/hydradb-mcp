import assert from "node:assert/strict";
import { test } from "node:test";

import type { HydraDBClient } from "@hydradb/sdk";
import { HydraDBError } from "@hydradb/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { fitUnifiedPrompt, unifiedStructuredContent } from "../src/context.js";
import { HydraDB } from "../src/hydra/index.js";
import { createHydraDBServer, unsearchableCollections } from "../src/server.js";

// Found by the PRO-2187 end-to-end run against staging (unified switch on):
//  1. a unified answer arriving on the v2 route (`kind: "all"`, or a default
//     sent while the layout probe could not answer) was refused as invalid;
//  2. a unified answer had no size bound (~265k chars for one search);
//  3. one graph-tool write listed a graph-only collection that broke every
//     widened search;
//  4. `kind: "unified"` on a split database quietly hit the wrong corpus.

type Probe = "split" | "unified" | "fail";

type Call = { method: string; args: Record<string, unknown> };

const UNIFIED_BODY = {
	chunks: [{ chunk_id: "k1", context_id: "u-policy", score: 0.9, content: "Refund window is 30 days." }],
	graph: [],
	forceful_relations: [],
	llm_prompt: "# Query results\n\n## Results\n\n### 1. refund-policy\n- **Id:** u-policy\n\nRefund window is 30 days.\n",
};

function build(opts: {
	probe: Probe;
	collections?: string[];
	pinned?: boolean;
	sdkQuery?: (args: Record<string, unknown>, n: number) => unknown;
	rawQueryData?: unknown;
}): { hydra: HydraDB; calls: Call[] } {
	const calls: Call[] = [];
	let sdkQueries = 0;

	const record = (method: string, data: unknown) => (args?: Record<string, unknown>) => {
		calls.push({ method, args: args ?? {} });

		return Promise.resolve({ data, success: true, meta: { requestId: "req-sdk" } });
	};

	const sdk = {
		query: (args: Record<string, unknown>) => {
			calls.push({ method: "sdk.query", args });
			const out = opts.sdkQuery ? opts.sdkQuery(args, sdkQueries++) : { chunks: [] };

			if (out instanceof Error) return Promise.reject(out);

			return Promise.resolve({ data: out, success: true, meta: { requestId: "req-sdk" } });
		},
		context: {
			ingest: record("sdk.ingest", { success: true, successCount: 1, failedCount: 0 }),
			list: record("sdk.list", { inner: { sources: [], total: 0 } }),
			delete: record("sdk.delete", { success: true, deletedCount: 1 }),
		},
		databases: { collections: record("sdk.collections", { collections: opts.collections ?? [] }) },
	} as unknown as HydraDBClient;

	const fetchFn = ((url: string | URL | Request, init?: RequestInit) => {
		const path = new URL(String(url)).pathname;
		const method = init?.method ?? "GET";

		const json = (status: number, body: unknown) =>
			Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

		if (path === "/databases" && method === "GET") {
			if (opts.probe === "fail") return json(503, { success: false, error: { code: "UNAVAILABLE", message: "down" } });

			return json(200, { success: true, data: { databases: ["db_test"], details: [{ database: "db_test", type: opts.probe }] } });
		}

		calls.push({ method: `raw ${method} ${path}`, args: init?.body ? JSON.parse(String(init.body)) : {} });

		const data =
			path === "/query"
				? (opts.rawQueryData ?? UNIFIED_BODY)
				: path === "/context/ingest"
					? { success: true, message: "queued", results: [{ id: "x", status: "queued" }], success_count: 1, failed_count: 0 }
					: { sources: [], total: 0 };

		return json(200, { success: true, data, meta: { request_id: "req-raw" } });
	}) as typeof fetch;

	const hydra = new HydraDB(
		{
			token: "t",
			database: "db_test",
			...(opts.pinned === false ? {} : { collection: "col_test" }),
			baseUrl: "https://api.test",
			fetchFn,
			maxRetries: 0,
		},
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

const textOf = (res: { content?: unknown }) =>
	((res.content as { type: string; text?: string }[]) ?? []).map((c) => c.text ?? "").join("\n");

// ---------------------------------------------------------------- fix 1

test("explicit kind=all on a known unified database is sent as unified (no type, raw route)", async () => {
	const { hydra, calls } = build({ probe: "unified" });
	const res = await (await connect(hydra)).callTool({ name: "hydradb_query", arguments: { query: "refund", kind: "all" } });

	assert.equal(res.isError, undefined, textOf(res));
	assert.equal(calls.find((c) => c.method === "sdk.query"), undefined, "must not take the v2 SDK route");
	const q = calls.find((c) => c.method === "raw POST /query");
	assert.ok(q, "unified query goes over the raw route");
	assert.equal("type" in q.args, false, "no type on a unified database");
	assert.match(textOf(res), /Refund window is 30 days/);
});

test("explicit kind=all with follow_forceful_relations on a unified database is accepted", async () => {
	const { hydra, calls } = build({ probe: "unified" });

	const res = await (await connect(hydra)).callTool({
		name: "hydradb_query",
		arguments: { query: "refund", kind: "all", follow_forceful_relations: true },
	});

	assert.equal(res.isError, undefined, textOf(res));
	assert.equal(calls.find((c) => c.method === "raw POST /query")?.args.follow_forceful_relations, true);
});

test("a unified answer on the v2 route (probe failed) is read by its shape, and the layout is remembered", async () => {
	const { hydra, calls } = build({ probe: "fail", sdkQuery: () => UNIFIED_BODY });
	const client = await connect(hydra);

	const first = await client.callTool({ name: "hydradb_query", arguments: { query: "refund" } });
	assert.equal(first.isError, undefined, textOf(first));
	assert.match(textOf(first), /Refund window is 30 days/);
	assert.equal(calls.filter((c) => c.method === "sdk.query").length, 1, "first search guessed split and took the v2 route");
	assert.match(textOf(first), /request_id: req-sdk/, "the request id survives the re-read");

	await client.callTool({ name: "hydradb_query", arguments: { query: "refund again" } });
	assert.equal(calls.filter((c) => c.method === "sdk.query").length, 1, "second search no longer guesses");
	assert.ok(calls.find((c) => c.method === "raw POST /query"), "second search goes unified");
});

test("a v2 answer with the graph off (no graph_context, additive forceful_relations object) still reads as v2", async () => {
	const { hydra } = build({
		probe: "split",
		sdkQuery: () => ({ chunks: [{ id: "s1", chunkContent: "hello from split" }], forceful_relations: { declared: [] } }),
	});

	const res = await (await connect(hydra)).callTool({ name: "hydradb_query", arguments: { query: "hi", graph_context: false } });

	assert.equal(res.isError, undefined, textOf(res));
	assert.match(textOf(res), /hello from split/);
});

test("a broken unified answer on the v2 route is refused as malformed, not read as empty", async () => {
	const { hydra } = build({ probe: "fail", sdkQuery: () => ({ chunks: [{ chunk_id: "k1" }], graph: [], llm_prompt: "P" }) });
	const res = await (await connect(hydra)).callTool({ name: "hydradb_query", arguments: { query: "refund" } });

	assert.equal(res.isError, true);
	assert.match(textOf(res), /malformed unified response/);
});

// ---------------------------------------------------------------- fix 2

function bigPrompt(bodyChars: number, blocks = 3): string {
	const parts = ["# Query results", "**Query:** refund", "", "## Results", ""];

	for (let i = 1; i <= blocks; i++) {
		parts.push(`### ${i}. doc-${i}`, `- **Relevance:** 0.9`, `- **Id:** id-${i} · **Last updated:** 2026-09-23`, "",
			`${"word ".repeat(bodyChars / 5)}`, "", `**Enrichment:** note ${i}`, "", "---");
	}

	parts.push("## Related facts", "", "- [P1] **a** -rel→ **b** [1][2][3]", "", "## Sources", "", "1. **doc-1** (id: id-1)");

	return parts.join("\n");
}

test("fitUnifiedPrompt returns a prompt that fits byte for byte", () => {
	const prompt = bigPrompt(100);
	const fit = fitUnifiedPrompt(prompt, { maxTotalChars: 40_000 });

	assert.equal(fit.trimmed, false);
	assert.equal(fit.text, prompt);
});

test("fitUnifiedPrompt keeps every heading, id and citation and shortens only bodies", () => {
	const prompt = bigPrompt(60_000);
	const fit = fitUnifiedPrompt(prompt, { maxTotalChars: 20_000 });

	assert.equal(fit.trimmed, true);
	assert.ok(fit.text.length <= 20_000, `got ${fit.text.length}`);

	for (let i = 1; i <= 3; i++) {
		assert.ok(fit.text.includes(`### ${i}. doc-${i}`), `heading ${i} kept`);
		assert.ok(fit.text.includes(`- **Id:** id-${i}`), `id line ${i} kept`);
		assert.ok(fit.text.includes(`pass Id id-${i} to hydradb_inspect`), `note ${i} names the id`);
	}

	assert.ok(fit.text.includes("- [P1] **a** -rel→ **b** [1][2][3]"), "related facts untouched");
	assert.ok(fit.text.includes("## Sources"), "sources untouched");
});

test("fitUnifiedPrompt with a body cap (detail=compact) shortens even a prompt that fits", () => {
	const fit = fitUnifiedPrompt(bigPrompt(2_000), { maxTotalChars: 40_000, maxBodyChars: 600 });

	assert.equal(fit.trimmed, true);
	assert.equal(fit.bodyCap, 600);
	assert.match(fit.text, /shortened: \d+ of \d+ characters shown/);
});

test("the structured copy is shortened to the same cap and flagged", () => {
	const long = "x ".repeat(5_000);

	const out = unifiedStructuredContent(
		{ chunks: [{ context_id: "c1", content: long, enrichment: long }], graph: [], forceful_relations: [], llm_prompt: "" },
		{ maxChunkChars: 600 },
	);

	assert.ok(out.chunks[0]!.content.length <= 600);
	assert.equal(out.chunks[0]!.content_truncated, true);
	assert.equal(out.chunks[0]!.content_chars, long.length);
	assert.equal(out.chunks[0]!.enrichment_truncated, true);
});

test("a huge unified answer stays within the query budget end to end", async () => {
	const huge = "word ".repeat(40_000);

	const body = {
		chunks: [{ chunk_id: "k1", context_id: "id-1", content: huge }],
		graph: [],
		forceful_relations: [],
		llm_prompt: bigPrompt(200_000, 1),
	};

	const { hydra } = build({ probe: "unified", rawQueryData: body });
	const res = await (await connect(hydra)).callTool({ name: "hydradb_query", arguments: { query: "release" } });
	const structured = res.structuredContent as { shortened?: boolean; chunks: { content: string; content_truncated?: boolean }[] };

	assert.ok(textOf(res).length <= 40_000, `text ${textOf(res).length}`);
	assert.equal(structured.shortened, true);
	assert.equal(structured.chunks[0]!.content_truncated, true);
	assert.ok(JSON.stringify(structured).length < 45_000, "structured copy bounded too");
});

// ---------------------------------------------------------------- fix 3

const REFUSED_DEFAULT = new HydraDBError({
	statusCode: 400,
	body: { success: false, error: { code: "INVALID_INPUT", message: "sub_tenant_ids do not exist: [default]" } },
});

test("unsearchableCollections reads the refused names and nothing else", () => {
	assert.deepEqual(unsearchableCollections(new Error("Hydra DB /query → 400: INVALID_INPUT: sub_tenant_ids do not exist: [default]")), ["default"]);
	assert.deepEqual(unsearchableCollections(new Error("x: sub_tenant_ids do not exist: [a, \"b\"]")), ["a", "b"]);
	assert.deepEqual(unsearchableCollections(new Error("Hydra DB /query → 400: INVALID_INPUT: query cannot be empty")), []);
});

test("a widened search drops a collection the API refuses as unsearchable and searches the rest", async () => {
	const { hydra, calls } = build({
		probe: "split",
		pinned: false,
		collections: ["engineering", "default"],
		sdkQuery: (_args, n) => (n === 0 ? REFUSED_DEFAULT : { chunks: [{ id: "s1", chunkContent: "found it" }] }),
	});

	const res = await (await connect(hydra)).callTool({ name: "hydradb_query", arguments: { query: "q" } });
	const queries = calls.filter((c) => c.method === "sdk.query");

	assert.equal(res.isError, undefined, textOf(res));
	assert.equal(queries.length, 2);
	assert.deepEqual(queries[0]!.args.collections, ["engineering", "default"]);
	assert.equal(queries[1]!.args.collection, "engineering");
	assert.match(textOf(res), /found it/);
	assert.match(textOf(res), /Scope warning: Skipped collection "default"/);
});

test("collections the caller named are never narrowed", async () => {
	const { hydra, calls } = build({
		probe: "split",
		pinned: false,
		sdkQuery: () => REFUSED_DEFAULT,
	});

	const res = await (await connect(hydra)).callTool({
		name: "hydradb_query",
		arguments: { query: "q", collections: ["engineering", "default"] },
	});

	assert.equal(res.isError, true);
	assert.equal(calls.filter((c) => c.method === "sdk.query").length, 1, "no retry on the caller's own scope");
});

test("any other refusal of a widened search is not retried", async () => {
	const { hydra, calls } = build({
		probe: "split",
		pinned: false,
		collections: ["engineering", "default"],
		sdkQuery: () => new HydraDBError({ statusCode: 400, body: { error: { code: "INVALID_INPUT", message: "query cannot be empty" } } }),
	});

	const res = await (await connect(hydra)).callTool({ name: "hydradb_query", arguments: { query: "q" } });

	assert.equal(res.isError, true);
	assert.equal(calls.filter((c) => c.method === "sdk.query").length, 1);
});

// ---------------------------------------------------------------- fix 4

for (const [tool, args] of [
	["hydradb_query", { query: "q", kind: "unified" }],
	["hydradb_ingest", { text: "a note", kind: "unified" }],
	["hydradb_ingest", { turns: [{ user: "u", assistant: "a" }], kind: "unified" }],
	["hydradb_list", { kind: "unified" }],
	["hydradb_delete", { id: "s1", kind: "unified" }],
] as const) {
	test(`${tool} ${"turns" in args ? "(turns) " : ""}refuses kind=unified on a known split database and sends nothing`, async () => {
		const { hydra, calls } = build({ probe: "split" });
		const res = await (await connect(hydra)).callTool({ name: tool, arguments: args });

		assert.equal(res.isError, true);
		assert.match(textOf(res), /split database/);
		assert.deepEqual(calls.filter((c) => c.method !== "sdk.collections"), [], "no request sent");
	});
}

test("kind=unified still goes out when the layout is unknown (the server decides)", async () => {
	const { hydra, calls } = build({ probe: "fail" });
	const res = await (await connect(hydra)).callTool({ name: "hydradb_query", arguments: { query: "q", kind: "unified" } });

	assert.equal(res.isError, undefined, textOf(res));
	assert.ok(calls.find((c) => c.method === "raw POST /query"));
});
