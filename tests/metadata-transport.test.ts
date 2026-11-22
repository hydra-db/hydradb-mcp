import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { HydraDB } from "../src/hydra/index.js";
import { createHydraDBServer } from "../src/server.js";
import { UNIFIED_INGEST_202 } from "./unified-fixture.js";

const warning = { code: "TRANSPORT_NOTICE", message: "Backend notice with collection scope.", collections: ["notes"] };

test("all existing database and graph tools preserve real HTTP envelope metadata", async () => {
	const seen: string[] = [];
	let statsWithoutMeta = false;
	const api = http.createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const path = new URL(req.url!, "http://loopback").pathname;
		seen.push(`${req.method} ${path}`);
		let data: unknown;
		if (path === "/databases") data = req.method === "GET"
			? { databases: ["db", "other"], details: [{ database: "db", type: "split" }] }
			: { database: req.method === "DELETE" ? "other" : "new-db", status: "accepted" };
		else if (path === "/databases/collections") data = req.method === "GET" ? { collections: ["notes"] } : { database: "db", collection: "notes", status: "deletion_scheduled" };
		else if (path === "/databases/stats") data = { database: "db", knowledge_collection: { row_count: 1 }, memory_collection: { row_count: 1 } };
		else if (path === "/databases/status") data = { database: "db", infra: { ready_for_ingestion: true } };
		else if (path === "/databases/db/metadata-schema") data = req.method === "GET" ? { database: "db", fields: [] } : { database: "db", added_fields: [] };
		else if (path === "/byog/query") data = [{ value: 1 }];
		else if (path === "/byog/collections") data = req.method === "GET" ? { collections: ["notes"] } : { deleted: true };
		else if (path === "/byog/databases") data = req.method === "POST" ? { database: "graph-db", status: "ready" } : { deleted: true, deleted_collections: ["notes"] };
		else { res.statusCode = 404; res.end(); return; }
		res.setHeader("content-type", "application/json");
		const meta = statsWithoutMeta && path === "/databases/stats" ? undefined : { request_id: `req-${path}`, warnings: [warning], collection: "notes" };
		res.end(JSON.stringify(path.endsWith("metadata-schema") && req.method !== "GET"
			? { ...(data as object), meta } : { success: true, data, meta }));
	});
	await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
	const baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
	const hydra = new HydraDB({ token: "synthetic-metadata-key", database: "db", collection: "notes", baseUrl, maxRetries: 0 });
	const server = createHydraDBServer(hydra, { database: "graph-db", collection: "notes" });
	const [ct, st] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "metadata-transport", version: "0" });
	await Promise.all([server.connect(st), client.connect(ct)]);
	try {
		for (const call of [
			{ name: "hydradb_databases", arguments: {}, path: "/databases" },
			{ name: "hydradb_database_create", arguments: { database: "new-db" }, path: "/databases" },
			{ name: "hydradb_database_create", arguments: { database: "new-unified", type: "unified" }, path: "/databases" },
			{ name: "hydradb_database_delete", arguments: { database: "other" }, path: "/databases" },
			{ name: "hydradb_database_readiness", arguments: {}, path: "/databases/status" },
			{ name: "hydradb_database_stats", arguments: {}, path: "/databases/stats" },
			{ name: "hydradb_database_schema_inspect", arguments: {}, path: "/databases/db/metadata-schema" },
			{ name: "hydradb_database_schema_update", arguments: { add_fields: [{ name: "tag", data_type: "VARCHAR" }] }, path: "/databases/db/metadata-schema" },
			{ name: "hydradb_list_collections", arguments: {}, path: "/databases/collections" },
			{ name: "hydradb_delete_collection", arguments: { collection: "notes" }, path: "/databases/collections" },
			{ name: "hydradb_graph_query", arguments: { query: "RETURN 1" }, path: "/byog/query" },
			{ name: "hydradb_graph_collections", arguments: {}, path: "/byog/collections" },
			{ name: "hydradb_graph_admin", arguments: { action: "create_database" }, path: "/byog/databases" },
			{ name: "hydradb_graph_admin", arguments: { action: "drop_collection", collection: "notes" }, path: "/byog/collections" },
			{ name: "hydradb_graph_admin", arguments: { action: "drop_database" }, path: "/byog/databases" },
		]) {
			const result = await client.callTool({ name: call.name, arguments: call.arguments });
			assert.equal(result.isError, undefined, `${call.name}: ${JSON.stringify(result.content)}`);
			assert.match(JSON.stringify(result.content), /TRANSPORT_NOTICE/, call.name);
			const metadata = result.structuredContent!;
			assert.ok((metadata.warnings as unknown[]).some((entry) => JSON.stringify(entry) === JSON.stringify(warning)), call.name);
			assert.ok(String(metadata.request_id).startsWith("req-"), call.name);
			assert.ok(seen.some((request) => request.endsWith(call.path)), call.name);
		}
		statsWithoutMeta = true;
		const result = await client.callTool({ name: "hydradb_list_collections", arguments: {} });
		assert.equal(result.structuredContent?.request_id, "req-/databases/collections");
		assert.ok(JSON.stringify(result.structuredContent?.warnings).includes("TRANSPORT_NOTICE"));
	} finally {
		await client.close();
		await server.close();
		api.closeAllConnections();
		await new Promise<void>((resolve) => api.close(() => resolve()));
	}
});

test("SDK and raw ingest preserve backend default warnings, request ids, scope, instructions and app knowledge", async () => {
	const warnings = [
		{ code: "inference_enabled_by_default", message: "Inference is enabled by default for 1 accepted item because infer was omitted. Set infer to false on an item to disable inference for that item.", collections: ["notes"] },
		{ code: "enrichment_enabled_by_default", message: "Enrichment is enabled by default for 1 accepted item because enrich was omitted. Set enrich to false on an item or on the request to disable enrichment.", collections: ["notes"] },
		warning,
	];
	const wire: { contentType: string; body: string }[] = [];
	const api = http.createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		assert.equal(req.url, "/context/ingest");
		wire.push({ contentType: String(req.headers["content-type"]), body: Buffer.concat(chunks).toString() });
		res.setHeader("content-type", "application/json");
		const data = String(req.headers["content-type"]).includes("application/json") ? UNIFIED_INGEST_202 : {
			...UNIFIED_INGEST_202, results: UNIFIED_INGEST_202.results.map(({ source_id, ...item }) => ({ ...item, id: source_id })),
		};
		res.end(JSON.stringify({ success: true, data,
			meta: { request_id: "req-ingest-defaults", database: "db", collection: "notes", warnings } }));
	});
	await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
	const baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
	try {
		for (const mode of ["split", "unified", "app-knowledge"] as const) {
			const hydra = new HydraDB({ token: "synthetic-metadata-key", database: "db", collection: "notes", baseUrl, maxRetries: 0 });
			hydra.databases.recordLayout("db", mode === "unified" ? "unified" : "split");
			const server = createHydraDBServer(hydra);
			const [ct, st] = InMemoryTransport.createLinkedPair();
			const client = new Client({ name: "ingest-transport", version: "0" });
			await Promise.all([server.connect(st), client.connect(ct)]);
			try {
				const args = mode === "app-knowledge"
					? { kind: "knowledge", app_knowledge: [{ id: "ticket-1", kind: "ticket", fields: { title: "AUTH-1", body: "Keep the audit trail." }, acl: ["group:engineering"] }] }
					: { text: "A customer priority.", custom_instructions: "Keep customer priorities.", infer: true };
				const result = await client.callTool({ name: "hydradb_ingest", arguments: args });
				assert.equal(result.isError, undefined, `${mode}: ${JSON.stringify(result.content)}`);
				const fields = result.structuredContent!;
				assert.deepEqual(fields.warnings, warnings, mode);
				assert.equal(fields.request_id, "req-ingest-defaults", mode);
				assert.deepEqual(fields.accepted_ids, ["policy-1"], mode);
				assert.equal(fields.success_count, 1, mode);
				assert.equal((fields.scope_notice as { database: string }).database, "db", mode);
				assert.equal((fields.scope_notice as { collection: string }).collection, "notes", mode);
				for (const notice of warnings) {
					assert.ok(JSON.stringify(result.content).includes(notice.code), mode);
					assert.ok(JSON.stringify(result.content).includes(notice.message), mode);
				}
				const sent = wire.at(-1)!;
				if (mode === "unified") {
					assert.match(sent.contentType, /application\/json/);
					assert.equal(JSON.parse(sent.body).context[0].instructions, "Keep customer priorities.");
				} else {
					assert.match(sent.contentType, /multipart\/form-data/);
					if (mode === "split") assert.match(sent.body, /custom_instructions.*Keep customer priorities\./);
					else {
						assert.match(sent.body, /name="app_knowledge"/);
						assert.match(sent.body, /"id":"ticket-1"/);
						assert.match(sent.body, /"fields":\{"title":"AUTH-1","body":"Keep the audit trail\.","kind":"ticket"\}/);
						assert.match(sent.body, /"acl":\["group:engineering"\]/);
					}
				}
			} finally { await client.close(); await server.close(); }
		}
	} finally {
		api.closeAllConnections();
		await new Promise<void>((resolve) => api.close(() => resolve()));
	}
});
