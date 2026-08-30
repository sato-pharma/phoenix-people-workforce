"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import {
  activePersonalWorkspaceTab,
  type PersonalWorkspaceTab,
} from "@/lib/workspace/personal-workspace-nav";

/**
 * THE personal workspace strip — the navigation `WorkspaceFrame` never had.
 *
 * Until 2026-08-30 every `/workspace/*` page was an island: the frame rendered a hero and the page
 * body and nothing else, so arriving on one gave you no route to any other. Fourteen of the fifteen
 * personal pages had no link pointing at them from anywhere in the app. This is the fix, and it is
 * deliberately the same strip the Direct Orders workspace uses — same border, same square control,
 * same uppercase weight — so the two do not read as two different products.
 *
 * **Navigation, not state.** Every tab is a real `<Link>` to a real route, so Back works, a tab is
 * shareable, and the server fetches only that page's data. Nothing here is client state.
 *
 * **It is not a gate.** The tabs handed to it are already resolved server-side by
 * `resolvePersonalWorkspaceTabs`, which mirrors each page's own guard; every page then re-checks
 * that guard for itself. This is the door, never the lock.
 *
 * `usePathname` is the one reason this is a client component: the frame it renders in is shared by
 * fifteen routes, and having each of them pass its own href back down would be fifteen chances to
 * pass the wrong one.
 */
export function PersonalWorkspaceTabs({ tabs }: { tabs: readonly PersonalWorkspaceTab[] }) {
  const pathname = usePathname() ?? "";
  // One tab is not a choice — render no chrome at all rather than a strip with nothing to switch
  // to. Same rule the outstation expense tabs use.
  if (tabs.length <= 1) return null;
  const active = activePersonalWorkspaceTab(pathname);

  return (
    <div className="-mx-1 overflow-x-auto px-1">
      <div className="inline-flex min-w-max border border-slate-300 bg-white p-1" role="tablist">
        {tabs.map((tab, index) => {
          const isActive = active?.href === tab.href;
          // A hairline wherever the run of work changes — pay, then time, then planning. It keeps
          // fifteen tabs readable as five short groups without adding a second row of chrome.
          const startsGroup = index > 0 && tabs[index - 1]?.group !== tab.group;
          return (
            <div className="flex items-center" key={tab.href}>
              {startsGroup ? <span aria-hidden className="mx-1 h-5 w-px bg-slate-200" /> : null}
              <Link
                aria-selected={isActive}
                className={`min-h-[40px] whitespace-nowrap px-3 py-1.5 text-phx-sm font-black uppercase tracking-wide transition-colors ${
                  isActive ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-100"
                }`}
                href={tab.href}
                role="tab"
              >
                {tab.label}
              </Link>
            </div>
          );
        })}
      </div>
    </div>
  );
}
