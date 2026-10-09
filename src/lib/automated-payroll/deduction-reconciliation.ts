import { lookupSource } from "@/lib/payroll/copilot/assemble.ts";
import { roundCurrency } from "@/lib/payroll/money";
import type { PayrollSalarySource } from "@/lib/payroll/salary-source-model.ts";

import type { DeductionBuckets, EmployeeDeductions } from "./deductions-source.ts";
import { isSettledInPart1, type PopulationMember } from "./recommend.ts";
import type { DraftRow } from "./types.ts";

/**
 * DOES THIS RUN CHARGE WHAT THE DEDUCTIONS MODULE APPROVED?
 *
 * The question `module-drift.ts` does NOT answer. Drift compares the module's answer NOW against
 * its answer AT THE CONFIRM, so a figure somebody set below a proposal that never moved is
 * invisible to it — correctly, because that is a decision rather than staleness. Nothing then
 * answered the plain question "is the month charging the approved money?", and on 2026-10-09 it was
 * asked twice by hand in SQL and got a different answer each time: the first pass compared one
 * employee's unpaid vacation against a single candidate when the module had approved two days, and
 * reported a 700.01 gap that was really 941.67. This is that comparison, written down once.
 *
 * 🔴 IT REPORTS. It changes nothing, recommends nothing, and a difference is NOT a defect — the
 * owner trims a proposal deliberately (2026-10-09, on three September figures: "the trims on Ghada,
 * Esraa and Aisha are intended"). What this gives is the list with the routing already applied, so
 * the question is answered the same way every time it is asked.
 *
 * 🔴 THE ROUTING IS THE WHOLE DIFFICULTY, AND IT IS `isSettledInPart1`. A bucket does not have one
 * column: a leaver's or one-part employee's loan lands in the Part 1 Other Deductions tab's own
 * column, and a two-part employee's lands in the Part 2 manual column TOGETHER WITH `other`.
 * Compare a bucket against the wrong column and you report a gap for money that is charged, and
 * miss one that is not. The predicate is read exactly as the steps read it — the frozen stamp
 * first, the live rule only while Part 1 is unconfirmed — so this agrees with the sheet rather than
 * forming a second opinion about it.
 *
 * 🔴 AND "NOT COMPARABLE" IS NOT THE SAME AS "NOT CHARGED". A leaver's CRM column holds real money
 * priced by payroll's own settlement engine; the module's figure for the same days is priced off
 * the BASE. Subtracting them is meaningless, but printing the run side as 0.00 says the opposite of
 * the truth — measured on the September 2026 run, where it would have read "Aisha Ehab Mamdouh
 * Hussein, run charges 0.00" against 1,250.00 actually charged. A claim therefore carries its
 * column AND a `comparable` flag, so the money is always shown and only the subtraction is skipped.
 */

/** Which draft columns a bucket's approved money can reach, for one employee's routing. */
export type ReconciliationClaim = {
  /** The buckets compared together. Loan and Other share one Part 2 column, so there they are one claim. */
  buckets: (keyof DeductionBuckets)[];
  /** The draft columns summed on the other side. Shown even when `comparable` is false. */
  columns: (keyof DraftRow)[];
  /**
   * False when the two sides are priced by different rules, so their difference means nothing.
   * The money is still reported; only the verdict changes.
   */
  comparable: boolean;
  /** What to call it in the report. */
  label: string;
};

export type ReconciliationVerdict =
  /** The module's approved total equals what the run charges. */
  | "matches"
  /** The run charges LESS than the module approved. */
  | "charged less"
  /** The run charges MORE than the module approved. */
  | "charged more"
  /**
   * The two figures are not comparable, by design rather than through a hole. The one case is a
   * leaver's CRM: `recommendP1Crm` skips leavers outright and `recommendResignationCrm` takes only
   * the DAY COUNT from the module, pricing it at the leaver's own NET day rate (owner, 2026-08-04
   * for which days are chargeable; 2026-08-30 for what a day is worth). The module prices the same
   * day off the BASE, so the amounts differ legitimately and the gap is not a shortfall.
   */
  | "not comparable by design"
  /**
   * Part of this claim's approved money has since been RETIRED by the module, so the two sides
   * cannot be scored against each other in either direction — and this is reported rather than
   * resolved, because only the reader knows which way it should fall.
   *
   * It cannot prove an over-charge: the figure WAS approved when the sheet was frozen, which is
   * what the run was built on. It cannot demand a charge either: the module has withdrawn the
   * money, and a run that never charged it has the same answer the module now gives. Both shapes
   * are live on the published August 2026 run — 934.74 EGP that read as over-charged before
   * retired approvals were counted at all, and 3,597.53 EGP that read as under-charged the moment
   * they were counted into the total.
   */
  | "explained by a retired approval"
  /**
   * The employee has a draft row but is NOT in this run's population, so no recommender runs for
   * them and no step can route the money anywhere. Not a shortfall: there is nobody to charge.
   * September 2026 had one — somebody terminated on 31 August, inside the cohort the owner closed
   * as settled off-system on 2026-10-07.
   */
  | "not in the population"
  /** Money the module approved for somebody with no draft row on this run at all. */
  | "not on this run";

export type ReconciliationRow = {
  hrId: string;
  fullName: string;
  label: string;
  buckets: (keyof DeductionBuckets)[];
  columns: (keyof DraftRow)[];
  moduleAmount: number;
  runAmount: number;
  /** module − run. Positive means the run charges LESS than was approved. */
  difference: number;
  verdict: ReconciliationVerdict;
  settledInPart1: boolean;
  /** True while Part 1 is unconfirmed, so the routing was computed live and can still move. */
  routingProvisional: boolean;
};

export type ReconciliationReport = {
  /** Every row the comparison produced, largest difference first. */
  rows: ReconciliationRow[];
  /** The rows that do not match and are not explained by the routing. */
  differences: ReconciliationRow[];
  /** Approved money that no step on this run can reach — not on the run, or not in the population. */
  unreachable: ReconciliationRow[];
  /**
   * Claims whose two sides are priced by different rules AND still differ. Deliberately kept out of
   * `differences`, because the gap is not evidence of a shortfall — but never dropped either: on the
   * September 2026 run this is where a 200.00 figure the owner typed himself over the module's
   * proposal lives, and a report that showed only `differences` would have lost it in silence.
   */
  notComparableGaps: ReconciliationRow[];
  /**
   * Claims standing on money the module has since retired. Kept out of `differences` in both
   * directions — see the `explained by a retired approval` verdict for why neither sign is
   * evidence. Never dropped: the figures are real and the reader is the one who can judge them.
   */
  explainedByRetiredApproval: ReconciliationRow[];
  /** Sum of `difference` over `differences`. Positive means the month under-charges overall. */
  netDifference: number;
  /** How many employees' routing was read live rather than from the Part 1 stamp. */
  provisionalRouting: number;
  /**
   * Approvals counted on the MODULE side although the module has since retired them, because they
   * were live and approved when the run was frozen (`countSupersededApprovedAfter`).
   *
   * Reported rather than folded in silently: without this line the module total is a number nobody
   * can reproduce from the Deductions screen, which is the screen the owner reads. `count` is
   * claims, `amount` is their money.
   */
  retiredApprovalsCounted: { count: number; amount: number };
};

/**
 * The claims for one employee, given their routing. Each entry mirrors ONE recommender in
 * recommend.ts and is named after it, so a step that changes which column it writes has to change
 * this with it. Exported because the routing is the part worth pinning by test.
 */
export function claimsFor(settledInPart1: boolean, isLeaver: boolean): ReconciliationClaim[] {
  if (settledInPart1) {
    return [
      // recommendFingerprint — every employee, Part 1, whatever their payment mode.
      {
        buckets: ["fingerprint"],
        columns: ["fingerprintValue"],
        comparable: true,
        label: "Finger Print",
      },
      // recommendP1Crm — one-part CONTINUING employees only; it skips leavers on purpose, and
      // recommendResignationCrm prices a leaver's days itself. Both sides are shown; see the
      // `not comparable by design` doc for why the difference is not a shortfall.
      isLeaver
        ? {
            buckets: ["crm"],
            columns: ["crm"],
            comparable: false,
            label: "CRM · Resignations (leaver net day rate, not the module's price)",
          }
        : { buckets: ["crm"], columns: ["p1odCrmValue"], comparable: true, label: "CRM · Part 1" },
      // recommendP1UnpaidVacation. It writes `p1odVacationValue`, but for a LEAVER it reads the
      // saved figure back from `unpaidVacations` — and assembleRows charges BOTH columns
      // independently (totalDeductions adds `unpaidVacations`, and `p1odVacationValue` inside
      // otherDeductions). Summing them is what the employee is actually charged, not a guess at
      // which of the two holds it.
      {
        buckets: ["unpaidVacation"],
        columns: ["p1odVacationValue", "unpaidVacations"],
        comparable: true,
        label: "Unpaid Vacation · Part 1",
      },
      // recommendP1OtherDeductions — loan and other each get their own column here.
      { buckets: ["loan"], columns: ["p1odLoanValue"], comparable: true, label: "Loan · Part 1" },
      { buckets: ["other"], columns: ["p1odOtherValue"], comparable: true, label: "Other · Part 1" },
    ];
  }
  return [
    {
      buckets: ["fingerprint"],
      columns: ["fingerprintValue"],
      comparable: true,
      label: "Finger Print",
    },
    // recommendCrm — Part 2, continuing two-part employees.
    { buckets: ["crm"], columns: ["crm"], comparable: true, label: "CRM · Part 2" },
    // recommendVacation — Part 2.
    {
      buckets: ["unpaidVacation"],
      columns: ["unpaidVacations"],
      comparable: true,
      label: "Unpaid Vacation · Part 2",
    },
    // recommendManualDeductions — loan AND other land in the ONE Part 2 column together, so
    // comparing either against it alone reports a difference that is not there.
    {
      buckets: ["loan", "other"],
      columns: ["manualOtherDeductions"],
      comparable: true,
      label: "Loan + Other · Part 2",
    },
  ];
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const ALL_BUCKETS: (keyof DeductionBuckets)[] = [
  "fingerprint",
  "crm",
  "unpaidVacation",
  "loan",
  "other",
];

/**
 * Compare a run's draft rows against the Deductions module's approved totals, bucket by bucket.
 *
 * Pure, for the same reason `buildDeductionBuckets` is: every input is already loaded, so the
 * routing rule is testable without a database and the script stays a thin caller.
 *
 * `names` exists because the owner's standing rule is names, never codes — and the two cases this
 * report is FOR are exactly the ones with no population row to take a name from. Without it the
 * September 2026 run printed a line reading "A-7" where a person's name belongs.
 */
export function reconcileDeductions(input: {
  members: PopulationMember[];
  sources: Map<string, PayrollSalarySource>;
  deductions: Map<string, EmployeeDeductions>;
  draftRows: DraftRow[];
  /** Compact HR key → full name, for anybody absent from the population. */
  names?: Map<string, string>;
}): ReconciliationReport {
  const draftByCompact = new Map(input.draftRows.map((row) => [row.employeeHrIdCompact, row]));
  const memberByCompact = new Map(input.members.map((member) => [member.compact, member]));
  const rows: ReconciliationRow[] = [];
  let provisionalRouting = 0;

  // Read off the LINES the buckets were built from, never recomputed from the candidates: a second
  // derivation of "which approvals were retired" is a second answer, and this one has to agree with
  // the module totals the rows below are compared against.
  const retiredLines = [...input.deductions.values()].flatMap((employee) =>
    employee.lines.filter((line) => Boolean(line.supersededAt)),
  );
  const retiredApprovalsCounted = {
    count: retiredLines.length,
    amount: roundCurrency(retiredLines.reduce((sum, line) => sum + line.amount, 0)),
  };

  // Driven by the MODULE's keys: an employee the module approved money for who is not on the run
  // at all is exactly the case worth seeing, and iterating the population would drop them in
  // silence.
  for (const [compact, employeeDeductions] of input.deductions) {
    const buckets = employeeDeductions.buckets;
    const approved = roundCurrency(ALL_BUCKETS.reduce((sum, bucket) => sum + buckets[bucket], 0));
    if (approved === 0) continue;

    const member = memberByCompact.get(compact);
    const draft = draftByCompact.get(compact);
    const hrId = member?.employee.hrId ?? draft?.employeeHrId ?? compact;
    const fullName = member?.employee.fullName ?? input.names?.get(compact) ?? hrId;

    // Neither a draft row nor a population row, or a draft row for somebody no recommender runs
    // for: either way nothing on this run can carry the money, so there is nothing to compare.
    // Reported in full rather than subtracted, because the money is real and the reason is the
    // answer the reader needs.
    if (!draft || !member) {
      rows.push({
        hrId,
        fullName,
        label: draft ? "not in this run's population" : "no draft row on this run",
        buckets: ALL_BUCKETS.filter((bucket) => roundCurrency(buckets[bucket]) !== 0),
        columns: [],
        moduleAmount: approved,
        runAmount: 0,
        difference: approved,
        verdict: draft ? "not in the population" : "not on this run",
        settledInPart1: draft?.settledInPart1 === true,
        routingProvisional: false,
      });
      continue;
    }

    // `sources` is keyed by salary-source lookup keys, NOT by compact — lookupSource is the one
    // accessor every step uses, and reaching into the map directly misses whoever's HR id
    // normalizes differently.
    const source = lookupSource(input.sources, member.employee.hrId);
    const routingProvisional = draft.settledInPart1 == null;
    if (routingProvisional) provisionalRouting += 1;
    const settledInPart1 = isSettledInPart1(member, source, draft.settledInPart1);
    const isLeaver = member.lifecycle === "leaver";

    for (const claim of claimsFor(settledInPart1, isLeaver)) {
      const moduleAmount = roundCurrency(
        claim.buckets.reduce((sum, bucket) => sum + buckets[bucket], 0),
      );
      const runAmount = roundCurrency(
        claim.columns.reduce((sum, column) => sum + numeric(draft[column]), 0),
      );
      if (moduleAmount === 0 && runAmount === 0) continue;

      const difference = roundCurrency(moduleAmount - runAmount);
      // Retired money standing behind this claim takes it out of the scoring entirely — see the
      // "explained by a retired approval" verdict. Checked before the sign of the difference,
      // because it is wrong in BOTH directions, not just the one that bit first.
      const retiredAmount = roundCurrency(
        claim.buckets.reduce((sum, bucket) => sum + (employeeDeductions.retiredBuckets?.[bucket] ?? 0), 0),
      );
      const verdict: ReconciliationVerdict = !claim.comparable
        ? "not comparable by design"
        : difference === 0
          ? "matches"
          : retiredAmount !== 0
            ? "explained by a retired approval"
            : difference > 0
              ? "charged less"
              : "charged more";

      rows.push({
        hrId,
        fullName,
        label: claim.label,
        buckets: claim.buckets,
        columns: claim.columns,
        moduleAmount,
        runAmount,
        difference,
        verdict,
        settledInPart1,
        routingProvisional,
      });
    }
  }

  rows.sort(
    (left, right) =>
      Math.abs(right.difference) - Math.abs(left.difference) ||
      left.fullName.localeCompare(right.fullName) ||
      left.label.localeCompare(right.label),
  );
  const differences = rows.filter(
    (row) => row.verdict === "charged less" || row.verdict === "charged more",
  );
  return {
    rows,
    differences,
    unreachable: rows.filter(
      (row) => row.verdict === "not on this run" || row.verdict === "not in the population",
    ),
    notComparableGaps: rows.filter(
      (row) => row.verdict === "not comparable by design" && row.difference !== 0,
    ),
    explainedByRetiredApproval: rows.filter(
      (row) => row.verdict === "explained by a retired approval",
    ),
    netDifference: roundCurrency(differences.reduce((sum, row) => sum + row.difference, 0)),
    provisionalRouting,
    retiredApprovalsCounted,
  };
}

const money = (value: number) =>
  value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** One line for a terminal, an audit note or a chat report. Names, never codes, and never an ellipsis. */
export function describeReconciliation(report: ReconciliationReport): string {
  const priced = report.notComparableGaps
    .map(
      (row) =>
        `${row.fullName} ${row.label}: the module approved ${money(row.moduleAmount)}, ` +
        `the run charges ${money(row.runAmount)}`,
    )
    .join("; ");
  const pricedNote = priced
    ? ` Separately, ${report.notComparableGaps.length} figure(s) are priced by a different rule and ` +
      `are NOT counted above — each is either that rate difference or somebody's own typed figure, ` +
      `so read the step before calling it either: ${priced}.`
    : "";
  if (report.differences.length === 0) {
    return (
      "Every approved deduction is charged by this run, in the column its routing sends it to." +
      pricedNote
    );
  }
  const direction = report.netDifference > 0 ? "under" : "over";
  const named = report.differences
    .map(
      (row) =>
        `${row.fullName} ${row.label}: the module approved ${money(row.moduleAmount)}, ` +
        `the run charges ${money(row.runAmount)}`,
    )
    .join("; ");
  return (
    `${report.differences.length} figure(s) differ from the Deductions module, ` +
    `${money(Math.abs(report.netDifference))} ${direction}-charged in total. ${named}. ` +
    `A difference is not automatically a defect — a trimmed proposal is a decision.` +
    pricedNote
  );
}
