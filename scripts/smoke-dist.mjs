#!/usr/bin/env node
/**
 * Prove the built package actually runs before publishing it.
 *
 * The publish workflow built `dist/` and shipped it without ever executing it,
 * so a build that compiled but failed at runtime would reach the registry. The
 * failure modes that survive `tsc` are exactly the ones that matter here: a bad
 * shebang, an unresolvable import in the emitted output, a missing `files`
 * entry, or a server that starts and never answers.
 *
 * This starts the built server over stdio the way a real MCP host does, speaks
 * the protocol, and asserts it lists its tools. No API key is needed for a
 * useful check — startup, handshake and tools/list all happen before any
 * outbound call.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";

const ENTRY = "dist/index.js";
const TIMEOUT_MS = 15_000;

function fail(message) {
	console.error(`[smoke-dist] FAIL: ${message}`);
	process.exit(1);
}

if (!existsSync(ENTRY)) fail(`${ENTRY} does not exist — was the build run?`);

// A missing shebang makes the `bin` entry unexecutable when npm links it.
const firstLine = readFileSync(ENTRY, "utf8").split("\n", 1)[0];
if (!firstLine.startsWith("#!")) {
	fail(`${ENTRY} has no shebang (first line: ${JSON.stringify(firstLine)})`);
}

const child = spawn(process.execPath, [ENTRY], {
	stdio: ["pipe", "pipe", "pipe"],
	env: {
		...process.env,
		HYDRADB_API_KEY: process.env.HYDRADB_API_KEY ?? "smoke-test-key",
		HYDRADB_DATABASE: process.env.HYDRADB_DATABASE ?? "smoke-test-db",
	},
});

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (c) => {
	stdout += c;
});
child.stderr.on("data", (c) => {
	stderr += c;
});

const timer = setTimeout(() => {
	child.kill("SIGKILL");
	fail(`no response within ${TIMEOUT_MS}ms.\nstderr:\n${stderr}`);
}, TIMEOUT_MS);

// A build that crashes on startup — an unresolvable import in the emitted
// output, say — ends the child before any reply arrives. Without this the
// harness simply runs out of work and exits 0, which is the one outcome a smoke
// test must never produce.
let finished = false;
child.on("exit", (code, signal) => {
	if (finished) return;
	fail(
		`the server exited before answering (code ${code}, signal ${signal}).\n` +
			`stderr:\n${stderr.trim() || "(empty)"}`,
	);
});

child.on("error", (error) => {
	fail(`could not start ${ENTRY}: ${error.message}`);
});

function send(message) {
	child.stdin.write(`${JSON.stringify(message)}\n`);
}

/** Wait until a JSON-RPC response with the given id appears on stdout. */
async function awaitResponse(id) {
	for (;;) {
		for (const line of stdout.split("\n")) {
			if (line.trim() === "") continue;
			let parsed;
			try {
				parsed = JSON.parse(line);
			} catch {
				fail(`non-JSON on stdout — the transport is corrupted: ${line.slice(0, 200)}`);
			}
			if (parsed.id === id) return parsed;
		}
		await once(child.stdout, "data");
	}
}

send({
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: {
		protocolVersion: "2024-11-05",
		capabilities: {},
		clientInfo: { name: "smoke-dist", version: "0.0.0" },
	},
});

const initialized = await awaitResponse(1);
if (initialized.error) fail(`initialize failed: ${JSON.stringify(initialized.error)}`);
const serverVersion = initialized.result?.serverInfo?.version;
if (!serverVersion) fail("initialize returned no server version");

// The version must match what is about to be published, or clients see stale
// metadata — a real bug this package shipped through the whole 1.x line.
const pkgVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
if (serverVersion !== pkgVersion) {
	fail(`server reports version ${serverVersion} but package.json says ${pkgVersion}`);
}

send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

const listed = await awaitResponse(2);
if (listed.error) fail(`tools/list failed: ${JSON.stringify(listed.error)}`);

const tools = listed.result?.tools ?? [];
if (tools.length === 0) fail("the server advertises no tools");

const REQUIRED = [
	"hydradb_query",
	"hydradb_ingest",
	"hydradb_list",
	"hydradb_inspect",
	"hydradb_delete",
	"hydradb_status",
];
const names = tools.map((t) => t.name);
const missing = REQUIRED.filter((t) => !names.includes(t));
if (missing.length > 0) fail(`missing canonical tool(s): ${missing.join(", ")}`);

clearTimeout(timer);
finished = true;
child.kill("SIGTERM");

console.error(
	`[smoke-dist] OK: ${ENTRY} starts, reports v${serverVersion}, and advertises ` +
		`${tools.length} tool(s): ${names.join(", ")}`,
);
