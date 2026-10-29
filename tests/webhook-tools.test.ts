import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { HydraDBClient } from "@hydradb/sdk";

import { HydraDB } from "../src/hydra/index.js";
import { createHydraDBServer, webhookToolsEnabled } from "../src/server.js";
import { TOOL_NAMES, WEBHOOK_TOOL_NAMES } from "../src/tool-names.js";

// A generated secret the API returns exactly once. Long enough to pass the
// backend's floor, and distinctive so a redaction test can grep for it.
const SECRET = "whsec_test_abcdefabcdef0123456789";

type WebhookCall = { method: string; args?: Record<string, unknown> };

/**
 * A HydraDB whose webhooks resource records calls instead of making them.
 *
 * `webhooks` is replaced wholesale rather than mocked at the transport layer:
 * the point of these tests is which requests the tools DECIDE to make, and how
 * their output is shaped — the signing-secret redaction above all.
 */
function mockWebhooks() {
	const calls: WebhookCall[] = [];

	const webhooks = {
		register(args: {
			url: string;
			eventTypes?: string[];
			signingSecret?: string;
			generateSigningSecret?: boolean;
		}) {
			calls.push({ method: "register", args });
			const generated = args.generateSigningSecret === true;
			return Promise.resolve({
				registered: true,
				url: args.url,
				event_types: args.eventTypes ?? ["indexing.status_changed"],
				signing_secret_configured: generated || args.signingSecret != null,
				...(generated ? { signing_secret: SECRET } : {}),
				message: "Webhook registered.",
			});
		},
		get() {
			calls.push({ method: "get" });
			return Promise.resolve({
				registered: true,
				url: "https://hooks.example.test/indexing",
				event_types: ["indexing.status_changed"],
				signing_secret_configured: true,
			});
		},
		delete() {
			calls.push({ method: "delete" });
			return Promise.resolve({ deleted: true, message: "Webhook unregistered." });
		},
		setSigningSecret(args: { signingSecret?: string }) {
			calls.push({ method: "setSigningSecret", args });
			return Promise.resolve({
				signing_secret: args.signingSecret ?? SECRET,
				generated: args.signingSecret == null,
				message: "Signing secret generated.",
			});
		},
		clearSigningSecret() {
			calls.push({ method: "clearSigningSecret" });
			return Promise.resolve({
				registered: true,
				signing_secret_configured: false,
				message: "Signing disabled. Deliveries are no longer signed.",
			});
		},
		listDeliveries(args: { limit?: number; cursor?: string; status?: string }) {
			calls.push({ method: "listDeliveries", args });
			return Promise.resolve({
				deliveries: [
					{
						delivery_id: "dlv_1",
						doc_id: "doc_1",
						status: "failed",
						indexing_status: "failed",
						event_type: "indexing.status_changed",
						attempts: 2,
						error_message: "connection refused",
						created_at: "2026-10-29T00:00:00Z",
						updated_at: "2026-10-29T00:01:00Z",
					},
				],
				count: 1,
				next_cursor: "CURSOR2",
			});
		},
		getDelivery(deliveryId: string) {
			calls.push({ method: "getDelivery", args: { deliveryId } });
			return Promise.resolve({
				delivery_id: deliveryId,
				doc_id: "doc_1",
				status: "failed",
				indexing_status: "failed",
				event_type: "indexing.status_changed",
				attempts: 2,
				error_code: "ECONNREFUSED",
				error_message: "connection refused",
				created_at: "2026-10-29T00:00:00Z",
				updated_at: "2026-10-29T00:01:00Z",
			});
		},
		retryDelivery(deliveryId: string) {
			calls.push({ method: "retryDelivery", args: { deliveryId } });
			return Promise.resolve({
				delivery_id: deliveryId,
				queued: true,
				message: "Delivery queued for retry.",
			});
		},
		test() {
			calls.push({ method: "test" });
			return Promise.resolve({
				delivered: true,
				status_code: 200,
				message: "Test delivery sent.",
			});
		},
	};

	const sdk = {
		query: () => Promise.resolve({ data: { chunks: [] }, success: true }),
		context: {},
	} as unknown as HydraDBClient;

	const hydra = new HydraDB({ token: "t", database: "db_test" }, sdk);
	// `webhooks` is readonly to callers, not to the test that stands in for it.
	(hydra as { webhooks: unknown }).webhooks = webhooks;

	return { hydra, calls };
}

async function connect(hydra: HydraDB) {
	const server = createHydraDBServer(hydra);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "0.0.0" });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return client;
}

function textOf(result: unknown): string {
	return (result as { content: { text: string }[] }).content[0]!.text;
}

async function withEnv(value: string | undefined, run: () => Promise<void>) {
	const previous = process.env.HYDRADB_MCP_WEBHOOK_TOOLS;

	if (value == null) delete process.env.HYDRADB_MCP_WEBHOOK_TOOLS;
	else process.env.HYDRADB_MCP_WEBHOOK_TOOLS = value;

	try {
		await run();
	} finally {
		if (previous == null) delete process.env.HYDRADB_MCP_WEBHOOK_TOOLS;
		else process.env.HYDRADB_MCP_WEBHOOK_TOOLS = previous;
	}
}

// --- Registration and gating ---

test("the webhook tools are registered by default", async () => {
	const { hydra } = mockWebhooks();
	const client = await connect(hydra);

	const names = (await client.listTools()).tools.map((t) => t.name);
	for (const name of WEBHOOK_TOOL_NAMES) {
		assert.ok(names.includes(name), `${name} should be registered by default`);
	}

	await client.close();
});

test("HYDRADB_MCP_WEBHOOK_TOOLS=0 withholds the whole family", async () => {
	await withEnv("0", async () => {
		const { hydra } = mockWebhooks();
		const client = await connect(hydra);

		const names = (await client.listTools()).tools.map((t) => t.name);
		for (const name of WEBHOOK_TOOL_NAMES) {
			assert.ok(!names.includes(name), `${name} should be withheld`);
		}
		// The memory surface is untouched by the webhook gate.
		assert.ok(names.includes(TOOL_NAMES.QUERY));

		await client.close();
	});
});

test("the webhook opt-out accepts the usual falsy spellings and nothing else", () => {
	for (const off of ["0", "false", "no", "off", "OFF", " off "]) {
		assert.ok(
			!webhookToolsEnabled({ HYDRADB_MCP_WEBHOOK_TOOLS: off }),
			`"${off}" should withhold`,
		);
	}

	// On by default, and any non-falsy value keeps it on.
	for (const on of ["1", "true", "yes", "on", "", "maybe"]) {
		assert.ok(
			webhookToolsEnabled({ HYDRADB_MCP_WEBHOOK_TOOLS: on }),
			`"${on}" should keep the tools on`,
		);
	}

	assert.ok(webhookToolsEnabled({}));
});

// --- Behaviour hints (PRO-3342 acceptance: delete + disable-signing destructive) ---

test("delete and disable-signing are annotated destructive; reads are read-only", async () => {
	const { hydra } = mockWebhooks();
	const client = await connect(hydra);
	const { tools } = await client.listTools();

	const hint = (name: string) =>
		tools.find((t) => t.name === name)!.annotations as Record<string, boolean> | undefined;

	for (const name of [TOOL_NAMES.WEBHOOK_DELETE, TOOL_NAMES.WEBHOOK_CLEAR_SIGNING_SECRET]) {
		assert.equal(hint(name)?.destructiveHint, true, `${name} must read as destructive`);
	}

	// Register replaces the current destination/events, and setting the secret
	// invalidates the receiver's old one — both destructive, and non-idempotent
	// since a fresh secret is minted per call, so a host must not treat a repeat
	// as a safe no-op.
	for (const name of [TOOL_NAMES.WEBHOOK_REGISTER, TOOL_NAMES.WEBHOOK_SET_SIGNING_SECRET]) {
		assert.equal(hint(name)?.destructiveHint, true, `${name} overwrites prior state`);
		assert.equal(hint(name)?.idempotentHint, false, `${name} is not safe to repeat blindly`);
	}

	for (const name of [
		TOOL_NAMES.WEBHOOK_GET,
		TOOL_NAMES.WEBHOOK_LIST_DELIVERIES,
		TOOL_NAMES.WEBHOOK_GET_DELIVERY,
	]) {
		assert.equal(hint(name)?.readOnlyHint, true, `${name} must read as read-only`);
	}

	await client.close();
});

// The webhook endpoints act on the whole ORG and carry no database/collection,
// so a connection the user confined to specific databases/collections (an OAuth
// grant) must not reach them — otherwise the grant's boundary is silently
// bypassed. The whole family is withheld rather than refused per-call, since
// these calls have no scope for the per-call guard to check.
test("the webhook tools are withheld from a scope-confined connection", async () => {
	for (const confinement of [
		{ allowedDatabases: ["db_test"] },
		{ allowedCollections: ["col_a"] },
	]) {
		const sdk = {
			query: () => Promise.resolve({ data: { chunks: [] }, success: true }),
			context: {},
		} as unknown as HydraDBClient;
		const hydra = new HydraDB({ token: "t", database: "db_test", ...confinement }, sdk);
		const client = await connect(hydra);

		const names = (await client.listTools()).tools.map((t) => t.name);
		for (const name of WEBHOOK_TOOL_NAMES) {
			assert.ok(!names.includes(name), `${name} must be withheld from a confined connection`);
		}
		// The memory surface a confined connection WAS granted is untouched.
		assert.ok(names.includes(TOOL_NAMES.QUERY));

		await client.close();
	}
});

// --- Register ---

test("register forwards the url, event types, and the generate flag", async () => {
	const { hydra, calls } = mockWebhooks();
	const client = await connect(hydra);

	await client.callTool({
		name: TOOL_NAMES.WEBHOOK_REGISTER,
		arguments: {
			url: "https://hooks.example.test/indexing",
			event_types: ["indexing.status_changed"],
			generate_signing_secret: true,
		},
	});

	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0], {
		method: "register",
		args: {
			url: "https://hooks.example.test/indexing",
			eventTypes: ["indexing.status_changed"],
			signingSecret: undefined,
			generateSigningSecret: true,
		},
	});

	await client.close();
});

test("a generated secret is shown once, clearly labelled", async () => {
	const { hydra } = mockWebhooks();
	const client = await connect(hydra);

	const text = textOf(
		await client.callTool({
			name: TOOL_NAMES.WEBHOOK_REGISTER,
			arguments: { url: "https://hooks.example.test/indexing", generate_signing_secret: true },
		}),
	);

	assert.ok(text.includes(SECRET), "the generated secret must be surfaced once");
	assert.match(text, /shown once/i, "the secret must be clearly labelled as one-time");
	assert.match(text, /cannot be retrieved/i);

	await client.close();
});

test("register without a secret never prints one", async () => {
	const { hydra } = mockWebhooks();
	const client = await connect(hydra);

	const text = textOf(
		await client.callTool({
			name: TOOL_NAMES.WEBHOOK_REGISTER,
			arguments: { url: "https://hooks.example.test/indexing" },
		}),
	);

	assert.ok(!text.includes(SECRET), "no secret was generated, so none may appear");
	assert.doesNotMatch(text, /shown once/i);

	await client.close();
});

// --- Signing secret ---

test("set-signing-secret shows the secret once and labels it", async () => {
	const { hydra } = mockWebhooks();
	const client = await connect(hydra);

	const text = textOf(
		await client.callTool({ name: TOOL_NAMES.WEBHOOK_SET_SIGNING_SECRET, arguments: {} }),
	);

	assert.ok(text.includes(SECRET));
	assert.match(text, /shown once/i);

	await client.close();
});

test("the signing secret never leaks back through get", async () => {
	const { hydra } = mockWebhooks();
	const client = await connect(hydra);

	// Generate a secret...
	await client.callTool({
		name: TOOL_NAMES.WEBHOOK_REGISTER,
		arguments: { url: "https://hooks.example.test/indexing", generate_signing_secret: true },
	});

	// ...then read the registration back: it must report signing is on without
	// echoing the plaintext, which the API never returns after creation.
	const text = textOf(await client.callTool({ name: TOOL_NAMES.WEBHOOK_GET, arguments: {} }));

	assert.ok(!text.includes(SECRET), "get must never carry the plaintext secret");
	assert.match(text, /signing: enabled/i);

	await client.close();
});

// --- Deliveries ---

test("list deliveries forwards the filters and renders the paging hint", async () => {
	const { hydra, calls } = mockWebhooks();
	const client = await connect(hydra);

	const text = textOf(
		await client.callTool({
			name: TOOL_NAMES.WEBHOOK_LIST_DELIVERIES,
			arguments: { limit: 50, status: "failed", cursor: "CURSOR1" },
		}),
	);

	assert.deepEqual(calls[0], {
		method: "listDeliveries",
		args: { limit: 50, cursor: "CURSOR1", status: "failed" },
	});
	assert.match(text, /dlv_1/);
	assert.match(text, /failed/);
	assert.match(text, /CURSOR2/, "the next-page cursor must be surfaced");

	await client.close();
});

test("get delivery forwards the id and renders its detail", async () => {
	const { hydra, calls } = mockWebhooks();
	const client = await connect(hydra);

	const text = textOf(
		await client.callTool({
			name: TOOL_NAMES.WEBHOOK_GET_DELIVERY,
			arguments: { delivery_id: "dlv_1" },
		}),
	);

	assert.deepEqual(calls[0], { method: "getDelivery", args: { deliveryId: "dlv_1" } });
	assert.match(text, /dlv_1/);
	assert.match(text, /ECONNREFUSED/);

	await client.close();
});

test("an empty delivery id is rejected before any request", async () => {
	const { hydra, calls } = mockWebhooks();
	const client = await connect(hydra);

	const result = await client.callTool({
		name: TOOL_NAMES.WEBHOOK_GET_DELIVERY,
		arguments: { delivery_id: "" },
	});

	assert.equal((result as { isError?: boolean }).isError, true);
	assert.equal(calls.length, 0, "a blank id must fail before any outbound request");

	await client.close();
});

test("retry delivery forwards the id", async () => {
	const { hydra, calls } = mockWebhooks();
	const client = await connect(hydra);

	const text = textOf(
		await client.callTool({
			name: TOOL_NAMES.WEBHOOK_RETRY_DELIVERY,
			arguments: { delivery_id: "dlv_1" },
		}),
	);

	assert.deepEqual(calls[0], { method: "retryDelivery", args: { deliveryId: "dlv_1" } });
	assert.match(text, /queued/i);

	await client.close();
});

test("test delivery reports the receiver's status code", async () => {
	const { hydra, calls } = mockWebhooks();
	const client = await connect(hydra);

	const text = textOf(await client.callTool({ name: TOOL_NAMES.WEBHOOK_TEST, arguments: {} }));

	assert.deepEqual(calls[0], { method: "test" });
	assert.match(text, /200/);

	await client.close();
});
