import type {
	PathTriplet,
	RecallResponse,
	ScoredPath,
} from "./types.js";

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

const primaryChunkToGroupIds = graphCtx.chunk_id_to_group_ids ?? {};
const chunkToGroupIds: Record<string, Set<string>> = {};
for (const [cid, gids] of Object.entries(primaryChunkToGroupIds)) {
	chunkToGroupIds[cid] = new Set(gids);
}
for (const [gid, rel] of Object.entries(relationIndex)) {
	for (const triplet of rel.triplets ?? []) {
		const cid = triplet.relation?.chunk_id;
		if (cid) {
			(chunkToGroupIds[cid] ??= new Set()).add(gid);
		}
	}
}
// Convert Sets to arrays for downstream compatibility
const chunkToGroupIdsArray: Record<string, string[]> = {};
for (const [cid, set] of Object.entries(chunkToGroupIds)) {
	chunkToGroupIdsArray[cid] = Array.from(set);
}

const consumedExtraIds = new Set<string>();
	const groupOccurrenceCounts: Record<string, number> = {};
	const chunkSections: string[] = [];

	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i]!;
		const lines: string[] = [];

		lines.push(`Chunk ${i + 1}`);

		const meta = chunk.document_metadata ?? {};
		const title =
			chunk.source_title || (meta as Record<string, string>).title;
		if (title) {
			lines.push(`Source: ${title}`);
		}

		lines.push(chunk.chunk_content ?? "");

const chunkUuid = chunk.chunk_uuid;
		const primaryGroupIds = primaryChunkToGroupIds[chunkUuid] ?? [];
		const fallbackGroupIds = chunkToGroupIdsArray[chunkUuid] ?? [];
		const hasLinkedGroups = primaryGroupIds.some((gid) => !!relationIndex[gid]);

		const matchedRelations: ScoredPath[] = [];

		// Only iterate primary groups fallback groups only used if NO primary groups existed
		const groupsToCheck = hasLinkedGroups ? primaryGroupIds : fallbackGroupIds;

		for (const gid of groupsToCheck) {
			if (relationIndex[gid]) {
				const occurrences = groupOccurrenceCounts[gid] ?? 0;
				if (
					maxGroupOccurrences == null ||
					occurrences < maxGroupOccurrences
				) {
					matchedRelations.push(relationIndex[gid]!);
					groupOccurrenceCounts[gid] = occurrences + 1;
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
					const extraContent = extraChunk.chunk_content ?? "";
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

