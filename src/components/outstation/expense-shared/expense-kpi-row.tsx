"use client";

import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, Banknote, Route, Target, Users, Wallet } from "lucide-react";

import { AdminStatCard } from "@/components/admin/admin-design-system";
import { egp, orDash, pct } from "@/components/outstation/expense-shared/formatters";
import type {
  ExpenseCommandKpiDeltas,
  ExpenseCommandKpis,
  ExpenseDashboardVariant,
} from "@/components/outstation/expense-shared/types";

/**
 * Render the primary KPI number and, when a previous-period comparison is available,
 * a small delta subtitle like "▲ 12.3% vs prev 30d". `sentiment` tells us whether
 * "up" is good ("up"), bad ("down"), or neutral ("neutral") — colouring follows.
 */
function KpiValue({
  primary,
  deltaPct,
  previousLabel,
  sentiment,
}: {
  primary: string;
  deltaPct: number | null | undefined;
  previousLabel: string | null;
  sentiment: "up" | "down" | "neutral";
}) {
  if (deltaPct === null || deltaPct === undefined || !previousLabel) {
    return <span>{primary}</span>;
  }
  // Treat <0.05% as flat to avoid jittery "+0.0%" noise.
  const flat = Math.abs(deltaPct) < 0.05;
  const positive = !flat && deltaPct > 0;
  const tone =
    flat || sentiment === "neutral"
      ? "text-slate-400"
      : (positive && sentiment === "up") || (!positive && sentiment === "down")
        ? "text-emerald-600"
        : "text-rose-600";
  const Icon = flat ? null : positive ? ArrowUp : ArrowDown;

  return (
    <span className="flex flex-col gap-0.5">
      <span>{primary}</span>
      <span className={`inline-flex items-center gap-1 text-phx-sm font-bold ${tone}`}>
        {Icon ? <Icon className="h-2.5 w-2.5" /> : null}
        <span>{flat ? "≈ flat" : pct(deltaPct)}</span>
        <span className="font-semibold text-slate-400">{previousLabel}</span>
      </span>
    </span>
  );
}

export function ExpenseKpiRow({
  kpis,
  kpiDeltas,
  variant = "admin",
}: {
  kpis: ExpenseCommandKpis;
  kpiDeltas?: ExpenseCommandKpiDeltas | null;
  variant?: ExpenseDashboardVariant;
}) {
  const totalLabel = variant === "portal" ? "My Total Spend" : "Total Spend";
  const previousLabel = kpiDeltas?.previousLabel ?? null;

  type KpiCard = {
    key: string;
    label: string;
    value: ReactNode;
    description: string;
    tone: "orange" | "blue" | "emerald" | "violet" | "rose";
    icon: ReactNode;
  };

  const cards: KpiCard[] = [
    {
      key: "total",
      label: totalLabel,
      value: (
        <KpiValue
          deltaPct={kpiDeltas?.totalAmountPct}
          previousLabel={previousLabel}
          primary={orDash(kpis.totalAmount, egp)}
          sentiment="down"
        />
      ),
      description: `${kpis.totalRows.toLocaleString()} trip${kpis.totalRows === 1 ? "" : "s"}`,
      tone: "orange",
      icon: <Wallet className="h-4 w-4" />,
    },
    {
      key: "approved",
      label: "Approved",
      value: (
        <KpiValue
          deltaPct={kpiDeltas?.approvedAmountPct}
          previousLabel={previousLabel}
          primary={orDash(kpis.approvedAmount, egp)}
          sentiment="up"
        />
      ),
      description: `${kpis.approvedRows.toLocaleString()} approved`,
      tone: "emerald",
      icon: <Banknote className="h-4 w-4" />,
    },
    {
      key: "pending",
      label: "Pending",
      value: (
        <KpiValue
          deltaPct={kpiDeltas?.pendingAmountPct}
          previousLabel={previousLabel}
          primary={orDash(kpis.pendingAmount, egp)}
          sentiment="down"
        />
      ),
      description: `${kpis.pendingRows.toLocaleString()} awaiting`,
      tone: "blue",
      icon: <Target className="h-4 w-4" />,
    },
  ];

  if (variant === "admin") {
    cards.push(
      {
        key: "distance",
        label: "Distance",
        value: kpis.totalDistance > 0 ? `${Math.round(kpis.totalDistance).toLocaleString()} km` : "—",
        description: "total travelled",
        tone: "violet",
        icon: <Route className="h-4 w-4" />,
      },
      {
        key: "employees",
        label: "Employees",
        value: (
          <KpiValue
            deltaPct={kpiDeltas?.employeeCountPct}
            previousLabel={previousLabel}
            primary={kpis.employeeCount > 0 ? kpis.employeeCount.toLocaleString() : "—"}
            sentiment="up"
          />
        ),
        description: "on outstation trips",
        tone: "blue",
        icon: <Users className="h-4 w-4" />,
      },
    );
  } else {
    cards.push(
      {
        key: "distance",
        label: "Distance",
        value: kpis.totalDistance > 0 ? `${Math.round(kpis.totalDistance).toLocaleString()} km` : "—",
        description: "total travelled",
        tone: "violet",
        icon: <Route className="h-4 w-4" />,
      },
      {
        key: "avg",
        label: "Avg / Trip",
        value: orDash(kpis.averageCostPerTrip, egp),
        description: "average trip cost",
        tone: "blue",
        icon: <Target className="h-4 w-4" />,
      },
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
      {cards.map((card) => (
        <AdminStatCard
          key={card.key}
          description={card.description}
          icon={card.icon}
          label={card.label}
          size="compact"
          tone={card.tone}
          value={card.value}
        />
      ))}
    </div>
  );
}
