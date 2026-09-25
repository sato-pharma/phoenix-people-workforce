import assert from "node:assert/strict";

import {
  findDuplicateExpenseHolds,
  heldDuplicateTotal,
} from "../src/lib/automated-payroll/duplicate-expense-hold.ts";
import {
  buildExpenseStepRows,
  type PayoutExpenseTrip,
  type PopulationMember,
} from "../src/lib/automated-payroll/recommend.ts";
import { STEP_DEFINITIONS } from "../src/lib/automated-payroll/step-definitions.ts";
import type { DraftRow } from "../src/lib/automated-payroll/types.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";

/**
 * THE DUPLICATE-CLAIM HOLD: the same trip claimed twice in one payout run is held out of the
 * proposed figure, with a written reason, until a human decides.
 *
 * WHAT HAPPENED. Ahmed Mohamed Ahmed Mohamed Heikal was reimbursed 351.00 twice for one trip to
 * As Satamuni on 23 May 2026. TRP-00261 and TRP-00262 are the same person, the same day, the same
 * destination and the same amount; both arrived `hr_approved` from one import, both were tagged to
 * payout month 6, and the step summed both. Nobody approved it twice — the uploaded sheet carried
 * the row twice and nothing in the system compared a row against the rows beside it. June 2026 is
 * published and announced, so that 351.00 stays paid (owner rule); this stops the next one.
 *
 * THE SAFETY PROPERTY IS THAT THE HELD MONEY STAYS VISIBLE AND STAYS PAYABLE. The owner's standing
 * rule is that the system FLAGS an expense and never auto-rejects one, and a figure nobody can see
 * is indistinguishable from a refusal. So a held trip keeps its full amount, stays in the trip
 * breakdown carrying the reason, and is subtotalled into its own context column — and approving it,
 * or typing the amount, still pays it. The assertions below pin BOTH halves, because a change that
 * merely dropped the money would satisfy the headline figure and quietly underpay someone.
 *
 * THE FALSE-POSITIVE HALF MATTERS AS MUCH AS THE CATCH. A hold puts a real person's honest claim in
 * front of HR as a possible double-claim, so the rule is deliberately narrow: all four of person,
 * day, destination and amount must match. Measured over all 413 expense rows in Phoenix's history
 * (2026-09-26) it fires on that one group and nothing else. The three "near miss" blocks below are
 * the shapes that DO occur legitimately on production and must never be held:
 *   - same day, different destination — all ten same-day trip pairs on production are this shape;
 *   - same destination and amount, different day — a fixed per-trip allowance repeats all month;
 *   - same day and destination, different amount — two legs priced differently.
 */

function member(hrId: string, fullName: string): PopulationMember {
  return {
    employee: { hrId, fullName, hireDate: "2024-01-01" } as unknown as EmployeeDirectoryRow,
    compact: hrId.toLowerCase().replace(/[^a-z0-9]+/g, ""),
    lifecycle: "regular",
    lastWorkingDate: null,
    noticeLastWorkingDate: null,
  };
}

function trip(overrides: Partial<PayoutExpenseTrip> = {}): PayoutExpenseTrip {
  return {
    tripId: "TRP-00000",
    expenseDate: "2026-05-23",
    toDate: "2026-05-23",
    fromLocation: "Mansoura",
    toLocation: "As Satamuni",
    tripType: "traveling",
    transportationType: "Car",
    km: 60,
    travelCost: 251,
    meetingAmount: 0,
    allowance: 100,
    otherAmount: 0,
    total: 351,
    approvedAmount: null,
    hrApproved: true,
    hrStatus: "",
    description: "",
    ...overrides,
  };
}

function tripsFor(hrId: string, trips: PayoutExpenseTrip[]): Map<string, PayoutExpenseTrip[]> {
  return new Map([[hrId.toLowerCase().replace(/[^a-z0-9]+/g, ""), trips]]);
}

const noDrafts = new Map<string, DraftRow>();

/** Every trip id the rule held, sorted, so a block reads as one assertion instead of three. */
function heldIds(trips: PayoutExpenseTrip[]): string[] {
  return [...findDuplicateExpenseHolds(trips).keys()].sort();
}

export function runDuplicateExpenseHoldTests() {
  // ── 1. THE HEADLINE: the live 351.00 pair is proposed ONCE ─────────────────────────────────
  // The exact production rows, with the real trip ids. Before this rule the step proposed 702.00.
  const heikal = [
    trip({ tripId: "TRP-00261" }),
    trip({ tripId: "TRP-00262" }),
  ];
  const [heikalRow] = buildExpenseStepRows(
    [member("B-154", "Ahmed Mohamed Ahmed Mohamed Heikal")],
    tripsFor("B-154", heikal),
    noDrafts,
  );

  assert.equal(
    heikalRow.recommended.expenses,
    351,
    "HEADLINE: one trip claimed twice is proposed once — 351.00, never the 702.00 that summing both produces",
  );
  assert.equal(
    heikalRow.context["On Hold — Duplicate"],
    351,
    "and the held copy's value is SHOWN, not discarded — this is what stops the hold reading as a refusal",
  );
  assert.equal(
    heikalRow.context["Awaiting Decision"],
    0,
    "a held copy is not ALSO counted as awaiting a decision: the hold is the decision it waits for",
  );
  assert.equal(heikalRow.context.Trips, 2, "the trip COUNT still covers both copies");
  assert.equal(
    (heikalRow.details ?? []).length,
    2,
    "both copies stay in the breakdown: HR cannot compare two trips it cannot see",
  );

  const kept = (heikalRow.details ?? []).find((line) => line["Trip ID"] === "TRP-00261");
  const held = (heikalRow.details ?? []).find((line) => line["Trip ID"] === "TRP-00262");
  assert.equal(kept?.["On Hold"], "—", "the copy that IS proposed says so by carrying no hold");
  assert.match(
    String(held?.["On Hold"] ?? ""),
    /TRP-00261/,
    "the held copy names the other trip, so HR can open the two side by side",
  );
  assert.match(
    String(held?.["On Hold"] ?? ""),
    /approve it, or type the amount, to pay it/,
    "and says in plain words that it is not refused — the system flags an expense, it never auto-rejects one",
  );
  assert.equal(
    kept?.Total,
    351,
    "the kept copy still carries its full amount",
  );
  assert.equal(
    held?.Total,
    351,
    "and so does the held one: holding money is not reducing it",
  );

  // ── 2. NEAR MISS — same day, different destination. Never held ─────────────────────────────
  // Every one of the ten same-day trip pairs on production is this shape. A same-day rule alone
  // would have held all ten, which is ten honest claims stopped to catch nothing.
  assert.deepEqual(
    heldIds([
      trip({ tripId: "A-1", toLocation: "As Satamuni" }),
      trip({ tripId: "A-2", toLocation: "Talkha" }),
    ]),
    [],
    "two destinations in one day is ordinary work, not a duplicate",
  );

  // ── 3. NEAR MISS — same destination and amount, different day. Never held ──────────────────
  // A fixed per-trip allowance repeats legitimately: the same rep on the same route all month
  // produces identical amounts, and matching on amount alone would hold a dozen honest claims.
  assert.deepEqual(
    heldIds([
      trip({ tripId: "B-1", expenseDate: "2026-05-23" }),
      trip({ tripId: "B-2", expenseDate: "2026-05-24" }),
    ]),
    [],
    "the same route on two days is two trips, however identical the money",
  );

  // ── 4. NEAR MISS — same day and destination, different amount. Never held ──────────────────
  assert.deepEqual(
    heldIds([
      trip({ tripId: "C-1", total: 351 }),
      trip({ tripId: "C-2", total: 420 }),
    ]),
    [],
    "a different amount is a different claim, even on the same day to the same place",
  );

  // ── 5. NEAR MISS — the same trip for two DIFFERENT people. Never held ──────────────────────
  // Two reps travelling together file identical claims. The grouping is per person because
  // buildExpenseStepRows holds one trip list per employee; this pins that it stays that way.
  const together = new Map<string, PayoutExpenseTrip[]>([
    ["b154", [trip({ tripId: "D-1" })]],
    ["b155", [trip({ tripId: "D-2" })]],
  ]);
  const shared = buildExpenseStepRows(
    [member("B-154", "Ahmed Mohamed Ahmed Mohamed Heikal"), member("B-155", "Mahmoud Sayed Ali")],
    together,
    noDrafts,
  );
  for (const row of shared) {
    assert.equal(
      row.context["On Hold — Duplicate"],
      0,
      `${row.fullName} travelled with a colleague — two people on one trip is not one person claiming twice`,
    );
    assert.equal(row.recommended.expenses, 351, `${row.fullName} is still paid in full`);
  }

  // ── 6. Three copies: two held, one paid ────────────────────────────────────────────────────
  // Holding EVERY copy would turn one duplicated row into a row nobody is paid for, which is a
  // new error rather than the absence of the old one. The first copy is always proposed.
  const thrice = [trip({ tripId: "E-1" }), trip({ tripId: "E-2" }), trip({ tripId: "E-3" })];
  assert.deepEqual(heldIds(thrice), ["E-2", "E-3"], "the first copy is kept and only the extras wait");
  const holds = findDuplicateExpenseHolds(thrice);
  assert.equal(holds.get("E-3")?.duplicateOfTripId, "E-1", "every extra points back at the one copy being paid");
  assert.equal(holds.get("E-3")?.copies, 3, "and knows how many copies are in the run");
  assert.match(
    holds.get("E-3")?.reason ?? "",
    /3 copies in this run/,
    "which is said out loud once there is more than one extra",
  );
  assert.doesNotMatch(
    findDuplicateExpenseHolds(heikal).get("TRP-00262")?.reason ?? "",
    /copies in this run/,
    "but a plain pair does not pad its reason with a count of two",
  );

  // ── 7. An UNDECIDED duplicate is held, not left to swell "Awaiting Decision" ───────────────
  const undecided = [
    trip({ tripId: "F-1", hrApproved: false }),
    trip({ tripId: "F-2", hrApproved: false }),
  ];
  const [undecidedRow] = buildExpenseStepRows([member("B-154", "Ahmed Heikal")], tripsFor("B-154", undecided), noDrafts);
  assert.equal(undecidedRow.recommended.expenses, 0, "nothing approved means nothing proposed");
  assert.equal(
    undecidedRow.context["Awaiting Decision"],
    351,
    "one copy waits for a decision, not both — counting the held copy here would overstate what is outstanding",
  );
  assert.equal(undecidedRow.context["On Hold — Duplicate"], 351, "and the other is reported as the duplicate it is");

  // ── 8. HR's reduced amount still governs the held figure ───────────────────────────────────
  // heldDuplicateTotal must go through payableExpenseAmount like every other payout path, or the
  // subtotal claims money that was never payable.
  const reducedPair = [
    trip({ tripId: "G-1" }),
    trip({ tripId: "G-2", approvedAmount: 300 }),
  ];
  assert.equal(
    heldDuplicateTotal(reducedPair, findDuplicateExpenseHolds(reducedPair)),
    300,
    "the held copy is reported at HR's approved 300, not the claimed 351",
  );

  // ── 9. Spelling is not identity: case, spacing and a timestamped date still match ──────────
  // The feeder has shipped both "As Satamuni" and "as  satamuni", and a date column that
  // sometimes carries a time. A rule defeated by a double space is not a rule.
  assert.deepEqual(
    heldIds([
      trip({ tripId: "H-1", toLocation: "As Satamuni", expenseDate: "2026-05-23" }),
      trip({ tripId: "H-2", toLocation: "  as  SATAMUNI ", expenseDate: "2026-05-23T00:00:00+02:00" }),
    ]),
    ["H-2"],
    "the same destination written differently is still the same destination",
  );

  // ── 10. A trip with no id is left alone ────────────────────────────────────────────────────
  // It cannot be named back to HR and two of them cannot be told apart in the breakdown, so
  // holding it would produce a reason nobody can act on.
  assert.deepEqual(
    heldIds([trip({ tripId: "" }), trip({ tripId: "" })]),
    [],
    "an unidentifiable trip is never held against something else unidentifiable",
  );
  assert.deepEqual(
    heldIds([trip({ tripId: "" }), trip({ tripId: "I-2" })]),
    [],
    "nor held against a first copy that cannot be named in the reason",
  );

  // ── 11. The columns must be DECLARED, or the hold renders nowhere ──────────────────────────
  // `Trips` shipped populated-but-undeclared once and was blank in the grid, the mobile card and
  // the xlsx for weeks. The same mistake here would hide money while still withholding it, which
  // is the one outcome this whole file exists to prevent.
  const declared = STEP_DEFINITIONS.p2_expenses.contextColumns.find((column) => column.key === "On Hold — Duplicate");
  assert.ok(declared, "the step must DECLARE the On Hold — Duplicate column or the subtotal renders nowhere");
  assert.equal(declared?.money, true, "and declare it as money, so the grid and the xlsx both currency-format it");
  assert.ok(
    (STEP_DEFINITIONS.p2_expenses.detailColumns ?? []).some((column) => column.key === "On Hold"),
    "and DECLARE the per-trip On Hold column, or the reason is computed and never seen",
  );
  assert.match(
    STEP_DEFINITIONS.p2_expenses.subtitle,
    /held out of the figure/i,
    "the subtitle must tell HR that a duplicate is held",
  );
  assert.match(
    STEP_DEFINITIONS.p2_expenses.subtitle,
    /not refused/i,
    "and that it is not refused — the standing rule is flag, never auto-reject",
  );
}
