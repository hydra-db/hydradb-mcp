/**
 * The hand-owned HydraDB wrapper. This module is the ONLY place that imports
 * `@hydradb/sdk`; everything else in the server talks to `HydraDB` here.
 *
 * It is intentionally self-contained so the same pattern can be ported to the
 * other client repos (per CONTRACT.md).
 */

export { HydraDB, ContextResource, DatabasesResource } from "./client.js";
export type {
	HydraConfig,
	ContextKind,
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
export { HydraWrapperError, translateError } from "./errors.js";
export { unwrap } from "./envelope.js";
