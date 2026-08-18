/**
 * Rendering and local limits for the BYOG (Bring Your Own Graph) tool.
 *
 * Deliberately contains NO Cypher analysis. An earlier version lexed the query
 * to classify reads vs writes and to pre-reject constructs the server refuses,
 * which meant a second, worse implementation of the server's own rules living
 * in a client: it could only ever agree with the server or be wrong, and being
 * wrong meant refusing a query HydraDB would have run.
 *
 * The server is the authority on what Cypher is valid and permitted. It rejects
 * unsupported constructs before executing anything — verified: a query mixing
 * CREATE with a procedure call leaves the node count unchanged — and its
 * messages are more specific than the ones this file used to produce.
 *
 * What is left is the work a client genuinely owns: turning the server's row
 * objects into something readable, and the two limits that are cheaper to check
 * here than to discover from a remote error.
 */

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
