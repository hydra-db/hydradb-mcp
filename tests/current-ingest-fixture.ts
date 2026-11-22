import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { HydraDB } from "../src/hydra/index.js";
import { createHydraDBServer } from "../src/server.js";

export async function currentIngestFixture(options: { layout?: "split" | "unified" | "unknown"; refuseSplit?: boolean; failWrites?: boolean } = {}) {
	const writes: Record<string, unknown>[] = [];
	const backend = http.createServer(async (req, res) => {
		res.setHeader("content-type", "application/json");
		if (req.method === "GET" && req.url === "/databases") {
			res.statusCode = options.layout === "unknown" ? 503 : 200;
			res.end(JSON.stringify({ success: true, data: { databases: ["db"], details: [{ database: "db", type: options.layout ?? "split" }] } }));
			return;
		}
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const bytes = Buffer.concat(chunks);
		const contentType = String(req.headers["content-type"]);
		let body: Record<string, unknown>;
		if (contentType.includes("application/json")) body = JSON.parse(bytes.toString());
		else {
			const form = await new Response(bytes, { headers: { "content-type": contentType } }).formData();
			body = {};
			for (const [key, value] of form) {
				if (typeof value !== "string") body[key] = { filename: value.name, text: await value.text() };
				else body[key] = ["memories", "document_metadata", "app_knowledge"].includes(key) ? JSON.parse(value) : value;
			}
		}
		writes.push(body);
		if (options.failWrites || (options.refuseSplit && body.type === "memory")) {
			res.statusCode = options.failWrites ? 503 : 400;
			res.end(JSON.stringify({ success: false, error: { code: options.failWrites ? "UPSTREAM" : "CORPUS_TYPE_UNSUPPORTED",
				message: options.failWrites ? "upstream unavailable" : "this database is unified: send the content as `items` (a JSON array of text or conversation items)" } }));
			return;
		}
		const inputs = (body.context ?? body.memories ?? body.app_knowledge ?? body.document_metadata ?? [{}]) as Record<string, unknown>[];
		res.end(JSON.stringify({ success: true, data: { success: true, success_count: inputs.length, failed_count: 0,
			results: inputs.map((item, i) => ({ id: item.context_id ?? item.source_id ?? item.id ?? `saved-${i}`, source_id: item.context_id ?? item.source_id ?? item.id ?? `saved-${i}`, status: "queued" })) },
			meta: { request_id: "req-current-ingest", database: "db", collection: "notes" } }));
	});
	await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
	const hydra = new HydraDB({ token: "synthetic-current-key", database: "db", collection: "notes",
		baseUrl: `http://127.0.0.1:${(backend.address() as AddressInfo).port}`, maxRetries: 2 });
	const server = createHydraDBServer(hydra);
	const client = new Client({ name: "current-ingest-regressions", version: "0" });
	const [ct, st] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(st), client.connect(ct)]);
	return { hydra, writes, call: (args: Record<string, unknown>) => client.callTool({ name: "hydradb_ingest", arguments: args }),
		async close() {
			await client.close(); await server.close(); backend.closeAllConnections();
			await new Promise<void>((resolve) => backend.close(() => resolve()));
		} };
}
