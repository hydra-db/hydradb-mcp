<!--
  This file is the SHARED HydraDB client contract (PRO-1298).
  The master copy is maintained centrally and committed verbatim to all four client repos,
  which form two groups (see §0):
    Group 1 (agent plugins):  hydradb-claude-code · openclaw-hydradb
    Group 2 (direct clients): hydradb-cli · hydradb-mcp
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

## 0. Client groups

The four clients are organised into **two groups**. A client belongs to exactly one.

| Group | Clients | What they are |
|---|---|---|
| **Group 1** | `hydradb-claude-code` (Claude Code plugin) · `openclaw-hydradb` (OpenClaw plugin) | **Agent plugins.** They extend a host agent that is already running. HydraDB is reached through skills, slash commands and agent tools; the end user never invokes them directly. |
| **Group 2** | `hydradb-cli` · `hydradb-mcp` | **Direct clients.** A person or a program drives them on purpose — a terminal command, or an MCP server a host connects to. Their surface is the product. |

Groups are the unit of coordination. A change that alters a shared surface is landed
across **every client in the group together**, so the two clients in a group never
disagree in a release. Concretely:

- **Group 1** shares the plugin idiom: slash-command names, skill front-matter, and the
  `--json` state shapes marketplace-shipped skill files parse. A rename in one is a rename
  in both.
- **Group 2** shares the *invocation* surface: command and tool names, flag and parameter
  spelling, and the `--output json` / `structuredContent` shapes that `jq` and MCP hosts
  parse. When both clients expose the same capability they expose it the same way — the
  same verbs, the same scope flags, the same defaults.

This does **not** relax anything below. §1's vocabulary, §2's wrapper rules and §3's alias
policy bind every client in both groups. Groups say who moves together, not who is exempt.

Where a capability exists in only one group, that is a deliberate product decision and is
recorded as such, not treated as drift for the other group to catch up on.

---

## 1. Canonical vocabulary

### Nouns

| Canonical | Meaning | Never say |
|---|---|---|
| **database** | isolated tenancy container | tenant, namespace, workspace (as a scope), knowledge base |
| **collection** | partition within a database | sub-tenant, sub_tenant_id |
| **metadata schema** | the metadata fields a database declares, each with a name and a stored type | custom properties, tenant metadata schema |
| **context** | the stored-unit family (memory + knowledge) | — |
| **memory** | a context item of kind `memory` | user memory, preference |
| **knowledge** | a context item of kind `knowledge` | document, file, source-as-kind |
| **source** | one ingested item; its identifier field is `id` | source_id, file_id, doc_id |
| **chunk** | one retrieved fragment of a source | — |
| **connector** | one connected provider account that syncs into a database | integration, data source, source (a source is one ingested item) |
| **provider** | the external system a connector reads, such as `slack`, `gmail` or `jira` | app, integration type |
| **resource** | one container inside a provider that a connector syncs, such as a Slack channel or a Drive folder | mapping, configured resource, channel or folder as the general term |

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
| **subgraph** | source_subgraph, connected subgraph, thread (as a graph read) — Group 2 only |

### Connector verbs

The connector family uses `list`, `inspect`, `update` and `delete` with the meanings above,
and adds the verbs below. These apply to connectors only.

| Canonical | Absorbs | Notes |
|---|---|---|
| **connect** | create (a connector), install, authorize | returns a dashboard link; never takes credentials |
| **reconnect** | reauthorize, rotate credentials | returns a dashboard link; never takes credentials |
| **health** | status (of a connector), check | see the `status` table below |
| **discover** | browse upstream, available resources | what the provider account has, added to HydraDB or not |
| **add** | configure, create resource, attach | resources only: attaches resources to a connector and starts syncing them. It does not ingest; adding a context item is still **ingest** |
| **sync** | run, trigger, refresh | starts a connector run. Local file sync is still **ingest** |
| **pause** / **resume** | stop, disable / start, enable | scheduling only; nothing is deleted |

### The `status` disambiguation (mandatory)

`status` currently names four unrelated things. Two are poll-until-ready calls; picking the wrong
one silently polls the wrong subject. Clients MUST use these names instead:

| Concept | Canonical name | Meaning |
|---|---|---|
| per-source indexing progress | **ingestionStatus** / `ingestion-status` | is this source indexed yet |
| database infra provisioning | **readiness** / `readiness` | is the database ready for ingestion |
| local client health | **doctor** | config present + endpoint reachable |
| connector sync health | **health** / `connector health` | is this connector syncing, and are its resources working |

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
| `databases.deleteCollection(database, collection)` | *(none — raw `DELETE /databases/collections`)* | not on the pinned SDK yet |
| `databases.stats(database)` | `databases.stats(database=…)` | row counts |
| `databases.readiness(database)` | `databases.status(database=…)` | **renamed away from `status`** |
| `databases.inspectMetadataSchema(database)` | `databases.getMetadataSchema(database=…)` | **renamed away from `get`** |
| `databases.updateMetadataSchema(database, addFields)` | `databases.updateMetadataSchema(database=…, add_fields=…)` | additive only |
| `context.ingest(database, kind, …)` | `context.ingest(…)` | multipart; `kind` ∈ {memory, knowledge} |
| `context.query(database, query, kind?, …)` | `client.query(…)` | the single retrieval entry point |
| `context.list(database, kind?, …)` | `context.list(…)` | — |
| `context.inspect(database, id, …)` | `context.inspect(…)` | was "fetch content" |
| `context.ingestionStatus(database, ids)` | `context.status(…)` | **renamed away from `status`** |
| `context.relations(database, id?, …)` | `context.relations(…)` | — |
| `context.subgraph(database, id, depth?, maxSources?)` | *(none — raw `GET /context/{id}/subgraph`)* | connected subgraph; **no SDK resource yet** |
| `context.delete(database, ids, kind)` | `context.delete(…)` | one path for memory + knowledge |
| `graph.query(database, collection, query, params?)` | *(none — raw `POST /byog/query`)* | BYOG Cypher in the narrow dialect (integer node ids, one-hop edge writes; see README "Supported Cypher"); **no SDK resource at 2.1.2** |
| `graph.createDatabase(database)` | *(none — raw `POST /byog/databases`)* | — |
| `graph.collections(database)` | *(none — raw `GET /byog/collections`)* | — |
| `graph.dropCollection(database, collection)` | *(none — raw `DELETE /byog/collections`)* | idempotent; leaves the listing when the drop succeeds (a very large collection can need a retry); storage retained |
| `graph.dropDatabase(database)` | *(none — raw `DELETE /byog/databases`)* | `deleted:false` ⇒ collections only |

### Connector wrapper methods

`connectors.*` follows the same rules. `connect` and `reconnect` make no SDK call: they return a
dashboard link, so they have no wrapper method.

| Wrapper method | SDK call today | Notes |
|---|---|---|
| `connectors.listProviders()` | `listProviders({})` | the provider catalog |
| `connectors.inspectProvider(provider)` | `listProviders({ id })` | one provider's setup guide and credential schema (field metadata only) |
| `connectors.list(provider?, includeHealth?)` | `connectors.list(…)` | |
| `connectors.inspect(id)` | `connectors.get({ id })` | **renamed away from `get`** |
| `connectors.health(id)` | `connectors.status({ id })` | **renamed away from `status`** |
| `connectors.discover(id, cursor?, limit?)` | `connectors.discover(…)` | resources upstream, added or not |
| `connectors.listResources(id)` | `connectors.listResources({ id })` | resources already added |
| `connectors.update(id, customInstructions?, syncIntervalSeconds?)` | `connectors.update(…)` | noncredential settings only |
| `connectors.delete(id)`, `.sync(id)`, `.pause(id)`, `.resume(id)` | same names | |
| `connectors.addResources(id, resources[], lookbackDays?, fullVisibilityRoles?, tableConfigs?)` | `connectors.configure(…)` | **the one way to attach resources**: adds the list and starts a sync |
| `connectors.updateResource(id, resourceId, acl?, customInstructions?)` | `connectors.updateResourceAcl(…)` | **renamed away from `updateResourceAcl`** |
| `connectors.deleteResource(id, resourceId)` | `connectors.deleteResource(…)` | |

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
7. **A hand-rolled path is still the wrapper.** Some endpoints have no SDK resource — BYOG
   (`/byog/*`) has none at `2.1.2`. Those are called directly, but from *inside* the wrapper and
   behind the same surface: same envelope-by-shape unwrapping, same `API-Version: 2` header, same
   translated error type. A caller must not be able to tell which methods went through the SDK.
   When the SDK grows the resource, only that one file changes. This does not weaken rule 1 — an
   endpoint the SDK does not expose has no generated name to be insulated from.

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
| `hydradb_subgraph` | — (new in PRO-1848; no prior spelling) |

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
| `hydradb subgraph <id>` | — (new in PRO-1848; no prior spelling) |
| `hydradb delete …` | `memories delete`, `knowledge delete` |
| `hydradb doctor` | `whoami` (config half) |

### Claude Code plugin (skills / slash)

| Canonical | Aliases (warn) |
|---|---|
| `/hydradb:query` | `/hydradb:search`, `/hydradb:recall` (already deprecated) |
| `/hydradb:ingest` | `/hydradb:remember`, `/hydradb:save-session`, `/hydradb:sync-workspace`, `reindex` |
| `/hydradb:doctor` | `/hydradb:status` |

### Databases

Database management on MCP is named noun first and verb last: `hydradb_database_<verb>`, and
`hydradb_database_schema_<verb>` for the metadata schema.

| Action | MCP tool |
|---|---|
| list databases | `hydradb_databases` |
| create a database | `hydradb_database_create` |
| delete a database | `hydradb_database_delete` |
| provisioning readiness | `hydradb_database_readiness` |
| row counts | `hydradb_database_stats` |
| inspect the metadata schema | `hydradb_database_schema_inspect` |
| update the metadata schema | `hydradb_database_schema_update` |
| list collections | `hydradb_list_collections` |
| delete a collection | `hydradb_delete_collection` |

Rules:

- **Shipped names stay.** `hydradb_databases`, `hydradb_list_collections` and
  `hydradb_delete_collection` shipped before this naming and keep their names. The other tools
  never shipped under another name, so they have no aliases.
- **Schema update is additive only.** It adds fields and never removes, renames or retypes one.
  The verb is `update`, not `add`.
- **Default exposure.** Every database action is on by default, including the irreversible
  `hydradb_database_delete`. It carries the surface's destructive marker (MCP
  `destructiveHint: true`), so the host asks before running it, and it refuses the connection's
  own default database. `HYDRADB_MCP_DATABASE_TOOLS=0` withholds create, delete, readiness, stats,
  schema inspect and schema update. `hydradb_databases` and the collection tools stay.
- **Other clients.** The CLI's `hydradb database …` commands keep their names. A client that adds
  metadata schema commands names them `schema inspect` and `schema update`.
- **Conformance.** The `database-metadata-schema-*` vectors list every client that does not ship
  those wrapper methods yet in `optional_for`. A client removes itself from that list in the
  change that ships them.

---

### Connectors

One name per action, noun first and verb last, so the three surfaces map one to one: CLI
`hydradb connector [provider|resource] <verb>`, MCP `hydradb_connector_[provider_|resource_]<verb>`,
plugin `/hydradb:connector-[provider-|resource-]<verb>`.

| Action | CLI | MCP tool | Claude Code plugin |
|---|---|---|---|
| list providers | `hydradb connector provider list` | `hydradb_connector_provider_list` | `/hydradb:connector-provider-list` |
| inspect one provider | `hydradb connector provider inspect <provider>` | `hydradb_connector_provider_inspect` | `/hydradb:connector-provider-inspect` |
| list connectors | `hydradb connector list` | `hydradb_connector_list` | `/hydradb:connector-list` |
| inspect one connector | `hydradb connector inspect <id>` | `hydradb_connector_inspect` | `/hydradb:connector-inspect` |
| connector health | `hydradb connector health <id>` | `hydradb_connector_health` | `/hydradb:connector-health` |
| connect a provider | `hydradb connector connect <provider>` | `hydradb_connector_connect` | `/hydradb:connector-connect` |
| reconnect a connector | `hydradb connector reconnect <id>` | `hydradb_connector_reconnect` | `/hydradb:connector-reconnect` |
| update settings | `hydradb connector update <id>` | `hydradb_connector_update` | `/hydradb:connector-update` |
| delete a connector | `hydradb connector delete <id>` | `hydradb_connector_delete` | `/hydradb:connector-delete` |
| start a sync | `hydradb connector sync <id>` | `hydradb_connector_sync` | `/hydradb:connector-sync` |
| pause | `hydradb connector pause <id>` | `hydradb_connector_pause` | `/hydradb:connector-pause` |
| resume | `hydradb connector resume <id>` | `hydradb_connector_resume` | `/hydradb:connector-resume` |
| discover upstream resources | `hydradb connector discover <id>` | `hydradb_connector_discover` | `/hydradb:connector-discover` |
| list added resources | `hydradb connector resource list <id>` | `hydradb_connector_resource_list` | `/hydradb:connector-resource-list` |
| add resources | `hydradb connector resource add <id> …` | `hydradb_connector_resource_add` | `/hydradb:connector-resource-add` |
| update one resource | `hydradb connector resource update <id> <resource_id>` | `hydradb_connector_resource_update` | `/hydradb:connector-resource-update` |
| delete one resource | `hydradb connector resource delete <id> <resource_id>` | `hydradb_connector_resource_delete` | `/hydradb:connector-resource-delete` |

Rules for every surface:

- **Connect and reconnect never take credentials.** They return the dashboard links
  `/connectors?connect=<provider>` and `/connectors?open=<id>`. The dashboard sends the credentials.
- **Resource add takes a list** and is the only way to attach resources. Each resource uses the
  fields resource list returns (`resource_id`, `resource_type`, `display_name`, `database_override`,
  `collection_override`, `acl`, `custom_instructions`, `metadata`, `additional_metadata`, `sync_mode`),
  so a listed resource can be sent back unchanged.
- **Default exposure.** Every connector action is on by default, including the irreversible
  `delete` and `resource delete`. Those two carry the surface's destructive marker (MCP
  `destructiveHint: true`), so the host asks before running them. `HYDRADB_MCP_CONNECTOR_TOOLS=0`
  withholds the whole MCP family.
- **Aliases.** The MCP and plugin names are new, so they have none. The CLI's existing
  `hydradb connectors …` commands become deprecated aliases with one warning each:
  `connectors providers` → `connector provider list` / `connector provider inspect`,
  `connectors get` → `connector inspect`, `connectors status` → `connector health`,
  `connectors resources` → `connector resource list`, `connectors configure` and
  `connectors resource add` → `connector resource add`, `connectors resource remove` →
  `connector resource delete`, and `connectors list`, `discover`, `sync` and `delete` → the same
  verb under `connector`. `connectors create` and `connectors rotate-credentials` send credentials
  from the terminal; the CLI change decides whether they stay CLI-only or become aliases of
  `connect` and `reconnect`.
- **OpenClaw** has no connector surface in this change. If it adds one, it uses the plugin column's
  names.

## 4. Conformance

Each repo ships a runner that feeds `conformance/vectors.json` (identical across repos) through its
wrapper and asserts the canonical call it produces. This is the anti-drift gate: a client that
renames an action, changes a default, or diverges in ingest behaviour fails its own CI.

The `connector-*` vectors list every client that does not ship the connector surface yet in
`optional_for`. A client removes itself from that list in the change that ships the surface.
`connect` and `reconnect` have no vector because they make no SDK call. See
`conformance/README.md` in each repo.
