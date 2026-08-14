import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveConfig } from "../src/config.js";
import { LogLevel, resolveLogLevel } from "../src/logger.js";

// A fresh warning sink per call keeps assertions isolated from the module-level
// once-per-process dedupe used in production.
function collect() {
	const messages: string[] = [];
	return { warn: (m: string) => messages.push(m), messages };
}

test("canonical HYDRADB_* names are read as primary with no warning", () => {
	const { warn, messages } = collect();
	const config = resolveConfig(
		{
			HYDRADB_API_KEY: "key",
			HYDRADB_DATABASE: "db",
			HYDRADB_COLLECTION: "col",
			HYDRADB_BASE_URL: "https://custom.example.com",
		},
		warn,
	);
	assert.deepEqual(config, {
		apiKey: "key",
		database: "db",
		collection: "col",
		baseUrl: "https://custom.example.com",
	});
	assert.deepEqual(messages, []);
});

test("deprecated HYDRA_DB_* names are honoured as a fallback and warn once", () => {
	const { warn, messages } = collect();
	const config = resolveConfig(
		{
			HYDRA_DB_API_KEY: "key",
			HYDRA_DB_TENANT_ID: "db",
			HYDRA_DB_SUB_TENANT_ID: "col",
		},
		warn,
	);
	assert.equal(config.apiKey, "key");
	assert.equal(config.database, "db");
	assert.equal(config.collection, "col");

	// Each deprecated var warns, naming its canonical replacement.
	assert.ok(messages.some((m) => m.includes("HYDRA_DB_API_KEY") && m.includes("HYDRADB_API_KEY")));
	assert.ok(messages.some((m) => m.includes("HYDRA_DB_TENANT_ID") && m.includes("HYDRADB_DATABASE")));
	assert.ok(
		messages.some((m) => m.includes("HYDRA_DB_SUB_TENANT_ID") && m.includes("HYDRADB_COLLECTION")),
	);
});

test("canonical wins when both canonical and deprecated are set (no warning)", () => {
	const { warn, messages } = collect();
	const config = resolveConfig(
		{
			HYDRADB_API_KEY: "canonical",
			HYDRA_DB_API_KEY: "legacy",
			HYDRADB_DATABASE: "db",
		},
		warn,
	);
	assert.equal(config.apiKey, "canonical");
	assert.deepEqual(messages, []);
});

test("collection defaults when unset; baseUrl is optional", () => {
	const { warn } = collect();
	const config = resolveConfig(
		{ HYDRADB_API_KEY: "key", HYDRADB_DATABASE: "db" },
		warn,
	);
	assert.equal(config.collection, "hydra-db-mcp");
	assert.equal(config.baseUrl, undefined);
});

test("HYDRADB_LOG_LEVEL is canonical; the HYDRA_DB_ spelling warns but still works", () => {
	const canonical = collect();
	assert.equal(
		resolveLogLevel({ HYDRADB_LOG_LEVEL: "debug" }, canonical.warn),
		LogLevel.DEBUG,
	);
	assert.deepEqual(canonical.messages, []);

	const legacy = collect();
	assert.equal(
		resolveLogLevel({ HYDRA_DB_LOG_LEVEL: "warn" }, legacy.warn),
		LogLevel.WARN,
	);
	assert.ok(
		legacy.messages.some(
			(m) => m.includes("HYDRA_DB_LOG_LEVEL") && m.includes("HYDRADB_LOG_LEVEL"),
		),
	);

	const both = collect();
	assert.equal(
		resolveLogLevel(
			{ HYDRADB_LOG_LEVEL: "info", HYDRA_DB_LOG_LEVEL: "debug" },
			both.warn,
		),
		LogLevel.INFO,
	);
	assert.deepEqual(both.messages, []);

	// Unset and unrecognised both fall back to ERROR.
	assert.equal(resolveLogLevel({}, collect().warn), LogLevel.ERROR);
	assert.equal(
		resolveLogLevel({ HYDRADB_LOG_LEVEL: "chatty" }, collect().warn),
		LogLevel.ERROR,
	);
});

test("missing required config throws naming the canonical variable", () => {
	const { warn } = collect();
	assert.throws(
		() => resolveConfig({ HYDRADB_DATABASE: "db" }, warn),
		/HYDRADB_API_KEY/,
	);
	assert.throws(
		() => resolveConfig({ HYDRADB_API_KEY: "key" }, warn),
		/HYDRADB_DATABASE/,
	);
});

test("timeout and retry overrides are read when set", () => {
	const { warn, messages } = collect();
	const config = resolveConfig(
		{
			HYDRADB_API_KEY: "key",
			HYDRADB_DATABASE: "db",
			HYDRADB_TIMEOUT_SECONDS: "45",
			HYDRADB_MAX_RETRIES: "0",
		},
		warn,
	);

	assert.equal(config.timeoutSeconds, 45);
	// Zero is a legitimate choice — "do not retry" — and must survive.
	assert.equal(config.maxRetries, 0);
	assert.deepEqual(messages, []);
});

// A typo'd number should not stop the server from starting. Falling back to the
// built-in default keeps it running; exiting 1 over a cosmetic env var is worse
// than the misconfiguration itself.
test("malformed timeout and retry values fall back rather than throwing", () => {
	const { warn } = collect();
	for (const bad of ["abc", "-5", "1.5", ""]) {
		const config = resolveConfig(
			{
				HYDRADB_API_KEY: "key",
				HYDRADB_DATABASE: "db",
				HYDRADB_TIMEOUT_SECONDS: bad,
			},
			warn,
		);
		assert.equal(
			config.timeoutSeconds,
			undefined,
			`"${bad}" should be ignored, not adopted`,
		);
	}
});
