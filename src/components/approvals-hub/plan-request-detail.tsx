import Link from "next/link";
import { ArrowLeft, ExternalLink } from "lucide-react";

import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import {
  LANDING_FOCUS,
  LANDING_INK,
  LandingEmpty,
  LandingPanel,
  LandingRailLine,
  landingActionClassName,
} from "@/components/employee-portal/landing-kit";
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

/** The white sheet a stand-alone line sits on: the kit's hairline and the soft depth token. */
const SHEET = `min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`;

function Row({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-slate-200 py-2 last:border-b-0">
      <dt className="text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500">{label}</dt>
      <dd className={`break-words text-sm font-semibold ${LANDING_INK}`} dir="auto">
        {value === null || value === undefined || value === "" ? "—" : value}
      </dd>
    </div>
  );
}

function Back({ href }: { href: string }) {
  return (
    <Link
      href={href}
      className={`inline-flex items-center gap-1.5 text-phx-xs font-bold uppercase tracking-[0.1em] underline-offset-4 transition-colors hover:underline motion-reduce:transition-none ${LANDING_INK} ${LANDING_FOCUS}`}
    >
      <ArrowLeft aria-hidden="true" className="h-4 w-4" /> Back to list
    </Link>
  );
}

export function PlanRequestDetail({ detail, backHref }: Props) {
  if (detail.notFound) {
    return (
      <div className="space-y-4">
        <Back href={backHref} />
        <div className={SHEET}>
          <LandingRailLine rail="bg-amber-500">This plan could not be found, or you do not have access to it.</LandingRailLine>
        </div>
      </div>
    );
  }

  const kindLabel = detail.planKind === "monthly" ? "Monthly" : "Weekly";

  return (
    <div className="space-y-4">
      <Back href={backHref} />

      {/* The head is the name and its standing alone (no sentence under a header); the plan type and
          its period are rows of Plan details. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-slate-200 pb-3">
        <h2 className={`min-w-0 break-words text-lg font-black ${LANDING_INK}`} dir="auto">{detail.employeeName}</h2>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {detail.adherence ? <PlanAdherenceBadge score={detail.adherence} /> : null}
          <PlanPeriodBadge status={detail.periodStatus} />
          <span className="text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-600">{detail.statusLabel}</span>
        </div>
      </div>

      {detail.readOnly && detail.readOnlyReason ? (
        <div className={SHEET}>
          <LandingRailLine rail="bg-slate-400">{detail.readOnlyReason}</LandingRailLine>
        </div>
      ) : null}

      {/* The submitter's own plan: a clear jump to the planner, where they can view/edit it through
          its lifecycle (e.g. fix a returned plan) — the hub page itself is read-only for them. */}
      {detail.isOwner && detail.plannerHref ? (
        <a href={detail.plannerHref} className={landingActionClassName("solid")}>
          <ExternalLink aria-hidden="true" className="h-4 w-4" /> Open in my planner
        </a>
      ) : null}

      <PlanCompositionSummary composition={detail.composition} />

      {/* What the plan said, then what the CRM says actually happened — and for each gap, one plain
          instruction. The score is only worth showing next to the reason for it. */}
      {detail.adherence ? <PlanAdherenceReport score={detail.adherence} /> : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4">
          <LandingPanel title="Plan details">
            <dl className="px-3 py-1 sm:px-4">
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
          </LandingPanel>

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

        <LandingPanel className="lg:col-span-2" title="Planned activities">
          {detail.calendar ? (
            <div className="px-3 py-3 sm:px-4">
              <WeeklyPlanCalendar detail={detail.calendar} />
            </div>
          ) : (
            <LandingEmpty>This plan has no activities.</LandingEmpty>
          )}
        </LandingPanel>
      </div>
    </div>
  );
}
