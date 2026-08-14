#!/usr/bin/env node
/**
 * Fail loudly when the test glob matches nothing.
 *
 * `npm test` ran `tsx --test tests/**​/*.test.ts`, and `/bin/sh` — npm's default
 * script shell — does not expand `**`. It passed the pattern through literally,
 * so the runner received a path that matched no file. Node 22 happens to expand
 * globs itself and covered for it; on Node 18 and 20, both of which this package
 * supports and both of which are in the CI matrix, it matched nothing and
 * reported:
 *
 *     ℹ tests 0 / pass 0 / fail 0
 *     EXIT=0
 *
 * A green run that executed nothing is worse than a red one. CI never caught it
 * because CI does not call `npm test` — it inlines `shopt -s globstar` under
 * bash, so the workflow and the script had already drifted apart.
 *
 * This asserts the suite is actually there before the runner starts. It counts
 * files rather than tests because the failure being guarded against is "the
 * glob matched nothing", which is visible before a single test runs.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * List files under `dir`, relative to it, walking subdirectories.
 *
 * Hand-rolled rather than `readdirSync(dir, { recursive: true })`: that option
 * arrived in Node 18.17, and `engines` allows `>=18`. On 18.0-18.16 an unknown
 * option is IGNORED rather than rejected, so the walk would silently flatten to
 * one level and nested test files — the exact thing this guard exists to catch —
 * would become invisible on the very versions where the glob bug bites hardest.
 */
function listFiles(dir, prefix = "") {
	const found = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const rel = prefix ? `${prefix}/${entry}` : entry;
		if (statSync(full).isDirectory()) found.push(...listFiles(full, rel));
		else found.push(rel);
	}
	return found;
}

/** Directories that must contain test files, and how few is suspicious. */
const EXPECTED = [
	{ dir: "tests", suffix: ".test.ts", min: 5 },
	{ dir: "conformance", suffix: ".test.ts", min: 1 },
];

let failed = false;

for (const { dir, suffix, min } of EXPECTED) {
	let files = [];
	try {
		files = listFiles(dir).filter((f) => f.endsWith(suffix));
	} catch (error) {
		console.error(`[assert-test-files] cannot read ${dir}/: ${error.message}`);
		failed = true;
		continue;
	}

	if (files.length < min) {
		console.error(
			`[assert-test-files] ${dir}/ has ${files.length} ${suffix} file(s), expected at least ${min}.\n` +
				`  Either tests were deleted, or the runner's glob no longer matches them.\n` +
				`  Found: ${files.join(", ") || "(none)"}`,
		);
		failed = true;
		continue;
	}

	// A file in a subdirectory will not be matched by the single-star glob the
	// test script uses, so it would silently never run.
	const nested = files.filter((f) => f.includes("/"));
	if (nested.length > 0) {
		console.error(
			`[assert-test-files] ${dir}/ contains nested test files that the test script's ` +
				`glob (${dir}/*${suffix}) will NOT match:\n` +
				nested.map((f) => `  ${join(dir, f)}`).join("\n") +
				`\n  Move them up, or widen the glob in package.json.`,
		);
		failed = true;
	}
}

if (failed) process.exit(1);
