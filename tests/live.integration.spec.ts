import { test } from "node:test";
import assert from "node:assert/strict";

import { toMemoryList, toSourceList } from "../src/adapters.js";
import { resolveConfig } from "../src/config.js";
import { HydraDB } from "../src/hydra/index.js";
import { HydraWrapperError } from "../src/hydra/errors.js";

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
// upload returns, and it is not deletable until indexing finishes. Knowledge
// ingestion runs through graph extraction and was still going at 90s, so the
// budget is 5 minutes. Override with HYDRADB_INDEX_TIMEOUT_MS for a slower or
// faster stack.
const INDEX_TIMEOUT_MS = Number(process.env.HYDRADB_INDEX_TIMEOUT_MS ?? 300_000);
const POLL_INTERVAL_MS = 5_000;

/**
 * Is this failure worth another attempt inside the polling window?
 *
 * A minutes-long poll against a remote API will meet the occasional dropped
 * connection - one such blip (`fetch failed`, no status, no response) ended a
 * run 34s into a 300s budget. Those retry. Anything the server answered with a
 * 4xx is a real answer and fails immediately; 429 and 5xx are the server asking
 * us to come back.
 *
 * Assertion failures raised inside the polled function are not
 * HydraWrapperErrors, so they propagate untouched - a spurious retry there would
 * hide the very thing the test is checking.
 */
function isRetriable(err: unknown): boolean {
	if (!(err instanceof HydraWrapperError)) return false;
	if (err.status == null) return true; // transport-level: no HTTP reply at all
	return err.status === 429 || err.status >= 500;
}

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

	let transientFailures = 0;

	for (;;) {
		try {
			const attempt = await fn();
			observed = attempt.observed;
			if (attempt.value != null) {
				if (transientFailures > 0) {
					console.error(
						`[live] ${label} satisfied after ${transientFailures} transient failure(s)`,
					);
				}
				return { value: attempt.value, observed, waitedMs: Date.now() - startedAt };
			}
		} catch (err) {
			if (!isRetriable(err) || Date.now() >= deadline) throw err;
			transientFailures++;
			observed = { transientError: String(err) };
			console.error(`[live] ${label}: transient failure, retrying — ${err}`);
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
			const { memories } = toMemoryList(raw);
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
		//
		// Only `completed` is treated as done and only `failed` as fatal;
		// everything else counts as in-progress. Deliberately a string compare
		// against no fixed set: a live run returned `graph_creation`, which the
		// SDK's IngestionSourceStatus enum (queued/processing/completed/failed)
		// does not declare, so switching on that enum would misread reality.
		let lastStatus: string | undefined;
		const indexed = await pollUntil("ingestion completes", async () => {
			const batch = await hydra.context.ingestionStatus({ ids: [sourceId] });
			const status = batch.statuses?.find((s) => s.id === sourceId);
			assert.notEqual(
				status?.indexingStatus,
				"failed",
				`ingestion failed for ${sourceId}: ${status?.errorMessage ?? status?.errorCode}`,
			);
			// A five-minute silent wait is indistinguishable from a hang; narrate
			// each transition so a slow stage is visible while it is happening.
			if (status?.indexingStatus !== lastStatus) {
				lastStatus = status?.indexingStatus;
				console.error(`[live] ${sourceId} indexingStatus=${lastStatus}`);
			}
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

// `upsert` is hardcoded true on both ingest paths, and PARAM.source_id tells the
// model to "use this as your session ID or any other unique identifier for a
// conversation". Whether following that instruction is safe depends entirely on
// what upsert does to a reused source_id — and nothing pinned it: not
// CONTRACT.md, not conformance/vectors.json, not this file.
//
// It REPLACES. A second ingest under the same source_id destroys the first, and
// the tool still answers "1 success, 0 failed". That is a data-loss path reached
// by following our own documentation, so it gets a regression test rather than a
// comment.
//
// Two things this test has to get right, both of which a naive version gets
// wrong:
//   - Row count cannot answer the question. The listing is per SOURCE, so it
//     returns exactly one row whether the second ingest replaced or appended.
//     Only the source's CONTENT distinguishes them.
//   - The read must happen after a terminal indexingStatus. Reading straight
//     after ingest returns the previous generation's content and "proves"
//     whichever answer the race happens to produce.
//
// `infer: false` keeps the text verbatim so the markers survive into storage;
// with inference on, the server stores extracted insights and neither marker is
// guaranteed to appear literally.
test(
	"live: reusing a source_id REPLACES the previous memory, it does not append",
	{ skip: skipReason },
	async () => {
		const hydra = client();
		const id = marker();
		const sourceId = `mcp-e2e-upsert-${id}`;
		const ALPHA = `UPSERT-ALPHA-${id}`;
		const BRAVO = `UPSERT-BRAVO-${id}`;

		async function ingestVerbatim(text: string) {
			const res = await hydra.context.ingest({
				kind: "memory",
				text,
				sourceId,
				title: `Upsert probe ${id}`,
				infer: false,
				upsert: true,
			});
			assert.equal(res.success, true, `ingest failed: ${res.message}`);
			return res;
		}

		async function awaitIndexed(label: string) {
			let lastStatus: string | undefined;
			const indexed = await pollUntil(`${label} reaches a terminal status`, async () => {
				const batch = await hydra.context.ingestionStatus({ ids: [sourceId] });
				const status = batch.statuses?.find((s) => s.id === sourceId);
				assert.notEqual(
					status?.indexingStatus,
					"failed",
					`ingestion failed for ${sourceId}: ${status?.errorMessage ?? status?.errorCode}`,
				);
				if (status?.indexingStatus !== lastStatus) {
					lastStatus = status?.indexingStatus;
					console.error(`[live] ${label} indexingStatus=${lastStatus}`);
				}
				return {
					value: status?.indexingStatus === "completed" ? status : null,
					observed: batch,
				};
			});
			assert.ok(
				indexed.value,
				`${label}: ${sourceId} never reached indexingStatus=completed within ${INDEX_TIMEOUT_MS}ms`,
			);
		}

		async function readBack(label: string): Promise<string> {
			const fetched = await pollUntil(`${label} inspect returns content`, async () => {
				const res = await hydra.context.inspect({ id: sourceId, mode: "content" });
				return { value: res.success ? res : null, observed: res };
			});
			assert.ok(fetched.value, `${label}: inspect(${sourceId}) never succeeded`);
			return String(fetched.value.content ?? fetched.value.contentBase64 ?? "");
		}

		await ingestVerbatim(`${ALPHA} the user prefers tabs over spaces.`);
		await awaitIndexed("first ingest");
		const afterAlpha = await readBack("first ingest");
		assert.ok(
			afterAlpha.includes(ALPHA),
			`first ingest never became readable — the test cannot judge upsert without it. Got: ${afterAlpha.slice(0, 200)}`,
		);

		await ingestVerbatim(`${BRAVO} the user deploys only on Tuesday and Thursday.`);
		await awaitIndexed("second ingest");
		const afterBravo = await readBack("second ingest");

		assert.ok(
			afterBravo.includes(BRAVO),
			`second ingest under the same source_id never landed. Got: ${afterBravo.slice(0, 200)}`,
		);
		assert.ok(
			!afterBravo.includes(ALPHA),
			"reusing a source_id APPENDED rather than replaced — upsert semantics have changed. " +
				"This inverts the guidance in PARAM.source_id and the correction path built on it; " +
				`re-read both before changing this assertion. Got: ${afterBravo.slice(0, 300)}`,
		);

		const deleted = await hydra.context.delete({ ids: [sourceId], kind: "memory" });
		assert.equal(
			deleted.success,
			true,
			`cleanup delete failed for ${sourceId}: ${JSON.stringify(deleted)}`,
		);
	},
);
