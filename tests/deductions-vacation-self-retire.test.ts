// A vacation re-collect must never delete the candidates it created itself.
//
// WHY THIS EXISTS, MEASURED ON PRODUCTION. Owner-reported 2026-10-07, after he
// had already reported the same symptom twice in other words:
// *"since u can read the vacation with no balance deductions correct why no
// automated payroll showing the deductions i approved in deductions module"*.
//
// `collect.ts` registers both vacation collectors with `reconcilesWholeCategory`,
// so every live candidate in the category a run collects is that run's to keep or
// to retire — a key the fresh scan does not produce IS superseded. But the
// already-claimed ledger read took every live candidate in the MONTH, with no
// category filter, which included the run's own rows from the run before. The
// request path therefore saw the day it had charged last time, treated it as
// taken, emitted no draft for it, and reconcile retired the row for being absent
// from the fresh scan. Every re-collect deleted the previous re-collect's work,
// with `superseded_by_candidate_id` NULL because there was no replacement to pair
// with — and the owner's decision on each row went with it.
//
// 2026-09 on production, before the fix: `vacation_balance` held 11 candidate
// keys, 29 superseded rows and 2 live ones; 13 of his decisions had been erased,
// three of them approvals (1,050.00 + 500.00 + 483.33 EGP); and 9 approved,
// still-unpaid vacation requests worth 7,374.99 EGP had no live candidate at all
// while the requests sat untouched in `v2_vacation_requests`. One generation
// chain, same `candidate_key`, same day, same amount:
//
//   created 06 Oct 06:35:19  Pending            -> retired 06:40:05
//   created 06 Oct 07:55:15  APPROVED 08:45:42  -> retired 07 Oct 02:35:27
//   created 07 Oct 02:40:05  live, back to Pending
//
// `crm_vacation_signal` never churned, because the CRM path does not read the
// ledger — it defers to live HR requests directly. That is why the single pushed
// vacation line survived.
//
// THE SIBLING TEST IS THE OTHER HALF OF THIS RULE.
// `deductions-vacation-ledger-guard.test.ts` pins that a day another live
// candidate already charges IS dropped (2026-08-03: 13 duplicate employee-days,
// 107,477.66 EGP). Both must hold at once: drop another owner's day, never your
// own replaceable one. Change one and read the other.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { ledgerRowStillClaimsItsDays } from "../src/lib/deductions/connectors/vacation.ts";

export function runDeductionsVacationSelfRetireTests(): void {
  // ── 1. The defect itself ──────────────────────────────────────────────────
  // This run's own unlocked row must NOT claim its day. Reconcile is about to
  // retire it, so treating it as taken is how the connector deleted its own
  // candidates — and the decision on each of them.
  assert.equal(
    ledgerRowStillClaimsItsDays({ category: "unpaid_vacation", lockedAt: null }, "unpaid_vacation"),
    false,
    "A live, UNLOCKED candidate in the category this run reconciles must not claim its day. It " +
      "does not survive the run — a key the fresh scan omits is superseded — so counting it makes " +
      "the scan omit the key, which retires the row and drops the owner's decision with it. That " +
      "is the 2026-10-07 defect: 13 decisions erased in one month, three of them approvals.",
  );

  // ── 2. The exception that must not be lost ────────────────────────────────
  // Reconcile REFUSES to supersede a locked candidate (published money is never
  // retracted automatically), so that row is still live after this run. Charging
  // its day again puts two live candidates on one employee-day — invisible to
  // findDayCollisions, which only reports a day claimed by more than one
  // CATEGORY, and surfacing as a raw unique_violation mid-publish from
  // deductions_publication_lines_guard_day_overlap.
  assert.equal(
    ledgerRowStillClaimsItsDays(
      { category: "unpaid_vacation", lockedAt: "2026-10-06T04:41:00.000Z" },
      "unpaid_vacation",
    ),
    true,
    "A LOCKED candidate in this run's own category must keep claiming its day: reconcile will not " +
      "retire it, so it is still live afterwards and re-charging that day double-books published " +
      "money. On production this is the one pushed September vacation line (466.67 EGP).",
  );

  // ── 3. Another category always claims ─────────────────────────────────────
  for (const lockedAt of [null, "2026-10-06T04:41:00.000Z"]) {
    assert.equal(
      ledgerRowStillClaimsItsDays({ category: "fingerprint", lockedAt }, "unpaid_vacation"),
      true,
      `A "fingerprint" candidate (lockedAt=${JSON.stringify(lockedAt)}) must claim its day whatever ` +
        "its lock state: this run does not reconcile that category, so the row survives and the day " +
        "is genuinely taken.",
    );
  }

  // ── 4. The two vacation categories are reconciled SEPARATELY ──────────────
  // collect.ts registers unpaid_vacation and insufficient_balance_vacation as
  // two collectors, each with its own reconcilesWholeCategory. So the sibling
  // category's row survives an unpaid_vacation run and still owns its day —
  // excluding it by "looks like vacation" would re-charge it.
  assert.equal(
    ledgerRowStillClaimsItsDays(
      { category: "insufficient_balance_vacation", lockedAt: null },
      "unpaid_vacation",
    ),
    true,
    "An insufficient_balance_vacation row must claim its day during an unpaid_vacation run. The two " +
      "are separate collectors with separate reconcile scopes, so this row is NOT retired by this " +
      "run — the exclusion is scoped to the category being reconciled, never to vacation in general.",
  );
  assert.equal(
    ledgerRowStillClaimsItsDays(
      { category: "unpaid_vacation", lockedAt: null },
      "insufficient_balance_vacation",
    ),
    true,
    "And symmetrically: an unpaid_vacation row claims its day during an insufficient_balance_vacation run.",
  );

  // ── 5. An unreadable category fails CLOSED ────────────────────────────────
  // A missing category must mean "someone else's day", never "mine to replace":
  // the expensive mistake here is deleting a decided row, so an unknown row is
  // left alone.
  for (const category of [null, "", "something_new"]) {
    assert.equal(
      ledgerRowStillClaimsItsDays({ category, lockedAt: null }, "unpaid_vacation"),
      true,
      `A row whose category is ${JSON.stringify(category)} must still claim its day — fail closed. ` +
        "Treating an unrecognised row as this run's own is how a decided candidate gets retired.",
    );
  }

  // ── 6. WIRING ─────────────────────────────────────────────────────────────
  // The pure function proves the rule. It proves nothing about the connector
  // applying it, which is the whole defect. Read EXECUTABLE lines only: this
  // file and the connector both document the incident at length in comments that
  // a raw-text match would happily satisfy.
  const source = readFileSync("src/lib/deductions/connectors/vacation.ts", "utf8");
  const code = stripComments(source);

  assert.match(
    code,
    /\.select\(\s*"(?:id,\s*)?employee_hr_id_compact,\s*dates,\s*category,\s*locked_at,\s*source_system"\s*\)/,
    'The ledger read must select "category", "locked_at" AND "source_system". Dropping category or ' +
      "locked_at is silent and inverts a decision: with no locked_at the predicate reads undefined, " +
      "Boolean(undefined) is false, and a PUBLISHED row stops claiming its day — so the connector " +
      "re-charges money that has already been paid. With no category every row looks foreign and the " +
      "2026-10-07 defect returns in full. source_system is what collectClaimedLedgerDays uses to skip " +
      "a manual_hr placeholder row (anchored to the 1st), so dropping it silently drops a genuine " +
      "same-category deduction on the real 1st.",
  );
  assert.match(
    code,
    /collectClaimedLedgerDays\(/,
    "loadAlreadyDeductedDays must route its rows through collectClaimedLedgerDays — the shared helper " +
      "that skips a manual_hr placeholder row and applies the keepRow predicate below.",
  );
  assert.match(
    code,
    /ledgerRowStillClaimsItsDays\(\{\s*category:\s*row\.category[\s\S]*?\},\s*input\.reconciledCategory\s*\)/,
    "collectClaimedLedgerDays must be passed ledgerRowStillClaimsItsDays as its keepRow, keyed on the " +
      "row's own category and locked_at and the category being reconciled. Without it the claimed set " +
      "contains this run's own replaceable rows again — a published row stops claiming its day and the " +
      "connector re-charges money already paid, which is exactly the defect.",
  );
  assert.match(
    code,
    /loadAlreadyDeductedDays\(\{\s*monthKey,\s*reconciledCategory:\s*input\.category\s*\}\)/,
    "The call site must pass the category being collected as reconciledCategory. Passing a constant, " +
      "or the wrong one, makes the exclusion either useless or dangerous — see case 4.",
  );
  assert.match(
    code,
    /\.is\(\s*"superseded_at",\s*null\s*\)/,
    "The ledger read must still be restricted to LIVE candidates — a withdrawn candidate frees its day.",
  );

  // Count guard: one declaration, one call. A second, unfiltered ledger read
  // would reintroduce the defect on whichever path used it, and every assertion
  // above would still pass.
  const reads = code.split("loadAlreadyDeductedDays").length - 1;
  assert.equal(
    reads,
    2,
    `Expected exactly 2 mentions of loadAlreadyDeductedDays in executable code (its declaration and ` +
      `its single call), found ${reads}. A new call site is not covered by the assertions above — ` +
      `point them at it, or route it through the same loader.`,
  );
}
