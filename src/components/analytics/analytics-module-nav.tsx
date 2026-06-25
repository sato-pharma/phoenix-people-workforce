"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type Tab = { readonly href: string; readonly label: string };

export function AnalyticsModuleNav({ tabs }: { tabs: readonly Tab[] }) {
  const pathname = usePathname();

  return (
    <nav className="flex border-b border-border">
      {tabs.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
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
