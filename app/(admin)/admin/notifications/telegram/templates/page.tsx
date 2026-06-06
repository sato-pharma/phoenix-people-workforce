import Link from "next/link";
import { redirect } from "next/navigation";
import { MessageSquareText } from "lucide-react";

import { AdminInsightChip, AdminPageHero } from "@/components/admin/admin-design-system";
import { TelegramTemplateManager } from "@/components/admin/telegram-template-manager";
import { Card } from "@/components/ui/card";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { listTelegramTemplates } from "@/lib/notifications/telegram-templates";

export const dynamic = "force-dynamic";

export default async function AdminTelegramTemplatesPage() {
  const access = await resolveAccessContextFromPage();
  if (!await canAccess(access, "communication", "read")) {
    redirect("/admin");
  }

  const templates = await listTelegramTemplates();
  const canUpdate = await canAccess(access, "communication", "update");
  const activeCount = templates.filter((template) => template.isActive).length;

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-6 text-slate-950 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1500px] space-y-6">
        <AdminPageHero
          badges={(
            <>
              <AdminInsightChip tone="slate">{templates.length} workflows</AdminInsightChip>
              <AdminInsightChip tone={activeCount > 0 ? "emerald" : "orange"}>{activeCount} active</AdminInsightChip>
              <AdminInsightChip tone="orange">Plain text only</AdminInsightChip>
            </>
          )}
          description="Edit Telegram notification text with safe placeholders. Telegram remains notification-only and globally governed."
          eyebrow="Admin / Notifications / Telegram"
          icon={<MessageSquareText className="h-4 w-4" />}
          title="Telegram Message Templates"
        />

        <div className="flex flex-wrap gap-2">
          <Link className="rounded border border-slate-200 bg-white px-3 py-2 text-sm font-bold text-slate-700" href="/admin/notifications/telegram">
            Back to Telegram Control Center
          </Link>
        </div>

        {!canUpdate ? (
          <Card className="rounded border border-amber-200 bg-amber-50 p-4 text-sm font-semibold text-amber-800">
            You can review Telegram templates, but this account cannot edit or test templates.
          </Card>
        ) : null}

        <TelegramTemplateManager canUpdate={canUpdate} initialTemplates={templates} />
      </div>
    </main>
  );
}
