/**
 * One retry policy for every HydraDB call, SDK or hand-rolled.
 *
 * The SDK retried on its own (2 retries, 60s per attempt, `Retry-After` capped
 * at 60s) and the raw transport had a second, different loop. Neither knew
 * whether the request was safe to send twice, neither could be stopped while
 * it slept between attempts, and both put the timeout on each attempt rather
 * than on the call. The SDK now runs with `maxRetries: 0` and this loop owns
 * every retry decision:
 *
 * - ONE deadline covers the whole call: every attempt and every wait. Nothing
 *   starts that could not finish inside it.
 * - `Retry-After` (seconds or HTTP date) replaces our own backoff, as long as
 *   the wait still ends inside the deadline. If it does not, the call fails
 *   now with the server's answer rather than sleeping into a timeout.
 * - A cancelled call never starts another attempt, including when the cancel
 *   arrives during the wait between attempts.
 * - A write that is not safe to repeat is retried only when the failure proves
 *   the server did not act on it (429, 408, connection refused). After an
 *   unclear failure (5xx, dropped connection, timeout) it is not retried, and
 *   the error says the outcome is unknown.
 */

import { HydraDBError } from "@hydradb/sdk";
import { z } from "zod";

import { HydraWrapperError, translateError } from "./errors.js";

/**
 * The whole-call deadline. Sized to finish inside the 60s a typical MCP host
 * waits for a tool, with room for the host's own overhead, so a stalled call
 * ends with a Hydra DB diagnostic rather than a generic host timeout while this
 * process keeps working.
 */
export const DEFAULT_TIMEOUT_SECONDS = 45;

/** Attempts after the first, all inside the deadline above. */
export const DEFAULT_MAX_RETRIES = 2;

/** Whether sending the same request twice can change the result. */
export type RetrySafety = "idempotent" | "unsafe";

export interface CallBudget {
	/** Whole-call deadline, every attempt and wait included. */
	deadlineMs: number;
	/** Attempts after the first. */
	maxRetries: number;
}

/**
 * The abort reason for a call that ran out of time.
 *
 * A distinct type so code holding only the signal can tell "the caller gave up"
 * from "the deadline passed": they ask for different actions.
 */
export class DeadlineExceeded extends Error {
	constructor(readonly deadlineMs: number) {
		super(`no answer within the ${formatSeconds(deadlineMs)} deadline for the whole call`);
		this.name = "DeadlineExceeded";
	}
}

/**
 * When a caller's own deadline ends, by its signal. The tool layer registers
 * its whole-call deadline here, so a request made late in a tool call knows
 * how much of that time is left, not just its own budget.
 */
const deadlines = new WeakMap<AbortSignal, number>();

/** Record that `signal` belongs to a call that must end by `endsAt` (epoch ms). */
export function markDeadline(signal: AbortSignal, endsAt: number): void {
	deadlines.set(signal, endsAt);
}

/** First backoff wait; doubles per attempt up to `MAX_BACKOFF_MS`. */
const BASE_BACKOFF_MS = 250;

const MAX_BACKOFF_MS = 2_000;

/**
 * Connection errors raised before any byte of the request reached the server.
 * A write that failed this way was not applied, so retrying it is safe.
 */
const NOT_SENT_CODES = new Set([
	"ECONNREFUSED",
	"ENOTFOUND",
	"EAI_AGAIN",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"UND_ERR_CONNECT_TIMEOUT",
]);

function formatSeconds(ms: number): string {
	const seconds = ms / 1000;

	return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
}

/**
 * `Retry-After` in milliseconds, from either form RFC 9110 allows: a number of
 * seconds, or an HTTP date. Undefined when absent or unreadable.
 */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
	if (value == null) return undefined;
	const trimmed = value.trim();

	if (trimmed === "") return undefined;

	if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;

	const date = Date.parse(trimmed);

	if (Number.isNaN(date)) return undefined;

	return Math.max(0, date - now);
}

interface Failure {
	status?: number;
	retryAfterMs?: number;
	/** The request certainly did not reach the server. */
	notSent: boolean;
}

/** One link of an error's cause chain: Node puts `code` on network errors. */
const errorLink = z.object({ code: z.string().optional(), cause: z.unknown() });

/** The `code` of an error and of each error in its cause chain. */
function errorCodes(cause: unknown): string[] {
	const codes: string[] = [];
	let current = cause;

	for (let depth = 0; depth < 5; depth++) {
		const link = errorLink.safeParse(current);

		if (!link.success) break;

		if (link.data.code != null) codes.push(link.data.code);
		current = link.data.cause;
	}

	return codes;
}

/** The HTTP status of a failed attempt, when it got a response. */
function statusOf(cause: unknown): number | undefined {
	if (cause instanceof HydraDBError) return cause.statusCode;

	if (cause instanceof HydraWrapperError) return cause.status;

	return undefined;
}

function retryAfterOf(cause: unknown, now: number): number | undefined {
	if (cause instanceof HydraWrapperError) return parseRetryAfter(cause.headers?.get("retry-after"), now);

	if (cause instanceof HydraDBError) return parseRetryAfter(cause.rawResponse?.headers.get("retry-after"), now);

	return undefined;
}

/** What a failed attempt says about the request, or undefined when it is not a transport failure. */
function describe(cause: unknown, now: number): Failure | undefined {
	const status = statusOf(cause);

	if (status != null) return { status, retryAfterMs: retryAfterOf(cause, now), notSent: false };

	// A failure with neither status nor transport cause is our own validation
	// or a programming error: the same request would fail the same way.
	const transport =
		(cause instanceof HydraDBError || cause instanceof HydraWrapperError) && cause.cause != null;

	if (!transport) return undefined;

	return { notSent: errorCodes(cause).some((code) => NOT_SENT_CODES.has(code)) };
}

/** What a failed attempt allows: try again, or stop and say why. */
function verdict(failure: Failure | undefined, safety: RetrySafety): "retry" | "final" | "unknown-outcome" {
	if (failure == null) return "final";

	const { status } = failure;

	// Refused before processing: safe to send again whatever the request is.
	if (status === 429 || status === 408) return "retry";

	if (status == null && failure.notSent) return "retry";

	const transient = status == null || status >= 500;

	if (!transient) return "final";

	return safety === "idempotent" ? "retry" : "unknown-outcome";
}

const UNKNOWN_OUTCOME =
	"Outcome unknown: the request reached Hydra DB and may or may not have been applied. " +
	"It was not retried because sending it twice is not safe. Check whether it took effect " +
	"before sending it again.";

function withHistory(base: HydraWrapperError, history: string[], elapsedMs: number, extra?: string): HydraWrapperError {
	const parts = [base.message];

	if (history.length > 1) {
		parts.push(`(${history.length} attempts over ${formatSeconds(elapsedMs)}: ${history.join(", ")})`);
	}

	if (extra) parts.push(extra);

	return new HydraWrapperError(parts.join(" "), base.path, {
		status: base.status,
		body: base.body,
		cause: base.cause ?? base,
	});
}

/** Resolves after `ms`; resolves `false` instead, at once, if `signal` aborts first. */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve(false);

			return;
		}

		const onAbort = () => {
			clearTimeout(timer);
			resolve(false);
		};

		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve(true);
		}, ms);

		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/** The abort reason for a call its caller cancelled. */
const CANCELLED = new Error("request cancelled by the caller");

export interface RetryCall<T> {
	path: string;
	safety: RetrySafety;
	budget: CallBudget;
	/** The caller's cancellation. Its reason may be a `DeadlineExceeded`. */
	signal?: AbortSignal;
	/** Exact credentials to scrub from any message. */
	known: readonly string[];
	/** Errors to pass through untouched, such as a refused scope. */
	rethrow?: (cause: unknown) => boolean;
	/** One attempt. Must stop when `signal` aborts. */
	attempt: (signal: AbortSignal) => Promise<T>;
}

/**
 * Run `attempt` under the whole-call deadline, retrying only when the failure
 * allows it for this `safety`. Always rejects with a `HydraWrapperError` whose
 * message describes the whole call, not just the last attempt.
 */
export async function withRetries<T>(call: RetryCall<T>): Promise<T> {
	const { path, safety, budget, known } = call;
	const started = Date.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new DeadlineExceeded(budget.deadlineMs)), budget.deadlineMs);

	// The tool layer aborts with its own whole-call deadline; that is a
	// deadline too, not the caller cancelling.
	const onCallerAbort = () =>
		controller.abort(call.signal?.reason instanceof DeadlineExceeded ? call.signal.reason : CANCELLED);

	if (call.signal?.aborted) onCallerAbort();
	else call.signal?.addEventListener("abort", onCallerAbort, { once: true });

	const history: string[] = [];

	/** The error for a call that was stopped from outside, by cancel or deadline. */
	const stopped = (inFlight: boolean): HydraWrapperError => {
		const reason = controller.signal.reason;
		const outOfTime = reason instanceof DeadlineExceeded;

		if (inFlight) history.push(outOfTime ? "timed out" : "cancelled");

		const what = outOfTime ? reason.message : CANCELLED.message;

		return withHistory(
			new HydraWrapperError(`Hydra DB ${path} → ERR: ${what}`, path),
			history,
			Date.now() - started,
			inFlight && safety === "unsafe" ? UNKNOWN_OUTCOME : undefined,
		);
	};

	try {
		for (let attempt = 0; ; attempt++) {
			if (controller.signal.aborted) throw stopped(false);

			let failed: unknown;

			try {
				return await call.attempt(controller.signal);
			} catch (caught) {
				failed = caught;
			}

			if (call.rethrow?.(failed)) throw failed;

			if (controller.signal.aborted) throw stopped(true);

			const now = Date.now();
			const failure = describe(failed, now);

			history.push(failure?.status != null ? String(failure.status) : "no response");

			const translated =
				failed instanceof HydraWrapperError ? failed : translateError(path, failed, known);

			const decision = verdict(failure, safety);

			if (decision === "unknown-outcome") {
				throw withHistory(translated, history, now - started, UNKNOWN_OUTCOME);
			}

			if (decision === "final" || attempt >= budget.maxRetries) {
				throw withHistory(translated, history, now - started);
			}

			const wait = failure?.retryAfterMs ?? Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);

			// The tighter of this request's budget and the caller's whole-call
			// deadline, so a wait that cannot finish is never started.
			const endsAt = Math.min(started + budget.deadlineMs, (call.signal && deadlines.get(call.signal)) ?? Number.POSITIVE_INFINITY);

			if (wait >= endsAt - now) {
				const why =
					failure?.retryAfterMs != null
						? `Hydra DB asked to retry after ${formatSeconds(wait)}, but this call's deadline is ${formatSeconds(Math.max(0, endsAt - now))} away; try again later.`
						: undefined;

				throw withHistory(translated, history, now - started, why);
			}

			if (!(await sleep(wait, controller.signal))) throw stopped(false);
		}
	} finally {
		clearTimeout(timer);
		call.signal?.removeEventListener("abort", onCallerAbort);
	}
}
