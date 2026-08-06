import assert from "node:assert/strict";

import {
  applyPreservedIdentities,
  isSilentAttribution,
  selectIdentitiesToPreserve,
} from "../src/lib/crm/sync.ts";
import type { CrmAttribution } from "../src/lib/crm/identity.ts";

/**
 * Guards the CRM sync's identity-preservation step.
 *
 * THE INCIDENT THIS PINS (production, measured 2026-08-06). `ireports360_visits.agent_hr_id` was
 * NULL on 0% of rows for 2026-07-01..07-05 and on 5-9% of rows every day from 07-06 onward. The
 * rolling 10-day sync re-resolves identity on every run and the upsert overwrites every column, so
 * once `employees.crm_id` stopped carrying these people the sync wrote a null over an agent_hr_id
 * the mirror had already resolved. Because the deduction connectors match on `agent_hr_id`, seven
 * medical reps were then charged 14,629.01 EGP of "no CRM activity" deductions for days on which
 * they had logged 8-22 real visits.
 *
 * The fix rests entirely on telling two nulls apart, so that is what these tests pin:
 *   SILENT  (hrId null, blockedHrId null) — nobody matched; the stored identity must be preserved.
 *   BLOCKED (hrId null, blockedHrId set)  — the post-exit guard deliberately refused a match
 *                                            because the CRM slot was handed to a replacement.
 *                                            This null MUST still be written, or a leaver keeps
 *                                            being credited with the new rep's work (the bug that
 *                                            made 190 live visits invisible).
 *
 * This is also the reason a `coalesce(new, old)` database trigger would be wrong: Postgres cannot
 * distinguish the two, so it would silently undo the post-exit guard.
 */
export function runCrmSyncIdentityPreservationTests() {
  const silent: CrmAttribution = { blockedHrId: null, hrId: null };
  const blocked: CrmAttribution = { blockedHrId: "B-99", hrId: null };
  const resolved: CrmAttribution = { blockedHrId: null, hrId: "B-147" };

  // ── 1. The three attribution shapes ────────────────────────────────────────
  assert.equal(isSilentAttribution(silent), true, "no tier matched → preserve what is stored");
  assert.equal(isSilentAttribution(blocked), false, "the post-exit guard's refusal is a decision, not an absence");
  assert.equal(isSilentAttribution(resolved), false, "a resolved identity needs no rescue");

  // ── 2. Only rows with a silent column are looked up ────────────────────────
  {
    type Row = { attribution: CrmAttribution; id: number };
    const rows: Row[] = [
      { attribution: silent, id: 1 },
      { attribution: blocked, id: 2 },
      { attribution: resolved, id: 3 },
    ];
    const keys = selectIdentitiesToPreserve(rows, (row) => row.id, (row) => [row.attribution]);
    assert.deepEqual(keys, [1], "only the silent row needs its stored identity read back");
  }

  // ── 3. A null column that does not APPLY is never rescued ──────────────────
  // A visit with no double_crm_id has no second person. Its null double_hr_id is correct, and
  // restoring some previously-stored value would invent a participant the visit never had.
  {
    type Row = { double: CrmAttribution | null; id: number };
    const rows: Row[] = [{ double: null, id: 7 }];
    const keys = selectIdentitiesToPreserve(rows, (row) => row.id, (row) => [row.double]);
    assert.deepEqual(keys, [], "an inapplicable column is not a silent null");
  }

  // ── 4. The restore itself: the three cases that decide the money ───────────
  {
    type Row = { agent_hr_id: string | null; attribution: CrmAttribution; crm_visit_id: number };
    const rows: Row[] = [
      // SILENT — this is the B-147 / B-111 shape that caused the false deductions.
      { agent_hr_id: null, attribution: silent, crm_visit_id: 101 },
      // BLOCKED — a handed-over slot. Must stay null.
      { agent_hr_id: null, attribution: blocked, crm_visit_id: 102 },
      // RESOLVED — the fresh answer always wins over the stored one.
      { agent_hr_id: "B-147", attribution: resolved, crm_visit_id: 103 },
    ];
    const stored = new Map<number, Record<string, string | null>>([
      [101, { agent_hr_id: "B-147" }],
      [102, { agent_hr_id: "B-99" }],
      [103, { agent_hr_id: "B-OLD" }],
    ]);

    const restored = applyPreservedIdentities(rows, stored, (row) => row.crm_visit_id, [
      { column: "agent_hr_id", of: (row) => row.attribution },
    ]);

    assert.equal(rows[0]!.agent_hr_id, "B-147", "a SILENT null must be replaced by the stored identity");
    assert.equal(rows[1]!.agent_hr_id, null, "a BLOCKED null must survive — the post-exit guard decided it");
    assert.equal(rows[2]!.agent_hr_id, "B-147", "a freshly resolved identity must not be overwritten by the mirror");
    assert.equal(restored, 1, "exactly one column was rescued");
  }

  // ── 5. Nothing stored → nothing invented ───────────────────────────────────
  {
    type Row = { agent_hr_id: string | null; attribution: CrmAttribution; crm_visit_id: number };
    const rows: Row[] = [{ agent_hr_id: null, attribution: silent, crm_visit_id: 201 }];
    const restored = applyPreservedIdentities(rows, new Map(), (row) => row.crm_visit_id, [
      { column: "agent_hr_id", of: (row) => row.attribution },
    ]);
    assert.equal(rows[0]!.agent_hr_id, null, "a first-ever sync has nothing to preserve and must stay null");
    assert.equal(restored, 0);
  }

  // ── 6. A stored NULL is not a rescue ───────────────────────────────────────
  // The mirror having null too means the identity was never known; restoring it is a no-op that
  // must not be counted, or the run reports rescues it did not perform.
  {
    type Row = { agent_hr_id: string | null; attribution: CrmAttribution; crm_visit_id: number };
    const rows: Row[] = [{ agent_hr_id: null, attribution: silent, crm_visit_id: 301 }];
    const stored = new Map<number, Record<string, string | null>>([[301, { agent_hr_id: null }]]);
    const restored = applyPreservedIdentities(rows, stored, (row) => row.crm_visit_id, [
      { column: "agent_hr_id", of: (row) => row.attribution },
    ]);
    assert.equal(restored, 0, "a stored null rescues nothing and must not inflate the count");
  }
}
