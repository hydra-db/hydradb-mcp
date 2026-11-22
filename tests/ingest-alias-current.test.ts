import assert from "node:assert/strict";
import { test } from "node:test";
import { currentIngestFixture } from "./current-ingest-fixture.js";

test("preferred date and instruction aliases cannot bypass unsupported knowledge validation", async () => {
	const fixture = await currentIngestFixture();
	try {
		for (const extra of [{ happened_at: "2026-11-16" }, { instructions: "Extract dates" }, { instructions: "" }]) {
			for (const input of [{ text: "document" }, { items: [{ text: "document", ...extra }] }]) {
				const result = await fixture.call({ type: "knowledge", ...input, ...(input.text ? extra : {}) });
				assert.equal(result.isError, true, JSON.stringify(extra));
				assert.match(JSON.stringify(result.content), /instructions|observation|happened/i);
				assert.equal(fixture.writes.length, 0);
			}
		}
	} finally { await fixture.close(); }
});

test("preferred aliases use presence priority and preserve an empty instruction on split and unified", async () => {
	for (const layout of ["split", "unified"] as const) {
		const fixture = await currentIngestFixture({ layout });
		try {
			const result = await fixture.call({ text: "note", happened_at: "2026-11-16", observation_date: "2026-10-01", instructions: "", custom_instructions: "legacy" });
			assert.equal(result.isError, undefined, JSON.stringify(result.content));
			const item = ((fixture.writes[0]!.context ?? fixture.writes[0]!.memories) as Record<string, unknown>[])[0]!;
			assert.equal(item.happened_at ?? item.observation_date, "2026-11-16");
			assert.equal(item.instructions ?? item.custom_instructions, "");
		} finally { await fixture.close(); }
	}
});

test("preferred aliases on file and app modes are rejected rather than ignored", async () => {
	const fixture = await currentIngestFixture();
	try {
		for (const input of [{ file: { filename: "note.txt", content_base64: "bm90ZQ==" } }, { app_knowledge: [{ id: "app-1", kind: "ticket", fields: { title: "AUTH-1" } }] }]) {
			for (const extra of [{ happened_at: "2026-11-16" }, { instructions: "" }]) {
				const result = await fixture.call({ ...input, ...extra });
				assert.equal(result.isError, true, JSON.stringify({ input, extra }));
				assert.equal(fixture.writes.length, 0);
			}
		}
	} finally { await fixture.close(); }
});

test("unified aliases preserve accepted instructions with explicit false enrichment", async () => {
	const fixture = await currentIngestFixture({ layout: "unified" });
	try {
		for (const fields of [{ instructions: "Keep the supplied context.", infer: false }, { instructions: "", custom_instructions: "legacy must not win", infer: false }]) {
			for (const input of [{ text: "note", ...fields }, { items: [{ text: "note", ...fields }] }]) {
				const result = await fixture.call(input);
				assert.equal(result.isError, undefined, JSON.stringify(result.content));
				const item = (fixture.writes.at(-1)!.context as Record<string, unknown>[])[0]!;
				assert.equal(item.enrich, false);
				assert.equal(item.instructions, fields.instructions);
			}
		}
	} finally { await fixture.close(); }
});
