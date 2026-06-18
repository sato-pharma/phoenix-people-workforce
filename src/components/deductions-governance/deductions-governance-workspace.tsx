"use client";

import { useCallback, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileSpreadsheet,
  Loader2,
  RefreshCw,
  Save,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";

import {
  AdminCallout,
  AdminPageHero,
  AdminStatCard,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  deductionDecisionReasons,
  deductionDecisionStatuses,
  deductionSeverities,
  deductionSourceModules,
  deductionTypes,
  type DeductionDecisionReason,
  type DeductionDecisionStatus,
  type DeductionSeverity,
  type DeductionSourceModule,
  type DeductionType,
} from "@/lib/deductions-governance/types";
import type {
  DeductionAuditEvent,
  DeductionCommentFeedItem,
  DeductionEmployeeGroup,
  DeductionInboxFilters,
  DeductionInboxKpis,
  DeductionInboxPage,
  DeductionInboxRow,
  DeductionSourceGroup,
} from "@/lib/deductions-governance/service";
import { cn } from "@/lib/utils";
import { SearchableSelect } from "@/components/ui/searchable-select";


type WorkspaceTab =
  | "overview"
  | "inbox"
  | "by-source"
  | "by-employee"
  | "final-approved"
  | "disputes"
  | "comments"
  | "audit";

const workspaceTabs: Array<{ id: WorkspaceTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "inbox", label: "Deduction Inbox" },
  { id: "by-source", label: "By Source" },
  { id: "by-employee", label: "By Employee" },
  { id: "final-approved", label: "Final Approved Deductions" },
  { id: "disputes", label: "Disputes" },
  { id: "comments", label: "Employee Comments" },
  { id: "audit", label: "Audit Trail" },
];

const pageSizeOptions = [25, 50, 100] as const;

type ApiPayload = {
  success: boolean;
  message?: string;
  kpis?: DeductionInboxKpis;
  inbox?: DeductionInboxPage;
  bySource?: DeductionSourceGroup[];
  byEmployee?: DeductionEmployeeGroup[];
  finalApproved?: DeductionInboxRow[];
  disputes?: DeductionInboxRow[];
  audit?: DeductionAuditEvent[];
  comments?: DeductionCommentFeedItem[];
};

type PayrollPreviewPayload = {
  preview?: {
    blockers: string[];
    canImport: boolean;
    rows: Array<{
      delta: number;
      employeeCode: string;
      employeeName: string | null;
      matched: boolean;
      appliedTotals: {
        crm: number;
        fingerPrint: number;
        unpaidVacations: number;
      };
      existingTotals: {
        crm: number;
        fingerPrint: number;
        unpaidVacations: number;
      };
      resultingTotals: {
        crm: number;
        fingerPrint: number;
        unpaidVacations: number;
      };
    }>;
    totals: {
      crm: number;
      fingerPrint: number;
      total: number;
      unpaidVacations: number;
    };
  };
  success?: boolean;
  message?: string;
};

export type DeductionsGovernanceWorkspaceProps = {
  availableMonthKeys?: string[];
  canEditDecisions: boolean;
  canSync?: boolean;
  defaultMonthKey?: string;
  initialAudit: DeductionAuditEvent[] | null;
  initialByEmployee: DeductionEmployeeGroup[] | null;
  initialBySource: DeductionSourceGroup[] | null;
  initialComments: DeductionCommentFeedItem[] | null;
  initialDisputes: DeductionInboxRow[] | null;
  initialError: string | null;
  initialFinalApproved: DeductionInboxRow[] | null;
  initialInbox: DeductionInboxPage | null;
  initialKpis: DeductionInboxKpis | null;
};

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-EG").format(value);
}

function formatMoney(value: number): string {
  return new Intl.NumberFormat("en-EG", {
    currency: "EGP",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(value);
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "-";
  try {
    return new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function severityBadgeVariant(severity: DeductionSeverity | null) {
  switch (severity) {
    case "High":
      return "danger" as const;
    case "Medium":
      return "warning" as const;
    case "Review":
      return "warning" as const;
    case "Low":
      return "success" as const;
    default:
      return "neutral" as const;
  }
}

function decisionBadgeVariant(status: DeductionDecisionStatus) {
  switch (status) {
    case "Approved for Payroll":
    case "Approved for Leave Adjustment":
    case "Resolved":
      return "success" as const;
    case "Disputed":
    case "Needs Follow-up":
      return "danger" as const;
    case "Pending":
      return "warning" as const;
    default:
      return "neutral" as const;
  }
}

function buildFiltersQuery(filters: DeductionInboxFilters, page: number, pageSize: number): string {
  const params = new URLSearchParams();
  if (filters.monthKey) params.set("monthKey", filters.monthKey);
  if (filters.sourceModule) params.set("sourceModule", filters.sourceModule);
  if (filters.deductionType) params.set("deductionType", filters.deductionType);
  if (filters.decisionStatus) params.set("decisionStatus", filters.decisionStatus);
  if (filters.severity) params.set("severity", filters.severity);
  if (filters.employeeSearch) params.set("employeeSearch", filters.employeeSearch);
  if (filters.includeSuperseded) params.set("includeSuperseded", "true");
  params.set("page", String(page));
  params.set("pageSize", String(pageSize));
  return params.toString();
}

function WorkspaceTabsBar({
  activeTab,
  onChange,
}: {
  activeTab: WorkspaceTab;
  onChange: (tab: WorkspaceTab) => void;
}) {
  return (
    <div className="phoenix-horizontal-scroll overflow-x-auto rounded-2xl border border-slate-200 bg-white/90 p-1.5 shadow-sm">
      <div className="flex min-w-max gap-1.5">
        {workspaceTabs.map((tab) => (
          <button
            aria-pressed={activeTab === tab.id}
            className={cn(
              "rounded-xl px-4 py-2 text-sm font-black transition",
              activeTab === tab.id
                ? "bg-slate-950 text-white shadow-[0_12px_24px_rgba(15,23,42,0.18)]"
                : "text-slate-600 hover:bg-orange-50 hover:text-orange-700",
            )}
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function KpiGrid({ kpis }: { kpis: DeductionInboxKpis }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <AdminStatCard
        description="All non-superseded deduction candidates matching the active filters."
        icon={<ScrollText className="h-5 w-5" />}
        label="Total Candidates"
        tone="orange"
        value={formatNumber(kpis.total)}
      />
      <AdminStatCard
        description="Awaiting HR decision."
        icon={<AlertTriangle className="h-5 w-5" />}
        label="Pending"
        tone={kpis.pending > 0 ? "orange" : "emerald"}
        value={formatNumber(kpis.pending)}
      />
      <AdminStatCard
        description="HR approved to be finalized and imported into the monthly payroll workbook."
        icon={<ShieldCheck className="h-5 w-5" />}
        label="Approved for Payroll"
        tone="blue"
        value={formatNumber(kpis.approvedForPayroll)}
      />
      <AdminStatCard
        description="HR approved to be settled through a leave-balance adjustment."
        icon={<ShieldCheck className="h-5 w-5" />}
        label="Approved for Leave Adjustment"
        tone="violet"
        value={formatNumber(kpis.approvedForLeaveAdjustment)}
      />
      <AdminStatCard
        description="Marked as not actionable."
        icon={<ShieldAlert className="h-5 w-5" />}
        label="Do Not Take Action"
        tone="emerald"
        value={formatNumber(kpis.doNotTakeAction)}
      />
      <AdminStatCard
        description="Needs follow-up or under dispute."
        icon={<AlertTriangle className="h-5 w-5" />}
        label="Disputed / Follow-up"
        tone={kpis.disputed + kpis.needsFollowUp > 0 ? "rose" : "emerald"}
        value={formatNumber(kpis.disputed + kpis.needsFollowUp)}
      />
      <AdminStatCard
        description="Distinct employees represented in the current filter set."
        icon={<ScrollText className="h-5 w-5" />}
        label="Employees Affected"
        tone="orange"
        value={formatNumber(kpis.employeesAffected)}
      />
      <AdminStatCard
        description="Sum of estimated_amount for Approved for Payroll + Approved for Leave Adjustment rows. NULL amounts excluded."
        icon={<ShieldCheck className="h-5 w-5" />}
        label="Estimated Amount Subtotal"
        tone="blue"
        value={formatMoney(kpis.estimatedAmountSubtotal)}
      />
    </div>
  );
}

function InboxFiltersBar({
  availableMonthKeys,
  filters,
  onChange,
  pageSize,
  onPageSizeChange,
  isLoading,
  onRefresh,
}: {
  availableMonthKeys: string[];
  filters: DeductionInboxFilters;
  onChange: (next: DeductionInboxFilters) => void;
  pageSize: number;
  onPageSizeChange: (next: number) => void;
  isLoading: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="grid gap-3 border-b border-slate-100 p-4 lg:grid-cols-[160px_180px_180px_180px_minmax(0,1fr)_140px]">
      {availableMonthKeys.length > 0 ? (
        <SearchableSelect
          className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
          value={filters.monthKey ?? ""}
          onChange={(event) => onChange({ ...filters, monthKey: event.target.value || undefined })}
        >
          <option value="">All months</option>
          {availableMonthKeys.map((mk) => (
            <option key={mk} value={mk}>{mk}</option>
          ))}
        </SearchableSelect>
      ) : (
        <input
          className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
          placeholder="Month (YYYY-MM)"
          value={filters.monthKey ?? ""}
          onChange={(event) => onChange({ ...filters, monthKey: event.target.value || undefined })}
        />
      )}
      <SearchableSelect
        className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
        value={filters.sourceModule ?? ""}
        onChange={(event) =>
          onChange({
            ...filters,
            sourceModule: event.target.value
              ? (event.target.value as DeductionSourceModule)
              : undefined,
          })
        }
      >
        <option value="">All sources</option>
        {deductionSourceModules.map((source) => (
          <option key={source} value={source}>
            {source}
          </option>
        ))}
      </SearchableSelect>
      <SearchableSelect
        className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
        value={filters.deductionType ?? ""}
        onChange={(event) =>
          onChange({
            ...filters,
            deductionType: event.target.value
              ? (event.target.value as DeductionType)
              : undefined,
          })
        }
      >
        <option value="">All types</option>
        {deductionTypes.map((type) => (
          <option key={type} value={type}>
            {type}
          </option>
        ))}
      </SearchableSelect>
      <SearchableSelect
        className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
        value={filters.decisionStatus ?? ""}
        onChange={(event) =>
          onChange({
            ...filters,
            decisionStatus: event.target.value
              ? (event.target.value as DeductionDecisionStatus)
              : undefined,
          })
        }
      >
        <option value="">All decision statuses</option>
        {deductionDecisionStatuses.map((status) => (
          <option key={status} value={status}>
            {status}
          </option>
        ))}
      </SearchableSelect>
      <input
        className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
        placeholder="Search employee name or HR_ID"
        value={filters.employeeSearch ?? ""}
        onChange={(event) =>
          onChange({ ...filters, employeeSearch: event.target.value })
        }
      />
      <div className="flex items-center gap-2">
        <SearchableSelect
          className="h-10 flex-1 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
          value={pageSize}
          onChange={(event) => onPageSizeChange(Number(event.target.value))}
        >
          {pageSizeOptions.map((size) => (
            <option key={size} value={size}>
              {size} rows
            </option>
          ))}
        </SearchableSelect>
        <Button
          className="gap-2"
          disabled={isLoading}
          type="button"
          variant="secondary"
          onClick={onRefresh}
        >
          {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Refresh
        </Button>
      </div>
      <SearchableSelect
        className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
        value={filters.severity ?? ""}
        onChange={(event) =>
          onChange({
            ...filters,
            severity: event.target.value
              ? (event.target.value as DeductionSeverity)
              : undefined,
          })
        }
      >
        <option value="">All severities</option>
        {deductionSeverities.map((severity) => (
          <option key={severity} value={severity}>
            {severity}
          </option>
        ))}
      </SearchableSelect>
    </div>
  );
}

function InboxTable({
  rows,
  canEditDecisions,
  onDecisionSaved,
}: {
  rows: DeductionInboxRow[];
  canEditDecisions: boolean;
  onDecisionSaved?: () => void;
}) {
  return (
    <div className="phoenix-horizontal-scroll max-h-[60vh] overflow-auto">
      <table className="w-full min-w-[1320px] text-left text-sm">
        <thead className="sticky top-0 z-10 bg-slate-50 text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">
          <tr>
            <th className="px-4 py-3">Employee</th>
            <th className="px-4 py-3">Code</th>
            <th className="px-4 py-3">Source</th>
            <th className="px-4 py-3">Type</th>
            <th className="px-4 py-3">Month</th>
            <th className="px-4 py-3">Unit</th>
            <th className="px-4 py-3">Value</th>
            <th className="px-4 py-3">Estimated / Calc</th>
            <th className="px-4 py-3">Severity</th>
            <th className="px-4 py-3">Decision</th>
            <th className="px-4 py-3">Reason</th>
            <th className="px-4 py-3">HR Note</th>
            <th className="px-4 py-3">Handoff</th>
            <th className="px-4 py-3">Created</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => {
            const status: DeductionDecisionStatus = row.decision?.decisionStatus ?? "Pending";
            return (
              <tr className="align-top text-slate-700 hover:bg-slate-50/70" key={row.id}>
                <td className="px-4 py-3">
                  <p className="font-black text-slate-950">{row.employeeName ?? "-"}</p>
                </td>
                <td className="px-4 py-3 font-mono text-xs font-semibold text-slate-500">{row.employeeCode}</td>
                <td className="px-4 py-3"><Badge variant="neutral">{row.sourceModule}</Badge></td>
                <td className="px-4 py-3 text-xs font-semibold">{row.deductionType}</td>
                <td className="whitespace-nowrap px-4 py-3 font-mono text-xs">{row.monthKey}</td>
                <td className="px-4 py-3 text-xs">{row.deductionUnit}</td>
                <td className="px-4 py-3 font-mono text-xs font-bold">{formatNumber(row.deductionValue)}</td>
                <td className="px-4 py-3 text-xs">
                  {row.estimatedAmount !== null
                    ? formatMoney(row.estimatedAmount)
                    : <span className="text-slate-400">{row.calculationStatus}</span>}
                </td>
                <td className="px-4 py-3">
                  <Badge variant={severityBadgeVariant(row.severity)}>
                    {row.severity ?? "-"}
                  </Badge>
                </td>
                <td className="px-4 py-3">
                  {canEditDecisions ? (
                    <DecisionControls row={row} onSaved={onDecisionSaved} />
                  ) : (
                    <Badge variant={decisionBadgeVariant(status)}>{status}</Badge>
                  )}
                </td>
                <td className="max-w-[240px] px-4 py-3 text-xs leading-5 text-slate-600">{row.decision?.decisionReason || "-"}</td>
                <td className="max-w-[240px] px-4 py-3 text-xs leading-5 text-slate-600">{row.decision?.hrNote || "-"}</td>
                <td className="px-4 py-3 text-xs">{row.decision?.payrollHandoffStatus ?? "Not pushed"}</td>
                <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-500">{formatDateTime(row.createdAt)}</td>
              </tr>
            );
          })}
          {rows.length === 0 ? (
            <tr>
              <td className="px-4 py-8 text-center text-sm text-slate-500" colSpan={14}>
                No deduction candidates match the current filters.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function DecisionControls({
  row,
  onSaved,
}: {
  row: DeductionInboxRow;
  onSaved?: () => void;
}) {
  const [status, setStatus] = useState<DeductionDecisionStatus>(
    row.decision?.decisionStatus ?? "Pending",
  );
  const [appliedValue, setAppliedValue] = useState<string>(
    row.decision?.appliedDeductionValue == null
      ? String(row.deductionValue)
      : String(row.decision.appliedDeductionValue),
  );
  const [reason, setReason] = useState<string>(
    row.decision?.decisionReason || "Policy violation",
  );
  const [hrNote, setHrNote] = useState<string>(row.decision?.hrNote ?? "");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const save = useCallback(async () => {
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/deductions-governance/decisions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appliedDeductionValue: status === "Approved for Payroll" ? Number(appliedValue) : null,
          candidateId: row.id,
          decisionReason: status === "Pending" ? "" : reason,
          decisionStatus: status,
          hrNote,
        }),
      });
      const payload = (await response.json()) as { success?: boolean; message?: string };
      if (!response.ok || !payload.success) {
        setMessage(payload.message ?? "Decision save failed.");
        return;
      }
      setMessage("Saved");
      onSaved?.();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Decision save failed.");
    } finally {
      setSaving(false);
    }
  }, [appliedValue, hrNote, onSaved, reason, row.id, status]);

  return (
    <div className="min-w-[260px] space-y-2">
      <SearchableSelect
        className="h-9 w-full rounded-lg border border-slate-200 bg-white px-2 text-xs font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
        value={status}
        onChange={(event) => setStatus(event.target.value as DeductionDecisionStatus)}
      >
        {deductionDecisionStatuses.map((item) => (
          <option key={item} value={item}>
            {item}
          </option>
        ))}
      </SearchableSelect>
      {status === "Approved for Payroll" ? (
        <div className="grid grid-cols-[1fr_1fr] gap-2">
          <label className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">
            Original
            <input
              className="mt-1 h-8 w-full rounded-lg border border-slate-100 bg-slate-50 px-2 font-mono text-xs text-slate-500"
              readOnly
              value={row.deductionValue}
            />
          </label>
          <label className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">
            Apply
            <input
              className="mt-1 h-8 w-full rounded-lg border border-slate-200 bg-white px-2 font-mono text-xs text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
              min="0"
              step="0.25"
              type="number"
              value={appliedValue}
              onChange={(event) => setAppliedValue(event.target.value)}
            />
          </label>
        </div>
      ) : null}
      {status !== "Pending" ? (
        <SearchableSelect
          className="h-9 w-full rounded-lg border border-slate-200 bg-white px-2 text-xs font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
          value={reason}
          onChange={(event) => setReason(event.target.value as DeductionDecisionReason)}
        >
          {deductionDecisionReasons.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </SearchableSelect>
      ) : null}
      <input
        className="h-9 w-full rounded-lg border border-slate-200 bg-white px-2 text-xs font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
        placeholder="HR note"
        value={hrNote}
        onChange={(event) => setHrNote(event.target.value)}
      />
      <div className="flex items-center gap-2">
        <Button className="h-8 gap-1.5 px-2 text-xs" disabled={saving} type="button" onClick={() => void save()}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Save
        </Button>
        {message ? (
          <span className={cn(
            "text-[11px] font-semibold",
            message === "Saved" ? "text-emerald-600" : "text-rose-600",
          )}>
            {message}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function BySourcePanel({ groups }: { groups: DeductionSourceGroup[] }) {
  if (groups.length === 0) {
    return (
      <Card className="p-6 text-sm text-slate-500">
        No source-level activity in the current filter set.
      </Card>
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {groups.map((group) => (
        <Card className="rounded-2xl border border-slate-200 bg-white/95 p-5 shadow-sm" key={group.sourceModule}>
          <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">{group.sourceModule}</p>
          <p className="mt-2 text-3xl font-black tracking-tight text-slate-900">{formatNumber(group.count)}</p>
          <dl className="mt-4 grid grid-cols-2 gap-2 text-xs font-semibold text-slate-600">
            <div><dt className="text-slate-400">Pending</dt><dd>{formatNumber(group.pending)}</dd></div>
            <div><dt className="text-slate-400">Disputed</dt><dd>{formatNumber(group.disputed)}</dd></div>
            <div><dt className="text-slate-400">Appr. Payroll</dt><dd>{formatNumber(group.approvedForPayroll)}</dd></div>
            <div><dt className="text-slate-400">Appr. Leave</dt><dd>{formatNumber(group.approvedForLeaveAdjustment)}</dd></div>
          </dl>
          <p className="mt-4 text-xs text-slate-500">
            Estimated (calculated only): <span className="font-semibold text-slate-700">{formatMoney(group.estimatedAmountCalculatedSubtotal)}</span>
          </p>
        </Card>
      ))}
    </div>
  );
}

function ByEmployeePanel({ groups }: { groups: DeductionEmployeeGroup[] }) {
  return (
    <div className="phoenix-horizontal-scroll max-h-[60vh] overflow-auto">
      <table className="w-full min-w-[920px] text-left text-sm">
        <thead className="sticky top-0 z-10 bg-slate-50 text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">
          <tr>
            <th className="px-4 py-3">Employee</th>
            <th className="px-4 py-3">Code</th>
            <th className="px-4 py-3">Total</th>
            <th className="px-4 py-3">Pending</th>
            <th className="px-4 py-3">Appr. Payroll</th>
            <th className="px-4 py-3">Appr. Leave</th>
            <th className="px-4 py-3">Disputed</th>
            <th className="px-4 py-3">Months</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {groups.map((group) => (
            <tr className="text-slate-700 hover:bg-slate-50/70" key={group.employeeCode}>
              <td className="px-4 py-3 font-black text-slate-950">{group.employeeName}</td>
              <td className="px-4 py-3 font-mono text-xs">{group.employeeCode}</td>
              <td className="px-4 py-3">{formatNumber(group.totalCandidates)}</td>
              <td className="px-4 py-3">{formatNumber(group.pending)}</td>
              <td className="px-4 py-3">{formatNumber(group.approvedForPayroll)}</td>
              <td className="px-4 py-3">{formatNumber(group.approvedForLeaveAdjustment)}</td>
              <td className="px-4 py-3">{formatNumber(group.disputed)}</td>
              <td className="max-w-[240px] px-4 py-3 text-xs">{group.monthsAffected.join(", ") || "-"}</td>
            </tr>
          ))}
          {groups.length === 0 ? (
            <tr>
              <td className="px-4 py-8 text-center text-sm text-slate-500" colSpan={8}>
                No employees match the current filters.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      {groups.length === 100 ? (
        <p className="px-4 py-3 text-xs text-slate-400">
          Showing top 100. Refine filters to narrow further.
        </p>
      ) : null}
    </div>
  );
}

function AuditPanel({ events }: { events: DeductionAuditEvent[] }) {
  if (events.length === 0) {
    return (
      <Card className="p-6 text-sm text-slate-500">
        Audit trail will populate as HR decisions and exports are recorded.
      </Card>
    );
  }
  return (
    <div className="divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white/95">
      {events.map((event) => (
        <div className="grid gap-1 px-4 py-3 sm:grid-cols-[180px_140px_120px_minmax(0,1fr)]" key={event.id}>
          <span className="text-xs text-slate-500">{formatDateTime(event.createdAt)}</span>
          <span className="text-xs font-semibold text-slate-700">{event.actorLoginId}</span>
          <span className="text-xs font-mono text-slate-500">{event.entityType ?? "-"}</span>
          <span className="text-xs text-slate-700">{event.summary ?? "-"}</span>
        </div>
      ))}
    </div>
  );
}

function CommentsPanel({ comments }: { comments: DeductionCommentFeedItem[] }) {
  if (comments.length === 0) {
    return (
      <Card className="p-6 text-sm text-slate-500">
        Employee comments will appear here after employees respond to finalized deductions.
      </Card>
    );
  }

  return (
    <div className="divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white/95">
      {comments.map((comment) => (
        <div className="grid gap-2 px-4 py-3 lg:grid-cols-[180px_220px_160px_minmax(0,1fr)]" key={comment.id}>
          <div>
            <p className="text-xs font-semibold text-slate-500">{formatDateTime(comment.createdAt)}</p>
            <p className="mt-1 font-mono text-[11px] font-semibold text-slate-400">{comment.authorHrId ?? comment.authorLoginId}</p>
          </div>
          <div>
            <p className="text-sm font-black text-slate-900">{comment.employeeName ?? comment.employeeCode ?? "-"}</p>
            <p className="mt-1 font-mono text-xs text-slate-500">{comment.employeeCode ?? comment.candidateId}</p>
          </div>
          <div className="flex flex-wrap items-start gap-1.5">
            {comment.monthKey ? <Badge variant="success">{comment.monthKey}</Badge> : null}
            {comment.sourceModule ? <Badge variant="neutral">{comment.sourceModule}</Badge> : null}
            {comment.deductionType ? <Badge variant="warning">{comment.deductionType}</Badge> : null}
          </div>
          <p className="text-sm leading-6 text-slate-700">{comment.body}</p>
        </div>
      ))}
    </div>
  );
}

export function DeductionsGovernanceWorkspace(props: DeductionsGovernanceWorkspaceProps) {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("overview");
  const [filters, setFilters] = useState<DeductionInboxFilters>(
    props.defaultMonthKey ? { monthKey: props.defaultMonthKey } : {},
  );
  const [pageSize, setPageSize] = useState<number>(50);
  const [page, setPage] = useState<number>(1);

  const [kpis, setKpis] = useState<DeductionInboxKpis | null>(props.initialKpis);
  const [inbox, setInbox] = useState<DeductionInboxPage | null>(props.initialInbox);
  const [bySource, setBySource] = useState<DeductionSourceGroup[] | null>(props.initialBySource);
  const [byEmployee, setByEmployee] = useState<DeductionEmployeeGroup[] | null>(props.initialByEmployee);
  const [finalApproved, setFinalApproved] = useState<DeductionInboxRow[] | null>(props.initialFinalApproved);
  const [disputes, setDisputes] = useState<DeductionInboxRow[] | null>(props.initialDisputes);
  const [audit, setAudit] = useState<DeductionAuditEvent[] | null>(props.initialAudit);
  const [comments, setComments] = useState<DeductionCommentFeedItem[] | null>(props.initialComments);
  const [error, setError] = useState<string | null>(props.initialError);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [isFinalizing, setIsFinalizing] = useState<boolean>(false);
  const [isImportingPayroll, setIsImportingPayroll] = useState<boolean>(false);
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [payrollPreview, setPayrollPreview] = useState<PayrollPreviewPayload["preview"] | null>(null);
  const [syncStatus, setSyncStatus] = useState<
    | { kind: "success"; created: number; skippedExisting: number; sourceTotal: number; warnings: number }
    | { kind: "error"; message: string }
    | null
  >(null);
  const [actionStatus, setActionStatus] = useState<
    | { kind: "success"; message: string }
    | { kind: "error"; message: string }
    | null
  >(null);

  const totalPages = useMemo(() => {
    if (!inbox || inbox.pageSize <= 0) return 1;
    return Math.max(1, Math.ceil(inbox.total / inbox.pageSize));
  }, [inbox]);

  const refresh = useCallback(async (nextPage = page, nextPageSize = pageSize) => {
    setIsLoading(true);
    setError(null);
    try {
      const query = buildFiltersQuery(filters, nextPage, nextPageSize);
      const response = await fetch(`/api/admin/deductions-governance?${query}`, {
        cache: "no-store",
      });
      const payload = (await response.json()) as ApiPayload;
      if (!payload.success) {
        setError(payload.message ?? "Failed to refresh Deductions Governance Center.");
        return;
      }
      if (payload.kpis) setKpis(payload.kpis);
      if (payload.inbox) setInbox(payload.inbox);
      if (payload.bySource) setBySource(payload.bySource);
      if (payload.byEmployee) setByEmployee(payload.byEmployee);
      if (payload.finalApproved) setFinalApproved(payload.finalApproved);
      if (payload.disputes) setDisputes(payload.disputes);
      if (payload.audit) setAudit(payload.audit);
      if (payload.comments) setComments(payload.comments);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to refresh.");
    } finally {
      setIsLoading(false);
    }
  }, [filters, page, pageSize]);

  const syncAllSources = useCallback(async () => {
    const monthKeyForSync = filters.monthKey;
    if (!monthKeyForSync) {
      setSyncStatus({
        kind: "error",
        message: "Select a monthKey filter before syncing deduction sources.",
      });
      return;
    }
    if (typeof window !== "undefined") {
      const confirmed = window.confirm(
        "Sync FWC absence, fingerprint lateness, and unpaid vacation candidates for the current month? This will not modify payroll or leave balances.",
      );
      if (!confirmed) return;
    }
    setIsSyncing(true);
    setSyncStatus(null);
    try {
      const response = await fetch(
        "/api/admin/deductions-governance/sync/all",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ monthKey: monthKeyForSync }),
        },
      );
      const payload = (await response.json()) as {
        success?: boolean;
        message?: string;
        sourceTotal?: number;
        created?: number;
        skippedExisting?: number;
        warnings?: string[];
      };
      if (!response.ok || !payload.success) {
        setSyncStatus({
          kind: "error",
          message: payload.message ?? "Deductions source sync failed.",
        });
        return;
      }
      setSyncStatus({
        kind: "success",
        created: payload.created ?? 0,
        skippedExisting: payload.skippedExisting ?? 0,
        sourceTotal: payload.sourceTotal ?? 0,
        warnings: Array.isArray(payload.warnings) ? payload.warnings.length : 0,
      });
      await refresh(1, pageSize);
    } catch (caught) {
      setSyncStatus({
        kind: "error",
        message: caught instanceof Error ? caught.message : "Deductions source sync failed.",
      });
    } finally {
      setIsSyncing(false);
    }
  }, [filters.monthKey, refresh, pageSize]);

  const finalizeCurrentMonth = useCallback(async () => {
    const monthKey = filters.monthKey;
    if (!monthKey) {
      setActionStatus({ kind: "error", message: "Select a monthKey filter before finalizing." });
      return;
    }
    if (typeof window !== "undefined" && !window.confirm(`Finalize approved deductions for ${monthKey}?`)) return;
    setIsFinalizing(true);
    setActionStatus(null);
    try {
      const response = await fetch("/api/admin/deductions-governance/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ monthKey }),
      });
      const payload = (await response.json()) as { success?: boolean; message?: string; summary?: { candidateCount?: number; totalAmount?: number } };
      if (!response.ok || !payload.success) {
        setActionStatus({ kind: "error", message: payload.message ?? "Finalization failed." });
        return;
      }
      setActionStatus({
        kind: "success",
        message: `Finalized ${formatNumber(payload.summary?.candidateCount ?? 0)} deduction(s), total ${formatMoney(payload.summary?.totalAmount ?? 0)}.`,
      });
      await refresh(1, pageSize);
    } catch (caught) {
      setActionStatus({ kind: "error", message: caught instanceof Error ? caught.message : "Finalization failed." });
    } finally {
      setIsFinalizing(false);
    }
  }, [filters.monthKey, pageSize, refresh]);

  const previewPayrollImport = useCallback(async () => {
    const monthKey = filters.monthKey;
    if (!monthKey) {
      setActionStatus({ kind: "error", message: "Select a monthKey filter before payroll preview." });
      return;
    }
    setActionStatus(null);
    try {
      const response = await fetch(`/api/admin/deductions-governance/payroll-preview?monthKey=${encodeURIComponent(monthKey)}`, {
        cache: "no-store",
      });
      const payload = (await response.json()) as PayrollPreviewPayload;
      if (!response.ok || !payload.success || !payload.preview) {
        setActionStatus({ kind: "error", message: payload.message ?? "Payroll preview failed." });
        return;
      }
      setPayrollPreview(payload.preview);
      setActionStatus({
        kind: payload.preview.canImport ? "success" : "error",
        message: payload.preview.canImport
          ? `Payroll preview ready: ${formatMoney(payload.preview.totals.total)} total.`
          : payload.preview.blockers.join(" "),
      });
    } catch (caught) {
      setActionStatus({ kind: "error", message: caught instanceof Error ? caught.message : "Payroll preview failed." });
    }
  }, [filters.monthKey]);

  const exportCurrentMonth = useCallback(async () => {
    const monthKey = filters.monthKey;
    if (!monthKey) {
      setActionStatus({ kind: "error", message: "Select a monthKey filter before export." });
      return;
    }
    setIsExporting(true);
    setActionStatus(null);
    try {
      const response = await fetch("/api/admin/deductions-governance/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ monthKey }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { message?: string } | null;
        setActionStatus({ kind: "error", message: payload?.message ?? "Deductions export failed." });
        return;
      }
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const matchedName = disposition.match(/filename="([^"]+)"/)?.[1];
      const fileName = matchedName ?? `phoenix-deductions-governance-${monthKey}.xlsx`;
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);
      setActionStatus({ kind: "success", message: `Export generated: ${fileName}` });
      await refresh(page, pageSize);
    } catch (caught) {
      setActionStatus({ kind: "error", message: caught instanceof Error ? caught.message : "Deductions export failed." });
    } finally {
      setIsExporting(false);
    }
  }, [filters.monthKey, page, pageSize, refresh]);

  const confirmPayrollImport = useCallback(async () => {
    const monthKey = filters.monthKey;
    if (!monthKey) {
      setActionStatus({ kind: "error", message: "Select a monthKey filter before payroll import." });
      return;
    }
    if (!payrollPreview?.canImport) {
      setActionStatus({ kind: "error", message: "Open a clean payroll preview before import." });
      return;
    }
    if (typeof window !== "undefined" && !window.confirm(`Import approved deductions into payroll for ${monthKey}?`)) return;
    setIsImportingPayroll(true);
    setActionStatus(null);
    try {
      const response = await fetch("/api/admin/deductions-governance/payroll-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ monthKey }),
      });
      const payload = (await response.json()) as { success?: boolean; message?: string };
      if (!response.ok || !payload.success) {
        setActionStatus({ kind: "error", message: payload.message ?? "Payroll import failed." });
        return;
      }
      setActionStatus({ kind: "success", message: "Deductions imported to payroll." });
      setPayrollPreview(null);
      await refresh(1, pageSize);
    } catch (caught) {
      setActionStatus({ kind: "error", message: caught instanceof Error ? caught.message : "Payroll import failed." });
    } finally {
      setIsImportingPayroll(false);
    }
  }, [filters.monthKey, pageSize, payrollPreview?.canImport, refresh]);

  const inboxRows = inbox?.rows ?? [];
  const safeKpis = kpis ?? {
    total: 0,
    pending: 0,
    approvedForPayroll: 0,
    approvedForLeaveAdjustment: 0,
    doNotTakeAction: 0,
    needsFollowUp: 0,
    disputed: 0,
    resolved: 0,
    cancelled: 0,
    employeesAffected: 0,
    activeSources: 0,
    estimatedAmountSubtotal: 0,
  };

  return (
    <div className="min-w-0 space-y-4 sm:space-y-5">
      <AdminPageHero
        actions={
          props.canSync ? (
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={isSyncing || isLoading}
                onClick={() => {
                  void syncAllSources();
                }}
                title="Imports pending candidates from FWC absence, fingerprint attendance, and unpaid vacation. Does not execute payroll or modify leave balances."
                type="button"
                variant="secondary"
              >
                {isSyncing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                <span className="ml-2">Sync Sources</span>
              </Button>
              <Button
                disabled={isFinalizing || isLoading}
                onClick={() => {
                  void finalizeCurrentMonth();
                }}
                type="button"
                variant="secondary"
              >
                {isFinalizing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                <span className="ml-2">Finalize Month</span>
              </Button>
              <Button
                disabled={isLoading}
                onClick={() => {
                  void previewPayrollImport();
                }}
                type="button"
                variant="secondary"
              >
                <FileSpreadsheet className="h-4 w-4" />
                <span className="ml-2">Payroll Preview</span>
              </Button>
              <Button
                disabled={isExporting || isLoading}
                onClick={() => {
                  void exportCurrentMonth();
                }}
                type="button"
                variant="secondary"
              >
                {isExporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />}
                <span className="ml-2">Export</span>
              </Button>
              <Button
                disabled={isImportingPayroll || !payrollPreview?.canImport}
                onClick={() => {
                  void confirmPayrollImport();
                }}
                type="button"
              >
                {isImportingPayroll ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                <span className="ml-2">Confirm Import</span>
              </Button>
            </div>
          ) : null
        }
        description="HR governance workspace for deduction candidates from FWC absence, fingerprint attendance, and unpaid vacation. Payroll import requires preview first."
        eyebrow="Workforce Governance"
        icon={<ShieldCheck className="h-3.5 w-3.5" />}
        title="Deductions Governance Center"
      />

      {syncStatus ? (
        <AdminCallout tone={syncStatus.kind === "success" ? "success" : "danger"}>
          {syncStatus.kind === "success" ? (
            <ShieldCheck className="mt-0.5 h-4 w-4" />
          ) : (
            <AlertTriangle className="mt-0.5 h-4 w-4" />
          )}
          <p>
            {syncStatus.kind === "success"
              ? `Synced ${formatNumber(syncStatus.created)} new candidate(s). Skipped ${formatNumber(syncStatus.skippedExisting)} existing. Source rows: ${formatNumber(syncStatus.sourceTotal)}. Warnings: ${formatNumber(syncStatus.warnings)}.`
              : `Sync failed: ${syncStatus.message}`}
          </p>
        </AdminCallout>
      ) : null}

      {actionStatus ? (
        <AdminCallout tone={actionStatus.kind === "success" ? "success" : "danger"}>
          {actionStatus.kind === "success" ? (
            <ShieldCheck className="mt-0.5 h-4 w-4" />
          ) : (
            <AlertTriangle className="mt-0.5 h-4 w-4" />
          )}
          <p>{actionStatus.message}</p>
        </AdminCallout>
      ) : null}

      {payrollPreview ? (
        <Card className="rounded-2xl border border-slate-200 bg-white/95 p-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-black text-slate-900">Payroll Import Preview</p>
              <p className="mt-1 text-xs text-slate-500">
                CRM {formatMoney(payrollPreview.totals.crm)} / Finger Print {formatMoney(payrollPreview.totals.fingerPrint)} / Unpaid Vacations {formatMoney(payrollPreview.totals.unpaidVacations)}
              </p>
            </div>
            <Badge variant={payrollPreview.canImport ? "success" : "danger"}>
              {payrollPreview.canImport ? "Ready" : "Blocked"}
            </Badge>
          </div>
          {payrollPreview.blockers.length > 0 ? (
            <ul className="mt-3 space-y-1 text-xs font-semibold text-rose-600">
              {payrollPreview.blockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          ) : null}
          <div className="phoenix-horizontal-scroll mt-3 max-h-64 overflow-auto">
            <table className="w-full min-w-[780px] text-left text-xs">
              <thead className="bg-slate-50 font-black uppercase tracking-[0.12em] text-slate-500">
                <tr>
                  <th className="px-3 py-2">Employee</th>
                  <th className="px-3 py-2">Code</th>
                  <th className="px-3 py-2">Matched</th>
                  <th className="px-3 py-2">CRM (now + add = new)</th>
                  <th className="px-3 py-2">Finger Print (now + add = new)</th>
                  <th className="px-3 py-2">Unpaid Vacations (now + add = new)</th>
                  <th className="px-3 py-2">Total Added</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {payrollPreview.rows.slice(0, 50).map((row) => (
                  <tr key={row.employeeCode}>
                    <td className="px-3 py-2 font-semibold text-slate-800">{row.employeeName ?? "-"}</td>
                    <td className="px-3 py-2 font-mono text-slate-500">{row.employeeCode}</td>
                    <td className="px-3 py-2">
                      <Badge variant={row.matched ? "success" : "danger"}>{row.matched ? "Matched" : "Unmatched"}</Badge>
                    </td>
                    <td className="px-3 py-2">{formatMoney(row.existingTotals.crm)} + {formatMoney(row.appliedTotals.crm)} = {formatMoney(row.resultingTotals.crm)}</td>
                    <td className="px-3 py-2">{formatMoney(row.existingTotals.fingerPrint)} + {formatMoney(row.appliedTotals.fingerPrint)} = {formatMoney(row.resultingTotals.fingerPrint)}</td>
                    <td className="px-3 py-2">{formatMoney(row.existingTotals.unpaidVacations)} + {formatMoney(row.appliedTotals.unpaidVacations)} = {formatMoney(row.resultingTotals.unpaidVacations)}</td>
                    <td className={cn("px-3 py-2 font-mono font-bold", row.delta > 0 ? "text-rose-600" : "text-slate-500")}>
                      {formatMoney(row.delta)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      <AdminCallout tone="neutral">
        <ShieldAlert className="mt-0.5 h-4 w-4" />
        <p>
          This module collects deduction candidates from operational sources for HR review.
          It does not change leave balances. Payroll changes happen only after a clean preview
          and explicit Confirm Import action by Admin HR or B-10.
        </p>
      </AdminCallout>

      {error ? (
        <AdminCallout tone="danger">
          <AlertTriangle className="mt-0.5 h-4 w-4" />
          <p>{error}</p>
        </AdminCallout>
      ) : null}

      <WorkspaceTabsBar activeTab={activeTab} onChange={setActiveTab} />

      {activeTab === "overview" ? (
        safeKpis.total === 0 ? (
          <Card className="p-8 text-center text-sm text-slate-500">
            <p className="text-base font-black text-slate-700">No deduction candidates yet.</p>
            <p className="mt-2">Select a month and sync sources to populate this inbox.</p>
          </Card>
        ) : (
          <KpiGrid kpis={safeKpis} />
        )
      ) : null}

      {activeTab === "inbox" ? (
        <AdminTableShell
          description="Filter, sort, review, and decide the live deduction candidate pool."
          title="Deduction Inbox"
        >
          <InboxFiltersBar
            availableMonthKeys={props.availableMonthKeys ?? []}
            filters={filters}
            isLoading={isLoading}
            pageSize={pageSize}
            onChange={(next) => {
              setFilters(next);
              setPage(1);
            }}
            onPageSizeChange={(size) => {
              setPageSize(size);
              setPage(1);
              void refresh(1, size);
            }}
            onRefresh={() => {
              setPage(1);
              void refresh(1, pageSize);
            }}
          />
          <InboxTable
            canEditDecisions={props.canEditDecisions}
            rows={inboxRows}
            onDecisionSaved={() => {
              void refresh(page, pageSize);
            }}
          />
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-4 py-3 text-xs font-semibold text-slate-500">
            <span>
              Showing {inboxRows.length ? (page - 1) * pageSize + 1 : 0}-
              {Math.min(page * pageSize, inbox?.total ?? 0)} of {formatNumber(inbox?.total ?? 0)} candidates
            </span>
            <div className="flex items-center gap-2">
              <Button
                disabled={page <= 1 || isLoading}
                type="button"
                variant="secondary"
                onClick={() => {
                  const next = Math.max(1, page - 1);
                  setPage(next);
                  void refresh(next, pageSize);
                }}
              >
                Previous
              </Button>
              <span>Page {page} / {totalPages}</span>
              <Button
                disabled={page >= totalPages || isLoading}
                type="button"
                variant="secondary"
                onClick={() => {
                  const next = Math.min(totalPages, page + 1);
                  setPage(next);
                  void refresh(next, pageSize);
                }}
              >
                Next
              </Button>
            </div>
          </div>
        </AdminTableShell>
      ) : null}

      {activeTab === "by-source" ? (
        <BySourcePanel groups={bySource ?? []} />
      ) : null}

      {activeTab === "by-employee" ? (
        <AdminTableShell
          description="Roll-up by employee across the current filter set. Top 100 by candidate count."
          title="By Employee"
        >
          <ByEmployeePanel groups={byEmployee ?? []} />
        </AdminTableShell>
      ) : null}

      {activeTab === "final-approved" ? (
        <div className="space-y-3">
          <AdminCallout tone="warning">
            <ShieldAlert className="mt-0.5 h-4 w-4" />
            <p>
              This view shows HR-approved deductions queued for monthly finalization and payroll preview.
              Leave balances are never changed from this workspace.
            </p>
          </AdminCallout>
          <AdminTableShell
            description="HR-approved candidates queued for finalization and payroll handoff."
            title="Final Approved Deductions"
          >
            <InboxTable canEditDecisions={false} rows={finalApproved ?? []} />
          </AdminTableShell>
        </div>
      ) : null}

      {activeTab === "disputes" ? (
        <AdminTableShell
          description="Candidates in Disputed, Needs Follow-up, or Resolved status."
          title="Disputes"
        >
          <InboxTable canEditDecisions={false} rows={disputes ?? []} />
        </AdminTableShell>
      ) : null}

      {activeTab === "comments" ? (
        <AdminTableShell
          description="Employee responses to finalized deductions. Comments are informational only and do not reopen payroll."
          title="Employee Comments"
        >
          <CommentsPanel comments={comments ?? []} />
        </AdminTableShell>
      ) : null}

      {activeTab === "audit" ? (
        <AuditPanel events={audit ?? []} />
      ) : null}
    </div>
  );
}
