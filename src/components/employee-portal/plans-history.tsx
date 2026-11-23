"use client";

import { CalendarDays, ChevronDown, ChevronUp, Lock } from "lucide-react";
import { useMemo, useState } from "react";

import {
  formatDate,
  formatDayName,
  PlanDecisionTimeline,
  planStatusWordClassName,
  statusInk,
  statusLabels,
  statusRail,
} from "@/components/employee-portal/plans-workspace";
import {
  LANDING_INK,
  LANDING_ROW_LINK,
  LandingCta,
  LandingEmpty,
} from "@/components/employee-portal/landing-kit";
import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { ChoiceGroup } from "@/components/ui/choice-group";
import { PHOENIX_CRM_PORTAL_BASE } from "@/lib/phoenix-crm/modules";
import { planNounLabel, planPeriodShortLabel } from "@/lib/weekly-planning/plan-labels";
import { splitDraftsReplacedByALaterPlan } from "@/lib/weekly-planning/plan-revisions";
import type { EmployeePlan } from "@/lib/weekly-planning/service";

/**
 * The plans a manager filed on the old Weekly / Monthly form, to READ — nothing else (owner, 2026-10-17:
 * "make it unhidden, but make them not able to submit … make them only able to see their historical plans,
 * which they submitted on the old module").
 *
 * A manager whose week is planned in Phoenix CRM now opens this instead of the builder. There is no field,
 * no save, no submit, no edit ask and no cancel here, and the server refuses each of them for him as well
 * (`assertPlansOnThisForm`), so hiding a button is never the only gate. It fits the screen the way every
 * page does: one column of blocks that wrap, never a table that scrolls sideways.
 */

type KindFilter = "all" | "weekly" | "monthly";

const KIND_OPTIONS = [
  { label: "All", value: "all" },
  { label: "Weekly", value: "weekly" },
  { label: "Monthly", value: "monthly" },
] as const;

function itemTitle(item: EmployeePlan["items"][number]): string {
  return item.activityTitle.trim() || item.activityType;
}

function itemPlace(item: EmployeePlan["items"][number]): string {
  return [item.area, item.locationText]
    .map((part) => (part ?? "").trim())
    .filter((part, index, all) => part.length > 0 && all.indexOf(part) === index)
    .join(" · ");
}

function itemTimes(item: EmployeePlan["items"][number]): string {
  if (!item.startTime && !item.endTime) return "";
  return [item.startTime, item.endTime].map((time) => (time ? time.slice(0, 5) : "")).filter(Boolean).join(" – ");
}

function PlanItems({ plan }: { plan: EmployeePlan }) {
  const items = [...plan.items].sort(
    (left, right) => left.activityDate.localeCompare(right.activityDate) || left.sortOrder - right.sortOrder,
  );
  if (items.length === 0) {
    return <LandingEmpty>This plan holds no days.</LandingEmpty>;
  }
  return (
    <ul className="divide-y divide-slate-200 px-3 sm:px-4">
      {items.map((item) => {
        const place = itemPlace(item);
        const times = itemTimes(item);
        return (
          <li className="grid gap-1 py-2.5 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-3" key={item.id}>
            <p className={`text-phx-sm font-bold tabular-nums ${LANDING_INK}`}>
              {formatDayName(item.activityDate)} {formatDate(item.activityDate)}
              {times ? <span className="block font-semibold text-slate-500">{times}</span> : null}
            </p>
            <div className="min-w-0 break-words" dir="auto">
              <p className={`text-phx-md font-bold ${LANDING_INK}`}>{itemTitle(item)}</p>
              {place ? <p className="text-phx-sm font-semibold text-slate-600">{place}</p> : null}
              {item.doubleVisitMedicalRepName ? (
                <p className="text-phx-sm font-semibold text-slate-600">With {item.doubleVisitMedicalRepName}</p>
              ) : null}
              {item.objective ? <p className="text-phx-sm font-semibold text-slate-500">{item.objective}</p> : null}
              {item.notes ? <p className="text-phx-sm text-slate-500">{item.notes}</p> : null}
              {item.returnNotes.map((note) => (
                <p className="mt-1 border-l-[3px] border-amber-500 pl-2 text-phx-sm font-semibold text-amber-800" key={note.id}>
                  Returned: {note.note}
                </p>
              ))}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function PlanCard({ onToggle, open, plan }: { onToggle: () => void; open: boolean; plan: EmployeePlan }) {
  return (
    <section className={`min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
      <button
        aria-expanded={open}
        className={`flex w-full min-w-0 items-stretch gap-3 py-3 pl-0 pr-3 text-left sm:pr-4 ${LANDING_ROW_LINK}`}
        onClick={onToggle}
        type="button"
      >
        <span aria-hidden="true" className={`w-1 shrink-0 ${statusRail(plan.status)}`} />
        <span className="flex min-w-0 flex-1 items-start justify-between gap-3">
          <span className="min-w-0">
            <span className={`block break-words text-phx-md font-bold ${LANDING_INK}`}>
              {planNounLabel(plan.planKind)} · {planPeriodShortLabel(plan)}
            </span>
            <span className="mt-0.5 block break-words text-phx-sm font-semibold tabular-nums text-slate-500">
              {formatDate(plan.periodStartDate)} to {formatDate(plan.periodEndDate)} · {plan.items.length}{" "}
              {plan.items.length === 1 ? "day" : "days"}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <span className={`${planStatusWordClassName} ${statusInk(plan.status)}`}>
              {statusLabels[plan.status]}
            </span>
            {open ? <ChevronUp aria-hidden="true" className="h-4 w-4 text-slate-500" /> : <ChevronDown aria-hidden="true" className="h-4 w-4 text-slate-500" />}
          </span>
        </span>
      </button>
      {open ? (
        <div className="border-t border-slate-200">
          <PlanItems plan={plan} />
          <div className="border-t border-slate-200 px-3 pb-4 pt-3 sm:px-4">
            <PlanDecisionTimeline decisions={plan.decisions} />
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function PlansHistory({ openPlanId, plans }: { openPlanId?: string | null; plans: EmployeePlan[] }) {
  const [kind, setKind] = useState<KindFilter>("all");
  const [openId, setOpenId] = useState<string | null>(openPlanId ?? null);

  // A draft whose week went forward on a later plan is never listed beside it (splitDraftsReplacedByALaterPlan).
  const { kept, replaced } = useMemo(() => splitDraftsReplacedByALaterPlan(plans), [plans]);
  const shown = useMemo(
    () =>
      kept
        .filter((plan) => kind === "all" || plan.planKind === kind)
        .sort(
          (left, right) =>
            right.periodStartDate.localeCompare(left.periodStartDate) || right.revision - left.revision,
        ),
    [kind, kept],
  );

  return (
    <div className="min-w-0 space-y-4">
      <div className={`flex min-w-0 gap-3 border border-slate-200 bg-white py-3 pr-3 sm:pr-4 ${adminSoftDepthClassName}`}>
        <span aria-hidden="true" className="w-1 shrink-0 bg-[#08111f]" />
        <Lock aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
        <div className="min-w-0">
          <p className={`text-phx-xs font-black uppercase tracking-[0.12em] ${LANDING_INK}`}>Read only</p>
          <p className="mt-1 break-words text-phx-md font-semibold text-slate-600">
            Your week is planned in Phoenix CRM now. These are the plans you filed on this form before. Nothing can be
            added or changed here.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <LandingCta href={`${PHOENIX_CRM_PORTAL_BASE}?tab=plan`} variant="solid">
              Plan your week in Phoenix CRM
            </LandingCta>
            <LandingCta href="/employee-portals/plans/calendar">
              <CalendarDays aria-hidden="true" className="h-4 w-4" />
              Calendar
            </LandingCta>
          </div>
        </div>
      </div>

      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <ChoiceGroup
          aria-label="Plan type"
          className="grid-cols-3 sm:w-72"
          onChange={setKind}
          options={KIND_OPTIONS}
          value={kind}
        />
        <p className={`text-phx-sm font-bold uppercase tracking-[0.08em] tabular-nums ${LANDING_INK}`}>
          {shown.length} {shown.length === 1 ? "plan" : "plans"}
          {replaced.length > 0 ? (
            <span className="block break-words text-phx-xs font-semibold normal-case tracking-normal text-slate-500">
              {replaced.length} unsent {replaced.length === 1 ? "draft" : "drafts"} replaced by a later plan not shown
            </span>
          ) : null}
        </p>
      </div>

      {shown.length === 0 ? (
        <div className={`border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
          <LandingEmpty>{plans.length === 0 ? "You did not file any plan on this form." : "No plan of this type."}</LandingEmpty>
        </div>
      ) : (
        <div className="space-y-2">
          {shown.map((plan) => (
            <PlanCard
              key={plan.id}
              onToggle={() => setOpenId((current) => (current === plan.id ? null : plan.id))}
              open={openId === plan.id}
              plan={plan}
            />
          ))}
        </div>
      )}
    </div>
  );
}
