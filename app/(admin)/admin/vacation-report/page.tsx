import { redirect } from "next/navigation";
import { FileSpreadsheet } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { CompanyVacationReportTable } from "@/components/vacation/company-vacation-report-table";
import { canAccessSystemAdministratorWorkspace } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getCompanyVacationReport } from "@/lib/vacation/company-vacation-report";

export const dynamic = "force-dynamic";

const REPORT_START_DATE = "2026-01-01";

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export default async function AdminVacationReportPage() {
  const access = await resolveAccessContextFromPage();
  if (!canAccessSystemAdministratorWorkspace(access)) redirect("/admin");

  const endDate = todayIso();
  const rows = await getCompanyVacationReport({ endDate, startDate: REPORT_START_DATE });

  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="HR Reporting"
        title="Company Vacation Report"
        description="Every HR-approved leave request alongside unverified CRM/attendance leave signals — org-wide, one Source column per row."
        icon={<FileSpreadsheet className="h-3.5 w-3.5" />}
      />
      <CompanyVacationReportTable
        endDate={endDate}
        rows={rows}
        startDate={REPORT_START_DATE}
      />
    </div>
  );
}
