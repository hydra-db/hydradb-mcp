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

test("local-only guard refuses external redirects", () => {
	const result = spawnSync(process.execPath, ["scripts/e2e-connectors.local.mjs", "--guard-self-test"], {
		cwd: process.cwd(),
		encoding: "utf8",
		timeout: 10_000,
	});

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /non-loopback redirect refused/);
});
