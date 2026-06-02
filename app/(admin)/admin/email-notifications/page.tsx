import { redirect } from "next/navigation";

import { EmailNotificationCenter } from "@/components/admin/email-notification-center";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  buildEmailNotificationPreview,
  emailNotificationTypes,
  getEmailNotificationOutboxStats,
  getEmailNotificationPolicies,
  getEmailRoutingOptions,
  type EmailNotificationType,
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
  const policyByType = new Map(policies.map((policy) => [policy.type, policy]));
  const previews = Object.fromEntries(
    emailNotificationTypes.map((type) => [type, buildEmailNotificationPreview(type, policyByType.get(type))]),
  ) as Record<EmailNotificationType, ReturnType<typeof buildEmailNotificationPreview>>;

  return (
    <EmailNotificationCenter
      initialPolicies={policies}
      outboxStats={outboxStats}
      previews={previews}
      routingOptions={routingOptions}
    />
  );
}
