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
}

export type EnvSource = Record<string, string | undefined>;
export type WarnFn = (message: string) => void;

const DEFAULT_COLLECTION = "hydra-db-mcp";

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

	return { apiKey, database, collection, baseUrl };
}
