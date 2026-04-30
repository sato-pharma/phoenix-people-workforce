"use client";

import {
  BriefcaseBusiness,
  CalendarClock,
  CalendarDays,
  FileSpreadsheet,
  Hourglass,
  Network,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { cn } from "@/lib/utils";

const sections = [
  {
    items: [
      { href: "/payroll?tab=generate", icon: CalendarDays, label: "Generate Payroll" },
      { href: "/payroll?tab=governance", icon: FileSpreadsheet, label: "Upload & Governance" },
    ],
    label: "Control Tower",
  },
  {
    items: [
      { href: "/employees", icon: UsersRound, label: "Employees" },
      { href: "/organogram", icon: Network, label: "Organogram" },
      { href: "/reports/vacancies", icon: BriefcaseBusiness, label: "Vacancies" },
    ],
    label: "Employee Management",
  },
  {
    items: [
      { href: "/probation", icon: Hourglass, label: "Probation" },
      { href: "/contracts", icon: CalendarClock, label: "Contract Renewal" },
      { href: "/hr-calendar", icon: CalendarDays, label: "HR Calendar" },
    ],
    label: "Tracking",
  },
];

function isActivePath(pathname: string, href: string, activeTab: string | null) {
  const baseHref = href.split("?")[0];
  if (href.includes("tab=governance")) {
    return pathname === baseHref && activeTab === "governance";
  }
  if (href.includes("tab=generate")) {
    return pathname === baseHref && activeTab === "generate";
  }
  return pathname.startsWith(baseHref);
}

export function Sidebar() {
  const pathname = usePathname();
  const [activeTab, setActiveTab] = useState<string | null>(pathname === "/payroll" ? "governance" : null);

  return (
    <aside className="sticky top-0 hidden h-screen w-[230px] shrink-0 border-r border-slate-200 bg-white px-4 py-5 shadow-[12px_0_34px_rgba(15,23,42,0.035)] lg:flex lg:flex-col">
      <Link className="flex items-center gap-3" href="/payroll?tab=generate">
        <img
          alt="Phoenix"
          className="h-16 w-16 object-contain drop-shadow-[0_0_16px_rgba(249,115,22,0.22)]"
          src="/brand/phoenix-bird-icon.png"
        />
        <div>
          <p className="whitespace-nowrap text-lg font-bold tracking-[0.18em] text-text">
            PHOENIX <span className="text-primary">X</span>
          </p>
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-text-secondary">
            Godmode Payroll
          </p>
        </div>
      </Link>

      <nav className="mt-6 flex-1 space-y-5 overflow-auto pr-1">
        {sections.map((section) => (
          <div key={section.label}>
            <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.22em] text-text-secondary">
              {section.label}
            </p>
            <div className="space-y-1">
              {section.items.map((item) => {
                const active = isActivePath(pathname, item.href, activeTab);

                return (
                  <Link
                    className={cn(
                      "flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-xs font-medium transition",
                      active
                        ? "bg-orange-50 text-primary shadow-[inset_3px_0_0_var(--phoenix-primary),0_10px_22px_rgba(249,115,22,0.08)]"
                        : "text-text-secondary hover:bg-slate-50 hover:text-text",
                    )}
                    href={item.href}
                    key={item.label}
                    onClick={() => setActiveTab(item.href.includes("tab=generate") ? "generate" : "governance")}
                  >
                    <span className="flex h-6 w-6 items-center justify-center rounded-lg border border-slate-200 bg-white text-[10px] shadow-sm">
                      <item.icon className="h-3.5 w-3.5" />
                    </span>
                    {item.label}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="mt-5 rounded-2xl border border-orange-200 bg-orange-50/70 p-4">
        <img
          alt=""
          className="mx-auto h-24 w-24 object-contain opacity-90"
          src="/brand/phoenix-bird-icon.png"
        />
        <div className="mt-2 flex items-center justify-center gap-2 text-[10px] font-bold uppercase tracking-[0.18em] text-primary">
          <ShieldCheck className="h-3.5 w-3.5" />
          Rise | Transform | Excel
        </div>
      </div>
    </aside>
  );
}
