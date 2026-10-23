// A structured ERROR's labels must reach the stored row, not just its event name.
//
// `logStructured("ERROR", …, { labels })` persists through log.ts's persistErrorEvent into
// app_error_events. Until 2026-10-23 that bridge carried exactly two things — `labels.route ??
// labels.job ?? labels.event` onto `route`, and an Error's `.stack` — and dropped every other
// label. Measured on production (ozucdzovmcqvepbozvqf) the same day: of 2,446
// `route_type='structured-log'` rows, ZERO carried an hr_id, ZERO carried a role, and 1,677 had no
// stack either, so the row was the event name and nothing else.
//
// The case that cost the diagnosis: src/lib/needs-you/service.ts logs a source timeout with
// `{ event, source, hrId, role, scope }`. The row said `route='needs_you_source_timeout'` and never
// WHICH source timed out, so the failing adapters had to be reconstructed out of the delivered
// Telegram digests in notification_events.metadata.
//
// Pinned here, because fixing one half still leaves the other blind:
//   1. the four labels with a real column are mapped onto those columns;
//   2. every remaining label survives, in the stack's label block;
//   3. the block LEADS, so `truncate`-from-the-end cannot silently eat it;
//   4. label values are redacted, because a label carries a share-link token as readily as a path;
//   5. the block is capped, so a generous call site cannot push a real stack out of the row.

import assert from "node:assert/strict";
import { structuredLogErrorInput } from "../src/lib/observability/log.ts";
import { LOG_LABELS_SEPARATOR, combineStack, formatLogLabels } from "../src/lib/error-monitor/service.ts";
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
  // 1. COLUMNS -- the four labels that have somewhere better to go than free text.
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

  // 2. THE REST -- nothing else may be dropped, and the constant `service` stamp is not signal.
  assert.deepEqual(
    input.logLabels,
    { event: "needs_you_source_timeout", source: "organogram-seat-drift", scope: "all" },
    "every label without a column must survive; `service` is the constant cleanLabels stamps on " +
      "every entry, and the four mapped onto columns are not repeated as text",
  );
  assert.ok(
    input.logLabels !== null && "source" in input.logLabels,
    "`source` is the label the whole incident turned on -- WHICH Needs You adapter timed out",
  );
  // `event` deliberately stays in the block as well as becoming the route: the column cannot say
  // which of route/job/event it came from, and a reader needs to know it was an event name.
  assert.equal(
    input.logLabels?.event,
    "needs_you_source_timeout",
    "`event` stays in the block too, so a reader can tell the route is an event name, not a path",
  );

  assert.equal(
    structuredLogErrorInput("x", { service: "phoenix-hr", event: "e" }, undefined).logLabels?.service,
    undefined,
    "the constant service stamp must never reach the stored block",
  );
  assert.equal(
    structuredLogErrorInput("x", { hrId: "B-10" }, undefined).logLabels,
    null,
    "labels that all have columns leave no block behind -- no separator with nothing under it",
  );
  assert.equal(structuredLogErrorInput("x", undefined, undefined).logLabels, null, "no labels, no block");

  // 3. PLACEMENT -- the block leads, because `stack` is truncated from the END.
  const block = formatLogLabels(input.logLabels);
  assert.ok(block, "the needs-you labels must format into a block");
  const withStack = combineStack("Error: boom\n    at thing (file.ts:1:1)", null, null, block);
  assert.ok(withStack, "combineStack must return something when given a stack and a block");
  assert.ok(
    withStack.startsWith(LOG_LABELS_SEPARATOR),
    "the label block must LEAD -- stack is truncated to 4000 from the end, so a trailing block is " +
      "the first thing a long stack would silently eat. Got: " + withStack.slice(0, 40),
  );
  assert.ok(
    withStack.includes("Error: boom"),
    "leading must not cost the real stack trace -- both have to be in the stored column",
  );
  // The 1,677-row case: no Error was passed, so the block is the entire diagnostic.
  assert.equal(
    combineStack(null, null, null, block),
    `${LOG_LABELS_SEPARATOR}\n${block}`,
    "with no stack the block stands alone, with no stray separators or blank lines around it",
  );
  assert.equal(
    combineStack("Error: boom", null, null, null),
    "Error: boom",
    "a row with no labels must be byte-identical to what it was before this existed",
  );

  // 4. PARSEABLE -- one `key=value` per line, so a reader and a `like` query both get at them.
  assert.deepEqual(
    formatLogLabels({ a: "1", b: "2" })?.split("\n"),
    ["a=1", "b=2"],
    "one key=value per line is the whole contract -- a JSON blob is not greppable in a text column",
  );
  assert.equal(formatLogLabels({ a: "" }), null, "an empty value is not worth a line, nor a separator");
  assert.equal(formatLogLabels(null), null, "null labels format to null, never to an empty block");

  // 5. REDACTED -- a label can carry a credential exactly as a path can, and redactSecretsFromRoute
  // is documented to run over free text for precisely this reason.
  const leaky = formatLogLabels({ target: "/share/territory/abc123secret", url: "/x?token=abc123secret" });
  assert.ok(leaky, "the leaky labels must still produce a block");
  assert.ok(
    !leaky.includes("abc123secret"),
    "a share-link token in a LABEL must be redacted at capture, same as one in a route -- the row " +
      "is written while the token still works. Got: " + leaky,
  );
  assert.ok(leaky.includes(TOKEN_PLACEHOLDER), "the redaction must leave the readable placeholder behind");

  // 6. CAPPED -- the block gets its own ceiling well under the column's 4000, so a call site that
  // labels generously cannot trade a lost stack for a kept label.
  const huge = formatLogLabels({ big: "x".repeat(5000) });
  assert.ok(huge, "an oversized label must still produce a block rather than being dropped whole");
  assert.ok(
    huge.length <= 1000,
    "the label block must be capped at 1000 so a 4000-character column keeps room for a real " +
      "stack trace; got " + huge.length,
  );
}
