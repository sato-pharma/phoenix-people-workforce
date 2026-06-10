import { getSupabaseAdmin } from "@/lib/supabase/server";
import { getFingerprintAttendanceReport } from "@/lib/attendance/fingerprint-report";

export type GenerateCandidatesResult = {
  employees: number;
  generated: number;
  monthKey: string;
  skipped: number;
  updated: number;
};

function parseMonthKey(monthKey: string): { dateFrom: string; dateTo: string } {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!match) throw new Error(`Invalid month key "${monthKey}". Expected format: YYYY-MM.`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const lastDay = new Date(year, month, 0).getDate();
  return {
    dateFrom: `${match[1]}-${match[2]}-01`,
    dateTo: `${match[1]}-${match[2]}-${String(lastDay).padStart(2, "0")}`,
  };
}

type EmployeeSalaryRow = { base_salary: number | null; hr_id: string };

export async function generateAttendanceDeductionCandidates(
  monthKey: string,
): Promise<GenerateCandidatesResult> {
  const { dateFrom, dateTo } = parseMonthKey(monthKey);

  const report = await getFingerprintAttendanceReport({ dateFrom, dateTo });

  // Group rows by employee.
  const byEmployee = new Map<string, typeof report.rows>();
  for (const row of report.rows) {
    const list = byEmployee.get(row.employeeHrId) ?? [];
    list.push(row);
    byEmployee.set(row.employeeHrId, list);
  }

  if (byEmployee.size === 0) {
    return { employees: 0, generated: 0, monthKey, skipped: 0, updated: 0 };
  }

  // Fetch base salaries for affected employees.
  const hrIds = Array.from(byEmployee.keys());
  const supabase = getSupabaseAdmin();
  const { data: salaryData } = await supabase
    .from("employees")
    .select("hr_id,base_salary")
    .in("hr_id", hrIds);

  const salaryMap = new Map<string, number | null>();
  for (const row of (salaryData ?? []) as EmployeeSalaryRow[]) {
    salaryMap.set(row.hr_id, row.base_salary ?? null);
  }

  let generated = 0;
  let updated = 0;
  let skipped = 0;

  for (const [hrId, rows] of byEmployee) {
    // Only rows with a deduction and no approved exception.
    const deductionRows = rows.filter((r) => parseFloat(r.deductionDays) > 0 && !r.hasException);
    if (deductionRows.length === 0) {
      skipped++;
      continue;
    }

    const totalDeductionDays = deductionRows.reduce((sum, r) => sum + parseFloat(r.deductionDays), 0);
    const dates = deductionRows.map((r) => r.date);

    // Count breakdown for evidence.
    const lateDays = deductionRows.filter((r) => r.status === "Late" || r.status === "Early leave").length;
    const absentDays = deductionRows.filter((r) => r.status === "Absence" || r.status === "Single punch").length;
    const shortDays = deductionRows.filter((r) => r.status === "Short day").length;

    const baseSalary = salaryMap.get(hrId) ?? null;
    const estimatedAmount = baseSalary != null
      ? Math.round((baseSalary / 30) * totalDeductionDays * 100) / 100
      : null;

    const candidateKey = `ATTENDANCE_DEVICE:${hrId}:${monthKey}`;

    const payload = {
      calculation_status: estimatedAmount != null ? "calculated" : "requires_payroll_formula",
      candidate_key: candidateKey,
      created_by: "system",
      dates: dates as unknown as string,
      deduction_type: "absence",
      deduction_unit: "days",
      deduction_value: totalDeductionDays,
      employee_hr_id_compact: hrId,
      employee_name: rows[0]?.employeeName ?? null,
      estimated_amount: estimatedAmount,
      evidence: JSON.stringify({ absentDays, lateDays, shortDays }),
      month: parseInt(monthKey.split("-")[1], 10),
      month_key: monthKey,
      reason: `${deductionRows.length} day(s) with attendance violations in ${monthKey}`,
      severity: totalDeductionDays >= 2 ? "high" : "medium",
      source_module: "ATTENDANCE_DEVICE",
      source_record_id: candidateKey,
      year: parseInt(monthKey.split("-")[0], 10),
    };

    // Check if this candidate already exists.
    const { data: existing } = await supabase
      .from("deduction_candidates")
      .select("id")
      .eq("candidate_key", candidateKey)
      .is("superseded_at", null)
      .maybeSingle();

    if (existing) {
      await supabase
        .from("deduction_candidates")
        .update({
          dates: JSON.stringify(dates),
          deduction_value: totalDeductionDays,
          estimated_amount: estimatedAmount,
          evidence: JSON.stringify({ absentDays, lateDays, shortDays }),
          reason: payload.reason,
        })
        .eq("id", existing.id);
      updated++;
    } else {
      await supabase.from("deduction_candidates").insert({
        ...payload,
        dates: JSON.stringify(dates),
        evidence: JSON.stringify({ absentDays, lateDays, shortDays }),
        employee_code: hrId,
      });
      generated++;
    }
  }

  return {
    employees: byEmployee.size,
    generated,
    monthKey,
    skipped,
    updated,
  };
}
