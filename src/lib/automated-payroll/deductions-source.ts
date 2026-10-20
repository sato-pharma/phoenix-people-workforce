import {
  resolveAppliedDeductionDates,
  scaleDeductionAmountToDays,
} from "@/lib/deductions/calculations";
import { listCandidatesForMonth } from "@/lib/deductions/service";
import type { DeductionsCandidateWithDecision, DeductionsCategory } from "@/lib/deductions/types";
import { sumDetectedDeductionDayWeights } from "@/lib/field-workforce-compliance/weekend-policy";
import { logError } from "@/lib/observability/log";
import { roundCurrency } from "@/lib/payroll/money";

import type { PayrollPeriod } from "./types.ts";

/**
 * The bridge from the Deductions module to the Automated Payroll sheet.
 *
 * WHY THIS EXISTS (owner-reported 2026-08-03). Two deduction systems shipped
 * side by side with table names one letter apart — `deductions_candidates` /
 * `deductions_decisions` (the Deductions workspace HR actually works in) and
 * `deduction_candidates` / `deduction_decisions` (the older governance flow).
 * Payroll read the second; HR confirmed in the first. They had never been
 * connected, and the Deductions page said so in its own nav description:
 * "Phase 1 preview — feeds nothing live yet."
 *
 * Measured on production for July 2026 before this shipped: 32 employees and
 * 34,443.50 EGP approved in the workspace, against 8,480.60 EGP across 9
 * employees sitting in the payroll run. Exactly one employee agreed. This module
 * is what makes the number HR confirms the number payroll pays.
 *
 * WHAT COUNTS — owner rule, 2026-08-03: "only the deductions I confirmed to
 * payroll will appear in Automated Payroll." A candidate reaches the sheet if
 * and only if its decision is "Approved for Payroll". Pending, Needs Follow-up,
 * Disputed and Do Not Take Action all pay nothing.
 *
 * This DELIBERATELY DIVERGES from the module's own `isEligibleForPublish`, which
 * treats `crm` as mandatory ("whoever has N days must be deducted") and counts
 * it while still Pending. That rule still governs the module's own Overview and
 * publish snapshot; it does not govern payroll. The owner's reason is the
 * stronger one for money leaving the company: it was surfaced to him that a
 * single undecided July CRM row would charge one employee 8,709.68 EGP with no
 * decision recorded against it, and he ruled that nothing should be deducted
 * that he has not explicitly confirmed.
 *
 * The practical consequence is a payroll figure that can be LOWER than the
 * module's Overview total for the same month. That is intended, and the gap is
 * always exactly the not-yet-confirmed rows — approving them closes it.
 *
 * HOW MUCH is NOT re-implemented here, because a second copy of that rule is a
 * second answer to "what does this employee owe": the decided `appliedAmount`
 * when the reviewer set one, else the candidate's own estimate scaled to the
 * days actually charged (`scaleDeductionAmountToDays`). Scaling the candidate's
 * own figure rather than recomputing from base salary is the module's deliberate
 * choice, so a row cannot jump because payroll changed that salary last week.
 *
 * This module reads only. Nothing here decides, approves, or writes back — the
 * wizard still freezes whatever HR confirms into its own draft rows.
 */

/** The one decision state that lets money reach the payroll sheet (owner rule 2026-08-03). */
export const PAYROLL_APPROVED_STATUS = "Approved for Payroll";

/**
 * The sentence a WITHHELD deduction line carries in a payroll breakdown.
 *
 * Since the push gate was retired (owner, 2026-10-07 — see `loadConfirmedDeductions`) the only
 * thing that withholds a line is its decision: Pending, Needs Follow-up, Disputed or Do Not Take
 * Action. An approved line is never withheld, so there is one sentence again. The parameter keeps
 * its name and type so the breakdown's caller is unchanged.
 *
 * Never changes a figure. It says the line is not charged and why.
 * Pinned by tests/deductions-approved-not-pushed-feedback.test.ts.
 */
export function withheldLineStatus(decisionStatus: string): string {
  return `${decisionStatus} — not charged, awaiting your approval in Deductions`;
}

/**
 * Whether a candidate is confirmed for payroll. Deliberately explicit rather
 * than "not rejected": a status this function has never heard of must fail
 * CLOSED (pay nothing) rather than silently deduct.
 */
export function isConfirmedForPayroll(candidate: {
  decision?: { decisionStatus?: string | null } | null;
}): boolean {
  return (candidate.decision?.decisionStatus ?? "Pending") === PAYROLL_APPROVED_STATUS;
}

/** Payroll-facing buckets. Mirrors the module's own category → salary-column mapping. */
export type DeductionBuckets = {
  /** → Part 1 fingerprint step (`fingerprintValue`), for every employee. */
  fingerprint: number;
  /**
   * → the Part 2 CRM step (`crm`) — CONTINUING TWO-PART EMPLOYEES ONLY.
   *
   * 🔴 Known coverage gap, not a claim of completeness: `p1_crm` and
   * `p1_resignation_crm` never receive this map (see recommendStep's dispatch),
   * and `recommendCrm` skips `isSettledInPart1` employees. So a confirmed CRM
   * candidate belonging to a one-part or leaving employee reaches no step —
   * the same shape of hole this file closed for loan/other. Leavers do get a
   * CRM figure, but from payroll's own `computeLeaverCrmDates`, not from here.
   * OWNER DECISION 2026-08-04 — ACCEPTED AND CLOSED, not a bug awaiting a fix.
   * Measured exposure on production that day: 0.00 EGP. The 20 one-part
   * employees have produced ONE candidate in these categories in the module's
   * whole lifetime and it was never approved, and every dsm_no_record and
   * holiday_bridge row belongs to a two-part employee. The overlap is
   * structural, not luck — these connectors target the field workforce.
   *
   * Do not "fix" this by wiring the map into the Part 1 steps. Two reasons:
   * leavers are NOT missing their figures (they come from payroll's own
   * settlement-aware engine — Base ÷ the month's ACTUAL days, capped at days
   * worked so no post-resignation day is charged, a deliberate 2026-07-26 rule
   * this must not overwrite), and `isSettledInPart1` is used in both directions
   * to keep the two populations disjoint, so feeding a Part 1 step without
   * removing the Part 2 path double-charges the same days.
   *
   * Reopen only if field-workforce staff — district managers especially — move
   * onto one-part pay. That makes it live immediately.
   */
  crm: number;
  /** unpaid_vacation + insufficient_balance_vacation → the Part 2 vacation step. Same one-part/leaver gap as `crm`. */
  unpaidVacation: number;
  /** → Part 1 Other Deductions, Loan column. */
  loan: number;
  /** other + the retired no_records_activity → Part 1 Other Deductions, Other column. */
  other: number;
};

/** One eligible candidate behind a bucket total — feeds the step's expandable breakdown. */
export type DeductionLine = {
  category: DeductionsCategory;
  /** The days actually charged (already narrowed to the reviewer's selection). */
  dates: string[];
  /**
   * The number of dates flagged — the EVIDENCE. Four no-activity dates read 4 here whatever
   * any of them is worth. Display this; never multiply a salary by it.
   */
  days: number;
  /**
   * The same span expressed as CHARGEABLE days — the multiplier the money is derived from.
   * Differs from `days` whenever a flagged date is worth less than a whole one, which today
   * means a Thursday (the owner's 2026-08-02 half-day rule).
   *
   * The two are separate because the module keeps evidence and charge separately auditable, and
   * the payroll wizard needs the charge: every CRM day field on the sheet drives an
   * `autoCalcMoneyKey`, so whatever number sits in it gets multiplied by a day rate the moment
   * anyone touches the row. Feeding it `days` charges a Thursday as a full day — measured across
   * August 2026's seven CRM candidates, 1,758.06 EGP of over-deduction against six leavers.
   */
  chargeableDays: number;
  amount: number;
  reason: string;
  status: string;
  /**
   * Which detector produced this, carried so the module's own collision rule can be applied to
   * exactly what payroll is about to charge. `findDayCollisions` skips `manual_hr`, whose "date"
   * is a placeholder rather than a day anybody was absent — without the source system here, a
   * manual entry would read as a second claim on a real day. Production carries one such row.
   */
  sourceSystem: string;
  /**
   * When this candidate was RETIRED, or null for a live one. Always null unless the caller asked
   * for retired approvals with `countSupersededApprovedAfter`, so every money path reads null here.
   * The reconciliation report prints it: a charge explained by an approval retired after the run
   * was published is a sound charge, and the date is the whole evidence for saying so.
   */
  supersededAt?: string | null;
};

export type EmployeeDeductions = {
  buckets: DeductionBuckets;
  /**
   * How much of `buckets` came from approvals the module has since RETIRED. All zeroes unless the
   * caller passed `countSupersededApprovedAfter`, so every money path reads zeroes.
   *
   * Carried per bucket, not as one total, because the reconciliation compares bucket by bucket and
   * has to know WHICH claim is standing on retired money. A claim that is must not be scored as a
   * difference in either direction: the module no longer stands behind the figure, so it can
   * neither prove the run over-charged nor demand that it charge more. Measured on the August 2026
   * run — folding it into the total silently turned two false over-charges into five false
   * under-charges worth 3,597.53 EGP.
   */
  retiredBuckets?: DeductionBuckets;
  lines: DeductionLine[];
  /**
   * Candidates the month DETECTED for this employee that the payroll gate did
   * NOT let through — everything still Pending, Needs Follow-up, Disputed or Do
   * Not Take Action. They contribute NOTHING to `buckets`, by design: the owner's
   * 2026-08-03 rule is that only what he confirmed reaches payroll, and that is
   * not in question here.
   *
   * They are carried so a zero can explain itself. The Deductions module's own
   * Overview counts a CRM row from the moment it is detected, while payroll waits
   * for the decision — so the two screens legitimately disagree, and until
   * 2026-08-30 payroll showed a bare 0.00 with nothing saying why. The owner hit
   * exactly that: "the CRM deduction is not reading any deduction", with all 7 of
   * August's CRM candidates (14,032.26 EGP) sitting undecided.
   *
   * A step renders these as breakdown lines carrying their real status. Never sum
   * them into a figure, and never let one reach a `values` entry.
   */
  pendingLines: DeductionLine[];
};

export function emptyBuckets(): DeductionBuckets {
  return { fingerprint: 0, crm: 0, unpaidVacation: 0, loan: 0, other: 0 };
}

/** Which payroll bucket a category lands in. Mirrors DEDUCTIONS_CATEGORY_CONFIG's salaryRecordsColumn. */
function bucketFor(category: DeductionsCategory): keyof DeductionBuckets {
  switch (category) {
    case "fingerprint":
      return "fingerprint";
    // A CRM half day lands in the CRM column (owner, 2026-10-08), and so does a field day reviewed in
    // the HR operations report (owner, 2026-10-20).
    case "crm":
    case "crm_half_day":
    case "field_review":
      return "crm";
    case "unpaid_vacation":
    case "insufficient_balance_vacation":
      return "unpaidVacation";
    case "loan":
      return "loan";
    // no_records_activity is retired but historical rows remain valid payroll
    // history, and its salary column was always other_deductions.
    // no_weekly_plan is a DAILY-module connector that writes no candidate here at all, but its
    // column is other_deductions — so this is where it would land if it ever reached payroll.
    case "no_records_activity":
    case "no_weekly_plan":
    case "other":
      return "other";
  }
}

/**
 * The DAYS this candidate actually charges. NEVER a count of dates.
 *
 * THE BUG THIS CLOSES (found 2026-08-05 on production; armed, not yet fired).
 * `candidateAmount` scaled by `resolveAppliedDeductionDates().length` — a COUNT
 * OF DATES — against `rawValue`, which is measured in DAYS and is routinely
 * FRACTIONAL. For CRM the two coincide (5 days = 5 dates), which is why this
 * survived review. Fingerprint breaks it: a late arrival is 0.13 days carrying
 * ONE date, so `estimate / 0.13 * 1` rescaled every partial-day deduction to a
 * FULL day.
 *
 * Measured on live July 2026 candidates: 62 rows across 21 employees, 26,671.23
 * EGP of real deductions that would have reached the sheet as 70,545.20 EGP —
 * +43,873.97 EGP, worst single row 14.3x (0.07 days: 15.73 -> 224.71 EGP).
 * Nothing had been charged only because every fractional row was still Pending;
 * approving one was all it took. The module's own publish path never had this —
 * it uses `appliedAmount ?? estimatedAmount` and does not scale — so the two
 * screens disagreed on the same rows, which is the exact failure this bridge
 * was built to end.
 *
 * The reviewer's stored `appliedValue` is authoritative when present, and in
 * practice it always is: `resolveDecisionCharge` writes it (plus an
 * `appliedAmount`, which short-circuits before this is reached) whenever days
 * are narrowed. The pro-rata fallback covers a row carrying narrowed DATES but
 * no stored day count, where the FRACTION of days kept is the only honest
 * reading — the same apportionment `clipLeaveToMonth` already applies, and
 * deliberately not a plain re-count.
 */
export function chargedDeductionDays(candidate: DeductionsCandidateWithDecision): number {
  const stated = candidate.decision?.appliedValue;
  if (stated != null && Number.isFinite(stated)) return stated;

  const detected = candidate.dates.length;
  const kept = resolveAppliedDeductionDates(candidate).length;
  // Never narrowed (or nothing to apportion against): the candidate charges
  // exactly what the detection engine measured, fraction and all.
  if (detected === 0 || kept === detected) return candidate.rawValue;
  return Math.round(candidate.rawValue * (kept / detected) * 100) / 100;
}

/**
 * The same candidate expressed in CHARGEABLE days — what a day rate may be multiplied by.
 *
 * `chargedDeductionDays` counts flagged days; this weights them. Today the only weight is the
 * owner's 2026-08-02 rule that THURSDAY IS A HALF DAY for the field workforce ("thursday am or
 * meeting or health day only"), which the CRM connector already applies when it prices
 * `estimatedAmount` — see `buildLeaverCrmCandidate`. Payroll never did, so the module and the
 * sheet disagreed about the same span: August 2026's B-3 was 4 flagged days priced by the module
 * at 3.5 and by the wizard at 4.
 *
 * SCOPED TO CRM DELIBERATELY. The Thursday half-day is a field-workforce ACTIVITY rule — it says a
 * rep is only expected to be in the field for half of a Thursday. It says nothing about a
 * fingerprint/attendance day, an unpaid vacation day, or a loan instalment, and halving one of
 * those would invent a discount nobody granted. Widen this only on an explicit owner rule.
 *
 * A stated `appliedValue` wins UNWEIGHTED only when it is a number a reviewer actually typed —
 * second-guessing a real correction is how it gets silently halved. Telling the two apart is the
 * whole difficulty, and the Deductions module's own review screen answers it: the day box is
 * PRE-FILLED with the count of ticked dates and sent on every save, so a value EQUAL to that count
 * is the default coming back, not a correction. `deductions-workspace.tsx` draws the same
 * distinction for its own "manual quantity" flag — `appliedValue !== tickedDays(...)`, which is the
 * tick count for every multi-date row (`daysForTickedDates`) and so for every CRM row.
 *
 * Without that test the weighting was thrown away the moment anybody opened a CRM candidate and
 * saved it, changed or not: `applied_value` was stamped with the raw date count and this function
 * then honoured it as a human's figure. Measured on production, August 2026: five approved CRM
 * candidates carrying a Thursday were stamped at the flagged count — a half-day too much each on
 * the day columns. Ayman El Salhy's two days, one of them a Thursday, read 2 where the module
 * priced 1.5.
 *
 * THE MONEY SURVIVED IT, AND THAT IS LUCK RATHER THAN DESIGN. `candidateAmount` prefers the
 * decision's own `appliedAmount`, which is scaled from an `estimatedAmount` the CRM connector had
 * already weighted — so all five were charged correctly on the August payslips. The day columns
 * feed `autoCalcMoneyKey`, so the wrong count becomes the wrong money the moment anyone edits that
 * row in the wizard. It was one click away from being real.
 *
 * A reviewer who types exactly the number the box already held is recorded as accepting it. The
 * two are indistinguishable, and accepting is the more honest reading of that click.
 */
export function chargeableDeductionDays(candidate: DeductionsCandidateWithDecision): number {
  const kept = resolveAppliedDeductionDates(candidate);
  const stated = candidate.decision?.appliedValue;
  const typedByAReviewer =
    stated != null && Number.isFinite(stated) && !(kept.length > 0 && stated === kept.length);
  if (typedByAReviewer) return stated;
  if (candidate.category !== "crm") return chargedDeductionDays(candidate);

  // No dates to weigh — a candidate carrying a day count but no calendar (hand-entered, or a
  // connector that reports a total). Fall back rather than returning a confident 0.
  if (kept.length === 0) return chargedDeductionDays(candidate);
  return sumDetectedDeductionDayWeights(kept);
}

/**
 * One candidate's payable amount. Returns 0 rather than null for an
 * unresolvable row: the candidate passed the module's eligibility gate, so it
 * belongs on the sheet, and a null here would silently drop it instead.
 */
export function candidateAmount(candidate: DeductionsCandidateWithDecision): number {
  const decided = candidate.decision?.appliedAmount;
  if (decided != null && Number.isFinite(decided)) return roundCurrency(decided);

  if (candidate.unit !== "days") return roundCurrency(candidate.estimatedAmount ?? 0);

  const charged = chargedDeductionDays(candidate);
  const scaled = scaleDeductionAmountToDays({
    estimatedAmount: candidate.estimatedAmount,
    rawValue: candidate.rawValue,
    appliedDays: charged,
  });
  return roundCurrency(scaled ?? candidate.estimatedAmount ?? 0);
}

/**
 * How a caller asks for RETIRED approvals to be counted as well. Omitted — which is every money
 * path in the app — and nothing changes: a superseded candidate contributes nothing, exactly as
 * before.
 */
export type BuildDeductionBucketsOptions = {
  /**
   * Count a candidate that was approved and then RETIRED, provided it was retired strictly AFTER
   * this instant. Pass the moment the run's figures stopped being able to move — `publishedAt`,
   * else `part1ConfirmedAt`.
   *
   * WHY A CUT-OFF RATHER THAN "COUNT THEM ALL" (owner, 2026-10-09: "fix the reconcile tool to
   * count a superseded approval"). The reconciliation asks whether a run charges what was
   * approved, and it asked it against the module as it looks TODAY — so an approval retired weeks
   * after the month was published turned a correct charge into a reported over-charge. Measured on
   * the August 2026 run: two rows, 934.74 EGP, both of them sound. The naive fix is to count every
   * retired approval, and that is wrong in the other direction: 93 of the 94 retired approvals on
   * production have no replacement at all, meaning the SOURCE withdrew the row — an unpaid day
   * corrected to paid, a fingerprint day excused. Counting those would claim money is approved
   * that the module has withdrawn. The cut-off keeps the only honest reading: money that was
   * live and approved when the sheet was frozen explains what the sheet charges; money retired
   * BEFORE that does not, and still reports as a difference.
   */
  countSupersededApprovedAfter?: string | null;
};

function parseCutoff(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Whether a retired candidate still explains money on a run frozen at `cutoff`.
 *
 * The replacement walk is what stops a day being counted twice. A retirement that handed its
 * decision on to a live replacement (the carry-forward in `reconcileCandidates`) is already
 * represented by that replacement, so counting the retired row as well would double the charge.
 * The chain is followed rather than just the immediate successor, because a row can be
 * re-calculated more than once, and `visited` keeps a cycle from hanging the report.
 */
function countsAsRetiredApproval(
  candidate: DeductionsCandidateWithDecision,
  cutoff: number | null,
  byId: Map<string, DeductionsCandidateWithDecision> | null,
): boolean {
  if (cutoff === null || !byId) return false;
  if (!isConfirmedForPayroll(candidate)) return false;
  const retiredAt = parseCutoff(candidate.supersededAt);
  if (retiredAt === null || retiredAt <= cutoff) return false;

  const visited = new Set<string>([candidate.id]);
  let next = candidate.supersededByCandidateId;
  while (next && !visited.has(next)) {
    visited.add(next);
    const replacement = byId.get(next);
    if (!replacement) return true;
    if (isConfirmedForPayroll(replacement)) return false;
    next = replacement.supersededByCandidateId;
  }
  return true;
}

/**
 * Folds the month's eligible candidates into per-employee buckets. Pure and
 * exported so the mapping and the eligibility gate are unit-tested without a
 * database — this decides real money, and a rule that only exists inside a
 * Supabase round-trip cannot be pinned by a test.
 *
 * THE GATE IS THE DECISION, FOR EVERY MONTH (owner, 2026-10-07): a candidate
 * counts iff its decision is "Approved for Payroll" — see `loadConfirmedDeductions`
 * for why the push no longer decides it. Whether the line was pushed is not read
 * here at all.
 */
export function buildDeductionBuckets(
  candidates: DeductionsCandidateWithDecision[],
  options?: BuildDeductionBucketsOptions,
): Map<string, EmployeeDeductions> {
  const cutoff = parseCutoff(options?.countSupersededApprovedAfter);
  const byId = cutoff === null ? null : new Map(candidates.map((row) => [row.id, row]));
  const byCompact = new Map<string, EmployeeDeductions>();
  for (const candidate of candidates) {
    if (candidate.supersededAt && !countsAsRetiredApproval(candidate, cutoff, byId)) continue;
    const compact = candidate.employeeHrIdCompact;
    if (!compact) continue;

    const confirmed = isConfirmedForPayroll(candidate);
    const amount = candidateAmount(candidate);
    const entry = byCompact.get(compact) ?? {
      buckets: emptyBuckets(),
      retiredBuckets: emptyBuckets(),
      lines: [],
      pendingLines: [],
    };

    const line: DeductionLine = {
      category: candidate.category,
      dates: resolveAppliedDeductionDates(candidate),
      // The charged DAYS, not `dates.length` — same unit error the amount had,
      // and the step sums these into the Deduction Days column, so a 0.13-day
      // late arrival must not be reported to HR as a whole day off.
      days: candidate.unit === "days" ? chargedDeductionDays(candidate) : 0,
      chargeableDays: candidate.unit === "days" ? chargeableDeductionDays(candidate) : 0,
      amount,
      reason: candidate.reason ?? "",
      status: candidate.decision?.decisionStatus ?? "Pending",
      sourceSystem: candidate.sourceSystem ?? "",
      supersededAt: candidate.supersededAt ?? null,
    };

    if (confirmed) {
      const bucket = bucketFor(candidate.category);
      entry.buckets[bucket] = roundCurrency(entry.buckets[bucket] + amount);
      if (candidate.supersededAt && entry.retiredBuckets) {
        entry.retiredBuckets[bucket] = roundCurrency(entry.retiredBuckets[bucket] + amount);
      }
      entry.lines.push(line);
    } else {
      // NOT added to any bucket — see EmployeeDeductions.pendingLines. This is
      // recorded so a legitimate 0.00 can say why it is 0.00, never so it can
      // become a figure.
      entry.pendingLines.push(line);
    }
    byCompact.set(compact, entry);
  }
  return byCompact;
}

/**
 * Every employee's confirmed deductions for a payroll period, keyed by compact
 * HR id.
 *
 * 🔴 PAYROLL READS THE DECISION, NOT THE PUSH (owner, 2026-10-07: "make the
 * Automated Payroll able to read them and every other deduction from the
 * Deductions module"). From 2026-09 the gate had been the PUSH (owner rule
 * 2026-09-22): an approved deduction paid nothing until the Super Admin pushed
 * that line. September 2026 showed the cost — 17 approved candidates worth
 * 11,580.17 EGP across four categories never reached the sheet, and one line
 * pushed and then decided "Do Not Take Action" would still have been charged.
 * Now "Approved for Payroll" is what payroll pays, in every month; July and
 * August already ran on exactly this rule, so they do not move.
 *
 * The push is unchanged for everything else it does — it still puts the line
 * on the employee's portal and sends the notice. It just no longer decides pay.
 * A decision that changes after its step was confirmed re-opens that step
 * (`recordDecision` → `resyncPayrollDeductionSteps`), so a late approval is not
 * lost behind a frozen 0.00.
 *
 * Defensive by design: a failure here returns an EMPTY map, which recommends
 * zero deductions rather than blocking the whole wizard. That is the safe
 * direction — a zero is visible to HR on the step and can be corrected, whereas
 * an exception takes down a payroll screen HR cannot work around. It is logged
 * loudly so the cause is findable rather than silent.
 */
export async function loadConfirmedDeductions(
  period: PayrollPeriod,
  options?: BuildDeductionBucketsOptions,
): Promise<Map<string, EmployeeDeductions>> {
  const monthKey = `${period.year}-${String(period.month).padStart(2, "0")}`;
  const includeSuperseded = Boolean(options?.countSupersededApprovedAfter);
  try {
    const candidates = await listCandidatesForMonth({ monthKey, includeSuperseded });
    return buildDeductionBuckets(candidates, options);
  } catch (error) {
    logError("Automated payroll: confirmed-deductions load failed", {
      labels: {
        event: "automated_payroll_confirmed_deductions_load_failed",
        month: period.month,
        year: period.year,
      },
      error,
    });
    return new Map();
  }
}

/** This employee's buckets, or all-zero when the month produced nothing for them. */
export function bucketsFor(
  deductions: Map<string, EmployeeDeductions>,
  compact: string,
): DeductionBuckets {
  return deductions.get(compact)?.buckets ?? emptyBuckets();
}

/** This employee's eligible lines for one bucket, for the step's breakdown panel. */
export function linesFor(
  deductions: Map<string, EmployeeDeductions>,
  compact: string,
  bucket: keyof DeductionBuckets,
): DeductionLine[] {
  return (deductions.get(compact)?.lines ?? []).filter((line) => bucketFor(line.category) === bucket);
}

/**
 * This employee's DETECTED-but-undecided lines for one bucket — the ones the
 * payroll gate is holding back. Display only: they are worth 0.00 to payroll
 * until the owner decides them in the Deductions module, and that is the point.
 * A step shows them so its zero is never mistaken for "nothing was found".
 */
export function pendingLinesFor(
  deductions: Map<string, EmployeeDeductions>,
  compact: string,
  bucket: keyof DeductionBuckets,
): DeductionLine[] {
  return (deductions.get(compact)?.pendingLines ?? []).filter(
    (line) => bucketFor(line.category) === bucket,
  );
}
