import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

/**
 * An acknowledged drift stays acknowledged only while it is the SAME drift.
 *
 * ── WHY THIS IS PINNED BY SOURCE ──────────────────────────────────────────────────────────────
 *
 * These are SQL functions with no application caller — the whole closing-drift module is reached
 * through psql and the Supabase MCP. There is nothing to exercise behaviourally from here, so the
 * design decision itself is what gets held: the fingerprint MUST include the deltas.
 *
 * ── WHAT GOES WRONG WITHOUT THE DELTAS ────────────────────────────────────────────────────────
 *
 * The obvious acknowledgement is a row saying "CNS 2026-07 is fine". That is a BLINDFOLD: every
 * later price edit, re-stamp or import repair on that line and period is absorbed by a note
 * somebody wrote in September, and the one thing the module exists to catch becomes the one thing
 * it cannot see.
 *
 * The near-miss version is subtler and is what this test really guards. Fingerprinting only WHICH
 * cells drifted looks careful and fails silently, because a price move changes the amounts without
 * changing the cell set. Measured on staging 2026-09-05: two successive edits to TE003 moved the
 * value from -558.80 to -894.08 across the SAME 49 cells. A cell-identity fingerprint stays
 * matched through that and hides a further 335.28 EGP of restatement; including both deltas flips
 * the verdict to "CHANGED SINCE IT WAS ACKNOWLEDGED", which is what production now does.
 */
export function runClosingDriftAcknowledgementTests() {
  const sql = readFileSync(
    "supabase/migrations/20260905130000_closing_drift_acknowledgement.sql",
    "utf8",
  );

  // ── the fingerprint carries BOTH deltas, not just the cell identity ─────────────────────────
  const fingerprintBody = sql.slice(
    sql.indexOf("function public.phx_closing_drift_fingerprint"),
    sql.indexOf("function public.phx_closing_drift_status"),
  );
  assert.ok(fingerprintBody.length > 0, "the fingerprint function must exist");
  assert.match(
    fingerprintBody,
    /round\(d\.units_delta, 6\)/,
    "the fingerprint must include the UNITS delta - without it a re-attribution of the same cells "
      + "stays acknowledged",
  );
  assert.match(
    fingerprintBody,
    /round\(d\.value_delta, 2\)/,
    "the fingerprint must include the VALUE delta - a price edit moves value on the SAME cells, so "
      + "a cell-identity fingerprint stays matched and hides the restatement (measured: -558.80 -> "
      + "-894.08 across the same 49 cells)",
  );
  assert.match(
    fingerprintBody,
    /where d\.area_code <> '\(no snapshot\)'/,
    "the '(no snapshot)' sentinel must be excluded - otherwise 'nothing has ever snapshotted this' "
      + "becomes acknowledgeable, and that is a state to fix rather than accept",
  );

  // ── the status must match on the fingerprint, never on line/period alone ────────────────────
  const statusBody = sql.slice(
    sql.indexOf("function public.phx_closing_drift_status"),
    sql.indexOf("function public.phx_acknowledge_closing_drift"),
  );
  assert.match(
    statusBody,
    /a\.drift_fingerprint = v_fingerprint/,
    "the acknowledgement must be matched on the fingerprint - matching on line and period alone is "
      + "the blindfold this module exists to avoid",
  );
  assert.match(
    statusBody,
    /CHANGED SINCE IT WAS ACKNOWLEDGED/,
    "a drift that WAS accepted and has since moved must say so, rather than reading as a first "
      + "sighting - the difference is whether anyone knows it was already looked at",
  );

  // ── an acknowledgement must name a person and give a reason ─────────────────────────────────
  const ackBody = sql.slice(sql.indexOf("function public.phx_acknowledge_closing_drift"));
  assert.match(
    ackBody,
    /An acknowledgement must name who made it\./,
    "an unattributed acknowledgement is worthless - somebody has to own the judgement",
  );
  assert.match(
    ackBody,
    /An acknowledgement must say WHY the drift is expected\./,
    "the entire value of this row is to a person who was not there when it was decided",
  );
  assert.match(
    ackBody,
    /There is no drift on % % to acknowledge\./,
    "acknowledging a clean line must fail - a pre-emptive acknowledgement would match the first "
      + "real drift that ever appears",
  );

  // ── the definer functions must not be reachable by anon or authenticated ────────────────────
  //
  // All three read the whole fact rollup as SECURITY DEFINER, and anon/authenticated inherit
  // EXECUTE through PUBLIC on a default ACL.
  for (const fn of [
    "phx_closing_drift_fingerprint(text, text)",
    "phx_closing_drift_status(text, text)",
    "phx_acknowledge_closing_drift(text, text, text, text)",
  ]) {
    assert.ok(
      sql.includes(`revoke execute on function public.${fn} from public, anon, authenticated;`),
      `${fn} must be revoked from public/anon/authenticated - it reads the whole fact rollup as definer`,
    );
    assert.ok(
      sql.includes(`grant  execute on function public.${fn} to service_role;`),
      `${fn} must be re-granted to service_role - revoking PUBLIC on a default ACL strips it too`,
    );
  }

  assert.ok(
    sql.includes("alter table public.monthly_closing_drift_acknowledgements enable row level security;"),
    "the acknowledgement table must have RLS enabled",
  );
  assert.ok(
    sql.includes("revoke all on public.monthly_closing_drift_acknowledgements from public, anon, authenticated;"),
    "and must not be readable or writable by anon or authenticated",
  );

  // ── the LIVE bodies, after 2026-10-23 split the recompute out ───────────────────────────────
  //
  // 🔴 EVERYTHING ABOVE NOW READS HISTORY. The 2026-09-05 file still holds the first definitions,
  // but the formula no longer lives inside phx_closing_drift_fingerprint and the acknowledgement
  // lookup no longer lives inside phx_closing_drift_status — both moved so that one line and period
  // cost ONE recompute of phx_closing_publication_snapshot instead of three (production 2026-10-23:
  // the status call alone was 3,635 ms and tipped past the 8-second statement timeout on the 06:36
  // digest). A test that pinned only the older file would keep passing while the live bodies drifted
  // away from it, which is the whole failure mode these assertions exist to prevent — so the same
  // three rules are pinned again here, on the file that now defines them.
  const live = readFileSync(
    "supabase/migrations/20261023084810_closing_drift_one_compute_and_contact_master_timeout.sql",
    "utf8",
  );

  const formulaBody = live.slice(
    live.indexOf("function public.phx_closing_drift_fingerprint_of"),
    live.indexOf("function public.phx_closing_drift_fingerprint(p_line"),
  );
  assert.ok(formulaBody.length > 0, "the lifted fingerprint formula must exist");
  assert.match(
    formulaBody,
    /round\(d\.units_delta, 6\)/,
    "the LIVE fingerprint must still include the UNITS delta - the expression was lifted into "
      + "phx_closing_drift_fingerprint_of, and it is the live one now",
  );
  assert.match(
    formulaBody,
    /round\(d\.value_delta, 2\)/,
    "the LIVE fingerprint must still include the VALUE delta - a price edit moves value on the SAME "
      + "cells, so a cell-identity fingerprint stays matched and hides the restatement",
  );

  const rowsBody = live.slice(
    live.indexOf("function public.phx_closing_drift_rows"),
    live.indexOf("function public.phx_closing_drift_fingerprint_of"),
  );
  assert.match(
    rowsBody,
    /where d\.area_code <> '\(no snapshot\)'/,
    "the '(no snapshot)' sentinel must be excluded in the one row-builder every other function "
      + "reads - excluding it once is what stops a later caller forgetting it",
  );

  const overviewBody = live.slice(
    live.indexOf("function public.phx_closing_drift_overview"),
    live.indexOf("function public.phx_closing_drift_status"),
  );
  assert.match(
    overviewBody,
    /a\.drift_fingerprint = v_fingerprint/,
    "the acknowledgement must still be matched on the fingerprint - matching on line and period "
      + "alone is the blindfold this module exists to avoid",
  );
  assert.match(
    overviewBody,
    /CHANGED SINCE IT WAS ACKNOWLEDGED/,
    "a drift that WAS accepted and has since moved must still say so",
  );

  // ── and the month is recomputed ONCE per line, which is the point of the whole file ─────────
  assert.equal(
    (live.match(/phx_closing_publication_drift\(p_line, p_period\)/g) ?? []).length,
    1,
    "phx_closing_publication_drift - which recomputes the whole month through "
      + "phx_closing_publication_snapshot - must be called from exactly ONE place in this file. A "
      + "second call site is the defect that was removed: the status function paid for the recompute "
      + "twice and the per-area read paid for it again, so three published lines cost nine "
      + "recomputes and one of them crossed the 8-second statement timeout",
  );

  for (const fn of [
    "phx_closing_drift_rows(text, text)",
    "phx_closing_drift_fingerprint_of(jsonb)",
    "phx_closing_drift_overview(text, text)",
  ]) {
    assert.ok(
      live.includes(`revoke execute on function public.${fn} from public, anon, authenticated;`),
      `${fn} must be revoked from public/anon/authenticated - it reads the whole fact rollup`,
    );
    assert.ok(
      live.includes(`grant  execute on function public.${fn} to service_role;`),
      `${fn} must be re-granted to service_role - revoking PUBLIC on a default ACL strips it too`,
    );
  }
}
