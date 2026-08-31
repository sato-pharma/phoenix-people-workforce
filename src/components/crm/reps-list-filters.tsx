"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { CoverageFilterOptions, CoverageFilterSelection } from "@/lib/crm/reps-list-board";

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

const LABEL_CLASS = "block text-phx-3xs font-black uppercase tracking-[0.16em] text-slate-400";
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
const SELECT_CLASS =
  "h-9 w-full border border-slate-200 bg-white px-2 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 disabled:bg-slate-50 disabled:text-slate-400";

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
  selection,
}: {
  basePath: string;
  options: CoverageFilterOptions;
  selection: CoverageFilterSelection;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  const apply = (key: string, value: string, clears: readonly string[]) => {
    const next = new URLSearchParams();
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

  return (
    <div className="grid gap-3 px-5 py-4 sm:grid-cols-2 lg:grid-cols-4">
      {LEVELS.map((level) => {
        const list = options[level.options];
        // A level with nothing to offer is disabled rather than hidden: the owner asked for four
        // filters and a filter that vanishes reads as a broken page, while a disabled one reads as
        // "choose the level above first", which is what is actually true.
        const disabled = pending || list.length === 0;
        return (
          <label className="block" key={level.key}>
            <span className={LABEL_CLASS}>{level.label}</span>
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
  );
}
