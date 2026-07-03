import { HeartPulse } from "lucide-react";
import { redirect } from "next/navigation";

import { AdminInsightChip, AdminPageHero } from "@/components/admin/admin-design-system";
import { SyntheticJourneysDashboard } from "@/components/admin/synthetic-journeys-dashboard";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getLatestRun, listRuns } from "@/lib/synthetic-journeys/service";

export const dynamic = "force-dynamic";

export default async function SyntheticJourneysPage() {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "synthetic_journeys", "read"))) {
    redirect("/admin");
  }

  // Falls back to the empty state if the synthetic_journey_runs/results tables
  // don't exist yet (migration not applied) — this page must never crash just
  // because no one has ingested a report or applied the migration yet.
  let latestRun: Awaited<ReturnType<typeof getLatestRun>> = null;
  let runs: Awaited<ReturnType<typeof listRuns>> = [];
  try {
    [latestRun, runs] = await Promise.all([getLatestRun(), listRuns(20)]);
  } catch (error) {
    console.error("[synthetic-journeys] failed to load run data (migration may not be applied yet):", error);
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <AdminPageHero
        badges={
          <div className="flex flex-wrap gap-2">
            <AdminInsightChip>Synthetic Journeys</AdminInsightChip>
            <AdminInsightChip tone="orange">Super Admin only</AdminInsightChip>
          </div>
        }
        description="Read-only results from the Synthetic User Journeys Playwright smoke suite. This page never runs tests or mutates data — it only displays the latest saved report."
        eyebrow="Quality and Reliability"
        icon={<HeartPulse className="h-3.5 w-3.5" />}
        title="Synthetic Journeys"
      />
      <SyntheticJourneysDashboard latestRun={latestRun} runs={runs} />
    </div>
  );
}
