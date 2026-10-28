#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import process from "node:process";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

const INSPECTOR_VERSION = "2.13.0";

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

localUrl("HYDRADB_BASE_URL");

const dashboard = localUrl("HYDRADB_DASHBOARD_URL");

required("HYDRADB_API_KEY");

required("HYDRADB_DATABASE");

const provider = process.env.ENG3341_PROVIDER?.trim() || "gitlab";

const connectorId = process.env.ENG3341_CONNECTOR_ID?.trim();

const resourceId = process.env.ENG3341_RESOURCE_ID?.trim();

const mutate = process.env.ENG3341_MUTATE === "1";

const cleanup = process.env.ENG3341_CLEANUP === "1";

const runOwned = process.env.ENG3341_RUN_OWNED === "1";

if ((mutate || cleanup) && !runOwned) {
	throw new Error("Set ENG3341_RUN_OWNED=1 before mutating or deleting fixtures");
}

if ((mutate || cleanup) && !connectorId) {
	throw new Error("ENG3341_CONNECTOR_ID is required for lifecycle mutations");
}

function inspector(method, { toolName, args } = {}) {
	const customBinary = process.env.MCP_INSPECTOR_BIN?.trim();
	const command = customBinary || "npx";

	const inspectorArgs = customBinary
		? ["--cli"]
		: ["--yes", `@modelcontextprotocol/inspector@${INSPECTOR_VERSION}`, "--cli"];

	const serverEnvironment = [
		"HYDRADB_API_KEY",
		"HYDRADB_DATABASE",
		"HYDRADB_COLLECTION",
		"HYDRADB_BASE_URL",
		"HYDRADB_DASHBOARD_URL",
	].flatMap((name) => process.env[name] == null ? [] : ["-e", `${name}=${process.env[name]}`]);

	const cliArgs = [
		"--method", method,
		"--format", "json",
		"--quiet",
		"--cwd", process.cwd(),
		...serverEnvironment,
		...(toolName ? ["--tool-name", toolName] : []),
		...(args ? ["--tool-args-json", JSON.stringify(args)] : []),
		"node", "dist/index.js",
	];

	const result = spawnSync(command, [...inspectorArgs, ...cliArgs], {
		cwd: process.cwd(),
		env: process.env,
		encoding: "utf8",
		maxBuffer: 8 * 1024 * 1024,
	});

	if (result.status !== 0) {
		throw new Error(`Inspector ${method}${toolName ? ` ${toolName}` : ""} failed (${result.status}): ${result.stderr.trim()}`);
	}

	return JSON.parse(result.stdout);
}

function structured(result) {
	return result.structuredContent ?? result.result?.structuredContent ?? result;
}

function call(name, args) {
	const result = inspector("tools/call", { toolName: name, args });
	const envelope = result.result ?? result;

	if (envelope.isError === true) throw new Error(`${name} returned a tool error`);

	return structured(envelope);
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

if (create.completed !== false || create.dashboard_url !== expectedCreate.toString()) {
	throw new Error("create completion result did not match the local dashboard link");
}

if (connectorId) {
	call("hydradb_connector_get", { connector_id: connectorId });
	const reconnect = call("hydradb_connector_update", { connector_id: connectorId, reconnect: true });
	const expectedReconnect = new URL("/connectors", dashboard);
	expectedReconnect.searchParams.set("open", connectorId);

	if (reconnect.completed !== false || reconnect.dashboard_url !== expectedReconnect.toString()) {
		throw new Error("reconnect completion result did not match the local dashboard link");
	}

	call("hydradb_connector_discover", { connector_id: connectorId, limit: 25 });
	call("hydradb_connector_resources", { connector_id: connectorId });
	call("hydradb_connector_status", { connector_id: connectorId });
}

if (mutate) {
	if (resourceId) {
		call("hydradb_connector_add_resource", { connector_id: connectorId, resource_id: resourceId });
		call("hydradb_connector_update_resource", {
			connector_id: connectorId,
			resource_id: resourceId,
			acl: [],
			custom_instructions: "ENG-3341 local-only verification",
		});
	}

	call("hydradb_connector_sync", { connector_id: connectorId });
	call("hydradb_connector_pause", { connector_id: connectorId });
	call("hydradb_connector_resume", { connector_id: connectorId });
	call("hydradb_connector_status", { connector_id: connectorId });
}

if (cleanup) {
	if (resourceId) call("hydradb_connector_delete_resource", { connector_id: connectorId, resource_id: resourceId });
	call("hydradb_connector_delete", { connector_id: connectorId });
}

console.log(JSON.stringify({
	ok: true,
	inspector_version: INSPECTOR_VERSION,
	provider,
	connector_checked: Boolean(connectorId),
	mutations_checked: mutate,
	cleanup_checked: cleanup,
}, null, 2));
