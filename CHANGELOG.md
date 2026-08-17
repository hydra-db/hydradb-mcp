# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.1] - 2026-08-17

### Fixed

Two parameters added in 1.2.0 could not succeed under any input. Both failed as a
remote 400 on a call the caller had already committed to, so the whole tool call
was lost to a value that had a working form.

- **`operator` on `hydradb_query` failed on every call that set it.** Hydra DB
  honours an operator only when the request also asks for keyword retrieval, and
  this server never sent `query_by` — so the parameter answered
  `400 INVALID_INPUT: operator is only valid with query_by=text` whatever it was
  set to. An operator now carries the retrieval method it requires, and the one
  self-contradicting combination (an operator with explicitly hybrid retrieval)
  is refused here rather than sent out to fail. The cost of that pairing is now
  in the parameter description instead of being discoverable by 400: setting an
  operator turns off the hybrid semantic search this tool otherwise runs, so the
  query matches literal words rather than the concept. The description also stops
  calling `or` the default, which invited callers to pass it redundantly and lose
  semantic matching for nothing. The hybrid-only `alpha` weighting is no longer
  sent on those queries, where there are no two retrieval lanes to weigh.
- **`observation_date` on `hydradb_ingest` documented a format the API
  rejects.** The description asked for an RFC3339 date, which is a date-*time*: a
  model that followed it sent `2026-08-17T00:00:00Z` and lost the entire ingest to
  `400 INVALID_INPUT: … is not a valid ISO-8601 date (want YYYY-MM-DD)`, on a
  value that would have worked as `2026-08-17`. The description and the README now
  state `YYYY-MM-DD` with a worked example, and the schema carries the pattern so
  the constraint reaches the model choosing the value. A date-time is the form a
  model reaches for when writing a date in JSON, so it is accepted and kept as its
  date part — trimmed textually, which keeps the day the caller wrote where
  converting to UTC would move `2026-08-17T23:00:00-08:00` to the 18th and record
  a date nobody named. Anything that is not a date is rejected before the request
  goes out. The deprecated `hydra_db_store` alias held verbatim copies of this
  blurb and the `metadata` one; both now reference the shared text, which is how
  the fix stays fixed.

## [1.2.0] - 2026-08-14

### ⚠️ Migration required if you call the old tool names

The seven deprecated `hydra_db_*` tool aliases are **no longer registered by
default**. If your `mcp.json` still calls them, add one environment variable:

```json
"env": { "HYDRADB_MCP_LEGACY_TOOLS": "1" }
```

Everything else in this release is backward compatible. This is called out first
because a minor version bump under-signals it: the change is breaking for anyone
who has not migrated to the canonical names.

The reason is not only the ~3,500 tokens per conversation the alias manifest
costs (44% of it). The alias names are systematically better literal matches for
how users phrase requests than the canonical names — "search my memory" matches
`hydra_db_search` exactly while `hydradb_query` needs a synonym step — and
picking one costs real capability, since `hydra_db_ingest_conversation` cannot
set `kind`, `overwrite`, `title`, `infer` or `is_markdown`.

Migration table:

| Deprecated | Use instead |
|---|---|
| `hydra_db_search` | `hydradb_query` |
| `hydra_db_store`, `hydra_db_ingest_conversation` | `hydradb_ingest` |
| `hydra_db_list_memories`, `hydra_db_list_sources` | `hydradb_list` |
| `hydra_db_fetch_content` | `hydradb_inspect` |
| `hydra_db_delete_memory` | `hydradb_delete` |

### Other breaking changes

- `kind` is now **required** on `hydradb_list`. It previously defaulted to
  `memory`, so `hydradb_list({})` returned memories only and read as the complete
  inventory — a caller asking "what does Hydra DB have?" never saw the knowledge
  corpus that `hydradb_query` searches by default.
- `hydradb_query` now returns a single context block instead of a summary
  followed by full context. Every chunk body was previously sent twice.
- `hydradb_query` defaults to `detail: "compact"`, which trims each chunk body to
  ~600 characters and omits surrounding-context blocks. Pass `detail: "full"` for
  the previous rendering.

### Added

- **`hydradb_status`** — check whether ingested sources have finished indexing.
  Ingestion is asynchronous, so a query issued immediately after a save can
  legitimately return nothing; this distinguishes "still indexing" from "the save
  failed".
- **Pagination** on `hydradb_list` (`page`, `page_size`), with the response
  stating how much of the corpus it covered.
- **`kind` on `hydradb_ingest`** — knowledge can now be created, not just
  searched, listed, inspected and deleted.
- **Bulk delete** — `hydradb_delete` accepts `ids`, reporting partial removals
  as partial.
- **New query parameters**: `source_ids` (search inside specific documents),
  `metadata_filters`, `num_related_chunks`, `operator`, `mode: "auto"`,
  `detail`.
- **New ingest parameters**: `metadata`, `observation_date`, `overwrite`.
- **`offset`/`limit`/`expiry_seconds`** on `hydradb_inspect`.
- **`structuredContent`** on `hydradb_list`, `hydradb_ingest` and
  `hydradb_delete`, alongside the existing text.
- **Lifecycle handling** — SIGINT/SIGTERM drain in-flight tool calls before
  closing; unhandled rejections and uncaught exceptions are logged and exit
  non-zero.
- **New environment variables**: `HYDRADB_TIMEOUT_SECONDS` (default 30),
  `HYDRADB_MAX_RETRIES` (default 2), `HYDRADB_MCP_LEGACY_TOOLS` (default off).

### Fixed

Most of these returned a success-shaped result while losing or inventing data,
so neither the caller nor the user learned anything had gone wrong.

- **Nothing ever emitted an ID.** Query results carried no value that
  `hydradb_inspect` or `hydradb_delete` would accept, and ingest returned a
  preview of the caller's own text instead of the id the server assigned. Recall
  and follow-up could not compose, and correcting a stored memory was
  unreachable in both directions.
- **A delete that removed nothing reported "not found or already deleted"** — a
  cause never observed, and the reassuring one. A caller that guessed an id read
  it as confirmation that the user's data was gone.
- **The memory listing presented page one as the entire store.** With 4,000
  memories stored, it answered "50 memories:" and page 2 was unreachable through
  the MCP entirely. The source listing printed the corpus-wide total above a
  single page.
- **Per-item ingest failures were discarded.** The server reports which item
  failed and why; the tool reported bare counts, so the only recovery was to
  re-ingest everything — which, since a reused `source_id` replaces, could
  destroy the item that had succeeded.
- **Generated conversation ids collided.** `mcp-conversation-${Date.now()}` has
  millisecond resolution, and with `upsert` hardcoded on, a collision silently
  replaced the earlier conversation and reported success.
- **`hydradb_list` ignored `source_ids` for memories** — accepted, validated, and
  dropped in silence.
- **Raw JSON envelopes reached the prompt.** When ingest stored the serialised
  source record, the renderer emitted ids and tenant identifiers where the
  content should have been.
- **Graph relations went missing.** `source_chunk_ids` — the primary
  chunk-to-relation mapping — was dropped by the response adapter, so relations
  linked only that way were never rendered.
- **`mode: "url"` could not work.** `presignedUrl` was never read, so the one
  mode whose purpose is a download link returned "(no text content)".
- **`hydradb_inspect` could end a session.** Binary content was inlined as
  base64, so a 1 MB scanned PDF became roughly 350k tokens in one call. Binary is
  now never inlined, and text output is bounded.
- **Error bodies were unbounded and unfiltered.** A CDN or proxy error page
  reached the caller whole. Now structured-first, capped, and scrubbed of
  credential-shaped material.
- **No timeout was configured**, so a failing endpoint could occupy a caller for
  ~3 minutes; and `extra.signal` was never forwarded, so a cancelled tool call
  left the request in flight.
- **Failures were inconsistently flagged.** A server-*refused* delete and a
  failed inspect returned success-shaped results, so a client branching on
  `isError` misread them.
- **Every untitled note was titled "MCP Memory"**, and title is the only
  per-chunk label rendered in search results.
- **`npm test` could pass having run zero tests** on Node 18 and 20 — `/bin/sh`
  does not expand `**`, and CI was running a different command.

### Changed

- Tool descriptions now say **when** to call each tool — recall before
  answering, save what the user reveals — with worked examples. Nothing
  previously did, which is the difference between a memory product and a
  note-taking tool.
- Parameter descriptions explain the decision each informs rather than restating
  the type.
- All four MCP behaviour hints (`readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint`) are declared on every tool. `destructiveHint`
  could not previously be set at all, and the spec defaults it to *true* for
  non-readonly tools — so `hydradb_ingest` read as destructive.
- Overlapping chunks whose content is wholly contained in another are suppressed,
  and extra context is deduplicated by content rather than id.
- `max_results` now bounds what is rendered, not just what is requested.
- The recall renderer reads SDK types directly; the snake_case mirror and its
  adapters are gone (−112 lines).
- Ingest input is bounded (1M characters, 500 turns).
- `moduleResolution` is `NodeNext`, so the SDK's `exports` subpaths resolve.
- The `lint` CI job runs an actual linter; the publish workflow smoke-tests the
  built package and asserts the tarball contents.

## [1.1.1] - 2026-07

### Fixed

- `hydradb_query` no longer pins `kind: "memory"`, which had made every ingested
  knowledge source unreachable from the MCP.
- The server reports its real version instead of a hardcoded `1.0.0`.

## [1.1.0] - 2026-07

### Added

- Canonical HydraDB tool vocabulary (`hydradb_*`), with the previous `hydra_db_*`
  names kept as deprecated aliases.

[1.2.1]: https://github.com/hydra-db/hydradb-mcp/releases/tag/v1.2.1
[1.2.0]: https://github.com/hydra-db/hydradb-mcp/releases/tag/v1.2.0
[1.1.1]: https://github.com/hydra-db/hydradb-mcp/releases/tag/v1.1.1
[1.1.0]: https://github.com/hydra-db/hydradb-mcp/releases/tag/v1.1.0
