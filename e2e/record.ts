/**
 * Re-record e2e/fixtures/staging.json: `npm run e2e:record`.
 *
 * Starts the simulator as a recording proxy in front of HYDRADB_E2E_BASE_URL,
 * points the real server at it, and drives one good call per route family plus
 * a bad key, a missing id and an invalid body. Every answer the API gave is
 * stored per route, with the API key, presigned URLs and the API host redacted.
 * It creates and deletes its own throwaway databases.
 */
import { writeFileSync } from "node:fs";

import { connectorMetadata } from "./data.js";
import { sleep, startStdio, type StdioServer, throwawayName } from "./harness.js";
import { type Exchange, type Fixtures, type Recorded, Simulator } from "./simulator.js";

const baseUrl = process.env.HYDRADB_E2E_BASE_URL?.replace(/\/+$/, "");
const apiKey = process.env.HYDRADB_E2E_API_KEY;

if (!baseUrl || !apiKey) {
	console.error("set HYDRADB_E2E_BASE_URL and HYDRADB_E2E_API_KEY to record fixtures");
	process.exit(1);
}

const database = throwawayName();
const graphDatabase = throwawayName();
const proxy = new Simulator({ upstream: baseUrl });
const proxyUrl = await proxy.start();
const env = (key: string, db: string) => ({ HYDRADB_API_KEY: key, HYDRADB_BASE_URL: proxyUrl, HYDRADB_DATABASE: db });
const server = await startStdio("source", env(apiKey, database));
const admin = await startStdio("source", env(apiKey, `${database}-admin`));

async function call(on: StdioServer, tool: string, args: Record<string, unknown>) {
	const answer = await on.call(tool, args);

	console.log(`${answer.isError ? "ERR" : "ok "} ${tool} ${answer.text.split("\n", 1)[0].slice(0, 140)}`);

	return answer;
}

async function until(what: string, check: () => Promise<boolean>) {
	for (let i = 0; i < 120; i++) {
		if (await check()) return;

		await sleep(5_000);
	}

	throw new Error(`${what} did not happen in 10 minutes`);
}

try {
	await call(server, "hydradb_database_create", {
		database,
		database_metadata_schema: [{ name: "team", data_type: "VARCHAR", max_length: 64, enable_match: true }],
	});
	await until("readiness", async () => (await call(server, "hydradb_database_readiness", {})).structured?.ready_for_ingestion === true);

	const rows = Array.from({ length: 50 }, (_, i) => ({
		text: `Connector message ${i} from the payments on-call channel.`,
		source_id: `rec-k-page-${i}`,
		title: `Slack message ${i}`,
		infer: false,
		additional_metadata: connectorMetadata(i + 1),
	}));

	await call(server, "hydradb_ingest", { kind: "knowledge", items: rows });
	await call(server, "hydradb_ingest", {
		kind: "knowledge",
		text: "Billing depends on the ledger service.",
		title: "Billing dependencies",
		source_id: "rec-k-rel",
		metadata: { team: "payments" },
		relations: { ids: ["rec-k-page-0"] },
	});
	await call(server, "hydradb_ingest", { kind: "knowledge", text: "A document in a collection the recorder drops.", title: "Drop", source_id: "rec-k-drop", collection: "rec-drop" });
	await call(server, "hydradb_ingest", { text: "The user prefers stacked pull requests.", source_id: "rec-m-text" });

	const ids = ["rec-k-rel", "rec-m-text", ...rows.map((row) => row.source_id)];

	await until("indexing", async () => {
		const answer = await call(server, "hydradb_status", { ids });

		return /All sources have reached a terminal state/.test(answer.text);
	});

	const collections = await call(server, "hydradb_list_collections", {});
	const collection = ((collections.structured?.collections as string[]) ?? []).find((name) => name !== "rec-drop") ?? "";

	await call(server, "hydradb_inspect", { id: "rec-k-rel" });
	await call(server, "hydradb_inspect", { id: "rec-k-missing" });
	await call(server, "hydradb_relations", { id: "rec-k-rel", kind: "knowledge" });
	await call(server, "hydradb_subgraph", { id: "rec-k-rel" });
	await call(server, "hydradb_update", { id: "rec-k-rel", collection, additional_metadata: { reviewed: true } });
	await call(server, "hydradb_database_stats", {});
	await call(server, "hydradb_database_schema_update", { add_fields: [{ name: "region", data_type: "VARCHAR", max_length: 32 }] });
	await call(server, "hydradb_database_schema_inspect", {});
	await call(server, "hydradb_databases", {});
	await call(server, "hydradb_connector_provider_list", {});
	await call(server, "hydradb_connector_list", {});
	await call(server, "hydradb_connector_inspect", { connector_id: "conn_e2e_missing_000000000000" });
	await call(server, "hydradb_graph_admin", { action: "create_database", database: graphDatabase });
	await call(server, "hydradb_graph_query", { database: graphDatabase, collection: "rec", query: "CREATE (p:Person {key: $key})", params: { key: "ada" } });
	await call(server, "hydradb_graph_query", { database: graphDatabase, collection: "rec", query: "CREATE (p:Person {id: $id, name: $name})", params: { id: 1, name: "Ada" } });
	await call(server, "hydradb_graph_query", { database: graphDatabase, collection: "rec", query: "MATCH (p:Person) RETURN p.id AS id, p.name AS name" });
	await call(server, "hydradb_graph_collections", { database: graphDatabase });
	await call(server, "hydradb_graph_admin", { action: "drop_collection", database: graphDatabase, collection: "rec" });
	await call(server, "hydradb_graph_admin", { action: "drop_database", database: graphDatabase });

	const queried = await call(server, "hydradb_query", { query: "Who depends on the ledger service?", kind: "knowledge", collection, structured: true });

	await call(server, "hydradb_feedback", { request_id: String(queried.structured?.request_id ?? ""), rating: "positive", feedback: "recorded by e2e" });
	await call(server, "hydradb_status", { ids });
	await call(server, "hydradb_list", { kind: "knowledge", page_size: 100, include_fields: ["additional_metadata"] });
	await call(server, "hydradb_delete", { ids: ["rec-m-text"], kind: "memory" });
	await call(server, "hydradb_delete_collection", { collection: "rec-drop" });

	const bad = await startStdio("source", env("sk_test_e2erecord.invalidinvalidinvalid", database));

	await call(bad, "hydradb_databases", {});
	await bad.close();
} finally {
	await call(admin, "hydradb_graph_admin", { action: "drop_database", database: graphDatabase });
	await call(admin, "hydradb_database_delete", { database });
	await admin.close();
	await server.close();
	await proxy.stop();
}

function redact(value: unknown): unknown {
	const text = JSON.stringify(value)
		.split(apiKey as string)
		.join("[redacted]")
		.split(baseUrl as string)
		.join("https://api.hydradb.invalid")
		.replace(/https:\/\/[^"\s]*X-Amz-[^"\s]*/g, "https://presigned.invalid/redacted")
		.split(database)
		.join("e2e-mcp-recorded")
		.split(graphDatabase)
		.join("e2e-mcp-recorded-graph");

	return JSON.parse(text);
}

/** Keep the recorded databases list to the recorder's own database: the rest name other people's. */
function trim(route: string, recorded: Recorded): Recorded {
	if (route !== "databases.list") return recorded;

	const data = (recorded.body as { data: Record<string, unknown[]> }).data;
	const ours = (entry: unknown) => JSON.stringify(entry).includes("e2e-mcp-recorded");

	for (const key of ["tenant_ids", "databases", "details"]) data[key] = (data[key] ?? []).filter(ours);

	return recorded;
}

const routes: Record<string, Recorded> = {};
const errors: Partial<Fixtures["errors"]> = {};
const describeCall = (ex: Exchange) => `${ex.method} ${ex.path}`;

for (const ex of proxy.exchanges) {
	const response = ex.response;

	if (!ex.route || !response) continue;

	if (response.status >= 200 && response.status < 300) routes[ex.route] = trim(ex.route, redact(response) as Recorded);

	const status = String(response.status);

	if ((status === "400" || status === "401" || status === "404") && errors[status] == null) {
		errors[status] = { ...(redact(response) as Recorded), call: describeCall(ex) };
	}
}

for (const status of ["400", "401", "404"] as const) {
	if (errors[status] == null) throw new Error(`no ${status} was recorded`);
}

const fixtures: Fixtures = { recorded_at: new Date().toISOString(), errors: errors as Fixtures["errors"], routes };
const out = new URL("./fixtures/staging.json", import.meta.url);

writeFileSync(out, `${JSON.stringify(fixtures, null, 1)}\n`);
console.log(`wrote ${Object.keys(routes).length} routes and ${Object.keys(errors).length} errors to ${out.pathname}`);
