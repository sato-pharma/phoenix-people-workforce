"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { DirectOrdersTabStrip } from "@/components/direct-orders/workspace/direct-orders-tab-strip";
import type { DirectOrderWorkspaceTabKey } from "@/lib/direct-orders/workspace-data";

/**
 * Which group each desk belongs to. The SAME grouping the workspace's own desk tabs use — matched
 * on the route slug so the nav registry stays a plain list of pages, and adding a desk means adding
 * one slug in one place.
 */
const DESK_GROUP: Record<string, DirectOrderWorkspaceTabKey> = {
  validations: "pharmacy-control",
  held: "pharmacy-control",
  pharmacies: "pharmacy-control",
  "pharmacy-variances": "pharmacy-control",
  cleanup: "pharmacy-control",
  report: "reports",
  "rep-counters": "reports",
  reconciliation: "reports",
  "approval-exceptions": "reports",
  caps: "controls",
};

/**
 * The persistent frame around every Direct Orders desk.
 *
 * WHAT THIS FIXES. The desk tabs used to render a grid of links OUT of the workspace. Opening
 * Pharmacy Validation or the Held Desk replaced the whole page: the tab strip vanished, the only
 * way back was the browser's Back button, and a Super Admin moving between the validation queue and
 * the held lane — which is one job, done in two places — left and re-entered the module each time.
 * "One place" stopped at the edge of the workspace route.
 *
 * The strip now sits above every desk, and because it lives in a LAYOUT for the `(desks)` route
 * group it does not remount as you move between them. The route group is why: it scopes this frame
 * to the ten desks without touching `/new` or `/[id]`, which are focused single-purpose screens
 * that a tab strip would only clutter — and route groups do not appear in the URL, so not one desk
 * link had to change.
 *
 * The desk keeps its own heading. The strip says which module you are in; the heading says which
 * desk. Replacing the desk headings with a single generic one would have cost more than it saved.
 */
export function DirectOrdersDeskShell({
  tabs,
  basePath,
  children,
}: {
  tabs: readonly DirectOrderWorkspaceTabKey[];
  basePath: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname() ?? "";
  const slug = pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length + 1).split("/")[0] : "";
  // An unmapped desk highlights nothing rather than guessing. A wrong "you are here" is worse than
  // none — it tells the reader the module is somewhere it is not.
  const activeTab = DESK_GROUP[slug] ?? null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href={basePath}
          className="inline-flex min-h-[40px] items-center gap-1.5 text-phx-sm font-black uppercase tracking-wide text-slate-500 hover:text-orange-700"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Direct Orders
        </Link>
        <DirectOrdersTabStrip tabs={tabs} activeTab={activeTab} basePath={basePath} />
      </div>
      {children}
    </div>
  );
}
