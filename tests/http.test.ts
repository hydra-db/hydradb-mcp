import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import { createHttpApp, redactPath } from "../src/http.js";
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

/**
 * A `tools/list` is answered by the server itself, with no outbound call, so
 * it proves a URL shape reaches a working MCP server without needing a real
 * key. The database (when the URL names none) is resolved lazily, on the
 * first tool CALL, so listing tools never touches the network either.
 */
async function listTools(path: string, headers: Record<string, string> = {}) {
	return request(
		"POST",
		path,
		{
			host: `127.0.0.1:${port}`,
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...headers,
		},
		JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
	);
}

function toolNames(res: Res): string[] {
	const body = JSON.parse(res.body);
	assert.equal(body.error, undefined, res.body);
	return body.result.tools.map((t: { name: string }) => t.name);
}

test("POST / authenticated with no database is served (database resolved lazily)", async () => {
	// This was a 400 asking for X-HydraDB-Database, which clients that can send
	// only an Authorization header could never satisfy.
	const res = await listTools("/", { authorization: "Bearer some-key" });
	assert.equal(res.status, 200, res.body);
	assert.ok(toolNames(res).includes("hydradb_query"));
	assert.equal(res.headers["cache-control"], "no-store");
});

test("POST /mcp authenticated with no database is served", async () => {
	const res = await listTools("/mcp", { authorization: "Bearer some-key" });
	assert.equal(res.status, 200, res.body);
	assert.ok(toolNames(res).includes("hydradb_databases"));
});

// --- Connection links and path scope (1.3.0) ---

const LINK_KEY = "sk_live_abcDEF123.superSecretValue_-x";

test("a connection link /c/<key>/<db>/<col> is served with no headers", async () => {
	const res = await listTools(`/c/${LINK_KEY}/my-db/my-col`);
	assert.equal(res.status, 200, res.body);
	assert.ok(toolNames(res).includes("hydradb_query"));
	assert.equal(res.headers["cache-control"], "no-store");
});

test("a connection link with only a key, and the /mcp/c spelling, are served", async () => {
	for (const path of [`/c/${LINK_KEY}`, `/mcp/c/${LINK_KEY}`, `/mcp/c/${LINK_KEY}/my-db`]) {
		const res = await listTools(path);
		assert.equal(res.status, 200, `${path}: ${res.body}`);
	}
});

test("a header-authenticated request can be scoped by path", async () => {
	for (const path of ["/my-db", "/my-db/my-col", "/mcp/my-db", "/mcp/my-db/my-col"]) {
		const res = await listTools(path, { authorization: "Bearer some-key" });
		assert.equal(res.status, 200, `${path}: ${res.body}`);
	}
});

test("a path-scoped request with no key anywhere is still 401", async () => {
	const res = await listTools("/my-db");
	assert.equal(res.status, 401);
});

test("reserved and malformed path segments are a JSON 404 that echoes nothing", async () => {
	for (const path of [
		"/c",
		"/health/x",
		`/c/${LINK_KEY}/bad$name`,
		`/c/${LINK_KEY}/ok/bad%20name`,
		"/.well-known/oauth-protected-resource",
		"/c/short",
		"/-leading-hyphen",
	]) {
		const res = await listTools(path, { authorization: "Bearer some-key" });
		assert.equal(res.status, 404, path);
		const body = JSON.parse(res.body);
		assert.equal(body.error.message, "Not found");
		assert.ok(!res.body.includes(LINK_KEY), `key echoed for ${path}`);
		assert.ok(!res.body.includes("bad"), `path echoed for ${path}`);
	}
});

test("GET /health is not mistaken for a database name", async () => {
	const res = await request("GET", "/health", { host: `127.0.0.1:${port}` });
	assert.equal(res.status, 200);
	assert.deepEqual(JSON.parse(res.body), { status: "ok", service: "hydradb-mcp" });
});

test("redactPath hides the key in a connection link", () => {
	assert.equal(redactPath(`/c/${LINK_KEY}/my-db`), "/c/[redacted]/my-db");
	assert.equal(redactPath(`/mcp/c/${LINK_KEY}`), "/mcp/c/[redacted]");
	assert.equal(redactPath("/my-db/col"), "/my-db/col");
	assert.equal(redactPath("/"), "/");
});
