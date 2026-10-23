import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { CrmRequestError, crmGet, crmPost, isRetryableFailure } from "../src/components/phoenix-crm/api.ts";

/**
 * Phoenix CRM — when the connection drops, there is something to press.
 *
 * 🔴 OWNER, 2026-10-23: "add a tap-to-retry to the Phoenix CRM pages when the connection drops."
 *
 * What was measured first, on production: 1,161 rows of `Load failed` (Safari/iOS), `network error`
 * (Chrome/Android) and `Failed to fetch` in `app_error_events` over 14 days, across 62 releases and
 * all three platforms — a fetch the rep's own network cut off, median 12.5 minutes into a visible
 * session. READS already had a Try again (`CrmLoadError` + `reload`). SAVES had none: the rep got
 * the sentence "No connection. Check the phone's internet and try again." and had to find the form,
 * fill it in and press Save a second time — which on a visit mints a NEW client id and can file the
 * visit twice. Re-sending the attempt he already made is both kinder and safer.
 *
 * What this pins:
 *   1. Only a dropped connection is retryable — never a refusal, never a signed-out session.
 *   2. `useCrmAction` keeps the stopped attempt WHOLE, and drops it on success and on clearError.
 *   3. The completion runs inside `run`, so a retry that works advances the screen.
 *   4. Every save-error surface in Phoenix CRM offers the retry — mechanically, so a new screen
 *      cannot quietly go back to a dead sentence.
 *   5. `RefreshFailed` cannot be rendered without a retry at all.
 */

function source(path: string): string {
  return stripComments(readFileSync(path, "utf8"));
}

const API_PATH = "src/components/phoenix-crm/api.ts";
const UI_PATH = "src/components/phoenix-crm/ui.tsx";
const REPORT_LIST_PATH = "src/components/phoenix-crm/report-list.tsx";

/** The screens that run a save through `useCrmAction` and show its sentence. */
const SAVE_SCREENS = [
  "src/components/phoenix-crm/missed-record-panel.tsx",
  "src/components/phoenix-crm/test-accounts-tab.tsx",
  "src/components/phoenix-crm/visit-detail-panel.tsx",
  "src/components/phoenix-crm/visit-edit-panel.tsx",
  "src/components/phoenix-crm/visit-start.tsx",
  "src/components/phoenix-crm/visits-tab.tsx",
];

type FetchLike = typeof globalThis.fetch;

async function withFetch<T>(stub: FetchLike, work: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await work();
  } finally {
    globalThis.fetch = real;
  }
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

async function caught(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error;
  }
  throw new Error("the call was expected to fail and did not");
}

export async function runPhoenixCrmTapToRetryTests(): Promise<void> {
  // ── 1 · Only a dropped connection is retryable ───────────────────────────────────────────────
  //
  // Through the REAL `request()`, with the browsers' own wordings — Safari says "Load failed",
  // Chrome/Android "network error" — because what the rep's phone throws is a bare TypeError and
  // the code must not be reading its message to decide.
  for (const wording of ["Load failed", "network error", "Failed to fetch"]) {
    const error = await withFetch(
      () => Promise.reject(new TypeError(wording)),
      () => caught(() => crmGet("/api/phoenix-crm/anything", "view")),
    );
    assert.ok(error instanceof CrmRequestError, `${wording}: the screens must see a CrmRequestError`);
    assert.equal((error as CrmRequestError).code, "offline", `${wording}: must classify as offline`);
    assert.equal(
      (error as CrmRequestError).message,
      "No connection. Check the phone's internet and try again.",
      `${wording}: the rep reads one sentence, never the browser's`,
    );
    assert.equal(isRetryableFailure(error), true, `${wording}: a dropped connection IS retryable`);
  }

  // A refusal is a decision: the same payload gets the same answer, so there is nothing to press.
  const refusal = await withFetch(
    () => Promise.resolve(jsonResponse({ error: "visit_too_far", message: "That is 1.2 km from the pharmacy.", success: false }, 422)),
    () => caught(() => crmPost("/api/phoenix-crm/visits", { any: "thing" }, "saved")),
  );
  assert.equal((refusal as CrmRequestError).code, "visit_too_far");
  assert.equal(isRetryableFailure(refusal), false, "a refusal must NOT offer a retry");

  // Signed out CAN succeed later, but only after signing in — the sentence already says so.
  const signedOut = await withFetch(
    () => Promise.resolve(jsonResponse({ success: false }, 401)),
    () => caught(() => crmPost("/api/phoenix-crm/visits", { any: "thing" }, "saved")),
  );
  assert.equal((signedOut as CrmRequestError).code, "signed_out");
  assert.equal(isRetryableFailure(signedOut), false, "a signed-out session must NOT offer a retry");

  // Anything that is not one of ours is not retryable either.
  assert.equal(isRetryableFailure(new Error("Load failed")), false, "a bare Error carries no code to judge");
  assert.equal(isRetryableFailure("Load failed"), false, "a thrown string carries no code to judge");
  assert.equal(isRetryableFailure(null), false, "null carries no code to judge");

  // ── 2 · The hook keeps the attempt whole, and lets it go ─────────────────────────────────────
  const api = source(API_PATH);
  assert.match(
    api,
    /if \(isRetryableFailure\(caught\)\) setStopped\(\{ label, then: then as StoppedAttempt\["then"\], work \}\);/,
    "the stopped attempt must be stored ONLY behind isRetryableFailure, and must keep label, work AND then",
  );
  assert.match(api, /const run = useCallback\(async <T,>\(label: string, work: \(\) => Promise<T>, then\?: \(value: T\) => void\)/, "run must take the completion as its third argument");
  const runBody = api.slice(api.indexOf("const run = useCallback"), api.indexOf("const clearError = useCallback"));
  assert.ok(runBody.includes("setStopped(null);") && runBody.indexOf("setStopped(null);") < runBody.indexOf("const value = await work();"), "a new attempt must drop the previous stopped one BEFORE it runs");
  assert.ok(runBody.includes("then?.(value);"), "the completion must run inside run, so a successful retry advances the screen");
  assert.ok(runBody.indexOf("then?.(value);") < runBody.indexOf("} catch (caught)"), "the completion belongs in the success path");
  const clearBody = api.slice(api.indexOf("const clearError = useCallback"), api.indexOf("const retry = useMemo"));
  assert.ok(clearBody.includes("setError(null);") && clearBody.includes("setStopped(null);"), "clearError must clear the attempt too — a cleared sentence leaves no button behind");
  assert.match(api, /if \(stopped === null\) return null;/, "retry must be null when there is nothing to retry, so a screen can gate the button on it");
  assert.match(api, /retry: \(\(\) => void\) \| null;/, "CrmAction.retry must be nullable, so onRetry={action.retry} type-checks as the gate");

  // ── 3 · No screen keeps a follow-up behind the await ─────────────────────────────────────────
  //
  // This is the half a retry silently breaks: the save goes through on the second press and the
  // panel stays open, because the line that closed it only ever ran on the first attempt.
  for (const path of SAVE_SCREENS) {
    const text = source(path);
    for (const [, tail] of text.matchAll(/await action\.run\(([\s\S]{0,1400}?)\n  \}/g)) {
      assert.ok(
        !/\n\s{4}if \((?:saved|done|ok|result) (?:===|!==) undefined\)/.test(tail),
        `${path}: a follow-up left behind the await never runs on a retry — pass it to run as the third argument`,
      );
    }
    assert.ok(!/const (?:saved|done|ok) = await action\.run\(/.test(text), `${path}: the answer must be handled inside run, not captured after it`);
  }

  // ── 4 · Every save-error surface offers the retry ────────────────────────────────────────────
  const ui = source(UI_PATH);
  assert.match(ui, /export function CrmSaveError\(\{/, "the shared save-error surface must exist");
  const saveError = ui.slice(ui.indexOf("export function CrmSaveError({"), ui.indexOf("const STAT_BARS"));
  assert.ok(saveError.includes("onRetry?: (() => void) | null;"), "CrmSaveError must accept a nullable onRetry");
  assert.ok(saveError.includes("{onRetry ? ("), "the button must be gated on onRetry — never shown beside a refusal");
  assert.ok(saveError.includes("Try again"), "the button says Try again, the same words the read side already uses");
  assert.ok(!/rounded-(?:sm|md|lg|xl|full)/.test(saveError), "the square-edge rule: no rounded corners in the save-error surface");

  for (const path of SAVE_SCREENS) {
    const text = source(path);
    assert.ok(text.includes("CrmSaveError"), `${path}: shows a save sentence, so it must use CrmSaveError`);
    for (const [line] of text.matchAll(/^.*\{action\.error\}.*$/gm)) {
      assert.ok(line.includes("onRetry={action.retry}"), `${path}: every save sentence must carry onRetry={action.retry} — found: ${line.trim()}`);
    }
    assert.ok(
      !/<CrmNote[^>]*>\s*\{action\.error\}/.test(text),
      `${path}: a save sentence in a bare CrmNote is the defect this change removed — a rep is left with nothing to press`,
    );
  }

  // ── 5 · A failed refresh cannot be rendered without a retry ──────────────────────────────────
  const reportList = source(REPORT_LIST_PATH);
  assert.match(
    reportList,
    /export function RefreshFailed\(\{ error, onRetry \}: \{ error: string \| null; onRetry: \(\) => void \}\)/,
    "RefreshFailed's onRetry must be REQUIRED — a read can always be asked again, and every caller holds reload",
  );
  const refreshFailed = reportList.slice(reportList.indexOf("export function RefreshFailed"), reportList.indexOf("export function DaysToggle"));
  assert.ok(refreshFailed.includes("Try again"), "RefreshFailed must offer the retry itself, not leave it to each caller");
  // Swept across the WHOLE module, not one file: the first sweep read `insight-reports.tsx` alone
  // and missed thirteen more in `reports-tab.tsx`, which only the type gate then caught (#6315).
  const refreshFiles = ["src/components/phoenix-crm/insight-reports.tsx", "src/components/phoenix-crm/reports-tab.tsx"];
  let refreshTotal = 0;
  for (const path of refreshFiles) {
    const uses = [...source(path).matchAll(/<RefreshFailed[^/]*\/>/g)].map((match) => match[0]);
    assert.ok(uses.length > 0, `${path}: expected to show the refresh notice`);
    for (const use of uses) assert.ok(use.includes("onRetry={resource.reload}"), `${path}: the refresh notice must be wired to reload: ${use}`);
    refreshTotal += uses.length;
  }
  assert.ok(refreshTotal >= 18, `every report's refresh notice must be wired (found ${refreshTotal}, expected the 5 insight reports plus the 13 in the reports tab)`);
  assert.ok(
    source("src/components/phoenix-crm/daily-plan-report.tsx").includes('<CrmSaveError message={resource.error} onRetry={resource.reload} title="This plan could not be refreshed" tone="warn" />'),
    "the plan report's own refresh notice must offer the retry too",
  );
}
