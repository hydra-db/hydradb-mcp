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
import { z } from "zod";

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

interface UploadResponse {
	success: boolean;
	message: string;
	results: Array<{
		id: string;
		filename?: string;
		status: string;
		error?: string;
	}>;
	success_count: number;
	failed_count: number;
}

/** Capture each ingest's multipart body as the API would parse it. */
function captureUploads(
	t: { mock: { method: typeof import("node:test").mock.method } },
	response: UploadResponse = {
		success: true,
		message: "Upload completed; files are queued for asynchronous processing.",
		results: [],
		success_count: 1,
		failed_count: 0,
	},
): Upload[] {
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
					...response,
					results: response.results.length > 0
						? response.results
						: [{ id: fields.get("document_metadata") ? "doc-1" : "gen-1", filename: files[0]?.name, status: "queued" }],
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
	items?: Array<{ text: string; title?: string }>;
	app_knowledge?: Array<{ kind: "message"; fields: { body: string } }>;
	kind?: string;
	title?: string;
	source_id?: string;
	record_type?: string | { name: string; fields: Record<string, string> };
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

test("an all-failed file upload does not claim the file was saved", async (t) => {
	const uploads = captureUploads(t, {
		success: false,
		message: "Upload rejected.",
		results: [{ id: "bad-file", filename: "bad.pdf", status: "failed", error: "file rejected" }],
		success_count: 0,
		failed_count: 1,
	});

	const client = await connect();

	const result = await ingest(client, {
		file: { filename: "bad.pdf", content_base64: "aGVsbG8=" },
	});

	assert.equal(result.isError, true);
	assert.doesNotMatch(result.text, /^Saved /);
	assert.match(result.text, /rejected every ingest item/i);
	assert.equal(uploads.length, 1);
});

test("file ingest forwards the record type definition or its reusable name", async (t) => {
	const uploads = captureUploads(t);
	const client = await connect();
	const file = { filename: "example.pdf", content_base64: "aGVsbG8=" };
	const definition = { name: "transaction", fields: { date: "date", amount: "number" } };
	const first = await ingest(client, { file, record_type: definition, source_id: "statement" });
	const second = await ingest(client, { file, record_type: "transaction" });

	assert.equal(first.isError, false, first.text);
	assert.match(first.text, /use hydradb_inspect/i);
	assert.equal(second.isError, false, second.text);
	assert.equal(uploads.length, 2);
	assert.deepEqual(JSON.parse(uploads[0]?.fields.get("record_type") ?? "null"), definition);
	assert.equal(uploads[0]?.fields.get("database"), "db_test");
	assert.deepEqual(JSON.parse(uploads[0]?.fields.get("document_metadata") ?? "null"), [{ id: "statement" }]);
	assert.equal(uploads[1]?.fields.get("record_type"), "transaction");
	assert.equal(await uploads[0]?.files[0]?.text(), "hello");
});

test("ingest rejects a record type without an uploaded document", async (t) => {
	const uploads = captureUploads(t);
	const client = await connect();
	const result = await ingest(client, { text: "a note", record_type: "transaction" });
	assert.equal(result.isError, true);
	assert.match(result.text, /record_type requires an uploaded file/);
	assert.equal(uploads.length, 0);
});

test("Inspect exposes PDF extraction and record validation separately", async (t) => {
	const report = { record_type: "transaction", records: 4, rejected: 1, tables: [] };
	const extraction = { status: "partial", method: "layout", rows_recovered: 2 };
	t.mock.method(globalThis, "fetch", async () => Response.json({
		success: true,
		data: { id: "statement", success: true, record_type_report: report, table_extraction: extraction },
	}));
	const client = await connect();
	const result = await client.callTool({ name: "hydradb_inspect", arguments: { id: "statement" } });
	assert.deepEqual(result.structuredContent?.record_type_report, report);
	assert.deepEqual(result.structuredContent?.table_extraction, extraction);
	assert.match(JSON.stringify(result.content), /4 imported, 1 rejected/);
	assert.match(JSON.stringify(result.content), /query totals may omit rows/i);
});

test("a query with no text chunks preserves table totals and PDF coverage", async (t) => {
	const table = { status: "ok", records: [{ total: "12.00" }], extraction_status: "unverified" };
	t.mock.method(globalThis, "fetch", async () => Response.json({
		success: true, data: { chunks: [], tabular_data: table },
	}));
	const client = await connect();

	const result = await client.callTool({
		name: "hydradb_query",
		arguments: { query: "What is the total?", collection: "statements", structured: true },
	});

	assert.deepEqual(result.structuredContent?.tabular_data, table);
	assert.match(JSON.stringify(result.content), /PDF table coverage is unverified/);
	assert.match(JSON.stringify(result.content), /12\.00/);
});

/** The /query body fields these tests check; any other field passes through. */
const queryBody = z.object({
	query: z.string(),
	collection: z.string().optional(),
	include_table_sql: z.boolean().optional(),
	table_limit: z.number().optional(),
	response_format: z.string().optional(),
}).passthrough();

/** The text of a tool result's first content block. */
function firstText(result: { content?: unknown }): string {
	return z.array(z.object({ text: z.string() })).parse(result.content)[0]?.text ?? "";
}

/** A /query `data` payload: a table answer, or the Markdown rendering. */
type QueryData = string | {
	chunks: [];
	tabular_data?: { status: "ok"; answer_type?: string; sql?: string; records: Record<string, string | number>[] };
};

/** Mocks /query, answering with `data`, and records each request body sent. */
function captureQueries(
	t: { mock: { method: typeof import("node:test").mock.method } },
	data: QueryData,
): z.infer<typeof queryBody>[] {
	const bodies: z.infer<typeof queryBody>[] = [];

	t.mock.method(globalThis, "fetch", async (_input: Request | string | URL, init?: RequestInit) => {
		bodies.push(queryBody.parse(JSON.parse(String(init?.body))));

		return Response.json({ success: true, data, meta: { request_id: "r-table" } });
	});

	return bodies;
}

test("include_table_sql and table_limit reach /query and the SQL is shown", async (t) => {
	const sql = "SELECT sum(\"Debit\") AS total FROM t_abc WHERE \"Date\" >= DATE '2024-10-01'";
	const table = { status: "ok", answer_type: "computed", sql, records: [{ total: 2575000 }] };
	const bodies = captureQueries(t, { chunks: [], tabular_data: table });
	const client = await connect();

	const result = await client.callTool({
		name: "hydradb_query",
		arguments: {
			query: "October outflows", collection: "statements", include_table_sql: true, table_limit: 5, structured: true,
		},
	});

	assert.equal(result.isError, undefined, JSON.stringify(result.content));
	assert.equal(bodies.length, 1);
	assert.equal(bodies[0]?.include_table_sql, true);
	assert.equal(bodies[0]?.table_limit, 5);
	// The SDK's own fields still go out as before.
	assert.equal(bodies[0]?.query, "October outflows");
	assert.equal(bodies[0]?.collection, "statements");
	assert.deepEqual(result.structuredContent?.tabular_data, table);
	const text = firstText(result);
	assert.ok(text.includes(`SQL executed:\n\`\`\`sql\n${sql}\n\`\`\``), text);
});

test("a query without the table options sends neither field", async (t) => {
	const bodies = captureQueries(t, { chunks: [], tabular_data: { status: "ok", records: [{ n: 1 }] } });
	const client = await connect();

	await client.callTool({ name: "hydradb_query", arguments: { query: "how many", collection: "statements" } });

	assert.equal(bodies.length, 1);
	assert.equal("include_table_sql" in (bodies[0] ?? {}), false);
	assert.equal("table_limit" in (bodies[0] ?? {}), false);
});

test("include_table_sql is forwarded on a Markdown query", async (t) => {
	const bodies = captureQueries(t, "## Table query\n\nQuery executed:\n```sql\nSELECT 1\n```\n");
	const client = await connect();

	const result = await client.callTool({
		name: "hydradb_query",
		arguments: { query: "q", collection: "statements", include_table_sql: true, response_format: "markdown" },
	});

	assert.equal(bodies[0]?.include_table_sql, true);
	assert.equal(bodies[0]?.response_format, "markdown");
	assert.match(JSON.stringify(result.content), /SELECT 1/);
});

test("a code fence inside the SQL cannot close the SQL block early", async (t) => {
	const table = { status: "ok", sql: "SELECT '```' AS x", records: [] };
	captureQueries(t, { chunks: [], tabular_data: table });
	const client = await connect();

	const result = await client.callTool({
		name: "hydradb_query",
		arguments: { query: "q", collection: "statements", include_table_sql: true },
	});

	const text = firstText(result);
	assert.ok(text.includes("SELECT '' ' '' AS x"), text);
	assert.equal(text.split("```").length, 3, text);
});

test("hydradb_query advertises the table options and bounds table_limit", async (t) => {
	const bodies = captureQueries(t, { chunks: [] });
	const client = await connect();
	const { tools } = await client.listTools();
	const props = tools.find((tool) => tool.name === "hydradb_query")?.inputSchema.properties ?? {};

	const typed = z.object({ type: z.string() });

	assert.equal(typed.parse(props.include_table_sql).type, "boolean");
	assert.equal(typed.parse(props.table_limit).type, "integer");

	for (const tableLimit of [0, 101, 2.5]) {
		const result = await client.callTool({
			name: "hydradb_query",
			arguments: { query: "q", collection: "statements", table_limit: tableLimit },
		});

		assert.equal(result.isError, true, `table_limit ${tableLimit}`);
	}

	assert.equal(bodies.length, 0);
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
		[{ file, text: "x" }, /exactly one of `text`, `turns`, `items`, `app_knowledge`, or `file`/],
		[{ file, turns: [{ user: "u", assistant: "a" }] }, /exactly one of `text`, `turns`, `items`, `app_knowledge`, or `file`/],
		[{ file, items: [{ text: "x" }] }, /exactly one of `text`, `turns`, `items`, `app_knowledge`, or `file`/],
		[{ file, app_knowledge: [{ kind: "message", fields: { body: "x" } }] }, /exactly one of `text`, `turns`, `items`, `app_knowledge`, or `file`/],
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

// The per-document keys POST /context/ingest accepts in `document_metadata`.
// Any other key fails the whole request with 400 INVALID_INPUT.
const DOCUMENT_METADATA_KEYS = new Set([
	"additional_metadata",
	"document_metadata",
	"evidence_kind",
	"evidence_subject",
	"file_id",
	"id",
	"infer",
	"metadata",
	"relations",
	"source_id",
]);

/** One `document_metadata` entry: an optional id plus whatever else was sent. */
const documentMetadata = z.array(z.object({ id: z.string().optional() }).passthrough());

/** A fake API that refuses unknown `document_metadata` keys the way the real one does. */
function strictUploads(t: { mock: { method: typeof import("node:test").mock.method } }): Upload[] {
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

		const items = documentMetadata.parse(JSON.parse(fields.get("document_metadata") ?? "[]"));

		const unknown = [...new Set(items.flatMap((item) => Object.keys(item)))]
			.filter((key) => !DOCUMENT_METADATA_KEYS.has(key))
			.sort();

		if (unknown.length > 0) {
			return new Response(
				JSON.stringify({
					success: false,
					error: {
						code: "INVALID_INPUT",
						message: `Invalid document_metadata: unsupported key(s) [${unknown.join(" ")}]`,
					},
				}),
				{ status: 400, headers: { "content-type": "application/json" } },
			);
		}

		return new Response(
			JSON.stringify({
				success: true,
				data: {
					success: true,
					message: "Upload completed; files are queued for asynchronous processing.",
					results: files.map((file, index) => ({
						id: items[index]?.id ?? `gen-${index + 1}`,
						filename: file.name,
						status: "queued",
					})),
					success_count: files.length,
					failed_count: 0,
				},
			}),
			{ status: 202, headers: { "content-type": "application/json" } },
		);
	});

	return uploads;
}

// Text saved as knowledge is uploaded as a Markdown file. The API reads the
// document's title from the filename and rejects a `title` key in
// `document_metadata`, so the title must travel as the filename only.
test("text saved as knowledge passes an API that rejects unknown document_metadata keys", async (t) => {
	const uploads = strictUploads(t);
	const client = await connect();

	const titled = await ingest(client, {
		kind: "knowledge",
		text: "Harbor pilots board at the outer buoy.",
		title: "Harbor pilot notes",
		source_id: "harbor-notes",
	});

	assert.equal(titled.isError, false, titled.text);
	assert.equal(uploads[0]?.files[0]?.name, "Harbor pilot notes.md");
	assert.equal(await uploads[0]?.files[0]?.text(), "Harbor pilots board at the outer buoy.");
	assert.deepEqual(JSON.parse(uploads[0]?.fields.get("document_metadata") ?? "null"), [{ id: "harbor-notes" }]);

	const untitled = await ingest(client, { kind: "knowledge", text: "Tide tables are posted weekly." });

	assert.equal(untitled.isError, false, untitled.text);
	assert.equal(uploads[1]?.files[0]?.name, "Tide tables are posted weekly.md");
	assert.deepEqual(JSON.parse(uploads[1]?.fields.get("document_metadata") ?? "null"), [{}]);

	const batch = await ingest(client, {
		kind: "knowledge",
		items: [{ text: "First entry.", title: "First" }, { text: "Second entry.", title: "Second.md" }],
	});

	assert.equal(batch.isError, false, batch.text);
	assert.deepEqual(uploads[2]?.files.map((file) => file.name), ["First.md", "Second.md"]);

	// A batch gets generated ids; nothing but `id` may ride along with them.
	const batchItems = documentMetadata.parse(JSON.parse(uploads[2]?.fields.get("document_metadata") ?? "[]"));

	assert.deepEqual(batchItems.map((item) => Object.keys(item)), [["id"], ["id"]]);
});

test("a local file that changes while it is read is refused, never sent in part", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "hydradb-mcp-"));
	const path = join(dir, "growing.pdf");

	t.after(() => rm(dir, { recursive: true, force: true }));
	await writeFile(path, "%PDF-1.4");

	const read = readLocal(path, undefined, undefined).then(
		(file) => assert.ok(file.data.length === 8 || file.data.length === 2 * 1024 * 1024, "a whole file, either version"),
		(err: Error) => assert.match(err.message, /changed while it was being read/),
	);

	// Observe both promises immediately: the reader can reject before truncate returns.
	await Promise.all([read, truncate(path, 2 * 1024 * 1024)]);
});
