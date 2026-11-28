/**
 * Live tier: the real server process against a real HydraDB API.
 *
 * Skips unless HYDRADB_E2E=1. One throwaway database per run: seed every item
 * through `hydradb_ingest`, wait once for indexing, then run scenarios that read
 * back what was written, whole, in both the text and the structured output.
 * See e2e/README.md.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { after, before, describe, it, test, type TestContext } from "node:test";

import { connectorMetadata, listedRows, missingInObject, missingInText } from "./data.js";
import {
	comparable,
	connectHttp,
	type Entry,
	REPO,
	type Session,
	sleep,
	startHttp,
	startStdio,
	type StdioServer,
	throwawayName,
	type ToolAnswer,
} from "./harness.js";
import {
	ACL_ALICE,
	ACL_FLIP,
	ACL_ITEMS,
	ACL_OPEN,
	ALICE,
	ALICE_EMAIL,
	type AclItem,
	APP_METADATA,
	BOB,
	DROPPED,
	FILE_TEXT,
	KEPT_KNOWLEDGE,
	KEPT_MEMORY,
	LARGE_DOCS,
	largeId,
	largeText,
	MISSING_CONNECTOR,
	NAMED,
	PAGE_ROWS,
	pageId,
	SEEDS,
	TEXT,
	type TextId,
	TURNS,
	WIDE_METADATA,
} from "./seeds.js";

// --- Configuration -----------------------------------------------------------

interface LiveConfig {
	baseUrl: string;
	apiKey: string;
	/** A database the caller owns: used for the data scenarios, never deleted. */
	database?: string;
	resultsPath?: string;
	entry: Entry;
}

function readConfig(): LiveConfig | string | null {
	if (process.env.HYDRADB_E2E !== "1") return null;

	const baseUrl = process.env.HYDRADB_E2E_BASE_URL?.trim();
	const apiKey = process.env.HYDRADB_E2E_API_KEY?.trim();

	if (!baseUrl) return "HYDRADB_E2E=1 but HYDRADB_E2E_BASE_URL is not set: the live tier needs the API base URL";

	if (!apiKey) return "HYDRADB_E2E=1 but HYDRADB_E2E_API_KEY is not set: the live tier needs an API key";

	const entry = process.env.HYDRADB_E2E_SERVER === "dist" ? "dist" : "source";

	return {
		baseUrl: baseUrl.replace(/\/+$/, ""),
		apiKey,
		database: process.env.HYDRADB_E2E_DATABASE?.trim() || undefined,
		resultsPath: process.env.HYDRADB_E2E_RESULTS?.trim() || undefined,
		entry,
	};
}

const config = readConfig();

// --- Run state ---------------------------------------------------------------

type Status = "pass" | "fail" | "skip" | "known_issue";

interface ScenarioResult {
	id: string;
	status: Status;
	duration_ms: number;
	detail?: string;
}

interface Run {
	cfg: LiveConfig;
	stdio: StdioServer;
	database: string;
	ownsDatabase: boolean;
	lifecycleDatabase: string;
	graphDatabase: string;
	/** A second graph database, for the documented write patterns. */
	scratchGraphDatabase: string;
	seeded: Map<string, ToolAnswer>;
	/** Tools each scenario's seed calls used, so its declared tools count as called. */
	seedCalls: Map<string, Set<string>>;
	statuses: Map<string, string>;
	startedAt: Date;
}

let run: Run | undefined;
let setupError: string | undefined;
const results: ScenarioResult[] = [];

function current(): Run {
	if (run == null) throw new Error(`setup did not finish: ${setupError ?? "unknown error"}`);

	return run;
}

// --- Helpers -----------------------------------------------------------------

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function brief(answer: ToolAnswer): string {
	return answer.text.length > 600 ? `${answer.text.slice(0, 600)}…` : answer.text;
}

function ok(answer: ToolAnswer, what: string): Record<string, unknown> {
	assert.equal(answer.isError, false, `${what} failed: ${brief(answer)}`);

	return answer.structured ?? {};
}

function failed(answer: ToolAnswer, what: string, pattern: RegExp) {
	assert.equal(answer.isError, true, `${what} should fail, but answered: ${brief(answer)}`);
	assert.match(answer.text, pattern, `${what} failed without an honest reason: ${brief(answer)}`);
}

function items(structured: Record<string, unknown>, key = "items"): Record<string, unknown>[] {
	const value = structured[key];

	return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

function idsOf(structured: Record<string, unknown>, key = "items"): string[] {
	return items(structured, key).map((item) => String(item.id));
}

/** The seed answer for `id`, failing the scenario with the API's refusal when its ingest failed. */
function seededAnswer(id: string): ToolAnswer {
	const answer = current().seeded.get(id);

	assert.ok(answer, `no seed call carried ${id}`);
	assert.equal(answer.isError, false, `the ingest that seeds ${id} was refused: ${brief(answer)}`);

	return answer;
}

function requireIndexed(...ids: string[]) {
	for (const id of ids) {
		seededAnswer(id);
		assert.equal(current().statuses.get(id), "completed", `${id} did not finish indexing (status: ${current().statuses.get(id) ?? "unknown"})`);
	}
}

async function eventually(what: string, budgetMs: number, check: () => Promise<boolean>) {
	const deadline = Date.now() + budgetMs;

	while (!(await check())) {
		if (Date.now() > deadline) assert.fail(`${what} did not happen within ${budgetMs / 1000}s`);

		await sleep(3_000);
	}
}

function parseStatuses(text: string): Map<string, string> {
	const found = new Map<string, string>();

	for (const match of text.matchAll(/^\s+- (\S+): (\S+)/gm)) found.set(match[1], match[2]);

	return found;
}

/** Not cached: a scenario that declares hydradb_list_collections must call it whatever ran before. */
async function defaultCollection(call: Caller): Promise<string> {
	const listed = ok(await call("hydradb_list_collections", {}), "hydradb_list_collections");
	const names = (listed.collections as string[] | undefined) ?? [];
	const generated = names.filter((name) => name !== NAMED && name !== DROPPED);

	assert.equal(generated.length, 1, `expected one workspace default collection besides ours, got ${JSON.stringify(names)}`);

	return generated[0];
}

// --- Scenarios ---------------------------------------------------------------

type Caller = (name: string, args?: Record<string, unknown>) => Promise<ToolAnswer>;

interface Ctx {
	call: Caller;
	run: Run;
	/**
	 * Only a failure inside `body` is the known issue. Everything else in the
	 * scenario is a precondition and fails it outright.
	 */
	expectFixed(body: () => Promise<void> | void): Promise<void>;
}

interface Scenario {
	id: string;
	/** Every tool the scenario calls. Completeness is checked against this. */
	tools: string[];
	knownIssue?: string;
	run(ctx: Ctx): Promise<void>;
}

/** Seed assertion: the ingest was accepted with exactly its ids, and they all finished indexing. */
function ingestScenario(id: string): Scenario {
	return {
		id,
		tools: ["hydradb_ingest"],
		async run() {
			for (const seed of SEEDS.filter((s) => s.scenario === id)) {
				const structured = ok(seededAnswer(seed.ids[0]), `ingest of ${seed.ids.join(", ")}`);

				assert.deepEqual([...((structured.accepted_ids as string[]) ?? [])].sort(), [...seed.ids].sort());
				assert.deepEqual(structured.rejected_items ?? [], []);
				assert.equal(structured.failed_count, 0);
				requireIndexed(...seed.ids);
			}
		},
	};
}

function connectorMissing(tool: string, args: Record<string, unknown>): Scenario {
	return {
		id: `connectors.${tool.replace("hydradb_connector_", "")}.missing_id`,
		tools: [tool],
		async run({ call }) {
			failed(await call(tool, { connector_id: MISSING_CONNECTOR, ...args }), tool, /not found/i);
		},
	};
}

// --- Access control ----------------------------------------------------------

/** One identity the read scenarios answer as, and which of ACL_ITEMS it must see. */
interface Reader {
	name: string;
	/** Undefined sends no `acl`: the API key's own unscoped read. */
	acl?: string[];
	sees: AclItem[];
}

const READERS: Reader[] = [
	{ name: "alice", acl: [ALICE], sees: [ACL_OPEN, ACL_ALICE] },
	{ name: "alice_bare_email", acl: [ALICE_EMAIL], sees: [ACL_OPEN, ACL_ALICE] },
	{ name: "bob", acl: [BOB], sees: [ACL_OPEN] },
	{ name: "public", acl: ["__public__"], sees: [ACL_OPEN] },
	{ name: "unscoped", sees: ACL_ITEMS },
];

const ACL_IDS = ACL_ITEMS.map((item) => item.id);
const scopedAs = (reader: Reader) => (reader.acl ? { acl: reader.acl } : {});
const sortedIds = (items: AclItem[]) => items.map((item) => item.id).sort();
const hiddenFrom = (reader: Reader) => ACL_ITEMS.filter((item) => !reader.sees.includes(item));

/**
 * No title or body of an item the reader may not see, in the text or the
 * structured output. A denied inspect may echo the id it was asked for, so ids
 * are checked only where the caller never named them.
 */
function assertHides(what: string, answer: ToolAnswer, hidden: AclItem[], checkIds: boolean) {
	const shown = `${answer.text}\n${JSON.stringify(answer.structured ?? null)}`;

	for (const item of hidden) {
		const leaked = [item.title, item.body, ...(checkIds ? [item.id] : [])].filter((secret) => shown.includes(secret));

		assert.deepEqual(leaked, [], `${what} leaked ${item.id}`);
	}
}

/** Follow-up args the server hands back must keep the caller's principals, or the next call reads unscoped. */
function assertFollowUpsKeep(what: string, rows: Record<string, unknown>[], reader: Reader) {
	for (const row of rows) {
		assert.deepEqual((row.inspect_args as Record<string, unknown> | undefined)?.acl, reader.acl, `${what}: inspect_args of ${row.id} lost the caller's acl`);
	}
}

/** Which ACL item each relation was extracted from, by its chunk id. */
function relationOwners(page: Record<string, unknown>): string[] {
	const owners = items(page, "relations").map((r) => String(r.chunk_id).replace(/_chunk_\d+$/, ""));

	return [...new Set(owners.filter((owner) => ACL_IDS.includes(owner)))].sort();
}

interface AclRead {
	read: string;
	tools: string[];
	check(call: Caller, reader: Reader): Promise<void>;
}

const ACL_READS: AclRead[] = [
	{
		read: "list",
		tools: ["hydradb_list"],
		async check(call, reader) {
			const answer = await call("hydradb_list", { kind: "knowledge", ids: ACL_IDS, ...scopedAs(reader) });
			const listed = ok(answer, `hydradb_list as ${reader.name}`);

			assert.deepEqual(idsOf(listed).sort(), sortedIds(reader.sees), "structuredContent.items");
			assert.deepEqual([...listedRows(answer.text).keys()].sort(), sortedIds(reader.sees), "the text listing");
			assertFollowUpsKeep("hydradb_list", items(listed), reader);
			assertHides(`hydradb_list as ${reader.name}`, answer, hiddenFrom(reader), true);
		},
	},
	{
		read: "query",
		tools: ["hydradb_query"],
		async check(call, reader) {
			const answer = await call("hydradb_query", { query: "heron migration", kind: "knowledge", source_ids: ACL_IDS, structured: true, ...scopedAs(reader) });
			const structured = ok(answer, `hydradb_query as ${reader.name}`);
			const inText = new Set([...answer.text.matchAll(/^Chunk \d+\s+\[id: ([^\]]+)\]/gm)].map((m) => m[1]));

			assert.deepEqual([...new Set(idsOf(structured, "sources"))].sort(), sortedIds(reader.sees), "structuredContent.sources");
			assert.deepEqual([...inText].sort(), sortedIds(reader.sees), "the ids in the text");
			for (const item of reader.sees) assert.ok(answer.text.includes(item.body), `${item.id}: its stored text is missing from the answer`);
			assertFollowUpsKeep("hydradb_query", items(structured, "sources"), reader);
			assertHides(`hydradb_query as ${reader.name}`, answer, hiddenFrom(reader), true);
		},
	},
	{
		read: "inspect",
		tools: ["hydradb_inspect"],
		async check(call, reader) {
			for (const item of ACL_ITEMS) {
				const answer = await call("hydradb_inspect", { id: item.id, ...scopedAs(reader) });
				const what = `hydradb_inspect ${item.id} as ${reader.name}`;

				if (reader.sees.includes(item)) {
					assert.ok(String(ok(answer, what).content).includes(item.body), `${what}: the stored text is missing`);
					continue;
				}

				failed(answer, what, /\b404\b.*not found/i);
				assert.ok(answer.text.includes(item.id), `${what}: the refusal does not name the id it looked for: ${brief(answer)}`);
				assertHides(what, answer, [item], false);
			}
		},
	},
	{
		read: "subgraph",
		tools: ["hydradb_subgraph"],
		async check(call, reader) {
			const answer = await call("hydradb_subgraph", { id: ACL_OPEN.id, depth: 1, ...scopedAs(reader) });
			const members = idsOf(ok(answer, `hydradb_subgraph of ${ACL_OPEN.id} as ${reader.name}`), "members");

			assert.deepEqual(members.sort(), sortedIds(reader.sees), "the members reached from the open item");
			assertHides(`hydradb_subgraph as ${reader.name}`, answer, hiddenFrom(reader), true);

			for (const item of hiddenFrom(reader)) {
				const denied = await call("hydradb_subgraph", { id: item.id, depth: 1, ...scopedAs(reader) });
				const what = `hydradb_subgraph of ${item.id} as ${reader.name}`;

				assert.deepEqual(idsOf(ok(denied, what), "members"), [], `${what} has members`);
				assertHides(what, denied, [item], false);
			}
		},
	},
	{
		read: "relations",
		tools: ["hydradb_relations"],
		async check(call, reader) {
			const whole = ok(await call("hydradb_relations", { kind: "knowledge", limit: 200 }), "hydradb_relations unscoped");

			assert.equal(whole.has_more, false, "precondition: limit 200 reads the whole collection");
			assert.deepEqual(relationOwners(whole), [...ACL_IDS].sort(), "precondition: every ACL item has extracted relations");

			const answer = await call("hydradb_relations", { kind: "knowledge", limit: 200, ...scopedAs(reader) });

			assert.deepEqual(relationOwners(ok(answer, `hydradb_relations as ${reader.name}`)), sortedIds(reader.sees), "the items the collection's relations came from");
			assertHides(`hydradb_relations as ${reader.name}`, answer, hiddenFrom(reader), true);

			for (const item of hiddenFrom(reader)) {
				const denied = await call("hydradb_relations", { id: item.id, kind: "knowledge", ...scopedAs(reader) });
				const what = `hydradb_relations of ${item.id} as ${reader.name}`;

				assert.deepEqual(items(ok(denied, what), "relations"), [], `${what} returned relations`);
				assertHides(what, denied, [item], false);
			}
		},
	},
];

/** Every read that takes `acl`, as every reader. */
const ACL_READ_SCENARIOS: Scenario[] = ACL_READS.flatMap((read) =>
	READERS.map((reader) => ({
		id: `acl.${read.read}.${reader.name}`,
		tools: read.tools,
		async run({ call }: Ctx) {
			requireIndexed(...ACL_IDS);
			await read.check(call, reader);
		},
	})),
);

/** Whether Bob can reach ACL_FLIP through list, query and inspect. */
async function bobSeesFlip(call: Caller): Promise<boolean[]> {
	const asBob = { acl: [BOB] };
	const listed = ok(await call("hydradb_list", { kind: "knowledge", ids: [ACL_FLIP.id], ...asBob }), "hydradb_list as bob");
	const queried = ok(await call("hydradb_query", { query: "heron flip memo", kind: "knowledge", source_ids: [ACL_FLIP.id], structured: true, ...asBob }), "hydradb_query as bob");
	const inspected = await call("hydradb_inspect", { id: ACL_FLIP.id, ...asBob });

	return [idsOf(listed).includes(ACL_FLIP.id), idsOf(queried, "sources").includes(ACL_FLIP.id), !inspected.isError];
}

const ACL_SCENARIOS: Scenario[] = [
	...ACL_READ_SCENARIOS,
	{
		id: "acl.update.takes_effect",
		tools: ["hydradb_update", "hydradb_list", "hydradb_query", "hydradb_inspect", "hydradb_list_collections"],
		async run({ call }) {
			requireIndexed(ACL_FLIP.id);
			const collection = await defaultCollection(call);
			const replace = async (acl: string[]) => {
				const updated = ok(await call("hydradb_update", { id: ACL_FLIP.id, collection, acl }), `hydradb_update acl ${JSON.stringify(acl)}`);

				assert.equal(updated.acl_updated, true, "the ACL was not reported as replaced");
				assert.equal(updated.vector_acl_synced, true, "the search index ACL was not reported as synchronized");
			};

			assert.deepEqual(await bobSeesFlip(call), [false, false, false], "precondition: Bob cannot see Alice's item");

			try {
				await replace(["__public__"]);
				await eventually("Bob to see the item made public", 60_000, async () => (await bobSeesFlip(call)).every(Boolean));
			} finally {
				await replace([ALICE]);
			}

			await eventually("Bob to lose the item put back to Alice", 60_000, async () => !(await bobSeesFlip(call)).some(Boolean));
		},
	},
	{
		id: "acl.http.list",
		tools: ["hydradb_list"],
		async run({ call, run: r }) {
			requireIndexed(...ACL_IDS);
			const server = await startHttp(r.cfg.entry, { HYDRADB_BASE_URL: r.cfg.baseUrl });

			try {
				const http = await connectHttp(server.url, { Authorization: `Bearer ${r.cfg.apiKey}`, "X-HydraDB-Database": r.database });

				try {
					for (const reader of READERS.filter((each) => each.name === "alice" || each.name === "bob")) {
						const args = { kind: "knowledge", ids: ACL_IDS, ...scopedAs(reader) };
						const viaHttp = await http.call("hydradb_list", args);

						assert.deepEqual(idsOf(ok(viaHttp, `hydradb_list over HTTP as ${reader.name}`)).sort(), sortedIds(reader.sees));
						assert.equal(comparable(viaHttp), comparable(await call("hydradb_list", args)), `hydradb_list as ${reader.name} answered differently over HTTP`);
					}
				} finally {
					await http.close();
				}
			} finally {
				await server.stop();
			}
		},
	},
	{
		id: "acl.inspect.access_list",
		tools: ["hydradb_inspect"],
		knownIssue: "F-mcp-14",
		async run({ call, expectFixed }) {
			requireIndexed(ACL_ALICE.id);
			const answer = await call("hydradb_inspect", { id: ACL_ALICE.id, acl: [ALICE] });
			const content = String(ok(answer, "hydradb_inspect as alice").content);

			assert.ok(content.includes(ACL_ALICE.body), "precondition: Alice reads her own item");
			await expectFixed(() => {
				const internal = [...content.matchAll(/"(acl[a-z0-9_]*)"\s*:/g)].map((m) => m[1]);

				assert.deepEqual(internal, [], "an app item's inspected content carries its access list and the API's ACL bookkeeping");
			});
		},
	},
];

const SCENARIOS: Scenario[] = [
	...[
		"ingest.memory.text",
		"ingest.memory.turns",
		"ingest.memory.items",
		"ingest.memory.infer_false",
		"ingest.knowledge.text",
		"ingest.knowledge.text_titled",
		"ingest.knowledge.metadata",
		"ingest.knowledge.relations",
		"ingest.knowledge.evidence",
		"ingest.knowledge.graph",
		"ingest.knowledge.items",
		"ingest.knowledge.page",
		"ingest.knowledge.large",
		"ingest.knowledge.file_base64",
		"ingest.knowledge.app",
		"ingest.knowledge.acl",
		"ingest.knowledge.collection",
	].map(ingestScenario),
	...ACL_SCENARIOS,
	{
		id: "status.terminal",
		tools: ["hydradb_status"],
		async run({ call }) {
			const answer = await call("hydradb_status", { ids: ["e2e-k-titled", "e2e-m-text", "e2e-k-file"] });

			ok(answer, "hydradb_status");
			assert.deepEqual(
				Object.fromEntries(parseStatuses(answer.text)),
				{ "e2e-k-titled": "completed", "e2e-m-text": "completed", "e2e-k-file": "completed" },
			);
			assert.match(answer.text, /All sources have reached a terminal state/);

			const named = await call("hydradb_status", { ids: ["e2e-k-named"], collection: NAMED });

			ok(named, "hydradb_status in a named collection");
			assert.equal(parseStatuses(named.text).get("e2e-k-named"), "completed");
		},
	},
	{
		id: "ingest.knowledge.default_title",
		tools: ["hydradb_list"],
		async run({ call }) {
			requireIndexed("e2e-k-plain");
			const listed = ok(await call("hydradb_list", { kind: "knowledge", ids: ["e2e-k-plain"] }), "hydradb_list");
			const title = String(items(listed)[0]?.title);

			assert.doesNotMatch(title, /\.\.md$/, `a title derived from text ending in "." is stored as ${JSON.stringify(title)}`);
		},
	},
	{
		id: "list.knowledge",
		tools: ["hydradb_list"],
		async run({ call }) {
			requireIndexed(...KEPT_KNOWLEDGE);
			const answer = await call("hydradb_list", { kind: "knowledge", page_size: 100 });
			const listed = ok(answer, "hydradb_list knowledge");
			const rows = listedRows(answer.text);
			const ids = idsOf(listed);

			for (const id of KEPT_KNOWLEDGE) {
				assert.ok(ids.includes(id), `${id} missing from structuredContent.items`);
				assert.ok(rows.has(id), `${id} missing from the text listing`);
			}

			const titled = items(listed).find((item) => item.id === "e2e-k-titled");

			assert.equal(titled?.title, "Ledger ownership.md");
			assert.match(rows.get("e2e-k-titled") ?? "", /Ledger ownership\.md/);
			assert.equal(listed.has_more, false);
		},
	},
	{
		id: "list.memory",
		tools: ["hydradb_list"],
		async run({ call }) {
			requireIndexed(...KEPT_MEMORY);
			const answer = await call("hydradb_list", { kind: "memory", page_size: 100 });
			const ids = idsOf(ok(answer, "hydradb_list memory"));
			const lines = new Set([...answer.text.matchAll(/^\d+\. \[([^\]]+)\]/gm)].map((m) => m[1]));

			for (const id of KEPT_MEMORY) {
				assert.ok(ids.includes(id), `${id} missing from structuredContent.items`);
				assert.ok(lines.has(id), `${id} missing from the text`);
			}

			assert.equal(answer.structured?.has_more, false);
		},
	},
	{
		id: "list.memory.content",
		tools: ["hydradb_list"],
		knownIssue: "F-mcp-6",
		async run({ call, expectFixed }) {
			requireIndexed("e2e-m-text", "e2e-m-item-2");
			const answer = await call("hydradb_list", { kind: "memory", ids: ["e2e-m-text", "e2e-m-item-2"] });
			const byId = new Map(items(ok(answer, "hydradb_list memory")).map((item) => [String(item.id), item]));

			assert.equal(byId.size, 2, "precondition: both memories are listed");
			await expectFixed(() => {
				for (const id of ["e2e-m-text", "e2e-m-item-2"] as const) {
					assert.equal(byId.get(id)?.content, TEXT[id], `${id}: structuredContent.items[].content is not the stored text`);
					assert.ok(answer.text.includes(`[${id}] ${TEXT[id]}`), `${id}: the listing does not print the stored text`);
				}
			});
		},
	},
	{
		id: "list.all",
		tools: ["hydradb_list"],
		async run({ call }) {
			requireIndexed(...KEPT_KNOWLEDGE, ...KEPT_MEMORY);
			const answer = await call("hydradb_list", { kind: "all", page_size: 100 });
			const ids = idsOf(ok(answer, "hydradb_list all"));
			const rows = listedRows(answer.text);

			for (const id of [...KEPT_KNOWLEDGE, ...KEPT_MEMORY]) {
				assert.ok(ids.includes(id), `${id} missing from structuredContent.items`);
				assert.ok(rows.has(id), `${id} missing from the text`);
			}
		},
	},
	{
		id: "list.include_fields.round_trip",
		tools: ["hydradb_list"],
		async run({ call }) {
			requireIndexed("e2e-k-wide", ...Array.from({ length: PAGE_ROWS }, (_, i) => pageId(i)));

			const single = await call("hydradb_list", { kind: "knowledge", ids: ["e2e-k-wide"], include_fields: ["additional_metadata"] });
			const one = ok(single, "hydradb_list one row");
			const row = items(one).find((item) => item.id === "e2e-k-wide");

			assert.deepEqual(missingInObject((row?.fields as Record<string, unknown>)?.additional_metadata, WIDE_METADATA), [], "keys lost from structuredContent");
			assert.deepEqual(missingInText(listedRows(single.text).get("e2e-k-wide") ?? "", WIDE_METADATA), [], "keys lost from the text");

			const page = await call("hydradb_list", { kind: "knowledge", page_size: 100, include_fields: ["additional_metadata"] });
			const full = ok(page, "hydradb_list full page");
			const rows = listedRows(page.text);
			const byId = new Map(items(full).map((item) => [String(item.id), item]));
			const lost: string[] = [];

			for (let i = 0; i < PAGE_ROWS; i++) {
				const expected = connectorMetadata(i + 1);
				const structuredMissing = missingInObject((byId.get(pageId(i))?.fields as Record<string, unknown>)?.additional_metadata, expected);
				const textMissing = missingInText(rows.get(pageId(i)) ?? "", expected);

				if (structuredMissing.length > 0) lost.push(`${pageId(i)} structured: ${structuredMissing.join(",")}`);
				if (textMissing.length > 0) lost.push(`${pageId(i)} text: ${textMissing.join(",")}`);
			}

			assert.deepEqual(lost, [], "a full page lost connector metadata");
			assert.deepEqual(missingInText(rows.get("e2e-k-wide") ?? "", WIDE_METADATA), [], "the wide row lost keys on a full page");
		},
	},
	{
		id: "list.filter.additional_metadata",
		tools: ["hydradb_list"],
		async run({ call }) {
			requireIndexed("e2e-k-wide");
			const exact = ok(
				await call("hydradb_list", { kind: "knowledge", additional_metadata: { slack_ts: WIDE_METADATA.slack_ts } }),
				"hydradb_list by additional_metadata",
			);

			assert.deepEqual(idsOf(exact), ["e2e-k-wide"]);

			const shared = ok(
				await call("hydradb_list", { kind: "knowledge", page_size: 100, additional_metadata: { channel_name: WIDE_METADATA.channel_name } }),
				"hydradb_list by a shared key",
			);

			assert.equal(idsOf(shared).length, PAGE_ROWS + 1);
		},
	},
	{
		id: "list.filter.metadata",
		tools: ["hydradb_list"],
		async run({ call }) {
			requireIndexed("e2e-k-wide");
			const listed = ok(await call("hydradb_list", { kind: "knowledge", metadata: { team: "payments" }, include_fields: ["metadata"] }), "hydradb_list by metadata");

			assert.deepEqual(idsOf(listed), ["e2e-k-wide"]);
			assert.deepEqual((items(listed)[0]?.fields as Record<string, unknown>)?.metadata, { team: "payments" });
		},
	},
	{
		id: "list.external_id",
		tools: ["hydradb_list"],
		async run({ call }) {
			requireIndexed("e2e-k-app");
			const answer = await call("hydradb_list", {
				kind: "knowledge",
				external_id: "E2E-1",
				provider: "jira",
				include_fields: ["title", "additional_metadata"],
			});
			const listed = ok(answer, "hydradb_list by external_id");

			assert.deepEqual(idsOf(listed), ["e2e-k-app"]);
			assert.deepEqual(missingInObject((items(listed)[0]?.fields as Record<string, unknown>)?.additional_metadata, APP_METADATA), []);
			assert.deepEqual(missingInText(listedRows(answer.text).get("e2e-k-app") ?? "", APP_METADATA), []);
		},
	},
	{
		id: "list.collection",
		tools: ["hydradb_list"],
		async run({ call }) {
			requireIndexed("e2e-k-named");
			const listed = ok(await call("hydradb_list", { kind: "knowledge", collection: NAMED }), "hydradb_list in a named collection");

			assert.deepEqual(idsOf(listed), ["e2e-k-named"]);
			assert.equal((listed.resolved_scope as Record<string, unknown>)?.collection, NAMED);
		},
	},
	{
		id: "list.ids.missing",
		tools: ["hydradb_list"],
		async run({ call }) {
			requireIndexed("e2e-k-titled");
			const answer = await call("hydradb_list", { kind: "knowledge", ids: ["e2e-k-does-not-exist"] });

			assert.deepEqual(idsOf(ok(answer, "hydradb_list of a missing id")), []);
			assert.match(answer.text, /e2e-k-does-not-exist/, `the answer does not name the id it looked for: ${answer.text}`);
			assert.doesNotMatch(answer.text, /No sources found in the workspace default/, `the answer reads as an empty database: ${answer.text}`);
		},
	},
	{
		id: "inspect.content",
		tools: ["hydradb_inspect"],
		async run({ call }) {
			const ids: TextId[] = [
				"e2e-k-plain",
				"e2e-k-titled",
				"e2e-k-wide",
				"e2e-k-rel",
				"e2e-k-evidence",
				"e2e-k-graph",
				"e2e-k-item-1",
				"e2e-k-item-2",
				"e2e-m-text",
				"e2e-m-item-1",
				"e2e-m-item-2",
				"e2e-m-raw",
			];

			requireIndexed(...ids);

			for (const id of ids) {
				const answer = await call("hydradb_inspect", { id });
				const inspected = ok(answer, `hydradb_inspect ${id}`);

				assert.equal(inspected.content, TEXT[id], `${id} stored content`);
				assert.equal(inspected.content_sha256, sha256(TEXT[id]), `${id} sha256`);
				assert.equal(inspected.complete, true);
				assert.ok(answer.text.includes(TEXT[id]), `${id} content in the text`);
			}
		},
	},
	{
		id: "inspect.turns",
		tools: ["hydradb_inspect"],
		async run({ call }) {
			requireIndexed("e2e-m-turns");
			const answer = await call("hydradb_inspect", { id: "e2e-m-turns" });
			const content = String(ok(answer, "hydradb_inspect turns").content);

			for (const turn of TURNS) {
				assert.ok(content.includes(turn.user), "the user turn is stored");
				assert.ok(content.includes(turn.assistant), "the assistant turn is stored");
			}
		},
	},
	{
		id: "inspect.file",
		tools: ["hydradb_inspect"],
		async run({ call }) {
			requireIndexed("e2e-k-file");
			const answer = await call("hydradb_inspect", { id: "e2e-k-file" });
			const inspected = ok(answer, "hydradb_inspect file");

			assert.equal(String(inspected.content).trim(), FILE_TEXT.trim());
			assert.ok(answer.text.includes("The payments team migrates the ledger"), "file content in the text");
		},
	},
	{
		id: "inspect.url",
		tools: ["hydradb_inspect"],
		async run({ call }) {
			requireIndexed("e2e-k-file");
			const answer = await call("hydradb_inspect", { id: "e2e-k-file", mode: "url", expiry_seconds: 60 });
			const url = String(ok(answer, "hydradb_inspect url").download_url);

			assert.match(url, /^https:\/\//);
			assert.ok(answer.text.includes(url), "the link is in the text");
		},
	},
	{
		id: "inspect.pages",
		tools: ["hydradb_inspect"],
		async run({ call }) {
			requireIndexed(largeId(0));
			const expected = largeText(0);
			let args: Record<string, unknown> | undefined = { id: largeId(0), limit: 4_000 };
			let joined = "";
			let slices = 0;

			while (args) {
				const slice = ok(await call("hydradb_inspect", args), `hydradb_inspect slice ${slices}`);

				joined += String(slice.content);
				slices++;
				assert.equal(slice.content_sha256, sha256(expected), "every slice names the whole document's hash");
				args = slice.has_more === true ? (slice.next_args as Record<string, unknown>) : undefined;
				assert.ok(slices < 10, "slicing did not end");
			}

			assert.ok(slices >= 3, `a ${expected.length}-character document in 4,000-character slices took ${slices}`);
			assert.equal(joined, expected);
		},
	},
	{
		id: "query.knowledge",
		tools: ["hydradb_query"],
		async run({ call }) {
			requireIndexed("e2e-k-titled");
			const answer = await call("hydradb_query", { query: "Who owns the ledger service?", kind: "knowledge", structured: true });
			const found = idsOf(ok(answer, "hydradb_query knowledge"), "sources");

			assert.ok(found.includes("e2e-k-titled"), `e2e-k-titled not among ${JSON.stringify(found)}`);
			assert.ok(answer.text.includes("[id: e2e-k-titled]"));
		},
	},
	{
		id: "query.memory",
		tools: ["hydradb_query"],
		async run({ call }) {
			requireIndexed("e2e-m-text");
			const answer = await call("hydradb_query", { query: "How does the user like pull requests?", kind: "memory", structured: true });
			const found = idsOf(ok(answer, "hydradb_query memory"), "sources");

			assert.ok(found.includes("e2e-m-text"), `e2e-m-text not among ${JSON.stringify(found)}`);
			assert.ok(answer.text.includes("[id: e2e-m-text]"));
		},
	},
	{
		id: "query.source_ids",
		tools: ["hydradb_query"],
		async run({ call }) {
			requireIndexed("e2e-k-titled");
			const answer = await call("hydradb_query", { query: "ledger", kind: "knowledge", source_ids: ["e2e-k-titled"], structured: true });
			const found = idsOf(ok(answer, "hydradb_query by source_ids"), "sources");

			assert.deepEqual([...new Set(found)], ["e2e-k-titled"]);
		},
	},
	{
		id: "query.collection",
		tools: ["hydradb_query"],
		async run({ call }) {
			requireIndexed("e2e-k-named");
			const answer = await call("hydradb_query", { query: "Where are invoices exported?", kind: "knowledge", collection: NAMED, structured: true });
			const structured = ok(answer, "hydradb_query in a named collection");

			assert.deepEqual([...new Set(idsOf(structured, "sources"))], ["e2e-k-named"]);
			assert.equal((structured.resolved_scope as Record<string, unknown>)?.collection, NAMED);
		},
	},
	{
		id: "query.metadata_filter",
		tools: ["hydradb_query"],
		async run({ call }) {
			requireIndexed("e2e-k-wide");
			const answer = await call("hydradb_query", { query: "ledger failover drill", kind: "knowledge", metadata_filters: { team: "payments" }, structured: true });

			assert.deepEqual([...new Set(idsOf(ok(answer, "hydradb_query with metadata_filters"), "sources"))], ["e2e-k-wide"]);
		},
	},
	{
		id: "query.markdown",
		tools: ["hydradb_query"],
		async run({ call }) {
			requireIndexed("e2e-k-titled");
			const answer = await call("hydradb_query", {
				query: "Who owns the ledger service?",
				kind: "knowledge",
				source_ids: ["e2e-k-titled"],
				response_format: "markdown",
			});

			ok(answer, "hydradb_query markdown");
			assert.ok(answer.text.includes(TEXT["e2e-k-titled"]), `the stored chunk is missing from the markdown: ${brief(answer)}`);
		},
	},
	{
		id: "query.structured.truncation",
		tools: ["hydradb_query"],
		knownIssue: "F-mcp-5",
		async run({ call, expectFixed }) {
			requireIndexed(...Array.from({ length: LARGE_DOCS }, (_, d) => largeId(d)));
			const answer = await call("hydradb_query", {
				query: "ledger failover drill reconciliation of balances",
				kind: "knowledge",
				detail: "full",
				structured: true,
				max_results: 50,
				mode: "fast",
			});
			const structured = ok(answer, "hydradb_query large");

			assert.match(answer.text, /\[response truncated/, "precondition: the text must be cut for this scenario to mean anything");

			const shown = new Set([...answer.text.matchAll(/\[id: ([^\]]+)\]/g)].map((m) => m[1]));
			const unshown = idsOf(structured, "sources").filter((id) => !shown.has(id));

			await expectFixed(() => {
				assert.ok(
					Object.keys(structured).some((key) => /truncat|omitted|shown/.test(key)),
					`structuredContent does not say the text was cut (keys: ${Object.keys(structured).join(", ")})`,
				);
				assert.deepEqual(unshown, [], "structuredContent.sources lists ids the text left out");
			});
		},
	},
	{
		id: "relations.item",
		tools: ["hydradb_relations"],
		async run({ call }) {
			requireIndexed("e2e-k-graph");
			const answer = await call("hydradb_relations", { id: "e2e-k-graph", kind: "knowledge" });
			const structured = ok(answer, "hydradb_relations item");
			const relations = items(structured, "relations");

			assert.equal(structured.id, "e2e-k-graph");
			assert.ok(
				relations.some((r) => /ada/i.test(String(r.from)) && /grace/i.test(String(r.to)) && /mentor/i.test(String(r.predicate))),
				`the caller's graph edge Ada mentors Grace is missing: ${JSON.stringify(relations)}`,
			);
			assert.match(answer.text, /mentor/i);
		},
	},
	{
		id: "relations.collection",
		tools: ["hydradb_relations"],
		async run({ call }) {
			requireIndexed("e2e-k-graph");
			const answer = await call("hydradb_relations", { kind: "knowledge", limit: 50 });
			const page = ok(answer, "hydradb_relations collection");
			const shown = items(page, "relations").length;

			assert.ok(shown > 0, "the seeded collection has relations");
			assert.equal(page.shown, shown);
			assert.match(answer.text, new RegExp(`^${shown} relations? for this collection:`));

			const tail = page.has_more === true ? /More relations exist: pass cursor=/ : /That is all of them|returned no cursor/;

			assert.match(answer.text, tail, "the text and structuredContent disagree about more pages");
		},
	},
	{
		id: "relations.paging",
		tools: ["hydradb_relations"],
		knownIssue: "F-mcp-7",
		async run({ call, expectFixed }) {
			requireIndexed("e2e-k-graph");
			const key = (r: Record<string, unknown>) => [r.from, r.predicate, r.to, r.chunk_id].join("|");
			const whole = ok(await call("hydradb_relations", { kind: "knowledge", limit: 200 }), "hydradb_relations limit 200");
			const all = new Set(items(whole, "relations").map(key));

			assert.ok(all.size > 2, `precondition: the collection needs more than 2 relations, it has ${all.size}`);
			assert.equal(whole.has_more, false, "precondition: limit 200 reads the whole collection");

			await expectFixed(async () => {
				const seen = new Set<string>();
				let args: Record<string, unknown> | undefined = { kind: "knowledge", limit: 2 };

				for (let pages = 0; args; pages++) {
					assert.ok(pages < 2 * all.size, "paging did not end");

					const answer = await call("hydradb_relations", args);
					const page = ok(answer, `hydradb_relations page ${pages + 1}`);
					const relations = items(page, "relations");
					const tail = answer.text.match(/(That is all of them|More relations exist[^.]*)/)?.[1] ?? "no tail";

					assert.ok(relations.length <= 2, `page ${pages + 1}: limit 2 returned ${relations.length} relations (${tail}, ${all.size} in all)`);
					for (const relation of relations) seen.add(key(relation));

					if (page.has_more !== true) {
						assert.equal(seen.size, all.size, `paging stopped after ${seen.size} of ${all.size} relations (${tail})`);
						args = undefined;
					} else {
						args = page.next_args as Record<string, unknown>;
					}
				}
			});
		},
	},
	{
		id: "subgraph.relations",
		tools: ["hydradb_subgraph"],
		async run({ call }) {
			requireIndexed("e2e-k-rel", "e2e-k-titled");
			const answer = await call("hydradb_subgraph", { id: "e2e-k-rel", depth: 1 });
			const structured = ok(answer, "hydradb_subgraph");
			const members = new Map(items(structured, "members").map((m) => [String(m.id), m]));

			assert.equal(members.get("e2e-k-rel")?.depth, 0);
			assert.equal(members.get("e2e-k-titled")?.depth, 1);
			assert.equal(members.get("e2e-k-titled")?.discovered_relation, "forceful_relation");
			assert.ok(items(structured, "relations").some((e) => e.from === "e2e-k-rel" && e.to === "e2e-k-titled"));
			assert.ok(answer.text.includes("[id: e2e-k-titled]"));
		},
	},
	{
		id: "subgraph.titles",
		tools: ["hydradb_subgraph"],
		knownIssue: "F-mcp-3",
		async run({ call, expectFixed }) {
			requireIndexed("e2e-k-rel", "e2e-k-titled");
			const answer = await call("hydradb_subgraph", { id: "e2e-k-rel", depth: 1 });
			const members = new Map(items(ok(answer, "hydradb_subgraph"), "members").map((m) => [String(m.id), m]));

			await expectFixed(() => {
				assert.equal(members.get("e2e-k-titled")?.title, "Ledger ownership.md");
				assert.doesNotMatch(answer.text, /\(untitled\)/, `titled members print as untitled:\n${answer.text}`);
			});
		},
	},
	{
		id: "update.additional_metadata",
		tools: ["hydradb_update", "hydradb_list", "hydradb_list_collections"],
		async run({ call }) {
			requireIndexed("e2e-k-upd");
			const collection = await defaultCollection(call);
			const updated = ok(
				await call("hydradb_update", { id: "e2e-k-upd", collection, additional_metadata: { stage: "approved", reviewer: "e2e" } }),
				"hydradb_update",
			);

			assert.equal(updated.updated, true);
			assert.deepEqual([...((updated.additional_metadata_keys as string[]) ?? [])].sort(), ["reviewer", "stage"]);

			await eventually("the edit to show in hydradb_list", 60_000, async () => {
				const listed = ok(await call("hydradb_list", { kind: "knowledge", ids: ["e2e-k-upd"], include_fields: ["additional_metadata"] }), "hydradb_list");
				const fields = items(listed)[0]?.fields as Record<string, unknown> | undefined;

				return missingInObject(fields?.additional_metadata, { stage: "approved", reviewer: "e2e" }).length === 0;
			});
		},
	},
	{
		id: "update.default_collection",
		tools: ["hydradb_update"],
		knownIssue: "F-mcp-2",
		async run({ call, expectFixed }) {
			requireIndexed("e2e-k-upd");
			const answer = await call("hydradb_update", { id: "e2e-k-upd", additional_metadata: { touched: "default-collection" } });

			await expectFixed(() => {
				assert.equal(answer.isError, false, `an item in the workspace default collection cannot be updated without naming it: ${answer.text}`);
			});
		},
	},
	{
		id: "feedback.query",
		tools: ["hydradb_query", "hydradb_feedback"],
		async run({ call }) {
			requireIndexed("e2e-k-titled");
			const queried = ok(await call("hydradb_query", { query: "Who owns the ledger service?", kind: "knowledge", structured: true }), "hydradb_query");
			const requestId = String(queried.request_id ?? "");

			assert.match(requestId, /^[0-9a-f-]{36}$/, "the query printed a request id");

			const answer = await call("hydradb_feedback", {
				request_id: requestId,
				rating: "positive",
				feedback: "e2e: the seeded owner was found",
				ground_truth_source_ids: ["e2e-k-titled"],
				metadata: { run: "e2e" },
			});

			ok(answer, "hydradb_feedback");
			assert.ok(answer.text.includes(`Feedback recorded for request ${requestId}.`), `the feedback was not recorded: ${brief(answer)}`);
		},
	},
	{
		id: "feedback.rating_only",
		tools: ["hydradb_query", "hydradb_feedback"],
		async run({ call }) {
			requireIndexed("e2e-k-titled");
			const queried = ok(await call("hydradb_query", { query: "Who owns the ledger service?", kind: "knowledge", structured: true }), "hydradb_query");
			const answer = await call("hydradb_feedback", { request_id: String(queried.request_id), rating: "negative" });

			assert.doesNotMatch(answer.text, /Cannot set property|\[object Object\]/, `a rating-only submission crashes: ${answer.text}`);
			assert.ok(
				answer.isError ? /feedback text|ground_truth/.test(answer.text) : /Feedback recorded/.test(answer.text),
				`neither recorded nor refused with a reason: ${answer.text}`,
			);
		},
	},
	{
		id: "collections.list",
		tools: ["hydradb_list_collections"],
		async run({ call, run: r }) {
			requireIndexed("e2e-k-named");
			const answer = await call("hydradb_list_collections", {});
			const listed = ok(answer, "hydradb_list_collections");
			const names = (listed.collections as string[]) ?? [];

			assert.ok(names.includes(NAMED), `${NAMED} missing from ${JSON.stringify(names)}`);
			assert.equal(names.filter((name) => name !== NAMED && name !== DROPPED).length, 1, `one workspace default collection: ${JSON.stringify(names)}`);
			assert.equal(listed.database, r.database);

			for (const name of names) assert.ok(answer.text.includes(name), `${name} missing from the text`);
		},
	},
	{
		id: "collections.delete",
		tools: ["hydradb_delete_collection", "hydradb_list_collections"],
		async run({ call }) {
			requireIndexed("e2e-k-drop");
			ok(await call("hydradb_delete_collection", { collection: DROPPED }), "hydradb_delete_collection");

			await eventually(`${DROPPED} to leave hydradb_list_collections`, 90_000, async () => {
				const listed = ok(await call("hydradb_list_collections", {}), "hydradb_list_collections");

				return !((listed.collections as string[]) ?? []).includes(DROPPED);
			});
		},
	},
	{
		id: "delete.item",
		tools: ["hydradb_delete", "hydradb_list"],
		async run({ call }) {
			requireIndexed("e2e-m-del", "e2e-k-del");
			const memory = ok(await call("hydradb_delete", { ids: ["e2e-m-del"], kind: "memory" }), "hydradb_delete memory");
			const knowledge = ok(await call("hydradb_delete", { ids: ["e2e-k-del"], kind: "knowledge" }), "hydradb_delete knowledge");

			assert.ok(JSON.stringify(memory).includes("e2e-m-del"));
			assert.ok(JSON.stringify(knowledge).includes("e2e-k-del"));

			await eventually("deleted items to leave hydradb_list", 90_000, async () => {
				const m = idsOf(ok(await call("hydradb_list", { kind: "memory", ids: ["e2e-m-del"] }), "hydradb_list memory"));
				const k = idsOf(ok(await call("hydradb_list", { kind: "knowledge", ids: ["e2e-k-del"] }), "hydradb_list knowledge"));

				return m.length === 0 && k.length === 0;
			});
		},
	},
	{
		id: "database.stats",
		tools: ["hydradb_database_stats"],
		async run({ call, run: r }) {
			requireIndexed(...KEPT_KNOWLEDGE, ...KEPT_MEMORY);
			const answer = await call("hydradb_database_stats", {});
			const stats = ok(answer, "hydradb_database_stats");

			assert.equal(stats.database, r.database);
			assert.ok(Number(stats.knowledge_rows) >= KEPT_KNOWLEDGE.length, `knowledge_rows ${stats.knowledge_rows}`);
			assert.ok(Number(stats.memory_rows) >= 1, `memory_rows ${stats.memory_rows}`);
			assert.ok(answer.text.includes(`${stats.knowledge_rows} knowledge row(s)`));
		},
	},
	{
		id: "database.schema",
		tools: ["hydradb_database_schema_inspect"],
		async run({ call }) {
			const answer = await call("hydradb_database_schema_inspect", {});
			const fields = items(ok(answer, "hydradb_database_schema_inspect"), "fields");
			const team = fields.find((field) => field.name === "team");

			assert.ok(team, `the team field is missing: ${JSON.stringify(fields)}`);
			assert.match(String(team.data_type), /VARCHAR/i);
			assert.ok(answer.text.includes("team"));
		},
	},
	{
		id: "database.lifecycle",
		tools: [
			"hydradb_database_create",
			"hydradb_database_readiness",
			"hydradb_database_schema_inspect",
			"hydradb_database_schema_update",
			"hydradb_database_stats",
			"hydradb_databases",
			"hydradb_database_delete",
		],
		async run({ call, run: r }) {
			const database = r.lifecycleDatabase;

			assert.equal(ok(await call("hydradb_database_create", { database }), "hydradb_database_create").database, database);

			await eventually(`${database} to be ready`, 300_000, async () => {
				const ready = ok(await call("hydradb_database_readiness", { database }), "hydradb_database_readiness");

				return ready.ready_for_ingestion === true;
			});

			assert.deepEqual(items(ok(await call("hydradb_database_schema_inspect", { database }), "schema inspect"), "fields"), []);
			ok(
				await call("hydradb_database_schema_update", {
					database,
					add_fields: [{ name: "region", data_type: "VARCHAR", max_length: 32, enable_match: true }],
				}),
				"hydradb_database_schema_update",
			);
			const fields = items(ok(await call("hydradb_database_schema_inspect", { database }), "schema inspect"), "fields");

			assert.ok(fields.some((field) => field.name === "region"), `region missing after the update: ${JSON.stringify(fields)}`);

			const stats = ok(await call("hydradb_database_stats", { database }), "hydradb_database_stats");

			assert.equal(stats.knowledge_rows, 0);
			assert.equal(stats.memory_rows, 0);

			const listed = await call("hydradb_databases", {});

			ok(listed, "hydradb_databases");
			assert.ok(listed.text.includes(database), `${database} missing from hydradb_databases`);
			assert.ok(listed.text.includes(r.database), `${r.database} missing from hydradb_databases`);

			failed(await call("hydradb_database_delete", { database: r.database }), "deleting the connection default", /default/i);
			ok(await call("hydradb_database_delete", { database }), "hydradb_database_delete");

			await eventually(`${database} to leave hydradb_databases`, 120_000, async () => {
				const after = await call("hydradb_databases", {});

				return !after.text.includes(database);
			});
		},
	},
	{
		id: "graph.lifecycle",
		tools: ["hydradb_graph_admin", "hydradb_graph_query", "hydradb_graph_collections"],
		async run({ call, run: r }) {
			const database = r.graphDatabase;
			const collection = "e2e";
			const created = ok(await call("hydradb_graph_admin", { action: "create_database", database }), "graph create_database");

			assert.equal(created.database, database);

			for (const [id, name] of [[1, "Ada"], [2, "Grace"]] as const) {
				ok(
					await call("hydradb_graph_query", { database, collection, query: "CREATE (p:Person {id: $id, name: $name})", params: { id, name } }),
					`graph write ${name}`,
				);
			}

			ok(
				await call("hydradb_graph_query", { database, collection, query: "MERGE (a:Person {id: 1})-[:MENTORS]->(b:Person {id: 2})" }),
				"graph write edge",
			);

			const read = await call("hydradb_graph_query", {
				database,
				collection,
				query: "MATCH (a:Person)-[:MENTORS]->(b:Person) RETURN a.name AS mentor, b.name AS mentee",
			});
			const rows = items(ok(read, "graph read"), "rows");

			assert.deepEqual(rows, [{ mentor: "Ada", mentee: "Grace" }]);
			assert.match(read.text, /Ada/);
			assert.match(read.text, /Grace/);

			const listed = ok(await call("hydradb_graph_collections", { database }), "hydradb_graph_collections");

			assert.deepEqual(listed.collections, [collection]);

			ok(await call("hydradb_graph_admin", { action: "drop_collection", database, collection }), "graph drop_collection");
			assert.deepEqual(ok(await call("hydradb_graph_collections", { database }), "hydradb_graph_collections").collections, []);

			const dropped = ok(await call("hydradb_graph_admin", { action: "drop_database", database }), "graph drop_database");

			assert.equal(dropped.database_deleted, true);
		},
	},
	{
		id: "graph.documented_writes",
		tools: ["hydradb_graph_admin", "hydradb_graph_query"],
		knownIssue: "F-mcp-8",
		async run({ call, run: r, expectFixed }) {
			const database = r.scratchGraphDatabase;

			ok(await call("hydradb_graph_admin", { action: "create_database", database }), "graph create_database");

			try {
				const batch = await call("hydradb_graph_query", {
					database,
					collection: "e2e",
					query: "UNWIND $rows AS row MERGE (p:Person {key: row.key}) SET p.name = row.name",
					params: { rows: [{ key: "ada", name: "Ada" }, { key: "grace", name: "Grace" }] },
				});
				const upsert = await call("hydradb_graph_query", {
					database,
					collection: "e2e",
					query: "MERGE (p:Person {key: $key}) SET p.name = $name RETURN p.key AS key",
					params: { key: "ada", name: "Ada Lovelace" },
				});

				await expectFixed(() => {
					assert.equal(batch.isError, false, `the documented UNWIND $rows batch write is refused: ${brief(batch)}`);
					assert.equal(upsert.isError, false, `the documented MERGE-on-a-key upsert is refused: ${brief(upsert)}`);
				});
			} finally {
				ok(await call("hydradb_graph_admin", { action: "drop_database", database }), "graph drop_database");
			}
		},
	},
	{
		id: "connectors.providers",
		tools: ["hydradb_connector_provider_list", "hydradb_connector_provider_inspect"],
		async run({ call }) {
			const listed = ok(await call("hydradb_connector_provider_list", {}), "hydradb_connector_provider_list");
			const providers = items(listed, "providers").map((p) => p.provider);

			assert.ok(providers.includes("slack"), "slack is a provider");

			const slack = ok(await call("hydradb_connector_provider_inspect", { provider: "slack" }), "hydradb_connector_provider_inspect");

			assert.equal(slack.provider, "slack");
			assert.equal(slack.connector_type, "slack");
		},
	},
	{
		id: "connectors.list",
		tools: ["hydradb_connector_list"],
		async run({ call }) {
			const listed = ok(await call("hydradb_connector_list", { include_health: true }), "hydradb_connector_list");

			assert.ok(Array.isArray(listed.connectors));
		},
	},
	{
		id: "connectors.connect",
		tools: ["hydradb_connector_connect"],
		async run({ call }) {
			const answer = await call("hydradb_connector_connect", { provider: "slack" });
			const link = ok(answer, "hydradb_connector_connect");

			assert.equal(link.completed, false);
			assert.match(String(link.dashboard_url), /connect=slack/);
			assert.ok(answer.text.includes(String(link.dashboard_url)));
		},
	},
	connectorMissing("hydradb_connector_inspect", {}),
	connectorMissing("hydradb_connector_health", {}),
	connectorMissing("hydradb_connector_discover", { limit: 5 }),
	connectorMissing("hydradb_connector_resource_list", {}),
	connectorMissing("hydradb_connector_reconnect", {}),
	connectorMissing("hydradb_connector_update", { sync_interval_seconds: 3600 }),
	connectorMissing("hydradb_connector_delete", {}),
	connectorMissing("hydradb_connector_sync", {}),
	connectorMissing("hydradb_connector_pause", {}),
	connectorMissing("hydradb_connector_resume", {}),
	connectorMissing("hydradb_connector_resource_add", { resources: [{ resource_id: "C0E2E1234567" }] }),
	connectorMissing("hydradb_connector_resource_update", { resource_id: "r-e2e-missing", custom_instructions: "e2e" }),
	connectorMissing("hydradb_connector_resource_delete", { resource_id: "r-e2e-missing" }),
	{
		id: "burst.concurrent_reads",
		tools: ["hydradb_inspect", "hydradb_list"],
		async run({ call }) {
			const inspected: TextId[] = ["e2e-k-plain", "e2e-k-titled", "e2e-k-wide", "e2e-k-rel", "e2e-k-evidence", "e2e-k-graph", "e2e-k-item-1", "e2e-k-item-2", "e2e-m-text", "e2e-m-item-1"];
			const listed = Array.from({ length: 10 }, (_, i) => pageId(i));

			requireIndexed(...inspected, ...listed);

			const calls = [
				...inspected.map(async (id) => {
					const answer = await call("hydradb_inspect", { id });

					return { id, answer, matches: () => answer.structured?.id === id && answer.structured?.content === TEXT[id] };
				}),
				...listed.map(async (id) => {
					const answer = await call("hydradb_list", { kind: "knowledge", ids: [id] });

					return { id, answer, matches: () => JSON.stringify(idsOf(answer.structured ?? {})) === JSON.stringify([id]) };
				}),
			];
			const settled = await Promise.all(calls);
			const wrong = settled
				.filter(({ answer, matches }) => (answer.isError ? !/429|rate.?limit/i.test(answer.text) : !matches()))
				.map(({ id, answer }) => `${id}: ${brief(answer)}`);

			assert.equal(settled.length, 20);
			assert.deepEqual(wrong, [], "a concurrent call crashed, failed dishonestly, or got another call's answer");
		},
	},
	{
		id: "http.parity",
		tools: ["hydradb_list", "hydradb_inspect", "hydradb_status", "hydradb_update", "hydradb_list_collections"],
		async run({ call, run: r }) {
			requireIndexed("e2e-k-titled", "e2e-k-wide");
			const collection = await defaultCollection(call);
			const server = await startHttp(r.cfg.entry, { HYDRADB_BASE_URL: r.cfg.baseUrl });

			try {
				const http = await connectHttp(server.url, { Authorization: `Bearer ${r.cfg.apiKey}`, "X-HydraDB-Database": r.database });

				try {
					assert.deepEqual(await http.toolNames(), await r.stdio.toolNames(), "both transports register the same tools");

					const same: [string, Record<string, unknown>][] = [
						["hydradb_list", { kind: "knowledge", ids: ["e2e-k-titled", "e2e-k-wide"], include_fields: ["title", "additional_metadata"] }],
						["hydradb_inspect", { id: "e2e-k-titled" }],
						["hydradb_status", { ids: ["e2e-k-titled", "e2e-k-wide"] }],
						["hydradb_list_collections", {}],
						["hydradb_update", { id: "e2e-k-titled", collection, additional_metadata: { transport: "checked" } }],
					];

					for (const [tool, args] of same) {
						const viaStdio = await call(tool, args);
						const viaHttp = await http.call(tool, args);

						ok(viaStdio, `${tool} over stdio`);
						assert.equal(comparable(viaHttp), comparable(viaStdio), `${tool} answered differently over HTTP`);
					}

					failed(
						await http.call("hydradb_ingest", { file: { path: `${REPO}package.json` } }),
						"file.path over HTTP",
						/`file\.path` works only on the local \(stdio\) Hydra DB MCP server/,
					);
				} finally {
					await http.close();
				}
			} finally {
				await server.stop();
			}

			assert.ok(!server.stderr().includes(r.cfg.apiKey), "the HTTP server logged the API key");
		},
	},
];

// --- Setup and teardown ------------------------------------------------------

function serverEnv(cfg: LiveConfig, database: string): Record<string, string> {
	return { HYDRADB_API_KEY: cfg.apiKey, HYDRADB_BASE_URL: cfg.baseUrl, HYDRADB_DATABASE: database };
}

async function waitForReady(stdio: Session, database: string) {
	const deadline = Date.now() + 300_000;

	for (;;) {
		const answer = await stdio.call("hydradb_database_readiness", { database });

		if (answer.structured?.ready_for_ingestion === true) return;

		if (Date.now() > deadline) throw new Error(`${database} was not ready within 5 minutes: ${brief(answer)}`);

		await sleep(5_000);
	}
}

/** Seed once, wait once: every ingest first, then poll status until every accepted id is terminal. */
async function seedAndWait(r: Run) {
	for (const seed of SEEDS) {
		const answer = await r.stdio.call("hydradb_ingest", seed.args);

		for (const id of seed.ids) r.seeded.set(id, answer);
		r.seedCalls.set(seed.scenario, new Set(["hydradb_ingest"]));
	}

	const groups = new Map<string | undefined, string[]>();

	for (const seed of SEEDS) {
		if (r.seeded.get(seed.ids[0])?.isError) continue;

		groups.set(seed.collection, [...(groups.get(seed.collection) ?? []), ...seed.ids]);
	}

	const deadline = Date.now() + 600_000;
	const terminal = new Set(["completed", "failed", "errored"]);

	for (;;) {
		const pending: string[] = [];

		for (const [collection, ids] of groups) {
			const open = ids.filter((id) => !terminal.has(r.statuses.get(id) ?? ""));

			for (let i = 0; i < open.length; i += 50) {
				const batch = open.slice(i, i + 50);
				const answer = await r.stdio.call("hydradb_status", collection ? { ids: batch, collection } : { ids: batch });

				for (const [id, status] of parseStatuses(answer.text)) r.statuses.set(id, status);
			}

			pending.push(...ids.filter((id) => !terminal.has(r.statuses.get(id) ?? "")));
		}

		if (pending.length === 0 || Date.now() > deadline) return;

		await sleep(5_000);
	}
}

async function setup(cfg: LiveConfig) {
	const database = cfg.database ?? throwawayName();
	const stdio = await startStdio(cfg.entry, serverEnv(cfg, database));
	const r: Run = {
		cfg,
		stdio,
		database,
		ownsDatabase: cfg.database == null,
		lifecycleDatabase: throwawayName(),
		graphDatabase: throwawayName(),
		scratchGraphDatabase: throwawayName(),
		seeded: new Map(),
		seedCalls: new Map(),
		statuses: new Map(),
		startedAt: new Date(),
	};

	run = r;

	const team = { name: "team", data_type: "VARCHAR", max_length: 64, enable_match: true };

	if (r.ownsDatabase) {
		const created = await stdio.call("hydradb_database_create", { database, database_metadata_schema: [team] });

		if (created.isError) throw new Error(`could not create ${database}: ${brief(created)}`);
	} else {
		const updated = await stdio.call("hydradb_database_schema_update", { database, add_fields: [team] });

		if (updated.isError && !/already|exist|no-op/i.test(updated.text)) throw new Error(`could not add the team field to ${database}: ${brief(updated)}`);
	}

	await waitForReady(stdio, database);
	await seedAndWait(r);
}

async function teardown() {
	const r = run;

	if (r == null) return;

	const admin = await startStdio(r.cfg.entry, serverEnv(r.cfg, `${r.database}-admin`)).catch(() => undefined);

	if (admin) {
		for (const database of [r.graphDatabase, r.scratchGraphDatabase]) {
			await admin.call("hydradb_graph_admin", { action: "drop_database", database });
		}

		await admin.call("hydradb_database_delete", { database: r.lifecycleDatabase });

		if (r.ownsDatabase) {
			const deleted = await admin.call("hydradb_database_delete", { database: r.database });

			if (deleted.isError) console.error(`[e2e] could not delete ${r.database}: ${brief(deleted)}`);
		}

		await admin.close();
	}

	const leaked = r.stdio.stderr().includes(r.cfg.apiKey);

	await r.stdio.close();

	if (leaked) throw new Error("the stdio server wrote the API key to stderr");
}

function writeResults(cfg: LiveConfig) {
	const r = run;
	const started = r?.startedAt ?? new Date();
	const recorded = new Set(results.map((result) => result.id));
	const all = [...SCENARIOS.map((s) => s.id), "completeness.tools"];

	for (const id of all) {
		if (!recorded.has(id)) results.push({ id, status: "fail", duration_ms: 0, detail: `did not run: ${setupError ?? "unknown"}` });
	}

	const body = {
		surface: "mcp",
		version: r?.stdio.version ?? "unknown",
		base_url: cfg.baseUrl,
		database: r?.database ?? "",
		started_at: started.toISOString().replace(/\.\d+Z$/, "Z"),
		duration_ms: Date.now() - started.getTime(),
		scenarios: results,
	};
	const counts = results.reduce<Record<string, number>>((acc, result) => {
		acc[result.status] = (acc[result.status] ?? 0) + 1;

		return acc;
	}, {});
	const line = (result: ScenarioResult) => `${result.status.padEnd(11)} ${result.id}${result.detail ? `  (${result.detail})` : ""}`;

	console.log(`\n[e2e] mcp live: ${JSON.stringify(counts)} in ${Math.round(body.duration_ms / 1000)}s against ${cfg.baseUrl}`);
	for (const result of results) console.log(`[e2e]   ${line(result)}`);

	if (cfg.resultsPath) writeFileSync(cfg.resultsPath, `${JSON.stringify(body, null, 2)}\n`);

	if (process.env.GITHUB_STEP_SUMMARY) {
		const markdown = [
			`### MCP live e2e: ${Object.entries(counts).map(([status, n]) => `${n} ${status}`).join(", ")}`,
			"",
			...results.map((result) => `- \`${result.id}\`: ${result.status}${result.detail ? `, ${result.detail.replace(/\n/g, " ")}` : ""}`),
			"",
		].join("\n");

		appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
	}
}

function oneLine(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);

	return message.replace(/\s+/g, " ").slice(0, 300);
}

async function runScenario(scenario: Scenario, t: TestContext) {
	const started = Date.now();
	const called = new Set<string>();
	const record = (status: Status, detail?: string) =>
		results.push({ id: scenario.id, status, duration_ms: Date.now() - started, ...(detail ? { detail } : {}) });
	let reproduced: string | undefined;
	let checkedFix = false;

	const ctx: Ctx = {
		run: current(),
		call: (name, args) => {
			called.add(name);

			return current().stdio.call(name, args);
		},
		async expectFixed(body) {
			checkedFix = true;

			try {
				await body();
			} catch (error) {
				reproduced = oneLine(error);
			}
		},
	};

	try {
		await scenario.run(ctx);

		const seedCalls = current().seedCalls.get(scenario.id) ?? new Set();
		const uncalled = scenario.tools.filter((tool) => !called.has(tool) && !seedCalls.has(tool));

		assert.deepEqual(uncalled, [], "the scenario declares tools it never called");

		if (scenario.knownIssue) {
			assert.ok(checkedFix, "a known-issue scenario must assert the fix with expectFixed");

			if (reproduced == null) {
				throw new Error(`${scenario.knownIssue} no longer reproduces: remove the knownIssue marker and close the finding`);
			}
		}
	} catch (error) {
		record("fail", oneLine(error));
		throw error;
	}

	if (scenario.knownIssue && reproduced != null) {
		record("known_issue", `${scenario.knownIssue}: ${reproduced}`);
		t.todo(`${scenario.knownIssue}: ${reproduced}`);

		return;
	}

	record("pass");
}

// --- The suite ---------------------------------------------------------------

if (typeof config === "string") {
	test("live configuration", () => {
		throw new Error(config);
	});
} else {
	describe("mcp live e2e", { skip: config == null ? "set HYDRADB_E2E=1 to run the live tier" : false }, () => {
		before(async () => {
			try {
				await setup(config as LiveConfig);
			} catch (error) {
				setupError = oneLine(error);
				throw error;
			}
		});

		after(async () => {
			try {
				await teardown();
			} finally {
				writeResults(config as LiveConfig);
			}
		});

		for (const scenario of SCENARIOS) it(scenario.id, (t) => runScenario(scenario, t));

		it("completeness.tools", async () => {
			const started = Date.now();

			try {
				const registered = await current().stdio.toolNames();
				const covered = new Set(SCENARIOS.flatMap((scenario) => scenario.tools));
				const uncovered = registered.filter((tool) => !covered.has(tool));
				const stale = [...covered].filter((tool) => !registered.includes(tool));

				assert.deepEqual(uncovered, [], "registered tools with no live scenario");
				assert.deepEqual(stale, [], "scenarios name tools the server does not register");
				results.push({ id: "completeness.tools", status: "pass", duration_ms: Date.now() - started });
			} catch (error) {
				results.push({ id: "completeness.tools", status: "fail", duration_ms: Date.now() - started, detail: oneLine(error) });
				throw error;
			}
		});
	});
}
