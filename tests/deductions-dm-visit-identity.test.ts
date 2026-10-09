// A DISTRICT MANAGER IS CREDITED BY EITHER ID, ON HIS OWN SINGLE VISIT OR ON A DOUBLE.
//
// WHY THIS EXISTS. Owner, 2026-10-09: the deductions module "is not reading dm did a single visits
// and came it deduction it must read both dm single or double visit".
//
// The DSM no-record connector built its activity set from `agent_hr_id`, `double_hr_id` and
// `double2_hr_id` alone. But the CRM mirror resolves those hr id columns ASYNCHRONOUSLY and leaves
// them NULL for weeks, while `*_crm_id` is on the row from the moment it is written —
// `half-day-rule.ts` records 2,050 such rows since June, 601 of them one rep's. So inside that
// window a manager who was in the field read as ABSENT, and absent in this category means a FULL
// day charged with no approval step, because these rows publish themselves unless somebody marks
// them "Do Not Take Action".
//
// MEASURED ON PRODUCTION, 2026-10-09. Of 52 flagged DSM no-record days, three are days the manager
// is now provably credited on as a double partner:
//   Sameh Shabaan El Hoseiny  2026-07-06   7 rows, as the double on B-147's visits
//   Taha Mohamed AboElftouh   2026-07-13   8 rows, as the double on B-52's visits
//   Yehya Mohamed Kamal       2026-07-21  10 rows, as the double on B-112's visits
// Every one of those rows carries `synced_at = 2026-09-20 17:17 UTC` — five weeks AFTER the
// candidates were created on 2026-08-11. That is the hr id backfill arriving too late to matter.
//
// THE ONE THING THIS FIX MUST NOT DO is pair a crm id to a person through `employees.crm_id`.
// `deductions-dsm-no-record.test.ts` has forbidden that since 2026-08-04 and the reason is earned:
// on 3 reused CRM logins that column names a RESIGNED person while the feed resolves the current
// holder correctly, so joining it attributes a working rep's day to a leaver. The map is therefore
// built from the feed's own rows — a row carrying BOTH ids teaches the pairing, and the rows
// carrying only the crm id are resolved from it.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { buildHalfDayIdentity, resolveSlot } from "../src/lib/deductions/half-day-rule.ts";

const DSM = "src/lib/deductions/connectors/dsm-no-record.ts";
const HALF_DAY = "src/lib/deductions/connectors/half-day.ts";

export function runDeductionsDmVisitIdentityTests() {
  // ── The resolver itself: a crm-id-only slot still finds its person ────────
  {
    // One row carries both ids (the backfill has caught up on it); the other carries only the crm
    // id. Both must credit B-117.
    const identity = buildHalfDayIdentity([
      { hrId: "B-117", crmId: 1421 },
      { hrId: null, crmId: 1421 },
    ]);

    const byHrId = resolveSlot("B-117", null, identity);
    assert.equal(byHrId.compact, "b117", "an hr id must still resolve on its own");

    const byCrmIdOnly = resolveSlot(null, 1421, identity);
    assert.equal(
      byCrmIdOnly.compact,
      "b117",
      "a slot carrying ONLY the crm id must still credit the manager — this is the whole fix: the mirror leaves the hr id null for weeks, and a manager read as absent is charged a full day",
    );
    assert.equal(byCrmIdOnly.ambiguous, false, "one claimant is not an ambiguous crm id");

    // A crm id two people claim is never arbitrated.
    const reused = buildHalfDayIdentity([
      { hrId: "B-117", crmId: 1391 },
      { hrId: "B-94", crmId: 1391 },
    ]);
    const contested = resolveSlot(null, 1391, reused);
    assert.equal(contested.compact, null, "a reused crm id must resolve to nobody");
    assert.deepEqual(
      [...contested.claimants].sort(),
      ["b117", "b94"],
      "a contested crm id must name every claimant, so the caller can decide which way to be wrong",
    );
  }

  // ── The no-record connector reads both ids, in all three slots ────────────
  {
    const source = readFileSync(DSM, "utf8");
    const code = stripComments(source);

    for (const column of ["agent_crm_id", "double_crm_id", "double2_crm_id"]) {
      assert.match(
        code,
        new RegExp(column),
        `${DSM}: the visit scan must select ${column} — without it a manager whose hr id has not been backfilled reads as absent and is charged a full day`,
      );
    }

    assert.match(
      code,
      /resolveSlot\(/,
      `${DSM}: slots must be resolved through resolveSlot, the same rule the Half Day (CRM) connector uses — the two must never disagree about who was on a visit`,
    );
    // All three slots must be paired with their own crm id. The agent slot is the manager's OWN
    // single visit, which is the half of the owner's instruction that reads as "single".
    for (const [hr, crm] of [
      ["agent_hr_id", "agent_crm_id"],
      ["double_hr_id", "double_crm_id"],
      ["double2_hr_id", "double2_crm_id"],
    ]) {
      assert.match(
        code,
        new RegExp(`hr: row\\.${hr}, crm: row\\.${crm}`),
        `${DSM}: the ${hr} slot must carry ${crm} beside it, or that slot is still hr-id-only`,
      );
    }
    assert.match(
      code,
      /if \(resolved\.ambiguous\)[\s\S]{0,160}?for \(const claimant of resolved\.claimants\) credit\(claimant, date\)/,
      `${DSM}: a contested crm id must credit EVERY claimant's day — a day here can only ever REMOVE a charge, so on a contested identity not charging is the safe direction to be wrong in`,
    );

    // The earned rule this fix must not trample.
    assert.doesNotMatch(
      code,
      /employees\.crm_id/,
      `${DSM}: the directory's crm_id must never pair a crm id to a person — on reused logins it names a RESIGNED person while the feed resolves the current holder correctly`,
    );
  }

  // ── The half-day connector's identity map covers slot 2 as well ───────────
  {
    const code = stripComments(readFileSync(HALF_DAY, "utf8"));
    assert.match(
      code,
      /hrId: row\.double2_hr_id, crmId: row\.double2_crm_id/,
      `${HALF_DAY}: buildHalfDayEvidence already resolves slot 2, so its pairs must reach the identity map — otherwise a chain visit's second manager can only be found by the one id that is null while the mirror backfills`,
    );
  }
}
