import Link from "next/link";

import type { CoverageFilterSelection } from "@/lib/crm/coverage-filters";

/**
 * The Reps List tab strip — Contact List and Reps Weekly Plans.
 *
 * ## This is not the tab strip that was retired
 *
 * `DistrictManagerTabs` was removed on 2026-08-31 when the owner retired Doctor List: it put two
 * boards over the SAME data behind two tabs, and "a one-item tab strip is not a tab strip" once one
 * of them went. This strip is the opposite case — two different questions about one rep, asked from
 * one picker: what is on his list, and what has he planned this week. The owner asked for it on
 * 2026-09-01 in those words: "another tab called Reps Weekly Plans".
 *
 * ## It renders NOTHING when the viewer has only one tab
 *
 * Plan verification admits a strictly shorter role list than Reps List does — National Sales Manager
 * and SFE Manager reach the contact list and are deliberately refused the plans, because reading a
 * rep's list and signing his plan are not the same authority. For those seats this returns null and
 * the page looks exactly as it did before the tab existed, rather than showing a tab that answers
 * "not available to your role" when pressed.
 */

export type RepsListTab = "contacts" | "plans";

export function resolveRepsListTab(value: string | undefined): RepsListTab {
  return value === "plans" ? "plans" : "contacts";
}

/** The current cascade as a query string, with the tab set and the week carried when it applies. */
function tabHref(input: {
  basePath: string;
  selection: CoverageFilterSelection;
  tab: RepsListTab;
  week: string | null;
}): string {
  const query = new URLSearchParams();
  // Switching tabs KEEPS the rep. A manager who has just read a rep's contact list and presses
  // Plans means "this rep's plans" — dropping the selection would send him back to the picker to
  // choose the same person again.
  if (input.selection.line) query.set("line", input.selection.line);
  if (input.selection.region) query.set("region", input.selection.region);
  if (input.selection.area) query.set("area", input.selection.area);
  if (input.selection.rep) query.set("rep", input.selection.rep);
  if (input.tab === "plans") {
    query.set("tab", "plans");
    if (input.week) query.set("week", input.week);
  }
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
  if (!canSeePlans) return null;

  const tabs: Array<{ key: RepsListTab; label: string }> = [
    { key: "contacts", label: "Contact list" },
    { key: "plans", label: "Reps weekly plans" },
  ];

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
                ? "border-b-2 border-orange-500 px-5 py-3 text-phx-xs font-black uppercase tracking-[0.14em] text-slate-900"
                : "border-b-2 border-transparent px-5 py-3 text-phx-xs font-black uppercase tracking-[0.14em] text-slate-400 transition-colors hover:text-slate-700"
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
