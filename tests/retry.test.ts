/**
 * The retry policy every HydraDB call runs under (src/hydra/retry.ts), through
 * the real SDK and the hand-rolled path, with `fetch` as the only fake.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { GraphResource, HydraDB, parseRetryAfter } from "../src/hydra/index.js";

type Reply = { status: number; headers?: Record<string, string>; body?: unknown } | "hang" | Error;

const OK_QUERY = { status: 200, body: { success: true, data: { chunks: [] } } };

/** Replace `fetch` with a scripted one; the last reply repeats. */
function scriptFetch(t: { mock: { method: typeof import("node:test").mock.method } }, replies: Reply[]) {
	const calls: { url: string; at: number }[] = [];
	t.mock.method(globalThis, "fetch", async (input: Request | string | URL, init?: RequestInit) => {
		calls.push({ url: String(input), at: Date.now() });
		const reply = replies[Math.min(calls.length - 1, replies.length - 1)] ?? OK_QUERY;

		if (reply instanceof Error) throw reply;

		if (reply === "hang") {
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
			});
		}

		return new Response(JSON.stringify(reply.body ?? { error: { code: "E", message: `status ${reply.status}` } }), {
			status: reply.status,
			headers: { "content-type": "application/json", ...reply.headers },
		});
	});

	return calls;
}


const OK_INGEST = { status: 200, body: { success: true, data: { success: 1, failed: 0, results: [] } } };

const OK_FEEDBACK = { status: 200, body: { success: true, data: { recorded: true } } };

function refused(): Error {
	return new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
}

function reset(): Error {
	return new TypeError("fetch failed", { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
}

test("Retry-After is read in both of its forms", () => {
	const now = Date.parse("2026-10-28T12:00:00Z");
	assert.equal(parseRetryAfter("3", now), 3000);
	assert.equal(parseRetryAfter("0", now), 0);
	assert.equal(parseRetryAfter("Wed, 28 Oct 2026 12:00:07 GMT", now), 7000);
	assert.equal(parseRetryAfter("Wed, 28 Oct 2026 11:59:00 GMT", now), 0, "a past date means now");
	assert.equal(parseRetryAfter("soon", now), undefined);
	assert.equal(parseRetryAfter(undefined, now), undefined);
});

// A write whose response was lost may have committed. Sending it again can
// apply it twice, so it is not retried, and the error says so.
test("an ingest is not retried after an unclear failure, and the error says the outcome is unknown", async (t) => {
	const failures: Reply[] = [{ status: 502 }, { status: 500 }, reset()];

	for (const failure of failures) {
		const calls = scriptFetch(t, [failure, OK_INGEST]);
		const hydra = new HydraDB({ token: "t", database: "db" });

		await assert.rejects(
			hydra.context.ingest({ kind: "memory", text: "note" }),
			/Outcome unknown: the request reached Hydra DB and may or may not have been applied/,
		);
		assert.equal(calls.length, 1, "one attempt only");
		t.mock.restoreAll();
	}
});

test("feedback and Cypher writes are not retried after a 5xx either", async (t) => {
	let calls = scriptFetch(t, [{ status: 503 }, OK_FEEDBACK]);
	const hydra = new HydraDB({ token: "t", database: "db" });
	await assert.rejects(hydra.feedback.submit({ requestId: "r1", feedback: "missing" }), /Outcome unknown/);
	assert.equal(calls.length, 1);
	t.mock.restoreAll();

	calls = scriptFetch(t, [{ status: 504 }, { status: 200, body: { success: true, data: [] } }]);
	const graph = new GraphResource({ token: "t" });
	await assert.rejects(graph.query({ database: "g", collection: "c", query: "CREATE (n)" }), /Outcome unknown/);
	assert.equal(calls.length, 1);
});

// 429 and a refused connection prove the server did not act on the request,
// so even a write is safe to send again.
test("a write is retried when the failure proves it was not applied", async (t) => {
	const failures: Reply[] = [{ status: 429, headers: { "retry-after": "0" } }, refused()];

	for (const failure of failures) {
		const calls = scriptFetch(t, [failure, OK_INGEST]);
		const hydra = new HydraDB({ token: "t", database: "db" });
		await hydra.context.ingest({ kind: "memory", text: "note" });
		assert.equal(calls.length, 2);
		t.mock.restoreAll();
	}
});

test("a read is retried after a 5xx", async (t) => {
	const calls = scriptFetch(t, [{ status: 503 }, OK_QUERY]);
	const hydra = new HydraDB({ token: "t", database: "db" });
	await hydra.context.query({ query: "q" });
	assert.equal(calls.length, 2);
});

test("Retry-After in seconds sets the wait, on the SDK and the hand-rolled path", async (t) => {
	const hydra = new HydraDB({ token: "t", database: "db" });

	const paths: [string, Reply, () => Promise<object>][] = [
		["SDK", OK_QUERY, () => hydra.context.query({ query: "q" })],
		["raw", OK_FEEDBACK, () => hydra.feedback.submit({ requestId: "r1", feedback: "missing" })],
	];

	for (const [name, ok, run] of paths) {
		const calls = scriptFetch(t, [{ status: 429, headers: { "retry-after": "1" } }, ok]);
		await run();
		assert.equal(calls.length, 2, name);
		const waited = (calls[1]?.at ?? 0) - (calls[0]?.at ?? 0);
		assert.ok(waited >= 950, `${name}: waited ${waited}ms, the server asked for 1000ms`);
		t.mock.restoreAll();
	}
});

test("Retry-After as an HTTP date sets the wait", async (t) => {
	// HTTP dates have whole-second resolution, so aim two seconds out.
	const at = new Date(Date.now() + 2000).toUTCString();
	const calls = scriptFetch(t, [{ status: 503, headers: { "retry-after": at } }, OK_QUERY]);
	const hydra = new HydraDB({ token: "t", database: "db" });
	await hydra.context.query({ query: "q" });
	const waited = (calls[1]?.at ?? 0) - (calls[0]?.at ?? 0);
	assert.ok(waited >= 900, `waited ${waited}ms for a date at least a second away`);
});

// Sleeping past the deadline only to time out would hide the server's answer.
test("a Retry-After past the deadline fails at once with the server's answer", async (t) => {
	const calls = scriptFetch(t, [{ status: 429, headers: { "retry-after": "30" } }, OK_QUERY]);
	const hydra = new HydraDB({ token: "t", database: "db", timeoutSeconds: 5 });
	const started = Date.now();
	await assert.rejects(
		hydra.context.query({ query: "q" }),
		/→ 429: .*Hydra DB asked to retry after 30s, past the 5s deadline for this call/,
	);
	assert.ok(Date.now() - started < 500, "no wait that could not finish");
	assert.equal(calls.length, 1);
});

test("a cancel during the wait between attempts starts no new attempt", async (t) => {
	const calls = scriptFetch(t, [{ status: 503, headers: { "retry-after": "2" } }, OK_QUERY]);
	const hydra = new HydraDB({ token: "t", database: "db" });
	const controller = new AbortController();
	const call = hydra.context.query({ query: "q" }, { signal: controller.signal });

	while (calls.length === 0) await new Promise((r) => setTimeout(r, 5));
	await new Promise((r) => setTimeout(r, 50));
	const cancelledAt = Date.now();
	controller.abort();

	await assert.rejects(call, /request cancelled by the caller/);
	assert.ok(Date.now() - cancelledAt < 200, "the wait ends with the cancel");
	await new Promise((r) => setTimeout(r, 2200));
	assert.equal(calls.length, 1, "nothing was sent after the cancel");
});

test("a cancelled call starts no attempt at all", async (t) => {
	const calls = scriptFetch(t, [OK_QUERY]);
	const hydra = new HydraDB({ token: "t", database: "db" });
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(hydra.context.query({ query: "q" }, { signal: controller.signal }), /cancelled/);
	assert.equal(calls.length, 0);
});

// The timeout used to apply per attempt: 3 attempts x 30s ran past a host's
// 60s, and the error described only the last attempt.
test("one deadline covers every attempt and wait, and the error describes the whole call", async (t) => {
	const calls = scriptFetch(t, [{ status: 503 }, { status: 503 }, "hang"]);
	const hydra = new HydraDB({ token: "t", database: "db", timeoutSeconds: 1.5, maxRetries: 5 });
	const started = Date.now();
	await assert.rejects(
		hydra.context.query({ query: "q" }),
		/\/query → ERR: no answer within the 1\.5s deadline for the whole call \(3 attempts over 1\.\ds: 503, 503, timed out\)/,
	);
	const elapsed = Date.now() - started;
	assert.ok(elapsed >= 1400 && elapsed < 1800, `the call took ${elapsed}ms against a 1.5s deadline`);
	assert.equal(calls.length, 3);
});

test("a write cut off by the deadline reports an unknown outcome", async (t) => {
	scriptFetch(t, ["hang"]);
	const hydra = new HydraDB({ token: "t", database: "db", timeoutSeconds: 0.3 });
	await assert.rejects(
		hydra.context.ingest({ kind: "memory", text: "note" }),
		/no answer within the 0\.3s deadline.*Outcome unknown/,
	);
});

test("a final 4xx is not retried and reads as before", async (t) => {
	const calls = scriptFetch(t, [{ status: 400, body: { error: { code: "INVALID_INPUT", message: "bad" } } }]);
	const hydra = new HydraDB({ token: "t", database: "db" });
	await assert.rejects(hydra.context.query({ query: "q" }), (err: Error) => {
		assert.equal(err.message, "Hydra DB /query → 400: INVALID_INPUT: bad");

		return true;
	});
	assert.equal(calls.length, 1);
});
