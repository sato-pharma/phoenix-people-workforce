"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type Tab = { readonly href: string; readonly label: string };

// The tab configs (module-nav-config.ts) declare canonical `/admin/analytics/*` hrefs. The same
// dashboards are also mounted read-only inside the employee portal at `/employee-portals/sales-analytics/*`;
// passing `mountRoot` rewrites that leading segment so the tabs link within the portal tree instead
// of jumping the viewer into the admin URL space. Omitting it keeps the canonical admin hrefs.
export function AnalyticsModuleNav({ tabs, mountRoot }: { tabs: readonly Tab[]; mountRoot?: string }) {
  const pathname = usePathname();
  const hrefFor = (href: string) => (mountRoot ? href.replace("/admin/analytics", mountRoot) : href);

  return (
    <nav className="flex border-b border-border">
      {tabs.map((tab) => {
        const href = hrefFor(tab.href);
        const active = pathname === href;
        return (
          <Link
            key={href}
            href={href}
            className={`px-4 py-2.5 text-xs font-semibold uppercase tracking-wide border-b-2 -mb-px transition-colors whitespace-nowrap ${
              active
                ? "border-[#F97316] text-[#F97316]"
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
