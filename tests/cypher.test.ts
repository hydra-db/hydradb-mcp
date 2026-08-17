import assert from "node:assert/strict";
import { test } from "node:test";

import {
	COLLECTION_PATTERN,
	MAX_BODY_BYTES,
	SCHEMA_QUERIES,
	isWriteQuery,
	renderRows,
	renderValue,
	stripNonCode,
	unsupportedConstruct,
	writeClausesIn,
} from "../src/cypher.js";

// --- Write detection ---

test("ordinary reads are not writes", () => {
	for (const query of [
		"MATCH (n) RETURN n",
		"MATCH (p:Person)-[:KNOWS*1..3]->(f) RETURN DISTINCT f.name AS name",
		"MATCH (a),(b) RETURN shortestPath((a)-[*..6]->(b)) AS p",
		"MATCH (p:Person) WHERE (p)-[:KNOWS]->() RETURN p.name AS name",
		"CALL { MATCH (p:Person) RETURN p.name AS n } RETURN n",
		"MATCH (p:Person) RETURN p.name AS name ORDER BY name SKIP $offset LIMIT $limit",
	]) {
		assert.equal(isWriteQuery(query), false, `should be a read: ${query}`);
	}
});

test("every write clause is detected", () => {
	for (const query of [
		"CREATE (n:Person {name: 'Alice'})",
		"MERGE (n:Person {ext_id: 1})",
		"MATCH (n) SET n.seen = true",
		"MATCH (n) DELETE n",
		"MATCH (n) DETACH DELETE n",
		"MATCH (n) REMOVE n.tag",
		"CREATE INDEX FOR (n:Person) ON (n.name)",
		"DROP INDEX ON :Person(name)",
		"MATCH (n) FOREACH (x IN [1] | SET n.k = x)",
	]) {
		assert.equal(isWriteQuery(query), true, `should be a write: ${query}`);
	}
});

/**
 * The reason this detector is not a substring scan.
 *
 * Neo4j's own MCP checks `any(keyword in query.upper() ...)`, so it refuses
 * this query from its read tool — a query HydraDB accepts and that mutates
 * nothing. Verified against the live BYOG API: it returns rows, changes no data.
 */
test("a write keyword inside a string literal is not a write", () => {
	const query = 'MATCH (p:Person) WHERE p.name = "CREATE something" RETURN p.name AS name';
	assert.equal(isWriteQuery(query), false);
	assert.deepEqual(writeClausesIn(query), []);
});

test("write keywords in comments and identifiers are not writes", () => {
	assert.equal(isWriteQuery("MATCH (n) RETURN n // TODO: also CREATE an index"), false);
	assert.equal(isWriteQuery("/* we used to MERGE here */ MATCH (n) RETURN n"), false);
	assert.equal(isWriteQuery("MATCH (n) RETURN n.`delete` AS d"), false);
	assert.equal(isWriteQuery("MATCH (n) WHERE n.note = 'please DELETE me' RETURN n"), false);
});

test("a write is still detected when a decoy literal is present", () => {
	// The literal must not blind the scan to the real clause beside it.
	const query = `MATCH (p:Person) WHERE p.note = "do not DELETE" SET p.seen = true`;
	assert.equal(isWriteQuery(query), true);
	assert.deepEqual(writeClausesIn(query), ["SET"]);
});

test("write keywords embedded in longer words are not matched", () => {
	// OFFSET contains SET; createdAt contains CREATE.
	assert.equal(isWriteQuery("MATCH (n) RETURN n.createdAt AS c"), false);
	assert.equal(isWriteQuery("MATCH (n) RETURN n.offset AS o"), false);
	assert.equal(isWriteQuery("MATCH (n) RETURN n.dropped AS d"), false);
});

test("escaped quotes do not end a literal early", () => {
	// If the backslash-escaped quote were treated as the terminator, the DELETE
	// after it would be read as live code.
	const query = `MATCH (n) WHERE n.s = 'it\\'s DELETE time' RETURN n`;
	assert.equal(isWriteQuery(query), false);
});

test("doubled quotes inside a literal do not end it early", () => {
	const query = `MATCH (n) WHERE n.s = 'a '' DELETE b' RETURN n`;
	assert.equal(isWriteQuery(query), false);
});

test("stripNonCode preserves length so offsets stay stable", () => {
	const query = `MATCH (n) WHERE n.s = "CREATE" RETURN n`;
	assert.equal(stripNonCode(query).length, query.length);
});

// --- Unsupported constructs ---

test("procedure calls are named locally, subqueries are not", () => {
	assert.ok(unsupportedConstruct("CALL db.labels()"));
	assert.ok(unsupportedConstruct("CALL apoc.meta.schema()"));
	assert.equal(
		unsupportedConstruct("CALL { MATCH (n) RETURN n.name AS x } RETURN x"),
		undefined,
	);
	// Whitespace between CALL and the brace still reads as a subquery.
	assert.equal(unsupportedConstruct("CALL  { MATCH (n) RETURN n AS x } RETURN x"), undefined);
});

test("LOAD CSV is named locally with the supported alternative", () => {
	const message = unsupportedConstruct("LOAD CSV FROM 'file:///x.csv' AS row RETURN row");
	assert.ok(message);
	assert.match(message, /params/);
});

test("a procedure name inside a string literal is not a procedure call", () => {
	assert.equal(
		unsupportedConstruct(`MATCH (n) WHERE n.doc = "CALL db.labels()" RETURN n`),
		undefined,
	);
});

// --- Schema queries ---

test("no schema query uses a procedure call", () => {
	// The whole point of deriving the schema: HydraDB rejects CALL db.* and
	// apoc.*, so a schema query that used one would fail before it ran.
	for (const [name, query] of Object.entries(SCHEMA_QUERIES)) {
		assert.equal(
			unsupportedConstruct(query),
			undefined,
			`${name} must not use a rejected construct`,
		);
		assert.equal(isWriteQuery(query), false, `${name} must be read-only`);
	}
});

test("sampled schema queries bind their limit as a parameter", () => {
	for (const name of ["nodeProperties", "relationshipProperties", "shape"] as const) {
		assert.match(SCHEMA_QUERIES[name], /\$sample/, `${name} should bind $sample`);
	}
});

// --- Collection names ---

test("collection names follow the server's documented charset", () => {
	for (const ok of ["contacts", "a", "A1", "my-graph_2", "0start"]) {
		assert.ok(COLLECTION_PATTERN.test(ok), `${ok} should be valid`);
	}
	for (const bad of ["", "-leading", "_leading", "has space", "has/slash", "a".repeat(65)]) {
		assert.ok(!COLLECTION_PATTERN.test(bad), `${JSON.stringify(bad)} should be invalid`);
	}
	assert.ok(COLLECTION_PATTERN.test("a".repeat(64)));
});

test("the body cap matches the documented 256 KiB", () => {
	assert.equal(MAX_BODY_BYTES, 262_144);
});

// --- Rendering ---

test("a node renders as Cypher notation, not raw JSON", () => {
	// The shape HydraDB actually returns: properties flattened alongside the
	// renderer-added id and labels.
	const node = { id: 0, labels: ["Person"], name: "Alice", role: "admin" };
	assert.equal(renderValue(node), '(:Person {name: Alice, role: admin})');
});

test("a relationship renders with its endpoints", () => {
	const rel = {
		id: 0,
		relation: "KNOWS",
		since: 2020,
		source_node_id: 0,
		target_node_id: 1,
	};
	assert.equal(renderValue(rel), "[0]-[:KNOWS {since: 2020}]->[1]");
});

test("a path renders in traversal order", () => {
	const path = {
		nodes: [
			{ id: 0, labels: ["Person"], name: "Alice" },
			{ id: 1, labels: ["Person"], name: "Bob" },
		],
		edges: [{ id: 0, relation: "KNOWS", source_node_id: 0, target_node_id: 1 }],
	};
	assert.equal(
		renderValue(path),
		"(:Person {name: Alice})-[:KNOWS]->(:Person {name: Bob})",
	);
});

test("scalars render as themselves", () => {
	assert.equal(renderValue("Alice"), "Alice");
	assert.equal(renderValue(42), "42");
	assert.equal(renderValue(null), "null");
	assert.equal(renderValue(true), "true");
});

test("an empty result says so rather than rendering nothing", () => {
	assert.equal(renderRows([]), "(0 rows)");
});

test("rows past the cap are reported, not silently dropped", () => {
	const rows = Array.from({ length: 10 }, (_, i) => ({ n: i }));
	const out = renderRows(rows, { maxRows: 3 });
	assert.match(out, /7 more row\(s\) not shown/);
	assert.match(out, /SKIP\/LIMIT/);
});

test("rows with differing columns still render every column", () => {
	const out = renderRows([{ a: 1 }, { b: 2 }]);
	assert.match(out, /a: 1/);
	assert.match(out, /b: 2/);
	// The missing cell is marked rather than omitted, so columns stay aligned.
	assert.match(out, /a: —/);
});
