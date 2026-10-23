// A structured ERROR's labels reach the stored row's own COLUMNS, not just its stack text.
//
// Sibling to tests/structured-log-persists-the-cause.test.ts, which pins what `persistedStack`
// puts in the `stack` column. This one pins the other half: the four labels that have a real
// column of their own, and the two safety properties of the label text that the cause test does
// not cover.
//
// ── WHAT WENT WRONG ──────────────────────────────────────────────────────────────────────────
//
// `persistErrorEvent` built its `logAppError` call from two fields — `route` and `stack` — so
// `hr_id`, `role`, `login_id` and `digest` were NEVER written by this path, whatever the call site
// labelled. Measured on production (ozucdzovmcqvepbozvqf) on 2026-10-23: of 2,446
// `route_type='structured-log'` rows, ZERO carried an `hr_id` and ZERO carried a `role`.
//
// The case that cost the diagnosis: src/lib/needs-you/service.ts logs a source timeout with
// `{ event, source, hrId, role, scope }`. The row said `route='needs_you_source_timeout'` and
// never WHICH source timed out, for whom, in what scope — so the failing adapters had to be
// reconstructed out of the delivered Telegram digests in `notification_events.metadata`.
//
// ── WHAT IS PINNED HERE ──────────────────────────────────────────────────────────────────────
//
//   1. the four labels with a column reach that column, under both spellings in use;
//   2. they are NOT also repeated in the stack text, where they would only cost the cause room;
//   3. label values are REDACTED — a label carries a share-link token as readily as a path, and
//      the row is written while the token still works;
//   4. the label text is CAPPED, so a generous call site cannot push the cause out of the row.
//
// (3) and (4) are the two gaps in the label block as first shipped. `service`/`event` exclusion
// and the labels-lead ordering belong to the cause test and are not re-asserted here.

import assert from "node:assert/strict";
import { persistedStack, structuredLogErrorInput } from "../src/lib/observability/log.ts";
import { TOKEN_PLACEHOLDER } from "../src/lib/error-monitor/redact-route.ts";

/** The exact labels src/lib/needs-you/service.ts passes, after cleanLabels stamps `service`. */
const NEEDS_YOU_TIMEOUT_LABELS = {
  service: "phoenix-hr",
  event: "needs_you_source_timeout",
  source: "organogram-seat-drift",
  hrId: "B-10",
  role: "Super Admin",
  scope: "all",
};

export function runStructuredLogLabelsReachTheRowTests() {
  // 1. COLUMNS — the four labels that have somewhere better to go than free text.
  const input = structuredLogErrorInput("Needs You source timed out", NEEDS_YOU_TIMEOUT_LABELS, undefined);

  assert.equal(
    input.route,
    "needs_you_source_timeout",
    "the event still becomes the route when no route/job label is given -- that behaviour is unchanged",
  );
  assert.equal(input.routeType, "structured-log", "the row must stay identifiable as a structured-log row");
  assert.equal(input.hrId, "B-10", "hr_id has a column and /admin/error-monitor filters on it -- it must not stay NULL");
  assert.equal(input.role, "Super Admin", "role has a column and is rendered in the table -- it must not stay NULL");

  // Both spellings are in use across the call sites (hrId 89, hr_id 14; loginId 9, login_id 1),
  // so accepting only the camelCase one would silently drop a seventh of them.
  const snakeCase = structuredLogErrorInput("x", { hr_id: "A-1", login_id: "a.one", digest: "123" }, undefined);
  assert.equal(snakeCase.hrId, "A-1", "hr_id must be read under its snake_case spelling too -- 14 call sites use it");
  assert.equal(snakeCase.loginId, "a.one", "login_id must be read under its snake_case spelling too");
  assert.equal(snakeCase.digest, "123", "digest has a column of its own and must reach it");

  assert.equal(
    structuredLogErrorInput("x", undefined, undefined).hrId,
    null,
    "no labels means no hr_id, never an empty string -- an empty string is not a person",
  );

  // 2. NOT TWICE — a label in a column must not also sit in the stack text, where the only thing
  // it can do is take characters off the cause that truncation would then drop.
  const stack = persistedStack(NEEDS_YOU_TIMEOUT_LABELS, undefined);
  assert.ok(stack, "the remaining labels must still produce a stack -- `source` and `scope` are the diagnostic");
  assert.ok(
    stack.includes("source=organogram-seat-drift"),
    "`source` is the label the whole incident turned on -- WHICH Needs You adapter timed out. Got: " + stack,
  );
  assert.ok(stack.includes("scope=all"), "`scope` has no column, so the stack is the only place it can go");
  assert.ok(
    !stack.includes("hrId=") && !stack.includes("hr_id="),
    "hr_id is in its own column now, so repeating it here only costs the cause room. Got: " + stack,
  );
  assert.ok(!stack.includes("role="), "same for role, which has a column and is rendered from it");
  assert.ok(
    !stack.includes("digest=") && !stack.includes("loginId="),
    "and for digest and login_id -- all four are columns, not stack text",
  );
  assert.equal(
    persistedStack({ service: "phoenix-hr", event: "e", hrId: "B-10", role: "Super Admin" }, null),
    null,
    "labels that ALL have columns (or are dropped) leave no stack behind -- not an empty string, " +
      "which reads as a cause that was captured and was blank",
  );

  // 3. REDACTED — a label can carry a credential exactly as a path can, and
  // redactSecretsFromRoute is documented to run over free text for precisely this reason.
  const leaky = persistedStack({ target: "/share/territory/abc123secret", url: "/x?token=abc123secret" }, null);
  assert.ok(leaky, "the leaky labels must still produce a stack");
  assert.ok(
    !leaky.includes("abc123secret"),
    "a share-link token in a LABEL must be redacted at capture, same as one in a route -- the row " +
      "is written while the token still works. Got: " + leaky,
  );
  assert.ok(leaky.includes(TOKEN_PLACEHOLDER), "the redaction must leave the readable placeholder behind");

  // 4. CAPPED — the labels LEAD and `stack` is cut from the END, so without a ceiling of their own
  // a generously-labelled call site evicts the cause the row was captured for.
  const cause = new Error("the cause that must survive");
  const huge = persistedStack({ big: "x".repeat(5000) }, cause);
  assert.ok(huge, "an oversized label must still produce a stack rather than being dropped whole");
  assert.ok(
    huge.includes("the cause that must survive"),
    "the cause must still be in the column -- evicting it to keep a long label trades one lost " +
      "diagnostic for another",
  );
  const labelPart = huge.split("\n")[0];
  assert.ok(
    labelPart.length <= 1000,
    "the label part must be capped at 1000 so the column's 4000 keeps room for the cause; got " + labelPart.length,
  );

  // The cause test's own ground: a non-Error throw must still reach the row. Re-checked here only
  // because the cap and the redaction run on the same path and must not disturb it.
  const supabaseRejection = { code: "57014", details: null, hint: null, message: "canceling statement due to statement timeout" };
  const withLabelsAndRejection = persistedStack({ hrId: "B-10", line: "CNS" }, supabaseRejection);
  assert.ok(
    withLabelsAndRejection?.includes("57014") && withLabelsAndRejection.includes("line=CNS"),
    "mapping hr_id onto its column must not cost the non-Error cause or the labels that stay",
  );
}
