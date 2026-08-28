import { ShieldCheck } from "lucide-react";
import { redirect } from "next/navigation";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { MailboxMonitorDashboard } from "@/components/admin/mailbox-monitor-dashboard";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { listImportableMailboxes, listMonitors } from "@/lib/mailbox-monitor/service";

export const dynamic = "force-dynamic";

// Mailbox Compliance Monitor — Super Admin only. The gate is the mailbox_monitor permission, whose
// hard boundary in permissions.ts grants it to no role but Super Admin; assertPermission throws for
// everyone else and we redirect. This is the security boundary, not the hidden sidebar link.
export default async function MailboxMonitorPage() {
  const access = await resolveAccessContextFromPage();

  try {
    await assertPermission(access, "mailbox_monitor", "read");
  } catch {
    redirect("/admin");
  }

  const [monitors, importable] = await Promise.all([listMonitors(), listImportableMailboxes()]);

  return (
    <div className="min-h-[calc(100vh-7rem)] rounded-[32px] border border-phx-line bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.12),transparent_30%),linear-gradient(180deg,#F8FAFC_0%,#EEF3F8_100%)] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] sm:p-6 xl:p-8">
      <div className="space-y-7">
        <AdminPageHero
          description="Read company mailboxes over a secure, read-only connection for compliance oversight. Opening a message here never marks it read for the mailbox owner. Super Admin only."
          eyebrow="Compliance"
          icon={<ShieldCheck className="h-3.5 w-3.5" />}
          title="Mailbox Compliance Monitor"
        />

        <MailboxMonitorDashboard initialImportable={importable} initialMonitors={monitors} />
      </div>
    </div>
  );
}
