import { redirect } from "next/navigation";

import { ConsolidatedReportView } from "@/components/probation/consolidated-report-view";
import { ProbationDecisionPanel } from "@/components/probation/probation-decision-panel";
import { ProbationAssessmentsPanel } from "@/components/probation/probation-assessments-panel";
import { DevelopmentActionsControl } from "@/components/probation/development-actions-control";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { employeeLeftLabel } from "@/lib/employees/left-flag";
import { readProbationEmployeeLeft } from "@/lib/probation/intelligence/cases";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { canReadAllProbation } from "@/lib/probation/service";
import { buildConsolidatedReport } from "@/lib/probation/intelligence/consolidated-report";
import { canDecideProbation } from "@/lib/probation/intelligence/decision";
import { getProbationConfig } from "@/lib/probation/intelligence/config";
import {
  canSubmitSfeAssessment,
  canSubmitHrAssessment,
  canSeeConfidentialNote,
} from "@/lib/probation/intelligence/assessments";

export const dynamic = "force-dynamic";

// The always-live consolidated probation report for one case (admin/HR/CEO surface).
export default async function ProbationCaseReportPage({
  params,
}: {
  params: Promise<{ caseId: string }>;
}) {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals");
  }
  // Company-wide readers see every case; the SFE Manager reaches a case report to submit their
  // (data-driven) assessment even though they are not a company-wide reader.
  if (!canReadAllProbation(access) && !canSubmitSfeAssessment(access)) {
    redirect("/employee-portals");
  }

  const { caseId } = await params;

  let report;
  let config;
  try {
    [report, config] = await Promise.all([
      buildConsolidatedReport(access, caseId),
      getProbationConfig(),
    ]);
  } catch (error) {
    const message = String((error as { message?: unknown })?.message ?? error);
    return (
      <div className="mx-auto max-w-3xl p-6">
        <h1 className="text-lg font-semibold text-slate-900">Probation report unavailable</h1>
        <p className="mt-2 text-sm text-slate-600">{message}</p>
      </div>
    );
  }

  const employeeLeft = report.case.status === "active" ? await readProbationEmployeeLeft(report.case.employeeHrId) : null;
  const showDecision = canDecideProbation(access);
  const canSubmitSfe = canSubmitSfeAssessment(access);
  const canSubmitHr = canSubmitHrAssessment(access);
  const canSeeConfidential = canSeeConfidentialNote(access);
  const canManageActions = canDecideProbation(access);

  const sfe = report.assessments.sfe;
  const hrRaw = report.assessments.hr;
  const hrReal = hrRaw && "score" in hrRaw ? hrRaw : null;
  const sfeExisting = sfe
    ? { score: sfe.score, comments: sfe.comments, confidentialNote: sfe.confidentialNote, status: sfe.status }
    : null;
  const hrExisting = hrReal
    ? { score: hrReal.score, comments: hrReal.comments, confidentialNote: hrReal.confidentialNote, status: hrReal.status }
    : null;

  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      {employeeLeft ? (
        <p className="mb-4 border border-phx-line bg-white p-3 text-sm font-semibold text-phx-ink shadow-none" role="status">
          <span className="font-black text-phx-danger">{employeeLeftLabel(employeeLeft)}.</span> This case is still open:
          nothing has been closed or decided for them.
        </p>
      ) : null}
      {showDecision && (
        <div className="mb-4">
          <ProbationDecisionPanel
            caseId={report.case.id}
            employeeName={report.case.employeeName ?? report.case.employeeHrId}
            decisionReady={report.score.decisionReady}
            alreadyDecided={report.case.status === "decided" || report.case.decision != null}
            decision={report.case.decision}
          />
        </div>
      )}
      {(canSubmitSfe || canSubmitHr) && (
        <div className="mb-4">
          <ProbationAssessmentsPanel
            caseId={report.case.id}
            scale={config.scoringScale}
            sfeEvidence={report.sfeEvidence}
            sfeExisting={sfeExisting}
            hrExisting={hrExisting}
            hrAssessmentEnabled={report.assessments.hrAssessmentEnabled}
            canSubmitSfe={canSubmitSfe}
            canSubmitHr={canSubmitHr}
            canSeeConfidential={canSeeConfidential}
          />
        </div>
      )}
      {canManageActions && report.developmentActions.length > 0 && (
        <div className="mb-4">
          <DevelopmentActionsControl
            actions={report.developmentActions.map((a) => ({
              id: a.id,
              title: a.title,
              ownerHrId: a.ownerHrId,
              ownerName: a.ownerName,
              dueDate: a.dueDate,
              status: a.status,
              followUpOutcome: a.followUpOutcome,
            }))}
          />
        </div>
      )}
      <ConsolidatedReportView report={report} />
    </div>
  );
}
