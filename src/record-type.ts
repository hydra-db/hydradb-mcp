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

const tableRecordSchema = z.record(jsonValue);
const tableRecord = z.custom<z.infer<typeof tableRecordSchema>>((value) => tableRecordSchema.safeParse(value).success);
const tableValue = z.custom<z.infer<typeof jsonValue>>((value) => jsonValue.safeParse(value).success);

export const tableQuerySchema = z.object({
	status: z.literal("ok"),
	answer_type: z.enum(["exact", "computed"]).optional(),
	records: z.array(tableRecord),
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
	const rows = z.array(tableValue).safeParse(table.rows);
	const count = Math.max(table.records.length, rows.success ? rows.data.length : 0);
	const lines = ["Table query", `${count} result rows.`];

	if (table.extraction_status != null) {
		lines.push(table.extraction_status === "partial"
			? "Table import was partial. This result only covers imported rows and may omit source data."
			: "PDF table coverage is unverified. This result covers imported rows.");
	}

	let length = lines.join("\n").length;
	const append = (line: string) => {
		if (length + line.length + 1 > 11800) return false;
		lines.push(line);
		length += line.length + 1;
		return true;
	};
	let shown = 0;

	for (let index = 0; index < Math.min(count, 10); index++) {
		const record = rows.success ? { row: rows.data[index], record: table.records[index] } : table.records[index];
		const line = JSON.stringify(record);
		const reference = table.answer_type === "exact" ? table.citations?.rows[index] : undefined;
		const citation = reference?.row == null ? "" : ` [source ${reference.source_id}, row ${reference.row}]`;

		if (line.length <= 800 && append(`Row ${index + 1}: ${line}${citation}`)) shown++;
	}

	if (shown < count) {
		lines.push(`(${count - shown} rows omitted)`);
		lines.push("The text preview is shortened. Use structured: true for the full returned records.");
	}

	if (table.truncated) lines.push("The API omitted additional result rows.");

	let shownSources = 0;
	for (const source of table.sources?.slice(0, 8) ?? []) {
		if (append(`Source ${JSON.stringify(source.title ?? source.id)} [id: ${source.id}, collection: ${source.collection}]`)) shownSources++;
	}

	if ((table.sources?.length ?? 0) > shownSources) lines.push("Use structured: true for the full source list.");

	return lines.join("\n");
}
