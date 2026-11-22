import assert from "node:assert/strict";
import { test } from "node:test";
import { currentIngestFixture } from "./current-ingest-fixture.js";

test("text ingestion carries user_name on unified items and leaves it off split memories, as main does", async () => {
	for (const layout of ["split", "unified"] as const) {
		const fixture = await currentIngestFixture({ layout });
		try {
			const result = await fixture.call({ text: "Ada likes concise answers.", user_name: "Ada", source_id: "ada-1" });
			assert.equal(result.isError, undefined, JSON.stringify(result.content));
			const items = fixture.writes[0]!.context ?? fixture.writes[0]!.memories;
			assert.ok(Array.isArray(items));
			assert.equal(items[0].user_name, layout === "unified" ? "Ada" : undefined);
		} finally { await fixture.close(); }
	}
});

test("omitted unified batch routing preserves item aliases, ids, ACLs and explicit false", async () => {
	const fixture = await currentIngestFixture({ layout: "unified" });
	try {
		const result = await fixture.call({ overwrite: false, items: [
			{ text: "one", source_id: "ctx-1", attributes: { team: "support" }, happened_at: "2026-11-16", instructions: "", custom_instructions: "legacy must not win", acl: [] },
			{ turns: [{ user: "two", assistant: "noted" }], source_id: "ctx-2", infer: false, user_name: "Ada", acl: null },
		] });
		assert.equal(result.isError, undefined, JSON.stringify(result.content));
		assert.equal(fixture.writes.length, 1);
		const body = fixture.writes[0]!;
		assert.equal(body.type, undefined);
		assert.equal(body.memories, undefined);
		assert.equal(body.upsert, false);
		const items = body.context as Record<string, unknown>[];
		assert.deepEqual(items.map((item) => item.context_id), ["ctx-1", "ctx-2"]);
		assert.deepEqual(items[0]!.attributes, { team: "support" });
		assert.equal(items[0]!.happened_at, "2026-11-16");
		assert.equal(items[0]!.instructions, "");
		assert.deepEqual(items[0]!.acl, []);
		assert.equal(items[1]!.acl, null);
		assert.equal(items[1]!.enrich, false);
		assert.equal(items[1]!.user_name, "Ada");
		assert.deepEqual(result.structuredContent?.accepted_ids, ["ctx-1", "ctx-2"]);
		assert.equal(result.structuredContent?.request_id, "req-current-ingest");
	} finally { await fixture.close(); }
});

test("explicit unified batch is refused on verified split before writes", async () => {
	const fixture = await currentIngestFixture();
	try {
		const result = await fixture.call({ type: "unified", items: [{ text: "note" }] });
		assert.equal(result.isError, true);
		assert.equal(fixture.writes.length, 0);
	} finally { await fixture.close(); }
});

test("unknown-layout omitted batch uses the same safe unified refusal fallback as a single item", async () => {
	const fixture = await currentIngestFixture({ layout: "unknown", refuseSplit: true });
	try {
		const result = await fixture.call({ items: [{ text: "note", source_id: "ctx-1" }] });
		assert.equal(result.isError, undefined, JSON.stringify(result.content));
		assert.equal(fixture.writes.length, 2);
		assert.equal(fixture.writes[0]!.type, "memory");
		assert.equal((fixture.writes[1]!.context as { context_id: string }[])[0]!.context_id, "ctx-1");
	} finally { await fixture.close(); }
});

test("unified batch never replays an ambiguous unsafe write", async () => {
	const fixture = await currentIngestFixture({ layout: "unified", failWrites: true });
	try {
		const result = await fixture.call({ items: [{ text: "note", source_id: "ctx-1" }] });
		assert.equal(result.isError, true);
		assert.match(JSON.stringify(result.content), /outcome unknown/i);
		assert.equal(fixture.writes.length, 1);
	} finally { await fixture.close(); }
});

test("an explicit split batch selector is never silently retried as unified", async () => {
	const fixture = await currentIngestFixture({ layout: "unified", refuseSplit: true });
	try {
		const result = await fixture.call({ type: "memory", items: [{ text: "note", source_id: "ctx-1" }] });
		assert.equal(result.isError, true);
		assert.equal(fixture.writes.length, 1);
		assert.equal(fixture.writes[0]!.type, "memory");
	} finally { await fixture.close(); }
});
