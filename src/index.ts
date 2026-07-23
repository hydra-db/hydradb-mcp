#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveConfig } from "./config.js";
import { createHydraDBServer } from "./server.js";

// Fail fast with a clean message if required config is missing. Honours the
// canonical HYDRADB_* names (and the deprecated HYDRA_DB_* aliases).
try {
	resolveConfig();
} catch (error) {
	console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
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

