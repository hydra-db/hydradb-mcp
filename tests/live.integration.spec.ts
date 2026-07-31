import { test } from "node:test";
import assert from "node:assert/strict";

import { toMemoryList, toSourceList } from "../src/adapters.js";
import { resolveConfig } from "../src/config.js";
import { HydraDB } from "../src/hydra/index.js";

const RUN_LIVE_TESTS = process.env.RUN_LIVE_TESTS === "true";

// Presence check without throwing, so the skip reason is clean when unset.
const hasApiKey =
	!!process.env.HYDRADB_API_KEY || !!process.env.HYDRA_DB_API_KEY;
const hasDatabase =
	!!process.env.HYDRADB_DATABASE || !!process.env.HYDRA_DB_TENANT_ID;

const skipReason = !RUN_LIVE_TESTS
	? "Set RUN_LIVE_TESTS=true to run integration tests"
	: !hasApiKey || !hasDatabase
		? "HYDRADB_API_KEY and HYDRADB_DATABASE (or their HYDRA_DB_* aliases) are required"
		: false;

// Ingestion is asynchronous: a queued source is not listable the moment the
// upload returns. The old 7.5s budget was shorter than observed indexing time,
// which made a slow index and a broken read path produce the same failure.
// Override with HYDRADB_INDEX_TIMEOUT_MS when testing against a slower stack.
const INDEX_TIMEOUT_MS = Number(process.env.HYDRADB_INDEX_TIMEOUT_MS ?? 90_000);
const POLL_INTERVAL_MS = 3_000;

/**
 * Poll until `fn` returns non-null or the budget runs out. Returns the last
 * observed value on failure as well, so an assertion can report what the API
 * actually said rather than just "expected true".
 */
async function pollUntil<T>(
	label: string,
	fn: () => Promise<{ value: T | null; observed: unknown }>,
): Promise<{ value: T | null; observed: unknown; waitedMs: number }> {
	const deadline = Date.now() + INDEX_TIMEOUT_MS;
	const startedAt = Date.now();
	let observed: unknown;

	for (;;) {
		const attempt = await fn();
		observed = attempt.observed;
		if (attempt.value != null) {
			return { value: attempt.value, observed, waitedMs: Date.now() - startedAt };
		}
		if (Date.now() >= deadline) {
			console.error(
				`[live] ${label} never satisfied within ${INDEX_TIMEOUT_MS}ms; last response: ${JSON.stringify(observed)?.slice(0, 400)}`,
			);
			return { value: null, observed, waitedMs: Date.now() - startedAt };
		}
		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	}
}

function marker(): string {
	return `integration-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function client(): HydraDB {
	const config = resolveConfig();
	return new HydraDB({
		token: config.apiKey,
		database: config.database,
		collection: config.collection,
		...(config.baseUrl != null ? { baseUrl: config.baseUrl } : {}),
	});
}

// The memory and knowledge families are ingested, listed and deleted through
// different server paths. The previous single test ingested a MEMORY and then
// asserted the source appeared in list(KNOWLEDGE), so it could never distinguish
// "knowledge listing is broken" from "that source was never knowledge".
test(
	"live: memory family — ingest -> query -> list(memory) -> delete",
	{ skip: skipReason },
	async () => {
		const hydra = client();
		const id = marker();
		const sourceId = `mcp-e2e-memory-${id}`;
		const text = `Hydra MCP integration test marker ${id}. User prefers masala chai and concise status updates.`;

		const ingest = await hydra.context.ingest({
			kind: "memory",
			text,
			sourceId,
			title: `Integration ${id}`,
			infer: true,
			upsert: true,
		});
		assert.equal(ingest.success, true, `ingest failed: ${ingest.message}`);
		assert.ok((ingest.successCount ?? 0) >= 1, "expected at least one queued item");

		const recall = await hydra.context.query({
			query: `masala chai ${id}`,
			kind: "memory",
			maxResults: 5,
			mode: "thinking",
			graphContext: true,
		});
		assert.ok(Array.isArray(recall.chunks), "query returned no chunks array");

		// Read through the adapter the tools use. Reading the raw SDK shape here is
		// what let PRO-1298's empty-list bug pass its own integration test.
		const found = await pollUntil("memory appears in list(memory)", async () => {
			const raw = await hydra.context.list({ kind: "memory" });
			const memories = toMemoryList(raw);
			const match = memories.find((m) => m.memory_content.includes(id));
			return { value: match ?? null, observed: { listed: memories.length } };
		});
		assert.ok(
			found.value,
			`ingested memory never appeared in list(memory) within ${INDEX_TIMEOUT_MS}ms — ` +
				`this is a real failure, not a skip: the tool would show the user nothing`,
		);

		const deleted = await hydra.context.delete({
			ids: [found.value.memory_id],
			kind: "memory",
		});
		assert.equal(
			deleted.success,
			true,
			`delete(memory) did not report success: ${JSON.stringify(deleted)}`,
		);
		assert.ok(
			(deleted.userMemoryDeleted ?? 0) > 0 || (deleted.deletedCount ?? 0) > 0,
			`delete(memory) reported success but removed nothing: ${JSON.stringify(deleted)}`,
		);
	},
);

test(
	"live: knowledge family — ingest -> list(knowledge) -> inspect -> delete",
	{ skip: skipReason },
	async () => {
		const hydra = client();
		const id = marker();
		const text = `# Integration ${id}\n\nHydra MCP knowledge marker ${id}.`;

		const ingest = await hydra.context.ingest({
			kind: "knowledge",
			text,
			title: `Integration ${id}`,
			filename: `integration-${id}.md`,
		});
		assert.equal(ingest.success, true, `ingest failed: ${ingest.message}`);

		// The knowledge path uploads a document; the server assigns the id and
		// returns it per item. The caller's sourceId is not sent on this path, so
		// filtering a listing by it would never match.
		const created = ingest.results?.[0];
		assert.ok(
			created?.id,
			`knowledge ingest returned no source id: ${JSON.stringify(ingest.results)}`,
		);
		const sourceId = created.id;

		// A source is listable and inspectable while it is still indexing, but the
		// server refuses to delete one mid-ingestion: "Source is still processing;
		// retry deletion after ingestion completes". ingestionStatus is the
		// canonical gate for that, and skipping it is what made this test fail on
		// its last step while every step before it passed.
		const indexed = await pollUntil("ingestion completes", async () => {
			const batch = await hydra.context.ingestionStatus({ ids: [sourceId] });
			const status = batch.statuses?.find((s) => s.id === sourceId);
			assert.notEqual(
				status?.indexingStatus,
				"failed",
				`ingestion failed for ${sourceId}: ${status?.errorMessage ?? status?.errorCode}`,
			);
			return {
				value: status?.indexingStatus === "completed" ? status : null,
				observed: batch,
			};
		});
		assert.ok(
			indexed.value,
			`${sourceId} never reached indexingStatus=completed within ${INDEX_TIMEOUT_MS}ms`,
		);

		const listed = await pollUntil(
			"knowledge source appears in list(knowledge)",
			async () => {
				const raw = await hydra.context.list({
					kind: "knowledge",
					ids: [sourceId],
				});
				const sources = toSourceList(raw).sources;
				return {
					value: sources.find((s) => s.id === sourceId) ?? null,
					observed: raw,
				};
			},
		);
		assert.ok(
			listed.value,
			`source ${sourceId} never appeared in list(knowledge) within ${INDEX_TIMEOUT_MS}ms`,
		);

		const fetched = await pollUntil("inspect returns content", async () => {
			const content = await hydra.context.inspect({
				id: sourceId,
				mode: "content",
			});
			return { value: content.success ? content : null, observed: content };
		});
		assert.ok(fetched.value, `inspect(${sourceId}) never succeeded`);

		const deleted = await hydra.context.delete({
			ids: [sourceId],
			kind: "knowledge",
		});
		// Print the whole response: "success !== true" on its own does not say
		// whether the server refused, why, or whether it removed anything.
		assert.equal(
			deleted.success,
			true,
			`delete(knowledge) did not report success for ${sourceId}: ${JSON.stringify(deleted)}`,
		);
		assert.ok(
			(deleted.deletedCount ?? 0) > 0,
			`delete(knowledge) reported success but removed nothing: ${JSON.stringify(deleted)}`,
		);
	},
);
