#!/usr/bin/env node
/**
 * Prove the documented install command starts the server.
 *
 * Every client config in the README and the docs is `npx -y @hydradb/mcp@...`
 * with no binary name. npx runs a package without one only when it can tell
 * which binary is meant: the package has a single `bin` entry, or one of them
 * is named after the package without its scope. From 1.2.2 to 1.8.0 this
 * package shipped `hydradb-mcp` and `hydradb-mcp-http` and no `mcp`, so the
 * command failed with "could not determine executable to run" before the
 * server was ever spawned. `smoke-dist.mjs` could not see it, because it runs
 * `node dist/index.js` and never goes through npm's bin resolution.
 *
 * This packs the package exactly as it would be published, then runs `npx` on
 * the tarball from an empty directory, the way a client does, and speaks
 * enough MCP to know the process that started is this server. It needs the
 * registry to install the package's dependencies.
 */
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TIMEOUT_MS = 180_000;

const pkg = JSON.parse(readFileSync("package.json", "utf8"));

function fail(message) {
	console.error(`[smoke-npx] FAIL: ${message}`);
	process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "hydradb-mcp-npx-"));

process.on("exit", () => rmSync(work, { recursive: true, force: true }));

const packed = JSON.parse(
	execFileSync("npm", ["pack", "--json", "--pack-destination", work], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
	}),
);

// Relative to `work`, where npx runs: npx reads `./x.tgz` as a package to
// install and an absolute path as a program to execute.
const tarball = `./${packed[0].filename}`;

/**
 * Run one npx command line and resolve once it answers `initialize` as this
 * server at this version. Anything else (npm refusing to pick a binary, a
 * crash on startup, silence) fails the run with what npm printed.
 */
function startsServer(args) {
	const label = `npx ${args.join(" ").replace(tarball, "<tarball>")}`;

	return new Promise((done) => {
		const child = spawn("npx", args, {
			cwd: work,
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				...process.env,
				HYDRADB_API_KEY: "smoke-test-key",
				HYDRADB_DATABASE: "smoke-test-db",
			},
		});

		let stdout = "";
		let stderr = "";
		let answered = false;
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (c) => {
			stderr += c;
		});

		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			fail(`${label}: no answer within ${TIMEOUT_MS}ms.\nstderr:\n${stderr}`);
		}, TIMEOUT_MS);

		child.on("error", (error) => fail(`${label}: could not run npx: ${error.message}`));
		child.on("exit", (code) => {
			if (answered) return;
			fail(`${label}: exited with code ${code} before answering.\n${stderr.trim() || "(no stderr)"}`);
		});

		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			const complete = stdout.slice(0, stdout.lastIndexOf("\n") + 1);

			for (const line of complete.split("\n")) {
				if (line.trim() === "") continue;
				let parsed;

				try {
					parsed = JSON.parse(line);
				} catch {
					fail(`${label}: non-JSON on stdout: ${line.slice(0, 200)}`);
				}

				if (parsed.id !== 1) continue;

				const version = parsed.result?.serverInfo?.version;

				if (version !== pkg.version) {
					fail(`${label}: answered as version ${version}, expected ${pkg.version}`);
				}

				answered = true;
				clearTimeout(timer);
				child.kill("SIGTERM");
				console.error(`[smoke-npx] OK: ${label}`);
				done();

				return;
			}
		});

		child.stdin.write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2024-11-05",
					capabilities: {},
					clientInfo: { name: "smoke-npx", version: "0.0.0" },
				},
			})}\n`,
		);
	});
}

/** A port nothing is listening on, for the HTTP binary to bind. */
function freePort() {
	return new Promise((done) => {
		const probe = createServer();
		probe.listen(0, "127.0.0.1", () => {
			const { port } = probe.address();
			probe.close(() => done(port));
		});
	});
}

/**
 * Run the HTTP binary through npx and resolve once it reports the port it
 * bound. npm links a binary as a symlink, and an entry point that compares
 * its own path with `argv[1]` without resolving the link exits 0 having
 * started nothing, so an early exit fails here whatever its code.
 */
async function startsHttpServer(args) {
	const label = `npx ${args.join(" ")}`;
	const port = await freePort();

	return new Promise((done) => {
		const child = spawn("npx", args, {
			cwd: work,
			stdio: ["ignore", "ignore", "pipe"],
			env: { ...process.env, PORT: String(port) },
		});

		let stderr = "";
		let listening = false;
		child.stderr.setEncoding("utf8");

		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			fail(`${label}: not listening within ${TIMEOUT_MS}ms.\nstderr:\n${stderr}`);
		}, TIMEOUT_MS);

		child.on("error", (error) => fail(`${label}: could not run npx: ${error.message}`));
		child.on("exit", (code) => {
			if (listening) return;
			fail(`${label}: exited with code ${code} without listening.\n${stderr.trim() || "(no stderr)"}`);
		});

		child.stderr.on("data", (chunk) => {
			stderr += chunk;

			if (listening || !stderr.includes(`:${port}`)) return;
			listening = true;
			clearTimeout(timer);
			child.kill("SIGTERM");
			console.error(`[smoke-npx] OK: ${label}`);
			done();
		});
	});
}

// The documented command: the package and nothing else.
await startsServer(["-y", tarball]);

// The explicit name clients pinned while the bare command was failing.
await startsServer(["-y", "-p", tarball, "hydradb-mcp"]);

await startsHttpServer(["-y", "-p", tarball, "hydradb-mcp-http"]);
