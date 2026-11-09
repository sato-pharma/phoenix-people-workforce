"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { CoverageFilterSelection } from "@/lib/crm/coverage-filters";
import { PLAN_STATUS_FILTERS, type PlanStatusCounts, type PlanStatusFilter } from "@/lib/crm/plan-status-filter";
import { phxSelectClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

/**
 * The status filter on Reps Weekly Plans.
 *
 * The owner, 2026-09-02: make "the admin, or any role who has the authority" able to "filter by
 * verified plan and non-verified plan".
 *
 * TWO WAYS TO SET ONE THING, and that is deliberate rather than redundant. The tiles above the rep
 * grid are the same four groups and are now clickable, which is the gesture a manager reaches for —
 * he is already reading "Awaiting you 3" when he decides he wants those three. But a number is not
 * obviously a control, so the filter also appears here as a labelled select beside the week, in the
 * same vocabulary as every other filter on this board. Both write the SAME `status` parameter, so
 * there is one state and no way for the two to disagree.
 *
 * Same shape as the week picker beside it — a URL change, never client state — so every pick
 * re-enters the page and re-runs the access gate rather than filtering a payload already in the
 * browser, and a manager can bookmark or send "my reps still waiting on me this week".
 */

// slate-500, not slate-400: the label is the only name a control has, and 400 on white read as disabled (premium
// pass, 2026-11-09). The same string in all three Reps List control files, so a row of them never mixes two greys.
const LABEL_CLASS = "block text-phx-3xs font-black uppercase tracking-[0.16em] text-slate-500";
/**
 * `text-sm`, matching the week picker and the cascade selects exactly. Do NOT shrink it:
 * `app/globals.css` RULE 3 floors every form control inside the admin and portal shells at
 * `max(16px, 1em)` below 768px, so a smaller class computes to 16px anyway — and if it ever did
 * apply it would reintroduce the iOS Safari focus-zoom that rule exists to kill.
 */
const SELECT_CLASS = cn(phxSelectClassName, "h-9 w-full px-2 disabled:text-slate-400");

/**
 * What each option is called.
 *
 * "No plan filed" is its own option and is NEVER merged into a single "not verified". A rep who
 * filed nothing has not planned his week; a rep whose plan is pending is waiting on his manager.
 * One option covering both would hand a manager a list mixing people he should ring with people he
 * should sign for — see `PLAN_STATUS_FILTERS`.
 */
const STATUS_LABEL: Record<PlanStatusFilter, string> = {
  all: "All reps",
  awaiting: "Awaiting verification",
  missing: "No plan filed",
  verified: "Verified",
};

export function PlanStatusPicker({
  basePath,
  counts,
  selection,
  status,
  week,
}: {
  basePath: string;
  /** Shown in each option, so the select answers "how many?" without the reader looking away. */
  counts: PlanStatusCounts;
  selection: CoverageFilterSelection;
  status: PlanStatusFilter;
  week: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  const apply = (value: string) => {
    const next = new URLSearchParams();
    // The tab and the week are carried explicitly. Dropping either sends the manager back to the
    // contact list on the current week, which is what happens the moment one is forgotten.
    next.set("tab", "plans");
    next.set("week", week);
    if (selection.line) next.set("line", selection.line);
    if (selection.region) next.set("region", selection.region);
    if (selection.area) next.set("area", selection.area);
    // `rep` and `plan` are deliberately NOT carried. Narrowing the grid is a browsing action, and a
    // rep left selected keeps his plan on screen and the grid hidden — so the filter would appear
    // to do nothing at all, on the one interaction whose whole purpose is visible.
    if (value && value !== "all") next.set("status", value);
    setPending(true);
    router.push(`${basePath}?${next.toString()}`);
  };

  return (
    <label className="block">
      <span className={LABEL_CLASS}>Plan status</span>
      <select
        className={`mt-1 ${SELECT_CLASS}`}
        disabled={pending}
        onChange={(event) => apply(event.target.value)}
        value={status}
      >
        {PLAN_STATUS_FILTERS.map((option) => (
          <option key={option} value={option}>
            {`${STATUS_LABEL[option]} (${counts[option]})`}
          </option>
        ))}
      </select>
    </label>
  );
}
