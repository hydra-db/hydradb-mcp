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

