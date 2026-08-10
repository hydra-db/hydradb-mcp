/**
 * Server configuration from the environment.
 *
 * Adopts the canonical `HYDRADB_*` names (CONTRACT §1) as PRIMARY, while still
 * honouring the legacy `HYDRA_DB_*` names as deprecated aliases so existing
 * setups keep working. The canonical name wins when both are set; using a
 * deprecated alias emits exactly one stderr warning per process naming the
 * canonical replacement.
 */

export interface HydraDBConfig {
	apiKey: string;
	database: string;
	collection: string;
	baseUrl?: string;
	timeoutSeconds: number;
	maxRetries: number;
}

export type EnvSource = Record<string, string | undefined>;
export type WarnFn = (message: string) => void;

const DEFAULT_COLLECTION = "hydra-db-mcp";

/**
 * Request latency budget handed to the SDK.
 *
 * The SDK applies its own per-attempt deadline (60s) and retry count (2) when
 * the caller supplies neither, so an unconfigured call can occupy ~180s plus
 * backoff — longer than the request timeout of the MCP clients waiting on it,
 * which turns a slow upstream into a tool call nobody is still listening for.
 * Choosing the deadline here caps the worst case near 90s and makes the budget
 * an operator-visible number rather than an inherited one.
 */
const DEFAULT_TIMEOUT_SECONDS = 30;
const DEFAULT_MAX_RETRIES = 2;

// Process-lifetime dedupe so each deprecated alias warns at most once.
const warnedOnce = new Set<string>();
function defaultWarn(message: string): void {
	console.error(message);
}
function warnOnce(message: string, warn: WarnFn): void {
	if (warnedOnce.has(message)) return;
	warnedOnce.add(message);
	warn(message);
}

/**
 * Read a canonical `HYDRADB_*` variable, falling back to the legacy `HYDRA_DB_*`
 * spelling with a once-per-process warning. Exported so every variable this
 * server reads goes through the same rule - `HYDRADB_LOG_LEVEL` is resolved by
 * the logger, which owns its own module state but must not invent a second
 * deprecation policy.
 */
export function readEnv(
	env: EnvSource,
	canonical: string,
	deprecated: string,
	warn: WarnFn = defaultWarn,
): string | undefined {
	const canonicalValue = env[canonical];
	if (canonicalValue != null && canonicalValue !== "") {
		return canonicalValue;
	}
	const deprecatedValue = env[deprecated];
	if (deprecatedValue != null && deprecatedValue !== "") {
		warnOnce(
			`[hydradb-mcp] Environment variable ${deprecated} is deprecated; use ${canonical} instead.`,
			warn,
		);
		return deprecatedValue;
	}
	return undefined;
}

/**
 * Read an optional integer variable. Canonical-only: these knobs are new, so
 * there is no legacy spelling for `readEnv`'s alias rule to resolve.
 *
 * A malformed value throws rather than falling back to the default — a timeout
 * silently reverting to 30s because it was typed as "30s" is exactly the kind
 * of misconfiguration that only shows up as latency in production.
 */
function readInt(
	env: EnvSource,
	name: string,
	fallback: number,
	min: number,
): number {
	const raw = env[name];
	if (raw == null || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < min) {
		throw new Error(`${name} must be an integer >= ${min}; got "${raw}"`);
	}
	return value;
}

export function resolveConfig(
	env: EnvSource = process.env,
	warn: WarnFn = defaultWarn,
): HydraDBConfig {
	const apiKey = readEnv(env, "HYDRADB_API_KEY", "HYDRA_DB_API_KEY", warn);
	if (!apiKey) {
		throw new Error(
			"HYDRADB_API_KEY (or its deprecated alias HYDRA_DB_API_KEY) environment variable is required",
		);
	}

	const database = readEnv(env, "HYDRADB_DATABASE", "HYDRA_DB_TENANT_ID", warn);
	if (!database) {
		throw new Error(
			"HYDRADB_DATABASE (or its deprecated alias HYDRA_DB_TENANT_ID) environment variable is required",
		);
	}

	const collection =
		readEnv(env, "HYDRADB_COLLECTION", "HYDRA_DB_SUB_TENANT_ID", warn) ??
		DEFAULT_COLLECTION;

	const baseUrl = readEnv(env, "HYDRADB_BASE_URL", "HYDRA_DB_BASE_URL", warn);

	const timeoutSeconds = readInt(
		env,
		"HYDRADB_TIMEOUT_SECONDS",
		DEFAULT_TIMEOUT_SECONDS,
		1,
	);
	const maxRetries = readInt(env, "HYDRADB_MAX_RETRIES", DEFAULT_MAX_RETRIES, 0);

	return { apiKey, database, collection, baseUrl, timeoutSeconds, maxRetries };
}
