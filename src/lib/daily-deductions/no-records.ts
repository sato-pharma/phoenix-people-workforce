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
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { assertBaseSalaryMapLoaded } from "@/lib/deductions/connectors/health.ts";
import { loadProvenWorkedDays } from "@/lib/deductions/proven-worked-days.ts";
import type { DeductionsCandidateDraft } from "@/lib/deductions/types.ts";
import { selectNoRecordsDrafts } from "./no-records-select.ts";

function lastDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

async function loadJobTitlesByCanonicalKey(): Promise<Map<string, string | null>> {
  // The WHOLE roster, page by page: a person cut off by a response ceiling would have no title, and
  // so would not be excluded from this connector's charge.
  let data: Array<{ hr_id: string; job_title: string | null }>;
  try {
    data = await fetchAllRows<{ hr_id: string; job_title: string | null }>(
      () => getSupabaseAdmin().from("employees").select("hr_id,job_title"),
      "hr_id",
    );
  } catch (error) {
    // Fail closed: without titles the Medical Rep / District Manager / SFE exclusions cannot be
    // applied, and the rest of the company would be charged on top of the connectors that own them.
    throw new Error(`Failed to load employee job titles: ${(error as { message?: string } | null)?.message ?? String(error)}`);
  }
  const titles = new Map<string, string | null>();
  for (const row of data) {
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

  const [days, jobTitleByCanonicalKey, outageDates, baseSalaryByCompact, provenWorked] = await Promise.all([
    getCompanyNoActivityDays({ access: systemAccessContext, start, end }),
    loadJobTitlesByCanonicalKey(),
    getCompanyWideOutageDates(start, end),
    getBaseSalaryMap(),
    // EVERY SOURCE THAT PROVES A DAY WAS WORKED. The engine above reads field visits through the
    // CRM door, which serves an unstarted team's Phoenix rows to nobody, and reads the outstation
    // trip tables not at all — so a rep who logged real visits, and a manager who spent the day
    // travelling, both reach this connector as a day with no activity. Throws on a failed read:
    // swallowing it would charge a day someone provably worked.
    loadProvenWorkedDays({ end, start }),
  ]);
  // Fail closed — without salaries every candidate's amount is unknown.
  assertBaseSalaryMapLoaded("No records connector", baseSalaryByCompact);

  return selectNoRecordsDrafts({
    days,
    jobTitleByCanonicalKey,
    outageDates,
    baseSalaryByCompact,
    provenWorkedDayKeys: provenWorked.keys,
    month: input.month,
    year: input.year,
  });
}
