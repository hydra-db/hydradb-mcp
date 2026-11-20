import { z } from "zod";
import { jsonValue } from "./adapters.js";

const fieldOptions = z.object({
	type: z.string().trim().min(1),
	description: z.string().max(500).optional(),
	required: z.boolean().optional(),
	date_order: z.enum(["DMY", "MDY", "YMD"]).optional(),
	enum: z.array(z.string().max(100)).max(100).optional(),
}).strict();

export const recordTypeSchema = z.union([
	z.string().trim().min(1),
	z.object({
		name: z.string().trim().min(1),
		description: z.string().max(500).optional(),
		fields: z.union([
			z.record(z.union([z.string().trim().min(1), fieldOptions])),
			z.array(fieldOptions.extend({ name: z.string().trim().min(1) })).min(1).max(64),
		]),
	}).strict(),
]);

export type IngestRecordType = z.infer<typeof recordTypeSchema>;

export function serializeRecordType(recordType: IngestRecordType): string {
	const name = recordTypeSchema.options[0].safeParse(recordType);

	return name.success ? name.data : JSON.stringify(recordType);
}

export const tableExtractionSchema = z.object({
	status: z.enum(["unverified", "partial"]),
	method: z.string().optional(),
	reason: z.string().optional(),
	pages: z.array(z.number()).optional(),
	rows_recovered: z.number().optional(),
	rows_matched: z.number().optional(),
	uncaptured_rows: z.number().optional(),
});

export const recordTypeReportSchema = z.object({
	record_type: z.string(),
	records: z.number(),
	rejected: z.number(),
	tables: z.array(z.unknown()),
});

export interface TableInspectionReports {
	record_type_report?: z.infer<typeof recordTypeReportSchema>;
	table_extraction?: z.infer<typeof tableExtractionSchema>;
}

export const tableQuerySchema = z.object({
	status: z.literal("ok"),
	answer_type: z.enum(["exact", "computed"]).optional(),
	records: z.array(z.record(jsonValue)),
	truncated: z.boolean().optional(),
	extraction_status: tableExtractionSchema.shape.status.optional(),
	sources: z.array(z.object({
		id: z.string(),
		collection: z.string(),
		title: z.string().optional(),
		sheet: z.string().optional(),
	}).passthrough()).optional(),
	citations: z.object({
		rows: z.array(z.object({ source_id: z.string(), row: z.number().optional() }).passthrough()),
	}).passthrough().optional(),
}).passthrough();

export function renderTableQuery(table: z.infer<typeof tableQuerySchema>): string {
	const lines = ["Table query", `${table.records.length} result rows.`];

	if (table.extraction_status != null) {
		lines.push(table.extraction_status === "partial"
			? "Table import was partial. This result only covers imported rows and may omit source data."
			: "PDF table coverage is unverified. This result covers imported rows.");
	}

	let shortened = table.records.length > 10;

	for (const [index, record] of table.records.slice(0, 10).entries()) {
		const line = JSON.stringify(record);
		const reference = table.answer_type === "exact" ? table.citations?.rows[index] : undefined;
		const citation = reference?.row == null ? "" : ` [source ${reference.source_id}, row ${reference.row}]`;

		shortened ||= line.length > 800;
		lines.push(`${line.length <= 800 ? line : `${line.slice(0, 800)}…`}${citation}`);
	}

	if (shortened) {
		lines.push("The text preview is shortened. Use structured: true for the full returned records.");
	}

	if (table.truncated) lines.push("The API omitted additional result rows.");

	for (const source of table.sources?.slice(0, 8) ?? []) {
		lines.push(`Source ${JSON.stringify(source.title ?? source.id)} [id: ${source.id}, collection: ${source.collection}]`);
	}

	if ((table.sources?.length ?? 0) > 8) lines.push("Use structured: true for the full source list.");

	return lines.join("\n");
}
