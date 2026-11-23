/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions -- Test doubles model dynamic SDK and log JSON, the same as connector-tools.test.ts. */
import "./support/log-level-info.js";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, test } from "node:test";

import { HydraDBError } from "@hydradb/sdk";
import type { HydraDBClient } from "@hydradb/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { resolveHttpServerConfig } from "../src/http-config.js";
import { HydraDB, HydraWrapperError } from "../src/hydra/index.js";
import { formatMessage, LogLevel, resolveLogFormat } from "../src/logger.js";
import { __resetMetrics, recordToolCall, renderMetrics, startMetricsServer } from "../src/metrics.js";
import { createHydraDBServer } from "../src/server.js";

const KEY = "sk_live_tooltestkey0000";

async function connect(sdk: Record<string, unknown>, opts: { timeoutSeconds?: number; maxRetries?: number } = {}) {
	const hydra = new HydraDB({ token: KEY, database: "db", ...opts }, sdk as unknown as HydraDBClient);
	const server = createHydraDBServer(hydra);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "observability-tests", version: "1" });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

	return { client, hydra };
}

/** The stderr lines the logger wrote while `run` ran. */
async function captureLogs(run: () => Promise<unknown>): Promise<string[]> {
	const lines: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => {
		lines.push(args.map(String).join(" "));
	};

	try {
		await run();
	} finally {
		console.error = original;
	}

	return lines;
}

function failureLogs(lines: string[]): Record<string, unknown>[] {
	return lines.flatMap((line) =>
		/tool call (failed|cancelled|rejected)/.test(line)
			? [JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>]
			: []);
}

function count(tool: string, result: string): number {
	const match = renderMetrics().match(new RegExp(`hydradb_mcp_tool_calls_total\\{tool="${tool}",result="${result}"\\} (\\d+)`));

	return match ? Number(match[1]) : 0;
}

beforeEach(() => __resetMetrics());

afterEach(() => __resetMetrics());

test("JSON log lines carry the level, service and fields; text stays as it was", () => {
	const json = JSON.parse(formatMessage(LogLevel.WARN, "tool call failed", { tool: "hydradb_query", error_type: "INTERNAL" }, "json"));
	assert.equal(json.level, "WARN");
	assert.equal(json.service_name, "hydradb-mcp");
	assert.equal(json.message, "tool call failed");
	assert.equal(json.tool, "hydradb_query");
	assert.equal(json.error_type, "INTERNAL");
	assert.match(json.timestamp, /^\d{4}-\d\d-\d\dT/);

	const forged = JSON.parse(formatMessage(LogLevel.INFO, "real", { level: "ERROR", message: "forged", service_name: "x" }, "json"));
	assert.deepEqual([forged.level, forged.message, forged.service_name], ["INFO", "real", "hydradb-mcp"]);

	assert.match(formatMessage(LogLevel.WARN, "hello", { a: 1 }, "text"), /^\[.+\] \[hydradb-mcp\] WARN: hello \{"a":1\}$/);
});

test("HYDRADB_LOG_FORMAT=json selects JSON; anything else keeps text", () => {
	assert.equal(resolveLogFormat({ HYDRADB_LOG_FORMAT: "json" }), "json");
	assert.equal(resolveLogFormat({ HYDRADB_LOG_FORMAT: " JSON " }), "json");
	assert.equal(resolveLogFormat({ HYDRADB_LOG_FORMAT: "yaml" }), "text");
	assert.equal(resolveLogFormat({}), "text");
});

test("metrics count calls by tool and result, with a duration histogram", () => {
	recordToolCall("hydradb_query", "ok", 0.2);
	recordToolCall("hydradb_query", "ok", 3);
	recordToolCall("hydradb_query", "error", 0.05);
	const text = renderMetrics();
	assert.match(text, /# TYPE hydradb_mcp_tool_calls_total counter/);
	assert.match(text, /hydradb_mcp_tool_calls_total\{tool="hydradb_query",result="ok"\} 2/);
	assert.match(text, /hydradb_mcp_tool_calls_total\{tool="hydradb_query",result="error"\} 1/);
	assert.match(text, /hydradb_mcp_tool_call_duration_seconds_bucket\{tool="hydradb_query",le="0.25"\} 2/);
	assert.match(text, /hydradb_mcp_tool_call_duration_seconds_bucket\{tool="hydradb_query",le="\+Inf"\} 3/);
	assert.match(text, /hydradb_mcp_tool_call_duration_seconds_count\{tool="hydradb_query"\} 3/);
});

test("the metrics server answers GET /metrics and nothing else", async () => {
	recordToolCall("hydradb_list", "ok", 0.1);
	const server = startMetricsServer(0, "127.0.0.1");
	await new Promise((resolve) => server.once("listening", resolve));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

	try {
		const metrics = await fetch(`${base}/metrics`);
		assert.equal(metrics.status, 200);
		assert.match(await metrics.text(), /tool="hydradb_list",result="ok"/);
		assert.equal((await fetch(`${base}/`)).status, 404);
		assert.equal((await fetch(`${base}/metrics`, { method: "POST" })).status, 404);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test("HYDRADB_METRICS_PORT turns the metrics port on, never onto the MCP port", () => {
	assert.equal(resolveHttpServerConfig({}).metricsPort, undefined);
	assert.equal(resolveHttpServerConfig({ HYDRADB_METRICS_PORT: "9464" }).metricsPort, 9464);
	assert.equal(resolveHttpServerConfig({ HYDRADB_METRICS_PORT: "nope" }).metricsPort, undefined);
	assert.equal(resolveHttpServerConfig({ PORT: "9000", HYDRADB_METRICS_PORT: "9000" }).metricsPort, undefined);
});

test("a successful call is counted ok and logs nothing", async () => {
	const { client } = await connect({ query: async () => ({ success: true, chunks: [] }), context: {} });
	const lines = await captureLogs(() => client.callTool({ name: "hydradb_query", arguments: { query: "who led phoenix" } }));
	assert.equal(count("hydradb_query", "ok"), 1);
	assert.deepEqual(failureLogs(lines), []);
});

test("a HydraDB failure is counted and logged with its status, never the arguments or the key", async () => {
	const fail = () => Promise.reject(new HydraDBError({ statusCode: 500, body: { error: { code: "E", message: "boom" } } }));
	const { client, hydra } = await connect({ query: fail, context: {} });
	const lines = await captureLogs(() => client.callTool({ name: "hydradb_query", arguments: { query: "secret question" } }));
	assert.equal(count("hydradb_query", "error"), 1);
	const [line, ...rest] = failureLogs(lines);
	assert.deepEqual(rest, []);
	assert.equal(line.tool, "hydradb_query");
	assert.equal(line.result, "error");
	assert.equal(line.error_type, "HYDRADB_HTTP_500");
	assert.equal(line.key_id, hydra.keyId);
	assert.equal(typeof line.duration_ms, "number");
	const all = lines.join("\n");
	assert.doesNotMatch(all, /secret question/);
	assert.doesNotMatch(all, new RegExp(KEY));
});

test("a reworded connector failure keeps the status HydraDB answered", async () => {
	const fail = () => Promise.reject(new HydraDBError({ statusCode: 404, body: { error: { code: "E", message: "gone" } } }));

	const { client } = await connect({
		query: async () => ({ success: true, chunks: [] }),
		context: {},
		connectors: { list: fail, get: fail, status: fail },
	});

	const lines = await captureLogs(() => client.callTool({ name: "hydradb_connector_list", arguments: {} }));
	const [line] = failureLogs(lines);
	assert.equal(line?.error_type, "HYDRADB_HTTP_404");
	assert.equal(count("hydradb_connector_list", "rejected"), 1);
});

for (const [status, expected] of [[400, "rejected"], [403, "rejected"], [408, "error"], [429, "error"], [503, "error"]] as const) {
	test(`a HydraDB ${status} is counted as ${expected}`, async () => {
		const fail = () => Promise.reject(new HydraDBError({ statusCode: status, body: { error: { code: "E", message: "x" } } }));
		const { client } = await connect({ query: fail, context: {} }, { maxRetries: 0 });
		const lines = await captureLogs(() => client.callTool({ name: "hydradb_query", arguments: { query: "q" } }));
		assert.equal(count("hydradb_query", expected), 1);
		assert.equal(failureLogs(lines)[0]?.result, expected);
	});
}

test("a call that runs out of its deadline is counted as a timeout", async () => {
	const hang = (_args: unknown, options?: { abortSignal?: AbortSignal }) =>
		new Promise((_resolve, reject) => {
			options?.abortSignal?.addEventListener("abort", () => reject(options.abortSignal?.reason), { once: true });
		});

	const { client } = await connect({ query: hang, context: {} }, { timeoutSeconds: 0.05 });
	const lines = await captureLogs(() => client.callTool({ name: "hydradb_query", arguments: { query: "q" } }));
	assert.equal(count("hydradb_query", "timeout"), 1);
	assert.equal(failureLogs(lines)[0]?.error_type, "DEADLINE_EXCEEDED");
});

test("a reworded database 403 is rejected with its status", async () => {
	const { client, hydra } = await connect({ query: async () => ({ success: true, chunks: [] }), context: {} });
	hydra.databases.create = () =>
		Promise.reject(new HydraWrapperError("Hydra DB /databases → 403: policy denied this request", "/databases", { status: 403 }));
	const lines = await captureLogs(() => client.callTool({ name: "hydradb_database_create", arguments: { database: "new" } }));
	assert.equal(count("hydradb_database_create", "rejected"), 1);
	assert.equal(failureLogs(lines)[0]?.error_type, "HYDRADB_HTTP_403");
});

test("a reworded unified-database ingest error is rejected with its status", async () => {
	const fail = () => Promise.reject(new HydraDBError({
		statusCode: 400,
		body: { error: { code: "CORPUS_TYPE_UNSUPPORTED", message: "app_knowledge is not supported for this corpus" } },
	}));

	const { client } = await connect({ query: async () => ({ success: true, chunks: [] }), context: { ingest: fail } }, { maxRetries: 0 });

	const lines = await captureLogs(() => client.callTool({
		name: "hydradb_ingest",
		arguments: { app_knowledge: [{ kind: "message", fields: { body: "hello" }, acl: ["bob"] }] },
	}));

	assert.equal(count("hydradb_ingest", "rejected"), 1);
	assert.equal(failureLogs(lines)[0]?.error_type, "HYDRADB_HTTP_400");
});
