/**
 * Cancellation and the whole-call deadline on the hosted transport, over real
 * HTTP: the MCP app on one port, a stand-in Hydra DB API on another.
 *
 * The hosted server builds a fresh MCP server per HTTP request, so the
 * `notifications/cancelled` POST arrives at an instance that is not running
 * the call. These tests prove the cancel still stops the upstream request.
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import { createHttpApp } from "../src/http.js";
import { buildAllowedHosts } from "../src/http-config.js";

interface Upstream {
	/** Resolves when the next upstream request arrives; its promise resolves when that request's socket closes. */
	nextRequest(): Promise<{ closed: Promise<void> }>;
	count(): number;
}

let mcp: http.Server;

let api: http.Server;

let mcpPort: number;

let upstream: Upstream;

const savedEnv = { ...process.env };

before(async () => {
	const waiting: ((value: { closed: Promise<void> }) => void)[] = [];
	let seen = 0;

	// Never answers: every request hangs until its client goes away.
	api = http.createServer((req, res) => {
		seen++;
		const closed = new Promise<void>((resolve) => res.on("close", () => resolve()));
		req.resume();
		waiting.shift()?.({ closed });
	});
	await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
	upstream = {
		nextRequest: () => new Promise((resolve) => waiting.push(resolve)),
		count: () => seen,
	};

	// SAFETY: the stand-in listens on a TCP port, so address() is an AddressInfo.
	process.env.HYDRADB_BASE_URL = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
	delete process.env.HYDRADB_API_KEY;
	delete process.env.HYDRADB_DATABASE;

	const hosts = buildAllowedHosts(0, []);

	const app = createHttpApp({
		port: 0,
		bindAddress: "127.0.0.1",
		allowedOrigins: [],
		allowedHosts: hosts,
		trustProxy: false,
	});

	await new Promise<void>((resolve) => {
		mcp = app.listen(0, "127.0.0.1", resolve);
	});
	// SAFETY: the server listens on a TCP port, so address() is an AddressInfo.
	mcpPort = (mcp.address() as AddressInfo).port;
	hosts.add(`127.0.0.1:${mcpPort}`);
});

after(() => {
	process.env = savedEnv;
	mcp?.close();
	api?.closeAllConnections();
	api?.close();
});

type JsonRpcMessage = { jsonrpc: "2.0"; id?: number; method: string; params: object };

function post(body: JsonRpcMessage, key = "sk_test_caller.secretpart"): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				host: "127.0.0.1",
				port: mcpPort,
				method: "POST",
				path: "/mcp",
				headers: {
					Authorization: `Bearer ${key}`,
					"X-HydraDB-Database": "db_test",
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
				},
			},
			(res) => {
				let data = "";
				res.on("data", (chunk) => {
					data += chunk;
				});
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
			},
		);

		req.on("error", reject);
		req.end(JSON.stringify(body));
	});
}

function callQuery(id: number) {
	return post({
		jsonrpc: "2.0",
		id,
		method: "tools/call",
		params: { name: "hydradb_query", arguments: { query: "owner" } },
	});
}

function cancel(requestId: number, key?: string) {
	return post({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId, reason: "user stopped" } }, key);
}

function within<T>(ms: number, promise: Promise<T>, what: string): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`${what} did not happen within ${ms}ms`)), ms)),
	]);
}

test("a cancel sent as its own HTTP request stops the running call and its upstream request", async () => {
	const arrived = upstream.nextRequest();
	const call = callQuery(7);
	const { closed } = await within(3000, arrived, "the upstream request");

	const ack = await cancel(7);
	assert.equal(ack.status, 202, "the notification is acknowledged as usual");

	await within(1000, closed, "the upstream request closing");
	const res = await within(1000, call, "the tool call answering");
	assert.equal(res.status, 200);
	assert.match(res.body, /cancelled by the caller/);
	assert.match(res.body, /"isError":true/);
});

test("a cancel from another credential does not touch the call", async () => {
	process.env.HYDRADB_TIMEOUT_SECONDS = "2";

	try {
		const arrived = upstream.nextRequest();
		const call = callQuery(8);
		const { closed } = await within(3000, arrived, "the upstream request");

		await cancel(8, "sk_test_someoneelse.otherpart");
		let closedEarly = false;
		void closed.then(() => {
			closedEarly = true;
		});
		await new Promise((r) => setTimeout(r, 300));
		assert.equal(closedEarly, false, "another caller's cancel must not stop this call");

		// It still ends, on its own deadline.
		const res = await within(3000, call, "the deadline");
		assert.match(res.body, /no answer within the 2s deadline for the whole call/);
	} finally {
		delete process.env.HYDRADB_TIMEOUT_SECONDS;
	}
});

test("a cancel with the same key id but a different secret does not touch the call", async () => {
	process.env.HYDRADB_TIMEOUT_SECONDS = "1";

	try {
		const arrived = upstream.nextRequest();
		const call = callQuery(9);
		const { closed } = await within(3000, arrived, "the upstream request");

		// The public half of a key is not a secret; it must not be enough.
		await cancel(9, "sk_test_caller.guessed");
		let closedEarly = false;
		void closed.then(() => {
			closedEarly = true;
		});
		await new Promise((r) => setTimeout(r, 300));
		assert.equal(closedEarly, false);
		await within(3000, call, "the deadline");
	} finally {
		delete process.env.HYDRADB_TIMEOUT_SECONDS;
	}
});

test("on hosted MCP one deadline ends a hanging call with a Hydra DB diagnostic", async () => {
	process.env.HYDRADB_TIMEOUT_SECONDS = "1";

	try {
		const before = upstream.count();
		const started = Date.now();
		const res = await within(3000, callQuery(10), "the deadline");
		const elapsed = Date.now() - started;
		assert.ok(elapsed >= 900 && elapsed < 1800, `took ${elapsed}ms against a 1s deadline`);
		assert.match(res.body, /Hydra DB \/query → ERR: no answer within the 1s deadline for the whole call/);
		assert.equal(upstream.count() - before, 1, "a hung read is not retried past the deadline");
	} finally {
		delete process.env.HYDRADB_TIMEOUT_SECONDS;
	}
});
