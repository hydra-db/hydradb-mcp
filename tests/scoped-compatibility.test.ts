import assert from "node:assert/strict";
import { test } from "node:test";
import type { HydraDBClient } from "@hydradb/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { resolveConfig } from "../src/config.js";
import { resolveRequestCredentials } from "../src/http-config.js";
import { HydraDB } from "../src/hydra/index.js";
import { createHydraDBServer } from "../src/server.js";

const warnings = [{ code: "ACL_REPLACED", message: "The stored ACL was replaced.", collections: ["notes", "archive"] }];
const unified = { chunks: [], graph: [], forceful_relations: [], llm_prompt: "" };

function fixture(opts: {
	database?: string;
	layout?: "split" | "unified";
	collection?: string;
	allowedDatabases?: string[];
	allowedCollections?: string[];
	queryData?: unknown;
	meta?: Record<string, unknown>;
} = {}) {
	const calls: { path: string; body: Record<string, unknown> }[] = [];
	const envelope = (data: unknown) => ({ success: true, data, meta: { request_id: "req-test", warnings, ...opts.meta } });
	const record = (path: string, data: unknown) => async (body: Record<string, unknown>) => {
		calls.push({ path, body });
		return envelope(data);
	};
	const sdk = {
		query: record("sdk.query", opts.queryData ?? { chunks: [] }),
		context: {
			ingest: record("sdk.ingest", { success: true, successCount: 1, failedCount: 0 }),
			list: record("sdk.list", { userMemories: [] }),
			inspect: record("sdk.inspect", { success: true, content: "stored text" }),
			status: record("sdk.status", { statuses: [] }),
		},
		databases: { list: async () => envelope({ databases: ["db-a", "db-b"], details: [{ database: "db-a", type: opts.layout ?? "split" }, { database: "db-b", type: opts.layout ?? "split" }] }), create: record("sdk.create", { database: "new-db", status: "accepted" }) },
		fetch: async (_path: string, init: RequestInit) => {
			calls.push({ path: "/query", body: JSON.parse(String(init.body)) });
			return new Response(JSON.stringify(envelope(opts.queryData ?? { chunks: [] })), { status: 200 });
		},
	} as unknown as HydraDBClient;
	const fetchFn: typeof fetch = async (input, init) => {
		const path = new URL(String(input)).pathname;
		calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : {} });
		const data = path === "/databases"
			? { databases: ["db-a", "db-b"], details: [{ database: "db-a", type: opts.layout ?? "split" }, { database: "db-b", type: opts.layout ?? "split" }] }
			: path === "/query" ? opts.queryData ?? (opts.layout === "unified" ? unified : { chunks: [] })
			: path === "/context/list" ? { sources: [], total: 0 }
			: { success: true, results: [{ source_id: "new-id", status: "queued" }], success_count: 1, failed_count: 0 };
		return new Response(JSON.stringify(envelope(data)), { status: 200, headers: { "content-type": "application/json" } });
	};
	const hydra = new HydraDB({ token: "synthetic-key", ...opts, baseUrl: "https://api.test", maxRetries: 0, fetchFn }, sdk);
	return { hydra, calls };
}

async function connect(hydra: HydraDB) {
	const server = createHydraDBServer(hydra);
	const [ct, st] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "scoped-test", version: "0" });
	await Promise.all([server.connect(st), client.connect(ct)]);
	return client;
}

const text = (result: { content?: unknown }) => JSON.stringify(result.content);

test("unified query defaults expose only required metadata while full results require structured true", async () => {
	const queryData = { chunks: [{ context_id: "ctx-1", content: "A source body." }], graph: [], forceful_relations: [], llm_prompt: "# Query results\n\nA source body." };
	const { hydra } = fixture({ database: "db-a", collection: "notes", layout: "unified", queryData });
	const client = await connect(hydra);
	try {
		for (const detail of ["compact", "full"] as const) {
			const plain = await client.callTool({ name: "hydradb_query", arguments: { query: "x", detail } });
			assert.equal(plain.isError, undefined, text(plain));
			assert.deepEqual(Object.keys(plain.structuredContent ?? {}).sort(), ["request_id", "scope_notice", "warnings"]);
			assert.ok(text(plain).includes("A source body."));
			const full = await client.callTool({ name: "hydradb_query", arguments: { query: "x", detail, structured: true } });
			assert.equal(full.isError, undefined, text(full));
			assert.equal((full.structuredContent?.chunks as { context_id: string }[])[0]?.context_id, "ctx-1");
			assert.ok(Array.isArray(full.structuredContent?.sources));
		}
	} finally { await client.close(); }
});

test("API-key-only stdio and HTTP configuration has no invented database", () => {
	assert.equal(resolveConfig({ HYDRADB_API_KEY: "synthetic-key" }).database, undefined);
	const credentials = resolveRequestCredentials({ authorization: "Bearer synthetic-key" }, { HYDRADB_DATABASE: "operator-db", HYDRADB_GRAPH_DATABASE: "operator-graph" });
	assert.ok(credentials.ok);
	assert.equal(credentials.credentials.database, undefined);
	assert.equal(credentials.credentials.graph.database, "");
});

test("database list/create work without a default; scoped data fails before any request", async () => {
	const { hydra, calls } = fixture();
	const client = await connect(hydra);
	const listed = await client.callTool({ name: "hydradb_databases", arguments: {} });
	assert.equal(listed.isError, undefined, text(listed));
	assert.deepEqual(listed.structuredContent?.databases, ["db-a", "db-b"]);
	assert.equal(listed.structuredContent?.default, null);
	const created = await client.callTool({ name: "hydradb_database_create", arguments: { database: "new-db" } });
	assert.equal(created.isError, undefined, text(created));
	const before = calls.length;
	const missing = await client.callTool({ name: "hydradb_query", arguments: { query: "hello" } });
	assert.equal(missing.isError, true);
	assert.match(text(missing), /database.*per.call|pass.*database/i);
	assert.equal(calls.length, before);
	const explicit = await client.callTool({ name: "hydradb_query", arguments: { query: "hello", database: "db-b", collection: "notes" } });
	assert.equal(explicit.isError, undefined, text(explicit));
	assert.ok(calls.some((c) => c.body.database === "db-b"));
	await client.close();
});

test("canonical query selectors win and also ride on their legacy wire names", async () => {
	const { hydra, calls } = fixture({ database: "db-a", collection: "notes" });
	const client = await connect(hydra);
	const queryTool = (await client.listTools()).tools.find((tool) => tool.name === "hydradb_query")!;
	assert.equal("context" in (queryTool.inputSchema.properties ?? {}), false);
	const result = await client.callTool({ name: "hydradb_query", arguments: {
		query: "hello", type: "knowledge", query_explicit_relations: false, follow_forceful_relations: true,
		query_forceful_relations: true, additional_graph_context: "", additional_context: "legacy",
	} });
	assert.equal(result.isError, undefined, text(result));
	const query = calls.find((c) => c.path === "/query")!;
	assert.ok(query, "canonical options must use the wire bridge");
	assert.equal(query.body.type, "knowledge");
	assert.equal(query.body.query_explicit_relations, false);
	assert.equal(query.body.query_forceful_relations, false);
	assert.equal(query.body.additional_graph_context, "");
	assert.equal(query.body.additional_context, "");
	assert.equal(query.body.recency_bias, 0.6);
	assert.equal("follow_forceful_relations" in query.body, false);
	const conflict = await client.callTool({ name: "hydradb_query", arguments: { query: "x", type: "memory", kind: "knowledge" } });
	assert.equal(conflict.isError, true);
	assert.match(text(conflict), /type.*kind|kind.*type/);
	await client.close();
});

test("legacy query names reach both canonical and legacy wire names on split and unified", async () => {
	for (const layout of ["split", "unified"] as const) {
		for (const relation of ["follow_forceful_relations", "query_forceful_relations"]) {
			const { hydra, calls } = fixture({ database: "db-a", collection: "notes", layout });
			const client = await connect(hydra);
			const result = await client.callTool({ name: "hydradb_query", arguments: { query: "x", [relation]: false, additional_context: "legacy hint" } });
			assert.equal(result.isError, undefined, text(result));
			const body = calls.find((c) => c.path === "/query")!.body;
			assert.equal(body.query_explicit_relations, false);
			assert.equal(body.query_forceful_relations, false);
			assert.equal(body.additional_graph_context, "legacy hint");
			assert.equal(body.additional_context, "legacy hint");
			assert.equal("follow_forceful_relations" in body, false);
			assert.equal(body.recency_bias, 0.6);
			if (layout === "unified") assert.equal("type" in body, false);
			else assert.equal(body.type, "all");
			await client.close();
		}
	}
});

test("ingestion keeps automatic layout routing and explicit/conflicting type validation", async () => {
	for (const layout of ["split", "unified"] as const) {
		const { hydra, calls } = fixture({ database: "db-a", layout });
		const client = await connect(hydra);
		const result = await client.callTool({ name: "hydradb_ingest", arguments: { text: "hello", infer: false } });
		assert.equal(result.isError, undefined, text(result));
		const ingested = calls.find((c) => c.path === (layout === "unified" ? "/context/ingest" : "sdk.ingest"))!.body;
		if (layout === "unified") {
			assert.equal("type" in ingested, false);
			assert.equal((ingested.context as { enrich: boolean }[])[0]!.enrich, false);
		} else assert.equal(ingested.type, "memory");
		const before = calls.length;
		const conflict = await client.callTool({ name: "hydradb_ingest", arguments: { text: "x", type: "knowledge", kind: "memory" } });
		assert.equal(conflict.isError, true);
		assert.equal(calls.length, before);
		await client.close();
	}
});

test("warnings and scope notices are machine readable and human visible without changing routing", async () => {
	const { hydra } = fixture({ database: "db-a", collection: "notes", allowedDatabases: ["db-a", "db-b"], allowedCollections: ["notes"] });
	const client = await connect(hydra);
	for (const database of [undefined, "db-b"]) {
		const result = await client.callTool({ name: "hydradb_query", arguments: { query: "x", ...(database ? { database } : {}) } });
		assert.equal(result.isError, undefined, text(result));
		assert.deepEqual(result.structuredContent?.warnings, warnings);
		const notice = result.structuredContent?.scope_notice as Record<string, unknown>;
		assert.equal(notice.database_source, database ? "per_call" : "connection_default");
		assert.equal(notice.collection_source, "connection_default");
		assert.equal(notice.database, database ?? "db-a");
		assert.equal(notice.oauth_restricted, true);
		assert.match(text(result), /ACL_REPLACED/);
		assert.match(text(result), /per.call|connection.default/i);
	}
	await client.close();
});

test("out-of-grant scope is refused before even the layout probe", async () => {
	const { hydra, calls } = fixture({ database: "db-a", collection: "notes", allowedDatabases: ["db-a"], allowedCollections: ["notes"] });
	const client = await connect(hydra);
	for (const call of [
		{ name: "hydradb_query", arguments: { query: "x" } },
		{ name: "hydradb_ingest", arguments: { text: "x" } },
		{ name: "hydradb_list", arguments: { type: "memory" } },
		{ name: "hydradb_inspect", arguments: { id: "x" } },
		{ name: "hydradb_delete", arguments: { id: "x" } },
		{ name: "hydradb_status", arguments: { ids: ["x"] } },
		{ name: "hydradb_subgraph", arguments: { id: "x" } },
	]) {
		for (const override of [{ database: "denied" }, { collection: "denied" }]) {
			const result = await client.callTool({ name: call.name, arguments: { ...call.arguments, ...override } });
			assert.equal(result.isError, true, call.name);
			assert.match(text(result), /confined/);
			assert.equal(result.structuredContent?.scope_notice, undefined);
			assert.equal(calls.length, 0);
		}
	}
	await client.close();
});

test("canonical linked response bucket wins over old map, including empty map", async () => {
	for (const canonical of [{}, { linked: { id: "linked", chunk_content: "canonical linked text" } }]) {
		const { hydra } = fixture({ database: "db-a", queryData: {
			chunks: [], additional_graph_context: canonical,
			additional_context: { stale: { id: "stale", chunk_content: "stale text" } },
		} });
		const result = await hydra.context.query({ query: "x", additionalGraphContext: "request hint" } as never);
		assert.deepEqual((result as Record<string, unknown>).additionalGraphContext, (result as Record<string, unknown>).additionalContext);
		assert.deepEqual(Object.keys((result as Record<string, unknown>).additionalContext as object), Object.keys(canonical));
	}
});

test("warnings survive SDK and unified raw ingestion/list/read paths", async () => {
	for (const layout of ["split", "unified"] as const) {
		const { hydra } = fixture({ database: "db-a", collection: "notes", layout });
		const client = await connect(hydra);
		for (const call of [
			{ name: "hydradb_ingest", arguments: { text: "hello" } },
			{ name: "hydradb_list", arguments: { type: "memory" } },
			{ name: "hydradb_inspect", arguments: { id: "stored" } },
		]) {
			const result = await client.callTool(call.name === "hydradb_list" && layout === "unified" ? { ...call, arguments: {} } : call);
			assert.equal(result.isError, undefined, text(result));
			assert.deepEqual(result.structuredContent?.warnings, warnings, `${layout} ${call.name}`);
			assert.match(text(result), /notes, archive/);
		}
		await client.close();
	}
});

test("collection omission stays API-resolved unless response meta reports its name", async () => {
	for (const collection of [undefined, "reported-collection"]) {
		const { hydra, calls } = fixture({ database: "db-a", meta: collection ? { collection } : {} });
		const client = await connect(hydra);
		const result = await client.callTool({ name: "hydradb_ingest", arguments: { text: "hello" } });
		assert.equal(result.isError, undefined, text(result));
		const notice = result.structuredContent?.scope_notice as Record<string, unknown>;
		assert.equal(notice.collection_source, "api_resolved");
		assert.equal(notice.collection, collection ?? null);
		assert.equal(notice.collection_reported, collection != null);
		assert.equal("collection" in calls.find((c) => c.path === "sdk.ingest")!.body, false);
		await client.close();
	}
});

test("unknown warnings retain code and collections while invalid entries are ignored", async () => {
	const custom = { code: "FUTURE_NOTICE", message: "A future backend notice.", collections: ["one"] };
	const { hydra } = fixture({ database: "db-a", collection: "notes", meta: { warnings: [null, { code: 2 }, custom] } });
	const client = await connect(hydra);
	const result = await client.callTool({ name: "hydradb_query", arguments: { query: "x" } });
	assert.deepEqual(result.structuredContent?.warnings, [custom]);
	assert.match(text(result), /FUTURE_NOTICE/);
	await client.close();
});

test("empty warnings stay absent and oversized warning collections remain bounded in both views", async () => {
	for (const entries of [[], Array.from({ length: 20 }, (_, i) => ({ code: `NOTICE_${i}`, message: "message".repeat(500), collections: Array.from({ length: 100 }, (_, j) => `collection-${j}`) }))]) {
		const { hydra } = fixture({ database: "db-a", collection: "notes", meta: { warnings: entries } });
		const client = await connect(hydra);
		const result = await client.callTool({ name: "hydradb_query", arguments: { query: "x" } });
		if (entries.length === 0) {
			assert.equal(result.structuredContent?.warnings, undefined);
			assert.doesNotMatch(text(result), /Warnings:/);
		} else {
			const out = result.structuredContent!;
			assert.ok(JSON.stringify({ warnings: out.warnings, warnings_omitted: out.warnings_omitted }).length <= 4000);
			assert.ok(Number(out.warnings_omitted) > 0);
			assert.match(text(result), /additional warnings omitted/);
		}
		await client.close();
	}
});

test("legacy response bucket remains a map and is independent from a request hint", async () => {
	const { hydra } = fixture({ database: "db-a", queryData: { chunks: [], additional_context: { old: { id: "old", chunk_content: "linked text" } } } });
	const result = await hydra.context.query({ query: "x", additionalGraphContext: "a request hint" });
	const split = result as { additionalContext: Record<string, unknown>; additionalGraphContext: Record<string, unknown> };
	assert.deepEqual(Object.keys(split.additionalGraphContext), ["old"]);
	assert.deepEqual(split.additionalGraphContext, split.additionalContext);
});

test("canonical type preserves explicit split knowledge ingestion and query defaults stay all", async () => {
	const { hydra, calls } = fixture({ database: "db-a", collection: "notes" });
	const client = await connect(hydra);
	const ingested = await client.callTool({ name: "hydradb_ingest", arguments: { text: "document", type: "knowledge" } });
	assert.equal(ingested.isError, undefined, text(ingested));
	const ingest = calls.find((c) => c.path === "sdk.ingest")!.body;
	assert.equal(ingest.type, "knowledge");
	assert.ok(Array.isArray(ingest.documents));
	assert.equal("memories" in ingest, false);
	await client.callTool({ name: "hydradb_query", arguments: { query: "x" } });
	const query = calls.find((c) => c.path === "sdk.query")!.body;
	assert.equal(query.type, "all");
	assert.equal(query.recencyBias, 0.6);
	await client.close();
});

test("canonical and legacy selectors may agree and explicit recency zero is preserved", async () => {
	const { hydra, calls } = fixture({ database: "db-a", collection: "notes" });
	const client = await connect(hydra);
	const result = await client.callTool({ name: "hydradb_query", arguments: {
		query: "x", type: "memory", kind: "memory", recency_bias: 0, additional_graph_context: null, additional_context: "",
	} });
	assert.equal(result.isError, undefined, text(result));
	const body = calls.find((c) => c.path === "/query")!.body;
	assert.equal(body.type, "memory");
	assert.equal(body.recency_bias, 0);
	assert.equal(body.additional_graph_context, "");
	await client.close();
});

test("scope notice reports the normalized effective database, not raw argument whitespace", async () => {
	const { hydra } = fixture({ database: "db-a", collection: "notes", allowedCollections: ["notes"] });
	const client = await connect(hydra);
	const result = await client.callTool({ name: "hydradb_query", arguments: { query: "x", database: "  db-b  ", collection: "  notes  " } });
	assert.equal(result.isError, undefined, text(result));
	assert.equal((result.structuredContent?.scope_notice as Record<string, unknown>).database, "db-b");
	assert.equal((result.structuredContent?.scope_notice as Record<string, unknown>).collection, "notes");
	await client.close();
});

test("an explicit existing graph operation needs no unrelated default context database", async () => {
	const { hydra } = fixture();
	let called = false;
	hydra.graph.query = async (args) => {
		called = true;
		assert.equal(args.database, "explicit-graph");
		return [];
	};
	const client = await connect(hydra);
	const result = await client.callTool({ name: "hydradb_graph_query", arguments: { query: "RETURN 1", database: "explicit-graph", collection: "notes" } });
	assert.equal(result.isError, undefined, text(result));
	assert.equal(called, true);
	await client.close();
});
