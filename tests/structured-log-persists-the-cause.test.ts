import { strict as assert } from "node:assert";

import { persistedStack } from "../src/lib/observability/log.ts";

/**
 * An ERROR row has to carry the CAUSE, not just the headline.
 *
 * ── WHAT WENT WRONG ───────────────────────────────────────────────────────────────────────────
 *
 * `persistErrorEvent` used to write `error instanceof Error ? error.stack : null` into
 * `app_error_events.stack`. A Supabase rejection is NOT an `Error` — PostgREST rethrows a plain
 * `{ message, details, hint, code }` — so every database failure in this app landed in the table as
 * a headline with an EMPTY stack.
 *
 * Measured: on 2026-10-23 at 06:36 Cairo the row `Failed to read a closing publication drift status`
 * reached production's table with `route` null and `stack` empty. The actual cause was
 * `57014 canceling statement due to statement timeout`, and finding that out took the Postgres log —
 * which keeps days, where this table keeps months. The row that was supposed to outlive the log
 * stream outlived it saying nothing.
 *
 * ── WHY THE LABELS LEAD ───────────────────────────────────────────────────────────────────────
 *
 * A headline cannot carry WHICH line, period, job or source. The call site's labels can, they are
 * non-sensitive by this module's contract, and they are the difference between "a drift read failed"
 * and "the CNS 2026-09 drift read failed". `service` and `event` are dropped because every line
 * carries them and `event` is already the row's `route`.
 */
export function runStructuredLogPersistsTheCauseTests() {
  // ── a Supabase rejection is not an Error, and must still reach the row ──────────────────────
  const supabaseRejection = {
    code: "57014",
    details: null,
    hint: null,
    message: "canceling statement due to statement timeout",
  };
  const fromSupabase = persistedStack(undefined, supabaseRejection);
  assert.ok(
    fromSupabase !== null,
    "a non-Error throw must still produce a stack column - returning null here is the defect that "
      + "put an empty stack on every database failure in the table",
  );
  assert.ok(
    fromSupabase.includes("canceling statement due to statement timeout"),
    "the row must carry the database's own words - without them the row says a read failed and "
      + "never that it was a timeout",
  );
  assert.ok(
    fromSupabase.includes("57014"),
    "and the sql_state, which is what tells a timeout apart from a permission denial or a missing "
      + "relation",
  );

  // ── an Error still contributes its stack, unchanged ─────────────────────────────────────────
  const thrown = new Error("boom");
  const fromError = persistedStack(undefined, thrown);
  assert.ok(
    fromError !== null && fromError.includes("boom"),
    "an Error must still report itself - this path was never broken and must not regress",
  );

  // ── the call site's labels lead, minus the two every line carries ───────────────────────────
  const labelled = persistedStack(
    { event: "closing_publication_drift_read_failed", line: "CNS", period: "2026-09", service: "phoenix-hr" },
    supabaseRejection,
  );
  assert.ok(labelled !== null, "labels alone must not erase the cause");
  assert.ok(
    labelled.includes("line=CNS") && labelled.includes("period=2026-09"),
    "the labels that name WHICH read failed must reach the row - the headline cannot carry them, "
      + "and they are why the next reader does not need the Postgres log",
  );
  assert.ok(
    !labelled.includes("service=phoenix-hr"),
    "`service` is on every single line and is noise in this column",
  );
  assert.ok(
    !labelled.includes("event="),
    "`event` is already the row's `route` - repeating it here costs characters that truncation "
      + "would take off the cause",
  );
  assert.ok(
    labelled.indexOf("line=CNS") < labelled.indexOf("canceling statement"),
    "the labels lead: `stack` is truncated from the END, so the short, always-present part goes "
      + "first and the long cause takes the loss",
  );

  // ── nothing to say means null, never an empty string ───────────────────────────────────────
  assert.equal(
    persistedStack(undefined, null),
    null,
    "an ERROR logged with no error object and no labels must leave the column null - an empty "
      + "string reads as a cause that was captured and was blank",
  );
  assert.equal(
    persistedStack({ event: "some_event", service: "phoenix-hr" }, null),
    null,
    "and the two labels every line carries are not, by themselves, a cause",
  );
}
