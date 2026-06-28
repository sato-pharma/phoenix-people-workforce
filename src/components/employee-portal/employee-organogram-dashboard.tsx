"use client";

import { useCallback, useMemo, useState } from "react";

import { Card } from "@/components/ui/card";
import { WorkspaceErrorBoundary } from "@/components/ui/workspace-error-boundary";
import { formatDateOnly } from "@/lib/date-only";
import { calculateOrganogramStructureKpis } from "@/lib/reports/organogram-safety";
import {
  type ManagerLane,
  type MemberNode,
  type OrganogramRow,
  buildMemberTree,
  buildOrganogramLanes,
  emptyText,
  filterOrganogramRows,
  isMedicalRep,
  isOrganogramVisibleRow,
  normalizeSearchValue,
  rowKey,
  titleText,
} from "@/lib/reports/organogram-view-model";
import type { VacancyReportData } from "@/lib/reports/vacancies";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

type EmployeeOrganogramDashboardProps = {
  fixedLine?: string | null;
  initialError?: string | null;
  initialReport?: VacancyReportData | null;
  showLinePicker?: boolean;
};

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

const inputClassName =
  "w-full rounded-md border border-gray-200 bg-white px-3 py-2.5 text-sm text-slate-700 outline-none transition focus:border-orange-300 focus:shadow-[0_0_0_3px_rgba(249,115,22,0.08)]";

const labelClassName =
  "text-[11px] font-semibold uppercase tracking-wider text-slate-400";

const cardShadow = "shadow-[0_1px_3px_rgba(15,23,42,0.08)]";

/* ------------------------------------------------------------------ */
/*  Business Logic Helpers                                            */
/* ------------------------------------------------------------------ */

function formatDate(value: string | null | undefined) {
  return formatDateOnly(value, "en", { day: "2-digit", month: "short", year: "numeric" });
}

/* ------------------------------------------------------------------ */
/*  UI Sub-Components                                                 */
/* ------------------------------------------------------------------ */

function TeamMemberCardUI({ row }: { row: OrganogramRow }) {
  const isVacancy = row.type === "vacancy";
  const showRepFields = isVacancy || isMedicalRep(row);

  return (
    <div
      className={`relative border-l-[3px] px-3 py-2.5 transition ${
        isVacancy
          ? "border-l-orange-400 bg-orange-50/40 hover:bg-orange-50/70"
          : "border-l-slate-200 bg-white hover:bg-slate-50/60"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="break-words text-[12px] font-semibold leading-snug text-slate-800">
            {row.fullName}
          </p>
          <p className="mt-0.5 font-mono text-[10px] tracking-wider text-slate-400">
            {row.hrId}
          </p>
        </div>
        {isVacancy && (
          <span className="shrink-0 rounded-md bg-orange-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-orange-700">
            Vacant
          </span>
        )}
      </div>
      {showRepFields && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-slate-500">
          {row.hireDate && (
            <span className="inline-flex items-center gap-1 rounded-sm bg-slate-100/80 px-1.5 py-0.5">
              <span aria-hidden className="h-1 w-1 rounded-sm bg-slate-400" />
              {formatDate(row.hireDate)}
            </span>
          )}
          {row.areaName && (
            <span className="inline-flex items-center gap-1 rounded-sm bg-slate-100/80 px-1.5 py-0.5">
              <span aria-hidden className="h-1 w-1 rounded-sm bg-orange-400" />
              <span>{emptyText(row.areaName)}</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function TeamMemberNodeUI({ node }: { node: MemberNode }) {
  return (
    <div>
      <TeamMemberCardUI row={node.row} />
      {node.children.length > 0 && (
        <div className="ml-3 divide-y divide-gray-100 border-l border-orange-200 pl-1.5">
          {node.children.map((child) => (
            <TeamMemberNodeUI key={child.key} node={child} />
          ))}
        </div>
      )}
    </div>
  );
}

function ManagerLaneUI({
  group,
  groupKey,
}: {
  group: ManagerLane;
  groupKey: string;
}) {
  const isVacantSeat = group.dsm?.type === "vacancy";
  const groupVacancies =
    group.members.filter((m) => m.type === "vacancy").length + (isVacantSeat ? 1 : 0);
  const scope = isVacantSeat
    ? [group.dsm?.lineName, group.dsm?.areaName ?? group.dsm?.regionName].filter(Boolean).join(" / ")
    : null;

  return (
    <div
      className={`overflow-hidden rounded-lg border border-gray-100 bg-white ${cardShadow}`}
      key={groupKey}
    >
      {/* Manager header — vacant DSM gets warm-orange tint, filled gets dark slate */}
      <div
        className={`border-b border-gray-100 px-3 py-2.5 ${
          isVacantSeat
            ? "bg-gradient-to-r from-orange-50 to-orange-50/40 text-slate-800"
            : "bg-gradient-to-r from-slate-800 to-slate-700 text-white"
        }`}
      >
        <div className="flex items-start gap-2">
          <span
            aria-hidden
            className={`mt-0.5 h-1.5 w-1.5 shrink-0 rounded-sm ${
              isVacantSeat ? "bg-orange-500" : "bg-orange-400"
            }`}
          />
          <div className="min-w-0 flex-1">
            <p
              className={`text-[10px] font-bold uppercase tracking-wider ${
                isVacantSeat ? "text-orange-700" : "text-slate-300"
              }`}
            >
              {group.title}
            </p>
            <p className="mt-0.5 break-words text-[13px] font-bold leading-snug">
              {group.name}
            </p>
            {scope && (
              <p
                className={`mt-0.5 break-words text-[10px] font-semibold ${
                  isVacantSeat ? "text-orange-600" : "text-orange-300"
                }`}
              >
                {scope}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Team summary */}
      <div className="flex items-center justify-between border-b border-gray-100 bg-slate-50/60 px-3 py-1.5 text-[10px]">
        <span className="font-semibold text-slate-500">
          {group.members.length} team members
        </span>
        {groupVacancies > 0 ? (
          <span className="font-bold text-orange-600">{groupVacancies} vacant</span>
        ) : (
          <span className="font-semibold text-emerald-600">Fully staffed</span>
        )}
      </div>

      {/* Team members — visible dividers between cards */}
      <div className="divide-y divide-gray-100 bg-white">
        {group.members.length === 0 ? (
          <div className="px-3 py-4 text-center text-[11px] text-slate-400">
            No team members assigned.
          </div>
        ) : (
          buildMemberTree(group.members).map((node) => (
            <TeamMemberNodeUI key={node.key} node={node} />
          ))
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Component                                                    */
/* ------------------------------------------------------------------ */

export function EmployeeOrganogramDashboard({
  fixedLine = null,
  initialError = null,
  initialReport = null,
  showLinePicker = false,
}: EmployeeOrganogramDashboardProps) {
  const [report, setReport] = useState<VacancyReportData | null>(initialReport);
  const [error, setError] = useState<string | null>(initialError);
  const [isLoading, setIsLoading] = useState(false);
  const [organogramSearch, setOrganogramSearch] = useState("");
  const [selectedMmLine, setSelectedMmLine] = useState<string | null>(null);
  const effectiveLineFilter = showLinePicker ? (selectedMmLine ?? "") : (fixedLine ?? "");
  const normalizedSearch = normalizeSearchValue(organogramSearch);

  const loadReport = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/reports/organogram", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.message ?? payload.error ?? "organogram_failed");
        return;
      }
      setReport(payload);
    } catch {
      setError("Unable to load organogram.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  const rows = useMemo(
    () => (report?.organogramRows ?? []).filter((r) => isOrganogramVisibleRow(r)),
    [report],
  );

  const availableLines = useMemo(() => {
    if (!showLinePicker) return [] as string[];
    const seen = new Set<string>();
    for (const r of rows) {
      if (r.lineName?.trim()) seen.add(r.lineName.trim());
    }
    return Array.from(seen).sort();
  }, [showLinePicker, rows]);

  const mmReady = !showLinePicker || selectedMmLine !== null;

  const filteredRows = useMemo(
    () => filterOrganogramRows(rows, effectiveLineFilter, normalizedSearch),
    [effectiveLineFilter, normalizedSearch, rows],
  );

  const employees = useMemo(
    () => filteredRows.filter((r) => r.type === "employee"),
    [filteredRows],
  );

  const structureKpis = useMemo(
    () => calculateOrganogramStructureKpis(filteredRows),
    [filteredRows],
  );

  // Build a list of vacant area names for each structure role
  // so we can display "Vacant: <area>, <area>" under each KPI card.
  type VacancyEntry = {
    area: string;
    code: string;
    line: string;
    manager: string;
    role: "DSM" | "RSM" | "NSM" | "Medical Representative";
  };
  const vacantList = useMemo<VacancyEntry[]>(() => {
    const list: VacancyEntry[] = [];
    for (const row of filteredRows) {
      if (row.type !== "vacancy") continue;
      const t = titleText(row);
      const area =
        row.areaName?.trim() || row.regionName?.trim() || row.teamName?.trim() || "—";
      let role: VacancyEntry["role"] | null = null;
      if (t.includes("medical representative") || t.includes("medical rep")) {
        role = "Medical Representative";
      } else if (
        t.includes("district sales manager") ||
        t.includes("district manager") ||
        t === "dsm"
      ) {
        role = "DSM";
      } else if (t.includes("regional sales manager") || t === "rsm") {
        role = "RSM";
      } else if (t.includes("national sales manager") || t === "nsm") {
        role = "NSM";
      }
      if (!role) continue;
      list.push({
        area,
        code: row.vacancyCode ?? row.hrId ?? "—",
        line: row.lineName ?? "—",
        manager: row.managerName?.trim() || "Unassigned",
        role,
      });
    }
    // Sort: DSM/RSM/NSM first (manager roles), then Medical Rep
    const rolePriority: Record<VacancyEntry["role"], number> = {
      NSM: 0,
      RSM: 1,
      DSM: 2,
      "Medical Representative": 3,
    };
    list.sort((a, b) => {
      const r = rolePriority[a.role] - rolePriority[b.role];
      if (r !== 0) return r;
      return a.area.localeCompare(b.area);
    });
    return list;
  }, [filteredRows]);

  const vacantCountByRole = useMemo(() => {
    const counts = { dsm: 0, medicalRep: 0, nsm: 0, rsm: 0 };
    for (const entry of vacantList) {
      if (entry.role === "DSM") counts.dsm++;
      else if (entry.role === "RSM") counts.rsm++;
      else if (entry.role === "NSM") counts.nsm++;
      else counts.medicalRep++;
    }
    return counts;
  }, [vacantList]);

  const lanes = useMemo(
    () => (effectiveLineFilter || normalizedSearch ? buildOrganogramLanes(filteredRows) : null),
    [effectiveLineFilter, filteredRows, normalizedSearch],
  );

  const completionPercent =
    structureKpis.total.total > 0
      ? Math.round((structureKpis.total.actual / structureKpis.total.total) * 100)
      : 0;

  /* KPI card data */
  const kpiCards = [
    {
      accent: "border-l-emerald-400",
      actual: structureKpis.medicalRep.actual,
      label: "Medical Reps",
      total: structureKpis.medicalRep.total,
      vacant: structureKpis.medicalRep.vacant,
    },
    {
      accent: "border-l-sky-400",
      actual: structureKpis.dsm.actual,
      label: "District Managers",
      total: structureKpis.dsm.total,
      vacant: structureKpis.dsm.vacant,
    },
    {
      accent: "border-l-amber-400",
      actual: structureKpis.rsm.actual,
      label: "Regional Managers",
      total: structureKpis.rsm.total,
      vacant: structureKpis.rsm.vacant,
    },
    {
      accent: "border-l-orange-400",
      actual: structureKpis.nsm.actual,
      label: "National Managers",
      total: structureKpis.nsm.total,
      vacant: structureKpis.nsm.vacant,
    },
    {
      accent: "border-l-slate-400",
      actual: structureKpis.total.actual,
      label: "Total Structure",
      total: structureKpis.total.total,
      vacant: structureKpis.total.vacant,
    },
  ];

  const lineName = effectiveLineFilter || "Select Line";

  return (
    <div className="space-y-5" dir="auto">
      {/* ---- MM Line Picker ---- */}
      {showLinePicker && report && (
        <Card className={`rounded-lg border border-gray-100 p-4 sm:p-5 ${cardShadow}`}>
          <label className="block">
            <span className={`mb-1.5 block ${labelClassName}`}>Product Line</span>
            <select
              className={inputClassName}
              onChange={(e) => setSelectedMmLine(e.target.value || null)}
              value={selectedMmLine ?? ""}
            >
              <option value="">— Select a product line —</option>
              {availableLines.map((line) => (
                <option key={line} value={line}>{line}</option>
              ))}
            </select>
          </label>
        </Card>
      )}

      {/* ---- MM Prompt (no line selected yet) ---- */}
      {showLinePicker && !selectedMmLine && report && (
        <Card className={`rounded-lg border border-gray-100 p-8 text-center ${cardShadow}`}>
          <h3 className="text-sm font-semibold text-slate-700">
            Select a product line to view its organogram
          </h3>
          <p className="mx-auto mt-2 max-w-md text-[11px] text-slate-400">
            Choose a line from the dropdown above. KPIs, vacancies, and the full hierarchy tree will appear for the selected line.
          </p>
        </Card>
      )}

      {/* ---- Data sections — gated for MM until a line is chosen ---- */}
      {mmReady && <>
      {/* ---- Stat Cards ---- */}
      <Card className={`overflow-hidden rounded-lg border border-gray-100 p-0 ${cardShadow}`}>
        <div className="grid grid-cols-2 divide-x divide-y divide-gray-100 sm:grid-cols-3 xl:grid-cols-5">
          {kpiCards.map((kpi) => {
            const pct = kpi.total > 0 ? Math.round((kpi.actual / kpi.total) * 100) : 0;
            return (
              <div className={`border-l-2 ${kpi.accent} px-4 py-4`} key={kpi.label}>
                <p className={labelClassName}>{kpi.label}</p>
                <div className="mt-1 flex items-end gap-1.5">
                  <span className="text-2xl font-bold text-slate-800">{kpi.actual}</span>
                  <span className="pb-0.5 text-sm text-slate-400">/ {kpi.total}</span>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <div
                    aria-label={`${kpi.label} completion ${pct}%`}
                    aria-valuemax={100}
                    aria-valuemin={0}
                    aria-valuenow={pct}
                    className="h-1 flex-1 overflow-hidden rounded bg-slate-100"
                    role="progressbar"
                  >
                    <div
                      className="h-full rounded bg-orange-500"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-[10px] font-semibold text-slate-400">{pct}%</span>
                </div>
                {kpi.vacant > 0 && (
                  <p className="mt-1 text-[10px] font-semibold text-orange-600">
                    {kpi.vacant} vacant
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      {/* ---- Vacant Positions Block (one row per role) ---- */}
      {vacantList.length > 0 && (
        <Card
          className={`overflow-hidden rounded-lg border border-gray-100 p-0 ${cardShadow}`}
        >
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2.5 sm:px-5">
            <div className="flex items-center gap-2">
              <span aria-hidden className="h-1.5 w-1.5 rounded-sm bg-orange-500" />
              <h3 className="text-sm font-bold text-slate-800">Vacant Positions</h3>
            </div>
            <span className="rounded-md bg-orange-50 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-orange-600">
              {vacantList.length} total
            </span>
          </div>
          <div className="divide-y divide-gray-100">
            {(
              [
                {
                  accent: "border-l-orange-400",
                  count: vacantCountByRole.nsm,
                  items: vacantList.filter((v) => v.role === "NSM").map((v) => v.area),
                  label: "NSM",
                  tone: "bg-orange-50 text-orange-700",
                },
                {
                  accent: "border-l-amber-400",
                  count: vacantCountByRole.rsm,
                  items: vacantList.filter((v) => v.role === "RSM").map((v) => v.area),
                  label: "RSM",
                  tone: "bg-amber-50 text-amber-700",
                },
                {
                  accent: "border-l-sky-400",
                  count: vacantCountByRole.dsm,
                  items: vacantList.filter((v) => v.role === "DSM").map((v) => v.area),
                  label: "DSM",
                  tone: "bg-sky-50 text-sky-700",
                },
                {
                  accent: "border-l-emerald-400",
                  count: vacantCountByRole.medicalRep,
                  items: vacantList
                    .filter((v) => v.role === "Medical Representative")
                    .map((v) => v.area),
                  label: "Medical Reps",
                  tone: "bg-emerald-50 text-emerald-700",
                },
              ] as const
            )
              .filter((row) => row.count > 0)
              .map((row) => (
                <div
                  className={`flex flex-wrap items-baseline gap-2 border-l-2 px-4 py-2.5 sm:px-5 ${row.accent}`}
                  key={row.label}
                >
                  <span
                    className={`inline-flex shrink-0 rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${row.tone}`}
                  >
                    {row.label} · {row.count}
                  </span>
                  <span className="text-[13px] text-slate-700">
                    {row.items.join(" - ")}
                  </span>
                </div>
              ))}
          </div>
        </Card>
      )}

      {/* ---- Structure Completion Bar ---- */}
      <WorkspaceErrorBoundary fallbackTitle="Structure overview unavailable">
        <Card className={`rounded-lg border border-gray-100 p-4 sm:p-5 ${cardShadow}`}>
          <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
            <div className="flex items-center gap-2">
              <span aria-hidden className="h-1.5 w-1.5 rounded-sm bg-emerald-500" />
              <div>
                <h3 className="text-sm font-bold text-slate-800">Structure Completion</h3>
                <p className="mt-0.5 text-[11px] text-slate-500">
                  {employees.length} employees across {effectiveLineFilter || "all lines"}
                </p>
              </div>
            </div>
            {structureKpis.total.total > 0 && (
              <div className="text-right">
                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  Filled
                </p>
                <p className="text-base font-bold text-slate-800">
                  {completionPercent}%
                </p>
              </div>
            )}
          </div>
          {structureKpis.total.total > 0 ? (
            <>
              <div
                aria-label="Structure completion chart"
                className="flex h-3 w-full overflow-hidden rounded-sm bg-slate-100"
                role="img"
              >
                <div
                  aria-label={`Filled positions: ${completionPercent}%`}
                  className="bg-gradient-to-r from-emerald-500 to-emerald-400"
                  role="img"
                  style={{
                    width: `${completionPercent}%`,
                    minWidth: structureKpis.total.actual > 0 ? "2px" : "0",
                  }}
                />
                <div
                  aria-label={`Vacant positions: ${100 - completionPercent}%`}
                  className="bg-gradient-to-r from-orange-400 to-orange-500"
                  role="img"
                  style={{
                    width: `${100 - completionPercent}%`,
                    minWidth: structureKpis.total.vacant > 0 ? "2px" : "0",
                  }}
                />
              </div>
              <div className="mt-2.5 flex flex-wrap items-center gap-3 text-[11px]">
                <span className="inline-flex items-center gap-1.5 text-slate-600">
                  <span
                    aria-hidden
                    className="inline-block h-2 w-2 rounded-sm bg-emerald-500"
                  />
                  <span className="font-medium">
                    Filled <strong className="font-bold">{structureKpis.total.actual}</strong>
                  </span>
                </span>
                <span className="inline-flex items-center gap-1.5 text-slate-600">
                  <span
                    aria-hidden
                    className="inline-block h-2 w-2 rounded-sm bg-orange-400"
                  />
                  <span className="font-medium">
                    Vacant{" "}
                    <strong className="font-bold">{structureKpis.total.vacant}</strong>
                  </span>
                </span>
                <span className="ml-auto text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  Total {structureKpis.total.total}
                </span>
              </div>
            </>
          ) : (
            <div className="flex h-3 w-full items-center justify-center rounded-sm bg-slate-100">
              <span className="text-[10px] text-slate-400">No data</span>
            </div>
          )}
        </Card>
      </WorkspaceErrorBoundary>

      {/* ---- Error Message ---- */}
      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm">
          <p className="font-semibold text-rose-800">Organogram unavailable</p>
          <p className="mt-0.5 text-rose-700">{error}</p>
        </div>
      )}

      {/* ---- Loading ---- */}
      {isLoading && !report && (
        <Card className={`rounded-lg border border-gray-100 p-6 ${cardShadow}`}>
          <div className="flex items-center gap-3 text-sm text-slate-500">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-orange-500 border-t-transparent" />
            Loading organogram...
          </div>
        </Card>
      )}

      {/* ---- Search & Info ---- */}
      {report && (
        <Card className={`rounded-lg border border-gray-100 p-4 sm:p-5 ${cardShadow}`}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center rounded-md bg-orange-50 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-orange-600">
                Filters
              </span>
              <span className="text-[11px] font-medium text-slate-500">
                {filteredRows.length} of {rows.length} positions shown
              </span>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <label className="block">
              <span className={`mb-1.5 block ${labelClassName}`}>Search</span>
              <input
                className={inputClassName}
                onChange={(e) => setOrganogramSearch(e.target.value)}
                placeholder="Search name, HR ID, manager..."
                type="text"
                value={organogramSearch}
              />
            </label>
            <div className="flex items-end gap-2">
              {organogramSearch && (
                <button
                  aria-label="Clear search"
                  className="inline-flex h-10 items-center rounded-md border border-gray-200 bg-white px-3 text-[12px] font-semibold text-slate-600 shadow-sm transition hover:border-orange-200 hover:text-orange-600"
                  onClick={() => setOrganogramSearch("")}
                  type="button"
                >
                  Reset
                </button>
              )}
              <button
                aria-label="Refresh organogram data"
                className="inline-flex h-10 items-center rounded-md bg-orange-500 px-4 text-[12px] font-semibold text-white shadow-sm transition hover:bg-orange-600 disabled:opacity-50"
                disabled={isLoading}
                onClick={() => void loadReport()}
                type="button"
              >
                {isLoading ? "Loading..." : "Refresh"}
              </button>
            </div>
          </div>
        </Card>
      )}

      {/* ---- Organogram Tree ---- */}
      {report && lanes && (
        <WorkspaceErrorBoundary fallbackTitle="Organogram tree unavailable">
          <Card className={`overflow-hidden rounded-lg border border-gray-100 p-0 ${cardShadow}`}>
            {/* Section header */}
            <div className="border-b border-gray-100 px-4 py-3 sm:px-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="h-1.5 w-1.5 rounded-sm bg-orange-500"
                  />
                  <div>
                    <h3 className="text-sm font-bold text-slate-800">
                      {lineName} Structure
                    </h3>
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      Leadership, manager lanes, employees, and vacancies
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <span className="rounded-md bg-slate-100 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-600">
                    {employees.length} employees
                  </span>
                  {structureKpis.total.vacant > 0 && (
                    <span className="rounded-md bg-orange-50 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-orange-600">
                      {structureKpis.total.vacant} vacancies
                    </span>
                  )}
                  <span className="rounded-md bg-slate-100 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-600">
                    {lanes.groups.length} lanes
                  </span>
                </div>
              </div>
            </div>

            {/* Hierarchy & Lanes */}
            <div className="bg-slate-50/70 px-3 py-5 sm:px-5">
              {/* Executive Hierarchy — wide NSM banner (line leader) */}
              <div className="relative mb-6 flex flex-col items-center">
                {/* NSM / Line Leader — wide banner to convey root authority */}
                <div className="w-full max-w-3xl rounded-lg border border-orange-300 bg-gradient-to-r from-orange-50 via-orange-50/80 to-orange-50 px-4 py-3 shadow-[0_1px_3px_rgba(249,115,22,0.12)] sm:px-6 sm:py-3.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <span
                        aria-hidden
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-orange-500 text-[13px] font-bold text-white shadow-sm sm:h-10 sm:w-10 sm:text-sm"
                      >
                        {lanes.lineLeader?.fullName
                          ? lanes.lineLeader.fullName
                              .trim()
                              .split(/\s+/)
                              .slice(0, 2)
                              .map((n) => n[0])
                              .join("")
                              .toUpperCase()
                          : "NS"}
                      </span>
                      <div className="min-w-0">
                        <p className="text-[10px] font-bold uppercase tracking-wider text-orange-600">
                          {lanes.lineLeader
                            ? lanes.lineLeader.positionTitle ??
                              lanes.lineLeader.jobTitle ??
                              "National Sales Manager"
                            : "National Sales Manager"}
                        </p>
                        <p className="mt-0.5 break-words text-sm font-bold text-slate-900 sm:text-base">
                          {lanes.lineLeader ? lanes.lineLeader.fullName : lineName}
                        </p>
                      </div>
                    </div>
                    <div className="hidden text-right text-[10px] sm:block">
                      <p className="font-semibold uppercase tracking-wider text-slate-500">
                        Line
                      </p>
                      <p className="mt-0.5 font-bold text-slate-700">{lineName}</p>
                    </div>
                  </div>
                </div>
                <div aria-hidden className="h-5 w-px bg-slate-300" />

                {/* Horizontal connector */}
                <div
                  aria-hidden
                  className="relative hidden h-px w-[85%] bg-slate-300 sm:block"
                >
                  <span className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-sm bg-orange-500" />
                </div>
              </div>

              {/* Manager Lanes */}
              {lanes.groups.length === 0 ? (
                <div className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-400">
                  No manager lanes found for this structure.
                </div>
              ) : (
                <div className="relative overflow-x-auto pb-2">
                  {/* Desktop Grid — split into TIERS: NSM-direct DSMs first, then each RSM with its DSMs below */}
                  <div className="hidden space-y-6 sm:block">
                    {(() => {
                      const directDsms = lanes.groups.filter((g) => g.dsm && !g.rsm);
                      const rsmGroups = lanes.groups.filter((g) => g.rsm);
                      const otherGroups = lanes.groups.filter(
                        (g) => !g.dsm && !g.rsm,
                      );
                      return (
                        <>
                          {/* TIER 1 — DSMs reporting directly to NSM */}
                          {directDsms.length > 0 && (
                            <div>
                              <div className="mb-2 flex items-center gap-2">
                                <span
                                  aria-hidden
                                  className="h-1.5 w-1.5 rounded-sm bg-slate-400"
                                />
                                <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
                                  Reports to NSM
                                </p>
                                <span className="text-[10px] text-slate-400">
                                  · {directDsms.length}{" "}
                                  {directDsms.length === 1 ? "lane" : "lanes"}
                                </span>
                              </div>
                              <div
                                className="grid min-w-max gap-3"
                                style={{
                                  gridTemplateColumns: `repeat(${directDsms.length}, minmax(220px, 1fr))`,
                                }}
                              >
                                {directDsms.map((group, gi) => {
                                  const gKey = group.dsm
                                    ? `t1-mgr-${rowKey(group.dsm)}-${gi}`
                                    : `t1-mgr-${group.name}-${gi}`;
                                  return (
                                    <ManagerLaneUI
                                      group={group}
                                      groupKey={gKey}
                                      key={gKey}
                                    />
                                  );
                                })}
                              </div>
                            </div>
                          )}

                          {/* TIER 2 — Each RSM banner + its child DSMs */}
                          {rsmGroups.map((group, gi) => {
                            const childCount = Math.max(
                              group.childLanes?.length ?? 1,
                              1,
                            );
                            const gKey = group.rsm
                              ? `t2-rsm-${rowKey(group.rsm)}-${gi}`
                              : `t2-mgr-${group.name}-${gi}`;
                            const groupVacancies = (group.childLanes ?? []).reduce(
                              (t, l) =>
                                t +
                                l.members.filter((m) => m.type === "vacancy").length +
                                (l.dsm?.type === "vacancy" ? 1 : 0),
                              0,
                            );
                            return (
                              <div className="relative" key={gKey}>
                                {/* Connector line proving RSM reports to NSM */}
                                <div className="mb-2 flex items-center gap-2 text-[10px]">
                                  <span
                                    aria-hidden
                                    className="h-1.5 w-1.5 rounded-sm bg-orange-500"
                                  />
                                  <p className="break-words font-bold uppercase tracking-wider text-orange-700">
                                    Reports to NSM ·{" "}
                                    {lanes.lineLeader ? lanes.lineLeader.fullName : lineName}
                                  </p>
                                </div>
                                <div
                                  className={`overflow-hidden rounded-lg border border-orange-200 bg-white ${cardShadow}`}
                                >
                                  {/* RSM header */}
                                  <div className="border-b border-orange-200 bg-gradient-to-r from-orange-100/60 via-orange-50 to-orange-100/60 px-4 py-3">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                      <div className="flex items-center gap-2">
                                        <span
                                          aria-hidden
                                          className="h-1.5 w-1.5 rounded-sm bg-orange-500"
                                        />
                                        <div>
                                          <p className="text-[10px] font-bold uppercase tracking-wider text-orange-700">
                                            {group.title}
                                          </p>
                                          <p className="mt-0.5 break-words text-[13px] font-bold text-slate-900">
                                            {group.name}
                                          </p>
                                        </div>
                                      </div>
                                      <div className="flex items-center gap-1.5 text-[10px]">
                                        <span className="rounded-sm bg-white px-1.5 py-0.5 font-semibold text-slate-600">
                                          {group.childLanes?.length ?? 0} DSM lanes
                                        </span>
                                        {groupVacancies > 0 && (
                                          <span className="rounded-sm bg-orange-200/80 px-1.5 py-0.5 font-bold text-orange-700">
                                            {groupVacancies} vacant
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                  {/* RSM's child DSM lanes */}
                                  <div
                                    className="grid min-w-max gap-2 bg-orange-50/20 p-2"
                                    style={{
                                      gridTemplateColumns: `repeat(${childCount}, minmax(220px, 1fr))`,
                                    }}
                                  >
                                    {(group.childLanes ?? []).length > 0 ? (
                                      group.childLanes?.map((lane, li) => (
                                        <ManagerLaneUI
                                          group={lane}
                                          groupKey={`${gKey}-child-${li}`}
                                          key={`${gKey}-child-${li}`}
                                        />
                                      ))
                                    ) : (
                                      <div className="p-4 text-center text-[11px] text-slate-400">
                                        No DSM lanes under this regional manager.
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </div>
                            );
                          })}

                          {/* Any other (marketing / fallback) groups */}
                          {otherGroups.length > 0 && (
                            <div
                              className="grid min-w-max gap-3"
                              style={{
                                gridTemplateColumns: `repeat(${otherGroups.length}, minmax(220px, 1fr))`,
                              }}
                            >
                              {otherGroups.map((group, gi) => {
                                const gKey = `other-${group.name}-${gi}`;
                                return (
                                  <ManagerLaneUI
                                    group={group}
                                    groupKey={gKey}
                                    key={gKey}
                                  />
                                );
                              })}
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </div>

                  {/* Mobile Card View */}
                  <div className="space-y-3 sm:hidden">
                    {lanes.groups.map((group, gi) => {
                      const gKey = group.dsm
                        ? `m-mgr-${rowKey(group.dsm)}-${gi}`
                        : group.rsm
                          ? `m-rsm-${rowKey(group.rsm)}-${gi}`
                          : `m-mgr-${group.name}-${gi}`;

                      if (group.rsm) {
                        const groupVacancies =
                          (group.childLanes ?? []).reduce(
                            (t, l) =>
                              t +
                              l.members.filter((m) => m.type === "vacancy").length +
                              (l.dsm?.type === "vacancy" ? 1 : 0),
                            0,
                          );

                        return (
                          <div
                            className={`overflow-hidden rounded-lg border border-orange-200 ${cardShadow}`}
                            key={gKey}
                          >
                            <div className="border-b border-orange-200 bg-orange-50 px-3 py-2.5">
                              <p className="text-[10px] font-semibold uppercase tracking-wider text-orange-700">
                                {group.title}
                              </p>
                              <p className="mt-0.5 break-words text-xs font-bold text-slate-800">
                                {group.name}
                              </p>
                              <div className="mt-1 flex gap-2 text-[10px]">
                                <span className="text-slate-500">
                                  {group.childLanes?.length ?? 0} DSM lanes
                                </span>
                                {groupVacancies > 0 && (
                                  <span className="font-semibold text-orange-600">
                                    {groupVacancies} vacant
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="space-y-2 bg-white p-2">
                              {(group.childLanes ?? []).map((lane, li) => (
                                <ManagerLaneUI
                                  group={lane}
                                  groupKey={`${gKey}-m-child-${li}`}
                                  key={`${gKey}-m-child-${li}`}
                                />
                              ))}
                            </div>
                          </div>
                        );
                      }

                      return (
                        <ManagerLaneUI
                          group={group}
                          groupKey={gKey}
                          key={gKey}
                        />
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </Card>
        </WorkspaceErrorBoundary>
      )}

      {/* No line selected message — shown for non-MM roles that have no filter yet */}
      {!showLinePicker && report && !effectiveLineFilter && !normalizedSearch && (
        <Card className={`rounded-lg border border-gray-100 p-8 text-center ${cardShadow}`}>
          <h3 className="text-sm font-semibold text-slate-700">
            Select a line to view the organogram
          </h3>
          <p className="mx-auto mt-2 max-w-md text-[11px] text-slate-400">
            The hierarchy stays hidden until a line is selected, so the chart
            only shows the exact structure you are reviewing.
          </p>
        </Card>
      )}
      </>}
    </div>
  );
}
