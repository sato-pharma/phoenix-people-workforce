"use client";

import {
  AlertTriangle,
  BadgeCheck,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ListFilter,
  Loader2,
  RefreshCw,
  Search,
  ShieldAlert,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import {
  AdminCallout,
  AdminPageHero,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import {
  PortalDesktopTable,
  PortalEmptyState,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type {
  FieldWorkforceCellStatus,
  FieldWorkforceDecisionReason,
  FieldWorkforceDayCell,
  FieldWorkforceDecisionStatus,
  FieldWorkforceEmployeeSummary,
  FieldWorkforceFinalAction,
  FieldWorkforcePreviewResult,
  FieldWorkforceRecommendation,
  FieldWorkforceRecommendationsReport,
  FieldWorkforceReviewCandidate,
  FieldWorkforceSeverity,
  FieldWorkforceValidationIssue,
} from "@/lib/field-workforce-compliance/types";
import type { FieldWorkforceEmployeeTrend, FieldWorkforceLiveMonthOption, FieldWorkforceLiveViewResult, FieldWorkforceMirrorFreshness } from "@/lib/field-workforce-compliance/live-snapshots";
import {
  buildFieldWorkforceLineScorecards,
  buildFieldWorkforceManagerScorecards,
  type FieldWorkforceGroupScorecard,
} from "@/lib/field-workforce-compliance/scorecards";
import { cn } from "@/lib/utils";
import { buildManagerChain, managerFilterOptions, matchesManagerFilter } from "@/lib/org/manager-filter";
import { handlePossibleSessionDeath } from "@/lib/auth/client-session";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { HeadOfficeAttendancePanel } from "@/components/field-workforce-compliance/head-office-attendance-panel";
import { phxFieldClassName } from "@/components/ui/form-tokens";
import { complianceLabel } from "@/lib/field-workforce-compliance/compliance-label";


type LiveMonthsListResponse = {
  data?: FieldWorkforceLiveMonthOption[];
  error?: string;
  message?: string;
  success: boolean;
};

type LiveViewResponse = {
  data?: FieldWorkforceLiveViewResult;
  error?: string;
  message?: string;
  mirrorFreshness?: FieldWorkforceMirrorFreshness;
  success: boolean;
};

type RecommendationsResponse = {
  data?: FieldWorkforceRecommendationsReport;
  error?: string;
  message?: string;
  success: boolean;
};

type WorkspaceTab = "overview" | "timeline" | "team-calendar" | "head-office-attendance" | "queue" | "summary" | "scorecards" | "diagnostics" | "recommendations";

const workspaceTabs: Array<{ id: WorkspaceTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "timeline", label: "Employee Timeline" },
  { id: "team-calendar", label: "Team Calendar" },
  { id: "queue", label: "Review Queue" },
  { id: "summary", label: "Monthly Summary" },
  { id: "scorecards", label: "Scorecards" },
  { id: "diagnostics", label: "Diagnostics" },
];

// Main tab bar: the review tabs, plus Recommendations (reachable for the live-mirror month
// without archiving) and the live-now Head Office Attendance fingerprint view.
const mainWorkspaceTabs: Array<{ id: WorkspaceTab; label: string }> = [
  ...workspaceTabs,
  { id: "recommendations", label: "Recommendations" },
  { id: "head-office-attendance", label: "Head Office Attendance" },
];

const severityOptions: Array<"All" | FieldWorkforceSeverity> = ["All", "High", "Review", "Medium", "Low"];
const statusOptions: Array<"All" | FieldWorkforceCellStatus> = ["All", "N", "AV", "CP", "VISITS", "F", "UNKNOWN"];
const pageSizeOptions = [25, 50, 100];
const decisionStatusOptions: FieldWorkforceDecisionStatus[] = [
  "Pending",
  "Approved for Leave Adjustment Report",
  "Approved for Payroll Deduction Report",
  "Do Not Take Action",
  "Needs Follow-up",
  "Disputed",
  "Resolved",
  "Cancelled",
];

const decisionReasonOptions: FieldWorkforceDecisionReason[] = [
  "System issue",
  "Manager approved field exception",
  "Official training",
  "Meeting / cycle meeting",
  "Medical excuse pending",
  "Doctor conference",
  "Area assignment issue",
  "Public holiday conflict",
  "Late CRM sync",
  "Duplicate / data issue",
  "Already covered",
  "No action needed",
  "Other",
];

function decisionStatusOptionsForRecommendation(
  recommendation: FieldWorkforceRecommendation,
): FieldWorkforceDecisionStatus[] {
  const common: FieldWorkforceDecisionStatus[] = [
    "Pending",
    "Do Not Take Action",
    "Needs Follow-up",
    "Disputed",
    "Resolved",
    "Cancelled",
  ];
  if (recommendation.recommendationType === "leave_reconciliation") {
    return [
      "Pending",
      "Approved for Leave Adjustment Report",
      ...common.slice(1),
    ];
  }
  return [
    "Pending",
    "Approved for Payroll Deduction Report",
    ...common.slice(1),
  ];
}

async function readJsonResponse<T extends { message?: string; success: boolean }>(response: Response): Promise<T> {
  // A 401, or a 403 right after SessionSecurityGuard's heartbeat/idle-timeout logout has
  // fired, means the session died out from under this request rather than the user
  // genuinely lacking access — redirect to sign in instead of showing a confusing
  // "you do not have access" error on a page that's about to navigate away anyway.
  if (handlePossibleSessionDeath(response)) {
    return { message: "Your session expired — redirecting you to sign in…", success: false } as T;
  }
  const text = await response.text();
  if (!text) return { message: response.statusText, success: response.ok } as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return { message: text, success: false } as T;
  }
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatPercentValue(value: number) {
  return `${formatNumber(value)}%`;
}

function formatRawValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}

// DATE-ONLY (an attendance/visit day, a `date` column — displayDateTime below takes a real instant),
// which `new Date` parses as UTC midnight. UTC here is CORRECT and must stay: it is what stops the
// calendar day being shifted by a zone offset. Not an instant — do not "fix" this one to Cairo.
function displayDate(value: string | null) {
  if (!value) return "-";
  const date = new Date(`${value}T00:00:00Z`);
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(date);
}

function displayDateTime(value: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

/** Human "N ago" for a mirror-sync age in hours (e.g. 0.5 -> "just now", 3 -> "3h ago"). */
function formatSyncAge(ageHours: number) {
  if (ageHours < 1) return "under an hour ago";
  if (ageHours < 24) return `${Math.round(ageHours)}h ago`;
  const days = Math.round(ageHours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

// DATE-ONLY (a calendar day, a `date` column), which `new Date` parses as UTC midnight. UTC here is
// CORRECT and must stay: it is what stops the calendar day being shifted by a zone offset. Not an
// instant — do not "fix" this one to Cairo.
function weekday(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
  }).format(new Date(`${value}T00:00:00Z`));
}

function severityBadge(severity: FieldWorkforceSeverity | undefined) {
  if (!severity) return <Badge variant="neutral">Clear</Badge>;
  if (severity === "High") return <Badge variant="danger">{severity}</Badge>;
  if (severity === "Review" || severity === "Medium") return <Badge variant="warning">{severity}</Badge>;
  return <Badge variant="neutral">{severity}</Badge>;
}

function statusLabel(status: FieldWorkforceCellStatus, visitCount?: number, attendanceCrossCheck?: FieldWorkforceDayCell["attendanceCrossCheck"]) {
  if (status === "N" && attendanceCrossCheck === "punch_no_visits") return "P";
  if (status === "VISITS") return String(visitCount ?? 0);
  if (status === "BLANK") return "-";
  return status;
}

function statusMeaning(status: FieldWorkforceCellStatus) {
  const labels: Record<FieldWorkforceCellStatus, string> = {
    AV: "Vacation signal",
    BLANK: "Blank",
    CP: "Campaign",
    F: "Friday",
    N: "No activity",
    UNKNOWN: "Unknown",
    VISITS: "Visits",
  };
  return labels[status];
}

function coverageLabel(value: FieldWorkforceRecommendation["existingCoverageStatus"]) {
  const labels: Record<FieldWorkforceRecommendation["existingCoverageStatus"], string> = {
    already_covered: "Already covered",
    leave_source_not_connected: "Leave source not connected yet",
    needs_reconciliation: "Needs reconciliation",
    not_applicable: "Not applicable",
    payroll_calculation_required: "Amount requires payroll calculation",
  };
  return labels[value];
}

function decisionBadge(status: FieldWorkforceDecisionStatus) {
  if (status.includes("Approved")) return <Badge variant="success">{status}</Badge>;
  if (status === "Resolved") return <Badge variant="success">{status}</Badge>;
  if (status === "Do Not Take Action" || status === "Cancelled") return <Badge variant="neutral">{status}</Badge>;
  if (status === "Needs Follow-up" || status === "Disputed") return <Badge variant="warning">{status}</Badge>;
  return <Badge variant="neutral">{status}</Badge>;
}

function formatDates(dates: string[]) {
  if (dates.length === 0) return "-";
  if (dates.length <= 3) return dates.map((date) => displayDate(date)).join(", ");
  return `${dates.slice(0, 3).map((date) => displayDate(date)).join(", ")} +${dates.length - 3}`;
}

function candidateMatchesStatus(candidate: FieldWorkforceReviewCandidate, status: FieldWorkforceCellStatus) {
  const meaning = candidate.normalizedMeaning.toLowerCase();
  if (status === "N") return meaning.includes("no activity");
  if (status === "AV") return meaning.includes("vacation");
  if (status === "CP") return meaning.includes("campaign");
  if (status === "VISITS") return meaning.includes("numeric visits");
  if (status === "F") return meaning.includes("friday");
  if (status === "UNKNOWN") return meaning.includes("unknown");
  return meaning.includes("blank");
}

type HierarchyFilterState = {
  areaName: string;
  employmentStatus: string;
  lineName: string;
  managerName: string;
  roleName: string;
  teamName: string;
};

type HierarchyItem = {
  areaName?: string | null;
  employeeName?: string | null;
  employmentStatus?: string | null;
  lineName?: string | null;
  managerName?: string | null;
  managersAbove?: readonly (string | null | undefined)[] | null;
  roleName?: string | null;
  teamName?: string | null;
};

const emptyHierarchyFilters: HierarchyFilterState = {
  areaName: "All",
  employmentStatus: "All",
  lineName: "All",
  managerName: "All",
  roleName: "All",
  teamName: "All",
};

const hierarchyFilterConfig = [
  ["managerName", "Manager"],
  ["lineName", "Line"],
  ["areaName", "Area"],
  ["teamName", "Team"],
  ["roleName", "Role"],
  ["employmentStatus", "Status"],
] as const;

// The Manager filter walks the reporting chain the rows themselves carry (src/lib/org/manager-filter.ts):
// choosing a manager keeps his own row and everybody beneath him, and the options include every
// manager up the chain. It used to list only the rows' direct managers and match
// `row.managerName === selected`, so a manager was never found in his own filter and a National
// Sales Manager's choice showed his district managers and none of their reps (owner, 2026-10-20).
const managerChainByItems = new WeakMap<readonly HierarchyItem[], Map<string, string>>();

function managerChainFor(items: readonly HierarchyItem[]) {
  let chain = managerChainByItems.get(items);
  if (!chain) {
    chain = buildManagerChain(items);
    managerChainByItems.set(items, chain);
  }
  return chain;
}

function uniqueHierarchyOptions<T extends HierarchyItem>(items: T[], key: keyof HierarchyFilterState) {
  if (key === "managerName") return managerFilterOptions(items, managerChainFor(items));
  return [...new Set(items.map((item) => item[key as keyof HierarchyItem]).filter((value): value is string => Boolean(value)))].sort((left, right) => left.localeCompare(right));
}

function hasHierarchyData<T extends HierarchyItem>(items: T[]) {
  return hierarchyFilterConfig.some(([key]) => uniqueHierarchyOptions(items, key).length > 0);
}

function matchesHierarchyFilters<T extends HierarchyItem>(item: T, filters: HierarchyFilterState, items: readonly T[]) {
  return hierarchyFilterConfig.every(([key]) => {
    const selected = filters[key];
    if (selected === "All") return true;
    if (key === "managerName") return matchesManagerFilter(item, selected, managerChainFor(items));
    return item[key as keyof HierarchyItem] === selected;
  });
}

function HierarchyFilters<T extends HierarchyItem>({
  filters,
  items,
  onChange,
}: {
  filters: HierarchyFilterState;
  items: T[];
  onChange: (filters: HierarchyFilterState) => void;
}) {
  if (!hasHierarchyData(items)) {
    return (
      <AdminCallout tone="neutral">
        <ListFilter className="mt-0.5 h-4 w-4" />
        <p>Employee hierarchy filters unavailable for this archive.</p>
      </AdminCallout>
    );
  }

  return (
    <div className="grid gap-2 rounded-xl border border-slate-200 bg-white p-3 md:grid-cols-3 xl:grid-cols-6">
      {hierarchyFilterConfig.map(([key, label]) => {
        const options = uniqueHierarchyOptions(items, key);
        if (options.length === 0) return null;
        return (
          <SearchableSelect
            className="h-9 px-3 text-xs"
            key={key}
            value={filters[key]}
            onChange={(event) => onChange({
              ...filters,
              [key]: event.target.value,
            })}
          >
            <option value="All">All {label}</option>
            {options.map((option) => <option key={option} value={option}>{option}</option>)}
          </SearchableSelect>
        );
      })}
    </div>
  );
}

/** A "VISITS" day additionally shades by visitPeriod: AM-only and PM-only get their own
 * distinct colors to flag a half-day visit pattern; a mixed/untagged day keeps the default
 * emerald. Same palette as the employee-portal Team Calendar. */
function statusCellClass(cell: FieldWorkforceDayCell) {
  const visitsClass =
    cell.visitPeriod === "AM"
      ? "border-cyan-300 bg-cyan-50 text-cyan-800 hover:bg-cyan-100"
      : cell.visitPeriod === "PM"
        ? "border-indigo-300 bg-indigo-50 text-indigo-800 hover:bg-indigo-100"
        : "border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100";
  // A fingerprint punch on an otherwise "N" (no CRM activity) day — mainly Head Office staff
  // who don't generate CRM visits at all — reads as "punched in", not "no activity".
  const nClass = cell.attendanceCrossCheck === "punch_no_visits"
    ? "border-teal-300 bg-teal-50 text-teal-800 hover:bg-teal-100"
    : "border-rose-300 bg-rose-50 text-rose-800 hover:bg-rose-100";
  const base = {
    AV: "border-sky-300 bg-sky-50 text-sky-800 hover:bg-sky-100",
    BLANK: "border-slate-200 bg-white text-slate-400 hover:bg-slate-50",
    CP: "border-violet-300 bg-violet-50 text-violet-800 hover:bg-violet-100",
    F: "border-slate-200 bg-slate-100 text-slate-500 hover:bg-slate-200",
    N: nClass,
    UNKNOWN: "border-red-400 bg-red-50 text-red-800 hover:bg-red-100",
    VISITS: visitsClass,
  }[cell.status];
  return cn(
    base,
    cell.isPublicHoliday ? "ring-2 ring-amber-300 ring-offset-1" : "",
    cell.isPreHire ? "opacity-45 grayscale" : "",
  );
}

function LegendChip({
  children,
  className,
  label,
}: {
  children: string;
  className: string;
  label: string;
}) {
  return (
    <div className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 shadow-sm">
      <span className={cn("inline-flex h-7 min-w-7 items-center justify-center rounded-md border px-1.5 text-phx-xs font-black", className)}>
        {children}
      </span>
      {label}
    </div>
  );
}

function MetricCard({
  label,
  tone = "neutral",
  value,
}: {
  label: string;
  tone?: "danger" | "neutral" | "success" | "warning";
  value: string;
}) {
  const tones = {
    danger: "border-rose-200 bg-rose-50 text-rose-900",
    neutral: "border-slate-200 bg-white text-slate-900",
    success: "border-emerald-200 bg-emerald-50 text-emerald-900",
    warning: "border-orange-200 bg-orange-50 text-orange-900",
  };
  return (
    <Card className={cn("rounded-xl border p-4 shadow-[0_12px_28px_rgba(15,23,42,0.06)]", tones[tone])}>
      <p className="text-phx-2xs font-black uppercase tracking-[0.16em] opacity-70">{label}</p>
      <p className="mt-2 break-words text-xl font-black tracking-tight sm:text-2xl">{value}</p>
    </Card>
  );
}

/** Appends the CRM-logging-timing line (first/last logged, active window, late-start) to a
 * day's tooltip text, when present. IMPORTANT: this is when the visit was LOGGED into the CRM,
 * not a GPS-verified visit time (iReports360 never returns an actual visit clock time) — the
 * copy always says "logged", never "visit(ed)", so it can't be mistaken for something verified.
 * Informational only — never changes the cell's status/color. */
function withLoggingTimingTooltip(explanation: string, cell: FieldWorkforceDayCell): string {
  const timing = cell.loggingTiming;
  let result = explanation;
  if (cell.campaignOverlay) {
    result = `${result} Mixed day: regular visits are counted (green) AND a campaign/special activity also occurred this day (violet).`;
  }
  if (timing?.firstLoggedTime) {
    const windowText = timing.activeWindowMinutes != null
      ? ` (logged over ${Math.floor(timing.activeWindowMinutes / 60)}h ${timing.activeWindowMinutes % 60}m)`
      : "";
    const lateText = timing.isLateStart ? " — late log (first AM-tagged entry logged after 11:30)" : "";
    result = `${result} Logged ${timing.firstLoggedTime}–${timing.lastLoggedTime ?? timing.firstLoggedTime}${windowText}${lateText}.`;
  }
  if (cell.attendanceCrossCheck === "visits_no_punch") {
    result = `${result} Attendance cross-check: CRM shows activity, but no fingerprint punch this day.`;
  } else if (cell.attendanceCrossCheck === "punch_no_visits") {
    result = `${result} Attendance cross-check: fingerprint punch recorded, but no CRM activity this day.`;
  } else if (cell.attendanceCrossCheck === "av_with_punch") {
    result = `${result} Attendance cross-check: fingerprint punch recorded on a day marked as vacation (AV), 5h+ worked — full contradiction.`;
  } else if (cell.attendanceCrossCheck === "av_with_partial_punch") {
    result = `${result} Attendance cross-check: fingerprint punch recorded on a day marked as vacation (AV), under 5h worked — likely a half-day.`;
  }
  return result;
}

function TimelineDayCell({ cell }: { cell: FieldWorkforceDayCell }) {
  const baseClass = cn(
    "relative flex h-10 w-full items-center justify-center rounded-lg border text-xs font-black",
    statusCellClass(cell),
  );
  const tooltip = withLoggingTimingTooltip(cell.explanation, cell);
  const content = (
    <>
      {cell.campaignOverlay ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-lg bg-violet-300/60 [clip-path:polygon(0_0,0_100%,100%_100%)]"
        />
      ) : null}
      <span className="relative z-10">{statusLabel(cell.status, cell.visitCount, cell.attendanceCrossCheck)}</span>
      {cell.isPublicHoliday ? (
        <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border border-white bg-amber-400" />
      ) : null}
      {cell.loggingTiming?.isLateStart ? (
        <span className="absolute -bottom-1 -left-1 h-2.5 w-2.5 rounded-full border border-white bg-violet-500" />
      ) : null}
      {cell.attendanceCrossCheck === "visits_no_punch" ? (
        <span className="absolute -left-1 -top-1 h-2.5 w-2.5 rounded-full border border-white bg-rose-500" />
      ) : cell.attendanceCrossCheck === "av_with_punch" ? (
        <span className="absolute -left-1 -top-1 h-2.5 w-2.5 rounded-full border border-white bg-orange-600" />
      ) : cell.attendanceCrossCheck === "av_with_partial_punch" ? (
        <span className="absolute -left-1 -top-1 h-2.5 w-2.5 rounded-full border border-white bg-yellow-500" />
      ) : null}
    </>
  );
  // Numeric-visit days, campaign days, AND fingerprint-punched "N" days deep-link to the day
  // drill-down in a NEW tab (all are real recorded activity, just categorized/sourced
  // differently); other days are static. punch_no_visits no longer needs its own corner dot
  // (line above) now that it drives the cell's main color instead.
  if (cell.status === "VISITS" || cell.status === "CP" || cell.attendanceCrossCheck === "punch_no_visits") {
    return (
      <Link
        aria-label={`${cell.employeeName} ${cell.dateIso}: ${tooltip} (open visits)`}
        className={cn(baseClass, "transition hover:ring-2 hover:ring-orange-300 focus:outline-none focus:ring-2 focus:ring-orange-300")}
        href={`/admin/field-workforce-compliance/visits/${encodeURIComponent(cell.hrId)}/${cell.dateIso}`}
        rel="noopener noreferrer"
        target="_blank"
        title={`${tooltip} — click to open the day's visits`}
      >
        {content}
      </Link>
    );
  }
  return (
    <div aria-label={`${cell.employeeName} ${cell.dateIso}: ${tooltip}`} className={baseClass} title={tooltip}>
      {content}
    </div>
  );
}

function TimelineLegend() {
  return (
    <div className="flex flex-wrap gap-2">
      <LegendChip className="border-rose-300 bg-rose-50 text-rose-800" label="No activity">N</LegendChip>
      <LegendChip className="border-sky-300 bg-sky-50 text-sky-800" label="Vacation">AV</LegendChip>
      <LegendChip className="border-violet-300 bg-violet-50 text-violet-800" label="Campaign (click to open)">CP</LegendChip>
      <LegendChip className="border-emerald-300 bg-emerald-50 text-emerald-800" label="Visits, full day">5</LegendChip>
      <div className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 shadow-sm">
        <span className="relative inline-flex h-7 min-w-7 items-center justify-center overflow-hidden rounded-md border border-emerald-300 bg-emerald-50 px-1.5 text-phx-xs font-black text-emerald-800">
          <span aria-hidden className="pointer-events-none absolute inset-0 bg-violet-300/60 [clip-path:polygon(0_0,0_100%,100%_100%)]" />
          <span className="relative z-10">5</span>
        </span>
        Visits + campaign (same day)
      </div>
      <LegendChip className="border-cyan-300 bg-cyan-50 text-cyan-800" label="Visits, AM only">5</LegendChip>
      <LegendChip className="border-indigo-300 bg-indigo-50 text-indigo-800" label="Visits, PM only">5</LegendChip>
      <LegendChip className="border-slate-200 bg-slate-100 text-slate-500" label="Friday">F</LegendChip>
      <LegendChip className="border-amber-300 bg-amber-50 text-amber-800 ring-2 ring-amber-300" label="Holiday">H</LegendChip>
      <LegendChip className="border-violet-300 bg-violet-50 text-violet-800 ring-2 ring-violet-300" label="Late log (AM-tagged entry logged after 11:30 — CRM log time, not a verified visit time)">•</LegendChip>
      <LegendChip className="border-rose-300 bg-rose-50 text-rose-800 ring-2 ring-rose-300" label="CRM activity but no fingerprint punch that day">•</LegendChip>
      <LegendChip className="border-teal-300 bg-teal-50 text-teal-800" label="Punched in (fingerprint), no CRM activity — click to open">P</LegendChip>
    </div>
  );
}

function WorkspaceTabs({
  activeTab,
  onChange,
  tabs = workspaceTabs,
}: {
  activeTab: WorkspaceTab;
  onChange: (tab: WorkspaceTab) => void;
  tabs?: Array<{ id: WorkspaceTab; label: string }>;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white/90 p-1.5 shadow-sm">
      {/*
        Fits-the-screen golden rule (AGENTS.md §4), and the same fix the analytics tab strip got:
        this was `overflow-x-auto` over a `min-w-max` row, so the later tabs sat off a phone
        screen behind a scroll. `flex-wrap` lets the row wrap onto a second line instead, and the
        buttons take `shrink-0` so no label is squeezed below its own text width — flex items
        default to `flex-shrink: 1`, which is what paints one label over its neighbour.
      */}
      <div className="flex flex-wrap gap-1.5">
        {tabs.map((tab) => (
          <button
            aria-pressed={activeTab === tab.id}
            className={cn(
              "shrink-0 rounded-xl px-4 py-2 text-sm font-black transition",
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

function ValidationIssues({
  title,
  issues,
  tone,
}: {
  issues: FieldWorkforceValidationIssue[];
  title: string;
  tone: "danger" | "warning";
}) {
  if (issues.length === 0) return null;
  return (
    <AdminCallout tone={tone}>
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0">
        <p className="font-semibold">{title}</p>
        <div className="mt-2 space-y-1 text-sm leading-6">
          {issues.slice(0, 4).map((issue, index) => (
            <p key={`${issue.code}:${issue.rowNumber ?? "file"}:${index}`}>
              {issue.rowNumber ? `Row ${issue.rowNumber}: ` : ""}{issue.message}
            </p>
          ))}
          {issues.length > 4 ? <p>{issues.length - 4} more issue(s) in Diagnostics.</p> : null}
        </div>
      </div>
    </AdminCallout>
  );
}

function OverviewPanel({
  highCount,
  holidayWarnings,
  result,
  totalCandidates,
}: {
  highCount: number;
  holidayWarnings: number;
  result: FieldWorkforcePreviewResult;
  totalCandidates: number;
}) {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Employees" value={formatNumber(result.metadata.employeeCount)} />
        <MetricCard label="Review Candidates" tone={totalCandidates ? "warning" : "success"} value={formatNumber(totalCandidates)} />
        <MetricCard label="High Severity" tone={highCount ? "danger" : "success"} value={formatNumber(highCount)} />
        <MetricCard label="Holiday Warnings" tone={holidayWarnings ? "warning" : "neutral"} value={formatNumber(holidayWarnings)} />
        <MetricCard label="Matched HR IDs" tone={result.metadata.unmatchedEmployees ? "warning" : "success"} value={`${formatNumber(result.metadata.matchedEmployees)} / ${formatNumber(result.metadata.employeeCount)}`} />
        <MetricCard label="Parsed Month" value={`${result.metadata.monthLabel} ${result.metadata.year}`} />
        <MetricCard label="Safety Status" tone="success" value="Review only" />
        <MetricCard label="Public Holidays" tone={result.metadata.holidayConnected ? "success" : "warning"} value={`${formatNumber(result.metadata.holidaysDetected)} detected`} />
      </div>
      <AdminCallout tone="neutral">
        <ShieldAlert className="mt-0.5 h-4 w-4" />
        <p>This workspace is archive/review only. Saving an archived month stores the historical snapshot; it does not approve, deduct payroll, or mutate leave balances.</p>
      </AdminCallout>
    </div>
  );
}

function EmployeePicker({
  employees,
  employeeSearch,
  onEmployeeSearchChange,
  onSelectEmployee,
  selectedEmployee,
}: {
  employees: FieldWorkforceEmployeeSummary[];
  employeeSearch: string;
  onEmployeeSearchChange: (value: string) => void;
  onSelectEmployee: (hrId: string) => void;
  selectedEmployee: FieldWorkforceEmployeeSummary | null;
}) {
  const selectedIndex = selectedEmployee
    ? employees.findIndex((employee) => employee.hrId === selectedEmployee.hrId)
    : -1;
  const hasPrevious = selectedIndex > 0;
  const hasNext = selectedIndex >= 0 && selectedIndex < employees.length - 1;

  return (
    <Card className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_320px_220px]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            className={cn(phxFieldClassName, "pl-9")}
            placeholder="Search employee or HR ID"
            value={employeeSearch}
            onChange={(event) => onEmployeeSearchChange(event.target.value)}
          />
        </div>
        <SearchableSelect
          className="px-3"
          value={selectedEmployee?.hrId ?? ""}
          onChange={(event) => onSelectEmployee(event.target.value)}
        >
          {employees.map((employee) => (
            <option key={employee.hrId} value={employee.hrId}>{employee.employeeName}</option>
          ))}
        </SearchableSelect>
        <div className="grid grid-cols-2 gap-2">
          <Button
            className="gap-2"
            disabled={!hasPrevious}
            type="button"
            variant="secondary"
            onClick={() => {
              if (hasPrevious) onSelectEmployee(employees[selectedIndex - 1].hrId);
            }}
          >
            <ChevronLeft className="h-4 w-4" />
            Previous
          </Button>
          <Button
            className="gap-2"
            disabled={!hasNext}
            type="button"
            variant="secondary"
            onClick={() => {
              if (hasNext) onSelectEmployee(employees[selectedIndex + 1].hrId);
            }}
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <p className="mt-2 text-xs font-semibold text-slate-500">
        Showing {selectedIndex >= 0 ? selectedIndex + 1 : 0} of {formatNumber(employees.length)} matching employees.
      </p>
    </Card>
  );
}

const CUSTOMER_AUTHENTICITY_RULE_LABELS: Record<string, string> = {
  consecutive_same_contact: "same contact 3+ consecutive days",
  high_concentration: "≥60% of visits to one contact",
  low_variety: "fewer than 3 distinct contacts all month",
  pm_recurring_contact: "same contact recurring in the PM slot",
};

function customerAuthenticityRuleLabel(rule: string): string {
  return CUSTOMER_AUTHENTICITY_RULE_LABELS[rule] ?? rule;
}

function employeeRiskLabel(employee: FieldWorkforceEmployeeSummary) {
  if (employee.severityCounts.High > 0) return "High";
  if (employee.noActivityPattern.hasThreeDayStreak) return "High";
  if (employee.severityCounts.Review > 0 || employee.noActivityPattern.hasTwoDayStreak) return "Review";
  if (employee.severityCounts.Medium > 0) return "Medium";
  return "Low";
}

function EmployeeComplianceCard({ employee }: { employee: FieldWorkforceEmployeeSummary }) {
  const risk = employeeRiskLabel(employee);
  return (
    <Card className="rounded-xl border border-slate-200 bg-white p-4 shadow-[0_14px_34px_rgba(15,23,42,0.06)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-400">Employee Monthly Compliance</p>
          <h3 className="mt-1 text-lg font-black text-slate-950">{employee.employeeName}</h3>
          <p className="mt-1 text-xs font-bold text-slate-500">Hire date {employee.hiringDateIso ?? "—"}</p>
          <p className="mt-2 text-xs font-semibold text-slate-500">
            {[employee.managerName, employee.lineName, employee.areaName, employee.teamName, employee.roleName, employee.employmentStatus].filter(Boolean).join(" / ") || "Employee hierarchy unavailable"}
          </p>
        </div>
        {severityBadge(risk)}
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard label="Eligible Days" value={formatNumber(employee.eligibleWorkingDays)} />
        <MetricCard label="Worked Days" tone="success" value={formatNumber(employee.workedDays)} />
        <MetricCard label="No Activity" tone={employee.noActivityCandidates ? "warning" : "success"} value={formatNumber(employee.noActivityCandidates)} />
        <MetricCard label="Vacation Days" tone={employee.vacationSignalDays ? "warning" : "neutral"} value={formatNumber(employee.vacationSignalDays)} />
        <MetricCard label="Campaign Days" value={formatNumber(employee.campaignDays)} />
        <MetricCard label="Total Visits" tone="success" value={formatNumber(employee.totalVisits)} />
        <MetricCard label="Compliance %" tone={employee.compliancePercent === null ? "neutral" : employee.compliancePercent >= 75 ? "success" : employee.compliancePercent >= 50 ? "warning" : "danger"} value={complianceLabel(employee, formatPercentValue)} />
        <MetricCard label="Longest N Streak" tone={employee.noActivityPattern.longestStreak >= 3 ? "danger" : employee.noActivityPattern.longestStreak >= 2 ? "warning" : "neutral"} value={formatNumber(employee.noActivityPattern.longestStreak)} />
        <MetricCard label="Holiday Warnings" tone={employee.holidayWarnings ? "warning" : "neutral"} value={formatNumber(employee.holidayWarnings)} />
        <MetricCard label="Pre-hire Context" tone={employee.preHireIgnoredValues ? "warning" : "neutral"} value={formatNumber(employee.preHireIgnoredValues)} />
        {employee.loggingTimingSummary ? (
          <>
            <MetricCard label="Avg First Logged" value={employee.loggingTimingSummary.avgFirstLoggedTime ?? "-"} />
            <MetricCard label="Late Log Days" tone={employee.loggingTimingSummary.lateStartDayCount ? "warning" : "success"} value={formatNumber(employee.loggingTimingSummary.lateStartDayCount)} />
          </>
        ) : null}
        {employee.customerAuthenticity && employee.customerAuthenticity.totalCustomerVisits > 0 ? (
          <>
            <MetricCard label="Distinct Contacts" value={formatNumber(employee.customerAuthenticity.distinctContacts)} />
            <MetricCard
              label="Top Contact Share"
              tone={employee.customerAuthenticity.flagged ? "warning" : "success"}
              value={employee.customerAuthenticity.topContactShare != null ? `${Math.round(employee.customerAuthenticity.topContactShare * 100)}%` : "-"}
            />
          </>
        ) : null}
      </div>
      <div className="mt-3 rounded-lg border border-orange-100 bg-orange-50 px-3 py-2 text-sm font-semibold text-orange-900">
        Consecutive no-activity signal: {employee.noActivityPattern.summary}
      </div>
      {employee.customerAuthenticity?.flagged ? (
        <div className="mt-3 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-sm font-semibold text-violet-900">
          Customer pattern review: {employee.customerAuthenticity.flaggedRules.map(customerAuthenticityRuleLabel).join("; ")}
          {employee.customerAuthenticity.topContactName ? ` (top contact: ${employee.customerAuthenticity.topContactName})` : ""}
        </div>
      ) : null}
    </Card>
  );
}

function SingleEmployeeTimeline({ employee }: { employee: FieldWorkforceEmployeeSummary }) {
  const monthColumns = { gridTemplateColumns: `repeat(${employee.timeline.length}, minmax(0, 1fr))` };
  return (
    <Card className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 bg-slate-50 px-4 py-3">
        <p className="text-sm font-black text-slate-950">{employee.employeeName}</p>
        <p className="mt-1 text-xs font-bold text-slate-500">Hire date {employee.hiringDateIso ?? "—"}</p>
      </div>
      {/* Full month fits the width — no horizontal scroll. */}
      <div className="p-3">
        <div className="grid gap-1" style={monthColumns}>
          {employee.timeline.map((cell) => (
            <div
              className={cn(
                "rounded-md py-1 text-center text-phx-3xs font-black uppercase tracking-tight text-slate-500",
                cell.isFriday ? "bg-slate-100" : "",
                cell.isPublicHoliday ? "bg-amber-50 text-amber-700" : "",
              )}
              key={`${cell.dateIso}-header`}
            >
              <span className="block text-phx-xs leading-tight text-slate-900">{cell.dayNumber}</span>
              <span>{weekday(cell.dateIso)}</span>
            </div>
          ))}
        </div>
        <div className="mt-1 grid gap-1" style={monthColumns}>
          {employee.timeline.map((cell) => (
            <TimelineDayCell cell={cell} key={cell.dateIso} />
          ))}
        </div>
      </div>
    </Card>
  );
}

function TimelinePanel({
  employees,
  employeeSearch,
  hierarchyFilters,
  hierarchyItems,
  onHierarchyFiltersChange,
  onEmployeeSearchChange,
  onSelectEmployee,
  selectedEmployee,
}: {
  employees: FieldWorkforceEmployeeSummary[];
  employeeSearch: string;
  hierarchyFilters: HierarchyFilterState;
  hierarchyItems: FieldWorkforceEmployeeSummary[];
  onEmployeeSearchChange: (value: string) => void;
  onHierarchyFiltersChange: (filters: HierarchyFilterState) => void;
  onSelectEmployee: (hrId: string) => void;
  selectedEmployee: FieldWorkforceEmployeeSummary | null;
}) {
  if (!selectedEmployee) {
    return (
      <Card className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
        No employee matches the current filter.
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <HierarchyFilters
        filters={hierarchyFilters}
        items={hierarchyItems}
        onChange={onHierarchyFiltersChange}
      />
      <EmployeePicker
        employeeSearch={employeeSearch}
        employees={employees}
        selectedEmployee={selectedEmployee}
        onEmployeeSearchChange={onEmployeeSearchChange}
        onSelectEmployee={onSelectEmployee}
      />
      <TimelineLegend />
      <EmployeeComplianceCard employee={selectedEmployee} />
      <EmployeeTrendStrip hrId={selectedEmployee.hrId} key={selectedEmployee.hrId} />
      <SingleEmployeeTimeline employee={selectedEmployee} />
    </div>
  );
}

/**
 * Cross-month compliance history for the selected employee — a per-employee sparkline plus
 * "flagged (High) in N of the last M months" as a displayed fact only. No auto-severity
 * change; purely informational, matching every other Tier 1/2 signal this pass.
 */
function EmployeeTrendStrip({ hrId }: { hrId: string }) {
  const [trend, setTrend] = useState<FieldWorkforceEmployeeTrend | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/admin/field-workforce-compliance/employee-trend/${encodeURIComponent(hrId)}`)
      .then((response) => response.json())
      .then((payload) => {
        if (cancelled) return;
        if (!payload.success) throw new Error(payload.message ?? "Trend unavailable.");
        setTrend(payload.data as FieldWorkforceEmployeeTrend);
      })
      .catch((fetchError: unknown) => {
        if (!cancelled) setError(fetchError instanceof Error ? fetchError.message : "Trend unavailable.");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [hrId]);

  if (isLoading) {
    return <Card className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">Loading compliance history…</Card>;
  }
  if (error || !trend) {
    return <Card className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">Compliance history unavailable{error ? `: ${error}` : "."}</Card>;
  }
  if (trend.monthsConsidered === 0) {
    return <Card className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">No saved months yet for this employee&apos;s compliance history.</Card>;
  }

  return (
    <Card className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-black text-slate-950">Compliance History ({trend.monthsConsidered}-month trend)</p>
        <span className={cn(
          "rounded-full px-2.5 py-1 text-xs font-black uppercase tracking-wide",
          trend.highSeverityMonthCount > 0 ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700",
        )}>
          Flagged (High) in {trend.highSeverityMonthCount} of {trend.monthsConsidered} months
        </span>
      </div>
      <div className="mt-3 flex items-end gap-2">
        {trend.points.filter((point): point is typeof point & { compliancePercent: number } => point.compliancePercent !== null).map((point) => (
          <div className="flex flex-col items-center gap-1" key={point.monthKey}>
            <div
              className={cn(
                "w-7 rounded-t-md",
                point.highSeverityCount > 0 ? "bg-rose-400" : point.compliancePercent >= 75 ? "bg-emerald-400" : point.compliancePercent >= 50 ? "bg-amber-400" : "bg-rose-300",
              )}
              style={{ height: `${Math.max(6, Math.round(point.compliancePercent))}px` }}
              title={`${point.monthKey}: ${point.compliancePercent}% compliance, ${point.noActivityCandidates} no-activity day(s)${point.highSeverityCount > 0 ? ", High severity" : ""}`}
            />
            <span className="text-phx-2xs font-bold text-slate-500">{point.monthKey.slice(5)}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

/** Whole line / whole team / all employees on one page — each rep's full month, green days deep-link.
 * Uses the same shared HierarchyFilters (all 6 dimensions) as Employee Timeline / Monthly Summary,
 * plus a name/HR-ID search — replaces the old bespoke Line+Team-only filter, whose Team dropdown
 * didn't cascade off the selected Line (picking a Team from a different Line silently produced
 * zero results, reading as "the filter is broken"). */
function TeamCalendarPanel({ employees }: { employees: FieldWorkforceEmployeeSummary[] }) {
  const [hierarchyFilters, setHierarchyFilters] = useState<HierarchyFilterState>(emptyHierarchyFilters);
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return employees.filter((employee) =>
      (!needle || `${employee.employeeName} ${employee.hrId}`.toLowerCase().includes(needle)) &&
      matchesHierarchyFilters(employee, hierarchyFilters, employees),
    );
  }, [employees, hierarchyFilters, query]);

  return (
    <div className="space-y-4">
      <Card className="rounded-xl border border-slate-200 bg-white p-4">
        <p className="text-sm font-black text-slate-950">Team Calendar</p>
        <p className="mt-1 text-xs font-semibold text-slate-500">A whole line, a whole team, or everyone — each rep&apos;s full month on one page. Click a green numeric day to open that day&apos;s visits.</p>
        <div className="relative mt-3">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            className={cn(phxFieldClassName, "pl-9")}
            placeholder="Search employee or HR ID"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="mt-3">
          <HierarchyFilters
            filters={hierarchyFilters}
            items={employees}
            onChange={setHierarchyFilters}
          />
        </div>
      </Card>
      <TimelineLegend />
      <p className="text-xs font-bold text-slate-500">Showing {filtered.length} of {employees.length} reps</p>
      {filtered.length === 0 ? (
        <Card className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">No employee matches the current filters.</Card>
      ) : (
        <div className="space-y-3">
          {filtered.map((employee) => (
            <SingleEmployeeTimeline employee={employee} key={employee.hrId} />
          ))}
        </div>
      )}
    </div>
  );
}

function ReviewQueue({
  candidates,
}: {
  candidates: FieldWorkforceReviewCandidate[];
}) {
  const [severity, setSeverity] = useState<"All" | FieldWorkforceSeverity>("All");
  const [status, setStatus] = useState<"All" | FieldWorkforceCellStatus>("All");
  const [employeeQuery, setEmployeeQuery] = useState("");
  const [holidayOnly, setHolidayOnly] = useState(false);
  const [preHireOnly, setPreHireOnly] = useState(false);
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const filtered = useMemo(() => candidates.filter((candidate) => {
    if (severity !== "All" && candidate.severity !== severity) return false;
    if (status !== "All" && !candidateMatchesStatus(candidate, status)) return false;
    if (holidayOnly && !candidate.context.some((item) => item.toLowerCase().includes("public holiday"))) return false;
    if (preHireOnly && candidate.type !== "pre_hire_activity") return false;
    if (employeeQuery.trim()) {
      const needle = employeeQuery.trim().toLowerCase();
      const haystack = `${candidate.employeeName} ${candidate.hrId}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  }), [candidates, employeeQuery, holidayOnly, preHireOnly, severity, status]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const visibleRows = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  function resetPage() {
    setPage(1);
  }

  /**
   * Rendered by both the desktop row and the phone card. The value lives in this component's
   * `notes`, not in the row, so the two copies are the same note rather than two drafts.
   */
  function sessionNoteInput(candidateId: string, widthClassName: string) {
    return (
      <input
        className={cn(
          phxFieldClassName,
          widthClassName,
        )}
        placeholder="Temporary note, not saved"
        value={notes[candidateId] ?? ""}
        onChange={(event) => setNotes((current) => ({
          ...current,
          [candidateId]: event.target.value,
        }))}
      />
    );
  }

  return (
    <AdminTableShell
      description="Review candidates are labels only. They do not approve, deduct, save, or mutate payroll/leave."
      title="Review Candidate Queue"
    >
      <div className="grid gap-3 border-b border-slate-100 p-4 lg:grid-cols-[180px_180px_minmax(0,1fr)_180px]">
        <SearchableSelect
          className="px-3"
          value={severity}
          onChange={(event) => {
            setSeverity(event.target.value as typeof severity);
            resetPage();
          }}
        >
          {severityOptions.map((option) => <option key={option} value={option}>{option} severity</option>)}
        </SearchableSelect>
        <SearchableSelect
          className="px-3"
          value={status}
          onChange={(event) => {
            setStatus(event.target.value as typeof status);
            resetPage();
          }}
        >
          {statusOptions.map((option) => <option key={option} value={option}>{option === "All" ? "All statuses" : statusMeaning(option)}</option>)}
        </SearchableSelect>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            className={cn(phxFieldClassName, "pl-9")}
            placeholder="Filter employee or HR ID"
            value={employeeQuery}
            onChange={(event) => {
              setEmployeeQuery(event.target.value);
              resetPage();
            }}
          />
        </div>
        <SearchableSelect
          className="px-3"
          value={pageSize}
          onChange={(event) => {
            setPageSize(Number(event.target.value));
            resetPage();
          }}
        >
          {pageSizeOptions.map((option) => <option key={option} value={option}>{option} rows</option>)}
        </SearchableSelect>
        <label className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 lg:col-span-2">
          <input
            checked={holidayOnly}
            className="h-4 w-4 accent-orange-600"
            type="checkbox"
            onChange={(event) => {
              setHolidayOnly(event.target.checked);
              resetPage();
            }}
          />
          Public holiday warnings only
        </label>
        <label className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 lg:col-span-2">
          <input
            checked={preHireOnly}
            className="h-4 w-4 accent-orange-600"
            type="checkbox"
            onChange={(event) => {
              setPreHireOnly(event.target.checked);
              resetPage();
            }}
          />
          Pre-hire anomalies only
        </label>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 text-xs font-semibold text-slate-500">
        <span>Showing {visibleRows.length ? (safePage - 1) * pageSize + 1 : 0}-{Math.min(safePage * pageSize, filtered.length)} of {formatNumber(filtered.length)} candidates</span>
        <div className="flex items-center gap-2">
          <Button disabled={safePage <= 1} type="button" variant="secondary" onClick={() => setPage((current) => Math.max(1, current - 1))}>Previous</Button>
          <span>Page {safePage} / {totalPages}</span>
          <Button disabled={safePage >= totalPages} type="button" variant="secondary" onClick={() => setPage((current) => Math.min(totalPages, current + 1))}>Next</Button>
        </div>
      </div>
      <div className="phoenix-horizontal-scroll max-h-[52vh] overflow-auto">
        {/* Eight columns at a 1180px minimum. A card list is safe here even though the last cell
            is an input: `notes` lives in this component, not in the row, so the card copy and the
            table copy read and write the same value and cannot diverge. */}
        <PortalResponsiveDataList
          empty={
            <PortalEmptyState
              message="No review candidates match the current filters."
              title="Nothing to review"
            />
          }
          getKey={(candidate) => candidate.id}
          items={visibleRows}
          renderCard={(candidate) => (
            <PortalRecordCard
              meta={
                <span>{displayDate(candidate.dateIso)}</span>
              }
              status={severityBadge(candidate.severity)}
              title={candidate.employeeName}
            >
              <PortalRecordFields
                fields={[
                  { label: "Raw", value: formatRawValue(candidate.rawValue) },
                  { label: "Meaning", value: candidate.normalizedMeaning },
                  { label: "Explanation", value: candidate.explanation },
                  {
                    label: "Context",
                    value: candidate.context.length ? (
                      <span className="flex flex-wrap gap-1.5">
                        {candidate.context.map((item) => (
                          <Badge key={item} variant={item.includes("Public holiday") ? "warning" : "neutral"}>
                            {item}
                          </Badge>
                        ))}
                      </span>
                    ) : (
                      "-"
                    ),
                  },
                  { label: "Session Note", value: sessionNoteInput(candidate.id, "w-full") },
                ]}
              />
            </PortalRecordCard>
          )}
          renderTable={() => (
            <div className="hidden md:block">
        {/*
          Fits-the-screen golden rule (AGENTS.md §4). Mobile has `renderCard` above; this
          desktop half was a `min-w-[1180px]` floor, so Context and the Session Note box — the
          only cell on the row you can actually type into — were off the right edge at every
          desktop width. Raw and Meaning are the same reading (the code, and what it means), so
          they merge into one cell and the note input goes fluid instead of a fixed 256px.
        */}
        <table className="w-full table-fixed text-left text-sm">
          <colgroup>
            <col className="w-[14%]" />
            <col className="w-[9%]" />
            <col className="w-[12%]" />
            <col className="w-[9%]" />
            <col className="w-[19%]" />
            <col className="w-[14%]" />
            <col className="w-[23%]" />
          </colgroup>
          <thead className="sticky top-0 z-10 bg-slate-50 text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">
            <tr>
              <th className="break-words px-4 py-3">Employee</th>
              <th className="break-words px-4 py-3">Date</th>
              <th className="break-words px-4 py-3">Raw / meaning</th>
              <th className="break-words px-4 py-3">Severity</th>
              <th className="break-words px-4 py-3">Explanation</th>
              <th className="break-words px-4 py-3">Context</th>
              <th className="break-words px-4 py-3">Session Note</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {visibleRows.map((candidate) => (
              <tr className="align-top text-slate-700 hover:bg-slate-50/70" key={candidate.id}>
                <td className="break-words px-4 py-3">
                  <p className="break-words font-black text-slate-950">{candidate.employeeName}</p>
                </td>
                <td className="break-words px-4 py-3">{displayDate(candidate.dateIso)}</td>
                <td className="break-words px-4 py-3">
                  <span className="block break-words font-mono text-xs font-bold">{formatRawValue(candidate.rawValue)}</span>
                  <span className="mt-1 block break-words">{candidate.normalizedMeaning}</span>
                </td>
                <td className="px-4 py-3">{severityBadge(candidate.severity)}</td>
                <td className="break-words px-4 py-3 leading-6">{candidate.explanation}</td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1.5">
                    {candidate.context.length ? candidate.context.map((item) => (
                      <Badge key={item} variant={item.includes("Public holiday") ? "warning" : "neutral"}>{item}</Badge>
                    )) : <span className="text-slate-400">-</span>}
                  </div>
                </td>
                <td className="px-4 py-3">{sessionNoteInput(candidate.id, "w-full")}</td>
              </tr>
            ))}
          </tbody>
        </table>
            </div>
          )}
        />
      </div>
    </AdminTableShell>
  );
}

function MonthlySummaryTable({
  employees,
  hierarchyFilters,
  onHierarchyFiltersChange,
}: {
  employees: FieldWorkforceEmployeeSummary[];
  hierarchyFilters: HierarchyFilterState;
  onHierarchyFiltersChange: (filters: HierarchyFilterState) => void;
}) {
  const [query, setQuery] = useState("");
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return employees.filter((employee) =>
      (!needle || `${employee.employeeName} ${employee.hrId}`.toLowerCase().includes(needle)) &&
      matchesHierarchyFilters(employee, hierarchyFilters, employees),
    );
  }, [employees, hierarchyFilters, query]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const visibleRows = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  return (
    <AdminTableShell
      description="Compact employee-level totals. Public holidays are warning overlays, not automatic calculation changes."
      title="Monthly Employee Summary"
    >
      <div className="border-b border-slate-100 p-4">
        <HierarchyFilters
          filters={hierarchyFilters}
          items={employees}
          onChange={(filters) => {
            onHierarchyFiltersChange(filters);
            setPage(1);
          }}
        />
      </div>
      <div className="grid gap-3 border-b border-slate-100 p-4 md:grid-cols-[minmax(0,1fr)_180px]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            className={cn(phxFieldClassName, "pl-9")}
            placeholder="Search employee or HR ID"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
          />
        </div>
        <SearchableSelect
          className="px-3"
          value={pageSize}
          onChange={(event) => {
            setPageSize(Number(event.target.value));
            setPage(1);
          }}
        >
          {pageSizeOptions.map((option) => <option key={option} value={option}>{option} rows</option>)}
        </SearchableSelect>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 text-xs font-semibold text-slate-500">
        <span>Showing {visibleRows.length ? (safePage - 1) * pageSize + 1 : 0}-{Math.min(safePage * pageSize, filtered.length)} of {formatNumber(filtered.length)} employees</span>
        <div className="flex items-center gap-2">
          <Button disabled={safePage <= 1} type="button" variant="secondary" onClick={() => setPage((current) => Math.max(1, current - 1))}>Previous</Button>
          <span>Page {safePage} / {totalPages}</span>
          <Button disabled={safePage >= totalPages} type="button" variant="secondary" onClick={() => setPage((current) => Math.min(totalPages, current + 1))}>Next</Button>
        </div>
      </div>
      <div className="phoenix-horizontal-scroll max-h-[52vh] overflow-auto">
        {/* Seven merged columns, fixed to the screen. The card leads with the compliance percentage
            because that is what this table is read for; the day counts follow. */}
        <PortalResponsiveDataList
          empty={
            <PortalEmptyState
              message="No employees match the current filters."
              title="No employees"
            />
          }
          getKey={(employee) => employee.hrId}
          items={visibleRows}
          renderCard={(employee) => (
            <PortalRecordCard
              accent={
                employee.compliancePercent === null
                  ? "slate"
                  : employee.compliancePercent >= 75
                    ? "emerald"
                    : employee.compliancePercent >= 50
                      ? "amber"
                      : "rose"
              }
              meta={
                <span>
                  {[employee.managerName, employee.lineName, employee.areaName]
                    .filter(Boolean)
                    .join(" / ") || "—"}
                </span>
              }
              status={
                <span className="font-black text-slate-950">
                  {complianceLabel(employee, formatPercentValue)}
                </span>
              }
              title={employee.employeeName}
            >
              <PortalRecordFields
                fields={[
                  { label: "Hiring Date", value: employee.hiringDateIso ?? "-" },
                  { label: "Eligible", value: formatNumber(employee.eligibleWorkingDays) },
                  { label: "Worked", value: formatNumber(employee.workedDays) },
                  { label: "N (no activity)", value: formatNumber(employee.noActivityCandidates) },
                  { label: "AV (vacation signal)", value: formatNumber(employee.vacationSignalDays) },
                  { label: "CP (campaign)", value: formatNumber(employee.campaignDays) },
                  { label: "Visits", value: formatNumber(employee.totalVisits) },
                  { label: "Holidays", value: formatNumber(employee.holidayWarnings) },
                  { label: "Pre-hire", value: formatNumber(employee.preHireIgnoredValues) },
                  { label: "Unknown", value: formatNumber(employee.unknownValues) },
                  {
                    label: "Avg First Logged",
                    value: employee.loggingTimingSummary?.avgFirstLoggedTime ?? "-",
                  },
                  {
                    label: "Late Log Days",
                    value: employee.loggingTimingSummary
                      ? formatNumber(employee.loggingTimingSummary.lateStartDayCount)
                      : "-",
                  },
                  {
                    label: "Customer Pattern",
                    value: employee.customerAuthenticity?.flagged
                      ? employee.customerAuthenticity.flaggedRules
                          .map(customerAuthenticityRuleLabel)
                          .join("; ")
                      : "-",
                  },
                ]}
              />
            </PortalRecordCard>
          )}
          renderTable={() => (
            <PortalDesktopTable
              cols={
                <colgroup>
                  <col className="w-[18%]" />
                  <col className="w-[13%]" />
                  <col className="w-[8%]" />
                  <col className="w-[17%]" />
                  <col className="w-[12%]" />
                  <col className="w-[14%]" />
                  <col className="w-[18%]" />
                </colgroup>
              }
            >
              <thead className="sticky top-0 z-10 bg-slate-50 text-phx-xs font-black uppercase tracking-[0.1em] text-slate-500">
                <tr>
                  <th className="px-3 py-3">Employee</th>
                  <th className="px-3 py-3">Days</th>
                  <th className="px-3 py-3">Compliance</th>
                  <th className="px-3 py-3">Activity</th>
                  <th className="px-3 py-3">Warnings</th>
                  <th className="px-3 py-3">Logging</th>
                  <th className="px-3 py-3">Customer Pattern</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visibleRows.map((employee) => (
                  <tr className="align-top text-slate-700 hover:bg-slate-50/70" key={employee.hrId}>
                    <td className="break-words px-3 py-3">
                      <p className="font-black text-slate-950">{employee.employeeName}</p>
                      <p className="mt-1 text-xs font-semibold text-slate-500">
                        {[employee.managerName, employee.lineName, employee.areaName].filter(Boolean).join(" / ") || "—"}
                      </p>
                    </td>
                    <td className="break-words px-3 py-3">
                      <p>Hired {employee.hiringDateIso ?? "—"}</p>
                      <p className="text-xs text-slate-500">Eligible {formatNumber(employee.eligibleWorkingDays)}</p>
                      <p className="text-xs text-slate-500">Worked {formatNumber(employee.workedDays)}</p>
                    </td>
                    <td className="break-words px-3 py-3 font-black text-slate-950">{complianceLabel(employee, formatPercentValue)}</td>
                    <td className="break-words px-3 py-3">
                      <p className="font-bold text-rose-700">No activity {formatNumber(employee.noActivityCandidates)}</p>
                      <p className="text-sky-700">Vacation signal {formatNumber(employee.vacationSignalDays)}</p>
                      <p className="text-violet-700">Campaign {formatNumber(employee.campaignDays)}</p>
                      <p className="text-emerald-700">Visits {formatNumber(employee.totalVisits)}</p>
                    </td>
                    <td className="break-words px-3 py-3">
                      <p className="text-orange-700">Holidays {formatNumber(employee.holidayWarnings)}</p>
                      <p className="text-rose-700">Pre-hire {formatNumber(employee.preHireIgnoredValues)}</p>
                      <p className="text-red-700">Unknown {formatNumber(employee.unknownValues)}</p>
                    </td>
                    <td className={cn("break-words px-3 py-3", employee.loggingTimingSummary?.lateStartDayCount ? "text-violet-700" : "")}>
                      <p>First logged {employee.loggingTimingSummary?.avgFirstLoggedTime ?? "—"}</p>
                      <p className={employee.loggingTimingSummary?.lateStartDayCount ? "font-bold" : ""}>
                        Late days {employee.loggingTimingSummary ? formatNumber(employee.loggingTimingSummary.lateStartDayCount) : "—"}
                      </p>
                    </td>
                    <td className={cn("break-words px-3 py-3", employee.customerAuthenticity?.flagged ? "font-bold text-violet-700" : "")}>
                      {employee.customerAuthenticity?.flagged
                        ? employee.customerAuthenticity.flaggedRules.map(customerAuthenticityRuleLabel).join("; ")
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </PortalDesktopTable>
          )}
        />
      </div>
    </AdminTableShell>
  );
}

function ScorecardTable({ scorecards, title }: { scorecards: FieldWorkforceGroupScorecard[]; title: string }) {
  return (
    <AdminTableShell description="Worst-first (lowest average compliance). Informational rollup of the currently loaded month — no severity or deduction impact." title={title}>
      <div className="phoenix-horizontal-scroll overflow-auto">
        <PortalResponsiveDataList
          empty={
            <PortalEmptyState
              message="No employees to roll up for this month."
              title="Nothing to roll up"
            />
          }
          getKey={(scorecard) => scorecard.groupName}
          items={scorecards}
          renderCard={(scorecard) => (
            <PortalRecordCard
              accent={
                scorecard.avgCompliancePercent === null
                  ? "slate"
                  : scorecard.avgCompliancePercent >= 75
                    ? "emerald"
                    : scorecard.avgCompliancePercent >= 50
                      ? "amber"
                      : "rose"
              }
              meta={<span>{formatNumber(scorecard.employeeCount)} employees</span>}
              status={
                <span
                  className={cn(
                    "font-black",
                    scorecard.avgCompliancePercent === null
                      ? "text-slate-500"
                      : scorecard.avgCompliancePercent >= 75
                        ? "text-emerald-700"
                        : scorecard.avgCompliancePercent >= 50
                          ? "text-amber-700"
                          : "text-rose-700",
                  )}
                >
                  {scorecard.avgCompliancePercent === null ? "—" : `${scorecard.avgCompliancePercent}%`}
                </span>
              }
              title={scorecard.groupName}
            >
              <PortalRecordFields
                fields={[
                  {
                    label: "No Activity Total",
                    value: formatNumber(scorecard.totalNoActivityCandidates),
                  },
                  {
                    label: "High Severity Total",
                    value: formatNumber(scorecard.totalHighSeverityCount),
                  },
                  {
                    label: "Flagged Employees",
                    value: formatNumber(scorecard.flaggedEmployeeCount),
                  },
                ]}
              />
            </PortalRecordCard>
          )}
          renderTable={() => (
            <div className="hidden md:block">
        {/*
          Fits-the-screen golden rule (AGENTS.md §4): the `min-w-[820px]` floor is gone. Every
          cell here is a group name or a number, so six fixed columns fit at any desktop width
          with no merge needed — the headers wrap, which is the rule's permitted answer.
        */}
        <table className="w-full table-fixed text-left text-sm">
          <colgroup>
            <col className="w-[22%]" />
            <col className="w-[13%]" />
            <col className="w-[16%]" />
            <col className="w-[17%]" />
            <col className="w-[17%]" />
            <col className="w-[15%]" />
          </colgroup>
          <thead className="sticky top-0 z-10 bg-slate-50 text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">
            <tr>
              <th className="break-words px-4 py-3">Group</th>
              <th className="break-words px-4 py-3">Employees</th>
              <th className="break-words px-4 py-3">Avg Compliance</th>
              <th className="break-words px-4 py-3">No Activity Total</th>
              <th className="break-words px-4 py-3">High Severity Total</th>
              <th className="break-words px-4 py-3">Flagged Employees</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {scorecards.map((scorecard) => (
              <tr className="text-slate-700 hover:bg-slate-50/70" key={scorecard.groupName}>
                <td className="break-words px-4 py-3 font-black text-slate-950">{scorecard.groupName}</td>
                <td className="px-4 py-3">{formatNumber(scorecard.employeeCount)}</td>
                <td className={cn("px-4 py-3 font-black", scorecard.avgCompliancePercent === null ? "text-slate-500" : scorecard.avgCompliancePercent >= 75 ? "text-emerald-700" : scorecard.avgCompliancePercent >= 50 ? "text-amber-700" : "text-rose-700")}>
                  {scorecard.avgCompliancePercent === null ? "—" : `${scorecard.avgCompliancePercent}%`}
                </td>
                <td className="px-4 py-3 text-rose-700">{formatNumber(scorecard.totalNoActivityCandidates)}</td>
                <td className="px-4 py-3 text-rose-700">{formatNumber(scorecard.totalHighSeverityCount)}</td>
                <td className={cn("px-4 py-3", scorecard.flaggedEmployeeCount ? "font-bold text-rose-700" : "")}>{formatNumber(scorecard.flaggedEmployeeCount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
            </div>
          )}
        />
      </div>
    </AdminTableShell>
  );
}

function ScorecardsPanel({ employees }: { employees: FieldWorkforceEmployeeSummary[] }) {
  const managerScorecards = useMemo(() => buildFieldWorkforceManagerScorecards(employees), [employees]);
  const lineScorecards = useMemo(() => buildFieldWorkforceLineScorecards(employees), [employees]);

  return (
    <div className="space-y-4">
      <ScorecardTable scorecards={managerScorecards} title="Manager Scorecard" />
      <ScorecardTable scorecards={lineScorecards} title="Line Scorecard" />
    </div>
  );
}

function DiagnosticsPanel({
  errors,
  result,
  warnings,
}: {
  errors: FieldWorkforceValidationIssue[];
  result: FieldWorkforcePreviewResult;
  warnings: FieldWorkforceValidationIssue[];
}) {
  const preHireContext = result.employees.reduce((sum, employee) => sum + employee.preHireIgnoredValues, 0);
  const unknownValues = result.employees.reduce((sum, employee) => sum + employee.unknownValues, 0);

  return (
    <AdminTableShell
      description="Secondary parsing details. Collapsed by default to keep the review workspace compact."
      title="Import Diagnostics"
    >
      <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard label="File" value={result.metadata.fileName} />
        <MetricCard label="Sheet" value={result.metadata.sheetName} />
        <MetricCard label="Date Range" value={`${displayDate(result.metadata.dateRange.start)} - ${displayDate(result.metadata.dateRange.end)}`} />
        <MetricCard label="Warnings" tone={warnings.length ? "warning" : "success"} value={formatNumber(warnings.length)} />
        <MetricCard label="Pre-hire Context" tone={preHireContext ? "warning" : "neutral"} value={formatNumber(preHireContext)} />
        <MetricCard label="Unknown Values" tone={unknownValues ? "danger" : "success"} value={formatNumber(unknownValues)} />
        <MetricCard
          label="Public Holidays"
          tone={result.metadata.holidayConnected ? "success" : "warning"}
          value={`${formatNumber(result.metadata.holidaysDetected)} detected`}
        />
      </div>
      <div className="space-y-3 border-t border-slate-100 p-4">
        <details className="rounded-xl border border-slate-200 bg-white p-4">
          <summary className="cursor-pointer text-sm font-black text-slate-900">Validation warnings and errors</summary>
          <div className="mt-3 max-h-72 space-y-2 overflow-auto text-sm leading-6 text-slate-600">
            {[...errors, ...warnings].length === 0 ? <p>No diagnostics reported.</p> : null}
            {[...errors, ...warnings].map((issue, index) => (
              <p key={`${issue.code}:${issue.rowNumber ?? "file"}:${index}`}>
                <span className="font-black text-slate-900">{issue.code}</span>
                {issue.rowNumber ? ` / Row ${issue.rowNumber}` : ""}: {issue.message}
              </p>
            ))}
          </div>
        </details>
        <details className="rounded-xl border border-slate-200 bg-white p-4">
          <summary className="cursor-pointer text-sm font-black text-slate-900">Archive safety boundaries</summary>
          <div className="mt-3 grid gap-2 text-sm leading-6 text-slate-600 sm:grid-cols-2">
            <p>Archive snapshot only.</p>
            <p>No duplicate month replacement.</p>
            <p>No approval workflow.</p>
            <p>No payroll action.</p>
            <p>No leave mutation.</p>
            <p>No notifications.</p>
          </div>
        </details>
      </div>
    </AdminTableShell>
  );
}

function ReviewWorkspacePanels({
  activeTab,
  errors,
  result,
  warnings,
}: {
  activeTab: WorkspaceTab;
  errors: FieldWorkforceValidationIssue[];
  result: FieldWorkforcePreviewResult;
  warnings: FieldWorkforceValidationIssue[];
}) {
  const [employeeSearch, setEmployeeSearch] = useState("");
  const [selectedHrId, setSelectedHrId] = useState<string>(result.employees[0]?.hrId ?? "");
  const [hierarchyFilters, setHierarchyFilters] = useState<HierarchyFilterState>(emptyHierarchyFilters);

  const filteredEmployees = useMemo(() => {
    const needle = employeeSearch.trim().toLowerCase();
    return result.employees.filter((employee) =>
      (!needle || `${employee.employeeName} ${employee.hrId}`.toLowerCase().includes(needle)) &&
      matchesHierarchyFilters(employee, hierarchyFilters, result.employees),
    );
  }, [employeeSearch, hierarchyFilters, result.employees]);

  const selectedEmployee =
    filteredEmployees.find((employee) => employee.hrId === selectedHrId) ??
    filteredEmployees[0] ??
    null;

  function selectEmployee(hrId: string) {
    setSelectedHrId(hrId);
  }

  const totalCandidates = result.reviewCandidates.length;
  const highCount = result.severityCounts.High;
  const holidayWarnings = result.employees.reduce((sum, employee) => sum + employee.holidayWarnings, 0);

  if (activeTab === "overview") {
    return (
      <OverviewPanel
        highCount={highCount}
        holidayWarnings={holidayWarnings}
        result={result}
        totalCandidates={totalCandidates}
      />
    );
  }

  if (activeTab === "timeline") {
    return (
      <TimelinePanel
        employeeSearch={employeeSearch}
        employees={filteredEmployees}
        hierarchyFilters={hierarchyFilters}
        hierarchyItems={result.employees}
        selectedEmployee={selectedEmployee}
        onEmployeeSearchChange={setEmployeeSearch}
        onHierarchyFiltersChange={(filters) => {
          setHierarchyFilters(filters);
          setSelectedHrId("");
        }}
        onSelectEmployee={selectEmployee}
      />
    );
  }

  if (activeTab === "team-calendar") {
    return <TeamCalendarPanel employees={result.employees} />;
  }

  if (activeTab === "queue") return <ReviewQueue candidates={result.reviewCandidates} />;
  if (activeTab === "summary") return <MonthlySummaryTable employees={result.employees} hierarchyFilters={hierarchyFilters} onHierarchyFiltersChange={setHierarchyFilters} />;
  if (activeTab === "scorecards") return <ScorecardsPanel employees={result.employees} />;
  if (activeTab === "diagnostics") return <DiagnosticsPanel errors={errors} result={result} warnings={warnings} />;

  return null;
}

function RecommendationRows({
  isSavingDecisionKey,
  onSaveDecision,
  recommendations,
}: {
  isSavingDecisionKey: string | null;
  onSaveDecision: (recommendation: FieldWorkforceRecommendation, status: FieldWorkforceDecisionStatus, note: string, reason: FieldWorkforceDecisionReason | "") => void;
  recommendations: FieldWorkforceRecommendation[];
}) {
  const [query, setQuery] = useState("");
  const [severity, setSeverity] = useState<"All" | FieldWorkforceSeverity>("All");
  const [decisionStatus, setDecisionStatus] = useState<"All" | FieldWorkforceDecisionStatus>("All");
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);
  const [draftStatuses, setDraftStatuses] = useState<Record<string, FieldWorkforceDecisionStatus>>({});
  const [draftReasons, setDraftReasons] = useState<Record<string, FieldWorkforceDecisionReason | "">>({});
  const [draftNotes, setDraftNotes] = useState<Record<string, string>>({});
  const [hierarchyFilters, setHierarchyFilters] = useState<HierarchyFilterState>(emptyHierarchyFilters);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return recommendations.filter((recommendation) => {
      if (severity !== "All" && recommendation.severity !== severity) return false;
      if (decisionStatus !== "All" && recommendation.decisionStatus !== decisionStatus) return false;
      if (!matchesHierarchyFilters(recommendation, hierarchyFilters, recommendations)) return false;
      if (!needle) return true;
      return `${recommendation.employeeName} ${recommendation.employeeCode} ${recommendation.sourceLabel}`.toLowerCase().includes(needle);
    });
  }, [decisionStatus, hierarchyFilters, query, recommendations, severity]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const visibleRows = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  function resetPage() {
    setPage(1);
  }

  /**
   * The four decision controls, extracted so the desktop row and the phone card render the same
   * ones. All three drafts live in this component keyed by `recommendationKey`, not inside a row,
   * so the two copies edit one value rather than two — that is what makes a card list safe here.
   */
  function decisionSelect(recommendation: FieldWorkforceRecommendation, widthClassName: string) {
    const status = draftStatuses[recommendation.recommendationKey] ?? recommendation.decisionStatus;
    return (
      <div className="space-y-2">
        {decisionBadge(recommendation.decisionStatus)}
        <SearchableSelect
          className={cn(
            "h-9 px-3 text-xs",
            widthClassName,
          )}
          value={status}
          onChange={(event) => setDraftStatuses((current) => ({
            ...current,
            [recommendation.recommendationKey]: event.target.value as FieldWorkforceDecisionStatus,
          }))}
        >
          {decisionStatusOptionsForRecommendation(recommendation).map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </SearchableSelect>
      </div>
    );
  }

  function reasonSelect(recommendation: FieldWorkforceRecommendation, widthClassName: string) {
    const status = draftStatuses[recommendation.recommendationKey] ?? recommendation.decisionStatus;
    const reason = draftReasons[recommendation.recommendationKey] ?? recommendation.decisionReason;
    const note = draftNotes[recommendation.recommendationKey] ?? recommendation.hrNote;
    const requiresReason = status !== "Pending";
    return (
      <div>
        <SearchableSelect
          className={cn(
            "h-9 px-3 text-xs",
            widthClassName,
          )}
          value={reason}
          onChange={(event) => setDraftReasons((current) => ({
            ...current,
            [recommendation.recommendationKey]: event.target.value as FieldWorkforceDecisionReason | "",
          }))}
        >
          <option value="">{requiresReason ? "Choose reason" : "No reason needed"}</option>
          {decisionReasonOptions.map((option) => <option key={option} value={option}>{option}</option>)}
        </SearchableSelect>
        {requiresReason && !reason ? <p className="mt-1 text-xs font-semibold text-rose-600">Required for this decision.</p> : null}
        {reason === "Other" && !note.trim() ? <p className="mt-1 text-xs font-semibold text-rose-600">Other requires HR note.</p> : null}
      </div>
    );
  }

  function hrNoteInput(recommendation: FieldWorkforceRecommendation, widthClassName: string) {
    const note = draftNotes[recommendation.recommendationKey] ?? recommendation.hrNote;
    return (
      <input
        className={cn(
          phxFieldClassName,
          widthClassName,
        )}
        placeholder="HR decision note"
        value={note}
        onChange={(event) => setDraftNotes((current) => ({
          ...current,
          [recommendation.recommendationKey]: event.target.value,
        }))}
      />
    );
  }

  function saveDecisionButton(recommendation: FieldWorkforceRecommendation) {
    const status = draftStatuses[recommendation.recommendationKey] ?? recommendation.decisionStatus;
    const reason = draftReasons[recommendation.recommendationKey] ?? recommendation.decisionReason;
    const note = draftNotes[recommendation.recommendationKey] ?? recommendation.hrNote;
    const requiresReason = status !== "Pending";
    return (
      <Button
        className="gap-2"
        disabled={isSavingDecisionKey === recommendation.recommendationKey || (requiresReason && !reason) || (reason === "Other" && !note.trim())}
        type="button"
        variant="secondary"
        onClick={() => onSaveDecision(recommendation, status, note, reason)}
      >
        {isSavingDecisionKey === recommendation.recommendationKey ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        Save Decision
      </Button>
    );
  }

  return (
    <div className="space-y-3">
      <div className="border-b border-slate-100 p-4">
        <HierarchyFilters
          filters={hierarchyFilters}
          items={recommendations}
          onChange={(filters) => {
            setHierarchyFilters(filters);
            resetPage();
          }}
        />
      </div>
      <div className="grid gap-3 border-b border-slate-100 p-4 lg:grid-cols-[minmax(0,1fr)_170px_230px_160px]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            className={cn(phxFieldClassName, "pl-9")}
            placeholder="Filter employee, code, or source"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              resetPage();
            }}
          />
        </div>
        <SearchableSelect
          className="px-3"
          value={severity}
          onChange={(event) => {
            setSeverity(event.target.value as typeof severity);
            resetPage();
          }}
        >
          {severityOptions.map((option) => <option key={option} value={option}>{option} severity</option>)}
        </SearchableSelect>
        <SearchableSelect
          className="px-3"
          value={decisionStatus}
          onChange={(event) => {
            setDecisionStatus(event.target.value as typeof decisionStatus);
            resetPage();
          }}
        >
          <option value="All">All decisions</option>
          {decisionStatusOptions.map((option) => <option key={option} value={option}>{option}</option>)}
        </SearchableSelect>
        <SearchableSelect
          className="px-3"
          value={pageSize}
          onChange={(event) => {
            setPageSize(Number(event.target.value));
            resetPage();
          }}
        >
          {pageSizeOptions.map((option) => <option key={option} value={option}>{option} rows</option>)}
        </SearchableSelect>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 text-xs font-semibold text-slate-500">
        <span>Showing {visibleRows.length ? (safePage - 1) * pageSize + 1 : 0}-{Math.min(safePage * pageSize, filtered.length)} of {formatNumber(filtered.length)} recommendations</span>
        <div className="flex items-center gap-2">
          <Button disabled={safePage <= 1} type="button" variant="secondary" onClick={() => setPage((current) => Math.max(1, current - 1))}>Previous</Button>
          <span>Page {safePage} / {totalPages}</span>
          <Button disabled={safePage >= totalPages} type="button" variant="secondary" onClick={() => setPage((current) => Math.min(totalPages, current + 1))}>Next</Button>
        </div>
      </div>
      <div className="phoenix-horizontal-scroll max-h-[56vh] overflow-auto">
        {/* Eleven columns at a 1480px minimum — the widest table in the HR namespace, and the one
            where the columns off the right edge were the decision, the reason, the note and the
            Save button. Cards are safe despite those being editable: all three drafts live in the
            enclosing component keyed by recommendationKey, so both copies edit one value. */}
        <PortalResponsiveDataList
          empty={
            <PortalEmptyState
              message="No recommendations match the current filters."
              title="Nothing to decide"
            />
          }
          getKey={(recommendation) => recommendation.recommendationKey}
          items={visibleRows}
          renderCard={(recommendation) => (
            <PortalRecordCard
              actions={saveDecisionButton(recommendation)}
              meta={
                <span>
                  <span className="font-mono">{recommendation.employeeCode}</span> ·{" "}
                  {recommendation.monthKey} · {recommendation.sourceLabel}
                </span>
              }
              status={severityBadge(recommendation.severity)}
              title={recommendation.employeeName}
            >
              <PortalRecordFields
                fields={[
                  { label: "Dates", value: formatDates(recommendation.dates) },
                  { label: "Days", value: formatNumber(recommendation.daysCount) },
                  {
                    label: "Coverage / Amount",
                    value: `${coverageLabel(recommendation.existingCoverageStatus)} · Amount: ${
                      recommendation.estimatedAmount === null
                        ? "Requires payroll calculation"
                        : formatNumber(recommendation.estimatedAmount)
                    }`,
                  },
                  { label: "Recommendation", value: recommendation.recommendation },
                  { label: "Decision", value: decisionSelect(recommendation, "w-full") },
                  { label: "Reason", value: reasonSelect(recommendation, "w-full") },
                  { label: "HR Note", value: hrNoteInput(recommendation, "w-full") },
                ]}
              />
            </PortalRecordCard>
          )}
          renderTable={() => (
            <div className="hidden md:block">
        {/*
          Fits-the-screen golden rule (AGENTS.md §4), and the widest floor in this file at
          `min-w-[1480px]` — nearly double the content column at 768px. Everything from the
          decision select rightwards, which is the entire point of this screen, was off the
          right edge; an HR reviewer had to scroll to reach the control she came here to use.

          Merged, not shrunk. Eleven columns become seven, and nothing is dropped:
            * Days is the count of the dates beside it -> folded into the Dates cell.
            * Decision, Reason, HR Note and Save are one act, not four -> one "HR decision"
              cell with the three controls stacked and the Save button under them.
          Those three controls were a fixed `w-64` (256px each, 768px between them) and are
          now fluid, so they take the width the column actually has. That column is given the
          second-largest share for exactly that reason — the rule says a native select may not
          be squeezed, so the merge exists to buy it room rather than to take room from it.
        */}
        <table className="w-full table-fixed text-left text-sm">
          <colgroup>
            <col className="w-[13%]" />
            <col className="w-[14%]" />
            <col className="w-[10%]" />
            <col className="w-[14%]" />
            <col className="w-[17%]" />
            <col className="w-[8%]" />
            <col className="w-[24%]" />
          </colgroup>
          <thead className="sticky top-0 z-10 bg-slate-50 text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">
            <tr>
              <th className="break-words px-4 py-3">Employee</th>
              <th className="break-words px-4 py-3">Dates</th>
              <th className="break-words px-4 py-3">Source</th>
              <th className="break-words px-4 py-3">Coverage / Amount</th>
              <th className="break-words px-4 py-3">Recommendation</th>
              <th className="break-words px-4 py-3">Severity</th>
              <th className="break-words px-4 py-3">HR decision</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {visibleRows.map((recommendation) => {
              return (
                <tr className="align-top text-slate-700 hover:bg-slate-50/70" key={recommendation.recommendationKey}>
                  <td className="break-words px-4 py-3">
                    <p className="break-words font-black text-slate-950">{recommendation.employeeName}</p>
                    <p className="mt-1 break-words font-mono text-xs font-semibold text-slate-500">{recommendation.employeeCode}</p>
                  </td>
                  <td className="break-words px-4 py-3">
                    <p className="break-words font-semibold text-slate-900">{formatDates(recommendation.dates)}</p>
                    <p className="mt-1 text-xs text-slate-500">{recommendation.monthKey}</p>
                    <p className="mt-1 text-xs font-semibold text-slate-500">
                      {formatNumber(recommendation.daysCount)} days
                    </p>
                  </td>
                  <td className="break-words px-4 py-3">{recommendation.sourceLabel}</td>
                  <td className="break-words px-4 py-3">
                    <p className="break-words">{coverageLabel(recommendation.existingCoverageStatus)}</p>
                    <p className="mt-1 break-words text-xs text-slate-500">Amount: {recommendation.estimatedAmount === null ? "Requires payroll calculation" : formatNumber(recommendation.estimatedAmount)}</p>
                  </td>
                  <td className="break-words px-4 py-3 leading-6">{recommendation.recommendation}</td>
                  <td className="px-4 py-3">{severityBadge(recommendation.severity)}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-2">
                      {decisionSelect(recommendation, "w-full")}
                      {reasonSelect(recommendation, "w-full")}
                      {hrNoteInput(recommendation, "w-full")}
                      {saveDecisionButton(recommendation)}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
            </div>
          )}
        />
      </div>
    </div>
  );
}

function FinalActionsTable({
  actions,
}: {
  actions: FieldWorkforceFinalAction[];
}) {
  const [hierarchyFilters, setHierarchyFilters] = useState<HierarchyFilterState>(emptyHierarchyFilters);
  const filteredActions = useMemo(() =>
    actions.filter((action) => matchesHierarchyFilters(action, hierarchyFilters, actions)),
  [actions, hierarchyFilters]);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-4">
        <HierarchyFilters filters={hierarchyFilters} items={actions} onChange={setHierarchyFilters} />
      </div>
      <AdminCallout tone="neutral">
        <ShieldAlert className="mt-0.5 h-4 w-4" />
        <p>Final approved actions are report-only. Exporting does not execute payroll, mutate leave balances, or push integrations.</p>
      </AdminCallout>
      <div className="phoenix-horizontal-scroll max-h-[52vh] overflow-auto">
        {/* Ten read-only columns at a 1280px minimum. Nothing here is editable, so the double
            render PortalResponsiveDataList performs is free — no draft state to lose across the
            breakpoint. Push Status and HR Note were the two columns off the right edge. */}
        <PortalResponsiveDataList
          empty={
            <PortalEmptyState
              message="No approved report actions match the current filters."
              title="Nothing approved yet"
            />
          }
          getKey={(action) => action.recommendationKey}
          items={filteredActions}
          renderCard={(action) => (
            <PortalRecordCard
              meta={
                <span>
                  <span className="font-mono">{action.employeeCode}</span> · {action.actionType}
                </span>
              }
              status={<Badge variant="neutral">{action.pushStatus}</Badge>}
              title={action.employeeName}
            >
              <PortalRecordFields
                fields={[
                  { label: "Approved Dates", value: formatDates(action.approvedDates) },
                  { label: "Days", value: formatNumber(action.approvedDaysCount) },
                  {
                    label: "Amount",
                    value: action.amount === null
                      ? "Amount requires payroll calculation"
                      : formatNumber(action.amount),
                  },
                  { label: "Reason", value: action.decisionReason || "-" },
                  { label: "Approved By", value: action.approvedBy ?? "-" },
                  { label: "Approved At", value: displayDateTime(action.approvedAt) },
                  { label: "HR Note", value: action.hrNote || "-" },
                ]}
              />
            </PortalRecordCard>
          )}
          renderTable={() => (
            <div className="hidden md:block">
        {/*
          Fits-the-screen golden rule (AGENTS.md §4). Mobile has `renderCard`; this desktop
          half was a `min-w-[1280px]` floor, so the HR note and the push status sat off the
          right edge at every desktop width.

          Merged, not shrunk, and nothing is dropped. Ten columns become eight: the approved
          dates and their day count are one span, and who approved it and when are one act.
        */}
        <table className="w-full table-fixed text-left text-sm">
          <colgroup>
            <col className="w-[15%]" />
            <col className="w-[11%]" />
            <col className="w-[15%]" />
            <col className="w-[10%]" />
            <col className="w-[14%]" />
            <col className="w-[14%]" />
            <col className="w-[12%]" />
            <col className="w-[9%]" />
          </colgroup>
          <thead className="sticky top-0 z-10 bg-slate-50 text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">
            <tr>
              <th className="break-words px-4 py-3">Employee</th>
              <th className="break-words px-4 py-3">Action Type</th>
              <th className="break-words px-4 py-3">Approved Dates</th>
              <th className="break-words px-4 py-3">Amount</th>
              <th className="break-words px-4 py-3">Reason</th>
              <th className="break-words px-4 py-3">Approved By</th>
              <th className="break-words px-4 py-3">HR Note</th>
              <th className="break-words px-4 py-3">Push Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filteredActions.map((action) => (
              <tr className="align-top text-slate-700 hover:bg-slate-50/70" key={action.recommendationKey}>
                <td className="break-words px-4 py-3">
                  <p className="break-words font-black text-slate-950">{action.employeeName}</p>
                  <p className="mt-1 break-words font-mono text-xs font-semibold text-slate-500">{action.employeeCode}</p>
                </td>
                <td className="break-words px-4 py-3">{action.actionType}</td>
                <td className="break-words px-4 py-3">
                  <span className="block break-words">{formatDates(action.approvedDates)}</span>
                  <span className="mt-1 block text-xs font-semibold text-slate-500">
                    {formatNumber(action.approvedDaysCount)} days
                  </span>
                </td>
                <td className="break-words px-4 py-3">{action.amount === null ? "Amount requires payroll calculation" : formatNumber(action.amount)}</td>
                <td className="break-words px-4 py-3">{action.decisionReason || "-"}</td>
                <td className="break-words px-4 py-3">
                  <span className="block break-words">{action.approvedBy ?? "-"}</span>
                  <span className="mt-1 block break-words text-xs font-semibold text-slate-500">
                    {displayDateTime(action.approvedAt)}
                  </span>
                </td>
                <td className="break-words px-4 py-3 leading-6">{action.hrNote || "-"}</td>
                <td className="px-4 py-3"><Badge variant="neutral">{action.pushStatus}</Badge></td>
              </tr>
            ))}
          </tbody>
        </table>
            </div>
          )}
        />
      </div>
    </div>
  );
}

function RecommendationsPanel({
  isLoading,
  isSavingDecisionKey,
  onRefresh,
  onSaveDecision,
  report,
  showPayrollRecommendations,
}: {
  isLoading: boolean;
  isSavingDecisionKey: string | null;
  onRefresh: (auditFinalReportView?: boolean) => void;
  onSaveDecision: (recommendation: FieldWorkforceRecommendation, status: FieldWorkforceDecisionStatus, note: string, reason: FieldWorkforceDecisionReason | "") => void;
  report: FieldWorkforceRecommendationsReport | null;
  showPayrollRecommendations: boolean;
}) {
  const [recommendationTab, setRecommendationTab] = useState<"final" | "leave" | "payroll">("leave");
  // Payroll recommendations are hidden for viewers without payroll standing (today: the SFE
  // Manager, whose remit is sales and CRM). Defaulting the tab away from "payroll" too, so a
  // hidden tab can never be the active one.
  const visibleRecommendationTab = !showPayrollRecommendations && recommendationTab === "payroll" ? "leave" : recommendationTab;

  if (!report) {
    return (
      <Card className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p>Load recommendations for this archived month.</p>
          <Button className="gap-2" disabled={isLoading} type="button" variant="secondary" onClick={() => onRefresh(false)}>
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Load Recommendations
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <AdminTableShell
      description="Decision-support reports only. These decisions do not push to payroll or mutate leave balances."
      title="Recommendations"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-4">
        <div className="flex flex-wrap gap-2">
          {(([
            ["leave", "Leave Recommendations"],
            ["payroll", "Payroll Recommendations"],
            ["final", "Final Actions"],
          ] as const).filter(([id]) => showPayrollRecommendations || id !== "payroll")).map(([id, label]) => (
            <button
              aria-pressed={visibleRecommendationTab === id}
              className={cn(
                "rounded-xl px-3 py-2 text-xs font-black transition",
                visibleRecommendationTab === id ? "bg-slate-950 text-white" : "bg-white text-slate-600 hover:bg-orange-50 hover:text-orange-700",
              )}
              key={id}
              type="button"
              onClick={() => {
                setRecommendationTab(id);
                if (id === "final") onRefresh(true);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <Button className="gap-2" disabled={isLoading} type="button" variant="secondary" onClick={() => onRefresh(visibleRecommendationTab === "final")}>
          {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Refresh
        </Button>
      </div>
      <div className="grid gap-3 border-b border-slate-100 p-4 md:grid-cols-2">
        <AdminCallout tone="warning">
          <CalendarDays className="mt-0.5 h-4 w-4" />
          <p>{report.integrationStatus.leaveSourceMessage}</p>
        </AdminCallout>
        <AdminCallout tone="warning">
          <ShieldAlert className="mt-0.5 h-4 w-4" />
          <p>{report.integrationStatus.payrollAmountMessage}</p>
        </AdminCallout>
      </div>
      {visibleRecommendationTab === "leave" ? (
        <RecommendationRows
          isSavingDecisionKey={isSavingDecisionKey}
          recommendations={report.leaveRecommendations}
          onSaveDecision={onSaveDecision}
        />
      ) : null}
      {visibleRecommendationTab === "payroll" ? (
        <RecommendationRows
          isSavingDecisionKey={isSavingDecisionKey}
          recommendations={report.payrollRecommendations}
          onSaveDecision={onSaveDecision}
        />
      ) : null}
      {visibleRecommendationTab === "final" ? <FinalActionsTable actions={report.finalActions} /> : null}
    </AdminTableShell>
  );
}

export function FieldWorkforceComplianceWorkspace({ showPayrollRecommendations = true }: { showPayrollRecommendations?: boolean } = {}) {
  const [isLoadingRecommendations, setIsLoadingRecommendations] = useState(false);
  const [isSavingDecisionKey, setIsSavingDecisionKey] = useState<string | null>(null);
  const [result, setResult] = useState<FieldWorkforcePreviewResult | null>(null);
  const [recommendationsReport, setRecommendationsReport] = useState<FieldWorkforceRecommendationsReport | null>(null);
  const [errors, setErrors] = useState<FieldWorkforceValidationIssue[]>([]);
  const [warnings, setWarnings] = useState<FieldWorkforceValidationIssue[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [recommendationsMessage, setRecommendationsMessage] = useState<string | null>(null);
  const [recommendationsError, setRecommendationsError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("overview");
  const [liveMirrorMonthKey, setLiveMirrorMonthKey] = useState<string | null>(null);
  const [mirrorFreshness, setMirrorFreshness] = useState<FieldWorkforceMirrorFreshness | null>(null);
  const [recentMonths, setRecentMonths] = useState<FieldWorkforceLiveMonthOption[]>([]);
  const [isLoadingMonthOptions, setIsLoadingMonthOptions] = useState(false);
  const [monthOptionsError, setMonthOptionsError] = useState<string | null>(null);
  const [selectedMonthKey, setSelectedMonthKey] = useState("");
  const [isLoadingLiveView, setIsLoadingLiveView] = useState(false);

  function handleWorkspaceTabChange(tab: WorkspaceTab) {
    setActiveTab(tab);
    if (
      tab === "recommendations" &&
      liveMirrorMonthKey &&
      !recommendationsReport &&
      !isLoadingRecommendations
    ) {
      void loadLiveMirrorRecommendations(liveMirrorMonthKey);
    }
  }

  async function loadLiveMirrorRecommendations(monthKey: string) {
    setIsLoadingRecommendations(true);
    setRecommendationsError(null);
    try {
      const response = await fetch(
        `/api/admin/field-workforce-compliance/live-snapshots/${monthKey}/recommendations`,
        { method: "GET" },
      );
      const payload = await readJsonResponse<RecommendationsResponse>(response);
      if (payload.success && payload.data) {
        setRecommendationsReport(payload.data);
      } else {
        setRecommendationsError(payload.message ?? payload.error ?? "Recommendations could not be loaded.");
      }
    } catch (error) {
      setRecommendationsError(error instanceof Error ? error.message : "Recommendations could not be loaded.");
    } finally {
      setIsLoadingRecommendations(false);
    }
  }

  // Cheap month-options list (no computation, just calendar math server-side) for the picker —
  // does not need re-fetching after selecting a month, since it's never tied to what's been
  // viewed. Only called once, from the mount effect below.
  useEffect(() => {
    let cancelled = false;

    async function loadRecentMonths() {
      setIsLoadingMonthOptions(true);
      setMonthOptionsError(null);
      try {
        const response = await fetch("/api/admin/field-workforce-compliance/live-snapshots", { method: "GET" });
        const payload = await readJsonResponse<LiveMonthsListResponse>(response);
        if (cancelled) return;
        if (payload.success && payload.data) {
          setRecentMonths(payload.data);
        } else {
          setMonthOptionsError(payload.message ?? payload.error ?? "Recent months could not be loaded.");
        }
      } catch (error) {
        if (!cancelled) setMonthOptionsError(error instanceof Error ? error.message : "Recent months could not be loaded.");
      } finally {
        if (!cancelled) setIsLoadingMonthOptions(false);
      }
    }

    // Every month is computed live now (no saved-snapshot list to consult first), so the
    // current month can be selected immediately on mount.
    const now = new Date();
    const currentMonthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    void handleSelectLiveMonth(currentMonthKey);
    void loadRecentMonths();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Shows a saved Field Workforce Compliance snapshot for the chosen month — a fast DB
   * read, not a live recompute. Snapshots are kept current automatically: the visits-report
   * sync (cron + manual backfill) recomputes whichever month(s) it touches, and a one-time
   * historical backfill covers everything before that. `forceRefresh` recomputes the chosen
   * month on the spot (e.g. the user's own "Refresh" action) rather than serving the cached copy. */
  async function handleSelectLiveMonth(monthKey: string) {
    if (!monthKey || isLoadingLiveView) return;
    setIsLoadingLiveView(true);
    setResult(null);
    setErrors([]);
    setWarnings([]);
    setMessage(null);
    setRecommendationsReport(null);
    setRecommendationsMessage(null);
    setRecommendationsError(null);

    try {
      const response = await fetch(`/api/admin/field-workforce-compliance/live-snapshots/${monthKey}`, { method: "GET" });
      const payload = await readJsonResponse<LiveViewResponse>(response);
      if (payload.success && payload.data) {
        setResult(payload.data.preview);
        setLiveMirrorMonthKey(payload.data.monthKey);
        setMirrorFreshness(payload.mirrorFreshness ?? null);
        setSelectedMonthKey(payload.data.monthKey);
        setActiveTab("timeline");
      } else {
        setActiveTab("overview");
        setMessage(payload.message ?? payload.error ?? "This month's compliance data could not be computed.");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "This month's compliance data could not be computed.");
    } finally {
      setIsLoadingLiveView(false);
    }
  }

  async function handleSaveDecision(
    recommendation: FieldWorkforceRecommendation,
    decisionStatus: FieldWorkforceDecisionStatus,
    hrNote: string,
    decisionReason: FieldWorkforceDecisionReason | "",
  ) {
    if (decisionStatus !== "Pending" && !decisionReason) {
      setRecommendationsError("A decision reason is required for non-Pending HR decisions.");
      return;
    }
    if (decisionReason === "Other" && !hrNote.trim()) {
      setRecommendationsError("HR note is required when decision reason is Other.");
      return;
    }
    setIsSavingDecisionKey(recommendation.recommendationKey);
    setRecommendationsMessage(null);
    setRecommendationsError(null);
    try {
      const url = `/api/admin/field-workforce-compliance/live-snapshots/${liveMirrorMonthKey}/recommendations`;
      const response = await fetch(url, {
        body: JSON.stringify({
          decisionReason,
          decisionStatus,
          hrNote,
          recommendationKey: recommendation.recommendationKey,
        }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      const payload = await readJsonResponse<RecommendationsResponse>(response);
      if (payload.success && payload.data) {
        setRecommendationsReport(payload.data);
        setRecommendationsMessage("HR decision saved for the recommendation report only. No payroll or leave action was executed.");
      } else {
        setRecommendationsError(payload.message ?? payload.error ?? "Decision update failed.");
      }
    } catch (error) {
      setRecommendationsError(error instanceof Error ? error.message : "Decision update failed.");
    } finally {
      setIsSavingDecisionKey(null);
    }
  }

  return (
    <div className="min-h-[calc(100vh-7rem)] rounded-3xl border border-slate-200 bg-[linear-gradient(180deg,#F8FAFC_0%,#EEF3F8_100%)] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] sm:p-5 xl:p-7">
      <div className="space-y-5">
        <AdminPageHero
          description="Understand and review monthly field workforce activity safely before any future HR, leave, or payroll decision."
          eyebrow="Operational HR Governance"
          icon={<ShieldAlert className="h-3.5 w-3.5" />}
          title="Workforce Compliance"
        />

        <AdminTableShell
          description="Always computed live from Phoenix CRM visits, with the iReports360 archive before each team's start — every month, including past ones, reflects the record as it stands right now. Nothing is cached or pre-saved. Recommendations for a live month can still be reviewed and decided under the Recommendations tab below."
          title="Live View (Field Visits)"
        >
          <div className="flex flex-wrap items-end gap-3 p-4">
            {recentMonths.length > 0 ? (
              <label className="flex flex-col gap-1 text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-400">
                Month
                <SearchableSelect
                  className="min-w-[220px] px-3"
                  value={selectedMonthKey}
                  onChange={(event) => void handleSelectLiveMonth(event.target.value)}
                >
                  {recentMonths.map((option) => (
                    <option key={option.monthKey} value={option.monthKey}>
                      {option.monthKey}
                    </option>
                  ))}
                </SearchableSelect>
              </label>
            ) : (
              <p className="text-sm text-slate-500">
                {isLoadingMonthOptions ? "Loading months…" : "Recent months could not be loaded."}
              </p>
            )}
            {isLoadingLiveView ? (
              <span className="inline-flex items-center gap-2 text-xs font-semibold text-slate-500">
                <Loader2 className="h-4 w-4 animate-spin" /> Computing live from the visits mirror…
              </span>
            ) : mirrorFreshness?.ageHours != null ? (
              <span className="text-xs font-semibold text-slate-500">
                Visits mirror synced {formatSyncAge(mirrorFreshness.ageHours)}
              </span>
            ) : null}
          </div>
          {monthOptionsError ? (
            <div className="border-t border-slate-100 p-4">
              <AdminCallout tone="warning">
                <AlertTriangle className="mt-0.5 h-4 w-4" />
                <p>{monthOptionsError}</p>
              </AdminCallout>
            </div>
          ) : null}
          {mirrorFreshness && (mirrorFreshness.isStale || mirrorFreshness.isOpenMonth) ? (
            <div className="border-t border-slate-100 p-4">
              <AdminCallout tone={mirrorFreshness.isStale ? "danger" : "warning"}>
                <AlertTriangle className="mt-0.5 h-4 w-4" />
                <p>
                  {mirrorFreshness.isStale
                    ? `The visits mirror hasn't synced successfully in ${mirrorFreshness.ageHours != null ? formatSyncAge(mirrorFreshness.ageHours) : "over a day"}${mirrorFreshness.latestStatus === "failed" ? " (last sync failed)" : ""}. This month's latest days may be incomplete — verify before approving any leave or deduction.`
                    : "This month is still in progress. Its most recent days are still filling in, so treat late “N” days as provisional and confirm before approving any leave or deduction."}
                </p>
              </AdminCallout>
            </div>
          ) : null}
        </AdminTableShell>

        {message ? (
          <AdminCallout tone="danger">
            <AlertTriangle className="mt-0.5 h-4 w-4" />
            <p>{message}</p>
          </AdminCallout>
        ) : null}
        {recommendationsMessage ? (
          <AdminCallout tone="success">
            <BadgeCheck className="mt-0.5 h-4 w-4" />
            <p>{recommendationsMessage}</p>
          </AdminCallout>
        ) : null}
        {recommendationsError ? (
          <AdminCallout tone="warning">
            <AlertTriangle className="mt-0.5 h-4 w-4" />
            <p>{recommendationsError}</p>
          </AdminCallout>
        ) : null}
        <ValidationIssues issues={errors} title="Preview blocked" tone="danger" />
        <ValidationIssues issues={warnings} title="Preview warnings" tone="warning" />

        <WorkspaceTabs activeTab={activeTab} tabs={mainWorkspaceTabs} onChange={handleWorkspaceTabChange} />
        {activeTab === "head-office-attendance" ? (
          <HeadOfficeAttendancePanel />
        ) : activeTab === "recommendations" ? (
          liveMirrorMonthKey ? (
            <RecommendationsPanel
              isLoading={isLoadingRecommendations}
              isSavingDecisionKey={isSavingDecisionKey}
              report={recommendationsReport}
              showPayrollRecommendations={showPayrollRecommendations}
              onRefresh={() => void loadLiveMirrorRecommendations(liveMirrorMonthKey)}
              onSaveDecision={(recommendation, decisionStatus, hrNote, decisionReason) => void handleSaveDecision(recommendation, decisionStatus, hrNote, decisionReason)}
            />
          ) : (
            <Card className="rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
              <p className="mx-auto max-w-xl text-sm leading-6 text-slate-500">
                Select a month above to review and decide recommendations here.
              </p>
            </Card>
          )
        ) : result ? (
          <>
            <ReviewWorkspacePanels
              activeTab={activeTab}
              errors={errors}
              key={`${result.metadata.year}-${result.metadata.month}-${result.metadata.fileName}`}
              result={result}
              warnings={warnings}
            />
            {result.severityCounts.Review > 0 && !result.metadata.holidayConnected ? (
              <AdminCallout tone="warning">
                <CalendarDays className="mt-0.5 h-4 w-4" />
                <p>{result.metadata.holidayMessage ?? "Public holiday overlay could not be loaded for this preview."}</p>
              </AdminCallout>
            ) : null}
          </>
        ) : (
          <Card className="rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-orange-200 bg-orange-50 text-orange-600">
              <BadgeCheck className="h-5 w-5" />
            </div>
            <h2 className="mt-4 text-lg font-black text-slate-950">Compliance workspace ready</h2>
            <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-slate-500">
              Select a month from the Live View above to review normalized activity, severity labels, public holiday overlays, and employee timelines.
            </p>
            <div className="mt-4 inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-black uppercase tracking-[0.14em] text-slate-500">
              <ListFilter className="h-3.5 w-3.5" />
              Compact tabbed workspace
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
