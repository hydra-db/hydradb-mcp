import assert from "node:assert/strict";
import { test } from "node:test";

import {
	COLLECTION_PATTERN,
	MAX_BODY_BYTES,
	renderRows,
	renderValue,
} from "../src/cypher.js";

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
