# Hydra DB — MCP Server

MCP (Model Context Protocol) server for [Hydra DB](https://hydradb.com), the state-of-the-art agentic memory. Provides tools for storing, recalling, and managing memories with knowledge-graph enriched context.

## Available Tools

### **hydra_db_search**

Search through Hydra DB memories. Returns relevant chunks with graph-enriched context including entity paths and knowledge graph relations.

### **hydra_db_store**

Save important information to Hydra DB memory. Hydra DB automatically extracts insights, preferences, and builds a knowledge graph from the stored content.

### **hydra_db_ingest_conversation**

Ingest user-assistant conversation turns into Hydra DB memory. Hydra DB extracts insights, preferences, and knowledge graph entities from the conversation.

### **hydra_db_list_memories**

List all stored user memories in Hydra DB. Returns memory IDs and their content.

### **hydra_db_delete_memory**

Delete a specific user memory from Hydra DB by its memory ID.

### **hydra_db_fetch_content**

Fetch the full content of a specific source by its source ID.

### **hydra_db_list_sources**

List all ingested sources in Hydra DB memory.

## Configuration

### Get Your Credentials

1. Get your Hydra DB API Key from [Hydra DB](https://app.hydradb.com)
2. Get your Tenant ID from the Hydra DB dashboard

### Environment Variables

| Variable                 | Description                         | Default        |
| ------------------------ | ----------------------------------- | -------------- |
| `HYDRA_DB_API_KEY`       | Your Hydra-DB API key                 | *Required*   |
| `HYDRA_DB_TENANT_ID`     | Your Hydra-DB tenant identifier       | *Required*   |
| `HYDRA_DB_SUB_TENANT_ID` | Sub-tenant for data partitioning    | `hydra-db-mcp` |
| `HYDRA_DB_LOG_LEVEL`     | Log level: DEBUG, INFO, WARN, ERROR | `ERROR`      |

### Claude Desktop

```json
{
  "mcpServers": {
        "hydradb": {
      "command": "npx",
      "args": ["-y", "@hydra_db/mcp@0.1.1"],
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
      "args": ["-y", "@hydra_db/mcp@0.1.1"],
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
      "args": ["-y", "@hydra_db/mcp@0.1.1"],
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
      "args": ["-y", "@hydra_db/mcp@0.1.1"],
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

- **hydra_db_search** queries `/recall/recall_preferences` for relevant memories and returns graph-enriched context (entity paths, chunk relations, extra context).
- **hydra_db_store** sends text to `/memories/add_memory` with `infer: true` and `upsert: true`. Hydra-DB extracts insights and builds a knowledge graph automatically.
- **hydra_db_ingest_conversation** sends user-assistant pairs to `/memories/add_memory` as conversation turns, grouped by `source_id`.
- **hydra_db_list_memories** and **hydra_db_list_sources** query `/list/data` to browse stored data.
- **hydra_db_delete_memory** calls `DELETE /memories/delete_memory` to remove a specific memory.
- **hydra_db_fetch_content** calls `/fetch/content` to retrieve the original ingested content.

## Development

```bash
npm install
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

