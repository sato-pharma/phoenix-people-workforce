import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { EmployeePortalServerShell } from "@/components/employee-portal/employee-portal-server-shell";
import { AppShell } from "@/components/layout/app-shell";
import { PageContainer } from "@/components/layout/page-container";
import { NotificationsHistory } from "@/components/notifications/notifications-history";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { listInAppNotificationsForViewer } from "@/lib/notifications/in-app";
import { mergePendingApprovalNotifications } from "@/lib/pending-approvals/notifications";
import { listPendingApprovals } from "@/lib/pending-approvals/service";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) {
    redirect("/login");
  }

  const [storedNotifications, pendingApprovalItems] = await Promise.all([
    listInAppNotificationsForViewer(access, 100),
    listPendingApprovals(access).catch(() => []),
  ]);
  const notifications = mergePendingApprovalNotifications(storedNotifications, pendingApprovalItems, 100);

  if (resolveNavigationMode(access) === "employee-portal") {
    return (
      <EmployeePortalServerShell access={access}>
        <EmployeePortalPageShell
          badge="Notifications"
          description="Review your unread and read Phoenix Workforce notifications in one place."
          title="Notification History"
        >
          <NotificationsHistory initialNotifications={notifications} />
        </EmployeePortalPageShell>
      </EmployeePortalServerShell>
    );
  }

  return (
    <AppShell navigationMode="admin">
      <PageContainer className="max-w-none">
        <div className="mb-6">
          <p className="text-xs font-black uppercase tracking-[0.18em] text-orange-600">Notifications</p>
          <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-950">Notification History</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
            Review your unread and read Phoenix Workforce notifications in one place.
          </p>
        </div>
        <NotificationsHistory initialNotifications={notifications} />
      </PageContainer>
    </AppShell>
  );
}
