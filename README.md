# Hydra DB — MCP Server

MCP (Model Context Protocol) server for [Hydra DB](https://hydradb.com), the state-of-the-art agentic memory. Provides tools for storing, recalling, and managing memories with knowledge-graph enriched context.

Run it two ways, same tools either way:

- **Local (stdio)** — the `npx @hydradb/mcp` binary each client spawns. No server to operate; credentials live in the client's config. This is the default and everything below the [Configuration](#configuration) section documents it.
- **Remote (HTTP)** — one hosted process behind a URL like `https://mcp.hydradb.com` that many clients point at, with nothing to install. See [**Remote / hosted server**](#remote--hosted-server).

## Available Tools

| Tool | What it does |
|---|---|
| `hydradb_query` | Search memories and knowledge together, with knowledge-graph context |
| `hydradb_ingest` | Save a note, a document, or a conversation |
| `hydradb_list` | Enumerate one family — every memory, or every knowledge source |
| `hydradb_inspect` | Fetch one source's full content by id |
| `hydradb_delete` | Remove one or more items by id, irreversibly |
| `hydradb_status` | Check whether an ingested source has finished indexing |
| `hydradb_subgraph` | Everything connected to one item — its thread, replies, parents, children, links |

Ids flow between these: `hydradb_query`, `hydradb_list` and `hydradb_subgraph` emit them;
`hydradb_inspect`, `hydradb_delete`, `hydradb_status` and `hydradb_subgraph` accept them.

### Graph tools (Cypher)

Hydra DB also runs **property graphs you model and own end to end**, queried in [Cypher](https://docs.hydradb.com/essentials/v2/graph-collections-byog). This is a different product surface from the memory and knowledge above, and nothing crosses between them: `hydradb_query` cannot see graph data, and `hydradb_graph_query` cannot see memories.

| Tool | What it does |
|---|---|
| `hydradb_graph_query` | Run Cypher — reads **and** writes |
| `hydradb_graph_collections` | List the graphs in a graph database |
| `hydradb_graph_admin` | Create a graph database; drop a collection or a database |

`hydradb_graph_query` is annotated `destructiveHint`, because it runs arbitrary Cypher and `DELETE` is as reachable through it as `MATCH`. There is deliberately **no** separate read-only Cypher tool and **no read-only mode**: both would mean classifying Cypher text client-side to decide what to refuse, which is a heuristic — a promise the server can keep and a client cannot. This server does not inspect your query at all; it sends it and reports what HydraDB says. To lock the graph surface down, withhold the tools (below) — that is a real guarantee.

```jsonc
// Everyone Alice knows within four hops
{"query": "MATCH (a:Person {name:$n})-[:KNOWS*1..4]->(r) RETURN DISTINCT r.name AS name",
 "params": {"n": "Alice"}}

// Bulk load, re-runnable after a failure
{"query": "UNWIND $rows AS row MERGE (p:Person {ext_id: row.ext_id}) SET p += row",
 "params": {"rows": [{"ext_id": "a", "name": "Alice"}]}}
```

**Differences from Neo4j** worth knowing before you write Cypher. Each is rejected *before* execution, so a rejected query changes nothing and fails identically on retry:

- Procedure calls (`CALL db.*`, `CALL apoc.*`) are rejected **by the server**, before it executes anything. `CALL { ... }` subqueries are fine. There is no schema tool and no `apoc.meta.schema()`; to learn a collection's structure, query it — `MATCH (n) UNWIND labels(n) AS l RETURN l, count(*) AS c ORDER BY l`.
- `LOAD CSV` is rejected — pass data through `params` instead.
- Existence checks are bare pattern predicates (`WHERE (p)-[:KNOWS]->()`); `EXISTS { ... }` and `exists()` are not accepted.
- `shortestPath` belongs in `RETURN`/`WITH`, not `MATCH p = ...`, and must be directed.
- `EXPLAIN`/`PROFILE` **execute** the query rather than planning it — do not use them to preview one.

Collections auto-create on first write, so there is no create-collection call. Requests are capped at 256 KiB (enforced locally, before upload) and large result sets are truncated server-side — paginate with `ORDER BY ... SKIP $offset LIMIT $limit`.

To turn the graph tools off entirely:

```
HYDRADB_MCP_GRAPH_TOOLS=0   # withhold all three
```

### Deprecated aliases

The previous `hydra_db_*` tool names are **no longer registered by default** as
of 1.2.0. If your `mcp.json` still calls them, set:

```
HYDRADB_MCP_LEGACY_TOOLS=1
```

| Deprecated alias | Use instead |
|---|---|
| `hydra_db_search` | `hydradb_query` |
| `hydra_db_store`, `hydra_db_ingest_conversation` | `hydradb_ingest` |
| `hydra_db_list_memories`, `hydra_db_list_sources` | `hydradb_list` |
| `hydra_db_fetch_content` | `hydradb_inspect` |
| `hydra_db_delete_memory` | `hydradb_delete` |

### **hydradb_query**

Searches **both** memories and ingested knowledge sources. Returns matching
chunks with their source id, a relevance score, and knowledge-graph context.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | What you want to know, as a question or topic |
| `kind` | string | No | `memory`, `knowledge`, or `all` (default: `all`) |
| `max_results` | number | No | Maximum chunks to return (1-50, default: 10) |
| `mode` | string | No | `fast`, `thinking` (default), or `auto` |
| `detail` | string | No | `compact` (default) trims each chunk; `full` returns them whole |
| `graph_context` | boolean | No | Include knowledge-graph relations (default: true) |
| `operator` | string | No | `or`, `and`, or `phrase`. Switches the query to keyword retrieval (`query_by=text`), which is the only mode Hydra DB accepts an operator on — semantic matching is off for that query. Unset (the default) is hybrid semantic search |
| `source_ids` | array | No | Restrict the search to these sources |
| `metadata_filters` | object | No | Exact-match filters over stored metadata |
| `num_related_chunks` | number | No | Adjacent chunks to attach per match (0-5, default: 0) |
| `recency_bias` | number | No | Favour recently-updated sources when ranking, 0-1 (default: 0). Re-ranks only; it never excludes older sources |
| `query_apps` | boolean | No | App-aware retrieval over connector sources — exact IDs and actors, thread reconstruction, parent/child expansion (default: false) |
| `collections` | array | No | Search several collections at once. Pass either this or `collection`, never both |

### **hydradb_ingest**

Saves information so it outlives the session. Provide **exactly one** of `text`
or `turns`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `text` | string | No\* | A note, fact, decision, or document body |
| `turns` | array | No\* | Conversation turns, each with `user` and `assistant` |
| `kind` | string | No | `memory` (default) or `knowledge` for a document |
| `title` | string | No | Label shown in later search results — always set it |
| `source_id` | string | No | Identifier for this entry. **Reusing one REPLACES what is stored under it** |
| `overwrite` | boolean | No | Allow that replacement (default: true) |
| `infer` | boolean | No | Extract insights and graph entities (default: true) |
| `is_markdown` | boolean | No | Chunk on markdown structure (default: false) |
| `metadata` | object | No | Key/value metadata, matchable later via `metadata_filters` |
| `observation_date` | string | No | When the fact was true, as `YYYY-MM-DD` (e.g. `2026-07-04`), vs when it was stored |
| `user_name` | string | No | What to call the user, used with `turns` (default: `User`) |

\* Passing both is an error; passing neither is an error.

Ingestion is **asynchronous** — content is not searchable the instant it is
saved. Use `hydradb_status` to confirm.

### **hydradb_list**

Enumerates one family at a time. These are separate corpora: listing memories
tells you nothing about which knowledge sources exist.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `kind` | string | **Yes** | `memory` or `knowledge` |
| `ids` | array | No | Restrict to these ids |
| `source_ids` | array | No | Deprecated alias for `ids` |
| `page` | number | No | Page to return, 1-indexed (default: 1) |
| `page_size` | number | No | Items per page (1-100) |

The response reports how many of the total it showed and how to reach the rest.

### **hydradb_inspect**

Fetches one source's full content by id.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | The source id, from `hydradb_query` or `hydradb_list` |
| `source_id` | string | No | Deprecated alias for `id` |
| `mode` | string | No | `content` (default), `url` for a download link, or `both` |
| `offset` | number | No | Character offset to read from (default: 0) |
| `limit` | number | No | Maximum characters to return (max 20000) |
| `expiry_seconds` | number | No | How long a `url` link stays valid |

Long sources come back in slices, and binary sources are never inlined — you get
their type and size, and `mode: "url"` returns a download link.

### **hydradb_subgraph**

Returns the connected subgraph of one item: every item reachable from it through
item-level links — explicit relations declared at ingest, a shared thread,
parent/child hierarchy — traversed breadth-first. Use it when one result is not
enough and you need what surrounds it: the rest of a Slack thread, the replies
under a ticket, the documents a page links to.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | The item to start from, from `hydradb_query` or `hydradb_list` |
| `kind` | string | No | `knowledge` (default) or `memory` — the two graphs are separate |
| `depth` | number | No | Hops to traverse (default 5, max 10) |
| `max_sources` | number | No | Cap on members returned (default 200, max 1000) |
| `database`, `collection` | string | No | Scope overrides |

Each member carries its id, title, depth from the start item and how it was
reached — `discovered_relation` is the mechanism (`same_thread`, `parent`,
`child`, or a `relates_to` type such as `reply_to`) and `discovered_via` the id
of the member it was reached from, so the list is also a tree.
`structuredContent` carries those same members, in the same order, plus
`relations`: the edges among them as `{from, to, type}`, so a client can rebuild
the graph and not just the list. `truncated` means `max_sources` clipped the
traversal; `structural_link_count` and `structural_truncated` report the
structural graph (entities, comments, attachments, actors) around the members.
Chunk-level entity relations are not included; those come from `hydradb_query`.

### **hydradb_delete**

Removes items by id. Irreversible.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ids` | array | No\* | The ids to delete — accepts several at once |
| `id` | string | No\* | A single id |
| `kind` | string | No | `memory` (default) or `knowledge` |

\* Provide one of them.

### **hydradb_status**

Checks whether ingested sources have finished indexing.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ids` | array | Yes | The source ids to check |

## Configuration

### Get Your Credentials

1. Get your Hydra DB API Key from [Hydra DB](https://app.hydradb.com)
2. Get your database name from the Hydra DB dashboard

### Environment Variables

| Variable             | Description                          | Default                   |
| -------------------- | ------------------------------------ | ------------------------- |
| `HYDRADB_API_KEY`    | Your Hydra DB API key                | *Required*                |
| `HYDRADB_DATABASE`   | Your Hydra DB database (tenant scope) | *Required*                |
| `HYDRADB_COLLECTION` | Collection (sub-tenant) for partitioning | `hydra-db-mcp`        |
| `HYDRADB_BASE_URL`   | Base URL override                    | `https://api.hydradb.com` |
| `HYDRADB_LOG_LEVEL`  | Log level: DEBUG, INFO, WARN, ERROR  | `ERROR`                   |
| `HYDRADB_TIMEOUT_SECONDS` | Per-attempt request timeout     | `30`                      |
| `HYDRADB_MAX_RETRIES` | Retries per request (0 disables)    | `2`                       |
| `HYDRADB_MCP_LEGACY_TOOLS` | Register the deprecated `hydra_db_*` tools | *off* |
| `HYDRADB_GRAPH_DATABASE` | Default graph database for the Cypher tools | `HYDRADB_DATABASE` |
| `HYDRADB_GRAPH_COLLECTION` | Default graph collection | `default` |
| `HYDRADB_MCP_GRAPH_TOOLS` | Register the graph tools (`0` withholds them) | *on* |

A graph database is a **different namespace** from the memory database: the same
name can exist as both, and Cypher aimed at the wrong one reads an empty graph
rather than failing. Every graph tool also takes `database` and `collection`
per call, overriding these defaults.

The legacy `HYDRA_DB_*` names — `HYDRA_DB_API_KEY`, `HYDRA_DB_TENANT_ID`,
`HYDRA_DB_SUB_TENANT_ID`, `HYDRA_DB_BASE_URL`, `HYDRA_DB_LOG_LEVEL` — remain
honoured as **deprecated aliases** (canonical wins when both are set; using an
alias prints a one-time warning naming its replacement).

### Claude Desktop

```json
{
  "mcpServers": {
    "hydradb": {
      "command": "npx",
      "args": ["-y", "@hydradb/mcp@latest"],
      "env": {
        "HYDRADB_API_KEY": "your-api-key",
        "HYDRADB_DATABASE": "your-database"
      }
    }
  }
}
```

### Cursor & Windsurf

| Client   | Config File                             |
| -------- | --------------------------------------- |
| Cursor   | `~/.cursor/mcp.json`                  |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |

```json
{
  "mcpServers": {
    "hydradb": {
      "command": "npx",
      "args": ["-y", "@hydradb/mcp@latest"],
      "env": {
        "HYDRADB_API_KEY": "your-api-key",
        "HYDRADB_DATABASE": "your-database"
      }
    }
  }
}
```

### VS Code

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "hydradb": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@hydradb/mcp@latest"],
      "env": {
        "HYDRADB_API_KEY": "your-api-key",
        "HYDRADB_DATABASE": "your-database"
      }
    }
  }
}
```

### Custom Sub-Tenant

To partition data, set the `HYDRADB_COLLECTION` environment variable:

```json
{
  "mcpServers": {
    "hydradb": {
      "command": "npx",
      "args": ["-y", "@hydradb/mcp@latest"],
      "env": {
        "HYDRADB_API_KEY": "your-api-key",
        "HYDRADB_DATABASE": "your-database",
        "HYDRADB_COLLECTION": "my-project"
      }
    }
  }
}
```

## Remote / hosted server

Everything above spawns the server locally over stdio. The same server also runs
as a long-lived **HTTP endpoint** that many clients reach at one URL — nothing to
install or update per user. This is what powers a hosted deployment like
`https://mcp.hydradb.com`, and what you run yourself with `npm run start:http`
or the Docker image.

The tool surface is identical; only how a client connects and authenticates
changes.

### Point a client at a URL

MCP clients that support a remote (`streamable-http`) server take a URL and
headers instead of a command:

```jsonc
{
  "mcpServers": {
    "hydradb": {
      "url": "https://mcp.hydradb.com",
      "headers": {
        "Authorization": "Bearer YOUR_HYDRADB_API_KEY",
        "X-HydraDB-Database": "your-database"
      }
    }
  }
}
```

Every request carries its own credentials, so one hosted process serves any
number of independent users. The headers a request may send:

| Header | Maps to | Required |
| --- | --- | --- |
| `Authorization: Bearer <key>` | Hydra DB API key (`X-HydraDB-Api-Key` also accepted) | Yes\* |
| `X-HydraDB-Database` | Default database (tenant scope) | Yes\* |
| `X-HydraDB-Collection` | Default collection (sub-tenant); defaults to `hydra-db-mcp` | No |
| `X-HydraDB-Graph-Database` | Default graph database for the Cypher tools; defaults to the request's database | No |
| `X-HydraDB-Graph-Collection` | Default graph collection; defaults to `default` | No |

\* Unless the server was started with `HYDRADB_API_KEY` / `HYDRADB_DATABASE` in
its environment (single-tenant self-host, below), in which case a request may
omit them and fall back to the server's own credentials. A request that supplies
neither a header nor a server-side default is refused: `401` with no key, `400`
with a key but no database.

Every tool additionally accepts optional `database` and `collection` parameters
directly in its arguments (e.g. `hydradb_query` with `{"query": "...", "database": "tenant_b"}`),
allowing multi-tenant agents to switch tenant scope per tool call while falling
back to the session defaults when omitted.

`Base URL`, request timeout and retry count are
**operator** settings read from the server's environment and are never taken
from a request header.

### Run the HTTP server

**Node:**

```bash
npm ci && npm run build
# Single-tenant: the server holds one account; clients send no credentials.
HYDRADB_API_KEY=your-key HYDRADB_DATABASE=your-database npm run start:http
# Multi-tenant: no account in the env; every client sends its own headers.
BIND_ADDRESS=0.0.0.0 ALLOWED_HOSTS=mcp.hydradb.com npm run start:http
```

**Docker:**

```bash
docker build -t hydradb-mcp .
# Single-tenant
docker run -p 8080:8080 -e HYDRADB_API_KEY=your-key -e HYDRADB_DATABASE=your-database hydradb-mcp
# Multi-tenant (clients authenticate per request)
docker run -p 8080:8080 -e ALLOWED_HOSTS=mcp.hydradb.com hydradb-mcp
```

The primary MCP endpoint is `/` (with `/mcp` supported as an alias); `GET /health` is an unauthenticated liveness probe.
The image binds `0.0.0.0` inside the container (the host controls exposure with
`-p`) and runs as an unprivileged user.

### Sign in with HydraDB (OAuth)

With three extra variables the hosted server also speaks the MCP authorization flow: a client that arrives with no credentials gets a `401` pointing at `/.well-known/oauth-protected-resource`, discovers the HydraDB dashboard as its authorization server, opens the browser, and the user signs in and picks a database. No key is ever pasted into a client.

| Variable | Description |
| --- | --- |
| `HYDRADB_OAUTH_ISSUER` | The authorization server, e.g. `https://app.hydradb.com`. Must match its `NEXTAUTH_URL` exactly |
| `HYDRADB_MCP_PUBLIC_URL` | This server's public URL as clients see it, e.g. `https://mcp.hydradb.com`. Tokens minted for any other audience are refused |
| `HYDRADB_OAUTH_INTROSPECTION_SECRET` | Shared secret the issuer's `/api/oauth/introspect` expects; must equal the dashboard's `MCP_INTROSPECTION_SECRET` |

All three are required together. With any of them missing, OAuth stays off and the server behaves exactly as before: no new routes, no new headers. Token introspection answers are memoised for up to 30 seconds, so disconnecting an app from the dashboard takes effect within that window.

OAuth is purely additive. API keys in `Authorization` / `X-HydraDB-Api-Key` headers, the `X-HydraDB-Database` header and the single-tenant environment fallback all keep working unchanged on the same URL.

### Server environment variables


These configure the HTTP process itself (the stdio server ignores them). All
the `HYDRADB_*` variables from [Environment Variables](#environment-variables)
also apply — as the single-tenant default and as operator settings.

| Variable | Description | Default |
| --- | --- | --- |
| `PORT` | Port to listen on | `8080` |
| `BIND_ADDRESS` | Interface to bind (`0.0.0.0` to accept off-host) | `127.0.0.1` |
| `ALLOWED_HOSTS` | Extra `Host` headers to accept (comma-separated); loopback always allowed | *(loopback only)* |
| `ALLOWED_ORIGINS` | CORS origins for browser clients (comma-separated; `*` allows any) | *(none)* |
| `TRUST_PROXY` | Express `trust proxy` when behind a reverse proxy: a hop count, `true`, or a subnet preset (`loopback`) | *off* |

### Security

The defaults are safe for local use and must be widened deliberately for a
public deployment — see [SECURITY.md](SECURITY.md):

- **Bind loopback by default.** `BIND_ADDRESS` stays `127.0.0.1` until you set
  otherwise; `0.0.0.0` exposes the server on every interface and logs a warning.
- **Host allowlist.** Requests whose `Host` is not loopback or in `ALLOWED_HOSTS`
  get `421 Misdirected Request` — a DNS-rebinding defence. Add your public
  hostname when binding publicly.
- **CORS is closed by default.** No cross-origin browser request is accepted
  until you list its origin in `ALLOWED_ORIGINS`. Non-browser clients (no
  `Origin` header) are unaffected.
- **Terminate TLS in front.** Run the server behind a reverse proxy / load
  balancer that handles HTTPS; do not expose plain HTTP to the internet.

## How It Works

The server talks to Hydra DB through the generated [`@hydradb/sdk`](https://www.npmjs.com/package/@hydradb/sdk)
(pinned exactly), behind a thin hand-owned wrapper in `src/hydra`. The wrapper
owns scope injection, envelope unwrapping and error translation; the tools call
it and render the results.

- **hydradb_query** retrieves relevant memories and returns graph-enriched context (entity paths, chunk relations, extra context). Supports `fast` and `thinking` recall modes.
- **hydradb_ingest** stores a note (`text`) or a conversation (`turns`) as a memory, with configurable `infer`, `is_markdown`, `title`, and `source_id`. Hydra DB extracts insights and builds a knowledge graph automatically.
- **hydradb_list** browses stored memories (`kind: memory`) or ingested knowledge sources (`kind: knowledge`, with an optional `source_ids` filter).
- **hydradb_inspect** retrieves the original ingested content of a source, with mode options (`content`, `url`, or `both`).
- **hydradb_delete** removes a memory or knowledge source by ID.

## Development

```bash
npm ci
npm run build
HYDRADB_API_KEY=your-key HYDRADB_DATABASE=your-database npm start
```

For development with auto-reload:

```bash
HYDRADB_API_KEY=your-key HYDRADB_DATABASE=your-database npm run dev
```

To run the HTTP transport locally (see [Remote / hosted server](#remote--hosted-server)):

```bash
HYDRADB_API_KEY=your-key HYDRADB_DATABASE=your-database npm run dev:http
# then: curl localhost:8080/health
```

## Testing

```bash
# unit + conformance tests (wrapper driven against a mocked SDK transport)
npm test

# just the shared conformance vectors
npm run test:conformance

# live integration test against Hydra DB (drives the wrapper end to end)
RUN_LIVE_TESTS=true HYDRADB_API_KEY=your-key HYDRADB_DATABASE=your-database npm run test:integration
```

## Troubleshooting

- **API Key Issues**: Ensure `HYDRADB_API_KEY` is set correctly
- **Connection Errors**: Check your internet connection and API key validity
- **Tool Not Found**: Make sure the package is installed and the command path is correct
- **Debug Logging**: Set `HYDRADB_LOG_LEVEL=DEBUG` for verbose output

## Contributing / Developer Setup

Get up and running quickly with the bootstrap script:

```bash
git clone https://github.com/usecortex/hydradb-mcp.git
cd hydradb-mcp
make bootstrap
```

This will install dependencies, build the project, and create a `.env` file from `.env.example`. Edit `.env` with your HydraDB credentials, then:

```bash
make dev          # Start MCP server in dev mode (auto-reload)
make test         # Run unit tests
make test-all     # Run unit + integration tests
make check-types  # Type-check without emitting
```

Run `make help` to see all available targets.
