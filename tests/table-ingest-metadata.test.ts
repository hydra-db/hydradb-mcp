import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { HydraDB } from "../src/hydra/index.js";
import { createHydraDBServer } from "../src/server.js";

test("structured table uploads retain their schema, request ID and backend warnings", async () => {
	const definition = { name: "transaction", fields: { amount: "number" } };
	const warning = { code: "table-coverage", message: "Synthetic table coverage warning" };
	const uploads: FormData[] = [];
	const fetchFn: typeof fetch = async (input, init) => {
		const path = new URL(String(input)).pathname;

		if (path === "/databases") {
			return Response.json({ success: true, data: { databases: ["db"], details: [{ database: "db", type: "split" }] } });
		}

		assert.equal(path, "/context/ingest");
		assert.ok(init?.body instanceof FormData);
		uploads.push(init.body);

		return Response.json({
			success: true,
			data: { success: true, success_count: 1, failed_count: 0, results: [{ id: "statement", status: "queued" }] },
			meta: { request_id: "table-request", warnings: [warning] },
		}, { status: 202 });
	};
	const hydra = new HydraDB({ token: "synthetic-key", database: "db", collection: "statements", baseUrl: "https://api.test", maxRetries: 0, fetchFn });
	const server = createHydraDBServer(hydra, { database: "db", collection: "statements" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "table-metadata-test", version: "0" });

	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

	try {
		const result = await client.callTool({ name: "hydradb_ingest", arguments: {
			database: "db", collection: "statements", source_id: "statement", record_type: definition,
			file: { filename: "statement.pdf", content_base64: "aGVsbG8=" },
		} });

		assert.equal(result.isError, undefined, JSON.stringify(result.content));
		assert.equal(uploads.length, 1);
		assert.deepEqual(JSON.parse(String(uploads[0]?.get("record_type"))), definition);
		assert.equal(uploads[0]?.get("database"), "db");
		assert.equal(uploads[0]?.get("collection"), "statements");
		assert.equal(result.structuredContent?.request_id, "table-request");
		assert.deepEqual(result.structuredContent?.warnings, [warning]);
	} finally {
		await client.close();
	}
});
