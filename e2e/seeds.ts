/**
 * What the live tier writes, and what it expects to read back. Every id starts
 * with `e2e-`; `KEPT_*` are the items no scenario removes.
 */
import { connectorMetadata } from "./data.js";

export const NAMED = "e2e-named";
export const DROPPED = "e2e-drop";
export const MISSING_CONNECTOR = "conn_e2e_missing_000000000000";
export const PAGE_ROWS = 50;
export const LARGE_DOCS = 6;

export const TEXT = {
	"e2e-m-text": "The user prefers stacked pull requests, each layer small and focused on one change.",
	"e2e-m-item-1": "The user drinks filter coffee every morning before standup.",
	"e2e-m-item-2": "The user runs ten kilometres every Saturday along the river.",
	"e2e-m-raw": "ERR_LEDGER_LOCK_TIMEOUT after 30s on shard 7 (verbatim error string).",
	"e2e-m-del": "A temporary memory that the delete scenario removes.",
	"e2e-k-plain": "The ledger runbook covers regional failover.",
	"e2e-k-titled": "Grace owns the ledger service.",
	"e2e-k-wide": "Thread about the ledger failover drill in the payments on-call channel.",
	"e2e-k-rel": "Billing depends on the ledger service for every invoice it settles.",
	"e2e-k-evidence": "Ada prefers pnpm for every JavaScript repository she maintains.",
	"e2e-k-graph": "Ada mentors Grace on the payments team.",
	"e2e-k-item-1": "Item one is about ledger reconciliation at month end.",
	"e2e-k-item-2": "Item two is about nightly billing exports.",
	"e2e-k-named": "Invoices are exported nightly to the finance bucket.",
	"e2e-k-upd": "A document the update scenario edits.",
	"e2e-k-del": "A temporary document that the delete scenario removes.",
	"e2e-k-drop": "A document in the collection the suite drops.",
} as const;

export type TextId = keyof typeof TEXT;

export const TURNS = [{ user: "I moved to Pune last month.", assistant: "Noted: you live in Pune now." }];

export const FILE_TEXT = "# Quarterly plan\n\nThe payments team migrates the ledger to the new cluster in Q1.\n";

export const pageId = (i: number) => `e2e-k-page-${i}`;
const pageText = (i: number) => `Connector message ${i} from the payments on-call channel about drill step ${i}.`;
export const largeId = (d: number) => `e2e-k-large-${d}`;

export function largeText(d: number): string {
	const paragraphs: string[] = [];

	for (let p = 0; p < 40; p++) {
		paragraphs.push(
			`Ledger failover drill note ${d}-${p}: the ledger service replicates journal entries to the standby ` +
				`region, and the drill checks that reconciliation of balances finishes within the agreed window ` +
				`for shard ${p} of document ${d}.`,
		);
	}

	return paragraphs.join("\n\n");
}

export const WIDE_METADATA = connectorMetadata(0);

const GRAPH = {
	entities: { ada: { name: "Ada", type: "Person" }, grace: { name: "Grace", type: "Person" } },
	relations: [{ source: "ada", target: "grace", predicate: "mentors" }],
};

export const APP_METADATA = { slack_ts: "1732780000.000999", channel_name: "payments-oncall" };

/** Fake principals under a reserved test domain. */
export const ALICE_EMAIL = "alice@e2e.hydradb.test";
export const ALICE = `user_email:${ALICE_EMAIL}`;
export const BOB = "user_email:bob@e2e.hydradb.test";

/** An app item the access-control scenarios read back. Titles and bodies are unique, so a leak shows in any output. */
export interface AclItem {
	id: string;
	title: string;
	body: string;
}

export const ACL_OPEN: AclItem = { id: "e2e-k-acl-open", title: "Open heron note", body: "The heron migration log is open to every reader." };
export const ACL_ALICE: AclItem = { id: "e2e-k-acl-alice", title: "Alice heron note", body: "Alice keeps the heron migration budget in vault seven." };
export const ACL_PRIVATE: AclItem = { id: "e2e-k-acl-private", title: "Private heron note", body: "The private heron census lists nesting sites by grid square." };
/** Restricted to Alice like ACL_ALICE, but only the ACL change scenario reads it, so that scenario can edit it. */
export const ACL_FLIP: AclItem = { id: "e2e-k-acl-flip", title: "Flip heron note", body: "Alice drafts the heron flip memo before review." };
/** The three the read scenarios assert on: unrestricted, Alice's, private. */
export const ACL_ITEMS = [ACL_OPEN, ACL_ALICE, ACL_PRIVATE];

const appItem = (item: AclItem) => ({ id: item.id, title: item.title, kind: "custom", fields: { body: item.body } });

export interface Seed {
	/** The ingest scenario that asserts this call's answer. */
	scenario: string;
	args: Record<string, unknown>;
	ids: string[];
	collection?: string;
}

export const SEEDS: Seed[] = [
	{ scenario: "ingest.memory.text", args: { text: TEXT["e2e-m-text"], source_id: "e2e-m-text" }, ids: ["e2e-m-text"] },
	{
		scenario: "ingest.memory.turns",
		args: { turns: TURNS, source_id: "e2e-m-turns", user_name: "Riya" },
		ids: ["e2e-m-turns"],
	},
	{
		scenario: "ingest.memory.items",
		args: {
			items: [
				{ text: TEXT["e2e-m-item-1"], source_id: "e2e-m-item-1" },
				{ text: TEXT["e2e-m-item-2"], source_id: "e2e-m-item-2", title: "Weekend running" },
			],
		},
		ids: ["e2e-m-item-1", "e2e-m-item-2"],
	},
	{
		scenario: "ingest.memory.infer_false",
		args: { text: TEXT["e2e-m-raw"], source_id: "e2e-m-raw", infer: false, additional_metadata: { origin: "e2e" } },
		ids: ["e2e-m-raw"],
	},
	{ scenario: "delete.item", args: { text: TEXT["e2e-m-del"], source_id: "e2e-m-del" }, ids: ["e2e-m-del"] },
	{
		scenario: "ingest.knowledge.text",
		args: { kind: "knowledge", text: TEXT["e2e-k-plain"], source_id: "e2e-k-plain" },
		ids: ["e2e-k-plain"],
	},
	{
		scenario: "ingest.knowledge.text_titled",
		args: { kind: "knowledge", text: TEXT["e2e-k-titled"], title: "Ledger ownership", source_id: "e2e-k-titled" },
		ids: ["e2e-k-titled"],
	},
	{
		scenario: "ingest.knowledge.metadata",
		args: {
			kind: "knowledge",
			text: TEXT["e2e-k-wide"],
			title: "Failover drill thread",
			source_id: "e2e-k-wide",
			metadata: { team: "payments" },
			additional_metadata: WIDE_METADATA,
		},
		ids: ["e2e-k-wide"],
	},
	{
		scenario: "ingest.knowledge.relations",
		args: {
			kind: "knowledge",
			text: TEXT["e2e-k-rel"],
			title: "Billing dependencies",
			source_id: "e2e-k-rel",
			relations: { ids: ["e2e-k-titled"] },
		},
		ids: ["e2e-k-rel"],
	},
	{
		scenario: "ingest.knowledge.evidence",
		args: {
			kind: "knowledge",
			text: TEXT["e2e-k-evidence"],
			title: "Ada tooling",
			source_id: "e2e-k-evidence",
			evidence_kind: "said",
			evidence_subject: "person:ada",
		},
		ids: ["e2e-k-evidence"],
	},
	{
		scenario: "ingest.knowledge.graph",
		args: { kind: "knowledge", text: TEXT["e2e-k-graph"], title: "Mentoring", source_id: "e2e-k-graph", graph: GRAPH },
		ids: ["e2e-k-graph"],
	},
	{
		scenario: "ingest.knowledge.items",
		args: {
			kind: "knowledge",
			items: [
				{ text: TEXT["e2e-k-item-1"], source_id: "e2e-k-item-1" },
				{ text: TEXT["e2e-k-item-2"], source_id: "e2e-k-item-2", title: "Billing exports" },
			],
		},
		ids: ["e2e-k-item-1", "e2e-k-item-2"],
	},
	{
		scenario: "ingest.knowledge.page",
		args: {
			kind: "knowledge",
			items: Array.from({ length: PAGE_ROWS }, (_, i) => ({
				text: pageText(i),
				source_id: pageId(i),
				title: `Slack message ${i}`,
				infer: false,
				additional_metadata: connectorMetadata(i + 1),
			})),
		},
		ids: Array.from({ length: PAGE_ROWS }, (_, i) => pageId(i)),
	},
	{
		scenario: "ingest.knowledge.large",
		args: {
			kind: "knowledge",
			items: Array.from({ length: LARGE_DOCS }, (_, d) => ({
				text: largeText(d),
				source_id: largeId(d),
				title: `Ledger drill notes ${d}`,
				infer: false,
			})),
		},
		ids: Array.from({ length: LARGE_DOCS }, (_, d) => largeId(d)),
	},
	{
		scenario: "ingest.knowledge.file_base64",
		args: {
			file: { filename: "plan.md", content_base64: Buffer.from(FILE_TEXT).toString("base64") },
			source_id: "e2e-k-file",
			title: "Quarterly plan",
		},
		ids: ["e2e-k-file"],
	},
	{
		scenario: "ingest.knowledge.app",
		args: {
			kind: "knowledge",
			app_knowledge: [
				{
					id: "e2e-k-app",
					title: "Ledger failover ticket",
					kind: "ticket",
					provider: "jira",
					external_id: "E2E-1",
					fields: { status: "open", summary: "Ledger failover takes too long" },
					additional_metadata: APP_METADATA,
				},
			],
		},
		ids: ["e2e-k-app"],
	},
	{
		// Alice's and the private item link to the open one, so a subgraph from it crosses into both.
		scenario: "ingest.knowledge.acl",
		args: {
			kind: "knowledge",
			app_knowledge: [
				appItem(ACL_OPEN),
				{ ...appItem(ACL_ALICE), acl: [ALICE], relations: { ids: [ACL_OPEN.id] } },
				{ ...appItem(ACL_PRIVATE), acl: ["__private__"], relations: { ids: [ACL_OPEN.id] } },
				{ ...appItem(ACL_FLIP), acl: [ALICE] },
			],
		},
		ids: [ACL_OPEN.id, ACL_ALICE.id, ACL_PRIVATE.id, ACL_FLIP.id],
	},
	{
		scenario: "ingest.knowledge.collection",
		args: { kind: "knowledge", text: TEXT["e2e-k-named"], title: "Invoice exports", source_id: "e2e-k-named", collection: NAMED },
		ids: ["e2e-k-named"],
		collection: NAMED,
	},
	{
		scenario: "update.additional_metadata",
		args: {
			kind: "knowledge",
			text: TEXT["e2e-k-upd"],
			title: "Update target",
			source_id: "e2e-k-upd",
			additional_metadata: { stage: "draft" },
		},
		ids: ["e2e-k-upd"],
	},
	{
		scenario: "delete.item",
		args: { kind: "knowledge", text: TEXT["e2e-k-del"], title: "Delete target", source_id: "e2e-k-del" },
		ids: ["e2e-k-del"],
	},
	{
		scenario: "collections.delete",
		args: { kind: "knowledge", text: TEXT["e2e-k-drop"], title: "Drop target", source_id: "e2e-k-drop", collection: DROPPED },
		ids: ["e2e-k-drop"],
		collection: DROPPED,
	},
];

/** Knowledge in the workspace default collection that no scenario removes. */
export const KEPT_KNOWLEDGE = [
	"e2e-k-plain",
	"e2e-k-titled",
	"e2e-k-wide",
	"e2e-k-rel",
	"e2e-k-evidence",
	"e2e-k-graph",
	"e2e-k-item-1",
	"e2e-k-item-2",
	...Array.from({ length: PAGE_ROWS }, (_, i) => pageId(i)),
	...Array.from({ length: LARGE_DOCS }, (_, d) => largeId(d)),
	"e2e-k-file",
	"e2e-k-app",
	"e2e-k-upd",
];

export const KEPT_MEMORY = ["e2e-m-text", "e2e-m-turns", "e2e-m-item-1", "e2e-m-item-2", "e2e-m-raw"];
