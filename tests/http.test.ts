import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import { createHttpApp } from "../src/http.js";
import { buildAllowedHosts } from "../src/http-config.js";

/**
 * The app under test binds an ephemeral port. Every case here exercises a path
 * that returns BEFORE a HydraDB client is built — Host/Origin/auth gating and
 * the health probe — so nothing reaches the network. The one thing a valid
 * `/mcp` call would do next (construct a HydraDB and talk to it) is covered by
 * the unit tests around credential resolution instead.
 */
let server: http.Server;
let port: number;

// The ephemeral port is not known until the socket binds, so the Host allowlist
// is built empty-of-port and the real loopback authority is added afterwards.
// The middleware holds the same Set by reference, so the late add takes effect.
const allowedHosts = buildAllowedHosts(0, ["mcp.hydradb.com"]);

before(async () => {
	const app = createHttpApp({
		port: 0,
		bindAddress: "127.0.0.1",
		allowedOrigins: ["https://app.hydradb.com"],
		allowedHosts,
		trustProxy: false,
	});
	await new Promise<void>((resolve) => {
		server = app.listen(0, "127.0.0.1", resolve);
	});
	port = (server.address() as AddressInfo).port;
	allowedHosts.add(`127.0.0.1:${port}`);
});

after(() => {
	server?.close();
});

interface Res {
	status: number;
	headers: http.IncomingHttpHeaders;
	body: string;
}

/** A raw request, so `Host` and `Origin` can be set (fetch forbids `Host`). */
function request(
	method: string,
	path: string,
	headers: Record<string, string> = {},
	body?: string,
): Promise<Res> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ host: "127.0.0.1", port, method, path, headers },
			(res) => {
				let data = "";
				res.on("data", (chunk) => {
					data += chunk;
				});
				res.on("end", () =>
					resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }),
				);
			},
		);
		req.on("error", reject);
		if (body) req.write(body);
		req.end();
	});
}

test("GET /health returns ok on an allowed host", async () => {
	const res = await request("GET", "/health", { host: `127.0.0.1:${port}` });
	assert.equal(res.status, 200);
	assert.deepEqual(JSON.parse(res.body), { status: "ok", service: "hydradb-mcp" });
});

test("a disallowed Host header is refused with 421", async () => {
	const res = await request("GET", "/health", { host: "evil.example.com" });
	assert.equal(res.status, 421);
	assert.equal(JSON.parse(res.body).error.message, "Misdirected request");
});

test("the configured public host is accepted", async () => {
	const res = await request("GET", "/health", { host: "mcp.hydradb.com" });
	assert.equal(res.status, 200);
});

test("POST / without credentials is 401 with a WWW-Authenticate header", async () => {
	const res = await request(
		"POST",
		"/",
		{ host: `127.0.0.1:${port}`, "content-type": "application/json" },
		JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
	);
	assert.equal(res.status, 401);
	assert.match(String(res.headers["www-authenticate"]), /Bearer/);
	assert.match(JSON.parse(res.body).error.message, /Authorization/);
});

test("POST /mcp without credentials is 401 with a WWW-Authenticate header", async () => {
	const res = await request(
		"POST",
		"/mcp",
		{ host: `127.0.0.1:${port}`, "content-type": "application/json" },
		JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
	);
	assert.equal(res.status, 401);
	assert.match(String(res.headers["www-authenticate"]), /Bearer/);
	assert.match(JSON.parse(res.body).error.message, /Authorization/);
});

test("POST / authenticated but with no database is 400", async () => {
	const res = await request(
		"POST",
		"/",
		{
			host: `127.0.0.1:${port}`,
			"content-type": "application/json",
			authorization: "Bearer some-key",
		},
		JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
	);
	assert.equal(res.status, 400);
	assert.match(JSON.parse(res.body).error.message, /X-HydraDB-Database/);
});

test("POST /mcp authenticated but with no database is 400", async () => {
	const res = await request(
		"POST",
		"/mcp",
		{
			host: `127.0.0.1:${port}`,
			"content-type": "application/json",
			authorization: "Bearer some-key",
		},
		JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
	);
	assert.equal(res.status, 400);
	assert.match(JSON.parse(res.body).error.message, /X-HydraDB-Database/);
});

test("a malformed JSON body is refused with a JSON-RPC 400, not HTML", async () => {
	const res = await request(
		"POST",
		"/mcp",
		{
			host: `127.0.0.1:${port}`,
			"content-type": "application/json",
			authorization: "Bearer k",
			"x-hydradb-database": "db",
		},
		"{not valid json",
	);
	assert.equal(res.status, 400);
	const body = JSON.parse(res.body);
	assert.equal(body.jsonrpc, "2.0");
	assert.match(body.error.message, /not valid JSON/);
});

test("a disallowed CORS origin is refused with 403", async () => {
	const res = await request("GET", "/health", {
		host: `127.0.0.1:${port}`,
		origin: "https://evil.example.com",
	});
	assert.equal(res.status, 403);
	assert.equal(JSON.parse(res.body).error.message, "Origin not allowed");
});

test("an allowed CORS origin passes and is echoed back", async () => {
	const res = await request("GET", "/health", {
		host: `127.0.0.1:${port}`,
		origin: "https://app.hydradb.com",
	});
	assert.equal(res.status, 200);
	assert.equal(res.headers["access-control-allow-origin"], "https://app.hydradb.com");
});

test("a CORS preflight (OPTIONS) for an allowed origin succeeds", async () => {
	const res = await request("OPTIONS", "/mcp", {
		host: `127.0.0.1:${port}`,
		origin: "https://app.hydradb.com",
		"access-control-request-method": "POST",
		"access-control-request-headers": "authorization,x-hydradb-database",
	});
	// cors answers a preflight with 204 and the allow headers.
	assert.ok(res.status === 204 || res.status === 200);
	assert.equal(res.headers["access-control-allow-origin"], "https://app.hydradb.com");
	assert.match(
		String(res.headers["access-control-allow-headers"]).toLowerCase(),
		/x-hydradb-database/,
	);
});

test("hosted OAuth calls reach the API tagged with the signed-in user, never the key secret", async (t) => {
	const now = 1_800_000_000_000;

	const introspection: typeof fetch = async () =>
		new Response(
			JSON.stringify({
				active: true,
				sub: "user-1",
				client_id: "hmc_claude",
				aud: "https://mcp.test",
				exp: Math.floor(now / 1000) + 3600,
				database: "personal",
				api_key: "hk_live_abc.SECRET",
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);

	const upstream: Headers[] = [];

	t.mock.method(globalThis, "fetch", async (input: Request | string | URL, init?: RequestInit) => {
		const headers = new Headers(input instanceof Request ? input.headers : undefined);

		for (const [k, v] of new Headers(init?.headers)) headers.set(k, v);

		upstream.push(headers);

		return new Response(JSON.stringify({ success: true, data: { chunks: [] }, meta: {} }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	});

	const hosts = buildAllowedHosts(0, ["mcp.test"]);

	const app = createHttpApp({
		port: 0,
		bindAddress: "127.0.0.1",
		allowedOrigins: [],
		allowedHosts: hosts,
		trustProxy: false,
		oauth: {
			issuer: "https://app.test",
			resource: "https://mcp.test",
			introspectionSecret: "s3cret",
			fetchFn: introspection,
			now: () => now,
		},
	});

	const srv = await new Promise<http.Server>((resolve) => {
		const s = app.listen(0, "127.0.0.1", () => resolve(s));
	});

	t.after(() => srv.close());

	// SAFETY: the server listens on a TCP port, so address() is an AddressInfo.
	const oauthPort = (srv.address() as AddressInfo).port;

	hosts.add(`127.0.0.1:${oauthPort}`);

	const res = await new Promise<Res>((resolve, reject) => {
		const body = JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "hydradb_query", arguments: { query: "owner" } },
		});

		const req = http.request(
			{
				host: "127.0.0.1",
				port: oauthPort,
				method: "POST",
				path: "/mcp",
				headers: {
					Authorization: "Bearer hmat_token",
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
				},
			},
			(r) => {
				let data = "";
				r.on("data", (c) => {
					data += c;
				});
				r.on("end", () => resolve({ status: r.statusCode ?? 0, headers: r.headers, body: data }));
			},
		);

		req.on("error", reject);
		req.end(body);
	});

	assert.equal(res.status, 200, res.body);
	assert.ok(upstream.length > 0, "the tool call never reached the API");

	for (const h of upstream) {
		assert.equal(h.get("x-hydradb-mcp-user"), "mcp:oauth:user-1");
		assert.equal(h.get("x-hydradb-source"), "mcp");
		assert.ok(!h.get("x-hydradb-mcp-user")?.includes("SECRET"));
	}
});
