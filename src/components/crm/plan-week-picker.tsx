"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { CoverageFilterSelection } from "@/lib/crm/coverage-filters";
import type { PlanWeek } from "@/lib/crm/plan-week";

/**
 * The week picker on Reps Weekly Plans.
 *
 * Same shape as the cascade beside it — a URL change, never client state — so every pick re-enters
 * the page and re-runs the access gate rather than filtering a payload already in the browser, and
 * a manager can bookmark or send one rep's week.
 *
 * FUTURE WEEKS SIT AT THE TOP, and the list is newest-first. A plan is verified BEFORE the week it
 * covers, so next week is the one this tab is opened to act on; burying it under a year of history
 * would put the useful case last. Each option says which week it is in words — the owner's standing
 * rule that a screen never shows a raw code, and a bare "2026-08-29" is one.
 */

const LABEL_CLASS = "block text-phx-3xs font-black uppercase tracking-[0.16em] text-slate-400";
/**
 * `text-sm`, matching the cascade selects exactly. Do NOT shrink it: `app/globals.css` RULE 3
 * floors every form control inside the admin and portal shells at `max(16px, 1em)` below 768px, so
 * a smaller class computes to 16px anyway — and if it ever did apply it would reintroduce the iOS
 * Safari focus-zoom that rule exists to kill.
 */
const SELECT_CLASS =
  "h-9 w-full border border-slate-200 bg-white px-2 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 disabled:bg-slate-50 disabled:text-slate-400";

/** "This week" / "Next week" / "Last week" beside the dates, so the common cases need no arithmetic. */
function weekSuffix(offset: number): string {
  if (offset === 0) return " — this week";
  if (offset === 1) return " — next week";
  if (offset === -1) return " — last week";
  return "";
}

export function PlanWeekPicker({
  basePath,
  selection,
  week,
  weeks,
}: {
  basePath: string;
  selection: CoverageFilterSelection;
  week: PlanWeek;
  weeks: PlanWeek[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  const apply = (value: string) => {
    const next = new URLSearchParams();
    // The tab is carried explicitly: changing the week must not drop the manager back onto the
    // contact list, which is what happens the moment this parameter is forgotten.
    next.set("tab", "plans");
    if (selection.line) next.set("line", selection.line);
    if (selection.region) next.set("region", selection.region);
    if (selection.area) next.set("area", selection.area);
    if (selection.rep) next.set("rep", selection.rep);
    if (value) next.set("week", value);
    setPending(true);
    router.push(`${basePath}?${next.toString()}`);
  };

  return (
    <label className="block">
      <span className={LABEL_CLASS}>Week</span>
      <select
        className={`mt-1 ${SELECT_CLASS}`}
        disabled={pending}
        onChange={(event) => apply(event.target.value)}
        value={week.key}
      >
        {weeks.map((option) => (
          <option key={option.key} value={option.key}>
            {`${option.label}${weekSuffix(option.offset)}`}
          </option>
        ))}
      </select>
    </label>
  );
}
