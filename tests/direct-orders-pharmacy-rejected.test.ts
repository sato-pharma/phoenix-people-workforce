import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { normalizePharmacyVerificationStatus } from "../src/lib/direct-orders/types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// A pharmacy can be REJECTED — proven false, not merely unreviewed.
//
// On 2026-08-05 the owner ruled that ten hand-created pharmacies were false. `verification_status`
// permitted only 'verified' and 'pending_review', so the permanent record of that decision read
// "awaiting a look" about ten records that had already been looked at and refused, and the work had
// to be done in raw SQL against production.
//
// THE TRAP THIS FILE EXISTS FOR: the row mapper was binary —
//
//     String(row.verification_status ?? "verified") === "pending_review" ? "pending_review" : "verified"
//
// Anything that was not `pending_review` became `verified`. Adding `rejected` to the database while
// that line stood would have reported every rejected pharmacy as VERIFIED — the exact inverse of
// the truth — in the picker, the approval detail and the registry manager, with no type error and
// no failing test. Two render sites were two-way if/else branches with the same effect.
// ─────────────────────────────────────────────────────────────────────────────

const SERVICE = "../src/lib/direct-orders/service.ts";
const TYPES = "../src/lib/direct-orders/types.ts";
const MIGRATION = "../supabase/migrations/20260805190000_direct_order_pharmacy_rejected_state.sql";

function read(rel: string) {
  return readFileSync(new URL(rel, import.meta.url), "utf8");
}

export function runDirectOrderPharmacyRejectedTests() {
  // ── The mapper, executed. This is the assertion that matters most. ───────────────────────
  assert.equal(
    normalizePharmacyVerificationStatus("rejected"),
    "rejected",
    "A REJECTED PHARMACY IS BEING REPORTED AS SOMETHING ELSE: the mapper used to be binary, so `rejected` came out as `verified` — a pharmacy proven false, shown as trusted, everywhere in the app",
  );
  assert.equal(normalizePharmacyVerificationStatus("pending_review"), "pending_review");
  assert.equal(normalizePharmacyVerificationStatus("verified"), "verified");
  // A null column predates all of this and matches the column's own default.
  assert.equal(normalizePharmacyVerificationStatus(null), "verified", "an absent value keeps the column default");
  assert.equal(normalizePharmacyVerificationStatus(undefined), "verified");
  // An unrecognised value must NOT resolve to verified — unknown is a reason to look, never to trust.
  assert.equal(
    normalizePharmacyVerificationStatus("something_new"),
    "pending_review",
    "AN UNKNOWN VERIFICATION VALUE MUST FAIL CLOSED: resolving it to `verified` is how a future status silently becomes trust nobody granted",
  );
  assert.equal(normalizePharmacyVerificationStatus("REJECTED"), "rejected", "comparison must be case-insensitive");

  const service = read(SERVICE);
  const types = read(TYPES);

  // ── The old binary ternary must not come back ────────────────────────────────────────────
  assert.doesNotMatch(
    service,
    /=== "pending_review" \? "pending_review" : "verified"/,
    "THE BINARY MAPPER IS BACK: any value that is not pending_review becomes verified, which reports a rejected pharmacy as trusted",
  );
  assert.match(
    service,
    /verificationStatus: normalizePharmacyVerificationStatus\(row\.verification_status\)/,
    "the row mapper must go through the shared normaliser",
  );
  assert.match(types, /\| "rejected";/, "the type must admit the new state or nothing can hold it");

  // ── Rejecting is deliberate, reasoned, and Super-Admin only ──────────────────────────────
  const start = service.indexOf("export async function rejectDirectOrderPharmacy");
  assert.ok(start > 0, "rejectDirectOrderPharmacy must exist — without it the state can only be set by raw SQL, which is the problem it was built to end");
  const nextExport = service.indexOf("\nexport ", start + 10);
  const block = service.slice(start, nextExport > 0 ? nextExport : undefined);

  assert.match(
    block,
    /access\.scope === "system" \|\| access\.role === "Super Admin"/,
    "rejecting a pharmacy as false must be Super Admin only",
  );
  assert.match(block, /if \(!reason\) badRequest\(/, "a reason is mandatory — the reason IS the record");
  assert.match(
    block,
    /verification_status: "rejected", active: false/,
    "REJECTING MUST DEACTIVATE: twelve query sites filter on `active` and none filter on verification_status, so a rejected-but-active pharmacy would still appear in the picker, the search and the probation sweep",
  );
  // ── An APPROVED order is never swept up by rejecting its venue ───────────────────────────
  //
  // ASSERTED FIRST, DELIBERATELY. The first failed assertion ends the test, so whichever one in this
  // block fires first is the message a developer reads. The exact-match on the status list below would also go
  // red if `approved` were put back, but it would report "the list changed" — true, and the wrong
  // headline for money being reversed. This one has to be the one that speaks.
  //
  // `approved` sat inside that list until 2026-08-29. Rejecting a venue therefore reversed money
  // that had already cleared the entire approval chain — automatically, from a button whose subject
  // is the VENUE, with nobody deciding to reverse the ORDER, and with the audit row written about
  // the venue rather than the order. Owner's rule that day: "I don't want any confirmed order and
  // accepted from our workflow to be lost."
  //
  // It had never fired in production (0 cascade events, and audit_logs held no direct_order_request
  // row ever leaving `approved`), so this pins a hole that was closed before it cost anything —
  // which is exactly the kind that comes back, because nothing in the history argues against it.
  assert.doesNotMatch(
    block,
    /\.in\("status", \[[^\]]*"approved"[^\]]*\]\)/,
    "AN APPROVED ORDER MUST NEVER BE REFUSED BY REJECTING ITS VENUE: that is committed money reversed with no person deciding to reverse it (owner, 2026-08-29)",
  );
  assert.match(
    block,
    /\.in\("status", \["held", "pending_approval", "returned", "draft"\]\)/,
    "every order still OPEN on the pharmacy must be refused with it — otherwise they strand on a pharmacy nobody can ever confirm",
  );
  assert.match(
    block,
    /\.eq\("status", "approved"\)/,
    "the approved orders left standing must be counted — a venue ruled FALSE while carrying committed money is the case that most needs a person to look, and silence leaves the admin to discover it",
  );
  assert.match(
    block,
    /approvedOrdersKept: approvedKept\.length/,
    "the count must reach the caller and the audit row, not just be computed and dropped",
  );

  // ── A rejection cannot be undone by pressing "confirm" ───────────────────────────────────
  assert.match(
    service,
    /verification_status \?\? ""\) === "rejected"\) \{[\s\S]{0,400}?badRequest\(/,
    "CONFIRMING A REJECTED PHARMACY MUST BE REFUSED: markDirectOrderPharmacyVerified would otherwise flip it back to verified AND revive every order on it, undoing a refusal from a button labelled only \"confirm\"",
  );

  // ── The two ideas must stay separate ─────────────────────────────────────────────────────
  const validation = read("../src/lib/direct-orders/pharmacy-validation.ts");
  assert.doesNotMatch(
    validation,
    /verification_status: "rejected"/,
    "REJECTING A VALIDATION MUST NOT REJECT THE PHARMACY: the decide path deliberately leaves the rep free to resubmit — \"this evidence does not convince me\" is a different statement from \"this pharmacy does not exist\"",
  );

  // ── The database enforces the invariant, not just the caller ─────────────────────────────
  const migration = read(MIGRATION);
  assert.match(migration, /'rejected'::text/, "the constraint must permit the new value");
  assert.match(
    migration,
    /check \(verification_status <> 'rejected' or active = false\)/,
    "the rejected-implies-inactive invariant must be enforced by the DATABASE — a caller that forgets it would create a refusal the rest of the module ignores",
  );
  assert.ok(
    migration.indexOf("update public.direct_order_pharmacies") < migration.indexOf("direct_order_pharmacies_rejected_is_inactive"),
    "the backfill must run BEFORE the invariant constraint is added, or the migration fails on its own data",
  );
}
