import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { HydraDB } from "../src/hydra/index.js";
import { createHydraDBServer } from "../src/server.js";

test("advertised infer help distinguishes optional enrichment from ongoing entity and graph extraction", async () => {
	const hydra = new HydraDB({ token: "synthetic-help-key", database: "db", collection: "notes" });
	const server = createHydraDBServer(hydra);
	const client = new Client({ name: "ingest-help-current", version: "0" });
	const [ct, st] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(st), client.connect(ct)]);
	try {
		const { tools } = await client.listTools();
		const ingest = tools.find((tool) => tool.name === "hydradb_ingest");
		assert.ok(ingest);
		const properties = ingest.inputSchema.properties as {
			infer: { description: string };
			items: { items: { properties: { infer: { description?: string; $ref?: string } } } };
		};
		const itemInfer = properties.items.items.properties.infer;
		const itemDescription = itemInfer.$ref === "#/properties/infer" ? properties.infer.description : itemInfer.description;
		for (const description of [properties.infer.description, itemDescription]) {
			assert.match(description, /additional memory enrichment/i);
			assert.match(description, /entity and graph extraction still run/i);
			assert.match(description, /default: true/i);
			assert.doesNotMatch(description, /store text verbatim|no interpretation|raw.only|no graph processing/i);
		}
	} finally { await client.close(); await server.close(); }
});
