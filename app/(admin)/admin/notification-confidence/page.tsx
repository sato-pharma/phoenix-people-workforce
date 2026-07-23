import { redirect } from "next/navigation";

import { PremiumHero } from "@/components/ui/premium-hero";
import { NotificationConfidenceWorkspace } from "@/components/admin/notification-confidence-workspace";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { listPendingNotificationReviews, listRecentNotificationSends } from "@/lib/notifications/confidence-gate";

export const dynamic = "force-dynamic";

export default async function AdminNotificationConfidencePage() {
  const access = await resolveAccessContextFromPage();
  if (access.role !== "Super Admin") {
    redirect("/employee-portals");
  }

  let initialRecent: Awaited<ReturnType<typeof listRecentNotificationSends>> = [];
  let initialPending: Awaited<ReturnType<typeof listPendingNotificationReviews>> = [];
  let initialError: string | null = null;
  try {
    [initialRecent, initialPending] = await Promise.all([
      listRecentNotificationSends(access, { limit: 150 }),
      listPendingNotificationReviews(access),
    ]);
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Unable to load the Notification Confidence Center.";
  }

  return (
    <div className="space-y-6">
      <PremiumHero
        kicker="System Safety"
        title="Notification Confidence Center"
        subtitle="Every automated email Phoenix sends passes a validation gate before dispatch. See what fired, what was held, why, and decide anything still pending review."
      />
      <NotificationConfidenceWorkspace initialError={initialError} initialPending={initialPending} initialRecent={initialRecent} />
    </div>
  );
}
