import assert from "node:assert/strict";
import { test } from "node:test";

import { HydraDBClient, HydraDBError } from "@hydradb/sdk";

import { HydraDB, HydraWrapperError, translateError, unwrap } from "../src/hydra/index.js";

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
