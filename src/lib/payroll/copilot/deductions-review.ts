import { systemAccessContext, type AccessContext } from "@/lib/auth/permissions";
import { resolveDigestCycle, type DigestCycle } from "@/lib/attendance/digest-cycle";
import { getDigestSettings } from "@/lib/attendance/digest-recipients";
import {
  listDeductionCandidates,
  type DeductionInboxRow,
} from "@/lib/deductions-governance/service";

import { compactHrKey } from "./feeders.ts";
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

/** Attendance-device deduction candidates for the resolved fingerprint cycle. */
export async function listFingerprintDeductionCandidates(
  access: AccessContext,
  period: CopilotPeriod,
): Promise<{ cycle: DigestCycle; rows: DeductionInboxRow[] }> {
  return listCandidatesForSourceModule(access, period, "ATTENDANCE_DEVICE");
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
 * Per-employee totals of already-"Approved for Payroll" fingerprint + CRM
 * decisions for the period, keyed by compact HR id — wired into
 * `assemble.ts` so the Copilot draft reflects real decided amounts instead
 * of the previous hardcoded zero. Defensive: never throws, returns an empty
 * map on any failure so a governance-data outage can't block payroll assembly.
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
    for (const row of [...fingerprint.rows, ...crm.rows]) {
      if (row.decision?.decisionStatus !== "Approved for Payroll") continue;
      const key = compactHrKey(row.employeeHrIdCompact || row.employeeCode);
      if (!key) continue;
      const amount = row.decision.appliedAmount ?? 0;
      const existing = totals.get(key) ?? { crm: 0, fingerPrint: 0 };
      if (row.decision.payrollColumn === "crm") existing.crm += amount;
      else if (row.decision.payrollColumn === "finger_print") existing.fingerPrint += amount;
      totals.set(key, existing);
    }
  } catch (error) {
    console.error("[payroll-copilot:deductions-review] approved-totals load failed:", error);
  }
  return totals;
}
