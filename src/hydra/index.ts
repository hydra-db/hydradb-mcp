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
	DEFAULT_TIMEOUT_SECONDS,
	DEFAULT_MAX_RETRIES,
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
	InspectParams,
	IngestionStatusParams,
	RelationsParams,
	DeleteParams,
	CreateDatabaseParams,
	DeleteCollectionParams,
} from "./client.js";
export { GraphResource } from "./graph.js";
export type {
	GraphConfig,
	GraphQueryParams,
	GraphScopeParams,
	GraphRow,
} from "./graph.js";
export { HydraWrapperError, responseError, translateError } from "./errors.js";
export {
	assertCollectionAllowed,
	assertDatabaseAllowed,
	DatabaseNotAllowedError,
	ScopeNotAllowedError,
} from "./client.js";
export { unwrap } from "./envelope.js";
