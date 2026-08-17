import { test } from "node:test";
import assert from "node:assert/strict";

import {
	buildRecalledContext,
	renderRecalledContext,
	renderedChunkCount,
} from "../src/context.js";
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


// Ingest can store a chunk whose body is the serialised source record rather
// than the text. Rendered verbatim that ships ids and tenant identifiers into
// the prompt in place of the content, and the reader has to parse it back out.
test("buildRecalledContext unwraps a v2 source envelope", () => {
	const out = buildRecalledContext({
		chunks: [
			{
				chunk_uuid: "c1",
				source_id: "s9",
				chunk_content:
					'{"id":"s9","tenant_id":"t","content":{"text":"the actual body text"}}',
			},
		],
	} as never);

	assert.match(out, /the actual body text/);
	assert.doesNotMatch(out, /tenant_id/, "internal fields must not reach the prompt");
	assert.doesNotMatch(out, /"content":/);
});

test("buildRecalledContext prefers text over markdown in an envelope", () => {
	const out = buildRecalledContext({
		chunks: [
			{
				chunk_uuid: "c1",
				source_id: "s9",
				chunk_content:
					'{"id":"s9","tenant_id":"t","content":{"text":"plain body","markdown":"# md body"}}',
			},
		],
	} as never);

	assert.match(out, /plain body/);
	assert.doesNotMatch(out, /# md body/);
});

test("buildRecalledContext falls back to markdown when text is absent", () => {
	const out = buildRecalledContext({
		chunks: [
			{
				chunk_uuid: "c1",
				source_id: "s9",
				chunk_content: '{"id":"s9","tenant_id":"t","content":{"markdown":"# md body"}}',
			},
		],
	} as never);

	assert.match(out, /# md body/);
});

// Only the envelope shape is unwrapped. Content that merely looks like JSON, or
// is malformed, or is a JSON object of some other shape, is left untouched —
// unwrapping it would silently drop what the user actually stored.
test("buildRecalledContext leaves non-envelope content untouched", () => {
	for (const body of [
		'{"not":"an envelope"}',
		'{"id":"s9","tenant_id":"t","content":"a string, not an object"}',
		"{ this is not valid json }",
		"a plain sentence about {braces}",
	]) {
		const out = buildRecalledContext({
			chunks: [{ chunk_uuid: "c1", source_id: "s9", chunk_content: body }],
		} as never);
		assert.match(
			out,
			new RegExp(body.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
			`content should be preserved verbatim: ${body}`,
		);
	}
});

// `source_chunk_ids` is the server's explicit statement of which chunks a
// relation came from, and the mapping the SDK's own renderer prefers. It was
// dropped by the adapter, so a relation linked ONLY that way — with no entry in
// chunk_id_to_group_ids and no matching triplet.chunk_id — vanished from the
// output. The graph traversal was paid for and the result discarded.
test("buildRecalledContext attaches relations linked only by source_chunk_ids", () => {
	const out = buildRecalledContext({
		chunks: [{ chunk_uuid: "c1", source_id: "s1", chunk_content: "body" }],
		graph_context: {
			query_paths: [],
			chunk_relations: [
				{
					relevancy_score: 0.9,
					group_id: "g1",
					source_chunk_ids: ["c1"],
					triplets: [
						{
							source: { name: "Alice" },
							relation: { raw_predicate: "likes", context: "" },
							target: { name: "Tea" },
						},
					],
				},
			],
			// Deliberately empty: the indirect route cannot find this relation.
			chunk_id_to_group_ids: {},
		},
	} as never);

	assert.match(out, /Graph Relations:/);
	assert.match(out, /Alice.*likes.*Tea/);
});

// When the server links both ways, the relation must appear once, not twice.
test("buildRecalledContext does not double-attach a relation linked both ways", () => {
	const out = buildRecalledContext({
		chunks: [{ chunk_uuid: "c1", source_id: "s1", chunk_content: "body" }],
		graph_context: {
			query_paths: [],
			chunk_relations: [
				{
					relevancy_score: 0.9,
					group_id: "g1",
					source_chunk_ids: ["c1"],
					triplets: [
						{
							source: { name: "Alice" },
							relation: { raw_predicate: "likes", context: "" },
							target: { name: "Tea" },
						},
					],
				},
			],
			chunk_id_to_group_ids: { c1: ["g1"] },
		},
	} as never);

	assert.equal(
		out.match(/Alice/g)?.length,
		1,
		"a relation reachable by both routes must be attached exactly once",
	);
});

// The direct route must not suppress the score filter.
test("buildRecalledContext still drops low-scoring relations linked directly", () => {
	const out = buildRecalledContext({
		chunks: [{ chunk_uuid: "c1", source_id: "s1", chunk_content: "body" }],
		graph_context: {
			query_paths: [],
			chunk_relations: [
				{
					relevancy_score: 0.15,
					group_id: "g1",
					source_chunk_ids: ["c1"],
					triplets: [
						{
							source: { name: "Bob" },
							relation: { raw_predicate: "dislikes", context: "" },
							target: { name: "Coffee" },
						},
					],
				},
			],
			chunk_id_to_group_ids: {},
		},
	} as never);

	assert.doesNotMatch(out, /Bob/);
});

// Greptile, PR #46: a nested content.text was enough to trigger unwrapping, so a
// legitimate JSON document with that shape lost every sibling and outer field.
test("buildRecalledContext does not unwrap JSON that merely looks like an envelope", () => {
	const stored = '{"content":{"text":"a fragment"},"author":"ada","tags":["x"]}';
	const out = buildRecalledContext({
		chunks: [{ chunk_uuid: "c1", source_id: "s9", chunk_content: stored }],
	} as never);

	// Without an identifying source field this is just a document the user
	// stored, and it must survive intact.
	assert.match(out, /author/);
	assert.match(out, /tags/);
	assert.ok(
		out.includes(stored),
		"a non-envelope document must be preserved verbatim, not reduced to content.text",
	);
});

test("buildRecalledContext still unwraps a real envelope carrying an id", () => {
	const out = buildRecalledContext({
		chunks: [
			{
				chunk_uuid: "c1",
				source_id: "s9",
				chunk_content:
					'{"id":"s9","tenant_id":"t","content":{"text":"the actual body"}}',
			},
		],
	} as never);

	assert.match(out, /the actual body/);
	assert.doesNotMatch(out, /tenant_id/);
});

// Greptile, PR #46 (second pass): an `id` alongside `content.text` was still not
// enough. A stored document can legitimately carry both, and unwrapping it drops
// every other field.
test("buildRecalledContext keeps a document that has an id but also unknown fields", () => {
	const stored =
		'{"id":"cfg-1","content":{"text":"the body"},"version":2,"owner":"ada"}';
	const out = buildRecalledContext({
		chunks: [{ chunk_uuid: "c1", source_id: "s9", chunk_content: stored }],
	} as never);

	assert.ok(
		out.includes(stored),
		"an unrecognised sibling field means this is a document, not an envelope",
	);
	assert.match(out, /version/);
	assert.match(out, /owner/);
});

// The inverse must still work. This is the envelope shape observed from the live
// API: scoping identifiers and the content, nothing else — so unwrapping it
// provably loses nothing.
test("buildRecalledContext unwraps an envelope of pure scoping fields", () => {
	const out = buildRecalledContext({
		chunks: [
			{
				chunk_uuid: "c1",
				source_id: "s9",
				chunk_content:
					'{"id":"s9","tenant_id":"t","sub_tenant_id":"c","content":{"text":"the actual body"}}',
			},
		],
	} as never);

	assert.match(out, /the actual body/);
	assert.doesNotMatch(out, /tenant_id/);
});

// Greptile, PR #46 (fourth pass): `title`, `metadata` and `timestamp` are
// envelope field names AND places user data lives. A record carrying any of
// them populated must be left alone, because unwrapping would discard exactly
// that data.
test("a record with populated non-scoping fields is never unwrapped", () => {
	for (const doc of [
		'{"id":"s9","tenant_id":"t","title":"Q3 report","content":{"text":"body"}}',
		'{"tenant_id":"t","timestamp":"2026-01-01","content":{"text":"body"}}',
		'{"tenant_id":"t","metadata":{"team":"platform"},"content":{"text":"body"}}',
	]) {
		const out = buildRecalledContext({
			chunks: [{ chunk_uuid: "c1", source_id: "s9", chunk_content: doc }],
		} as never);
		assert.ok(out.includes(doc), `must survive verbatim: ${doc}`);
	}
});

// Empty values are not data, so they do not block unwrapping.
test("an envelope with empty non-scoping fields still unwraps", () => {
	const out = buildRecalledContext({
		chunks: [
			{
				chunk_uuid: "c1",
				source_id: "s9",
				chunk_content:
					'{"id":"s9","tenant_id":"t","title":"","metadata":{},"content":{"text":"the actual body"}}',
			},
		],
	} as never);

	assert.match(out, /the actual body/);
	assert.doesNotMatch(out, /tenant_id/);
});

// Greptile, PR #46 (third pass): an `id` is not evidence of an envelope, and
// neither are `title`/`metadata`/`timestamp` — all names a user's own document
// plausibly uses. Only the internal scoping fields are ours alone.
test("buildRecalledContext keeps a document whose fields merely look internal", () => {
	const stored =
		'{"id":"doc-1","title":"Notes","timestamp":"2026-01-01","content":{"text":"the body"}}';
	const out = buildRecalledContext({
		chunks: [{ chunk_uuid: "c1", source_id: "s9", chunk_content: stored }],
	} as never);

	assert.ok(
		out.includes(stored),
		"without tenant_id this is a user document and must survive verbatim",
	);
	assert.match(out, /Notes/);
	assert.match(out, /2026-01-01/);
});

// Retrieval returns overlapping windows over the same source, so a short chunk
// is frequently a literal substring of a longer one. In a live 15-chunk sample,
// 4 were fully contained in another — roughly a quarter of the body re-sent.
test("buildRecalledContext suppresses chunks contained in another chunk", () => {
	const long = "The user prefers tabs over spaces in every language they write.";
	const short = "prefers tabs over spaces";

	const response = {
		chunks: [
			{ chunk_uuid: "c1", source_id: "same-doc", chunk_content: long },
			{ chunk_uuid: "c2", source_id: "same-doc", chunk_content: short },
		],
	} as never;

	const out = buildRecalledContext(response);

	assert.match(out, /every language they write/, "the longer body must survive");
	// Both chunks are still rendered — only the duplicated BODY collapses, since
	// each chunk's id, score and relations exist nowhere else.
	assert.equal(out.match(/^Chunk \d+/gm)?.length, 2);
	assert.match(out, /same text as Chunk 1/);
	// The duplicated text appears once.
	assert.equal(out.match(/prefers tabs over spaces/g)?.length, 1);
	assert.equal(renderedChunkCount(response), 2);
});

test("buildRecalledContext keeps genuinely different chunks", () => {
	const response = {
		chunks: [
			{ chunk_uuid: "c1", source_id: "s1", chunk_content: "prefers tabs over spaces" },
			{ chunk_uuid: "c2", source_id: "s2", chunk_content: "deploys on Tuesday and Thursday" },
		],
	} as never;

	assert.equal(renderedChunkCount(response), 2);
	assert.equal(buildRecalledContext(response).match(/Chunk \d/g)?.length, 2);
});

// Whitespace differences are not content differences.
test("containment ignores whitespace and case", () => {
	const response = {
		chunks: [
			{ chunk_uuid: "c1", source_id: "same-doc", chunk_content: "The User Prefers Tabs Over Spaces" },
			{ chunk_uuid: "c2", source_id: "same-doc", chunk_content: "  prefers   tabs\n over spaces  " },
		],
	} as never;

	assert.match(buildRecalledContext(response), /same text as Chunk 1/);
});

// Identical bodies collapse to one, keeping the higher-ranked chunk.
test("identical chunks collapse to a single rendering", () => {
	const body = "the user deploys on Tuesday";
	const response = {
		chunks: [
			{ chunk_uuid: "c1", source_id: "one-doc", chunk_content: body, relevancy_score: 0.9 },
			{ chunk_uuid: "c2", source_id: "one-doc", chunk_content: body, relevancy_score: 0.4 },
		],
	} as never;

	const out = buildRecalledContext(response);
	assert.equal(out.match(/^Chunk \d+/gm)?.length, 2);
	assert.equal(out.match(/the user deploys on Tuesday/g)?.length, 1);
	assert.match(out, /same text as Chunk 1/);
});

// Chunk numbering must follow what is rendered, or it points at nothing.
test("chunk numbering is contiguous after suppression", () => {
	const response = {
		chunks: [
			{ chunk_uuid: "c1", source_id: "doc-a", chunk_content: "alpha body that is long enough" },
			{ chunk_uuid: "c2", source_id: "doc-a", chunk_content: "alpha body" },
			{ chunk_uuid: "c3", source_id: "doc-b", chunk_content: "beta body entirely different" },
		],
	} as never;

	const out = buildRecalledContext(response);
	// All three render; chunk 2's body points at chunk 1.
	assert.match(out, /Chunk 1/);
	assert.match(out, /Chunk 2/);
	assert.match(out, /Chunk 3/);
	assert.match(out, /same text as Chunk 1/);
	assert.match(out, /beta body entirely different/);
});

// The id-keyed dedupe never noticed the same passage arriving under two ids.
test("extra context is deduped by content, not only by id", () => {
	const passage = "Tea helps Alice focus in the morning.";
	const out = buildRecalledContext({
		chunks: [
			{
				chunk_uuid: "c1",
				source_id: "s1",
				chunk_content: "chunk one",
				extra_context_ids: ["e1", "e2"],
			},
		],
		additional_context: {
			e1: { chunk_uuid: "e1", source_id: "x", chunk_content: passage },
			e2: { chunk_uuid: "e2", source_id: "y", chunk_content: `  ${passage}  ` },
		},
	} as never);

	assert.equal(
		out.match(/Tea helps Alice focus/g)?.length,
		1,
		"the same passage under two ids must be emitted once",
	);
});

// Greptile, PR #49: suppression must be scoped to ONE source. Two documents can
// legitimately hold the same sentence, and dropping one of those does not remove
// duplication — it removes a MATCH, taking its id, score and graph relations with
// it, so the caller can no longer discover that source at all.
test("identical text from DIFFERENT sources is never suppressed", () => {
	const shared = "Deploys go out on Tuesday and Thursday.";
	const response = {
		chunks: [
			{ chunk_uuid: "c1", source_id: "runbook", chunk_content: shared, relevancy_score: 0.9 },
			{ chunk_uuid: "c2", source_id: "onboarding", chunk_content: shared, relevancy_score: 0.8 },
		],
	} as never;

	const out = buildRecalledContext(response);

	assert.equal(renderedChunkCount(response), 2);
	assert.match(out, /runbook/, "each source id must remain discoverable");
	assert.match(out, /onboarding/);
});

test("a substring match across sources is kept", () => {
	const response = {
		chunks: [
			{
				chunk_uuid: "c1",
				source_id: "doc-a",
				chunk_content: "The user prefers tabs over spaces in every language.",
			},
			{ chunk_uuid: "c2", source_id: "doc-b", chunk_content: "prefers tabs over spaces" },
		],
	} as never;

	assert.equal(renderedChunkCount(response), 2);
});

// The same passage cited under a different source title is a second citation,
// not a duplicate — dropping it strips that chunk's attribution entirely.
test("extra context with the same text but a different title is kept", () => {
	const passage = "Tea helps Alice focus.";
	const out = buildRecalledContext({
		chunks: [
			{
				chunk_uuid: "c1",
				source_id: "s1",
				chunk_content: "chunk one",
				extra_context_ids: ["e1", "e2"],
			},
		],
		additional_context: {
			e1: { chunk_uuid: "e1", source_id: "x", chunk_content: passage, source_title: "Doc A" },
			e2: { chunk_uuid: "e2", source_id: "y", chunk_content: passage, source_title: "Doc B" },
		},
	} as never);

	assert.match(out, /Doc A/);
	assert.match(out, /Doc B/, "a different attribution is not a duplicate");
});

// Greptile, PR #49: block placement is the ONLY thing tying an extra-context
// passage to its chunk, so suppressing a repeat outright left the later chunk
// looking as though it referenced nothing at all.
test("a repeated extra-context passage cites where it was shown", () => {
	const passage = "Tea helps Alice focus in the morning.";
	const out = buildRecalledContext({
		chunks: [
			{
				chunk_uuid: "c1",
				source_id: "s1",
				chunk_content: "first chunk body",
				extra_context_ids: ["e1"],
			},
			{
				chunk_uuid: "c2",
				source_id: "s2",
				chunk_content: "second chunk body entirely different",
				extra_context_ids: ["e2"],
			},
		],
		additional_context: {
			e1: { chunk_uuid: "e1", source_id: "x", chunk_content: passage },
			e2: { chunk_uuid: "e2", source_id: "y", chunk_content: passage },
		},
	} as never);

	// Sent once...
	assert.equal(
		out.match(/Tea helps Alice focus/g)?.length,
		1,
		"the passage itself must not be repeated",
	);
	// ...but the second chunk still shows that it referenced something.
	assert.match(out, /same as Chunk 1/);
	const secondChunk = out.slice(out.indexOf("Chunk 2"));
	assert.match(secondChunk, /Extra Context:/, "chunk 2 must not look context-free");
});

// Greptile, PR #49: dropping a contained chunk removed more than duplicated
// text. Its id, score, graph relations and extra-context references belong to
// that chunk and exist nowhere else, so the caller lost a discoverable source.
test("a contained chunk keeps its id, score and relations", () => {
	const long = "The user prefers tabs over spaces in every language they write.";
	const out = buildRecalledContext({
		chunks: [
			{
				chunk_uuid: "c1",
				source_id: "doc",
				chunk_content: long,
				relevancy_score: 0.9,
			},
			{
				chunk_uuid: "c2",
				source_id: "doc",
				chunk_content: "prefers tabs over spaces",
				relevancy_score: 0.7,
				extra_context_ids: ["e1"],
			},
		],
		additional_context: {
			e1: { chunk_uuid: "e1", source_id: "x", chunk_content: "a related passage" },
		},
		graph_context: {
			query_paths: [],
			chunk_relations: [
				{
					relevancy_score: 0.9,
					group_id: "g1",
					source_chunk_ids: ["c2"],
					triplets: [
						{
							source: { name: "Alice" },
							relation: { raw_predicate: "likes", context: "" },
							target: { name: "Tabs" },
						},
					],
				},
			],
			chunk_id_to_group_ids: {},
		},
	} as never);

	// The body is sent once...
	assert.equal(out.match(/prefers tabs over spaces/g)?.length, 1);
	// ...but everything that is NOT the body survives on the second chunk.
	assert.match(out, /\(70%\)/, "its score must survive");
	assert.match(out, /Alice.*likes.*Tabs/, "its graph relation must survive");
	assert.match(out, /a related passage/, "its extra context must survive");
});

// The whole rendering must fit the ceiling, including the entity-path prefix.
test("entity paths count against the output budget", () => {
	const out = buildRecalledContext(
		{
			chunks: Array.from({ length: 20 }, (_, i) => ({
				chunk_uuid: `c${i}`,
				source_id: `s${i}`,
				chunk_content: `body-${i} ` + "x".repeat(3000),
			})),
			graph_context: {
				query_paths: Array.from({ length: 200 }, (_, i) => ({
					relevancy_score: 0.9,
					combined_context: `entity path ${i} ` + "p".repeat(200),
					triplets: [],
				})),
				chunk_relations: [],
				chunk_id_to_group_ids: {},
			},
		} as never,
		{ maxTotalChars: 20_000 },
	);

	assert.ok(
		out.length <= 20_000,
		`the whole rendering must fit the ceiling, got ${out.length}`,
	);
	assert.match(out, /ENTITY PATHS/, "the prefix is still included, just budgeted");
});

// Greptile, PR #49: the count was derived by matching /^Chunk \d+/ over the
// finished text, so a stored body containing such a line was counted as a
// rendered section and `Found N` announced more matches than existed.
test("content that looks like a chunk header does not inflate the count", () => {
	const { shown, text } = renderRecalledContext({
		chunks: [
			{
				chunk_uuid: "c1",
				source_id: "s1",
				chunk_content: "Chunk 5 of the manual covers rollback.\nChunk 6 covers restore.",
			},
			{ chunk_uuid: "c2", source_id: "s2", chunk_content: "an unrelated body" },
		],
	} as never);

	assert.equal(shown, 2, "only real sections count");
	// The body itself is untouched — it is the caller's content.
	assert.match(text, /Chunk 5 of the manual/);
});

// Greptile, PR #49: a `(same text as Chunk N)` pointer must always resolve.
// Two ways it could dangle, both now impossible.
test("a body pointer never aims forward, where truncation could remove it", () => {
	// The LONGER body is second, so the naive rule would point chunk 1 forward
	// at chunk 2 — and truncation drops from the end.
	const long = "The user prefers tabs over spaces in every language they write.";
	const out = buildRecalledContext({
		chunks: [
			{ chunk_uuid: "c1", source_id: "doc", chunk_content: "prefers tabs over spaces" },
			{ chunk_uuid: "c2", source_id: "doc", chunk_content: long },
		],
	} as never);

	assert.doesNotMatch(out, /same text as Chunk 2/, "a pointer must not aim forward");
	// Both bodies are present rather than one pointing at something that may go.
	assert.match(out, /prefers tabs over spaces/);
	assert.match(out, /every language they write/);
});

test("compact rendering never collapses bodies into a pointer", () => {
	const shared = "y".repeat(400);
	const out = buildRecalledContext(
		{
			chunks: [
				{ chunk_uuid: "c1", source_id: "doc", chunk_content: `${"x".repeat(2000)}${shared}` },
				{ chunk_uuid: "c2", source_id: "doc", chunk_content: shared },
			],
		} as never,
		{ maxChunkChars: 600 },
	);

	// The shared text sits past chunk 1's 600-character cut, so a pointer would
	// promise content the rendered response does not contain.
	assert.doesNotMatch(out, /same text as Chunk/);
	assert.match(out, new RegExp(shared.slice(0, 50)), "the second body is rendered");
});
