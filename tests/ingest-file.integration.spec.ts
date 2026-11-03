/**
 * Live: a PDF and a DOCX ingested through `hydradb_ingest` are found by
 * `hydradb_query`. Runs against a real Hydra DB in a throwaway collection,
 * deleted afterwards. Set RUN_LIVE_TESTS=true with HYDRADB_API_KEY and
 * HYDRADB_DATABASE (and HYDRADB_BASE_URL for a non-production stack).
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { resolveConfig } from "../src/config.js";
import { HydraDB } from "../src/hydra/index.js";
import { createHydraDBServer } from "../src/server.js";

const live =
	process.env.RUN_LIVE_TESTS === "true" &&
	(process.env.HYDRADB_API_KEY ?? "") !== "" &&
	(process.env.HYDRADB_DATABASE ?? "") !== "";

const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));

const INDEX_TIMEOUT_MS = Number(process.env.HYDRADB_INDEX_TIMEOUT_MS ?? 300_000);

const collection = `mcp-file-ingest-${Date.now()}`;

let client: Client | undefined;

async function connect(): Promise<Client> {
	if (client) return client;

	const config = resolveConfig();

	const hydra = new HydraDB({
		token: config.apiKey,
		database: config.database,
		collection,
		baseUrl: config.baseUrl,
	});

	// localFiles, as on the stdio server, so the DOCX goes by path.
	const server = createHydraDBServer(hydra, {}, { localFiles: true });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

	client = new Client({ name: "live-file-ingest", version: "0" });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

	return client;
}

/** The tool arguments this test sends. */
interface CallArgs {
	file?: { filename?: string; content_base64?: string; path?: string };
	source_id?: string;
	ids?: string[];
	query?: string;
	kind?: string;
	collection?: string;
}

async function call(name: string, args: CallArgs) {
	const result = await (await connect()).callTool({ name, arguments: args });
	// SAFETY: every tool result here carries text content.
	const text = (result.content as { text: string }[]).map((part) => part.text).join("\n");

	return { isError: result.isError === true, text };
}

after(async () => {
	if (!client) return;

	await call("hydradb_delete_collection", { collection });
	await client.close();
});

test("a PDF and a DOCX ingested through hydradb_ingest are found by a query", { skip: !live && "Set RUN_LIVE_TESTS=true with HYDRADB_API_KEY and HYDRADB_DATABASE" }, async () => {
	const pdf = await readFile(`${FIXTURES}/quillmoor-tide-log.pdf`);

	const ingested = [
		await call("hydradb_ingest", {
			file: { filename: "quillmoor-tide-log.pdf", content_base64: pdf.toString("base64") },
			source_id: "quillmoor",
		}),
		await call("hydradb_ingest", { file: { path: `${FIXTURES}/ferncastle-release-plan.docx` }, source_id: "ferncastle" }),
	];

	for (const result of ingested) assert.equal(result.isError, false, result.text);

	const deadline = Date.now() + INDEX_TIMEOUT_MS;

	for (;;) {
		const status = await call("hydradb_status", { ids: ["quillmoor", "ferncastle"] });

		assert.doesNotMatch(status.text, /errored|failed/, status.text);

		if (/quillmoor: completed/.test(status.text) && /ferncastle: completed/.test(status.text)) break;

		assert.ok(Date.now() < deadline, `not indexed in time: ${status.text}`);
		await new Promise((resolve) => setTimeout(resolve, 5_000));
	}

	const fromPdf = await call("hydradb_query", {
		query: "How often does the Quillmoor lighthouse keeper record the tide gauge?",
		kind: "knowledge",
	});

	assert.match(fromPdf.text, /forty-seven minutes/);
	assert.match(fromPdf.text, /quillmoor-tide-log\.pdf/);

	const fromDocx = await call("hydradb_query", {
		query: "Who holds the signing key for the Ferncastle amber build?",
		kind: "knowledge",
	});

	assert.match(fromDocx.text, /Oslo/);
	assert.match(fromDocx.text, /ferncastle-release-plan\.docx/);
});
