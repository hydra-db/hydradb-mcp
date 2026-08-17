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
	timeoutSeconds?: number;
	maxRetries?: number;
	graph: GraphConfig;
}

/**
 * Scope and gating for the BYOG graph tools.
 *
 * A graph database is a DIFFERENT namespace from the memory database: the same
 * name can exist as both, and a Cypher query aimed at the wrong one silently
 * reads an empty graph rather than failing. So the graph scope is configured
 * separately, and every graph tool also takes a per-call override.
 */
export interface GraphConfig {
	/** Whether the graph tools are registered at all. */
	enabled: boolean;
	/** Refuse to register the mutating tools, mirroring Neo4j's read-only mode. */
	readOnly: boolean;
	/**
	 * Default graph database. Falls back to HYDRADB_DATABASE — convenient when
	 * one name is used for both, and harmless otherwise because the tools accept
	 * `database` per call.
	 */
	database: string;
	/** Default graph collection. */
	collection: string;
}

const DEFAULT_GRAPH_COLLECTION = "default";

/**
 * Env flags are read permissively in one direction only.
 *
 * A user who writes `HYDRADB_GRAPH_READONLY=true` meaning "on" must not get
 * "off" because only `1` was accepted — the failure mode is a server that
 * accepts writes when its operator believed it would not.
 */
function flag(raw: string | undefined, fallback: boolean): boolean {
	if (raw == null || raw.trim() === "") return fallback;
	const value = raw.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(value)) return true;
	if (["0", "false", "no", "off"].includes(value)) return false;
	return fallback;
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

	// Included only when actually set, so the resolved config says what the
	// environment said rather than carrying a row of undefined knobs.
	const timeoutSeconds = positiveInt(env.HYDRADB_TIMEOUT_SECONDS);
	const maxRetries = nonNegativeInt(env.HYDRADB_MAX_RETRIES);

	return {
		apiKey,
		database,
		collection,
		baseUrl,
		...(timeoutSeconds != null ? { timeoutSeconds } : {}),
		...(maxRetries != null ? { maxRetries } : {}),
		graph: resolveGraphConfig(env, database),
	};
}

/**
 * Graph scope and gating, resolved on its own.
 *
 * Separate from `resolveConfig` because it must be resolvable WITHOUT an API key
 * or a memory database: tests construct a server around an injected client and
 * never set those, and making the graph tools depend on them would mean the
 * graph surface could not be exercised without a full credential set.
 */
export function resolveGraphConfig(
	env: EnvSource = process.env,
	fallbackDatabase = "",
): GraphConfig {
	return {
		enabled: flag(env.HYDRADB_MCP_GRAPH_TOOLS, true),
		readOnly: flag(env.HYDRADB_GRAPH_READONLY, false),
		// Not `readEnv` — these are new names with no legacy spelling to alias,
		// and inventing a deprecated one would be noise.
		database: env.HYDRADB_GRAPH_DATABASE?.trim() || fallbackDatabase,
		collection: env.HYDRADB_GRAPH_COLLECTION?.trim() || DEFAULT_GRAPH_COLLECTION,
	};
}

/**
 * Numeric overrides are ignored rather than fatal when malformed.
 *
 * A typo'd timeout should not stop the server from starting — falling back to
 * the built-in default keeps it running, and the alternative (exit 1 on a
 * cosmetic env var) is worse than the misconfiguration.
 */
function positiveInt(raw: string | undefined): number | undefined {
	const value = Number(raw);
	return raw != null && Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeInt(raw: string | undefined): number | undefined {
	const value = Number(raw);
	return raw != null && Number.isInteger(value) && value >= 0 ? value : undefined;
}
