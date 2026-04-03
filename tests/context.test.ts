import { test } from "node:test";
import assert from "node:assert/strict";

import { buildRecalledContext } from "../src/context.js";
import type { RecallResponse } from "../src/types.js";

test("buildRecalledContext includes entity paths, graph relations and extra context", () => {
	const response: RecallResponse = {
		chunks: [
			{
				chunk_uuid: "c1",
				source_id: "s1",
				chunk_content: "Chunk one body",
				source_title: "Doc A",
				extra_context_ids: ["ec1"],
			},
		],
		graph_context: {
			query_paths: [
				{
					relevancy_score: 0.9,
					combined_context: "Alice -> prefers -> tea",
					triplets: [],
				},
			],
			chunk_relations: [
				{
					relevancy_score: 0.8,
					group_id: "g1",
					triplets: [
						{
							source: { name: "Alice", type: "person", entity_id: "e1" },
							relation: {
								canonical_predicate: "prefers",
								raw_predicate: "likes",
								context: "morning routine",
								relationship_id: "r1",
								chunk_id: "c1",
							},
							target: { name: "Tea", type: "drink", entity_id: "e2" },
						},
					],
				},
			],
			chunk_id_to_group_ids: {
				c1: ["g1"],
			},
		},
		additional_context: {
			ec1: {
				chunk_uuid: "ec1",
				source_id: "s2",
				chunk_content: "Tea helps Alice focus",
				source_title: "Doc B",
			},
		},
	};

	const output = buildRecalledContext(response);

	assert.match(output, /=== ENTITY PATHS ===/);
	assert.match(output, /Alice -> prefers -> tea/);
	assert.match(output, /=== CONTEXT ===/);
	assert.match(output, /Chunk 1/);
	assert.match(output, /Source: Doc A/);
	assert.match(output, /Graph Relations:/);
	assert.match(output, /\(Alice\) —\[likes\]→ \(Tea\) \[morning routine\]/);
	assert.match(output, /Extra Context:/);
	assert.match(output, /Related Context \(Doc B\): Tea helps Alice focus/);
});

test("buildRecalledContext respects maxGroupOccurrences cap", () => {
	const makeResponse = (): RecallResponse => ({
		chunks: [
			{
				chunk_uuid: "c1",
				source_id: "s1",
				chunk_content: "Chunk A",
			},
			{
				chunk_uuid: "c2",
				source_id: "s1",
				chunk_content: "Chunk B",
			},
			{
				chunk_uuid: "c3",
				source_id: "s1",
				chunk_content: "Chunk C",
			},
		],
		graph_context: {
			query_paths: [],
			chunk_relations: [
				{
					relevancy_score: 0.9,
					group_id: "g1",
					triplets: [
						{
							source: {
								name: "Alice",
								type: "person",
								entity_id: "e1",
							},
							relation: {
								canonical_predicate: "likes",
								raw_predicate: "likes",
								context: "",
								relationship_id: "r1",
								chunk_id: "c1",
							},
							target: {
								name: "Tea",
								type: "drink",
								entity_id: "e2",
							},
						},
					],
				},
			],
			chunk_id_to_group_ids: { c1: ["g1"], c2: ["g1"], c3: ["g1"] },
		},
	});

	// With cap=1, the relation should appear only once
	const capped = buildRecalledContext(makeResponse(), {
		maxGroupOccurrences: 1,
	});
	const countCapped = (capped.match(/Alice/g) ?? []).length;
	assert.equal(
		countCapped,
		1,
		"maxGroupOccurrences=1 should show relation only on first matching chunk",
	);

	// With cap=2, the relation should appear exactly twice
	const capped2 = buildRecalledContext(makeResponse(), {
		maxGroupOccurrences: 2,
	});
	const countCapped2 = (capped2.match(/Alice/g) ?? []).length;
	assert.equal(
		countCapped2,
		2,
		"maxGroupOccurrences=2 should show relation on first two matching chunks",
	);

	// With no cap (default), the relation appears for all 3 chunks
	const uncapped = buildRecalledContext(makeResponse());
	const countUncapped = (uncapped.match(/Alice/g) ?? []).length;
	assert.equal(
		countUncapped,
		3,
		"no maxGroupOccurrences cap → relation should appear for every matching chunk",
	);
});

test("buildRecalledContext fallback path respects maxGroupOccurrences", () => {
	// Two separate groups, each with one triplet referencing a different chunk.
	// Neither chunk is in chunk_id_to_group_ids, so fallback path is used.
	const response: RecallResponse = {
		chunks: [
			{ chunk_uuid: "c1", source_id: "s1", chunk_content: "Chunk A" },
			{ chunk_uuid: "c2", source_id: "s1", chunk_content: "Chunk B" },
			{ chunk_uuid: "c3", source_id: "s1", chunk_content: "Chunk C" },
		],
		graph_context: {
			query_paths: [],
			chunk_relations: [
				{
					relevancy_score: 0.9,
					group_id: "g1",
					triplets: [
						{
							source: { name: "Bob", type: "person", entity_id: "e1" },
							relation: {
								canonical_predicate: "works_at",
								raw_predicate: "works at",
								context: "",
								relationship_id: "r1",
								chunk_id: "c1",
							},
							target: { name: "Acme", type: "org", entity_id: "e2" },
						},
					],
				},
				{
					relevancy_score: 0.9,
					group_id: "g2",
					triplets: [
						{
							source: { name: "Bob", type: "person", entity_id: "e1" },
							relation: {
								canonical_predicate: "works_at",
								raw_predicate: "works at",
								context: "",
								relationship_id: "r2",
								chunk_id: "c2",
							},
							target: { name: "Acme", type: "org", entity_id: "e2" },
						},
					],
				},
				{
					relevancy_score: 0.9,
					group_id: "g3",
					triplets: [
						{
							source: { name: "Bob", type: "person", entity_id: "e1" },
							relation: {
								canonical_predicate: "works_at",
								raw_predicate: "works at",
								context: "",
								relationship_id: "r3",
								chunk_id: "c3",
							},
							target: { name: "Acme", type: "org", entity_id: "e2" },
						},
					],
				},
			],
			// No chunk_id_to_group_ids entries — forces fallback path
			chunk_id_to_group_ids: {},
		},
	};

	// With cap=1, each group appears once — one relation per chunk via fallback
	const capped = buildRecalledContext(response, { maxGroupOccurrences: 1 });
	const countCapped = (capped.match(/Bob/g) ?? []).length;
	assert.equal(countCapped, 3, "fallback path: cap=1, each group used once per chunk");

	// With cap=2, same result since each group only has one matching chunk
	const capped2 = buildRecalledContext(response, { maxGroupOccurrences: 2 });
	const countCapped2 = (capped2.match(/Bob/g) ?? []).length;
	assert.equal(countCapped2, 3, "fallback path: cap=2, same as uncapped here");
});

test("buildRecalledContext capped primary groups do not trigger fallback", () => {
	// Chunk c2 is linked to g1 via chunk_id_to_group_ids, but g1 is already
	// capped from c1. c2 should NOT fall through to the fallback path and
	// pick up unrelated group g2.
	const response: RecallResponse = {
		chunks: [
			{ chunk_uuid: "c1", source_id: "s1", chunk_content: "Chunk A" },
			{ chunk_uuid: "c2", source_id: "s1", chunk_content: "Chunk B" },
		],
		graph_context: {
			query_paths: [],
			chunk_relations: [
				{
					relevancy_score: 0.9,
					group_id: "g1",
					triplets: [
						{
							source: { name: "Alice", type: "person", entity_id: "e1" },
							relation: {
								canonical_predicate: "likes",
								raw_predicate: "likes",
								context: "",
								relationship_id: "r1",
								chunk_id: "c1",
							},
							target: { name: "Tea", type: "drink", entity_id: "e2" },
						},
					],
				},
				{
					relevancy_score: 0.9,
					group_id: "g2",
					triplets: [
						{
							source: { name: "Unrelated", type: "thing", entity_id: "e3" },
							relation: {
								canonical_predicate: "exists",
								raw_predicate: "exists",
								context: "",
								relationship_id: "r2",
								chunk_id: "c2",
							},
							target: { name: "Nowhere", type: "place", entity_id: "e4" },
						},
					],
				},
			],
			// Both chunks linked to g1; g2 is NOT linked to any chunk
			chunk_id_to_group_ids: { c1: ["g1"], c2: ["g1"] },
		},
	};

	// With cap=1, g1 is used for c1 and capped for c2.
	// c2 should NOT pick up g2 via fallback (g2 has a triplet with chunk_id=c2
	// but c2 has a primary link to g1, so fallback should not trigger)
	const result = buildRecalledContext(response, { maxGroupOccurrences: 1 });
	assert.ok(
		!result.includes("Unrelated"),
		"capped primary groups should not trigger fallback to unlinked groups",
	);
});

test("buildRecalledContext filters low-score relations by default", () => {
	const response: RecallResponse = {
		chunks: [
			{
				chunk_uuid: "c1",
				source_id: "s1",
				chunk_content: "Chunk one body",
			},
		],
		graph_context: {
			query_paths: [],
			chunk_relations: [
				{
					relevancy_score: 0.2,
					group_id: "g1",
					triplets: [
						{
							source: { name: "Alice", type: "person", entity_id: "e1" },
							relation: {
								canonical_predicate: "prefers",
								raw_predicate: "likes",
								context: "context",
								relationship_id: "r1",
								chunk_id: "c1",
							},
							target: { name: "Tea", type: "drink", entity_id: "e2" },
						},
					],
				},
			],
			chunk_id_to_group_ids: {
				c1: ["g1"],
			},
		},
	};

	const output = buildRecalledContext(response);

	assert.doesNotMatch(output, /Graph Relations:/);
	assert.doesNotMatch(output, /Alice/);
});

