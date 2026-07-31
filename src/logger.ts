/**
 * Structured logger for Hydra DB MCP Server.
 * Outputs to stderr to avoid interfering with STDIO transport.
 */

import { type EnvSource, readEnv, type WarnFn } from "./config.js";

export enum LogLevel {
	DEBUG = 0,
	INFO = 1,
	WARN = 2,
	ERROR = 3,
}

const LOG_LEVEL_NAMES: Record<LogLevel, string> = {
	[LogLevel.DEBUG]: "DEBUG",
	[LogLevel.INFO]: "INFO",
	[LogLevel.WARN]: "WARN",
	[LogLevel.ERROR]: "ERROR",
};

/**
 * `HYDRADB_LOG_LEVEL` is the canonical name (CONTRACT §1). `HYDRA_DB_LOG_LEVEL`
 * was the only variable the canonical-prefix migration missed; it is honoured as
 * a deprecated alias on the same terms as every other legacy spelling.
 */
export function resolveLogLevel(
	env: EnvSource = process.env,
	warn?: WarnFn,
): LogLevel {
	// `warn` is optional here; passing it through undefined falls back to
	// readEnv's own stderr default.
	const level = readEnv(
		env,
		"HYDRADB_LOG_LEVEL",
		"HYDRA_DB_LOG_LEVEL",
		warn,
	)?.toUpperCase();
	switch (level) {
		case "DEBUG":
			return LogLevel.DEBUG;
		case "INFO":
			return LogLevel.INFO;
		case "WARN":
			return LogLevel.WARN;
		case "ERROR":
			return LogLevel.ERROR;
		default:
			return LogLevel.ERROR;
	}
}

const currentLogLevel = resolveLogLevel();

function formatMessage(
	level: LogLevel,
	message: string,
	meta?: Record<string, unknown>,
): string {
	const timestamp = new Date().toISOString();
	const levelName = LOG_LEVEL_NAMES[level];
	if (meta && Object.keys(meta).length > 0) {
		try {
			return `[${timestamp}] [hydradb-mcp] ${levelName}: ${message} ${JSON.stringify(meta)}`;
		} catch {
			return `[${timestamp}] [hydradb-mcp] ${levelName}: ${message} [unstringifiable]`;
		}
	}
	return `[${timestamp}] [hydradb-mcp] ${levelName}: ${message}`;
}

function log(
	level: LogLevel,
	message: string,
	meta?: Record<string, unknown>,
): void {
	if (level >= currentLogLevel) {
		console.error(formatMessage(level, message, meta));
	}
}

export const logger = {
	debug(message: string, meta?: Record<string, unknown>): void {
		log(LogLevel.DEBUG, message, meta);
	},
	info(message: string, meta?: Record<string, unknown>): void {
		log(LogLevel.INFO, message, meta);
	},
	warn(message: string, meta?: Record<string, unknown>): void {
		log(LogLevel.WARN, message, meta);
	},
	error(message: string, meta?: Record<string, unknown>): void {
		log(LogLevel.ERROR, message, meta);
	},
};

