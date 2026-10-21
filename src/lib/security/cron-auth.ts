import { NextResponse } from "next/server";

import { previousCronSecret } from "@/lib/auth/previous-secret";
import { ApiError } from "@/lib/http/api-errors";
import { logCronUnauthorized, logStructured } from "@/lib/observability/log";
import { bearerSecretMatches, secretMatches } from "@/lib/security/constant-time";

/**
 * The cron/worker authorization POLICY, in one place.
 *
 * `constant-time.ts` deliberately stops at the comparison and says so: callers keep the decision
 * about an UNSET secret "because that is a policy question, not a comparison one." This module is
 * that policy question — the missing counterpart, not a competitor. Import the comparison from
 * there and the policy from here; no route should ever spell either one out again.
 *
 * WHY THIS MODULE EXISTS AT ALL — two measured problems, on 2026-08-29:
 *
 *  1. The dev-bypass line was copied byte-for-byte into 23 route files. Clearing the PREVIOUS bad
 *     spelling of it took three passes (#1529, #1949, #2479) precisely because the rule lived in
 *     the routes: each pass fixed routes without changing what the next author would copy.
 *
 *  2. Eight of those 23 routes rejected an unauthorized caller and LOGGED NOTHING. In production
 *     `railway logs | grep cron_unauthorized` is the only detection mechanism there is (no
 *     log-based metrics since the GCP retirement), so a leaked-secret probe against any of
 *     ireports360-visits-{sync,reconcile,live-sync}, reconciliation-check, notifications/
 *     {birthdays,contract-renewals,holiday-confirmation,process} left no trace at all.
 *     `assertCronAuthorized` makes the log inseparable from the rejection.
 */

/**
 * Is this request authorized to run a cron/worker route?
 *
 * THE ONE AND ONLY HOME of the unset-secret rule. The rule is
 * `process.env.NODE_ENV === "development"`, NOT `!isProductionRuntime()`. The latter reads
 * "only in dev" but actually means "anywhere not labelled production" — it silently opened 18
 * routes the moment an environment's APP_ENV went unset (AGENTS.md §2.3). Do not reintroduce it.
 *
 * `NODE_ENV` is inlined by Next at build time, per static reference. That is exactly why this
 * comparison must be written out literally here and never through a variable or a helper
 * argument — an unresolved reference evaluates `undefined === "development"` and fails closed,
 * which is safe but silently breaks every local dev run.
 *
 * Even the hardened form is not a safety net on a laptop configured like this repo's: `.env.local`
 * points at PRODUCTION Supabase and carries no CRON_SECRET, so a local `pnpm run dev` still
 * bypasses every one of these routes against real data. "Only a real developer machine" is a true
 * statement about NODE_ENV; it is not a claim that the machine is safe to leave unauthenticated.
 */
export function cronSecretAuthorized(request: Request, secret: string | undefined): boolean {
  if (!secret) return process.env.NODE_ENV === "development";
  return bearerSecretMatches(request.headers.get("authorization"), secret);
}

/**
 * Does the bearer match the PRE-ROTATION `CRON_SECRET` (`CRON_SECRET_PREVIOUS`), still inside its
 * window? So cron-job.org's jobs can be moved to the new value one at a time without a single 401
 * (src/lib/auth/previous-secret.ts holds the reason and the hard end date). Only ever the shared
 * cron secret — a route on its own token never accepts it.
 */
export function previousCronSecretAuthorized(request: Request, now: Date = new Date()): boolean {
  const previous = previousCronSecret(now);
  return previous !== null && bearerSecretMatches(request.headers.get("authorization"), previous);
}

export type CronAuthOptions = {
  /**
   * The expected secret. Omit entirely to use `CRON_SECRET` — the case for 22 of the 23 routes.
   * Pass a STATIC `process.env.X` reference for a route on its own token; never `process.env[name]`,
   * which Next cannot inline or resolve the same way.
   */
  secret?: string | undefined;
  /** Preserves a route's existing 401 body verbatim. Omit for the bare `{ error: "unauthorized" }`. */
  message?: string;
};

/**
 * Guard a cron/worker route. Returns `null` when authorized, or the 401 response to return.
 *
 *     const denied = assertCronAuthorized(request, "cron/background-jobs");
 *     if (denied) return denied;
 *
 * Returns a response rather than throwing because 22 of the 23 routes emit their 401 BEFORE their
 * `try` block — several have no `try` at all — so a throwing guard would force a control-flow
 * change into every call site instead of a two-line substitution.
 */
export function assertCronAuthorized(
  request: Request,
  job: string,
  options?: CronAuthOptions,
): NextResponse | null {
  // `"secret" in options`, not `options?.secret ?? process.env.CRON_SECRET`: a route that passes
  // its own token must fail closed when that token is unset, never silently fall back to the
  // shared CRON_SECRET and authorize a caller who holds the wrong one.
  const ownToken = Boolean(options && "secret" in options);
  const secret = options && "secret" in options ? options.secret : process.env.CRON_SECRET;
  if (cronSecretAuthorized(request, secret)) return null;
  // The old CRON_SECRET, during the rotation window only, and only while the new one is SET — an
  // unset CRON_SECRET still fails closed. Logged so `railway logs | grep cron_previous_secret` lists
  // the jobs still to move.
  if (!ownToken && secret && previousCronSecretAuthorized(request)) {
    logStructured("INFO", `Cron authorized with the previous CRON_SECRET: ${job}`, {
      labels: { event: "cron_previous_secret", job },
    });
    return null;
  }
  logCronUnauthorized(job, request);
  return NextResponse.json(
    options?.message ? { error: "unauthorized", message: options.message } : { error: "unauthorized" },
    { status: 401 },
  );
}

/**
 * Guard a route whose token has NO dev bypass — an unset token is a misconfiguration, not an
 * invitation. Throws `ApiError(500, code, message)` when the token is absent, matching what the
 * synthetic-journeys ingest and attendance raw-punches routes did inline.
 *
 * The `.trim()` calls are load-bearing and deliberately kept: both routes trimmed the expected
 * token AND the sliced bearer value, so `bearerSecretMatches` — which compares the whole header
 * against `"Bearer <expected>"` without trimming — is NOT equivalent and would start rejecting a
 * token that carries trailing whitespace. The comparison itself still goes through
 * `secretMatches`, so the hand-rolled `timingSafeEqual` buffers are gone.
 */
export function requiredTokenAuthorized(
  request: Request,
  token: string | undefined,
  code: string,
  message: string,
): boolean {
  const expected = token?.trim();
  if (!expected) {
    throw new ApiError(500, code, message);
  }
  const authorization = request.headers.get("authorization") ?? "";
  const actual = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  if (!actual) return false;
  return secretMatches(actual, expected);
}
