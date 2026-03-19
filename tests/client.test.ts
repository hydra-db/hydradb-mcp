import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import { HydraDBClient } from "../src/client.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

test("ingestText sends expected payload", async () => {
	let calledUrl = "";
	let calledMethod = "";
	let calledBody: unknown = null;
	let calledAuthHeader = "";

	globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
		calledUrl = String(url);
		calledMethod = String(init?.method ?? "");
		calledBody = init?.body ? JSON.parse(String(init.body)) : null;
		calledAuthHeader = String(
			(init?.headers as Record<string, string>)?.Authorization ?? "",
		);

		return new Response(
			JSON.stringify({
				success: true,
				message: "ok",
				results: [],
				success_count: 1,
				failed_count: 0,
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}) as typeof fetch;

	const client = new HydraDBClient("test-key", "tenant-a", "sub-a");

	await client.ingestText("hello world", {
		sourceId: "source-1",
		title: "Title",
		infer: true,
	});

	assert.equal(calledUrl, "https://api.hydradb.com/memories/add_memory");
	assert.equal(calledMethod, "POST");
	assert.equal(calledAuthHeader, "Bearer test-key");
	assert.deepEqual(calledBody, {
		memories: [
			{
				text: "hello world",
				infer: true,
				is_markdown: false,
				custom_instructions:
					"Focus on extracting user preferences, habits, opinions, likes, dislikes, goals, and recurring themes. Capture any stated or implied personal context that would help personalise future interactions.",
				source_id: "source-1",
				title: "Title",
			},
		],
		tenant_id: "tenant-a",
		sub_tenant_id: "sub-a",
		upsert: true,
	});
});

test("listSources uses list/data with kind=knowledge", async () => {
	let calledBody: unknown = null;

	globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
		calledBody = init?.body ? JSON.parse(String(init.body)) : null;
		return new Response(
			JSON.stringify({
				success: true,
				sources: [],
				total: 0,
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}) as typeof fetch;

	const client = new HydraDBClient("test-key", "tenant-a", "sub-a");
	await client.listSources(["source-1"]);

	assert.deepEqual(calledBody, {
		tenant_id: "tenant-a",
		sub_tenant_id: "sub-a",
		kind: "knowledge",
		source_ids: ["source-1"],
	});
});

test("deleteMemory calls DELETE endpoint with query params", async () => {
	let calledUrl = "";
	let calledMethod = "";

	globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
		calledUrl = String(url);
		calledMethod = String(init?.method ?? "");
		return new Response(
			JSON.stringify({
				success: true,
				user_memory_deleted: true,
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}) as typeof fetch;

	const client = new HydraDBClient("test-key", "tenant-a", "sub-a");
	await client.deleteMemory("mem-123");

	assert.equal(calledMethod, "DELETE");
	assert.match(
		calledUrl,
		/^https:\/\/api\.hydradb\.com\/memories\/delete_memory\?/,
	);
	assert.match(calledUrl, /tenant_id=tenant-a/);
	assert.match(calledUrl, /sub_tenant_id=sub-a/);
	assert.match(calledUrl, /memory_id=mem-123/);
});

