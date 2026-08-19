import assert from "node:assert/strict";
import { test } from "node:test";

import {
	buildAllowedHosts,
	DEFAULT_BIND_ADDRESS,
	DEFAULT_PORT,
	parseList,
	parsePort,
	resolveHttpServerConfig,
	resolveRequestCredentials,
} from "../src/http-config.js";

// --- Operator config ---

test("resolveHttpServerConfig defaults to loopback with no cross-origin", () => {
	const config = resolveHttpServerConfig({});
	assert.equal(config.port, DEFAULT_PORT);
	assert.equal(config.bindAddress, DEFAULT_BIND_ADDRESS);
	assert.deepEqual(config.allowedOrigins, []);
	// Loopback names on the default port are always answerable.
	assert.ok(config.allowedHosts.has(`localhost:${DEFAULT_PORT}`));
	assert.ok(config.allowedHosts.has("127.0.0.1"));
});

test("resolveHttpServerConfig reads PORT, BIND_ADDRESS and the allowlists", () => {
	const config = resolveHttpServerConfig({
		PORT: "9000",
		BIND_ADDRESS: "0.0.0.0",
		ALLOWED_ORIGINS: "https://a.com, https://b.com",
		ALLOWED_HOSTS: "mcp.hydradb.com",
	});
	assert.equal(config.port, 9000);
	assert.equal(config.bindAddress, "0.0.0.0");
	assert.deepEqual(config.allowedOrigins, ["https://a.com", "https://b.com"]);
	assert.ok(config.allowedHosts.has("mcp.hydradb.com"));
	// The configured port replaces the default one in the loopback entries.
	assert.ok(config.allowedHosts.has("localhost:9000"));
});

test("parsePort falls back on garbage rather than accepting a partial number", () => {
	assert.equal(parsePort(undefined), DEFAULT_PORT);
	assert.equal(parsePort("8080abc"), DEFAULT_PORT);
	assert.equal(parsePort("0"), DEFAULT_PORT);
	assert.equal(parsePort("70000"), DEFAULT_PORT);
	assert.equal(parsePort("3000"), 3000);
});

test("parseList trims and drops empties", () => {
	assert.deepEqual(parseList(" a , ,b ,"), ["a", "b"]);
	assert.deepEqual(parseList(undefined), []);
	assert.deepEqual(parseList(""), []);
});

test("buildAllowedHosts lowercases and always includes loopback", () => {
	const hosts = buildAllowedHosts(8080, ["MCP.Hydradb.COM"]);
	assert.ok(hosts.has("mcp.hydradb.com"));
	assert.ok(hosts.has("[::1]:8080"));
	assert.ok(hosts.has("localhost"));
});

// --- Per-request credentials ---

test("credentials come from Authorization + X-HydraDB-Database headers", () => {
	const result = resolveRequestCredentials(
		{
			authorization: "Bearer secret-key",
			"x-hydradb-database": "tenant-a",
		},
		{},
	);
	assert.ok(result.ok);
	assert.equal(result.credentials.apiKey, "secret-key");
	assert.equal(result.credentials.database, "tenant-a");
	// Collection defaults, and the graph database mirrors the memory database.
	assert.equal(result.credentials.collection, "hydra-db-mcp");
	assert.equal(result.credentials.graph.database, "tenant-a");
	assert.equal(result.credentials.graph.enabled, true);
});

test("the Bearer scheme is optional and case-insensitive", () => {
	for (const authorization of ["Bearer k", "bearer k", "BEARER k", "k"]) {
		const result = resolveRequestCredentials(
			{ authorization, "x-hydradb-database": "db" },
			{},
		);
		assert.ok(result.ok, `expected ok for "${authorization}"`);
		assert.equal(result.credentials.apiKey, "k");
	}
});

test("X-HydraDB-Api-Key is accepted when Authorization cannot be set", () => {
	const result = resolveRequestCredentials(
		{ "x-hydradb-api-key": "hdr-key", "x-hydradb-database": "db" },
		{},
	);
	assert.ok(result.ok);
	assert.equal(result.credentials.apiKey, "hdr-key");
});

test("headers override the environment fallback", () => {
	const result = resolveRequestCredentials(
		{
			authorization: "Bearer header-key",
			"x-hydradb-database": "header-db",
			"x-hydradb-collection": "header-col",
			"x-hydradb-graph-database": "graph-db",
			"x-hydradb-graph-collection": "graph-col",
		},
		{ HYDRADB_API_KEY: "env-key", HYDRADB_DATABASE: "env-db" },
	);
	assert.ok(result.ok);
	assert.equal(result.credentials.apiKey, "header-key");
	assert.equal(result.credentials.database, "header-db");
	assert.equal(result.credentials.collection, "header-col");
	assert.equal(result.credentials.graph.database, "graph-db");
	assert.equal(result.credentials.graph.collection, "graph-col");
});

test("a missing key is a 401 (single-tenant self-host is the env-fallback case)", () => {
	// Multi-tenant: no env, no header — nothing authenticated the request.
	const anon = resolveRequestCredentials({ "x-hydradb-database": "db" }, {});
	assert.ok(!anon.ok);
	assert.equal(anon.status, 401);

	// Self-host: the operator set the env, so no header is needed.
	const selfHost = resolveRequestCredentials(
		{},
		{ HYDRADB_API_KEY: "env-key", HYDRADB_DATABASE: "env-db" },
	);
	assert.ok(selfHost.ok);
	assert.equal(selfHost.credentials.apiKey, "env-key");
	assert.equal(selfHost.credentials.database, "env-db");
});

test("an authenticated request with no database is a 400, not a 401", () => {
	const result = resolveRequestCredentials({ authorization: "Bearer k" }, {});
	assert.ok(!result.ok);
	assert.equal(result.status, 400);
	assert.match(result.message, /X-HydraDB-Database/);
});

test("baseUrl/timeout/retries are operator env only, never from headers", () => {
	const result = resolveRequestCredentials(
		{
			authorization: "Bearer k",
			"x-hydradb-database": "db",
			// A caller trying to redirect the server's outbound calls is ignored.
			"x-hydradb-base-url": "https://evil.example.com",
		},
		{
			HYDRADB_BASE_URL: "https://api.hydradb.com",
			HYDRADB_TIMEOUT_SECONDS: "45",
			HYDRADB_MAX_RETRIES: "0",
		},
	);
	assert.ok(result.ok);
	assert.equal(result.credentials.baseUrl, "https://api.hydradb.com");
	assert.equal(result.credentials.timeoutSeconds, 45);
	assert.equal(result.credentials.maxRetries, 0);
});

test("legacy HYDRA_DB_* env aliases still resolve on the header path, silently", () => {
	const result = resolveRequestCredentials(
		{},
		{ HYDRA_DB_API_KEY: "legacy-key", HYDRA_DB_TENANT_ID: "legacy-db" },
	);
	assert.ok(result.ok);
	assert.equal(result.credentials.apiKey, "legacy-key");
	assert.equal(result.credentials.database, "legacy-db");
});

test("repeated headers take the first value", () => {
	const result = resolveRequestCredentials(
		{
			authorization: ["Bearer first", "Bearer second"],
			"x-hydradb-database": ["db-1", "db-2"],
		},
		{},
	);
	assert.ok(result.ok);
	assert.equal(result.credentials.apiKey, "first");
	assert.equal(result.credentials.database, "db-1");
});

test("graph tools can be withheld by the operator regardless of caller", () => {
	const result = resolveRequestCredentials(
		{ authorization: "Bearer k", "x-hydradb-database": "db" },
		{ HYDRADB_MCP_GRAPH_TOOLS: "0" },
	);
	assert.ok(result.ok);
	assert.equal(result.credentials.graph.enabled, false);
});
