import { notFound } from "next/navigation";
import { connection } from "next/server";

import { MedicalRepOverviewPage } from "@/components/employee-portal/employee-portal-dashboard-dynamic";
import { IdentityCard } from "@/components/employee-portal/identity-card";
import {
  EmployeePortalChrome,
} from "@/components/employee-portal/employee-portal-layout";
import {
  EmployeePortalActionBar,
  EmployeePortalActionLink,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { resolveEmployeePortalNavVisibility } from "@/lib/employee-portal/navigation";
import { employeePortalDevPreviewData } from "@/lib/employee-portal/dev-preview-data";

export const metadata = {
  title: "Employee Portal Dev Preview",
};

export default async function EmployeePortalDevPreviewPage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }

  await connection();

  const data = employeePortalDevPreviewData;
  const visibility = resolveEmployeePortalNavVisibility(
    data.employee.roleLabel,
    undefined,
    data.employee.line,
    data.employee.department,
  );

  return (
    <EmployeePortalChrome
      activePathOverride="/employee-portals"
      data={data}
      disableSessionGuard
      visibility={visibility}
    >
      <IdentityCard data={data} />
      <EmployeePortalPageShell
        badge="Dev Preview"
        description="Preview fixture for polishing the employee portal without a live authenticated session."
        title="Dashboard Overview"
      >
        <EmployeePortalActionBar
          actions={
            <>
              <span className="inline-flex items-center justify-center rounded-full border border-sky-200 bg-sky-50 px-3 py-1.5 text-xs font-bold text-sky-700 shadow-[0_8px_20px_rgba(14,165,233,0.07)]">
                Local fixture data
              </span>
              <EmployeePortalActionLink href="/employee-portals" label="Open Protected Portal" />
            </>
          }
        />
        <MedicalRepOverviewPage data={data} />
      </EmployeePortalPageShell>
    </EmployeePortalChrome>
  );
}
