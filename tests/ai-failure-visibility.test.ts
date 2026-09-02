import assert from "node:assert/strict";

import {
  buildAiFailureEvent,
  failureThrottleKey,
  shouldReportFailure,
  FAILURE_THROTTLE_MS,
  type AiCallRecord,
} from "../src/lib/observability/ai-metrics.ts";

// Guards the 2026-09-02 finding: AI telemetry was writing to GCP Cloud Monitoring with
// GCP_PROJECT_ID unset on Railway, so it returned on its first line. When OPENAI_API_KEY held a
// masked paste and OpenAI answered 401, every AI feature failed together for days and NOTHING
// recorded it — the call sites all catch and degrade to "no suggestions", so the UI was quiet too.
//
// These tests exercise the PURE exports only. `pnpm run test` runs with production credentials
// (AGENTS.md §2.1), so a test must never reach logAppError; recordAiCall's own suite gate covers
// the path that would.

function record(over: Partial<AiCallRecord> = {}): AiCallRecord {
  return {
    component: "sales_normalizer_ai_suggest",
    purpose: "ai_suggest_customer",
    model: "gpt-4o",
    status: "error",
    latencyMs: 812,
    errorCode: "401",
    ...over,
  };
}

export function runAiFailureVisibilityTests() {
  // --- a success is not an alarm ----------------------------------------------------------
  assert.equal(
    buildAiFailureEvent(record({ status: "success" })),
    null,
    "a successful call must write no row — a row per success would bury the failures this exists to show",
  );

  // --- the row the 401 outage would have produced ------------------------------------------
  const event = buildAiFailureEvent(record());
  assert.ok(event, "an errored call must produce a row");
  assert.equal(event.moduleKey, "ai", "rows group under one module so a total AI outage reads as one story");
  assert.equal(event.source, "server", "these are server-side upstream failures");
  assert.equal(
    event.route,
    "/ai/sales_normalizer_ai_suggest/ai_suggest_customer",
    "the pseudo-route keeps each feature its own signature — signatureKey is `module_key|route`",
  );
  assert.match(
    event.message,
    /HTTP 401/,
    "the row must say WHY: 'the key is wrong' and 'the model is busy' looked identical during the outage",
  );
  assert.match(
    event.message,
    /Sales normalizer — AI suggest/,
    "owner rule: human-readable names, never raw codes, on anything that reaches a screen",
  );
  assert.equal(
    event.stack,
    null,
    "never attach the upstream body — on a 401 OpenAI echoes a fragment of the key back",
  );

  // --- every component maps to a distinct, human-readable signature -------------------------
  const components = [
    "openai_client",
    "sales_ai_provider",
    "sales_normalizer_ai_suggest",
    "sales_weekly_ai_verify",
  ] as const;
  const routes = new Set<string>();
  for (const component of components) {
    const built = buildAiFailureEvent(record({ component }));
    assert.ok(built, `${component} must produce a row`);
    routes.add(built.route as string);
    assert.ok(
      !built.message.includes(component),
      `${component} must be reported by its human label, not its raw code`,
    );
  }
  assert.equal(routes.size, components.length, "each component needs its own signature, or one outage hides another");

  // --- an error with no HTTP status still reports, and says so -------------------------------
  const noCode = buildAiFailureEvent(record({ errorCode: undefined }));
  assert.match(
    noCode!.message,
    /no error code reported/,
    "a missing code must be stated, not silently rendered as a blank",
  );
  assert.match(
    buildAiFailureEvent(record({ errorCode: "timeout" }))!.message,
    /timeout/,
    "a non-numeric code passes through unchanged rather than being forced into an HTTP shape",
  );

  // --- throttling: a dead key fails in bursts, not once ---------------------------------------
  // aiSuggest batches at 60 rows and loops, so one click can throw the same error a dozen times.
  const seen = new Map<string, number>();
  const key = failureThrottleKey(record());
  const t0 = 1_000_000;
  assert.equal(shouldReportFailure(key, t0, seen), true, "the first failure in a window must be reported");
  assert.equal(shouldReportFailure(key, t0 + 1_000, seen), false, "a repeat inside the window must be suppressed");
  assert.equal(
    shouldReportFailure(key, t0 + FAILURE_THROTTLE_MS, seen),
    true,
    "once the window has passed the problem must be reported again — an outage that goes quiet reads as fixed",
  );

  // --- but a DIFFERENT failure is never suppressed by an unrelated one -------------------------
  const fresh = new Map<string, number>();
  assert.equal(shouldReportFailure(failureThrottleKey(record({ errorCode: "401" })), t0, fresh), true);
  assert.equal(
    shouldReportFailure(failureThrottleKey(record({ errorCode: "429" })), t0, fresh),
    true,
    "a rate-limit must not be hidden by an earlier auth failure — they need different fixes",
  );
  assert.equal(
    shouldReportFailure(failureThrottleKey(record({ component: "openai_client" })), t0, fresh),
    true,
    "CV extraction failing must not be hidden by the sales normalizer failing",
  );

  // --- the throttle map cannot grow without bound ---------------------------------------------
  const many = new Map<string, number>();
  for (let i = 0; i < 150; i += 1) shouldReportFailure(`stale-${i}`, t0, many);
  shouldReportFailure("fresh-key", t0 + FAILURE_THROTTLE_MS + 1, many);
  assert.ok(many.size < 150, "entries that can no longer suppress anything must be dropped");
}
