/**
 * The unified `POST /query` answer and `POST /context/ingest` 202 (PRO-1618),
 * shared by the renderer, wrapper and server tests so all three pin the same
 * wire body.
 *
 * The query envelope is a REAL one, copied byte for byte from what the
 * server's own handler test renders (hydradb-application #1639): two chunks
 * whose `enrichment` is a plain string with `enrichment_kind` beside it, one
 * carrying `temporal[]`; one graph path per `origin`; one forceful relation
 * whose chunk has neither; and the markdown `llm_prompt` exactly as the
 * server's builder lays it out (`# Query results`, `## Results`,
 * `## Forceful relations`, `## Related facts`, `## Temporal facts`,
 * `## Sources`).
 */

import type { UnifiedQueryResult } from "../src/hydra/index.js";

export const UNIFIED_QUERY_ENVELOPE = {
	success: true,
	data: {
		chunks: [
			{
				chunk_id: "ck_policy_3",
				context_id: "refund-policy",
				score: 0.91,
				content: "Refunds are processed within 30 days of purchase by the Finance Department.",
				enrichment: "Refund window is 30 days; Finance owns refund processing.",
				enrichment_kind: "business_knowledge",
				temporal: [
					{
						content: "Refund policy effective_from June 2026. Start: 2026-06-01",
						start_date: "2026-06-01",
						end_date: null,
					},
				],
			},
			{
				chunk_id: "ck_chat_1",
				context_id: "chat-2026-07-29",
				score: 0.84,
				content: "user: Keep refund answers short please\nassistant: Got it.",
				enrichment: "User prefers short answers about refunds.",
				enrichment_kind: "user_preference",
			},
		],
		graph: [
			{
				origin: "query_path",
				triplets: [
					{
						source: {
							entity_id: "ent_refunds",
							name: "Refund Processing",
						},
						relation: {
							predicate: "managed by",
							context: "Refund processing is managed by the Finance Department.",
							relationship_id: "rel_managed_by",
							chunk_id: "ck_policy_3",
						},
						target: {
							entity_id: "ent_finance",
							name: "Finance Department",
						},
					},
				],
				path_summary: "Refund processing is managed by the Finance Department.",
			},
			{
				origin: "chunk_relation",
				triplets: [
					{
						source: {
							entity_id: "ent_user",
							name: "User",
						},
						relation: {
							predicate: "prefers",
							context: "The user prefers short answers about refunds.",
							relationship_id: "rel_prefers",
							chunk_id: "ck_chat_1",
						},
						target: {
							entity_id: "ent_short",
							name: "short answers",
						},
					},
				],
				path_summary: "The user prefers short answers about refunds.",
			},
		],
		forceful_relations: [
			{
				via: {
					from: "refund-policy",
					to: "refund-faq",
				},
				chunk: {
					chunk_id: "ck_faq_1",
					context_id: "refund-faq",
					score: 0,
					content: "FAQ: refunds to a card take 5 to 7 business days to appear.",
				},
			},
		],
		llm_prompt:
			"# Query results\n" +
			"\n" +
			"**Query:** who owns refund processing?\n" +
			"**Found:** 2 results across 2 sources · 2 related facts · 1 temporal fact · 1 forceful relation\n" +
			"Cite a result by its number in brackets, e.g. [1].\n" +
			"\n" +
			"## Results\n" +
			"\n" +
			"### 1. Refund policy\n" +
			"- **Relevance:** 0.91 · **Collection:** support · **Type:** file · **Category:** business_knowledge\n" +
			"- **Id:** refund-policy · **Last updated:** 2026-07-02\n" +
			"\n" +
			"Refunds are processed within 30 days of purchase by the Finance Department.\n" +
			"\n" +
			"**Enrichment:** Refund window is 30 days; Finance owns refund processing.\n" +
			"\n" +
			"---\n" +
			"\n" +
			"### 2. Support chat with Priya\n" +
			"- **Relevance:** 0.84 · **Collection:** support · **Type:** message · **Category:** user_preference\n" +
			"- **Id:** chat-2026-07-29 · **Last updated:** 2026-07-29\n" +
			"\n" +
			"user: Keep refund answers short please\n" +
			"assistant: Got it.\n" +
			"\n" +
			"**Enrichment:** User prefers short answers about refunds.\n" +
			"\n" +
			"## Forceful relations\n" +
			"\n" +
			"Linked to a result by the author at ingest time (forceful_relations), not by relevance to this query.\n" +
			"\n" +
			"### R1. Refund FAQ\n" +
			"- **Linked from:** refund-policy · **Collection:** support\n" +
			"- **Id:** refund-faq\n" +
			"\n" +
			"FAQ: refunds to a card take 5 to 7 business days to appear.\n" +
			"\n" +
			"## Related facts\n" +
			"\n" +
			"- [P1] **Refund Processing** -managed by→ **Finance Department** (query path, relevance 0.81) [1]\n" +
			"  Refund processing is managed by the Finance Department.\n" +
			"- [P2] **User** -prefers→ **short answers** (chunk relation, relevance 0.74) [2]\n" +
			"  The user prefers short answers about refunds.\n" +
			"\n" +
			"## Temporal facts\n" +
			"\n" +
			"- **Refund policy** *effective_from* → **June 2026** (from 2026-06-01, precision: month, status: ongoing; evidence: \"from June\") [1]\n" +
			"\n" +
			"## Sources\n" +
			"\n" +
			"1. **Refund policy** (file, id: refund-policy) · https://docs.acme.com/refunds · updated 2026-07-02\n" +
			"2. **Support chat with Priya** (message, id: chat-2026-07-29) · updated 2026-07-29\n" +
			"3. **Refund FAQ** (id: refund-faq)",
	} satisfies UnifiedQueryResult,
	error: null,
	meta: {
		request_id: "ab5a04df-d3c4-419c-9669-d1ea2c3f9c51",
		api_version: "2.0.1",
		latency_ms: null,
		database: "acme_corp",
		collection: "support",
	},
};

export const UNIFIED_QUERY_FIXTURE: UnifiedQueryResult = UNIFIED_QUERY_ENVELOPE.data;

/** The 202 body: the result item still says `source_id`, which IS the context id. */
export const UNIFIED_INGEST_202 = {
	success: true,
	message: "Context queued for ingestion successfully",
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
