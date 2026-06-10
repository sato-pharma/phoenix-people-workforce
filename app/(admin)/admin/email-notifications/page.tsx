import { redirect } from "next/navigation";

import { EmailNotificationCenter } from "@/components/admin/email-notification-center";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  getEmailNotificationOutboxStats,
  getEmailNotificationPolicies,
  getEmailRoutingOptions,
} from "@/lib/notifications/email";

export const dynamic = "force-dynamic";

export default async function AdminEmailNotificationsPage() {
  const access = await resolveAccessContextFromPage();
  if (!await canAccess(access, "admin", "read")) {
    redirect("/employee-portals");
  }

  const [policies, outboxStats, routingOptions] = await Promise.all([
    getEmailNotificationPolicies(),
    getEmailNotificationOutboxStats(),
    getEmailRoutingOptions(),
  ]);

  return (
    <EmailNotificationCenter
      initialPolicies={policies}
      outboxStats={outboxStats}
      routingOptions={routingOptions}
    />
  );
}
