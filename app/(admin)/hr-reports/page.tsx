import { ClipboardCheck } from "lucide-react";
import { redirect } from "next/navigation";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { HrOpsReportsWorkspace, type HrOpsWorkspaceMode } from "@/components/hr-ops-reports/hr-ops-reports-workspace";
import { isSalaryBlindRole } from "@/lib/auth/hr-functions";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { loadReportList, type HrOpsQueueReport } from "@/lib/hr-ops-reports/queue";
import { withCurrentLineNames } from "@/lib/hr-ops-reports/line-names";
import { viewReportWithLines } from "@/lib/hr-ops-reports/serialize";
import { getReport, getReportLines } from "@/lib/hr-ops-reports/store";
import { isUuid } from "@/lib/http/uuid";

// HR Daily & Weekly Reports — ONE page for both ends of the review (owner, 2026-10-20).
//
// The HR Operations Specialist opens it at /hr/hr-reports (the /hr namespace is a proxy rewrite
// onto this page): she confirms, rejects or recommends days on every flagged row and submits the
// report. The HR Manager opens it at /hr-reports from the admin rail: he decides each row and sees
// what the days would cost. The view is chosen from the GRANT, never from a role name —
// `hr_ops_reports:approve` decides, `update` reviews — and the amount is fetched only by the
// decider's screen, from a route that refuses a salary-blind seat. Her payload carries days only
// (src/lib/hr-ops-reports/serialize.ts is an allow-list).
export const dynamic = "force-dynamic";

function pickReport(reports: readonly HrOpsQueueReport[], mode: HrOpsWorkspaceMode, wanted: string | null): string | null {
  if (wanted && reports.some((report) => report.id === wanted)) return wanted;
  const waiting = reports.find((report) =>
    mode === "decider" ? report.status === "submitted" : report.status === "in_review",
  );
  return waiting?.id ?? reports[0]?.id ?? null;
}

export default async function HrOpsReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "hr_ops_reports", "read"))) {
    redirect("/admin");
  }
  const canDecide = (await canAccess(access, "hr_ops_reports", "approve")) && !isSalaryBlindRole(access.role);
  const canReview = await canAccess(access, "hr_ops_reports", "update");
  const mode: HrOpsWorkspaceMode = canDecide ? "decider" : canReview ? "reviewer" : "reader";

  const params = await searchParams;
  const wanted = typeof params.report === "string" && isUuid(params.report) ? params.report : null;

  // A deploy can reach production before its migration: that is said in words, never drawn as an
  // empty list that reads "nothing to review".
  let reports: HrOpsQueueReport[] = [];
  let selected: ReturnType<typeof viewReportWithLines> | null = null;
  let loadError: string | null = null;
  try {
    reports = await loadReportList();
    const id = pickReport(reports, mode, wanted);
    if (id) {
      const report = await getReport(id);
      if (report) selected = viewReportWithLines(report, await withCurrentLineNames(await getReportLines(id)));
    }
  } catch (error) {
    loadError = error instanceof Error ? error.message : "The reports could not be loaded.";
  }

  return (
    <div className="min-h-[calc(100vh-7rem)] border border-phx-line bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.12),transparent_30%),linear-gradient(180deg,#F8FAFC_0%,#EEF3F8_100%)] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] sm:p-6 xl:p-8">
      <div className="space-y-6">
        <AdminPageHero
          description={
            mode === "decider"
              ? "Every flagged day from the fingerprint and field-visit reports, with HR's answer beside it. Approve the days that stand or reject the row; approved days go on to the weekly attendance review."
              : "Yesterday's fingerprint and field-visit report, and last week's on a Sunday. Confirm, reject or recommend days on every flagged row, with a reason, then submit it to the HR Manager. Days only — the HR Manager decides."
          }
          eyebrow="Attendance & field review"
          icon={<ClipboardCheck className="h-3.5 w-3.5" />}
          title="Daily & Weekly Reports"
        />

        {loadError ? (
          <div className="border border-amber-200 bg-amber-50 p-5 text-sm font-semibold text-amber-900">{loadError}</div>
        ) : (
          <HrOpsReportsWorkspace initialReport={selected} initialReports={reports} mode={mode} />
        )}
      </div>
    </div>
  );
}
