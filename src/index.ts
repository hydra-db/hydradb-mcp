#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createHydraDBServer } from "./server.js";

const HYDRA_DB_API_KEY = process.env.HYDRA_DB_API_KEY;
if (!HYDRA_DB_API_KEY) {
	console.error(
		"Error: HYDRA_DB_API_KEY environment variable is required",
	);
	process.exit(1);
}

const HYDRA_DB_TENANT_ID = process.env.HYDRA_DB_TENANT_ID;
if (!HYDRA_DB_TENANT_ID) {
	console.error(
		"Error: HYDRA_DB_TENANT_ID environment variable is required",
	);
	process.exit(1);
}

async function main() {
	try {
		const server = createHydraDBServer();
		const transport = new StdioServerTransport();
		await server.connect(transport);
	} catch (error) {
		console.error("Fatal error running server:", error);
		process.exit(1);
	}
}

main().catch((error) => {
	console.error("Fatal error running server:", error);
	process.exit(1);
});

