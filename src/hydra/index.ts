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
} from "./client.js";
export { GraphResource } from "./graph.js";
export type {
	GraphConfig,
	GraphQueryParams,
	GraphScopeParams,
	GraphRow,
} from "./graph.js";
export { HydraWrapperError, responseError, translateError } from "./errors.js";
export { unwrap } from "./envelope.js";

// Default-database resolution (1.3.0): exported so the rule is testable and so
// embedders can apply it outside the server.
export {
	__resetDefaultDatabaseCache,
	AmbiguousDatabaseError,
	DEFAULT_DATABASE_NAME,
	DefaultDatabase,
	resolveDefaultDatabase,
} from "./client.js";
