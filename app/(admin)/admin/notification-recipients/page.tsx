import { BellRing } from "lucide-react";
import { redirect } from "next/navigation";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { NotificationRoleRecipientsCenter } from "@/components/admin/notification-role-recipients-center";
import { canAccessSystemAdministratorWorkspace } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getNotificationRolePolicies } from "@/lib/notifications/role-recipients";

// Notification Recipients — which roles get told about each system notification.
//
// This editor is not new. It has existed since the Email Control Center shipped, but it had no
// page of its own: it rendered as an unlabelled section at the BOTTOM of /admin/cron-control, a
// page named after the GCP Cloud Scheduler dashboard that died with GCP billing on 2026-08-01.
// Two things pointed at a URL that never existed. AGENTS.md 2.3 tells an operator to "retarget or
// silence it at /admin/notification-recipients" when the outbox drain strands and pages a human —
// and /admin/notification-recipients 404'd. The Email Control Center's own role_recipients rows
// deep-linked to /admin/cron-control instead, so the one documented recovery path for a stranded
// notification queue led to a dead scheduler's error box.
//
// This page is that URL. Super Admin only, end-to-end, matching the access-registry entries for
// /api/admin/notification-recipients — which were already Super-Admin-only for both view and edit,
// unlike cron-control's CEO+Super-Admin view.

export const dynamic = "force-dynamic";

export default async function NotificationRecipientsPage() {
  const access = await resolveAccessContextFromPage();

  if (!canAccessSystemAdministratorWorkspace(access)) {
    redirect("/admin");
  }

  const policies = await getNotificationRolePolicies();

  return (
    <div className="min-h-[calc(100vh-7rem)] rounded-[32px] border border-phx-line bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.12),transparent_30%),linear-gradient(180deg,#F8FAFC_0%,#EEF3F8_100%)] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] sm:p-6 xl:p-8">
      <div className="space-y-7">
        <AdminPageHero
          description="Choose which roles are notified for each system notification — the weekly health digest, the stranded-drain alert, and the rest. Silencing or retargeting an alert happens here. Super Admin only."
          eyebrow="System automation"
          icon={<BellRing className="h-3.5 w-3.5" />}
          title="Notification Recipients"
        />

        <NotificationRoleRecipientsCenter initialPolicies={policies} />
      </div>
    </div>
  );
}
