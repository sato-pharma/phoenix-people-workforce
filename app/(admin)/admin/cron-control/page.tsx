import { Timer } from "lucide-react";
import { redirect } from "next/navigation";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { CronControlDashboard } from "@/components/admin/cron-control-dashboard";
import { canAccessSystemAdministratorWorkspace } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { listCronJobs, type ListCronJobsResult } from "@/lib/cron-control/service";

export const dynamic = "force-dynamic";

export default async function CronControlPage() {
  const access = await resolveAccessContextFromPage();

  const allowed = access.role === "CEO" || canAccessSystemAdministratorWorkspace(access);
  if (!allowed) {
    redirect("/admin");
  }

  const initialListing: ListCronJobsResult = await listCronJobs().catch((error: unknown) => ({
    available: false,
    error: error instanceof Error ? error.message : "Unknown error occurred",
  }));

  return (
    <div className="min-h-[calc(100vh-7rem)] rounded-[32px] border border-[#E2E8F0] bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.12),transparent_30%),linear-gradient(180deg,#F8FAFC_0%,#EEF3F8_100%)] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] sm:p-6 xl:p-8">
      <div className="space-y-7">
        <AdminPageHero
          description="View, pause/resume, manually trigger, and reschedule the GCP Cloud Scheduler jobs that drive payroll/notification SLAs, birthday & contract reminders, and iReports360 sync. Viewing is Super Admin + CEO; changes are Super Admin only."
          eyebrow="System automation"
          icon={<Timer className="h-3.5 w-3.5" />}
          title="Cron Control"
        />

        <CronControlDashboard canMutate={canAccessSystemAdministratorWorkspace(access)} initialListing={initialListing} />
      </div>
    </div>
  );
}
