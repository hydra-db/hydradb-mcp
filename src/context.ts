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

	// Unwrap ONLY when nothing would be lost by doing so.
	//
	// A nested `content.text` is not evidence of an envelope, and neither is an
	// `id` alongside it — a user can legitimately store
	// `{"id":"cfg","content":{"text":"..."},"version":2}`, and unwrapping that
	// discards `version` silently, turning a stored document into one of its
	// fragments. So instead of guessing what an envelope looks like, check the
	// inverse: every key we are about to drop must be one the envelope is known
	// to carry. An unrecognised sibling means this is someone's document, and it
	// is returned untouched.
	//
	// The asymmetry is deliberate. Leaving a real envelope wrapped is ugly;
	// unwrapping a real document destroys data.
	const record = parsed as Record<string, unknown>;
	// Only SCOPING keys. These are identifiers the server stamps on a record;
	// they carry nothing the user wrote, so discarding them loses nothing.
	//
	// The previous allowlist also contained `title`, `metadata`, `timestamp` and
	// friends. Those ARE envelope fields, but they also carry user data — so a
	// document with any of them populated was being reduced to its content.text
	// and the rest silently dropped. Three rounds of narrowing the guess did not
	// fix that, because the premise was wrong: the test cannot be "does this look
	// like an envelope", it has to be "is there anything here to lose".
	const SCOPING_KEYS = new Set([
		"content",
		"id",
		"tenant_id",
		"sub_tenant_id",
		"source_id",
		"chunk_id",
	]);

	// Any other key holding an actual value means this is someone's document.
	// Empty strings, nulls and empty objects are not data, so a bare envelope
	// carrying `"title": ""` still unwraps.
	const hasData = (value: unknown): boolean => {
		if (value == null) return false;
		if (typeof value === "string") return value.trim() !== "";
		if (Array.isArray(value)) return value.length > 0;
		if (typeof value === "object") return Object.keys(value).length > 0;
		return true;
	};
	const wouldLoseSomething = Object.entries(record).some(
		([key, value]) => !SCOPING_KEYS.has(key) && hasData(value),
	);
	if (wouldLoseSomething) return trimmed;

	// And require a field that is unambiguously OURS. `id` alone is not — a
	// user's own document can carry one. `tenant_id`/`sub_tenant_id` are internal
	// scoping fields the server stamps on; a hand-written document has neither.
	const looksLikeSource = ["tenant_id", "sub_tenant_id"].some(
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

/**
 * Normalised form for comparing two bodies. Retrieval returns overlapping
 * windows over the same source, and they rarely differ by more than whitespace.
 */
function normalise(text: string): string {
	return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Chunk indices whose body is wholly contained in another chunk's body.
 *
 * The API returns overlapping windows, so a short chunk is frequently a literal
 * substring of a longer one — in a live 15-chunk sample, 4 were fully contained
 * in another, roughly a quarter of the body re-sent for nothing.
 *
 * Ties are resolved by keeping the earlier (higher-ranked) chunk, and identical
 * bodies collapse to one. O(n^2) over at most 50 items is free.
 */
function containedChunkIndices(
	bodies: string[],
	sourceIds: (string | undefined)[],
): Map<number, number> {
	const normalised = bodies.map(normalise);
	/** duplicate chunk index -> the 1-based chunk number holding the same text. */
	const dropped = new Map<number, number>();

	for (let i = 0; i < normalised.length; i++) {
		if (dropped.has(i)) continue;
		const a = normalised[i]!;
		if (a === "") continue;
		for (let j = 0; j < normalised.length; j++) {
			if (i === j || dropped.has(j)) continue;
			const b = normalised[j]!;
			if (b === "") continue;

			// Only within ONE source. Two different sources can legitimately hold
			// the same sentence — a policy quoted in two documents, the same fact
			// recorded twice — and suppressing one of those does not remove
			// duplication, it removes a MATCH: its id, score and graph relations
			// all disappear, and the caller can no longer discover that source.
			// The duplication this exists to remove is the overlapping windows
			// retrieval returns over a single source.
			const sameSource =
				sourceIds[i] != null && sourceIds[i] === sourceIds[j];
			if (!sameSource) continue;

			// Point BACKWARDS only. Truncation drops sections from the end, so a
			// pointer to an earlier chunk always resolves; one aimed forward can
			// name a chunk the budget removed, leaving the caller told the text is
			// in "Chunk 12" when there is no Chunk 12.
			if (i >= j) continue;
			// Keep the longer body; on an exact tie keep whichever ranked first.
			const keepsI = a.length > b.length || (a.length === b.length && i < j);
			if (keepsI && a.includes(b)) dropped.set(j, i + 1);
		}
	}
	return dropped;
}

/**
 * How many chunks the renderer will actually emit.
 *
 * The caller needs this for its "Found N" header. Reporting the raw chunk count
 * there while the body shows fewer is the same disagreement the removed summary
 * block had, reintroduced by deduping.
 */
export function renderedChunkCount(response: RecallResponse): number {
	const chunks = response.chunks ?? [];
	const contained = containedChunkIndices(
		chunks.map((c) => extractChunkText(c.chunk_content)),
		chunks.map((c) => c.source_id),
	);
	// Every chunk is still rendered; only duplicated BODIES are collapsed.
	return chunks.length;
}

/**
 * Render, and report how many chunks the caller can actually see.
 *
 * `buildRecalledContext` returns only the text, so a caller counting chunks had
 * to compute that separately — and any count computed before the total-character
 * budget applies overstates what survived it. The header and the body must
 * describe the same thing.
 */
/** Room reserved for the truncation notice itself, so it also fits. */
const TRUNCATION_NOTE_ALLOWANCE = 240;

export function renderRecalledContext(
	response: RecallResponse,
	opts?: Parameters<typeof buildRecalledContext>[1],
): { text: string; shown: number } {
	// The count comes from the renderer, which knows exactly how many sections it
	// emitted. Deriving it by matching /^Chunk \d+/ over the finished text meant a
	// stored body containing a line like "Chunk 5 of the manual" was counted as a
	// rendered section, so `Found N` announced more matches than existed — the
	// same header/body disagreement this PR removed, reintroduced by the fix for
	// it.
	return render(response, opts);
}

export function buildRecalledContext(
	response: RecallResponse,
	opts?: Parameters<typeof render>[1],
): string {
	return render(response, opts).text;
}

function render(
	response: RecallResponse,
	opts?: {
		maxGroupOccurrences?: number;
		minEvidenceScore?: number;
		/**
		 * Per-chunk body ceiling. Unset renders every chunk in full, which is what
		 * `detail: "full"` asks for.
		 */
		maxChunkChars?: number;
		/** Drop the Extra Context blocks entirely (compact mode). */
		includeExtraContext?: boolean;
		/** Total character ceiling for the whole rendering. */
		maxTotalChars?: number;
	},
): { text: string; shown: number } {
	const minScore = opts?.minEvidenceScore ?? 0.4;
	const maxGroupOccurrences = opts?.maxGroupOccurrences;
	const maxChunkChars = opts?.maxChunkChars;
	const includeExtraContext = opts?.includeExtraContext ?? true;

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

	// Suppress chunks wholly contained in another chunk before rendering any of
	// them, so the numbering reflects what the caller actually receives.
	// Body collapsing is disabled when per-chunk trimming is on. Compact mode
	// already caps each body, so the duplication it would remove is small — and
	// the pointer could name a chunk whose RENDERED body was cut before the
	// shared text, promising content no rendered chunk actually contains.
	const contained =
		maxChunkChars == null
			? containedChunkIndices(
					chunks.map((c) => extractChunkText(c.chunk_content)),
					chunks.map((c) => c.source_id),
				)
			: new Map<number, number>();
	// Extra context is deduped by CONTENT as well as by id: the same passage
	// arrives under different ids, and an id-keyed check never notices.
	// Maps a passage to the chunk number that already rendered it, so a later
	// chunk can point at it instead of either repeating it or losing the
	// association entirely.
	const seenExtraContent = new Map<string, number>();

	let rendered = 0;
	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i]!;
		rendered++;
		// A contained chunk is rendered, but its BODY is replaced with a pointer.
		// Only the text is duplicated: the id, score, graph relations and
		// extra-context references belong to THIS chunk and exist nowhere else,
		// so dropping the whole section would remove associations rather than
		// repetition — and take a discoverable source id with them.
		const bodyDuplicateOf = contained.get(i);
		const lines: string[] = [];

		// The id rides in the chunk header because this block is what a caller
		// actually reads. Without it a recall result is unactionable: there is no
		// value anywhere in the output that `hydradb_inspect` or `hydradb_delete`
		// will accept, so a follow-up means guessing an id or listing everything
		// and matching on prose.
		const chunkId = chunk.source_id;
		// The score lives here rather than in a separate summary block. It was the
		// only thing that block carried which this one did not, and reproducing it
		// meant re-sending a truncated copy of every chunk body to deliver one
		// percentage per chunk.
		const score =
			chunk.relevancy_score != null
				? `  (${Math.round(chunk.relevancy_score * 100)}%)`
				: "";
		lines.push(`Chunk ${rendered}${chunkId ? `  [id: ${chunkId}]` : ""}${score}`);

		const meta = chunk.document_metadata ?? {};
		const title =
			chunk.source_title || (meta as Record<string, string>).title;
		if (title) {
			lines.push(`Source: ${title}`);
		}

		const bodyText = extractChunkText(chunk.chunk_content);
		if (bodyDuplicateOf != null) {
			lines.push(`(same text as Chunk ${bodyDuplicateOf})`);
		} else
		lines.push(
			maxChunkChars != null && bodyText.length > maxChunkChars
				? `${bodyText.slice(0, maxChunkChars)}… [chunk truncated: ${bodyText.length} chars; ` +
					`use detail:"full" or ${"hydradb_inspect"} for the whole source]`
				: bodyText,
		);

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

		const extraIds = includeExtraContext ? (chunk.extra_context_ids ?? []) : [];
		if (extraIds.length > 0 && Object.keys(extraContextMap).length > 0) {
			const extraLines: string[] = [];
			for (const ctxId of extraIds) {
				if (consumedExtraIds.has(ctxId)) continue;
				const extraChunk = extraContextMap[ctxId];
				if (extraChunk) {
					consumedExtraIds.add(ctxId);
					const extraContent = extractChunkText(extraChunk.chunk_content);
					// Keying only on id let byte-identical passages through under
					// different ids — three ~700-char duplicates in one live sample.
					// The title is part of the key: the same passage attributed to a
					// different source is not a duplicate, it is a second citation,
					// and dropping it would strip that chunk's attribution.
					const fingerprint = `${extraChunk.source_title ?? ""}\u0000${normalise(extraContent)}`;
					// Placement is the ONLY thing tying an extra-context block to its
					// chunk, so suppressing a repeat outright leaves that chunk looking
					// as though it referenced nothing. Cite where it was shown instead:
					// the association survives, and the passage is still sent once.
					const shownIn = fingerprint !== "" ? seenExtraContent.get(fingerprint) : undefined;
					if (shownIn != null) {
						extraLines.push(`  Related Context: (same as Chunk ${shownIn})`);
						continue;
					}
					if (fingerprint !== "") seenExtraContent.set(fingerprint, rendered);
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

	const text = output.join("\n");
	const budget = opts?.maxTotalChars;
	if (budget != null && text.length > budget) {
		// A per-chunk cap does not bound the whole: fifty capped chunks still add
		// up. The total ceiling is the one that actually protects the caller.
		//
		// Cut at a CHUNK boundary, not mid-string. Slicing the joined text can
		// sever a chunk header, leaving a partial `[id: …]` the caller might try
		// to use, and it silently removes whole sections the "Found N" header is
		// still counting. Dropping whole chunks and saying how many were dropped
		// keeps the header and the body describing the same thing.
		// The prefix needs its own ceiling, not just a place in the accounting: a
		// graph-heavy result can produce entity paths that exceed the whole budget
		// on their own, and then no amount of dropping chunks brings the total
		// under it. Half the budget leaves room for the chunks the caller asked
		// for.
		const headBudget = Math.floor(budget / 2);
		let head = "";
		if (entityPathLines.length > 0) {
			const keptPaths: string[] = [];
			let headUsed = "=== ENTITY PATHS ===\n\n".length;
			for (const line of entityPathLines) {
				if (headUsed + line.length + 1 > headBudget) break;
				keptPaths.push(line);
				headUsed += line.length + 1;
			}
			const droppedPaths = entityPathLines.length - keptPaths.length;
			head =
				`=== ENTITY PATHS ===\n${keptPaths.join("\n")}` +
				(droppedPaths > 0 ? `\n[${droppedPaths} more entity path(s) omitted]` : "") +
				"\n\n";
		}
		const kept: string[] = [];
		// The prefix and the framing count against the ceiling too. Budgeting only
		// the chunk sections let a graph-heavy result exceed the documented limit
		// by however large its entity paths happened to be.
		let used = head.length + "=== CONTEXT ===\n".length + TRUNCATION_NOTE_ALLOWANCE;
		const separator = "\n\n---\n\n";
		for (const section of chunkSections) {
			const cost = section.length + (kept.length > 0 ? separator.length : 0);
			if (used + cost > budget) break;
			kept.push(section);
			used += cost;
		}
		const dropped = chunkSections.length - kept.length;
		return {
			text:
				`${head}=== CONTEXT ===\n${kept.join(separator)}\n\n` +
				`[response truncated: showing ${kept.length} of ${chunkSections.length} chunks. ` +
				`${dropped} omitted to stay within ${budget} characters. Narrow the query, lower ` +
				`max_results, or fetch a specific source with hydradb_inspect.]`,
			shown: kept.length,
		};
	}
	return { text, shown: chunkSections.length };
}

