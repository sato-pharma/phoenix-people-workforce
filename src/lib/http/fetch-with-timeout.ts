// One door for a call to an outside service that must not hang (audit item REC-050, 13 Nov 2026).
//
// A `fetch` with no deadline waits as long as the provider keeps the connection open: a Google or
// Zoom that accepts the request and then says nothing holds the person's request (or a whole cron
// tick) until the platform cuts it. Most outbound calls in this codebase already pass
// `signal: AbortSignal.timeout(...)` by hand; this helper is the same thing with three things the
// hand-written form keeps getting wrong:
//
//   1. a caller's OWN abort signal is combined with the deadline (`AbortSignal.any`, Node 20+; this
//      app runs Node 24 — package.json `engines`, the Dockerfile's node:24 base), never replaced by it;
//   2. running out of time throws a NAMED error, `OutboundTimeoutError`, which carries the HOST only —
//      never the full address, whose query can hold a key or a signed token;
//   3. there is ONE retry policy, and it can only ever repeat a GET or a HEAD. A POST, PUT, PATCH or
//      DELETE is sent once whatever the caller asks: a Zoom meeting create or a photo upload must
//      never be made twice because the first answer was slow.
//
// THE DEFAULT IS 15 SECONDS. It is the limit the codebase already uses most for a provider's API
// call (Zoom's ZOOM_CALL_DEADLINE_MS, the Google token exchanges, the Places details calls): long
// enough for a slow answer, short enough that a person waiting on a screen is told "it failed"
// rather than left looking at a spinner. A call that moves a file passes its own, longer limit.
//
// The limit covers the whole exchange, body included, exactly as `AbortSignal.timeout` on a plain
// fetch does: a body read that runs out throws the platform's own TimeoutError from `.json()` /
// `.arrayBuffer()`, which every caller already treats as a failed call.
//
// Tested, with the repo-wide rule that every outbound call has a deadline, in
// tests/outbound-time-limits.test.ts.

/** The limit when a caller names none — see the header for why fifteen seconds. */
export const DEFAULT_OUTBOUND_TIMEOUT_MS = 15_000;

/** A caller can never ask for more tries than this, whatever it passes. */
const MAX_ATTEMPTS = 3;

/** The wait before try N+1 is N times this — short, because a person may be waiting. */
const RETRY_BACKOFF_MS = 250;

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD"]);

export class OutboundTimeoutError extends Error {
  // NOT TypeScript parameter properties: the test runner strips types and cannot compile one.
  /** The host that did not answer, e.g. `www.googleapis.com` — never the path or query. */
  readonly host: string;
  readonly timeoutMs: number;

  constructor(host: string, timeoutMs: number, options?: { cause?: unknown }) {
    super(`${host} did not answer within ${Math.round(timeoutMs / 100) / 10} seconds`, options);
    this.name = "OutboundTimeoutError";
    this.host = host;
    this.timeoutMs = timeoutMs;
  }
}

export function isOutboundTimeoutError(error: unknown): error is OutboundTimeoutError {
  return error instanceof OutboundTimeoutError;
}

export type FetchWithTimeoutInit<I extends string | URL | Request = string | URL | Request> = RequestInit & {
  /** How long ONE try may take, in milliseconds. Default `DEFAULT_OUTBOUND_TIMEOUT_MS`. */
  timeoutMs?: number;
  /**
   * Try again on a network error, a timeout or a 5xx answer — for a GET or HEAD ONLY. `attempts` is
   * the total number of tries (2 = one retry), capped at 3. A non-idempotent method ignores it.
   */
  retry?: { attempts: number; onlyIdempotent?: true };
  /** The fetch to use — injectable so a test can prove the request without reaching the provider. */
  fetchImpl?: (input: I, init?: RequestInit) => Promise<Response>;
};

function hostOf(input: string | URL | Request): string {
  try {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return new URL(href).host || "an outside service";
  } catch {
    return "an outside service";
  }
}

function methodOf(input: string | URL | Request, method: string | undefined): string {
  if (method) return method.toUpperCase();
  return typeof input === "object" && "method" in input && typeof input.method === "string" ? input.method.toUpperCase() : "GET";
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `fetch`, with a deadline on every try and at most one retry policy (see the header).
 *
 * A caller's own abort passes straight through as the error it aborted with, and is never retried.
 * A try that runs out of time throws `OutboundTimeoutError` (after the last try, when retrying).
 * A 5xx on the LAST try is returned as the response, so the caller's own error mapping still reads it.
 */
export async function fetchWithTimeout<I extends string | URL | Request>(
  input: I,
  init: FetchWithTimeoutInit<I> = {},
): Promise<Response> {
  const { fetchImpl, retry, signal: callerSignal, timeoutMs = DEFAULT_OUTBOUND_TIMEOUT_MS, ...requestInit } = init;
  const doFetch: (input: I, init?: RequestInit) => Promise<Response> = fetchImpl ?? fetch;
  const idempotent = IDEMPOTENT_METHODS.has(methodOf(input, requestInit.method));
  const attempts = retry && idempotent ? Math.max(1, Math.min(MAX_ATTEMPTS, Math.floor(retry.attempts) || 1)) : 1;

  for (let attempt = 1; ; attempt += 1) {
    callerSignal?.throwIfAborted();
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;

    let response: Response;
    try {
      response = await doFetch(input, { ...requestInit, signal });
    } catch (error) {
      // The caller called it off: their decision, passed through untouched and never retried.
      if (callerSignal?.aborted) throw error;
      const failure = deadline.aborted ? new OutboundTimeoutError(hostOf(input), timeoutMs, { cause: error }) : error;
      if (attempt < attempts) {
        await wait(RETRY_BACKOFF_MS * attempt);
        continue;
      }
      throw failure;
    }

    if (response.status >= 500 && attempt < attempts) {
      // Release the connection before asking again; the body of a failed try is never read.
      await response.body?.cancel().catch(() => undefined);
      await wait(RETRY_BACKOFF_MS * attempt);
      continue;
    }
    return response;
  }
}
