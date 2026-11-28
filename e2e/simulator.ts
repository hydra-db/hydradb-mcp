/**
 * A stand-in HydraDB API on 127.0.0.1. It records every request and answers
 * from a table: the recorded staging response for each route, unless a test
 * armed that route (for one marker) with a simulated result. With `upstream`
 * set it forwards every request to a real API instead and records the answers,
 * which is how `e2e/record.ts` captures the fixtures.
 */
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export type Outcome =
	| "400"
	| "401"
	| "403"
	| "404"
	| "429"
	| "500"
	| "503"
	| "reset"
	| "slow"
	| "non_json"
	| "empty_object"
	| "empty_list";

export const OUTCOMES: Outcome[] = ["400", "401", "403", "404", "429", "500", "503", "reset", "slow", "non_json", "empty_object", "empty_list"];

export interface Recorded {
	status: number;
	headers: Record<string, string>;
	body: unknown;
}

export interface Fixtures {
	recorded_at: string;
	/** Real error envelopes, by status, with the call that produced each. */
	errors: Record<"400" | "401" | "404", Recorded & { call: string }>;
	/** The last successful staging answer per route id. */
	routes: Record<string, Recorded>;
}

export interface FilePart {
	filename: string;
	contentType: string;
	content: string;
}

export interface Exchange {
	route: string | undefined;
	marker: string | undefined;
	method: string;
	path: string;
	query: URLSearchParams;
	headers: Record<string, string>;
	/** Parsed JSON body, or the multipart text fields. */
	body: unknown;
	files: Record<string, FilePart[]>;
	/** Set in proxy mode: what the real API answered. */
	response?: Recorded;
}

interface Route {
	id: string;
	method: string;
	pattern: RegExp;
	/** Dotted paths of the result lists in the route's answer, emptied for the `empty_list` result. */
	list?: string[];
}

/**
 * Every route this server calls, by family. First match wins, so a literal
 * segment comes before a parameter in the same position.
 */
export const ROUTES: Route[] = [
	{ id: "ingest", method: "POST", pattern: /^\/context\/ingest$/ },
	{ id: "list", method: "POST", pattern: /^\/context\/list$/, list: ["data.sources"] },
	{ id: "inspect", method: "GET", pattern: /^\/context\/inspect$/ },
	{ id: "status", method: "GET", pattern: /^\/context\/status$/, list: ["data.statuses"] },
	{ id: "relations", method: "GET", pattern: /^\/context\/relations$/, list: ["data.relations"] },
	{ id: "subgraph", method: "GET", pattern: /^\/context\/[^/]+\/subgraph$/, list: ["data.sources"] },
	{ id: "update", method: "PATCH", pattern: /^\/context\/[^/]+\/metadata$/ },
	{ id: "delete", method: "DELETE", pattern: /^\/context$/ },
	{ id: "query", method: "POST", pattern: /^\/query$/, list: ["data.chunks"] },
	{ id: "feedback", method: "POST", pattern: /^\/feedback$/ },
	{ id: "collections.list", method: "GET", pattern: /^\/databases\/collections$/, list: ["data.collections", "data.sub_tenant_ids"] },
	{ id: "collections.delete", method: "DELETE", pattern: /^\/databases\/collections$/ },
	{ id: "databases.status", method: "GET", pattern: /^\/databases\/status$/ },
	{ id: "databases.stats", method: "GET", pattern: /^\/databases\/stats$/ },
	{ id: "databases.schema", method: "GET", pattern: /^\/databases\/[^/]+\/metadata-schema$/, list: ["data.fields"] },
	{ id: "databases.schema_update", method: "PATCH", pattern: /^\/databases\/[^/]+\/metadata-schema$/ },
	{ id: "databases.list", method: "GET", pattern: /^\/databases$/, list: ["data.tenant_ids", "data.databases", "data.details"] },
	{ id: "databases.create", method: "POST", pattern: /^\/databases$/ },
	{ id: "databases.delete", method: "DELETE", pattern: /^\/databases$/ },
	{ id: "connectors.providers", method: "GET", pattern: /^\/connectors\/providers$/, list: ["providers"] },
	{ id: "connectors.list", method: "GET", pattern: /^\/connectors$/, list: ["connectors"] },
	{ id: "connectors.status", method: "GET", pattern: /^\/connectors\/[^/]+\/status$/ },
	{ id: "connectors.resources", method: "GET", pattern: /^\/connectors\/[^/]+\/resources$/, list: ["resources"] },
	{ id: "connectors.discover", method: "GET", pattern: /^\/connectors\/[^/]+\/discover$/, list: ["resources"] },
	{ id: "connectors.get", method: "GET", pattern: /^\/connectors\/[^/]+$/ },
	{ id: "connectors.update", method: "PATCH", pattern: /^\/connectors\/[^/]+$/ },
	{ id: "connectors.delete", method: "DELETE", pattern: /^\/connectors\/[^/]+$/ },
	{ id: "connectors.sync", method: "POST", pattern: /^\/connectors\/[^/]+\/sync$/ },
	{ id: "connectors.pause", method: "POST", pattern: /^\/connectors\/[^/]+\/pause$/ },
	{ id: "connectors.resume", method: "POST", pattern: /^\/connectors\/[^/]+\/resume$/ },
	{ id: "connectors.configure", method: "POST", pattern: /^\/connectors\/[^/]+\/configure$/ },
	{ id: "connectors.resource_update", method: "PATCH", pattern: /^\/connectors\/[^/]+\/resources\/[^/]+$/ },
	{ id: "connectors.resource_delete", method: "DELETE", pattern: /^\/connectors\/[^/]+\/resources\/[^/]+$/ },
	{ id: "graph.query", method: "POST", pattern: /^\/byog\/query$/, list: ["data"] },
	{ id: "graph.collections", method: "GET", pattern: /^\/byog\/collections$/, list: ["data.collections"] },
	{ id: "graph.drop_collection", method: "DELETE", pattern: /^\/byog\/collections$/ },
	{ id: "graph.create", method: "POST", pattern: /^\/byog\/databases$/ },
	{ id: "graph.drop_database", method: "DELETE", pattern: /^\/byog\/databases$/ },
];

export function routeOf(method: string, path: string): Route | undefined {
	return ROUTES.find((route) => route.method === method && route.pattern.test(path));
}

/**
 * Which test a request belongs to. Tests give each call its own database name
 * (or connector id), so concurrent calls can be armed and counted apart.
 */
function markerOf(path: string, query: URLSearchParams, body: unknown): string | undefined {
	const connector = /^\/connectors\/(?!providers$)([^/]+)/.exec(path)?.[1];

	if (connector) return decodeURIComponent(connector);

	const schema = /^\/databases\/([^/]+)\/metadata-schema$/.exec(path)?.[1];

	if (schema) return decodeURIComponent(schema);

	const fromQuery = query.get("database");

	if (fromQuery) return fromQuery;

	if (body != null && typeof body === "object" && "database" in body) {
		const value = (body as { database?: unknown }).database;

		if (typeof value === "string") return value;
	}

	return undefined;
}

/** Enough of RFC 7578 for what an SDK's FormData sends: text fields and file parts. */
export function parseMultipart(raw: Buffer, contentType: string): { fields: Record<string, string>; files: Record<string, FilePart[]> } {
	const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
	const fields: Record<string, string> = {};
	const files: Record<string, FilePart[]> = {};

	if (!boundary) return { fields, files };

	const delimiter = `--${boundary[1] ?? boundary[2]}`;

	for (const part of raw.toString("latin1").split(delimiter).slice(1)) {
		if (part.startsWith("--")) break;

		const split = part.indexOf("\r\n\r\n");

		if (split < 0) continue;

		const head = part.slice(0, split);
		const content = Buffer.from(part.slice(split + 4).replace(/\r\n$/, ""), "latin1").toString("utf8");
		const name = /name="([^"]*)"/i.exec(head)?.[1] ?? "";
		const filename = /filename="([^"]*)"/i.exec(head)?.[1];

		if (filename == null) {
			fields[name] = content;
		} else {
			const type = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1] ?? "";

			files[name] = [...(files[name] ?? []), { filename, contentType: type, content }];
		}
	}

	return { fields, files };
}

function at(value: unknown, path: string): unknown {
	let current = value;

	for (const key of path.split(".")) {
		if (current == null || typeof current !== "object") return undefined;

		current = (current as Record<string, unknown>)[key];
	}

	return current;
}

/** `value` with the array at each of `paths` replaced by `[]`; undefined when one of them holds no array. */
function emptied(value: unknown, paths: string[]): unknown {
	if (!paths.every((path) => Array.isArray(at(value, path)))) return undefined;

	const copy = JSON.parse(JSON.stringify(value));

	for (const path of paths) {
		const keys = path.split(".");
		const last = keys.pop() as string;
		const parent = keys.reduce((node, key) => node[key], copy);

		parent[last] = [];
	}

	return copy;
}

/** A real envelope from the fixtures, carrying another status's code and message. */
function envelope(fixtures: Fixtures, code: string, message: string): unknown {
	const base = JSON.parse(JSON.stringify(fixtures.errors["401"].body));

	base.error = { ...base.error, code, message };

	return base;
}

/**
 * Codes and messages from the HydraDB API source, applied to the recorded
 * envelope for the statuses a test key cannot provoke on staging:
 * `apierr.CodeForbidden` and the permissions middleware, the rate limiter's
 * `LimitExceededError`, the auth middleware's 500, and `assertGraphReady`'s 503.
 */
export const SIMULATED_ERRORS: Record<"403" | "429" | "500" | "503", { code: string; message: string; retryAfter?: string }> = {
	"403": { code: "FORBIDDEN", message: "insufficient role for this action" },
	"429": { code: "RATE_LIMITED", message: "query rps rate limit exceeded (limit: 10). Please retry in 1 second(s).", retryAfter: "1" },
	"500": { code: "INTERNAL_ERROR", message: "Internal server error" },
	"503": {
		code: "TENANT_INFRA_NOT_READY",
		message:
			"The database's graph store is still starting up. See https://docs.hydradb.com/api-reference/v2/endpoint/ingest for usage details. " +
			"Wait until GET /databases/status reports ready_for_ingestion, or retry after the Retry-After interval.",
		retryAfter: "30",
	},
};

export const NON_JSON_BODY = "<html><head><title>OK</title></head><body><p>Service maintenance page</p></body></html>";

export function loadFixtures(): Fixtures {
	return JSON.parse(readFileSync(new URL("./fixtures/staging.json", import.meta.url), "utf8")) as Fixtures;
}

const armKey = (route: string, marker: string | undefined) => `${route}\u0000${marker ?? "*"}`;

export class Simulator {
	readonly exchanges: Exchange[] = [];
	private readonly armed = new Map<string, Outcome>();
	private server?: Server;

	constructor(
		private readonly options: { fixtures?: Fixtures; upstream?: string; slowMs?: number },
	) {}

	async start(): Promise<string> {
		this.server = createServer((req, res) => {
			this.handle(req, res).catch((error) => {
				res.statusCode = 599;
				res.end(String(error));
			});
		});
		await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
		const address = this.server.address();
		const port = typeof address === "object" && address != null ? address.port : 0;

		return `http://127.0.0.1:${port}`;
	}

	async stop(): Promise<void> {
		this.server?.closeAllConnections?.();
		await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
	}

	/** Answer `route` with `outcome` for requests carrying `marker` (undefined: every request). */
	arm(route: string, marker: string | undefined, outcome: Outcome) {
		this.armed.set(armKey(route, marker), outcome);
	}

	disarm(route: string, marker: string | undefined) {
		this.armed.delete(armKey(route, marker));
	}

	requests(route: string, marker?: string): Exchange[] {
		return this.exchanges.filter((ex) => ex.route === route && (marker == null || ex.marker === marker));
	}

	private async handle(req: IncomingMessage, res: ServerResponse) {
		const chunks: Buffer[] = [];

		for await (const chunk of req) chunks.push(chunk as Buffer);

		const raw = Buffer.concat(chunks);
		const url = new URL(req.url ?? "/", "http://simulator");
		const method = req.method ?? "GET";
		const contentType = String(req.headers["content-type"] ?? "");
		let body: unknown;
		let files: Record<string, FilePart[]> = {};

		if (contentType.startsWith("multipart/form-data")) {
			const parsed = parseMultipart(raw, contentType);

			body = parsed.fields;
			files = parsed.files;
		} else if (raw.length > 0) {
			try {
				body = JSON.parse(raw.toString("utf8"));
			} catch {
				body = raw.toString("utf8");
			}
		}

		const route = routeOf(method, url.pathname);
		const exchange: Exchange = {
			route: route?.id,
			marker: markerOf(url.pathname, url.searchParams, body),
			method,
			path: url.pathname,
			query: url.searchParams,
			headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])),
			body,
			files,
		};

		this.exchanges.push(exchange);

		if (this.options.upstream) {
			await this.forward(req, raw, exchange, res);

			return;
		}

		const outcome = route
			? (this.armed.get(armKey(route.id, exchange.marker)) ?? this.armed.get(armKey(route.id, undefined)))
			: undefined;

		await this.answer(route, outcome, req, res);
	}

	private async forward(req: IncomingMessage, raw: Buffer, exchange: Exchange, res: ServerResponse) {
		const headers = new Headers();

		for (const [key, value] of Object.entries(req.headers)) {
			if (value != null && !["host", "content-length", "connection"].includes(key)) headers.set(key, String(value));
		}

		const upstream = await fetch(`${this.options.upstream}${req.url}`, {
			method: req.method,
			headers,
			body: raw.length > 0 ? new Uint8Array(raw) : undefined,
		});
		const text = await upstream.text();
		let parsed: unknown = text;

		try {
			parsed = JSON.parse(text);
		} catch {
			// a non-JSON answer is recorded as text
		}

		const kept: Record<string, string> = {};

		for (const name of ["content-type", "retry-after"]) {
			const value = upstream.headers.get(name);

			if (value) kept[name] = value;
		}

		exchange.response = { status: upstream.status, headers: kept, body: parsed };
		res.writeHead(upstream.status, kept);
		res.end(text);
	}

	private async answer(route: Route | undefined, outcome: Outcome | undefined, req: IncomingMessage, res: ServerResponse) {
		const fixtures = this.options.fixtures;

		if (fixtures == null) throw new Error("replay mode needs fixtures");

		const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
			const text = typeof body === "string" ? body : JSON.stringify(body);

			res.writeHead(status, { "content-type": typeof body === "string" ? "text/html" : "application/json", ...headers });
			res.end(text);
		};
		const good = route ? fixtures.routes[route.id] : undefined;

		switch (outcome) {
			case "400":
			case "401":
			case "404": {
				const recorded = fixtures.errors[outcome];

				send(recorded.status, recorded.body, recorded.headers);

				return;
			}
			case "403":
			case "429":
			case "500":
			case "503": {
				const simulated = SIMULATED_ERRORS[outcome];

				send(Number(outcome), envelope(fixtures, simulated.code, simulated.message), simulated.retryAfter ? { "retry-after": simulated.retryAfter } : {});

				return;
			}
			case "reset":
				req.socket.destroy();

				return;
			case "slow":
				await new Promise((resolve) => setTimeout(resolve, this.options.slowMs ?? 5_000));
				if (good) send(good.status, good.body);
				else send(204, "");

				return;
			case "non_json":
				send(200, NON_JSON_BODY);

				return;
			case "empty_object":
				send(200, {});

				return;
			case "empty_list": {
				const body = route?.list && good ? emptied(good.body, route.list) : undefined;

				if (body === undefined) throw new Error(`route ${route?.id} has no list to empty`);

				send(good?.status ?? 200, body);

				return;
			}
			default:
				if (good == null) {
					send(501, { error: { code: "NO_FIXTURE", message: `no recorded answer for ${req.method} ${req.url}` } });

					return;
				}

				send(good.status, good.body);
		}
	}
}
