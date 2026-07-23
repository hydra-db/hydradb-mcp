import { test } from "node:test";
import assert from "node:assert/strict";

import { toMemoryList } from "../src/adapters.js";
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

async function poll<T>(
	fn: () => Promise<T | null>,
	opts?: { attempts?: number; delayMs?: number },
): Promise<T | null> {
	const attempts = opts?.attempts ?? 5;
	const delayMs = opts?.delayMs ?? 1500;

	for (let i = 0; i < attempts; i++) {
		const value = await fn();
		if (value != null) return value;
		await new Promise((resolve) => setTimeout(resolve, delayMs));
	}

	return null;
}

test(
	"live Hydra DB e2e via the wrapper: ingest -> query -> list -> inspect -> delete",
	{ skip: skipReason },
	async () => {
		const config = resolveConfig();
		const hydra = new HydraDB({
			token: config.apiKey,
			database: config.database,
			collection: config.collection,
			...(config.baseUrl != null ? { baseUrl: config.baseUrl } : {}),
		});

		const marker = `integration-${Date.now()}-${Math.random()
			.toString(36)
			.slice(2, 8)}`;
		const sourceId = `mcp-e2e-${marker}`;
		const text = `Hydra MCP integration test marker ${marker}. User prefers masala chai and concise status updates.`;

		const ingest = await hydra.context.ingest({
			kind: "memory",
			text,
			sourceId,
			title: `Integration ${marker}`,
			infer: true,
			upsert: true,
		});
		assert.equal(ingest.success, true);
		assert.ok((ingest.successCount ?? 0) >= 1);

		const recall = await hydra.context.query({
			query: `masala chai ${marker}`,
			kind: "memory",
			maxResults: 5,
			mode: "thinking",
			graphContext: true,
		});
		assert.ok(Array.isArray(recall.chunks));

		const listedSource = await poll(async () => {
			const listed = await hydra.context.list({
				kind: "knowledge",
				ids: [sourceId],
			});
			const sources = listed.inner?.sources ?? [];
			return sources.length > 0 ? sources[0] : null;
		});
		assert.ok(listedSource, "Expected source to appear in list(knowledge)");

		const fetched = await poll(async () => {
			const content = await hydra.context.inspect({
				id: sourceId,
				mode: "content",
			});
			return content.success ? content : null;
		});
		assert.ok(fetched, "Expected inspect success");

		const memories = toMemoryList(await hydra.context.list({ kind: "memory" }));
		const createdMemory = memories.find((m) =>
			m.memory_content.includes(marker),
		);
		if (createdMemory) {
			const deleted = await hydra.context.delete({
				ids: [createdMemory.memory_id],
				kind: "memory",
			});
			assert.equal(deleted.success, true);
		}
	},
);
