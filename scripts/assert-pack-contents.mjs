#!/usr/bin/env node
/**
 * Assert the published tarball contains what it must.
 *
 * `files` in package.json decides what actually ships, and a missing entry is
 * invisible until someone installs the package and it does not run. The build
 * passing and the tarball being correct are different questions.
 */
import { execFileSync } from "node:child_process";

const REQUIRED = ["dist/index.js", "package.json", "README.md"];

const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], {
	encoding: "utf8",
	stdio: ["ignore", "pipe", "inherit"],
});

const files = (JSON.parse(raw)[0]?.files ?? []).map((f) => f.path);
const missing = REQUIRED.filter((f) => !files.includes(f));

if (missing.length > 0) {
	console.error(`[assert-pack] tarball is missing: ${missing.join(", ")}`);
	console.error(`[assert-pack] it contains: ${files.join(", ")}`);
	process.exit(1);
}

// The bin entry has to be inside the tarball or `npx @hydradb/mcp` resolves to
// nothing after install.
const bin = JSON.parse(
	execFileSync("node", ["-p", "JSON.stringify(require('./package.json').bin)"], {
		encoding: "utf8",
	}),
);
for (const [name, path] of Object.entries(bin ?? {})) {
	const normalised = path.replace(/^\.\//, "");
	if (!files.includes(normalised)) {
		console.error(
			`[assert-pack] bin "${name}" points at ${path}, which is not in the tarball`,
		);
		process.exit(1);
	}
}

// `npx @hydradb/mcp` names no binary. With more than one `bin` entry npx runs
// the one named after the package without its scope, and refuses to guess when
// there is none ("could not determine executable to run").
const { name: packageName } = JSON.parse(
	execFileSync("node", ["-p", "JSON.stringify(require('./package.json'))"], {
		encoding: "utf8",
	}),
);

const unscoped = packageName.split("/").pop();

const binNames = Object.keys(bin ?? {});

if (binNames.length !== 1 && !binNames.includes(unscoped)) {
	console.error(
		`[assert-pack] no bin is named "${unscoped}", so \`npx ${packageName}\` cannot pick one of: ` +
			binNames.join(", "),
	);
	process.exit(1);
}

if (binNames.includes(unscoped) && bin[unscoped] !== bin["hydradb-mcp"]) {
	console.error(
		`[assert-pack] bin "${unscoped}" must start the stdio server, the same file as "hydradb-mcp"`,
	);
	process.exit(1);
}

console.error(`[assert-pack] OK: ${files.length} files, all required entries present`);
