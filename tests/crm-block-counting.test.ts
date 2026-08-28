import assert from "node:assert/strict";

import { recordsNoWorkToAttribute } from "../src/lib/crm/identity.ts";
import { buildCrmIdentityMaps } from "../src/lib/crm/identity.ts";
import { countBlockedAttributions, type BlockCountableVisit } from "../src/lib/crm/sync.ts";
import {
  ADMIN_WORK_TYPE,
  AMBIGUOUS_TYPE,
  BRM_TYPE,
  CAMPAIGN_TYPE,
  CASUAL_LEAVE_TYPE,
  HOLIDAY_TYPE,
  MEETING_TYPE,
  REGULAR_TYPE,
  TRAINING_TYPE,
  UNLABELED_FIELD_VISIT_TYPE,
} from "../src/lib/crm/visit-types.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import type { CrmResolutionRow } from "../src/lib/crm/types.ts";

function employee(overrides: Partial<EmployeeDirectoryRow> & { hrId: string }): EmployeeDirectoryRow {
  return { crmId: null, crmUsername: null, hireDate: null, lastWorkingDate: null, ...overrides } as EmployeeDirectoryRow;
}

function visit(overrides: Partial<BlockCountableVisit>): BlockCountableVisit {
  return { agentID: null, agentName: null, visitDate: null, visitType: REGULAR_TYPE, ...overrides };
}

/**
 * WHICH BLOCKED ATTRIBUTIONS ACTUALLY COUNT.
 *
 * THE INCIDENT THIS PINS (production, measured 2026-08-28). The CRM sync reported "with warnings" on
 * every single run from 27 August onward — 48 runs on the first day alone — and no action could ever
 * clear it. 27 August was a public holiday: iReports360 sprayed a holiday marker across EVERY account
 * in the system, 168 markers across 168 slots with zero real calls company-wide, deactivated accounts
 * included. Five of those landed on slots whose holder had left, the post-exit guard correctly refused
 * them, and the counter treated five dead accounts as five live handovers needing an override.
 *
 * They were provably dead: each slot's last real call is the day its holder left — `( Behira 2 / C )`
 * 2026-07-11 against a 2026-07-11 exit, `( Cairo West / C )` 2026-06-10 against 2026-06-11,
 * `( Bani Sweif / E )` 2026-06-10 against 2026-06-10. And the CRM admin strips the person's name at
 * resignation, so there was no identity left to record even if someone had tried.
 *
 * WHY THIS MATTERS MORE THAN THE NOISE. A counter that is permanently non-zero stops being a signal.
 * These same counters are what would page a human the day a CRM slot is genuinely handed to a new
 * hire and somebody's real work starts going unattributed — the case section (E) pins.
 */
export function runCrmBlockCountingTests() {
  // ── (A) The predicate: only the two codes that record the ABSENCE of work ─────────────────
  assert.equal(recordsNoWorkToAttribute(HOLIDAY_TYPE), true, "a public holiday records no work");
  assert.equal(recordsNoWorkToAttribute(CASUAL_LEAVE_TYPE), true, "a casual leave day records no work");

  // Everything else IS activity somebody performed, and a block on one still wants acting on.
  // Listed one by one rather than as "not the two above" so that adding a new code to the domain
  // forces a decision here instead of silently inheriting whichever default someone wrote.
  for (const [type, name] of [
    [REGULAR_TYPE, "a regular doctor call"],
    [CAMPAIGN_TYPE, "a campaign visit"],
    [TRAINING_TYPE, "a training day"],
    [MEETING_TYPE, "a meeting"],
    [ADMIN_WORK_TYPE, "admin work"],
    [BRM_TYPE, "a business review"],
    [AMBIGUOUS_TYPE, "an ambiguous -7 row, which may well be a sales day"],
    [UNLABELED_FIELD_VISIT_TYPE, "an unlabeled field visit — a real call the vendor never described"],
  ] as const) {
    assert.equal(recordsNoWorkToAttribute(type), false, `${name} records work and must still count`);
  }
  assert.equal(recordsNoWorkToAttribute(null), false, "an unknown type is not evidence of no work");
  assert.equal(recordsNoWorkToAttribute(undefined), false, "a missing type is not evidence of no work");

  // ── The roster the rest of the file counts against ────────────────────────────────────────
  //
  // A leaver whose slot was deactivated and name-stripped: the record's label no longer matches her
  // own, which is exactly what makes a post-exit row a block rather than her own trailing work.
  const leaver = employee({
    hrId: "B-171",
    crmId: "1485",
    crmUsername: "Samia.Elgendy ( Behira 2 / C )",
    hireDate: "2026-01-05",
    lastWorkingDate: "2026-07-11",
  });
  const joiner = employee({
    hrId: "AI-0003",
    crmId: "1602",
    crmUsername: "Soad.Atef ( Cairo East 1 / A )",
    hireDate: "2026-06-20",
  });
  const maps = buildCrmIdentityMaps([leaver, joiner]);
  const STRIPPED = "( Behira 2 / C )";

  // ── (B) A real call past the exit still counts — the alarm must keep working ──────────────
  assert.deepEqual(
    countBlockedAttributions(
      [visit({ agentID: 1485, agentName: STRIPPED, visitDate: "2026-08-27", visitType: REGULAR_TYPE })],
      maps,
    ),
    { postExit: 1, preHire: 0 },
    "a real doctor call on a slot whose holder has left is somebody's unattributed work — count it",
  );

  // ── (C) THE HEADLINE. The same slot, same date, a holiday marker — counts nothing ─────────
  //
  // This is the assertion the whole file exists for. If someone removes the skip, this returns
  // { postExit: 1 } and the sync goes back to reporting "with warnings" forever over dead accounts.
  assert.deepEqual(
    countBlockedAttributions(
      [visit({ agentID: 1485, agentName: STRIPPED, visitDate: "2026-08-27", visitType: HOLIDAY_TYPE })],
      maps,
    ),
    { postExit: 0, preHire: 0 },
    "a public-holiday marker is sprayed across every account including deactivated ones — a block " +
      "on one means a dead slot exists, not that anybody's work needs an override",
  );
  assert.deepEqual(
    countBlockedAttributions(
      [visit({ agentID: 1485, agentName: STRIPPED, visitDate: "2026-08-27", visitType: CASUAL_LEAVE_TYPE })],
      maps,
    ),
    { postExit: 0, preHire: 0 },
    "a casual-leave marker is the same shape and is skipped the same way",
  );

  // ── (D) The pre-hire counter obeys the identical rule ─────────────────────────────────────
  assert.deepEqual(
    countBlockedAttributions(
      [
        visit({ agentID: 1602, agentName: "Soad.Atef ( Cairo East 1 / A )", visitDate: "2026-02-14", visitType: CAMPAIGN_TYPE }),
        visit({ agentID: 1602, agentName: "Soad.Atef ( Cairo East 1 / A )", visitDate: "2026-02-14", visitType: HOLIDAY_TYPE }),
      ],
      maps,
    ),
    { postExit: 0, preHire: 1 },
    "before the hire date a campaign counts and a holiday marker does not — one rule, both ends",
  );

  // ── (E) THE SAFETY PROPERTY. Silencing markers cannot hide a genuinely reused slot ────────
  //
  // The one case that would be dangerous to miss is a CRM slot handed to a new hire while the roster
  // still points it at the leaver. That slot does not only emit markers — it emits the successor's
  // real calls too, and those still count. So the alarm survives exactly where it is needed.
  assert.deepEqual(
    countBlockedAttributions(
      [
        visit({ agentID: 1485, agentName: STRIPPED, visitDate: "2026-08-27", visitType: HOLIDAY_TYPE }),
        visit({ agentID: 1485, agentName: STRIPPED, visitDate: "2026-08-26", visitType: REGULAR_TYPE }),
        visit({ agentID: 1485, agentName: STRIPPED, visitDate: "2026-08-25", visitType: REGULAR_TYPE }),
      ],
      maps,
    ),
    { postExit: 2, preHire: 0 },
    "a reused slot still raises the alarm through its real calls — the marker skip is not a hole",
  );

  // ── (F) A refused OVERRIDE stays uncounted, and for its own separate reason ───────────────
  //
  // Pinned here as well as in crm-override-employment-scope so that whoever changes one skip sees
  // both. Isolating this path takes care: a refused override does not end the waterfall, it stands
  // aside and lets the automatic tiers try. So the slot must be one NO automatic tier can answer —
  // an id the roster does not carry — or tier 2 resolves the same leaver and produces a genuine
  // automatic block instead, which is a different thing and rightly counts (see the next assertion).
  const orphanSlot: CrmResolutionRow[] = [{ crmId: 7777, mappedHrId: "B-171", status: "mapped" }];
  const orphanMapped = buildCrmIdentityMaps([leaver, joiner], orphanSlot);
  assert.deepEqual(
    countBlockedAttributions(
      [visit({ agentID: 7777, agentName: "( Retired Slot / C )", visitDate: "2026-08-27", visitType: REGULAR_TYPE })],
      orphanMapped,
    ),
    { postExit: 0, preHire: 0 },
    "a slot whose only answer is a human's mapping, refused because the date is outside that " +
      "person's employment, has nothing left for anyone to record — even on a real call",
  );

  // The counterpart, and the reason the two skips must stay separate: when an AUTOMATIC tier
  // independently resolves the slot to the leaver, that block is real and is counted, mapping or no.
  const alsoMapped = buildCrmIdentityMaps([leaver, joiner], [{ crmId: 1485, mappedHrId: "B-171", status: "mapped" }]);
  assert.deepEqual(
    countBlockedAttributions(
      [visit({ agentID: 1485, agentName: STRIPPED, visitDate: "2026-08-27", visitType: REGULAR_TYPE })],
      alsoMapped,
    ),
    { postExit: 1, preHire: 0 },
    "an override standing aside leaves the automatic block intact, and a real call on it still counts",
  );

  // ── (G) Rows that resolve cleanly are not blocks at all ───────────────────────────────────
  assert.deepEqual(
    countBlockedAttributions(
      [
        visit({ agentID: 1485, agentName: STRIPPED, visitDate: "2026-05-04", visitType: REGULAR_TYPE }),
        visit({ agentID: 1602, agentName: "Soad.Atef ( Cairo East 1 / A )", visitDate: "2026-07-01", visitType: REGULAR_TYPE }),
        visit({ agentID: 9999, agentName: "Nobody.Here ( Tanta / P )", visitDate: "2026-07-01", visitType: REGULAR_TYPE }),
      ],
      maps,
    ),
    { postExit: 0, preHire: 0 },
    "work inside employment, and an agent the roster does not know at all, produce no blocks",
  );
  assert.deepEqual(countBlockedAttributions([], maps), { postExit: 0, preHire: 0 }, "an empty run counts nothing");
}
