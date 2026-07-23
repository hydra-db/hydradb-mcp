import assert from "node:assert/strict";
import { test } from "node:test";

import type { HydraDB as SDK } from "@hydradb/sdk";

import {
	toAddMemoryResponse,
	toMemoryList,
	toRecallResponse,
	toSourceList,
} from "../src/adapters.js";
import { buildRecalledContext } from "../src/context.js";

// Mirrors the shape the SDK actually returns at runtime: known fields are
// camelCase, but triplet innards (relation/source/target) stay raw snake_case.
test("toRecallResponse maps SDK camelCase into the legacy recall render", () => {
	const data: SDK.SearchV2RetrievalResult = {
		chunks: [
			{
				chunkUuid: "c1",
				id: "s1",
				chunkContent: "Chunk one body",
				sourceTitle: "Doc A",
				relevancyScore: 0.9,
				extraContextIds: ["ec1"],
			},
		],
		graphContext: {
			queryPaths: [
				{
					relevancyScore: 0.9,
					combinedContext: "Alice -> prefers -> tea",
					triplets: [],
				},
			],
			chunkRelations: [
				{
					relevancyScore: 0.8,
					groupId: "g1",
					triplets: [
						{
							source: { name: "Alice" },
							relation: {
								raw_predicate: "likes",
								canonical_predicate: "prefers",
								context: "morning routine",
								chunk_id: "c1",
							},
							target: { name: "Tea" },
						},
					],
				},
			],
			chunkIdToGroupIds: { c1: ["g1"] },
		},
		additionalContext: {
			ec1: {
				chunkUuid: "ec1",
				id: "s2",
				chunkContent: "Tea helps Alice focus",
				sourceTitle: "Doc B",
			},
		},
	};

	const res = toRecallResponse(data);

	// The chunk-summary path reads snake_case fields directly.
	assert.equal(res.chunks[0]!.chunk_content, "Chunk one body");
	assert.equal(res.chunks[0]!.relevancy_score, 0.9);

	const output = buildRecalledContext(res);
	assert.match(output, /=== ENTITY PATHS ===/);
	assert.match(output, /Alice -> prefers -> tea/);
	assert.match(output, /=== CONTEXT ===/);
	assert.match(output, /Source: Doc A/);
	assert.match(output, /Graph Relations:/);
	assert.match(output, /\(Alice\) —\[likes\]→ \(Tea\) \[morning routine\]/);
	assert.match(output, /Related Context \(Doc B\): Tea helps Alice focus/);
});

test("toAddMemoryResponse maps ingest counts", () => {
	const res = toAddMemoryResponse({
		success: true,
		message: "ok",
		successCount: 3,
		failedCount: 1,
	});
	assert.equal(res.success_count, 3);
	assert.equal(res.failed_count, 1);
	assert.equal(res.success, true);
});

test("toMemoryList reads memory rows defensively", () => {
	const rows = toMemoryList({
		inner: {
			sources: [
				{ memory_id: "m1", memory_content: "prefers dark mode" },
				{ id: "m2", content: "likes tea" },
			],
		},
	});
	assert.deepEqual(rows, [
		{ memory_id: "m1", memory_content: "prefers dark mode" },
		{ memory_id: "m2", memory_content: "likes tea" },
	]);
});

test("toSourceList reads source rows and total", () => {
	const { sources, total } = toSourceList({
		inner: {
			total: 2,
			sources: [
				{ id: "s1", title: "Q3 report", type: "file" },
				{ source_id: "s2", source_type: "slack" },
			],
		},
	});
	assert.equal(total, 2);
	assert.deepEqual(sources, [
		{ id: "s1", title: "Q3 report", type: "file" },
		{ id: "s2", title: undefined, type: "slack" },
	]);
});
