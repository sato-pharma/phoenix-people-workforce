import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildAiFailureEvent,
  dispatchAiCall,
  takeAnsweringCheckSlot,
  type AiCallSinks,
  type AiCallState,
  failureThrottleKey,
  shouldReportFailure,
  aiErrorCodeForResponse,
  isKeyRejectedRecord,
  isQuotaExhaustedRecord,
  AI_QUOTA_EXHAUSTED_CODE,
  FAILURE_THROTTLE_MS,
  type AiCallRecord,
} from "../src/lib/observability/ai-metrics.ts";
import {
  aiAnsweringIdempotencyKey,
  aiAnsweringTitle,
  aiKeyAlertIdempotencyKey,
  aiKeyAlertTitle,
  aiProviderKeyVariable,
  aiQuotaAlertEnabled,
  aiQuotaAlertTitle,
  aiQuotaIdempotencyKey,
  buildAiKeyRejectedMessage,
  buildAiAccountAnsweringMessage,
  buildAiQuotaExhaustedMessage,
  notifyAiAccountAnswering,
  takeAiQuotaAlertSlot,
  unclosedAiOutage,
} from "../src/lib/notifications/ai-quota-alert.ts";
import { stripComments } from "./support/comment-strip.ts";

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
    provider: "openai",
    status: "error",
    latencyMs: 812,
    errorCode: "401",
    ...over,
  };
}

export async function runAiFailureVisibilityTests() {
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

  // --- a leg the next provider is asked to cover is NOT an AI failure ------------------------
  // 🔴 23 Oct 2026: the board carried 21 "AI call failed — Shared OpenAI client: account out of credit"
  // rows against CV extraction while Claude had answered all 58 reads, and they were read as dead
  // extractions. The leg is reported as what it is — handed to another account.
  const rescued = record({
    component: "openai_client",
    purpose: "recruitment-cv-extraction",
    errorCode: AI_QUOTA_EXHAUSTED_CODE,
    failedOverTo: "anthropic",
    status: "failed_over",
  });
  const rescuedEvent = buildAiFailureEvent(rescued);
  assert.ok(rescuedEvent, "a rescued leg is still recorded — it is the only trace that the account is dead");
  assert.doesNotMatch(
    rescuedEvent.message,
    /^AI call failed —/,
    "it must NOT read as an AI failure: that is the whole mislabelling this status exists to end",
  );
  assert.match(rescuedEvent.message, /failed over to Anthropic/, "it names the account that was asked next");
  assert.match(rescuedEvent.message, /OpenAI said account out of credit/, "and the account that refused, by name");
  assert.doesNotMatch(
    rescuedEvent.message,
    /was answered/,
    "never claim the call succeeded — this row is written when the next account is ASKED, and it may fail too",
  );
  assert.equal(
    rescuedEvent.route,
    "/ai/openai_client/recruitment-cv-extraction/failed-over",
    "its own signature: an hourly by-design failover must never group with a real outage of the same feature",
  );
  assert.notEqual(
    rescuedEvent.route,
    buildAiFailureEvent(record({ component: "openai_client", purpose: "recruitment-cv-extraction" }))!.route,
    "and that signature differs from the feature's failure signature",
  );
  assert.equal(
    isQuotaExhaustedRecord(rescued),
    true,
    "a rescued leg still pages: the user got an answer from the other account, but this one is just as empty and only a top-up ends it",
  );
  assert.notEqual(
    failureThrottleKey(rescued),
    failureThrottleKey({ ...rescued, status: "error", failedOverTo: undefined }),
    "the five-minute throttle must not let the rescued leg suppress the real failure of the same feature, account and code",
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
  assert.equal(
    shouldReportFailure(failureThrottleKey(record({ model: "claude-sonnet-5-5", provider: "anthropic" })), t0, fresh),
    true,
    "a dead Claude account must not be hidden by a dead OpenAI one on the same feature — they are topped up in different places",
  );

  // --- the throttle map cannot grow without bound ---------------------------------------------
  const many = new Map<string, number>();
  for (let i = 0; i < 150; i += 1) shouldReportFailure(`stale-${i}`, t0, many);
  shouldReportFailure("fresh-key", t0 + FAILURE_THROTTLE_MS + 1, many);
  assert.ok(many.size < 150, "entries that can no longer suppress anything must be dropped");

  // --- out of credit pages the owner (2026-09-18) ---------------------------------------------
  // At 09:55 that day OpenAI refused the Sales normalizer with insufficient_quota. The raw-fetch
  // paths recorded it as a bare "429" — indistinguishable from a busy minute — and it reached no
  // one. The account has no auto-recharge, so this is the failure that needs a human, fast.
  const quotaBody = JSON.stringify({
    error: {
      message: "You exceeded your current quota, please check your plan and billing details.",
      type: "insufficient_quota",
      code: "insufficient_quota",
    },
  });
  assert.equal(
    aiErrorCodeForResponse(429, quotaBody),
    AI_QUOTA_EXHAUSTED_CODE,
    "an insufficient_quota 429 must be recorded as out of credit, not as a bare 429",
  );
  const rateBody = JSON.stringify({
    error: {
      message: "Rate limit reached for gpt-4o on tokens per min (TPM): Limit 450000. Please try again in 2s.",
      type: "tokens",
      code: "rate_limit_exceeded",
    },
  });
  assert.equal(aiErrorCodeForResponse(429, rateBody), "429", "a per-minute rate limit clears by itself and must NOT page anyone");
  assert.equal(aiErrorCodeForResponse(401, quotaBody), "401", "only a 429 can be out of credit");
  assert.equal(isQuotaExhaustedRecord(record({ errorCode: AI_QUOTA_EXHAUSTED_CODE })), true);
  assert.equal(isQuotaExhaustedRecord(record({ errorCode: "429" })), false);
  assert.equal(
    isQuotaExhaustedRecord(record({ errorCode: AI_QUOTA_EXHAUSTED_CODE, status: "success" })),
    false,
    "a success never pages",
  );
  assert.match(
    buildAiFailureEvent(record({ errorCode: AI_QUOTA_EXHAUSTED_CODE }))!.message,
    /out of credit/,
    "the error-monitor row must say out of credit in words",
  );
  // 🔴 THE ALERT MUST NAME THE RIGHT ACCOUNT. `groq_transcription` shares this alarm deliberately,
  // and until 2026-09-28 the message hardcoded "OpenAI" and listed OpenAI's features — so a Groq
  // outage sent him to the wrong billing page and named six features that were working fine.
  const openAiAlert = buildAiQuotaExhaustedMessage(record({ component: "openai_client" }));
  const groqAlert = buildAiQuotaExhaustedMessage(record({ component: "groq_transcription", provider: "groq" }));
  const anthropicAlert = buildAiQuotaExhaustedMessage(
    record({ component: "phoenix_crm_signboard", model: "claude-sonnet-5-5", provider: "anthropic" }),
  );
  for (const [label, text] of [["OpenAI", openAiAlert], ["Groq", groqAlert]] as const) {
    assert.match(text, /top(ped)? up|Add credit/i, `the ${label} alert must say what fixes it`);
    assert.match(text, /no auto-recharge/i, `the ${label} alert must say waiting cannot fix it`);
    assert.match(text, new RegExp(`${label} billing page`), `the ${label} alert must name the ${label} billing page`);
  }
  assert.doesNotMatch(
    groqAlert,
    /OpenAI/,
    "a Groq outage must not mention OpenAI at all — not the provider, and not its feature list: " +
      "during an outage, being pointed at the wrong account costs more than the outage",
  );
  assert.doesNotMatch(groqAlert, /CV extraction|Sales normalizer/, "the Groq alert must not list OpenAI's features");
  // Since the two Anthropic accounts stand behind OpenAI (24 Oct 2026), an empty OpenAI account no longer
  // means every feature is down — the alarm says where the calls went, and when nothing is left.
  assert.doesNotMatch(openAiAlert, /Every OpenAI feature is failing/, "the pre-failover wording claimed an outage that no longer happens");
  assert.match(openAiAlert, /first Anthropic account, then the backup one/, "the OpenAI alarm names the stand-in accounts");
  // 🔴 THE ALARM NAMES THE ACCOUNT THE CALL WAS BILLED TO, NEVER ONE GUESSED FROM THE FEATURE (code review,
  // 19 Oct 2026). Since the Anthropic failover one feature reaches two accounts: a Claude account out of
  // credit on the shared client's fallback leg sent him to top up OpenAI.
  const anthropicFallbackAlert = buildAiQuotaExhaustedMessage(
    record({ component: "openai_client", model: "claude-haiku-5-5", provider: "anthropic" }),
  );
  for (const text of [anthropicAlert, anthropicFallbackAlert]) {
    assert.match(text, /^💳 Anthropic says/, "a Claude account out of credit must be named as Anthropic");
    assert.match(text, /Add credit, or raise the workspace spend limit, on the Anthropic billing page/, "it says what ends either refusal");
    assert.doesNotMatch(text, /OpenAI billing page|CV extraction/, "a Claude outage must not send him to OpenAI's billing page");
  }
  assert.equal(aiQuotaAlertTitle("anthropic"), "Anthropic account is out of credit");
  assert.equal(aiQuotaAlertTitle("openai"), "OpenAI account is out of credit", "the OpenAI title reads as it always has");
  // The second Anthropic account (2026-10-24) is billed separately, so its alarm names it and is its own for the day.
  const backupAlert = buildAiQuotaExhaustedMessage(
    record({ component: "openai_client", model: "claude-haiku-5-5", provider: "anthropic_backup" }),
  );
  assert.equal(aiQuotaAlertTitle("anthropic_backup"), "Anthropic backup account is out of credit");
  assert.match(backupAlert, /The backup Anthropic account refuses every call/, "the backup alarm names the backup account");
  assert.match(backupAlert, /Add credit, or raise the workspace spend limit/, "and says what ends either refusal");
  assert.doesNotMatch(backupAlert, /OpenAI billing page|no auto-recharge/, "it never sends him to OpenAI's billing page");
  assert.match(anthropicAlert, /The first Anthropic account refuses every call/, "the first account's alarm names the first account");
  assert.notEqual(
    aiQuotaIdempotencyKey("anthropic_backup", "2026-10-24", "E-100"),
    aiQuotaIdempotencyKey("anthropic", "2026-10-24", "E-100"),
    "both Anthropic accounts running dry the same day are two alarms, not one",
  );
  // 🔴 A REFUSED KEY PAGES TOO (24 Oct 2026). The production OpenAI key was refused for days with every call
  // quietly moving to Claude, and nobody was told: the alarm listened for out of credit alone. A rescued leg
  // pages as well, because the stand-in hiding the outage is exactly how it went unseen.
  for (const code of ["auth_failed", "401", "403"]) {
    assert.equal(isKeyRejectedRecord(record({ errorCode: code })), true, `${code} is a refused key and must page`);
    assert.equal(isKeyRejectedRecord(record({ errorCode: code, status: "failed_over" })), true, `a rescued ${code} still pages`);
  }
  assert.equal(isKeyRejectedRecord(record({ errorCode: "auth_failed", status: "success" })), false, "a success never pages");
  assert.equal(isKeyRejectedRecord(record({ errorCode: "429" })), false, "a rate limit clears by itself and must not page");
  assert.equal(isKeyRejectedRecord(record({ errorCode: AI_QUOTA_EXHAUSTED_CODE })), false, "out of credit keeps its own alarm");
  assert.equal(aiKeyAlertTitle("openai"), "OpenAI refuses its API key");
  assert.equal(aiProviderKeyVariable("anthropic_backup"), "ANTHROPIC_API_KEY_2");
  const keyAlert = buildAiKeyRejectedMessage(record({ component: "openai_client", errorCode: "auth_failed" }));
  assert.match(keyAlert, /^🔑 OpenAI refuses the API key/, "the refused-key alarm names the account");
  assert.match(keyAlert, /put it in OPENAI_API_KEY on Railway/, "and the exact variable to replace");
  assert.match(keyAlert, /first Anthropic account, then the backup one/, "and where the calls went meanwhile");
  assert.doesNotMatch(keyAlert, /out of credit|top(ped)? up/i, "a refused key is never described as an empty account");
  assert.match(
    buildAiKeyRejectedMessage(record({ component: "openai_client", errorCode: "401", provider: "anthropic_backup" })),
    /ANTHROPIC_API_KEY_2/,
    "the backup account's alarm names the backup account's variable",
  );
  assert.notEqual(
    aiKeyAlertIdempotencyKey("openai", "2026-10-24", "E-100"),
    aiQuotaIdempotencyKey("openai", "2026-10-24", "E-100"),
    "a refused key and an empty account on one day are two alarms, not one",
  );
  assert.match(
    buildAiQuotaExhaustedMessage(record({ component: "sales_weekly_ai_verify", provider: "openrouter" })),
    /OpenRouter billing page/,
    "a sales path on OpenRouter names OpenRouter",
  );
  // 🔴 ONCE A DAY FOR EACH ACCOUNT, NOT ONCE A DAY FOR ALL OF THEM: a Claude account that runs dry in the
  // afternoon is a second outage, and one shared slot swallowed it after the morning's OpenAI alarm.
  const slots = new Map<AiCallRecord["provider"], string>();
  assert.equal(takeAiQuotaAlertSlot(slots, "openai", "2026-10-19"), true, "the first OpenAI alarm of the day is sent");
  assert.equal(takeAiQuotaAlertSlot(slots, "openai", "2026-10-19"), false, "a second OpenAI alarm the same day is not");
  assert.equal(takeAiQuotaAlertSlot(slots, "anthropic", "2026-10-19"), true, "Anthropic running out the same afternoon is still told");
  assert.equal(takeAiQuotaAlertSlot(slots, "openai", "2026-10-20"), true, "the next day starts again");
  assert.equal(
    aiQuotaIdempotencyKey("openai", "2026-10-19", "E-100"),
    "ai-quota-exhausted:2026-10-19:E-100",
    "the OpenAI key is the one it was always sent under, so the day this ships does not page him twice",
  );
  assert.notEqual(
    aiQuotaIdempotencyKey("anthropic", "2026-10-19", "E-100"),
    aiQuotaIdempotencyKey("openai", "2026-10-19", "E-100"),
    "each account has its own key for the day, or the notification store would drop the second as a repeat",
  );
  assert.equal(
    aiQuotaAlertEnabled(),
    false,
    "the suite runs with production credentials — it must never page the owner",
  );

  await runAiAccountAnsweringTests();
}

/**
 * The other half of the two alarms (18 Nov 2026). The first Anthropic account ran out of credit at 03:35 Cairo,
 * the backup answered every call all day, and when it was topped up nothing would have said so: a success
 * writes no row, so "mended" looked exactly like "nobody is working tonight".
 */
async function runAiAccountAnsweringTests() {
  // --- when an answer asks the question ---------------------------------------------------------
  const checked = new Set<AiCallRecord["provider"]>();
  const refused = new Set<AiCallRecord["provider"]>();
  const answered = (provider: AiCallRecord["provider"]) => record({ errorCode: undefined, provider, status: "success" });
  assert.equal(
    takeAnsweringCheckSlot(answered("anthropic"), checked, refused),
    true,
    "an account's FIRST answer in a process asks — the process Railway starts after a key swap never saw the refusals",
  );
  assert.equal(
    takeAnsweringCheckSlot(answered("anthropic"), checked, refused),
    false,
    "every later answer costs nothing — no read, no import — until the account refuses again",
  );
  assert.equal(
    takeAnsweringCheckSlot(answered("anthropic_backup"), checked, refused),
    true,
    "each account is asked about on its own",
  );
  assert.equal(
    takeAnsweringCheckSlot(
      record({ errorCode: AI_QUOTA_EXHAUSTED_CODE, failedOverTo: "anthropic_backup", provider: "anthropic", status: "failed_over" }),
      checked,
      refused,
    ),
    false,
    "a refusal is never itself an answer",
  );
  assert.equal(
    takeAnsweringCheckSlot(answered("anthropic_backup"), checked, refused),
    false,
    "the first account running dry does not make the backup's next answer news",
  );
  assert.equal(
    takeAnsweringCheckSlot(answered("anthropic"), checked, refused),
    true,
    "the first answer after this process saw the account refuse for credit asks again",
  );
  takeAnsweringCheckSlot(record({ errorCode: "timeout", provider: "anthropic", status: "error" }), checked, refused);
  assert.equal(
    takeAnsweringCheckSlot(answered("anthropic"), checked, refused),
    false,
    "a timeout is not an outage the alarm told, so the answer after it asks nothing",
  );
  takeAnsweringCheckSlot(record({ errorCode: "auth_failed", provider: "anthropic", status: "error" }), checked, refused);
  assert.equal(
    takeAnsweringCheckSlot(answered("anthropic"), checked, refused),
    true,
    "a refused key is the other alarm, and an answer after it asks too",
  );

  // --- which outage is still open ---------------------------------------------------------------
  assert.equal(unclosedAiOutage([]), null, "no alarm ever: an answer is ordinary and nobody is told");
  assert.deepEqual(
    unclosedAiOutage([
      { created_at: "2026-11-18T01:35:17Z", event_type: "ai_quota_exhausted" },
      { created_at: "2026-10-24T04:36:08Z", event_type: "ai_account_answering" },
    ]),
    { kind: "out_of_credit", toldAt: "2026-11-18T01:35:17Z" },
    "an alarm newer than any answering notice is an outage told and never closed",
  );
  assert.deepEqual(
    unclosedAiOutage([{ created_at: "2026-10-24T04:36:08Z", event_type: "ai_key_rejected" }]),
    { kind: "key_refused", toldAt: "2026-10-24T04:36:08Z" },
    "a refused-key alarm is closed the same way",
  );
  assert.equal(
    unclosedAiOutage([
      { created_at: "2026-11-18T22:10:00Z", event_type: "ai_account_answering" },
      { created_at: "2026-11-18T01:35:17Z", event_type: "ai_quota_exhausted" },
    ]),
    null,
    "an outage already closed is never told twice",
  );

  // --- what he reads ----------------------------------------------------------------------------
  assert.equal(aiAnsweringTitle("anthropic"), "Anthropic account is answering again");
  assert.equal(
    aiAnsweringIdempotencyKey("anthropic", "2026-11-18", "B-10"),
    "ai-account-answering:anthropic:2026-11-18:B-10",
    "one notice per outage and person — every process and every later answer lands on the same key",
  );
  assert.notEqual(
    aiAnsweringIdempotencyKey("anthropic", "2026-11-18", "B-10"),
    aiAnsweringIdempotencyKey("anthropic_backup", "2026-11-18", "B-10"),
    "each account closes its own outage",
  );
  const message = buildAiAccountAnsweringMessage(
    record({ component: "phoenix_crm_signboard", errorCode: undefined, provider: "anthropic", status: "success" }),
    { kind: "out_of_credit", toldAt: "2026-11-18T01:35:17Z" },
    new Date("2026-11-18T22:05:00Z"),
  );
  assert.match(message, /The first Anthropic account answered/, "it names the account that came back");
  assert.match(message, /reading the signboard in a place photo/, "and the feature it answered, in words");
  assert.match(message, /19 Nov, 00:05 Cairo/, "the answer's time is Cairo's, never UTC (22:05 UTC is 00:05 the next day)");
  assert.match(message, /out of credit since 18 Nov, 03:35 Cairo/, "and how long it had been out, from its alarm");
  assert.match(message, /Nothing else to do/, "calls go back to it by themselves, so it asks nothing of him");
  assert.match(
    buildAiAccountAnsweringMessage(
      record({ errorCode: undefined, provider: "anthropic_backup", status: "success" }),
      { kind: "key_refused", toldAt: "2026-11-18T01:35:17Z" },
      new Date("2026-11-18T10:00:00Z"),
    ),
    /The backup Anthropic account answered[\s\S]*refusing its key since/,
    "the backup account and a refused key read as what they are",
  );
  assert.equal(
    await notifyAiAccountAnswering(answered("anthropic")),
    true,
    "inside the suite it reads nothing and sends nothing, and says it finished so nothing retries",
  );

  // --- the recorder really asks on a success --------------------------------------------------------
  // A success returns early (it writes no row), so the check must come BEFORE that return. Drives the real
  // routing with fakes in place of the notices and the failure table.
  const calls: string[] = [];
  const sinks: AiCallSinks = {
    askAnswering: (r) => calls.push(`ask:${r.provider}`),
    pageAlarm: (r) => calls.push(`page:${r.provider}`),
    writeRow: (event) => calls.push(`row:${event.route}`),
  };
  const state: AiCallState = { answeringChecked: new Set(), lastReportedAt: new Map(), refusedSinceCheck: new Set() };
  dispatchAiCall(answered("anthropic"), sinks, state, 1_000);
  assert.deepEqual(calls, ["ask:anthropic"], "an account's first answer asks, and a success still writes no row");
  dispatchAiCall(answered("anthropic"), sinks, state, 2_000);
  assert.deepEqual(calls, ["ask:anthropic"], "the second answer asks nothing");
  dispatchAiCall(
    record({ component: "phoenix_crm_signboard", errorCode: AI_QUOTA_EXHAUSTED_CODE, failedOverTo: "anthropic_backup", provider: "anthropic", purpose: "phoenix-crm-signboard", status: "failed_over" }),
    sinks,
    state,
    3_000,
  );
  assert.deepEqual(
    calls,
    ["ask:anthropic", "page:anthropic", "row:/ai/phoenix_crm_signboard/phoenix-crm-signboard/failed-over"],
    "a refusal for credit pages and writes its row, exactly as before",
  );
  dispatchAiCall(answered("anthropic"), sinks, state, 4_000);
  assert.equal(calls.at(-1), "ask:anthropic", "the answer after that refusal asks whether the outage is still open");

  const metrics = stripComments(readFileSync("src/lib/observability/ai-metrics.ts", "utf8"));
  const recorder = metrics.slice(metrics.indexOf("export function recordAiCall("));
  assert.ok(
    recorder.includes("dispatchAiCall(record, LIVE_SINKS, LIVE_STATE)"),
    "recordAiCall routes every call through the routing pinned above",
  );
  assert.ok(
    metrics.includes(".then((alert) => alert.notifyAiAccountAnswering(record))"),
    "the live sink hands the answer to the notice",
  );
  assert.ok(
    /if \(!finished\) LIVE_STATE\.refusedSinceCheck\.add\(record\.provider\)/.test(metrics),
    "a check that could not finish is asked again on the next answer",
  );
}
