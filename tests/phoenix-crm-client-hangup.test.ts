import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isAbandonedIncomingRequest } from "@/lib/error-monitor/benign-disconnect.ts";

import { stripComments } from "./support/comment-strip.ts";

/**
 * A PHONE THAT HANGS UP WHILE STILL SENDING A PHOENIX CRM SAVE IS NOT AN ERROR.
 *
 * 27 Nov 2026: 23 of the 25 "Phoenix CRM request failed" rows of the week before carried Node's own
 * `Error: aborted` (code ECONNRESET) from `abortIncoming` / `socketOnClose` — the phone dropped the
 * connection mid-upload, so `request.json()` threw inside the route. Two of them were Gehad Alaa El
 * Din's plan saves at 03:39 and 03:41 Cairo; the saves around them landed and she sent the week at
 * 03:49. Each one also wrote an "API error hidden from the caller" row, so one hang-up was two rows.
 *
 * Both directions are pinned:
 *   - the exact Node error is matched, and phoenixCrmFailure answers it before toApiError and the log;
 *   - every OTHER reset or abort is NOT matched — an upstream socket we opened ("socket hang up",
 *     "read ECONNRESET"), a timeout we set (AbortError, PostgREST's "Supabase request timed out."), and
 *     "Connection closed." stay real faults at a route's catch.
 */
export function runPhoenixCrmClientHangupTests() {
  const hungUp = Object.assign(new Error("aborted"), { code: "ECONNRESET" });
  assert.equal(isAbandonedIncomingRequest(hungUp), true, "Node's connResetException('aborted') is the phone hanging up mid-upload");

  const ours: Array<[string, unknown]> = [
    ["an upstream socket hang up", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })],
    ["an upstream read reset", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })],
    ["'aborted' with no code", new Error("aborted")],
    ["'aborted' with another code", Object.assign(new Error("aborted"), { code: "EPIPE" })],
    ["a bare AbortError", Object.assign(new Error("This operation was aborted"), { name: "AbortError" })],
    ["PostgREST's own timeout", { code: "", message: "AbortError: Supabase request timed out.", details: "", hint: "" }],
    ["a real 'Connection closed.'", new Error("Connection closed.")],
    ["a string", "aborted"],
    ["null", null],
  ];
  for (const [label, error] of ours) {
    assert.equal(isAbandonedIncomingRequest(error), false, `${label} is OUR fault and must still be logged`);
  }

  const http = stripComments(readFileSync("src/lib/phoenix-crm/server/http.ts", "utf8"));
  const failure = http.slice(http.indexOf("export function phoenixCrmFailure("));
  const hangup = failure.indexOf("if (isAbandonedIncomingRequest(error))");
  assert.ok(hangup > 0, "phoenixCrmFailure asks whether the client hung up");
  assert.match(failure.slice(hangup, hangup + 400), /status: 499/, "the hang-up answers 499, nobody is there to read it");
  assert.ok(hangup < failure.indexOf("toApiError("), "the hang-up is decided before toApiError would file it as a hidden API error");
  assert.ok(hangup < failure.indexOf("logError("), "the hang-up is decided before the error log");
  assert.ok(!/logError\(/.test(failure.slice(hangup, failure.indexOf("toApiError("))), "the hang-up branch writes no error row");
}
