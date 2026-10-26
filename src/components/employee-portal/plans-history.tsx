"use client";

import { CalendarDays, ChevronDown, ChevronUp, Lock } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import {
  formatDate,
  formatDayName,
  PlanDecisionTimeline,
  statusLabels,
  statusTone,
} from "@/components/employee-portal/plans-workspace";
import {
  adminChipDepthClassName,
  adminRecessedDepthClassName,
  adminSoftDepthClassName,
} from "@/components/admin/admin-design-tokens";
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
    return <p className="px-4 pb-4 text-sm font-semibold text-slate-500">This plan holds no days.</p>;
  }
  return (
    <ul className="px-4 pb-2">
      {items.map((item) => {
        const place = itemPlace(item);
        const times = itemTimes(item);
        return (
          <li className="grid gap-1 border-t border-slate-100 py-2.5 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-3" key={item.id}>
            <p className="text-xs font-black text-slate-700">
              {formatDayName(item.activityDate)} {formatDate(item.activityDate)}
              {times ? <span className="block font-semibold text-slate-500">{times}</span> : null}
            </p>
            <div className="min-w-0 break-words">
              <p className="text-sm font-black text-slate-900">{itemTitle(item)}</p>
              {place ? <p className="text-xs font-semibold text-slate-600">{place}</p> : null}
              {item.doubleVisitMedicalRepName ? (
                <p className="text-xs font-semibold text-slate-600">With {item.doubleVisitMedicalRepName}</p>
              ) : null}
              {item.objective ? <p className="text-xs font-semibold text-slate-500">{item.objective}</p> : null}
              {item.notes ? <p className="text-xs text-slate-500">{item.notes}</p> : null}
              {item.returnNotes.map((note) => (
                <p className="mt-1 border-l-2 border-amber-300 pl-2 text-xs font-semibold text-amber-800" key={note.id}>
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
        className="flex w-full min-w-0 items-start justify-between gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-orange-50/40"
        onClick={onToggle}
        type="button"
      >
        <span className="min-w-0">
          <span className="block text-sm font-black text-slate-900">
            {planNounLabel(plan.planKind)} · {planPeriodShortLabel(plan)}
          </span>
          <span className="mt-0.5 block text-xs font-semibold text-slate-500">
            {formatDate(plan.periodStartDate)} to {formatDate(plan.periodEndDate)} · {plan.items.length}{" "}
            {plan.items.length === 1 ? "day" : "days"}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className={`border px-2 py-1 text-phx-xs font-black ${statusTone(plan.status)}`}>
            {statusLabels[plan.status]}
          </span>
          {open ? <ChevronUp className="h-4 w-4 text-slate-500" /> : <ChevronDown className="h-4 w-4 text-slate-500" />}
        </span>
      </button>
      {open ? (
        <div className="border-t border-slate-200">
          <PlanItems plan={plan} />
          <div className="px-4 pb-4">
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
      <div className={`flex min-w-0 items-start gap-3 border border-slate-200 bg-slate-50 p-4 ${adminRecessedDepthClassName}`}>
        <Lock aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
        <div className="min-w-0">
          <p className="text-sm font-black text-slate-900">Read only</p>
          <p className="mt-1 text-sm font-semibold text-slate-600">
            Your week is planned in Phoenix CRM now. These are the plans you filed on this form before. Nothing can be
            added or changed here.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link
              className="inline-flex h-10 items-center border border-orange-200 bg-orange-50 px-3 text-sm font-black text-orange-700 hover:border-orange-300 hover:bg-orange-100"
              href={`${PHOENIX_CRM_PORTAL_BASE}?tab=plan`}
            >
              Plan your week in Phoenix CRM
            </Link>
            <Link
              className={`inline-flex h-10 items-center gap-1.5 border border-slate-200 bg-white px-3 text-sm font-black text-slate-700 hover:border-orange-300 hover:bg-orange-50 ${adminChipDepthClassName}`}
              href="/employee-portals/plans/calendar"
            >
              <CalendarDays className="h-4 w-4" />
              Calendar
            </Link>
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
        <p className="text-sm font-black text-slate-700">
          {shown.length} {shown.length === 1 ? "plan" : "plans"}
          {replaced.length > 0 ? (
            <span className="block text-xs font-semibold text-slate-500">
              {replaced.length} unsent {replaced.length === 1 ? "draft" : "drafts"} replaced by a later plan not shown
            </span>
          ) : null}
        </p>
      </div>

      {shown.length === 0 ? (
        <p className={`border border-slate-200 bg-white p-4 text-sm font-semibold text-slate-500 ${adminSoftDepthClassName}`}>
          {plans.length === 0 ? "You did not file any plan on this form." : "No plan of this type."}
        </p>
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
