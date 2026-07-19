import Link from "next/link";
import { BarChart3, CalendarRange, TrendingUp, GitCompare, ArrowLeftRight } from "lucide-react";

import { redirect } from "next/navigation";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { canViewPortalCoreAnalytics, canViewPortalDetailedAnalytics } from "@/lib/analytics/portal-access";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { AnalyticsSection } from "@/components/analytics/analytics-section";

export const dynamic = "force-dynamic";

// Portal Sales Analytics hub. The employee-portal layout supplies the portal shell; this page only
// renders the tile grid. Field roles reach their OWN scoped analytics here — never via an /admin URL.
// Tiles follow the tier matrix (see canViewPortalDetailedAnalytics): everyone gets the 3 core
// dashboards; RM + line managers additionally get Executive Comparison + Reconciliation.

const CORE_MODULES = [
  {
    href: "/employee-portals/sales-analytics/source-sales",
    icon: BarChart3,
    label: "Source of Sales Analytics",
    description:
      "Distributor invoice aggregates by brick, area, region, product, family, and line — scoped to you.",
    badge: "SoS",
    accent: "#2563EB",
  },
  {
    href: "/employee-portals/sales-analytics/monthly-closing",
    icon: CalendarRange,
    label: "Monthly Closing Analytics",
    description:
      "Employee-attributed monthly closing vs target. Achievement %, ranking, and territory drill-down.",
    badge: "Closing",
    accent: "#059669",
  },
  {
    href: "/employee-portals/sales-analytics/weekly-sales",
    icon: TrendingUp,
    label: "Weekly Sales Analytics",
    description:
      "Weekly distributor sell-out and stock position by branch, region, product, and line.",
    badge: "Weekly",
    accent: "#F97316",
  },
] as const;

// Shown only to the "detailed" tier (Regional Manager + line managers).
const DETAILED_MODULES = [
  {
    href: "/employee-portals/sales-analytics/executive-comparison",
    icon: GitCompare,
    label: "Executive Comparison",
    description:
      "Side-by-side KPI comparison across lines, regions, distributors, and periods — within your scope.",
    badge: "Exec",
    accent: "#7C3AED",
  },
  {
    href: "/employee-portals/sales-analytics/reconciliation",
    icon: ArrowLeftRight,
    label: "Cross-Source Reconciliation",
    description:
      "Compare Source of Sales vs Monthly Closing vs Weekly on the same period × line grain.",
    badge: "Recon",
    accent: "#DC2626",
  },
] as const;

export default async function PortalSalesAnalyticsHubPage() {
  const access = await resolveAuthenticatedPageAccess();
  await assertPermission(access, "sales", "read");
  if (!canViewPortalCoreAnalytics(access.role)) redirect(resolveLandingPathForRole(access.role));

  const modules = canViewPortalDetailedAnalytics(access.role)
    ? [...CORE_MODULES, ...DETAILED_MODULES]
    : CORE_MODULES;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center gap-3 border-b border-border pb-5">
        <div className="w-1 h-12 bg-[#0F172A] shrink-0" />
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-[#0F172A] mb-0.5">BI Foundation</p>
          <h1 className="text-2xl font-bold text-foreground leading-tight">Sales Analytics</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Distributor sell-in, monthly closing, and weekly trends — scoped to your line and region.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {modules.map((mod) => (
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

      <AnalyticsSection title="What you're seeing">
        <p className="text-xs text-muted-foreground">
          Every dashboard is bound to your own line and region. Confidential products (LA003, LA004,
          SS001) and the Head-Office line are excluded from all views.
        </p>
      </AnalyticsSection>
    </div>
  );
}
