#!/usr/bin/env node

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveConfig } from "./config.js";
import { logger } from "./logger.js";
import {
	awaitInFlight,
	beginShutdown,
	createHydraDBServer,
	inFlightCount,
} from "./server.js";

// Fail fast with a clean message if required config is missing. Honours the
// canonical HYDRADB_* names (and the deprecated HYDRA_DB_* aliases).
try {
	resolveConfig();
} catch (error) {
	console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}

/**
 * How long to let in-flight work finish after a stop signal.
 *
 * SIGTERM is how most MCP hosts and container runtimes stop a server, and an
 * ingest that has been accepted but not yet answered is the case worth
 * protecting: dropping it leaves the caller unable to tell whether the write
 * committed. Short enough that nothing hangs a shutdown.
 */
const SHUTDOWN_GRACE_MS = 5_000;

/** Stack included when there is one — this is the last thing logged before exit. */
function describe(error: unknown): string {
	if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
	return String(error);
}

/**
 * Wire process-level lifecycle handling.
 *
 * Before this the server had none: no SIGINT/SIGTERM handling, no
 * unhandledRejection, no uncaughtException, and no transport close handling.
 * SIGTERM terminated the process immediately, dropping any in-flight request
 * with no log line; and after `connect()` resolved, a stray rejection killed the
 * process with a raw stack on stderr and no MCP-level notice, so the host simply
 * saw the server vanish mid-session.
 *
 * Everything here writes to stderr only. On stdio transport, stdout is the
 * JSON-RPC channel and any stray byte on it corrupts the stream.
 */
function installLifecycle(server: Server) {
	let shuttingDown = false;

	const shutdown = async (signal: string) => {
		// A second signal means the operator is impatient; honour that rather
		// than waiting out the grace period twice.
		if (shuttingDown) {
			logger.warn(`${signal} received again — exiting immediately`);
			process.exit(130);
		}
		shuttingDown = true;
		// Stop accepting NEW calls before draining. Without this, a call arriving
		// after the drain resolves but before the transport closes is accepted and
		// then aborted, which is the failure draining exists to prevent.
		beginShutdown();
		logger.info(`${signal} received — shutting down`);

		const timer = setTimeout(() => {
			logger.warn(
				`in-flight work did not finish within ${SHUTDOWN_GRACE_MS}ms — exiting anyway`,
			);
			process.exit(0);
		}, SHUTDOWN_GRACE_MS);
		// Do not let the grace timer itself hold the process open.
		timer.unref();

		try {
			// Drain BEFORE closing. `server.close()` tears down the transport; it
			// does not wait for handlers already running, so closing first would
			// cut an accepted ingest off mid-write and leave the caller unable to
			// tell whether it committed.
			const pending = inFlightCount();
			if (pending > 0) {
				logger.info(`waiting for ${pending} in-flight tool call(s)`);
				await awaitInFlight();
			}
			await server.close();
		} catch (error) {
			logger.error("error while closing the server", { error: describe(error) });
		}
		clearTimeout(timer);
		process.exit(0);
	};

	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));

	// The host closing the pipe is a normal end of session, not a failure.
	server.onclose = () => {
		if (shuttingDown) return;
		logger.info("transport closed — exiting");
		process.exit(0);
	};

	server.onerror = (error) => {
		logger.error("transport error", { error: describe(error) });
	};

	// Node terminates on an unhandled rejection by default, with a raw stack and
	// no explanation of which server it came from. Log it in our own format, then
	// exit non-zero so a supervisor restarts rather than silently continuing.
	process.on("unhandledRejection", (reason) => {
		logger.error("unhandled promise rejection", { error: describe(reason) });
		process.exit(1);
	});

	process.on("uncaughtException", (error) => {
		logger.error("uncaught exception", { error: describe(error) });
		process.exit(1);
	});
}

async function main() {
	const server = createHydraDBServer();
	installLifecycle(server);
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

main().catch((error) => {
	console.error("Fatal error running server:", error);
	process.exit(1);
});
