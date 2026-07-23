import { NextResponse } from "next/server";

import { getFingerprintAttendanceReport } from "@/lib/attendance/fingerprint-report";
import { resolveAccessContext } from "@/lib/auth/server";
import { actorId, assertAutomatedPayrollHrActor } from "@/lib/automated-payroll/permissions";
import { recordCopilotDeductionDecision } from "@/lib/deductions-governance/service";
import { compactHrKey } from "@/lib/payroll/copilot/feeders";
import { listFingerprintDeductionCandidates } from "@/lib/payroll/copilot/deductions-review";
import {
  buildDeductionReportWorkbook,
  formatPeriodLabel,
  periodFileSlug,
  xlsxResponse,
} from "@/lib/payroll/copilot/report-exports";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Standalone Fingerprint Deductions page - the same simplified review the
 * Payroll Copilot fingerprint tab does, but keyed by plain month/year instead
 * of a Copilot runId, so HR can review and confirm it independently of any
 * Copilot run. Reads/writes the SAME deduction_candidates/deduction_decisions
 * rows, resolved for the exact day-24->24 cycle Automated Payroll's "Fingerprint
 * deductions" step uses - confirming here is what that step then shows.
 */
const DECISION_SOURCE = { key: "fingerprint-deductions", label: "Fingerprint Deductions" } as const;

const DEDUCTION_TYPE_LABELS: Record<string, string> = {
  late_arrival: "Late arrival",
  early_leave: "Early leave",
  short_hours: "Short hours",
  missing_punch: "Missing punch",
  absence: "Absence",
  no_activity: "No activity",
};

const DASH = String.fromCharCode(8212);

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected error.";
  const forbidden = message.startsWith("Forbidden:");
  return NextResponse.json(
    { error: forbidden ? "forbidden" : "invalid_request", message },
    { status: forbidden ? 403 : 400 },
  );
}

function parsePeriod(month: unknown, year: unknown): { month: number; year: number } | null {
  const m = Number(month);
  const y = Number(year);
  if (!Number.isInteger(m) || m < 1 || m > 12 || !Number.isInteger(y) || y < 2000) return null;
  return { month: m, year: y };
}

/** One query for everything the page needs per-employee (name, base salary, hire date) - avoids three separate full-table scans. */
async function loadEmployeeLookups(): Promise<{
  names: Map<string, string>;
  baseSalaries: Map<string, number>;
  hireDates: Map<string, string>;
}> {
  const { data, error } = await getSupabaseAdmin().from("employees").select("hr_id,full_name,base_salary,hire_date");
  if (error) throw error;
  const names = new Map<string, string>();
  const baseSalaries = new Map<string, number>();
  const hireDates = new Map<string, string>();
  for (const row of (data ?? []) as Array<{
    hr_id: string;
    full_name: string | null;
    base_salary: number | null;
    hire_date: string | null;
  }>) {
    const key = compactHrKey(row.hr_id);
    if (!key) continue;
    if (row.full_name?.trim()) names.set(key, row.full_name.trim());
    const salary = Number(row.base_salary ?? 0);
    if (Number.isFinite(salary) && salary > 0) baseSalaries.set(key, salary);
    hireDates.set(key, row.hire_date ? String(row.hire_date).slice(0, 10) : "");
  }
  return { names, baseSalaries, hireDates };
}

type PunchInfo = { checkIn: string; checkOut: string; worked: string };

type CyclePunchRow = {
  employeeHrId: string;
  employeeName: string;
  date: string;
  checkIn: string;
  checkOut: string;
  worked: string;
  status: string;
};

/**
 * Every punched day in the cycle window (not just deduction days) - one call to
 * getFingerprintAttendanceReport feeds both the per-candidate check-in/check-out
 * lookup AND the full "All Punches" tab, so the page never fetches this twice.
 * Keyed by compact HR key so the lookup joins regardless of "B-185" vs "b185"
 * formatting differences between sources. Only called for the JSON path -
 * the xlsx export doesn't need punch detail, just the candidates + employee maps.
 */
async function loadCyclePunches(
  dateFromIso: string,
  dateToIso: string,
): Promise<{ lookup: Map<string, PunchInfo>; all: CyclePunchRow[]; truncated: boolean }> {
  const report = await getFingerprintAttendanceReport({ dateFrom: dateFromIso, dateTo: dateToIso });
  const lookup = new Map<string, PunchInfo>();
  const all: CyclePunchRow[] = [];
  for (const row of report.rows) {
    const info: PunchInfo = {
      checkIn: row.actualFirstPunch || DASH,
      checkOut: row.actualLastPunch || DASH,
      worked: row.timeLong || DASH,
    };
    lookup.set(`${compactHrKey(row.employeeHrId)} ${row.dateIso}`, info);
    all.push({
      employeeHrId: row.employeeHrId,
      employeeName: row.employeeName,
      date: row.dateIso,
      checkIn: info.checkIn,
      checkOut: info.checkOut,
      worked: info.worked,
      status: row.status,
    });
  }
  return { lookup, all, truncated: report.truncated };
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    assertAutomatedPayrollHrActor(access);

    const url = new URL(request.url);
    const period = parsePeriod(url.searchParams.get("month"), url.searchParams.get("year"));
    if (!period) {
      return NextResponse.json(
        { error: "invalid_request", message: "month (1-12) and year are required." },
        { status: 400 },
      );
    }

    const [{ cycle, rows, rosterCount, scopedCount }, { names, baseSalaries, hireDates }] = await Promise.all([
      listFingerprintDeductionCandidates(access, period),
      loadEmployeeLookups(),
    ]);

    if (url.searchParams.get("format") === "xlsx") {
      // xlsx only needs candidates + employee lookups - skip the full punch report
      // entirely here, it's not used by the workbook and can be slow on a busy cycle.
      const buffer = await buildDeductionReportWorkbook({
        title: `Fingerprint Deductions - ${formatPeriodLabel(period)}`,
        subtitle:
          "Attendance-device fingerprint deductions flagged for payroll. Value = base salary / 30 x deduction days (Approved once decided, otherwise an Estimate).",
        qtyHeader: "Deduction Days",
        rows,
        hireDates,
        baseSalaries,
      });
      return xlsxResponse(buffer, `Fingerprint_Deductions_${periodFileSlug(period)}.xlsx`);
    }

    const { lookup, all: allPunches, truncated } = await loadCyclePunches(cycle.startIso, cycle.endIso);

    return NextResponse.json({
      cycle,
      rosterCount,
      scopedCount,
      allPunches,
      punchesTruncated: truncated,
      candidates: rows.map((row) => {
        const key = compactHrKey(row.employeeCode);
        return {
          id: row.id,
          employeeHrId: row.employeeCode,
          employeeName: names.get(key) ?? row.employeeName,
          baseSalary: baseSalaries.get(key) ?? null,
          reason: DEDUCTION_TYPE_LABELS[row.deductionType] ?? row.deductionType,
          deductionUnit: row.deductionUnit,
          deductionValue: row.deductionValue,
          estimatedAmount: row.estimatedAmount,
          severity: row.severity,
          dates: row.dates,
          punches: row.dates.map((date) => lookup.get(`${key} ${date}`) ?? null),
          decisionStatus: row.decision?.decisionStatus ?? "Pending",
          appliedDeductionValue: row.decision?.appliedDeductionValue ?? null,
          appliedAmount: row.decision?.appliedAmount ?? null,
        };
      }),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    assertAutomatedPayrollHrActor(access);

    const body = (await request.json().catch(() => ({}))) as {
      candidateId?: string;
      decisionStatus?: string;
      appliedDeductionValue?: number;
      month?: number;
      year?: number;
    };
    const candidateId = String(body.candidateId ?? "").trim();
    if (!candidateId) {
      return NextResponse.json({ error: "invalid_request", message: "candidateId is required." }, { status: 400 });
    }
    if (body.decisionStatus !== "Approved for Payroll" && body.decisionStatus !== "Do Not Take Action") {
      return NextResponse.json(
        { error: "invalid_request", message: "decisionStatus must be 'Approved for Payroll' or 'Do Not Take Action'." },
        { status: 400 },
      );
    }
    const period = parsePeriod(body.month, body.year);
    if (!period) {
      return NextResponse.json(
        { error: "invalid_request", message: "month (1-12) and year are required." },
        { status: 400 },
      );
    }

    // Re-resolve this exact cycle's candidate list and require candidateId to be
    // IN it - this is the only page-side guarantee that the ID actually is an
    // ATTENDANCE_DEVICE candidate that overlaps the selected cycle, not (say) a
    // FIELD_WORKFORCE/CRM candidate ID someone crafted by hand. Without this,
    // recordCopilotDeductionDecision would happily decide a CRM no-activity
    // candidate and mislabel it as a "Fingerprint Deductions" decision.
    const { rows } = await listFingerprintDeductionCandidates(access, period);
    if (!rows.some((row) => row.id === candidateId)) {
      return NextResponse.json(
        { error: "invalid_request", message: "This candidate isn't a fingerprint deduction for the selected cycle." },
        { status: 400 },
      );
    }

    const decision = await recordCopilotDeductionDecision({
      candidateId,
      decisionStatus: body.decisionStatus,
      appliedDeductionValue: typeof body.appliedDeductionValue === "number" ? body.appliedDeductionValue : null,
      actorLoginId: actorId(access),
      source: DECISION_SOURCE,
    });

    return NextResponse.json({ decision });
  } catch (error) {
    return errorResponse(error);
  }
}
