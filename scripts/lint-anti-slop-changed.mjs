import { execFileSync, spawnSync } from "node:child_process";

const configuredBase = process.env.ANTI_SLOP_BASE ?? "origin/main";

const requestedFiles = process.argv.slice(2);

const extensions = /\.(?:[cm]?[jt]sx?)$/;

function git(args) {
	return execFileSync("git", args, { encoding: "utf8" });
}

function resolveBase() {
	try {
		git(["rev-parse", "--verify", configuredBase]);

		return configuredBase;
	} catch {
		git(["rev-parse", "--verify", "main"]);

		return "main";
	}
}

const base = resolveBase();

const files = (
	requestedFiles.length > 0
		? requestedFiles
		: git(["diff", "--name-only", "--diff-filter=ACMR", base, "--"])
				.split("\n")
				.filter(Boolean)
).filter((file) => extensions.test(file));

if (files.length === 0) {
	console.log("anti-slop: no changed TypeScript or JavaScript files");
	process.exit(0);
}

const changedLines = new Map(files.map((file) => [file, new Set()]));

const diff = git(["diff", "--unified=0", base, "--", ...files]).split("\n");

let currentFile;

let currentLine = 0;

let inHunk = false;

for (const row of diff) {
	if (row.startsWith("+++ b/")) {
		currentFile = row.slice(6);
		inHunk = false;
		continue;
	}

	if (row.startsWith("@@")) {
		const match = row.match(/\+(\d+)(?:,(\d+))?/);

		if (match) {
			currentLine = Number(match[1]);
			inHunk = true;
		}

		continue;
	}

	if (!inHunk || !currentFile || row.startsWith("\\")) continue;

	if (row.startsWith("+") && !row.startsWith("+++")) {
		changedLines.get(currentFile)?.add(currentLine);
		currentLine += 1;
	} else if (!row.startsWith("-") || row.startsWith("---")) {
		currentLine += 1;
	}
}

const result = spawnSync(
	process.platform === "win32" ? "npx.cmd" : "npx",
	["oxlint", "--config", "oxlint.config.ts", "--format", "json", ...files],
	{ encoding: "utf8" },
);

if (result.error) throw result.error;

const report = JSON.parse(result.stdout);

const introduced = report.diagnostics.filter((diagnostic) => {
	if (diagnostic.severity !== "error") return false;
	const line = diagnostic.labels?.[0]?.span?.line;

	return line != null && changedLines.get(diagnostic.filename)?.has(line);
});

for (const diagnostic of introduced) {
	const span = diagnostic.labels[0].span;
	console.error(
		`${diagnostic.filename}:${span.line}:${span.column}: ${diagnostic.code}: ${diagnostic.message}`,
	);
}

if (introduced.length > 0) {
	console.error(`anti-slop: ${introduced.length} error(s) introduced relative to ${base}`);
	process.exit(1);
}

console.log(`anti-slop: no new errors in ${files.length} changed file(s) relative to ${base}`);
