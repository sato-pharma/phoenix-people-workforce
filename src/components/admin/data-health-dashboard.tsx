"use client";

import {
  AdminInsightChip,
  AdminPageHero,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import {
  Activity,
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Database,
  Heart,
  Loader2,
  ShieldCheck,
  TrendingUp,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Card } from "@/components/ui/card";
import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import { cn } from "@/lib/utils";
import type { DataHealthStats, SalaryFlag, SalaryFlagsResult } from "@/lib/admin/service";
import type { ExportColumn, ExportRow } from "@/lib/export/table-workbook";
import { formatCurrency } from "@/lib/sales/format";

const PAGE_SIZE = 12;

type DataHealthDashboardProps = {
  stats: DataHealthStats;
  salaryFlags: SalaryFlagsResult | null;
};

type SummaryCardProps = {
  color: "blue" | "green" | "orange" | "rose";
  icon: LucideIcon;
  title: string;
  value: number | string;
};

type QueueCardProps = {
  active?: boolean;
  color: "blue" | "green" | "orange" | "rose";
  count: number | string;
  description: string;
  icon: LucideIcon;
  onClick: () => void;
  title: string;
};

type DetailViewKey =
  | "active-missing-access"
  | "employee-issues"
  | "salary-flags"
  | "sales-issues"
  | "orphan-hrids"
  | "non-login-nodes"
  | "historical-records"
  | "vacancy-nodes"
  | "non-assignable-sales"
  | "vacant-territory-sales"
  | "line-level-sales"
  | "other-sales-exceptions";

function Pagination({
  from,
  onPage,
  page,
  pageCount,
  to,
  total,
}: {
  from: number;
  onPage: (p: number) => void;
  page: number;
  pageCount: number;
  to: number;
  total: number;
}) {
  if (pageCount <= 1) return null;
  return (
    <div className="flex items-center justify-between border-t border-slate-200 bg-white px-4 py-3">
      <span className="text-xs font-semibold text-slate-600">
        {from}-{to} of {total}
      </span>
      <div className="flex items-center gap-1.5">
        <button
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:border-slate-300 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 disabled:opacity-40"
          disabled={page === 1}
          onClick={() => onPage(page - 1)}
          type="button"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="px-3 text-xs font-bold text-slate-800">
          {page} / {pageCount}
        </span>
        <button
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:border-slate-300 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 disabled:opacity-40"
          disabled={page === pageCount}
          onClick={() => onPage(page + 1)}
          type="button"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  } catch {
    return iso;
  }
}

// ── Command-Center-style section label (orange accent bar + eyebrow + title) ──
function SectionLabel({ action, eyebrow, title }: { action?: ReactNode; eyebrow: string; title: string }) {
  return (
    <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="mt-1 h-9 w-1.5 shrink-0 bg-gradient-to-b from-orange-500 to-amber-400" />
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-orange-600">{eyebrow}</p>
          <h2 className="mt-1 text-xl font-bold tracking-[-0.025em] text-slate-950">{title}</h2>
        </div>
      </div>
      {action ? <div className="flex flex-wrap gap-2">{action}</div> : null}
    </div>
  );
}

// Premium card accents (top bar gradient + glow + gradient icon + value tint) to
// match the Command Center KPI/module cards.
const cardAccent: Record<SummaryCardProps["color"], { bar: string; glow: string; icon: string; value: string }> = {
  blue: {
    bar: "from-sky-500 via-sky-400 to-sky-300",
    glow: "bg-sky-400/20",
    icon: "bg-gradient-to-br from-sky-100 to-sky-50 text-sky-700 ring-sky-200/70",
    value: "text-sky-950",
  },
  green: {
    bar: "from-emerald-500 via-emerald-400 to-emerald-300",
    glow: "bg-emerald-400/20",
    icon: "bg-gradient-to-br from-emerald-100 to-emerald-50 text-emerald-700 ring-emerald-200/70",
    value: "text-emerald-950",
  },
  orange: {
    bar: "from-orange-500 via-orange-400 to-amber-300",
    glow: "bg-orange-400/25",
    icon: "bg-gradient-to-br from-orange-100 to-orange-50 text-orange-700 ring-orange-200/70",
    value: "text-orange-950",
  },
  rose: {
    bar: "from-rose-500 via-rose-400 to-rose-300",
    glow: "bg-rose-400/20",
    icon: "bg-gradient-to-br from-rose-100 to-rose-50 text-rose-700 ring-rose-200/70",
    value: "text-rose-950",
  },
};

export function DataHealthDashboard({ salaryFlags: initialSalaryFlags, stats }: DataHealthDashboardProps) {
  const [selectedView, setSelectedView] = useState<DetailViewKey>("active-missing-access");
  const [employeePage, setEmployeePage] = useState(1);
  const [salesPage, setSalesPage] = useState(1);
  const [orphanPage, setOrphanPage] = useState(1);
  const [salaryPage, setSalaryPage] = useState(1);

  const [salaryFlagsData, setSalaryFlagsData] = useState<SalaryFlagsResult | null>(initialSalaryFlags);
  const [showResolved, setShowResolved] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  const detailRef = useRef<HTMLDivElement | null>(null);

  const employeeIssues = stats.employeeIssues.filter((issue) => issue.health_status !== "ok");
  const activeMissingAccessIssues = employeeIssues.filter(
    (issue) => issue.node_type === "active_employee" && (!issue.has_auth_user || !issue.has_access_profile),
  );
  const nonLoginIssues = employeeIssues.filter((issue) => issue.node_type === "non_login_aggregation_node");
  const historicalIssues = employeeIssues.filter((issue) => issue.node_type === "historical_record");
  const vacancyAudit = stats.vacancyAudit;

  const nonAssignableSalesIssues = stats.salesIssues.filter((issue) => issue.classification === "non_assignable_territory_sales");
  const vacantTerritorySalesIssues = stats.salesIssues.filter((issue) => issue.classification === "vacant_territory_sales");
  const lineLevelSalesIssues = stats.salesIssues.filter((issue) => issue.classification === "line_level_sales");
  const otherSalesIssues = stats.salesIssues.filter((issue) => issue.classification === "others_unassigned_sales");

  const flags: SalaryFlag[] = salaryFlagsData?.flags ?? [];
  const unresolvedCount = salaryFlagsData?.unresolvedCount ?? 0;

  const tableHeadClass =
    "bg-slate-50 text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500";
  const tableBodyClass = "divide-y divide-slate-200";
  const tableRowClass =
    "transition-colors hover:bg-slate-50";

  async function handleResolveFlag(id: string) {
    setResolvingId(id);
    try {
      const res = await fetch("/api/admin/salary-flags", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) throw new Error("Failed to resolve flag");
      const updated = await res.json() as SalaryFlagsResult;
      setSalaryFlagsData(updated);
    } catch (err) {
      console.error(err);
    } finally {
      setResolvingId(null);
    }
  }

  async function handleToggleResolved(value: boolean) {
    setShowResolved(value);
    setSalaryPage(1);
    try {
      const res = await fetch(`/api/admin/salary-flags?showResolved=${value}`);
      if (!res.ok) throw new Error("Failed to fetch flags");
      const updated = await res.json() as SalaryFlagsResult;
      setSalaryFlagsData(updated);
    } catch (err) {
      console.error(err);
    }
  }

  function openDetail(view: DetailViewKey) {
    setSelectedView(view);

    if (
      view === "active-missing-access" ||
      view === "employee-issues" ||
      view === "non-login-nodes" ||
      view === "historical-records" ||
      view === "vacancy-nodes"
    ) {
      setEmployeePage(1);
    } else if (
      view === "sales-issues" ||
      view === "non-assignable-sales" ||
      view === "vacant-territory-sales" ||
      view === "line-level-sales" ||
      view === "other-sales-exceptions"
    ) {
      setSalesPage(1);
    } else if (view === "orphan-hrids") {
      setOrphanPage(1);
    } else if (view === "salary-flags") {
      setSalaryPage(1);
    }

    requestAnimationFrame(() => {
      detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  // Deep-link support: `/admin/data-health?view=<queue>` opens that queue and scrolls to it.
  // Used by the Command Center "Fix now" remediation shortcuts.
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("view");
    const validViews = new Set<string>([
      "active-missing-access",
      "employee-issues",
      "salary-flags",
      "sales-issues",
      "orphan-hrids",
      "non-login-nodes",
      "historical-records",
      "vacancy-nodes",
      "non-assignable-sales",
      "vacant-territory-sales",
      "line-level-sales",
      "other-sales-exceptions",
    ]);
    if (!requested || !validViews.has(requested)) return;
    // Defer so the state update runs in a callback, not synchronously in the effect body.
    const id = window.setTimeout(() => openDetail(requested as DetailViewKey), 0);
    return () => window.clearTimeout(id);
  }, []);

  const priorityCards: Array<Omit<QueueCardProps, "active" | "onClick"> & { key: DetailViewKey }> = [
    {
      key: "active-missing-access",
      color: activeMissingAccessIssues.length > 0 ? "rose" : "green",
      count: activeMissingAccessIssues.length,
      description: "Active users missing auth profile or access card.",
      icon: ShieldCheck,
      title: "Active Missing Auth/Access",
    },
    {
      key: "employee-issues",
      color: employeeIssues.length > 0 ? "rose" : "green",
      count: employeeIssues.length,
      description: "All employee linkage records that need review.",
      icon: AlertCircle,
      title: "Data Issues",
    },
    {
      key: "sales-issues",
      color: stats.salesIssues.length > 0 ? "rose" : "green",
      count: stats.salesIssues.length,
      description: "Sales rows with unresolved assignment exceptions.",
      icon: Activity,
      title: "Unresolved Sales",
    },
    {
      key: "salary-flags",
      color: unresolvedCount > 0 ? "rose" : "green",
      count: unresolvedCount,
      description: "Payroll flags that still need resolution.",
      icon: Heart,
      title: "Salary Flags",
    },
    {
      key: "orphan-hrids",
      color: stats.orphanAudit.length > 0 ? "orange" : "green",
      count: stats.orphanAudit.length,
      description: "HR IDs referenced by data but missing in the directory.",
      icon: Database,
      title: "Orphan HR IDs",
    },
  ];

  const supportingCards: Array<Omit<QueueCardProps, "active" | "onClick"> & { key: DetailViewKey }> = [
    {
      key: "non-login-nodes",
      color: nonLoginIssues.length > 0 ? "orange" : "green",
      count: nonLoginIssues.length,
      description: "Aggregation placeholders and non-login records.",
      icon: Database,
      title: "Non-login Nodes",
    },
    {
      key: "historical-records",
      color: historicalIssues.length > 0 ? "blue" : "green",
      count: historicalIssues.length,
      description: "Inactive records still affecting governance views.",
      icon: Database,
      title: "Historical Records",
    },
    {
      key: "vacancy-nodes",
      color: stats.summary.vacantPositions > 0 ? "orange" : "green",
      count: stats.summary.vacantPositions,
      description: "Vacant positions currently open inside the live structure.",
      icon: Users,
      title: "Vacant Positions",
    },
    {
      key: "non-assignable-sales",
      color: nonAssignableSalesIssues.length > 0 ? "orange" : "green",
      count: nonAssignableSalesIssues.length,
      description: "Territory rows intentionally outside assignment logic.",
      icon: Activity,
      title: "Non-assignable Sales",
    },
    {
      key: "vacant-territory-sales",
      color: vacantTerritorySalesIssues.length > 0 ? "orange" : "green",
      count: vacantTerritorySalesIssues.length,
      description: "Sales attached to vacant territory ownership.",
      icon: Activity,
      title: "Vacant Territory Sales",
    },
    {
      key: "line-level-sales",
      color: lineLevelSalesIssues.length > 0 ? "blue" : "green",
      count: lineLevelSalesIssues.length,
      description: "Line-level sales entries needing final ownership logic.",
      icon: Activity,
      title: "Line-level Sales",
    },
    {
      key: "other-sales-exceptions",
      color: otherSalesIssues.length > 0 ? "blue" : "green",
      count: otherSalesIssues.length,
      description: "Other unassigned or uncategorized sales exceptions.",
      icon: Activity,
      title: "Other Sales Exceptions",
    },
  ];

  const employeeDetailViews = new Set<DetailViewKey>([
    "active-missing-access",
    "employee-issues",
    "non-login-nodes",
    "historical-records",
  ]);
  const salesDetailViews = new Set<DetailViewKey>([
    "sales-issues",
    "non-assignable-sales",
    "vacant-territory-sales",
    "line-level-sales",
    "other-sales-exceptions",
  ]);

  const selectedMeta = {
    "active-missing-access": {
      count: activeMissingAccessIssues.length,
      description: "Focused queue for active employee records that are missing auth, access, or both.",
      title: "Active Missing Auth/Access",
    },
    "employee-issues": {
      count: employeeIssues.length,
      description: "Full employee linkage issue list across active, historical, vacancy, and placeholder nodes.",
      title: "Data Issues",
    },
    "salary-flags": {
      count: flags.length,
      description: "Resolve payroll exceptions from one compact queue. Use the toggle to include resolved items when needed.",
      title: "Salary Flags",
    },
    "sales-issues": {
      count: stats.salesIssues.length,
      description: "All unresolved sales linkage records, including owner, manager, line, and territory mismatches.",
      title: "Unresolved Sales",
    },
    "orphan-hrids": {
      count: stats.orphanAudit.length,
      description: "Records that reference HR IDs not found in the active employee directory.",
      title: "Orphan HR ID Audit",
    },
    "non-login-nodes": {
      count: nonLoginIssues.length,
      description: "Only the non-login aggregation nodes from the employee governance audit.",
      title: "Non-login Nodes",
    },
    "historical-records": {
      count: historicalIssues.length,
      description: "Historical employee records that still appear in governance checks and need follow-up.",
      title: "Historical Records",
    },
    "vacancy-nodes": {
      count: stats.summary.vacantPositions,
      description: "Open positions recorded in the organogram structure, including their line, area, and manager coverage.",
      title: "Vacant Positions",
    },
    "non-assignable-sales": {
      count: nonAssignableSalesIssues.length,
      description: "Sales rows classified as non-assignable territory records.",
      title: "Non-assignable Sales",
    },
    "vacant-territory-sales": {
      count: vacantTerritorySalesIssues.length,
      description: "Sales rows attached to territories that currently have no owner.",
      title: "Vacant Territory Sales",
    },
    "line-level-sales": {
      count: lineLevelSalesIssues.length,
      description: "Line-level sales records that still need final governance review.",
      title: "Line-level Sales",
    },
    "other-sales-exceptions": {
      count: otherSalesIssues.length,
      description: "Other uncategorized or unassigned sales exceptions.",
      title: "Other Sales Exceptions",
    },
  }[selectedView];

  // Build the export payload for whichever detail table is currently shown.
  const exportData: { columns: ExportColumn[]; rows: ExportRow[] } = (() => {
    if (employeeDetailViews.has(selectedView)) {
      const arr = {
        "active-missing-access": activeMissingAccessIssues,
        "employee-issues": employeeIssues,
        "non-login-nodes": nonLoginIssues,
        "historical-records": historicalIssues,
      }[selectedView as "active-missing-access" | "employee-issues" | "non-login-nodes" | "historical-records"];
      return {
        columns: [
          { key: "hr_id", label: "HR_ID" },
          { key: "full_name", label: "Employee Name" },
          { key: "node_type", label: "Node Type" },
          { key: "auth", label: "Auth" },
          { key: "access", label: "Access" },
          { key: "manager_hr_id", label: "Manager HR_ID" },
          { key: "status", label: "Status" },
        ],
        rows: arr.map((issue) => ({
          hr_id: issue.hr_id,
          full_name: issue.full_name,
          node_type: issue.node_type,
          auth: issue.has_auth_user ? "yes" : "no",
          access: issue.has_access_profile ? "yes" : "no",
          manager_hr_id: issue.manager_hr_id ?? "-",
          status: issue.health_status,
        })),
      };
    }
    if (salesDetailViews.has(selectedView)) {
      const arr = {
        "sales-issues": stats.salesIssues,
        "non-assignable-sales": nonAssignableSalesIssues,
        "vacant-territory-sales": vacantTerritorySalesIssues,
        "line-level-sales": lineLevelSalesIssues,
        "other-sales-exceptions": otherSalesIssues,
      }[selectedView as "sales-issues" | "non-assignable-sales" | "vacant-territory-sales" | "line-level-sales" | "other-sales-exceptions"];
      return {
        columns: [
          { key: "period", label: "Month" },
          { key: "employee_hr_id", label: "Employee HR_ID" },
          { key: "manager_hr_id", label: "Manager HR_ID" },
          { key: "line", label: "Line" },
          { key: "territory", label: "Territory" },
          { key: "product", label: "Product" },
          { key: "sales_value", label: "Sales", numeric: true },
          { key: "status", label: "Status" },
          { key: "reason", label: "Reason" },
        ],
        rows: arr.map((issue) => ({
          period: issue.period ?? "-",
          employee_hr_id: issue.employee_hr_id ?? "-",
          manager_hr_id: issue.manager_hr_id ?? "-",
          line: issue.line ?? "-",
          territory: issue.territory ?? "-",
          product: issue.product,
          sales_value: issue.sales_value,
          status: issue.linkage_health_status,
          reason: issue.reason,
        })),
      };
    }
    if (selectedView === "vacancy-nodes") {
      return {
        columns: [
          { key: "vacancy_code", label: "Vacancy Code" },
          { key: "line_name", label: "Line" },
          { key: "area_name", label: "Area" },
          { key: "manager_hr_id", label: "Manager HR_ID" },
          { key: "status", label: "Status" },
        ],
        rows: vacancyAudit.map((vacancy) => ({
          vacancy_code: vacancy.vacancy_code ?? vacancy.vacancy_id ?? "-",
          line_name: vacancy.line_name ?? "-",
          area_name: vacancy.area_name ?? "-",
          manager_hr_id: vacancy.manager_hr_id ?? "-",
          status: vacancy.status ?? "vacant",
        })),
      };
    }
    if (selectedView === "orphan-hrids") {
      return {
        columns: [
          { key: "source", label: "Source" },
          { key: "hr_id", label: "HR_ID" },
          { key: "rows_count", label: "Count", numeric: true },
          { key: "sample_name", label: "Sample Name" },
        ],
        rows: stats.orphanAudit.map((orphan) => ({
          source: orphan.source,
          hr_id: orphan.hr_id,
          rows_count: orphan.rows_count,
          sample_name: orphan.sample_name ?? "-",
        })),
      };
    }
    return {
      columns: [
        { key: "hrId", label: "HR_ID" },
        { key: "flagType", label: "Flag Type" },
        { key: "severity", label: "Severity" },
        { key: "message", label: "Message" },
        { key: "createdAt", label: "Created At" },
        { key: "resolved", label: "Resolved" },
      ],
      rows: flags.map((flag) => ({
        hrId: flag.hrId ?? "-",
        flagType: flag.flagType?.replace(/_/g, " ") ?? "unknown",
        severity: flag.severity ?? "-",
        message: flag.message ?? "-",
        createdAt: formatDate(flag.createdAt),
        resolved: flag.resolvedAt ? "yes" : "no",
      })),
    };
  })();

  const exportButton = (
    <ExportXlsxButton
      columns={exportData.columns}
      rows={exportData.rows}
      sheetName={selectedMeta.title}
      subtitle={selectedMeta.description}
      title={selectedMeta.title}
    />
  );

  let detailContent = <></>;
  let detailAction = (
    <div className="flex flex-wrap items-center gap-2">
      <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-bold text-slate-600">
        {selectedMeta.count} records
      </span>
      {exportButton}
    </div>
  );

  if (employeeDetailViews.has(selectedView)) {
    const selectedIssues = {
      "active-missing-access": activeMissingAccessIssues,
      "employee-issues": employeeIssues,
      "non-login-nodes": nonLoginIssues,
      "historical-records": historicalIssues,
      "vacancy-nodes": [],
      "salary-flags": [],
      "sales-issues": [],
      "orphan-hrids": [],
      "non-assignable-sales": [],
      "vacant-territory-sales": [],
      "line-level-sales": [],
      "other-sales-exceptions": [],
    }[selectedView];

    const pageCount = Math.max(1, Math.ceil(selectedIssues.length / PAGE_SIZE));
    const visibleIssues = selectedIssues.slice((employeePage - 1) * PAGE_SIZE, employeePage * PAGE_SIZE);

    detailContent = (
      <>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className={tableHeadClass}>
                {["HR_ID", "Employee Name", "Node Type", "Auth", "Manager HR_ID", "Status"].map((heading) => (
                  <th className="px-6 py-4 text-[10px] font-black uppercase tracking-[0.15em] text-slate-400" key={heading}>
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className={tableBodyClass}>
              {visibleIssues.length === 0 ? (
                <tr>
                  <td className="p-8 text-center text-sm font-medium text-slate-400" colSpan={6}>
                    No employee governance records match this card.
                  </td>
                </tr>
              ) : (
                visibleIssues.map((issue, index) => (
                  <tr className={tableRowClass} key={`${issue.hr_id}-${issue.health_status}-${index}`}>
                    <td className="px-6 py-4 font-mono text-sm font-bold text-slate-600">{issue.hr_id}</td>
                    <td className="px-6 py-4 text-sm font-bold text-slate-900">
                      <div>{issue.full_name}</div>
                      <div className="mt-1 text-xs font-medium text-slate-400">{issue.job_title || issue.reason}</div>
                    </td>
                    <td className="px-6 py-4">
                      <StatusBadge status={issue.node_type} />
                    </td>
                    <td className="px-6 py-4 text-xs font-semibold text-slate-500">
                      <div>Auth: {issue.has_auth_user ? "yes" : "no"}</div>
                      <div>Access: {issue.has_access_profile ? "yes" : "no"}</div>
                    </td>
                    <td className="px-6 py-4 font-mono text-sm text-slate-400">{issue.manager_hr_id ?? "-"}</td>
                    <td className="px-6 py-4">
                      <StatusBadge status={issue.health_status} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <Pagination
          from={selectedIssues.length === 0 ? 0 : (employeePage - 1) * PAGE_SIZE + 1}
          onPage={setEmployeePage}
          page={employeePage}
          pageCount={pageCount}
          to={Math.min(employeePage * PAGE_SIZE, selectedIssues.length)}
          total={selectedIssues.length}
        />
      </>
    );
  } else if (salesDetailViews.has(selectedView)) {
    const selectedIssues = {
      "sales-issues": stats.salesIssues,
      "non-assignable-sales": nonAssignableSalesIssues,
      "vacant-territory-sales": vacantTerritorySalesIssues,
      "line-level-sales": lineLevelSalesIssues,
      "other-sales-exceptions": otherSalesIssues,
      "active-missing-access": [],
      "employee-issues": [],
      "salary-flags": [],
      "orphan-hrids": [],
      "non-login-nodes": [],
      "historical-records": [],
      "vacancy-nodes": [],
    }[selectedView];

    const pageCount = Math.max(1, Math.ceil(selectedIssues.length / PAGE_SIZE));
    const visibleIssues = selectedIssues.slice((salesPage - 1) * PAGE_SIZE, salesPage * PAGE_SIZE);

    detailContent = (
      <>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className={tableHeadClass}>
                {["Month", "Owner", "Line / Territory", "Product", "Sales", "Status"].map((heading) => (
                  <th className="px-6 py-4 text-[10px] font-black uppercase tracking-[0.15em] text-slate-400" key={heading}>
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className={tableBodyClass}>
              {visibleIssues.length === 0 ? (
                <tr>
                  <td className="p-8 text-center text-sm font-medium text-slate-400" colSpan={6}>
                    No sales governance records match this card.
                  </td>
                </tr>
              ) : (
                visibleIssues.map((issue, index) => (
                  <tr
                    className={tableRowClass}
                    key={issue.record_id ?? `${issue.period ?? "row"}-${issue.row_number ?? "missing"}-${index}`}
                  >
                    {/* The canonical closing has no upload batch to cite, so the month is the
                        locator: it is what the owner needs to find the row in the closing. */}
                    <td className="px-6 py-4 font-mono text-xs font-bold text-slate-500">
                      {issue.period ?? "-"}
                    </td>
                    <td className="px-6 py-4 text-xs font-semibold text-slate-500">
                      <div>
                        Employee: <span className="font-mono">{issue.employee_hr_id ?? "-"}</span>
                      </div>
                      <div>
                        Manager: <span className="font-mono">{issue.manager_hr_id ?? "-"}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-xs font-semibold text-slate-500">
                      <div>{issue.line ?? "-"}</div>
                      <div className="text-slate-400">{issue.territory ?? "-"}</div>
                    </td>
                    <td className="px-6 py-4 text-sm font-medium text-slate-500">{issue.product}</td>
                    <td className="px-6 py-4 text-sm font-bold text-slate-700">{formatCurrency(issue.sales_value)}</td>
                    <td className="px-6 py-4">
                      <StatusBadge status={issue.linkage_health_status} />
                      <p className="mt-1 max-w-xs text-xs font-medium text-slate-400">{issue.reason}</p>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <Pagination
          from={selectedIssues.length === 0 ? 0 : (salesPage - 1) * PAGE_SIZE + 1}
          onPage={setSalesPage}
          page={salesPage}
          pageCount={pageCount}
          to={Math.min(salesPage * PAGE_SIZE, selectedIssues.length)}
          total={selectedIssues.length}
        />
      </>
    );
  } else if (selectedView === "vacancy-nodes") {
    const pageCount = Math.max(1, Math.ceil(vacancyAudit.length / PAGE_SIZE));
    const visibleVacancies = vacancyAudit.slice((employeePage - 1) * PAGE_SIZE, employeePage * PAGE_SIZE);

    detailContent = (
      <>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className={tableHeadClass}>
                {["Vacancy Code", "Line", "Area", "Manager HR_ID", "Status"].map((heading) => (
                  <th className="px-6 py-4 text-[10px] font-black uppercase tracking-[0.15em] text-slate-400" key={heading}>
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className={tableBodyClass}>
              {visibleVacancies.length === 0 ? (
                <tr>
                  <td className="p-8 text-center text-sm font-medium text-slate-400" colSpan={5}>
                    No vacant positions are recorded in the current structure.
                  </td>
                </tr>
              ) : (
                visibleVacancies.map((vacancy, index) => (
                  <tr className={tableRowClass} key={`${vacancy.vacancy_id ?? vacancy.vacancy_code ?? "vacancy"}-${index}`}>
                    <td className="px-6 py-4 font-mono text-sm font-bold text-slate-700">{vacancy.vacancy_code ?? vacancy.vacancy_id ?? "-"}</td>
                    <td className="px-6 py-4 text-sm font-medium text-slate-700">{vacancy.line_name ?? "-"}</td>
                    <td className="px-6 py-4 text-sm font-medium text-slate-500">{vacancy.area_name ?? "-"}</td>
                    <td className="px-6 py-4 font-mono text-sm text-slate-400">{vacancy.manager_hr_id ?? "-"}</td>
                    <td className="px-6 py-4">
                      <StatusBadge status={vacancy.status ?? "vacant"} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <Pagination
          from={vacancyAudit.length === 0 ? 0 : (employeePage - 1) * PAGE_SIZE + 1}
          onPage={setEmployeePage}
          page={employeePage}
          pageCount={pageCount}
          to={Math.min(employeePage * PAGE_SIZE, vacancyAudit.length)}
          total={vacancyAudit.length}
        />
      </>
    );
  } else if (selectedView === "orphan-hrids") {
    const pageCount = Math.max(1, Math.ceil(stats.orphanAudit.length / PAGE_SIZE));
    const visibleIssues = stats.orphanAudit.slice((orphanPage - 1) * PAGE_SIZE, orphanPage * PAGE_SIZE);

    detailContent = (
      <>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className={tableHeadClass}>
                {["Source", "HR_ID", "Count", "Sample Name"].map((heading) => (
                  <th className="px-6 py-4 text-[10px] font-black uppercase tracking-[0.15em] text-slate-400" key={heading}>
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className={tableBodyClass}>
              {visibleIssues.length === 0 ? (
                <tr>
                  <td className="p-8 text-center text-sm font-medium text-slate-400" colSpan={4}>
                    No orphan HR IDs found in the system.
                  </td>
                </tr>
              ) : (
                visibleIssues.map((orphan, index) => (
                  <tr className={tableRowClass} key={`${orphan.source}-${orphan.hr_id}-${index}`}>
                    <td className="px-6 py-4 text-[11px] font-bold uppercase tracking-tighter text-slate-400">
                      {orphan.source}
                    </td>
                    <td className="px-6 py-4 font-mono text-sm font-bold text-rose-500">{orphan.hr_id}</td>
                    <td className="px-6 py-4 text-sm font-bold text-slate-900">{orphan.rows_count}</td>
                    <td className="px-6 py-4 text-sm font-medium text-slate-500">{orphan.sample_name ?? "-"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <Pagination
          from={stats.orphanAudit.length === 0 ? 0 : (orphanPage - 1) * PAGE_SIZE + 1}
          onPage={setOrphanPage}
          page={orphanPage}
          pageCount={pageCount}
          to={Math.min(orphanPage * PAGE_SIZE, stats.orphanAudit.length)}
          total={stats.orphanAudit.length}
        />
      </>
    );
  } else {
    const pageCount = Math.max(1, Math.ceil(flags.length / PAGE_SIZE));
    const visibleFlags = flags.slice((salaryPage - 1) * PAGE_SIZE, salaryPage * PAGE_SIZE);

    detailAction = (
      <div className="flex flex-wrap items-center gap-2">
        {unresolvedCount > 0 ? (
          <span className="rounded-full border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
            {unresolvedCount} unresolved
          </span>
        ) : null}
        <label className="flex cursor-pointer items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600">
          <input
            checked={showResolved}
            className="h-3.5 w-3.5 accent-orange-500"
            onChange={(event) => handleToggleResolved(event.target.checked)}
            type="checkbox"
          />
          Show resolved
        </label>
        {exportButton}
      </div>
    );

    detailContent = (
      <>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className={tableHeadClass}>
                {["HR_ID", "Flag Type", "Severity", "Message", "Created At", "Action"].map((heading) => (
                  <th className="px-6 py-4 text-[10px] font-black uppercase tracking-[0.15em] text-slate-400" key={heading}>
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className={tableBodyClass}>
              {visibleFlags.length === 0 ? (
                <tr>
                  <td className="p-8 text-center text-sm font-medium text-slate-400" colSpan={6}>
                    {unresolvedCount === 0 ? "All salary flags have been resolved." : "No flags to display."}
                  </td>
                </tr>
              ) : (
                visibleFlags.map((flag) => (
                  <tr className={tableRowClass} key={flag.id}>
                    <td className="px-6 py-4 font-mono text-sm font-bold text-slate-600">{flag.hrId ?? "-"}</td>
                    <td className="px-6 py-4 text-sm font-medium text-slate-700">
                      <span className="rounded-full border border-orange-200 bg-orange-50 px-3 py-1 text-[11px] font-bold text-orange-700">
                        {flag.flagType?.replace(/_/g, " ") ?? "unknown"}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-sm text-slate-500">
                      <span className={cn(
                        "font-semibold",
                        flag.severity === "high"
                          ? "text-rose-600"
                          : flag.severity === "medium"
                            ? "text-amber-600"
                            : "text-slate-500",
                      )}
                      >
                        {flag.severity ?? "-"}
                      </span>
                    </td>
                    <td className="max-w-lg px-6 py-4 text-xs font-medium text-slate-500">
                      <span className="line-clamp-1">{flag.message ?? "-"}</span>
                    </td>
                    <td className="px-6 py-4 text-xs font-semibold text-slate-500">{formatDate(flag.createdAt)}</td>
                    <td className="px-6 py-4">
                      {flag.resolvedAt ? (
                        <span className="flex items-center gap-1.5 text-[10px] font-semibold text-emerald-600">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          Resolved
                        </span>
                      ) : (
                        <button
                          className="flex h-9 items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 text-[11px] font-bold text-emerald-700 transition hover:border-emerald-300 hover:bg-emerald-100 disabled:opacity-50"
                          disabled={resolvingId === flag.id}
                          onClick={() => handleResolveFlag(flag.id)}
                          type="button"
                        >
                          {resolvingId === flag.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <CheckCircle2 className="h-3.5 w-3.5" />
                          )}
                          Resolve
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <Pagination
          from={flags.length === 0 ? 0 : (salaryPage - 1) * PAGE_SIZE + 1}
          onPage={setSalaryPage}
          page={salaryPage}
          pageCount={pageCount}
          to={Math.min(salaryPage * PAGE_SIZE, flags.length)}
          total={flags.length}
        />
      </>
    );
  }

  return (
    <div className="space-y-6">
        <AdminPageHero
          badges={(
            <>
              <AdminInsightChip>{stats.summary.healthRate.toFixed(1)}% health</AdminInsightChip>
              <AdminInsightChip tone="slate">{stats.summary.activeEmployees} active employees</AdminInsightChip>
              <AdminInsightChip tone="orange">{stats.summary.issuesCount} data issues</AdminInsightChip>
            </>
          )}
          description="Open the queue you want, review only its records, and keep the governance page tidy instead of stacking long tables."
          eyebrow="Governance"
          icon={<ShieldCheck className="h-3.5 w-3.5" />}
          title="Data Health Governance"
        />

      <section>
        <SectionLabel eyebrow="Needs attention" title="Priority Queues" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-5">
          {priorityCards.map((card) => (
            <QueueCard
              active={selectedView === card.key}
              color={card.color}
              count={card.count}
              description={card.description}
              icon={card.icon}
              key={card.key}
              onClick={() => openDetail(card.key)}
              title={card.title}
            />
          ))}
        </div>
      </section>

      <section>
        <SectionLabel eyebrow="Drill-down" title="Supporting Views" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {supportingCards.map((card) => (
            <QueueCard
              active={selectedView === card.key}
              color={card.color}
              count={card.count}
              description={card.description}
              icon={card.icon}
              key={card.key}
              onClick={() => openDetail(card.key)}
              title={card.title}
            />
          ))}
        </div>
      </section>

      <section>
        <SectionLabel eyebrow="Overview" title="Health Summary" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-5">
          <SummaryCard color="blue" icon={Users} title="Total Structure" value={stats.summary.structureNodes} />
          <SummaryCard color="green" icon={Users} title="Active Employees" value={stats.summary.activeEmployees} />
          <SummaryCard color="green" icon={Heart} title="Healthy Records" value={stats.summary.healthyEmployees} />
          <SummaryCard
            color={stats.summary.healthRate > 95 ? "green" : stats.summary.healthRate > 80 ? "orange" : "rose"}
            icon={TrendingUp}
            title="Health Rate"
            value={`${stats.summary.healthRate.toFixed(1)}%`}
          />
          <SummaryCard
            color={stats.summary.unresolvedSalesExceptions > 0 ? "rose" : "green"}
            icon={Activity}
            title="Assigned Sales"
            value={`${stats.salesClassification.assigned_employee_sales.records} / ${formatCurrency(stats.salesClassification.assigned_employee_sales.salesValue)}`}
          />
          <SummaryCard
            color={stats.summary.marketingPharmacyCoverageRate > 95 ? "green" : stats.summary.marketingPharmacyCoverageRate > 80 ? "orange" : "rose"}
            icon={Activity}
            title="Pharmacy Map Coverage"
            value={`${stats.summary.marketingPharmacyCoverageRate.toFixed(0)}% · ${stats.summary.marketingUnmappedPharmacyTargets} unmapped`}
          />
        </div>
      </section>

      <div ref={detailRef}>
        <AdminTableShell
          action={detailAction}
          description={selectedMeta.description}
          title={selectedMeta.title}
        >
          {detailContent}
        </AdminTableShell>
      </div>
    </div>
  );
}

function QueueCard({
  active = false,
  color,
  count,
  description,
  icon: Icon,
  onClick,
  title,
}: QueueCardProps) {
  const accent = cardAccent[color];

  return (
    <button
      className={cn(
        "group relative overflow-hidden border border-slate-200 bg-white p-5 text-left shadow-[0_6px_20px_rgba(15,23,42,0.07)] transition duration-200",
        "hover:-translate-y-1 hover:border-orange-200/70 hover:shadow-[0_16px_38px_rgba(15,23,42,0.13)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2 active:translate-y-0",
        active && "border-orange-300/70 shadow-[0_16px_44px_rgba(249,115,22,0.14)] ring-1 ring-orange-200",
      )}
      onClick={onClick}
      type="button"
    >
      <div aria-hidden="true" className={cn("absolute inset-x-0 top-0 h-1 bg-gradient-to-r opacity-70 transition-opacity duration-200 group-hover:opacity-100", accent.bar)} />
      <div aria-hidden="true" className={cn("pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full blur-2xl", accent.glow)} />
      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">{title}</p>
          <p className={cn("mt-2.5 break-words text-3xl font-black tracking-[-0.035em]", accent.value)}>{count}</p>
        </div>
        <div className={cn("flex h-12 w-12 shrink-0 items-center justify-center shadow-sm ring-1", accent.icon)}>
          <Icon aria-hidden="true" className="h-6 w-6" />
        </div>
      </div>
      <p className="relative mt-3 text-xs leading-5 text-slate-500">{description}</p>
      <div className="relative mt-4 flex items-center gap-1 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-700">
        View details
        <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
      </div>
    </button>
  );
}

function SummaryCard({ color, icon: Icon, title, value }: SummaryCardProps) {
  const accent = cardAccent[color];

  return (
    <Card className="group relative overflow-hidden border border-slate-200 bg-white p-5 shadow-[0_6px_20px_rgba(15,23,42,0.07)] transition duration-200 hover:-translate-y-1 hover:border-orange-200/70 hover:shadow-[0_16px_38px_rgba(15,23,42,0.13)]">
      <div aria-hidden="true" className={cn("absolute inset-x-0 top-0 h-1 bg-gradient-to-r opacity-70 transition-opacity duration-200 group-hover:opacity-100", accent.bar)} />
      <div aria-hidden="true" className={cn("pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full blur-2xl", accent.glow)} />
      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">{title}</p>
          <p className={cn("mt-2.5 break-words text-xl font-black tracking-[-0.03em]", accent.value)}>{value}</p>
        </div>
        <div className={cn("flex h-12 w-12 shrink-0 items-center justify-center shadow-sm ring-1", accent.icon)}>
          <Icon aria-hidden="true" className="h-6 w-6" />
        </div>
      </div>
    </Card>
  );
}

function StatusBadge({ status }: { status: string }) {
  const isOk = ["ok", "active_employee", "assigned_employee_sales"].includes(status);
  const isWarning = [
    "missing_manager",
    "missing_line",
    "missing_area",
    "historical_record",
    "vacancy_node",
    "system_placeholder",
    "others_unassigned_node",
    "non_login_aggregation_node",
    "non_assignable_territory_sales",
    "vacant_territory_sales",
    "line_level_sales",
    "others_unassigned_sales",
  ].includes(status);

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-3 py-1 text-[11px] font-bold uppercase tracking-wider",
        isOk
          ? "border-emerald-200 bg-emerald-50/80 text-emerald-800"
          : isWarning
            ? "border-orange-200 bg-orange-50/80 text-orange-800"
            : "border-rose-200 bg-rose-50/80 text-rose-800",
      )}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}
