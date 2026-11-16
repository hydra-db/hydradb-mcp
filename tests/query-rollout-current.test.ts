import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { HydraDB, isUnifiedQueryResult } from "../src/hydra/index.js";
import { createHydraDBServer } from "../src/server.js";

const warning = { code: "ROLLOUT_NOTICE", message: "The backend selected the response shape.", collections: ["notes"] };
async function rolloutFixture(data: unknown) {
	const requests: Record<string, unknown>[] = [];
	const api = http.createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		requests.push(JSON.parse(Buffer.concat(chunks).toString()));
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify({ success: true, data, meta: { request_id: "req-rollout", warnings: [warning], database: "db", collection: "notes" } }));
	});
	await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
	const hydra = new HydraDB({ token: "synthetic-rollout-key", database: "db", collection: "notes", maxRetries: 0,
		baseUrl: `http://127.0.0.1:${(api.address() as AddressInfo).port}` });
	hydra.databases.recordLayout("db", "unified");
	const server = createHydraDBServer(hydra);
	const client = new Client({ name: "rollout-current", version: "0" });
	const [ct, st] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(st), client.connect(ct)]);
	return { hydra, requests, call: (args: Record<string, unknown>) => client.callTool({ name: "hydradb_query", arguments: { query: "policy", structured: true, ...args } }),
		async close() { await client.close(); await server.close(); api.closeAllConnections(); await new Promise<void>((resolve) => api.close(() => resolve())); } };
}

const v2 = (graph: boolean) => ({ chunks: [{ id: "source-v2", chunk_content: "A valid v2 response chunk.", score: 0.9 }],
	llm_prompt: "A shared v2 prompt.", forceful_relations: {}, graph: {}, ...(graph ? { graph_context: {} } : {}) });
for (const graph of [false, true]) {
	for (const route of ["raw-unified", "sdk", "sdk-controls"] as const) {
		test(`rollout-disabled v2 response survives ${route} with graph ${graph} and final MCP metadata`, async () => {
			const fixture = await rolloutFixture(v2(graph));
			try {
				const result = await fixture.call({ graph_context: graph, ...(route === "raw-unified" ? {} : { type: "all" }),
					...(route === "sdk-controls" ? { additional_graph_context: "hint", query_explicit_relations: false } : {}) });
				assert.equal(result.isError, undefined, JSON.stringify(result.content));
				assert.match(JSON.stringify(result.content), /valid v2 response chunk/);
				assert.equal(result.structuredContent?.request_id, "req-rollout");
				assert.deepEqual(result.structuredContent?.warnings, [warning]);
				assert.equal((result.structuredContent?.sources as { id: string }[])[0]?.id, "source-v2");
				assert.equal(fixture.requests.length, 1);
				assert.equal(fixture.requests[0]?.type, route === "raw-unified" ? undefined : "all");
			} finally { await fixture.close(); }
		});
	}
}

test("actual wrapper transports read rollout-disabled v2 by structure and keep response metadata", async () => {
	for (const kind of ["unified", "all"] as const) {
		const fixture = await rolloutFixture(v2(false));
		try {
			const metadata: unknown[] = [];
			const result = await fixture.hydra.context.query({ kind, query: "policy" }, { onMeta: (meta) => metadata.push(meta) });
			assert.equal(isUnifiedQueryResult(result), false);
			assert.ok(JSON.stringify(result).includes("valid v2 response chunk"));
			assert.ok(JSON.stringify(metadata).includes("req-rollout"));
			assert.ok(JSON.stringify(metadata).includes("ROLLOUT_NOTICE"));
			assert.equal(fixture.requests.length, 1);
		} finally { await fixture.close(); }
	}
});

test("true unified responses still render as unified and malformed unified responses remain errors", async () => {
	for (const kind of [undefined, "all"] as const) {
		for (const malformed of [false, true]) {
			const fixture = await rolloutFixture({ chunks: [{ ...(malformed ? {} : { context_id: "source-unified" }), content: "Unified content." }],
				graph: [], forceful_relations: [], llm_prompt: "# Query results\nUnified content." });
			try {
				const result = await fixture.call(kind === undefined ? {} : { type: kind });
				assert.equal(result.isError, malformed ? true : undefined, JSON.stringify(result.content));
				if (malformed) assert.match(JSON.stringify(result.content), /malformed unified/i);
				else assert.equal(result.structuredContent?.layout, "unified");
				assert.equal(fixture.requests.length, 1);
			} finally { await fixture.close(); }
		}
	}
});
