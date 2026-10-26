"use client";

import Link from "next/link";

import type { DirectOrderWorkspaceTabKey } from "@/lib/direct-orders/workspace-data";
import { adminRecessedDepthClassName } from "@/components/admin/admin-design-tokens";

/**
 * What each tab is CALLED. Lives here, with the strip that renders it, so the workspace and the
 * desk shell cannot disagree about a label.
 *
 * Named for the WORK, not the permission level. "Admin Tools" described who was allowed in rather
 * than what they came to do, which is exactly why everything ended up inside it.
 */
export const TAB_LABEL: Record<DirectOrderWorkspaceTabKey, string> = {
  overview: "Overview",
  "needs-action": "Needs Action",
  orders: "Orders",
  "pharmacy-control": "Pharmacy Control",
  reports: "Reports & Monitoring",
  controls: "Commercial Controls",
};

/**
 * THE Direct Orders tab strip. One definition, rendered in two places.
 *
 * It appears inside the workspace itself and — since the "one place" work — above every desk under
 * `(desks)/`, so opening Pharmacy Validation or the Held Desk no longer feels like leaving the
 * module. Writing it twice is how this module ended up correcting the word "Approved" in four
 * files, so it is a component rather than a copied block.
 *
 * NAVIGATION, NOT STATE. Each tab is a real `<Link>` to `?view=`, which is what lets the server
 * fetch only the data that view needs, makes Back work, and makes a filtered list shareable. The
 * desk shell reaches it from a different route entirely, so a click there is a genuine journey back
 * into the workspace — there is no shared client state to preserve, and none is pretended.
 */
export function DirectOrdersTabStrip({
  tabs,
  activeTab,
  basePath,
  needsActionCount = 0,
  rounded = false,
}: {
  tabs: readonly DirectOrderWorkspaceTabKey[];
  /**
   * Which tab reads as current. On a desk route this is the GROUP the desk belongs to
   * (`pharmacy-control`, `reports`, `controls`) rather than the desk itself — the strip names the
   * kind of work, and the desk's own heading names the desk.
   */
  activeTab: DirectOrderWorkspaceTabKey | null;
  basePath: string;
  needsActionCount?: number;
  /** Portal shell is rounded, admin is square — the one visual difference between the two. */
  rounded?: boolean;
}) {
  if (tabs.length === 0) return null;
  const control = rounded ? "rounded-lg" : "";
  return (
    // The tabs WRAP onto a second row rather than scroll sideways (fits-the-screen golden rule).
    <div className={`inline-flex max-w-full flex-wrap border border-slate-300 bg-white p-1 ${adminRecessedDepthClassName} ${control}`} role="tablist">
      {tabs.map((key) => {
        const active = activeTab === key;
        return (
          <Link
            key={key}
            href={key === "overview" ? basePath : `${basePath}?view=${key}`}
            role="tab"
            aria-selected={active}
            className={`min-h-[40px] px-3 py-1.5 text-phx-sm font-black uppercase tracking-wide transition-colors ${control} ${
              active ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-100"
            }`}
          >
            {TAB_LABEL[key]}
            {key === "needs-action" && needsActionCount > 0 ? (
              <span className="ml-1.5 inline-flex min-w-[18px] justify-center rounded-full bg-phx-warn px-1 text-phx-2xs text-white">
                {needsActionCount}
              </span>
            ) : null}
          </Link>
        );
      })}
    </div>
  );
}
