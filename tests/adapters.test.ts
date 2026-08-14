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

// `results` was hardcoded `[]`, so a caller told "1 success, 2 failed" had no
// reason, no code and no way to tell which item failed.
test("toAddMemoryResponse carries per-item failures instead of discarding them", () => {
	const res = toAddMemoryResponse({
		success: false,
		message: "partial",
		successCount: 1,
		failedCount: 1,
		results: [
			{ id: "s-ok", status: "completed", error: "", errorCode: "" },
			{
				id: "s-bad",
				filename: "notes.md",
				status: "failed",
				error: "content exceeds maximum size",
				errorCode: "TOO_LARGE",
			},
		],
	});

	assert.equal(res.results.length, 2);
	assert.deepEqual(res.results[1], {
		source_id: "s-bad",
		title: "notes.md",
		status: "failed",
		error: "content exceeds maximum size",
		error_code: "TOO_LARGE",
		relations_error: null,
	});
	// Empty strings are how the server says "no error"; normalise so callers can
	// test presence rather than emptiness.
	assert.equal(res.results[0].error, null);
	assert.equal(res.results[0].error_code, null);
});

// An item can be accepted and stored while graph extraction fails. failed_count
// stays 0, so this is invisible unless the per-item field is carried through.
test("toAddMemoryResponse carries relations_error on an otherwise successful item", () => {
	const res = toAddMemoryResponse({
		success: true,
		message: "ok",
		successCount: 1,
		failedCount: 0,
		results: [
			{
				id: "s1",
				status: "completed",
				error: "",
				relationsError: "entity extraction timed out",
			},
		],
	});

	assert.equal(res.failed_count, 0);
	assert.equal(res.results[0].error, null);
	assert.equal(res.results[0].relations_error, "entity extraction timed out");
});

test("toMemoryList reads memory rows defensively", () => {
	// The live API returns memories at top-level `user_memories` (not under
	// `.inner`, and not under `sources` — that is the knowledge shape).
	const { memories } = toMemoryList({
		user_memories: [
			{ memory_id: "m1", memory_content: "prefers dark mode" },
			{ id: "m2", content: "likes tea" },
		],
	});
	assert.deepEqual(memories, [
		{ memory_id: "m1", memory_content: "prefers dark mode" },
		{ memory_id: "m2", memory_content: "likes tea" },
	]);
});

// The server reports how much of the corpus a listing covered; discarding it is
// what let 50 rows out of 4,000 be presented as the whole store.
test("toMemoryList carries pagination metadata", () => {
	const { page } = toMemoryList({
		user_memories: [{ memory_id: "m1", memory_content: "one" }],
		total: 412,
		pagination: { page: 1, page_size: 50, total_pages: 9, has_next: true },
	} as never);

	assert.equal(page.total, 412);
	assert.equal(page.page, 1);
	assert.equal(page.has_next, true);
	assert.equal(page.total_pages, 9);
});

// Same defensive reasoning as the rows: the SDK types this under `.inner` while
// the live API returns at top level, and camelCase appears on some paths.
test("toMemoryList reads pagination from .inner and camelCase too", () => {
	const { memories, page } = toMemoryList({
		inner: {
			user_memories: [{ memory_id: "m1", memory_content: "one" }],
			total: 7,
			pagination: { page: 2, pageSize: 25, totalPages: 4, hasNext: true },
		},
	} as never);

	assert.equal(memories.length, 1);
	assert.equal(page.total, 7);
	assert.equal(page.page, 2);
	assert.equal(page.page_size, 25);
	assert.equal(page.has_next, true);
});

// With no metadata at all, the row count is the honest answer — never invent a
// total the server did not report.
test("toMemoryList falls back to the row count when the server sends no total", () => {
	const { page } = toMemoryList({
		user_memories: [
			{ memory_id: "m1", memory_content: "one" },
			{ memory_id: "m2", memory_content: "two" },
		],
	});

	assert.equal(page.total, 2);
	assert.equal(page.has_next, undefined);
});

test("toSourceList reads source rows and total", () => {
	// The live API returns knowledge sources at top-level `sources`/`total`.
	const { sources, total } = toSourceList({
		total: 2,
		sources: [
			{ id: "s1", title: "Q3 report", type: "file" },
			{ source_id: "s2", source_type: "slack" },
		],
	});
	assert.equal(total, 2);
	assert.deepEqual(sources, [
		{ id: "s1", title: "Q3 report", type: "file" },
		{ id: "s2", title: undefined, type: "slack" },
	]);
});
