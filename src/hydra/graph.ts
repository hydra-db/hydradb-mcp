/**
 * The BYOG (Bring Your Own Graph) half of the wrapper.
 *
 * Everything else in this directory delegates to `@hydradb/sdk`. This file
 * cannot: the generated SDK at the pinned 2.1.2 exposes `context`, `databases`,
 * `connectors` and `webhooks` and has no `byog` resource at all, so the
 * `/byog/*` endpoints are unreachable through it.
 *
 * So this is a hand-rolled HTTP path — but it is NOT a second client. It sits
 * behind the same wrapper surface, unwraps the same `HandlerEnvelope` by shape
 * (see ./envelope), and raises the same `HydraWrapperError` with the same
 * message template (see ./errors). A caller cannot tell which of its methods
 * went through the SDK and which did not, which is the property that matters:
 * when the SDK grows a `byog` resource, this file is replaced and nothing above
 * it changes.
 *
 * CONTRACT §2 rule 1 pins the SDK exactly because generated method names churn.
 * That reasoning is unaffected here — there is no generated name to be
 * insulated from yet.
 */

import { HydraWrapperError } from "./errors.js";
import { newRawTransport, type RawTransport, sendRaw } from "./transport.js";

export interface GraphConfig {
	token: string;
	baseUrl?: string;
	timeoutSeconds?: number;
	maxRetries?: number;
}

export interface GraphQueryParams {
	database: string;
	collection: string;
	query: string;
	params?: Record<string, unknown>;
}

export interface GraphScopeParams {
	database: string;
	collection?: string;
}

/** One row of a Cypher result: keys are the RETURN column names. */
export type GraphRow = Record<string, unknown>;

export interface RequestOptions {
	signal?: AbortSignal;
}

/**
 * Status codes worth retrying.
 *
 * 429 and 5xx are documented as transient. 4xx other than 429 are not: a
 * rejected construct, a Cypher error and a bad collection name all fail
 * identically on retry, so retrying them only delays the message.
 */

/**
 * A 2xx whose body is not the shape this endpoint promises.
 *
 * Raised rather than coerced to an empty result. An empty array is a perfectly
 * ordinary answer here — a query that matched nothing, a database with no
 * graphs — so silently substituting one for a malformed response makes a broken
 * integration indistinguishable from a true negative, which is the one case a
 * caller cannot debug. The `path` and a bounded preview of what actually
 * arrived are carried through so the failure is actionable.
 */
function unexpectedShape(path: string, expected: string, got: unknown): HydraWrapperError {
	let preview: string;
	try {
		preview = JSON.stringify(got) ?? String(got);
	} catch {
		preview = String(got);
	}
	if (preview.length > 200) preview = `${preview.slice(0, 200)}…`;
	return new HydraWrapperError(
		`Hydra DB ${path} → ERR: expected ${expected}, got ${preview}. ` +
		"This is a response-shape mismatch, not an empty result.",
		path,
		{ body: got },
	);
}

export class GraphResource {
	private readonly transport: RawTransport;

	constructor(config: GraphConfig) {
		this.transport = newRawTransport(config, { timeoutSeconds: 30, maxRetries: 2 });
	}

	/**
	 * Run Cypher against one collection (`POST /byog/query`).
	 *
	 * Returns the rows verbatim — an array of row objects keyed by the query's
	 * RETURN column names. A write with no RETURN yields `[]`, which is a
	 * success and must not be read as a failure.
	 */
	async query(
		params: GraphQueryParams,
		opts?: RequestOptions,
	): Promise<GraphRow[]> {
		const body = {
			database: params.database,
			collection: params.collection,
			query: params.query,
			...(params.params != null ? { params: params.params } : {}),
		};
		const rows = await this.send<unknown>("/byog/query", "POST", body, opts);
		// `data` is ALWAYS an array on success — verified against the live API,
		// including a write with no RETURN, which yields `[]`. So anything else
		// means the response contract moved, and coercing it to `[]` would
		// present that as a legitimate "no rows matched": the caller would read a
		// broken integration as an empty graph and act on it. Fail loudly instead.
		if (!Array.isArray(rows)) {
			throw unexpectedShape("/byog/query", "an array of row objects", rows);
		}
		// Element-wise, not just the container. `renderRows` calls `Object.keys`
		// on each row, which throws a bare TypeError on `null` and on a string —
		// an unactionable crash inside a tool handler, where the caller sees a
		// stack rather than "the response was not what we expected".
		const bad = rows.findIndex(
			(row) => row == null || typeof row !== "object" || Array.isArray(row),
		);
		if (bad !== -1) {
			throw unexpectedShape(
				"/byog/query",
				`an array of row objects (row ${bad} is not one)`,
				rows[bad],
			);
		}
		return rows as GraphRow[];
	}

	/** Create a graph database (`POST /byog/databases`). Ready immediately. */
	createDatabase(
		database: string,
		opts?: RequestOptions,
	): Promise<{ database?: string; status?: string; cluster?: string }> {
		return this.send("/byog/databases", "POST", { database }, opts);
	}

	/** List the collections in a graph database (`GET /byog/collections`). */
	async listCollections(
		params: GraphScopeParams,
		opts?: RequestOptions,
	): Promise<string[]> {
		const res = await this.send<{ collections?: unknown }>(
			`/byog/collections?database=${encodeURIComponent(params.database)}`,
			"GET",
			undefined,
			opts,
		);
		// Same reasoning as `query`: a missing or non-array `collections` is a
		// contract change, and reporting it as "no collections yet" would send
		// the caller off to create graphs that already exist.
		if (!Array.isArray(res?.collections)) {
			throw unexpectedShape(
				"/byog/collections",
				"an object with a `collections` array",
				res,
			);
		}
		// A non-string element would be rendered as a collection name the caller
		// could then pass back as scope, so it is reported rather than coerced.
		const notAName = res.collections.findIndex((name) => typeof name !== "string");
		if (notAName !== -1) {
			throw unexpectedShape(
				"/byog/collections",
				`an array of collection names (index ${notAName} is not a string)`,
				res.collections[notAName],
			);
		}
		return res.collections as string[];
	}

	/** Drop one collection and all its data (`DELETE /byog/collections`). Idempotent. */
	dropCollection(
		params: { database: string; collection: string },
		opts?: RequestOptions,
	): Promise<Record<string, unknown>> {
		return this.send("/byog/collections", "DELETE", params, opts);
	}

	/**
	 * Drop a graph database (`DELETE /byog/databases`).
	 *
	 * `deleted` is false when the database was created through the standard
	 * database API and merely holds graph collections — in that case only the
	 * collections go. That distinction is reported, not smoothed over.
	 */
	dropDatabase(
		database: string,
		opts?: RequestOptions,
	): Promise<{ deleted?: boolean; deleted_collections?: string[] }> {
		return this.send("/byog/databases", "DELETE", { database }, opts);
	}

	// --- Transport ---

	private send<T>(
		path: string,
		method: "GET" | "POST" | "DELETE",
		body: unknown,
		opts?: RequestOptions,
	): Promise<T> {
		return sendRaw<T>(this.transport, path, method, body, opts);
	}
}
