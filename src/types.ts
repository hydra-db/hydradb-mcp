// The ingest result shape the tool layer reports from.
//
// This file used to mirror every recall payload in snake_case so `context.ts`
// could keep its original field names; that renderer now reads SDK types
// directly and those mirrors are gone. What is left is the ingest result, which
// is not a casing mirror — it is the shape the per-item failure reporting reads,
// and the SDK's own type does not distinguish "no error" from an empty string.

export type MemoryResultItem = {
	source_id: string;
	title?: string | null;
	status: string;
	error?: string | null;
	/** Machine-readable classification for `error`, when the server sent one. */
	error_code?: string | null;
	/**
	 * Graph extraction can fail on an item the server otherwise accepted. That
	 * item is stored and findable by text, but unreachable by graph traversal —
	 * a partial success that looks identical to a full one unless reported.
	 */
	relations_error?: string | null;
};

export type AddMemoryResponse = {
	success: boolean;
	message: string;
	results: MemoryResultItem[];
	success_count: number;
	failed_count: number;
};
