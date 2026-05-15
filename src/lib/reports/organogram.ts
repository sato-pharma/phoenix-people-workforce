import type { AccessContext } from "@/lib/auth/permissions";
import { scopeOrganogramReportForAccess } from "@/lib/reports/organogram-safety";
import { getVacancyReport } from "@/lib/reports/vacancies";

export async function getOrganogramReport(access: AccessContext) {
  return scopeOrganogramReportForAccess(await getVacancyReport(), access);
}
