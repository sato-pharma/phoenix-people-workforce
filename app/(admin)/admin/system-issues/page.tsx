import { AlertCircle, TriangleAlert } from "lucide-react";
import { redirect } from "next/navigation";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { SystemIssuesDashboard } from "@/components/admin/system-issues-dashboard";
import { Card } from "@/components/ui/card";
import { getErrorEvents, getUserAttemptSummary } from "@/lib/error-monitor/service";
import { getRecentGcpLogEntries } from "@/lib/observability/gcp-logs";
import { canAccessSystemAdministratorWorkspace } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function SystemIssuesPage() {
  const access = await resolveAccessContextFromPage();

  const allowed = access.role === "CEO" || canAccessSystemAdministratorWorkspace(access);
  if (!allowed) {
    redirect("/admin");
  }

  function describeError(error: unknown) {
    return error instanceof Error ? error.message : "Unknown error occurred";
  }

  const [appErrorsSettled, gcpLogsResult, attemptsSettled] = await Promise.all([
    getErrorEvents({ pageSize: 100 })
      .then((data) => ({ data, error: null as string | null }))
      .catch((error: unknown) => {
        console.error("Failed to load app_error_events:", error);
        return { data: null, error: describeError(error) };
      }),
    getRecentGcpLogEntries({ hoursBack: 24 }),
    getUserAttemptSummary({})
      .then((data) => ({ data, error: null as string | null }))
      .catch((error: unknown) => {
        console.error("Failed to load user attempt summary:", error);
        return { data: null, error: describeError(error) };
      }),
  ]);

  const appErrorsResult = appErrorsSettled.data;
  const attemptsResult = attemptsSettled.data;
  const loadError = appErrorsSettled.error ?? attemptsSettled.error;

  return (
    <div className="min-h-[calc(100vh-7rem)] rounded-[32px] border border-[#E2E8F0] bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.12),transparent_30%),linear-gradient(180deg,#F8FAFC_0%,#EEF3F8_100%)] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] sm:p-6 xl:p-8">
      <div className="space-y-7">
        <AdminPageHero
          description="Live system errors from Supabase + GCP Cloud Logging, and per-employee error/failed-login attempt counts. Super Admin + CEO only."
          eyebrow="System diagnostics"
          icon={<TriangleAlert className="h-3.5 w-3.5" />}
          title="System Issues"
        />

        {appErrorsResult && attemptsResult ? (
          <SystemIssuesDashboard
            initialAppErrors={appErrorsResult}
            initialAttempts={attemptsResult}
            initialGcpLogs={gcpLogsResult}
          />
        ) : (
          <Card className="border-rose-200 bg-[linear-gradient(135deg,#FFF1F2_0%,#FFFFFF_100%)] p-6 shadow-[0_16px_36px_rgba(244,63,94,0.10)]">
            <div className="mb-4 flex items-center gap-3 text-rose-600">
              <AlertCircle className="h-6 w-6" />
              <h2 className="text-lg font-bold">Failed to Load System Issues</h2>
            </div>
            <div className="rounded-lg border border-rose-200 bg-white/70 p-3">
              <p className="break-all font-mono text-xs text-rose-800">{loadError ?? "Unknown error"}</p>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
