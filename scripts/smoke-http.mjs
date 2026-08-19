#!/usr/bin/env node
/**
 * Prove the built HTTP server actually runs before publishing or shipping it.
 *
 * The stdio smoke ({@link ./smoke-dist.mjs}) covers `dist/index.js`; this covers
 * `dist/http.js`, whose failure modes survive `tsc` just as readily — a bad
 * shebang, an unresolvable import in the emitted output, a listener that binds
 * but never answers, or auth/routing wired so nothing responds.
 *
 * It starts the built server on an ephemeral port, then asserts the three things
 * a hosted deployment depends on and that all resolve BEFORE any outbound Hydra
 * DB call, so no API key is needed:
 *   - GET /health answers;
 *   - POST /mcp with no credentials is refused (401);
 *   - POST /mcp with credential headers completes the MCP handshake and lists
 *     its tools (tools/list is answered locally by the server).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const ENTRY = "dist/http.js";
const PORT = 8137;
const BASE = `http://127.0.0.1:${PORT}`;
const TIMEOUT_MS = 15_000;

function fail(message) {
	console.error(`[smoke-http] FAIL: ${message}`);
	process.exit(1);
}

if (!existsSync(ENTRY)) fail(`${ENTRY} does not exist — was the build run?`);

const child = spawn("node", [ENTRY], {
	// Strip any tenant credentials from the child's environment. The
	// unauthenticated-`/mcp` check asserts a 401, which only holds when the
	// server has NO ambient account to fall back to — and this script is run by
	// hand and in CI where `HYDRADB_API_KEY` may well be exported. Node omits env
	// entries whose value is `undefined`, so this removes them for the child only.
	env: {
		...process.env,
		HYDRADB_API_KEY: undefined,
		HYDRA_DB_API_KEY: undefined,
		HYDRADB_DATABASE: undefined,
		HYDRA_DB_TENANT_ID: undefined,
		PORT: String(PORT),
		BIND_ADDRESS: "127.0.0.1",
	},
	stdio: ["ignore", "inherit", "inherit"],
});

const killer = setTimeout(() => {
	child.kill("SIGKILL");
	fail(`server did not pass its checks within ${TIMEOUT_MS}ms`);
}, TIMEOUT_MS);
killer.unref();

function stop(code) {
	clearTimeout(killer);
	child.kill("SIGTERM");
	process.exit(code);
}

/** Poll /health until the listener is up (or time runs out). */
async function waitForListening() {
	for (let i = 0; i < 50; i++) {
		try {
			const res = await fetch(`${BASE}/health`);
			if (res.ok) return await res.json();
		} catch {
			// Not up yet.
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	fail("server never became reachable on /health");
}

async function post(headers, body) {
	return fetch(`${BASE}/mcp`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

const MCP_HEADERS = {
	Accept: "application/json, text/event-stream",
	Authorization: "Bearer smoke-key",
	"X-HydraDB-Database": "smoke-db",
};

try {
	const health = await waitForListening();
	if (health?.status !== "ok") fail(`/health returned ${JSON.stringify(health)}`);

	// No credentials -> refused, not served against some ambient account.
	const anon = await post({}, { jsonrpc: "2.0", id: 1, method: "tools/list" });
	if (anon.status !== 401) fail(`unauthenticated /mcp returned ${anon.status}, expected 401`);

	// Handshake, then list tools — both answered without an outbound call.
	const init = await post(MCP_HEADERS, {
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "smoke-http", version: "0" },
		},
	});
	if (!init.ok) fail(`initialize returned HTTP ${init.status}`);

	const listRes = await post(MCP_HEADERS, {
		jsonrpc: "2.0",
		id: 2,
		method: "tools/list",
		params: {},
	});
	const parsed = await listRes.json();
	const tools = parsed?.result?.tools;
	if (!Array.isArray(tools) || tools.length === 0) {
		fail(`tools/list returned no tools: ${JSON.stringify(parsed).slice(0, 300)}`);
	}

	console.error(
		`[smoke-http] OK: ${ENTRY} listens on ${BASE}/mcp, refuses anonymous calls (401), ` +
			`and advertises ${tools.length} tool(s): ${tools.map((t) => t.name).join(", ")}`,
	);
	stop(0);
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
}
