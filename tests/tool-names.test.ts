import { test } from "node:test";
import assert from "node:assert/strict";

import { SERVER_INSTRUCTIONS, TOOL_DESCRIPTIONS } from "../src/descriptions.js";
import {
	CANONICAL_TOOL_NAMES,
	DEPRECATED_TOOL_NAMES,
	TOOL_NAMES,
} from "../src/tool-names.js";

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

// Only the CANONICAL tools. The instructions used to enumerate all seven
// deprecated aliases too, which meant the server taught the model that
// `hydra_db_ingest_conversation` exists before it had even seen the tool list —
// and those names beat the canonical ones on literal match.
test("server instructions reference every canonical tool", () => {
	for (const toolName of CANONICAL_TOOL_NAMES) {
		assert.match(
			SERVER_INSTRUCTIONS,
			new RegExp(toolName),
			`Server instructions should mention ${toolName}`,
		);
	}
});

test("server instructions do not advertise deprecated aliases", () => {
	for (const toolName of DEPRECATED_TOOL_NAMES) {
		assert.doesNotMatch(
			SERVER_INSTRUCTIONS,
			new RegExp(toolName),
			`Server instructions should not name the deprecated ${toolName}`,
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

// The text/turns rule was stated three different ways: the description said
// `turns` "rather than" `text` (a preference), the schema marked both optional
// (both allowed, neither required), and the handler threw on both and on
// neither. The model discovered the real rule only from a runtime error.
test("the text/turns rule is stated identically wherever it appears", () => {
	const ingest = TOOL_DESCRIPTIONS[TOOL_NAMES.INGEST];

	assert.match(ingest.description, /EXACTLY ONE/);
	for (const param of ["text", "turns"] as const) {
		assert.match(
			ingest.params[param],
			/EXACTLY ONE/,
			`${param}'s own description must state the rule, since a model may read it alone`,
		);
	}

	// And it must not describe the two as interchangeable.
	assert.doesNotMatch(
		ingest.description,
		/rather than `text`/,
		"'rather than' reads as a preference between two allowed options",
	);
});
