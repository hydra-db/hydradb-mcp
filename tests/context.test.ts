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

