"use client";

/**
 * Shared bold org-chart renderer used by BOTH the admin `/organogram` page and the
 * employee-portal Organogram tab. It turns the scoped `organogramRows` (already
 * filtered + visibility-checked by each surface) into a top-down chart:
 *
 *   Executive spine (CEO → Line → NSM)
 *     → tier of DSM lanes reporting to NSM ("Reports to NSM")
 *     → each RSM banner with its child DSM lanes (`childLanes`)
 *       → per-lane collapsible member trees with drawn connector lines
 *
 * All hierarchy math lives in `organogram-view-model.ts` / `organogram-safety.ts`
 * (untouched). This module is presentation only. The `theme` prop tunes labels and a
 * couple of paddings; both admin and portal shells force square corners globally, so
 * the two surfaces read as one consistent chart.
 */

import {
  Building2,
  ChevronDown,
  ChevronRight,
  Crown,
  ImageDown,
  Layers,
  Loader2,
  MapPin,
  Minus,
  Network,
  Plus,
  Printer,
  UserRound,
  UsersRound,
} from "lucide-react";
import * as React from "react";

import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import { formatDateOnly } from "@/lib/date-only";
import type { ExportColumn, ExportRow } from "@/lib/export/table-workbook";
import { calculateOrganogramStructureKpis } from "@/lib/reports/organogram-safety";
import {
  type ManagerLane,
  type MemberNode,
  type OrganogramRow,
  type TopManagerLane,
  buildMemberTree,
  buildOrganogramLanes,
  emptyText,
  isMedicalRep,
  rowKey,
} from "@/lib/reports/organogram-view-model";
import { cn, formatEmployeeDisplayName } from "@/lib/utils";

export type OrgChartTheme = "admin" | "portal";

export type OrgChartKpiLabels = {
  medicalRep: string;
  dsm: string;
  rsm: string;
  nsm: string;
  total: string;
};

/**
 * Default (full) KPI labels. The admin surface uses these; the portal passes shorter
 * variants for its narrower column. Kept as a constant here so the wording lives with
 * the chart it labels.
 */
export const DEFAULT_ORG_KPI_LABELS: OrgChartKpiLabels = {
  dsm: "District Sales Managers",
  medicalRep: "Medical Sales Representatives",
  nsm: "National Sales Managers",
  rsm: "Regional Sales Managers",
  total: "Total Line Structure",
};

type OrgChartTreeProps = {
  rows: OrganogramRow[];
  lineName: string | null;
  theme?: OrgChartTheme;
  kpiLabels?: OrgChartKpiLabels;
};

/* ------------------------------------------------------------------ */
/*  Small helpers                                                      */
/* ------------------------------------------------------------------ */

function initials(name: string | null | undefined) {
  const parts = String(name ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);
  const joined = parts.map((part) => part[0] ?? "").join("");
  return joined ? joined.toUpperCase() : "—";
}

function formatHireDate(value: string | null | undefined) {
  return formatDateOnly(value, "en", { day: "2-digit", month: "short", year: "numeric" });
}

function countDescendants(node: MemberNode): number {
  return node.children.reduce((total, child) => total + 1 + countDescendants(child), 0);
}

/**
 * Stable per-lane identity key for a DSM/RSM-anchored lane. Prefers the lane's
 * manager/vacancy-slot identity (already unique via rowKey) over the array
 * position, so collapse state doesn't cross-bind onto a different lane when
 * the underlying rows are reordered or filtered (e.g. by search). Falls back
 * to a positional key only for the rare lane with neither a dsm nor an rsm.
 */
function tierLaneKey(tier: "t1" | "t2", group: TopManagerLane, index: number) {
  const identity = group.dsm ?? group.rsm ?? null;
  return identity ? `${tier}-${rowKey(identity)}` : `${tier}-${group.name}-${index}`;
}

function childLaneKey(parentKey: string, lane: ManagerLane, index: number) {
  return lane.dsm ? `${parentKey}-child-${rowKey(lane.dsm)}` : `${parentKey}-child-${lane.name}-${index}`;
}

// Lane-grid column count: a plain `auto-fit` grid packs as many 240px+ lanes
// as the viewport allows per row, so the same line renders a different,
// unbalanced split (e.g. 5 then 2) depending on screen width. Fixing the
// column count at ceil(count/2) instead always wraps into two even-ish rows
// (7 -> 4+3, 6 -> 3+3) regardless of viewport, matching how a manually laid
// out org chart reads. Below 5 lanes there's no wrap to balance, so show
// them all on one row.
function laneGridColumnCount(count: number) {
  return count > 4 ? Math.ceil(count / 2) : Math.max(count, 1);
}

/* ------------------------------------------------------------------ */
/*  Avatar + person / vacancy card                                    */
/* ------------------------------------------------------------------ */

function Avatar({
  name,
  vacancy,
}: {
  name: string | null | undefined;
  vacancy: boolean;
}) {
  if (vacancy) {
    return (
      <span
        aria-hidden
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-dashed border-orange-400 bg-orange-50 text-orange-500"
      >
        <UserRound className="h-4 w-4" />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-slate-700 to-slate-900 text-[11px] font-black text-white"
    >
      {initials(name)}
    </span>
  );
}

function PersonNode({
  row,
  collapsed,
  onToggle,
  hiddenCount,
}: {
  row: OrganogramRow;
  collapsed?: boolean;
  onToggle?: () => void;
  hiddenCount?: number;
}) {
  const isVacancy = row.type === "vacancy";
  const showRepFields = isVacancy || isMedicalRep(row);
  const title = row.positionTitle ?? row.jobTitle;

  return (
    <div
      className={cn(
        "group relative flex items-start gap-2.5 overflow-hidden rounded-xl border px-3 py-2.5 shadow-[0_2px_10px_rgba(15,23,42,0.05)] transition-all duration-150 hover:-translate-y-px hover:shadow-md",
        isVacancy
          ? "border-orange-300 bg-orange-50/70 [border-style:dashed]"
          : "border-slate-200 bg-white hover:border-slate-300",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-0 w-1",
          isVacancy ? "bg-orange-400" : "bg-slate-300",
        )}
      />
      <Avatar name={row.displayName} vacancy={isVacancy} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className="whitespace-normal break-words text-[12px] font-bold leading-tight text-slate-900">
            {isVacancy ? "Open Vacancy" : formatEmployeeDisplayName(row.displayName)}
          </p>
          {isVacancy ? (
            <span className="shrink-0 rounded-md bg-orange-100 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-[0.12em] text-orange-700">
              Vacant
            </span>
          ) : null}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-slate-500">
          <span className="font-mono font-semibold text-slate-400">{row.hrId}</span>
          {title && !showRepFields ? (
            <span className="break-words font-medium text-slate-600">{title}</span>
          ) : null}
        </div>
        {showRepFields ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-slate-500">
            {row.hireDate ? (
              <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 font-medium">
                <span aria-hidden className="h-1 w-1 rounded-full bg-slate-400" />
                {formatHireDate(row.hireDate)}
              </span>
            ) : null}
            <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 font-medium">
              <MapPin className="h-2.5 w-2.5 text-orange-400" />
              {emptyText(row.areaName)}
            </span>
          </div>
        ) : null}
      </div>
      {onToggle ? (
        <button
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand reports" : "Collapse reports"}
          className="ml-1 inline-flex shrink-0 items-center gap-1 self-center rounded-md border border-slate-200 bg-white px-1.5 py-1 text-[10px] font-bold text-slate-500 shadow-sm transition hover:border-orange-300 hover:text-orange-600"
          onClick={onToggle}
          type="button"
        >
          {collapsed ? (
            <>
              <ChevronRight className="h-3 w-3" />
              {hiddenCount ? <span>{hiddenCount}</span> : null}
            </>
          ) : (
            <ChevronDown className="h-3 w-3" />
          )}
        </button>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Collapsible member branch (drawn connector lines)                 */
/* ------------------------------------------------------------------ */

function MemberBranch({
  node,
  collapsedKeys,
  onToggle,
  level = 1,
}: {
  node: MemberNode;
  collapsedKeys: Set<string>;
  onToggle: (key: string) => void;
  level?: number;
}) {
  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsedKeys.has(node.key);

  return (
    <li
      aria-expanded={hasChildren ? !isCollapsed : undefined}
      aria-level={level}
      aria-selected={false}
      className="relative before:absolute before:-left-4 before:top-5 before:h-px before:w-4 before:bg-orange-200/80"
      role="treeitem"
    >
      <PersonNode
        collapsed={isCollapsed}
        hiddenCount={hasChildren ? countDescendants(node) : undefined}
        onToggle={hasChildren ? () => onToggle(node.key) : undefined}
        row={node.row}
      />
      {hasChildren && !isCollapsed ? (
        <ul
          className="ml-4 mt-2 space-y-2 border-l-2 border-orange-200/80 pl-4"
          role="group"
        >
          {node.children.map((child) => (
            <MemberBranch
              collapsedKeys={collapsedKeys}
              key={child.key}
              level={level + 1}
              node={child}
              onToggle={onToggle}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/* ------------------------------------------------------------------ */
/*  Manager lane                                                       */
/* ------------------------------------------------------------------ */

function ManagerLane({
  group,
  laneKey,
  collapsedKeys,
  onToggle,
}: {
  group: ManagerLane;
  laneKey: string;
  collapsedKeys: Set<string>;
  onToggle: (key: string) => void;
}) {
  const isVacantManagerSeat = group.dsm?.type === "vacancy";
  const laneCollapsed = collapsedKeys.has(laneKey);
  const groupVacancies =
    group.members.filter((member) => member.type === "vacancy").length +
    (isVacantManagerSeat ? 1 : 0);
  const managerScope = isVacantManagerSeat
    ? [group.dsm?.lineName, group.dsm?.areaName ?? group.dsm?.regionName]
        .filter(Boolean)
        .join(" / ")
    : null;
  const memberTree = React.useMemo(() => buildMemberTree(group.members), [group.members]);

  return (
    <div className="min-w-[240px] overflow-hidden border border-slate-200 bg-white shadow-[0_2px_12px_rgba(15,23,42,0.06)] transition-shadow duration-300 hover:shadow-[0_10px_28px_rgba(15,23,42,0.1)]">
      {/* Manager header — filled seats are dark slate, vacant seats warm orange */}
      <div
        className={cn(
          "flex items-start gap-2.5 px-3 py-2.5",
          isVacantManagerSeat
            ? "bg-gradient-to-r from-orange-50 to-orange-100/60 text-slate-800"
            : "bg-gradient-to-br from-slate-800 to-slate-950 text-white",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[11px] font-black",
            isVacantManagerSeat
              ? "border border-dashed border-orange-400 bg-white text-orange-500"
              : "bg-white/10 text-white ring-1 ring-white/20",
          )}
        >
          {isVacantManagerSeat ? <Building2 className="h-4 w-4" /> : initials(group.name)}
        </span>
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              "text-[9px] font-black uppercase tracking-[0.14em]",
              isVacantManagerSeat ? "text-orange-600" : "text-orange-300",
            )}
          >
            {group.title}
          </p>
          <p className="mt-0.5 break-words text-[13px] font-bold leading-snug">
            {isVacantManagerSeat ? "Open Seat" : formatEmployeeDisplayName(group.name)}
          </p>
          {managerScope ? (
            <p
              className={cn(
                "mt-0.5 break-words text-[10px] font-semibold",
                isVacantManagerSeat ? "text-orange-600" : "text-orange-200",
              )}
            >
              {managerScope}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span
            className={cn(
              "rounded-md px-1.5 py-1 text-center text-[10px] font-black leading-none ring-1",
              isVacantManagerSeat
                ? "bg-white text-orange-600 ring-orange-200"
                : "bg-white/10 text-white ring-white/20",
            )}
          >
            {isVacantManagerSeat ? "Vacant" : group.members.length}
          </span>
          {group.members.length > 0 ? (
            <button
              aria-expanded={!laneCollapsed}
              aria-label={laneCollapsed ? "Expand team" : "Collapse team"}
              className={cn(
                "inline-flex items-center rounded-md px-1 py-1 transition",
                isVacantManagerSeat
                  ? "text-orange-500 hover:bg-orange-100"
                  : "text-white/70 hover:bg-white/10 hover:text-white",
              )}
              onClick={() => onToggle(laneKey)}
              type="button"
            >
              {laneCollapsed ? (
                <ChevronRight className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
            </button>
          ) : null}
        </div>
      </div>

      {/* Team summary */}
      <div className="flex items-center justify-between border-y border-slate-100 bg-slate-50/70 px-3 py-1.5 text-[10px]">
        <span className="font-semibold text-slate-500">
          {group.members.length} team {group.members.length === 1 ? "member" : "members"}
        </span>
        {groupVacancies > 0 ? (
          <span className="font-black uppercase tracking-[0.08em] text-orange-600">
            {groupVacancies} vacant
          </span>
        ) : (
          <span className="font-semibold text-emerald-600">Fully staffed</span>
        )}
      </div>

      {/* Team members with drawn connectors + collapse */}
      {!laneCollapsed ? (
        <div className="px-3 py-3">
          {group.members.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-300 px-3 py-4 text-center text-[11px] text-slate-400">
              No team rows under this manager.
            </div>
          ) : (
            <ul aria-label="Team reporting tree" className="space-y-2" role="tree">
              {memberTree.map((node) => (
                <MemberBranch
                  collapsedKeys={collapsedKeys}
                  key={node.key}
                  node={node}
                  onToggle={onToggle}
                />
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Executive spine (CEO → Line → NSM)                                 */
/* ------------------------------------------------------------------ */

function SpineNode({
  icon,
  label,
  name,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  name: string;
  tone: "dark" | "line" | "leader";
}) {
  return (
    <div
      className={cn(
        "relative w-full max-w-md border px-4 py-3 text-center transition-shadow duration-300",
        tone === "dark"
          ? "border-slate-900 bg-gradient-to-br from-slate-800 to-slate-950 text-white shadow-[0_16px_36px_rgba(15,23,42,0.35)]"
          : tone === "leader"
            ? "border-orange-300 bg-gradient-to-r from-orange-50 via-orange-50/70 to-orange-50 shadow-[0_10px_26px_rgba(249,115,22,0.14)]"
            : "border-slate-200 bg-white shadow-sm",
      )}
    >
      <div
        className={cn(
          "mb-1 flex items-center justify-center gap-1.5 text-[10px] font-black uppercase tracking-[0.16em]",
          tone === "dark" ? "text-orange-300" : "text-orange-600",
        )}
      >
        {icon}
        {label}
      </div>
      <p
        className={cn(
          "break-words text-sm font-bold leading-snug",
          tone === "dark" ? "text-white" : "text-slate-900",
        )}
      >
        {name}
      </p>
    </div>
  );
}

function Trunk() {
  return <div aria-hidden className="h-5 w-0.5 bg-orange-300/80" />;
}

/* ------------------------------------------------------------------ */
/*  KPI strip + completion bar                                        */
/* ------------------------------------------------------------------ */

type KpiTone = "emerald" | "sky" | "amber" | "orange" | "slate";

const TONE_ACCENT: Record<KpiTone, string> = {
  amber: "bg-amber-400",
  emerald: "bg-emerald-400",
  orange: "bg-orange-400",
  sky: "bg-sky-400",
  slate: "bg-slate-400",
};

const TONE_ICON: Record<KpiTone, string> = {
  amber: "bg-gradient-to-br from-amber-50 to-amber-100 text-amber-600 ring-amber-200",
  emerald: "bg-gradient-to-br from-emerald-50 to-emerald-100 text-emerald-600 ring-emerald-200",
  orange: "bg-gradient-to-br from-orange-50 to-orange-100 text-orange-600 ring-orange-200",
  sky: "bg-gradient-to-br from-sky-50 to-sky-100 text-sky-600 ring-sky-200",
  slate: "bg-gradient-to-br from-slate-50 to-slate-100 text-slate-600 ring-slate-200",
};

const TONE_GLOW: Record<KpiTone, string> = {
  amber: "bg-amber-300/30",
  emerald: "bg-emerald-300/30",
  orange: "bg-orange-300/30",
  sky: "bg-sky-300/30",
  slate: "bg-slate-300/30",
};

const TONE_FILL: Record<KpiTone, string> = {
  amber: "bg-amber-500",
  emerald: "bg-emerald-500",
  orange: "bg-orange-500",
  sky: "bg-sky-500",
  slate: "bg-slate-500",
};

function KpiCard({
  actual,
  icon,
  label,
  tone,
  total,
  vacant,
}: {
  actual: number;
  icon: React.ReactNode;
  label: string;
  tone: KpiTone;
  total: number;
  vacant: number;
}) {
  const pct = total > 0 ? Math.round((actual / total) * 100) : 0;
  return (
    <div className="group relative overflow-hidden border border-slate-200 bg-white p-4 shadow-[0_2px_12px_rgba(15,23,42,0.05)] transition-all duration-300 ease-out hover:-translate-y-1 hover:border-slate-300 hover:shadow-[0_18px_40px_rgba(15,23,42,0.1)]">
      <span aria-hidden className={cn("absolute inset-x-0 top-0 h-1", TONE_ACCENT[tone])} />
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute -right-6 -top-8 h-24 w-24 rounded-full blur-2xl transition-opacity duration-300 group-hover:opacity-90",
          TONE_GLOW[tone],
        )}
      />
      <div className="relative flex items-start justify-between gap-2">
        <p className="break-words text-[10px] font-black uppercase tracking-[0.12em] text-slate-500">
          {label}
        </p>
        <span
          aria-hidden
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center ring-1 transition-transform duration-300 group-hover:scale-110",
            TONE_ICON[tone],
          )}
        >
          {icon}
        </span>
      </div>
      <div className="relative mt-1.5 flex items-end gap-1.5">
        <span className="text-2xl font-black leading-none text-slate-900">{actual}</span>
        <span className="pb-0.5 text-sm font-bold leading-none text-slate-400">/ {total}</span>
      </div>
      <div className="relative mt-2.5 flex items-center gap-2">
        <div
          aria-label={`${label} completion ${pct}%`}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={pct}
          className="h-1.5 flex-1 overflow-hidden bg-slate-100"
          role="progressbar"
        >
          <div className={cn("h-full transition-all duration-500", TONE_FILL[tone])} style={{ width: `${pct}%` }} />
        </div>
        <span className="text-[10px] font-black text-slate-400">{pct}%</span>
      </div>
      {vacant > 0 ? (
        <p className="relative mt-1.5 text-[10px] font-black uppercase tracking-[0.08em] text-orange-600">
          {vacant} vacant
        </p>
      ) : null}
    </div>
  );
}

function CompletionBar({
  actual,
  total,
  vacant,
  employees,
  scopeLabel,
}: {
  actual: number;
  total: number;
  vacant: number;
  employees: number;
  scopeLabel: string;
}) {
  const filledPct = total > 0 ? Math.round((actual / total) * 100) : 0;
  const vacantPct = 100 - filledPct;

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-[0_2px_12px_rgba(15,23,42,0.05)] sm:p-5">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div className="flex items-center gap-2">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          <div>
            <h3 className="text-sm font-black text-slate-900">Structure Completion</h3>
            <p className="mt-0.5 text-[11px] text-slate-500">
              {employees} employees across {scopeLabel}
            </p>
          </div>
        </div>
        {total > 0 ? (
          <div className="text-right">
            <p className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-500">
              Filled
            </p>
            <p className="text-base font-black text-slate-900">{filledPct}%</p>
          </div>
        ) : null}
      </div>
      {total > 0 ? (
        <>
          <div
            aria-label="Structure completion chart"
            className="flex h-3 w-full overflow-hidden rounded-full bg-slate-100"
            role="img"
          >
            <div
              className="bg-gradient-to-r from-emerald-500 to-emerald-400"
              style={{ width: `${filledPct}%`, minWidth: actual > 0 ? "3px" : "0" }}
            />
            <div
              className="bg-gradient-to-r from-orange-400 to-orange-500"
              style={{ width: `${vacantPct}%`, minWidth: vacant > 0 ? "3px" : "0" }}
            />
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-3 text-[11px]">
            <span className="inline-flex items-center gap-1.5 text-slate-600">
              <span aria-hidden className="inline-block h-2 w-2 rounded-sm bg-emerald-500" />
              <span className="font-medium">Filled {filledPct}%</span>
            </span>
            <span className="inline-flex items-center gap-1.5 text-slate-600">
              <span aria-hidden className="inline-block h-2 w-2 rounded-sm bg-orange-400" />
              <span className="font-medium">Vacant {vacantPct}%</span>
            </span>
            <span className="ml-auto text-[10px] font-black uppercase tracking-[0.1em] text-slate-400">
              Total {total}
            </span>
          </div>
        </>
      ) : (
        <div className="flex h-3 w-full items-center justify-center rounded-full bg-slate-100">
          <span className="text-[10px] text-slate-400">No data</span>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Tier label                                                         */
/* ------------------------------------------------------------------ */

function TierLabel({
  count,
  dotClassName,
  text,
  textClassName,
}: {
  count?: number;
  dotClassName: string;
  text: string;
  textClassName: string;
}) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", dotClassName)} />
      <p className={cn("text-[10px] font-black uppercase tracking-[0.14em]", textClassName)}>
        {text}
      </p>
      {typeof count === "number" ? (
        <span className="text-[10px] font-semibold text-slate-400">
          · {count} {count === 1 ? "lane" : "lanes"}
        </span>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main tree                                                          */
/* ------------------------------------------------------------------ */

export function OrgChartTree({
  rows,
  lineName,
  theme = "admin",
  kpiLabels = DEFAULT_ORG_KPI_LABELS,
}: OrgChartTreeProps) {
  const [collapsedKeys, setCollapsedKeys] = React.useState<Set<string>>(new Set());
  const collapsedKeysRef = React.useRef(collapsedKeys);
  React.useEffect(() => {
    collapsedKeysRef.current = collapsedKeys;
  }, [collapsedKeys]);
  const toggle = React.useCallback((key: string) => {
    setCollapsedKeys((previous) => {
      const next = new Set(previous);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  // Zoom: scales only the chart canvas (spine + lanes), not the KPI summary
  // above it. Ctrl/Cmd+wheel matches the conventional "don't hijack normal
  // page scroll" pattern; panning stays on the existing native overflow-x
  // scroll rather than a custom drag handler, so it can't interfere with the
  // per-node collapse click targets.
  const MIN_ZOOM = 0.5;
  const MAX_ZOOM = 1.75;
  const clampZoom = React.useCallback(
    (value: number) => Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value)) * 100) / 100,
    [],
  );
  const [zoom, setZoom] = React.useState(1);
  const zoomIn = React.useCallback(() => setZoom((z) => clampZoom(z + 0.1)), [clampZoom]);
  const zoomOut = React.useCallback(() => setZoom((z) => clampZoom(z - 0.1)), [clampZoom]);
  const resetZoom = React.useCallback(() => setZoom(1), []);
  const handleCanvasWheel = React.useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      setZoom((z) => clampZoom(z + (event.deltaY < 0 ? 0.1 : -0.1)));
    },
    [clampZoom],
  );

  // Print: unroll every collapsed lane for the duration of printing (a
  // collapsed lane's members aren't in the DOM at all when collapsed, so no
  // print-only CSS override could resurrect them — this has to happen in
  // JS), then restore whatever was collapsed before. Listens for the actual
  // beforeprint/afterprint events rather than only the toolbar button's
  // onClick, so it also covers the browser's native Ctrl+P / File > Print.
  const [isPrinting, setIsPrinting] = React.useState(false);
  const collapsedKeysBeforePrintRef = React.useRef<Set<string> | null>(null);
  React.useEffect(() => {
    const handleBeforePrint = () => {
      collapsedKeysBeforePrintRef.current = collapsedKeysRef.current;
      setCollapsedKeys(new Set());
      setIsPrinting(true);
    };
    const handleAfterPrint = () => {
      if (collapsedKeysBeforePrintRef.current) {
        setCollapsedKeys(collapsedKeysBeforePrintRef.current);
        collapsedKeysBeforePrintRef.current = null;
      }
      setIsPrinting(false);
    };

    window.addEventListener("beforeprint", handleBeforePrint);
    window.addEventListener("afterprint", handleAfterPrint);
    return () => {
      window.removeEventListener("beforeprint", handleBeforePrint);
      window.removeEventListener("afterprint", handleAfterPrint);
    };
  }, []);
  const handlePrint = React.useCallback(() => window.print(), []);

  // PNG export target — deliberately the chart canvas only (spine + lanes),
  // excluding the toolbar/KPI cards above it, which live in sibling elements
  // outside this ref.
  const chartCanvasRef = React.useRef<HTMLDivElement>(null);
  const [isExportingPng, setIsExportingPng] = React.useState(false);

  const structureKpis = React.useMemo(() => calculateOrganogramStructureKpis(rows), [rows]);
  const { chiefExecutive, filledLaneCount, groups, laneLeaderName, lineLeader } = React.useMemo(() => {
    const lanes = buildOrganogramLanes(rows);
    return {
      ...lanes,
      laneLeaderName: lanes.lineLeader
        ? formatEmployeeDisplayName(lanes.lineLeader.displayName)
        : (lineName ?? "Line Leadership"),
    };
  }, [rows, lineName]);

  const employeeCount = rows.filter((row) => row.type === "employee").length;
  const resolvedLineName = lineName ?? "Selected line";

  const directDsms = groups.filter((group) => group.dsm && !group.rsm);
  const rsmGroups = groups.filter((group) => group.rsm);
  const otherGroups = groups.filter((group) => !group.dsm && !group.rsm);
  const hasContent = rows.length > 0;

  const handleExportPng = React.useCallback(async () => {
    if (!chartCanvasRef.current || isExportingPng) return;
    setIsExportingPng(true);
    const previousCollapsedKeys = collapsedKeysRef.current;
    try {
      // Unroll every lane so the exported image shows the full structure,
      // not whatever happens to be collapsed on screen — then wait two
      // animation frames for React to actually commit that DOM before
      // capturing it (a single setState doesn't paint synchronously).
      setCollapsedKeys(new Set());
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });

      const { toPng } = await import("html-to-image");
      const dataUrl = await toPng(chartCanvasRef.current, {
        backgroundColor: "#ffffff",
        pixelRatio: 2,
      });

      const link = document.createElement("a");
      const safeLineName = resolvedLineName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      link.download = `organogram-${safeLineName || "structure"}.png`;
      link.href = dataUrl;
      link.click();
    } catch (error) {
      console.error("Organogram PNG export failed:", error);
    } finally {
      setCollapsedKeys(previousCollapsedKeys);
      setIsExportingPng(false);
    }
  }, [isExportingPng, resolvedLineName]);

  // Every collapsible top-level lane key — mirrors the keys the tiers below use —
  // so "Collapse all" can fold every lane in one click.
  const collapsibleLaneKeys = [
    ...directDsms.map((group, index) => tierLaneKey("t1", group, index)),
    ...rsmGroups.flatMap((group, index) => {
      const laneKey = tierLaneKey("t2", group, index);
      return (group.childLanes ?? []).map((lane, laneIndex) => childLaneKey(laneKey, lane, laneIndex));
    }),
    ...otherGroups.map((group, index) => `other-${group.name}-${index}`),
  ];

  // Flat structure export — the same rows the chart renders (already server-scoped
  // to the viewer), downloaded as a premium Phoenix-styled sheet.
  const exportColumns: ExportColumn[] = [
    { key: "hrId", label: "HR ID", width: 12 },
    { key: "name", label: "Name", width: 26 },
    { key: "title", label: "Title", width: 26 },
    { key: "type", label: "Type", width: 12 },
    { key: "line", label: "Line", width: 18 },
    { key: "area", label: "Area", width: 18 },
    { key: "region", label: "Region", width: 18 },
    { key: "manager", label: "Reports To", width: 24 },
    { key: "managerHrId", label: "Manager HR ID", width: 14 },
  ];
  const exportRows: ExportRow[] = rows.map((row) => ({
    area: row.areaName ?? "",
    hrId: row.hrId,
    line: row.lineName ?? "",
    manager: row.managerName ?? "",
    managerHrId: row.managerHrId ?? "",
    name: row.type === "vacancy" ? "Open Vacancy" : row.displayName ?? row.fullName,
    region: row.regionName ?? "",
    title: row.positionTitle ?? row.jobTitle ?? "",
    type: row.type === "vacancy" ? "Vacancy" : "Employee",
  }));

  const kpiIconClassName = "h-4 w-4";
  const kpiCards: Array<{ actual: number; icon: React.ReactNode; label: string; tone: KpiTone; total: number; vacant: number }> = [
    { actual: structureKpis.medicalRep.actual, icon: <UserRound className={kpiIconClassName} />, label: kpiLabels.medicalRep, tone: "emerald", total: structureKpis.medicalRep.total, vacant: structureKpis.medicalRep.vacant },
    { actual: structureKpis.dsm.actual, icon: <MapPin className={kpiIconClassName} />, label: kpiLabels.dsm, tone: "sky", total: structureKpis.dsm.total, vacant: structureKpis.dsm.vacant },
    { actual: structureKpis.rsm.actual, icon: <Layers className={kpiIconClassName} />, label: kpiLabels.rsm, tone: "amber", total: structureKpis.rsm.total, vacant: structureKpis.rsm.vacant },
    { actual: structureKpis.nsm.actual, icon: <UsersRound className={kpiIconClassName} />, label: kpiLabels.nsm, tone: "orange", total: structureKpis.nsm.total, vacant: structureKpis.nsm.vacant },
    { actual: structureKpis.total.actual, icon: <Network className={kpiIconClassName} />, label: kpiLabels.total, tone: "slate", total: structureKpis.total.total, vacant: structureKpis.total.vacant },
  ];

  return (
    <div className="space-y-5" dir="auto">
      {/* Whole-tree controls + structure export */}
      {hasContent ? (
        <div className="flex flex-wrap items-center justify-end gap-2 print:hidden">
          <div className="inline-flex h-9 items-center gap-0.5 border border-[#D8E0EA] bg-white px-1 text-[#0F172A] shadow-sm">
            <button
              aria-label="Zoom out"
              className="inline-flex h-7 w-7 items-center justify-center text-slate-500 transition hover:text-[#F97316] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F97316]/40 disabled:cursor-not-allowed disabled:opacity-30"
              disabled={zoom <= MIN_ZOOM}
              onClick={zoomOut}
              type="button"
            >
              <Minus className="h-3.5 w-3.5" />
            </button>
            <button
              aria-label="Reset zoom to 100%"
              className="min-w-[3.5rem] px-1 text-center text-xs font-bold tabular-nums text-slate-500 transition hover:text-[#F97316] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F97316]/40"
              onClick={resetZoom}
              type="button"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              aria-label="Zoom in"
              className="inline-flex h-7 w-7 items-center justify-center text-slate-500 transition hover:text-[#F97316] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F97316]/40 disabled:cursor-not-allowed disabled:opacity-30"
              disabled={zoom >= MAX_ZOOM}
              onClick={zoomIn}
              type="button"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          <button
            className="inline-flex h-9 items-center gap-1 border border-[#D8E0EA] bg-white px-3 text-xs font-bold text-[#0F172A] shadow-sm transition hover:border-[#FDBA74] hover:text-[#F97316] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F97316]/40"
            onClick={() => setCollapsedKeys(new Set())}
            type="button"
          >
            Expand all
          </button>
          <button
            className="inline-flex h-9 items-center gap-1 border border-[#D8E0EA] bg-white px-3 text-xs font-bold text-[#0F172A] shadow-sm transition hover:border-[#FDBA74] hover:text-[#F97316] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F97316]/40"
            onClick={() => setCollapsedKeys(new Set(collapsibleLaneKeys))}
            type="button"
          >
            Collapse all
          </button>
          <button
            className="inline-flex h-9 items-center gap-1.5 border border-[#D8E0EA] bg-white px-3 text-xs font-bold text-[#0F172A] shadow-sm transition hover:border-[#FDBA74] hover:text-[#F97316] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F97316]/40"
            onClick={handlePrint}
            type="button"
          >
            <Printer className="h-3.5 w-3.5" />
            Print
          </button>
          <button
            className="inline-flex h-9 items-center gap-1.5 border border-[#D8E0EA] bg-white px-3 text-xs font-bold text-[#0F172A] shadow-sm transition hover:border-[#FDBA74] hover:text-[#F97316] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F97316]/40 disabled:opacity-50"
            disabled={isExportingPng}
            onClick={handleExportPng}
            type="button"
          >
            {isExportingPng ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ImageDown className="h-3.5 w-3.5" />
            )}
            PNG
          </button>
          <ExportXlsxButton
            columns={exportColumns}
            rows={exportRows}
            sheetName="Organogram"
            subtitle={`${resolvedLineName} · ${employeeCount} employees`}
            title={`Organogram — ${resolvedLineName}`}
          />
        </div>
      ) : null}

      {/* KPI strip */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {kpiCards.map((card) => (
          <KpiCard
            actual={card.actual}
            icon={card.icon}
            key={card.label}
            label={card.label}
            tone={card.tone}
            total={card.total}
            vacant={card.vacant}
          />
        ))}
      </div>

      <CompletionBar
        actual={structureKpis.total.actual}
        employees={employeeCount}
        scopeLabel={resolvedLineName}
        total={structureKpis.total.total}
        vacant={structureKpis.total.vacant}
      />

      {/* Chart canvas */}
      <div
        className={cn(
          "overflow-hidden rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-6 sm:px-5 print:overflow-visible print:rounded-none print:border-none print:bg-white print:p-0 print:shadow-none",
          theme === "admin" ? "shadow-[0_2px_16px_rgba(15,23,42,0.06)] print:shadow-none" : "",
        )}
        onWheel={handleCanvasWheel}
        ref={chartCanvasRef}
        style={
          isPrinting
            ? undefined
            : {
                backgroundImage:
                  "linear-gradient(rgba(226,232,240,0.6) 1px, transparent 1px), linear-gradient(90deg, rgba(226,232,240,0.6) 1px, transparent 1px)",
                backgroundSize: "48px 48px",
              }
        }
      >
        {/* Zoom scales everything below; print always renders at 100% so the
            full structure fits the page regardless of the on-screen zoom. */}
        <div className="print:!scale-100" style={{ transform: `scale(${zoom})`, transformOrigin: "top center" }}>
        {/* Executive spine */}
        <div className="flex flex-col items-center">
          <SpineNode
            icon={<Crown className="h-3.5 w-3.5" />}
            label={
              chiefExecutive
                ? chiefExecutive.positionTitle ?? chiefExecutive.jobTitle ?? "CEO"
                : "CEO"
            }
            name={
              chiefExecutive
                ? formatEmployeeDisplayName(chiefExecutive.displayName)
                : "Executive Leadership"
            }
            tone="dark"
          />
          <Trunk />
          <SpineNode
            icon={<Network className="h-3.5 w-3.5" />}
            label="Line"
            name={resolvedLineName}
            tone="line"
          />
          <Trunk />
          <SpineNode
            icon={<UsersRound className="h-3.5 w-3.5" />}
            label={
              lineLeader
                ? lineLeader.positionTitle ?? lineLeader.jobTitle ?? "National Sales Manager"
                : "National Sales Manager"
            }
            name={laneLeaderName}
            tone="leader"
          />
          <Trunk />
          <div aria-hidden className="relative h-0.5 w-[92%] max-w-5xl bg-orange-300/70">
            <span className="absolute left-1/2 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-orange-500" />
          </div>
        </div>

        {groups.length === 0 ? (
          <div className="mx-auto mt-8 max-w-md rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
            No manager lanes found for this line.
          </div>
        ) : (
          <div className="mt-6 space-y-8 pb-2">
            {/* Tier 1 — DSMs reporting directly to the NSM */}
            {directDsms.length > 0 ? (
              <div>
                <TierLabel
                  count={directDsms.length}
                  dotClassName="bg-slate-400"
                  text="Reports to NSM"
                  textClassName="text-slate-500"
                />
                <div
                  className="grid gap-3"
                  style={{ gridTemplateColumns: `repeat(${laneGridColumnCount(directDsms.length)}, minmax(240px, 1fr))` }}
                >
                  {directDsms.map((group, index) => {
                    const laneKey = tierLaneKey("t1", group, index);
                    return (
                      <div className="flex flex-col" key={laneKey}>
                        <div aria-hidden className="mx-auto h-3 w-0.5 bg-orange-300/70" />
                        <ManagerLane
                          collapsedKeys={collapsedKeys}
                          group={group}
                          laneKey={laneKey}
                          onToggle={toggle}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {/* Tier 2 — each RSM banner + its child DSM lanes */}
            {rsmGroups.map((group, index) => {
              const childLanes = group.childLanes ?? [];
              const laneKey = tierLaneKey("t2", group, index);
              const groupVacancies = childLanes.reduce(
                (total, lane) =>
                  total +
                  lane.members.filter((member) => member.type === "vacancy").length +
                  (lane.dsm?.type === "vacancy" ? 1 : 0),
                0,
              );
              return (
                <div key={laneKey}>
                  <TierLabel
                    dotClassName="bg-orange-500"
                    text={`Reports to NSM · ${laneLeaderName}`}
                    textClassName="text-orange-700"
                  />
                  <div className="overflow-hidden rounded-xl border border-orange-200 bg-white shadow-[0_2px_12px_rgba(15,23,42,0.06)]">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-orange-200 bg-gradient-to-r from-orange-100/60 via-orange-50 to-orange-100/60 px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <span
                          aria-hidden
                          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-orange-500 text-[11px] font-black text-white"
                        >
                          {initials(group.name)}
                        </span>
                        <div className="min-w-0">
                          <p className="text-[9px] font-black uppercase tracking-[0.14em] text-orange-700">
                            {group.title}
                          </p>
                          <p className="mt-0.5 break-words text-[13px] font-bold text-slate-900">
                            {formatEmployeeDisplayName(group.name)}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 text-[10px]">
                        <span className="inline-flex items-center gap-1 rounded-md bg-white px-1.5 py-1 font-bold text-slate-600 ring-1 ring-orange-200">
                          <Layers className="h-3 w-3 text-orange-500" />
                          {childLanes.length} DSM lanes
                        </span>
                        {groupVacancies > 0 ? (
                          <span className="rounded-md bg-orange-200/70 px-1.5 py-1 font-black text-orange-700">
                            {groupVacancies} vacant
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <div
                      className="grid gap-3 bg-orange-50/30 p-3"
                      style={{ gridTemplateColumns: `repeat(${laneGridColumnCount(childLanes.length)}, minmax(240px, 1fr))` }}
                    >
                      {childLanes.length > 0 ? (
                        childLanes.map((lane, laneIndex) => {
                          const childKey = childLaneKey(laneKey, lane, laneIndex);
                          return (
                            <div className="flex flex-col" key={childKey}>
                              <div aria-hidden className="mx-auto h-3 w-0.5 bg-orange-300/70" />
                              <ManagerLane
                                collapsedKeys={collapsedKeys}
                                group={lane}
                                laneKey={childKey}
                                onToggle={toggle}
                              />
                            </div>
                          );
                        })
                      ) : (
                        <div className="rounded-lg border border-dashed border-slate-300 p-4 text-center text-[11px] text-slate-400">
                          No DSM lanes under this regional manager.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}

            {/* Marketing / fallback groups */}
            {otherGroups.length > 0 ? (
              <div>
                <TierLabel
                  count={otherGroups.length}
                  dotClassName="bg-slate-400"
                  text="Other reporting groups"
                  textClassName="text-slate-500"
                />
                <div
                  className="grid gap-3"
                  style={{ gridTemplateColumns: `repeat(${laneGridColumnCount(otherGroups.length)}, minmax(240px, 1fr))` }}
                >
                  {otherGroups.map((group, index) => {
                    const laneKey = `other-${group.name}-${index}`;
                    return (
                      <div className="flex flex-col" key={laneKey}>
                        <div aria-hidden className="mx-auto h-3 w-0.5 bg-orange-300/70" />
                        <ManagerLane
                          collapsedKeys={collapsedKeys}
                          group={group}
                          laneKey={laneKey}
                          onToggle={toggle}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <p className="pt-1 text-[10px] font-semibold text-slate-400">
              {filledLaneCount} staffed {filledLaneCount === 1 ? "lane" : "lanes"} shown
            </p>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
