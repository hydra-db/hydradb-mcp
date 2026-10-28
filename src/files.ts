/**
 * Files an agent hands to `hydradb_ingest`: PDF, Word, slides, spreadsheets,
 * images and text, uploaded as `documents` on POST /context/ingest.
 *
 * Two ways in:
 *
 * - `content_base64`, on every transport. The hosted server cannot read the
 *   user's disk, so there the bytes have to travel in the tool call. They pass
 *   through the conversation as base64, so the limit is lower than the API's.
 * - `path`, on the local (stdio) server only. That server runs as the user on
 *   their own machine, so reading a file the agent names is access the agent
 *   already has; and the bytes go straight to Hydra DB instead of through the
 *   model's context, so the API's own 50 MB limit applies. The hosted server
 *   refuses it: there a path would name a file on the SERVER's disk.
 *
 * Every check here runs before the upload, so an unusable file fails with a
 * message naming the problem instead of a remote error after the bytes moved.
 */

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join } from "node:path";

/** The API's per-file limit for `documents` (413 above it). */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/**
 * The limit for a file sent inline as base64. As base64 it is a third larger,
 * and it rides in the tool call's JSON body, which the hosted server caps.
 */
export const MAX_INLINE_FILE_BYTES = 8 * 1024 * 1024;

/**
 * What POST /context/ingest reads through `documents`, by extension, with the
 * content type sent alongside. The server goes by extension first.
 */
const CONTENT_TYPES = new Map<string, string>([
	[".pdf", "application/pdf"],
	[".doc", "application/msword"],
	[".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
	[".docm", "application/vnd.ms-word.document.macroEnabled.12"],
	[".dot", "application/msword"],
	[".dotx", "application/vnd.openxmlformats-officedocument.wordprocessingml.template"],
	[".odt", "application/vnd.oasis.opendocument.text"],
	[".ott", "application/vnd.oasis.opendocument.text-template"],
	[".rtf", "application/rtf"],
	[".xls", "application/vnd.ms-excel"],
	[".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
	[".xlsm", "application/vnd.ms-excel.sheet.macroEnabled.12"],
	[".xlsb", "application/vnd.ms-excel.sheet.binary.macroEnabled.12"],
	[".ods", "application/vnd.oasis.opendocument.spreadsheet"],
	[".ots", "application/vnd.oasis.opendocument.spreadsheet-template"],
	[".csv", "text/csv"],
	[".tsv", "text/tab-separated-values"],
	[".ppt", "application/vnd.ms-powerpoint"],
	[".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
	[".pptm", "application/vnd.ms-powerpoint.presentation.macroEnabled.12"],
	[".odp", "application/vnd.oasis.opendocument.presentation"],
	[".otp", "application/vnd.oasis.opendocument.presentation-template"],
	[".pages", "application/vnd.apple.pages"],
	[".numbers", "application/vnd.apple.numbers"],
	[".key", "application/vnd.apple.keynote"],
	[".png", "image/png"],
	[".jpg", "image/jpeg"],
	[".jpeg", "image/jpeg"],
	[".tif", "image/tiff"],
	[".tiff", "image/tiff"],
	[".webp", "image/webp"],
	[".gif", "image/gif"],
	[".bmp", "image/bmp"],
	[".txt", "text/plain"],
	[".md", "text/markdown"],
	[".markdown", "text/markdown"],
	[".json", "application/json"],
]);

export const SUPPORTED_EXTENSIONS = [...CONTENT_TYPES.keys()];

/** A file ready to upload. */
export interface IngestFile {
	data: Buffer;
	filename: string;
	contentType: string;
}

function megabytes(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The content type for `filename`, or a refusal naming what is accepted. */
export function contentTypeFor(filename: string): string {
	const ext = extname(filename).toLowerCase();
	const type = CONTENT_TYPES.get(ext);

	if (type != null) return type;

	throw new Error(
		`"${filename}" ${ext === "" ? "has no file extension" : `is a ${ext} file, which Hydra DB cannot read`}. ` +
		`Supported: ${SUPPORTED_EXTENSIONS.join(" ")}. Convert it (for example to PDF) and send that.`,
	);
}

/**
 * Decode inline base64, refusing anything over the inline limit BEFORE the
 * bytes are decoded, so an oversized file costs a length check, not a buffer.
 * A `data:` URL prefix is accepted, since that is how many tools hand files out.
 */
export function decodeInline(filename: string, contentBase64: string): IngestFile {
	const contentType = contentTypeFor(filename);
	const payload = contentBase64.replace(/^data:[^,]*;base64,/, "").replace(/\s+/g, "");

	if (payload === "") throw new Error(`content_base64 for "${filename}" is empty.`);

	if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(payload)) {
		throw new Error(`content_base64 for "${filename}" is not valid base64.`);
	}

	const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
	const size = Math.floor((payload.length * 3) / 4) - padding;

	if (size > MAX_INLINE_FILE_BYTES) {
		throw new Error(
			`"${filename}" is ${megabytes(size)}; a file sent inline as content_base64 can be at most ` +
			`${megabytes(MAX_INLINE_FILE_BYTES)}. Split it into smaller files` +
			`, or on the local (stdio) server pass its \`path\` instead (up to ${megabytes(MAX_FILE_BYTES)}).`,
		);
	}

	return { data: Buffer.from(payload, "base64"), filename, contentType };
}

/**
 * Read a local file for the stdio server. The path must be absolute (or start
 * with `~/`): the server's working directory is not the agent's, so a relative
 * path could name a different file than the one meant.
 */
export async function readLocal(path: string, filename?: string): Promise<IngestFile> {
	const resolved = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;

	if (!isAbsolute(resolved)) {
		throw new Error(`path must be absolute (or start with ~/), got "${path}".`);
	}

	const name = filename ?? basename(resolved);
	const contentType = contentTypeFor(name);

	const info = await stat(resolved).catch(() => {
		throw new Error(`No readable file at "${path}".`);
	});

	if (!info.isFile()) throw new Error(`"${path}" is not a file.`);

	if (info.size > MAX_FILE_BYTES) {
		throw new Error(
			`"${name}" is ${megabytes(info.size)}; Hydra DB accepts files up to ${megabytes(MAX_FILE_BYTES)}. ` +
			"Split it into smaller files.",
		);
	}

	if (info.size === 0) throw new Error(`"${path}" is empty.`);

	return { data: await readFile(resolved), filename: name, contentType };
}
