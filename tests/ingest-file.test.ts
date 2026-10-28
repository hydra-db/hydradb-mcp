/**
 * `hydradb_ingest` with a `file`: what reaches POST /context/ingest, and what
 * is refused before anything is uploaded. The real SDK builds the multipart
 * body; only `fetch` is faked.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, open, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { MAX_FILE_BYTES, MAX_INLINE_FILE_BYTES, readLocal } from "../src/files.js";
import { HydraDB } from "../src/hydra/index.js";
import { createHydraDBServer } from "../src/server.js";

// Not import.meta.dirname: that arrived in Node 20.11, and engines allows 18.
const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));

const PDF = join(FIXTURES, "quillmoor-tide-log.pdf");

const DOCX = join(FIXTURES, "ferncastle-release-plan.docx");

interface Upload {
	fields: Map<string, string>;
	files: File[];
}

/** Capture each ingest's multipart body as the API would parse it. */
function captureUploads(t: { mock: { method: typeof import("node:test").mock.method } }): Upload[] {
	const uploads: Upload[] = [];

	t.mock.method(globalThis, "fetch", async (input: Request | string | URL, init?: RequestInit) => {
		// SAFETY: `duplex` is a valid RequestInit key that Node's lib types omit.
		const form = await new Request(String(input), { ...init, duplex: "half" } as RequestInit).formData();
		const fields = new Map<string, string>();
		const files: File[] = [];

		for (const [name, value] of form) {
			if (value instanceof Blob) {
				if (name === "documents") files.push(value);
			} else {
				fields.set(name, value);
			}
		}

		uploads.push({ fields, files });

		return new Response(
			JSON.stringify({
				success: true,
				data: {
					success: true,
					message: "Upload completed; files are queued for asynchronous processing.",
					results: [{ id: fields.get("document_metadata") ? "doc-1" : "gen-1", filename: files[0]?.name, status: "queued" }],
					success_count: 1,
					failed_count: 0,
				},
			}),
			{ status: 202, headers: { "content-type": "application/json" } },
		);
	});

	return uploads;
}

async function connect(options: { localFiles?: boolean } = {}) {
	const hydra = new HydraDB({ token: "t", database: "db_test", maxRetries: 0 });
	const server = createHydraDBServer(hydra, {}, options);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "0.0.0" });

	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

	return client;
}

/** The hydradb_ingest arguments these tests send. */
interface IngestArgs {
	file?: { filename?: string; content_base64?: string; path?: string };
	text?: string;
	turns?: { user: string; assistant: string }[];
	kind?: string;
	title?: string;
	source_id?: string;
}

async function ingest(client: Client, args: IngestArgs) {
	const result = await client.callTool({ name: "hydradb_ingest", arguments: args });
	// SAFETY: every hydradb_ingest result carries text content.
	const text = (result.content as { text: string }[]).map((part) => part.text).join("\n");

	return { isError: result.isError === true, text };
}

test("a PDF sent as base64 is uploaded as a knowledge document, byte for byte", async (t) => {
	const uploads = captureUploads(t);
	const client = await connect();
	const bytes = await readFile(PDF);

	const result = await ingest(client, {
		file: { filename: "quillmoor-tide-log.pdf", content_base64: bytes.toString("base64") },
		source_id: "quillmoor",
	});

	assert.equal(result.isError, false, result.text);
	assert.match(result.text, /Saved quillmoor-tide-log\.pdf to Hydra DB as knowledge \(id: doc-1\)/);
	assert.equal(uploads.length, 1);
	assert.equal(uploads[0]?.fields.get("type"), "knowledge");
	assert.deepEqual(JSON.parse(uploads[0]?.fields.get("document_metadata") ?? "null"), [{ id: "quillmoor" }]);

	const file = uploads[0]?.files[0];

	assert.equal(file?.name, "quillmoor-tide-log.pdf");
	assert.equal(file?.type, "application/pdf");
	assert.ok(Buffer.from(await file!.arrayBuffer()).equals(bytes), "the bytes arrive unchanged");
});

test("on the stdio server a DOCX can be ingested by path", async (t) => {
	const uploads = captureUploads(t);
	const client = await connect({ localFiles: true });

	const result = await ingest(client, { file: { path: DOCX } });

	assert.equal(result.isError, false, result.text);

	const file = uploads[0]?.files[0];

	assert.equal(file?.name, "ferncastle-release-plan.docx");
	assert.equal(file?.type, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
	assert.ok(Buffer.from(await file!.arrayBuffer()).equals(await readFile(DOCX)));
	assert.equal(uploads[0]?.fields.has("document_metadata"), false, "no id given, none sent");
});

test("the hosted server refuses a path: it would read the server's own disk", async (t) => {
	const uploads = captureUploads(t);
	const client = await connect();

	const result = await ingest(client, { file: { path: DOCX } });

	assert.equal(result.isError, true);
	assert.match(result.text, /works only on the local \(stdio\) Hydra DB MCP server/);
	assert.match(result.text, /`file\.content_base64` \(up to 8 MB\)/);
	assert.equal(uploads.length, 0);
});

test("an oversized inline file is refused before upload, naming the limit", async (t) => {
	const uploads = captureUploads(t);
	const client = await connect();
	const tooBig = "A".repeat(Math.ceil(((MAX_INLINE_FILE_BYTES + 1) * 4) / 3) + 4);

	const result = await ingest(client, { file: { filename: "big.pdf", content_base64: tooBig } });

	assert.equal(result.isError, true);
	assert.match(result.text, /"big\.pdf" is 8\.0 MB; a file sent inline as content_base64 can be at most 8\.0 MB/);
	assert.equal(uploads.length, 0);
});

test("an oversized local file is refused before it is read", async (t) => {
	const uploads = captureUploads(t);
	const client = await connect({ localFiles: true });
	const dir = await mkdtemp(join(tmpdir(), "hydradb-mcp-"));
	const path = join(dir, "huge.pdf");

	t.after(() => rm(dir, { recursive: true, force: true }));
	await writeFile(path, "");
	// Sparse: the size is real, no 50 MB is written.
	await truncate(path, MAX_FILE_BYTES + 1);

	const result = await ingest(client, { file: { path } });

	assert.equal(result.isError, true);
	assert.match(result.text, /"huge\.pdf" is 50\.0 MB; Hydra DB accepts files up to 50\.0 MB/);
	assert.equal(uploads.length, 0);
});

test("a file Hydra DB cannot read is refused before upload", async (t) => {
	const uploads = captureUploads(t);
	const client = await connect();

	for (const filename of ["photo.heic", "README"]) {
		const result = await ingest(client, { file: { filename, content_base64: "aGVsbG8=" } });

		assert.equal(result.isError, true, filename);
		assert.match(result.text, /Supported: \.pdf .*\.docx .*\.pptx/);
	}

	assert.equal(uploads.length, 0);
});

test("file is exclusive with text and turns, is knowledge only, and takes no title", async (t) => {
	const uploads = captureUploads(t);
	const client = await connect();
	const file = { filename: "a.pdf", content_base64: "aGVsbG8=" };

	const cases: [IngestArgs, RegExp][] = [
		[{ file, text: "x" }, /exactly one of `text`, `turns` or `file`/],
		[{ file, turns: [{ user: "u", assistant: "a" }] }, /exactly one of `text`, `turns` or `file`/],
		[{ file, kind: "memory" }, /as knowledge, not memory/],
		[{ file: { filename: "a.pdf" } }, /exactly one of `content_base64`/],
		[{ file: { content_base64: "aGVsbG8=" } }, /filename` is required/],
		[{ file: { filename: "a.pdf", content_base64: "not base64!" } }, /not valid base64/],
		// Right alphabet, impossible shape: these used to decode to fewer bytes than sent.
		[{ file: { filename: "a.pdf", content_base64: "A" } }, /not valid base64/],
		[{ file: { filename: "a.pdf", content_base64: "AAAAA" } }, /not valid base64/],
		[{ file: { filename: "a.pdf", content_base64: "AAA==" } }, /not valid base64/],
		[{ file: { filename: "a.pdf", content_base64: "==" } }, /not valid base64/],
	];

	for (const [args, message] of cases) {
		const result = await ingest(client, args);

		assert.equal(result.isError, true, JSON.stringify(args));
		assert.match(result.text, message);
	}

	assert.equal(uploads.length, 0);
});

test("the tool description states the size limits", async () => {
	const client = await connect();
	const { tools } = await client.listTools();
	const tool = tools.find((candidate) => candidate.name === "hydradb_ingest");
	// SAFETY: hydradb_ingest's input schema declares `file` as an object property.
	const file = (tool?.inputSchema.properties as Record<string, { description?: string }>).file;

	assert.match(tool?.description ?? "", /`file`.*base64 up to 8 MB.*local path up to 50 MB/);
	assert.match(file?.description ?? "", /AT MOST 8 MB per file/);
	assert.match(file?.description ?? "", /AT MOST 50 MB/);
});

test("a local read stops when the call is cancelled", async () => {
	const controller = new AbortController();

	controller.abort();

	await assert.rejects(readLocal(DOCX, undefined, controller.signal), { name: "AbortError" });
});

// A read stuck on a stalled mount cannot be interrupted, but the call waiting
// on it must still end. A FIFO with no writer blocks the open the same way.
test("a cancel ends the wait on a local read that never completes", { skip: process.platform === "win32" }, async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "hydradb-mcp-"));
	const fifo = join(dir, "stalled.pdf");

	t.after(() => rm(dir, { recursive: true, force: true }));
	execFileSync("mkfifo", [fifo]);

	const controller = new AbortController();
	const read = readLocal(fifo, undefined, controller.signal);

	try {
		setTimeout(() => controller.abort(), 100);

		const started = Date.now();

		await assert.rejects(read, { name: "AbortError" });
		assert.ok(Date.now() - started < 1000, "the cancel ended the wait");
	} finally {
		// Unblock the pending open with a writer that sends nothing, so the
		// process can exit; writing bytes could fail with EPIPE once the
		// abandoned reader closes.
		await (await open(fifo, "w")).close();
	}
});

// The API takes no title for a document; it uses the filename. So a `title`,
// which the tool tells agents to always set, renames the upload.
test("a title becomes the uploaded filename, keeping the extension", async (t) => {
	const uploads = captureUploads(t);
	const client = await connect();
	const content_base64 = (await readFile(PDF)).toString("base64");

	for (const [title, expected] of [["Tide log", "Tide log.pdf"], ["Tide log.PDF", "Tide log.PDF"]]) {
		const result = await ingest(client, { file: { filename: "quillmoor-tide-log.pdf", content_base64 }, title });

		assert.equal(result.isError, false, result.text);
		assert.equal(uploads.at(-1)?.files[0]?.name, expected);
	}
});

test("a local file that changes while it is read is refused, never sent in part", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "hydradb-mcp-"));
	const path = join(dir, "growing.pdf");

	t.after(() => rm(dir, { recursive: true, force: true }));
	await writeFile(path, "%PDF-1.4");

	const read = readLocal(path, undefined, undefined);

	// Grows after the read starts; depending on timing, before or after the size check.
	await truncate(path, 2 * 1024 * 1024);

	await read.then(
		(file) => assert.ok(file.data.length === 8 || file.data.length === 2 * 1024 * 1024, "a whole file, either version"),
		(err: Error) => assert.match(err.message, /changed while it was being read/),
	);
});
