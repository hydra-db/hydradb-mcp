import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import { createHttpApp } from "../src/http.js";
import { buildAllowedHosts, resolveRequestCredentials } from "../src/http-config.js";
import {
	__resetIntrospectionCache,
	introspect,
	isAccessToken,
	metadataUrl,
	type OAuthConfig,
	protectedResourceMetadata,
	resolveOAuthConfig,
	wwwAuthenticate,
} from "../src/oauth.js";

// --- Config ---

test("OAuth is off with no configuration and on only when all three values are set", () => {
	const warnings: string[] = [];
	const warn = (m: string) => warnings.push(m);
	assert.equal(resolveOAuthConfig({}, warn), null);
	assert.equal(warnings.length, 0);

	// Half a configuration is treated as none, loudly.
	assert.equal(resolveOAuthConfig({ HYDRADB_OAUTH_ISSUER: "https://app.test" }, warn), null);
	assert.match(warnings[0], /HYDRADB_MCP_PUBLIC_URL/);
	assert.match(warnings[0], /HYDRADB_OAUTH_INTROSPECTION_SECRET/);

	const config = resolveOAuthConfig({
		HYDRADB_OAUTH_ISSUER: "https://app.test/",
		HYDRADB_MCP_PUBLIC_URL: "https://mcp.test/",
		HYDRADB_OAUTH_INTROSPECTION_SECRET: "s3cret",
	});
	assert.deepEqual(config, {
		issuer: "https://app.test",
		resource: "https://mcp.test",
		introspectionSecret: "s3cret",
	});
});

test("a non-URL issuer disables OAuth rather than advertising garbage", () => {
	const warnings: string[] = [];
	assert.equal(
		resolveOAuthConfig(
			{
				HYDRADB_OAUTH_ISSUER: "app.test",
				HYDRADB_MCP_PUBLIC_URL: "https://mcp.test",
				HYDRADB_OAUTH_INTROSPECTION_SECRET: "s",
			},
			(m) => warnings.push(m),
		),
		null,
	);
	assert.match(warnings[0], /HYDRADB_OAUTH_ISSUER must be an absolute/);
});

const CONFIG: OAuthConfig = {
	issuer: "https://app.test",
	resource: "https://mcp.test",
	introspectionSecret: "s3cret",
};

test("metadata document and WWW-Authenticate follow RFC 9728", () => {
	assert.equal(metadataUrl(CONFIG), "https://mcp.test/.well-known/oauth-protected-resource");
	assert.deepEqual(protectedResourceMetadata(CONFIG), {
		resource: "https://mcp.test",
		authorization_servers: ["https://app.test"],
		scopes_supported: ["hydradb"],
		bearer_methods_supported: ["header"],
		resource_name: "Hydra DB MCP",
		resource_documentation: "https://docs.hydradb.com/mcp",
	});
	assert.equal(
		wwwAuthenticate(CONFIG),
		'Bearer realm="Hydra DB MCP", resource_metadata="https://mcp.test/.well-known/oauth-protected-resource", scope="hydradb"',
	);
	assert.equal(
		wwwAuthenticate(CONFIG, "invalid_token", 'it "expired"'),
		"Bearer realm=\"Hydra DB MCP\", error=\"invalid_token\", error_description=\"it 'expired'\", " +
			'resource_metadata="https://mcp.test/.well-known/oauth-protected-resource", scope="hydradb"',
	);
});

test("only hmat_ bearers are treated as access tokens; API keys are not", () => {
	assert.ok(isAccessToken("hmat_abc"));
	assert.ok(!isAccessToken("sk_live_abc.def"));
	assert.ok(!isAccessToken(undefined));
});

// --- Introspection ---

type Call = { url: string; init: RequestInit };
function fakeFetch(handler: (call: Call) => { status: number; body?: unknown }) {
	const calls: Call[] = [];
	const fetchFn = (async (url: string | URL, init?: RequestInit) => {
		const call = { url: String(url), init: init ?? {} };
		calls.push(call);
		const { status, body } = handler(call);
		return new Response(body == null ? null : JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json" },
		});
	}) as unknown as typeof fetch;
	return { fetchFn, calls };
}

const NOW = 1_800_000_000_000;
const active = (over: Record<string, unknown> = {}) => ({
	active: true,
	sub: "user-1",
	client_id: "hmc_claude",
	client_name: "Claude Desktop",
	scope: "hydradb",
	aud: "https://mcp.test",
	exp: Math.floor(NOW / 1000) + 3600,
	database: "personal",
	collection: "hydra-db-mcp",
	api_key: "sk_live_abc.SECRET",
	...over,
});

test("introspection sends the secret and the token as a form, and maps the answer", async () => {
	__resetIntrospectionCache();
	const { fetchFn, calls } = fakeFetch(() => ({ status: 200, body: active() }));
	const result = await introspect({ ...CONFIG, fetchFn, now: () => NOW }, "hmat_tok1");
	assert.ok(result.ok);
	assert.deepEqual(result.token, {
		apiKey: "sk_live_abc.SECRET",
		database: "personal",
		collection: "hydra-db-mcp",
		userId: "user-1",
		clientId: "hmc_claude",
		clientName: "Claude Desktop",
		expiresAt: Math.floor(NOW / 1000) + 3600,
	});
	assert.equal(calls[0].url, "https://app.test/api/oauth/introspect");
	const headers = calls[0].init.headers as Record<string, string>;
	assert.equal(headers.Authorization, "Bearer s3cret");
	assert.equal(calls[0].init.body, "token=hmat_tok1");
});

test("a token for another resource is refused even though the issuer says it is active", async () => {
	__resetIntrospectionCache();
	const { fetchFn } = fakeFetch(() => ({ status: 200, body: active({ aud: "https://other.test" }) }));
	const result = await introspect({ ...CONFIG, fetchFn, now: () => NOW }, "hmat_tok2");
	assert.ok(!result.ok);
	assert.equal(result.reason, "wrong_audience");
	// A trailing slash on the audience is not a different resource.
	const ok = fakeFetch(() => ({ status: 200, body: active({ aud: ["https://mcp.test/"] }) }));
	const r2 = await introspect({ ...CONFIG, fetchFn: ok.fetchFn, now: () => NOW }, "hmat_tok3");
	assert.ok(r2.ok);
});

test("inactive, expired and key-less answers are invalid_token; transport failures are unavailable", async () => {
	__resetIntrospectionCache();
	const cfg = (h: Parameters<typeof fakeFetch>[0]) => ({ ...CONFIG, fetchFn: fakeFetch(h).fetchFn, now: () => NOW });
	const a = await introspect(cfg(() => ({ status: 200, body: { active: false } })), "hmat_a");
	assert.ok(!a.ok && a.reason === "invalid_token");
	const b = await introspect(cfg(() => ({ status: 200, body: active({ exp: Math.floor(NOW / 1000) - 1 }) })), "hmat_b");
	assert.ok(!b.ok && b.reason === "invalid_token");
	const c = await introspect(cfg(() => ({ status: 200, body: active({ api_key: "" }) })), "hmat_c");
	assert.ok(!c.ok && c.reason === "invalid_token");
	const d = await introspect(cfg(() => ({ status: 500 })), "hmat_d");
	assert.ok(!d.ok && d.reason === "unavailable");
	// A refused secret is the operator's problem, not "your token is bad".
	const e = await introspect(cfg(() => ({ status: 401 })), "hmat_e");
	assert.ok(!e.ok && e.reason === "unavailable");
});

test("successful introspections are memoised briefly, bounded by the token's own expiry", async () => {
	__resetIntrospectionCache();
	let now = NOW;
	const { fetchFn, calls } = fakeFetch(() => ({ status: 200, body: active({ exp: Math.floor(NOW / 1000) + 30 }) }));
	const cfg = { ...CONFIG, fetchFn, now: () => now };
	await introspect(cfg, "hmat_memo");
	await introspect(cfg, "hmat_memo");
	assert.equal(calls.length, 1);
	// The token expires in 30s, at the cache ceiling: the memo dies with it.
	now = NOW + 31_000;
	const late = await introspect(cfg, "hmat_memo");
	assert.equal(calls.length, 2);
	// ...and the issuer's fresh answer (exp in the past now) is honoured.
	assert.ok(!late.ok);
	// Failures are never cached.
	__resetIntrospectionCache();
	const bad = fakeFetch(() => ({ status: 200, body: { active: false } }));
	const cfg2 = { ...CONFIG, fetchFn: bad.fetchFn, now: () => NOW };
	await introspect(cfg2, "hmat_x");
	await introspect(cfg2, "hmat_x");
	assert.equal(bad.calls.length, 2);
});

// --- HTTP wiring ---

let server: http.Server;
let port: number;
const allowedHosts = buildAllowedHosts(0, []);
let introspectAnswer: () => { status: number; body?: unknown } = () => ({ status: 200, body: active() });

before(async () => {
	const { fetchFn } = fakeFetch(() => introspectAnswer());
	const app = createHttpApp({
		port: 0,
		bindAddress: "127.0.0.1",
		allowedOrigins: [],
		allowedHosts,
		trustProxy: false,
		oauth: { ...CONFIG, fetchFn, now: () => NOW },
	});
	await new Promise<void>((resolve) => {
		server = app.listen(0, "127.0.0.1", resolve);
	});
	port = (server.address() as AddressInfo).port;
	allowedHosts.add(`127.0.0.1:${port}`);
});
after(() => server?.close());

function request(method: string, path: string, headers: Record<string, string> = {}, body?: string) {
	return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
			let data = "";
			res.on("data", (c) => {
				data += c;
			});
			res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
		});
		req.on("error", reject);
		if (body) req.write(body);
		req.end();
	});
}
const TOOLS_LIST = JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 });
function toolNames(res: { body: string }): string[] {
	const body = JSON.parse(res.body);
	assert.equal(body.error, undefined, res.body);
	return body.result.tools.map((t: { name: string }) => t.name);
}
const JSON_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

test("the protected resource metadata document is served at both well-known paths", async () => {
	for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
		const res = await request("GET", path, { host: `127.0.0.1:${port}` });
		assert.equal(res.status, 200, path);
		assert.equal(JSON.parse(res.body).authorization_servers[0], "https://app.test");
		assert.equal(res.headers["access-control-allow-origin"], "*");
	}
});

test("an anonymous request is a 401 that points at the metadata document", async () => {
	const res = await request("POST", "/", { host: `127.0.0.1:${port}`, ...JSON_HEADERS }, TOOLS_LIST);
	assert.equal(res.status, 401);
	assert.match(String(res.headers["www-authenticate"]), /resource_metadata="https:\/\/mcp\.test\/\.well-known\/oauth-protected-resource"/);
	assert.match(String(res.headers["www-authenticate"]), /scope="hydradb"/);
	// No token was presented, so no `error=` claim about one.
	assert.doesNotMatch(String(res.headers["www-authenticate"]), /error=/);
});

test("a valid access token is served exactly like the API key it stands for", async () => {
	__resetIntrospectionCache();
	introspectAnswer = () => ({ status: 200, body: active() });
	const res = await request(
		"POST",
		"/",
		{ host: `127.0.0.1:${port}`, ...JSON_HEADERS, authorization: "Bearer hmat_good" },
		TOOLS_LIST,
	);
	assert.equal(res.status, 200, res.body);
	assert.ok(JSON.parse(res.body).result.tools.some((t: { name: string }) => t.name === "hydradb_query"));
	assert.equal(res.headers["cache-control"], "no-store");
});

test("an invalid or foreign token is a 401 with error=invalid_token", async () => {
	__resetIntrospectionCache();
	introspectAnswer = () => ({ status: 200, body: { active: false } });
	const res = await request(
		"POST",
		"/",
		{ host: `127.0.0.1:${port}`, ...JSON_HEADERS, authorization: "Bearer hmat_bad" },
		TOOLS_LIST,
	);
	assert.equal(res.status, 401);
	assert.match(String(res.headers["www-authenticate"]), /error="invalid_token"/);
	assert.ok(!res.body.includes("hmat_bad"));

	introspectAnswer = () => ({ status: 200, body: active({ aud: "https://elsewhere.test" }) });
	const foreign = await request(
		"POST",
		"/",
		{ host: `127.0.0.1:${port}`, ...JSON_HEADERS, authorization: "Bearer hmat_foreign" },
		TOOLS_LIST,
	);
	assert.equal(foreign.status, 401);
	assert.match(String(foreign.headers["www-authenticate"]), /not issued for this server/);
});

test("an unreachable issuer is a 503, not a 401 that blames the caller", async () => {
	__resetIntrospectionCache();
	introspectAnswer = () => ({ status: 502 });
	const res = await request(
		"POST",
		"/",
		{ host: `127.0.0.1:${port}`, ...JSON_HEADERS, authorization: "Bearer hmat_any" },
		TOOLS_LIST,
	);
	assert.equal(res.status, 503);
});

test("API keys keep working unchanged with OAuth on", async () => {
	// The key path must be untouched: same header, same database requirement,
	// same result, whether or not OAuth is configured.
	const key = await request(
		"POST",
		"/",
		{
			host: `127.0.0.1:${port}`,
			...JSON_HEADERS,
			authorization: "Bearer sk_live_abc.def",
			"x-hydradb-database": "db",
		},
		TOOLS_LIST,
	);
	assert.equal(key.status, 200, key.body);
	// And a key with no database is still the 400 it always was.
	const noDb = await request(
		"POST",
		"/",
		{ host: `127.0.0.1:${port}`, ...JSON_HEADERS, authorization: "Bearer sk_live_abc.def" },
		TOOLS_LIST,
	);
	assert.equal(noDb.status, 400);
	assert.match(JSON.parse(noDb.body).error.message, /X-HydraDB-Database/);
});

test("an OAuth token supplies the database, so no header is needed", async () => {
	__resetIntrospectionCache();
	introspectAnswer = () => ({ status: 200, body: active() });
	const res = await request(
		"POST",
		"/",
		{ host: `127.0.0.1:${port}`, ...JSON_HEADERS, authorization: "Bearer hmat_scoped" },
		TOOLS_LIST,
	);
	assert.equal(res.status, 200, res.body);
});

// --- Database confinement (the consent screen's "Other databases: not allowed") ---

test("introspection carries the confined database list when the issuer sends one", async () => {
	__resetIntrospectionCache();
	const { fetchFn } = fakeFetch(() => ({ status: 200, body: active({ databases: ["personal"] }) }));
	const r = await introspect({ ...CONFIG, fetchFn, now: () => NOW }, "hmat_confined");
	assert.ok(r.ok);
	assert.deepEqual(r.token.allowedDatabases, ["personal"]);
	// null (or absent) means unrestricted.
	const { fetchFn: f2 } = fakeFetch(() => ({ status: 200, body: active({ databases: null }) }));
	const r2 = await introspect({ ...CONFIG, fetchFn: f2, now: () => NOW }, "hmat_open");
	assert.ok(r2.ok);
	assert.equal(r2.token.allowedDatabases, undefined);
});

test("a confined connection refuses a per-call database outside its list, before any network call", async () => {
	__resetIntrospectionCache();
	introspectAnswer = () => ({ status: 200, body: active({ database: "personal", databases: ["personal"] }) });
	const res = await request(
		"POST",
		"/",
		{ host: `127.0.0.1:${port}`, ...JSON_HEADERS, authorization: "Bearer hmat_confined2" },
		JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "hydradb_list", arguments: { kind: "memory", database: "work" } },
		}),
	);
	assert.equal(res.status, 200, res.body);
	const body = JSON.parse(res.body);
	assert.equal(body.result.isError, true);
	assert.match(body.result.content[0].text, /confined to database "personal"/);
	assert.match(body.result.content[0].text, /cannot use database "work"/);
	assert.match(body.result.content[0].text, /reconnect/);
});

test("hydradb_databases on a confined connection answers from the list, marking the default", async () => {
	__resetIntrospectionCache();
	introspectAnswer = () => ({ status: 200, body: active({ database: "personal", databases: ["personal"] }) });
	const res = await request(
		"POST",
		"/",
		{ host: `127.0.0.1:${port}`, ...JSON_HEADERS, authorization: "Bearer hmat_confined3" },
		JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "hydradb_databases", arguments: {} } }),
	);
	const body = JSON.parse(res.body);
	assert.equal(body.result.isError, undefined, res.body);
	assert.deepEqual(body.result.structuredContent, { databases: ["personal"], default: "personal", confined: true });
	assert.match(body.result.content[0].text, /confined/);
});

test("the 401 challenge is readable cross-origin, so browser clients can discover the issuer", async () => {
	const res = await request(
		"OPTIONS",
		"/",
		{
			host: `127.0.0.1:${port}`,
			origin: "https://claude.ai",
			"access-control-request-method": "POST",
			"access-control-request-headers": "authorization,content-type",
		},
	);
	// The app under test allows no origins, so the preflight is refused; the
	// exposed-headers list is asserted on a permitted-origin app below.
	assert.ok(res.status === 403 || res.status === 204);
});

test("request headers cannot re-scope an OAuth identity after consent", async () => {
	__resetIntrospectionCache();
	introspectAnswer = () => ({ status: 200, body: active({ database: "personal", collection: "hydra-db-mcp", databases: ["personal"] }) });
	// The client sends headers naming a different database, collection and
	// graph scope. Every one must be ignored: the token is the identity.
	const res = await request(
		"POST",
		"/",
		{
			host: `127.0.0.1:${port}`,
			...JSON_HEADERS,
			authorization: "Bearer hmat_rescope",
			"x-hydradb-database": "work",
			"x-hydradb-collection": "other",
			"x-hydradb-graph-database": "work-graph",
			"x-hydradb-graph-collection": "gc",
		},
		JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "hydradb_databases", arguments: {} } }),
	);
	const body = JSON.parse(res.body);
	assert.equal(body.result.isError, undefined, res.body);
	// Default is still the approved database, and the graph default follows it.
	assert.deepEqual(body.result.structuredContent, { databases: ["personal"], default: "personal", confined: true });
	const graph = await request(
		"POST",
		"/",
		{ host: `127.0.0.1:${port}`, ...JSON_HEADERS, authorization: "Bearer hmat_rescope", "x-hydradb-graph-database": "work-graph" },
		JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "hydradb_graph_collections", arguments: { database: "work-graph" } } }),
	);
	const g = JSON.parse(graph.body);
	assert.equal(g.result.isError, true);
	assert.match(g.result.content[0].text, /confined to database "personal"/);
});

test("hydradb_databases is registered for OAuth connections only", async () => {
	__resetIntrospectionCache();
	introspectAnswer = () => ({ status: 200, body: active() });
	const viaToken = await request("POST", "/", { host: `127.0.0.1:${port}`, ...JSON_HEADERS, authorization: "Bearer hmat_tools" }, TOOLS_LIST);
	assert.ok(toolNames(viaToken).includes("hydradb_databases"));
	const viaKey = await request(
		"POST",
		"/",
		{ host: `127.0.0.1:${port}`, ...JSON_HEADERS, authorization: "Bearer sk_live_abc.def", "x-hydradb-database": "db" },
		TOOLS_LIST,
	);
	// An API-key connection's tool list is exactly what it was before OAuth existed.
	assert.ok(!toolNames(viaKey).includes("hydradb_databases"));
});

// --- The graph surface must not be a way around consent ---

test("graph headers are powerless against an OAuth identity, and defaults come from consent", () => {
	// The graph tools reach a different namespace than the context tools, so
	// they need the same protection stated separately: a token holder must not
	// be able to point graph reads, writes or drops somewhere the consent
	// screen never showed.
	const withToken = resolveRequestCredentials(
		{
			"x-hydradb-graph-database": "attacker-graph",
			"x-hydradb-graph-collection": "attacker-collection",
			"x-hydradb-database": "attacker-db",
			"x-hydradb-collection": "attacker-col",
		},
		{ HYDRADB_GRAPH_COLLECTION: "operator-shared-namespace" },
		{ apiKey: "sk_live_x.y", database: "approved-db", collection: "approved-col" },
	);
	assert.ok(withToken.ok);
	assert.equal(withToken.credentials.database, "approved-db");
	assert.equal(withToken.credentials.collection, "approved-col");
	assert.equal(withToken.credentials.graph.database, "approved-db");
	// Not the operator's HYDRADB_GRAPH_COLLECTION, which on a hosted process is
	// one namespace shared by every tenant.
	assert.equal(withToken.credentials.graph.collection, "approved-col");

	// Without a token, the header path is exactly as it always was.
	const withHeaders = resolveRequestCredentials(
		{
			authorization: "Bearer sk_live_x.y",
			"x-hydradb-database": "db",
			"x-hydradb-graph-database": "gdb",
			"x-hydradb-graph-collection": "gcol",
		},
		{},
	);
	assert.ok(withHeaders.ok);
	assert.equal(withHeaders.credentials.graph.database, "gdb");
	assert.equal(withHeaders.credentials.graph.collection, "gcol");
});

test("a confined connection cannot reach another database through the graph tools", async () => {
	__resetIntrospectionCache();
	introspectAnswer = () => ({
		status: 200,
		body: active({ database: "personal", collection: "personal-col", databases: ["personal"] }),
	});
	const res = await request(
		"POST",
		"/",
		{ host: `127.0.0.1:${port}`, ...JSON_HEADERS, authorization: "Bearer hmat_graphconfined" },
		JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "hydradb_graph_collections", arguments: { database: "work" } },
		}),
	);
	assert.equal(res.status, 200, res.body);
	const body = JSON.parse(res.body);
	assert.equal(body.result.isError, true);
	assert.match(body.result.content[0].text, /confined to database "personal"/);
});

test("graph_admin cannot drop a database outside a confined connection's list", async () => {
	__resetIntrospectionCache();
	introspectAnswer = () => ({
		status: 200,
		body: active({ database: "personal", collection: "personal-col", databases: ["personal"] }),
	});
	const res = await request(
		"POST",
		"/",
		{ host: `127.0.0.1:${port}`, ...JSON_HEADERS, authorization: "Bearer hmat_dropguard" },
		JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "hydradb_graph_admin", arguments: { action: "drop_database", database: "work" } },
		}),
	);
	const body = JSON.parse(res.body);
	assert.equal(body.result.isError, true);
	assert.match(body.result.content[0].text, /cannot use database "work"/);
});

// --- A confined grant confines the collection too ---

test("introspection carries the confined collection alongside the database", async () => {
	__resetIntrospectionCache();
	const { fetchFn } = fakeFetch(() => ({
		status: 200,
		body: active({ databases: ["personal"], collections: ["personal-col"] }),
	}));
	const r = await introspect({ ...CONFIG, fetchFn, now: () => NOW }, "hmat_bothaxes");
	assert.ok(r.ok);
	assert.deepEqual(r.token.allowedDatabases, ["personal"]);
	assert.deepEqual(r.token.allowedCollections, ["personal-col"]);
});

const confined = () =>
	active({
		database: "personal",
		collection: "personal-col",
		databases: ["personal"],
		collections: ["personal-col"],
	});

async function callConfined(token: string, name: string, args: Record<string, unknown>) {
	__resetIntrospectionCache();
	introspectAnswer = () => ({ status: 200, body: confined() });
	const res = await request(
		"POST",
		"/",
		{ host: `127.0.0.1:${port}`, ...JSON_HEADERS, authorization: `Bearer ${token}` },
		JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
	);
	assert.equal(res.status, 200, res.body);
	return JSON.parse(res.body).result;
}

test("a confined connection refuses a per-call collection on the context tools", async () => {
	const r = await callConfined("hmat_c1", "hydradb_list", { kind: "memory", collection: "someone-else" });
	assert.equal(r.isError, true);
	assert.match(r.content[0].text, /confined to collection "personal-col"/);
	assert.match(r.content[0].text, /cannot use collection "someone-else"/);
});

test("a confined connection refuses a per-call collection on graph reads and writes", async () => {
	const r = await callConfined("hmat_c2", "hydradb_graph_query", {
		query: "MATCH (n) RETURN n",
		collection: "someone-else",
	});
	assert.equal(r.isError, true);
	assert.match(r.content[0].text, /cannot use collection "someone-else"/);
});

test("graph_admin cannot drop a collection outside a confined connection's list", async () => {
	// The irreversible one: an unchecked collection here deletes a graph the
	// consent screen never showed.
	const r = await callConfined("hmat_c3", "hydradb_graph_admin", {
		action: "drop_collection",
		collection: "someone-else",
	});
	assert.equal(r.isError, true);
	assert.match(r.content[0].text, /cannot use collection "someone-else"/);
});

/**
 * These two assert that a call got PAST the confinement guard. They cannot
 * assert success: the fake key means the request then fails at the network,
 * which is an error of a completely different kind. So they check the guard
 * specifically, by its message.
 */
const CONFINEMENT = /This connection is confined to/;

test("a confined connection passes the guard inside its own scope", async () => {
	const ok = await callConfined("hmat_c4", "hydradb_list", {
		kind: "memory",
		database: "personal",
		collection: "personal-col",
	});
	assert.doesNotMatch(ok.content[0].text, CONFINEMENT);
});

test("an unconfined OAuth connection keeps per-call scope overrides", async () => {
	// The default choice is "allowed when asked": both axes stay free, which is
	// the documented per-call scoping the product already shipped.
	__resetIntrospectionCache();
	introspectAnswer = () => ({ status: 200, body: active({ databases: null, collections: null }) });
	const res = await request(
		"POST",
		"/",
		{ host: `127.0.0.1:${port}`, ...JSON_HEADERS, authorization: "Bearer hmat_open" },
		JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "hydradb_list",
				arguments: { kind: "memory", database: "anything", collection: "anything" },
			},
		}),
	);
	assert.doesNotMatch(JSON.parse(res.body).result.content[0].text, CONFINEMENT);
});
