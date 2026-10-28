import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { HydraDBClient, HydraDBError } from "@hydradb/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { HydraDB, scrub, translateError } from "../src/hydra/index.js";
import { createHydraDBServer } from "../src/server.js";

// Shaped like the keys the dashboard issues: sk_<env>_<12-char id>.<32-char secret>.
const KEY_ID = "sk_live_x4K9aB2cD3eF";
const KEY_SECRET = "Zq8RtY2uI9oP3aS6dF1gH4jK7lM0nB5v";
const API_KEY = `${KEY_ID}.${KEY_SECRET}`;
const ACCESS_TOKEN = "hmat_9fJ2kL5mN8pQ1rS4tU7vW0xY3zA6bC";
const REFRESH_TOKEN = "hmrt_Gh7Jk2Lm5Np8Qr1St4Uv7Wx0Yz3Ab6C";

function assertGone(text: string, secret: string) {
	assert.ok(!text.includes(secret), `"${secret}" survived in: ${text}`);
}

test("a HydraDB API key is removed whole, secret half included", () => {
	for (const body of [
		`upstream rejected key ${API_KEY}`,
		`{"detail":"bad credential","echo":"${API_KEY}"}`,
		`GET /query?x=1 Authorization=${API_KEY}`,
	]) {
		const message = translateError("/query", new HydraDBError({ statusCode: 401, body })).message;
		assertGone(message, KEY_SECRET);
		assertGone(message, KEY_ID);
		assert.match(message, /redacted/);
	}
});

test("a key with a short id still loses its secret", () => {
	// The old pattern needed 16+ characters before the dot; a short id slipped past it.
	const out = scrub("echo sk_test_ab.c2VjcmV0LXRoYXQtbXVzdC1nbw");
	assertGone(out, "c2VjcmV0LXRoYXQtbXVzdC1nbw");
});

test("OAuth access and refresh tokens are removed", () => {
	for (const token of [ACCESS_TOKEN, REFRESH_TOKEN]) {
		const message = translateError(
			"/query",
			new HydraDBError({ statusCode: 502, body: `proxy saw token ${token} and gave up` }),
		).message;
		assertGone(message, token);
		assert.match(message, /proxy saw token \[redacted\] and gave up/);
	}
});

test("credentials in a quoted query string are removed", () => {
	const out = scrub(
		"GET /v1/query?api_key=opaque123456&access_token=abc.def.ghi&client_secret=s3cr3t-value&page=2",
	);
	for (const secret of ["opaque123456", "abc.def.ghi", "s3cr3t-value"]) assertGone(out, secret);
	assert.match(out, /page=2/);
});

test("a network failure that quotes the request is scrubbed too", () => {
	const message = translateError(
		"/query",
		new Error(`connect ECONNREFUSED while sending Bearer ${ACCESS_TOKEN}`),
	).message;
	assertGone(message, ACCESS_TOKEN);
});

test("the caller's own credential is removed whatever its format", () => {
	const legacy = "legacy-opaque-credential-7c1e9";
	const out = scrub(`rejected ${legacy} for tenant`, [legacy]);
	assert.equal(out, "rejected [redacted] for tenant");
	// A body that echoes only the secret half of a key loses it as well.
	assertGone(scrub(`secret was ${KEY_SECRET}`, [API_KEY]), KEY_SECRET);
	// Too short to be a credential: blanking it would mangle ordinary words.
	assert.equal(scrub("the key k failed", ["k"]), "the key k failed");
});

async function connect(t: TestContext, token: string, respond: () => Response | Promise<Response>) {
	const fetchFn: typeof fetch = async () => respond();
	const config = { token, database: "synthetic-db", collection: "docs", baseUrl: "https://offline.invalid", maxRetries: 0 };
	const sdk = new HydraDBClient({ token, baseUrl: config.baseUrl, fetch: fetchFn, maxRetries: 0, timeoutInSeconds: 1 });
	const server = createHydraDBServer(new HydraDB(config, sdk));
	const client = new Client({ name: "redaction-tests", version: "1" });
	const [ct, st] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(st), client.connect(ct)]);
	t.after(async () => {
		await client.close();
		await server.close();
	});
	return client;
}

function resultText(result: { content?: unknown }): string {
	return (result.content as { text?: string }[]).map((part) => part.text ?? "").join("\n");
}

test("a tool error never shows the model the caller's unrecognised credential", async (t) => {
	// No pattern knows this format; only knowing it is the caller's own removes it.
	const token = "acme-proxy-issued-0f3b9d27";
	const client = await connect(t, token, () =>
		new Response(`<html><title>401</title><body>gateway refused credential ${token}</body></html>`, {
			status: 401,
		}),
	);

	const result = await client.callTool({ name: "hydradb_query", arguments: { query: "anything" } });

	assert.equal(result.isError, true);
	assertGone(resultText(result), token);
	assert.match(resultText(result), /gateway refused credential \[redacted\]/);
});

test("a tool error on an OAuth connection never shows the access token", async (t) => {
	const client = await connect(t, ACCESS_TOKEN, () => {
		throw new Error(`socket closed mid-request (auth ${ACCESS_TOKEN})`);
	});

	const result = await client.callTool({ name: "hydradb_query", arguments: { query: "anything" } });

	assert.equal(result.isError, true);
	assertGone(resultText(result), ACCESS_TOKEN);
});
