#!/usr/bin/env node

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/require-readable-spacing -- This launcher validates one protected JSON I/O boundary before setting process environment values. */
import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

const environmentPath = process.argv[2];
const entrypoint = process.argv[3];

if (!environmentPath || !entrypoint) {
	throw new Error("Usage: protected-env-mcp-launcher.mjs <environment.json> <entrypoint>");
}

const environment = JSON.parse(readFileSync(environmentPath, "utf8"));

if (environment == null || typeof environment !== "object" || Array.isArray(environment)) {
	throw new Error("Protected environment file must contain one JSON object");
}

for (const [name, value] of Object.entries(environment)) {
	if (typeof value !== "string") throw new Error(`Protected environment value ${name} must be a string`);
	process.env[name] = value;
}

await import(pathToFileURL(entrypoint).href);
