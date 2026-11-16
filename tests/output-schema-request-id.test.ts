import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { GraphResource, HydraDB } from "../src/hydra/index.js";
import { createHydraDBServer } from "../src/server.js";

const REQUEST_ID = "req-schema";

function dataFor(method: string, path: string): unknown {
	if (path === "/databases") return { databases: ["db"], details: [{ database: "db", type: "split" }] };
	if (path === "/context/list") return { sources: [{ id: "s1", title: "t", type: "knowledge" }], total: 1, page: 1, page_size: 20, has_more: false };
	if (path === "/context/ingest") return { success: true, success_count: 1, failed_count: 0, results: [{ source_id: "ctx-1", status: "queued" }] };
	if (path.endsWith("/collections")) return { database: "db", collections: ["notes"] };
	if (path.startsWith("/byog/query")) return [{ n: 1 }];
	if (path.includes("relations")) return { relations: [], total: 0, has_more: false };
	if (method === "PATCH") return { id: "s1", updated: true, additional_metadata_keys: ["k"] };
	if (method === "DELETE") return { success: true, deleted: true };
	return { success: true };
}

function backend() {
	const fetchFn: typeof fetch = async (input, init) => {
		const url = new URL(String(input));
		const body = JSON.stringify({ success: true, data: dataFor(init?.method ?? "GET", url.pathname), meta: { request_id: REQUEST_ID } });
		return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
	};
	const hydra = new HydraDB({ token: "synthetic-key", database: "db", collection: "notes", baseUrl: "https://api.test", maxRetries: 0, fetchFn });
	// HydraDB does not hand fetchFn to its graph resource, so the graph tools need their own.
	Object.assign(hydra, { graph: new GraphResource({ token: "synthetic-key", baseUrl: "https://api.test", maxRetries: 0, fetchFn } as never) });
	return hydra;
}

const ARGUMENTS: Record<string, Record<string, unknown>> = {
	hydradb_ingest: { text: "x" },
	hydradb_update: { id: "s1", additional_metadata: { k: "v" } },
	hydradb_list: { type: "knowledge" },
	hydradb_relations: { id: "s1" },
	hydradb_delete: { ids: ["s1"], type: "knowledge" },
	hydradb_list_collections: {},
	hydradb_delete_collection: { collection: "notes" },
	hydradb_graph_query: { query: "MATCH (n) RETURN n LIMIT 1" },
};

test("every tool with an output schema validates in the SDK client when the backend returns a request ID", async () => {
	const server = createHydraDBServer(backend(), { database: "db", collection: "notes" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "output-schema-test", version: "0" });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	try {
		const schemaTools = (await client.listTools()).tools.filter((tool) => tool.outputSchema).map((tool) => tool.name).sort();
		assert.deepEqual(schemaTools, Object.keys(ARGUMENTS).sort(), "every output-schema tool has arguments in this test");
		const failures: string[] = [];
		for (const name of schemaTools) {
			try {
				const result = await client.callTool({ name, arguments: ARGUMENTS[name] });
				if (result.isError) failures.push(`${name}: isError ${JSON.stringify(result.content)}`);
				else if (result.structuredContent?.request_id !== REQUEST_ID) failures.push(`${name}: request_id missing from structuredContent`);
			} catch (error) {
				failures.push(`${name}: ${(error as Error).message}`);
			}
		}
		assert.deepEqual(failures, []);
	} finally {
		await client.close();
	}
});
