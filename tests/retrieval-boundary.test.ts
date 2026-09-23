import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { HydraDBClient } from "@hydradb/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { HydraDB, type HydraConfig } from "../src/hydra/index.js";
import { createHydraDBServer } from "../src/server.js";

type ToolArgs = Record<string, unknown>;
type WireBody = { collection?: string; collections?: unknown; page?: number; acl?: string[]; filters?: { source_fields?: Record<string, string>; additional_metadata?: { connector_id?: string } }; group_threads?: boolean };
type WireCall = { url: URL; body: WireBody; headers: Headers; signal?: AbortSignal | null };
type SourceRef = { id: string; inspect_args: ToolArgs; list_args: ToolArgs; scope_unresolved?: boolean };
type QueryOutput = { resolved_scope: unknown; request_id?: string; sources: SourceRef[]; scope_warning?: string };
type ListOutput = { items: { id: string; title?: string; external_id?: string; provider?: string; parent_external_id?: string; connector_id?: string; children_args?: ToolArgs }[]; has_more: boolean; next_args: ToolArgs };
type InspectOutput = { content: string; offset: number; total_characters: number; complete: boolean; has_more: boolean; content_sha256: string; next_args: ToolArgs };
function output<T>(result: { structuredContent?: unknown }): T {
	assert.ok(result.structuredContent, "structured output must be present");
	return result.structuredContent as T;
}
const json = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { headers: { "content-type": "application/json" } });
const text = (result: { content?: unknown }) => z.array(z.object({ type: z.string(), text: z.string().optional() })).parse(result.content).filter((part) => part.type === "text").map((part) => part.text).join("\n");

// Real generated HydraDB SDK and real MCP serialization/validation. Only HTTP
// is replaced with synthetic fixtures; every unhandled route fails closed.
async function fixture(t: TestContext, respond: (call: WireCall) => Response | Promise<Response>, config: Partial<HydraConfig> = {}) {
	const calls: WireCall[] = [];
	const fetchFn: typeof fetch = async (input, init) => {
		const call = { url: new URL(String(input)), body: JSON.parse(String(init?.body ?? "{}")), headers: new Headers(init?.headers), signal: init?.signal };
		calls.push(call);
		return respond(call);
	};
	const cfg = { token: "synthetic-token", database: "synthetic-db", collection: "docs", baseUrl: "https://offline.invalid", maxRetries: 0, ...config };
	const sdk = new HydraDBClient({ token: cfg.token, baseUrl: cfg.baseUrl, fetch: fetchFn, maxRetries: 0, timeoutInSeconds: 1 });
	const hydra = new HydraDB(cfg, sdk);
	const server = createHydraDBServer(hydra);
	const client = new Client({ name: "offline-boundary-tests", version: "1" });
	const [ct, st] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(st), client.connect(ct)]);
	t.after(async () => { await client.close(); await server.close(); });
	return { client, hydra, calls };
}

const queryData = (collection = "docs") => ({
	chunks: [{ id: "shared-id", collection, chunk_uuid: "chunk-1", source_title: "📘 Example Architecture", chunk_content: "Canonical synthetic body", relevancy_score: 0.95, extra_context_ids: ["extra-1"] }],
	graph_context: { chunk_relations: [{ group_id: "group-1", relevancy_score: 0.95, source_chunk_ids: ["chunk-1"], combined_context: "Synthetic dependency relation" }], query_paths: [], chunk_id_to_group_ids: {} },
	additional_context: { "extra-1": { id: "appendix", source_title: "Appendix", chunk_content: "Synthetic extra context" } },
	app_search_fusion: { diagnostic: "synthetic-fusion" },
});

test("real SDK/MCP ordinary, titles and list→source queries retain content, graph, scope and ACL", async (t) => {
	const { client, calls, hydra } = await fixture(t, ({ url }) => {
		if (url.pathname === "/context/list") return json({ sources: [{ id: "shared-id" }], total: 1 });
		if (url.pathname === "/query") return new Response(JSON.stringify({ success: true, data: queryData(), meta: { request_id: "request-1" } }));
		throw new Error(`Unexpected route ${url.pathname}`);
	});
	const acl = ["reader@example.invalid", "group:synthetic:readers"];
	const listed = await client.callTool({ name: "hydradb_list", arguments: { kind: "knowledge", external_id: "123456", provider: "confluence", acl } });
	assert.equal(listed.isError, undefined);
	const id = output<ListOutput>(listed).items[0]!.id;
	for (const selectors of [{}, { titles: ["📘 Example Architecture"] }, { source_ids: [id] }, { source_ids: [id], titles: ["📘 Example Architecture"] }]) {
		const result = await client.callTool({ name: "hydradb_query", arguments: { query: "build", detail: "full", structured: true, kind: "knowledge", acl, ...selectors } });
		assert.equal(result.isError, undefined, text(result));
		for (const expected of ["Canonical synthetic body", "📘 Example Architecture", "95%", "Synthetic dependency relation", "Synthetic extra context", "request-1", 'collection "docs"']) assert.ok(text(result).includes(expected), expected);
		const structured = output<QueryOutput>(result);
		assert.deepEqual(structured.resolved_scope, { database: "synthetic-db", collection: "docs" });
		assert.deepEqual(structured.sources[0].inspect_args, { id, database: "synthetic-db", collection: "docs", acl });
		assert.deepEqual(structured.sources[0].list_args, { ids: [id], kind: "knowledge", database: "synthetic-db", collection: "docs", acl });
		assert.equal(structured.request_id, "request-1");
	}
	for (const call of calls) {
		assert.deepEqual(call.body.acl, acl);
		assert.equal(call.headers.get("authorization"), "Bearer synthetic-token");
	}
	assert.deepEqual(calls[0]!.body.filters?.source_fields, { app_external_id: "123456", app_provider: "confluence" });
	const normalized = await hydra.context.query({ query: "build", titles: ["📘 Example Architecture"] });
	assert.deepEqual((normalized as unknown as Record<string, unknown>).app_search_fusion, { diagnostic: "synthetic-fusion" });
});

test("malformed HTTP-200 query replies are errors, not empty results or fallback searches", async (t) => {
	let body: unknown;
	const { client, calls } = await fixture(t, ({ url }) => {
		if (url.pathname === "/databases/collections") return json({ collections: ["docs", "other-docs"] });
		if (url.pathname === "/query") return new Response(typeof body === "string" ? body : JSON.stringify(body));
		throw new Error(`Unexpected route ${url.pathname}`);
	}, { collection: undefined });
	for (body of ["<html>Sign in</html>", null, [], {}, { success: true, data: {} }, { success: false, data: { chunks: [] } }, { success: true, data: { chunks: null } }, { success: true, data: { chunks: [{}] } }, { success: true, data: { chunks: [{ id: " " }] } }, { success: true, data: { chunks: [] }, error: { message: "failed" } }]) {
		for (const selectors of [{}, { titles: ["Example"] }]) {
			const before = calls.filter((c) => c.url.pathname === "/query").length;
			const result = await client.callTool({ name: "hydradb_query", arguments: { query: "build", ...selectors } });
			assert.equal(result.isError, true, JSON.stringify(body));
			assert.doesNotMatch(text(result), /No relevant/);
			assert.equal(calls.filter((c) => c.url.pathname === "/query").length, before + 1, "invalid success must not trigger a second scope");
		}
	}
	body = { success: true, data: { chunks: [] } };
	for (const selectors of [{}, { titles: ["Example"] }]) {
		const result = await client.callTool({ name: "hydradb_query", arguments: { query: "build", ...selectors } });
		assert.equal(result.isError, undefined);
		assert.match(text(result), /No relevant/);
	}
});

test("real SDK query HTTP errors and caller cancellation survive both query paths", async (t) => {
	let aborting = false;
	let capturedSignal: AbortSignal | null | undefined;
	const { client, hydra } = await fixture(t, ({ signal }) => {
		if (!aborting) return new Response(JSON.stringify({ error: { message: "permission denied" } }), { status: 403 });
		capturedSignal = signal;
		return new Promise<Response>((_, reject) => {
			if (signal?.aborted) reject(new Error("caller aborted"));
			else signal?.addEventListener("abort", () => reject(new Error("caller aborted")), { once: true });
		});
	});
	for (const titles of [undefined, ["Example"]]) {
		const result = await client.callTool({ name: "hydradb_query", arguments: { query: "build", titles } });
		assert.equal(result.isError, true);
		assert.match(text(result), /403/);
	}
	aborting = true;
	for (const titles of [undefined, ["Example"]]) {
		const controller = new AbortController();
		const pending = hydra.context.query({ query: "build", titles }, { signal: controller.signal });
		await new Promise<void>((resolve) => setImmediate(resolve));
		controller.abort();
		await assert.rejects(pending);
		assert.equal(capturedSignal?.aborted, true);
	}
});

test("overlapping source IDs in concurrent collection queries keep independent follow-up scope and ACL", async (t) => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const { client, calls } = await fixture(t, async ({ url, body }) => {
		if (url.pathname === "/query") {
			if (body.collection === "a") await gate; else release();
			return json(queryData(body.collection));
		}
		if (url.pathname === "/context/inspect") return json({ success: true, content: `body-${url.searchParams.get("collection")}` });
		if (url.pathname === "/context/list") return json({ sources: [{ id: "shared-id", title: body.collection }], total: 1 });
		throw new Error(`Unexpected route ${url.pathname}`);
	}, { collection: undefined });
	const results = await Promise.all(["a", "b"].map((collection) => client.callTool({ name: "hydradb_query", arguments: { query: "build", structured: true, kind: "knowledge", database: `db-${collection}`, collection, acl: [`${collection}@example.invalid`] } })));
	for (const [i, collection] of ["a", "b"].entries()) {
		const result = results[i]!;
		assert.equal(result.isError, undefined);
		const source = output<QueryOutput>(result).sources[0]!;
		assert.equal(source.inspect_args.collection, collection);
		assert.equal(source.inspect_args.database, `db-${collection}`);
		assert.deepEqual(source.inspect_args.acl, [`${collection}@example.invalid`]);
		const inspected = await client.callTool({ name: "hydradb_inspect", arguments: source.inspect_args });
		assert.equal(output<InspectOutput>(inspected).content, `body-${collection}`);
		const listed = await client.callTool({ name: "hydradb_list", arguments: source.list_args });
		assert.equal(output<ListOutput>(listed).items[0]!.title, collection);
	}
	assert.equal(calls.some((c) => c.url.pathname === "/databases/collections"), false, "explicit calls must not discover or widen");
	for (const call of calls.filter((c) => c.url.pathname === "/context/inspect")) {
		assert.ok(call.url.searchParams.get("acl")?.includes(`${call.url.searchParams.get("collection")}@example.invalid`));
	}
});

test("implicit single-collection query reports copyable scope; multi-collection IDs stay distinct", async (t) => {
	const { client } = await fixture(t, ({ url, body }) => {
		if (url.pathname === "/databases/collections") return json({ collections: ["docs"] });
		if (url.pathname === "/query") return json(body.collections ? { chunks: [...queryData("a").chunks, ...queryData("b").chunks, { id: "unknown", chunk_content: "Unattributed" }] } : { chunks: [{ id: "shared-id", chunk_content: "Body" }] });
		if (url.pathname === "/context/list") return json({ sources: body.collection === "docs" ? [{ id: "shared-id" }] : [], total: body.collection === "docs" ? 1 : 0 });
		throw new Error(`Unexpected route ${url.pathname}`);
	}, { collection: undefined });
	const single = await client.callTool({ name: "hydradb_query", arguments: { query: "build", structured: true, kind: "knowledge" } });
	assert.deepEqual(output<QueryOutput>(single).resolved_scope, { database: "synthetic-db", collection: "docs" });
	const list = await client.callTool({ name: "hydradb_list", arguments: output<QueryOutput>(single).sources[0]!.list_args });
	assert.equal(output<ListOutput>(list).items.length, 1);
	const unscopedList = await client.callTool({ name: "hydradb_list", arguments: { kind: "knowledge", external_id: "123456" } });
	assert.equal(output<ListOutput>(unscopedList).items.length, 0, "an earlier query must not mutate a later call's scope");
	const multi = await client.callTool({ name: "hydradb_query", arguments: { query: "build", detail: "full", structured: true, collections: ["a", "b"] } });
	const sources = output<QueryOutput>(multi).sources;
	assert.deepEqual(sources.slice(0, 2).map((s) => [s.id, s.inspect_args.collection]), [["shared-id", "a"], ["shared-id", "b"]]);
	assert.equal([...text(multi).matchAll(/Canonical synthetic body/g)].length, 2, "same source ID in another collection is not the same source for body deduplication");
	assert.equal(sources[2].scope_unresolved, true);
	assert.equal(sources[2].inspect_args, undefined);
});

test("real SDK/MCP inspect pagination reconstructs >125K content with stable scope and ACL", async (t) => {
	let body = "abcdefghij📘".repeat(11000); // 132K UTF-16 code units.
	const { client, calls } = await fixture(t, ({ url }) => {
		assert.equal(url.pathname, "/context/inspect");
		return json({ success: true, content: body });
	});
	let args: ToolArgs = { id: "shared-id", database: "synthetic-db", collection: "docs", acl: ["reader@example.invalid"] };
	const slices: string[] = [];
	const hashes = new Set<string>();
	for (let i = 0; i < 10; i++) {
		const result = await client.callTool({ name: "hydradb_inspect", arguments: args });
		assert.equal(result.isError, undefined);
		const data = output<InspectOutput>(result);
		assert.ok(data.content.length <= 20000);
		assert.ok(text(result).includes(data.content));
		assert.equal(data.offset, slices.join("").length);
		assert.equal(data.total_characters, body.length);
		assert.equal(data.complete, false);
		hashes.add(data.content_sha256);
		slices.push(data.content);
		if (!data.has_more) break;
		args = data.next_args;
		assert.deepEqual(args.acl, ["reader@example.invalid"]);
		assert.equal(args.collection, "docs");
	}
	assert.equal(slices.length, 7);
	assert.equal(slices.join(""), body);
	assert.equal(hashes.size, 1);
	for (const call of calls) {
		assert.equal(call.url.searchParams.get("collection"), "docs");
		assert.equal(call.url.searchParams.has("offset"), false, "pagination is local, not a backend snapshot");
		assert.ok(call.url.searchParams.get("acl")?.includes("reader@example.invalid"));
	}
	body = "changed";
	const changed = await client.callTool({ name: "hydradb_inspect", arguments: { ...args, offset: 0 } });
	assert.equal(output<InspectOutput>(changed).complete, true);
	assert.equal(hashes.has(output<InspectOutput>(changed).content_sha256), false);
	const pastEnd = await client.callTool({ name: "hydradb_inspect", arguments: { ...args, offset: 99 } });
	assert.equal(pastEnd.isError, true);
	const oversized = await client.callTool({ name: "hydradb_inspect", arguments: { ...args, limit: 50000 } });
	assert.equal(oversized.isError, true);
});

test("indexed child listing requires provider and connector, preserves filters/ACL, and paginates identities", async (t) => {
	const { client, calls } = await fixture(t, ({ url, body }) => {
		assert.equal(url.pathname, "/context/list");
		const page = body.page ?? 1;
		return json({ sources: [{ id: `child-${page}`, app_external_id: `external-${page}`, app_provider: "confluence", app_parent_id: "123456", additional_metadata: { connector_id: "synthetic-connector", private_field: "do-not-emit" } }], total: 2, pagination: { page, page_size: 1, has_next: page === 1 } });
	});
	const schema = (await client.listTools()).tools.find((tool) => tool.name === "hydradb_list")!.inputSchema;
	assert.ok(schema.properties?.parent_external_id);
	assert.ok(schema.properties?.connector_id);
	for (const args of [{ kind: "knowledge", parent_external_id: "123456" }, { kind: "knowledge", parent_external_id: "123456", provider: "confluence" }, { kind: "memory", parent_external_id: "123456", provider: "confluence", connector_id: "synthetic-connector" }, { kind: "memory", connector_id: "synthetic-connector" }, { kind: "knowledge", parent_external_id: " ", provider: "confluence" }]) {
		const result = await client.callTool({ name: "hydradb_list", arguments: args });
		assert.equal(result.isError, true);
	}
	assert.equal(calls.length, 0);
	const args = { kind: "knowledge", parent_external_id: "123456", provider: "confluence", connector_id: "synthetic-connector", acl: ["reader@example.invalid"], page_size: 1 };
	const result = await client.callTool({ name: "hydradb_list", arguments: args });
	assert.equal(result.isError, undefined, text(result));
	const data = output<ListOutput>(result);
	assert.equal(data.items[0].external_id, "external-1");
	assert.equal(data.items[0].provider, "confluence");
	assert.equal(data.items[0].parent_external_id, "123456");
	assert.equal(data.items[0].connector_id, "synthetic-connector");
	assert.deepEqual(data.items[0].children_args, { kind: "knowledge", parent_external_id: "external-1", provider: "confluence", connector_id: "synthetic-connector", database: "synthetic-db", collection: "docs", acl: args.acl });
	assert.doesNotMatch(JSON.stringify(result), /do-not-emit|private_field/);
	assert.equal(data.has_more, true);
	assert.deepEqual(calls[0]!.body.filters?.source_fields, { app_parent_id: "123456", app_provider: "confluence" });
	assert.equal(calls[0]!.body.group_threads, false);
	assert.deepEqual(calls[0]!.body.filters?.additional_metadata, { connector_id: "synthetic-connector" });
	const next = await client.callTool({ name: "hydradb_list", arguments: data.next_args });
	assert.equal(output<ListOutput>(next).has_more, false);
	assert.equal(calls[1]!.body.page, 2);
	assert.deepEqual(calls[1]!.body.acl, args.acl);
	assert.deepEqual(calls[1]!.body.filters?.additional_metadata, { connector_id: "synthetic-connector" });
	assert.match(text(result), /indexed direct children, not proof/);
	await client.callTool({ name: "hydradb_list", arguments: { ...args, external_id: "external-1", url: "https://example.invalid/child" } });
	assert.deepEqual(calls[2]!.body.filters?.source_fields, { app_parent_id: "123456", app_external_id: "external-1", app_provider: "confluence", url: "https://example.invalid/child" });
});

test("failed collection discovery preserves legitimate default searches with an explicit coverage warning", async (t) => {
	let empty = false;
	const { client, calls } = await fixture(t, ({ url }) => {
		if (url.pathname === "/databases/collections") return new Response("unavailable", { status: 503 });
		if (url.pathname === "/query") return json({ chunks: empty ? [] : [{ id: "default-id", chunk_content: "Default content" }] });
		throw new Error(`Unexpected route ${url.pathname}`);
	}, { collection: undefined });
	for (empty of [false, true]) {
		const result = await client.callTool({ name: "hydradb_query", arguments: { query: "build", structured: true } });
		assert.equal(result.isError, undefined);
		assert.match(text(result), /Collection discovery failed; only the workspace default/);
		assert.match(output<QueryOutput>(result).scope_warning!, /Named collections may contain additional results/);
		assert.deepEqual(output<QueryOutput>(result).resolved_scope, { database: "synthetic-db", collection: null });
	}
	assert.ok(calls.filter((c) => c.url.pathname === "/query").every((c) => c.body.collection == null && c.body.collections == null));
});

test("parent lookup cannot bypass collection confinement and preserves HTTP errors", async (t) => {
	const { client, calls } = await fixture(t, () => new Response("permission denied", { status: 403 }), { allowedCollections: ["docs"] });
	const args = { kind: "knowledge", parent_external_id: "123456", provider: "confluence", connector_id: "synthetic-connector", acl: ["reader@example.invalid"] };
	const deniedScope = await client.callTool({ name: "hydradb_list", arguments: { ...args, collection: "outside" } });
	assert.equal(deniedScope.isError, true);
	assert.equal(calls.length, 0);
	const failed = await client.callTool({ name: "hydradb_list", arguments: args });
	assert.equal(failed.isError, true);
	assert.match(text(failed), /403/);
	assert.deepEqual(calls[0]!.body.acl, args.acl);
});

test("identity lookups preserve multiple candidates; connector filtering disambiguates same-provider IDs", async (t) => {
	const { client, calls } = await fixture(t, ({ body }) => {
		const connector = body.filters?.additional_metadata?.connector_id;
		const sources = ["connector-a", "connector-b"].filter((id) => connector == null || connector === id).map((id) => ({ id: `source-${id}`, app_external_id: "123456", app_provider: "confluence", additional_metadata: { connector_id: id } }));
		return json({ sources, total: sources.length });
	});
	const args = { kind: "knowledge", external_id: "123456", provider: "confluence" };
	const ambiguous = await client.callTool({ name: "hydradb_list", arguments: args });
	assert.equal(output<ListOutput>(ambiguous).items.length, 2, "never automatically select one connector's candidate");
	const scoped = await client.callTool({ name: "hydradb_list", arguments: { ...args, connector_id: "connector-b" } });
	assert.deepEqual(output<ListOutput>(scoped).items.map((item) => item.id), ["source-connector-b"]);
	assert.deepEqual(calls[1]!.body.filters?.source_fields, { app_external_id: "123456", app_provider: "confluence" });
	const connectorOnly = await client.callTool({ name: "hydradb_list", arguments: { kind: "knowledge", connector_id: "connector-a" } });
	assert.deepEqual(output<ListOutput>(connectorOnly).items.map((item) => item.id), ["source-connector-a"]);
	assert.equal(calls[2]!.body.filters?.source_fields, undefined);
	assert.deepEqual(calls[2]!.body.filters?.additional_metadata, { connector_id: "connector-a" });
});

// Text only by default, in either detail mode: the model reads the text, so
// everything a follow-up needs must be in it. `structured: true` opts in.
test("query returns text only unless structured: true, in either detail mode", async (t) => {
	const { client } = await fixture(t, ({ url }) => {
		if (url.pathname === "/query") return new Response(JSON.stringify({ success: true, data: queryData(), meta: { request_id: "request-1" } }));
		throw new Error(`Unexpected route ${url.pathname}`);
	});
	for (const detail of ["compact", "full"] as const) {
		const plain = await client.callTool({ name: "hydradb_query", arguments: { query: "build", kind: "knowledge", detail } });
		assert.equal(plain.isError, undefined);
		assert.equal(plain.structuredContent, undefined, `${detail}: no structuredContent by default`);
		const body = text(plain);
		assert.match(body, /\[id: shared-id\]/);
		assert.match(body, /Collection: "docs"/);
		assert.match(body, /database "synthetic-db"/);
		assert.match(body, /request_id: request-1/);
		assert.match(body, /Synthetic dependency relation/);

		const structured = await client.callTool({ name: "hydradb_query", arguments: { query: "build", kind: "knowledge", detail, structured: true } });
		assert.equal(text(structured), body, `${detail}: the text is the same either way`);
		assert.equal(output<QueryOutput>(structured).sources[0]!.id, "shared-id");
		assert.equal(output<QueryOutput>(structured).request_id, "request-1");
	}
});
