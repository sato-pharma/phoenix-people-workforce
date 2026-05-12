import { notFound } from "next/navigation";
import { connection } from "next/server";

import {
  IdentityCard,
  MedicalRepOverviewPage,
} from "@/components/employee-portal/employee-portal-dashboard";
import {
  EmployeePortalTopNav,
  EmployeePortalSidebar,
} from "@/components/employee-portal/employee-portal-layout";
import {
  EmployeePortalActionBar,
  EmployeePortalActionLink,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { PageTransition } from "@/components/ui/page-transition";
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
  const visibility = resolveEmployeePortalNavVisibility(data.employee.roleLabel);

  return (
    <div className="relative min-h-screen overflow-hidden bg-[linear-gradient(180deg,#f8fafc_0%,#eef4f8_46%,#f8fafc_100%)]">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-sky-500 via-orange-500 to-emerald-500" />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(15,23,42,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(15,23,42,0.035)_1px,transparent_1px)] bg-[size:48px_48px] [mask-image:linear-gradient(180deg,rgba(0,0,0,0.78),transparent_64%)]" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-[linear-gradient(180deg,rgba(255,255,255,0.92),rgba(255,255,255,0)_70%)]" />
      <EmployeePortalTopNav
        activePathOverride="/employee-portals"
        data={data}
        disableSessionGuard
        visibility={visibility}
      />
      <div className="relative mx-auto flex w-full max-w-[1560px] gap-6 px-4 py-6 lg:gap-8 lg:px-8 lg:py-8">
        <EmployeePortalSidebar activePathOverride="/employee-portals" visibility={visibility} />
        <main className="min-w-0 flex-1 space-y-6 lg:space-y-8">
          <IdentityCard data={data} />
          <PageTransition>
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
          </PageTransition>
        </main>
      </div>
    </div>
  );
}
