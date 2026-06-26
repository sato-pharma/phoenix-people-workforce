import Link from "next/link";
import { redirect } from "next/navigation";
import { BarChart3, TrendingUp, CalendarRange, GitCompare, ArrowLeftRight } from "lucide-react";

import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { OpenInMetabaseLink } from "@/components/analytics/open-in-metabase-link";
import { AnalyticsSection } from "@/components/analytics/analytics-section";

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
    accent: "#2563EB",
  },
  {
    href: "/admin/analytics/monthly-closing",
    icon: CalendarRange,
    label: "Monthly Closing Analytics",
    description:
      "Employee-attributed monthly closing vs target. Achievement %, ranking, " +
      "manager hierarchy, and territory drill-down.",
    badge: "Closing",
    accent: "#059669",
  },
  {
    href: "/admin/analytics/weekly-sales",
    icon: TrendingUp,
    label: "Weekly Sales Analytics",
    description:
      "Weekly distributor sell-out and stock position by branch, region, product, and line. " +
      "Trend and cover analysis.",
    badge: "Weekly",
    accent: "#F97316",
  },
  {
    href: "/admin/analytics/executive-comparison",
    icon: GitCompare,
    label: "Executive Comparison",
    description:
      "Side-by-side KPI comparison across lines, regions, distributors, and periods. " +
      "Growth %, contribution %, and ranking tables.",
    badge: "Exec",
    accent: "#7C3AED",
  },
  {
    href: "/admin/analytics/reconciliation",
    label: "Cross-Source Reconciliation",
    icon: ArrowLeftRight,
    description:
      "Compare Source of Sales vs Monthly Closing vs Weekly on the same period × line grain. " +
      "Identify gaps between the three pipelines.",
    badge: "Recon",
    accent: "#DC2626",
  },
] as const;

export default async function AnalyticsHubPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals");
  }
  await assertPermission(access, "sales", "read");
  const canOpenMetabase = access.role === "CEO" || access.role === "Super Admin";

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-4 border-b border-border pb-5">
        <div className="flex items-center gap-3">
          <div className="w-1 h-12 bg-[#0F172A] shrink-0" />
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-[#0F172A] mb-0.5">BI Foundation</p>
            <h1 className="text-2xl font-bold text-foreground leading-tight">Sales Analytics</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Three sales pipelines, unified dimension filters, comparison mode.
              Add <code>?demo=1</code> to any dashboard to preview it with fake sample data.
            </p>
          </div>
        </div>
        {canOpenMetabase ? <OpenInMetabaseLink /> : null}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {MODULES.map((mod) => (
          <Link
            key={mod.href}
            href={mod.href}
            className="group border border-border bg-card hover:shadow-md transition-all flex flex-col overflow-hidden"
            style={{ borderTopWidth: 3, borderTopColor: mod.accent }}
          >
            <div className="p-5 flex flex-col gap-3 flex-1">
              <div className="flex items-center justify-between">
                <mod.icon className="h-6 w-6" style={{ color: mod.accent }} />
                <span
                  className="text-[10px] font-black uppercase tracking-widest text-white px-1.5 py-0.5"
                  style={{ backgroundColor: mod.accent }}
                >
                  {mod.badge}
                </span>
              </div>
              <div>
                <p className="font-semibold text-foreground group-hover:text-orange-600 transition-colors">
                  {mod.label}
                </p>
                <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{mod.description}</p>
              </div>
            </div>
          </Link>
        ))}
      </div>

      <AnalyticsSection title="Data pipelines connected">
        <ul className="list-disc list-inside space-y-1 ml-1 text-xs text-muted-foreground">
          <li>Source of Sales — distributor invoice aggregates via <code>source_of_sales_fact_rollup</code></li>
          <li>Monthly Closing — employee target/actual via <code>sales_records</code></li>
          <li>Weekly Sales — distributor weekly sell-out via <code>weekly_sales_rows</code></li>
        </ul>
        <p className="mt-3 text-xs text-muted-foreground">
          Confidential products (LA003, LA004, SS001) are excluded from all views unless you have CEO / Super Admin access.
        </p>
      </AnalyticsSection>
    </div>
  );
}
