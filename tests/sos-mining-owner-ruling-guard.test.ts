import assert from "node:assert/strict";

import { selectCustomerRowsToWrite } from "../src/lib/sales/normalizer/mapping.ts";

// The companion to tests/sos-self-heal-owner-verified-guard.test.ts. That one pins the guard on the
// SELF-HEAL path (applyCustomerBrickCorrections); this one pins it on the WRITE path every mining
// caller goes through — learnFromImportHistory, which fires unattended after every validated import,
// and learnFromCleanedFile.
//
// The defect this pins: saveMappings upserts ON CONFLICT DO UPDATE, and mining called it with no
// options at all. Each validated import therefore rewrote every customer mapping it had ever seen
// back to whatever the OLDEST historical sheet said, wiping confidence/mapped_by as it went. Measured
// against production on 2026-08-30: 418 owner-verified mappings, 417 of them in line to be
// overwritten, 4 onto an outright different brick — including a swapped Sohag pair (373353 and
// 442050) an admin had corrected by hand the week before.

type Row = { customer_code: string; distributor_code: string; brick_id: string };

function row(over: Partial<Row> = {}): Row {
  return { brick_id: "B213-1", customer_code: "373353", distributor_code: "IS-S", ...over };
}

export function runSosMiningOwnerRulingGuardTests() {
  const RULED = new Set(["IS-S 373353"]);
  const KNOWN = new Set(["IS-S 373353", "IS-S 442050"]);

  // THE HEADLINE. A mine must never touch a customer the crosswalk already knows — that is what
  // "bulk-bootstrap the dictionary" always claimed to do, and doing anything else is what reverted
  // the owner's rulings. Both the ruled customer and the merely-known one stay untouched.
  {
    const out = selectCustomerRowsToWrite([row(), row({ customer_code: "442050" })], KNOWN, RULED, "learn");
    assert.equal(out.rows.length, 0, "mining never rewrites a customer the crosswalk already holds");
    assert.equal(out.skippedOwnerVerified, 1, "the owner ruling is reported as a ruling");
    assert.equal(out.skippedExisting, 1, "the ordinary known customer is reported separately");
  }

  // Mining still does its actual job: a customer nobody has mapped yet is learned.
  {
    const out = selectCustomerRowsToWrite([row({ customer_code: "999001" })], KNOWN, RULED, "learn");
    assert.equal(out.rows.length, 1, "an unknown customer is still learned — the guard is not an off switch");
    assert.equal(out.skippedExisting, 0, "and nothing is counted as skipped");
  }

  // "correct" is the DEFAULT mode, so every caller that passes no options at all lands here. It may
  // refresh an ordinary mapping, but an owner ruling is still untouchable.
  {
    const out = selectCustomerRowsToWrite([row(), row({ customer_code: "442050" })], KNOWN, RULED, "correct");
    assert.equal(out.rows.length, 1, "correct mode still updates an ordinary existing mapping");
    assert.equal(out.rows[0]?.customer_code, "442050", "the row that survives is the unruled one");
    assert.equal(out.skippedOwnerVerified, 1, "the owner ruling is spared even in the default mode");
  }

  // "force" is the single escape hatch, held only by the Super-Admin mapping screen: the owner
  // changing his own mind must land.
  {
    const out = selectCustomerRowsToWrite([row()], KNOWN, RULED, "force");
    assert.equal(out.rows.length, 1, "an explicit human re-map overwrites even an owner ruling");
    assert.equal(out.skippedOwnerVerified, 0, "and nothing is reported as guarded");
  }

  // The guard is keyed (distributor, customer) exactly as the upsert's onConflict is, so a ruling on
  // one distributor must not shield the same customer code under another. Customer codes repeat
  // across distributors constantly.
  {
    const out = selectCustomerRowsToWrite([row({ distributor_code: "PS" })], new Set<string>(), RULED, "learn");
    assert.equal(out.rows.length, 1, "a ruling on IS-S does not shield the PS mapping of that code");
    assert.equal(out.skippedOwnerVerified, 0, "the guard matches the upsert key, not the code alone");
  }

  // Distributor is normalized on both sides of the comparison; the customer code is compared
  // literally, because that is what the upsert's onConflict compares.
  {
    const out = selectCustomerRowsToWrite([row({ distributor_code: " is-s " })], new Set<string>(), RULED, "learn");
    assert.equal(out.skippedOwnerVerified, 1, "a padded, lower-cased distributor still matches the ruling");
  }

  // A ruling on a row the batch does not carry must not remove anything.
  {
    const out = selectCustomerRowsToWrite([row({ customer_code: "999002" })], new Set<string>(), new Set(["IS-S 000000"]), "learn");
    assert.equal(out.rows.length, 1, "an unrelated ruling never suppresses a legitimate insert");
  }
}
