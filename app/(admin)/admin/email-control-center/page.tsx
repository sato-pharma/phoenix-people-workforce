import { MailCheck } from "lucide-react";
import { redirect } from "next/navigation";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { EmailControlCenterDashboard } from "@/components/admin/email-control-center-dashboard";
import { canAccessSystemAdministratorWorkspace } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getEmailControlCenterSnapshot } from "@/lib/notifications/email-control-center";

export const dynamic = "force-dynamic";

export default async function EmailControlCenterPage() {
  const access = await resolveAccessContextFromPage();

  const isSuperAdmin = canAccessSystemAdministratorWorkspace(access);
  const allowed = access.role === "CEO" || isSuperAdmin;
  if (!allowed) {
    redirect("/admin");
  }

  const snapshot = await getEmailControlCenterSnapshot();

  return (
    <div className="min-h-[calc(100vh-7rem)] rounded-[32px] border border-phx-line bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.12),transparent_30%),linear-gradient(180deg,#F8FAFC_0%,#EEF3F8_100%)] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] sm:p-6 xl:p-8">
      <div className="space-y-7">
        <AdminPageHero
          description="Every automated email Phoenix sends, in one place: turn any one off entirely, or fine-tune exactly which roles receive it. Viewing is Super Admin + CEO; changes are Super Admin only."
          eyebrow="System automation"
          icon={<MailCheck className="h-3.5 w-3.5" />}
          title="Email Control Center"
        />

        <EmailControlCenterDashboard canMutate={isSuperAdmin} initialSnapshot={snapshot} />
      </div>
    </div>
  );
}
