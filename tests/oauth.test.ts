import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import { createHttpApp } from "../src/http.js";
import { buildAllowedHosts } from "../src/http-config.js";
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

test("successful introspections are memoised for a minute, bounded by the token's own expiry", async () => {
	__resetIntrospectionCache();
	let now = NOW;
	const { fetchFn, calls } = fakeFetch(() => ({ status: 200, body: active({ exp: Math.floor(NOW / 1000) + 30 }) }));
	const cfg = { ...CONFIG, fetchFn, now: () => now };
	await introspect(cfg, "hmat_memo");
	await introspect(cfg, "hmat_memo");
	assert.equal(calls.length, 1);
	// The token expires in 30s, before the 60s cache ceiling: the memo dies with it.
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
			res.on("data", (c) => (data += c));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
		});
		req.on("error", reject);
		if (body) req.write(body);
		req.end();
	});
}
const TOOLS_LIST = JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 });
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

test("API keys and connection links keep working unchanged with OAuth on", async () => {
	const key = await request(
		"POST",
		"/",
		{ host: `127.0.0.1:${port}`, ...JSON_HEADERS, authorization: "Bearer sk_live_abc.def" },
		TOOLS_LIST,
	);
	assert.equal(key.status, 200, key.body);
	const link = await request("POST", "/c/sk_live_abc.def/db", { host: `127.0.0.1:${port}`, ...JSON_HEADERS }, TOOLS_LIST);
	assert.equal(link.status, 200, link.body);
});
