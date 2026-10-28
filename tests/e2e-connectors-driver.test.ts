import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("local connector driver keeps API keys out of child process arguments", () => {
	const directory = mkdtempSync(join(tmpdir(), "hydradb-e2e-driver-test-"));
	const inspector = join(directory, "inspector.mjs");
	const argumentsLog = join(directory, "arguments.log");
	const apiKey = "eng3341-process-list-secret";

	try {
		writeFileSync(inspector, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.ARGUMENTS_LOG, JSON.stringify(args) + "\\n");
const method = args[args.indexOf("--method") + 1];
const toolName = args[args.indexOf("--tool-name") + 1];
const output = method === "tools/list"
  ? { tools: [
      { name: "hydradb_connector_create", inputSchema: { properties: { provider: {} } } },
      { name: "hydradb_connector_update", inputSchema: { properties: {} } }
    ] }
  : toolName === "hydradb_connector_create"
    ? { result: { content: [{ type: "text", text: "http://127.0.0.1:3000/connectors?connect=gitlab" }], structuredContent: { completed: false, dashboard_url: "http://127.0.0.1:3000/connectors?connect=gitlab" } } }
    : { result: { content: [], structuredContent: {} } };
process.stdout.write(JSON.stringify(output));
`, { mode: 0o700 });
		chmodSync(inspector, 0o700);

		const result = spawnSync(process.execPath, ["scripts/e2e-connectors.local.mjs"], {
			cwd: process.cwd(),
			env: {
				...process.env,
				ARGUMENTS_LOG: argumentsLog,
				HYDRADB_API_KEY: apiKey,
				HYDRADB_DATABASE: "local-test",
				HYDRADB_BASE_URL: "http://127.0.0.1:9999",
				HYDRADB_DASHBOARD_URL: "http://127.0.0.1:3000",
				MCP_INSPECTOR_BIN: inspector,
			},
			encoding: "utf8",
		});

		assert.equal(result.status, 0, result.stderr);
		assert.doesNotMatch(readFileSync(argumentsLog, "utf8"), new RegExp(apiKey));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("local-only guard refuses redirect chains at the first hop", () => {
	const result = spawnSync(process.execPath, ["scripts/e2e-connectors.local.mjs", "--guard-self-test"], {
		cwd: process.cwd(),
		encoding: "utf8",
		timeout: 10_000,
	});

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /redirect chain refused at first hop/);
	assert.match(result.stdout, /configured query preserved/);
});

test("local OAuth failures never print an echoed bearer token", () => {
	const token = "eng3341-oauth-error-secret";

	const result = spawnSync(process.execPath, ["scripts/e2e-connectors.local.mjs", "--oauth-error-self-test"], {
		cwd: process.cwd(),
		env: { ...process.env, ENG3341_SELF_TEST_TOKEN: token },
		encoding: "utf8",
		timeout: 10_000,
	});

	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(token));
	assert.match(result.stdout, /request failed safely/);
});

test("full lifecycle refuses a non-loopback fake-vendor control endpoint before setup", () => {
	const result = spawnSync(process.execPath, ["scripts/e2e-connectors.local.mjs"], {
		cwd: process.cwd(),
		env: {
			...process.env,
			HYDRADB_BASE_URL: "http://127.0.0.1:9999",
			HYDRADB_DASHBOARD_URL: "http://127.0.0.1:3000",
			ENG3341_FULL_LIFECYCLE: "1",
			ENG3341_RUN_OWNED: "1",
			ENG3341_CONNECTOR_ID: "run-owned-connector",
			ENG3341_RESOURCE_ID: "run-owned-resource",
			ENG3341_FAKE_VENDOR_CONTROL_URL: "https://vendor.example.test/__eng3341/failure",
		},
		encoding: "utf8",
		timeout: 10_000,
	});

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /must use a loopback host/);
});
