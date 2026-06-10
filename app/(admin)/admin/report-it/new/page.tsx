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
    <div className="p-4 sm:p-6 max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-bold">Report It</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Report an adverse drug reaction (ADR) in a safe, confidential way. All fields
          with <span className="text-red-500">*</span> are required.
        </p>
      </div>
      <ReportItForm />
    </div>
  );
}
