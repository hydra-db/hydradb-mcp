/**
 * The hand-owned HydraDB wrapper. This module is the ONLY place that imports
 * `@hydradb/sdk`; everything else in the server talks to `HydraDB` here.
 *
 * It is intentionally self-contained so the same pattern can be ported to the
 * other client repos (per CONTRACT.md).
 */

export {
	HydraDB,
	ContextResource,
	DatabasesResource,
	FeedbackResource,
	DEFAULT_TIMEOUT_SECONDS,
	DEFAULT_MAX_RETRIES,
	hasEntries,
	isUnifiedQueryResult,
	toUnifiedQueryResult,
} from "./client.js";

export type {
	HydraConfig,
	ContextKind,
	ForcefulRelations,
	RequestOptions,
	QueryKind,
	QueryResult,
	UnifiedQueryResult,
	UnifiedChunk,
	UnifiedTemporal,
	UnifiedEntity,
	UnifiedEdge,
	UnifiedTriplet,
	UnifiedGraphPath,
	UnifiedForcefulRelation,
	UnifiedGraphOrigin,
	ConversationTurn,
	QueryParams,
	AppKnowledgeItem,
	AppKnowledgeKind,
	IngestGraph,
	IngestItem,
	IngestParams,
	IngestDocument,
	UpdateContextParams,
	ListParams,
	MetadataFilter,
	MetadataFilterValue,
	InspectParams,
	IngestionStatusParams,
	RelationsParams,
	SubgraphParams,
	SubgraphMember,
	SubgraphResult,
	DeleteParams,
	CreateDatabaseParams,
	DeleteCollectionParams,
	FeedbackParams,
	FeedbackResult,
	FeedbackRating,
	FeedbackSource,
	FeedbackGroundTruth,
	Layout,
} from "./client.js";

export { GraphResource } from "./graph.js";

export { ConnectorsResource } from "./connectors.js";

export type {
	ConnectorUpdateRequest,
	ConnectorResourceAddRequest,
	ConnectorResourceUpdateRequest,
	ConnectorUpdateResponse,
	ConnectorDeleteResponse,
	ConnectorSyncResponse,
	ConnectorPauseResponse,
	ConnectorResumeResponse,
	ConnectorResourceMapping,
	ConnectorResourceAddResponse,
	ConnectorResourceUpdateResponse,
	ConnectorResourceDeleteResponse,
	ConnectorDiscoverParams,
	ConnectorListParams,
	ConnectorList,
	ConnectorProviderCatalog,
	ConnectorProviderDetail,
	ConnectorResource,
	ConnectorResources,
	ConnectorStatus,
	ConnectorView,
	DiscoveredConnectorResources,
} from "./connectors.js";

export type {
	GraphConfig,
	GraphQueryParams,
	GraphScopeParams,
	GraphRow,
} from "./graph.js";

export { HydraWrapperError, responseError, scrub, translateError } from "./errors.js";

export {
	assertCollectionAllowed,
	assertDatabaseAllowed,
	DatabaseNotAllowedError,
	ScopeNotAllowedError,
} from "./client.js";

export { unwrap } from "./envelope.js";
export type { ResponseMeta, ResponseWarning } from "./envelope.js";

export { DEFAULT_BASE_URL, apiKeyId, newRawTransport, sendRaw } from "./transport.js";

export { DeadlineExceeded, markDeadline, parseRetryAfter, withRetries } from "./retry.js";

export type { CallBudget, RetrySafety } from "./retry.js";

export type { RawTransport } from "./transport.js";
