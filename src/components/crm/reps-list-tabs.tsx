import Link from "next/link";

import type { CoverageFilterSelection } from "@/lib/crm/coverage-filters";

/**
 * The Reps List tab strip — Contact List, Reps Weekly Plans and Vacant Areas.
 *
 * ## This is not the tab strip that was retired
 *
 * `DistrictManagerTabs` was removed on 2026-08-31 when the owner retired Doctor List: it put two
 * boards over the SAME data behind two tabs, and "a one-item tab strip is not a tab strip" once one
 * of them went. This strip is the opposite case — different questions asked from one picker: what
 * is on a rep's list, what has he planned this week, and whose doctors sit in the areas nobody
 * covers. The owner asked for the second on 2026-09-01 ("another tab called Reps Weekly Plans") and
 * the third on 2026-09-14 ("a third tab that is showing the doctors list in vacant areas").
 *
 * ## The plans tab appears only for a viewer who may verify
 *
 * Plan verification admits a strictly shorter role list than Reps List does — National Sales Manager
 * and SFE Manager reach the contact list and are deliberately refused the plans, because reading a
 * rep's list and signing his plan are not the same authority. Vacant Areas reads the same lists as
 * the contact tab under the same scope, so every Reps List viewer gets it, and the strip therefore
 * always holds at least two tabs.
 *
 * ## The call rate is NOT a tab here — it lives on KPIs
 *
 * It was a fourth tab (the retired Reps Plans module) for a few hours on 2026-09-21, then the owner
 * took it off both shells: "since the call rate is already in the KPIs tab ... no need for it to be
 * in the reps list tab in ... managers portals and in admin accounts." The rate, and the per-rep
 * visits drill-down under it, are on the KPIs board's Call Rate tab; the two pages forward any old
 * `?tab=call-rate` link there.
 */

export type RepsListTab = "contacts" | "plans" | "vacant";

/** The tab to open. `plans` resolves only THROUGH its gate — a hand-typed `?tab=plans` from a seat
 * without it lands on the contact list rather than on a refusal. */
export function resolveRepsListTab(value: string | undefined, canSeePlans: boolean): RepsListTab {
  if (value === "vacant") return "vacant";
  if (value === "plans" && canSeePlans) return "plans";
  return "contacts";
}

/** The current cascade as a query string, with the tab set and the week carried when it applies. */
function tabHref(input: {
  basePath: string;
  selection: CoverageFilterSelection;
  tab: RepsListTab;
  week: string | null;
}): string {
  const query = new URLSearchParams();
  // Switching tabs KEEPS the geography, and the rep wherever a rep means something. A manager who
  // has just read a rep's contact list and presses Plans means "this rep's plans" — dropping the
  // selection would send him back to the picker to choose the same person again.
  if (input.selection.line) query.set("line", input.selection.line);
  if (input.selection.region) query.set("region", input.selection.region);
  if (input.selection.area) query.set("area", input.selection.area);
  // A vacant area has no rep, so the rep is not carried INTO that tab.
  if (input.tab !== "vacant") {
    if (input.selection.rep) query.set("rep", input.selection.rep);
  }
  if (input.tab === "plans") {
    query.set("tab", "plans");
    if (input.week) query.set("week", input.week);
  }
  if (input.tab === "vacant") query.set("tab", "vacant");
  const search = query.toString();
  return search ? `${input.basePath}?${search}` : input.basePath;
}

export function RepsListTabs({
  active,
  basePath,
  canSeePlans,
  selection,
  week,
}: {
  active: RepsListTab;
  basePath: string;
  canSeePlans: boolean;
  selection: CoverageFilterSelection;
  week: string | null;
}) {
  const tabs: Array<{ key: RepsListTab; label: string }> = [{ key: "contacts", label: "Contact list" }];
  if (canSeePlans) tabs.push({ key: "plans", label: "Reps weekly plans" });
  tabs.push({ key: "vacant", label: "Vacant areas" });

  return (
    // A strip, not a card: it sits directly on top of the board it switches, sharing its border so
    // the two read as one control surface rather than two stacked panels.
    <div className="flex flex-wrap gap-0 border border-b-0 border-slate-200 bg-white">
      {tabs.map((tab) => {
        const current = tab.key === active;
        return (
          <Link
            aria-current={current ? "page" : undefined}
            className={
              current
                ? "inline-flex min-h-11 items-center border-b-[3px] border-orange-500 bg-orange-50 px-5 py-3 text-phx-xs font-black uppercase tracking-[0.14em] text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
                : "inline-flex min-h-11 items-center border-b-[3px] border-transparent px-5 py-3 text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
            }
            href={tabHref({ basePath, selection, tab: tab.key, week })}
            key={tab.key}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
