"use client";

import {
  AlertTriangle,
  BarChart2,
  FileUp,
  Link2,
  TrendingUp,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/sales/format";
import type { SalesDashboardData } from "@/lib/sales/types";
import { cn } from "@/lib/utils";

type Props = {
  initialData: SalesDashboardData | null;
  initialError: string | null;
};

function MetricCard({
  label,
  value,
  sub,
  tone = "neutral",
  icon: Icon,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "neutral" | "success" | "warning" | "danger";
  icon?: React.ComponentType<{ className?: string }>;
}) {
  const toneClasses: Record<string, string> = {
    neutral: "bg-primary/10 text-primary",
    success: "bg-green-50 text-success dark:bg-green-950/30",
    warning: "bg-orange-50 text-warning dark:bg-orange-950/30",
    danger: "bg-red-50 text-danger dark:bg-red-950/30",
  };

  return (
    <Card>
      <div className="flex items-start gap-4">
        {Icon && (
          <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-lg", toneClasses[tone])}>
            <Icon className="h-5 w-5" />
          </div>
        )}
        <div className="min-w-0">
          <p className="text-sm text-text-secondary">{label}</p>
          <p className="mt-1 text-2xl font-bold text-text">{value}</p>
          {sub && <p className="mt-0.5 text-xs text-text-secondary">{sub}</p>}
        </div>
      </div>
    </Card>
  );
}

function AchievementBadge({ rate }: { rate: number }) {
  if (rate >= 1) return <Badge variant="success">{formatPercent(rate)}</Badge>;
  if (rate >= 0.8) return <Badge variant="warning">{formatPercent(rate)}</Badge>;
  return <Badge variant="danger">{formatPercent(rate)}</Badge>;
}

export function SalesDashboard({ initialData: data, initialError: error }: Props) {
  const [activeTab, setActiveTab] = useState<"overview" | "managers" | "products" | "territories">("overview");

  if (error) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-text">Sales Intelligence</h1>
          <p className="mt-1 text-text-secondary">Performance dashboard across all sales lines.</p>
        </div>
        <Card className="border-danger/20 bg-red-50 dark:bg-red-950/20">
          <div className="flex items-center gap-3">
            <AlertTriangle className="h-5 w-5 text-danger" />
            <div>
              <p className="font-medium text-danger">Unable to load sales data</p>
              <p className="text-sm text-text-secondary">{error}</p>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  if (!data) return null;

  const { summary, familyMatrix, managerPerformance, productPerformance, territories, anomalies, recentBatches } = data;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-text">Sales Intelligence</h1>
          <p className="mt-1 text-text-secondary">Approved sales performance across all lines and periods.</p>
        </div>
        <div className="flex gap-2">
          <Link href="/sales/queue">
            <Button variant="secondary">Review Queue {summary.openReviewBatches > 0 && <Badge variant="warning" className="ml-2">{summary.openReviewBatches}</Badge>}</Button>
          </Link>
          <Link href="/sales/upload">
            <Button>
              <FileUp className="mr-2 h-4 w-4" />
              Upload Sales
            </Button>
          </Link>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Total Approved Sales"
          value={formatCurrency(summary.totalApprovedSales)}
          sub={`Target: ${formatCurrency(summary.totalApprovedTarget)}`}
          tone="neutral"
          icon={TrendingUp}
        />
        <MetricCard
          label="Achievement Rate"
          value={formatPercent(summary.achievementRate)}
          sub={`${formatNumber(summary.unitsSold)} units sold`}
          tone={summary.achievementRate >= 1 ? "success" : summary.achievementRate >= 0.8 ? "warning" : "danger"}
          icon={BarChart2}
        />
        <MetricCard
          label="Linked Employees"
          value={String(summary.linkedEmployees)}
          sub={`${summary.linkedRecords} of ${summary.approvedRecords} records linked`}
          tone="neutral"
          icon={Users}
        />
        <MetricCard
          label="Data Quality"
          value={formatPercent(summary.dataQualityRate)}
          sub={`${summary.activeProducts} active products`}
          tone={summary.dataQualityRate >= 0.9 ? "success" : "warning"}
          icon={Link2}
        />
      </div>

      {/* Tab Nav */}
      <div className="flex gap-1 rounded-lg border border-border bg-bg-muted p-1">
        {(["overview", "managers", "products", "territories"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              "flex-1 rounded-md px-3 py-2 text-sm font-medium capitalize transition-colors",
              activeTab === tab ? "bg-card text-text shadow-sm" : "text-text-secondary hover:text-text"
            )}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Overview Tab */}
      {activeTab === "overview" && (
        <div className="space-y-6">
          {/* Family Matrix */}
          <Card>
            <h2 className="mb-4 text-base font-semibold text-text">Family Performance Matrix</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {familyMatrix.length === 0 && <p className="col-span-full text-sm text-text-secondary">No approved sales data yet.</p>}
              {familyMatrix.map((family) => (
                <div
                  key={family.name}
                  className={cn(
                    "rounded-lg border p-4",
                    family.status === "green" && "border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950/20",
                    family.status === "yellow" && "border-orange-200 bg-orange-50 dark:border-orange-800 dark:bg-orange-950/20",
                    family.status === "red" && "border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/20",
                    family.status === "neutral" && "border-border bg-bg-muted"
                  )}
                >
                  <p className="font-medium text-text">{family.name}</p>
                  <p className="mt-1 text-lg font-bold text-text">{formatCurrency(family.sales)}</p>
                  <div className="mt-1 flex items-center justify-between">
                    <p className="text-xs text-text-secondary">Target: {formatCurrency(family.target)}</p>
                    <AchievementBadge rate={family.achievementRate} />
                  </div>
                </div>
              ))}
            </div>
          </Card>

          {/* Anomalies */}
          {anomalies.length > 0 && (
            <Card>
              <div className="mb-4 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-warning" />
                <h2 className="text-base font-semibold text-text">Statistical Anomalies</h2>
              </div>
              <div className="space-y-3">
                {anomalies.map((anomaly, i) => (
                  <div key={i} className="flex items-start justify-between gap-4 rounded-lg border border-border bg-bg-muted p-3">
                    <div>
                      <p className="text-sm font-medium text-text">{anomaly.label}</p>
                      <p className="text-xs text-text-secondary">{anomaly.detail}</p>
                    </div>
                    <Badge variant={anomaly.score > 0 ? "warning" : "danger"}>
                      {anomaly.score > 0 ? "High" : "Low"}
                    </Badge>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Recent Batches */}
          <Card>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold text-text">Recent Import Batches</h2>
              <Link href="/sales/queue" className="text-sm font-medium text-primary hover:underline">View all</Link>
            </div>
            <div className="space-y-2">
              {recentBatches.length === 0 && <p className="text-sm text-text-secondary">No batches uploaded yet.</p>}
              {recentBatches.map((batch) => (
                <div key={batch.id} className="flex items-center justify-between rounded-lg border border-border bg-bg-muted px-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-text">{batch.fileName}</p>
                    <p className="text-xs text-text-secondary">{batch.line} Â· {batch.period}</p>
                  </div>
                  <Badge variant={batch.status === "approved" ? "success" : batch.status === "rejected" ? "danger" : batch.status === "needs_review" ? "warning" : "neutral"}>
                    {batch.status}
                  </Badge>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {/* Managers Tab */}
      {activeTab === "managers" && (
        <Card>
          <h2 className="mb-4 text-base font-semibold text-text">D.M. Performance Ranking</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="pb-3 pr-4 font-medium text-text-secondary">#</th>
                  <th className="pb-3 pr-4 font-medium text-text-secondary">D.M. Name</th>
                  <th className="pb-3 pr-4 font-medium text-text-secondary">Line</th>
                  <th className="pb-3 pr-4 font-medium text-text-secondary">Sales</th>
                  <th className="pb-3 pr-4 font-medium text-text-secondary">Target</th>
                  <th className="pb-3 font-medium text-text-secondary">Achievement</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {managerPerformance.length === 0 && (
                  <tr><td colSpan={6} className="py-6 text-center text-sm text-text-secondary">No manager data available.</td></tr>
                )}
                {managerPerformance.map((manager, i) => (
                  <tr key={manager.manager} className="hover:bg-bg-muted transition-colors">
                    <td className="py-3 pr-4 font-mono text-xs text-text-secondary">{i + 1}</td>
                    <td className="py-3 pr-4 font-medium text-text">{manager.manager}</td>
                    <td className="py-3 pr-4 text-text-secondary">{manager.line}</td>
                    <td className="py-3 pr-4 font-mono text-text">{formatCurrency(manager.sales)}</td>
                    <td className="py-3 pr-4 font-mono text-text-secondary">{formatCurrency(manager.target)}</td>
                    <td className="py-3"><AchievementBadge rate={manager.achievementRate} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Products Tab */}
      {activeTab === "products" && (
        <Card>
          <h2 className="mb-4 text-base font-semibold text-text">Product Performance</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="pb-3 pr-4 font-medium text-text-secondary">Product</th>
                  <th className="pb-3 pr-4 font-medium text-text-secondary">Family</th>
                  <th className="pb-3 pr-4 font-medium text-text-secondary">Sales</th>
                  <th className="pb-3 pr-4 font-medium text-text-secondary">Target</th>
                  <th className="pb-3 font-medium text-text-secondary">Achievement</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {productPerformance.length === 0 && (
                  <tr><td colSpan={5} className="py-6 text-center text-sm text-text-secondary">No product data available.</td></tr>
                )}
                {productPerformance.slice(0, 30).map((product) => (
                  <tr key={product.product} className="hover:bg-bg-muted transition-colors">
                    <td className="py-3 pr-4 font-medium text-text">{product.product}</td>
                    <td className="py-3 pr-4 text-text-secondary">{product.family}</td>
                    <td className="py-3 pr-4 font-mono text-text">{formatCurrency(product.sales)}</td>
                    <td className="py-3 pr-4 font-mono text-text-secondary">{formatCurrency(product.target)}</td>
                    <td className="py-3"><AchievementBadge rate={product.achievementRate} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Territories Tab */}
      {activeTab === "territories" && (
        <Card>
          <h2 className="mb-4 text-base font-semibold text-text">Territory Performance</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="pb-3 pr-4 font-medium text-text-secondary">Territory</th>
                  <th className="pb-3 pr-4 font-medium text-text-secondary">Sales</th>
                  <th className="pb-3 pr-4 font-medium text-text-secondary">Target</th>
                  <th className="pb-3 font-medium text-text-secondary">Achievement</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {territories.length === 0 && (
                  <tr><td colSpan={4} className="py-6 text-center text-sm text-text-secondary">No territory data available.</td></tr>
                )}
                {territories.map((territory) => (
                  <tr key={territory.name} className="hover:bg-bg-muted transition-colors">
                    <td className="py-3 pr-4 font-medium text-text">{territory.name}</td>
                    <td className="py-3 pr-4 font-mono text-text">{formatCurrency(territory.sales)}</td>
                    <td className="py-3 pr-4 font-mono text-text-secondary">{formatCurrency(territory.target)}</td>
                    <td className="py-3"><AchievementBadge rate={territory.achievementRate} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
