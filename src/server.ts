import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HydraDBClient } from "./client.js";
import { buildRecalledContext } from "./context.js";
import { TOOL_DESCRIPTIONS, SERVER_INSTRUCTIONS } from "./descriptions.js";
import { logger } from "./logger.js";
import { TOOL_NAMES } from "./tool-names.js";

const DEFAULT_SUB_TENANT = "hydra-db-mcp";

function getConfig() {
	const apiKey = process.env.HYDRA_DB_API_KEY;
	if (!apiKey) {
		throw new Error(
			"HYDRA_DB_API_KEY environment variable is required",
		);
	}

	const tenantId = process.env.HYDRA_DB_TENANT_ID;
	if (!tenantId) {
		throw new Error(
			"HYDRA_DB_TENANT_ID environment variable is required",
		);
	}

	const subTenantId = process.env.HYDRA_DB_SUB_TENANT_ID || DEFAULT_SUB_TENANT;

	return { apiKey, tenantId, subTenantId };
}

export function createHydraDBServer() {
	const server = new McpServer(
		{
			name: "hydradb-mcp",
			version: "1.0.0",
		},
		{
			instructions: SERVER_INSTRUCTIONS,
		},
	);

	const config = getConfig();
	const client = new HydraDBClient(
		config.apiKey,
		config.tenantId,
		config.subTenantId,
	);

	// --- Search ---

	const desc = TOOL_DESCRIPTIONS[TOOL_NAMES.SEARCH];
	server.registerTool(
		TOOL_NAMES.SEARCH,
		{
			title: desc.title,
			description: desc.description,
			inputSchema: {
				query: z.string().describe(desc.params.query),
				max_results: z
					.number()
					.min(1)
					.max(50)
					.optional()
					.describe(desc.params.max_results),
				mode: z
					.enum(["fast", "thinking"])
					.optional()
					.describe(desc.params.mode),
				graph_context: z
					.boolean()
					.optional()
					.describe(desc.params.graph_context),
			} as any,
			annotations: {
				readOnlyHint: true,
				openWorldHint: true,
				idempotentHint: true,
			},
		},
		async (args: any) => {
			const {
				query,
				max_results,
				mode,
				graph_context,
			} = args as {
				query: string;
				max_results?: number;
				mode?: "fast" | "thinking";
				graph_context?: boolean;
			};

			logger.debug(`${TOOL_NAMES.SEARCH}: "${query}"`);

			const res = await client.recall(query, {
				maxResults: max_results ?? 10,
				mode: mode ?? "thinking",
				graphContext: graph_context ?? true,
			});

			if (!res.chunks || res.chunks.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: "No relevant memories found in Hydra DB.",
						},
					],
				};
			}

			const contextStr = buildRecalledContext(res);
			const summary = res.chunks.slice(0, 10).map((c, i) => {
				const score =
					c.relevancy_score != null
						? ` (${Math.round(c.relevancy_score * 100)}%)`
						: "";
				const snippet =
					c.chunk_content.length > 150
						? `${c.chunk_content.slice(0, 150)}...`
						: c.chunk_content;
				return `${i + 1}. ${snippet}${score}`;
			});

			return {
				content: [
					{
						type: "text" as const,
						text: `Found ${res.chunks.length} memories:\n\n${summary.join("\n")}\n\n---\nFull context:\n${contextStr}`,
					},
				],
			};
		},
	);

	// --- Store ---

	const storeDesc = TOOL_DESCRIPTIONS[TOOL_NAMES.STORE];
	server.registerTool(
		TOOL_NAMES.STORE,
		{
			title: storeDesc.title,
			description: storeDesc.description,
			inputSchema: {
				text: z.string().describe(storeDesc.params.text),
				title: z
					.string()
					.optional()
					.describe(storeDesc.params.title),
				source_id: z
					.string()
					.optional()
					.describe(storeDesc.params.source_id),
				infer: z
					.boolean()
					.optional()
					.describe(storeDesc.params.infer),
				is_markdown: z
					.boolean()
					.optional()
					.describe(storeDesc.params.is_markdown),
			} as any,
		},
		async (args: any) => {
			const { text, title, source_id, infer, is_markdown } = args as {
				text: string;
				title?: string;
				source_id?: string;
				infer?: boolean;
				is_markdown?: boolean;
			};

			logger.debug(`${TOOL_NAMES.STORE}: "${text.slice(0, 50)}..."`);

			const res = await client.ingestText(text, {
				sourceId: source_id,
				title: title ?? "MCP Memory",
				infer: infer ?? true,
				isMarkdown: is_markdown ?? false,
			});

			const preview =
				text.length > 80 ? `${text.slice(0, 80)}...` : text;

			return {
				content: [
						{
							type: "text" as const,
							text: `Saved to Hydra DB (${res.success_count} success, ${res.failed_count} failed): "${preview}"`,
						},
				],
			};
		},
	);

	// --- Ingest Conversation ---

	const ingestDesc = TOOL_DESCRIPTIONS[TOOL_NAMES.INGEST_CONVERSATION];
	const turnSchema = z.object({
		user: z.string().describe("The user's message"),
		assistant: z.string().describe("The assistant's response"),
	});

	server.registerTool(
		TOOL_NAMES.INGEST_CONVERSATION,
		{
			title: ingestDesc.title,
			description: ingestDesc.description,
			inputSchema: {
				turns: z
					.array(turnSchema)
					.min(1)
					.describe(ingestDesc.params.turns),
				source_id: z
					.string()
					.describe(ingestDesc.params.source_id),
				user_name: z
					.string()
					.optional()
					.describe(ingestDesc.params.user_name),
			} as any,
		},
		async (args: any) => {
			const { turns, source_id, user_name } = args as {
				turns: { user: string; assistant: string }[];
				source_id: string;
				user_name?: string;
			};

			logger.debug(
				`${TOOL_NAMES.INGEST_CONVERSATION}: ${turns.length} turns -> ${source_id}`,
			);

			const res = await client.ingestConversation(
				turns,
				source_id,
				user_name,
			);

			return {
				content: [
						{
							type: "text" as const,
							text: `Ingested ${turns.length} conversation turn(s) into Hydra DB (source: ${source_id}, success: ${res.success_count}, failed: ${res.failed_count})`,
						},
				],
			};
		},
	);

	// --- List Memories ---

	const listDesc = TOOL_DESCRIPTIONS[TOOL_NAMES.LIST_MEMORIES];
	server.registerTool(
		TOOL_NAMES.LIST_MEMORIES,
		{
			title: listDesc.title,
			description: listDesc.description,
			inputSchema: {} as any,
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async () => {
			logger.debug(TOOL_NAMES.LIST_MEMORIES);

			const res = await client.listMemories();
			const memories = res.user_memories ?? [];

			if (memories.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: "No memories stored yet.",
						},
					],
				};
			}

			const lines = memories.map(
				(m, i) =>
					`${i + 1}. [${m.memory_id}] ${m.memory_content.slice(0, 150)}`,
			);

			return {
				content: [
					{
						type: "text" as const,
						text: `${memories.length} memories:\n\n${lines.join("\n")}`,
					},
				],
			};
		},
	);

	// --- Delete Memory ---

	const deleteDesc = TOOL_DESCRIPTIONS[TOOL_NAMES.DELETE_MEMORY];
	server.registerTool(
		TOOL_NAMES.DELETE_MEMORY,
		{
			title: deleteDesc.title,
			description: deleteDesc.description,
			inputSchema: {
				memory_id: z.string().describe(deleteDesc.params.memory_id),
			} as any,
		},
		async (args: any) => {
			const { memory_id } = args as { memory_id: string };

			logger.debug(`${TOOL_NAMES.DELETE_MEMORY}: ${memory_id}`);

			const res = await client.deleteMemory(memory_id);

			if (res.user_memory_deleted) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Deleted memory: ${memory_id}`,
						},
					],
				};
			}

			return {
				content: [
					{
						type: "text" as const,
						text: `Memory ${memory_id} was not found or already deleted.`,
					},
				],
			};
		},
	);

	// --- Fetch Content ---

	const fetchDesc = TOOL_DESCRIPTIONS[TOOL_NAMES.FETCH_CONTENT];
	server.registerTool(
		TOOL_NAMES.FETCH_CONTENT,
		{
			title: fetchDesc.title,
			description: fetchDesc.description,
			inputSchema: {
				source_id: z.string().describe(fetchDesc.params.source_id),
				mode: z
					.enum(["content", "url", "both"])
					.optional()
					.describe(fetchDesc.params.mode),
			} as any,
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async (args: any) => {
			const { source_id, mode } = args as {
				source_id: string;
				mode?: "content" | "url" | "both";
			};

			logger.debug(`${TOOL_NAMES.FETCH_CONTENT}: ${source_id}`);

			const res = await client.fetchContent(source_id, mode ?? "content");

			if (!res.success || res.error) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Could not fetch source ${source_id}: ${res.error ?? "unknown error"}`,
						},
					],
				};
			}

			const content =
				res.content ?? res.content_base64 ?? "(no text content)";

			return {
				content: [
					{
						type: "text" as const,
						text: `Source: ${source_id}\n\n${content}`,
					},
				],
			};
		},
	);

	// --- List Sources ---

	const sourcesDesc = TOOL_DESCRIPTIONS[TOOL_NAMES.LIST_SOURCES];
	server.registerTool(
		TOOL_NAMES.LIST_SOURCES,
		{
			title: sourcesDesc.title,
			description: sourcesDesc.description,
			inputSchema: {
				source_ids: z
					.array(z.string())
					.optional()
					.describe(sourcesDesc.params.source_ids),
			} as any,
			annotations: {
				readOnlyHint: true,
				idempotentHint: true,
			},
		},
		async (args: any) => {
			const { source_ids } = args as { source_ids?: string[] };

			logger.debug(TOOL_NAMES.LIST_SOURCES);

			const res = await client.listSources(source_ids);

			if (!res.sources || res.sources.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: "No sources found.",
						},
					],
				};
			}

			const lines = res.sources.map((s, i) => {
				const title = s.title ? ` — ${s.title}` : "";
				const type = s.type ? ` (${s.type})` : "";
				return `${i + 1}. [${s.id}]${title}${type}`;
			});

			return {
				content: [
					{
						type: "text" as const,
						text: `${res.total} sources:\n\n${lines.join("\n")}`,
					},
				],
			};
		},
	);

	return server.server;
}

