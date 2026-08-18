# Hydra DB — MCP Server

MCP (Model Context Protocol) server for [Hydra DB](https://hydradb.com), the state-of-the-art agentic memory. Provides tools for storing, recalling, and managing memories with knowledge-graph enriched context.

## Available Tools

| Tool | What it does |
|---|---|
| `hydradb_query` | Search memories and knowledge together, with knowledge-graph context |
| `hydradb_ingest` | Save a note, a document, or a conversation |
| `hydradb_list` | Enumerate one family — every memory, or every knowledge source |
| `hydradb_inspect` | Fetch one source's full content by id |
| `hydradb_delete` | Remove one or more items by id, irreversibly |
| `hydradb_status` | Check whether an ingested source has finished indexing |

Ids flow between these: `hydradb_query` and `hydradb_list` emit them;
`hydradb_inspect`, `hydradb_delete` and `hydradb_status` accept them.

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
