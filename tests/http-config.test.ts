import assert from "node:assert/strict";
import { test } from "node:test";

import {
	buildAllowedHosts,
	DEFAULT_BIND_ADDRESS,
	DEFAULT_PORT,
	parseList,
	parsePort,
	parseTrustProxy,
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

test("an authenticated request with no database resolves, with the database left open", () => {
	// This used to be a 400 asking for X-HydraDB-Database. Clients that can send
	// only an Authorization header (Claude Desktop, claude.ai) could therefore
	// never use the hosted server. The database is now optional and resolved
	// from the account on first use.
	const result = resolveRequestCredentials({ authorization: "Bearer k" }, {});
	assert.ok(result.ok);
	assert.equal(result.credentials.apiKey, "k");
	assert.equal(result.credentials.database, undefined);
	assert.equal(result.credentials.collection, "hydra-db-mcp");
	assert.equal(result.credentials.graph.database, "");
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

// --- Credentials resolve as a coupled identity, not field-by-field ---

test("a caller's key never pairs with the operator's env database", () => {
	// The caller authenticated with their OWN key but named no database. The env
	// database is the operator's, so it is NOT consulted: the caller's database
	// is left to be resolved from the caller's own account, never borrowed.
	const result = resolveRequestCredentials(
		{ authorization: "Bearer caller-key" },
		{ HYDRADB_API_KEY: "operator-key", HYDRADB_DATABASE: "operator-db" },
	);
	assert.ok(result.ok);
	assert.equal(result.credentials.apiKey, "caller-key");
	assert.equal(result.credentials.database, undefined);
	// Same for the graph namespace: the operator's default is not inherited.
	assert.equal(result.credentials.graph.database, "");
});

test("a caller-authenticated request ignores the operator's graph env database", () => {
	// HYDRADB_GRAPH_DATABASE is the operator's; a caller who sends their own key
	// and database, but no graph header, gets THEIR database as the graph default.
	const result = resolveRequestCredentials(
		{ authorization: "Bearer caller-key", "x-hydradb-database": "caller-db" },
		{ HYDRADB_GRAPH_DATABASE: "operator-graph" },
	);
	assert.ok(result.ok);
	assert.equal(result.credentials.graph.database, "caller-db");
});

test("an unauthenticated (self-host) request does honour the graph env database", () => {
	const result = resolveRequestCredentials(
		{},
		{
			HYDRADB_API_KEY: "env-key",
			HYDRADB_DATABASE: "env-db",
			HYDRADB_GRAPH_DATABASE: "env-graph",
		},
	);
	assert.ok(result.ok);
	assert.equal(result.credentials.graph.database, "env-graph");
});

// --- trust proxy ---

test("parseTrustProxy maps env spellings to Express's setting", () => {
	assert.equal(parseTrustProxy(undefined), false);
	assert.equal(parseTrustProxy(""), false);
	assert.equal(parseTrustProxy("false"), false);
	assert.equal(parseTrustProxy("true"), true);
	assert.equal(parseTrustProxy("2"), 2);
	assert.equal(parseTrustProxy("loopback"), "loopback");
});

test("resolveHttpServerConfig defaults trustProxy off", () => {
	assert.equal(resolveHttpServerConfig({}).trustProxy, false);
	assert.equal(resolveHttpServerConfig({ TRUST_PROXY: "1" }).trustProxy, 1);
});

// --- Path scope (connection links, 1.3.0) ---

test("a connection link authenticates and scopes with no headers at all", () => {
	const result = resolveRequestCredentials(
		{},
		{ HYDRADB_API_KEY: "operator-key", HYDRADB_DATABASE: "operator-db" },
		{ apiKey: "sk_live_abc.secret", database: "my-db", collection: "my-col" },
	);
	assert.ok(result.ok);
	assert.equal(result.credentials.apiKey, "sk_live_abc.secret");
	assert.equal(result.credentials.database, "my-db");
	assert.equal(result.credentials.collection, "my-col");
	// The link's key counts as caller authentication, so the graph scope follows
	// the link's database, not the operator's.
	assert.equal(result.credentials.graph.database, "my-db");
});

test("a link with only a key leaves the database to be resolved", () => {
	const result = resolveRequestCredentials({}, {}, { apiKey: "sk_live_abc.secret" });
	assert.ok(result.ok);
	assert.equal(result.credentials.database, undefined);
	assert.equal(result.credentials.collection, "hydra-db-mcp");
});

test("path scope beats the equivalent header, header beats env", () => {
	const result = resolveRequestCredentials(
		{
			authorization: "Bearer header-key",
			"x-hydradb-database": "header-db",
			"x-hydradb-collection": "header-col",
		},
		{ HYDRADB_COLLECTION: "env-col" },
		{ apiKey: "path-key", database: "path-db" },
	);
	assert.ok(result.ok);
	assert.equal(result.credentials.apiKey, "path-key");
	assert.equal(result.credentials.database, "path-db");
	// No collection in the path, so the header's wins over the env's.
	assert.equal(result.credentials.collection, "header-col");
});

test("a path database scopes a header-authenticated request", () => {
	const result = resolveRequestCredentials(
		{ authorization: "Bearer k" },
		{},
		{ database: "path-db" },
	);
	assert.ok(result.ok);
	assert.equal(result.credentials.apiKey, "k");
	assert.equal(result.credentials.database, "path-db");
});

test("a path database alone, with no key anywhere, is still a 401", () => {
	const result = resolveRequestCredentials({}, {}, { database: "path-db" });
	assert.ok(!result.ok);
	assert.equal(result.status, 401);
});
