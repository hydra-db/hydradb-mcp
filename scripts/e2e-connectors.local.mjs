#!/usr/bin/env node

/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-conditional-empty-object-spread, anti-slop/require-readable-spacing -- Inspector JSON, process records, and fixture contracts are dynamic test boundaries. */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const INSPECTOR_VERSION = "2.13.0";
const PROVIDER_FAILURE_SKIP_REASON =
	"provider failure: not run — local backend does not surface a stopped-vendor failure within 6 minutes; sync stayed healthy and idle";
const temporaryDirectory = mkdtempSync(join(tmpdir(), "hydradb-connector-e2e-"));
const childProcesses = new Set();

function cleanUp() {
	for (const child of childProcesses) child.kill("SIGTERM");
	rmSync(temporaryDirectory, { recursive: true, force: true });
}

process.on("exit", cleanUp);

function required(name) {
	const value = process.env[name]?.trim();

	if (!value) throw new Error(`${name} is required`);

	return value;
}

function localUrl(name) {
	const value = required(name);
	const url = new URL(value);

	if (!LOOPBACK_HOSTS.has(url.hostname)) {
		throw new Error(`${name} must use a loopback host; refused ${url.origin}`);
	}

	return url;
}

function lifecycleReport(fullLifecycle, cleanup, passedCases, skippedCases) {
	return {
		status: fullLifecycle && cleanup && skippedCases.length === 0 ? "complete" : "partial",
		inspector_version: INSPECTOR_VERSION,
		passed_cases: passedCases,
		skipped_cases: skippedCases,
	};
}

if (process.argv.includes("--report-self-test")) {
	console.log(JSON.stringify(lifecycleReport(true, true, [], [PROVIDER_FAILURE_SKIP_REASON])));
	process.exit(0);
}

async function startGuardedProxy(target) {
	const child = spawn(process.execPath, [resolve("scripts/local-only-http-proxy.mjs"), target.toString()], {
		cwd: process.cwd(),
		env: { PATH: process.env.PATH },
		stdio: ["ignore", "pipe", "pipe"],
	});
	childProcesses.add(child);

	return await new Promise((resolveProxy, rejectProxy) => {
		let output = "";
		const reject = () => rejectProxy(new Error("The local-only HTTP guard failed to start"));

		child.once("error", reject);
		child.once("exit", reject);
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			output += chunk;
			const newline = output.indexOf("\n");

			if (newline < 0) return;
			child.removeListener("error", reject);
			child.removeListener("exit", reject);
			resolveProxy(new URL(output.slice(0, newline)));
		});
	});
}

async function guardSelfTest() {
	let secondHopRequests = 0;
	const secondHop = createServer((_request, response) => {
		secondHopRequests += 1;
		response.writeHead(307, { location: "https://example.com/forbidden" });
		response.end();
	});
	await new Promise((resolveListen) => secondHop.listen(0, "127.0.0.1", resolveListen));
	const secondHopAddress = secondHop.address();

	if (secondHopAddress == null || typeof secondHopAddress === "string") {
		throw new Error("Second redirect fixture did not receive a port");
	}

	const redirectServer = createServer((_request, response) => {
		response.writeHead(307, { location: `http://127.0.0.1:${secondHopAddress.port}/second-hop` });
		response.end();
	});
	await new Promise((resolveListen) => redirectServer.listen(0, "127.0.0.1", resolveListen));
	const address = redirectServer.address();

	if (address == null || typeof address === "string") throw new Error("Redirect fixture did not receive a port");

	const proxy = await startGuardedProxy(new URL(`http://127.0.0.1:${address.port}`));
	const response = await fetch(proxy, { method: "POST", body: "must-not-leave-loopback", redirect: "manual" });
	redirectServer.close();
	secondHop.close();

	if (response.status !== 502 || secondHopRequests !== 0) {
		throw new Error("The local-only guard followed a redirect");
	}

	let receivedQuery = "";
	const queryServer = createServer((request, queryResponse) => {
		receivedQuery = new URL(request.url ?? "/", "http://query-fixture.invalid").search;
		queryResponse.writeHead(204);
		queryResponse.end();
	});
	await new Promise((resolveListen) => queryServer.listen(0, "127.0.0.1", resolveListen));
	const queryAddress = queryServer.address();

	if (queryAddress == null || typeof queryAddress === "string") throw new Error("Query fixture did not receive a port");

	const queryProxy = await startGuardedProxy(
		new URL(`http://127.0.0.1:${queryAddress.port}/__eng3341/mode?fixture=run-owned`),
	);
	await fetch(queryProxy, { method: "POST", body: "{}", redirect: "manual" });
	queryServer.close();

	if (receivedQuery !== "?fixture=run-owned") throw new Error("The local-only guard discarded a configured query");

	console.log(JSON.stringify({
		ok: true,
		cases: ["redirect chain refused at first hop", "configured query preserved"],
	}));
}

if (process.argv.includes("--guard-self-test")) {
	await guardSelfTest();
	process.exit(0);
}

async function guardedHttpCall(url, token, name, args) {
	const guardedUrl = await startGuardedProxy(url);
	const transport = new StreamableHTTPClientTransport(guardedUrl, {
		requestInit: { headers: { authorization: `Bearer ${token}` } },
	});
	const client = new Client({ name: "eng3341-local-e2e", version: "1" });

	try {
		await client.connect(transport);
		return await client.callTool({ name, arguments: args });
	} catch {
		throw new Error(`Local OAuth ${name} request failed safely`);
	} finally {
		await client.close().catch(() => undefined);
	}
}

async function oauthErrorSelfTest() {
	const token = required("ENG3341_SELF_TEST_TOKEN");
	const errorServer = createServer((request, response) => {
		response.writeHead(500, { "content-type": "text/plain" });
		response.end(`refused ${request.headers.authorization ?? "missing authorization"}`);
	});
	await new Promise((resolveListen) => errorServer.listen(0, "127.0.0.1", resolveListen));
	const address = errorServer.address();

	if (address == null || typeof address === "string") throw new Error("OAuth error fixture did not receive a port");

	try {
		await guardedHttpCall(new URL(`http://127.0.0.1:${address.port}/mcp`), token, "self_test", {});
		throw new Error("OAuth error fixture unexpectedly succeeded");
	} catch (error) {
		if (!(error instanceof Error) || error.message !== "Local OAuth self_test request failed safely") throw error;
		console.log(JSON.stringify({ ok: true, case: error.message }));
	} finally {
		errorServer.close();
	}
}

if (process.argv.includes("--oauth-error-self-test")) {
	await oauthErrorSelfTest();
	process.exit(0);
}

const api = localUrl("HYDRADB_BASE_URL");
const dashboard = localUrl("HYDRADB_OAUTH_ISSUER");
const provider = process.env.ENG3341_PROVIDER?.trim() || "gitlab";
const connectorId = process.env.ENG3341_CONNECTOR_ID?.trim();
const resourceId = process.env.ENG3341_RESOURCE_ID?.trim();
const fullLifecycle = process.env.ENG3341_FULL_LIFECYCLE === "1";
const cleanup = process.env.ENG3341_CLEANUP === "1";
const runOwned = process.env.ENG3341_RUN_OWNED === "1";
const skipProviderFailure = process.env.ENG3341_SKIP_PROVIDER_FAILURE === "1";
const fakeVendorControl = fullLifecycle ? localUrl("ENG3341_FAKE_VENDOR_CONTROL_URL") : undefined;
const pollTimeoutSeconds = Number(process.env.ENG3341_POLL_TIMEOUT_SECONDS ?? "360");
const passedCases = [];
const skippedCases = [];

if (!Number.isSafeInteger(pollTimeoutSeconds) || pollTimeoutSeconds < 30 || pollTimeoutSeconds > 900) {
	throw new Error("ENG3341_POLL_TIMEOUT_SECONDS must be an integer between 30 and 900");
}

const pollTimeoutMs = pollTimeoutSeconds * 1_000;

if ((fullLifecycle || cleanup) && !runOwned) {
	throw new Error("Set ENG3341_RUN_OWNED=1 before lifecycle mutations or cleanup");
}
if (fullLifecycle && (!connectorId || !resourceId)) {
	throw new Error("Full lifecycle requires ENG3341_CONNECTOR_ID and ENG3341_RESOURCE_ID");
}
if (cleanup && !connectorId) throw new Error("Cleanup requires ENG3341_CONNECTOR_ID");

const guardedApi = await startGuardedProxy(api);
const protectedEnvironment = {
	HYDRADB_API_KEY: required("HYDRADB_API_KEY"),
	HYDRADB_DATABASE: required("HYDRADB_DATABASE"),
	...(process.env.HYDRADB_COLLECTION ? { HYDRADB_COLLECTION: process.env.HYDRADB_COLLECTION } : {}),
	HYDRADB_BASE_URL: guardedApi.origin,
	HYDRADB_OAUTH_ISSUER: dashboard.origin,
};
const environmentPath = join(temporaryDirectory, "environment.json");
writeFileSync(environmentPath, JSON.stringify(protectedEnvironment), { encoding: "utf8", mode: 0o600 });
chmodSync(environmentPath, 0o600);

function inspectorEnvironment() {
	const environment = { ...process.env };

	for (const name of [
		"HYDRADB_API_KEY",
		"HYDRADB_DATABASE",
		"HYDRADB_COLLECTION",
		"HYDRADB_BASE_URL",
		"HYDRADB_OAUTH_ISSUER",
		"ENG3341_OAUTH_ALLOWED_TOKEN",
		"ENG3341_OAUTH_DENIED_TOKEN",
	]) delete environment[name];

	return environment;
}

function inspector(method, { toolName, args } = {}) {
	const customBinary = process.env.MCP_INSPECTOR_BIN?.trim();
	const command = customBinary || "npx";
	const inspectorArgs = customBinary
		? ["--cli"]
		: ["--yes", `@modelcontextprotocol/inspector@${INSPECTOR_VERSION}`, "--cli"];
	const cliArgs = [
		"--method", method,
		"--format", "json",
		"--quiet",
		"--cwd", process.cwd(),
		...(toolName ? ["--tool-name", toolName] : []),
		...(args ? ["--tool-args-json", JSON.stringify(args)] : []),
		"node",
		resolve("scripts/protected-env-mcp-launcher.mjs"),
		environmentPath,
		resolve("dist/index.js"),
	];
	const result = spawnSync(command, [...inspectorArgs, ...cliArgs], {
		cwd: process.cwd(),
		env: inspectorEnvironment(),
		encoding: "utf8",
		maxBuffer: 8 * 1024 * 1024,
	});

	if (result.status !== 0) {
		throw new Error(`Inspector ${method}${toolName ? ` ${toolName}` : ""} failed with exit ${result.status}`);
	}

	return JSON.parse(result.stdout);
}

function call(name, args, allowError = false) {
	const result = inspector("tools/call", { toolName: name, args });
	const envelope = result.result ?? result;
	const text = Array.isArray(envelope.content)
		? envelope.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")
		: "";

	if (envelope.isError === true && !allowError) throw new Error(`${name} returned a tool error`);

	return {
		data: envelope.structuredContent ?? envelope.result?.structuredContent ?? envelope,
		isError: envelope.isError === true,
		text,
	};
}

async function callHttp(urlName, tokenName, name, args) {
	const url = localUrl(urlName);
	const token = required(tokenName);

	return await guardedHttpCall(url, token, name, args);
}

async function pollStatus(predicate, label, timeoutMs = pollTimeoutMs) {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		const status = call("hydradb_connector_status", { connector_id: connectorId });

		if (predicate(status)) return status;
		await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
	}

	throw new Error(`Timed out while waiting for ${label}`);
}

async function setFakeVendorMode(mode) {
	const guardedControl = await startGuardedProxy(fakeVendorControl);
	const response = await fetch(guardedControl, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ mode }),
		redirect: "manual",
	});

	if (!response.ok) throw new Error("The local fake-vendor failure control refused a mode change");
}

const listed = inspector("tools/list");
const tools = listed.tools ?? listed.result?.tools ?? [];

for (const name of ["hydradb_connector_create", "hydradb_connector_update"]) {
	if (!tools.some((tool) => tool.name === name)) throw new Error(`${name} is not registered`);
}

const createTool = tools.find((tool) => tool.name === "hydradb_connector_create");
const createFields = Object.keys(createTool.inputSchema?.properties ?? {});

if (createFields.length !== 1 || createFields[0] !== "provider") {
	throw new Error("hydradb_connector_create must expose only the provider argument");
}

call("hydradb_connector_providers", { provider });
const create = call("hydradb_connector_create", { provider });
const expectedCreate = new URL("/connectors", dashboard);
expectedCreate.searchParams.set("connect", provider);

if (create.data.completed !== false || create.data.dashboard_url !== expectedCreate.toString()) {
	throw new Error("Create completion result did not match the local dashboard link");
}
if (!create.text.includes(expectedCreate.toString())) throw new Error("Create text did not include the dashboard link");
passedCases.push("create completion link");

if (connectorId) {
	call("hydradb_connector_get", { connector_id: connectorId });
	const reconnect = call("hydradb_connector_update", { connector_id: connectorId, reconnect: true });
	const expectedReconnect = new URL("/connectors", dashboard);
	expectedReconnect.searchParams.set("open", connectorId);

	if (reconnect.data.completed !== false || reconnect.data.dashboard_url !== expectedReconnect.toString()) {
		throw new Error("Reconnect completion result did not match the local dashboard link");
	}
	if (!reconnect.text.includes(expectedReconnect.toString())) throw new Error("Reconnect text did not include the dashboard link");
	passedCases.push("reconnect completion link");
} else {
	skippedCases.push("reconnect completion link: ENG3341_CONNECTOR_ID not set");
}

if (fullLifecycle) {
	call("hydradb_connector_discover", { connector_id: connectorId, limit: 25 });
	call("hydradb_connector_add_resource", { connector_id: connectorId, resource_id: resourceId });
	call("hydradb_connector_configure", {
		connector_id: connectorId,
		resources: [{ resource_id: resourceId, sync_mode: "rescan" }],
	});
	call("hydradb_connector_update_resource", {
		connector_id: connectorId,
		resource_id: resourceId,
		acl: [],
		custom_instructions: "ENG-3341 local-only verification",
	});
	const configured = call("hydradb_connector_resources", { connector_id: connectorId });

	if (!JSON.stringify(configured.data).includes(resourceId)) {
		throw new Error("Configured resource listing did not include the run-owned resource");
	}
	passedCases.push("configure and configured resource listing");
	const before = call("hydradb_connector_status", { connector_id: connectorId }).data.last_successful_sync_at;
	call("hydradb_connector_sync", { connector_id: connectorId });
	await pollStatus(
		(status) => status.data.last_successful_sync_at && status.data.last_successful_sync_at !== before && !status.data.error,
		"a successful connector sync",
	);
	call("hydradb_connector_pause", { connector_id: connectorId });
	call("hydradb_connector_resume", { connector_id: connectorId });
	passedCases.push("resource lifecycle and successful sync");

	if (skipProviderFailure) {
		skippedCases.push(PROVIDER_FAILURE_SKIP_REASON);
	} else {
		let failed;

		try {
			await setFakeVendorMode("terminal_failure");
			call("hydradb_connector_sync", { connector_id: connectorId });
			failed = await pollStatus((status) => status.data.error != null, "a safe provider failure");
		} finally {
			await setFakeVendorMode("healthy");
		}
		const secretMarker = process.env.ENG3341_SECRET_MARKER?.trim();

		if (!failed.data.error?.action || (secretMarker && failed.text.includes(secretMarker))) {
			throw new Error("Provider failure output was not safe and actionable");
		}
		passedCases.push("safe provider failure");
	}

	const allowedResult = await callHttp(
		"ENG3341_OAUTH_ALLOWED_MCP_URL",
		"ENG3341_OAUTH_ALLOWED_TOKEN",
		"hydradb_connector_update",
		{ connector_id: connectorId, reconnect: true },
	);
	const deniedReads = await Promise.all([
		["hydradb_connector_get", { connector_id: connectorId }],
		["hydradb_connector_status", { connector_id: connectorId }],
		["hydradb_connector_resources", { connector_id: connectorId }],
		["hydradb_connector_discover", { connector_id: connectorId, limit: 1 }],
	].map(([name, args]) => callHttp(
		"ENG3341_OAUTH_DENIED_MCP_URL",
		"ENG3341_OAUTH_DENIED_TOKEN",
		name,
		args,
	)));
	const deniedList = await callHttp(
		"ENG3341_OAUTH_DENIED_MCP_URL",
		"ENG3341_OAUTH_DENIED_TOKEN",
		"hydradb_connector_list",
		{},
	);
	const deniedWrite = await callHttp(
		"ENG3341_OAUTH_DENIED_MCP_URL",
		"ENG3341_OAUTH_DENIED_TOKEN",
		"hydradb_connector_update",
		{ connector_id: connectorId, custom_instructions: "must not apply" },
	);

	if (
		allowedResult.isError
		|| deniedReads.some((result) => !result.isError)
		|| !deniedWrite.isError
		|| JSON.stringify(deniedList.structuredContent ?? deniedList).includes(connectorId)
	) {
		throw new Error("OAuth allowed and denied connector results did not match the expected confinement");
	}
	passedCases.push("OAuth list filtering and by-ID read/write confinement");
} else {
	skippedCases.push("full resource, sync, failure, and OAuth lifecycle: ENG3341_FULL_LIFECYCLE not set");
}

if (cleanup) {
	if (resourceId) call("hydradb_connector_delete_resource", { connector_id: connectorId, resource_id: resourceId });
	call("hydradb_connector_delete", { connector_id: connectorId });
	passedCases.push("run-owned cleanup");
} else {
	skippedCases.push("cleanup: ENG3341_CLEANUP not set");
}

console.log(JSON.stringify(lifecycleReport(fullLifecycle, cleanup, passedCases, skippedCases), null, 2));
cleanUp();
