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

  // ── (B) With NO label to compare, post-exit work is refused ──────────────────────────────
  //
  // Check-ins carry a crm_id only — never a display name — so the label test cannot run and the
  // stricter date-only answer stands. Unattributed is recoverable (it surfaces in Unmapped Agents);
  // silently crediting a leaver is the failure this guard exists to prevent.
  assert.equal(
    resolveEmployeeHrId(1536, null, maps, "2026-07-01"),
    null,
    "with no label to verify ownership, post-exit work must not be attributed to the departed employee",
  );
  const blocked = resolveEmployeeAttribution(1536, null, maps, "2026-07-15");
  assert.equal(blocked.hrId, null, "post-exit work resolves to nobody");
  assert.equal(
    blocked.blockedHrId,
    "PD-0003",
    "the blocked hr id is reported so the sync can COUNT and alert, not just see a bare null",
  );

  // ── (C) OWN TRAILING WORK is not a misattribution ────────────────────────────────────────
  //
  // The date alone cannot tell a handed-over slot from someone's final days logged late. The CRM
  // LABEL can: if the record still names the same person, the work is theirs. Every one of these is
  // a real production case from 2026-08-01 (see isAttributableOn's doc comment).
  const trailing = buildCrmIdentityMaps([
    employee({ hrId: "B-162", crmId: "1481", crmUsername: "Veronica.Ashraf ( Alex Center / A )", lastWorkingDate: "2026-06-30" }),
    employee({ hrId: "B-111", crmId: "1413", crmUsername: "Amany.Wasiem ( Assuit 1 / F )", lastWorkingDate: "2026-07-09" }),
    employee({ hrId: "B-176", crmId: "1499", crmUsername: "Eman.Essam ( Behera 1 / A )", lastWorkingDate: "2026-07-12" }),
  ]);
  assert.equal(
    resolveEmployeeHrId(1481, "Veronica.Ashraf ( Alex Center / A )", trailing, "2026-07-01"),
    "B-162",
    "work one day past the exit date, still carrying the person's OWN label, stays theirs",
  );
  assert.equal(
    resolveEmployeeHrId(1499, "Eman.Essam ( Behera 1 / A )", trailing, "2026-07-13"),
    "B-176",
    "same rule for a single trailing visit",
  );
  // The vendor emits this person's label with a DOUBLE space before the closing paren. Raw string
  // equality reports a false mismatch and would unmap correctly-attributed work; normalizeCrmName
  // is what makes the comparison hold.
  assert.equal(
    resolveEmployeeHrId(1413, "Amany.Wasiem ( Assuit 1 / F  )", trailing, "2026-07-12"),
    "B-111",
    "label matching must normalise the vendor's inconsistent internal spacing",
  );
  assert.equal(
    resolveEmployeeAttribution(1481, "Veronica.Ashraf ( Alex Center / A )", trailing, "2026-07-01").blockedHrId,
    null,
    "own trailing work is not a blocked attribution — it must not raise the sync alert",
  );

  // ── (D) A HANDED-OVER slot is still blocked — the label names someone else ────────────────
  assert.equal(
    resolveEmployeeHrId(1536, "Essam.Youssef ( Dokki / P )", maps, "2026-07-15"),
    null,
    "a record labelled with a DIFFERENT person must never be filed under the leaver",
  );
  // The real slot-1536 case began ONE day after the exit — which is why a grace window cannot work.
  assert.equal(
    resolveEmployeeHrId(1536, "Essam.Youssef ( Dokki / P )", maps, "2026-07-01"),
    null,
    "a handed-over slot is blocked from day one, however small the gap",
  );

  // ── (E) The name tier resolves a departed person's own late-logged work ───────────────────
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
    "B-85",
    "a record carrying the departed person's OWN label is their trailing work, not a reused slot",
  );
  // A label naming somebody else never resolves to the leaver in the first place.
  assert.equal(
    resolveEmployeeHrId(null, "Soad.Atef ( Cairo East 1 / A )", nameOnlyMaps, "2026-07-20"),
    null,
    "a different person's label does not resolve to the departed employee at all",
  );

  // ── (F) An explicit admin override WINS, including for post-exit dates ───────────────────
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

  // ── (G) No date supplied → previous behaviour, so no caller silently starts failing ───────
  assert.equal(
    resolveEmployeeHrId(1536, null, maps),
    "PD-0003",
    "with no visit date to judge against, resolution is unchanged",
  );

  // ── (H) An active employee (no last working date) is never blocked ───────────────────────
  assert.ok(isAttributableOn("B-164", "2026-12-31", maps), "an employee with no exit date is always attributable");
  assert.ok(isAttributableOn("UNKNOWN-HR", "2026-12-31", maps), "an hr id absent from the map is not blocked");
  assert.ok(isAttributableOn("PD-0003", null, maps), "a null date cannot block anything");

  // ── (I) Timestamps compare correctly against a plain date ────────────────────────────────
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
