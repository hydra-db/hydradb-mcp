# Hydra DB — MCP Server

MCP (Model Context Protocol) server for [Hydra DB](https://hydradb.com), the state-of-the-art agentic memory. Provides tools for storing, recalling, and managing memories with knowledge-graph enriched context.

## Available Tools

### **hydra_db_search**

Search through Hydra DB memories. Returns relevant chunks with graph-enriched context including entity paths and knowledge graph relations.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | The search query to find relevant memories |
| `max_results` | number | No | Maximum number of memory chunks to return (1-50, default: 10) |
| `mode` | string | No | Recall mode: `fast` for quick semantic search, `thinking` for deeper personalised recall with graph traversal (default: `thinking`) |
| `graph_context` | boolean | No | Whether to include knowledge graph relations in results (default: true) |

### **hydra_db_store**

Save important information to Hydra DB memory. Hydra DB automatically extracts insights, preferences, and builds a knowledge graph from the stored content. Supports plain text and markdown.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `text` | string | Yes | The information to store in memory |
| `title` | string | No | Title for the memory entry (default: `MCP Memory`) |
| `source_id` | string | No | Source identifier to group related memories together (e.g. session ID) |
| `infer` | boolean | No | Whether Hydra DB should extract insights and build knowledge graph (default: true) |
| `is_markdown` | boolean | No | Whether the text is in markdown format (default: false) |

### **hydra_db_ingest_conversation**

Ingest user-assistant conversation turns into Hydra DB memory. Hydra DB extracts insights, preferences, and knowledge graph entities from the conversation.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `turns` | array | Yes | Array of conversation turns, each with a `user` and `assistant` field |
| `source_id` | string | Yes | Source identifier to group all turns from the same session together |
| `user_name` | string | No | Name of the user for personalisation (default: `User`) |

### **hydra_db_list_memories**

List all stored user memories in Hydra DB. Returns memory IDs and their content. No parameters required.

### **hydra_db_delete_memory**

Delete a specific user memory from Hydra DB by its memory ID. This action is irreversible.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `memory_id` | string | Yes | The ID of the memory to delete |

### **hydra_db_fetch_content**

Fetch the full content of a specific source by its source ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `source_id` | string | Yes | The source ID to fetch content for |
| `mode` | string | No | Fetch mode: `content` for text, `url` for presigned URL, `both` for both (default: `content`) |

### **hydra_db_list_sources**

List all ingested sources in Hydra DB memory. Returns source IDs, titles, types, and metadata.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `source_ids` | array | No | Array of specific source IDs to filter by. If omitted, lists all sources |

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

- **hydra_db_search** queries `POST /recall/recall_preferences` for relevant memories and returns graph-enriched context (entity paths, chunk relations, extra context). Supports `fast` and `thinking` recall modes.
- **hydra_db_store** sends text to `POST /memories/add_memory` with configurable `infer`, `upsert`, `is_markdown`, `title`, and `source_id` options. Hydra DB extracts insights and builds a knowledge graph automatically.
- **hydra_db_ingest_conversation** sends user-assistant pairs to `POST /memories/add_memory` as conversation turns, grouped by `source_id`.
- **hydra_db_list_memories** queries `POST /list/data` (kind: `memories`) to browse stored memories.
- **hydra_db_list_sources** queries `POST /list/data` (kind: `knowledge`) to browse ingested sources, with optional `source_ids` filter.
- **hydra_db_delete_memory** calls `DELETE /memories/delete_memory` to remove a specific memory.
- **hydra_db_fetch_content** calls `POST /fetch/content` to retrieve the original ingested content, with mode options (`content`, `url`, or `both`).

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
