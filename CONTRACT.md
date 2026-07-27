<!--
  This file is the SHARED HydraDB client contract (PRO-1298).
  The master copy is maintained centrally and committed verbatim to all four client repos:
    hydradb-cli · hydradb-mcp · openclaw-hydradb · hydradb-claude-code
  Do not edit a single repo's copy in isolation. A change is one PR per repo against this one text.
-->

# HydraDB client contract

Every shipped HydraDB client wraps the generated SDK (`hydradb-sdk` / `@hydradb/sdk`) behind a thin,
hand-owned layer and exposes the **same vocabulary** for the **same operations**. This document is
the authority for both. If a client's surface disagrees with this file, the client is wrong.

Why this exists: the SDK's method names are generated from OpenAPI **summary text** with no
`x-fern-sdk-method-name` overrides, and its CI auto-bumps only the patch digit while publishing on
merge — so a breaking rename can arrive as `2.1.2 → 2.1.3`. The wrapper is the firewall that keeps
that churn from reaching users. It is the reason we pin the SDK **exactly**, never with `^`/`~`/`>=`.

---

## 1. Canonical vocabulary

### Nouns

| Canonical | Meaning | Never say |
|---|---|---|
| **database** | isolated tenancy container | tenant, namespace, workspace (as a scope), knowledge base |
| **collection** | partition within a database | sub-tenant, sub_tenant_id |
| **context** | the stored-unit family (memory + knowledge) | — |
| **memory** | a context item of kind `memory` | user memory, preference |
| **knowledge** | a context item of kind `knowledge` | document, file, source-as-kind |
| **source** | one ingested item; its identifier field is `id` | source_id, file_id, doc_id |
| **chunk** | one retrieved fragment of a source | — |

`context` names **one** thing: the stored-unit family. Its two other historical senses are
expressed as compounds, never as a bare `context`:
- the string you inject into a prompt → **context string**
- the knowledge graph → **context graph**

`workspace` is not a HydraDB term. It may refer only to a client's *local* notion (the plugin's
project directory) and must never denote a database, collection, or org.

### Verbs — exactly one per action

| Canonical | Absorbs |
|---|---|
| **query** | search, recall, full_recall, recall_preferences, boolean_recall, full, preferences, keyword, retrieve |
| **ingest** | add, store, remember, save, capture, upload, sync (local file sync), push, index |
| **list** | list_data, browse, "fetch sources" |
| **inspect** | fetch content, get content, fetch_content |
| **delete** | remove, forget |
| **relations** | graph_relations, graph_relations_by_id |

### The `status` disambiguation (mandatory)

`status` currently names four unrelated things. Two are poll-until-ready calls; picking the wrong
one silently polls the wrong subject. Clients MUST use these names instead:

| Concept | Canonical name | Meaning |
|---|---|---|
| per-source indexing progress | **ingestionStatus** / `ingestion-status` | is this source indexed yet |
| database infra provisioning | **readiness** / `readiness` | is the database ready for ingestion |
| local client health | **doctor** | config present + endpoint reachable |

### Environment variables — canonical prefix `HYDRADB_`

| Canonical | Deprecated aliases still read (with a one-line warning) |
|---|---|
| `HYDRADB_API_KEY` | `HYDRA_DB_API_KEY`, `HYDRA_OPENCLAW_API_KEY` |
| `HYDRADB_DATABASE` | `HYDRADB_TENANT_ID`, `HYDRA_DB_TENANT_ID`, `HYDRA_OPENCLAW_TENANT_ID` |
| `HYDRADB_COLLECTION` | `HYDRADB_SUB_TENANT_ID`, `HYDRA_DB_SUB_TENANT_ID` |
| `HYDRADB_BASE_URL` | `HYDRA_DB_BASE_URL`, `HYDRADB_API_URL` |

A deprecated alias is honoured but emits exactly one stderr warning per process naming the canonical
replacement. The canonical name wins if both are set.

**Per-client scoping (important):** a client reads the canonical `HYDRADB_*` name plus **only the
legacy prefix(es) it itself historically shipped** — not every spelling in the table. Concretely:
the Claude Code plugin, MCP, and CLI read the `HYDRA_DB_*` spellings (and the plugin's existing
`HYDRADB_*`); OpenClaw reads `HYDRA_OPENCLAW_*`. No client reads another client's prefix — e.g. the
plugin must NOT read `HYDRA_OPENCLAW_API_KEY`. The table above is the union across clients, not a
per-client checklist.

---

## 2. The wrapper surface

Each client exposes a `HydraDB` wrapper object. Method names are canonical (§1); each maps to the
current SDK method internally. Language casing: `snake_case` in Python, `camelCase` in TS/JS.

| Wrapper method | SDK call today | Notes |
|---|---|---|
| `databases.create(database, …)` | `databases.create(database=…)` | — |
| `databases.delete(database)` | `databases.delete(database=…)` | — |
| `databases.list()` | `databases.list()` | returns ids only |
| `databases.collections(database)` | `databases.collections(database=…)` | was "list sub-tenants" |
| `databases.stats(database)` | `databases.stats(database=…)` | row counts |
| `databases.readiness(database)` | `databases.status(database=…)` | **renamed away from `status`** |
| `context.ingest(database, kind, …)` | `context.ingest(…)` | multipart; `kind` ∈ {memory, knowledge} |
| `context.query(database, query, kind?, …)` | `client.query(…)` | the single retrieval entry point |
| `context.list(database, kind?, …)` | `context.list(…)` | — |
| `context.inspect(database, id, …)` | `context.inspect(…)` | was "fetch content" |
| `context.ingestionStatus(database, ids)` | `context.status(…)` | **renamed away from `status`** |
| `context.relations(database, id?, …)` | `context.relations(…)` | — |
| `context.delete(database, ids, kind)` | `context.delete(…)` | one path for memory + knowledge |

Rules every wrapper obeys:

1. **Exact SDK pin.** Depend on `hydradb-sdk==<x.y.z>` / `"@hydradb/sdk": "<x.y.z>"` — never a range.
2. **Unwrap the envelope, but not blindly.** Most methods return `HandlerEnvelope{data,success,meta}`;
   return `.data`. But `connectors.*` mostly returns bare objects and
   `databases.updateMetadataSchema` is not enveloped — unwrap by checking for the envelope shape,
   never by assuming it.
3. **Own env/config.** Both SDKs read zero environment variables; the wrapper supplies `token`,
   `base_url`, database, collection from config per §1.
4. **Translate errors** back into the host client's existing error type/shape. Do not let raw SDK
   exception types leak to surfaces that previously saw the client's own error.
5. **Preserve host behaviour** the SDK does not provide (redaction, silent-failure, retries capped
   under hook budgets, defaults, output shapes). These are listed per-client in the plan.
6. **Send `API-Version: 2`.** (The SDK does this; a client that previously sent no version header is
   changing server behaviour by adopting it — that is intended, but must be tested, not assumed.)

---

## 3. User-facing names + alias policy

Adopt the canonical user-facing name on every surface, and keep every current name working as a
**deprecated alias that emits one warning**. Aliases are removed only in a later major, after
telemetry shows adoption. These surfaces make aliases mandatory (renaming them outright is breaking):
MCP tool names live in users' `mcp.json`; the plugin's `--json` shape is parsed by marketplace-shipped
skill files and persisted to `state.json`; the CLI's `--output json` is a documented `jq` contract.

### MCP tools

| Canonical | Aliases (warn) |
|---|---|
| `hydradb_query` | `hydra_db_search` |
| `hydradb_ingest` | `hydra_db_store`, `hydra_db_ingest_conversation` |
| `hydradb_list` | `hydra_db_list_memories`, `hydra_db_list_sources` |
| `hydradb_inspect` | `hydra_db_fetch_content` |
| `hydradb_delete` | `hydra_db_delete_memory` |

### OpenClaw (agent tool / slash / CLI — align all three)

| Canonical | Aliases (warn) |
|---|---|
| tool `hydradb_query` · slash `/hydradb-query` · cli `hydradb query` | `hydra_search` / `/hydra-recall` / `hydra search` |
| tool `hydradb_ingest` · slash `/hydradb-ingest` · cli `hydradb ingest` | `hydra_store` / `/hydra-remember` |
| tool `hydradb_list` · slash `/hydradb-list` · cli `hydradb list` | `hydra_list_memories` / `/hydra-list` / `hydra list` |
| tool `hydradb_inspect` · slash `/hydradb-inspect` · cli `hydradb inspect` | `hydra_get_content` / `/hydra-get` / `hydra get` |
| tool `hydradb_delete` · slash `/hydradb-delete` · cli `hydradb delete` | `hydra_delete_memory` / `/hydra-delete` / `hydra delete` |

### CLI (`hydradb`)

| Canonical | Aliases (warn) |
|---|---|
| `hydradb query …` (`--kind memory\|knowledge`, `--operator`) | `recall full`, `recall preferences`, `recall keyword` |
| `hydradb database create/delete/list/collections/stats/readiness` | the whole `tenant` group |
| `hydradb ingest …` | `memories add`, `knowledge upload`, `knowledge upload-text` |
| `hydradb list …` | `memories list`, `fetch sources` |
| `hydradb inspect …` | `fetch content` |
| `hydradb relations …` | `fetch relations` |
| `hydradb delete …` | `memories delete`, `knowledge delete` |
| `hydradb doctor` | `whoami` (config half) |

### Claude Code plugin (skills / slash)

| Canonical | Aliases (warn) |
|---|---|
| `/hydradb:query` | `/hydradb:search`, `/hydradb:recall` (already deprecated) |
| `/hydradb:ingest` | `/hydradb:remember`, `/hydradb:save-session`, `/hydradb:sync-workspace`, `reindex` |
| `/hydradb:doctor` | `/hydradb:status` |

---

## 4. Conformance

Each repo ships a runner that feeds `conformance/vectors.json` (identical across repos) through its
wrapper and asserts the canonical call it produces. This is the anti-drift gate: a client that
renames an action, changes a default, or diverges in ingest behaviour fails its own CI. See
`conformance/README.md` in each repo.
