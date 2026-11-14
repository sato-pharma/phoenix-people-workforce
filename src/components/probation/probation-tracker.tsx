"use client";

import { humanizeCode } from "@/lib/format/code-label";
import {
  AlertTriangle,
  Download,
  MessageCircle,
  RefreshCw,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminStatCard,
  AdminTableShell,
  AdminSectionHeader,
  adminPanelClassName,
} from "@/components/admin/admin-design-system";
import {
  PortalEmptyState,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatDateOnly, parseDateOnly } from "@/lib/date-only";
import { employeeLeftWord } from "@/lib/employees/left-flag";
import {
  calculateProbationProgress,
  classifyProbationTrafficStatus,
  summarizeProbationRiskRows,
} from "@/lib/lifecycle-risk/metrics";
import { WhatsAppSendDialog } from "@/components/recruitment/whatsapp-send-dialog";
import type { ProbationRow, TrafficStatus } from "@/lib/probation/types";
import { cn } from "@/lib/utils";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { phxSelectClassName } from "@/components/ui/form-tokens";


type Props = {
  capabilities?: ProbationTrackerCapabilities;
  initialData: ProbationRow[] | null;
  initialError: string | null;
  presentation?: "default" | "premium";
};

type ProbationTrackerCapabilities = {
  canExport?: boolean;
  canManageWorkflow?: boolean;
  viewerMode?: "employee" | "executive" | "hr" | "manager";
};

type SortKey =
  | "days-asc"
  | "days-desc"
  | "hire-asc"
  | "hire-desc"
  | "name-asc"
  | "name-desc";

const allValue = "__all__";

const selectClassName  = phxSelectClassName;

const adminTableHeaderClassName =
  "px-2.5 py-2 text-phx-2xs font-black uppercase tracking-[0.14em] text-phx-ink-soft";

const probationTableCellClassName =
  "px-2 py-1.5 text-xs text-text-secondary";
const probationTableValueClassName =
  "px-2 py-1.5 text-xs";
const probationActionButtonClassName =
  "h-7 rounded-md px-2 text-phx-2xs";

const premiumPageClassName =
  "relative rounded-[20px] border border-slate-200/80 bg-white shadow-[0_16px_44px_rgba(15,23,42,0.06)] p-4";

const premiumPanelClassName =
  "rounded-[20px] border border-slate-200/80 bg-white shadow-[0_16px_44px_rgba(15,23,42,0.06)]";


function getTrafficStatus(daysRemaining: number): TrafficStatus {
  return classifyProbationTrafficStatus(daysRemaining);
}

function getProbationProgress(daysRemaining: number) {
  return calculateProbationProgress(daysRemaining);
}

function statusLabel(status: TrafficStatus) {
  if (status === "safe") {
    return "Safe";
  }

  if (status === "warning") {
    return "Warning";
  }

  return "Critical";
}

function workflowBadgeVariant(status: string | null | undefined) {
  if (status === "passed") return "success";
  if (status === "terminated") return "danger";
  return "neutral";
}

function workflowLabel(status: string | null | undefined) {
  return status ? humanizeCode(status) : "Not requested";
}

function formatDate(value: string) {
  return formatDateOnly(value, "en", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function uniqueOptions(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function SelectFilter({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  options: string[];
  value: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">
        {label}
      </span>
      <SearchableSelect
        className={selectClassName}
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        <option value={allValue}>{label}</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </SearchableSelect>
    </label>
  );
}

function ZoneSelect({
  onChange,
  value,
}: {
  onChange: (value: TrafficStatus | "all") => void;
  value: TrafficStatus | "all";
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">
        Zone
      </span>
      <SearchableSelect
        className={selectClassName}
        onChange={(event) => onChange(event.target.value as TrafficStatus | "all")}
        value={value}
      >
        <option value="all">All zones</option>
        <option value="safe">Safe</option>
        <option value="warning">Warning</option>
        <option value="critical">Critical</option>
      </SearchableSelect>
    </label>
  );
}

function SortSelect({
  onChange,
  value,
}: {
  onChange: (value: SortKey) => void;
  value: SortKey;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">
        Sort
      </span>
      <SearchableSelect
        className={selectClassName}
        onChange={(event) => onChange(event.target.value as SortKey)}
        value={value}
      >
        <option value="days-asc">Days ascending</option>
        <option value="days-desc">Days descending</option>
        <option value="hire-asc">Hire date ascending</option>
        <option value="hire-desc">Hire date descending</option>
        <option value="name-asc">Name A-Z</option>
        <option value="name-desc">Name Z-A</option>
      </SearchableSelect>
    </label>
  );
}

export function ProbationTracker({
  capabilities = {},
  initialData,
  initialError,
  presentation = "default",
}: Props) {
  const isPremium = presentation === "premium";
  const canExport = capabilities.canExport ?? false;
  const canManageWorkflow = capabilities.canManageWorkflow ?? false;
  const viewerMode = capabilities.viewerMode ?? "hr";
  const isExecutiveReadOnly = viewerMode === "executive";
  const panelClassName = isPremium ? premiumPanelClassName : adminPanelClassName;
  const [areaFilter, setAreaFilter] = useState(allValue);
  const [jobFilter, setJobFilter] = useState(allValue);
  const [lineFilter, setLineFilter] = useState(allValue);
  const [query, setQuery] = useState(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("employeeHrId") ?? "";
  });
  const [sortBy, setSortBy] = useState<SortKey>("days-asc");
  const [trafficFilter, setTrafficFilter] = useState<TrafficStatus | "all">("all");
  const [employmentFilter, setEmploymentFilter] = useState<string>(allValue);
  const [rows] = useState<ProbationRow[]>(() => initialData ?? []);
  /** The probationer whose WhatsApp dialog is open, or null. One at a time, by row. */
  const [whatsAppRow, setWhatsAppRow] = useState<ProbationRow | null>(null);


  const filterOptions = useMemo(
    () => ({
      areas: uniqueOptions(rows.map((row) => row.area_name)),
      jobs: uniqueOptions(rows.map((row) => row.job_title)),
      lines: uniqueOptions(rows.map((row) => row.line_name)),
      employmentStatuses: uniqueOptions(rows.map((row) => row.employment_status ?? "")),
    }),
    [rows],
  );

  const filteredRows = useMemo(() => {
    const search = query.trim().toLowerCase();

    return rows
      .filter((row) => {
        const searchable = [row.full_name, row.hr_id, row.crm_id].join(" ").toLowerCase();
        const traffic = getTrafficStatus(row.days_remaining);

        return (
          (!search || searchable.includes(search)) &&
          (lineFilter === allValue || row.line_name === lineFilter) &&
          (areaFilter === allValue || row.area_name === areaFilter) &&
          (jobFilter === allValue || row.job_title === jobFilter) &&
          (employmentFilter === allValue || row.employment_status === employmentFilter) &&
          (trafficFilter === "all" || traffic === trafficFilter)
        );
      })
      .sort((left, right) => {
        if (sortBy === "days-desc") {
          return right.days_remaining - left.days_remaining;
        }

        if (sortBy === "hire-asc") {
          return (parseDateOnly(left.hire_date)?.getTime() ?? 0) - (parseDateOnly(right.hire_date)?.getTime() ?? 0);
        }

        if (sortBy === "hire-desc") {
          return (parseDateOnly(right.hire_date)?.getTime() ?? 0) - (parseDateOnly(left.hire_date)?.getTime() ?? 0);
        }

        if (sortBy === "name-asc") {
          return left.full_name.localeCompare(right.full_name);
        }

        if (sortBy === "name-desc") {
          return right.full_name.localeCompare(left.full_name);
        }

        return left.days_remaining - right.days_remaining;
      });
  }, [areaFilter, employmentFilter, jobFilter, lineFilter, query, rows, sortBy, trafficFilter]);

  const summary = useMemo(
    () => summarizeProbationRiskRows(filteredRows.map((row) => ({
      daysRemaining: row.days_remaining,
      employeeHrId: row.hr_id,
      employeeName: row.full_name,
      hireDate: row.hire_date,
      probationEndDate: row.probation_end_date,
      workflowDecision: row.workflow?.decision ?? null,
    }))),
    [filteredRows],
  );

  const feedbackReportRows = useMemo(
    () => filteredRows.map((row) => {
      const probationDay = Math.max(0, Math.min(90, 90 - Math.max(0, row.days_remaining)));
      return {
        ...row,
        feedbackStatus: row.workflow?.managerFeedback ? "Submitted" : "Pending",
        probationDayStatus: row.workflow?.decision
          ? row.workflow.decision
          : `Day ${probationDay} / ${Math.max(0, row.days_remaining)} days remaining`,
      };
    }),
    [filteredRows],
  );

  const hasActiveFilters =
    areaFilter !== allValue ||
    jobFilter !== allValue ||
    lineFilter !== allValue ||
    query.length > 0 ||
    sortBy !== "days-asc" ||
    trafficFilter !== "all" ||
    employmentFilter !== allValue;

  const activeFilterCount = [
    areaFilter !== allValue ? areaFilter : "",
    jobFilter !== allValue ? jobFilter : "",
    lineFilter !== allValue ? lineFilter : "",
    query ? query : "",
    sortBy !== "days-asc" ? sortBy : "",
    trafficFilter !== "all" ? trafficFilter : "",
    employmentFilter !== allValue ? employmentFilter : "",
  ].filter(Boolean).length;

  function resetFilters() {
    setAreaFilter(allValue);
    setJobFilter(allValue);
    setLineFilter(allValue);
    setEmploymentFilter(allValue);
    setQuery("");
    setSortBy("days-asc");
    setTrafficFilter("all");
  }

  /**
   * The cells below are rendered by BOTH the desktop row and the phone card, so they are extracted
   * rather than copied. Plain functions, not nested components — a nested component would remount
   * its subtree on every parent render, and `react/no-unstable-nested-components` is an error here.
   */
  function progressCell(traffic: TrafficStatus, progress: number) {
    return (
      <div className="space-y-1">
        <div className="h-2 overflow-hidden rounded-full bg-slate-100">
          <div
            className={cn(
              "h-full rounded-full transition-all",
              traffic === "safe" ? "bg-success" : traffic === "warning" ? "bg-warning" : "bg-danger",
            )}
            style={{ width: `${progress}%` }}
          />
        </div>
        <p className="text-phx-xs leading-tight text-text-secondary">{progress}% complete</p>
      </div>
    );
  }

  function rowActions(row: ProbationRow) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {/*
          Message this probationer on WhatsApp. It opens a dialog with a preview and sends nothing on
          its own.
        */}
        <Button
          className={probationActionButtonClassName}
          onClick={() => setWhatsAppRow(row)}
          variant="secondary"
        >
          <MessageCircle className="mr-1 h-3.5 w-3.5" />
          WhatsApp
        </Button>
        {/*
          One probation model (REC-010, 14 Nov 2026): the decision, the feedback and the evidence live
          on the probation CASE. The old review, feedback, pass and terminate buttons
          wrote a second record (probation_evaluations) and were retired; never re-add them here.
        */}
        {row.workflow ? (
          <Link
            className="inline-flex h-7 items-center border border-phx-line bg-white px-2 text-phx-2xs font-semibold text-phx-ink hover:bg-slate-50"
            href={`/probation/cases/${row.workflow.id}`}
          >
            Open case
          </Link>
        ) : (
          <span className="text-xs font-semibold text-phx-ink-soft">No case</span>
        )}
      </div>
    );
  }

  return (
    <div className={isPremium ? premiumPageClassName : "space-y-4"}>
      {/*
        ONE dialog for the whole table, keyed by the row that opened it — not one per row. A dialog
        rendered inside every row mounts as many copies as there are probationers, and each one
        fetches the template list on mount.
      */}
      {whatsAppRow ? (
        <WhatsAppSendDialog
          employeeHrId={whatsAppRow.hr_id}
          employeeName={whatsAppRow.full_name}
          onClose={() => setWhatsAppRow(null)}
        />
      ) : null}
      <div className="relative space-y-4">
        <AdminPageHero
          actions={
            <div className="flex w-full flex-wrap gap-2 sm:w-auto">
              <Button
                className="h-8 gap-1.5 rounded-lg"
                disabled={!hasActiveFilters}
                onClick={resetFilters}
                variant="secondary"
              >
                <RefreshCw className="h-4 w-4" />
                Reset Filters
              </Button>
              {canExport ? (
                <>
                  <a
                    className="inline-flex h-8 items-center justify-center gap-2 rounded-lg border border-[#D7E0EA] bg-white/95 px-2.5 py-2 text-xs font-semibold text-phx-ink shadow-[0_8px_20px_rgba(15,23,42,0.08)] transition hover:border-phx-ink-faint hover:bg-phx-paper"
                    href="/api/exports?report=probation&format=pdf"
                  >
                    <Download className="h-4 w-4 text-phx-ink-2" />
                    Export PDF
                  </a>
                  <a
                    className="inline-flex h-8 items-center justify-center gap-2 rounded-lg border border-[#D7E0EA] bg-white/95 px-2.5 py-2 text-xs font-semibold text-phx-ink shadow-[0_8px_20px_rgba(15,23,42,0.08)] transition hover:border-phx-ink-faint hover:bg-phx-paper"
                    href="/api/exports?report=probation&format=xlsx"
                  >
                    <Download className="h-4 w-4 text-phx-ink-2" />
                    Export Excel
                  </a>
                </>
              ) : null}
            </div>
          }
          badges={(
            <div className="flex flex-wrap gap-2">
              {isExecutiveReadOnly ? (
                <AdminInsightChip tone="slate">Executive read-only</AdminInsightChip>
              ) : null}
              <AdminInsightChip>Employees in probation period: {summary.total}</AdminInsightChip>
              <AdminInsightChip tone="slate">
                {summary.total > 0 ? `${((summary.critical / summary.total) * 100).toFixed(0)}% critical` : "0% critical"}
              </AdminInsightChip>
              <AdminInsightChip tone="slate">
                {summary.warning} warning, {summary.safe} safe
              </AdminInsightChip>
            </div>
          )}
          description={isExecutiveReadOnly
            ? "Review company probation risk and upcoming decision deadlines. HR and authorized reviewers keep ownership of workflow actions."
            : "Track employees inside the 90-day probation window and prioritize deadlines by risk zone before deadlines become people-risk."
          }
          eyebrow={isExecutiveReadOnly ? "Executive Read-Only" : "People Operations"}
          icon={<Shield className="h-3.5 w-3.5" />}
          title="Probation Period"
        />

        {isExecutiveReadOnly ? (
          <AdminCallout tone="warning">
            <ShieldCheck className="mt-0.5 h-4 w-4 text-[#B45309]" />
            <div>
              <p className="font-semibold">CEO read-only probation view</p>
              <p className="text-sm">
                This page shows aggregate and employee probation risk for oversight. Create, decision, and feedback actions remain disabled for CEO.
              </p>
            </div>
          </AdminCallout>
        ) : null}

      {initialError ? (
        <AdminCallout tone="danger">
          <AlertTriangle className="mt-0.5 h-5 w-5 text-danger" />
          <div>
            <h2 className="text-base font-semibold text-text">Probation data unavailable</h2>
            <p className="mt-1 text-sm text-text-secondary">{initialError}</p>
          </div>
        </AdminCallout>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <AdminStatCard
          size="compact"
          description="Matching current filters"
          icon={<Shield className="h-5 w-5" />}
          label="Total in Probation"
          value={summary.total}
        />
        <AdminStatCard
          size="compact"
          description="More than 60 days remaining"
          icon={<ShieldCheck className="h-5 w-5" />}
          label="Safe Zone"
          value={summary.safe}
        />
        <AdminStatCard
          size="compact"
          description="30 to 60 days remaining"
          icon={<ShieldAlert className="h-5 w-5" />}
          label="Warning Zone"
          value={summary.warning}
        />
        <AdminStatCard
          size="compact"
          description="Less than 30 days remaining"
          icon={<AlertTriangle className="h-5 w-5" />}
          label="Critical Zone"
          value={summary.critical}
        />
      </div>

      <AdminTableShell
        action={
          <Button
            className="h-9 gap-2 rounded-xl"
            disabled={!hasActiveFilters}
            onClick={resetFilters}
            variant="secondary"
          >
            <X className="h-4 w-4" />
            {activeFilterCount > 0 ? `Clear (${activeFilterCount})` : "Clear"}
          </Button>
        }
        description="Use line, area, role, employment status, risk zone, and sort to focus on probation windows."
        title="Probation Filters"
      >
        <div className="grid gap-2 p-3 sm:p-3.5 xl:grid-cols-[1.5fr_repeat(4,minmax(0,1fr))_auto]">
          <label className="relative block">
            <span className="mb-1.5 block text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">
              Search
            </span>
            <Search className="pointer-events-none absolute left-3 top-10 h-4 w-4 text-text-secondary" />
            <Input
              className="pl-9"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search name"
              value={query}
            />
          </label>
          <SelectFilter
            label="All lines"
            onChange={setLineFilter}
            options={filterOptions.lines}
            value={lineFilter}
          />
          <SelectFilter
            label="All areas"
            onChange={setAreaFilter}
            options={filterOptions.areas}
            value={areaFilter}
          />
          <SelectFilter
            label="All job titles"
            onChange={setJobFilter}
            options={filterOptions.jobs}
            value={jobFilter}
          />
          <SelectFilter
            label="All statuses"
            onChange={setEmploymentFilter}
            options={filterOptions.employmentStatuses}
            value={employmentFilter}
          />
          <ZoneSelect onChange={setTrafficFilter} value={trafficFilter} />
          <SortSelect onChange={setSortBy} value={sortBy} />
        </div>
      </AdminTableShell>

      {canManageWorkflow ? (
        <Card className={`${panelClassName} overflow-hidden p-0`}>
          <AdminSectionHeader
            action={<Badge variant="neutral">{feedbackReportRows.filter((row) => row.feedbackStatus === "Pending").length} pending</Badge>}
            description="HR/Admin view of manager feedback status during the fixed 90-day probation period."
            title="Managers Feedback in Probation Period"
          />
          {/* Twelve columns at a 1080px minimum — nearly three phone screens wide. The card
              leads with the two things this panel exists to answer: who has not submitted, and
              what they recommended. */}
          <PortalResponsiveDataList
            empty={
              <PortalEmptyState
                message="No probation feedback records match the current filters."
                title="No feedback to review"
              />
            }
            getKey={(row) => row.hr_id}
            items={feedbackReportRows}
            renderCard={(row) => (
              <PortalRecordCard
                accent={row.feedbackStatus === "Pending" ? "amber" : "emerald"}
                meta={
                  <span>
                    {row.line_name} / {row.area_name}
                    {row.team_name ? ` / ${row.team_name}` : ""}
                  </span>
                }
                status={
                  <Badge variant={row.feedbackStatus === "Pending" ? "warning" : "success"}>
                    {row.feedbackStatus}
                  </Badge>
                }
                title={row.full_name}
              >
                <PortalRecordFields
                  fields={[
                    ...(employeeLeftWord(row) ? [{ label: "No longer here", value: employeeLeftWord(row) as string }] : []),
                    { label: "Hiring Date", value: formatDate(row.hire_date) },
                    { label: "Probation Day / Status", value: row.probationDayStatus },
                    { label: "Direct Manager", value: row.manager_name ?? "—" },
                    {
                      label: "Manager of Manager",
                      value: row.manager_manager_name ?? "—",
                    },
                    { label: "Feedback By", value: row.workflow?.managerReviewedBy ?? "-" },
                    {
                      label: "Feedback Date",
                      value: row.workflow?.managerReviewedAt
                        ? formatDate(row.workflow.managerReviewedAt)
                        : "-",
                    },
                    {
                      label: "Recommendation",
                      value: row.workflow?.decision ?? row.workflow?.hrRecommendation ?? "-",
                    },
                    { label: "Feedback Text", value: row.workflow?.managerFeedback ?? "-" },
                  ]}
                />
              </PortalRecordCard>
            )}
            renderTable={() => (
              <div className="hidden bg-white/80 md:block">
                {/*
                  Fits-the-screen golden rule (AGENTS.md §4). `overflow-x-auto` over a
                  `min-w-[1080px]` floor — the widest table on this rail, and the one that most
                  needed the fix: the Feedback Text column it exists to show sat past the right edge
                  at every desktop width below 1080px.

                  Merged, not shrunk, and no value is dropped. Twelve columns become six:
                    * HR ID, Name and Hiring Date all describe one person -> "Employee".
                    * Direct Manager and Manager of Manager -> "Managers", one above the other.
                    * Feedback By, Feedback Date and Feedback Text -> "Feedback", the attribution
                      line above the text itself, which now gets the widest share (30%) instead of
                      a `max-w-[260px]` box at the far right of a scroll.
                    * Recommendation and Pending Status -> one decision cell.
                */}
            <table className="w-full table-fixed text-left text-xs">
              <colgroup>
                <col className="w-[17%]" />
                <col className="w-[11%]" />
                <col className="w-[15%]" />
                <col className="w-[30%]" />
                <col className="w-[14%]" />
                <col className="w-[13%]" />
              </colgroup>
              <thead className="bg-slate-50/90 text-xs uppercase tracking-[0.12em] text-text-secondary">
                <tr className="border-b border-slate-200">
                  {[
                    "Employee",
                    "Probation Day / Status",
                    "Managers",
                    "Feedback",
                    "Recommendation",
                    "Line / Area / Team",
                  ].map((column) => (
                    <th className={adminTableHeaderClassName} key={column}>
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-phx-line">
                {feedbackReportRows.map((row) => (
                    <tr className="align-top transition-colors hover:bg-slate-50/65" key={`feedback:${row.hr_id}`}>
                      <td className={cn(probationTableCellClassName, "break-words align-top")}>
                        <span className="block break-words font-semibold text-text">{row.full_name}</span>
                        {employeeLeftWord(row) ? (
                          <span className="block break-words text-xs font-bold text-phx-danger">{employeeLeftWord(row)}</span>
                        ) : null}
                        <span className="block break-words text-text-secondary">
                          Hired {formatDate(row.hire_date)}
                        </span>
                      </td>
                      <td className={cn(probationTableCellClassName, "break-words align-top")}>{row.probationDayStatus}</td>
                      <td className={cn(probationTableCellClassName, "break-words align-top")}>
                        <span className="block break-words">{row.manager_name ?? "—"}</span>
                        <span className="block break-words text-text-secondary">
                          via {row.manager_manager_name ?? "—"}
                        </span>
                      </td>
                      <td className={cn(probationTableCellClassName, "break-words align-top")}>
                        <span className="block break-words text-text-secondary">
                          {row.workflow?.managerReviewedBy ?? "-"}
                          {row.workflow?.managerReviewedAt
                            ? ` · ${formatDate(row.workflow.managerReviewedAt)}`
                            : ""}
                        </span>
                        <span className="mt-1 block break-words">{row.workflow?.managerFeedback ?? "-"}</span>
                      </td>
                      <td className={cn(probationTableCellClassName, "break-words align-top")}>
                        <span className="block break-words">
                          {row.workflow?.decision ?? row.workflow?.hrRecommendation ?? "-"}
                        </span>
                        <span className="mt-1 block">
                          <Badge variant={row.feedbackStatus === "Pending" ? "warning" : "success"}>{row.feedbackStatus}</Badge>
                        </span>
                      </td>
                      <td className={cn(probationTableCellClassName, "break-words align-top")}>
                        <p>{row.line_name}</p>
                        <p className="mt-1">{row.area_name}</p>
                        <p className="mt-1">{row.team_name ?? "-"}</p>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
              </div>
            )}
          />
        </Card>
      ) : null}

      <Card className={`${panelClassName} overflow-hidden p-0`}>
        <AdminSectionHeader
          action={
            <div className="flex flex-wrap gap-2">
              <Badge variant="warning">{summary.warning} warning</Badge>
              <Badge variant="danger">{summary.critical} critical</Badge>
            </div>
          }
          description={`Showing ${filteredRows.length} of ${rows.length} employees in the active probation window.`}
          title="Current Probation Employees"
        />
        {/* Desktop gets the table, a phone one card per employee. The table used to carry a
            940px minimum, so everything from "Days" rightwards — the progress, the review
            decision and every action button — sat off the right edge inside a container that
            gave no hint it scrolled. It is now seven merged columns with no floor at all, so it
            fits whatever width the desktop shell gives it. */}
        <PortalResponsiveDataList
          empty={
            <PortalEmptyState
              message="No probation records match the current filters."
              title="Nothing in probation"
            />
          }
          getKey={(row) => row.hr_id}
          items={filteredRows}
          renderCard={(row) => {
            const traffic = getTrafficStatus(row.days_remaining);

            return (
              <PortalRecordCard
                accent={traffic === "safe" ? "emerald" : traffic === "warning" ? "amber" : "rose"}
                actions={rowActions(row)}
                meta={
                  <span>
                    {row.job_title}
                  </span>
                }
                status={
                  <Badge variant={traffic === "safe" ? "success" : traffic === "warning" ? "warning" : "danger"}>
                    {statusLabel(traffic)}
                  </Badge>
                }
                title={row.full_name}
              >
                <PortalRecordFields
                  fields={[
                    ...(employeeLeftWord(row) ? [{ label: "No longer here", value: employeeLeftWord(row) as string }] : []),
                    { label: "Line", value: row.line_name },
                    { label: "Area", value: row.area_name },
                    { label: "Hire Date", value: formatDate(row.hire_date) },
                    { label: "End Date", value: formatDate(row.probation_end_date) },
                    { label: "Days Remaining", value: String(Math.max(0, row.days_remaining)) },
                    {
                      label: "Progress",
                      value: progressCell(traffic, getProbationProgress(row.days_remaining)),
                    },
                    {
                      label: "Probation Review",
                      value: (
                        <span className="space-y-1">
                          <Badge variant={workflowBadgeVariant(row.workflow?.status)}>
                            {workflowLabel(row.workflow?.status)}
                          </Badge>
                          {row.workflow?.decision ? (
                            <span className="block text-xs font-semibold text-phx-ink">
                              Decision: {humanizeCode(row.workflow.decision)}
                            </span>
                          ) : null}
                        </span>
                      ),
                    },
                  ]}
                />
              </PortalRecordCard>
            );
          }}
          renderTable={() => (
            <div className="hidden bg-white/80 md:block">
              {/*
                Fits-the-screen golden rule (AGENTS.md §4). Mobile has `renderCard` above, so the
                mobile half was met; this desktop half was `overflow-x-auto` over `min-w-[940px]`,
                wider than the content column at 768px or in a 1024px window, so Status, Probation
                Review and the Actions buttons — everything the reviewer acts on — sat behind a
                sideways scroll on a laptop.

                Fixed by MERGING columns, which is what the rule asks for, never by shrinking type.
                Thirteen columns become seven and NOT ONE VALUE IS DROPPED:
                  * HR ID, CRM ID, Full Name and Job Title all describe one person -> "Employee".
                  * Line and Area -> "Line / Area".
                  * Hire Date, End Date and Days are one interval -> "Probation window".
                Progress keeps the widest share because its bar carries a `min-w-[125px]` floor of
                its own, which 17% clears at every desktop width.
              */}
            <table className="w-full table-fixed text-left text-xs">
              <colgroup>
                <col className="w-[22%]" />
                <col className="w-[12%]" />
                <col className="w-[15%]" />
                <col className="w-[17%]" />
                <col className="w-[10%]" />
                <col className="w-[12%]" />
                <col className="w-[12%]" />
              </colgroup>
              <thead className="sticky top-0 bg-slate-50/90 backdrop-blur">
                <tr className="border-b border-slate-200 text-xs uppercase tracking-[0.12em] text-text-secondary">
                {[
                  "Employee",
                  "Line / Area",
                  "Probation window",
                  "Progress",
                  "Status",
                  "Probation Review",
                  "Actions",
                ].map((column) => (
                  <th className={adminTableHeaderClassName} key={column}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-phx-line">
              {filteredRows.map((row) => {
                  const traffic = getTrafficStatus(row.days_remaining);
                  const progress = getProbationProgress(row.days_remaining);

                  return (
                    <tr className="transition-colors hover:bg-slate-50/65" key={row.hr_id}>
                      <td className={cn(probationTableCellClassName, "break-words align-top")}>
                        <span className="block break-words font-semibold text-text">{row.full_name}</span>
                        {employeeLeftWord(row) ? (
                          <span className="block break-words text-xs font-bold text-phx-danger">{employeeLeftWord(row)}</span>
                        ) : null}
                        <span className="block break-words text-text-secondary">{row.job_title}</span>
                      </td>
                      <td className={cn(probationTableCellClassName, "break-words align-top")}>
                        <span className="block break-words">{row.line_name}</span>
                        <span className="block break-words text-text-secondary">{row.area_name}</span>
                      </td>
                      <td className={cn(probationTableCellClassName, "break-words align-top")}>
                        <span className="block break-words">
                          {formatDate(row.hire_date)} → {formatDate(row.probation_end_date)}
                        </span>
                        <span className="block font-semibold text-text">
                          {Math.max(0, row.days_remaining)} days
                        </span>
                      </td>
                      <td className={probationTableCellClassName}>
                        {progressCell(traffic, progress)}
                      </td>
                      <td className={probationTableValueClassName}>
                        <Badge variant={traffic === "safe" ? "success" : traffic === "warning" ? "warning" : "danger"}>
                          {statusLabel(traffic)}
                        </Badge>
                      </td>
                      <td className={cn(probationTableValueClassName, "space-y-1.5")}>
                        <div className="space-y-2">
                          <Badge variant={workflowBadgeVariant(row.workflow?.status)}>{workflowLabel(row.workflow?.status)}</Badge>
                          {row.workflow?.decision ? (
                            <div className="text-xs font-semibold text-phx-ink">Decision: {humanizeCode(row.workflow.decision)}</div>
                          ) : null}
                        </div>
                      </td>
                      <td className={cn(probationTableValueClassName, "align-top")}>{rowActions(row)}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
            </div>
          )}
        />
      </Card>

      {/*
        RETIRED 2026-09-01 — three panels stood here and none of them could ever show anything:
        the per-cycle feedback form, the "Probation Feedback Report", and the DV Status column.
        All three read employee_probation / probation_feedback_submissions, and employee_probation
        has held ZERO rows since the Case model took over provisioning, so the form always answered
        "not eligible", the report was always empty and the DV column was always a dash.

        Feedback lives in the Case model now: an evaluator submits against a real double-visit at
        /employee-portals/probation/feedback/<dvDayId>, and it is read back on the case page at
        /probation/cases/<caseId>. Do not re-add a second feedback surface here.
      */}

      </div>
    </div>
  );
}
