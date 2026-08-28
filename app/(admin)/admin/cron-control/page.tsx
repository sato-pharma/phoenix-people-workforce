import { Timer } from "lucide-react";
import { redirect } from "next/navigation";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { CronControlDashboard } from "@/components/admin/cron-control-dashboard";
import { NotificationRoleRecipientsCenter } from "@/components/admin/notification-role-recipients-center";
import { canAccessSystemAdministratorWorkspace } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { listCronJobs, type ListCronJobsResult } from "@/lib/cron-control/service";
import { getNotificationRolePolicies } from "@/lib/notifications/role-recipients";

export const dynamic = "force-dynamic";

export default async function CronControlPage() {
  const access = await resolveAccessContextFromPage();

  const isSuperAdmin = canAccessSystemAdministratorWorkspace(access);
  const allowed = access.role === "CEO" || isSuperAdmin;
  if (!allowed) {
    redirect("/admin");
  }

  const [initialListing, notificationPolicies] = await Promise.all([
    listCronJobs().catch((error: unknown) => ({
      available: false as const,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    })),
    // Super-Admin-only section below — skip the fetch entirely for CEO, matching the section's
    // own visibility (which roles get notified is internal plumbing, not a CEO oversight signal).
    isSuperAdmin ? getNotificationRolePolicies() : Promise.resolve(null),
  ]);

  return (
    <div className="min-h-[calc(100vh-7rem)] rounded-[32px] border border-phx-line bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.12),transparent_30%),linear-gradient(180deg,#F8FAFC_0%,#EEF3F8_100%)] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] sm:p-6 xl:p-8">
      <div className="space-y-7">
        <AdminPageHero
          description="View, pause/resume, manually trigger, and reschedule the GCP Cloud Scheduler jobs that drive payroll/notification SLAs, birthday & contract reminders, and iReports360 sync. Viewing is Super Admin + CEO; changes are Super Admin only."
          eyebrow="System automation"
          icon={<Timer className="h-3.5 w-3.5" />}
          title="Cron Control"
        />

        <CronControlDashboard canMutate={isSuperAdmin} initialListing={initialListing as ListCronJobsResult} />

        {isSuperAdmin && notificationPolicies ? (
          <NotificationRoleRecipientsCenter initialPolicies={notificationPolicies} />
        ) : null}
      </div>
    </div>
  );
}
