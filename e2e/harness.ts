import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const REPO = fileURLToPath(new URL("..", import.meta.url));

/** Which build of the server to drive: the TypeScript source, or the `dist/` npm ships. */
export type Entry = "source" | "dist";

export interface ToolAnswer {
	isError: boolean;
	text: string;
	structured: Record<string, unknown> | undefined;
	ms: number;
}

export interface Session {
	readonly version: string;
	call(name: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<ToolAnswer>;
	toolNames(): Promise<string[]>;
	close(): Promise<void>;
}

/** The parts of an answer two transports must agree on. */
export function comparable(answer: ToolAnswer): string {
	return JSON.stringify({ isError: answer.isError, text: answer.text, structured: answer.structured ?? null });
}

const CALL_TIMEOUT_MS = 120_000;

function command(entry: Entry, script: "index" | "http"): { command: string; args: string[] } {
	if (entry === "dist") {
		const built = `${REPO}dist/${script}.js`;

		if (!existsSync(built)) throw new Error(`${built} does not exist: run \`npm run build\` first`);

		return { command: process.execPath, args: [built] };
	}

	return { command: `${REPO}node_modules/.bin/tsx`, args: [`${REPO}src/${script}.ts`] };
}

function wrap(client: Client): Session {
	return {
		version: client.getServerVersion()?.version ?? "unknown",
		async call(name, args = {}, timeoutMs = CALL_TIMEOUT_MS) {
			const started = Date.now();

			try {
				const res = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
				const content = Array.isArray(res.content) ? res.content : [];
				const text = content.map((part) => (part.type === "text" ? part.text : "")).join("\n");

				return {
					isError: res.isError === true,
					text,
					structured: res.structuredContent as Record<string, unknown> | undefined,
					ms: Date.now() - started,
				};
			} catch (error) {
				return {
					isError: true,
					text: error instanceof Error ? error.message : String(error),
					structured: undefined,
					ms: Date.now() - started,
				};
			}
		},
		async toolNames() {
			const { tools } = await client.listTools();

			return tools.map((tool) => tool.name).sort();
		},
		close: () => client.close(),
	};
}

export interface StdioServer extends Session {
	stderr(): string;
}

/**
 * Spawn the server over stdio and connect the SDK client to it. The child gets
 * the MCP SDK's safe default environment plus `env`, so a developer's own
 * HYDRADB_* settings never leak into a run.
 */
export async function startStdio(entry: Entry, env: Record<string, string>): Promise<StdioServer> {
	const { command: cmd, args } = command(entry, "index");
	const transport = new StdioClientTransport({ command: cmd, args, env, stderr: "pipe", cwd: REPO });
	let stderr = "";

	transport.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});

	const client = new Client({ name: "hydradb-mcp-e2e", version: "0.0.0" });

	try {
		await client.connect(transport);
	} catch (error) {
		throw new Error(`the stdio server did not start: ${error instanceof Error ? error.message : error}\n${stderr}`);
	}

	return { ...wrap(client), stderr: () => stderr };
}

export async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();

		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			const port = typeof address === "object" && address != null ? address.port : 0;

			probe.close(() => resolve(port));
		});
	});
}

export interface HttpServer {
	url: URL;
	stderr(): string;
	stop(): Promise<void>;
}

/** Start the HTTP transport on a free loopback port and wait until `/health` answers. */
export async function startHttp(entry: Entry, env: Record<string, string>): Promise<HttpServer> {
	const port = await freePort();
	const { command: cmd, args } = command(entry, "http");
	const child: ChildProcess = spawn(cmd, args, {
		cwd: REPO,
		env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env, PORT: String(port), BIND_ADDRESS: "127.0.0.1" },
		stdio: ["ignore", "ignore", "pipe"],
	});
	let stderr = "";

	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});

	const base = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + 30_000;

	while (Date.now() < deadline) {
		if (child.exitCode != null) throw new Error(`the HTTP server exited with ${child.exitCode}:\n${stderr}`);

		try {
			const res = await fetch(`${base}/health`);

			if (res.ok) break;
		} catch {
			// not listening yet
		}

		await new Promise((resolve) => setTimeout(resolve, 200));
	}

	return {
		url: new URL(`${base}/mcp`),
		stderr: () => stderr,
		stop: () =>
			new Promise((resolve) => {
				if (child.exitCode != null) {
					resolve();

					return;
				}

				child.once("exit", () => resolve());
				child.kill("SIGTERM");
			}),
	};
}

export async function connectHttp(url: URL, headers: Record<string, string>): Promise<Session> {
	const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
	const client = new Client({ name: "hydradb-mcp-e2e", version: "0.0.0" });

	await client.connect(transport);

	return wrap(client);
}

/** `e2e-<surface>-<utc yyyymmddhhmmss>-<4 random lowercase chars>`, as the contract names a throwaway database. */
export function throwawayName(surface = "mcp"): string {
	const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
	const letters = "abcdefghijklmnopqrstuvwxyz";
	let suffix = "";

	for (let i = 0; i < 4; i++) suffix += letters[Math.floor(Math.random() * letters.length)];

	return `e2e-${surface}-${stamp}-${suffix}`;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
