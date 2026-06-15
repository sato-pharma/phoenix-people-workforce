"use client";

import type { ReactNode } from "react";
import {
  Banknote,
  Route,
  ShieldAlert,
  Target,
  Users,
  Wallet,
} from "lucide-react";

import { AdminStatCard } from "@/components/admin/admin-design-system";
import { egp, orDash } from "@/components/outstation/expense-shared/formatters";
import type {
  ExpenseCommandKpis,
  ExpenseDashboardVariant,
} from "@/components/outstation/expense-shared/types";

export function ExpenseKpiRow({
  kpis,
  variant = "admin",
}: {
  kpis: ExpenseCommandKpis;
  variant?: ExpenseDashboardVariant;
}) {
  const totalLabel = variant === "portal" ? "My Total Spend" : "Total Spend";

  type KpiCard = {
    key: string;
    label: string;
    value: string;
    description: string;
    tone: "orange" | "blue" | "emerald" | "violet" | "rose";
    icon: ReactNode;
  };

  const cards: KpiCard[] = [
    {
      key: "total",
      label: totalLabel,
      value: orDash(kpis.totalAmount, egp),
      description: `${kpis.totalRows.toLocaleString()} trip${kpis.totalRows === 1 ? "" : "s"}`,
      tone: "orange" as const,
      icon: <Wallet className="h-4 w-4" />,
    },
    {
      key: "approved",
      label: "Approved",
      value: orDash(kpis.approvedAmount, egp),
      description: `${kpis.approvedRows.toLocaleString()} approved`,
      tone: "emerald" as const,
      icon: <Banknote className="h-4 w-4" />,
    },
    {
      key: "pending",
      label: "Pending",
      value: orDash(kpis.pendingAmount, egp),
      description: `${kpis.pendingRows.toLocaleString()} awaiting`,
      tone: "blue" as const,
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
        tone: "violet" as const,
        icon: <Route className="h-4 w-4" />,
      },
      {
        key: "risk",
        label: "High-Risk",
        value: kpis.highRiskRows && kpis.highRiskRows > 0 ? kpis.highRiskRows.toLocaleString() : "—",
        description: "fraud / territory flags",
        tone: "rose" as const,
        icon: <ShieldAlert className="h-4 w-4" />,
      },
      {
        key: "employees",
        label: "Employees",
        value: kpis.employeeCount > 0 ? kpis.employeeCount.toLocaleString() : "—",
        description: "on outstation trips",
        tone: "blue" as const,
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
        tone: "violet" as const,
        icon: <Route className="h-4 w-4" />,
      },
      {
        key: "avg",
        label: "Avg / Trip",
        value: orDash(kpis.averageCostPerTrip, egp),
        description: "average trip cost",
        tone: "blue" as const,
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
