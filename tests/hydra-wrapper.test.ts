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

test("an SDK error with neither status nor body still says something", () => {
	// The shape a timed-out request arrives in: the SDK classifies the abort as
	// an unknown failure, so the reason survives only on `message`. Rendering the
	// body alone would emit `Hydra DB /query → ERR: ` and strand the model.
	const translated = translateError(
		"/query",
		new HydraDBError({ message: "invalid_argument" }),
	);
	assert.equal(translated.message, "Hydra DB /query → ERR: invalid_argument");
	assert.equal(translated.status, undefined);
});

test("the fallback does not disturb errors that carry a status", () => {
	// A status with no body keeps the v1 template exactly — the SDK's own message
	// would read "Status code: 500", which the template already conveys.
	assert.equal(
		translateError("/query", new HydraDBError({ statusCode: 500 })).message,
		"Hydra DB /query → 500: ",
	);
	// And a status with a body is unchanged.
	assert.equal(
		translateError(
			"/query",
			new HydraDBError({ statusCode: 400, body: { code: "BAD" } }),
		).message,
		`Hydra DB /query → 400: ${JSON.stringify({ code: "BAD" })}`,
	);
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
