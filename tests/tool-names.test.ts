import { test } from "node:test";
import assert from "node:assert/strict";

import { SERVER_INSTRUCTIONS, TOOL_DESCRIPTIONS } from "../src/descriptions.js";
import { TOOL_NAMES } from "../src/tool-names.js";

test("all tool names are unique", () => {
	const names = Object.values(TOOL_NAMES);
	const unique = new Set(names);
	assert.equal(unique.size, names.length);
});

test("all tool names have corresponding descriptions", () => {
	for (const toolName of Object.values(TOOL_NAMES)) {
		assert.ok(
			toolName in TOOL_DESCRIPTIONS,
			`Missing description for tool: ${toolName}`,
		);
	}
});

test("server instructions reference all configured tools", () => {
	for (const toolName of Object.values(TOOL_NAMES)) {
		assert.match(
			SERVER_INSTRUCTIONS,
			new RegExp(toolName),
			`Server instructions should mention ${toolName}`,
		);
	}
});


// The instructions were a routing table — half of it an alias inventory — and
// never said WHEN to call anything. A memory server whose instructions never say
// "recall first" gets used only when the user types "remember this", which is
// the difference between a memory product and a note-taking tool.
test("server instructions direct proactive recall and proactive save", () => {
	const text = SERVER_INSTRUCTIONS.toLowerCase();

	// Recall before answering, not only on request.
	assert.match(text, /before answering/);
	assert.match(text, /unsure/, "the unsure case is where recall is most often skipped");

	// Save without being asked.
	assert.match(text, /without being asked/);
	assert.match(text, /distilled fact/, "storing transcripts instead of facts is the failure mode");

	// The boundary matters as much as the encouragement.
	assert.match(text, /never store secrets|never store secrets, credentials/);

	// Ids compose; inventing them is the documented hazard.
	assert.match(text, /never invent one/);
});

test("tool descriptions carry worked examples", () => {
	for (const name of [TOOL_NAMES.QUERY, TOOL_NAMES.INGEST]) {
		const description = TOOL_DESCRIPTIONS[name].description;
		assert.match(
			description,
			/Examples:/,
			`${name} should show at least one worked call — a polymorphic or mode-flagged tool is where examples pay off most`,
		);
		// Examples must be valid JSON objects, or they teach the wrong shape.
		const lines = description
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.startsWith("{"));
		assert.ok(lines.length > 0, `${name} example block should contain call objects`);
		for (const line of lines) {
			assert.doesNotThrow(
				() => JSON.parse(line),
				`${name} example is not valid JSON: ${line}`,
			);
		}
	}
});
