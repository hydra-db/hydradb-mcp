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
	WebhooksResource,
	DEFAULT_TIMEOUT_SECONDS,
	DEFAULT_MAX_RETRIES,
	hasEntries,
} from "./client.js";

export type {
	HydraConfig,
	ContextKind,
	RequestOptions,
	QueryKind,
	ConversationTurn,
	QueryParams,
	IngestParams,
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
	WebhookRegisterParams,
	WebhookSigningSecretParams,
	WebhookListDeliveriesParams,
	WebhookRegisterResult,
	WebhookGetResult,
	WebhookDeleteResult,
	WebhookSigningSecretResult,
	WebhookDeliveryItem,
	WebhookDeliveryListResult,
	WebhookRetryResult,
	WebhookTestResult,
} from "./client.js";

export { GraphResource } from "./graph.js";

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

export { DEFAULT_BASE_URL, apiKeyId, newRawTransport, sendRaw } from "./transport.js";

export type { RawTransport } from "./transport.js";
