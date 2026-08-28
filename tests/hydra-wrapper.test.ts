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

import { assertDatabaseAllowed, DatabaseNotAllowedError } from "../src/hydra/index.js";

test("assertDatabaseAllowed: undefined allows anything, a list allows only its members", () => {
	assert.doesNotThrow(() => assertDatabaseAllowed("anything", undefined));
	assert.doesNotThrow(() => assertDatabaseAllowed("a", ["a", "b"]));
	assert.throws(() => assertDatabaseAllowed("c", ["a", "b"]), DatabaseNotAllowedError);
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
			assert.ok(e instanceof DatabaseNotAllowedError);
			assert.equal(e.database, "work");
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
