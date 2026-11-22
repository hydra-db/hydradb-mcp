import assert from "node:assert/strict";
import { test } from "node:test";
import { currentIngestFixture } from "./current-ingest-fixture.js";

test("split legacy memory, bare knowledge and files reject explicit ACL states before any write", async () => {
	const fixture = await currentIngestFixture();
	try {
		for (const acl of [["user_email:reader@example.test"], [], null]) {
			for (const args of [
				{ kind: "memory", text: "note", acl },
				{ kind: "knowledge", text: "document", acl },
				{ file: { filename: "note.txt", content_base64: "bm90ZQ==" }, acl },
				{ items: [{ text: "note", acl }] },
			]) {
				const result = await fixture.call(args);
				assert.equal(result.isError, true, JSON.stringify(args));
				assert.match(JSON.stringify(result.content), /acl.*(unsupported|not support|cannot|only)|not support.*acl/i);
				assert.equal(fixture.writes.length, 0, JSON.stringify(args));
			}
		}
	} finally { await fixture.close(); }
});

test("unknown-layout ACL ingestion fails safely unless unified is explicitly selected", async () => {
	const fixture = await currentIngestFixture({ layout: "unknown" });
	try {
		const refused = await fixture.call({ items: [{ text: "note", acl: [] }] });
		assert.equal(refused.isError, true);
		assert.equal(fixture.writes.length, 0);
		const explicit = await fixture.call({ type: "unified", items: [{ text: "note", source_id: "ctx-1", acl: null }] });
		assert.equal(explicit.isError, undefined, JSON.stringify(explicit.content));
		assert.equal(fixture.writes.length, 1);
		assert.equal((fixture.writes[0]!.context as { acl: unknown }[])[0]!.acl, null);
	} finally { await fixture.close(); }
});

test("resource split ACL guards protect direct SDK multipart calls as well as MCP", async () => {
	const fixture = await currentIngestFixture();
	try {
		for (const acl of [["__private__"], [], null]) {
			for (const request of [
				{ kind: "memory" as const, text: "note", acl },
				{ kind: "knowledge" as const, text: "document", acl },
				{ kind: "knowledge" as const, file: { data: Buffer.from("note"), filename: "note.txt", contentType: "text/plain" }, acl },
				{ kind: "memory" as const, items: [{ text: "note", acl }] },
			]) await assert.rejects(fixture.hydra.context.ingest(request), /acl.*(unsupported|not support|cannot|only)/i);
		}
		assert.equal(fixture.writes.length, 0);
	} finally { await fixture.close(); }
});

test("app knowledge split SDK transport preserves explicit principal, empty and null ACL states", async () => {
	const fixture = await currentIngestFixture();
	try {
		for (const acl of [["user_email:reader@example.test"], [], null]) {
			const result = await fixture.call({ app_knowledge: [{ id: "app-1", kind: "ticket", fields: { title: "AUTH-1" }, acl }] });
			assert.equal(result.isError, undefined, JSON.stringify(result.content));
			assert.deepEqual((fixture.writes.at(-1)!.app_knowledge as { acl: unknown }[])[0]!.acl, acl);
		}
	} finally { await fixture.close(); }
});

test("unified raw transport preserves empty and null ACLs without dropping them", async () => {
	const fixture = await currentIngestFixture({ layout: "unified" });
	try {
		for (const acl of [[], null]) {
			const result = await fixture.call({ text: "note", source_id: "ctx-1", acl });
			assert.equal(result.isError, undefined, JSON.stringify(result.content));
			const item = (fixture.writes.at(-1)!.context as Record<string, unknown>[])[0]!;
			assert.ok(Object.hasOwn(item, "acl"));
			assert.deepEqual(item.acl, acl);
		}
	} finally { await fixture.close(); }
});
