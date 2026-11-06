// One employee-day must never be charged by two live deduction rows.
//
// WHY THIS EXISTS, MEASURED 2026-10-09. The Deductions screen listed one resigned representative twice
// for 27 September: a CRM row from the normal scan (Approved for Payroll, 533.33 EGP) and a CRM row from
// the final-settlement scan (Pending, 533.33 EGP), both live. The settlement path only inserts — it
// cannot retire an earlier row — and its draft is keyed `leaver_<hr>_<month>` where the normal scan keys
// each day `live_<month>_..._<day>`, so the candidate_key unique index let both in. findDayCollisions
// counts two rows of one category and one source as a single claim, so nothing flagged it. No money had
// doubled; approving the second row, or Select-all + Approve in the bulk bar, would have charged it twice.
//
// Two halves are pinned: the settlement path no longer adds a row beside one that covers the same day,
// and the screen marks a pair that is already there.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";

import { splitDraftsByClaimedDays } from "@/lib/deductions/conflict";
import { findSameDayOverlaps } from "@/lib/deductions/day-overlap";

const ROOT = path.resolve(import.meta.dirname, "..");

export function runDeductionsSameDayGuardTests() {
  // --- the settlement path holds back a draft that shares a day with a live row -----------------
  const live = [
    { employeeHrIdCompact: "b96", category: "crm" as const, sourceSystem: "crm_visits_mirror", dates: ["2026-09-27"] },
    { employeeHrIdCompact: "b96", category: "other" as const, sourceSystem: "manual_hr", dates: ["2026-09-01"] },
  ];
  const sameDay = { employeeHrId: "B-96", category: "crm" as const, monthKey: "2026-09", dates: ["2026-09-27"] };
  const partlyOverlapping = { employeeHrId: "B-96", category: "crm" as const, monthKey: "2026-09", dates: ["2026-09-27", "2026-09-29"] };
  const otherDay = { employeeHrId: "B-96", category: "crm" as const, monthKey: "2026-09", dates: ["2026-09-29"] };
  const otherPerson = { employeeHrId: "B-97", category: "crm" as const, monthKey: "2026-09", dates: ["2026-09-27"] };
  const otherCategory = { employeeHrId: "B-96", category: "fingerprint" as const, monthKey: "2026-09", dates: ["2026-09-27"] };
  const manualAnchored = { employeeHrId: "B-96", category: "other" as const, monthKey: "2026-09", dates: ["2026-09-01"] };

  const split = splitDraftsByClaimedDays([sameDay, partlyOverlapping, otherDay, otherPerson, otherCategory, manualAnchored], live);
  assert.deepEqual(
    split.keep,
    [otherDay, otherPerson, otherCategory, manualAnchored],
    "a draft is held back only when it shares a day with a live row of the SAME employee and category (another day, another person, another category and a manual placeholder date all stay)",
  );
  assert.equal(split.held.length, 2, "the same-day and the partly-overlapping drafts are both held back");
  assert.deepEqual(split.held[0].claimedDates, ["2026-09-27"]);
  assert.deepEqual(split.held[0].openDates, [], "a fully covered draft leaves no open day to name");
  assert.deepEqual(
    split.held[1].openDates,
    ["2026-09-29"],
    "a partly covered draft is held whole — never trimmed, because its amount is derived from the weighted day count — and names the day left open",
  );

  // --- the screen marks a pair that is already there ---------------------------------------------
  const approved = { id: "a", employeeHrId: "B-96", category: "crm" as const, dates: ["2026-09-27"], decision: { decisionStatus: "Approved for Payroll", appliedDates: null } };
  const pending = { id: "b", employeeHrId: "B-96", category: "crm" as const, dates: ["2026-09-27"], decision: null };
  const found = findSameDayOverlaps([approved, pending]);
  assert.deepEqual(found.get("a"), { otherIds: ["b"], dates: ["2026-09-27"] }, "both rows of the pair are marked");
  assert.deepEqual(found.get("b"), { otherIds: ["a"], dates: ["2026-09-27"] });

  assert.equal(
    findSameDayOverlaps([approved, { ...pending, decision: { decisionStatus: "Do Not Take Action", appliedDates: null } }]).size,
    0,
    "a row set to Do Not Take Action charges nothing, so it is not a clash",
  );
  assert.equal(
    findSameDayOverlaps([approved, { ...pending, decision: { decisionStatus: "Pending", appliedDates: [] } }]).size,
    0,
    "a day the reviewer unticked is not applied, so it is not a clash",
  );
  assert.equal(findSameDayOverlaps([approved, { ...pending, employeeHrId: "B-97" }]).size, 0, "two different people never clash");
  assert.equal(
    findSameDayOverlaps([
      { ...approved, category: "loan" as const, dates: ["2026-09-01"] },
      { ...pending, category: "loan" as const, dates: ["2026-09-01"] },
    ]).size,
    0,
    "Loan and Other carry a placeholder date, not a detected day",
  );

  // --- the wiring ----------------------------------------------------------------------------------
  const settlement = readFileSync(path.join(ROOT, "src/lib/deductions/settlement.ts"), "utf8");
  const code = settlement.replace(/\/\/.*$/gm, "");
  const splitAt = code.indexOf("splitDraftsByClaimedDays(");
  const insertAt = code.indexOf("insertCandidateDrafts({");
  assert.ok(splitAt > 0 && insertAt > splitAt, "settlement.ts must hold back claimed days BEFORE it inserts");
  assert.ok(
    /splitDraftsByClaimedDays\(mine,\s*live\)/.test(code) && /listCandidatesForMonth\(\{[^}]*employeeHrIdCompact:\s*wanted/.test(code),
    "settlement.ts must hand the guard the employee's LIVE rows — calling it with an empty list holds back nothing and the duplicate comes straight back",
  );
  assert.ok(!/reconcileCandidateDrafts\(/.test(code), "the settlement path must stay insert-only: a one-employee draft set would supersede the whole month");

  const workspace = readFileSync(path.join(ROOT, "src/components/admin/deductions-workspace.tsx"), "utf8");
  // Over EVERY row of the tab, never the filtered view: a search or decision filter must not hide
  // the clash it is meant to explain (2026-11-07, when the tab gained filters).
  assert.ok(/findSameDayOverlaps\(allRows\)/.test(workspace), "the category tab no longer looks for same-day pairs across all its rows");
  assert.ok(/<SameDayBadge overlap=/.test(workspace), "the same-day marker is not rendered on the rows");
  assert.ok(/clashingNames/.test(workspace) && /charges that day twice|charge the same day/.test(workspace), "the bulk bar no longer warns before approving both rows of a pair");
}
