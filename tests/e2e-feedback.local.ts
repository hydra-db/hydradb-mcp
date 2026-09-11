/**
 * Manual end-to-end check against a REAL HydraDB, driving the MCP server the
 * way a client does. Not part of the suite: it needs a live token and writes a
 * real feedback row.
 *
 *   HYDRADB_API_KEY=... HYDRADB_DATABASE=... npx tsx tests/e2e-feedback.local.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { HydraDB } from "../src/hydra/index.js";
import { createHydraDBServer } from "../src/server.js";

const token = process.env.HYDRADB_API_KEY ?? "";
const database = process.env.HYDRADB_DATABASE ?? "";
const baseUrl = process.env.HYDRADB_BASE_URL;
if (!token || !database) throw new Error("set HYDRADB_API_KEY and HYDRADB_DATABASE");

const hydra = new HydraDB({ token, database, ...(baseUrl ? { baseUrl } : {}) });
const server = createHydraDBServer(hydra, {});
const [a, b] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "e2e", version: "0" }, { capabilities: {} });
await Promise.all([server.connect(b), client.connect(a)]);

const textOf = (r: unknown) =>
	((r as { content?: { type: string; text?: string }[] }).content ?? [])
		.map((c) => c.text ?? "")
		.join("\n");

console.log("1. hydradb_feedback is registered");
const tools = (await client.listTools()).tools.map((t) => t.name);
console.log("   present:", tools.includes("hydradb_feedback"));

console.log("\n2. hydradb_query");
const q = await client.callTool({
	name: "hydradb_query",
	arguments: { query: process.env.E2E_QUERY ?? "what do you know", max_results: 3 },
});
const qText = textOf(q);
console.log("   " + qText.split("\n").slice(0, 2).join("\n   ").slice(0, 240));

const m = qText.match(/request_id:\s*([0-9a-fA-F-]{36})/);
console.log("\n3. request_id surfaced in the query output:", m ? m[1] : "NOT FOUND");
if (!m) { console.log("   (unwrap dropped meta — the feedback tool would be unusable)"); process.exit(1); }

console.log("\n4. hydradb_feedback against that id");
const f = await client.callTool({
	name: "hydradb_feedback",
	arguments: {
		request_id: m[1],
		feedback: "E2E check from the MCP feedback tool — ignore.",
		rating: "neutral",
		ground_truth_source_ids: ["e2e-nonexistent-source"],
		metadata: { harness: "mcp-e2e" },
	},
});
console.log("   " + textOf(f));
console.log("   isError:", (f as { isError?: boolean }).isError === true);

console.log("\n5. a submission with no signal is refused");
const bad = await client.callTool({
	name: "hydradb_feedback",
	arguments: { request_id: m[1] },
});
console.log("   isError:", (bad as { isError?: boolean }).isError === true, "|", textOf(bad).slice(0, 120));
process.exit(0);
