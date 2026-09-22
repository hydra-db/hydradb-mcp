/**
 * The unified `POST /query` answer and `POST /context/ingest` 202 (PRO-1618),
 * shaped exactly as CONTRACT.md states them, shared by the renderer, wrapper
 * and server tests so all three pin the same wire body.
 *
 * All four query keys are populated: two chunks (one carrying
 * `enrichment.kind`), one graph path, one declared relation, and the
 * server-built prompt with its [1], [R1], [P1] citation labels.
 */

import type { UnifiedQueryResult } from "../src/hydra/index.js";

export const UNIFIED_QUERY_FIXTURE: UnifiedQueryResult = {
	chunks: [
		{
			chunk_id: "ck_9f2",
			context_id: "chat-2026-07-29#w2",
			score: 0.87,
			content: "user: Keep answers short please\nassistant: Got it.",
			enrichment: { text: "User prefers short, bullet-point answers.", kind: "user_preference" },
		},
		{
			chunk_id: "ck_a01",
			context_id: "policy-1",
			score: 0.61,
			content: "Refund policy: 30-day window.",
		},
	],
	graph: [
		{
			triplets: [
				{
					source: { entity_id: "ent_a3f", name: "John" },
					relation: {
						predicate: "subscribed to",
						context: "John subscribed to the Pro plan.",
						temporal_details: "since June",
						relationship_id: "rel_1",
						chunk_id: "ck_9f2",
					},
					target: { entity_id: "ent_9c1", name: "Pro plan" },
				},
			],
			path_summary: "John is on the Pro plan since June 2026.",
		},
	],
	relations: [
		{
			via: { from: "linear-PRO-1169", to: "linear-PRO-1169-comment-4" },
			chunk: {
				chunk_id: "ck_c4",
				context_id: "linear-PRO-1169-comment-4",
				score: 0.55,
				content: "Comment 4: shipped the fix.",
			},
		},
	],
	llm_prompt:
		"=== CONTEXT ===\n" +
		"Cite anything you use from this context with its bracketed label, e.g. [1].\n\n" +
		"[1] context_id: chat-2026-07-29#w2\n" +
		"user: Keep answers short please\nassistant: Got it.\n\n" +
		"[2] context_id: policy-1\n" +
		"Refund policy: 30-day window.\n\n" +
		"=== RELATED CONTEXT ===\n" +
		"[R1] context_id: linear-PRO-1169-comment-4\n" +
		"Comment 4: shipped the fix.\n\n" +
		"=== GRAPH ===\n" +
		"[P1] John is on the Pro plan since June 2026.\n" +
		"    John -> subscribed to -> Pro plan [1]",
};

/** The 202 body: the result item still says `source_id`, which IS the context id. */
export const UNIFIED_INGEST_202 = {
	success: true,
	message: "queued",
	results: [
		{
			source_id: "policy-1",
			title: "Refund policy",
			status: "queued",
			infer: true,
			error: null,
			error_code: null,
		},
	],
	success_count: 1,
	failed_count: 0,
};
