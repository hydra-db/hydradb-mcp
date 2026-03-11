import { logger } from "./logger.js";
import type {
	AddMemoryRequest,
	AddMemoryResponse,
	ConversationTurn,
	DeleteMemoryResponse,
	FetchContentRequest,
	FetchContentResponse,
	ListDataRequest,
	ListMemoriesResponse,
	ListSourcesResponse,
	RecallRequest,
	RecallResponse,
} from "./types.js";

const API_BASE = "https://api.hydradb.com";

const INGEST_INSTRUCTIONS =
	"Focus on extracting user preferences, habits, opinions, likes, dislikes, " +
	"goals, and recurring themes. Capture any stated or implied personal context " +
	"that would help personalise future interactions.";

export class CortexClient {
	private apiKey: string;
	private tenantId: string;
	private subTenantId: string;

	constructor(apiKey: string, tenantId: string, subTenantId: string) {
		this.apiKey = apiKey;
		this.tenantId = tenantId;
		this.subTenantId = subTenantId;
		logger.info(`Hydra DB connected (tenant=${tenantId}, sub=${subTenantId})`);
	}

	private headers(): Record<string, string> {
		return {
			Authorization: `Bearer ${this.apiKey}`,
			"Content-Type": "application/json",
		};
	}

	private async post<T>(path: string, body: unknown): Promise<T> {
		const url = `${API_BASE}${path}`;
		logger.debug("POST " + path, { body: body as Record<string, unknown> });
		const res = await fetch(url, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`Hydra DB ${path} → ${res.status}: ${text}`);
		}
		return res.json() as Promise<T>;
	}

	private async del<T>(
		path: string,
		params: Record<string, string>,
	): Promise<T> {
		const qs = new URLSearchParams(params).toString();
		const url = `${API_BASE}${path}?${qs}`;
		logger.debug("DELETE " + path, params);
		const res = await fetch(url, {
			method: "DELETE",
			headers: this.headers(),
		});
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`Hydra DB ${path} → ${res.status}: ${text}`);
		}
		return res.json() as Promise<T>;
	}

	// --- Ingest ---

	async ingestConversation(
		turns: ConversationTurn[],
		sourceId: string,
		userName?: string,
	): Promise<AddMemoryResponse> {
		const payload: AddMemoryRequest = {
			memories: [
				{
					user_assistant_pairs: turns,
					infer: true,
					source_id: sourceId,
					user_name: userName ?? "User",
					custom_instructions: INGEST_INSTRUCTIONS,
				},
			],
			tenant_id: this.tenantId,
			sub_tenant_id: this.subTenantId,
			upsert: true,
		};
		return this.post<AddMemoryResponse>("/memories/add_memory", payload);
	}

	async ingestText(
		text: string,
		opts?: {
			sourceId?: string;
			title?: string;
			infer?: boolean;
			isMarkdown?: boolean;
			customInstructions?: string;
		},
	): Promise<AddMemoryResponse> {
		const shouldInfer = opts?.infer ?? true;
		const payload: AddMemoryRequest = {
			memories: [
				{
					text,
					infer: shouldInfer,
					is_markdown: opts?.isMarkdown ?? false,
					...(shouldInfer && {
						custom_instructions:
							opts?.customInstructions ?? INGEST_INSTRUCTIONS,
					}),
					...(opts?.sourceId && { source_id: opts.sourceId }),
					...(opts?.title && { title: opts.title }),
				},
			],
			tenant_id: this.tenantId,
			sub_tenant_id: this.subTenantId,
			upsert: true,
		};
		return this.post<AddMemoryResponse>("/memories/add_memory", payload);
	}

	// --- Recall ---

	async recall(
		query: string,
		opts?: {
			maxResults?: number;
			mode?: "fast" | "thinking";
			graphContext?: boolean;
			recencyBias?: number;
		},
	): Promise<RecallResponse> {
		const payload: RecallRequest = {
			tenant_id: this.tenantId,
			sub_tenant_id: this.subTenantId,
			query,
			max_results: opts?.maxResults ?? 10,
			mode: opts?.mode ?? "thinking",
			alpha: 0.8,
			recency_bias: opts?.recencyBias ?? 0,
			graph_context: opts?.graphContext ?? true,
		};
		return this.post<RecallResponse>(
			"/recall/recall_preferences",
			payload,
		);
	}

	// --- List ---

	async listMemories(): Promise<ListMemoriesResponse> {
		const payload: ListDataRequest = {
			tenant_id: this.tenantId,
			sub_tenant_id: this.subTenantId,
			kind: "memories",
		};
		return this.post<ListMemoriesResponse>("/list/data", payload);
	}

	async listSources(sourceIds?: string[]): Promise<ListSourcesResponse> {
		const payload: ListDataRequest = {
			tenant_id: this.tenantId,
			sub_tenant_id: this.subTenantId,
			kind: "memories",
			...(sourceIds && { source_ids: sourceIds }),
		};
		return this.post<ListSourcesResponse>("/list/data", payload);
	}

	// --- Delete ---

	async deleteMemory(memoryId: string): Promise<DeleteMemoryResponse> {
		return this.del<DeleteMemoryResponse>("/memories/delete_memory", {
			tenant_id: this.tenantId,
			memory_id: memoryId,
			sub_tenant_id: this.subTenantId,
		});
	}

	// --- Fetch Content ---

	async fetchContent(
		sourceId: string,
		mode: "content" | "url" | "both" = "content",
	): Promise<FetchContentResponse> {
		const payload: FetchContentRequest = {
			tenant_id: this.tenantId,
			sub_tenant_id: this.subTenantId,
			source_id: sourceId,
			mode,
		};
		return this.post<FetchContentResponse>("/fetch/content", payload);
	}

	// --- Accessors ---

	getTenantId(): string {
		return this.tenantId;
	}

	getSubTenantId(): string {
		return this.subTenantId;
	}
}
