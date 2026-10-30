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
			update: response("update", {
				connectorId: "c1",
				syncIntervalSeconds: 0,
				customInstructionsUpdated: false,
			}),
			delete: response("delete", { connectorId: "c1", deleted: true }),
			sync: response("sync", { runId: "" }),
			pause: response("pause", { connectorId: "c1", paused: true }),
			resume: response("resume", { connectorId: "c1", paused: false }),
			configure: response("configure", {
				connectorId: "c1",
				configured: 0,
				backfill: false,
				warnings: [],
			}),
			createResource: response("createResource", { resourceId: "r1", acl: [] }),
			updateResourceAcl: response("updateResourceAcl", {
				resourceId: "r1",
				acl: [],
				customInstructions: "",
			}),
			deleteResource: response("deleteResource", {
				resourceId: "r1",
				deleted: true,
			}),
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
	const options = { signal: controller.signal };

	await resource.listProviders(undefined, options);
	await resource.list({}, options);
	await resource.get("c1", options);
	await resource.status("c1", options);
	await resource.discover({ connectorId: "c1" }, options);
	await resource.listResources("c1", options);

	assert.equal(calls.length, 6);
	assert.ok(calls.every((call) => call.signal === controller.signal));
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

test("connector wrapper rejects missing result arrays instead of reporting empty results", async () => {
	const listResource = new ConnectorsResource({
		connectors: { list: () => Promise.resolve({}) },
	} as unknown as HydraDBClient);

	const statusResource = new ConnectorsResource({
		connectors: { status: () => Promise.resolve({ connectorId: "c1" }) },
	} as unknown as HydraDBClient);

	const configuredResource = new ConnectorsResource({
		connectors: { listResources: () => Promise.resolve({}) },
	} as unknown as HydraDBClient);

	await assert.rejects(
		() => listResource.list(),
		/Invalid successful connector list response/,
	);

	await assert.rejects(
		() => statusResource.status("c1"),
		/Invalid successful connector status response/,
	);

	await assert.rejects(
		() => configuredResource.listResources("c1"),
		/Invalid successful connector resources response/,
	);
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

test("connector writes map requests and forward cancellation, including falsy values", async () => {
	const { resource, calls } = fixture();
	const signal = new AbortController().signal;
	const opts = { signal };
	assert.equal(
		(
			await resource.update(
				{ connectorId: "c1", syncIntervalSeconds: 0, customInstructions: "" },
				opts,
			)
		).syncIntervalSeconds,
		0,
	);
	await resource.delete("c1", opts);
	assert.equal((await resource.sync("c1", opts)).runId, "");
	await resource.pause("c1", opts);
	assert.equal((await resource.resume("c1", opts)).paused, false);
	assert.deepEqual(
		await resource.configure(
			{
				connectorId: "c1",
				resources: [],
				fullVisibilityRoles: [],
				lookbackDays: 0,
				tableConfigs: [],
			},
			opts,
		),
		{ connectorId: "c1", configured: 0, backfill: false, warnings: [] },
	);
	await resource.createResource(
		{
			connectorId: "c1",
			resourceId: "r1",
			acl: [],
			customInstructions: "",
			databaseOverride: "",
		},
		opts,
	);
	await resource.updateResource(
		{ connectorId: "c1", resourceId: "r1", acl: [], customInstructions: "" },
		opts,
	);
	await resource.deleteResource("c1", "r1", opts);
	assert.deepEqual(
		calls.map(({ method, request }) => ({ method, request })),
		[
			{
				method: "update",
				request: { id: "c1", syncIntervalSeconds: 0, customInstructions: "" },
			},
			{ method: "delete", request: { id: "c1" } },
			{ method: "sync", request: { id: "c1" } },
			{ method: "pause", request: { id: "c1" } },
			{ method: "resume", request: { id: "c1" } },
			{
				method: "configure",
				request: {
					id: "c1",
					resources: [],
					fullVisibilityRoles: [],
					lookbackDays: 0,
					tableConfigs: [],
				},
			},
			{
				method: "createResource",
				request: {
					id: "c1",
					resourceId: "r1",
					acl: [],
					customInstructions: "",
					databaseOverride: "",
				},
			},
			{
				method: "updateResourceAcl",
				request: {
					id: "c1",
					resourceId: "r1",
					acl: [],
					customInstructions: "",
				},
			},
			{ method: "deleteResource", request: { id: "c1", resourceId: "r1" } },
		],
	);
	assert.ok(calls.every((call) => call.signal === signal));
});

test("credential endpoint wrappers map synthetic create and reconnect requests", async () => {
	const calls: Call[] = [];
	const signal = new AbortController().signal;

	const sdk = {
		connectors: {
			create: (request: Record<string, unknown>, options?: { abortSignal?: AbortSignal }) => {
				calls.push({ method: "create", request, signal: options?.abortSignal });

				return Promise.resolve({ connectorId: "c2", provider: "gitlab" });
			},
			update: (request: Record<string, unknown>, options?: { abortSignal?: AbortSignal }) => {
				calls.push({ method: "update-credentials", request, signal: options?.abortSignal });

				return Promise.resolve({ connectorId: "c2", credentialsUpdated: true });
			},
		},
	} as unknown as HydraDBClient;

	const resource = new ConnectorsResource(sdk);

	assert.equal(
		(await resource.createWithCredentials({ provider: "gitlab", database: "db", credentials: { token: "synthetic" } }, { signal })).connectorId,
		"c2",
	);
	assert.equal(
		(await resource.updateCredentials({ connectorId: "c2", credentials: { token: "replacement" } }, { signal })).credentialsUpdated,
		true,
	);
	assert.deepEqual(calls, [
		{
			method: "create",
			request: { provider: "gitlab", database: "db", credentials: { token: "synthetic" } },
			signal,
		},
		{
			method: "update-credentials",
			request: { id: "c2", credentials: { token: "replacement" } },
			signal,
		},
	]);
});

test("connector writes validate success and translate errors with encoded paths", async () => {
	const invalid = new ConnectorsResource({
		connectors: { sync: () => Promise.resolve({ runId: 42 }) },
	} as unknown as HydraDBClient);

	await assert.rejects(
		() => invalid.sync("c/1"),
		/Invalid successful connector sync response/,
	);

	const failing = new ConnectorsResource({
		connectors: { deleteResource: () => Promise.reject(new Error("failed")) },
	} as unknown as HydraDBClient);

	await assert.rejects(
		() => failing.deleteResource("c/1", "r/2"),
		/\/connectors\/c%2F1\/resources\/r%2F2 → ERR: failed/,
	);
});

test("write responses unwrap envelopes and reject invalid field types", async () => {
	const methods = [
		"update",
		"delete",
		"sync",
		"pause",
		"resume",
		"configure",
		"createResource",
		"updateResourceAcl",
		"deleteResource",
	] as const;

	const valid = [
		{ connectorId: "c1" },
		{ deleted: false },
		{ runId: "" },
		{ paused: false },
		{ paused: false },
		{ configured: 0 },
		{ resourceId: "r1" },
		{ acl: [] },
		{ deleted: false },
	];

	const invalid = [
		{ syncIntervalSeconds: "0" },
		{ deleted: "yes" },
		{ runId: 1 },
		{ paused: 0 },
		{ paused: 0 },
		{ configured: "0" },
		{ resourceId: 1 },
		{ acl: "public" },
		{ deleted: "yes" },
	];

	const invoke = (resource: ConnectorsResource, index: number) =>
		[
			() => resource.update({ connectorId: "c1" }),
			() => resource.delete("c1"),
			() => resource.sync("c1"),
			() => resource.pause("c1"),
			() => resource.resume("c1"),
			() => resource.configure({ connectorId: "c1", resources: [] }),
			() => resource.createResource({ connectorId: "c1", resourceId: "r1" }),
			() => resource.updateResource({ connectorId: "c1", resourceId: "r1" }),
			() => resource.deleteResource("c1", "r1"),
		][index]!();

	for (const [index, method] of methods.entries()) {
		const ok = new ConnectorsResource({
			connectors: {
				[method]: () => Promise.resolve({ success: true, data: valid[index] }),
			},
		} as unknown as HydraDBClient);

		assert.deepEqual(await invoke(ok, index), valid[index]);

		const bad = new ConnectorsResource({
			connectors: { [method]: () => Promise.resolve(invalid[index]) },
		} as unknown as HydraDBClient);

		await assert.rejects(() => invoke(bad, index), /Invalid successful/);
	}
});

test("resource create accepts the SDK contract's all-optional response", async () => {
	const resource = new ConnectorsResource({
		connectors: { createResource: () => Promise.resolve({}) },
	} as unknown as HydraDBClient);

	assert.deepEqual(
		await resource.createResource({ connectorId: "c1", resourceId: "r1" }),
		{},
	);
});
