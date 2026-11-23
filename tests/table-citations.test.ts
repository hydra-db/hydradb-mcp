import assert from "node:assert/strict";
import { test } from "node:test";

import { renderTableQuery, tableQuerySchema } from "../src/record-type.js";

test("table citations retain complete paired rows and omit oversized records whole", () => {
	const records = [{ name: "first" }, { name: "escaped-" + "\\\"".repeat(900) }, { name: "last" }];
	const rows = [["first"], ["large"], ["last"]];
	const table = tableQuerySchema.parse({
		status: "ok", answer_type: "exact", records, rows,
		citations: { rows: [{ source_id: "s1", row: 1 }, { source_id: "s1", row: 2 }, { source_id: "s1", row: 3 }] },
		sources: [{ id: "s1", collection: "docs", title: "Revenue" }],
	});
	const text = renderTableQuery(table);
	assert.match(text, /Row 1: .*\[source s1, row 1\]/);
	assert.match(text, /Row 3: .*\[source s1, row 3\]/);
	assert.match(text, /1 rows? omitted/);
	assert.ok(!text.includes("escaped-"));
	assert.ok(text.includes(JSON.stringify({ row: rows[0], record: records[0] })));
	assert.match(text, /Source "Revenue" \[id: s1, collection: docs\]/);
	assert.deepEqual(table.records, records);
});

test("table source references share the bounded text preview budget", () => {
	const table = tableQuerySchema.parse({
		status: "ok", records: [{ total: 0 }],
		sources: [{ id: "huge", collection: "docs", title: "x".repeat(20000) }, { id: "s2", collection: "docs", title: "Visible" }],
	});
	const text = renderTableQuery(table);
	assert.ok(text.length <= 12000);
	assert.match(text, /Source "Visible"/);
	assert.match(text, /full source list/);
	assert.equal(table.sources?.[0]?.title?.length, 20000);
});
