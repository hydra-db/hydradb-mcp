/**
 * The OAuth 2.1 RESOURCE-SERVER half of MCP authorization (PRO-1790).
 *
 * This server never issues tokens and never talks to the user. It does three
 * things the MCP authorization spec asks of a protected resource:
 *
 *   1. Advertise where its authorization server is, via an RFC 9728 Protected
 *      Resource Metadata document at `/.well-known/oauth-protected-resource`,
 *      and point at that document from every 401 (`WWW-Authenticate`).
 *   2. Recognise an access token the authorization server issued and turn it
 *      into the same {@link RequestCredentials} an API key would produce, by
 *      asking the authorization server what the token stands for (RFC 7662
 *      introspection). The answer carries the API key the dashboard minted on
 *      the user's Approve click, so the tool layer keeps calling Hydra DB
 *      exactly as it does for a key: nothing downstream knows OAuth exists.
 *   3. Refuse a token that was not issued for THIS server (audience binding,
 *      RFC 8707), so a token minted for another resource cannot be replayed
 *      here.
 *
 * All of it is additive and switched on only by configuration: with no
 * `HYDRADB_OAUTH_ISSUER` the server behaves exactly as before.
 */

import { createHash } from "node:crypto";

import { logger } from "./logger.js";

/** Access tokens the dashboard issues carry this prefix; keys carry `sk_`. */
export const ACCESS_TOKEN_PREFIX = "hmat_";

/** The one scope this resource defines. Granularity is PRO-1789's problem. */
export const SCOPE = "hydradb";

export interface OAuthConfig {
	/** The authorization server, e.g. `https://app.hydradb.com`. No trailing slash. */
	issuer: string;
	/** This server's canonical URL as clients know it, e.g. `https://mcp.hydradb.com`. */
	resource: string;
	/** Shared secret presented to the issuer's introspection endpoint. */
	introspectionSecret: string;
	/** Overrides for tests. */
	fetchFn?: typeof fetch;
	now?: () => number;
}

/** Everything an introspected token stands for. Mirrors the dashboard's response. */
export interface IntrospectedToken {
	apiKey: string;
	database?: string;
	collection?: string;
	/**
	 * Databases a per-call `database` argument may name. Absent means any (the
	 * user chose to let the app switch when asked); present means the user
	 * confined the app to exactly these on the consent screen, and this server
	 * is where that promise is kept, because the API key behind the token is
	 * org-wide and the key never leaves this process.
	 */
	allowedDatabases?: string[];
	/**
	 * Collections a per-call `collection` argument may name, on the same terms.
	 * Confinement has to cover both or it means nothing: a caller pinned to one
	 * database could still step sideways into a collection the consent screen
	 * never showed and, through `drop_collection`, delete it.
	 */
	allowedCollections?: string[];
	userId?: string;
	clientId?: string;
	clientName?: string;
	/** Epoch seconds. */
	expiresAt: number;
}

export type IntrospectionResult =
	| { ok: true; token: IntrospectedToken }
	| { ok: false; reason: "invalid_token" | "wrong_audience" | "unavailable"; detail?: string };

function stripSlash(url: string): string {
	return url.replace(/\/+$/, "");
}

/**
 * Read the OAuth configuration, or `null` when the feature is off.
 *
 * All three values are needed: an issuer says where to send clients, a
 * resource says which audience to accept, and the secret is what makes the
 * introspection answer trustworthy. Half a configuration is treated as none,
 * with a startup warning, rather than as a server that advertises an
 * authorization flow it cannot complete.
 */
export function resolveOAuthConfig(
	env: Record<string, string | undefined> = process.env,
	warn: (message: string) => void = (m) => console.error(`[hydradb-mcp] ${m}`),
): OAuthConfig | null {
	const issuer = env.HYDRADB_OAUTH_ISSUER?.trim();
	const resource = env.HYDRADB_MCP_PUBLIC_URL?.trim();
	const introspectionSecret = env.HYDRADB_OAUTH_INTROSPECTION_SECRET?.trim();
	if (!issuer && !resource && !introspectionSecret) return null;
	const missing = [
		!issuer && "HYDRADB_OAUTH_ISSUER",
		!resource && "HYDRADB_MCP_PUBLIC_URL",
		!introspectionSecret && "HYDRADB_OAUTH_INTROSPECTION_SECRET",
	].filter(Boolean);
	if (missing.length > 0) {
		warn(
			`WARNING: OAuth is partially configured (missing ${missing.join(", ")}); ` +
				"it stays OFF until all three are set.",
		);
		return null;
	}
	for (const [name, value] of [
		["HYDRADB_OAUTH_ISSUER", issuer],
		["HYDRADB_MCP_PUBLIC_URL", resource],
	] as const) {
		if (!/^https?:\/\//i.test(value!)) {
			warn(`WARNING: ${name} must be an absolute http(s) URL; OAuth stays OFF.`);
			return null;
		}
	}
	return {
		issuer: stripSlash(issuer!),
		resource: stripSlash(resource!),
		introspectionSecret: introspectionSecret!,
	};
}

/** Where the Protected Resource Metadata document lives for this server. */
export function metadataUrl(config: OAuthConfig, mcpPath = ""): string {
	// RFC 9728 puts the well-known segment BEFORE the resource's path, so a
	// server at /mcp advertises at /.well-known/oauth-protected-resource/mcp.
	return `${config.resource}/.well-known/oauth-protected-resource${mcpPath}`;
}

/** The RFC 9728 document itself. */
export function protectedResourceMetadata(config: OAuthConfig): Record<string, unknown> {
	return {
		resource: config.resource,
		authorization_servers: [config.issuer],
		scopes_supported: [SCOPE],
		bearer_methods_supported: ["header"],
		resource_name: "Hydra DB MCP",
		resource_documentation: "https://docs.hydradb.com/mcp",
	};
}

/**
 * The `WWW-Authenticate` value for a 401.
 *
 * `resource_metadata` is how a client that arrived with nothing learns where
 * to log in (the MCP spec's first discovery step), and `scope` tells it what
 * to ask for. `error` is included only when a token was PRESENTED and refused,
 * so an anonymous first contact reads as "authenticate" rather than "your
 * token is bad".
 */
export function wwwAuthenticate(
	config: OAuthConfig,
	error?: "invalid_token" | "insufficient_scope",
	description?: string,
): string {
	const parts = [`Bearer realm="Hydra DB MCP"`];
	if (error) parts.push(`error="${error}"`);
	if (description) parts.push(`error_description="${description.replace(/"/g, "'")}"`);
	parts.push(`resource_metadata="${metadataUrl(config)}"`);
	parts.push(`scope="${SCOPE}"`);
	return parts.join(", ");
}

/** Whether a bearer value is one of OUR access tokens rather than an API key. */
export function isAccessToken(bearer: string | undefined): bearer is string {
	return typeof bearer === "string" && bearer.startsWith(ACCESS_TOKEN_PREFIX);
}

// --- Introspection, with a bounded memo ---

/**
 * Introspection answers are memoised per token so the hosted server, which
 * builds a client per request, does not ask the dashboard on every tool call.
 * Only successes are cached, for the shorter of the token's own expiry and
 * this ceiling. The ceiling IS the revocation lag: measured end to end, a
 * disconnect or a refresh-token reuse detection reaches this server exactly
 * one ceiling later. Thirty seconds keeps an agent's burst of tool calls at
 * one hop while keeping that lag short enough that a revoked token cannot do
 * much with it.
 */
const INTROSPECTION_CACHE_TTL_MS = 30_000;
const INTROSPECTION_CACHE_MAX = 5_000;
const INTROSPECTION_TIMEOUT_MS = 5_000;

interface CacheEntry {
	token: IntrospectedToken;
	expires: number;
}
const cache = new Map<string, CacheEntry>();

/** Test-only. */
export function __resetIntrospectionCache(): void {
	cache.clear();
}

function cacheKey(token: string): string {
	// Never keep the raw token as a Map key: it would sit in memory in the
	// clear for as long as the entry lives.
	return createHash("sha256").update(token).digest("hex");
}

/**
 * Ask the issuer what a token stands for.
 *
 * The response shape is the contract in PRO-1790: `active`, `aud`, `exp`,
 * `api_key`, `database`, `collection`, `sub`, `client_id`, `client_name`.
 * Audience is checked HERE, not trusted from the issuer's say-so: the issuer
 * may legitimately serve several resources, and this server must only honour
 * tokens minted for itself.
 */
export async function introspect(
	config: OAuthConfig,
	token: string,
): Promise<IntrospectionResult> {
	const now = config.now ?? Date.now;
	const key = cacheKey(token);
	const hit = cache.get(key);
	if (hit && hit.expires > now()) return { ok: true, token: hit.token };
	if (hit) cache.delete(key);

	const fetchFn = config.fetchFn ?? fetch;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), INTROSPECTION_TIMEOUT_MS);
	let body: Record<string, unknown>;
	try {
		const res = await fetchFn(`${config.issuer}/api/oauth/introspect`, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Accept: "application/json",
				Authorization: `Bearer ${config.introspectionSecret}`,
			},
			body: new URLSearchParams({ token }).toString(),
			signal: controller.signal,
		});
		if (res.status === 401 || res.status === 403) {
			// Our secret was refused. That is an operator problem, not the
			// caller's, and it must not read as "your token is invalid".
			logger.error("introspection refused: HYDRADB_OAUTH_INTROSPECTION_SECRET is not accepted by the issuer");
			return { ok: false, reason: "unavailable", detail: "introspection refused" };
		}
		if (!res.ok) {
			return { ok: false, reason: "unavailable", detail: `introspection HTTP ${res.status}` };
		}
		body = (await res.json()) as Record<string, unknown>;
	} catch (err) {
		return {
			ok: false,
			reason: "unavailable",
			detail: err instanceof Error ? err.message : String(err),
		};
	} finally {
		clearTimeout(timer);
	}

	if (body.active !== true) return { ok: false, reason: "invalid_token" };

	const aud = body.aud;
	const audiences = Array.isArray(aud) ? aud : typeof aud === "string" ? [aud] : [];
	if (!audiences.some((a) => typeof a === "string" && stripSlash(a) === config.resource)) {
		return { ok: false, reason: "wrong_audience" };
	}

	const apiKey = typeof body.api_key === "string" ? body.api_key : "";
	const exp = typeof body.exp === "number" ? body.exp : 0;
	if (!apiKey || exp <= Math.floor(now() / 1000)) {
		return { ok: false, reason: "invalid_token" };
	}

	const stringList = (v: unknown): string[] | undefined =>
		Array.isArray(v)
			? v.filter((d): d is string => typeof d === "string" && d.length > 0)
			: undefined;
	const allowed = stringList(body.databases);
	const allowedCols = stringList(body.collections);
	const resolved: IntrospectedToken = {
		apiKey,
		...(allowed ? { allowedDatabases: allowed } : {}),
		...(allowedCols ? { allowedCollections: allowedCols } : {}),
		database: typeof body.database === "string" && body.database ? body.database : undefined,
		collection:
			typeof body.collection === "string" && body.collection ? body.collection : undefined,
		userId: typeof body.sub === "string" ? body.sub : undefined,
		clientId: typeof body.client_id === "string" ? body.client_id : undefined,
		clientName: typeof body.client_name === "string" ? body.client_name : undefined,
		expiresAt: exp,
	};

	if (cache.size >= INTROSPECTION_CACHE_MAX) {
		const oldest = cache.keys().next().value;
		if (oldest != null) cache.delete(oldest);
	}
	cache.set(key, {
		token: resolved,
		expires: Math.min(now() + INTROSPECTION_CACHE_TTL_MS, exp * 1000),
	});
	return { ok: true, token: resolved };
}
