"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type Tab = { readonly href: string; readonly label: string };

// The tab configs (module-nav-config.ts) declare canonical `/admin/analytics/*` hrefs. The same
// dashboards are also mounted read-only inside the employee portal at `/employee-portals/sales-analytics/*`;
// passing `mountRoot` rewrites that leading segment so the tabs link within the portal tree instead
// of jumping the viewer into the admin URL space. Omitting it keeps the canonical admin hrefs.
//
// LAYOUT — bound by the owner's fits-the-screen golden rule (AGENTS.md §4): never a horizontal
// scroll, mobile AND desktop friendly. This was `phoenix-horizontal-scroll flex overflow-x-auto`
// with nowrap items, which broke that rule two ways at 375px, where this nav gets 303px of content
// (375 less `main`'s `px-3` at app-shell.tsx:199, less the dashboard's own `p-6`): the strip parked
// content behind a sideways scroll, AND — because flex items default to `flex-shrink: 1` — each tab
// was squeezed BELOW its own text width, so labels overflowed their box and painted over their
// neighbours. That second half is the one a `main.scrollWidth > main.clientWidth` check cannot see:
// clipped content inside an overflow band adds nothing to an ancestor's scrollWidth, so the page
// measured a clean 375/375 while the labels were unreadable. Measure the nav's own box, and each
// tab's.
//
// WHO THIS AFFECTS. Ruling 11 removed the Sales Analytics module from every rail, so twelve of the
// thirteen dashboards using this strip are reachable by URL only. The live consumer is the Finance
// Manager's Monthly Closing export (/admin/analytics/monthly-closing/details), the one surviving
// nav entry into this tree — CLOSING_TABS, which clipped 2px of label at 375px. The worst case was
// the archived Source of Sales page: 22px of strip hidden and 77px of label text clipped.
//
// `flex-wrap` + `shrink-0` fixes both halves — each tab keeps its natural width and the row wraps
// instead of scrolling. Verified on the running dev server: 303/303, nothing hidden, no clipped
// text, two rows at 375px and one row at every desktop width (668 / 616 / 856 / 1222px of content),
// so desktop is unchanged. Note 1024px is NARROWER than 768px — that is where the sidebar appears.
// Wrapping is the rule's permitted answer; shrinking the type or truncating with an ellipsis is not.
// Do not reintroduce `overflow-x-auto` here — that pattern IS the bug, not the fix.
export function AnalyticsModuleNav({ tabs, mountRoot }: { tabs: readonly Tab[]; mountRoot?: string }) {
  const pathname = usePathname();
  const hrefFor = (href: string) => (mountRoot ? href.replace("/admin/analytics", mountRoot) : href);

  return (
    <nav className="flex flex-wrap border-b border-border">
      {tabs.map((tab) => {
        const href = hrefFor(tab.href);
        const active = pathname === href;
        return (
          <Link
            key={href}
            href={href}
            className={`shrink-0 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide border-b-2 -mb-px transition-colors whitespace-nowrap ${
              active
                ? "border-phx-accent text-phx-accent"
                : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
