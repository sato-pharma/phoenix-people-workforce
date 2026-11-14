import { BellRing } from "lucide-react";
import { redirect } from "next/navigation";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { NotificationTypesRegistry, type NotificationTypeRow, type UntypedSendRow } from "@/components/admin/notification-types-registry";
import { canAccessSystemAdministratorWorkspace } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { listNotificationTypes, NOTIFICATION_CHANNEL_LABELS, UNTYPED_SENDS } from "@/lib/notifications/notification-types";

// Notification Types — the one registry of every notice the code sends (REC-084), read-only.
//
// Beside Notification Recipients and the Email Control Center. The list is the registry in
// src/lib/notifications/notification-types.ts, each type joined with its resolved notification
// policy, so what this page says about channels and recipients is what the engine does.
// tests/notification-type-registry.test.ts keeps the registry equal to the code's sends.
//
// Super Admin only, with the same check as /admin/notification-recipients.

export const dynamic = "force-dynamic";

export default async function NotificationTypesPage() {
  const access = await resolveAccessContextFromPage();

  if (!canAccessSystemAdministratorWorkspace(access)) {
    redirect("/admin");
  }

  const rows: NotificationTypeRow[] = listNotificationTypes().map((type) => ({
    channels: type.channelLabels,
    delivery: type.delivery ?? "engine",
    eventType: type.eventType,
    fallbacks: type.fallbackChannelLabels,
    key: `${type.module}.${type.eventType}`,
    label: type.label,
    module: type.module,
    moduleLabel: type.moduleLabel,
    priority: type.priorityLabel,
    recipients: type.recipientLabels,
    telegramAllowed: type.policy.telegramAllowed,
  }));
  const untyped: UntypedSendRow[] = UNTYPED_SENDS.map((send) => ({
    channel: NOTIFICATION_CHANNEL_LABELS[send.channel],
    file: send.file,
    label: send.label,
  }));

  return (
    <div className="min-h-[calc(100vh-7rem)] border border-phx-line bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.12),transparent_30%),linear-gradient(180deg,#F8FAFC_0%,#EEF3F8_100%)] p-5 sm:p-6 xl:p-8">
      <div className="space-y-7">
        <AdminPageHero
          description="Every notification the system sends, with the channels, recipients, priority and Telegram rule the notification policy gives it. Read-only — recipients by role are changed in Notification Recipients. Super Admin only."
          eyebrow="System automation"
          icon={<BellRing className="h-3.5 w-3.5" />}
          title="Notification Types"
        />

        <NotificationTypesRegistry rows={rows} untyped={untyped} />
      </div>
    </div>
  );
}
