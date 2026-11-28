/**
 * The `additional_metadata` a Slack-plus-GitHub connector row carries: 13 keys
 * and about 650 characters of JSON. `n` keeps every row's values distinct, so a
 * response that mixed rows up cannot pass.
 */
export function connectorMetadata(n: number): Record<string, string | number> {
	const ts = `1732780000.${String(100 + n).padStart(6, "0")}`;

	return {
		app_provider: "slack",
		connector_id: "conn_01HZXE2EABCDEFGHJKMNPQRSTV",
		workspace_id: "T0E2E1234567",
		channel_id: "C0E2E1234567",
		channel_name: "payments-oncall-escalations-emea",
		slack_ts: ts,
		thread_ts: "1732779000.000050",
		author_name: "Ada Lovelace (Payments SRE team)",
		author_email: "ada.lovelace@payments.example.com",
		permalink: `https://example.slack.com/archives/C0E2E1234567/p${ts.replace(".", "")}?thread_ts=1732779000.000050&cid=C0E2E1234567`,
		github_repo: "hydra-db/hydradb-application",
		github_issue_number: 4200 + n,
		github_issue_url: `https://github.com/hydra-db/hydradb-application/issues/${4200 + n}#issuecomment-1732780000`,
	};
}

/**
 * The rows a listing printed, by id. A row starts at `N. [id]` and runs to the
 * next one, so a key found in a row's block was printed for that row.
 */
export function listedRows(text: string): Map<string, string> {
	const rows = new Map<string, string>();
	const starts = [...text.matchAll(/^\d+\. \[([^\]]+)\]/gm)];

	for (const [index, match] of starts.entries()) {
		const end = starts[index + 1]?.index ?? text.length;

		rows.set(match[1], text.slice(match.index, end));
	}

	return rows;
}

/** Every key of `expected` that the row's text does not print with its exact JSON value. */
export function missingInText(row: string, expected: Record<string, unknown>): string[] {
	return Object.entries(expected)
		.filter(([key, value]) => !row.includes(`"${key}":${JSON.stringify(value)}`))
		.map(([key]) => key);
}

/** Every key of `expected` that `actual` lacks or holds with another value. */
export function missingInObject(actual: unknown, expected: Record<string, unknown>): string[] {
	const record = actual != null && typeof actual === "object" ? (actual as Record<string, unknown>) : {};

	return Object.entries(expected)
		.filter(([key, value]) => JSON.stringify(record[key]) !== JSON.stringify(value))
		.map(([key]) => key);
}

/** Keys the API accepts on each `document_metadata` item of `POST /context/ingest` (`knownUploadItemKeys`). */
export const DOCUMENT_METADATA_KEYS = new Set([
	"id",
	"source_id",
	"file_id",
	"infer",
	"metadata",
	"additional_metadata",
	"document_metadata",
	"relations",
	"evidence_kind",
	"evidence_subject",
]);

/**
 * Keys of a `memories` item the API decodes (`memories.MemoryItem`). The decoder
 * drops any other key without an error, so a misspelt key loses data silently.
 */
export const MEMORY_ITEM_KEYS = new Set([
	"source_id",
	"title",
	"text",
	"user_assistant_pairs",
	"is_markdown",
	"infer",
	"custom_instructions",
	"user_name",
	"observation_date",
	"evidence_kind",
	"evidence_subject",
	"metadata",
	"additional_metadata",
]);

/** Body keys of `PATCH /context/{id}/metadata` (`contextMetadataUpdateRequest`), deprecated aliases left out. */
export const UPDATE_BODY_KEYS = new Set(["database", "collection", "database_metadata", "additional_metadata", "acl", "acl_inherit"]);

/** Body keys of `POST /feedback` (`feedback.Request`), deprecated aliases left out. */
export const FEEDBACK_BODY_KEYS = new Set(["request_id", "feedback", "rating", "source", "ground_truth", "database", "collection", "metadata"]);
