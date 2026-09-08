import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SUBMIT_FORM = "src/components/direct-orders/direct-order-submit-form.tsx";

/**
 * 🔒 OVER CAP NEVER BLOCKS A SUBMISSION.
 *
 * Owner rule, 2026-08-03, restated 2026-09-08 ("NEVER BLOCK TO ANY BONUS CAP"). A bonus or
 * discount above the cap is FLAGGED for every approver and submitted through the normal chain.
 * The cap is a signal, never a gate — the same shape as "the system flags an expense, it never
 * auto-rejects one".
 *
 * WHY A TEST AND NOT JUST THE COMMENT THAT WAS THERE. Until now the rule was held by a single
 * line of prose inside the component. Adding `&& !overCap` to the readiness expression is a
 * one-token edit that looks like tightening validation, reviews as an improvement, and would go
 * green — while silently reversing an owner decision and stranding every over-cap order at the
 * submit button with no error message anywhere.
 *
 * WHY IT READS THE SOURCE. `readyToSubmit` is a local inside a client component, so there is
 * nothing importable to call. Extracting it would mean refactoring the live path reps place real
 * orders through, to gain a test — the wrong trade against a rule this cheap to pin textually.
 *
 * It does NOT slice a byte window (those false-fail the moment the file shifts). It locates the
 * assignment by name and asserts on that expression alone, so the file can grow freely around it.
 */
export function runOverCapNeverBlocksTests() {
  // Line endings normalised first. The expression below is terminated by `;` at a line end, and a
  // CRLF checkout would put `\r` between the two — so a Windows working copy failed to find the
  // assignment AT ALL and reported "renamed" for a file that had not changed a character. That is
  // the wrong red: it points a reader at the gate instead of at the rule.
  const source = readFileSync(SUBMIT_FORM, "utf8").replace(/\r\n/g, "\n");

  // ── The readiness expression itself ─────────────────────────────────────────────────────────
  const match = source.match(/const readyToSubmit\s*=([\s\S]*?);\n/);
  assert.ok(
    match,
    "could not find the `readyToSubmit` assignment in the submit form — if it was renamed, this test must be pointed at the new gate rather than deleted",
  );
  const expression = match[1];

  // The whole rule, in one assertion: the submit gate cannot see the cap.
  assert.ok(
    !/cap/i.test(expression),
    `the submit gate must never reference a cap — over cap is flagged and submitted, never blocked (owner rule 2026-08-03, restated 2026-09-08). Found:\n${expression.trim()}`,
  );

  // The gate must still be a real gate — a test that only forbids something would also pass on an
  // expression someone had emptied to `true`, which blocks nothing but validates nothing either.
  for (const precondition of ["product", "qtyNum", "collectionDate"]) {
    assert.ok(
      expression.includes(precondition),
      `the submit gate must still require ${precondition} — this test forbids a CAP term, it does not license removing the real preconditions`,
    );
  }

  // ── What the rep is told ────────────────────────────────────────────────────────────────────
  // The banner is the other half of the rule: over cap must announce itself as flagged, and say
  // out loud that it is not blocked. A silent over-cap submission is its own defect — the rep
  // would not know an approver is about to see a flag.
  assert.match(
    source,
    /Over cap[\s\S]{0,200}not blocked/,
    "the over-cap banner must tell the rep the request still submits and is flagged, NOT blocked",
  );

  // ── The cap is still computed and shown ─────────────────────────────────────────────────────
  // Never blocking is not the same as never mentioning. If `overCap` stopped being derived at all,
  // the approver-facing flag would vanish and the cap would become decorative.
  assert.match(source, /const overCap\s*=/, "the form must still DERIVE overCap, so approvers keep getting the flag");
  assert.match(source, /over cap/i, "the form must still label an over-cap deal for the reader");
}
