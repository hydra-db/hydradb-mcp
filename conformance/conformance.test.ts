/**
 * HydraDB client conformance runner (PRO-1298).
 *
 * Drives the SHARED `vectors.json` through THIS repo's wrapper against a mocked
 * SDK transport and asserts the canonical SDK call each vector produces. This is
 * the anti-drift gate: if the wrapper renames an action, drops the scope,
 * changes a default, or regresses ingest content-type, a vector fails here.
 *
 * See ./README.md for what each `expect.sdk` field means and how it maps onto
 * the recorded SDK request object.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { HydraDBClient } from "@hydradb/sdk";

import { HydraDB } from "../src/hydra/index.js";
import { ALIAS_REPLACEMENTS, CANONICAL_TOOL_NAMES } from "../src/tool-names.js";

// This repo's identity within the shared fixture. Vectors whose `optional_for`
// names us are not our responsibility (they exercise behaviour, e.g.
// client-assigned source ids via app_knowledge, that this server doesn't do).
const REPO = "mcp";

// The `expect.sdk` keys this runner knows how to assert. If the shared fixture
// grows a key we don't handle on a vector that ISN'T optional for us, we fail
// loudly rather than pretend-pass it.
const HANDLED_SDK_KEYS = new Set([
	"method",
	"args_include",
	"args_scope",
	"content_type",
	"forbid_content_type",
	"forbid_field",
	"source_field_in",
]);

// Vectors name request fields in wire (snake_case) form; the SDK request object
// uses camelCase. Check both so `app_knowledge` matches `appKnowledge`, etc.
function toCamel(name: string): string {
	return name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function hasField(args: Record<string, unknown>, name: string): boolean {
	return args[name] != null || args[toCamel(name)] != null;
}

type Vector = {
	id: string;
	optional_for?: string[];
	call: { op: string; args: Record<string, unknown> };
	expect: {
		wrapper_method: string;
		sdk: {
			method: string;
			args_include?: Record<string, unknown>;
			args_scope?: Record<string, unknown>;
			content_type?: string;
			forbid_content_type?: string;
			forbid_field?: string;
		} & Record<string, unknown>;
	};
	aliases?: Record<string, string[]>;
};

type Vectors = {
	scope_defaults: { database: string; collection: string };
	vectors: Vector[];
};

const vectorsPath = fileURLToPath(new URL("./vectors.json", import.meta.url));
const suite = JSON.parse(readFileSync(vectorsPath, "utf-8")) as Vectors;

type RecordedCall = {
	method: string;
	args: Record<string, unknown>;
	contentType: string;
};

function makeRecorder(): { sdk: HydraDBClient; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const record =
		(method: string, contentType: string) =>
		(args?: Record<string, unknown>) => {
			calls.push({ method, args: args ?? {}, contentType });
			return Promise.resolve({ data: {}, success: true });
		};

	const sdk = {
		query: record("query", "application/json"),
		context: {
			ingest: record("ingest", "multipart/form-data"),
			list: record("list", "application/json"),
			inspect: record("inspect", "application/json"),
			delete: record("delete", "application/json"),
			relations: record("relations", "application/json"),
			status: record("status", "application/json"),
		},
		databases: {
			create: record("create", "application/json"),
			delete: record("delete", "application/json"),
			list: record("list", "application/json"),
			collections: record("collections", "application/json"),
			stats: record("stats", "application/json"),
			status: record("status", "application/json"),
		},
	};

	return { sdk: sdk as unknown as HydraDBClient, calls };
}

function invoke(hydra: HydraDB, op: string, args: Record<string, unknown>): Promise<unknown> {
	const a = args as Record<string, string & string[] & undefined>;
	switch (op) {
		case "query":
			return hydra.context.query({
				query: a.query,
				kind: a.kind as never,
				operator: a.operator as never,
				maxResults: a.max_results as never,
				mode: a.mode as never,
			});
		case "ingest":
			return hydra.context.ingest({
				kind: a.kind as never,
				text: a.text,
				title: a.title,
			});
		case "list":
			return hydra.context.list({ kind: a.kind as never, ids: a.ids ?? a.source_ids });
		case "inspect":
			return hydra.context.inspect({ id: a.id, mode: a.mode });
		case "delete":
			return hydra.context.delete({ ids: a.ids, kind: a.kind as never });
		case "relations":
			return hydra.context.relations({ id: a.id, kind: a.kind as never });
		case "context.ingestionStatus":
			return hydra.context.ingestionStatus({ ids: a.ids });
		case "database.create":
			return hydra.databases.create({ database: a.database });
		case "database.delete":
			return hydra.databases.delete(a.database);
		case "database.collections":
			return hydra.databases.collections(a.database);
		case "database.readiness":
			return hydra.databases.readiness(a.database);
		default:
			throw new Error(`conformance: unhandled op "${op}"`);
	}
}

for (const vector of suite.vectors) {
	const skip = vector.optional_for?.includes(REPO)
		? `optional_for ${REPO}`
		: false;

	test(`conformance: ${vector.id} → ${vector.expect.wrapper_method}`, { skip }, async () => {
		// Guard against the shared fixture drifting in a way this runner would
		// otherwise ignore (an unhandled expect key would silently no-op).
		const unhandled = Object.keys(vector.expect.sdk).filter(
			(key) => !HANDLED_SDK_KEYS.has(key),
		);
		assert.deepEqual(
			unhandled,
			[],
			`${vector.id}: unhandled expect.sdk keys ${JSON.stringify(unhandled)} — extend the runner or mark the vector optional_for ${REPO}`,
		);

		const { sdk, calls } = makeRecorder();
		const hydra = new HydraDB(
			{
				token: "conformance-token",
				database: suite.scope_defaults.database,
				collection: suite.scope_defaults.collection,
			},
			sdk,
		);

		await invoke(hydra, vector.call.op, vector.call.args);

		assert.equal(calls.length, 1, `expected exactly one SDK call for ${vector.id}`);
		const call = calls[0]!;
		const { sdk: expected } = vector.expect;

		assert.equal(call.method, expected.method, `SDK method for ${vector.id}`);

		for (const [key, value] of Object.entries(expected.args_include ?? {})) {
			assert.deepEqual(
				call.args[key],
				value,
				`${vector.id}: SDK arg "${key}" must equal ${JSON.stringify(value)}`,
			);
		}

		for (const [key, value] of Object.entries(expected.args_scope ?? {})) {
			assert.deepEqual(
				call.args[key],
				value,
				`${vector.id}: SDK scope "${key}" must equal ${JSON.stringify(value)}`,
			);
		}

		if (expected.content_type != null) {
			assert.equal(
				call.contentType,
				expected.content_type,
				`${vector.id}: content type`,
			);
		}

		if (expected.forbid_content_type != null) {
			assert.notEqual(
				call.contentType,
				expected.forbid_content_type,
				`${vector.id}: content type must not be ${expected.forbid_content_type}`,
			);
		}

		const forbidField = expected.forbid_field as string | undefined;
		if (forbidField != null) {
			assert.ok(
				!hasField(call.args, forbidField),
				`${vector.id}: SDK request must not carry "${forbidField}"`,
			);
		}

		const sourceFieldIn = expected.source_field_in as string[] | undefined;
		if (sourceFieldIn != null) {
			assert.ok(
				sourceFieldIn.some((field) => hasField(call.args, field)),
				`${vector.id}: source must be carried in one of ${JSON.stringify(sourceFieldIn)}`,
			);
		}
	});
}

test("conformance: every MCP tool alias resolves to a registered canonical tool", () => {
	const canonical = new Set<string>(CANONICAL_TOOL_NAMES);
	for (const vector of suite.vectors) {
		for (const alias of vector.aliases?.mcp_tool ?? []) {
			const replacement = ALIAS_REPLACEMENTS[alias];
			assert.ok(
				replacement != null,
				`${vector.id}: mcp_tool alias "${alias}" has no canonical replacement`,
			);
			assert.ok(
				canonical.has(replacement),
				`${vector.id}: "${alias}" resolves to "${replacement}", which is not canonical`,
			);
		}
	}
});
