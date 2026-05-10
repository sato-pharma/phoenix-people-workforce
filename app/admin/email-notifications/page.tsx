import { redirect } from "next/navigation";

import { EmailNotificationCenter } from "@/components/admin/email-notification-center";
import { AppShell } from "@/components/layout/app-shell";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  buildEmailNotificationPreview,
  emailNotificationTypes,
  getEmailNotificationOutboxStats,
  getEmailNotificationPolicies,
  type EmailNotificationType,
} from "@/lib/notifications/email";

export const dynamic = "force-dynamic";

export default async function AdminEmailNotificationsPage() {
  const access = await resolveAccessContextFromPage();
  if (!await canAccess(access, "admin", "read")) {
    redirect("/employee-portals");
  }

  const [policies, outboxStats] = await Promise.all([
    getEmailNotificationPolicies(),
    getEmailNotificationOutboxStats(),
  ]);
  const previews = Object.fromEntries(
    emailNotificationTypes.map((type) => [type, buildEmailNotificationPreview(type)]),
  ) as Record<EmailNotificationType, ReturnType<typeof buildEmailNotificationPreview>>;

  return (
    <AppShell navigationMode="admin">
      <EmailNotificationCenter
        initialPolicies={policies}
        outboxStats={outboxStats}
        previews={previews}
      />
    </AppShell>
  );
}
