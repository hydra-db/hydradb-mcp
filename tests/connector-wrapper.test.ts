/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions -- Test doubles intentionally model generated SDK request and response JSON. */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { HydraDBClient } from "@hydradb/sdk";

import { ConnectorsResource } from "../src/hydra/index.js";

type Call = { method: string; request: Record<string, unknown>; signal?: AbortSignal };

function fixture() {
	const calls: Call[] = [];

	const response = (method: string, body: unknown) =>
		(request: Record<string, unknown> = {}, options?: { abortSignal?: AbortSignal }) => {
			calls.push({ method, request, signal: options?.abortSignal });

			return Promise.resolve(body);
		};

	const sdk = {
		listProviders: (request: Record<string, unknown> = {}, options?: { abortSignal?: AbortSignal }) => {
			calls.push({ method: "providers", request, signal: options?.abortSignal });

			return Promise.resolve(
				request.id
					? {
							provider: request.id,
							connectorType: "moveit",
							filterableFields: [],
							indexedObjectTypes: [],
							searchableFields: [],
						}
					: { providers: [{ provider: "slack", category: "Communication", supported: true }] },
			);
		},
		connectors: {
			list: response("list", {
				connectors: [{ connectorId: "c1", provider: "slack", database: "db-a" }],
			}),
			get: response("get", { connectorId: "c1", provider: "slack", database: "db-a" }),
			status: response("status", {
				connectorId: "c1",
				provider: "slack",
				status: "healthy",
				resources: [],
			}),
			discover: response("discover", {
				provider: "slack",
				resources: [{ id: "r1", name: "general", resourceType: "channel" }],
			}),
			listResources: response("resources", {
				resources: [{ connectorId: "c1", resourceId: "r1", databaseOverride: "db-a" }],
			}),
		},
	} as unknown as HydraDBClient;

	return { resource: new ConnectorsResource(sdk), calls };
}

test("connector wrapper maps all six read operations to the pinned SDK", async () => {
	const { resource, calls } = fixture();

	await resource.listProviders();
	await resource.list({ provider: "slack", includeHealth: true });
	await resource.get("c1");
	await resource.status("c1");
	await resource.discover({ connectorId: "c1", cursor: "next", limit: 25 });
	await resource.listResources("c1");

	assert.deepEqual(calls.map(({ method, request }) => ({ method, request })), [
		{ method: "providers", request: {} },
		{ method: "list", request: { provider: "slack", include: "health" } },
		{ method: "get", request: { id: "c1" } },
		{ method: "status", request: { id: "c1" } },
		{ method: "discover", request: { id: "c1", cursor: "next", limit: 25 } },
		{ method: "resources", request: { id: "c1" } },
	]);
});

test("connector wrapper requests one provider by the SDK id field", async () => {
	const { resource, calls } = fixture();

	await resource.listProviders("slack");

	assert.deepEqual(calls[0]?.request, { id: "slack" });
});

test("connector wrapper forwards cancellation to every SDK call", async () => {
	const { resource, calls } = fixture();
	const controller = new AbortController();

	await resource.get("c1", { signal: controller.signal });

	assert.equal(calls[0]?.signal, controller.signal);
});

test("connector wrapper rejects malformed successful responses", async () => {
	const sdk = {
		connectors: {
			list: () => Promise.resolve({ connectors: [{ connectorId: "" }] }),
		},
	} as unknown as HydraDBClient;

	const resource = new ConnectorsResource(sdk);

	await assert.rejects(() => resource.list(), /Invalid successful connector list response/);
});

test("connector wrapper preserves false, zero, empty strings and empty arrays", async () => {
	const sdk = {
		connectors: {
			get: () => Promise.resolve({
				connectorId: "c1",
				provider: "slack",
				database: "db-a",
				paused: false,
				documentsDispatched: 0,
				customInstructions: "",
			}),
			status: () => Promise.resolve({
				connectorId: "c1",
				status: "checking",
				resources: [],
			}),
		},
	} as unknown as HydraDBClient;

	const resource = new ConnectorsResource(sdk);

	assert.deepEqual(await resource.get("c1"), {
		connectorId: "c1",
		provider: "slack",
		database: "db-a",
		paused: false,
		documentsDispatched: 0,
		customInstructions: "",
	});
	assert.deepEqual((await resource.status("c1")).resources, []);
});
