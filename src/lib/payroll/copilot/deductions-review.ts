import { systemAccessContext, type AccessContext } from "@/lib/auth/permissions";
import { resolveDigestCycle, type DigestCycle } from "@/lib/attendance/digest-cycle";
import { getDigestSettings } from "@/lib/attendance/digest-recipients";
import { resolveActiveAttendancePolicy } from "@/lib/attendance/metrics";
import { loadAttendanceFlexPolicyGroups } from "@/lib/attendance/policy-groups";
import { getAttendanceRoster } from "@/lib/attendance/roster";
import { resolveDayBasedDeductionAmount } from "@/lib/deductions-governance/calculations";
import { syncFieldWorkforceNoActivityCandidatesForLiveMonth } from "@/lib/deductions-governance/connectors/field-workforce-compliance";
import {
  listDeductionCandidates,
  type DeductionInboxRow,
} from "@/lib/deductions-governance/service";

import { compactHrKey, getBaseSalaryMap } from "./feeders.ts";
import type { CopilotPeriod } from "./types.ts";

/**
 * Bridges the Payroll Copilot to the existing Deductions Governance data
 * (`deduction_candidates`/`deduction_decisions`) for the two simplified
 * review tabs (fingerprint/attendance, CRM no-activity) — reads and writes
 * the SAME rows the full HR governance workspace uses, so there is one
 * shared source of truth regardless of which UI made the decision.
 *
 * The tricky part: `deduction_candidates.month_key` is stamped by the
 * CALENDAR month of the underlying work date, but the payroll/fingerprint
 * cycle runs day-24 -> day-24 (see attendance/digest-cycle.ts) — a payroll
 * month's cycle spans two calendar months. So candidates are fetched for
 * BOTH month_keys the cycle touches, then filtered down to rows whose own
 * `dates` actually fall inside the resolved [startIso, endIso] window.
 */

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** The day-24->24 cycle for a Copilot payroll period (probe day 1, always before any real anchor). */
export async function resolveCopilotCycleWindow(period: CopilotPeriod): Promise<DigestCycle> {
  const probeDate = `${period.year}-${pad2(period.month)}-01`;
  try {
    const settings = await getDigestSettings();
    return resolveDigestCycle(probeDate, settings.cycleAnchorDay);
  } catch (error) {
    console.error("[payroll-copilot:deductions-review] digest settings load failed, using default anchor 24:", error);
    return resolveDigestCycle(probeDate, 24);
  }
}

/** The one or two calendar month_keys a cycle window touches (exported for tests). */
export function monthKeysForWindow(cycle: DigestCycle): string[] {
  const startKey = cycle.startIso.slice(0, 7);
  const endKey = cycle.endIso.slice(0, 7);
  return startKey === endKey ? [startKey] : [startKey, endKey];
}

/** True when any of a candidate's dates falls inside the cycle window (exported for tests). */
export function candidateOverlapsWindow(dates: string[], cycle: DigestCycle): boolean {
  return dates.some((date) => date >= cycle.startIso && date <= cycle.endIso);
}

async function fetchAllCandidatesForMonthKey(
  access: AccessContext,
  monthKey: string,
  sourceModule: "ATTENDANCE_DEVICE" | "FIELD_WORKFORCE",
): Promise<DeductionInboxRow[]> {
  const rows: DeductionInboxRow[] = [];
  let page = 1;
  // Defensive cap: a single payroll cycle realistically has well under this
  // many candidates for one source module; prevents an infinite loop if the
  // total count is ever miscomputed.
  const MAX_PAGES = 50;
  for (; page <= MAX_PAGES; page += 1) {
    const result = await listDeductionCandidates({
      access,
      filters: { monthKey, sourceModule },
      page,
      pageSize: 100,
    });
    rows.push(...result.rows);
    if (rows.length >= result.total || result.rows.length === 0) break;
  }
  return rows;
}

async function listCandidatesForSourceModule(
  access: AccessContext,
  period: CopilotPeriod,
  sourceModule: "ATTENDANCE_DEVICE" | "FIELD_WORKFORCE",
): Promise<{ cycle: DigestCycle; rows: DeductionInboxRow[] }> {
  const cycle = await resolveCopilotCycleWindow(period);
  const monthKeys = monthKeysForWindow(cycle);
  const perKey = await Promise.all(
    monthKeys.map((monthKey) => fetchAllCandidatesForMonthKey(access, monthKey, sourceModule)),
  );
  const rows = perKey.flat().filter((row) => candidateOverlapsWindow(row.dates, cycle));
  return { cycle, rows };
}

/**
 * How many of the attendance roster (device-mapped, head-office employees) are
 * actually "in scope" for the flexible-hours engine during this cycle — i.e.
 * their resolved active policy has `required_minutes` set. Mirrors the exact
 * scoping check `computeSettlementWeekDigests` uses (digest-service.ts:
 * `if (!policy || policy.required_minutes == null) continue;`). Most policies
 * today only carry the late-arrival side (flex_minutes) with no
 * required_minutes, so this is usually a small subset of the roster — a
 * second, independent reason (besides dry-run) this tab can show zero or very
 * few candidates. Defensive: any failure here must never break the tab.
 */
async function countFlexibleHoursScope(cycle: DigestCycle): Promise<{ rosterCount: number; scopedCount: number }> {
  const [roster, policies] = await Promise.all([
    getAttendanceRoster({ dateFromIso: cycle.startIso, dateToIso: cycle.endIso }),
    loadAttendanceFlexPolicyGroups({ activeOnly: true }),
  ]);
  let scopedCount = 0;
  for (const employee of roster) {
    const policy = resolveActiveAttendancePolicy(
      { hr_id: employee.hrId, job_title: employee.jobTitle },
      policies,
      cycle.startIso,
      cycle.endIso,
    );
    if (policy && policy.required_minutes != null) scopedCount += 1;
  }
  return { rosterCount: roster.length, scopedCount };
}

/**
 * Attendance-device deduction candidates for the resolved fingerprint cycle.
 * Also reports whether the attendance weekly-digest engine is currently in
 * dry-run mode (`attendance_digest_settings.dry_run`) — in dry-run, the
 * settlement flow that would push real rows into `deduction_candidates`
 * intentionally no-ops, so this tab is expected to show zero candidates.
 * `dryRun` lets the UI say that honestly instead of showing a bare "0".
 * `rosterCount`/`scopedCount` additionally surface the (separate, more common)
 * reason this tab under-counts even with dry-run off: most employees on the
 * roster don't have a required_minutes policy configured yet.
 */
export async function listFingerprintDeductionCandidates(
  access: AccessContext,
  period: CopilotPeriod,
): Promise<{
  cycle: DigestCycle;
  rows: DeductionInboxRow[];
  dryRun: boolean;
  rosterCount: number | null;
  scopedCount: number | null;
}> {
  const [{ cycle, rows }, settings] = await Promise.all([
    listCandidatesForSourceModule(access, period, "ATTENDANCE_DEVICE"),
    getDigestSettings().catch(() => null),
  ]);
  const scope = await countFlexibleHoursScope(cycle).catch((error) => {
    console.error("[payroll-copilot:deductions-review] flexible-hours scope count failed:", error);
    return null;
  });
  return {
    cycle,
    rows,
    dryRun: settings?.dryRun ?? false,
    rosterCount: scope?.rosterCount ?? null,
    scopedCount: scope?.scopedCount ?? null,
  };
}

/**
 * Syncs the CURRENT/live month's pending Field Workforce Compliance
 * no-activity candidates into `deduction_candidates` before reading them.
 * Without this, only already-`Approved for Payroll` decisions ever reach
 * this table (via the daily auto-sync) — the live month's still-pending
 * candidates would never appear here, undercounting the tab. Insert-only/
 * idempotent (skips rows that already exist), so safe to call on every load.
 * Defensive: never throws — a sync failure just means this load reflects
 * whatever was already synced, not a payroll-blocking error.
 */
export async function syncCrmLiveMonthCandidates(period: CopilotPeriod, createdBy: string): Promise<void> {
  try {
    await syncFieldWorkforceNoActivityCandidatesForLiveMonth({
      createdBy,
      month: period.month,
      year: period.year,
    });
  } catch (error) {
    console.error("[payroll-copilot:deductions-review] CRM live-month sync failed:", error);
  }
}

/**
 * CRM "no activity" deduction candidates for the resolved cycle. Excludes
 * `retroactive_leave` rows — those are a leave-adjustment concern, not payroll.
 * No hire/resignation-date boundary logic needed here: the FWC engine that
 * produces these candidates already excludes pre-hire/post-resignation days
 * before a row ever reaches `deduction_candidates`.
 */
export async function listCrmDeductionCandidates(
  access: AccessContext,
  period: CopilotPeriod,
): Promise<{ cycle: DigestCycle; rows: DeductionInboxRow[] }> {
  const { cycle, rows } = await listCandidatesForSourceModule(access, period, "FIELD_WORKFORCE");
  return { cycle, rows: rows.filter((row) => row.deductionType === "no_activity") };
}

export type ApprovedDeductionTotals = { crm: number; fingerPrint: number };

/**
 * Per-employee totals of fingerprint + CRM deductions for the period, keyed
 * by compact HR id — wired into `assemble.ts` so the Copilot draft reflects
 * real amounts instead of the previous hardcoded zero. Defensive: never
 * throws, returns an empty map on any failure so a governance-data outage
 * can't block payroll assembly.
 *
 * CRM no-activity (N) is MANDATORY per the owner's dictated payroll rule:
 * "whoever has N days must be deducted" — no approval gate. Every no-activity
 * candidate counts toward the sheet UNLESS HR has explicitly cleared it via
 * "Do Not Take Action" (e.g. investigated and found to be a device/data
 * issue). A row that hasn't been decided yet uses the same base-salary/30 x
 * days ESTIMATE the CRM review tab and its xlsx export show (see
 * report-exports.ts) — once HR approves it with a possibly-edited value, the
 * decided `appliedAmount` takes over. This keeps the sheet, the review tab,
 * and the downloaded report always in agreement.
 *
 * Fingerprint deductions are NOT covered by that unconditional rule — they
 * stay approval-gated (must be explicitly "Approved for Payroll" on the
 * Fingerprint tab before they reach the sheet).
 *
 * Called from deep inside `assembleDraft`, which has no request-scoped
 * `AccessContext` available — uses `systemAccessContext` the same way other
 * internal cross-module reads do, since `listDeductionCandidates` does not
 * itself enforce the access argument (the real permission gate already ran
 * at the route layer before `assembleDraft` was ever called).
 */
export async function buildApprovedDeductionTotals(
  period: CopilotPeriod,
): Promise<Map<string, ApprovedDeductionTotals>> {
  const totals = new Map<string, ApprovedDeductionTotals>();
  try {
    const [fingerprint, crm] = await Promise.all([
      listCandidatesForSourceModule(systemAccessContext, period, "ATTENDANCE_DEVICE"),
      listCandidatesForSourceModule(systemAccessContext, period, "FIELD_WORKFORCE"),
    ]);

    for (const row of fingerprint.rows) {
      if (row.decision?.decisionStatus !== "Approved for Payroll") continue;
      const key = compactHrKey(row.employeeHrIdCompact || row.employeeCode);
      if (!key) continue;
      const existing = totals.get(key) ?? { crm: 0, fingerPrint: 0 };
      existing.fingerPrint += row.decision.appliedAmount ?? 0;
      totals.set(key, existing);
    }

    // Only deduct what the CRM review tab actually shows. listCrmDeductionCandidates
    // filters FIELD_WORKFORCE to `no_activity`; a non-no_activity field-workforce row
    // (e.g. a retroactive_leave row) would otherwise be summed into the `crm` pay
    // column here yet never appear in the review tab — money deducted that was never
    // reviewable. Filtering to the same set keeps "what's deducted" == "what's shown".
    const crmReviewableRows = crm.rows.filter((row) => row.deductionType === "no_activity");
    const needsEstimate = crmReviewableRows.some(
      (row) => row.decision?.decisionStatus !== "Approved for Payroll",
    );
    const baseSalaries = needsEstimate ? await getBaseSalaryMap() : new Map<string, number>();
    for (const row of crmReviewableRows) {
      if (row.decision?.decisionStatus === "Do Not Take Action") continue;
      const key = compactHrKey(row.employeeHrIdCompact || row.employeeCode);
      if (!key) continue;
      const amount = resolveDayBasedDeductionAmount({
        decision: row.decision,
        deductionValue: row.deductionValue,
        baseSalary: baseSalaries.get(key),
      }) ?? 0;
      const existing = totals.get(key) ?? { crm: 0, fingerPrint: 0 };
      existing.crm += amount;
      totals.set(key, existing);
    }
  } catch (error) {
    console.error("[payroll-copilot:deductions-review] approved-totals load failed:", error);
  }
  return totals;
}
