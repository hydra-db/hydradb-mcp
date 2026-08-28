# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — OAuth resource server ("Sign in with HydraDB")

The hosted server can now take part in the MCP authorization flow (PRO-1790).
With `HYDRADB_OAUTH_ISSUER`, `HYDRADB_MCP_PUBLIC_URL` and
`HYDRADB_OAUTH_INTROSPECTION_SECRET` set, it serves an RFC 9728 Protected
Resource Metadata document at `/.well-known/oauth-protected-resource`, points
every `401` at it via `WWW-Authenticate`, and accepts `hmat_` access tokens
issued by the HydraDB dashboard, exchanging each (with a bounded memo) for the
API key and database the user approved. Tokens for another audience are
refused. Nothing changes for API keys, headers, links or the env fallback; with
the variables unset the server is byte-for-byte the previous one.

## [1.3.0] - 2026-08-27

### Added — connection links: paste one URL, no headers, no JSON

The hosted server now serves **connection links**, URLs that carry the whole
configuration:

```
https://mcp.hydradb.com/c/<api-key>[/<database>[/<collection>]]
```

A link is what the dashboard's new **Settings → MCP** page mints per client. It
is the shape to use with clients that accept a URL and nothing else (Claude
Desktop, claude.ai, mobile), where the `X-HydraDB-Database` header could never
be sent and every request was refused with `400`. The link is the API key:
revoking the key kills the link. Header-authenticated requests can also be
scoped by path (`/<database>[/<collection>]`), and every shape is accepted
under `/mcp/...` too. Paths carrying a key are redacted from logs, never echoed
in error bodies, and answered with `Cache-Control: no-store`.

### Changed — the database is optional everywhere

`HYDRADB_DATABASE` (stdio) and `X-HydraDB-Database` (HTTP) are no longer
required. When nothing names a database, the server resolves the account's
default on the first call that needs it: exactly one database → that one; none
→ `default` is created and waited for; several → the call fails naming them and
asking for `database` (never a guess). The result is memoised per account so the
hosted server does not list databases on every request. Resolution is lazy, so
a bad key surfaces as a readable tool error rather than a failed start-up.

Nothing existing changes: every header, environment variable, precedence rule
and per-call `database` / `collection` argument behaves exactly as before. The
only observable difference is that requests which used to be refused for
naming no database now work.

### Added — `hydradb_databases`

Lists the databases the connection's account can address and marks the one
unscoped calls use, so an agent told "choose a database" can find the choices
without leaving MCP.

## [1.2.2] - 2026-08-19

### Added — per-call database and collection scope overrides

Every context tool (`hydradb_query`, `hydradb_ingest`, `hydradb_list`,
`hydradb_inspect`, `hydradb_delete`, `hydradb_status`, and deprecated aliases)
now accepts optional `database` and `collection` arguments directly in its payload.
This allows multi-tenant SaaS agents to dynamically switch tenant/collection scopes
per request within a single persistent MCP session, while falling back to the session
defaults when omitted.

### Added — remote HTTP transport (hosted server)

The server can now run as a long-lived **HTTP endpoint** that many clients reach
at one URL (`https://mcp.hydradb.com`), alongside the existing stdio (`npx`) binary.
This is what a hosted deployment runs, and what `npm run start:http` or the new
Docker image runs locally — nothing to install per user.

The tool surface is unchanged: the HTTP server builds the exact same server as
stdio via `createHydraDBServer`. Only connection and auth are new.

- **Root endpoint and backward-compatible alias.** The server serves the MCP
  Streamable HTTP transport directly on `/` and `/mcp`.
- **Per-request, multi-tenant credentials.** A hosted process has no single
  ambient account, so each request selects its tenant with headers —
  `Authorization: Bearer <api-key>` (or `X-HydraDB-Api-Key`) and
  `X-HydraDB-Database`, with optional `X-HydraDB-Collection` and
  `X-HydraDB-Graph-*`. A request that authenticates nobody is refused (`401`);
  one that names no database is `400`. A single-tenant self-host may instead set
  `HYDRADB_API_KEY`/`HYDRADB_DATABASE` in the environment and clients send no
  credentials — the header path falls back to it.
- **Safe-by-default network posture.** Binds loopback unless `BIND_ADDRESS` is
  set; a `Host` allowlist (`ALLOWED_HOSTS`, loopback always) answers stray
  authorities with `421`; CORS is closed until `ALLOWED_ORIGINS` lists an
  origin. `Base URL`/timeout/retries stay operator-only env settings and are
  never read from a request header.
- New: `src/http.ts` (Express app + lifecycle), `src/http-config.ts`
  (operator + per-request config resolution), `Dockerfile`, `.dockerignore`,
  `npm run start:http` / `dev:http`, and a `hydradb-mcp-http` bin. Runtime deps
  `express` and `cors` were added.

### Added — graph (BYOG) tools

Hydra DB's **graph database** offering is now reachable from the MCP. Previously
this server exposed only the application offering (memory and knowledge); the
property graphs users model and own end to end, queried in Cypher, had no client
surface at all despite being [documented](https://docs.hydradb.com/essentials/v2/graph-collections-byog)
and live.

Three new tools, all additive — nothing about the existing six changed:

| Tool | Annotation | What it does |
|---|---|---|
| `hydradb_graph_query` | `destructiveHint` | Cypher, reads and writes alike |
| `hydradb_graph_collections` | `readOnlyHint` | List the graphs in a graph database |
| `hydradb_graph_admin` | `destructiveHint` | Create a graph database; drop a collection or database |

This covers [Neo4j's MCP server](https://github.com/neo4j-contrib/mcp-neo4j)
`read_neo4j_cypher` and `write_neo4j_cypher`, plus the graph database lifecycle
its Aura server covers. Two of its capabilities are deliberately **not**
reproduced:

**One Cypher tool, not a read/write pair.** Neo4j splits `read_neo4j_cypher`
from `write_neo4j_cypher` so a host can auto-approve one and gate the other.
That split is only sound if the read/write classifier is right on every query,
and any classifier over Cypher text is a heuristic — Neo4j's own is a substring
scan that refuses `MATCH (p:Person) WHERE p.name = "CREATE something" RETURN
p.name`, a query HydraDB accepts and that mutates nothing. Rather than ship a
tool whose contract ("this one never writes") rests on a heuristic, there is one
tool, annotated destructive, and the host gates the whole graph surface. No
classifier ships at all.

**No schema tool.** Neo4j's `get_neo4j_schema` runs `CALL apoc.meta.schema()`,
which HydraDB rejects outright. A derived equivalent is not part of the product,
so none ships. Callers discover a collection's structure the same way they query
it — `MATCH (n) UNWIND labels(n) AS l RETURN l, count(*) AS c ORDER BY l` — and
the tool description says so.

Also worth recording: **`EXPLAIN` is not a preview.** `EXPLAIN MATCH (p:Person)
RETURN p` returns live rows rather than a plan, so it is documented as something
not to reach for.

The 256 KiB body cap IS enforced before upload, since the remote `413` arrives
only after the whole oversized batch has been sent — that is a transport fact
the client owns, not a rule about what Cypher means.

Registered by default, with one switch: `HYDRADB_MCP_GRAPH_TOOLS=0` withholds
all three, for memory-only users who do not want the extra tool definitions in
every conversation.

**The client does not inspect your Cypher.** No read/write classification, no
read-only mode, no local pre-rejection of unsupported constructs. All of those
would put a second, worse implementation of the server's rules inside a client,
able only to agree with the server or to be wrong — and being wrong means
refusing a query HydraDB would have run. The server rejects unsupported
constructs before executing anything (verified: a query mixing `CREATE` with a
procedure call leaves the node count unchanged) and its messages are more
specific than the ones this server used to produce. Queries are sent verbatim.

Withholding the tools is the only lockdown offered, because it is the only one
that is actually a guarantee.

New configuration: `HYDRADB_GRAPH_DATABASE` (falls back to `HYDRADB_DATABASE`)
and `HYDRADB_GRAPH_COLLECTION` (defaults to `default`). A graph database is a
different namespace from the memory database, so every graph tool also accepts
`database` and `collection` per call.

### Internal

- `HydraDB.graph` is a hand-rolled HTTP path, not an SDK call: `@hydradb/sdk`
  at the pinned 2.1.2 has no `byog` resource, so the endpoints are unreachable
  through it. It sits behind the same wrapper surface, unwraps the same envelope
  by shape and raises the same `HydraWrapperError`, so callers cannot tell which
  methods go through the SDK. When the SDK grows a `byog` resource, that one file
  is replaced and nothing above it changes. The exact SDK pin is unaffected —
  there is no generated name to be insulated from yet.
- `responseError()` added to the wrapper's error module so failures from the
  non-SDK path are formatted through the same code as SDK failures, keeping the
  error code, the server's message and the request id.
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
