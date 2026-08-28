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

// --- Default database resolution (1.3.0) ---

import {
	__resetDefaultDatabaseCache,
	AmbiguousDatabaseError,
	DEFAULT_DATABASE_NAME,
} from "../src/hydra/index.js";

/** An SDK whose `databases` surface answers from canned lists and records writes. */
function databasesSdk(names: string[]) {
	const calls: string[] = [];
	const sdk = {
		query(args: Record<string, unknown>) {
			calls.push(`query:${args.database}`);
			return Promise.resolve({ data: { chunks: [] }, success: true });
		},
		databases: {
			list() {
				calls.push("list");
				return Promise.resolve({ data: { databases: names }, success: true });
			},
			create(args: { database: string }) {
				calls.push(`create:${args.database}`);
				// The server provisions asynchronously; from now on it lists.
				names.push(args.database);
				return Promise.resolve({ data: { status: "creating" }, success: true });
			},
			status(args: { database: string }) {
				calls.push(`status:${args.database}`);
				return Promise.resolve({
					data: { infra: { readyForIngestion: true } },
					success: true,
				});
			},
		},
	} as unknown as HydraDBClient;
	return { sdk, calls };
}

test("a configured database is used as-is and never resolved", async () => {
	__resetDefaultDatabaseCache();
	const { sdk, calls } = databasesSdk(["a", "b"]);
	const hydra = new HydraDB({ token: "t", database: "fixed" }, sdk);
	assert.equal(hydra.database.known, "fixed");
	await hydra.context.query({ query: "hi" });
	assert.deepEqual(calls, ["query:fixed"]);
});

test("an account with exactly one database resolves to it, once, on first use", async () => {
	__resetDefaultDatabaseCache();
	const { sdk, calls } = databasesSdk(["only-one"]);
	const hydra = new HydraDB({ token: "t1" }, sdk);
	// Construction is free: nothing has been resolved yet.
	assert.equal(hydra.database.known, undefined);
	assert.deepEqual(calls, []);

	await hydra.context.query({ query: "hi" });
	await hydra.context.query({ query: "again" });
	assert.equal(hydra.database.known, "only-one");
	// One list, then every call scoped to it.
	assert.deepEqual(calls, ["list", "query:only-one", "query:only-one"]);
});

test("an account with no database gets one created and waits for readiness", async () => {
	__resetDefaultDatabaseCache();
	const { sdk, calls } = databasesSdk([]);
	const hydra = new HydraDB({ token: "t2" }, sdk);
	await hydra.context.query({ query: "hi" });
	assert.equal(hydra.database.known, DEFAULT_DATABASE_NAME);
	assert.deepEqual(calls, [
		"list",
		`create:${DEFAULT_DATABASE_NAME}`,
		`status:${DEFAULT_DATABASE_NAME}`,
		`query:${DEFAULT_DATABASE_NAME}`,
	]);
});

test("an account with several databases is asked to choose, never guessed for", async () => {
	__resetDefaultDatabaseCache();
	const { sdk, calls } = databasesSdk(["work", "personal"]);
	const hydra = new HydraDB({ token: "t3" }, sdk);
	await assert.rejects(
		() => hydra.context.query({ query: "hi" }),
		(e: unknown) => {
			assert.ok(e instanceof AmbiguousDatabaseError);
			assert.deepEqual(e.databases, ["work", "personal"]);
			assert.match(e.message, /"work", "personal"/);
			assert.match(e.message, /Pass `database`/);
			return true;
		},
	);
	// Nothing was written and no query went out.
	assert.deepEqual(calls, ["list"]);
	// A per-call database sidesteps the question entirely.
	await hydra.context.query({ query: "hi", database: "work" });
	assert.deepEqual(calls, ["list", "query:work"]);
	// The failure did not poison the resolver: it asks again next time.
	await assert.rejects(() => hydra.context.query({ query: "hi" }), AmbiguousDatabaseError);
	assert.deepEqual(calls, ["list", "query:work", "list"]);
});

test("the resolved default is memoised per account across client instances", async () => {
	__resetDefaultDatabaseCache();
	const first = databasesSdk(["memo"]);
	await new HydraDB({ token: "same-token" }, first.sdk).context.query({ query: "a" });
	assert.deepEqual(first.calls, ["list", "query:memo"]);

	// A second client for the SAME token (what the hosted server builds per
	// request) skips the list.
	const second = databasesSdk(["memo"]);
	await new HydraDB({ token: "same-token" }, second.sdk).context.query({ query: "b" });
	assert.deepEqual(second.calls, ["query:memo"]);

	// A different token is a different account and resolves on its own.
	const third = databasesSdk(["other"]);
	await new HydraDB({ token: "other-token" }, third.sdk).context.query({ query: "c" });
	assert.deepEqual(third.calls, ["list", "query:other"]);
	__resetDefaultDatabaseCache();
});

test("a lost create race resolves to the same default instead of failing", async () => {
	__resetDefaultDatabaseCache();
	// Two unscoped clients hit a zero-database account at once. The second
	// create loses with a 409, which means the database exists — the goal.
	const calls: string[] = [];
	const sdk = {
		query(args: Record<string, unknown>) {
			calls.push(`query:${args.database}`);
			return Promise.resolve({ data: { chunks: [] }, success: true });
		},
		databases: {
			list() {
				calls.push("list");
				return Promise.resolve({ data: { databases: [] }, success: true });
			},
			create() {
				calls.push("create");
				return Promise.reject(
					new HydraDBError({ statusCode: 409, body: { code: "CONFLICT" } }),
				);
			},
			status() {
				return Promise.resolve({ data: { infra: { readyForIngestion: true } }, success: true });
			},
		},
	} as unknown as HydraDBClient;

	const hydra = new HydraDB({ token: "race-token" }, sdk);
	await hydra.context.query({ query: "hi" });
	assert.equal(hydra.database.known, DEFAULT_DATABASE_NAME);
	assert.deepEqual(calls, ["list", "create", `query:${DEFAULT_DATABASE_NAME}`]);
	__resetDefaultDatabaseCache();
});

test("a non-conflict create failure still propagates", async () => {
	__resetDefaultDatabaseCache();
	const sdk = {
		query: () => Promise.resolve({ data: { chunks: [] }, success: true }),
		databases: {
			list: () => Promise.resolve({ data: { databases: [] }, success: true }),
			create: () =>
				Promise.reject(new HydraDBError({ statusCode: 403, body: { code: "FORBIDDEN" } })),
		},
	} as unknown as HydraDBClient;
	await assert.rejects(
		() => new HydraDB({ token: "forbidden-token" }, sdk).context.query({ query: "hi" }),
		/403/,
	);
	__resetDefaultDatabaseCache();
});
