import { getCompanyWideOutageDates } from "@/lib/attendance/ingestion-health";
import { getMonthlyAttendanceSummary } from "@/lib/attendance/monthly-summary";
import { cairoTodayIso } from "@/lib/attendance/working-days";
import { addDaysToDateOnly } from "@/lib/date-only";
import { isEligibleForPublish, resolveAppliedDeductionDates } from "@/lib/deductions/calculations";
import { findDayCollisions } from "@/lib/deductions/conflict";
import {
  getCompanyMonthSummaryByCategory,
  getEmployeeMonthSummary,
  listCandidatesForMonth,
} from "@/lib/deductions/service";
import { deductionsCategories, type DeductionsCandidateWithDecision } from "@/lib/deductions/types";
import {
  diffSets,
  formatCount,
  formatList,
  formatMoney,
  moneyMatches,
  MONEY_TOLERANCE_EGP,
} from "@/lib/reconciliation/compare";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";
import { findDuplicateEmployeeDays } from "@/lib/reconciliation/duplicate-days";
import { retryOnceIfBreached } from "@/lib/reconciliation/retry";
import type { ReconciliationCheck, ReconciliationOutcome } from "@/lib/reconciliation/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * The month under review — the newest month that actually has live candidates, not "this month".
 *
 * Anchoring on the calendar month would make the check silently vacuous for the first days of
 * every month (no candidates collected yet ⇒ nothing compares ⇒ green), which is precisely the
 * "looks fine because nobody looked" shape this harness exists to kill.
 */
async function latestDeductionsMonthKey(): Promise<string | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("deductions_candidates")
    .select("month_key")
    .is("superseded_at", null)
    .order("month_key", { ascending: false })
    .limit(1);
  if (error) throw new Error(`Deductions month lookup failed: ${error.message}`);
  const row = (data ?? [])[0] as { month_key?: string } | undefined;
  return row?.month_key ?? null;
}

/**
 * How many per-employee summaries to ask for at once.
 *
 * Asking one at a time is what makes these two the slowest checks in the harness: every
 * getEmployeeMonthSummary re-reads the whole employee directory and the month's holiday overrides,
 * so a month with a few hundred charged employees becomes a few hundred serial round-trips to a
 * database on another continent. Past the per-check ceiling the result is "errored", which ALERTS —
 * the harness would then page the owner about itself rather than about a wrong number. Four keeps
 * the wall time bounded while leaving the shared statement pool room for the other checks running
 * beside it.
 */
const PER_EMPLOYEE_CONCURRENCY = 4;

function distinctEmployees(candidates: readonly DeductionsCandidateWithDecision[]) {
  const seen = new Map<string, { employeeHrId: string; employeeName: string | null }>();
  for (const candidate of candidates) {
    if (seen.has(candidate.employeeHrIdCompact)) continue;
    seen.set(candidate.employeeHrIdCompact, {
      employeeHrId: candidate.employeeHrId,
      employeeName: candidate.employeeName,
    });
  }
  return seen;
}

/** Names, never codes — HR acts on a person, and a bare code makes them go and look it up. */
function personLabel(person: { employeeHrId: string; employeeName: string | null }): string {
  return person.employeeName?.trim() || person.employeeHrId;
}

const emptyOutcome = (source: string, monthKey: string | null): ReconciliationOutcome => ({
  left: { source, value: "no month with live candidates" },
  right: { source: "deductions_candidates", value: "no month with live candidates" },
  holds: true,
  detail: monthKey
    ? `No live candidates for ${monthKey}; nothing to reconcile.`
    : "No deductions month holds live candidates yet; nothing to reconcile.",
});

/**
 * Check 5 — the By Employee tab's Total against what publishing would actually take.
 *
 * getEmployeeMonthSummary filters only "Do Not Take Action", so Pending candidates that publish
 * will never take are folded into the per-employee Total, while getCompanyMonthSummaryByCategory
 * splits willPublish from pending using publishMonth's own predicate. One screen, two tabs, two
 * different answers about the same person's money — and HR acts on the bigger one.
 *
 * The eligibility predicate is never restated here: isEligibleForPublish is imported, so this
 * check and publishing can only ever agree.
 */
const byEmployeeTotalMatchesWillPublish: ReconciliationCheck = {
  id: "deductions-by-employee-total-matches-company-will-publish",
  title: "The By Employee tab's Total must equal what publishing would actually take for that employee",
  domain: "deductions-attendance",
  severity: "critical",
  // Closed by #1682: getEmployeeMonthSummary now splits willPublish from pending with
  // publishMonth's own predicate, the way Overview always did. Before that the per-employee Totals
  // summed to 70,227.63 EGP for 2026-07 against a Will-publish figure of 37,846.73 — 32,380.90 EGP
  // of Pending that publishing would never take, shown to HR as money owed. Asserted rather than
  // documented now, so the two tabs can never drift apart again.
  expectation: "holds",
  async run(): Promise<ReconciliationOutcome> {
    const monthKey = await latestDeductionsMonthKey();
    if (!monthKey) return emptyOutcome("getEmployeeMonthSummary", null);

    const candidates = await listCandidatesForMonth({ monthKey });
    if (candidates.length === 0) return emptyOutcome("getEmployeeMonthSummary", monthKey);

    const employees = distinctEmployees(candidates);
    const eligibleByEmployee = new Map<string, number>();
    for (const candidate of candidates) {
      if (candidate.decision?.decisionStatus === "Do Not Take Action") continue;
      if (!isEligibleForPublish(candidate)) continue;
      const amount = candidate.decision?.appliedAmount ?? candidate.estimatedAmount ?? 0;
      eligibleByEmployee.set(
        candidate.employeeHrIdCompact,
        (eligibleByEmployee.get(candidate.employeeHrIdCompact) ?? 0) + amount,
      );
    }

    const company = await getCompanyMonthSummaryByCategory({ monthKey });
    const problems: string[] = [];
    let byEmployeeTotal = 0;

    const roster = [...employees.entries()];
    const summaries = await mapWithConcurrency(roster, PER_EMPLOYEE_CONCURRENCY, ([, person]) =>
      getEmployeeMonthSummary({ monthKey, employeeHrId: person.employeeHrId }),
    );

    for (const [index, [compact, person]] of roster.entries()) {
      const shown = summaries[index]?.willPublishTotal ?? 0;
      const publishable = Math.round((eligibleByEmployee.get(compact) ?? 0) * 100) / 100;
      byEmployeeTotal += shown;
      if (!moneyMatches(shown, publishable)) {
        problems.push(
          `${personLabel(person)}: By Employee Total ${formatMoney(shown)} vs ${formatMoney(publishable)} publishable`,
        );
      }
    }

    byEmployeeTotal = Math.round(byEmployeeTotal * 100) / 100;

    return {
      left: {
        source: `getEmployeeMonthSummary({ monthKey: "${monthKey}" }).willPublishTotal summed over ${formatCount(employees.size, "employee")}`,
        value: formatMoney(byEmployeeTotal),
      },
      right: {
        source: `getCompanyMonthSummaryByCategory({ monthKey: "${monthKey}" }).willPublishTotal`,
        value: formatMoney(company.willPublishTotal),
      },
      holds: problems.length === 0 && moneyMatches(byEmployeeTotal, company.willPublishTotal),
      detail:
        problems.length === 0
          ? `Every employee's ${monthKey} Total equals what publishing would take.`
          : `${monthKey}: ${formatList(problems)}`,
    };
  },
};

/**
 * Check 6 — per-employee category buckets against the company-by-category buckets.
 *
 * Both tabs aggregate listCandidatesForMonth, but the per-employee path adds an
 * employee_hr_id_compact filter produced by compactDeductionsHrId. If that key normalisation ever
 * drifts — a candidate stored with an HR_ID shape the compact filter no longer matches — the
 * employee's own tab silently shows less than the company total, and nothing today would notice.
 * The employee SETS are compared too, so a candidate can never be visible company-wide and
 * invisible on its own employee's screen.
 */
const perEmployeeBucketsReconcileToCompany: ReconciliationCheck = {
  id: "deductions-per-employee-category-buckets-reconcile-to-company",
  title: "Per-employee category buckets must add up to the company-by-category buckets for the same month",
  domain: "deductions-attendance",
  severity: "high",
  expectation: "holds",
  run: retryOnceIfBreached(async (): Promise<ReconciliationOutcome> => {
    const monthKey = await latestDeductionsMonthKey();
    if (!monthKey) return emptyOutcome("getEmployeeMonthSummary() category buckets", null);

    const candidates = await listCandidatesForMonth({ monthKey });
    if (candidates.length === 0) return emptyOutcome("getEmployeeMonthSummary() category buckets", monthKey);

    const employees = distinctEmployees(candidates);
    const perEmployeeAmount = new Map<string, number>();
    const perEmployeeCount = new Map<string, number>();
    const perEmployeeSeen = new Map<string, Set<string>>();
    let perEmployeeTotal = 0;

    const roster = [...employees.entries()];
    const summaries = await mapWithConcurrency(roster, PER_EMPLOYEE_CONCURRENCY, ([, person]) =>
      getEmployeeMonthSummary({ monthKey, employeeHrId: person.employeeHrId }),
    );

    for (const [index, [compact]] of roster.entries()) {
      const summary = summaries[index];
      perEmployeeTotal += (summary?.willPublishTotal ?? 0) + (summary?.pendingTotal ?? 0);
      for (const category of deductionsCategories) {
        // Both halves, because the company side below also adds willPublish + pending: this check
        // asks whether the per-employee buckets ADD UP to the company buckets, not whether a
        // candidate is publishable. Reading only one half would report a false shortfall for every
        // category holding undecided rows.
        const willPublish = summary?.willPublish[category];
        const pending = summary?.pending[category];
        if (!willPublish && !pending) continue;
        const amount = (willPublish?.amount ?? 0) + (pending?.amount ?? 0);
        const candidateCount = (willPublish?.candidateCount ?? 0) + (pending?.candidateCount ?? 0);
        perEmployeeAmount.set(category, (perEmployeeAmount.get(category) ?? 0) + amount);
        perEmployeeCount.set(category, (perEmployeeCount.get(category) ?? 0) + candidateCount);
        const seen = perEmployeeSeen.get(category) ?? new Set<string>();
        seen.add(compact);
        perEmployeeSeen.set(category, seen);
      }
    }

    const company = await getCompanyMonthSummaryByCategory({ monthKey });
    const companyTotal = Math.round((company.willPublishTotal + company.pendingTotal) * 100) / 100;
    const problems: string[] = [];

    for (const category of deductionsCategories) {
      const companyAmount =
        Math.round((company.willPublish[category].totalAmount + company.pending[category].totalAmount) * 100) / 100;
      const companyCount = company.willPublish[category].candidateCount + company.pending[category].candidateCount;
      const employeeAmount = Math.round((perEmployeeAmount.get(category) ?? 0) * 100) / 100;
      const employeeCount = perEmployeeCount.get(category) ?? 0;
      // The per-employee path rounds once per employee and the company path once per category, so
      // cent-level divergence is arithmetic, not a defect. The tolerance scales with the number of
      // employees that could each have contributed a rounding step.
      const tolerance = MONEY_TOLERANCE_EGP * Math.max(1, perEmployeeSeen.get(category)?.size ?? 1);
      if (!moneyMatches(employeeAmount, companyAmount, tolerance)) {
        problems.push(
          `${category}: employee tabs total ${formatMoney(employeeAmount)} vs company total ${formatMoney(companyAmount)}`,
        );
      }
      if (employeeCount !== companyCount) {
        problems.push(
          `${category}: employee tabs show ${formatCount(employeeCount, "candidate")} vs company ${formatCount(companyCount, "candidate")}`,
        );
      }
    }

    // A candidate the company can see but its own employee cannot is the silent-underreporting
    // shape the payroll defect had; comparing the identity sets is what catches it.
    const companyEmployees = new Set(
      candidates
        .filter((candidate) => candidate.decision?.decisionStatus !== "Do Not Take Action")
        .map((candidate) => candidate.employeeHrIdCompact),
    );
    const employeeSets = diffSets([...perEmployeeSeen.values()].flatMap((set) => [...set]), companyEmployees);
    const label = (compact: string) => personLabel(employees.get(compact) ?? { employeeHrId: compact, employeeName: null });
    if (employeeSets.onlyInRight.length > 0) {
      const missing = employeeSets.onlyInRight.map(label).sort();
      problems.push(`${formatCount(missing.length, "employee")} visible company-wide but not on their own tab: ${formatList(missing)}`);
    }
    if (employeeSets.onlyInLeft.length > 0) {
      const extra = employeeSets.onlyInLeft.map(label).sort();
      problems.push(`${formatCount(extra.length, "employee")} charged on their own tab but absent from the company Overview: ${formatList(extra)}`);
    }

    return {
      left: {
        source: `getEmployeeMonthSummary({ monthKey: "${monthKey}" }) willPublish + pending summed over ${formatCount(employees.size, "employee")}`,
        value: formatMoney(Math.round(perEmployeeTotal * 100) / 100),
      },
      right: {
        source: `getCompanyMonthSummaryByCategory({ monthKey: "${monthKey}" }) willPublish + pending`,
        value: formatMoney(companyTotal),
      },
      holds: problems.length === 0,
      detail:
        problems.length === 0
          ? `Every category reconciles between the employee tabs and the company Overview for ${monthKey}.`
          : `${monthKey}: ${formatList(problems)}`,
    };
  }),
};

/**
 * Check 7 — the publish gate's collision answer against the true duplicate-day set.
 *
 * Both sides read the same snapshot in one invocation and both resolve their days through
 * resolveAppliedDeductionDates, so a reviewer who narrows a candidate's days off an overlap
 * correctly clears the collision on BOTH sides rather than only one.
 */
const noEmployeeDayChargedTwice: ReconciliationCheck = {
  id: "no-employee-day-charged-twice-across-eligible-candidates",
  title: "No employee-day may be charged by more than one publish-eligible candidate, in any category or none",
  domain: "deductions-attendance",
  severity: "critical",
  expectation: "holds",
  async run(): Promise<ReconciliationOutcome> {
    const monthKey = await latestDeductionsMonthKey();
    if (!monthKey) return emptyOutcome("findDayCollisions (the publish gate)", null);

    const candidates = await listCandidatesForMonth({ monthKey });
    const eligible = candidates.filter(isEligibleForPublish);
    if (eligible.length === 0) {
      return {
        left: { source: "findDayCollisions (the publish gate)", value: "0 collisions" },
        right: { source: "duplicate (employee, day) pairs across the same eligible set", value: "0 duplicates" },
        holds: true,
        detail: `${monthKey} has no publish-eligible candidates; nothing could be charged twice.`,
      };
    }

    // Fed exactly the way publishMonth feeds it — same set, same date resolution.
    const gateCollisions = findDayCollisions(
      eligible.map((candidate) => ({ ...candidate, dates: resolveAppliedDeductionDates(candidate) })),
    );
    const duplicates = findDuplicateEmployeeDays(
      eligible.map((candidate) => ({
        employeeHrIdCompact: candidate.employeeHrIdCompact,
        employeeHrId: candidate.employeeHrId,
        employeeName: candidate.employeeName,
        category: candidate.category,
        sourceSystem: candidate.sourceSystem,
        dates: resolveAppliedDeductionDates(candidate),
      })),
    );

    const gateKeys = gateCollisions.map((collision) => `${collision.employeeHrId}:${collision.date}`);
    const trueKeys = duplicates.map((duplicate) => `${duplicate.employeeHrId}:${duplicate.date}`);
    const difference = diffSets(gateKeys, trueKeys);
    const missed = duplicates
      .filter((duplicate) => difference.onlyInRight.includes(`${duplicate.employeeHrId}:${duplicate.date}`))
      .map(
        (duplicate) =>
          `${duplicate.employeeName?.trim() || duplicate.employeeHrId} ${duplicate.date} claimed by ${duplicate.claims.join(" + ")}`,
      );

    return {
      left: {
        source: `findDayCollisions over the ${formatCount(eligible.length, "eligible candidate")} publish would take for ${monthKey}`,
        value: formatCount(gateCollisions.length, "collision"),
      },
      right: {
        source: "duplicate (employee, day) pairs across that same eligible set, grouped without category",
        value: formatCount(duplicates.length, "duplicated employee-day"),
      },
      holds: difference.identical,
      detail:
        difference.identical
          ? duplicates.length === 0
            ? `No employee-day is claimed twice in ${monthKey}'s publish-eligible set.`
            : `The publish gate reports every one of ${monthKey}'s ${formatCount(duplicates.length, "duplicated employee-day")}.`
          : `${monthKey}: days the publish gate would let through and charge twice — ${formatList(missed)}`,
    };
  },
};

/**
 * Check 8 — the monthly attendance summary against the canonical device-outage detector.
 *
 * monthly-summary.ts computes absentDays = expectedWorkingDays − presentDays with no outage
 * concept at all, while the sibling per-day screen (employee-day-report.ts) consults
 * getCompanyWideOutageDates and labels the very same day "Device outage". So the day report says
 * "device outage" and the monthly summary says "absent", for the same person on the same date —
 * and the monthly summary is what feeds the fingerprint deduction conversation.
 */
const absenceNeverCountedOnAnOutageDay: ReconciliationCheck = {
  id: "attendance-absence-never-counted-on-a-company-wide-outage-day",
  title: "The monthly attendance summary must report zero absence on days the device recorded nothing for anybody",
  domain: "deductions-attendance",
  severity: "critical",
  expectation: "holds",
  // Was known-open until 2026-10-23. The summary excludes an outage day (monthly-summary.ts, noDataDays /
  // missingDataDates); what was wrong was this check, which compared ALL absence in the month with the number
  // of outage days and so called any month holding an outage a breach.
  async run(): Promise<ReconciliationOutcome> {
    const month = cairoTodayIso().slice(0, 7);
    const summary = await getMonthlyAttendanceSummary({ month });

    // Today is excluded on purpose: a check running at 06:00 Cairo sees a legitimately punch-free
    // morning and would call it an outage. getAttendanceIngestionHealth draws the same line at
    // yesterday, and the two must not disagree about what "an outage" is.
    const yesterday = addDaysToDateOnly(cairoTodayIso(), -1) ?? summary.dateFrom;
    const outageTo = summary.dateTo < yesterday ? summary.dateTo : yesterday;
    const outageDates =
      outageTo < summary.dateFrom ? new Set<string>() : await getCompanyWideOutageDates(summary.dateFrom, outageTo);

    const rosterSize = summary.rows.length;
    // The rule is about the outage days themselves: each one must come back from the summary as "no data"
    // (neither expected nor absent), whatever ordinary absence the month holds on other days.
    const reported = new Set(summary.missingDataDates);
    const dates = [...outageDates].sort();
    const stillCounted = dates.filter((date) => !reported.has(date));
    const holds = rosterSize === 0 || stillCounted.length === 0;

    return {
      left: {
        source: `getMonthlyAttendanceSummary({ month: "${month}" }).missingDataDates over ${summary.dateFrom}..${summary.dateTo}`,
        value: `${formatCount(summary.missingDataDates.length, "day")} reported as no data (${formatCount(summary.totals.absentDays, "absent employee-day")} counted on other days, across ${formatCount(rosterSize, "rostered employee")})`,
      },
      right: {
        source: `getCompanyWideOutageDates(${summary.dateFrom}, ${outageTo}) — the canonical detector, through yesterday only`,
        value: formatCount(outageDates.size, "company-wide outage day"),
      },
      holds,
      detail: holds
        ? outageDates.size === 0
          ? `No company-wide outage day in ${summary.dateFrom}..${outageTo}; the summary's absence figure stands.`
          : `Every one of the ${formatCount(outageDates.size, "outage day")} (${formatList(dates)}) is reported as no data, so none became a false absentee.`
        : `The device recorded nothing for anybody on ${formatList(stillCounted)}, yet the summary did not report ${stillCounted.length === 1 ? "it" : "them"} as no data — all ${formatCount(rosterSize, "rostered employee")} would be counted absent. Holiday calendar reachable: ${summary.holidayCalendarReachable && summary.holidaySourceConnected ? "yes" : "NO — a real public holiday could be being read as a working day"}.`,
    };
  },
};

export const deductionsAttendanceReconciliationChecks: ReconciliationCheck[] = [
  byEmployeeTotalMatchesWillPublish,
  perEmployeeBucketsReconcileToCompany,
  noEmployeeDayChargedTwice,
  absenceNeverCountedOnAnOutageDay,
];
