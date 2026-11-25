/**
 * Tool-call metrics in the Prometheus text format, served on their own port
 * when `HYDRADB_METRICS_PORT` is set (the hosted deployment). A failed tool
 * call answers inside a JSON-RPC 200, so nothing outside this process can
 * count it. No dependency: the counters are plain maps, kept for the process
 * because the HTTP transport builds a new server per request.
 */

import { createServer, type Server } from "node:http";

// rejected: HydraDB refused the caller's request (a 4xx other than 408/429), not a failure of ours.
export const TOOL_RESULTS = ["ok", "rejected", "error", "timeout", "cancelled"] as const;

export type ToolResultLabel = (typeof TOOL_RESULTS)[number];

const DURATION_BUCKETS = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

const calls = new Map<string, number>();

const durations = new Map<string, { buckets: number[]; sum: number; count: number }>();

export function recordToolCall(tool: string, result: ToolResultLabel, seconds: number): void {
	const key = `${tool}\u0000${result}`;
	calls.set(key, (calls.get(key) ?? 0) + 1);

	let hist = durations.get(tool);

	if (!hist) {
		hist = { buckets: DURATION_BUCKETS.map(() => 0), sum: 0, count: 0 };
		durations.set(tool, hist);
	}

	DURATION_BUCKETS.forEach((le, i) => {
		if (seconds <= le) hist.buckets[i]++;
	});
	hist.sum += seconds;
	hist.count++;
}

function label(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export function renderMetrics(): string {
	const out = [
		"# HELP hydradb_mcp_tool_calls_total MCP tool calls by tool and result (ok, rejected, error, timeout, cancelled).",
		"# TYPE hydradb_mcp_tool_calls_total counter",
	];

	for (const [key, n] of calls) {
		const [tool, result] = key.split("\u0000");
		out.push(`hydradb_mcp_tool_calls_total{tool="${label(tool)}",result="${result}"} ${n}`);
	}

	out.push(
		"# HELP hydradb_mcp_tool_call_duration_seconds Duration of MCP tool calls.",
		"# TYPE hydradb_mcp_tool_call_duration_seconds histogram",
	);

	for (const [tool, hist] of durations) {
		const t = label(tool);
		DURATION_BUCKETS.forEach((le, i) => {
			out.push(`hydradb_mcp_tool_call_duration_seconds_bucket{tool="${t}",le="${le}"} ${hist.buckets[i]}`);
		});
		out.push(`hydradb_mcp_tool_call_duration_seconds_bucket{tool="${t}",le="+Inf"} ${hist.count}`);
		out.push(`hydradb_mcp_tool_call_duration_seconds_sum{tool="${t}"} ${hist.sum}`);
		out.push(`hydradb_mcp_tool_call_duration_seconds_count{tool="${t}"} ${hist.count}`);
	}

	return `${out.join("\n")}\n`;
}

/** Test-only: start from empty counters. */
export function __resetMetrics(): void {
	calls.clear();
	durations.clear();
}

/** GET /metrics on its own port; the public MCP port never serves it. */
export function startMetricsServer(port: number, host = "0.0.0.0"): Server {
	return createServer((req, res) => {
		if (req.method === "GET" && req.url === "/metrics") {
			res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
			res.end(renderMetrics());

			return;
		}

		res.writeHead(404).end();
	}).listen(port, host);
}
