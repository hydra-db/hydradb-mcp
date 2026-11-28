/**
 * Simulated tier: the real server process against e2e/simulator.ts, offline.
 *
 * Every probe (one tool call that reaches one route) meets every simulated
 * result, and each cell asserts the failure is reported honestly, quickly, once
 * for an ambiguous write, and without the key. The cells are generated from
 * PROBES x OUTCOMES. See e2e/README.md.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it, type TestContext } from "node:test";

import {
	connectorMetadata,
	DOCUMENT_METADATA_KEYS,
	FEEDBACK_BODY_KEYS,
	listedRows,
	MEMORY_ITEM_KEYS,
	missingInObject,
	missingInText,
	UPDATE_BODY_KEYS,
} from "./data.js";
import { startStdio, type StdioServer, type ToolAnswer } from "./harness.js";
import { type Exchange, loadFixtures, type Outcome, OUTCOMES, ROUTES, SIMULATED_ERRORS, Simulator } from "./simulator.js";

const fixtures = loadFixtures();
const simulator = new Simulator({ fixtures, slowMs: 4_000 });
const KEY = `sk_test_e2esim${randomBytes(4).toString("hex")}.${randomBytes(16).toString("hex")}`;
const DEADLINE_SECONDS = 2;
const MAX_RETRIES = 2;
const CELL_BUDGET_MS = 10_000;

let server: StdioServer;

before(async () => {
	const url = await simulator.start();

	server = await startStdio("source", {
		HYDRADB_API_KEY: KEY,
		HYDRADB_BASE_URL: url,
		HYDRADB_DATABASE: "sim-default",
		HYDRADB_TIMEOUT_SECONDS: String(DEADLINE_SECONDS),
		HYDRADB_MAX_RETRIES: String(MAX_RETRIES),
	});
});

after(async () => {
	await server?.close();
	await simulator.stop();
	assert.ok(!server.stderr().includes(KEY), "the server logged its API key");
});

// --- The table ---------------------------------------------------------------

interface Probe {
	/** The route this probe's call reaches, and the one its cells arm. */
	route: string;
	tool: string;
	args(marker: string): Record<string, unknown>;
	/** Not safe to send twice: an ambiguous failure must not be retried. */
	write: boolean;
	/** How a cell is told apart from the others: its database name, its connector id, or not at all. */
	marker: "database" | "connector" | "none";
}

const db = (extra: Record<string, unknown> = {}) => (marker: string) => ({ database: marker, ...extra });
const connector = (extra: Record<string, unknown> = {}) => (marker: string) => ({ connector_id: marker, ...extra });
const none = (args: Record<string, unknown> = {}) => () => args;

const PROBES: Probe[] = [
	{ route: "ingest", tool: "hydradb_ingest", args: db({ kind: "knowledge", text: "x", title: "T", source_id: "sim-1" }), write: true, marker: "database" },
	{ route: "list", tool: "hydradb_list", args: db({ kind: "knowledge" }), write: false, marker: "database" },
	{ route: "inspect", tool: "hydradb_inspect", args: db({ id: "sim-1" }), write: false, marker: "database" },
	{ route: "query", tool: "hydradb_query", args: db({ query: "ledger", collection: "c" }), write: false, marker: "database" },
	{ route: "status", tool: "hydradb_status", args: db({ ids: ["sim-1"] }), write: false, marker: "database" },
	{ route: "relations", tool: "hydradb_relations", args: db({ id: "sim-1" }), write: false, marker: "database" },
	{ route: "subgraph", tool: "hydradb_subgraph", args: db({ id: "sim-1" }), write: false, marker: "database" },
	{ route: "update", tool: "hydradb_update", args: db({ id: "sim-1", collection: "c", additional_metadata: { a: 1 } }), write: true, marker: "database" },
	{ route: "delete", tool: "hydradb_delete", args: db({ ids: ["sim-1"], kind: "knowledge" }), write: true, marker: "database" },
	{
		route: "feedback",
		tool: "hydradb_feedback",
		args: db({ request_id: "0c82d439-ebc9-4bf2-bc3b-0d64d149cac1", rating: "positive", feedback: "e2e" }),
		write: true,
		marker: "database",
	},
	{ route: "databases.list", tool: "hydradb_databases", args: none(), write: false, marker: "none" },
	{ route: "databases.create", tool: "hydradb_database_create", args: db(), write: true, marker: "database" },
	{ route: "databases.delete", tool: "hydradb_database_delete", args: db(), write: true, marker: "database" },
	{ route: "databases.status", tool: "hydradb_database_readiness", args: db(), write: false, marker: "database" },
	{ route: "databases.stats", tool: "hydradb_database_stats", args: db(), write: false, marker: "database" },
	{ route: "databases.schema", tool: "hydradb_database_schema_inspect", args: db(), write: false, marker: "database" },
	{
		route: "databases.schema_update",
		tool: "hydradb_database_schema_update",
		args: db({ add_fields: [{ name: "region", data_type: "VARCHAR", max_length: 32 }] }),
		write: true,
		marker: "database",
	},
	{ route: "collections.list", tool: "hydradb_list_collections", args: db(), write: false, marker: "database" },
	{ route: "collections.delete", tool: "hydradb_delete_collection", args: db({ collection: "c" }), write: true, marker: "database" },
	{ route: "connectors.providers", tool: "hydradb_connector_provider_list", args: none(), write: false, marker: "none" },
	{ route: "connectors.list", tool: "hydradb_connector_list", args: none(), write: false, marker: "none" },
	{ route: "connectors.get", tool: "hydradb_connector_inspect", args: connector(), write: false, marker: "connector" },
	{ route: "connectors.sync", tool: "hydradb_connector_sync", args: connector(), write: true, marker: "connector" },
	{ route: "graph.query", tool: "hydradb_graph_query", args: db({ collection: "c", query: "MATCH (p:Person) RETURN p.name AS name" }), write: true, marker: "database" },
	{ route: "graph.collections", tool: "hydradb_graph_collections", args: db(), write: false, marker: "database" },
	{ route: "graph.create", tool: "hydradb_graph_admin", args: db({ action: "create_database" }), write: true, marker: "database" },
];

/**
 * Cells that fail today because of a product bug. Each asserts the correct
 * behaviour; the marker must come off when the finding is fixed.
 */
const KNOWN: Record<string, string> = {
	"update.500": "F-mcp-10",
	"update.reset": "F-mcp-10",
	"delete.500": "F-mcp-10",
	"delete.reset": "F-mcp-10",
	"ingest.non_json": "F-mcp-11",
	"ingest.empty_object": "F-mcp-11",
	"delete.non_json": "F-mcp-11",
	"delete.empty_object": "F-mcp-11",
	"feedback.empty_object": "F-mcp-11",
	"collections.delete.non_json": "F-mcp-11",
	"collections.delete.empty_object": "F-mcp-11",
	"connectors.sync.non_json": "F-mcp-11",
	"connectors.sync.empty_object": "F-mcp-11",
	"graph.create.non_json": "F-mcp-11",
	"graph.create.empty_object": "F-mcp-11",
	"inspect.non_json": "F-mcp-12",
	"feedback.non_json": "F-mcp-9",
	"databases.list.empty_list": "F-mcp-13",
};

const AMBIGUOUS: Outcome[] = ["500", "reset", "slow"];

/** Connector tools rewrite every API failure into one fixed sentence per class (server.ts `hideConnectorFailure`). */
const CONNECTOR_CLASS: Partial<Record<Outcome, RegExp>> = {
	"400": /rejected the request as invalid/,
	"401": /refused this connection's credentials/,
	"403": /refused this connection's credentials/,
	"404": /not found/,
	"429": /rate-limited/,
	"500": /temporarily unavailable/,
	"503": /temporarily unavailable/,
};

function serverMessage(outcome: Outcome): string | undefined {
	if (outcome === "400" || outcome === "401" || outcome === "404") {
		return (fixtures.errors[outcome].body as { error: { message: string } }).error.message;
	}

	if (outcome === "403" || outcome === "429" || outcome === "500" || outcome === "503") return SIMULATED_ERRORS[outcome].message;

	return undefined;
}

function hasList(route: string): boolean {
	return (ROUTES.find((r) => r.id === route)?.list?.length ?? 0) > 0 && fixtures.routes[route] != null;
}

function markerFor(probe: Probe, outcome: Outcome): string | undefined {
	const slug = `${probe.route.replace(/\./g, "-")}-${outcome.replace(/_/g, "-")}`;

	if (probe.marker === "database") return `sim-${slug}`;

	if (probe.marker === "connector") return `conn_sim_${slug.replace(/-/g, "_")}`;

	return undefined;
}

/** Everything a user can read: the text and the structured output. */
function readable(answer: ToolAnswer): string {
	return `${answer.text}\n${JSON.stringify(answer.structured ?? null)}`;
}

function assertCell(probe: Probe, outcome: Outcome, answer: ToolAnswer, sent: Exchange[]) {
	const what = `${probe.tool} on ${outcome}`;
	const shown = readable(answer);

	assert.ok(answer.ms < CELL_BUDGET_MS, `${what} took ${answer.ms}ms`);
	assert.ok(!shown.includes(KEY) && !shown.includes(KEY.split(".")[1]), `${what} printed the API key`);
	assert.doesNotMatch(answer.text, /\bundefined\b|\[object Object\]|\bNaN\b/, `${what} printed a broken value: ${answer.text}`);
	assert.ok(sent.length >= 1, `${what} never reached ${probe.route}`);

	if (probe.write && AMBIGUOUS.includes(outcome)) {
		assert.equal(sent.length, 1, `${what} sent an unsafe write ${sent.length} times after an ambiguous failure`);
	} else {
		assert.ok(sent.length <= 1 + MAX_RETRIES, `${what} retried without bound (${sent.length} requests)`);
	}

	if (outcome === "empty_list") {
		assert.equal(answer.isError, false, `${what} errored on an empty result: ${answer.text}`);
		assert.match(answer.text, /\bno\b|\bnone\b|nothing|\b0\b/i, `${what} does not say nothing was found: ${answer.text}`);

		return;
	}

	assert.equal(answer.isError, true, `${what} reported success: ${answer.text.slice(0, 300)}`);
	assert.ok(answer.text.trim().length > 0, `${what} failed with no message`);

	const connectorClass = probe.tool.startsWith("hydradb_connector_") ? CONNECTOR_CLASS[outcome] : undefined;

	if (connectorClass) {
		assert.match(answer.text, connectorClass, `${what} did not name the failure's class: ${answer.text}`);

		return;
	}

	const message = serverMessage(outcome);

	if (message != null) {
		assert.match(answer.text, new RegExp(`\\b${outcome}\\b`), `${what} does not carry the status: ${answer.text}`);
		assert.ok(answer.text.includes(message), `${what} does not carry the server's message: ${answer.text}`);
	}
}

async function runCell(probe: Probe, outcome: Outcome, t: TestContext) {
	const id = `${probe.route}.${outcome}`;
	const marker = markerFor(probe, outcome);
	const already = simulator.requests(probe.route, marker).length;

	simulator.arm(probe.route, marker, outcome);

	let answer: ToolAnswer;

	try {
		answer = await server.call(probe.tool, probe.args(marker ?? ""), 30_000);
	} finally {
		simulator.disarm(probe.route, marker);
	}

	const sent = simulator.requests(probe.route, marker).slice(already);
	const finding = KNOWN[id];

	if (finding == null) {
		assertCell(probe, outcome, answer, sent);

		return;
	}

	try {
		assertCell(probe, outcome, answer, sent);
	} catch (error) {
		t.todo(`${finding}: ${error instanceof Error ? error.message.split("\n", 1)[0] : error}`);

		return;
	}

	throw new Error(`${finding} no longer reproduces for ${id}: remove it from KNOWN`);
}

describe("simulated results", { concurrency: true }, () => {
	for (const probe of PROBES) {
		const outcomes = OUTCOMES.filter((outcome) => outcome !== "empty_list" || hasList(probe.route));

		describe(probe.route, { concurrency: probe.marker !== "none" }, () => {
			for (const outcome of outcomes) it(`${probe.route}.${outcome}`, (t) => runCell(probe, outcome, t));
		});
	}

	it("every cell in KNOWN is a real cell", () => {
		const cells = new Set(PROBES.flatMap((p) => OUTCOMES.map((o) => `${p.route}.${o}`)));

		assert.deepEqual(Object.keys(KNOWN).filter((id) => !cells.has(id)), []);
	});
});

// --- Request bodies ----------------------------------------------------------

interface IngestCase {
	name: string;
	args: Record<string, unknown>;
	check(ex: Exchange): void;
}

function jsonField(ex: Exchange, field: string): Record<string, unknown>[] {
	const raw = (ex.body as Record<string, string> | undefined)?.[field];

	assert.ok(raw != null, `the request carries no ${field} field`);

	const parsed = JSON.parse(raw);

	return Array.isArray(parsed) ? parsed : [parsed];
}

function onlyKeys(items: Record<string, unknown>[], allowed: Set<string>, field: string) {
	for (const [index, item] of items.entries()) {
		const refused = Object.keys(item).filter((key) => !allowed.has(key));

		assert.deepEqual(refused, [], `${field}[${index}] carries keys the API does not accept`);
	}
}

const WIDE = connectorMetadata(0);

function knowledgeText(text: string, title: string | undefined, extra: (item: Record<string, unknown>) => void = () => {}) {
	return (ex: Exchange) => {
		const items = jsonField(ex, "document_metadata");

		onlyKeys(items, DOCUMENT_METADATA_KEYS, "document_metadata");
		assert.equal(items.length, ex.files.documents?.length, "one document_metadata item per uploaded document");
		assert.equal(ex.files.documents?.[0]?.content, text, "the document part is the caller's text");

		if (title != null) assert.equal(ex.files.documents?.[0]?.filename, `${title}.md`);

		extra(items[0]);
	};
}

function memories(check: (items: Record<string, unknown>[]) => void) {
	return (ex: Exchange) => {
		const items = jsonField(ex, "memories");

		onlyKeys(items, MEMORY_ITEM_KEYS, "memories");
		check(items);
	};
}

const INGEST_CASES: IngestCase[] = [
	{
		name: "memory text",
		args: { text: "The user prefers stacked pull requests.", source_id: "m-1" },
		check: memories((items) => assert.equal(items[0].text, "The user prefers stacked pull requests.")),
	},
	{
		name: "memory turns",
		args: { turns: [{ user: "I moved to Pune.", assistant: "Noted." }], source_id: "m-2", user_name: "Riya" },
		check: memories((items) => {
			assert.deepEqual(items[0].user_assistant_pairs, [{ user: "I moved to Pune.", assistant: "Noted." }]);
			assert.equal(items[0].user_name, "Riya");
		}),
	},
	{
		name: "memory items",
		args: { items: [{ text: "one", source_id: "m-3" }, { text: "two", source_id: "m-4", title: "Two" }] },
		check: memories((items) => assert.deepEqual(items.map((i) => i.source_id), ["m-3", "m-4"])),
	},
	{
		name: "memory infer false",
		args: { text: "verbatim", source_id: "m-5", infer: false, additional_metadata: { origin: "e2e" } },
		check: memories((items) => {
			assert.equal(items[0].infer, false);
			assert.deepEqual(items[0].additional_metadata, { origin: "e2e" });
		}),
	},
	{ name: "knowledge text", args: { kind: "knowledge", text: "Untitled document.", source_id: "k-1" }, check: knowledgeText("Untitled document.", undefined) },
	{
		name: "knowledge text titled",
		args: { kind: "knowledge", text: "Grace owns the ledger.", title: "Ledger ownership", source_id: "k-2" },
		check: knowledgeText("Grace owns the ledger.", "Ledger ownership"),
	},
	{
		name: "knowledge metadata",
		args: { kind: "knowledge", text: "Wide.", title: "Wide", source_id: "k-3", metadata: { team: "payments" }, additional_metadata: WIDE },
		check: knowledgeText("Wide.", "Wide", (item) => {
			assert.deepEqual(item.metadata, { team: "payments" });
			assert.deepEqual(item.additional_metadata, WIDE);
		}),
	},
	{
		name: "knowledge relations",
		args: { kind: "knowledge", text: "Related.", title: "Related", source_id: "k-4", relations: { ids: ["k-2"] } },
		check: knowledgeText("Related.", "Related", (item) => assert.ok(JSON.stringify(item.relations).includes("k-2"))),
	},
	{
		name: "knowledge evidence",
		args: { kind: "knowledge", text: "Said.", title: "Said", source_id: "k-5", evidence_kind: "said", evidence_subject: "person:ada" },
		check: knowledgeText("Said.", "Said", (item) => {
			assert.equal(item.evidence_kind, "said");
			assert.equal(item.evidence_subject, "person:ada");
		}),
	},
	{
		name: "knowledge graph",
		args: {
			kind: "knowledge",
			text: "Ada mentors Grace.",
			title: "Mentoring",
			source_id: "k-6",
			graph: { entities: { ada: { name: "Ada", type: "Person" } }, relations: [{ source: "ada", target: "ada", predicate: "knows" }] },
		},
		check: (ex) => {
			knowledgeText("Ada mentors Grace.", "Mentoring")(ex);
			assert.ok(Object.keys(jsonField(ex, "graph_payload")[0]).includes("k-6"), "graph_payload is keyed by the source id");
		},
	},
	{
		name: "knowledge items",
		args: { kind: "knowledge", items: [{ text: "one", source_id: "k-7" }, { text: "two", source_id: "k-8", title: "Two" }] },
		check: (ex) => {
			const items = jsonField(ex, "document_metadata");

			onlyKeys(items, DOCUMENT_METADATA_KEYS, "document_metadata");
			assert.deepEqual(items.map((i) => i.id), ["k-7", "k-8"]);
			assert.deepEqual(ex.files.documents?.map((d) => d.content), ["one", "two"]);
		},
	},
	{
		name: "knowledge file base64",
		args: { file: { filename: "plan.md", content_base64: Buffer.from("# Plan\n").toString("base64") }, source_id: "k-9" },
		check: (ex) => {
			const items = jsonField(ex, "document_metadata");

			onlyKeys(items, DOCUMENT_METADATA_KEYS, "document_metadata");
			assert.deepEqual(items, [{ id: "k-9" }]);
			assert.equal(ex.files.documents?.[0]?.content, "# Plan\n");
		},
	},
	{
		name: "knowledge app",
		args: {
			kind: "knowledge",
			app_knowledge: [{ id: "k-10", title: "Ticket", kind: "ticket", provider: "jira", external_id: "E2E-1", fields: { status: "open" }, additional_metadata: { slack_ts: "1.2" } }],
		},
		check: (ex) => {
			const [item] = jsonField(ex, "app_knowledge");

			assert.equal(item.id, "k-10");
			assert.deepEqual(item.additional_metadata, { slack_ts: "1.2" });
		},
	},
	{
		name: "knowledge collection",
		args: { kind: "knowledge", text: "Scoped.", title: "Scoped", source_id: "k-11", collection: "named" },
		check: (ex) => {
			knowledgeText("Scoped.", "Scoped")(ex);
			assert.equal((ex.body as Record<string, string>).collection, "named");
		},
	},
];

describe("request bodies", { concurrency: true }, () => {
	for (const [index, testCase] of INGEST_CASES.entries()) {
		it(`ingest ${testCase.name} sends only keys the API accepts`, async () => {
			const marker = `sim-body-${index}`;
			const answer = await server.call("hydradb_ingest", { ...testCase.args, database: marker });
			const [sent] = simulator.requests("ingest", marker);

			assert.ok(sent, `no ingest request was sent: ${answer.text}`);
			testCase.check(sent);
		});
	}

	it("update sends only keys the API accepts, with the caller's values", async () => {
		const edit = { database_metadata: { team: "payments" }, additional_metadata: WIDE, acl: ["ada@example.com"] };

		await server.call("hydradb_update", { id: "k-12", collection: "c", database: "sim-body-update", ...edit });
		const [sent] = simulator.requests("update", "sim-body-update");

		assert.ok(sent, "no update request was sent");
		assert.equal(sent.path, "/context/k-12/metadata");
		onlyKeys([sent.body as Record<string, unknown>], UPDATE_BODY_KEYS, "update body");
		assert.deepEqual(missingInObject(sent.body, { collection: "c", ...edit }), []);
	});

	it("feedback sends only keys the API accepts, with the caller's values", async () => {
		await server.call("hydradb_feedback", {
			request_id: "0c82d439-ebc9-4bf2-bc3b-0d64d149cac1",
			rating: "negative",
			feedback: "the owner was missing",
			ground_truth_source_ids: ["k-2"],
			metadata: { run: "e2e" },
			database: "sim-body-feedback",
		});
		const [sent] = simulator.requests("feedback", "sim-body-feedback");

		assert.ok(sent, "no feedback request was sent");
		onlyKeys([sent.body as Record<string, unknown>], FEEDBACK_BODY_KEYS, "feedback body");
		assert.deepEqual(
			missingInObject(sent.body, { request_id: "0c82d439-ebc9-4bf2-bc3b-0d64d149cac1", rating: "negative", feedback: "the owner was missing", metadata: { run: "e2e" } }),
			[],
		);
		assert.deepEqual((sent.body as { ground_truth?: { source_ids?: string[] } }).ground_truth?.source_ids, ["k-2"]);
	});
});

// --- Access control ----------------------------------------------------------

/** Every principal form the API reads, plus characters a query string must escape. */
const PRINCIPALS = ["user_email:alice@e2e.hydradb.test", "bob@e2e.hydradb.test", "domain:e2e.hydradb.test", "group:okta:00g/e2e+ops&1", "__public__"];

interface AclReadCase {
	name: string;
	route: string;
	tool: string;
	args: Record<string, unknown>;
	/** The principals as the API reads them from the recorded request. */
	sent(ex: Exchange): unknown;
}

const fromBody = (ex: Exchange) => (ex.body as Record<string, unknown> | undefined)?.acl;
const fromQuery = (ex: Exchange) => ex.query.getAll("acl");

const ACL_READ_CASES: AclReadCase[] = [
	{ name: "list", route: "list", tool: "hydradb_list", args: { kind: "knowledge" }, sent: fromBody },
	{ name: "list with projected fields", route: "list", tool: "hydradb_list", args: { kind: "knowledge", include_fields: ["title"] }, sent: fromBody },
	{ name: "query", route: "query", tool: "hydradb_query", args: { query: "ledger", collection: "c" }, sent: fromBody },
	{ name: "inspect", route: "inspect", tool: "hydradb_inspect", args: { id: "sim-1" }, sent: fromQuery },
	{ name: "relations of an item", route: "relations", tool: "hydradb_relations", args: { id: "sim-1" }, sent: fromQuery },
	{ name: "relations of a collection", route: "relations", tool: "hydradb_relations", args: {}, sent: fromQuery },
	{ name: "subgraph", route: "subgraph", tool: "hydradb_subgraph", args: { id: "sim-1" }, sent: fromQuery },
];

describe("acl on the wire", { concurrency: true }, () => {
	for (const [index, testCase] of ACL_READ_CASES.entries()) {
		it(`${testCase.name} sends the caller's principals exactly`, async () => {
			const marker = `sim-acl-read-${index}`;
			const answer = await server.call(testCase.tool, { ...testCase.args, acl: PRINCIPALS, database: marker });
			const sent = simulator.requests(testCase.route, marker);

			assert.ok(sent.length >= 1, `no ${testCase.route} request was sent: ${answer.text}`);
			for (const ex of sent) assert.deepEqual(testCase.sent(ex), PRINCIPALS, `${testCase.route} request ${ex.path}`);
		});
	}

	it("update sends the complete replacement acl, once", async () => {
		await server.call("hydradb_update", { id: "k-acl", collection: "c", acl: PRINCIPALS, database: "sim-acl-update" });
		const sent = simulator.requests("update", "sim-acl-update");

		assert.equal(sent.length, 1, `the update was sent ${sent.length} times`);
		assert.deepEqual(fromBody(sent[0]), PRINCIPALS);
	});

	it("update with acl null sends an empty acl, the API's private", async () => {
		await server.call("hydradb_update", { id: "k-acl", collection: "c", acl: null, database: "sim-acl-update-null" });
		const sent = simulator.requests("update", "sim-acl-update-null");

		assert.equal(sent.length, 1, `the update was sent ${sent.length} times`);
		assert.deepEqual(fromBody(sent[0]), []);
	});

	it("app knowledge ingest sends each item's acl, once", async () => {
		await server.call("hydradb_ingest", {
			kind: "knowledge",
			app_knowledge: [
				{ id: "k-acl-1", kind: "custom", fields: { body: "restricted" }, acl: PRINCIPALS },
				{ id: "k-acl-2", kind: "custom", fields: { body: "private" }, acl: ["__private__"] },
				{ id: "k-acl-3", kind: "custom", fields: { body: "open" } },
			],
			database: "sim-acl-ingest",
		});
		const sent = simulator.requests("ingest", "sim-acl-ingest");

		assert.equal(sent.length, 1, `the ingest was sent ${sent.length} times`);
		assert.deepEqual(jsonField(sent[0], "app_knowledge").map((item) => item.acl), [PRINCIPALS, ["__private__"], undefined]);
	});
});

// --- Round trip ----------------------------------------------------------------

describe("round trip", () => {
	it("a recorded page of connector rows keeps every requested field in both views", async () => {
		const page = (fixtures.routes.list.body as { data: { sources: { id: string; additional_metadata: Record<string, unknown> }[] } }).data.sources;
		const rows = page.filter((source) => Object.keys(source.additional_metadata ?? {}).length >= 13);

		assert.ok(rows.length >= 50, `the list fixture holds ${rows.length} connector rows; re-record it`);

		const answer = await server.call("hydradb_list", { kind: "knowledge", page_size: 100, include_fields: ["additional_metadata"], database: "sim-round-trip" });
		const structured = new Map(((answer.structured?.items as Record<string, unknown>[]) ?? []).map((item) => [String(item.id), item]));
		const text = listedRows(answer.text);
		const lost: string[] = [];

		assert.equal(answer.isError, false, answer.text);

		for (const row of rows) {
			const fields = structured.get(row.id)?.fields as Record<string, unknown> | undefined;
			const inStructured = missingInObject(fields?.additional_metadata, row.additional_metadata);
			const inText = missingInText(text.get(row.id) ?? "", row.additional_metadata);

			if (inStructured.length > 0) lost.push(`${row.id} structured: ${inStructured.join(",")}`);
			if (inText.length > 0) lost.push(`${row.id} text: ${inText.join(",")}`);
		}

		assert.deepEqual(lost, []);
	});
});
