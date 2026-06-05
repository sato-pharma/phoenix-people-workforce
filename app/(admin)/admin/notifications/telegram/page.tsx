import { redirect } from "next/navigation";
import Link from "next/link";
import { Send } from "lucide-react";

import { AdminInsightChip, AdminPageHero } from "@/components/admin/admin-design-system";
import { TelegramAdminControlCenter } from "@/components/admin/telegram-admin-control-center";
import { Card } from "@/components/ui/card";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getTelegramAdminControlCenter } from "@/lib/notifications/telegram-admin";

export const dynamic = "force-dynamic";

export default async function AdminTelegramNotificationsPage() {
  const access = await resolveAccessContextFromPage();
  if (!await canAccess(access, "communication", "read")) {
    redirect("/admin");
  }

  const data = await getTelegramAdminControlCenter();
  const canUpdate = await canAccess(access, "communication", "update");

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-6 text-slate-950 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1500px] space-y-6">
        <AdminPageHero
          badges={(
            <>
              <AdminInsightChip tone={data.globalEnabled ? "emerald" : "orange"}>{data.globalEnabled ? "Telegram enabled" : "Telegram disabled"}</AdminInsightChip>
              <AdminInsightChip tone="slate">{data.summary.connectedCount} connected</AdminInsightChip>
              <AdminInsightChip tone="slate">{data.summary.pendingCount} pending</AdminInsightChip>
              <AdminInsightChip tone="slate">{data.deliveries.length} recent deliveries</AdminInsightChip>
            </>
          )}
          description="Govern Telegram as a Phoenix notification channel. Telegram remains notification-only and never performs approvals."
          eyebrow="Admin / Notifications"
          icon={<Send className="h-4 w-4" />}
          title="Telegram Control Center"
        />

        {!canUpdate ? (
          <Card className="rounded border border-amber-200 bg-amber-50 p-4 text-sm font-semibold text-amber-800">
            You can review Telegram status, but this account cannot change Telegram settings.
          </Card>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Link className="rounded border border-slate-200 bg-white px-3 py-2 text-sm font-bold text-slate-700" href="/admin/notifications/telegram/templates">
            Edit Telegram Templates
          </Link>
        </div>

        <TelegramAdminControlCenter canUpdate={canUpdate} initialData={data} />
      </div>
    </main>
  );
}
