import { redirect } from "next/navigation";

import { EmailNotificationCenter } from "@/components/admin/email-notification-center";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  getEmailNotificationOutboxStats,
  getEmailNotificationPolicies,
  getEmailRoutingOptions,
} from "@/lib/notifications/email";
import { listExhaustedDurableEmails } from "@/lib/notifications/durable-email";
import { logError } from "@/lib/observability/log";

export const dynamic = "force-dynamic";

export default async function AdminEmailNotificationsPage() {
  const access = await resolveAccessContextFromPage();
  if (!await canAccess(access, "admin", "read")) {
    redirect("/employee-portals");
  }

  const [policies, outboxStats, routingOptions, exhaustedApprovalEmails] = await Promise.all([
    getEmailNotificationPolicies(),
    getEmailNotificationOutboxStats(),
    getEmailRoutingOptions(),
    // A failed read says "unavailable" on the page, never an empty list that reads as "all delivered".
    listExhaustedDurableEmails().catch((error: unknown) => {
      logError("Approval emails out of retries could not be listed", {
        error,
        labels: { event: "durable_email_list_failed" },
      });
      return null;
    }),
  ]);

  return (
    <EmailNotificationCenter
      exhaustedApprovalEmails={exhaustedApprovalEmails}
      initialPolicies={policies}
      outboxStats={outboxStats}
      routingOptions={routingOptions}
    />
  );
}
