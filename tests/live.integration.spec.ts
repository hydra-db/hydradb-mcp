import { test } from "node:test";
import assert from "node:assert/strict";

import { HydraDBClient } from "../src/client.js";

const RUN_LIVE_TESTS = process.env.RUN_LIVE_TESTS === "true";

const apiKey = process.env.HYDRA_DB_API_KEY ?? "";
const tenantId = process.env.HYDRA_DB_TENANT_ID ?? "";
const subTenantId = process.env.HYDRA_DB_SUB_TENANT_ID ?? "hydra-db-mcp";

const skipReason =
	!RUN_LIVE_TESTS
		? "Set RUN_LIVE_TESTS=true to run integration tests"
		: !apiKey || !tenantId
			? "HYDRA_DB_API_KEY and HYDRA_DB_TENANT_ID are required"
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
	"live Hydra DB e2e: ingest -> recall -> list -> fetch -> delete",
	{ skip: skipReason },
	async () => {
		const client = new HydraDBClient(apiKey, tenantId, subTenantId);

		const marker = `integration-${Date.now()}-${Math.random()
			.toString(36)
			.slice(2, 8)}`;
		const sourceId = `mcp-e2e-${marker}`;
		const text = `Hydra MCP integration test marker ${marker}. User prefers masala chai and concise status updates.`;

		const ingest = await client.ingestText(text, {
			sourceId,
			title: `Integration ${marker}`,
			infer: true,
		});

		assert.equal(ingest.success, true);
		assert.ok(ingest.success_count >= 1);

		const recall = await client.recall(`masala chai ${marker}`, {
			maxResults: 5,
			mode: "thinking",
			graphContext: true,
		});
		assert.ok(Array.isArray(recall.chunks));

		const listedSource = await poll(async () => {
			const listed = await client.listSources([sourceId]);
			if (!listed.sources || listed.sources.length === 0) return null;
			return listed.sources[0];
		});
		assert.ok(listedSource, "Expected source to appear in listSources");

		const fetched = await poll(async () => {
			const content = await client.fetchContent(sourceId, "content");
			return content.success ? content : null;
		});
		assert.ok(fetched, "Expected fetchContent success");

		const memories = await client.listMemories();
		assert.equal(memories.success, true);
		assert.ok(Array.isArray(memories.user_memories));

		const createdMemory = memories.user_memories.find((m) =>
			m.memory_content.includes(marker),
		);
		if (createdMemory) {
			const deleted = await client.deleteMemory(createdMemory.memory_id);
			assert.equal(deleted.success, true);
		}
	},
);

