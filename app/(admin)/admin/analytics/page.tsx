import Link from "next/link";
import { redirect } from "next/navigation";
import { BarChart3, TrendingUp, CalendarRange, GitCompare, ArrowLeftRight } from "lucide-react";

import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

const MODULES = [
  {
    href: "/admin/analytics/source-sales",
    icon: BarChart3,
    label: "Source of Sales Analytics",
    description:
      "Distributor invoice aggregates by brick, area, region, product, family, and line. " +
      "Compare distributors, channels, and periods.",
    badge: "SoS",
    color: "text-blue-600",
  },
  {
    href: "/admin/analytics/monthly-closing",
    icon: CalendarRange,
    label: "Monthly Closing Analytics",
    description:
      "Employee-attributed monthly closing vs target. Achievement %, ranking, " +
      "manager hierarchy, and territory drill-down.",
    badge: "Closing",
    color: "text-emerald-600",
  },
  {
    href: "/admin/analytics/weekly-sales",
    icon: TrendingUp,
    label: "Weekly Sales Analytics",
    description:
      "Weekly distributor sell-out and stock position by branch, region, product, and line. " +
      "Trend and cover analysis.",
    badge: "Weekly",
    color: "text-orange-600",
  },
  {
    href: "/admin/analytics/executive-comparison",
    icon: GitCompare,
    label: "Executive Comparison",
    description:
      "Side-by-side KPI comparison across lines, regions, distributors, and periods. " +
      "Growth %, contribution %, and ranking tables.",
    badge: "Exec",
    color: "text-purple-600",
  },
  {
    href: "/admin/analytics/reconciliation",
    label: "Cross-Source Reconciliation",
    icon: ArrowLeftRight,
    description:
      "Compare Source of Sales vs Monthly Closing vs Weekly on the same period × line grain. " +
      "Identify gaps between the three pipelines.",
    badge: "Recon",
    color: "text-red-600",
  },
] as const;

export default async function AnalyticsHubPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals");
  }
  await assertPermission(access, "sales", "read");

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Sales Analytics</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Enterprise BI foundation — three sales pipelines, unified dimension filters, comparison mode.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {MODULES.map((mod) => (
          <Link
            key={mod.href}
            href={mod.href}
            className="group border border-border bg-card p-5 hover:border-orange-400 hover:shadow-sm transition-all flex flex-col gap-3"
          >
            <div className="flex items-center justify-between">
              <mod.icon className={`h-6 w-6 ${mod.color}`} />
              <span className="text-xs font-semibold uppercase tracking-wide border border-current px-1.5 py-0.5 rounded-none opacity-60">
                {mod.badge}
              </span>
            </div>
            <div>
              <p className="font-semibold text-foreground group-hover:text-orange-600 transition-colors">
                {mod.label}
              </p>
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{mod.description}</p>
            </div>
          </Link>
        ))}
      </div>

      <div className="border border-border bg-muted/30 p-4 text-xs text-muted-foreground space-y-1">
        <p className="font-semibold text-foreground">Data pipelines connected</p>
        <ul className="list-disc list-inside space-y-0.5 ml-1">
          <li>Source of Sales — distributor invoice aggregates via <code>source_of_sales_fact_rollup</code></li>
          <li>Monthly Closing — employee target/actual via <code>sales_records</code></li>
          <li>Weekly Sales — distributor weekly sell-out via <code>weekly_sales_rows</code></li>
        </ul>
        <p className="mt-2">
          Confidential products (LA003, LA004, SS001) are excluded from all views unless you have CEO / Super Admin access.
        </p>
      </div>
    </div>
  );
}
