import type {
	PathTriplet,
	RecallResponse,
	ScoredPath,
} from "./types.js";

/**
 * A chunk's readable text, unwrapping the v2 source envelope when present.
 *
 * Ingest can store a chunk whose body is the serialised source record rather
 * than the text itself:
 *
 *     {"id":"s9","tenant_id":"t","content":{"text":"the actual body"}}
 *
 * Rendered verbatim, that ships ids, tenant identifiers and JSON punctuation
 * into the prompt in place of the content, and the reader has to parse it back
 * out. The SDK's own renderer unwraps this (`dist/helpers/buildString.js`);
 * this port keeps the behaviour without taking the rest of that helper, which
 * drops the evidence-score filter, extra context and `raw_predicate` handling
 * below.
 *
 * The wire format is snake_case regardless of SDK casing, so the keys checked
 * here are the wire ones. Anything that does not match the envelope shape is
 * returned untouched — a chunk that legitimately begins and ends with braces is
 * left alone.
 */
function extractChunkText(chunkContent: string | undefined): string {
	if (!chunkContent) return "";
	const trimmed = chunkContent.trim();
	if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return trimmed;

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return trimmed;
	}
	if (typeof parsed !== "object" || parsed === null) return trimmed;

	// A nested `content.text` is not enough to call something an envelope. A
	// user can legitimately store a JSON document that happens to have that
	// shape, and unwrapping it would silently discard every sibling and outer
	// field — turning a stored document into one of its fragments. Require an
	// identifying field from the source record as well, so this only fires on
	// what it was written for.
	const record = parsed as Record<string, unknown>;
	const looksLikeSource = ["id", "tenant_id", "source_id", "chunk_id"].some(
		(key) => typeof record[key] === "string",
	);
	if (!looksLikeSource) return trimmed;

	const content = record.content;
	if (typeof content === "object" && content !== null) {
		for (const key of ["text", "markdown"] as const) {
			const value = (content as Record<string, unknown>)[key];
			if (typeof value === "string" && value.trim()) return value.trim();
		}
	}
	return trimmed;
}

function formatTriplet(triplet: PathTriplet): string {
	const src = triplet.source?.name ?? "?";
	const rel = triplet.relation;
	const predicate =
		rel?.raw_predicate ?? rel?.canonical_predicate ?? "related to";
	const tgt = triplet.target?.name ?? "?";
	const ctx = rel?.context ? ` [${rel.context}]` : "";
	return `  (${src}) —[${predicate}]→ (${tgt})${ctx}`;
}

export function buildRecalledContext(
	response: RecallResponse,
	opts?: {
		maxGroupOccurrences?: number;
		minEvidenceScore?: number;
	},
): string {
	const minScore = opts?.minEvidenceScore ?? 0.4;
	const maxGroupOccurrences = opts?.maxGroupOccurrences;

	const chunks = response.chunks ?? [];
	const graphCtx = response.graph_context ?? {
		query_paths: [],
		chunk_relations: [],
		chunk_id_to_group_ids: {},
	};
	const extraContextMap = response.additional_context ?? {};

	const rawRelations: ScoredPath[] = graphCtx.chunk_relations ?? [];
	const relationIndex: Record<string, ScoredPath> = {};

	for (let idx = 0; idx < rawRelations.length; idx++) {
		const relation = rawRelations[idx]!;
		if ((relation.relevancy_score ?? 0) < minScore) continue;
		const groupId = relation.group_id ?? `p_${idx}`;
		relationIndex[groupId] = relation;
	}

	// Direct chunk → relation links, the mapping the server states explicitly and
	// the one the SDK's own renderer reaches for first. Without it this renderer
	// had only the indirect route (group_id + chunk_id_to_group_ids) and the
	// triplet.chunk_id scan, so any relation the server linked ONLY via
	// source_chunk_ids was silently dropped from the output.
	const directRelations: Record<string, [string, ScoredPath][]> = {};
	for (const [groupId, relation] of Object.entries(relationIndex)) {
		for (const chunkId of relation.source_chunk_ids ?? []) {
			const bucket = directRelations[chunkId];
			if (bucket) bucket.push([groupId, relation]);
			else directRelations[chunkId] = [[groupId, relation]];
		}
	}

	const chunkToGroupIds = graphCtx.chunk_id_to_group_ids ?? {};
	const consumedExtraIds = new Set<string>();
	const groupOccurrenceCounts: Record<string, number> = {};
	const chunkSections: string[] = [];

	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i]!;
		const lines: string[] = [];

		// The id rides in the chunk header because this block is what a caller
		// actually reads. Without it a recall result is unactionable: there is no
		// value anywhere in the output that `hydradb_inspect` or `hydradb_delete`
		// will accept, so a follow-up means guessing an id or listing everything
		// and matching on prose.
		const chunkId = chunk.source_id;
		lines.push(`Chunk ${i + 1}${chunkId ? `  [id: ${chunkId}]` : ""}`);

		const meta = chunk.document_metadata ?? {};
		const title =
			chunk.source_title || (meta as Record<string, string>).title;
		if (title) {
			lines.push(`Source: ${title}`);
		}

		lines.push(extractChunkText(chunk.chunk_content));

		const chunkUuid = chunk.chunk_uuid;
		const linkedGroupIds = chunkToGroupIds[chunkUuid] ?? [];

		const matchedRelations: ScoredPath[] = [];

		/** Take a relation for this chunk unless its group is already capped. */
		const take = (gid: string, relation: ScoredPath) => {
			const occurrences = groupOccurrenceCounts[gid] ?? 0;
			if (maxGroupOccurrences == null || occurrences < maxGroupOccurrences) {
				matchedRelations.push(relation);
				groupOccurrenceCounts[gid] = occurrences + 1;
			}
		};

		// Preferred route: the server said which chunks this relation came from.
		const direct = directRelations[chunkUuid] ?? [];
		for (const [gid, relation] of direct) {
			take(gid, relation);
		}

		// Track whether a lookup found any candidate groups (even if all were
		// capped) to avoid incorrectly falling through to the fallback path
		const hasLinkedGroups = linkedGroupIds.some(
			(gid) => !!relationIndex[gid],
		);

		// Indirect route, used only when the direct one produced no candidates —
		// running both would attach the same relation twice.
		if (direct.length === 0) {
			for (const gid of linkedGroupIds) {
				if (relationIndex[gid]) {
					take(gid, relationIndex[gid]!);
				}
			}
		}

		if (
			matchedRelations.length === 0 &&
			!hasLinkedGroups &&
			direct.length === 0
		) {
			for (const [gid, rel] of Object.entries(relationIndex)) {
				const triplets = rel.triplets ?? [];
				const hasChunk = triplets.some(
					(t) => t.relation?.chunk_id === chunkUuid,
				);
				if (hasChunk) {
					const occurrences = groupOccurrenceCounts[gid] ?? 0;
					if (
						maxGroupOccurrences == null ||
						occurrences < maxGroupOccurrences
					) {
						matchedRelations.push(rel);
						groupOccurrenceCounts[gid] = occurrences + 1;
					}
				}
			}
		}

		const relationLines: string[] = [];
		for (const rel of matchedRelations) {
			const triplets = rel.triplets ?? [];
			if (triplets.length > 0) {
				for (const triplet of triplets) {
					relationLines.push(formatTriplet(triplet));
				}
			} else if (rel.combined_context) {
				relationLines.push(`  ${rel.combined_context}`);
			}
		}

		if (relationLines.length > 0) {
			lines.push("Graph Relations:");
			lines.push(...relationLines);
		}

		const extraIds = chunk.extra_context_ids ?? [];
		if (extraIds.length > 0 && Object.keys(extraContextMap).length > 0) {
			const extraLines: string[] = [];
			for (const ctxId of extraIds) {
				if (consumedExtraIds.has(ctxId)) continue;
				const extraChunk = extraContextMap[ctxId];
				if (extraChunk) {
					consumedExtraIds.add(ctxId);
					const extraContent = extractChunkText(extraChunk.chunk_content);
					const extraTitle = extraChunk.source_title ?? "";
					if (extraTitle) {
						extraLines.push(
							`  Related Context (${extraTitle}): ${extraContent}`,
						);
					} else {
						extraLines.push(`  Related Context: ${extraContent}`);
					}
				}
			}
			if (extraLines.length > 0) {
				lines.push("Extra Context:");
				lines.push(...extraLines);
			}
		}

		chunkSections.push(lines.join("\n"));
	}

	const entityPathLines: string[] = [];
	const rawPaths: ScoredPath[] = graphCtx.query_paths ?? [];
	for (const path of rawPaths) {
		if (path.combined_context) {
			entityPathLines.push(path.combined_context);
		} else {
			const triplets = path.triplets ?? [];
			const segments: string[] = [];
			for (const pt of triplets) {
				const s = pt.source?.name;
				const rel = pt.relation;
				const p =
					rel?.raw_predicate ??
					rel?.canonical_predicate ??
					"related to";
				const t = pt.target?.name;
				segments.push(`(${s} -> ${p} -> ${t})`);
			}
			if (segments.length > 0) {
				entityPathLines.push(segments.join(" -> "));
			}
		}
	}

	const output: string[] = [];

	if (entityPathLines.length > 0) {
		output.push("=== ENTITY PATHS ===");
		output.push(entityPathLines.join("\n"));
		output.push("");
	}

	if (chunkSections.length > 0) {
		output.push("=== CONTEXT ===");
		output.push(chunkSections.join("\n\n---\n\n"));
	}

	return output.join("\n");
}

