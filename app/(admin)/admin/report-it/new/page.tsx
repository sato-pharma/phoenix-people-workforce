import { redirect } from "next/navigation";
import { ShieldAlert } from "lucide-react";

import { AdminInsightChip, AdminPageHero } from "@/components/admin/admin-design-system";
import { ReportItForm } from "@/components/report-it/report-it-form";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";

export const dynamic = "force-dynamic";

// Admin-shell submission page. Lets admin-mode users (Super Admin, CEO,
// Finance Manager) file an ADR report without being dropped
// into the employee-portal shell. The employee portal keeps its own
// /employee-portals/report-it route for portal-mode users.
export default async function AdminReportItNewPage() {
  const access = await resolveAuthenticatedPageAccess();

  if (!access.hrId) {
    redirect("/login");
  }

  await assertPermission(access, "report_it", "create");

  return (
    <div className="space-y-5">
      <AdminPageHero
        badges={(
          <>
            <AdminInsightChip>Admin shell</AdminInsightChip>
            <AdminInsightChip tone="slate">Confidential report intake</AdminInsightChip>
          </>
        )}
        description="Submit an adverse drug reaction report from the admin workspace without switching into the employee portal experience."
        eyebrow="Pharmacovigilance"
        icon={<ShieldAlert className="h-3.5 w-3.5" />}
        title="Report It"
      />

      <div className="mx-auto max-w-6xl">
        <ReportItForm variant="admin" />
      </div>
    </div>
  );
}
