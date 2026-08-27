/**
 * Configuration for the remotely hostable HTTP transport.
 *
 * There are two configurations here, and they belong to two different people.
 *
 *   - {@link resolveHttpServerConfig} is the OPERATOR's config: the port, the
 *     bind address, and the Host/Origin allowlists that decide who may reach the
 *     process at all. It is read once at startup from the environment.
 *
 *   - {@link resolveRequestCredentials} is the CALLER's config: which Hydra DB
 *     account, database and collection a single request runs against. On a
 *     multi-tenant deployment (one process serving `mcp.hydradb.com` for many
 *     users) this MUST come per request, from headers, because the process has
 *     no single tenant of its own. It is resolved fresh on every `/mcp` call.
 *
 * The stdio server ({@link file://./index.ts}) has only the second concern and
 * reads it from the environment via {@link file://./config.ts}; a hosted server
 * cannot, because one env-configured key would make every user share one
 * account. So the header path is the substantive new surface, and it falls back
 * to the environment only to keep the single-tenant self-hosting story (set the
 * env, expose the port, done) working unchanged.
 */

import {
	DEFAULT_COLLECTION,
	type EnvSource,
	type GraphConfig,
	nonNegativeInt,
	positiveInt,
	readEnv,
	resolveGraphConfig,
} from "./config.js";

// --- Operator config (read once at startup) ---

export interface HttpServerConfig {
	/** TCP port to listen on. */
	port: number;
	/**
	 * Interface to bind. Defaults to loopback so an unconfigured server is not
	 * reachable off-box; a hosted deployment sets `0.0.0.0` deliberately.
	 */
	bindAddress: string;
	/** CORS allowlist. Empty means no cross-origin browser request is accepted. */
	allowedOrigins: string[];
	/** Accepted `Host` headers, lowercased. Loopback + the configured port always. */
	allowedHosts: Set<string>;
	/**
	 * Express's `trust proxy` setting. `false` (the default) trusts no
	 * `X-Forwarded-*`, so a direct client cannot spoof its address in the logs;
	 * a deployment behind a known proxy sets `TRUST_PROXY` to a hop count or a
	 * subnet preset so the real client IP is recovered without trusting all hops.
	 */
	trustProxy: boolean | number | string;
}

export const DEFAULT_PORT = 8080;
export const DEFAULT_BIND_ADDRESS = "127.0.0.1";

/** Split a comma-separated env var into trimmed, non-empty entries. */
export function parseList(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(",")
		.map((v) => v.trim())
		.filter((v) => v.length > 0);
}

/**
 * A port, or the default when the value is absent or not a usable port.
 *
 * A typo'd `PORT` should not crash startup with a stack trace; it should fall
 * back and let the startup banner show what it actually bound. Ports outside
 * 1-65535 fall back for the same reason `parseInt("8080abc")` must not become
 * `8080` silently — `Number` rejects the trailing garbage that `parseInt` keeps.
 */
export function parsePort(raw: string | undefined, fallback = DEFAULT_PORT): number {
	const value = Number(raw);
	return raw != null && Number.isInteger(value) && value >= 1 && value <= 65_535
		? value
		: fallback;
}

/**
 * The set of `Host` headers this server answers to.
 *
 * Loopback names on the bound port are always included so a local run works with
 * no configuration. A hosted deployment adds its public hostname(s) via
 * `ALLOWED_HOSTS`. The bare (portless) loopback names cover clients that omit
 * the port on the default HTTP/HTTPS port.
 */
export function buildAllowedHosts(port: number, extra: string[]): Set<string> {
	return new Set<string>(
		[
			`localhost:${port}`,
			`127.0.0.1:${port}`,
			`[::1]:${port}`,
			"localhost",
			"127.0.0.1",
			"[::1]",
			...extra,
		].map((h) => h.toLowerCase()),
	);
}

/**
 * Interpret `TRUST_PROXY` for Express's `trust proxy` setting.
 *
 * Absent → `false` (trust nothing, the safe default). `true`/`false` → boolean.
 * An integer → that many hops. Anything else is passed through as an Express
 * preset or subnet list (e.g. `loopback`, `10.0.0.0/8`), so an operator can name
 * exactly their proxy without this needing to know the syntax.
 */
export function parseTrustProxy(raw: string | undefined): boolean | number | string {
	const value = raw?.trim();
	if (!value) return false;
	if (value.toLowerCase() === "true") return true;
	if (value.toLowerCase() === "false") return false;
	if (/^\d+$/.test(value)) return Number(value);
	return value;
}

export function resolveHttpServerConfig(env: EnvSource = process.env): HttpServerConfig {
	const port = parsePort(env.PORT);
	return {
		port,
		bindAddress: env.BIND_ADDRESS?.trim() || DEFAULT_BIND_ADDRESS,
		allowedOrigins: parseList(env.ALLOWED_ORIGINS),
		allowedHosts: buildAllowedHosts(port, parseList(env.ALLOWED_HOSTS)),
		trustProxy: parseTrustProxy(env.TRUST_PROXY),
	};
}

// --- Per-request tenant credentials ---

/**
 * Header names a caller uses to select and authenticate against their tenant.
 *
 * Lowercased because Node lowercases incoming header names, and every lookup
 * here goes through {@link headerValue} which reads them off `req.headers`.
 *
 * The API key is read from the standard `Authorization: Bearer <key>` first;
 * `X-HydraDB-Api-Key` exists only for clients whose MCP config cannot set an
 * `Authorization` header. Everything else — which database, which collection —
 * has no standard header, so it takes an `X-HydraDB-*` one.
 */
export const HEADER_AUTHORIZATION = "authorization";
export const HEADER_API_KEY = "x-hydradb-api-key";
export const HEADER_DATABASE = "x-hydradb-database";
export const HEADER_COLLECTION = "x-hydradb-collection";
export const HEADER_GRAPH_DATABASE = "x-hydradb-graph-database";
export const HEADER_GRAPH_COLLECTION = "x-hydradb-graph-collection";

/** The request headers this resolver reads. Matches Node's `IncomingHttpHeaders`. */
export type RequestHeaders = Record<string, string | string[] | undefined>;

/**
 * Everything needed to construct a scoped {@link HydraDB} for one request.
 *
 * `baseUrl`, `timeoutSeconds` and `maxRetries` are deliberately absent from the
 * header surface: they are OPERATOR knobs read from the environment, not caller
 * ones. Letting a caller set `baseUrl` per request would point this server's
 * outbound calls at a host of the caller's choosing, which is a request-forgery
 * primitive the tenant selection has no reason to hand out.
 */
export interface RequestCredentials {
	apiKey: string;
	/**
	 * Absent when nothing named one. The client then resolves the account's
	 * default on first use (one database → it; none → `default` is created;
	 * several → the call is told to choose). Not a refusal any more: the old
	 * 400 made the hosted server unusable from clients that can send only an
	 * `Authorization` header, which is most of them.
	 */
	database?: string;
	collection: string;
	baseUrl?: string;
	timeoutSeconds?: number;
	maxRetries?: number;
	graph: GraphConfig;
}

/**
 * Scope carried in the URL path rather than in headers.
 *
 * A connection link (`/c/<api-key>/<database>[/<collection>]`) is how a user
 * who can paste exactly one thing into their client authenticates: Claude
 * Desktop and claude.ai accept a URL and nothing else. `/<database>[/<collection>]`
 * without a key scopes a header-authenticated request the same way. Anything
 * here beats the equivalent header, because the URL is the more deliberate
 * choice — it was minted for this exact client.
 */
export interface PathScope {
	apiKey?: string;
	database?: string;
	collection?: string;
}

/**
 * Resolution is either credentials or the exact HTTP failure to return.
 *
 * The status and message are carried out rather than thrown so the caller can
 * answer with a JSON-RPC error body at the right code — 401 when nothing
 * authenticated the request — instead of a generic 500 that tells the client
 * nothing about what to fix.
 */
export type CredentialResolution =
	| { ok: true; credentials: RequestCredentials }
	| { ok: false; status: number; message: string };

/** One header value, taking the first when a header arrives repeated. */
function headerValue(headers: RequestHeaders, name: string): string | undefined {
	const raw = headers[name];
	const value = Array.isArray(raw) ? raw[0] : raw;
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

/**
 * The token from an `Authorization` header, accepting `Bearer <token>` or a bare
 * token. The scheme is matched case-insensitively (RFC 7235 says it is
 * case-insensitive, and clients send `bearer`, `Bearer` and `BEARER` in the
 * wild); a bare value is accepted because some MCP hosts drop the scheme.
 */
function bearerToken(authorization: string | undefined): string | undefined {
	if (!authorization) return undefined;
	const match = /^\s*Bearer\s+(.+)$/i.exec(authorization);
	if (match) return match[1].trim() || undefined;
	return authorization.trim() || undefined;
}

/**
 * Turn one request's headers (falling back to the environment) into the tenant
 * credentials for that request.
 *
 * The API key and the database resolve TOGETHER, not field-by-field, which is
 * the security-relevant part:
 *   - When the key comes from a request header, the request is
 *     "caller-authenticated" and its database MUST also come from a header. The
 *     env is NOT consulted for the database, so a caller who sends their own key
 *     but omits `X-HydraDB-Database` is refused (400) rather than silently run
 *     against the operator's env database. Likewise the graph scope defaults to
 *     the request's own database, never the operator's `HYDRADB_GRAPH_DATABASE`.
 *   - When there is no key header, the request is unauthenticated and falls back
 *     entirely to the operator's env credentials — the single-tenant self-host
 *     case, identical to the stdio server. A hosted, multi-tenant process sets
 *     no tenant env, so such a request is refused (401).
 *
 * Resolving field-by-field instead would let a caller's key pair with the
 * operator's database (or graph namespace), mixing two identities into one
 * request. `baseUrl`/`timeoutSeconds`/`maxRetries` are read from the environment
 * only — they are the operator's, not the caller's (see {@link RequestCredentials}).
 */
export function resolveRequestCredentials(
	headers: RequestHeaders,
	env: EnvSource = process.env,
	path: PathScope = {},
): CredentialResolution {
	const headerKey =
		path.apiKey?.trim() ||
		bearerToken(headerValue(headers, HEADER_AUTHORIZATION)) ||
		headerValue(headers, HEADER_API_KEY);
	// Whether the CALLER authenticated this request with their own key decides
	// whether the operator's env is allowed to supply the rest of the identity.
	const callerAuthenticated = headerKey != null;

	const apiKey =
		// The env fallback reuses the exact same canonical/legacy alias rules as
		// the stdio server, so a self-host configured for stdio needs no new vars.
		headerKey ?? readEnv(env, "HYDRADB_API_KEY", "HYDRA_DB_API_KEY", noopWarn);
	if (!apiKey) {
		return {
			ok: false,
			status: 401,
			message:
				"Missing Hydra DB credentials. Send `Authorization: Bearer <api-key>` " +
				"(or the `X-HydraDB-Api-Key` header). Get a key at https://app.hydradb.com.",
		};
	}

	const namedDatabase =
		path.database?.trim() || headerValue(headers, HEADER_DATABASE);
	// A caller-authenticated request takes its database ONLY from the request;
	// the env database belongs to the operator's identity, not the caller's.
	// Naming none is fine: the client resolves the account's default on first
	// use (see RequestCredentials.database).
	const database = callerAuthenticated
		? namedDatabase
		: (namedDatabase ??
			readEnv(env, "HYDRADB_DATABASE", "HYDRA_DB_TENANT_ID", noopWarn) ??
			undefined);

	// Collection is a partition WITHIN the resolved database, not a cross-tenant
	// boundary, so an env default is safe for either mode.
	const collection =
		path.collection?.trim() ||
		headerValue(headers, HEADER_COLLECTION) ||
		readEnv(env, "HYDRADB_COLLECTION", "HYDRA_DB_SUB_TENANT_ID", noopWarn) ||
		DEFAULT_COLLECTION;

	// Operator-owned transport knobs. Same env vars, same parsing as resolveConfig.
	const baseUrl = readEnv(env, "HYDRADB_BASE_URL", "HYDRA_DB_BASE_URL", noopWarn);
	const timeoutSeconds = positiveInt(env.HYDRADB_TIMEOUT_SECONDS);
	const maxRetries = nonNegativeInt(env.HYDRADB_MAX_RETRIES);

	return {
		ok: true,
		credentials: {
			apiKey,
			...(database ? { database } : {}),
			collection,
			...(baseUrl != null ? { baseUrl } : {}),
			...(timeoutSeconds != null ? { timeoutSeconds } : {}),
			...(maxRetries != null ? { maxRetries } : {}),
			graph: resolveRequestGraphConfig(headers, env, database ?? "", callerAuthenticated),
		},
	};
}

/**
 * Graph scope for one request: the operator's `enabled` flag, but the caller's
 * database and collection.
 *
 * The graph database defaults to the request's OWN database, so a caller that
 * names only `X-HydraDB-Database` gets a coherent graph scope without a second
 * header. When the request named no database at all this is empty, and the
 * graph tools fall back to the memory client's resolved default at call time. The operator's `HYDRADB_GRAPH_DATABASE` is honoured as that default
 * ONLY for an unauthenticated (env-credential) request — for a caller-
 * authenticated one it would pin every tenant to the operator's single graph
 * namespace, the mixing this resolver exists to prevent. Header overrides always
 * win, letting a caller address a graph in a different namespace than their
 * memory database — which, because the two are genuinely separate stores, is a
 * real need.
 */
function resolveRequestGraphConfig(
	headers: RequestHeaders,
	env: EnvSource,
	database: string,
	callerAuthenticated: boolean,
): GraphConfig {
	// For a caller-authenticated request the fallback database is the request's
	// own, so `resolveGraphConfig`'s env default is deliberately not consulted.
	const base = resolveGraphConfig(env, database);
	const defaultDatabase = callerAuthenticated ? database : base.database;
	return {
		enabled: base.enabled,
		database: headerValue(headers, HEADER_GRAPH_DATABASE) ?? defaultDatabase,
		collection: headerValue(headers, HEADER_GRAPH_COLLECTION) ?? base.collection,
	};
}

/**
 * Credential resolution must not emit deprecation warnings.
 *
 * `readEnv` warns once per process when a legacy alias is used. On the header
 * path the env is only a fallback and is read on EVERY request; routing its
 * warning through the process-wide dedupe would still fire on the first request
 * and, worse, tie a per-request code path to shared mutable warning state. The
 * stdio/startup path already surfaces any legacy-alias warning, so silence here
 * drops nothing.
 */
function noopWarn(): void {}

/** A JSON-RPC error body, so every HTTP failure speaks the protocol's dialect. */
export function jsonRpcError(code: number, message: string): {
	jsonrpc: "2.0";
	error: { code: number; message: string };
	id: null;
} {
	return { jsonrpc: "2.0", error: { code, message }, id: null };
}
