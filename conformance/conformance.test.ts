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

import { z } from "zod";

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

// Expected values are wire JSON, so nested SDK objects (a resource list) are
// compared in wire spelling too: `resourceId` is checked as `resource_id`.
type WireJson = string | number | boolean | null | WireJson[] | { [key: string]: WireJson };

function toSnake(name: string): string {
	return name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function inWireForm(value: WireJson): WireJson {
	if (Array.isArray(value)) return value.map(inWireForm);

	if (value instanceof Object) {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [toSnake(key), inWireForm(item)]));
	}

	return value;
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

// The connector wrapper validates every successful response, so each connector
// SDK method answers with the smallest body its schema accepts.
const CONNECTOR_RESPONSES = {
	providerList: { providers: [] },
	providerDetail: { provider: "slack", connectorType: "classic", filterableFields: [], indexedObjectTypes: [], searchableFields: [] },
	list: { connectors: [] },
	get: { connectorId: "conn_1" },
	status: { connectorId: "conn_1", resources: [] },
	discover: { provider: "slack", resources: [] },
	listResources: { resources: [] },
	write: { connectorId: "conn_1" },
	resourceWrite: { connectorId: "conn_1", resourceId: "C1" },
};

// What a recorded SDK call answers with: a connector body above, the query body, or empty.
type RecordedBody = (typeof CONNECTOR_RESPONSES)[keyof typeof CONNECTOR_RESPONSES] | { chunks: [] } | Record<string, never>;

// The connector-resource-add vector's resources, in wire form.
const vectorResources = z.array(z.object({ resource_id: z.string(), display_name: z.string().optional() }));

function makeRecorder(): { sdk: HydraDBClient; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const record =
		(method: string, contentType: string, response: RecordedBody = method === "query" ? { chunks: [] } : {}) =>
		(args?: Record<string, unknown>) => {
			calls.push({ method, args: args ?? {}, contentType });

			return Promise.resolve({ data: response, success: true });
		};

	const json = "application/json";

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
		listProviders: (args?: { id?: string }) =>
			record(
				"listProviders",
				json,
				args?.id ? CONNECTOR_RESPONSES.providerDetail : CONNECTOR_RESPONSES.providerList,
			)(args),
		connectors: {
			list: record("list", json, CONNECTOR_RESPONSES.list),
			get: record("get", json, CONNECTOR_RESPONSES.get),
			status: record("status", json, CONNECTOR_RESPONSES.status),
			discover: record("discover", json, CONNECTOR_RESPONSES.discover),
			listResources: record("listResources", json, CONNECTOR_RESPONSES.listResources),
			update: record("update", json, CONNECTOR_RESPONSES.write),
			delete: record("delete", json, CONNECTOR_RESPONSES.write),
			sync: record("sync", json),
			pause: record("pause", json, CONNECTOR_RESPONSES.write),
			resume: record("resume", json, CONNECTOR_RESPONSES.write),
			configure: record("configure", json, CONNECTOR_RESPONSES.write),
			updateResourceAcl: record("updateResourceAcl", json, CONNECTOR_RESPONSES.resourceWrite),
			deleteResource: record("deleteResource", json, CONNECTOR_RESPONSES.resourceWrite),
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
			return hydra.databases.delete({ database: a.database });
		case "database.collections":
			return hydra.databases.collections(a.database);
		case "database.readiness":
			return hydra.databases.readiness({ database: a.database });
		case "connector.providerList":
			return hydra.connectors.listProviders();
		case "connector.providerInspect":
			return hydra.connectors.inspectProvider(a.provider);
		case "connector.list":
			return hydra.connectors.list({ provider: a.provider, includeHealth: a.include_health });
		case "connector.inspect":
			return hydra.connectors.inspect(a.id);
		case "connector.health":
			return hydra.connectors.health(a.id);
		case "connector.discover":
			return hydra.connectors.discover({ connectorId: a.id, cursor: a.cursor, limit: a.limit });
		case "connector.update":
			return hydra.connectors.update({
				connectorId: a.id,
				customInstructions: a.custom_instructions,
				syncIntervalSeconds: a.sync_interval_seconds,
			});
		case "connector.delete":
			return hydra.connectors.delete(a.id);
		case "connector.sync":
			return hydra.connectors.sync(a.id);
		case "connector.pause":
			return hydra.connectors.pause(a.id);
		case "connector.resume":
			return hydra.connectors.resume(a.id);
		case "connector.resourceList":
			return hydra.connectors.listResources(a.id);
		case "connector.resourceAdd":
			return hydra.connectors.addResources({
				connectorId: a.id,
				resources: vectorResources.parse(args.resources).map((resource) => ({
					resourceId: resource.resource_id,
					name: resource.display_name,
				})),
				lookbackDays: a.lookback_days,
			});
		case "connector.resourceUpdate":
			return hydra.connectors.updateResource({ connectorId: a.id, resourceId: a.resource_id, acl: a.acl });
		case "connector.resourceDelete":
			return hydra.connectors.deleteResource(a.id, a.resource_id);
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
				database: vector.call.op === "database.delete"
					? "conformance_connection_default"
					: suite.scope_defaults.database,
				collection: suite.scope_defaults.collection,
			},
			sdk,
		);

		await invoke(hydra, vector.call.op, vector.call.args);

		assert.equal(calls.length, 1, `expected exactly one SDK call for ${vector.id}`);
		const call = calls[0]!;
		const { sdk: expected } = vector.expect;

		assert.equal(call.method, expected.method, `SDK method for ${vector.id}`);

		// Vectors name fields in wire (snake_case) form; the SDK request object
		// carries them in camelCase, so read whichever spelling is present.
		for (const [key, value] of Object.entries(expected.args_include ?? {})) {
			const actual = call.args[key] !== undefined ? call.args[key] : call.args[toCamel(key)];

			assert.deepEqual(
				// SAFETY: SDK request arguments are JSON the wrapper built from JSON vector args.
				inWireForm(actual as WireJson),
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
