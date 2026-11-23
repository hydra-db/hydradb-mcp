import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { boundStructuredContent, unifiedStructuredContent } from "../src/context.js";
import type { UnifiedQueryResult } from "../src/hydra/client.js";
import { HydraDB } from "../src/hydra/index.js";
import { createHydraDBServer } from "../src/server.js";

const budget = 40_000;
const size = (value: unknown) => JSON.stringify(value).length;
const answer = (overrides: Partial<UnifiedQueryResult> = {}): UnifiedQueryResult => ({
	chunks: [{ context_id: "source-1", chunk_id: "chunk-1", score: 0.9, content: "A policy." }],
	graph: [], forceful_relations: [], llm_prompt: "# Results\nA policy. [1]",
	...overrides,
});

test("structured budget leaves small temporal and graph payloads unchanged", () => {
	const out = unifiedStructuredContent(answer({ graph: [{ origin: "query_path", path_summary: "A path." }] }));
	const before = structuredClone(out);
	assert.equal(boundStructuredContent(out, budget), false);
	assert.deepEqual(out, before);
});

for (const forceful of [false, true]) {
	test(`structured budget bounds a single 50k temporal fact (${forceful ? "forceful" : "direct"}) without losing metadata`, () => {
		const chunk = { ...answer().chunks[0], temporal: [{ content: "t".repeat(50_000), start_date: "2026-06-01", end_date: null }] };
		const input = answer(forceful ? { chunks: [], forceful_relations: [{ via: { from: "parent", to: "source-1" }, chunk }] } : { chunks: [chunk] });
		const before = structuredClone(input);
		const out = unifiedStructuredContent(input);
		assert.equal(boundStructuredContent(out, budget), true);
		assert.ok(size(out) <= budget, `serialized size ${size(out)}`);
		const kept = forceful ? out.forceful_relations[0]!.chunk : out.chunks[0]!;
		assert.equal(kept.context_id, "source-1");
		assert.equal(kept.chunk_id, "chunk-1");
		assert.equal(kept.score, 0.9);
		assert.equal(kept.temporal![0]!.start_date, "2026-06-01");
		assert.equal(kept.temporal![0]!.end_date, null);
		assert.equal(kept.temporal![0]!.content_truncated, true);
		assert.equal(kept.temporal![0]!.content_chars, 50_000);
		assert.deepEqual(out.sources, [{ id: "source-1" }]);
		if (forceful) assert.deepEqual(out.forceful_relations[0]!.via, { from: "parent", to: "source-1" });
		assert.equal(out.graph_triplets_omitted, undefined);
		assert.deepEqual(input, before, "bounding the structured view must not mutate the upstream facts");
	});
}

for (const [label, body] of [
	["escaped controls", "\u0000\"\\\n".repeat(75)],
	["unicode pairs", "😀".repeat(150)],
	["lone surrogates", "\ud800".repeat(300)],
] as const) {
	test(`structured budget measures final JSON with ${label} and no graph`, () => {
		const input = answer({ chunks: Array.from({ length: 90 }, (_, i) => ({
			context_id: `source-${i}`, chunk_id: `chunk-${i}`, score: 0.8, content: body, enrichment: body,
		})) });
		const out = unifiedStructuredContent(input);
		assert.ok(size(out) > budget);
		assert.equal(boundStructuredContent(out, budget - 4_000), true);
		assert.ok(size(out) <= budget - 4_000, `serialized size ${size(out)}`);
		assert.deepEqual(out.sources, input.chunks.map((c) => ({ id: c.context_id })));
		assert.deepEqual(out.chunks.map((c) => [c.context_id, c.chunk_id, c.score]), input.chunks.map((c) => [c.context_id, c.chunk_id, c.score]));
		assert.ok(out.chunks.every((c) => c.content_truncated && c.content_chars === body.length && c.enrichment_truncated));
		assert.equal(out.graph_triplets_omitted, undefined);
		if (label === "unicode pairs") {
			for (const chunk of out.chunks) {
				assert.equal(Buffer.from(chunk.content).toString(), chunk.content, "a cut must not split a surrogate pair");
				assert.equal(Buffer.from(chunk.enrichment!).toString(), chunk.enrichment);
			}
		}
	});
}

test("structured budget reports temporal list and text truncation honestly", () => {
	const out = unifiedStructuredContent(answer({ chunks: [{ context_id: "source-1", content: "short", temporal:
		Array.from({ length: 8 }, (_, i) => ({ content: "x".repeat(20_000), start_date: `2026-06-0${i + 1}` })),
	}] }));
	assert.equal(boundStructuredContent(out, budget), true);
	assert.ok(size(out) <= budget, `serialized size ${size(out)}`);
	assert.equal(out.chunks[0]!.temporal_truncated, true);
	assert.equal(out.chunks[0]!.temporal_total, 8);
	assert.deepEqual(out.chunks[0]!.temporal!.map((f) => f.start_date), ["2026-06-01", "2026-06-02", "2026-06-03"]);
	assert.ok(out.chunks[0]!.temporal!.every((f) => f.content_truncated && f.content_chars === 20_000));
});

test("structured budget includes graph omission markers in the final serialized size", () => {
	const out = unifiedStructuredContent(answer({ chunks: [{ context_id: "source-1", content: "c".repeat(200) }],
		graph: [{ origin: "query_path", path_summary: "s".repeat(100), triplets: [{ relation: { context: "g".repeat(50_000) } }] }],
	}));
	const limit = size({ ...out, graph: [], graph_triplets_omitted: true });
	assert.equal(boundStructuredContent(out, limit), true);
	assert.ok(size(out) <= limit, `serialized size ${size(out)}, limit ${limit}`);
	assert.equal(out.graph_paths_total, 1);
	assert.equal(out.graph_triplets_omitted, true);
	assert.deepEqual(out.sources, [{ id: "source-1" }]);
});

test("structured budget marks shortened graph summaries without inventing omitted triplets", () => {
	const out = unifiedStructuredContent(answer({ graph: [{ origin: "chunk_relation", path_summary: "p".repeat(50_000) }] }));
	assert.equal(boundStructuredContent(out, budget), true);
	assert.ok(size(out) <= budget);
	assert.equal(out.graph[0]!.origin, "chunk_relation");
	assert.equal(out.graph[0]!.path_summary_truncated, true);
	assert.equal(out.graph[0]!.path_summary_chars, 50_000);
	assert.equal(out.graph_triplets_omitted, undefined);
});

test("structured budget rejects an impossible metadata-only budget instead of cutting IDs", () => {
	const id = "source-" + "x".repeat(50_000);
	const out = unifiedStructuredContent(answer({ chunks: [{ context_id: id, chunk_id: "chunk", content: "body", score: 0.9 }] }));
	assert.throws(() => boundStructuredContent(out, budget), /provenance.*metadata/i);
	assert.equal(out.chunks[0]!.context_id, id);
	assert.equal(out.chunks[0]!.chunk_id, "chunk");
	assert.deepEqual(out.sources, [{ id }]);
});

test("structured budget accounts for and preserves fully assembled metadata and ACL notices", () => {
	const extra = { shortened: true, request_id: "req-\"\\😀", scope_warning: "Skipped \"default\".",
		warnings: [{ code: "WARNING", message: "\u0000".repeat(200) }],
		scope_notice: { allowed_databases: ["db"], allowed_collections: ["notes", "private-😀"] },
		resolved_scope: { database: "db", collection: "notes" },
	};
	const out = { ...unifiedStructuredContent(answer({ chunks: Array.from({ length: 90 }, (_, i) => ({
		context_id: `source-${i}`, content: "\u0000".repeat(300),
	})) })), ...structuredClone(extra) };
	assert.equal(boundStructuredContent(out, budget), true);
	assert.ok(size(out) <= budget, `serialized size ${size(out)}`);
	for (const key of Object.keys(extra) as (keyof typeof extra)[]) assert.deepEqual(out[key], extra[key]);
});

test("actual MCP structured temporal output retains backend notices within 40k", async () => {
	const warnings = [{ code: "BUDGET_NOTICE", message: "Notice \"quoted\" 😀", collections: ["notes"] }];
	const data = answer({ chunks: [{ context_id: "source-1", content: "A policy.", temporal: [{ content: "\u0000😀".repeat(20_000), start_date: "2026-06-01", end_date: null }] }] });
	const hydra = new HydraDB({ token: "synthetic-budget-key", database: "db", collection: "notes", maxRetries: 0,
		fetchFn: (async () => new Response(JSON.stringify({ success: true, data, meta: { request_id: "req-budget", warnings } }),
			{ status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
	});
	hydra.databases.recordLayout("db", "unified");
	const server = createHydraDBServer(hydra);
	const client = new Client({ name: "structured-budget", version: "0" });
	const [ct, st] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(st), client.connect(ct)]);
	try {
		const result = await client.callTool({ name: "hydradb_query", arguments: { query: "policy", structured: true } });
		assert.equal(result.isError, undefined, JSON.stringify(result.content));
		const fields = result.structuredContent as Record<string, unknown>;
		assert.ok(size(fields) <= budget, `serialized size ${size(fields)}`);
		assert.deepEqual(fields.warnings, warnings);
		assert.equal(fields.request_id, "req-budget");
		assert.equal(fields.shortened, true);
		assert.deepEqual(fields.sources, [{ id: "source-1" }]);
	} finally { await client.close(); await server.close(); }
});

test("actual MCP budgets the final assembly including notices, scope, request ID and ACL grants", async () => {
	const warnings = [{ code: "BUDGET_NOTICE", message: "Notice \"quoted\" 😀", collections: ["notes"] }];
	const requestId = "req-\"\\😀";
	const allowedCollections = ["notes", "other-\"\\😀".repeat(50)];
	const data = answer();
	const hydra = new HydraDB({ token: "synthetic-budget-key", database: "db", collection: "notes", maxRetries: 0,
		allowedDatabases: ["db"], allowedCollections,
		fetchFn: (async () => new Response(JSON.stringify({ success: true, data, meta: { request_id: requestId, warnings } }),
			{ status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
	});
	hydra.databases.recordLayout("db", "unified");
	const server = createHydraDBServer(hydra);
	const client = new Client({ name: "structured-final-budget", version: "0" });
	const [ct, st] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(st), client.connect(ct)]);
	try {
		const call = () => client.callTool({ name: "hydradb_query", arguments: { query: "policy", structured: true, detail: "full" } });
		const small = await call();
		assert.equal(small.isError, undefined, JSON.stringify(small.content));
		const fields = small.structuredContent as Record<string, unknown>;
		const noticeFields = { request_id: fields.request_id, warnings: fields.warnings, scope_notice: fields.scope_notice };
		const text = (small.content as { text: string }[])[0]!.text;
		const noticeText = text.slice(text.indexOf("\n\nWarnings:"));
		const innerBudget = budget - Math.max(noticeText.length, size(noticeFields));
		data.chunks[0]!.content = "";
		const fixed = size(unifiedStructuredContent(data));
		data.chunks[0]!.content = "\"".repeat(Math.floor((innerBudget - fixed) / 2));
		data.llm_prompt = `# Results\n${data.chunks[0]!.content} [1]`;
		assert.ok(size(unifiedStructuredContent(data)) <= innerBudget);
		const result = await call();
		assert.equal(result.isError, undefined, JSON.stringify(result.content));
		const structured = result.structuredContent as Record<string, unknown>;
		assert.ok(size(structured) <= budget, `serialized size ${size(structured)}`);
		assert.deepEqual(structured.warnings, warnings);
		assert.equal(structured.request_id, requestId);
		assert.deepEqual(structured.resolved_scope, { database: "db", collection: "notes" });
		assert.deepEqual((structured.scope_notice as { allowed_collections: string[] }).allowed_collections, allowedCollections);
		assert.deepEqual(structured.sources, [{ id: "source-1" }]);
	} finally { await client.close(); await server.close(); }
});
