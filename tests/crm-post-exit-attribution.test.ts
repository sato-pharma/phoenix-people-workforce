import assert from "node:assert/strict";

import {
  buildCrmIdentityMaps,
  isAttributableOn,
  resolveEmployeeAttribution,
  resolveEmployeeHrId,
} from "../src/lib/crm/identity.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import type { CrmResolutionRow } from "../src/lib/crm/types.ts";

/** Minimal directory row — only the fields the identity waterfall reads. */
function employee(overrides: Partial<EmployeeDirectoryRow> & { hrId: string }): EmployeeDirectoryRow {
  return {
    crmId: null,
    crmUsername: null,
    lastWorkingDate: null,
    ...overrides,
  } as EmployeeDirectoryRow;
}

/**
 * POST-EXIT ATTRIBUTION GUARD.
 *
 * Whoever administers iReports360 hands a departing rep's CRM account to their replacement instead
 * of creating a new one, while the Phoenix roster keeps `employees.crm_id` pointing at the person
 * who left. Tier 2 of the waterfall therefore stamps the replacement's work with the LEAVER's hr id,
 * and the departed-agent exclusion then hides it — so the new rep's work goes invisible everywhere
 * and can manufacture a wrongful absence deduction.
 *
 * Verified in production 2026-08-01: 203 visits across 5 employees were attributed past an exit
 * date, the two largest (163 + 27) being the known misattributions.
 */
export function runCrmPostExitAttributionTests() {
  const leaver = employee({ hrId: "PD-0003", crmId: "1536", crmUsername: "Mayar.Tarek ( Dokki / P )", lastWorkingDate: "2026-06-30" });
  const replacement = employee({ hrId: "B-164", crmId: "1477", crmUsername: "Essam.Youssef ( Nasr City / P )" });
  const maps = buildCrmIdentityMaps([leaver, replacement]);

  // ── (A) Work up to and including the last working day still belongs to the leaver ────────
  assert.equal(
    resolveEmployeeHrId(1536, "Essam.Youssef ( Dokki / P )", maps, "2026-06-15"),
    "PD-0003",
    "a visit during employment must stay attributed to that employee",
  );
  assert.equal(
    resolveEmployeeHrId(1536, null, maps, "2026-06-30"),
    "PD-0003",
    "the last working day itself is INCLUSIVE — that day was worked",
  );

  // ── (B) Work after the exit date is refused, not silently filed under the leaver ──────────
  assert.equal(
    resolveEmployeeHrId(1536, null, maps, "2026-07-01"),
    null,
    "the day after the exit date must not be attributed to the departed employee",
  );
  const blocked = resolveEmployeeAttribution(1536, null, maps, "2026-07-15");
  assert.equal(blocked.hrId, null, "post-exit work resolves to nobody");
  assert.equal(
    blocked.blockedHrId,
    "PD-0003",
    "the blocked hr id is reported so the sync can COUNT and alert, not just see a bare null",
  );

  // ── (C) The name tier is guarded too — a stale display name outlives a person like an id ──
  const nameOnlyMaps = buildCrmIdentityMaps([
    employee({ hrId: "B-85", crmUsername: "Tayseer.Khaled ( Cairo East 1 / A )", lastWorkingDate: "2026-06-02" }),
  ]);
  assert.equal(
    resolveEmployeeHrId(null, "Tayseer.Khaled ( Cairo East 1 / A )", nameOnlyMaps, "2026-05-20"),
    "B-85",
    "the username tier still resolves during employment",
  );
  assert.equal(
    resolveEmployeeHrId(null, "Tayseer.Khaled ( Cairo East 1 / A )", nameOnlyMaps, "2026-07-20"),
    null,
    "the username tier must be guarded too — a stale crm_username outlives the person",
  );

  // ── (D) An explicit admin override WINS, including for post-exit dates ───────────────────
  //
  // Tier 1 is a human's hand-verified decision about who owns a CRM slot, and it is the intended way
  // to record "this slot belongs to someone the roster doesn't link". Guarding it would let a stale
  // roster date veto a human decision, inverting the waterfall's authority order.
  const resolutions: CrmResolutionRow[] = [{ crmId: 1536, mappedHrId: "B-164", status: "mapped" }];
  const overriddenMaps = buildCrmIdentityMaps([leaver, replacement], resolutions);
  assert.equal(
    resolveEmployeeHrId(1536, null, overriddenMaps, "2026-07-15"),
    "B-164",
    "an explicit identity override resolves the slot to the real current owner",
  );
  assert.equal(
    resolveEmployeeAttribution(1536, null, overriddenMaps, "2026-07-15").blockedHrId,
    null,
    "an override is not a blocked attribution — nothing needs alerting",
  );
  // And the override is not itself vetoed when it points at someone with a last working date.
  const overrideToLeaver = buildCrmIdentityMaps([leaver, replacement], [
    { crmId: 9999, mappedHrId: "PD-0003", status: "mapped" },
  ]);
  assert.equal(
    resolveEmployeeHrId(9999, null, overrideToLeaver, "2026-07-15"),
    "PD-0003",
    "the guard must not override an admin's explicit decision",
  );

  // ── (E) No date supplied → previous behaviour, so no caller silently starts failing ───────
  assert.equal(
    resolveEmployeeHrId(1536, null, maps),
    "PD-0003",
    "with no visit date to judge against, resolution is unchanged",
  );

  // ── (F) An active employee (no last working date) is never blocked ───────────────────────
  assert.ok(isAttributableOn("B-164", "2026-12-31", maps), "an employee with no exit date is always attributable");
  assert.ok(isAttributableOn("UNKNOWN-HR", "2026-12-31", maps), "an hr id absent from the map is not blocked");
  assert.ok(isAttributableOn("PD-0003", null, maps), "a null date cannot block anything");

  // ── (G) Timestamps compare correctly against a plain date ────────────────────────────────
  // Callers pass a sliced YYYY-MM-DD, but a full check-in timestamp must not accidentally read as
  // "after" its own last working day through string comparison.
  assert.ok(
    isAttributableOn("PD-0003", "2026-06-30T18:45:00", maps),
    "a timestamp ON the last working day is still attributable (the date part is what counts)",
  );
  assert.equal(
    isAttributableOn("PD-0003", "2026-07-01T00:05:00", maps),
    false,
    "a timestamp after the last working day is blocked",
  );
}
