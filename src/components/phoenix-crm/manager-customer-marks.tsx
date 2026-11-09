"use client";

/**
 * The marks on each customer of a manager's plan board (owner, 2026-10-23) — what each one means is in
 * `manager-customer-marks-rules.ts`. Drawn for the MANAGER only; the rep's own screens never import this.
 *
 *   - The card's left edge is the customer's grade: A dark, B mid, C light — one colour family, flat.
 *   - Square pips are the rep's visits this month against the grade's number ("2 of 3"); one past the
 *     number is amber, since over is a deviation too. Square, never round (the square-edge golden rule).
 *   - "With you" / "Your single visit" when the manager himself saw the customer this month.
 *   - The marketing chip opens that request, in a new tab so the half-day he is planning stays on screen.
 *   - The group bar above the list: every feature a group of the shown customers shares, each colouring
 *     its customers when pressed — and "Go first" on the few worth his half-day most.
 */

import type { ReactNode } from "react";

import { crmUrl, useCrmGet } from "@/components/phoenix-crm/api";
import { useCrmSurface } from "@/components/phoenix-crm/surface";
import {
  customerGroups,
  frequencyPips,
  frequencyStanding,
  frequencyText,
  suggestionReason,
  type CustomerGroup,
  type CustomerGroupTone,
  type CustomerInsight,
  type CustomerInsightView,
  type GroupableCustomer,
} from "@/lib/phoenix-crm/manager-customer-marks-rules";
import { resolveMarketingRequestDestination } from "@/lib/marketing-requests/notification-link";
import { cn } from "@/lib/utils";

const INSIGHT = "/api/phoenix-crm/manager-plans/customers/insight";

/** The marks for the customers of these territories (and his own list), for the month of `date`. */
export function useCustomerInsight(input: { seats: ReadonlyArray<string>; own?: boolean; date: string; test: boolean }) {
  const seats = [...new Set(input.seats)].sort().join(",");
  return useCrmGet<CustomerInsightView>(seats ? crmUrl(INSIGHT, { seats, own: input.own, date: input.date, test: input.test }) : null, "insight");
}

const GRADE_EDGE: Record<string, string> = {
  A: "border-l-sky-900",
  B: "border-l-sky-500",
  C: "border-l-sky-200",
};

const GRADE_CHIP: Record<string, string> = {
  A: "border-sky-900 bg-sky-900 text-white",
  B: "border-sky-500 bg-sky-500 text-white",
  C: "border-sky-200 bg-sky-50 text-sky-800",
};

const TONE: Record<CustomerGroupTone, { chip: string; on: string; card: string }> = {
  violet: { chip: "border-violet-300 text-violet-800", on: "border-violet-700 bg-violet-700 text-white", card: "bg-violet-50 outline-violet-400" },
  rose: { chip: "border-rose-300 text-rose-800", on: "border-rose-700 bg-rose-700 text-white", card: "bg-rose-50 outline-rose-400" },
  amber: { chip: "border-amber-300 text-amber-900", on: "border-amber-600 bg-amber-600 text-white", card: "bg-amber-50 outline-amber-400" },
  emerald: { chip: "border-emerald-300 text-emerald-800", on: "border-emerald-700 bg-emerald-700 text-white", card: "bg-emerald-50 outline-emerald-400" },
  sky: { chip: "border-sky-300 text-sky-800", on: "border-sky-700 bg-sky-700 text-white", card: "bg-sky-50 outline-sky-400" },
  teal: { chip: "border-teal-300 text-teal-800", on: "border-teal-700 bg-teal-700 text-white", card: "bg-teal-50 outline-teal-400" },
  indigo: { chip: "border-indigo-300 text-indigo-800", on: "border-indigo-700 bg-indigo-700 text-white", card: "bg-indigo-50 outline-indigo-400" },
  slate: { chip: "border-slate-300 text-slate-700", on: "border-slate-700 bg-slate-700 text-white", card: "bg-slate-100 outline-slate-400" },
};

/** One customer's card: the grade edge, and the tint of the group he is in when that group is pressed. */
export function CustomerCard({
  children,
  grade,
  highlight,
  dimmed,
}: {
  children: ReactNode;
  grade: string | null;
  highlight: CustomerGroupTone | null;
  dimmed: boolean;
}) {
  return (
    <div
      className={cn(
        "min-w-0 border border-l-4 border-slate-200 p-2.5",
        GRADE_EDGE[grade ?? ""] ?? "border-l-slate-200",
        highlight && cn("outline outline-2 -outline-offset-2", TONE[highlight].card),
        dimmed && "opacity-60",
      )}
    >
      {children}
    </div>
  );
}

function Pips({ insight }: { insight: CustomerInsight }) {
  const { pips, more } = frequencyPips(insight.repVisits, insight.target);
  if (pips.length === 0) return null;
  const standing = frequencyStanding(insight.repVisits, insight.target);
  const onTarget = standing === "on" || standing === "over";
  return (
    <span aria-hidden className="inline-flex items-center gap-0.5">
      {pips.map((pip, index) => (
        <span
          className={cn(
            "inline-block h-2 w-2 border",
            pip === "done" && (onTarget ? "border-emerald-700 bg-emerald-700" : "border-slate-800 bg-slate-800"),
            pip === "due" && "border-slate-400 bg-white",
            pip === "over" && "border-amber-600 bg-amber-500",
          )}
          key={index}
        />
      ))}
      {more > 0 ? <span className="text-phx-sm font-black text-slate-500">{`+${more}`}</span> : null}
    </span>
  );
}

/** The marks under a customer's name. Nothing while the marks are still loading — the card reads as before. */
export function CustomerMarks({ insight, monthName, suggested }: { insight: CustomerInsight | undefined; monthName: string; suggested: boolean }) {
  const surface = useCrmSurface();
  if (!insight) return null;
  const standing = frequencyStanding(insight.repVisits, insight.target);
  const isOwnList = insight.listType === null;
  return (
    <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      {insight.grade ? (
        <span className={cn("inline-flex h-4 min-w-4 items-center justify-center border px-1 text-phx-sm font-black", GRADE_CHIP[insight.grade])}>{insight.grade}</span>
      ) : null}
      {!isOwnList ? (
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <Pips insight={insight} />
          <span
            className={cn(
              "text-xs font-bold",
              standing === "behind" ? "text-rose-700" : standing === "over" ? "text-amber-800" : standing === "on" ? "text-emerald-700" : "text-slate-500",
            )}
          >
            {frequencyText(insight.repVisits, insight.target, monthName)}
          </span>
        </span>
      ) : null}
      {insight.withYou > 0 ? (
        <span className="border border-emerald-300 bg-emerald-50 px-1.5 text-phx-sm font-black uppercase tracking-[0.06em] text-emerald-800">
          {insight.withYou === 1 ? "With you" : `With you ×${insight.withYou}`}
        </span>
      ) : null}
      {insight.yourOwn > 0 ? (
        <span className="border border-teal-300 bg-teal-50 px-1.5 text-phx-sm font-black uppercase tracking-[0.06em] text-teal-800">
          {insight.yourOwn === 1 ? "Your single visit" : `Your single visits ×${insight.yourOwn}`}
        </span>
      ) : null}
      {insight.marketing.map((mark) => (
        <a
          className="border border-violet-300 bg-violet-50 px-1.5 text-phx-sm font-black uppercase tracking-[0.06em] text-violet-800 underline-offset-2 hover:underline"
          href={resolveMarketingRequestDestination({ navigationMode: surface === "admin" ? "admin" : "employee-portal", requestId: mark.requestId })}
          key={mark.requestId}
          onClick={(event) => event.stopPropagation()}
          rel="noreferrer"
          target="_blank"
          title={mark.byName ? "Matched by the customer's name on the rep's list" : undefined}
        >
          {`Marketing · ${mark.code}${mark.typeName ? ` · ${mark.typeName}` : ""} · ${mark.statusLabel}${mark.byName ? " · by name" : ""}`}
        </a>
      ))}
      {suggested ? (
        <span className="border border-orange-300 bg-orange-50 px-1.5 text-phx-sm font-black uppercase tracking-[0.06em] text-orange-800" title={suggestionReason(insight)}>
          Go first
        </span>
      ) : null}
    </span>
  );
}

/** The groups the shown customers fall into; pressing one colours its customers and fades the rest. */
export function CustomerGroupBar({
  customers,
  insight,
  active,
  onActive,
}: {
  customers: ReadonlyArray<GroupableCustomer>;
  insight: CustomerInsightView | null;
  active: string | null;
  onActive: (key: string | null) => void;
}) {
  if (!insight) return null;
  const groups = customerGroups(customers, insight.insights, insight.monthName);
  return (
    <div className="grid min-w-0 gap-2">
      <p className="break-words text-xs font-semibold leading-5 text-slate-500">
        {insight.monthAhead
          ? `${insight.monthName} has not started, so no visit counts in it yet. The edge of each card is the grade: A dark, B mid, C light.`
          : `The edge of each card is the grade (A dark, B mid, C light). The squares are the rep's visits in ${insight.monthName} against the grade's number. Press a group to colour its customers.`}
      </p>
      {groups.length > 0 ? (
        <div className="flex min-w-0 flex-wrap gap-1.5">
          {groups.map((group) => (
            <GroupChip active={active === group.key} group={group} key={group.key} onPress={() => onActive(active === group.key ? null : group.key)} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function GroupChip({ active, group, onPress }: { active: boolean; group: CustomerGroup; onPress: () => void }) {
  return (
    <button
      aria-pressed={active}
      className={cn("inline-flex max-w-full items-center gap-1.5 border px-2 py-1 text-left text-xs font-bold", active ? TONE[group.tone].on : cn("bg-white hover:bg-slate-50", TONE[group.tone].chip))}
      onClick={onPress}
      title={group.hint}
      type="button"
    >
      <span className="break-words" dir="auto">
        {group.label}
      </span>
      <span className={cn("text-phx-sm font-black", active ? "text-white" : "text-slate-500")}>{group.ids.length}</span>
    </button>
  );
}

/** The highlight a customer wears under the pressed group, and whether he fades because he is not in it. */
export function groupLook(groupKey: string | null, groups: ReadonlyArray<CustomerGroup>, id: string): { highlight: CustomerGroupTone | null; dimmed: boolean } {
  const group = groupKey ? groups.find((entry) => entry.key === groupKey) : undefined;
  if (!group) return { highlight: null, dimmed: false };
  return group.ids.includes(id) ? { highlight: group.tone, dimmed: false } : { highlight: null, dimmed: true };
}
