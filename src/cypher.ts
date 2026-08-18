/**
 * Cypher analysis and result rendering for the BYOG (Bring Your Own Graph)
 * tools.
 *
 * This file owns two things that have nothing to do with transport, so they can
 * be tested without a network:
 *
 *   - deciding whether a query WRITES, which backs the opt-in read-only mode;
 *   - turning the server's row objects back into something readable.
 */

/**
 * Clauses that mutate the graph.
 *
 * `ADD` is not here even though Neo4j's own `_is_write_query` lists it: it is
 * not a Cypher write clause, only part of `SET n:Label` / `ADD CONSTRAINT`,
 * both of which are already caught by a real member of this list. Including it
 * would reject `MATCH (n) WHERE n.tag = 'add' ...` for no reason.
 *
 * `CREATE INDEX` / `DROP INDEX` count as writes: they are schema changes, they
 * are billed against the 30s write budget, and a read-only caller should not be
 * issuing them.
 */
const WRITE_CLAUSES = [
	"CREATE",
	"MERGE",
	"SET",
	"DELETE",
	"DETACH",
	"REMOVE",
	"DROP",
	"FOREACH",
	"LOAD",
] as const;

/**
 * Everything that is not executable Cypher, blanked out.
 *
 * This is the whole reason the detector is not a substring scan. Neo4j's MCP
 * checks `any(keyword in query.upper() for keyword in [...])`, so
 *
 *     MATCH (p:Person) WHERE p.name = "CREATE something" RETURN p.name
 *
 * is classified as a write and refused by its read tool — a query that HydraDB
 * accepts and that mutates nothing. The same happens for a comment mentioning a
 * write, and for a property literally named `` `delete` ``.
 *
 * Replacing with spaces rather than deleting keeps every offset stable, so a
 * keyword sitting against a stripped region cannot be fused with its neighbour
 * into a different token.
 *
 * Handled: single-quoted and double-quoted strings (with backslash escapes),
 * backtick-quoted identifiers, `//` line comments and block comments.
 */
export function stripNonCode(query: string): string {
	let out = "";
	let i = 0;

	while (i < query.length) {
		const ch = query[i];
		const next = query[i + 1];

		// Line comment — runs to the newline, which is preserved.
		if (ch === "/" && next === "/") {
			while (i < query.length && query[i] !== "\n") {
				out += " ";
				i++;
			}
			continue;
		}

		// Block comment — unterminated ones blank the rest, which is correct:
		// the server will reject the query anyway, and everything after an
		// unclosed opener is a comment as far as any reader is concerned.
		if (ch === "/" && next === "*") {
			out += "  ";
			i += 2;
			while (i < query.length && !(query[i] === "*" && query[i + 1] === "/")) {
				out += query[i] === "\n" ? "\n" : " ";
				i++;
			}
			if (i < query.length) {
				out += "  ";
				i += 2;
			}
			continue;
		}

		// Quoted region: string literal or backticked identifier.
		if (ch === "'" || ch === '"' || ch === "`") {
			const quote = ch;
			out += " ";
			i++;
			while (i < query.length) {
				// Backslash escape. Backticked identifiers escape by doubling
				// rather than with backslashes, but consuming the pair here is
				// still safe — a backslash inside one is an ordinary character
				// and the character after it cannot be the closing backtick
				// without the identifier being malformed anyway.
				if (query[i] === "\\" && quote !== "`") {
					out += i + 1 < query.length ? "  " : " ";
					i += 2;
					continue;
				}
				if (query[i] === quote) {
					// Doubled quote is an escaped quote, not a terminator.
					if (query[i + 1] === quote) {
						out += "  ";
						i += 2;
						continue;
					}
					out += " ";
					i++;
					break;
				}
				out += query[i] === "\n" ? "\n" : " ";
				i++;
			}
			continue;
		}

		out += ch;
		i++;
	}

	return out;
}

/** The write clauses a query actually uses, in the order they appear. */
export function writeClausesIn(query: string): string[] {
	const code = stripNonCode(query).toUpperCase();
	const found: string[] = [];
	for (const clause of WRITE_CLAUSES) {
		// `\b` on both sides so SET does not match `OFFSET`, and CREATE does not
		// match a variable called `createdAt`.
		if (new RegExp(`\\b${clause}\\b`).test(code)) found.push(clause);
	}
	return found;
}

/**
 * Whether this query mutates the graph.
 *
 * This is NOT used to route between tools — there is one Cypher tool, and it
 * runs whatever it is given. It backs only the opt-in `HYDRADB_GRAPH_READONLY`
 * mode, where the sole consequence of a wrong answer is a refused query.
 *
 * That asymmetry is deliberate. The detector is conservative in one direction:
 * it may call a read a write (cost: an operator-configured server declines a
 * query it could have run), never a write a read. Nothing else depends on it.
 */
export function isWriteQuery(query: string): boolean {
	return writeClausesIn(query).length > 0;
}

/**
 * Constructs HydraDB refuses BEFORE running anything, so the request fails with
 * a 400 and nothing executes.
 *
 * Caught locally so the caller gets the reason and the alternative in one step
 * instead of a remote validation error they have to interpret. Retrying either
 * of these unchanged fails identically, so a fast, specific local failure is
 * strictly better than a slow, generic remote one.
 */
export function unsupportedConstruct(query: string): string | undefined {
	const code = stripNonCode(query);

	// `CALL { ... }` subqueries ARE supported; `CALL some.procedure(...)` is not.
	// The distinction is the token after CALL, so look at that rather than at
	// the bare keyword.
	const call = /\bCALL\s*(\{)?/i.exec(code);
	if (call && call[1] == null) {
		return (
			"HydraDB rejects procedure calls (`CALL db.*`, `CALL apoc.*`) before running " +
			"them. `CALL { ... }` subqueries are supported."
		);
	}

	if (/\bLOAD\s+CSV\b/i.test(code)) {
		return (
			"HydraDB rejects `LOAD CSV` — it does not load files or URLs server-side. " +
			"Send the rows through `params` instead, e.g. " +
			"`UNWIND $rows AS row MERGE (n:Thing {id: row.id}) SET n += row`."
		);
	}

	return undefined;
}

/**
 * The documented request-body ceiling for `POST /byog/query`.
 *
 * Enforced before the request goes out. The server answers an oversize body
 * with 413 — but only after the whole thing has been uploaded, which on a bulk
 * load is the slowest possible way to learn the batch was too big.
 */
export const MAX_BODY_BYTES = 256 * 1024;

/** Collection names the server accepts. Rejecting locally names the rule. */
export const COLLECTION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

// --- Result rendering ---

/**
 * The renderer-added keys on a returned node or relationship.
 *
 * These are added by HydraDB's renderer, not stored by the user, so they are
 * separated from the real properties when rendering. A stored property with one
 * of these names is shadowed in the response — which is worth knowing but is
 * the server's behaviour, not something this file can fix.
 */
const NODE_KEYS = ["id", "labels"] as const;
const REL_KEYS = ["id", "relation", "source_node_id", "target_node_id"] as const;

type Row = Record<string, unknown>;

function isRecord(value: unknown): value is Row {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

function isNode(value: unknown): value is Row {
	return isRecord(value) && "labels" in value && "id" in value;
}

function isRelationship(value: unknown): value is Row {
	return isRecord(value) && "relation" in value && "source_node_id" in value;
}

function isPath(value: unknown): value is { nodes: unknown[]; edges: unknown[] } {
	return (
		isRecord(value) &&
		Array.isArray((value as Row).nodes) &&
		Array.isArray((value as Row).edges)
	);
}

function properties(value: Row, reserved: readonly string[]): Row {
	const out: Row = {};
	for (const [key, val] of Object.entries(value)) {
		if (!reserved.includes(key)) out[key] = val;
	}
	return out;
}

function inline(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

function propsToString(props: Row): string {
	const entries = Object.entries(props);
	if (entries.length === 0) return "";
	return ` {${entries.map(([k, v]) => `${k}: ${inline(v)}`).join(", ")}}`;
}

/**
 * One returned value, rendered the way a graph user reads it.
 *
 * A node comes back as a flat object mixing its properties with `id` and
 * `labels`; dumping that as raw JSON makes the caller do the separating. This
 * renders `(:Person {name: "Alice"})` instead, which is both shorter and the
 * notation the query was written in.
 */
export function renderValue(value: unknown): string {
	if (isPath(value)) {
		const nodes = value.nodes.map((n) => renderValue(n));
		const edges = value.edges.map((e) =>
			isRelationship(e) ? String(e.relation) : "?",
		);
		// Interleave nodes and edges in traversal order: (a)-[R]->(b)-[S]->(c).
		const parts: string[] = [];
		for (let i = 0; i < nodes.length; i++) {
			parts.push(nodes[i] ?? "");
			if (i < edges.length) parts.push(`-[:${edges[i]}]->`);
		}
		return parts.join("");
	}

	if (isNode(value)) {
		const labels = Array.isArray(value.labels)
			? (value.labels as unknown[]).map((l) => `:${String(l)}`).join("")
			: "";
		return `(${labels}${propsToString(properties(value, NODE_KEYS))})`;
	}

	if (isRelationship(value)) {
		return (
			`[${value.source_node_id}]-[:${value.relation}` +
			`${propsToString(properties(value, REL_KEYS))}]->[${value.target_node_id}]`
		);
	}

	return inline(value);
}

/**
 * Rows as a table, bounded.
 *
 * A traversal can return far more than the caller can use, and unlike the
 * memory tools there is no server-side relevance ranking to lean on — the query
 * asked for exactly this. So the ceiling is on the rendering, and what was
 * dropped is stated rather than silently cut.
 */
export function renderRows(
	rows: Row[],
	opts: { maxRows?: number; maxChars?: number } = {},
): string {
	const maxRows = opts.maxRows ?? 100;
	const maxChars = opts.maxChars ?? 20_000;

	if (rows.length === 0) return "(0 rows)";

	const shown = rows.slice(0, maxRows);
	const columns = [...new Set(shown.flatMap((row) => Object.keys(row)))];

	const lines: string[] = [];
	for (const [index, row] of shown.entries()) {
		const cells = columns.map((col) =>
			col in row ? `${col}: ${renderValue(row[col])}` : `${col}: —`,
		);
		lines.push(`${index + 1}. ${cells.join(" | ")}`);
	}

	let body = lines.join("\n");
	if (body.length > maxChars) {
		body = `${body.slice(0, maxChars)}\n[truncated: ${body.length} chars of rendered rows]`;
	}

	const omitted = rows.length - shown.length;
	const footer =
		omitted > 0
			? `\n\n[${omitted} more row(s) not shown — add SKIP/LIMIT to page through them]`
			: "";

	return `${body}${footer}`;
}
