import { redirect } from "next/navigation";
import { Mail } from "lucide-react";

import { AdminInsightChip, AdminPageHero } from "@/components/admin/admin-design-system";
import { EmailAdminControlCenterView } from "@/components/admin/email-admin-control-center";
import { EmailSuppressionPanel } from "@/components/admin/email-suppression-panel";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getEmailAdminControlCenter } from "@/lib/notifications/email-admin";

export const dynamic = "force-dynamic";

export default async function AdminEmailNotificationsPage() {
  const access = await resolveAccessContextFromPage();
  if (!await canAccess(access, "communication", "read")) {
    redirect("/admin");
  }

  const data = await getEmailAdminControlCenter();

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-6 text-slate-950 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1500px] space-y-6">
        <AdminPageHero
          badges={(
            <>
              <AdminInsightChip tone="emerald">{data.summary.sentCount} sent</AdminInsightChip>
              <AdminInsightChip tone="orange">
                {data.summary.pendingCount + data.summary.retryingCount + data.summary.failedCount + data.summary.skippedCount} not sent
              </AdminInsightChip>
              <AdminInsightChip tone="slate">{data.deliveries.length} recent deliveries</AdminInsightChip>
            </>
          )}
          description="See which notification emails actually went out and which didn't, with the reason why."
          eyebrow="Admin / Notifications"
          icon={<Mail className="h-4 w-4" />}
          title="Email Delivery Status"
        />

        {access.role === "Super Admin" ? <EmailSuppressionPanel /> : null}

        <EmailAdminControlCenterView initialData={data} />
      </div>
    </main>
  );
}
