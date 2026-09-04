import assert from "node:assert/strict";
import { test } from "node:test";

import { type HydraDBClient, HydraDBError } from "@hydradb/sdk";

import {
	DEFAULT_MAX_RETRIES,
	DEFAULT_TIMEOUT_SECONDS,
	HydraDB,
	HydraWrapperError,
	translateError,
	unwrap,
} from "../src/hydra/index.js";

test("unwrap returns .data for an envelope and passes through bare payloads", () => {
	assert.deepEqual(unwrap({ data: { a: 1 }, success: true, meta: {} }), { a: 1 });
	// A bare payload that itself has `success` but no top-level `data`.
	assert.deepEqual(unwrap({ success: true, content: "x" }), {
		success: true,
		content: "x",
	});
	assert.equal(unwrap(null), null);
});

test("translateError reproduces the v1 error template for SDK errors", () => {
	const err = new HydraDBError({ statusCode: 404, body: { code: "NOT_FOUND" } });
	const translated = translateError("/query", err);
	assert.ok(translated instanceof HydraWrapperError);
	assert.equal(translated.message, `Hydra DB /query → 404: ${JSON.stringify({ code: "NOT_FOUND" })}`);
	assert.equal(translated.status, 404);
	assert.equal(translated.path, "/query");
});

test("translateError handles non-SDK failures without a status", () => {
	const translated = translateError("/context/ingest", new Error("socket hang up"));
	assert.equal(translated.message, "Hydra DB /context/ingest → ERR: socket hang up");
});

test("wrapper catches SDK errors and rethrows the byte-identical message", async () => {
	const failingSdk = {
		query() {
			return Promise.reject(
				new HydraDBError({ statusCode: 500, body: "boom" }),
			);
		},
	} as unknown as HydraDBClient;

	const hydra = new HydraDB(
		{ token: "t", database: "db_test", collection: "col_test" },
		failingSdk,
	);

	await assert.rejects(
		() => hydra.context.query({ query: "hi", kind: "memory" }),
		(e: unknown) => {
			assert.ok(e instanceof HydraWrapperError);
			assert.equal(e.message, "Hydra DB /query → 500: boom");
			return true;
		},
	);
});

test("wrapper unwraps the envelope and returns .data", async () => {
	const okSdk = {
		context: {
			list() {
				return Promise.resolve({
					data: { inner: { sources: [{ id: "s1" }], total: 1 } },
					success: true,
					meta: {},
				});
			},
		},
	} as unknown as HydraDBClient;

	const hydra = new HydraDB(
		{ token: "t", database: "db_test", collection: "col_test" },
		okSdk,
	);
	const data = await hydra.context.list({ kind: "knowledge" });
	assert.deepEqual(data, { inner: { sources: [{ id: "s1" }], total: 1 } });
});

// The knowledge branch builds a multipart document and can carry only the body
// and its filename. Every memory-item field it was handed used to be discarded
// in silence — a caller setting infer:true on a knowledge write was answered
// "success: 1, failed: 0" as though the instruction had been honoured.
function ingestSdk(): { sdk: HydraDBClient; calls: unknown[] } {
	const calls: unknown[] = [];
	const sdk = {
		context: {
			ingest(request: unknown) {
				calls.push(request);
				return Promise.resolve({ data: { success: true }, success: true });
			},
		},
	} as unknown as HydraDBClient;
	return { sdk, calls };
}

test("knowledge ingest rejects memory-only params instead of dropping them", async () => {
	for (const [name, extra] of [
		["pairs", { pairs: [{ user: "hi", assistant: "hello" }] }],
		["sourceId", { sourceId: "s1" }],
		["infer", { infer: true }],
		["isMarkdown", { isMarkdown: true }],
		["customInstructions", { customInstructions: "focus on X" }],
		["userName", { userName: "Ada" }],
	] as const) {
		const { sdk } = ingestSdk();
		const hydra = new HydraDB({ token: "t", database: "db_test" }, sdk);
		await assert.rejects(
			() => hydra.context.ingest({ kind: "knowledge", text: "body", ...extra }),
			(err: unknown) => {
				assert.ok(err instanceof Error);
				assert.match(err.message, new RegExp(name));
				assert.match(err.message, /memory ingestion only/);
				return true;
			},
			`knowledge ingest should reject ${name} rather than silently drop it`,
		);
	}
});

test("knowledge ingest still accepts the params it can carry", async () => {
	const { sdk, calls } = ingestSdk();
	const hydra = new HydraDB({ token: "t", database: "db_test" }, sdk);

	await hydra.context.ingest({
		kind: "knowledge",
		text: "quarterly report body",
		title: "Q3",
		filename: "q3.md",
	});

	assert.equal(calls.length, 1, "knowledge ingest should still reach the SDK");
});

test("memory ingest is unaffected by the knowledge guard", async () => {
	const { sdk, calls } = ingestSdk();
	const hydra = new HydraDB({ token: "t", database: "db_test" }, sdk);

	await hydra.context.ingest({
		kind: "memory",
		text: "a note",
		sourceId: "s1",
		infer: true,
		userName: "Ada",
		customInstructions: "focus on X",
	});

	assert.equal(calls.length, 1);
});

// The error body is model-visible by design and was stringified whole with no
// limit. HydraDB's own error path is clean, but this string also carries
// whatever a CDN, WAF or corporate proxy returns.
test("error bodies are capped so a gateway page cannot flood the context", () => {
	const html = `<html><head><title>502 Bad Gateway</title></head><body>${"padding ".repeat(5000)}</body></html>`;
	const translated = translateError("/query", new HydraDBError({ statusCode: 502, body: html }));

	assert.ok(
		translated.message.length < 700,
		`expected a bounded message, got ${translated.message.length} chars`,
	);
	assert.match(translated.message, /truncated, \d+ chars/);
	// Markup is stripped first so the budget is spent on readable text.
	assert.match(translated.message, /502 Bad Gateway/);
	assert.doesNotMatch(translated.message, /<html>/);
});

test("credential-shaped substrings are scrubbed from error bodies", () => {
	for (const [body, forbidden] of [
		["upstream rejected: Authorization: Bearer sk-live-abcdef1234567890", "sk-live"],
		['{"api_key":"hdb_abcdefghijklmnopqrstuvwx"}', "hdb_abcdefghijklmnopqrstuvwx"],
		['{"token":"eyJhbGciOiJIUzI1NiJ9"}', "eyJhbGciOiJIUzI1NiJ9"],
	] as const) {
		const translated = translateError(
			"/query",
			new HydraDBError({ statusCode: 500, body }),
		);
		assert.doesNotMatch(
			translated.message,
			new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
			`credential material must not survive: ${body}`,
		);
		assert.match(translated.message, /redacted/);
	}
});

// The common case: the v2 envelope. Rendering only code/message/request_id is
// both shorter and more useful than the stringified object it replaces — the
// request id is what a user needs to file a ticket, and it was buried before.
test("v2 envelope errors render code, message and request id", () => {
	const translated = translateError(
		"/context/ingest",
		new HydraDBError({
			statusCode: 400,
			body: {
				success: false,
				data: null,
				error: { code: "INVALID_ARGUMENT", message: "text must not be empty" },
				meta: { request_id: "req_abc123", api_version: "2", latency_ms: 12 },
			},
		}),
	);

	assert.equal(
		translated.message,
		"Hydra DB /context/ingest → 400: INVALID_ARGUMENT: text must not be empty (request_id: req_abc123)",
	);
	assert.doesNotMatch(translated.message, /latency_ms/, "envelope noise should be dropped");
});

test("non-envelope bodies still round-trip readably", () => {
	const translated = translateError(
		"/query",
		new HydraDBError({ statusCode: 404, body: { code: "NOT_FOUND" } }),
	);
	assert.equal(translated.message, `Hydra DB /query → 404: ${JSON.stringify({ code: "NOT_FOUND" })}`);
});

// The client was constructed with only token and baseUrl, inheriting the SDK's
// 60s timeout and 2 retries. Their product is ~3 minutes of silence on a
// persistently failing endpoint — far longer than any MCP host waits, so the
// host times out first and the caller gets a generic error with no HydraDB
// diagnostic while this process keeps retrying on its behalf.
test("the wrapper's timeout budget is tighter than the SDK's inherited default", () => {
	assert.ok(
		Number.isInteger(DEFAULT_TIMEOUT_SECONDS) && DEFAULT_TIMEOUT_SECONDS > 0,
		"a timeout must actually be set; undefined means no deadline at all",
	);
	assert.ok(
		DEFAULT_TIMEOUT_SECONDS < 60,
		"must be tighter than the SDK's 60s default, or setting it changes nothing",
	);
	// worst case = timeout x (1 + retries), and it has to stay inside a typical
	// MCP host's tool timeout or the host reports a generic failure first.
	assert.ok(
		DEFAULT_TIMEOUT_SECONDS * (1 + DEFAULT_MAX_RETRIES) <= 120,
		"the worst-case call must stay under two minutes",
	);
});

// A cancelled tool call must cancel the HTTP request. Without this the caller
// has given up and the process keeps working — and keeps retrying — for it.
test("an abort signal reaches the SDK as abortSignal", async () => {
	const seen: unknown[] = [];
	const sdk = {
		query(_request: unknown, requestOptions: unknown) {
			seen.push(requestOptions);
			return Promise.resolve({ data: { chunks: [] }, success: true });
		},
		context: {
			delete(_request: unknown, requestOptions: unknown) {
				seen.push(requestOptions);
				return Promise.resolve({ data: { success: true }, success: true });
			},
		},
	} as unknown as HydraDBClient;

	const hydra = new HydraDB({ token: "t", database: "db_test" }, sdk);
	const controller = new AbortController();

	await hydra.context.query({ query: "hi" }, { signal: controller.signal });
	await hydra.context.delete({ ids: ["s1"], kind: "memory" }, { signal: controller.signal });

	assert.equal(seen.length, 2);
	for (const opts of seen) {
		assert.equal(
			(opts as { abortSignal?: AbortSignal }).abortSignal,
			controller.signal,
		);
	}
});

test("no request options are sent when there is no signal", async () => {
	const seen: unknown[] = [];
	const sdk = {
		query(_request: unknown, requestOptions: unknown) {
			seen.push(requestOptions);
			return Promise.resolve({ data: { chunks: [] }, success: true });
		},
	} as unknown as HydraDBClient;

	const hydra = new HydraDB({ token: "t", database: "db_test" }, sdk);
	await hydra.context.query({ query: "hi" });

	assert.equal(seen[0], undefined, "an empty options object would be noise on the wire");
});

// `operator` is keyword syntax and the API takes it only alongside
// `query_by=text`. The wrapper forwarded the operator and never the retrieval
// method, so every call that set it came back
//   Hydra DB /query → 400: INVALID_INPUT: operator is only valid with query_by=text
function querySdk(): { sdk: HydraDBClient; calls: Record<string, unknown>[] } {
	const calls: Record<string, unknown>[] = [];
	const sdk = {
		query(request: Record<string, unknown>) {
			calls.push(request);
			return Promise.resolve({ data: { chunks: [] }, success: true });
		},
	} as unknown as HydraDBClient;
	return { sdk, calls };
}

test("an operator carries the text retrieval method the API requires", async () => {
	for (const operator of ["or", "and", "phrase"] as const) {
		const { sdk, calls } = querySdk();
		const hydra = new HydraDB({ token: "t", database: "db_test" }, sdk);

		await hydra.context.query({ query: "invoice OR receipt", operator });

		assert.equal(calls[0]?.operator, operator);
		assert.equal(calls[0]?.queryBy, "text", `operator ${operator} needs query_by=text`);
	}
});

test("a query without an operator leaves the retrieval method to the API", async () => {
	const { sdk, calls } = querySdk();
	const hydra = new HydraDB({ token: "t", database: "db_test" }, sdk);

	await hydra.context.query({ query: "how does auth work" });

	assert.equal(
		calls[0]?.queryBy,
		undefined,
		"hybrid is the API's default; stating it would claim a default this wrapper never chose",
	);
});

test("an explicit queryBy is forwarded and never overridden", async () => {
	const { sdk, calls } = querySdk();
	const hydra = new HydraDB({ token: "t", database: "db_test" }, sdk);

	await hydra.context.query({ query: "ECONNRESET", queryBy: "text", operator: "phrase" });
	await hydra.context.query({ query: "how does auth work", queryBy: "hybrid" });

	assert.equal(calls[0]?.queryBy, "text");
	assert.equal(calls[0]?.operator, "phrase");
	assert.equal(calls[1]?.queryBy, "hybrid");
	assert.equal(calls[1]?.operator, undefined);
});

test("operator with an explicit hybrid retrieval is rejected, not sent", async () => {
	const { sdk, calls } = querySdk();
	const hydra = new HydraDB({ token: "t", database: "db_test" }, sdk);

	await assert.rejects(
		() => hydra.context.query({ query: "invoice", operator: "and", queryBy: "hybrid" }),
		(err: unknown) => {
			assert.ok(err instanceof Error);
			assert.match(err.message, /operator "and"/);
			assert.match(err.message, /queryBy "text"/);
			return true;
		},
	);
	assert.equal(calls.length, 0, "a request that cannot succeed must not reach the wire");
});

// --- Database confinement ---

import { assertDatabaseAllowed, ScopeNotAllowedError } from "../src/hydra/index.js";

test("assertDatabaseAllowed: undefined allows anything, a list allows only its members", () => {
	assert.doesNotThrow(() => assertDatabaseAllowed("anything", undefined));
	assert.doesNotThrow(() => assertDatabaseAllowed("a", ["a", "b"]));
	assert.throws(() => assertDatabaseAllowed("c", ["a", "b"]), ScopeNotAllowedError);
});

test("a confined client refuses a per-call override and never reaches the SDK", async () => {
	const calls: string[] = [];
	const sdk = {
		query(args: Record<string, unknown>) {
			calls.push(`query:${args.database}`);
			return Promise.resolve({ data: { chunks: [] }, success: true });
		},
	} as unknown as HydraDBClient;
	const hydra = new HydraDB(
		{ token: "t", database: "personal", allowedDatabases: ["personal"] },
		sdk,
	);
	// The default is always fine, with or without naming it.
	await hydra.context.query({ query: "hi" });
	await hydra.context.query({ query: "hi", database: "personal" });
	// Anything else is refused before the call is built.
	await assert.rejects(
		() => hydra.context.query({ query: "hi", database: "work" }),
		(e: unknown) => {
			assert.ok(e instanceof ScopeNotAllowedError);
			assert.equal(e.requested, "work");
			assert.deepEqual(e.allowed, ["personal"]);
			return true;
		},
	);
	assert.deepEqual(calls, ["query:personal", "query:personal"]);
});

test("an unconfined client passes any per-call database through", async () => {
	const calls: string[] = [];
	const sdk = {
		query(args: Record<string, unknown>) {
			calls.push(`query:${args.database}`);
			return Promise.resolve({ data: { chunks: [] }, success: true });
		},
	} as unknown as HydraDBClient;
	const hydra = new HydraDB({ token: "t", database: "personal" }, sdk);
	await hydra.context.query({ query: "hi", database: "work" });
	assert.deepEqual(calls, ["query:work"]);
});

test("collections and collection cannot be sent together", async () => {
	const calls: string[] = [];
	const sdk = {
		query(args: Record<string, unknown>) {
			calls.push(`query:${JSON.stringify(args.collections ?? args.collection)}`);
			return Promise.resolve({ data: { chunks: [] }, success: true });
		},
	} as unknown as HydraDBClient;
	const hydra = new HydraDB({ token: "t", database: "db" }, sdk);

	// Hydra DB refuses a request carrying both selectors, so this must fail here
	// rather than travel to the wire to fail there.
	await assert.rejects(
		() =>
			hydra.context.query({
				query: "hi",
				collection: "a",
				collections: ["b", "c"],
			}),
		/not\s+both/,
	);
	await assert.rejects(
		() => hydra.context.query({ query: "hi", collections: [] }),
		/at least one collection/,
	);
	assert.deepEqual(calls, [], "neither call should reach the SDK");
});

test("a confined client enforces confinement on every named collection", async () => {
	const calls: string[] = [];
	const sdk = {
		query(args: Record<string, unknown>) {
			calls.push(`query:${JSON.stringify(args.collections)}`);
			return Promise.resolve({ data: { chunks: [] }, success: true });
		},
	} as unknown as HydraDBClient;
	const hydra = new HydraDB(
		{
			token: "t",
			database: "db",
			collection: "allowed_a",
			allowedCollections: ["allowed_a", "allowed_b"],
		},
		sdk,
	);

	await hydra.context.query({ query: "hi", collections: ["allowed_a", "allowed_b"] });

	// A multi-scope selector must not be a way around the confinement that the
	// singular selector enforces.
	await assert.rejects(
		() => hydra.context.query({ query: "hi", collections: ["allowed_a", "secret"] }),
		(e: unknown) => {
			assert.ok(e instanceof ScopeNotAllowedError);
			assert.equal(e.requested, "secret");
			return true;
		},
	);
	assert.deepEqual(calls, ['query:["allowed_a","allowed_b"]']);
});

test("a weighted collections object is scoped and forwarded as given", async () => {
	const calls: unknown[] = [];
	const sdk = {
		query(args: Record<string, unknown>) {
			calls.push(args.collections);
			return Promise.resolve({ data: { chunks: [] }, success: true });
		},
	} as unknown as HydraDBClient;
	const hydra = new HydraDB(
		{ token: "t", database: "db", allowedCollections: ["a", "b"] },
		sdk,
	);

	await hydra.context.query({ query: "hi", collections: { a: 2, b: 1 } });
	assert.deepEqual(calls, [{ a: 2, b: 1 }]);

	// The weights are keyed by collection name, so confinement reads the keys.
	await assert.rejects(
		() => hydra.context.query({ query: "hi", collections: { a: 2, secret: 1 } }),
		ScopeNotAllowedError,
	);
});

// ── context.subgraph (PRO-1848): the raw path, behind the same surface ─────

function fakeRawFetch(
	handler: (url: string, init?: RequestInit) => { status: number; body: unknown },
) {
	const calls: { url: string; init?: RequestInit }[] = [];
	const fetchFn = (async (url: string | URL, init?: RequestInit) => {
		calls.push({ url: String(url), init });
		const { status, body } = handler(String(url), init);
		return new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});
	}) as unknown as typeof fetch;
	return { fetchFn, calls };
}

test("context.subgraph hits GET /context/{id}/subgraph with the scope and API-Version", async () => {
	const { fetchFn, calls } = fakeRawFetch(() => ({
		status: 200,
		body: {
			data: { seed_source_id: "s 1", sources: [{ source_id: "s 1", depth: 0 }], relations: [], auxiliary_relations: [], is_truncated: false, auxiliary_truncated: false, max_depth_reached: 0, success: true, message: "ok" },
			success: true,
			meta: {},
		},
	}));
	const hydra = new HydraDB(
		{ token: "tok", database: "db_test", collection: "col_test", baseUrl: "https://h.test/", fetchFn },
		{} as unknown as HydraDBClient,
	);

	const res = await hydra.context.subgraph({ id: "s 1", depth: 2, maxSources: 50, kind: "memory" });

	assert.equal(res.seed_source_id, "s 1", "envelope unwrapped to .data");
	assert.equal(calls.length, 1);
	const url = new URL(calls[0]!.url);
	// The id is a path segment, so it is escaped; a trailing slash on the base
	// must not produce "//context".
	assert.equal(url.pathname, "/context/s%201/subgraph");
	assert.equal(url.searchParams.get("database"), "db_test");
	assert.equal(url.searchParams.get("collection"), "col_test");
	assert.equal(url.searchParams.get("type"), "memory");
	assert.equal(url.searchParams.get("depth"), "2");
	assert.equal(url.searchParams.get("max_sources"), "50");
	const headers = calls[0]!.init?.headers as Record<string, string>;
	assert.equal(headers["API-Version"], "2", "CONTRACT §2 rule 6");
	assert.equal(headers.Authorization, "Bearer tok");
	assert.equal(calls[0]!.init?.method, "GET");
});

test("context.subgraph translates a failure into the wrapper's own error", async () => {
	const { fetchFn } = fakeRawFetch(() => ({
		status: 400,
		body: { success: false, error: { code: "INVALID_INPUT", message: "depth must be a positive integer" } },
	}));
	const hydra = new HydraDB(
		{ token: "tok", database: "db_test", baseUrl: "https://h.test", fetchFn },
		{} as unknown as HydraDBClient,
	);
	await assert.rejects(
		() => hydra.context.subgraph({ id: "x", depth: 99 }),
		(e: unknown) => {
			assert.ok(e instanceof HydraWrapperError, "same error type as an SDK failure");
			assert.equal(e.status, 400);
			assert.match(e.message, /depth must be a positive integer/);
			return true;
		},
	);
});

// The server treats an item id as opaque: ingest stores a caller's source_id
// verbatim, so " s1" and "s1" are two different items and a wrapper that
// trimmed would quietly ask about the other one.
test("context.subgraph sends the id verbatim, and rejects only a blank one", async () => {
	const { fetchFn, calls } = fakeRawFetch(() => ({
		status: 200,
		body: { data: { seed_source_id: " s1 ", sources: [], relations: [], auxiliary_relations: [], is_truncated: false, auxiliary_truncated: false, max_depth_reached: 0, success: true, message: "ok" }, success: true },
	}));
	const hydra = new HydraDB(
		{ token: "tok", database: "db_test", baseUrl: "https://h.test", fetchFn },
		{} as unknown as HydraDBClient,
	);

	await hydra.context.subgraph({ id: " s1 " });
	assert.equal(new URL(calls[0]!.url).pathname, "/context/%20s1%20/subgraph");

	// Blank is the one id rejected locally: it would build "/context//subgraph"
	// and come back as an opaque routing failure.
	await assert.rejects(
		() => hydra.context.subgraph({ id: "   " }),
		(e: unknown) => {
			assert.ok(e instanceof HydraWrapperError);
			assert.match(e.message, /id must not be empty/);
			return true;
		},
	);
	assert.equal(calls.length, 1, "the blank id never reached the network");
});

test("context.subgraph refuses a database the connection is confined away from", async () => {
	const { fetchFn, calls } = fakeRawFetch(() => ({ status: 200, body: { data: {}, success: true } }));
	const hydra = new HydraDB(
		{ token: "tok", database: "db_test", allowedDatabases: ["db_test"], baseUrl: "https://h.test", fetchFn },
		{} as unknown as HydraDBClient,
	);
	await assert.rejects(() => hydra.context.subgraph({ id: "x", database: "other" }));
	assert.equal(calls.length, 0, "a refused scope never reaches the network");
});

// PRO-1684: the subgraph read is ACL-scoped server-side, so the wrapper must
// carry the principals to the wire as repeated acl params. An omitted acl
// sends nothing.
test("context.subgraph carries acl principals to the wire", async () => {
	const { fetchFn, calls } = fakeRawFetch(() => ({
		status: 200,
		body: { data: { seed_source_id: "s1", sources: [], relations: [], auxiliary_relations: [], is_truncated: false, auxiliary_truncated: false, max_depth_reached: 0, success: true, message: "ok" }, success: true },
	}));
	const hydra = new HydraDB(
		{ token: "tok", database: "db_test", baseUrl: "https://h.test", fetchFn },
		{} as unknown as HydraDBClient,
	);

	await hydra.context.subgraph({ id: "s1", acl: ["alice@corp.com", "group:google:eng@corp.com"] });
	const url = new URL(calls[0]!.url);
	assert.deepEqual(url.searchParams.getAll("acl"), ["alice@corp.com", "group:google:eng@corp.com"]);

	await hydra.context.subgraph({ id: "s1" });
	assert.equal(new URL(calls[1]!.url).searchParams.has("acl"), false, "omitted acl sends no acl field");
});

// ── PRO-1684: permission-aware search ────────────────────────────────────────
// The caller declares the principals to answer as, and the wrapper must carry
// them to the wire on every read the API scopes by ACL.

function captureSdk(seen: Record<string, unknown>) {
	const grab = (key: string) => (req: unknown) => {
		seen[key] = req;
		return Promise.resolve({});
	};
	return {
		query: grab("query"),
		context: {
			list: grab("list"),
			inspect: grab("inspect"),
			relations: grab("relations"),
		},
	} as unknown as HydraDBClient;
}

function wrapperFor(seen: Record<string, unknown>) {
	return new HydraDB(
		{ token: "t", database: "db_test", collection: "col_test" },
		captureSdk(seen),
	);
}

test("query carries acl principals to the SDK", async () => {
	const seen: Record<string, { acl?: string[] }> = {};
	await wrapperFor(seen).context.query({
		query: "roadmap",
		acl: ["alice@corp.com", "group:google:eng@corp.com"],
	});
	assert.deepEqual(seen.query.acl, ["alice@corp.com", "group:google:eng@corp.com"]);
});

test("list, inspect and relations each carry acl principals", async () => {
	const seen: Record<string, { acl?: string[] }> = {};
	const hydra = wrapperFor(seen);
	await hydra.context.list({ acl: ["bob@corp.com"] });
	await hydra.context.inspect({ id: "s1", acl: ["carol@corp.com"] });
	await hydra.context.relations({ id: "s1", acl: ["dan@corp.com"] });
	assert.deepEqual(seen.list.acl, ["bob@corp.com"]);
	assert.deepEqual(seen.inspect.acl, ["carol@corp.com"]);
	assert.deepEqual(seen.relations.acl, ["dan@corp.com"]);
});

test("an omitted acl stays undefined rather than becoming an empty list", async () => {
	// The API treats `acl: []` the same as an absent acl, so [] is not a way to
	// ask for "nobody". Sending nothing keeps the request faithful to what the
	// caller actually said rather than relying on that equivalence.
	const seen: Record<string, { acl?: string[] }> = {};
	const hydra = wrapperFor(seen);
	await hydra.context.query({ query: "roadmap" });
	await hydra.context.list({});
	assert.equal(seen.query.acl, undefined);
	assert.equal(seen.list.acl, undefined);
});


// PRO-1618: a database created with `type: "unified"` has one corpus. The
// pinned SDK cannot send `items`, `type` on create, or read `details[]`, so
// those three go over a hand-rolled v2 transport; these pin the wire shape.
function fetchStub(body: unknown, status = 200): { fetch: typeof fetch; calls: { url: string; init: RequestInit }[] } {
	const calls: { url: string; init: RequestInit }[] = [];
	const impl = ((url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), init: init ?? {} });
		return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
	}) as typeof fetch;
	return { fetch: impl, calls };
}

test("unified ingest posts items[] as a JSON body, not the multipart memories field", async () => {
	const { fetch, calls } = fetchStub({ success: true, data: { success: true, success_count: 1, failed_count: 0 } });
	const sdk = { context: { ingest() { throw new Error("SDK path must not be used for unified"); } } } as unknown as HydraDBClient;
	const hydra = new HydraDB({ token: "t", database: "db_u", collection: "c1", baseUrl: "https://api.test", fetchFn: fetch }, sdk);

	await hydra.context.ingest({
		kind: "unified",
		pairs: [{ user: "I prefer dark mode", assistant: "Noted" }],
		sourceId: "chat-1",
		userName: "Ada",
		infer: true,
		customInstructions: "focus",
		metadata: { topic: "ui" },
		observationDate: "2026-09-01",
		upsert: true,
	});

	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.url, "https://api.test/context/ingest");
	assert.equal(calls[0]!.init.method, "POST");
	assert.equal((calls[0]!.init.headers as Record<string, string>)["API-Version"], "2");
	const body = JSON.parse(String(calls[0]!.init.body));
	assert.deepEqual(body, {
		database: "db_u",
		collection: "c1",
		upsert: true,
		items: [
			{
				conversation: [
					{ role: "user", content: "I prefer dark mode", name: "Ada" },
					{ role: "assistant", content: "Noted" },
				],
				context_id: "chat-1",
				enrich: true,
				custom_instructions: "focus",
				attributes: { topic: "ui" },
				happened_at: "2026-09-01",
			},
		],
	});
});

test("database create with a layout posts type, plain create keeps the SDK path", async () => {
	const { fetch, calls } = fetchStub({ success: true, data: { success: true } });
	let sdkCreates = 0;
	const sdk = {
		databases: {
			create() {
				sdkCreates += 1;
				return Promise.resolve({ success: true, data: { success: true } });
			},
		},
	} as unknown as HydraDBClient;
	const hydra = new HydraDB({ token: "t", database: "db", baseUrl: "https://api.test", fetchFn: fetch }, sdk);

	await hydra.databases.create({ database: "new-db", type: "unified" });
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.url, "https://api.test/databases");
	assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { database: "new-db", type: "unified" });

	await hydra.databases.create({ database: "old-db" });
	assert.equal(sdkCreates, 1, "a create without a layout must stay on the SDK");
	assert.equal(calls.length, 1);
});

test("layout() reads GET /databases details once and falls back to split", async () => {
	const { fetch, calls } = fetchStub({
		success: true,
		data: { databases: ["a", "b"], details: [{ database: "a", type: "unified" }, { database: "b", type: "split" }] },
	});
	const hydra = new HydraDB({ token: "t", database: "a", baseUrl: "https://api.test", fetchFn: fetch }, {} as HydraDBClient);

	assert.equal(await hydra.databases.layout("a"), "unified");
	assert.equal(await hydra.databases.layout("b"), "split");
	assert.equal(await hydra.databases.layout("never-listed"), "split");
	assert.equal(calls.length, 1, "the probe is memoised for the process");
	assert.equal(calls[0]!.init.method, "GET");

	const failing = fetchStub({ success: false, error: { message: "nope" } }, 500);
	const broken = new HydraDB({ token: "t", database: "a", baseUrl: "https://api.test", fetchFn: failing.fetch }, {} as HydraDBClient);
	assert.equal(await broken.databases.layout("a"), "split");
});

// The pinned SDK's REQUEST serializers reject `type: "unified"` before anything
// is sent, so every read and delete that names that kind is built by hand and
// its result is parsed with the SDK's own response serializer: callers get the
// same camelCase object either way.
test("unified query, list and delete bypass the SDK request serializers and return SDK-shaped results", async () => {
	const answers: Record<string, unknown> = {
		"/query": { chunks: [{ chunk_uuid: "c1", id: "s1", chunk_content: "body", relevancy_score: 0.9 }], sources: [] },
		"/context/list": { sources: [{ id: "s1", title: "T" }], total: 1 },
		"/context": { success: true, deleted_count: 2, user_memory_deleted: 2, results: [] },
	};
	const calls: { url: string; init: RequestInit }[] = [];
	const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
		const path = new URL(String(url)).pathname;
		calls.push({ url: String(url), init: init ?? {} });
		return Promise.resolve(
			new Response(JSON.stringify({ success: true, data: answers[path] }), { status: 200, headers: { "content-type": "application/json" } }),
		);
	}) as typeof fetch;
	const sdk = {
		query() { throw new Error("SDK query must not be used for unified"); },
		context: {
			list() { throw new Error("SDK list must not be used for unified"); },
			delete() { throw new Error("SDK delete must not be used for unified"); },
		},
	} as unknown as HydraDBClient;
	const hydra = new HydraDB({ token: "t", database: "db_u", collection: "c1", baseUrl: "https://api.test", fetchFn: fetchImpl }, sdk);

	const q = await hydra.context.query({ query: "acme", kind: "unified", maxResults: 5, operator: "and" });
	assert.equal(q.chunks?.[0]?.chunkContent, "body", "query result is parsed to the SDK's camelCase");
	assert.equal(q.chunks?.[0]?.relevancyScore, 0.9);
	assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
		database: "db_u", collection: "c1", query: "acme", type: "unified", operator: "and", query_by: "text", max_results: 5,
	});

	const l = await hydra.context.list({ kind: "unified", page: 2, pageSize: 10 });
	assert.equal((l as unknown as { sources: { id: string }[] }).sources[0]?.id, "s1");
	assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), { database: "db_u", collection: "c1", type: "unified", page: 2, page_size: 10 });

	const d = await hydra.context.delete({ ids: ["a", "b"], kind: "unified" });
	assert.equal(d.deletedCount, 2, "delete result is parsed to the SDK's camelCase");
	assert.equal(calls[2]!.init.method, "DELETE");
	assert.deepEqual(JSON.parse(String(calls[2]!.init.body)), { database: "db_u", collection: "c1", ids: ["a", "b"], type: "unified" });
});

// PRO-1684 on PRO-1618: a unified database enforces document ACLs like a
// split one, so the hand-built relations request has to carry the principals
// in the same repeated form the SDK path sends. Dropping them would make
// "view as" silently widen to everything on this layout.
test("unified relations carries acl principals and the unified type", async () => {
	const calls: string[] = [];
	const fetchImpl = ((url: string | URL | Request) => {
		calls.push(String(url));
		return Promise.resolve(
			new Response(JSON.stringify({ success: true, data: { relations: [], total: 0 } }), { status: 200, headers: { "content-type": "application/json" } }),
		);
	}) as typeof fetch;
	const sdk = { context: { relations() { throw new Error("SDK relations must not be used for unified"); } } } as unknown as HydraDBClient;
	const hydra = new HydraDB({ token: "t", database: "db_u", collection: "c1", baseUrl: "https://api.test", fetchFn: fetchImpl }, sdk);

	await hydra.context.relations({ kind: "unified", id: "s1", limit: 3, acl: ["alice@acme.com", "group:slack:C1"] });
	const sent = new URL(calls[0]!);
	assert.equal(sent.pathname, "/context/relations");
	assert.equal(sent.searchParams.get("type"), "unified");
	assert.equal(sent.searchParams.get("id"), "s1");
	assert.equal(sent.searchParams.get("limit"), "3");
	assert.deepEqual(sent.searchParams.getAll("acl"), ["alice@acme.com", "group:slack:C1"]);

	// No principals means no acl parameter at all: absent and [] are the same
	// to the API, and the request should say what the caller said.
	await hydra.context.relations({ kind: "unified", id: "s1" });
	assert.equal(new URL(calls[1]!).searchParams.has("acl"), false);
});

// Greptile on #72: the memoised probe took its FIRST caller's signal, so a
// later caller who cancelled kept waiting, and a first caller who cancelled
// failed everyone else's probe (they then read the database as split). The
// shared request now takes no caller signal; each waiter honours its own.
test("a cancelled layout waiter rejects alone while the shared probe still serves the others", async () => {
	let release: (r: Response) => void = () => {};
	const gate = new Promise<Response>((resolve) => { release = resolve; });
	let requests = 0;
	const slow = (() => { requests += 1; return gate; }) as typeof fetch;
	const hydra = new HydraDB({ token: "t", database: "a", baseUrl: "https://api.test", fetchFn: slow }, {} as HydraDBClient);

	const first = new AbortController();
	const firstWaiter = hydra.databases.layout("a", first.signal);
	const secondWaiter = hydra.databases.layout("a");
	first.abort();
	await assert.rejects(firstWaiter, (err: unknown) => err instanceof HydraWrapperError && /cancelled by the caller/.test(err.message));

	release(new Response(JSON.stringify({ success: true, data: { databases: ["a"], details: [{ database: "a", type: "unified" }] } }), { status: 200 }));
	assert.equal(await secondWaiter, "unified", "the other waiter still gets the real layout");
	assert.equal(requests, 1, "one shared probe, not one per waiter");
	assert.equal(await hydra.databases.layout("a"), "unified", "and it stays memoised");
});

test("an abort during retry backoff ends the loop without another request", async () => {
	let attempts = 0;
	const controller = new AbortController();
	const flaky = (() => {
		attempts += 1;
		// Cancel while the transport is sleeping before its retry.
		setTimeout(() => controller.abort(), 10);
		return Promise.resolve(new Response("upstream", { status: 503 }));
	}) as typeof fetch;
	const hydra = new HydraDB({ token: "t", database: "a", baseUrl: "https://api.test", fetchFn: flaky, maxRetries: 3 }, {} as HydraDBClient);
	await assert.rejects(
		hydra.databases.layout("a", controller.signal),
		(err: unknown) => err instanceof HydraWrapperError && /cancelled by the caller/.test(err.message),
	);
	assert.equal(attempts, 1, "no request is made for a caller who already cancelled");
});

test("the raw transport retries 5xx and network failures, never a 4xx", async () => {
	let attempts = 0;
	const flaky = ((url: string | URL | Request) => {
		attempts += 1;
		if (attempts < 3) return Promise.resolve(new Response("upstream", { status: 503 }));
		return Promise.resolve(
			new Response(JSON.stringify({ success: true, data: { databases: ["a"], details: [{ database: "a", type: "unified" }] } }), { status: 200 }),
		);
	}) as typeof fetch;
	const hydra = new HydraDB({ token: "t", database: "a", baseUrl: "https://api.test", fetchFn: flaky, maxRetries: 2 }, {} as HydraDBClient);
	assert.equal(await hydra.databases.layout("a"), "unified");
	assert.equal(attempts, 3);

	let rejected = 0;
	const refusing = (() => {
		rejected += 1;
		return Promise.resolve(new Response(JSON.stringify({ success: false, error: { message: "no" } }), { status: 400 }));
	}) as typeof fetch;
	const strict = new HydraDB({ token: "t", database: "a", baseUrl: "https://api.test", fetchFn: refusing, maxRetries: 2 }, {} as HydraDBClient);
	await assert.rejects(() => strict.databases.create({ database: "x", type: "unified" }));
	assert.equal(rejected, 1, "a 4xx is final");
});
