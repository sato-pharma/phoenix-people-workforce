import Link from "next/link";
import { ArrowLeft, ExternalLink } from "lucide-react";

import { adminPanelClassName, adminPanelHeaderClassName, adminSoftPanelClassName } from "@/components/admin/admin-design-tokens";
import type { PlanApprovalDetail } from "@/lib/approvals-hub/service";
import { cairoDate } from "@/lib/format/cairo-datetime";
import { planPeriodLabel } from "@/lib/weekly-planning/plan-labels";
import { RequestTracker } from "@/components/approvals-hub/request-tracker";
import { PlanDecisionActions } from "@/components/approvals-hub/plan-decision-actions";
import { PlanApproverContext } from "@/components/approvals-hub/plan-approver-context";
import { PlanCompositionSummary, PlanPeriodBadge } from "@/components/approvals-hub/plan-summary";
import { WeeklyPlanCalendar } from "@/components/action-center/weekly-plan-calendar";
import { PlanConversationThread } from "@/components/weekly-planning/plan-conversation-thread";
import { PlanAdherenceBadge, PlanAdherenceReport } from "@/components/weekly-planning/plan-adherence-report";

type Props = {
  detail: PlanApprovalDetail;
  backHref: string;
};

function Row({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-slate-100 py-2">
      <dt className="text-phx-xs font-bold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="text-sm font-semibold text-slate-900">{value === null || value === undefined || value === "" ? "—" : value}</dd>
    </div>
  );
}

export function PlanRequestDetail({ detail, backHref }: Props) {
  if (detail.notFound) {
    return (
      <div className="space-y-4">
        <Link href={backHref} className="inline-flex items-center gap-1.5 text-sm font-bold text-orange-600 hover:text-orange-700">
          <ArrowLeft className="h-4 w-4" /> Back to list
        </Link>
        <p className={`${adminSoftPanelClassName} px-4 py-6 text-sm text-slate-600`}>
          This plan could not be found, or you do not have access to it.
        </p>
      </div>
    );
  }

  const kindLabel = detail.planKind === "monthly" ? "Monthly" : "Weekly";

  return (
    <div className="space-y-4">
      <Link href={backHref} className="inline-flex items-center gap-1.5 text-sm font-bold text-orange-600 hover:text-orange-700">
        <ArrowLeft className="h-4 w-4" /> Back to list
      </Link>

      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-phx-line pb-3">
        <div>
          <h2 className="text-lg font-black text-slate-900">{detail.employeeName}</h2>
          <p className="text-sm text-slate-600">
            {kindLabel} plan · {planPeriodLabel(detail.periodStartDate, detail.periodEndDate) || detail.periodKey}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {detail.adherence ? <PlanAdherenceBadge score={detail.adherence} /> : null}
          <PlanPeriodBadge status={detail.periodStatus} />
          <span className="whitespace-nowrap border border-slate-300 px-2.5 py-1 text-xs font-bold uppercase tracking-wide text-slate-700">
            {detail.statusLabel}
          </span>
        </div>
      </div>

      {detail.readOnly && detail.readOnlyReason ? (
        <p className="border-l-4 border-slate-400 bg-slate-50 px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-[inset_0_1px_2px_rgba(15,23,42,0.05)]">
          {detail.readOnlyReason}
        </p>
      ) : null}

      {/* The submitter's own plan: a clear jump to the planner, where they can view/edit it through
          its lifecycle (e.g. fix a returned plan) — the hub page itself is read-only for them. */}
      {detail.isOwner && detail.plannerHref ? (
        <a
          href={detail.plannerHref}
          className="inline-flex items-center gap-1.5 bg-orange-500 px-4 py-2 text-sm font-bold text-white hover:bg-orange-600"
        >
          <ExternalLink className="h-4 w-4" /> Open in my planner
        </a>
      ) : null}

      <PlanCompositionSummary composition={detail.composition} />

      {/* What the plan said, then what the CRM says actually happened — and for each gap, one plain
          instruction. The score is only worth showing next to the reason for it. */}
      {detail.adherence ? <PlanAdherenceReport score={detail.adherence} /> : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4">
          <section className={adminPanelClassName}>
            <header className={`${adminPanelHeaderClassName} px-4 py-2.5`}>
              <h3 className="text-phx-xs font-black uppercase tracking-[0.14em] text-white">Plan details</h3>
            </header>
            <dl className="px-4 py-2">
              <Row label="Employee" value={detail.employeeName} />
              <Row label="Job title" value={detail.employeeJobTitle} />
              <Row label="Plan type" value={`${kindLabel} plan`} />
              <Row label="Period" value={planPeriodLabel(detail.periodStartDate, detail.periodEndDate) || detail.periodKey} />
              {/* `submittedAt` is an INSTANT we stamped, so it is read in Cairo — this is a server component, where the
                  platform formatter would have used UTC and put an evening submission on the day before. */}
              <Row label="Submitted" value={cairoDate(detail.submittedAt)} />
              <Row label="Manager" value={detail.managerName} />
              <Row label="Activities" value={detail.composition.total} />
            </dl>
          </section>

          {/* Approver decision-support — never shown to the submitter viewing their own plan. */}
          {!detail.isOwner ? <PlanApproverContext employeeHrId={detail.employeeHrId} /> : null}

          <RequestTracker
            steps={detail.steps}
            stageLabel={detail.stageLabel}
            ageDays={detail.slaAgeDays}
            slaModule="plan"
            fallbackStatusLabel={`Status: ${detail.statusLabel}`}
          />

          {/* Two-way conversation — same thread the submitter sees in their own
              planner, so a return/edit-request is never a one-shot monologue. */}
          <PlanConversationThread key={detail.planId} planId={detail.planId} />

          {!detail.readOnly ? (
            <PlanDecisionActions
              planId={detail.planId}
              decisionStage={detail.decisionStage}
              canAcknowledge={detail.canAcknowledge}
              isEditRequestDecision={detail.isEditRequestDecision}
              canRequestVisitDetails={detail.canRequestVisitDetails}
              returnableActivities={detail.returnableActivities}
              backHref={backHref}
            />
          ) : null}
        </div>

        <section className={`${adminPanelClassName} lg:col-span-2`}>
          <header className={`${adminPanelHeaderClassName} px-4 py-2.5`}>
            <h3 className="text-phx-xs font-black uppercase tracking-[0.14em] text-white">Planned activities</h3>
          </header>
          <div className="px-4 py-4">
            {detail.calendar ? (
              <WeeklyPlanCalendar detail={detail.calendar} />
            ) : (
              <p className="text-sm text-slate-500">This plan has no activities.</p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
