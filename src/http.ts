#!/usr/bin/env node

/**
 * The remotely hostable HTTP transport.
 *
 * This is the server behind a URL like `https://mcp.hydradb.com/mcp`: instead of
 * every user installing and spawning the stdio binary ({@link file://./index.ts}),
 * one process answers MCP over HTTP and each user points their client at the URL.
 *
 * It reuses the whole tool surface unchanged — {@link createHydraDBServer} builds
 * exactly the same server the stdio path does. The only things this file adds are
 * the ones a network endpoint needs and a pipe does not: a Host/Origin
 * allowlist, CORS, and PER-REQUEST tenant credentials (see
 * {@link file://./http-config.ts}), because one hosted process has no single
 * ambient account to run as.
 *
 * Sessions are stateless: MCP's Protocol object binds to one transport, so a
 * shared process serving many independent callers builds a fresh server +
 * transport per request and tears it down when the response closes. That is the
 * transport's documented stateless mode (`sessionIdGenerator: undefined`).
 */

import cors from "cors";
import express, { type Express } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { HydraDB } from "./hydra/index.js";
import {
	buildAllowedHosts,
	type HttpServerConfig,
	jsonRpcError,
	parseList,
	parsePort,
	resolveHttpServerConfig,
	resolveRequestCredentials,
	type ResolvedIdentity,
} from "./http-config.js";
import { logger } from "./logger.js";
import {
	introspect,
	isAccessToken,
	metadataUrl,
	type OAuthConfig,
	protectedResourceMetadata,
	wwwAuthenticate,
} from "./oauth.js";
import {
	awaitInFlight,
	beginShutdown,
	createHydraDBServer,
	inFlightCount,
} from "./server.js";

/**
 * The largest request body accepted before parsing.
 *
 * Sized above the tool layer's own ceilings — memory ingest caps `text` at 1M
 * characters (~4 MB as UTF-8 with a JSON envelope), which is the biggest
 * legitimate body — so a valid large ingest is not rejected at the door while an
 * unbounded body cannot exhaust memory. Anything genuinely oversized is still
 * refused by the per-tool checks with a message naming the real limit.
 */
const MAX_REQUEST_BODY = "8mb";

/**
 * Startup banners and security warnings go straight to stderr, not through
 * `logger`.
 *
 * `logger` is gated by `HYDRADB_LOG_LEVEL`, which defaults to ERROR, so a
 * `logger.warn` about a public bind would be invisible in the exact default
 * configuration where it matters most. These lines must surface regardless of
 * level — the same reason the deprecated-alias warnings bypass the logger — so
 * they use `console.error` (stderr) directly. Per-request and lifecycle logging
 * still goes through `logger`.
 */
function banner(message: string): void {
	console.error(`[hydradb-mcp] ${message}`);
}

/** The bearer value from an `Authorization` header, scheme-insensitive. */
function bearerFromHeader(value: string | string[] | undefined): string | undefined {
	const raw = Array.isArray(value) ? value[0] : value;
	if (!raw) return undefined;
	const match = /^\s*Bearer\s+(.+)$/i.exec(raw);
	return (match ? match[1] : raw).trim() || undefined;
}

/** JSON-RPC error codes used for transport-level failures (spec: -32000 range). */
const JSONRPC_UNAUTHORIZED = -32001;
const JSONRPC_BAD_REQUEST = -32602;
const JSONRPC_INTERNAL_ERROR = -32603;
const JSONRPC_MISDIRECTED = -32000;

/**
 * Build the Express app for the HTTP transport.
 *
 * Exported (and taking its config as an argument rather than reading the
 * environment) so tests exercise the exact wiring production runs, against an
 * arbitrary allowlist, with no process-global state.
 */
export function createHttpApp(config: HttpServerConfig): Express {
	const { bindAddress, allowedOrigins, allowedHosts } = config;
	const allowsAllOrigins = allowedOrigins.includes("*");
	// OAuth is a per-deployment capability, not a per-request one, so it is
	// resolved once. `null` means every OAuth surface below is absent and this
	// server is byte-for-byte the pre-OAuth one.
	const oauth: OAuthConfig | null = config.oauth ?? null;

	const app = express();
	// Off by default so a direct client cannot spoof `X-Forwarded-*`; a
	// deployment behind a known proxy sets TRUST_PROXY to recover the real client
	// IP without trusting every hop. Only logging and `req.protocol` read it — the
	// Host allowlist, not a proxy header, is the DNS-rebinding defence.
	app.set("trust proxy", config.trustProxy);
	// The Host allowlist is the actual defence; the fingerprinting header is noise.
	app.disable("x-powered-by");

	// --- Host header allowlist (runs first, before CORS) ---
	//
	// A DNS-rebinding defence: without it, a page the user visits can point a
	// hostname it controls at 127.0.0.1 and drive a locally bound server. The
	// check is the operator's ALLOWED_HOSTS plus loopback; a hosted deployment
	// adds its public hostname. 421 Misdirected Request is the status for "this
	// server does not answer to that authority".
	app.use((req, res, next) => {
		const host = req.headers.host;
		if (!host || !allowedHosts.has(host.toLowerCase())) {
			logger.warn("rejected request with disallowed Host header", {
				host,
				path: req.path,
			});
			res
				.status(421)
				.json(jsonRpcError(JSONRPC_MISDIRECTED, "Misdirected request"));
			return;
		}
		next();
	});

	// --- CORS ---
	//
	// A distinct error type so the error handler below can tell an origin
	// rejection apart from any other downstream failure and answer it with 403.
	class CorsOriginNotAllowedError extends Error {
		constructor(readonly origin: string) {
			super(`Origin ${origin} not allowed by CORS`);
			this.name = "CorsOriginNotAllowedError";
		}
	}

	app.use(
		cors({
			origin: (origin, callback) => {
				// No Origin header: a non-browser client or a same-origin request.
				// These are not subject to CORS and are allowed through.
				if (!origin) return callback(null, true);
				// The opaque `null` origin (sandboxed iframe, file://) is only
				// honoured when the operator lists it explicitly.
				if (origin === "null") {
					return allowedOrigins.includes("null")
						? callback(null, true)
						: callback(new CorsOriginNotAllowedError("null"));
				}
				if (allowsAllOrigins || allowedOrigins.includes(origin)) {
					return callback(null, true);
				}
				return callback(new CorsOriginNotAllowedError(origin));
			},
			// The client reads the session id and negotiated protocol version off
			// the response; without exposing them a browser cannot complete a session.
			// WWW-Authenticate is the OAuth discovery entry point: a browser-based
			// client (claude.ai) that cannot read it off the 401 never learns where
			// to log in, so the whole flow silently fails for exactly the clients
			// OAuth exists for.
			exposedHeaders: ["Mcp-Session-Id", "Mcp-Protocol-Version", "WWW-Authenticate"],
			allowedHeaders: [
				"Content-Type",
				"Authorization",
				"Mcp-Session-Id",
				"Mcp-Protocol-Version",
				"X-HydraDB-Api-Key",
				"X-HydraDB-Database",
				"X-HydraDB-Collection",
				"X-HydraDB-Graph-Database",
				"X-HydraDB-Graph-Collection",
			],
		}),
	);

	// Turn a CORS origin rejection into an explicit 403 with a JSON-RPC body,
	// mirroring the 421 the Host check emits. Placed right after cors so any
	// other error still reaches Express's default handler unchanged.
	app.use(
		(
			err: Error,
			req: express.Request,
			res: express.Response,
			next: express.NextFunction,
		) => {
			if (err instanceof CorsOriginNotAllowedError) {
				logger.warn("rejected request with disallowed Origin", {
					origin: err.origin,
					path: req.path,
				});
				res
					.status(403)
					.json(jsonRpcError(JSONRPC_MISDIRECTED, "Origin not allowed"));
				return;
			}
			next(err);
		},
	);

	app.use(express.json({ limit: MAX_REQUEST_BODY }));

	// --- The MCP endpoint ---
	// Serves MCP at both the root `/` (e.g. https://mcp.hydradb.com) and `/mcp`
	// so clients pointing at either URL connect seamlessly.
	// --- OAuth Protected Resource Metadata (RFC 9728) ---
	//
	// The one document a client needs to get from "401" to "open the browser at
	// the right place". Served at the root form and the `/mcp` path form, since
	// a client tries the path-inserted URL first when the endpoint has a path.
	// Registered only when OAuth is configured, so an unconfigured server has
	// no new routes at all.
	if (oauth) {
		app.get(
			["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"],
			(_req, res) => {
				res.setHeader("Cache-Control", "public, max-age=300");
				res.setHeader("Access-Control-Allow-Origin", "*");
				res.json(protectedResourceMetadata(oauth));
			},
		);
	}

	app.all(["/", "/mcp"], async (req, res) => {
		// An OAuth access token arrives in the same `Authorization: Bearer` slot
		// an API key does. It is told apart by prefix and exchanged, via the
		// issuer, for the API key and scope the user approved on the consent
		// screen. From there it is indistinguishable from a caller who sent that
		// key directly: the same resolver runs, and the tool layer never learns
		// OAuth exists.
		let identity: ResolvedIdentity | undefined;
		const bearer = bearerFromHeader(req.headers.authorization);
		if (oauth && isAccessToken(bearer)) {
			const result = await introspect(oauth, bearer);
			if (!result.ok) {
				if (result.reason === "unavailable") {
					logger.error("token introspection unavailable", { detail: result.detail });
					res
						.status(503)
						.json(jsonRpcError(JSONRPC_INTERNAL_ERROR, "Authorization service unavailable"));
					return;
				}
				res.setHeader(
					"WWW-Authenticate",
					wwwAuthenticate(
						oauth,
						"invalid_token",
						result.reason === "wrong_audience"
							? "token was not issued for this server"
							: "token is invalid, expired or revoked",
					),
				);
				res
					.status(401)
					.json(jsonRpcError(JSONRPC_UNAUTHORIZED, "Invalid or expired access token"));
				return;
			}
			const t = result.token;
			identity = {
				apiKey: t.apiKey,
				...(t.database != null ? { database: t.database } : {}),
				...(t.collection != null ? { collection: t.collection } : {}),
				...(t.allowedDatabases ? { allowedDatabases: t.allowedDatabases } : {}),
			};
			// A token is a credential; nothing carrying one may be cached.
			res.setHeader("Cache-Control", "no-store");
		}

		// Who is this request for? On a hosted process the answer lives entirely
		// in the request, so it is resolved here and a missing/incomplete answer
		// is refused before any server is built.
		const resolution = resolveRequestCredentials(req.headers, process.env, identity);
		if (!resolution.ok) {
			// 401 gets a WWW-Authenticate header so a spec-compliant client knows
			// how to authenticate rather than just seeing a bare refusal. With
			// OAuth configured that header is the whole discovery entry point.
			if (resolution.status === 401) {
				res.setHeader(
					"WWW-Authenticate",
					oauth ? wwwAuthenticate(oauth) : 'Bearer realm="Hydra DB MCP"',
				);
			}
			res
				.status(resolution.status)
				.json(
					jsonRpcError(
						resolution.status === 401
							? JSONRPC_UNAUTHORIZED
							: JSONRPC_BAD_REQUEST,
						resolution.message,
					),
				);
			return;
		}

		const creds = resolution.credentials;
		try {
			const hydra = new HydraDB({
				token: creds.apiKey,
				database: creds.database,
				collection: creds.collection,
				...(creds.allowedDatabases ? { allowedDatabases: creds.allowedDatabases } : {}),
				...(creds.baseUrl != null ? { baseUrl: creds.baseUrl } : {}),
				...(creds.timeoutSeconds != null
					? { timeoutSeconds: creds.timeoutSeconds }
					: {}),
				...(creds.maxRetries != null ? { maxRetries: creds.maxRetries } : {}),
			});
			const server = createHydraDBServer(hydra, creds.graph, { oauthTools: identity != null });

			// Stateless: this pair serves exactly this request and is discarded when
			// the response closes. Tearing them down on `close` — which fires for a
			// clean end AND for the error path below (it sends a response, which then
			// closes) — is what frees the per-request state; without it a long-lived
			// process leaks a server per call. It is the single teardown point, so
			// nothing here double-closes. `close()` returns a promise, and a stray
			// rejection would take the whole process down via `unhandledRejection`, so
			// it is explicitly swallowed.
			const transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: undefined,
				enableJsonResponse: true,
			});
			res.on("close", () => {
				transport.close().catch(() => {});
				server.close().catch(() => {});
			});

			await server.connect(transport);
			await transport.handleRequest(req, res, req.body);
		} catch (error) {
			logger.error("error handling MCP request", {
				error: error instanceof Error ? error.message : String(error),
			});
			// Do not close here: the `res.on("close")` handler above owns teardown,
			// and the transport may still be mid-write. Only the transport writes the
			// JSON-RPC body, so this responds solely when nothing has been sent yet
			// AND the socket is still open — a client that aborted mid-request lands
			// here too, and writing to its closed socket is pointless. Ending the
			// response then triggers that one teardown.
			if (!res.headersSent && !res.writableEnded) {
				res
					.status(500)
					.json(jsonRpcError(JSONRPC_INTERNAL_ERROR, "Internal server error"));
			}
		}
	});

	// A liveness probe for load balancers and container orchestrators. It says
	// nothing about Hydra DB reachability on purpose — credentials are per
	// request, so there is no single upstream this endpoint could check.
	app.get("/health", (_req, res) => {
		res.json({ status: "ok", service: "hydradb-mcp" });
	});

	// `express.json` throws on a malformed body (`entity.parse.failed`) or one
	// over the limit (`entity.too.large`). Registered after the routes so it
	// catches those, it keeps every refusal on this server speaking JSON-RPC
	// rather than letting Express answer with its default HTML error page. Any
	// other error falls through to Express's default handler unchanged.
	app.use(
		(
			err: Error & { type?: string; status?: number },
			_req: express.Request,
			res: express.Response,
			next: express.NextFunction,
		) => {
			if (err.type === "entity.parse.failed") {
				res
					.status(400)
					.json(jsonRpcError(JSONRPC_BAD_REQUEST, "Request body is not valid JSON"));
				return;
			}
			if (err.type === "entity.too.large") {
				res
					.status(413)
					.json(
						jsonRpcError(
							JSONRPC_BAD_REQUEST,
							`Request body exceeds the ${MAX_REQUEST_BODY} limit`,
						),
					);
				return;
			}
			next(err);
		},
	);

	if (bindAddress === "0.0.0.0" || bindAddress === "::") {
		banner(
			`WARNING: BIND_ADDRESS=${bindAddress} exposes the server on all network interfaces — ` +
				"set ALLOWED_HOSTS/ALLOWED_ORIGINS and put it behind TLS. See SECURITY.md.",
		);
	}
	if (allowsAllOrigins) {
		banner('WARNING: ALLOWED_ORIGINS contains "*" — any website may call this server. See SECURITY.md.');
	}

	return app;
}

/**
 * Wire graceful shutdown for the HTTP server.
 *
 * The in-flight bookkeeping is shared with the stdio path (it is module state in
 * {@link file://./server.js}), so this drains accepted tool calls the same way:
 * stop accepting, close the listener, wait for running handlers, then exit. An
 * ingest cut off mid-write leaves the caller unable to tell whether it
 * committed, which under upsert is not answerable by retrying.
 */
const SHUTDOWN_GRACE_MS = 10_000;

function installLifecycle(httpServer: import("node:http").Server): void {
	let shuttingDown = false;

	const shutdown = async (signal: string) => {
		if (shuttingDown) {
			logger.warn(`${signal} received again — exiting immediately`);
			process.exit(130);
		}
		shuttingDown = true;
		beginShutdown();
		logger.info(`${signal} received — shutting down`);

		const timer = setTimeout(() => {
			logger.warn(
				`in-flight work did not finish within ${SHUTDOWN_GRACE_MS}ms — exiting anyway`,
			);
			process.exit(0);
		}, SHUTDOWN_GRACE_MS);
		timer.unref();

		// Stop accepting new connections, then drain the calls already running.
		httpServer.close();
		const pending = inFlightCount();
		if (pending > 0) {
			logger.info(`waiting for ${pending} in-flight tool call(s)`);
			await awaitInFlight();
		}
		clearTimeout(timer);
		process.exit(0);
	};

	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));

	process.on("unhandledRejection", (reason) => {
		logger.error("unhandled promise rejection", {
			error: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
		});
		process.exit(1);
	});
	process.on("uncaughtException", (error) => {
		logger.error("uncaught exception", { error: error.stack ?? error.message });
		process.exit(1);
	});
}

function main(): void {
	const config = resolveHttpServerConfig();

	// A public bind WITH tenant credentials in the env is the one genuinely
	// dangerous combination: every unauthenticated request would run under that
	// account. It is legitimate for a single-tenant self-host, so this warns
	// rather than refuses — but a multi-tenant operator must see it.
	const publicBind = config.bindAddress === "0.0.0.0" || config.bindAddress === "::";
	if (publicBind && (process.env.HYDRADB_API_KEY || process.env.HYDRA_DB_API_KEY)) {
		banner(
			"WARNING: HYDRADB_API_KEY is set while binding publicly — every request that " +
				"sends no `Authorization` header will run under this account. Unset it for a " +
				"multi-tenant deployment so each caller must authenticate. See SECURITY.md.",
		);
	}

	const app = createHttpApp(config);

	if (config.oauth) {
		banner(
			`OAuth enabled: issuer ${config.oauth.issuer}, resource ${config.oauth.resource} ` +
				`(metadata at ${metadataUrl(config.oauth)})`,
		);
	}

	const httpServer = app
		.listen(config.port, config.bindAddress, () => {
			// Startup banners: on stderr so an operator sees where it bound
			// regardless of HYDRADB_LOG_LEVEL.
			banner(`listening on http://${config.bindAddress}:${config.port}`);
			banner(
				`allowed origins: ${
					config.allowedOrigins.length > 0
						? config.allowedOrigins.join(", ")
						: "(none — cross-origin browser requests will be rejected)"
				}`,
			);
		})
		.on("error", (error) => {
			logger.error("HTTP server error", { error: error.message });
			process.exit(1);
		});

	installLifecycle(httpServer);
}

// Only auto-start when run as a script, so tests can import `createHttpApp`
// without binding a port. Covers `node dist/http.js`, `tsx src/http.ts`, and
// the Docker entrypoint.
const invokedAsScript =
	import.meta.url === `file://${process.argv[1]}` ||
	process.argv[1]?.endsWith("/http.js") ||
	process.argv[1]?.endsWith("/http.ts");

if (invokedAsScript) {
	main();
}

// Re-exported so callers importing the HTTP entry point get the config helpers
// from one place.
export { buildAllowedHosts, parseList, parsePort, resolveHttpServerConfig };
