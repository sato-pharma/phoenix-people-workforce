import { redirect } from "next/navigation";

import { ReportItForm } from "@/components/report-it/report-it-form";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

// Admin-shell submission page. Lets admin-mode users (Super Admin, CEO,
// HR Specialist, Finance Manager) file an ADR report without being dropped
// into the employee-portal shell. The employee portal keeps its own
// /employee-portals/report-it route for portal-mode users.
export default async function AdminReportItNewPage() {
  const access = await resolveAccessContextFromPage();

  if (!access.hrId) {
    redirect("/login");
  }

  await assertPermission(access, "report_it", "create");

  return (
    <main className="p-4 sm:p-6">
      <div className="mx-auto max-w-6xl">
        <ReportItForm />
      </div>
    </main>
  );
}
