// Daily Deductions module: the No-records connector (I/O half). The selection rules live in
// no-records-select.ts; this file only loads what they need.
//
// It reuses the Private Calendar "No Activity Recorded" engine (the same one the retired
// month-module No Records category used), which covers attendance, vacation, excuse, double
// visit, solo field visit, approved plan and holiday, for every active employee.

import { systemAccessContext } from "@/lib/auth/permissions.ts";
import { getCompanyWideOutageDates } from "@/lib/attendance/ingestion-health";
import { canonicalHrIdKey } from "@/lib/hr-id.ts";
import { getCompanyNoActivityDays } from "@/lib/private-calendar/service.ts";
import { getBaseSalaryMap } from "@/lib/payroll/copilot/feeders.ts";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { assertBaseSalaryMapLoaded } from "@/lib/deductions/connectors/health.ts";
import type { DeductionsCandidateDraft } from "@/lib/deductions/types.ts";
import { selectNoRecordsDrafts } from "./no-records-select.ts";

function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

async function loadJobTitlesByCanonicalKey(): Promise<Map<string, string | null>> {
  const { data, error } = await getSupabaseAdmin().from("employees").select("hr_id,job_title");
  // Fail closed: without titles the Medical Rep / District Manager / SFE exclusions cannot be
  // applied, and the rest of the company would be charged on top of the connectors that own them.
  if (error) throw new Error(`Failed to load employee job titles: ${error.message}`);
  const titles = new Map<string, string | null>();
  for (const row of (data ?? []) as Array<{ hr_id: string; job_title: string | null }>) {
    const key = canonicalHrIdKey(row.hr_id);
    if (key) titles.set(key, row.job_title);
  }
  return titles;
}

export async function collectNoRecordsDailyCandidates(input: {
  month: number;
  year: number;
}): Promise<DeductionsCandidateDraft[]> {
  const monthKey = `${input.year}-${String(input.month).padStart(2, "0")}`;
  const start = `${monthKey}-01`;
  const end = `${monthKey}-${String(lastDayOfMonth(input.year, input.month)).padStart(2, "0")}`;

  const [days, jobTitleByCanonicalKey, outageDates, baseSalaryByCompact] = await Promise.all([
    getCompanyNoActivityDays({ access: systemAccessContext, start, end }),
    loadJobTitlesByCanonicalKey(),
    getCompanyWideOutageDates(start, end),
    getBaseSalaryMap(),
  ]);
  // Fail closed — without salaries every candidate's amount is unknown.
  assertBaseSalaryMapLoaded("No records connector", baseSalaryByCompact);

  return selectNoRecordsDrafts({
    days,
    jobTitleByCanonicalKey,
    outageDates,
    baseSalaryByCompact,
    month: input.month,
    year: input.year,
  });
}
