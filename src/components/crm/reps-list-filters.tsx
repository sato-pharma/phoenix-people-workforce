"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { CoverageFilterOptions, CoverageFilterSelection } from "@/lib/crm/reps-list-board";
import { phxSelectClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

// Client half of Reps List — the Line -> Region -> Area -> Rep cascade.
//
// Styling copies doctor-list-tables.tsx verbatim (flat borders, orange focus accent, the same
// LABEL/SELECT class pair) because this board replaces it in the same shell and must not read as a
// one-off. Owner's standing rule.
//
// EVERY CHANGE IS A URL CHANGE, NOT CLIENT STATE. The set of reps a viewer may see is a server
// decision, so each pick re-enters the page and re-runs the access gate rather than filtering a
// payload already in the browser. It also means a manager can bookmark or share one rep's list.
//
// PICKING A LEVEL CLEARS THE LEVELS BELOW IT. Choosing a different line while an area from the old
// line is still selected would otherwise submit a pair that no rep occupies — which the server
// prunes correctly, but only after a round trip that looks to the user like the filter was ignored.

// slate-500, not slate-400: the label is the only name a control has, and 400 on white read as disabled (premium
// pass, 2026-11-09). The same string in all three Reps List control files, so a row of them never mixes two greys.
const LABEL_CLASS = "block text-phx-xs font-black uppercase tracking-[0.16em] text-slate-500";
/**
 * `text-sm`, and DO NOT shrink it to make a long rep name fit on a phone. That was tried here on
 * 2026-09-01 and is wrong twice over.
 *
 * The measurement is real: at 375px the Medical rep picker holds 322px of text in a 307px box, so
 * the browser clips a typical 34-character name. It is the one control on this board that cannot
 * honour the owner's fits-the-screen golden rule by wrapping, because a native `<select>` never
 * wraps its selected option at any font size.
 *
 * But `text-xs` does not fix it and cannot. `app/globals.css` RULE 3 floors EVERY form control
 * inside `.admin-shell` and `.employee-portal-shell` at `max(16px, 1em)` below 768px, deliberately:
 * iOS Safari zooms the whole page in when a control under 16px takes focus and LEAVES it zoomed
 * after blur. So a smaller class here computes to 16px anyway — measured, `text-xs` and `text-sm`
 * both resolve to 16px at 375px — and if it ever did apply it would reintroduce the zoom defect
 * that rule was written to kill. Shrinking a phone control is not available as a tool here.
 *
 * The real answer is already in place: nothing on this screen lives only inside this select. The
 * chosen rep's full name is printed in the section heading above it and on every rep card, so the
 * clipped text is a duplicate, never the only copy. Fix a future complaint there, not with a size.
 */
const SELECT_CLASS = cn(phxSelectClassName, "h-9 w-full px-2 disabled:text-slate-400");

/** The cascade order the owner specified. `clears` is every level below this one. */
const LEVELS = [
  { clears: ["region", "area", "rep"], key: "line", label: "Line", options: "lines" },
  { clears: ["area", "rep"], key: "region", label: "Region", options: "regions" },
  { clears: ["rep"], key: "area", label: "Area", options: "areas" },
  { clears: [], key: "rep", label: "Medical rep", options: "reps" },
] as const;

export function RepsListFilters({
  basePath,
  options,
  preserve,
  selection,
  withRep,
}: {
  basePath: string;
  options: CoverageFilterOptions;
  /**
   * Query parameters that are not part of the cascade and must survive a pick — the open tab and
   * the chosen week.
   *
   * Without this the cascade rebuilt the URL from its own four levels alone, so on the Reps Weekly
   * Plans tab choosing a line would drop the tab and the week and bounce the manager back to tab
   * one on the current week. The cascade is shared by both tabs precisely so they can never offer
   * different reps; carrying the rest of the URL is the price of sharing it.
   */
  preserve?: Record<string, string | undefined>;
  selection: CoverageFilterSelection;
  /**
   * False on the Vacant Areas tab. A vacant area has nobody in the seat, so a Medical rep picker
   * there could only ever read "No medical rep available" — a control that looks broken.
   */
  withRep?: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const levels = withRep === false ? LEVELS.filter((level) => level.key !== "rep") : LEVELS;

  const apply = (key: string, value: string, clears: readonly string[]) => {
    const next = new URLSearchParams();
    for (const [name, carried] of Object.entries(preserve ?? {})) {
      if (carried) next.set(name, carried);
    }
    for (const level of LEVELS) {
      if (level.key === key) continue;
      if (clears.includes(level.key)) continue;
      const current = selection[level.key];
      if (current) next.set(level.key, current);
    }
    if (value) next.set(key, value);
    setPending(true);
    const query = next.toString();
    router.push(query ? `${basePath}?${query}` : basePath);
  };

  // How many cascade levels are narrowed — the count beside "Clear filters", and whether that control shows at all.
  const narrowed = levels.filter((level) => Boolean(selection[level.key])).length;
  const clearAll = () => {
    const next = new URLSearchParams();
    for (const [name, carried] of Object.entries(preserve ?? {})) {
      if (carried) next.set(name, carried);
    }
    setPending(true);
    const query = next.toString();
    router.push(query ? `${basePath}?${query}` : basePath);
  };

  return (
    <div className="px-5 py-4">
      {/* The cascade's own heading line: what it is, how much of it is narrowed, and the one way to undo every pick
          at once. A pick in progress says so in words, because the selects disable while the page re-enters. */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">
          {pending ? "Applying the filter" : narrowed > 0 ? `Filtered · ${narrowed} of ${levels.length} levels` : "Filters · showing everything in your reach"}
        </p>
        {narrowed > 0 ? (
          <button
            className="inline-flex min-h-11 items-center border border-slate-300 bg-white px-3 py-1 text-phx-sm font-black uppercase tracking-[0.12em] text-slate-700 transition-colors hover:border-orange-400 hover:text-orange-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 disabled:text-slate-400 md:min-h-0"
            disabled={pending}
            onClick={clearAll}
            type="button"
          >
            Clear filters
          </button>
        ) : null}
      </div>
      <div className={`grid gap-3 sm:grid-cols-2 ${levels.length === 3 ? "lg:grid-cols-3" : "lg:grid-cols-4"}`}>
      {levels.map((level) => {
        const list = options[level.options];
        // A level with nothing to offer is disabled rather than hidden: the owner asked for four
        // filters and a filter that vanishes reads as a broken page, while a disabled one reads as
        // "choose the level above first", which is what is actually true.
        const disabled = pending || list.length === 0;
        return (
          <label className="block" key={level.key}>
            <span className={LABEL_CLASS}>
              {level.label}
              {selection[level.key] ? <span className="ml-1.5 text-orange-700">· set</span> : null}
            </span>
            <select
              className={`mt-1 ${SELECT_CLASS}`}
              disabled={disabled}
              onChange={(event) => apply(level.key, event.target.value, level.clears)}
              value={selection[level.key] ?? ""}
            >
              <option value="">
                {list.length === 0 ? `No ${level.label.toLowerCase()} available` : `All ${level.label.toLowerCase()}s`}
              </option>
              {list.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.name}
                </option>
              ))}
            </select>
          </label>
        );
      })}
      </div>
    </div>
  );
}

/**
 * The month the ACTIVITY column is scored over — tab one only.
 *
 * A SEPARATE CONTROL FROM THE CASCADE ABOVE, and separate on purpose. The four cascade levels
 * answer "whose list"; this answers "over what window". They compose freely — every combination is
 * meaningful — so folding the month into LEVELS would wrongly make it clear the levels below it.
 *
 * IT LIVES IN THIS FILE FOR THE SELECT CLASSES. The long note on SELECT_CLASS above applies here
 * unchanged: it must not be shrunk to fit a phone, because `globals.css` floors every control at
 * 16px below 768px to stop iOS Safari zooming the page. A month label is short, so unlike the rep
 * picker this one has room to spare — but a future "fix" that shrinks it would be wrong for exactly
 * the reason written up there.
 *
 * The contact list itself is NOT time-scoped and never becomes so: changing the month re-scores the
 * annotation and never adds or removes a contact. That is why this picker cannot empty the board.
 */
export function RepsListMonthPicker({
  basePath,
  month,
  options,
  preserve,
}: {
  basePath: string;
  month: string;
  options: readonly { label: string; value: string }[];
  /** The cascade and the open tab, so choosing a month does not send the reader back to all reps. */
  preserve?: Record<string, string | undefined>;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  const apply = (value: string) => {
    const next = new URLSearchParams();
    for (const [name, carried] of Object.entries(preserve ?? {})) {
      if (carried) next.set(name, carried);
    }
    if (value) next.set("month", value);
    setPending(true);
    const query = next.toString();
    router.push(query ? `${basePath}?${query}` : basePath);
  };

  return (
    <label className="block w-full sm:w-56">
      <span className={LABEL_CLASS}>Activity month</span>
      <select
        className={`mt-1 ${SELECT_CLASS}`}
        disabled={pending || options.length === 0}
        onChange={(event) => apply(event.target.value)}
        value={month}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
