# Cortex AI — MCP Server

MCP (Model Context Protocol) server for [Cortex AI](https://usecortex.ai), th state-of-the-art agentic memory. Provides tools for storing, recalling, and managing memories with knowledge-graph enriched context.

## Available Tools

### **cortex_search**

Search through Cortex AI memories. Returns relevant chunks with graph-enriched context including entity paths and knowledge graph relations.

### **cortex_store**

Save important information to Cortex AI memory. Cortex automatically extracts insights, preferences, and builds a knowledge graph from the stored content.

### **cortex_ingest_conversation**

Ingest user-assistant conversation turns into Cortex AI memory. Cortex extracts insights, preferences, and knowledge graph entities from the conversation.

### **cortex_list_memories**

List all stored user memories in Cortex AI. Returns memory IDs and their content.

### **cortex_delete_memory**

Delete a specific user memory from Cortex AI by its memory ID.

### **cortex_fetch_content**

Fetch the full content of a specific source by its source ID.

### **cortex_list_sources**

List all ingested sources in Cortex AI memory.

## Configuration

### Get Your Credentials

1. Get your Cortex API Key from [Cortex AI](https://app.usecortex.ai)
2. Get your Tenant ID from the Cortex dashboard

### Environment Variables

| Variable                 | Description                         | Default        |
| ------------------------ | ----------------------------------- | -------------- |
| `CORTEX_API_KEY`       | Your Cortex API key                 | *Required*   |
| `CORTEX_TENANT_ID`     | Your Cortex tenant identifier       | *Required*   |
| `CORTEX_SUB_TENANT_ID` | Sub-tenant for data partitioning    | `cortex-mcp` |
| `CORTEX_LOG_LEVEL`     | Log level: DEBUG, INFO, WARN, ERROR | `ERROR`      |

### Claude Desktop

```json
{
  "mcpServers": {
    "cortex": {
      "command": "npx",
      "args": ["-y", "@usecortex_ai/mcp@0.0.1"],
      "env": {
        "CORTEX_API_KEY": "your-api-key",
        "CORTEX_TENANT_ID": "your-tenant-id"
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
    "cortex": {
      "command": "npx",
      "args": ["-y", "@usecortex_ai/mcp@0.0.1"],
      "env": {
        "CORTEX_API_KEY": "your-api-key",
        "CORTEX_TENANT_ID": "your-tenant-id"
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
    "cortex": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@usecortex_ai/mcp@0.0.1"],
      "env": {
        "CORTEX_API_KEY": "your-api-key",
        "CORTEX_TENANT_ID": "your-tenant-id"
      }
    }
  }
}
```

### Custom Sub-Tenant

To partition data, set the `CORTEX_SUB_TENANT_ID` environment variable:

```json
{
  "mcpServers": {
    "cortex": {
      "command": "npx",
      "args": ["-y", "@usecortex_ai/mcp@0.0.1"],
      "env": {
        "CORTEX_API_KEY": "your-api-key",
        "CORTEX_TENANT_ID": "your-tenant-id",
        "CORTEX_SUB_TENANT_ID": "my-project"
      }
    }
  }
}
```

## How It Works

- **cortex_search** queries `/recall/recall_preferences` for relevant memories and returns graph-enriched context (entity paths, chunk relations, extra context).
- **cortex_store** sends text to `/memories/add_memory` with `infer: true` and `upsert: true`. Cortex extracts insights and builds a knowledge graph automatically.
- **cortex_ingest_conversation** sends user-assistant pairs to `/memories/add_memory` as conversation turns, grouped by `source_id`.
- **cortex_list_memories** and **cortex_list_sources** query `/list/data` to browse stored data.
- **cortex_delete_memory** calls `DELETE /memories/delete_memory` to remove a specific memory.
- **cortex_fetch_content** calls `/fetch/content` to retrieve the original ingested content.

## Development

```bash
npm install
npm run build
CORTEX_API_KEY=your-key CORTEX_TENANT_ID=your-tenant npm start
```

For development with auto-reload:

```bash
CORTEX_API_KEY=your-key CORTEX_TENANT_ID=your-tenant npm run dev
```

## Troubleshooting

- **API Key Issues**: Ensure `CORTEX_API_KEY` is set correctly
- **Connection Errors**: Check your internet connection and API key validity
- **Tool Not Found**: Make sure the package is installed and the command path is correct
- **Debug Logging**: Set `CORTEX_LOG_LEVEL=DEBUG` for verbose output
