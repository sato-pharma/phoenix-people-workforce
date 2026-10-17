import Link from "next/link";
import { ArrowLeft, ExternalLink } from "lucide-react";

import { adminPanelClassName, adminPanelHeaderClassName, adminSoftPanelClassName } from "@/components/admin/admin-design-tokens";
import { ManagerPlanDecisionActions } from "@/components/approvals-hub/manager-plan-decision-actions";
import type {
  ManagerHubDetail,
  ManagerHubPlanDetail,
  ManagerHubRemovalDetail,
  ManagerHubStep,
  ManagerHubStepState,
} from "@/lib/phoenix-crm/server/manager-plan-hub";

/**
 * The Approvals Hub page of a district manager's Phoenix CRM week (owner, 2026-10-16): the week day by
 * day and half by half — with a rep and the customers he ticked (each flagged when it is not on the rep's
 * sent day), an admin activity, or a single visit and its customers — plus the tracker and, for the step's
 * holder or the Administrator, the decision. The same page shows his ask to edit a week and his ask to take
 * a customer off his own list.
 */

const STEP_TONE: Record<ManagerHubStepState, { dot: string; text: string; label: string }> = {
  done: { dot: "bg-emerald-500", text: "text-emerald-700", label: "Done" },
  current: { dot: "bg-orange-500", text: "text-orange-700", label: "Waiting" },
  waiting: { dot: "bg-slate-300", text: "text-slate-500", label: "Later" },
  returned: { dot: "bg-amber-500", text: "text-amber-700", label: "Returned" },
  refused: { dot: "bg-rose-500", text: "text-rose-700", label: "Refused" },
  closed: { dot: "bg-slate-400", text: "text-slate-600", label: "Closed when the week ended" },
};

const headerText = "text-phx-xs font-black uppercase tracking-[0.14em] text-white";

function Back({ href }: { href: string }) {
  return (
    <Link href={href} className="inline-flex items-center gap-1.5 text-sm font-bold text-orange-600 hover:text-orange-700">
      <ArrowLeft className="h-4 w-4" /> Back to list
    </Link>
  );
}

function Fact({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-slate-100 py-2">
      <dt className="text-phx-xs font-bold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="break-words text-sm font-semibold text-slate-900">{value || "—"}</dd>
    </div>
  );
}

function Tracker({ title, steps }: { title: string; steps: ManagerHubStep[] }) {
  if (steps.length === 0) return null;
  return (
    <section className={adminPanelClassName}>
      <header className={`${adminPanelHeaderClassName} px-4 py-2.5`}>
        <h3 className={headerText}>{title}</h3>
      </header>
      <ol className="space-y-3 px-4 py-4">
        {steps.map((step) => {
          const tone = STEP_TONE[step.state];
          return (
            <li key={step.label} className="flex gap-3">
              <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 ${tone.dot}`} aria-hidden />
              <div className="min-w-0">
                <p className="text-sm font-bold text-slate-900">{step.label}</p>
                <p className="break-words text-xs text-slate-600">{step.who}</p>
                <p className={`text-phx-2xs font-black uppercase tracking-wide ${tone.text}`}>
                  {tone.label}
                  {step.at ? ` · ${step.at}` : ""}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function WeekDays({ detail }: { detail: ManagerHubPlanDetail }) {
  const days = detail.board.days.filter((day) => day.halves.length > 0 || day.holiday);
  return (
    <section className={`${adminPanelClassName} lg:col-span-2`}>
      <header className={`${adminPanelHeaderClassName} px-4 py-2.5`}>
        <h3 className={headerText}>The week, half-day by half-day</h3>
      </header>
      <div className="space-y-3 px-4 py-4">
        {days.length === 0 ? <p className="text-sm text-slate-500">This week has no working days.</p> : null}
        {days.map((day) => (
          <div key={day.date} className="border border-slate-200">
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-100 bg-slate-50 px-3 py-1.5">
              <span className="text-phx-xs font-black uppercase tracking-wide text-slate-700">{day.dateText}</span>
              {day.holiday ? <span className="text-phx-xs font-bold text-slate-500">{day.holiday}</span> : null}
              {detail.returnedDayText && detail.board.plan?.returnedDay === day.date ? (
                <span className="text-phx-xs font-black uppercase tracking-wide text-amber-700">Returned</span>
              ) : null}
            </div>
            <div className="divide-y divide-slate-100">
              {day.slots.map((slot) => (
                <div key={slot.half} className="px-3 py-2">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="text-phx-xs font-black uppercase tracking-wide text-slate-500">{slot.half}</span>
                    <span className="break-words text-sm font-bold text-slate-900">{slot.summary ?? "Nothing planned"}</span>
                  </div>
                  {slot.kind === "admin" && slot.note ? <p className="mt-1 break-words text-xs text-slate-600">{slot.note}</p> : null}
                  {slot.kind !== "admin" && slot.note ? <p className="mt-1 break-words text-xs text-slate-600">Note: {slot.note}</p> : null}
                  {slot.customers.length > 0 ? (
                    <ul className="mt-1.5 flex flex-wrap gap-1.5">
                      {slot.customers.map((customer) => (
                        <li
                          key={customer.customerId ?? customer.managerCustomerId ?? customer.name}
                          className={`max-w-full border px-2 py-0.5 text-xs ${customer.flag ? "border-amber-400 bg-amber-50 text-amber-800" : "border-slate-200 bg-white text-slate-700"}`}
                        >
                          <span className="break-words font-semibold" dir="auto">
                            {customer.name}
                          </span>
                          {customer.grade ? <span className="text-slate-500"> · {customer.grade}</span> : null}
                          {customer.own ? <span className="text-slate-500"> · Manager&apos;s own list</span> : null}
                          {customer.flagLabel ? <span className="font-bold"> · {customer.flagLabel}</span> : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function PlanDetail({ detail, backHref, plannerHref }: { detail: ManagerHubPlanDetail; backHref: string; plannerHref: string }) {
  const ask = detail.ask;
  return (
    <div className="space-y-4">
      <Back href={backHref} />
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-phx-line pb-3">
        <div className="min-w-0">
          <h2 className="break-words text-lg font-black text-slate-900">{detail.managerName}</h2>
          <p className="text-sm text-slate-600">District manager weekly plan · {detail.weekText}</p>
        </div>
        <span className="border border-slate-300 px-2.5 py-1 text-xs font-bold uppercase tracking-wide text-slate-700">{detail.statusLabel}</span>
      </div>

      {detail.isTest ? (
        <p className="border-l-4 border-slate-400 bg-slate-50 px-4 py-2.5 text-sm font-semibold text-slate-700">A test persona&apos;s week — nothing here is real.</p>
      ) : null}

      {detail.isOwner ? (
        <a href={plannerHref} className="inline-flex items-center gap-1.5 bg-orange-500 px-4 py-2 text-sm font-bold text-white hover:bg-orange-600">
          <ExternalLink className="h-4 w-4" /> Open my plan in Phoenix CRM
        </a>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4">
          <section className={adminPanelClassName}>
            <header className={`${adminPanelHeaderClassName} px-4 py-2.5`}>
              <h3 className={headerText}>Plan details</h3>
            </header>
            <dl className="px-4 py-2">
              <Fact label="District manager" value={detail.managerName} />
              <Fact label="Week" value={detail.weekText} />
              <Fact label="Sent" value={detail.sentAt ? `${detail.sentAt}${detail.sentLate ? " · after the Thursday deadline" : ""}` : "Not sent"} />
              {detail.returnedDayText ? <Fact label="Day returned" value={detail.returnedDayText} /> : null}
              {detail.decisionNote ? <Fact label="Note" value={detail.decisionNote} /> : null}
            </dl>
          </section>

          {ask ? (
            <section className={adminPanelClassName}>
              <header className={`${adminPanelHeaderClassName} px-4 py-2.5`}>
                <h3 className={headerText}>The ask to edit the week</h3>
              </header>
              <dl className="px-4 py-2">
                <Fact label="Why" value={ask.reason} />
                <Fact label="Asked" value={ask.askedAt} />
                <Fact label="Stands" value={ask.statusLabel} />
                {ask.decisionNote ? <Fact label="Note" value={ask.decisionNote} /> : null}
              </dl>
            </section>
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
              target={{ kind: "plan", planId: detail.planId, version: detail.version, returnableDays: detail.returnableDays, thenName: detail.thenName }}
              byAdministrator={detail.decideAs === "administrator"}
              backHref={backHref}
            />
          ) : null}
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
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-phx-line pb-3">
        <div className="min-w-0">
          <h2 className="break-words text-lg font-black text-slate-900" dir="auto">
            {detail.customerName}
          </h2>
          <p className="text-sm text-slate-600">{detail.managerName} asks to take this customer off Manager&apos;s own list</p>
        </div>
        <span className="border border-slate-300 px-2.5 py-1 text-xs font-bold uppercase tracking-wide text-slate-700">{detail.statusLabel}</span>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <section className={adminPanelClassName}>
          <header className={`${adminPanelHeaderClassName} px-4 py-2.5`}>
            <h3 className={headerText}>The customer</h3>
          </header>
          <dl className="px-4 py-2">
            <Fact label="District manager" value={detail.managerName} />
            <Fact label="Speciality" value={detail.speciality} />
            <Fact label="Grade · potential" value={grades} />
            <Fact label="Area" value={detail.areaName} />
            <Fact label="Why it is asked" value={detail.reason} />
            {detail.decisionNote ? <Fact label="Note" value={detail.decisionNote} /> : null}
          </dl>
        </section>
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

export function ManagerPlanRequestDetail({ detail, backHref, plannerHref }: { detail: ManagerHubDetail; backHref: string; plannerHref: string }) {
  if (detail.kind === "plan") return <PlanDetail detail={detail} backHref={backHref} plannerHref={plannerHref} />;
  if (detail.kind === "removal") return <RemovalDetail detail={detail} backHref={backHref} />;
  return (
    <div className="space-y-4">
      <Back href={backHref} />
      <p className={`${adminSoftPanelClassName} px-4 py-6 text-sm text-slate-600`}>This plan could not be found, or you do not have access to it.</p>
    </div>
  );
}
