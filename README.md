# Hydra DB — MCP Server

MCP (Model Context Protocol) server for [Hydra DB](https://hydradb.com), the state-of-the-art agentic memory. Provides tools for storing, recalling, and managing memories with knowledge-graph enriched context.

## Available Tools

The tool names follow the canonical HydraDB vocabulary. Every previous name still
works as a **deprecated alias** (marked as such in its description) so existing
`mcp.json` files keep working — but new integrations should use the canonical
names below.

| Canonical tool | Deprecated alias(es) |
|---|---|
| `hydradb_query` | `hydra_db_search` |
| `hydradb_ingest` | `hydra_db_store`, `hydra_db_ingest_conversation` |
| `hydradb_list` | `hydra_db_list_memories`, `hydra_db_list_sources` |
| `hydradb_inspect` | `hydra_db_fetch_content` |
| `hydradb_delete` | `hydra_db_delete_memory` |

### **hydradb_query**

Search through Hydra DB memories. Returns relevant chunks with graph-enriched context including entity paths and knowledge graph relations.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | The search query to find relevant memories |
| `max_results` | number | No | Maximum number of memory chunks to return (1-50, default: 10) |
| `mode` | string | No | Recall mode: `fast` for quick semantic search, `thinking` for deeper personalised recall with graph traversal (default: `thinking`) |
| `graph_context` | boolean | No | Whether to include knowledge graph relations in results (default: true) |

### **hydradb_ingest**

Save information to Hydra DB memory. Hydra DB automatically extracts insights, preferences, and builds a knowledge graph from the stored content. Provide `text` to store a note/document, or `turns` to ingest a conversation.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `text` | string | No\* | The information to store in memory |
| `title` | string | No | Title for the memory entry (default: `MCP Memory`) |
| `source_id` | string | No | Source identifier to group related memories together (e.g. session ID) |
| `infer` | boolean | No | Whether Hydra DB should extract insights and build knowledge graph (default: true) |
| `is_markdown` | boolean | No | Whether the text is in markdown format (default: false) |
| `turns` | array | No\* | Conversation turns (each with a `user` and `assistant` field) to ingest instead of `text` |
| `user_name` | string | No | Name of the user for personalisation, used with `turns` (default: `User`) |

\* Provide exactly one of `text` or `turns`.

### **hydradb_list**

List stored memories or ingested knowledge sources in Hydra DB.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `kind` | string | No | Which family to list: `memory` or `knowledge` (default: `memory`) |
| `source_ids` | array | No | For `knowledge`, an array of specific source IDs to filter by. If omitted, lists all |

### **hydradb_inspect**

Fetch the full content of a specific source by its source ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `source_id` | string | Yes | The source ID to fetch content for |
| `mode` | string | No | Fetch mode: `content` for text, `url` for presigned URL, `both` for both (default: `content`) |

### **hydradb_delete**

Delete a memory or knowledge source from Hydra DB by its ID. This action is irreversible.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | Yes | The ID of the item to delete |
| `kind` | string | No | Which family the ID belongs to: `memory` or `knowledge` (default: `memory`) |

## Configuration

### Get Your Credentials

1. Get your Hydra DB API Key from [Hydra DB](https://app.hydradb.com)
2. Get your Tenant ID from the Hydra DB dashboard

### Environment Variables

| Variable                 | Description                         | Default        |
| ------------------------ | ----------------------------------- | -------------- |
| `HYDRA_DB_API_KEY`       | Your Hydra DB API key               | *Required*     |
| `HYDRA_DB_TENANT_ID`     | Your Hydra DB tenant identifier     | *Required*     |
| `HYDRA_DB_SUB_TENANT_ID` | Sub-tenant for data partitioning    | `hydra-db-mcp` |
| `HYDRA_DB_LOG_LEVEL`     | Log level: DEBUG, INFO, WARN, ERROR | `ERROR`        |

### Claude Desktop

```json
{
  "mcpServers": {
    "hydradb": {
      "command": "npx",
      "args": ["-y", "@hydradb/mcp@latest"],
      "env": {
        "HYDRA_DB_API_KEY": "your-api-key",
        "HYDRA_DB_TENANT_ID": "your-tenant-id"
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
        "HYDRA_DB_API_KEY": "your-api-key",
        "HYDRA_DB_TENANT_ID": "your-tenant-id"
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
        "HYDRA_DB_API_KEY": "your-api-key",
        "HYDRA_DB_TENANT_ID": "your-tenant-id"
      }
    }
  }
}
```

### Custom Sub-Tenant

To partition data, set the `HYDRA_DB_SUB_TENANT_ID` environment variable:

```json
{
  "mcpServers": {
    "hydradb": {
      "command": "npx",
      "args": ["-y", "@hydradb/mcp@latest"],
      "env": {
        "HYDRA_DB_API_KEY": "your-api-key",
        "HYDRA_DB_TENANT_ID": "your-tenant-id",
        "HYDRA_DB_SUB_TENANT_ID": "my-project"
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
HYDRA_DB_API_KEY=your-key HYDRA_DB_TENANT_ID=your-tenant npm start
```

For development with auto-reload:

```bash
HYDRA_DB_API_KEY=your-key HYDRA_DB_TENANT_ID=your-tenant npm run dev
```

## Testing

```bash
# unit tests (mocked HTTP)
npm test

# live integration test against Hydra DB
RUN_LIVE_TESTS=true HYDRA_DB_API_KEY=your-key HYDRA_DB_TENANT_ID=your-tenant npm run test:integration
```

## Troubleshooting

- **API Key Issues**: Ensure `HYDRA_DB_API_KEY` is set correctly
- **Connection Errors**: Check your internet connection and API key validity
- **Tool Not Found**: Make sure the package is installed and the command path is correct
- **Debug Logging**: Set `HYDRA_DB_LOG_LEVEL=DEBUG` for verbose output

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
