import Link from "next/link";
import { ArrowLeft, ExternalLink } from "lucide-react";

import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { ManagerPlanDecisionActions } from "@/components/approvals-hub/manager-plan-decision-actions";
import { RecordConversationThread } from "@/components/conversations/record-conversation-thread";
import { ManagerWeekGlancePanel } from "@/components/phoenix-crm/manager-week-glance";
import {
  LANDING_FOCUS,
  LANDING_INK,
  LandingPanel,
  LandingRailLine,
  landingActionClassName,
} from "@/components/employee-portal/landing-kit";
import {
  MANAGER_GLANCE_KIND_EDGE,
  MANAGER_HUB_EMPTY_HALF_WORDS,
  managerGlanceGrade,
  managerHubWeekExportHref,
  managerSavedSlot,
} from "@/lib/phoenix-crm/manager-week-glance";
import type {
  ManagerHubDetail,
  ManagerHubPlanDetail,
  ManagerHubRemovalDetail,
  ManagerHubSingleVisitDayDetail,
  ManagerHubStep,
  ManagerHubStepState,
} from "@/lib/phoenix-crm/server/manager-plan-hub";

/**
 * The Approvals Hub page of a district manager's Phoenix CRM week (owner, 2026-10-16): the week day by
 * day and half by half — with a rep and the customers he ticked (each flagged when it is not on the rep's
 * sent day), an admin activity, or a single visit and its customers — plus the tracker and, for the step's
 * holder or the Administrator, the decision. The same page shows his ask to edit a week, his ask to take
 * a customer off his own list, and his ask for another day of single visits.
 */

// The kit's language (landing-kit.tsx): a step's state is a 4px rail and coloured small capitals —
// navy for the step waiting now, the tone scale's 700s for the rest. Orange stays the title tick.
const STEP_TONE: Record<ManagerHubStepState, { dot: string; text: string; label: string }> = {
  done: { dot: "bg-emerald-500", text: "text-emerald-700", label: "Done" },
  current: { dot: "bg-[#08111f]", text: "text-[#08111f]", label: "Waiting" },
  waiting: { dot: "bg-slate-300", text: "text-slate-500", label: "Later" },
  returned: { dot: "bg-amber-500", text: "text-amber-700", label: "Returned" },
  refused: { dot: "bg-rose-500", text: "text-rose-700", label: "Refused" },
  closed: { dot: "bg-slate-400", text: "text-slate-600", label: "Closed before it was decided" },
};

/** The white sheet a stand-alone line sits on: the kit's hairline and the soft depth token. */
const SHEET = `min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`;

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

/** The page's own head: the name in navy, its standing in small capitals beside it. */
function PageHead({ title, status, dir }: { title: string; status: string; dir?: "auto" }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-slate-200 pb-3">
      <h2 className={`min-w-0 break-words text-lg font-black ${LANDING_INK}`} dir={dir}>
        {title}
      </h2>
      <span className="text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-600">{status}</span>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-slate-200 py-2 last:border-b-0">
      <dt className="text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500">{label}</dt>
      <dd className={`break-words text-sm font-semibold ${LANDING_INK}`} dir="auto">{value || "—"}</dd>
    </div>
  );
}

function Tracker({ title, steps }: { title: string; steps: ManagerHubStep[] }) {
  if (steps.length === 0) return null;
  return (
    <LandingPanel title={title}>
      <ol className="divide-y divide-slate-200">
        {steps.map((step) => {
          const tone = STEP_TONE[step.state];
          return (
            <li key={step.label} className="flex min-w-0 gap-3 px-3 py-2.5 sm:px-4">
              <span className={`w-1 shrink-0 self-stretch ${tone.dot}`} aria-hidden />
              <div className="min-w-0">
                <p className={`break-words text-sm font-bold ${LANDING_INK}`}>{step.label}</p>
                <p className="break-words text-xs text-slate-600" dir="auto">{step.who}</p>
                <p className={`text-phx-xs font-black uppercase tracking-[0.1em] ${tone.text}`}>
                  {tone.label}
                  {step.at ? ` · ${step.at}` : ""}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </LandingPanel>
  );
}

type HubSlot = ManagerHubPlanDetail["board"]["days"][number]["slots"][number];

/**
 * A district manager's half-day with his manager or product manager (owner, 2026-10-23: "make sure the approval go
 * into workflows and appear in a polished way for the approver"): what kind it is, who goes, and — under it — each
 * ticked area as a chip. A national manager's With a district manager keeps its one line, as merged (owner: "leave nsm").
 */
function RideAlong({ slot }: { slot: HubSlot }) {
  const who = slot.seniorName ?? "A manager no longer on the list";
  const title = slot.seniorTitle;
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="text-phx-xs font-black uppercase tracking-[0.1em] text-sky-700">{slot.kindLabel}</span>
      <span className={`break-words text-sm font-bold ${LANDING_INK}`} dir="auto">{who}</span>
      {title ? <span className="break-words text-xs font-semibold text-slate-500">{title}</span> : null}
    </span>
  );
}

function WeekDays({ detail }: { detail: ManagerHubPlanDetail }) {
  const days = detail.board.days.filter((day) => day.halves.length > 0 || day.holiday);
  return (
    <LandingPanel className="lg:col-span-2" title="The week, half-day by half-day">
      <div className="space-y-3 px-3 py-3 sm:px-4">
        {days.length === 0 ? <p className="text-sm text-slate-500">This week has no working days.</p> : null}
        {days.map((day) => (
          <div key={day.date} className="border border-slate-200">
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-200 px-3 py-1.5">
              <span className={`text-phx-xs font-black uppercase tracking-[0.1em] ${LANDING_INK}`}>{day.dateText}</span>
              {day.holiday ? <span className="text-phx-xs font-bold text-slate-500">{day.holiday}</span> : null}
              {detail.returnedDayText && detail.board.plan?.returnedDay === day.date ? (
                <span className="text-phx-xs font-black uppercase tracking-[0.1em] text-amber-700">Returned</span>
              ) : null}
            </div>
            <div className="divide-y divide-slate-200">
              {/* Every half the day holds, an empty one included: the approver reads what was left empty too, where the
                  list of saved halves alone hid it (premium pass, 2026-11-09). A planned half wears its kind's edge,
                  as on the week at a glance. */}
              {day.halves.map((half) => {
                const slot = managerSavedSlot(day, half);
                if (!slot) {
                  return (
                    <div key={half} className="px-3 py-2">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span className="text-phx-xs font-black uppercase tracking-[0.1em] text-slate-500">{half}</span>
                        <span className="break-words text-sm font-semibold text-slate-500">{MANAGER_HUB_EMPTY_HALF_WORDS}</span>
                      </div>
                    </div>
                  );
                }
                return (
                <div key={slot.half} className={`border-l-4 ${slot.kind ? MANAGER_GLANCE_KIND_EDGE[slot.kind] : "border-l-transparent"} px-3 py-2`}>
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="text-phx-xs font-black uppercase tracking-[0.1em] text-slate-500">{slot.half}</span>
                    {slot.kind === "with_senior" ? (
                      <RideAlong slot={slot} />
                    ) : (
                      <span className={`break-words text-sm font-bold ${LANDING_INK}`}>{slot.summary ?? "Nothing planned"}</span>
                    )}
                  </div>
                  {slot.kind === "with_senior" && slot.tickedAreas.length > 0 ? (
                    <ul className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Areas">
                      {slot.tickedAreas.map((area) => (
                        <li
                          key={area.seatId}
                          className={`max-w-full border px-2 py-0.5 text-xs ${area.vacant ? "border-amber-500 text-amber-800" : "border-slate-200 text-slate-700"}`}
                        >
                          <span className="break-words font-semibold" dir="auto">
                            {area.name}
                          </span>
                          {area.vacant ? <span className="font-bold"> · Vacant</span> : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {/* A regional sales manager's view only: a neutral chain visit or leave line — never a warning (owner, 2026-10-24). */}
                  {(detail.halfNotes?.[`${day.date}|${slot.half}`] ?? []).map((line) => (
                    <p className="mt-1 break-words text-xs font-semibold text-sky-800" key={line}>
                      {line}
                    </p>
                  ))}
                  {slot.kind === "admin" && slot.note ? <p className="mt-1 break-words text-xs text-slate-600">{slot.note}</p> : null}
                  {slot.kind !== "admin" && slot.note ? <p className="mt-1 break-words text-xs text-slate-600">Note: {slot.note}</p> : null}
                  {slot.customers.length > 0 ? (
                    <ul className="mt-1.5 flex flex-wrap gap-1.5">
                      {slot.customers.map((customer) => (
                        <li
                          key={customer.customerId ?? customer.managerCustomerId ?? customer.name}
                          className={`max-w-full border px-2 py-0.5 text-xs ${customer.flag ? "border-amber-500 text-amber-800" : "border-slate-200 text-slate-700"}`}
                        >
                          <span className="break-words font-semibold" dir="auto">
                            {customer.name}
                          </span>
                          {managerGlanceGrade(customer.grade) !== "none" ? <span className="text-slate-500"> · {managerGlanceGrade(customer.grade)}</span> : null}
                          {customer.own ? <span className="text-slate-500"> · Manager&apos;s own list</span> : null}
                          {customer.flagLabel ? <span className="font-bold"> · {customer.flagLabel}</span> : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </LandingPanel>
  );
}

function PlanDetail({ detail, backHref, plannerHref }: { detail: ManagerHubPlanDetail; backHref: string; plannerHref: string }) {
  const ask = detail.ask;
  return (
    <div className="space-y-4">
      <Back href={backHref} />
      {/* The head is the name and its standing alone (owner, 2026-11-20: no sentence under any header);
          the week and the planner's title are the Plan details panel's own rows. */}
      <PageHead status={detail.statusLabel} title={detail.managerName} dir="auto" />

      {detail.isTest ? (
        <div className={SHEET}>
          <LandingRailLine rail="bg-slate-400">A test persona&apos;s week — nothing here is real.</LandingRailLine>
        </div>
      ) : null}

      {detail.isOwner ? (
        <a href={plannerHref} className={landingActionClassName("solid")}>
          <ExternalLink aria-hidden="true" className="h-4 w-4" /> Open my plan in Phoenix CRM
        </a>
      ) : null}

      {/* The same week at a glance as on the planner's own board — the same figures, read from the same module — so the
          approver sees the week whole before reading it half by half. Text only: nothing here opens a half. */}
      <div className={SHEET}>
        <ManagerWeekGlancePanel canOpen={false} exportHref={managerHubWeekExportHref(detail.planId)} view={detail.board} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4">
          <LandingPanel title="Plan details">
            <dl className="px-3 py-1 sm:px-4">
              <Fact label={detail.managerTitle} value={detail.managerName} />
              <Fact label="Week" value={detail.weekText} />
              <Fact label="Sent" value={detail.sentAt ? `${detail.sentAt}${detail.sentLate ? " · after the Thursday deadline" : ""}` : "Not sent"} />
              {detail.returnedDayText ? <Fact label="Day returned" value={detail.returnedDayText} /> : null}
              {detail.decisionNote ? <Fact label="Note" value={detail.decisionNote} /> : null}
            </dl>
          </LandingPanel>

          {ask ? (
            <LandingPanel title="The ask to edit the week">
              <dl className="px-3 py-1 sm:px-4">
                <Fact label="Why" value={ask.reason} />
                <Fact label="Asked" value={ask.askedAt} />
                <Fact label="Stands" value={ask.statusLabel} />
                {ask.decisionNote ? <Fact label="Note" value={ask.decisionNote} /> : null}
              </dl>
            </LandingPanel>
          ) : null}

          {ask ? <Tracker title="Ask to edit tracker" steps={ask.steps} /> : null}

          <Tracker title="Approval tracker" steps={detail.steps} />

          {ask?.decideAs ? (
            <ManagerPlanDecisionActions
              target={{ kind: "edit", requestId: ask.requestId, version: ask.version, stage: ask.stage, thenName: ask.thenName }}
              byAdministrator={ask.decideAs === "administrator"}
              backHref={backHref}
            />
          ) : detail.decideAs ? (
            <ManagerPlanDecisionActions
              target={{ kind: "plan", planId: detail.planId, version: detail.version, canApprove: detail.canApprove, returnableDays: detail.returnableDays, thenName: detail.thenName }}
              byAdministrator={detail.decideAs === "administrator"}
              backHref={backHref}
            />
          ) : detail.endedUndecidedOnText ? (
            // A sent week whose Thursday passed undecided: the database refuses every step on it, so the page says
            // why there is no button instead of leaving its approver to look for one (owner, 2026-11-08).
            <div className={SHEET}>
              <LandingRailLine rail="bg-slate-400">
                This week ended on {detail.endedUndecidedOnText} before it was approved. A week that has ended can no longer be approved
                or returned.
              </LandingRailLine>
            </div>
          ) : null}

          {/* The week's conversation, open at any status once it has been sent (owner, 2026-11-01). The same
              thread the manager opens on his plan board. */}
          {detail.conversation ? <RecordConversationThread base={detail.conversation.url} key={detail.planId} note={detail.conversation.note} /> : null}
        </div>

        <WeekDays detail={detail} />
      </div>
    </div>
  );
}

function RemovalDetail({ detail, backHref }: { detail: ManagerHubRemovalDetail; backHref: string }) {
  const grades = [detail.grade, detail.potentialGrade].filter(Boolean).join(" · ");
  return (
    <div className="space-y-4">
      <Back href={backHref} />
      <PageHead status={detail.statusLabel} title={detail.customerName} dir="auto" />
      <div className="grid gap-4 lg:grid-cols-2">
        <LandingPanel title="The customer">
          <dl className="px-3 py-1 sm:px-4">
            <Fact label={detail.managerTitle} value={detail.managerName} />
            <Fact label="Speciality" value={detail.speciality} />
            <Fact label="Grade · potential" value={grades} />
            <Fact label="Area" value={detail.areaName} />
            <Fact label="Why it is asked" value={detail.reason} />
            {detail.decisionNote ? <Fact label="Note" value={detail.decisionNote} /> : null}
          </dl>
        </LandingPanel>
        <div className="space-y-4">
          <Tracker title="Approval tracker" steps={detail.steps} />
          {detail.decideAs ? (
            <ManagerPlanDecisionActions
              target={{ kind: "removal", customerId: detail.customerId, requestedAt: detail.requestedAt, stage: detail.stage, thenName: detail.thenName }}
              byAdministrator={detail.decideAs === "administrator"}
              backHref={backHref}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SingleVisitDayDetail({ detail, backHref }: { detail: ManagerHubSingleVisitDayDetail; backHref: string }) {
  return (
    <div className="space-y-4">
      <Back href={backHref} />
      <PageHead status={detail.statusLabel} title={detail.visitDateText} />
      <div className="grid gap-4 lg:grid-cols-2">
        <LandingPanel title="The ask">
          <dl className="px-3 py-1 sm:px-4">
            <Fact label={detail.managerTitle} value={detail.managerName} />
            <Fact label="Day" value={detail.visitDateText} />
            <Fact label="Week" value={detail.weekText} />
            <Fact label="This week so far" value={detail.weekLine} />
            <Fact label="Why it is asked" value={detail.reason} />
            {detail.decisionNote ? <Fact label="Note" value={detail.decisionNote} /> : null}
          </dl>
        </LandingPanel>
        <div className="space-y-4">
          <Tracker title="Approval tracker" steps={detail.steps} />
          {detail.decideAs ? (
            <ManagerPlanDecisionActions
              target={{ kind: "single_visit_day", requestId: detail.requestId, version: detail.version, stage: detail.stage, thenName: detail.thenName }}
              byAdministrator={detail.decideAs === "administrator"}
              backHref={backHref}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function ManagerPlanRequestDetail({ detail, backHref, plannerHref }: { detail: ManagerHubDetail; backHref: string; plannerHref: string }) {
  if (detail.kind === "plan") return <PlanDetail detail={detail} backHref={backHref} plannerHref={plannerHref} />;
  if (detail.kind === "removal") return <RemovalDetail detail={detail} backHref={backHref} />;
  if (detail.kind === "single_visit_day") return <SingleVisitDayDetail detail={detail} backHref={backHref} />;
  return (
    <div className="space-y-4">
      <Back href={backHref} />
      <div className={SHEET}>
        <LandingRailLine rail="bg-amber-500">This plan could not be found, or you do not have access to it.</LandingRailLine>
      </div>
    </div>
  );
}
