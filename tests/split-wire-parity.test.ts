import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { HydraDB } from "../src/hydra/index.js";
import { createHydraDBServer } from "../src/server.js";

// The global fetch is replaced, not HydraConfig.fetchFn, so this file runs
// unchanged against the main branch build and proves the expected bodies are
// the ones main sends.

const MEMORY_INSTRUCTIONS =
	"Focus on extracting user preferences, habits, opinions, likes, dislikes, goals, and recurring themes. " +
	"Capture any stated or implied personal context that would help personalise future interactions.";

const MAIN_SPLIT_QUERY = {
	query: "hello",
	type: "all",
	database: "db-split",
	collection: "notes",
	max_results: 10,
	mode: "thinking",
	alpha: 0.8,
	recency_bias: 0,
	graph_context: true,
};

const MAIN_SPLIT_INGEST = {
	database: "db-split",
	collection: "notes",
	type: "memory",
	upsert: "true",
	memories: [{ text: "note one", infer: true, is_markdown: false, custom_instructions: MEMORY_INSTRUCTIONS, title: "note one" }],
};

type Sent = { path: string; body: Record<string, unknown> };

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function recordWire(layout: "split" | "unified"): Sent[] {
	const sent: Sent[] = [];
	const envelope = (data: unknown) =>
		new Response(JSON.stringify({ success: true, data, meta: { request_id: "req-1" } }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		const path = new URL(request.url).pathname;
		let body: Record<string, unknown> = {};
		if (request.headers.get("content-type")?.includes("multipart/form-data")) {
			for (const [key, value] of (await request.formData()).entries()) {
				body[key] = value instanceof File ? `<file ${value.name} ${value.type} ${await value.text()}>` : value;
			}
		} else if (request.method !== "GET") {
			const raw = await request.text();
			body = raw ? JSON.parse(raw) : {};
		}
		sent.push({ path, body });
		if (path === "/databases") {
			return envelope({ databases: ["db-split"], details: [{ database: "db-split", type: layout }] });
		}
		if (path === "/query") {
			return envelope(layout === "unified" ? { chunks: [], graph: [], forceful_relations: [], llm_prompt: "" } : { chunks: [] });
		}
		return envelope({ success: true, success_count: 1, failed_count: 0, results: [{ source_id: "new-id", status: "queued" }] });
	}) as typeof fetch;
	return sent;
}

async function call(name: string, args: Record<string, unknown>) {
	const hydra = new HydraDB({ token: "synthetic-key", baseUrl: "https://api.test", database: "db-split", collection: "notes" });
	const server = createHydraDBServer(hydra);
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "split-wire-parity", version: "0" });
	await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
	try {
		const result = await client.callTool({ name, arguments: args });
		assert.equal(result.isError, undefined, JSON.stringify(result.content));

		return result;
	} finally {
		await client.close();
	}
}

const bodyAt = (sent: Sent[], path: string) => {
	const found = sent.filter((s) => s.path === path);
	assert.equal(found.length, 1, `exactly one ${path} request`);
	return found[0].body;
};

test("an untyped split query sends the body main sends", async () => {
	const sent = recordWire("split");
	await call("hydradb_query", { query: "hello" });
	const body = bodyAt(sent, "/query");
	for (const [field, value] of Object.entries(MAIN_SPLIT_QUERY)) assert.deepEqual(body[field], value, field);
	assert.deepEqual(body, MAIN_SPLIT_QUERY);
});

test("an untyped split ingest sends the body main sends", async () => {
	const sent = recordWire("split");
	await call("hydradb_ingest", { text: "note one" });
	const body = bodyAt(sent, "/context/ingest");
	const memories = JSON.parse(String(body.memories));
	assert.deepEqual(memories, MAIN_SPLIT_INGEST.memories);
	for (const [field, value] of Object.entries(MAIN_SPLIT_INGEST)) {
		if (field !== "memories") assert.equal(body[field], value, field);
	}
	assert.deepEqual({ ...body, memories }, MAIN_SPLIT_INGEST);
});

test("a split query sends an explicit recency bias as given", async () => {
	for (const recency of [0.6, 0.25]) {
		const sent = recordWire("split");
		await call("hydradb_query", { query: "hello", recency_bias: recency });
		assert.deepEqual(bodyAt(sent, "/query"), { ...MAIN_SPLIT_QUERY, recency_bias: recency });
	}
});

test("an untyped unified query sends no type and leaves recency to the server unless passed", async () => {
	const { type: _type, recency_bias: _recency, ...unifiedQuery } = MAIN_SPLIT_QUERY;
	for (const [args, expected] of [
		[{}, unifiedQuery],
		[{ recency_bias: 0.3 }, { ...unifiedQuery, recency_bias: 0.3 }],
	] as const) {
		const sent = recordWire("unified");
		await call("hydradb_query", { query: "hello", ...args });
		assert.deepEqual(bodyAt(sent, "/query"), expected);
	}
});

test("a split text ingest with user_name sends the body main sends", async () => {
	for (const args of [{}, { kind: "memory" }]) {
		const sent = recordWire("split");
		await call("hydradb_ingest", { text: "note one", user_name: "alice", ...args });
		const body = bodyAt(sent, "/context/ingest");
		assert.deepEqual({ ...body, memories: JSON.parse(String(body.memories)) }, MAIN_SPLIT_INGEST);
	}
});

// is_markdown is accepted on every ingest path, without a notice, and travels
// only as a split memory's flag. Elsewhere there is no field for it: the split
// bodies are main's bodies without it, and the unified decoder refuses
// unknown keys, so a context item never carries it.

const MAIN_SPLIT_KNOWLEDGE_TEXT = {
	database: "db-split",
	collection: "notes",
	type: "knowledge",
	upsert: "true",
	document_metadata: JSON.stringify([{ title: "note one" }]),
	documents: "<file note one.md text/markdown note one>",
};

const MAIN_SPLIT_FILE = {
	database: "db-split",
	collection: "notes",
	type: "knowledge",
	upsert: "true",
	documents: "<file a.txt text/plain hi>",
};

type Args = Parameters<typeof call>[1];

async function sameBodyWithMarkdown(layout: "split" | "unified", without: Args, withMarkdown: Args) {
	const bodies = [];

	for (const args of [without, withMarkdown]) {
		const sent = recordWire(layout);
		const result = await call("hydradb_ingest", args);

		assert.doesNotMatch(JSON.stringify(result.content), /markdown/i, "no notice for the option");
		bodies.push(bodyAt(sent, "/context/ingest"));
	}

	assert.deepEqual(bodies[1], bodies[0], `${layout} ${JSON.stringify(withMarkdown)}`);

	return bodies[0];
}

test("a split memory ingest with is_markdown sends the body main sends", async () => {
	const sent = recordWire("split");
	await call("hydradb_ingest", { text: "note one", is_markdown: true });
	const body = bodyAt(sent, "/context/ingest");
	assert.deepEqual(
		{ ...body, memories: JSON.parse(String(body.memories)) },
		{ ...MAIN_SPLIT_INGEST, memories: [{ ...MAIN_SPLIT_INGEST.memories[0], is_markdown: true }] },
	);
});

test("split knowledge text, files and knowledge items accept is_markdown and send main's body without it", async () => {
	const file = { filename: "a.txt", content_base64: Buffer.from("hi").toString("base64") };
	const appKnowledge = [{ id: "a1", kind: "message", fields: { body: "hello" } }];

	assert.deepEqual(
		await sameBodyWithMarkdown("split", { text: "note one", kind: "knowledge" }, { text: "note one", kind: "knowledge", is_markdown: true }),
		MAIN_SPLIT_KNOWLEDGE_TEXT,
	);
	assert.deepEqual(await sameBodyWithMarkdown("split", { file }, { file, is_markdown: true }), MAIN_SPLIT_FILE);
	await sameBodyWithMarkdown(
		"split",
		{ kind: "knowledge", items: [{ text: "note one", source_id: "k1" }] },
		{ kind: "knowledge", items: [{ text: "note one", source_id: "k1", is_markdown: true }] },
	);
	await sameBodyWithMarkdown("split", { app_knowledge: appKnowledge }, { app_knowledge: appKnowledge, is_markdown: true });
});

test("a unified database accepts is_markdown and leaves it out of every context item", async () => {
	const turns = [{ user: "u", assistant: "a" }];
	const text = await sameBodyWithMarkdown("unified", { text: "note one" }, { text: "note one", is_markdown: true });

	await sameBodyWithMarkdown("unified", { turns, source_id: "c1" }, { turns, source_id: "c1", is_markdown: true });
	await sameBodyWithMarkdown(
		"unified",
		{ items: [{ text: "note one", source_id: "i1" }] },
		{ items: [{ text: "note one", source_id: "i1", is_markdown: true }] },
	);
	assert.doesNotMatch(JSON.stringify(text.context), /is_markdown/);
});
