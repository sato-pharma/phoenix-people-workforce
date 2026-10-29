"use client";

import { useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Download,
  Flame,
  Gauge,
  MapPinned,
  RefreshCcw,
  Sparkles,
  TrendingDown,
  TrendingUp,
  User,
  Users,
  UsersRound,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { rowDetailToggleProps, TableRowDetail } from "@/components/ui/table-row-detail";
import { Input } from "@/components/ui/input";
import {
  PortalDesktopTable,
  PortalEmptyState,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import {
  PHARMACIES_IREPORTS360_ONLY,
  formatPharmacyFigure,
  formatVisitCountSplit,
  pharmacyRecordingOf,
  pharmacyTileFigure,
  type VisitCountSplit,
} from "@/lib/crm/visit-count-buckets";
import { canonicalHrIdKey } from "@/lib/hr-id";
import type {
  DoubleVisitDashboardData,
  DoubleVisitInsight,
  DoubleVisitLogEntry,
  DoubleVisitManagerSummary,
  DoubleVisitMrScore,
  DoubleVisitRoleCode,
  DoubleVisitRoleRollup,
  DoubleVisitTrendPoint,
} from "@/lib/double-visit-analytics/types";
import { entryCountBucket, entryPeriodLabel } from "@/lib/double-visit-analytics/count-bucket";
import { visitLogPerDoubleVisitor } from "@/lib/double-visit-analytics/chain-visitors";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";
import { phxSelectClassName } from "@/components/ui/form-tokens";

type Tab = "summary" | "managers" | "mr-status" | "trends";
type PeriodFilter = "ALL" | "AM" | "PM" | "Pharmacies";
type RoleFilter = "ALL" | DoubleVisitRoleCode;
type SortKey =
  | "activeDvDays"
  | "callsPerActiveDay"
  | "concentrationPct"
  | "coveragePct"
  | "daysSinceLastDv"
  | "distinctMrs"
  | "name"
  | "totalDvs";

// Join HR_IDs on the same canonical key the server uses (trim + lowercase + aaa→aa).
const hk = (value: string | null | undefined) => canonicalHrIdKey(value) ?? "";

// ─── Formatting helpers ───────────────────────────────────────────────────────

function fmt(n: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(n);
}

// DATE-ONLY (hire / last-DV / span dates, all `date` columns, sliced to 10 chars first), which `new
// Date` parses as UTC midnight. UTC here is CORRECT and must stay: it is what stops the calendar day
// being shifted by a zone offset. Not an instant — do not "fix" this one to Cairo.
function fmtDate(v: string | null | undefined) {
  if (!v) return "—";
  const d = new Date(`${v.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? v
    : stableEnGbFormatter({ day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).format(d);
}

// Midnight-UTC to midnight-UTC so this matches the server's daysSinceLastDv exactly.
function daysBetween(isoDate: string | null) {
  if (!isoDate) return null;
  const today = new Date().toISOString().slice(0, 10);
  const ms = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${isoDate.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.round(ms / 86_400_000));
}

function bandClass(b: "critical" | "healthy" | "warning") {
  if (b === "healthy") return "bg-emerald-50 text-emerald-700 ring-emerald-200";
  if (b === "warning") return "bg-amber-50 text-amber-700 ring-amber-200";
  return "bg-rose-50 text-rose-700 ring-rose-200";
}

// AM · PM · Pharmacies kept on-brand: AM = orange accent, PM = neutral slate, Pharmacies = emerald —
// the same three tones as the split bar below. A pharmacy is never shown, or counted, as PM.
function periodPillClass(p: "AM" | "PM" | "Pharmacies" | "UNKNOWN") {
  if (p === "AM") return "bg-orange-100 text-orange-700";
  if (p === "PM") return "bg-slate-200 text-slate-700";
  if (p === "Pharmacies") return "bg-emerald-100 text-emerald-800";
  return "bg-slate-100 text-slate-500";
}

function coverageClass(pct: number | null) {
  if (pct == null) return "bg-slate-100 text-slate-400";
  if (pct >= 80) return "bg-emerald-50 text-emerald-700";
  if (pct >= 50) return "bg-amber-50 text-amber-700";
  return "bg-rose-50 text-rose-700";
}

function insightStripe(severity: DoubleVisitInsight["severity"]) {
  if (severity === "critical") return "border-l-rose-500 bg-rose-50/40";
  if (severity === "warning") return "border-l-amber-500 bg-amber-50/40";
  if (severity === "positive") return "border-l-emerald-500 bg-emerald-50/40";
  return "border-l-slate-400 bg-slate-50";
}

// ─── Small shared pieces ──────────────────────────────────────────────────────

function RoleBadge({ role }: { role: DoubleVisitRoleCode | null }) {
  const tone =
    role === "NSM" || role === "GPM"
      ? "bg-orange-100 text-orange-700"
      : role === "RM" || role === "PM"
        ? "bg-slate-200 text-slate-700"
        : role
          ? "bg-slate-100 text-slate-600"
          : "bg-slate-100 text-slate-400";
  return <span className={`rounded px-2 py-0.5 text-phx-2xs font-black uppercase tracking-wide ${tone}`}>{role ?? "—"}</span>;
}

/**
 * A row of figures as the golden-rule split, with its Phoenix CRM share. Phoenix CRM logs no pharmacy
 * visit, so a split of its double visits prints "Pharmacies not recorded in Phoenix", never 0, and beside
 * iReports360 visits "(iReports360 only)" (src/lib/crm/visit-count-buckets.ts).
 */
function figureSplit(am: number, pm: number, pharmacies: number, phoenix: number | undefined): VisitCountSplit {
  return { am, pm, pharmacies, ...(phoenix ? { phoenix } : {}) };
}

/** A Pharmacies table cell: the count (— for none, as before), "Not recorded", or the count named "(iReports360 only)". */
function pharmacyCellContent(split: VisitCountSplit): ReactNode {
  const recording = pharmacyRecordingOf(split);
  if (recording === "not-recorded") return pharmacyTileFigure(split).value;
  const figure = split.pharmacies > 0 ? split.pharmacies : <span className="text-slate-300">—</span>;
  if (recording === "recorded") return figure;
  return (
    <>
      {figure} <span className="text-phx-2xs text-slate-400">{PHARMACIES_IREPORTS360_ONLY}</span>
    </>
  );
}

// THE AM · PM · PHARMACIES GOLDEN RULE: three segments, never a two-way AM/PM split that files the
// pharmacies among the PM doctors. `phoenix` words the tooltip of a Phoenix CRM share.
function AmPmBar({ am, pharmacies, phoenix, pm }: { am: number; pharmacies: number; phoenix?: number; pm: number }) {
  const total = am + pm + pharmacies;
  const share = (value: number) => (total > 0 ? (value / total) * 100 : 0);
  return (
    <div className="flex h-2 w-full overflow-hidden bg-slate-100" title={formatVisitCountSplit(figureSplit(am, pm, pharmacies, phoenix))}>
      <div className="h-2 bg-phx-accent" style={{ width: `${share(am)}%` }} />
      <div className="h-2 bg-slate-400" style={{ width: `${share(pm)}%` }} />
      <div className="h-2 bg-emerald-600" style={{ width: `${share(pharmacies)}%` }} />
    </div>
  );
}

function StatChip({ label, value, sub, span }: { label: string; span?: boolean; sub?: string; value: string }) {
  return (
    <div className={["rounded border border-slate-200 bg-slate-50 px-4 py-3", span ? "col-span-2 sm:col-span-1" : ""].join(" ")}>
      <p className="text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-400">{label}</p>
      <p className="mt-1 text-xl font-black text-slate-950">{value}</p>
      {sub ? <p className="mt-0.5 text-xs font-semibold text-slate-500">{sub}</p> : null}
    </div>
  );
}

function KpiCard({ icon: Icon, label, value, hint }: { hint: string; icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="rounded border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-phx-xs font-black uppercase tracking-[0.16em] text-slate-500">{label}</p>
          <p className="mt-2 text-2xl font-black text-slate-950">{value}</p>
        </div>
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded bg-slate-100 text-slate-700">
          <Icon className="h-5 w-5" />
        </span>
      </div>
      <p className="mt-3 text-xs font-semibold text-slate-500">{hint}</p>
    </div>
  );
}

function MiniStat({ value, label, tone }: { label: string; tone?: "orange" | "rose" | "slate"; value: string }) {
  const toneClass =
    tone === "orange"
      ? "border-orange-200 bg-orange-50 text-orange-700"
      : tone === "rose"
        ? "border-rose-200 bg-rose-50 text-rose-700"
        : "border-slate-200 bg-slate-50 text-slate-700";
  return (
    <span className={["inline-flex items-baseline gap-1.5 rounded border px-3 py-1.5", toneClass].join(" ")}>
      <span className="text-sm font-black">{value}</span>
      <span className="text-phx-xs font-semibold uppercase tracking-wide opacity-80">{label}</span>
    </span>
  );
}

function RoleFilterBar({
  value,
  options,
  onChange,
}: {
  onChange: (next: RoleFilter) => void;
  options: DoubleVisitRoleCode[];
  value: RoleFilter;
}) {
  const all: RoleFilter[] = ["ALL", ...options];
  return (
    <div className="flex flex-wrap overflow-hidden rounded border border-slate-200">
      {all.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          className={["px-3.5 py-2 text-xs font-black uppercase", value === option ? "bg-phx-accent text-white" : "bg-white text-slate-500 hover:bg-slate-50"].join(" ")}
        >
          {option === "ALL" ? "All Roles" : option}
        </button>
      ))}
    </div>
  );
}

function SortHeader({
  label,
  field,
  sortKey,
  sortDir,
  onSort,
  align = "left",
}: {
  align?: "left" | "right";
  field: SortKey;
  label: string;
  onSort: (key: SortKey) => void;
  sortDir: "asc" | "desc";
  sortKey: SortKey;
}) {
  const active = sortKey === field;
  return (
    <th className={`px-3 py-3 ${align === "right" ? "text-right" : "text-left"}`}>
      <button type="button" onClick={() => onSort(field)} className={`inline-flex items-center gap-1 ${active ? "text-phx-accent" : ""}`}>
        {label}
        {active ? (sortDir === "asc" ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />) : null}
      </button>
    </th>
  );
}

// ─── Manager profile (computed from visit log) ────────────────────────────────

type MrVisitRow = {
  am: number;
  area: string | null;
  dates: Set<string>;
  days: number;
  firstDate: string | null;
  hrId: string | null;
  key: string;
  lastDate: string | null;
  name: string;
  pharmacies: number;
  /** Of these double visits, Phoenix CRM's own — it logs no pharmacy visit. */
  phoenix: number;
  pm: number;
  score: DoubleVisitMrScore | null;
  visits: number;
  visitsPerDay: number;
};

function buildManagerProfile(
  managerKey: string,
  visitLog: DoubleVisitLogEntry[],
  mrScores: DoubleVisitMrScore[],
  periodFilter: PeriodFilter,
  teamMrHrIds: string[] | null | undefined = null,
) {
  // All-period rows for this manager — drives the stable summary chips.
  // A chain visit is in BOTH managers' records (owner, 2026-10-08): each finds it under his own name.
  const allRows = visitLogPerDoubleVisitor(visitLog).filter((e) => hk(e.doubleVisitorHrId) === managerKey);
  const totalVisits = allRows.reduce((s, e) => s + e.visitCount, 0);
  // AM · PM · Pharmacies apart — a pharmacy visit is never one of the PM doctors (count-bucket.ts).
  const amVisits = allRows.filter((e) => entryCountBucket(e) === "AM").reduce((s, e) => s + e.visitCount, 0);
  const pmVisits = allRows.filter((e) => entryCountBucket(e) === "PM").reduce((s, e) => s + e.visitCount, 0);
  const pharmacyVisits = allRows.filter((e) => entryCountBucket(e) === "Pharmacies").reduce((s, e) => s + e.visitCount, 0);
  const phoenixVisits = allRows.filter((e) => e.fromPhoenix && entryCountBucket(e) !== null).reduce((s, e) => s + e.visitCount, 0);
  const lastDate = [...new Set(allRows.map((e) => e.date))].sort().at(-1) ?? null;

  // All-period visited set — an MR visited in any period is NOT neglected.
  const visitedKeysAll = new Set(allRows.map((e) => hk(e.visitedHrId)).filter(Boolean));

  // Period-scoped rows reshape only the breakdown table below the chips.
  const scopedRows = periodFilter === "ALL" ? allRows : allRows.filter((e) => entryCountBucket(e) === periodFilter);

  const byMr = new Map<string, MrVisitRow>();
  for (const row of scopedRows) {
    const key = hk(row.visitedHrId) || `name:${row.visitedName ?? "unknown"}`;
    const existing =
      byMr.get(key) ??
      { am: 0, area: row.area, dates: new Set<string>(), days: 0, firstDate: null, hrId: row.visitedHrId, key, lastDate: null, name: row.visitedName ?? "Unmapped MR", pharmacies: 0, phoenix: 0, pm: 0, score: null, visits: 0, visitsPerDay: 0 };
    existing.visits += row.visitCount;
    const countBucket = entryCountBucket(row);
    if (countBucket === "AM") existing.am += row.visitCount;
    else if (countBucket === "PM") existing.pm += row.visitCount;
    else if (countBucket === "Pharmacies") existing.pharmacies += row.visitCount;
    if (countBucket && row.fromPhoenix) existing.phoenix += row.visitCount;
    existing.dates.add(row.date.slice(0, 10));
    if (!existing.lastDate || row.date > existing.lastDate) existing.lastDate = row.date;
    if (!existing.firstDate || row.date < existing.firstDate) existing.firstDate = row.date;
    byMr.set(key, existing);
  }

  const scoreByKey = new Map(mrScores.map((s) => [hk(s.hrId), s]));
  for (const [, row] of byMr) {
    row.score = row.hrId ? (scoreByKey.get(hk(row.hrId)) ?? null) : null;
    row.days = row.dates.size;
    row.visitsPerDay = row.days > 0 ? row.visits / row.days : 0;
  }

  const allByMr = Array.from(byMr.values());
  const mrBreakdown = allByMr.filter((r) => r.hrId != null).sort((a, b) => b.visits - a.visits);
  // Resigned reps' accounts get renamed to their area in the CRM (no HR id). These are
  // real manager effort (counted in the totals) — surfaced as their own labeled line, not
  // as MRs and not as a data gap.
  const vacantTerritories = allByMr.filter((r) => r.hrId == null).sort((a, b) => b.visits - a.visits);
  const vacantVisits = vacantTerritories.reduce((s, r) => s + r.visits, 0);

  // Team MRs this manager never visited (any period). The team is his WHOLE team — every rep beneath
  // a DSM, RM or NSM, the same population his coverage figure counts — so an RM or NSM, whose reps
  // report to his DSMs rather than to him, no longer reads an empty list (owner, 2026-10-20). A
  // manager with no org team (no team list on his summary) keeps the direct-report reading.
  const teamKeys = teamMrHrIds ? new Set(teamMrHrIds.map((hrId) => hk(hrId)).filter(Boolean)) : null;
  const neglectedMrs = mrScores.filter(
    (s) => (teamKeys ? teamKeys.has(hk(s.hrId)) : hk(s.managerHrId) === managerKey) && !visitedKeysAll.has(hk(s.hrId)),
  );

  // Concentration / over-focus signal from the real-MR breakdown.
  const scopedTotal = mrBreakdown.reduce((s, r) => s + r.visits, 0);
  const maxVisits = mrBreakdown.reduce((m, r) => Math.max(m, r.visits), 0);
  const avgVisits = mrBreakdown.length ? scopedTotal / mrBreakdown.length : 0;
  const topN = Math.min(4, mrBreakdown.length);
  const topShare = scopedTotal > 0 ? mrBreakdown.slice(0, topN).reduce((s, r) => s + r.visits, 0) / scopedTotal : 0;
  const overFocusedKeys = new Set(
    mrBreakdown.filter((r) => mrBreakdown.length > 1 && avgVisits > 0 && r.visits >= avgVisits * 2).map((r) => r.key),
  );

  return {
    amVisits,
    avgVisits,
    concentrationPct: Math.round(topShare * 100),
    lastDate,
    maxVisits,
    mrBreakdown,
    neglectedMrs,
    overFocusedKeys,
    pharmacyVisits,
    phoenixVisits,
    pmVisits,
    topN,
    totalVisits,
    vacantTerritories,
    vacantVisits,
    visitedCount: visitedKeysAll.size,
  };
}

// Display the recorded account name as-is for a resigned/area-renamed territory,
// stripping only the wrapping parentheses (e.g. "( Cairo East 1 / F )" → "Cairo East 1 / F").
function territoryLabel(row: { area: string | null; name: string }) {
  const cleaned = row.name.replace(/^\(\s*/, "").replace(/\s*\)$/, "").trim();
  return cleaned || row.area || "Unknown territory";
}

// ─── Expandable MR row (used in By MR tab) ────────────────────────────────────

function ExpandableMrRow({
  open,
  onToggle,
  onSelectManager,
  periodFilter,
  score,
  visitLog,
}: {
  onSelectManager: (managerHrId: string | null) => void;
  onToggle: () => void;
  open: boolean;
  periodFilter: PeriodFilter;
  score: DoubleVisitMrScore;
  visitLog: DoubleVisitLogEntry[];
}) {
  const mrHistory = useMemo(() => {
    const scoreKey = hk(score.hrId);
    const rows = visitLog.filter(
      (e) => hk(e.visitedHrId) === scoreKey && (periodFilter === "ALL" || entryCountBucket(e) === periodFilter),
    );
    return [...rows].sort((a, b) => b.date.localeCompare(a.date));
  }, [visitLog, score.hrId, periodFilter]);
  const detailId = `mr-history-${hk(score.hrId)}`;

  return (
    <>
      <tr className="cursor-pointer border-t border-slate-100 hover:bg-slate-50" onClick={onToggle} {...rowDetailToggleProps(detailId, open)}>
        <td className="w-8 px-3 py-3 text-slate-400">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </td>
        <td className="px-3 py-3">
          <p className="text-sm font-semibold text-slate-800">{score.mrName}</p>
          {score.areaName ? <p className="break-words text-xs text-slate-400">{score.areaName}</p> : null}
        </td>
        <td className="px-3 py-3 text-sm text-slate-600">{fmtDate(score.hireDate)}</td>
        <td className="px-3 py-3 text-xs">
          {score.managerName ? (
            <button
              type="button"
              onClick={(event) => { event.stopPropagation(); onSelectManager(score.managerHrId); }}
              className="font-semibold text-orange-700 underline decoration-orange-300 underline-offset-2 hover:text-orange-800"
            >
              {score.managerName}
            </button>
          ) : <span className="text-slate-400">—</span>}
        </td>
        <td className="px-3 py-3 text-right text-sm font-black text-slate-950 tabular-nums">{score.totalDvs}</td>
        <td className="px-3 py-3 text-right text-sm text-slate-700 tabular-nums">{score.dvsLast90Days}</td>
        <td className="px-3 py-3 text-sm text-slate-700">{fmtDate(score.lastDvDate)}</td>
        <td className="px-3 py-3 text-right text-sm font-semibold text-slate-700 tabular-nums">
          {score.daysSinceLastDv ?? <span className="text-rose-600">Never</span>}
        </td>
        <td className="px-3 py-3 text-sm text-slate-500">{score.lastDoubleVisitorName ?? "—"}</td>
        <td className="px-3 py-3">
          <span className={`rounded px-2 py-1 text-xs font-black uppercase ring-1 ${bandClass(score.band)}`}>{score.band}</span>
        </td>
      </tr>
      {open && (
        <TableRowDetail className="px-6 py-4" colSpan={10} id={detailId}>
            {mrHistory.length === 0 ? (
              <p className="text-sm text-slate-400">
                No visits recorded for this MR{periodFilter !== "ALL" ? ` in ${periodFilter}` : ""}.
              </p>
            ) : (
              <table className="w-full table-fixed text-left text-sm">
                <colgroup>
                  <col className="w-[18%]" />
                  <col className="w-[32%]" />
                  <col className="w-[24%]" />
                  <col className="w-[16%]" />
                  <col className="w-[10%]" />
                </colgroup>
                <thead>
                  <tr className="text-xs font-black uppercase tracking-wide text-slate-500">
                    <th className="pb-2 pr-6">Date</th>
                    <th className="pb-2 pr-6">Manager / DV</th>
                    <th className="pb-2 pr-6">Area</th>
                    <th className="pb-2 pr-6">Period</th>
                    <th className="pb-2 text-right">Visits</th>
                  </tr>
                </thead>
                <tbody>
                  {mrHistory.map((e, i) => (
                    <tr key={`${e.date}-${hk(e.doubleVisitorHrId) || e.doubleVisitorName || "dv"}-${e.period}-${e.visitCount}-${i}`} className="border-t border-slate-200">
                      <td className="py-1.5 pr-6 font-semibold text-slate-800">{fmtDate(e.date)}</td>
                      <td className="min-w-0 break-words py-1.5 pr-6 text-slate-700">{e.doubleVisitorName ?? "—"}</td>
                      <td className="min-w-0 break-words py-1.5 pr-6 text-slate-600">{e.area ?? "—"}</td>
                      <td className="py-1.5 pr-6">
                        {entryPeriodLabel(e) !== "UNKNOWN" ? (
                          <span className={`rounded px-1.5 py-0.5 text-xs font-black ${periodPillClass(entryPeriodLabel(e))}`}>{entryPeriodLabel(e)}</span>
                        ) : "—"}
                      </td>
                      <td className="py-1.5 text-right font-bold text-slate-800 tabular-nums">{e.visitCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </TableRowDetail>
      )}
    </>
  );
}

// ─── MR score card (mobile) — mirrors ExpandableMrRow's data + expand/collapse ──

function MrScoreCard({
  onSelectManager,
  onToggle,
  open,
  periodFilter,
  score,
  visitLog,
}: {
  onSelectManager: (managerHrId: string | null) => void;
  onToggle: () => void;
  open: boolean;
  periodFilter: PeriodFilter;
  score: DoubleVisitMrScore;
  visitLog: DoubleVisitLogEntry[];
}) {
  const mrHistory = useMemo(() => {
    const scoreKey = hk(score.hrId);
    const rows = visitLog.filter(
      (e) => hk(e.visitedHrId) === scoreKey && (periodFilter === "ALL" || entryCountBucket(e) === periodFilter),
    );
    return [...rows].sort((a, b) => b.date.localeCompare(a.date));
  }, [visitLog, score.hrId, periodFilter]);

  return (
    <PortalRecordCard
      accent={score.band === "critical" ? "rose" : score.band === "warning" ? "amber" : "emerald"}
      title={score.mrName}
      meta={score.areaName ? <span>{score.areaName}</span> : undefined}
      status={<span className={`rounded px-2 py-1 text-xs font-black uppercase ring-1 ${bandClass(score.band)}`}>{score.band}</span>}
      actions={
        <button
          type="button"
          onClick={onToggle}
          className="inline-flex items-center gap-1 text-xs font-black uppercase tracking-wide text-orange-700"
        >
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          {open ? "Hide history" : "View history"}
        </button>
      }
    >
      <PortalRecordFields
        fields={[
          { label: "Hire date", value: fmtDate(score.hireDate) },
          {
            label: "Manager",
            value: score.managerName ? (
              <button
                type="button"
                onClick={() => onSelectManager(score.managerHrId)}
                className="font-bold text-orange-700 underline decoration-orange-300 underline-offset-2"
              >
                {score.managerName}
              </button>
            ) : (
              "—"
            ),
          },
          { label: "Total DVs", value: score.totalDvs },
          { label: "DVs (90d)", value: score.dvsLast90Days },
          { label: "Last DV", value: fmtDate(score.lastDvDate) },
          { label: "Days since", value: score.daysSinceLastDv ?? "Never" },
          { label: "Last by", value: score.lastDoubleVisitorName ?? "—" },
        ]}
      />
      {open ? (
        <div className="mt-3 divide-y divide-slate-100 rounded border border-slate-100">
          {mrHistory.length === 0 ? (
            <p className="px-3 py-3 text-xs font-semibold text-slate-400">
              No visits recorded{periodFilter !== "ALL" ? ` in ${periodFilter}` : ""}.
            </p>
          ) : (
            mrHistory.map((e, i) => (
              <div
                key={`${e.date}-${hk(e.doubleVisitorHrId) || e.doubleVisitorName || "dv"}-${e.period}-${e.visitCount}-${i}`}
                className="flex items-center justify-between gap-2 px-3 py-2 text-xs"
              >
                <div className="min-w-0">
                  <p className="font-bold text-slate-800">{fmtDate(e.date)}</p>
                  <p className="break-words text-slate-500">
                    {e.doubleVisitorName ?? "—"} · {e.area ?? "—"}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {entryPeriodLabel(e) !== "UNKNOWN" ? (
                    <span className={`rounded px-1.5 py-0.5 text-phx-2xs font-black ${periodPillClass(entryPeriodLabel(e))}`}>{entryPeriodLabel(e)}</span>
                  ) : null}
                  <span className="font-black tabular-nums text-slate-800">{e.visitCount}</span>
                </div>
              </div>
            ))
          )}
        </div>
      ) : null}
    </PortalRecordCard>
  );
}

// ─── Role rollup card ─────────────────────────────────────────────────────────

function RoleRollupCard({ rollup, active, onClick }: { active: boolean; onClick: () => void; rollup: DoubleVisitRoleRollup }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "rounded border bg-white p-4 text-left shadow-sm transition-colors hover:bg-slate-50",
        active ? "border-l-2 border-l-phx-accent border-slate-200 bg-orange-50" : "border-slate-200",
      ].join(" ")}
    >
      <div className="flex items-center justify-between gap-2">
        <RoleBadge role={rollup.roleCode} />
        <span className="text-xs font-semibold text-slate-500">{rollup.activeManagerCount} {rollup.activeManagerCount === 1 ? "manager" : "managers"}</span>
      </div>
      <p className="mt-2 text-2xl font-black text-slate-950">{fmt(rollup.totalDvs)} <span className="text-sm font-bold text-slate-400">DVs</span></p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <MiniStat tone="orange" value={rollup.avgCallsPerDay != null ? fmt(rollup.avgCallsPerDay) : "—"} label="calls/day" />
        <MiniStat value={rollup.avgCoveragePct != null ? `${rollup.avgCoveragePct}%` : "—"} label="coverage" />
        {rollup.neglectedMrCount != null && rollup.neglectedMrCount > 0 && (
          <MiniStat tone="rose" value={String(rollup.neglectedMrCount)} label="neglected" />
        )}
      </div>
      <div className="mt-3">
        <div className="flex flex-wrap items-center justify-between gap-x-2 text-phx-2xs font-bold uppercase tracking-wide text-slate-400">
          <span>AM {rollup.amVisits}</span>
          <span>PM {rollup.pmVisits}</span>
          <span>{formatPharmacyFigure(figureSplit(rollup.amVisits, rollup.pmVisits, rollup.pharmacyVisits, rollup.phoenixVisits))}</span>
        </div>
        <div className="mt-1"><AmPmBar am={rollup.amVisits} pharmacies={rollup.pharmacyVisits} phoenix={rollup.phoenixVisits} pm={rollup.pmVisits} /></div>
      </div>
    </button>
  );
}

// ─── Mobile record cards (leaderboard / breakdown / trend tables) ────────────

function LeaderboardCard({
  maxDvs,
  onOpen,
  rank,
  row,
}: {
  maxDvs: number;
  onOpen: (managerHrId: string | null) => void;
  rank: number;
  row: DoubleVisitManagerSummary;
}) {
  return (
    <PortalRecordCard
      accent="slate"
      title={row.managerName}
      meta={<span>#{rank}</span>}
      status={<RoleBadge role={row.roleCode} />}
      actions={
        <button
          type="button"
          onClick={() => onOpen(row.managerHrId)}
          className="inline-flex items-center gap-1 text-xs font-black uppercase tracking-wide text-orange-700"
        >
          View profile <ChevronRight className="h-3.5 w-3.5" />
        </button>
      }
    >
      <div className="flex items-center gap-2">
        <div className="relative h-2 flex-1 bg-slate-100">
          <div className="absolute inset-y-0 left-0 bg-phx-accent" style={{ width: `${maxDvs ? (row.totalDvs / maxDvs) * 100 : 0}%` }} />
        </div>
        <span className="whitespace-nowrap text-sm font-black tabular-nums text-slate-950">{row.totalDvs} DVs</span>
      </div>
      <PortalRecordFields
        fields={[
          { label: "Active days", value: row.activeDvDays },
          { label: "Calls/day", value: fmt(row.callsPerActiveDay) },
          { label: "MRs / team", value: `${row.distinctMrs} / ${row.teamMrCount ?? "—"}` },
          {
            label: "Coverage",
            value: (
              <span className={`rounded px-2 py-0.5 text-xs font-black ${coverageClass(row.coveragePct)}`}>
                {row.coveragePct != null ? `${row.coveragePct}%` : "—"}
              </span>
            ),
          },
          { label: "Concentration", value: row.concentrationPct != null ? `${row.concentrationPct}%` : "—" },
          {
            label: "Last visit",
            value: row.lastDvDate ? (
              <>
                {fmtDate(row.lastDvDate)}
                {row.daysSinceLastDv != null ? <span className="block text-slate-400">{row.daysSinceLastDv}d ago</span> : null}
              </>
            ) : (
              "—"
            ),
          },
        ]}
      />
      <div className="mt-1 flex flex-wrap items-center justify-between gap-x-2 text-phx-2xs font-bold uppercase tracking-wide text-slate-400">
        <span>AM {row.amVisits}</span>
        <span>PM {row.pmVisits}</span>
        <span>{formatPharmacyFigure(figureSplit(row.amVisits, row.pmVisits, row.pharmacyVisits, row.phoenixVisits))}</span>
      </div>
      <div className="mt-1"><AmPmBar am={row.amVisits} pharmacies={row.pharmacyVisits} phoenix={row.phoenixVisits} pm={row.pmVisits} /></div>
    </PortalRecordCard>
  );
}

function MrBreakdownCard({
  maxVisits,
  overFocused,
  row,
}: {
  maxVisits: number;
  overFocused: boolean;
  row: MrVisitRow;
}) {
  return (
    <PortalRecordCard
      accent={overFocused ? "orange" : "slate"}
      title={row.name}
      meta={row.area ? <span>{row.area}</span> : undefined}
      status={
        row.score ? (
          <span className={`rounded px-2 py-0.5 text-xs font-black uppercase ring-1 ${bandClass(row.score.band)}`}>{row.score.band}</span>
        ) : null
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative h-2 flex-1 bg-slate-100">
          <div className="absolute inset-y-0 left-0 bg-phx-accent" style={{ width: `${maxVisits ? (row.visits / maxVisits) * 100 : 0}%` }} />
        </div>
        <span className="whitespace-nowrap text-sm font-black tabular-nums text-slate-950">{row.visits} visits</span>
        {overFocused ? (
          <span className="rounded bg-orange-100 px-1.5 py-0.5 text-phx-2xs font-black uppercase text-orange-700">Over-focused</span>
        ) : null}
      </div>
      <PortalRecordFields
        fields={[
          { label: "Days", value: row.days },
          {
            label: "Visits/day",
            value: <span className={row.visitsPerDay > 4 ? "font-black text-orange-600" : undefined}>{fmt(row.visitsPerDay)}</span>,
          },
          { label: "AM", value: row.am > 0 ? row.am : "—" },
          { label: "PM", value: row.pm > 0 ? row.pm : "—" },
          { label: "Pharmacies", value: pharmacyCellContent(figureSplit(row.am, row.pm, row.pharmacies, row.phoenix)) },
          { label: "Span", value: `${fmtDate(row.firstDate)} – ${fmtDate(row.lastDate)}` },
        ]}
      />
    </PortalRecordCard>
  );
}

function VacantTerritoryCard({ row }: { row: MrVisitRow }) {
  return (
    <PortalRecordCard
      accent="slate"
      title={territoryLabel(row)}
      meta={<span className="rounded bg-slate-100 px-1.5 py-0.5 text-phx-2xs font-black uppercase text-slate-500">Resigned / vacant</span>}
      status={<span className="whitespace-nowrap text-sm font-black tabular-nums text-slate-950">{row.visits} visits</span>}
    >
      <PortalRecordFields
        fields={[
          { label: "Days", value: row.days },
          { label: "AM", value: row.am > 0 ? row.am : "—" },
          { label: "PM", value: row.pm > 0 ? row.pm : "—" },
          { label: "Pharmacies", value: pharmacyCellContent(figureSplit(row.am, row.pm, row.pharmacies, row.phoenix)) },
          { label: "Span", value: `${fmtDate(row.firstDate)} – ${fmtDate(row.lastDate)}` },
        ]}
      />
    </PortalRecordCard>
  );
}

function TrendCard({ week }: { week: DoubleVisitTrendPoint }) {
  return (
    <PortalRecordCard
      accent="slate"
      title={fmtDate(week.weekStart)}
      status={<span className="whitespace-nowrap text-sm font-black tabular-nums text-slate-950">{fmt(week.totalDvs)} DVs</span>}
    >
      <PortalRecordFields fields={[{ label: "MRs covered", value: week.distinctMrs }]} />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-2 text-phx-2xs font-bold uppercase tracking-wide text-slate-400">
        <span>AM {week.amVisits}</span>
        <span>PM {week.pmVisits}</span>
        <span>{formatPharmacyFigure(figureSplit(week.amVisits, week.pmVisits, week.pharmacyVisits, week.phoenixVisits))}</span>
      </div>
      <div className="mt-1"><AmPmBar am={week.amVisits} pharmacies={week.pharmacyVisits} phoenix={week.phoenixVisits} pm={week.pmVisits} /></div>
    </PortalRecordCard>
  );
}

function NeglectedMrCard({ onOpen, score }: { onOpen: (score: DoubleVisitMrScore) => void; score: DoubleVisitMrScore }) {
  return (
    <PortalRecordCard
      accent={score.band === "critical" ? "rose" : "amber"}
      title={score.mrName}
      meta={score.managerName ? <span>{score.managerName}</span> : undefined}
      status={<span className={`rounded px-2 py-1 text-xs font-black uppercase ring-1 ${bandClass(score.band)}`}>{score.band}</span>}
      actions={
        <button
          type="button"
          onClick={() => onOpen(score)}
          className="inline-flex items-center gap-1 text-xs font-black uppercase tracking-wide text-orange-700"
        >
          View history <ChevronRight className="h-3.5 w-3.5" />
        </button>
      }
    >
      <PortalRecordFields
        fields={[
          { label: "Last 90d", value: score.dvsLast90Days },
          { label: "Prev 90d", value: score.dvsPrev90Days },
          {
            label: "Trend",
            value:
              score.trendDirection === "improving" ? (
                <span className="inline-flex items-center gap-1 text-emerald-600"><TrendingUp className="h-3.5 w-3.5" /> Improving</span>
              ) : score.trendDirection === "declining" ? (
                <span className="inline-flex items-center gap-1 text-rose-600"><TrendingDown className="h-3.5 w-3.5" /> Declining</span>
              ) : (
                <span className="text-slate-400">Flat</span>
              ),
          },
        ]}
      />
    </PortalRecordCard>
  );
}

// ─── Main workspace ───────────────────────────────────────────────────────────

export function DoubleVisitAnalyticsWorkspace({
  dashboard,
  embedded = false,
  ownDoubleVisits,
}: {
  dashboard: DoubleVisitDashboardData;
  /**
   * Portal (read-only) embedding. The host page already renders a title banner, so the
   * component suppresses its own header and exposes a slim date-range + export toolbar instead.
   */
  embedded?: boolean;
  /** When set (portal PM/GPM view), renders a "Your double visits" KPI = the viewer's personal DV count. */
  ownDoubleVisits?: number | null;
}) {
  const [activeTab, setActiveTab] = useState<Tab>("summary");
  const [selectedManagerKey, setSelectedManagerKey] = useState<string>("");
  const [periodFilter, setPeriodFilter] = useState<PeriodFilter>("ALL");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("ALL");
  const [sortKey, setSortKey] = useState<SortKey>("totalDvs");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [mrSearch, setMrSearch] = useState("");
  const [expandedMrKeys, setExpandedMrKeys] = useState<Set<string>>(new Set());

  const [dateFrom, setDateFrom] = useState(dashboard.dateFrom);
  const [dateTo, setDateTo] = useState(dashboard.dateTo);

  const visitLog = useMemo(() => dashboard.visitLog ?? [], [dashboard.visitLog]);
  const managerSummaries = useMemo(() => dashboard.managerSummaries ?? [], [dashboard.managerSummaries]);
  const executiveSummary = dashboard.executiveSummary;
  const criticalMrs = dashboard.mrScores.filter((s) => s.band === "critical");
  const weakMrs = dashboard.mrScores.filter((s) => s.band !== "healthy");

  const summaryByKey = useMemo(
    () => new Map(managerSummaries.map((s) => [hk(s.managerHrId), s])),
    [managerSummaries],
  );
  const availableRoles = executiveSummary?.roleRollups.map((r) => r.roleCode) ?? [];

  // Per-manager all-period totals (drives the sidebar ranking — always all periods).
  const managerTotals = useMemo(() => {
    const map = new Map<string, { dvs: number; lastDate: string | null; mrs: Set<string>; name: string }>();
    for (const e of visitLogPerDoubleVisitor(visitLog)) {
      const mKey = hk(e.doubleVisitorHrId);
      if (!mKey) continue;
      const existing = map.get(mKey) ?? { dvs: 0, lastDate: null, mrs: new Set<string>(), name: e.doubleVisitorName ?? "Unnamed manager" };
      existing.dvs += e.visitCount;
      const visited = hk(e.visitedHrId);
      if (visited) existing.mrs.add(visited);
      if (!existing.lastDate || e.date > existing.lastDate) existing.lastDate = e.date;
      map.set(mKey, existing);
    }
    return map;
  }, [visitLog]);

  const managerProfile = useMemo(
    () =>
      selectedManagerKey
        ? buildManagerProfile(
            selectedManagerKey,
            visitLog,
            dashboard.mrScores,
            periodFilter,
            summaryByKey.get(selectedManagerKey)?.teamMrHrIds ?? null,
          )
        : null,
    [selectedManagerKey, visitLog, dashboard.mrScores, periodFilter, summaryByKey],
  );

  // By-MR list: search only. Period scopes each MR's expanded history, never row
  // membership — hiding MRs by period would hide exactly the neglected ones.
  const filteredMrScores = useMemo(() => {
    if (!mrSearch) return dashboard.mrScores;
    const q = mrSearch.toLowerCase();
    return dashboard.mrScores.filter(
      (s) => s.mrName.toLowerCase().includes(q) || s.hrId.toLowerCase().includes(q) || (s.managerName ?? "").toLowerCase().includes(q),
    );
  }, [dashboard.mrScores, mrSearch]);

  // Sidebar manager list — scoped by the shared role filter.
  const managerList = useMemo(
    () =>
      dashboard.executiveReports
        .map((r) => {
          const totals = managerTotals.get(hk(r.managerHrId));
          return { ...r, actualDvs: totals?.dvs ?? 0, actualMrs: totals?.mrs.size ?? 0, lastDate: totals?.lastDate ?? null };
        })
        .filter((r) => roleFilter === "ALL" || summaryByKey.get(hk(r.managerHrId))?.roleCode === roleFilter)
        .sort((a, b) => b.actualDvs - a.actualDvs),
    [dashboard.executiveReports, managerTotals, roleFilter, summaryByKey],
  );

  // Leaderboard — role-filtered + sorted (nulls always last).
  const leaderboardRows = useMemo(() => {
    const filtered = roleFilter === "ALL" ? managerSummaries : managerSummaries.filter((s) => s.roleCode === roleFilter);
    const value = (s: DoubleVisitManagerSummary): number | string | null => {
      switch (sortKey) {
        case "name": return s.managerName.toLowerCase();
        case "coveragePct": return s.coveragePct;
        case "concentrationPct": return s.concentrationPct;
        case "daysSinceLastDv": return s.daysSinceLastDv;
        case "activeDvDays": return s.activeDvDays;
        case "callsPerActiveDay": return s.callsPerActiveDay;
        case "distinctMrs": return s.distinctMrs;
        default: return s.totalDvs;
      }
    };
    const mult = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = value(a);
      const bv = value(b);
      if (av == null && bv == null) return a.managerName.localeCompare(b.managerName);
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "string" && typeof bv === "string") return mult * av.localeCompare(bv);
      return mult * ((av as number) - (bv as number));
    });
  }, [managerSummaries, roleFilter, sortKey, sortDir]);

  const leaderboardMaxDvs = leaderboardRows.reduce((m, s) => Math.max(m, s.totalDvs), 0);
  const selectedSummary = selectedManagerKey ? summaryByKey.get(selectedManagerKey) ?? null : null;
  const selectedExec = selectedManagerKey
    ? dashboard.executiveReports.find((r) => hk(r.managerHrId) === selectedManagerKey)
    : undefined;
  const selectedName =
    selectedSummary?.managerName ??
    selectedExec?.managerName ??
    managerTotals.get(selectedManagerKey)?.name ??
    dashboard.mrScores.find((s) => hk(s.managerHrId) === selectedManagerKey)?.managerName ??
    selectedManagerKey.toUpperCase();

  function handleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir(key === "name" ? "asc" : "desc"); }
  }

  // Reload the CURRENT page (admin or portal) with the chosen range. Never hardcode the
  // admin path — a portal user sent to /admin/* is bounced back out by the admin layout.
  function applyDateRange(from: string, to: string) {
    const params = new URLSearchParams();
    if (from) params.set("dateFrom", from);
    if (to) params.set("dateTo", to);
    const qs = params.toString();
    window.location.assign(qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
  }

  function openManager(managerHrId: string | null) {
    const key = hk(managerHrId);
    if (!key) return;
    setSelectedManagerKey(key);
    setActiveTab("managers");
  }

  function focusMr(score: DoubleVisitMrScore) {
    setMrSearch(score.mrName);
    setExpandedMrKeys(new Set([hk(score.hrId)]));
    setActiveTab("mr-status");
  }

  function focusMrByHrId(mrHrId: string | null) {
    const score = dashboard.mrScores.find((s) => hk(s.hrId) === hk(mrHrId));
    if (score) focusMr(score);
  }

  function toggleMr(scoreKey: string) {
    setExpandedMrKeys((prev) => {
      const next = new Set(prev);
      if (next.has(scoreKey)) next.delete(scoreKey);
      else next.add(scoreKey);
      return next;
    });
  }

  const exportHref = `/api/admin/double-visit-analytics/export?dateFrom=${encodeURIComponent(dateFrom)}&dateTo=${encodeURIComponent(dateTo)}`;
  // The coaching audit export mirrors the board's live filters — date range, role, period — so the
  // workbook is the on-screen view: one tab per coach with the full per-rep / per-day / dated trail.
  // split=month keeps each calendar month's own figures in one file (one tab per coach per month),
  // so a multi-month range comes back as a single combined audit rather than a collapsed total.
  const auditExportHref = `/api/admin/double-visit-analytics/audit-export?dateFrom=${encodeURIComponent(dateFrom)}&dateTo=${encodeURIComponent(dateTo)}&role=${encodeURIComponent(roleFilter)}&period=${encodeURIComponent(periodFilter)}&split=month`;
  const periodLabel = periodFilter === "ALL" ? "" : periodFilter;
  const activeManagerCount = managerSummaries.length;
  const idleCount = executiveSummary?.idleManagers.length ?? 0;
  // A Phoenix CRM double visit logs no pharmacy visit: the band says so rather than print 0.
  const kpiPharmacy = pharmacyTileFigure(
    figureSplit(dashboard.kpis.amVisitCount, dashboard.kpis.pmVisitCount, dashboard.kpis.pharmacyVisitCount ?? 0, dashboard.kpis.phoenixVisitCount),
    { formatNumber: fmt },
  );

  const TABS: { icon: LucideIcon; id: Tab; label: string }[] = [
    { id: "summary", icon: Sparkles, label: "Summary" },
    { id: "managers", icon: Users, label: "By Manager" },
    { id: "mr-status", icon: User, label: "By MR" },
    { id: "trends", icon: TrendingUp, label: "Trends" },
  ];

  return (
    <div className="space-y-6">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      {embedded ? (
        // Portal embedding: the host shell already renders the title/description banner, so
        // show only a slim snapshot + date-range + export toolbar (no duplicate <h1>).
        <div className="flex flex-wrap items-end justify-between gap-3">
          <p className="text-sm font-medium text-slate-600">
            Live iReports360 mirror · {fmtDate(dashboard.dateFrom)} – {fmtDate(dashboard.dateTo)} · {fmt(dashboard.kpis.totalVisits)} visits
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="block">
              <span className="mb-1 block text-phx-2xs font-black uppercase tracking-wide text-slate-500">From</span>
              <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            </label>
            <label className="block">
              <span className="mb-1 block text-phx-2xs font-black uppercase tracking-wide text-slate-500">To</span>
              <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
            </label>
            <Button className="min-h-10 gap-2 rounded border border-slate-200 bg-white px-3 text-slate-700 hover:bg-slate-50" onClick={() => applyDateRange(dateFrom, dateTo)} type="button">
              <RefreshCcw className="h-4 w-4" /> Apply
            </Button>
            <a href={exportHref}>
              <Button className="min-h-10 gap-2 rounded bg-slate-950 px-4 text-white hover:bg-slate-800" type="button">
                <Download className="h-4 w-4" /> Excel
              </Button>
            </a>
            <label className="flex items-center gap-2">
              <span className="text-phx-2xs font-black uppercase tracking-wide text-slate-500">Period</span>
              <select
                aria-label="Period for the coaching audit export"
                value={periodFilter}
                onChange={(e) => setPeriodFilter(e.target.value as PeriodFilter)}
                className={`${phxSelectClassName}`}
              >
                <option value="ALL">All periods</option>
                <option value="AM">AM</option>
                <option value="PM">PM</option>
                <option value="Pharmacies">Pharmacies</option>
              </select>
            </label>
            <a href={auditExportHref}>
              <Button className="min-h-10 gap-2 rounded border border-slate-300 bg-white px-3 text-slate-700 hover:bg-slate-50" type="button">
                <Download className="h-4 w-4" /> Coaching audit
              </Button>
            </a>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.18em] text-orange-600">Field performance evidence</p>
            <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-950">Double Visit Analytics</h1>
            <p className="mt-2 max-w-3xl text-sm font-medium text-slate-600">
              Live iReports360 mirror (auto-synced 3x daily) · {fmtDate(dashboard.dateFrom)} – {fmtDate(dashboard.dateTo)} · {fmt(dashboard.kpis.totalVisits)} visits
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2">
              <span className="text-phx-2xs font-black uppercase tracking-wide text-slate-500">Period</span>
              <select
                aria-label="Period for the coaching audit export"
                value={periodFilter}
                onChange={(e) => setPeriodFilter(e.target.value as PeriodFilter)}
                className={`${phxSelectClassName}`}
              >
                <option value="ALL">All periods</option>
                <option value="AM">AM</option>
                <option value="PM">PM</option>
                <option value="Pharmacies">Pharmacies</option>
              </select>
            </label>
            <a href={exportHref}>
              <Button className="min-h-11 gap-2 rounded bg-slate-950 px-4 text-white hover:bg-slate-800" type="button">
                <Download className="h-4 w-4" /> Executive Excel
              </Button>
            </a>
            <a href={auditExportHref}>
              <Button className="min-h-11 gap-2 rounded border border-slate-300 bg-white px-4 text-slate-700 hover:bg-slate-50" type="button">
                <Download className="h-4 w-4" /> Coaching audit
              </Button>
            </a>
          </div>
        </div>
      )}

      {/* ── Tabs ───────────────────────────────────────────────────────── */}
      <div className="flex gap-0 overflow-x-auto rounded border border-slate-200 bg-white shadow-sm">
        {TABS.map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => setActiveTab(id)}
            className={[
              "flex items-center gap-2 whitespace-nowrap px-5 py-3 text-sm font-bold transition-colors",
              activeTab === id ? "border-b-2 border-phx-accent bg-orange-50 text-slate-950" : "text-slate-500 hover:bg-slate-50 hover:text-slate-700",
            ].join(" ")}
          >
            <Icon className="h-4 w-4" /> {label}
          </button>
        ))}
      </div>

      {/* ── Shared period + search bar (Managers / By MR tabs) ─ */}
      {(activeTab === "managers" || activeTab === "mr-status") && (
        <div className="flex flex-wrap items-center gap-3 rounded border border-slate-200 bg-white px-4 py-3 shadow-sm">
          <div className="flex overflow-hidden rounded border border-slate-200">
            {(["ALL", "AM", "PM", "Pharmacies"] as PeriodFilter[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPeriodFilter(p)}
                className={["px-4 py-2 text-xs font-black uppercase", periodFilter === p ? "bg-phx-accent text-white" : "bg-white text-slate-500 hover:bg-slate-50"].join(" ")}
              >
                {p === "ALL" ? "All Periods" : p}
              </button>
            ))}
          </div>
          {activeTab === "mr-status" && (
            <Input
              className="min-w-[220px] flex-1"
              placeholder="Search MR name, HR ID, or manager…"
              value={mrSearch}
              onChange={(e) => setMrSearch(e.target.value)}
            />
          )}
          {activeTab === "mr-status" && periodFilter !== "ALL" && (
            <span className="text-xs font-semibold text-slate-400">Period applies to each MR&apos;s expanded history.</span>
          )}
          {(periodFilter !== "ALL" || mrSearch) && (
            <button type="button" onClick={() => { setPeriodFilter("ALL"); setMrSearch(""); }} className="text-xs font-bold text-slate-400 underline hover:text-slate-700">
              Clear
            </button>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════
          SUMMARY TAB
      ═══════════════════════════════════════════════════════════════════ */}
      {activeTab === "summary" && (
        !dashboard.schemaReady ? (
          <Card className="rounded border border-slate-200 bg-white p-10 text-center shadow-sm">
            <Activity className="mx-auto h-12 w-12 text-slate-300" />
            <h2 className="mt-4 text-lg font-black text-slate-950">Visits Report not provisioned yet</h2>
            <p className="mx-auto mt-2 max-w-md text-sm font-medium text-slate-500">
              Double Visit Analytics reads live off the Visits Report (ireports360_visits) — that table isn&apos;t available in this environment yet.
            </p>
          </Card>
        ) : (
          <>
            {/* Headline KPI band */}
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <KpiCard icon={Activity} label="Double Visits" value={fmt(dashboard.kpis.totalVisits)} hint="Total visit count from official snapshot (you + the team reporting to you)." />
              {typeof ownDoubleVisits === "number" ? (
                <KpiCard icon={Activity} label="Your Double Visits" value={fmt(ownDoubleVisits)} hint="Double visits you personally performed. Your team's visits are counted in the total above." />
              ) : null}
              <KpiCard icon={CalendarDays} label="Active DV Days" value={fmt(dashboard.kpis.activeDoubleVisitDays)} hint="Distinct manager × date combinations." />
              <KpiCard icon={Users} label="Active Double-Visitors" value={fmt(activeManagerCount)} hint={`${idleCount} eligible manager${idleCount === 1 ? "" : "s"} did zero DVs.`} />
              <KpiCard icon={Gauge} label="Avg Calls / Day" value={fmt(dashboard.kpis.averageVisitsPerDoubleVisitDay)} hint="Visits per active double visit day." />
              <KpiCard icon={UsersRound} label="MR Coverage" value={fmt(dashboard.kpis.mrCoverageCount)} hint="Mapped MRs with at least one DV in range." />
              <KpiCard icon={Flame} label="Neglected MRs" value={fmt(weakMrs.length)} hint={`${criticalMrs.length} critical (≥60 days or 0 DVs/90d).`} />
              <KpiCard icon={Activity} label="AM Visits" value={fmt(dashboard.kpis.amVisitCount)} hint="Morning double visit workload." />
              <KpiCard icon={Activity} label="PM Visits" value={fmt(dashboard.kpis.pmVisitCount)} hint="Afternoon double visits to doctors — pharmacies are counted apart." />
              <KpiCard icon={Activity} label="Pharmacy Visits" value={kpiPharmacy.note ? kpiPharmacy.value : fmt(dashboard.kpis.pharmacyVisitCount ?? 0)} hint={kpiPharmacy.note ? `Double visits to pharmacies, never counted in AM or PM — ${kpiPharmacy.note}.` : "Double visits to pharmacies, never counted in AM or PM."} />
            </div>

            {/* Role rollups */}
            {executiveSummary && executiveSummary.roleRollups.length > 0 && (
              <div>
                <h2 className="flex items-center gap-2 text-lg font-black text-slate-950"><TrendingUp className="h-5 w-5" /> Effort by role</h2>
                <p className="mt-1 text-xs text-slate-500">Click a role to filter the leaderboard below.</p>
                <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {executiveSummary.roleRollups.map((rollup) => (
                    <RoleRollupCard
                      key={rollup.roleCode}
                      rollup={rollup}
                      active={roleFilter === rollup.roleCode}
                      onClick={() => setRoleFilter(roleFilter === rollup.roleCode ? "ALL" : rollup.roleCode)}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Auto-insights */}
            {executiveSummary && executiveSummary.insights.length > 0 && (
              <Card className="rounded border border-slate-200 bg-white p-0 shadow-sm">
                <div className="border-b border-slate-100 px-5 py-4">
                  <h2 className="flex items-center gap-2 text-lg font-black text-slate-950"><Sparkles className="h-5 w-5 text-phx-accent" /> What the report found</h2>
                  <p className="text-sm text-slate-500">Auto-generated findings from this snapshot.</p>
                </div>
                <div className="divide-y divide-slate-100">
                  {executiveSummary.insights.map((insight) => (
                    <div key={insight.id} className={`flex items-start gap-3 border-l-4 px-5 py-3 ${insightStripe(insight.severity)}`}>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-black text-slate-900">{insight.title}</p>
                        <p className="text-sm text-slate-600">{insight.detail}</p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        {insight.managerHrId && (
                          <button type="button" onClick={() => openManager(insight.managerHrId)} className="text-xs font-bold text-orange-700 underline hover:text-orange-800">Open manager</button>
                        )}
                        {insight.mrHrId && (
                          <button type="button" onClick={() => focusMrByHrId(insight.mrHrId)} className="text-xs font-bold text-orange-700 underline hover:text-orange-800">Open MR</button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {/* Idle managers */}
            {executiveSummary && executiveSummary.idleManagers.length > 0 && (
              <Card className="rounded border border-rose-200 bg-rose-50 p-0 shadow-sm">
                <div className="border-b border-rose-200 px-5 py-4">
                  <h2 className="text-base font-black text-rose-800">{executiveSummary.idleManagers.length} Manager{executiveSummary.idleManagers.length !== 1 ? "s" : ""} Did Zero Double Visits</h2>
                  <p className="text-sm text-rose-600">Eligible DSM/RM/NSM/PM/GPM/TM with no DV activity in this snapshot.</p>
                </div>
                <div className="px-5 py-3">
                  <div className="flex flex-wrap gap-2">
                    {executiveSummary.idleManagers.map((m) => (
                      <span key={m.hrId} className="inline-flex items-center gap-1.5 rounded border border-rose-200 bg-white px-2 py-1 text-xs font-semibold text-rose-700">
                        <RoleBadge role={m.roleCode} /> {m.name}
                      </span>
                    ))}
                  </div>
                </div>
              </Card>
            )}

            {/* Leaderboard */}
            <Card className="rounded border border-slate-200 bg-white p-0 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
                <div>
                  <h2 className="text-lg font-black text-slate-950">Manager leaderboard</h2>
                  <p className="text-sm text-slate-500">Every double-visitor — sort by any column, filter by role, click a row for the full profile.</p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <RoleFilterBar value={roleFilter} options={availableRoles} onChange={setRoleFilter} />
                  <span className="rounded bg-slate-100 px-3 py-1 text-sm font-black text-slate-600">{leaderboardRows.length} {leaderboardRows.length === 1 ? "manager" : "managers"}</span>
                </div>
              </div>
              <PortalResponsiveDataList
                breakpoint="lg"
                empty={
                  <PortalEmptyState
                    title="No double-visitors"
                    message={`No double-visitors${roleFilter !== "ALL" ? ` for ${roleFilter}` : ""} in this snapshot.`}
                  />
                }
                getKey={(row) => row.managerHrId}
                items={leaderboardRows}
                renderCard={(row, index) => (
                  <LeaderboardCard row={row} rank={index + 1} maxDvs={leaderboardMaxDvs} onOpen={openManager} />
                )}
                renderTable={() => (
                  <PortalDesktopTable
                    breakpoint="lg"
                    cols={
                      <colgroup>
                        <col className="w-[4%]" />
                        <col className="w-[16%]" />
                        <col className="w-[8%]" />
                        <col className="w-[12%]" />
                        <col className="w-[8%]" />
                        <col className="w-[8%]" />
                        <col className="w-[8%]" />
                        <col className="w-[9%]" />
                        <col className="w-[9%]" />
                        <col className="w-[9%]" />
                        <col className="w-[9%]" />
                      </colgroup>
                    }
                  >
                    <thead className="sticky top-0 bg-slate-50 text-xs font-black uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-3 py-3">#</th>
                        <SortHeader label="Manager" field="name" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                        <th className="px-3 py-3">Role</th>
                        <SortHeader label="DVs" field="totalDvs" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                        <SortHeader label="Active Days" field="activeDvDays" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} align="right" />
                        <SortHeader label="Calls/Day" field="callsPerActiveDay" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} align="right" />
                        <SortHeader label="MRs / Team" field="distinctMrs" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} align="right" />
                        <SortHeader label="Coverage" field="coveragePct" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                        <SortHeader label="Concentration" field="concentrationPct" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} align="right" />
                        <th className="px-3 py-3">AM · PM · Pharmacies</th>
                        <SortHeader label="Last Visit" field="daysSinceLastDv" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                      </tr>
                    </thead>
                    <tbody>
                      {leaderboardRows.map((row, index) => (
                        <tr key={row.managerHrId} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50" onClick={() => openManager(row.managerHrId)}>
                          <td className="px-3 py-2.5 text-sm font-bold tabular-nums text-slate-400">{index + 1}</td>
                          <td className="px-3 py-2.5">
                            <p className="text-sm font-bold text-slate-800">{row.managerName}</p>
                          </td>
                          <td className="px-3 py-2.5"><RoleBadge role={row.roleCode} /></td>
                          <td className="px-3 py-2.5">
                            <div className="flex items-center gap-2">
                              <div className="relative h-2 w-16 bg-slate-100">
                                <div className="absolute inset-y-0 left-0 bg-phx-accent" style={{ width: `${leaderboardMaxDvs ? (row.totalDvs / leaderboardMaxDvs) * 100 : 0}%` }} />
                              </div>
                              <span className="text-sm font-black tabular-nums text-slate-950">{row.totalDvs}</span>
                            </div>
                          </td>
                          <td className="px-3 py-2.5 text-right text-sm tabular-nums text-slate-700">{row.activeDvDays}</td>
                          <td className="px-3 py-2.5 text-right text-sm font-bold tabular-nums text-slate-800">{fmt(row.callsPerActiveDay)}</td>
                          <td className="px-3 py-2.5 text-right text-sm tabular-nums text-slate-700">
                            {row.distinctMrs} <span className="text-slate-400">/ {row.teamMrCount ?? "—"}</span>
                          </td>
                          <td className="px-3 py-2.5">
                            <span className={`rounded px-2 py-0.5 text-xs font-black ${coverageClass(row.coveragePct)}`}>{row.coveragePct != null ? `${row.coveragePct}%` : "—"}</span>
                          </td>
                          <td className={`px-3 py-2.5 text-right text-sm font-bold tabular-nums ${row.concentrationPct != null && row.concentrationPct >= 60 ? "text-orange-600" : "text-slate-600"}`}>
                            {row.concentrationPct != null ? `${row.concentrationPct}%` : "—"}
                          </td>
                          <td className="px-3 py-2.5">
                            <div className="w-24"><AmPmBar am={row.amVisits} pharmacies={row.pharmacyVisits} phoenix={row.phoenixVisits} pm={row.pmVisits} /></div>
                          </td>
                          <td className="px-3 py-2.5 text-sm text-slate-600">
                            {fmtDate(row.lastDvDate)}
                            {row.daysSinceLastDv != null && <span className="block text-xs text-slate-400">{row.daysSinceLastDv}d ago</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </PortalDesktopTable>
                )}
              />
            </Card>

            {/* Heatmaps */}
            <div className="grid gap-4 xl:grid-cols-2">
              <Card className="rounded border border-slate-200 bg-white p-5 shadow-sm">
                <h2 className="flex items-center gap-2 text-lg font-black text-slate-950"><MapPinned className="h-5 w-5" /> Area heatmap</h2>
                <p className="mt-1 text-xs text-slate-500">Coverage from active MRs in scope.</p>
                <div className="mt-4 grid gap-2">
                  {dashboard.heatmap.byArea.length === 0 && <p className="text-sm text-slate-400">No coverage data in range.</p>}
                  {dashboard.heatmap.byArea.slice(0, 20).map((row) => (
                    <div key={row.label} className="grid grid-cols-[1fr_100px_80px] items-center gap-3 rounded border border-slate-100 px-3 py-2">
                      <span className="min-w-0 break-words text-sm font-semibold text-slate-800">{row.label}</span>
                      <div className="relative h-2 rounded bg-slate-100">
                        <div className="absolute left-0 top-0 h-2 rounded bg-phx-accent" style={{ width: `${Math.min(100, row.coveragePercent ?? 0)}%` }} />
                      </div>
                      <span className="text-right text-sm font-bold text-slate-700">{row.coveragePercent ?? 0}%</span>
                    </div>
                  ))}
                </div>
              </Card>
              <Card className="rounded border border-slate-200 bg-white p-5 shadow-sm">
                <h2 className="flex items-center gap-2 text-lg font-black text-slate-950"><MapPinned className="h-5 w-5" /> Line heatmap</h2>
                <p className="mt-1 text-xs text-slate-500">Every scoped line shown, 0% when no DV activity.</p>
                <div className="mt-4 grid gap-2">
                  {dashboard.heatmap.byLine.length === 0 && <p className="text-sm text-slate-400">No coverage data in range.</p>}
                  {dashboard.heatmap.byLine.slice(0, 20).map((row) => (
                    <div key={row.label} className="grid grid-cols-[1fr_100px_80px] items-center gap-3 rounded border border-slate-100 px-3 py-2">
                      <span className="min-w-0 break-words text-sm font-semibold text-slate-800">{row.label}</span>
                      <div className="relative h-2 rounded bg-slate-100">
                        <div className="absolute left-0 top-0 h-2 rounded bg-phx-accent" style={{ width: `${Math.min(100, row.coveragePercent ?? 0)}%` }} />
                      </div>
                      <span className="text-right text-sm font-bold text-slate-700">{row.coveragePercent ?? 0}%</span>
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          </>
        )
      )}

      {/* ═══════════════════════════════════════════════════════════════════
          BY MANAGER TAB
      ═══════════════════════════════════════════════════════════════════ */}
      {activeTab === "managers" && (
        <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
          {/* Manager list */}
          <Card className="rounded border border-slate-200 bg-white p-0 shadow-sm self-start max-h-[calc(100vh-220px)] overflow-auto">
            <div className="border-b border-slate-100 px-4 py-3">
              <h2 className="text-sm font-black uppercase tracking-wide text-slate-500">Managers ({managerList.length})</h2>
              <p className="text-phx-xs font-semibold text-slate-400">Ranked by total DVs (all periods)</p>
              {availableRoles.length > 0 && (
                <div className="mt-2"><RoleFilterBar value={roleFilter} options={availableRoles} onChange={setRoleFilter} /></div>
              )}
            </div>
            {managerList.map((m) => {
              const mKey = hk(m.managerHrId);
              return (
                <button
                  key={m.managerHrId}
                  type="button"
                  onClick={() => setSelectedManagerKey(selectedManagerKey === mKey ? "" : mKey)}
                  className={[
                    "w-full border-t border-slate-100 px-4 py-3 text-left transition-colors hover:bg-slate-50",
                    selectedManagerKey === mKey ? "bg-orange-50 border-l-2 border-l-phx-accent" : "",
                  ].join(" ")}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="min-w-0 break-words text-sm font-bold text-slate-800">{m.managerName}</p>
                    <RoleBadge role={summaryByKey.get(mKey)?.roleCode ?? null} />
                  </div>
                  <div className="mt-1.5 flex items-center gap-3">
                    <span className="text-xs font-semibold text-slate-600">{fmt(m.actualDvs)} DVs</span>
                    <span className="text-xs text-slate-400">·</span>
                    <span className="text-xs font-semibold text-slate-600">{m.actualMrs} MRs</span>
                    {m.lastDate && (
                      <>
                        <span className="text-xs text-slate-400">·</span>
                        <span className="text-xs text-slate-500">{fmtDate(m.lastDate)}</span>
                      </>
                    )}
                  </div>
                </button>
              );
            })}
            {managerList.length === 0 && (
              <p className="px-4 py-6 text-sm text-slate-400">No managers{roleFilter !== "ALL" ? ` for ${roleFilter}` : ""} in range.</p>
            )}
          </Card>

          {/* Manager profile panel */}
          <div className="space-y-4">
            {!selectedManagerKey ? (
              <Card className="rounded border border-slate-200 bg-white p-8 text-center shadow-sm">
                <Users className="mx-auto h-10 w-10 text-slate-300" />
                <p className="mt-3 text-sm font-semibold text-slate-500">Select a manager on the left to see their full DV profile.</p>
              </Card>
            ) : managerProfile ? (
              <>
                {/* Identity */}
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-xl font-black text-slate-950">{selectedName}</h2>
                    <RoleBadge role={selectedSummary?.roleCode ?? null} />
                  </div>
                  <p className="text-sm text-slate-500">
                    {[selectedSummary?.role, periodLabel ? `${periodLabel} breakdown` : null].filter(Boolean).join(" · ")}
                  </p>
                </div>

                {/* Stat summary (always all-period; from server when available) */}
                <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
                  <StatChip label="Total DVs" value={fmt(selectedSummary?.totalDvs ?? managerProfile.totalVisits)} />
                  <StatChip label="Active DV Days" value={fmt(selectedSummary?.activeDvDays ?? 0)} />
                  <StatChip label="Calls / Day" value={fmt(selectedSummary?.callsPerActiveDay ?? 0)} />
                  <StatChip label="MRs Visited" value={String(selectedSummary?.distinctMrs ?? managerProfile.visitedCount)} />
                  <StatChip label="Coverage" value={selectedSummary?.coveragePct != null ? `${selectedSummary.coveragePct}%` : "—"} sub={selectedSummary?.teamMrCount != null ? `${selectedSummary.distinctMrs} of ${selectedSummary.teamMrCount} team` : undefined} />
                  <StatChip span label="Last Visit" value={fmtDate(selectedSummary?.lastDvDate ?? managerProfile.lastDate)} sub={(selectedSummary?.lastDvDate ?? managerProfile.lastDate) ? `${daysBetween(selectedSummary?.lastDvDate ?? managerProfile.lastDate) ?? "—"} days ago` : undefined} />
                </div>
                {periodLabel ? (
                  <p className="-mt-1 text-xs font-semibold text-slate-400">Headline stats above cover all periods; the {periodLabel} filter applies to the MR breakdown below.</p>
                ) : null}

                {/* AM · PM · Pharmacies + concentration / focus signal */}
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-2">
                    <span className="text-phx-xs font-bold uppercase tracking-wide text-slate-400">AM {selectedSummary?.amVisits ?? managerProfile.amVisits} · PM {selectedSummary?.pmVisits ?? managerProfile.pmVisits} · {formatPharmacyFigure(figureSplit(selectedSummary?.amVisits ?? managerProfile.amVisits, selectedSummary?.pmVisits ?? managerProfile.pmVisits, selectedSummary?.pharmacyVisits ?? managerProfile.pharmacyVisits, selectedSummary ? selectedSummary.phoenixVisits : managerProfile.phoenixVisits))}</span>
                    <div className="w-28"><AmPmBar am={selectedSummary?.amVisits ?? managerProfile.amVisits} pharmacies={selectedSummary?.pharmacyVisits ?? managerProfile.pharmacyVisits} phoenix={selectedSummary ? selectedSummary.phoenixVisits : managerProfile.phoenixVisits} pm={selectedSummary?.pmVisits ?? managerProfile.pmVisits} /></div>
                  </div>
                  {selectedSummary?.teamMrCount != null && (
                    <MiniStat tone="orange" value={`${selectedSummary.distinctMrs}/${selectedSummary.teamMrCount}`} label="team MRs visited" />
                  )}
                  {managerProfile.mrBreakdown.length > 0 && (
                    <MiniStat tone="orange" value={`${managerProfile.concentrationPct}%`} label={`of DVs on top ${managerProfile.topN}`} />
                  )}
                  {managerProfile.overFocusedKeys.size > 0 && (
                    <MiniStat tone="orange" value={String(managerProfile.overFocusedKeys.size)} label="over-focused" />
                  )}
                  {managerProfile.neglectedMrs.length > 0 && (
                    <MiniStat tone="rose" value={String(managerProfile.neglectedMrs.length)} label="not visited" />
                  )}
                </div>

                {/* MR visit breakdown */}
                <Card className="rounded border border-slate-200 bg-white p-0 shadow-sm">
                  <div className="border-b border-slate-100 px-5 py-4">
                    <h3 className="text-base font-black text-slate-950">
                      MRs Visited{periodLabel ? ` — ${periodLabel} only` : ""} · sorted by visit count
                    </h3>
                    <p className="text-sm text-slate-500">Visits = total calls; Days = distinct dates; Visits/Day shows intensity (e.g. 29 visits across 6 days). Resigned-rep territories are listed separately below.</p>
                  </div>
                  <PortalResponsiveDataList
                    breakpoint="lg"
                    empty={
                      <PortalEmptyState
                        title="No visits recorded"
                        message={`No visits recorded${periodLabel ? ` for ${periodLabel}` : ""}.`}
                      />
                    }
                    getKey={(row) => row.key}
                    items={managerProfile.mrBreakdown}
                    renderCard={(row) => (
                      <MrBreakdownCard
                        row={row}
                        maxVisits={managerProfile.maxVisits}
                        overFocused={managerProfile.overFocusedKeys.has(row.key)}
                      />
                    )}
                    renderTable={() => (
                      <div className="max-h-[480px] overflow-y-auto">
                        <PortalDesktopTable
                          breakpoint="lg"
                          cols={
                            <colgroup>
                              <col className="w-[18%]" />
                              <col className="w-[16%]" />
                              <col className="w-[8%]" />
                              <col className="w-[10%]" />
                              <col className="w-[16%]" />
                              <col className="w-[8%]" />
                              <col className="w-[8%]" />
                              <col className="w-[8%]" />
                              <col className="w-[8%]" />
                            </colgroup>
                          }
                        >
                          <thead className="sticky top-0 bg-slate-50 text-xs font-black uppercase tracking-wide text-slate-500">
                            <tr>
                              <th className="px-3 py-3">MR</th>
                              <th className="px-3 py-3">Visits</th>
                              <th className="px-3 py-3 text-right">Days</th>
                              <th className="px-3 py-3 text-right">Visits/Day</th>
                              <th className="px-3 py-3">Span</th>
                              <th className="px-3 py-3 text-right">AM</th>
                              <th className="px-3 py-3 text-right">PM</th>
                              <th className="px-3 py-3 text-right">Pharmacies</th>
                              <th className="px-3 py-3">Band</th>
                            </tr>
                          </thead>
                          <tbody>
                            {managerProfile.mrBreakdown.map((row) => (
                              <tr key={row.key} className="border-t border-slate-100">
                                <td className="px-3 py-2.5">
                                  <p className="text-sm font-semibold text-slate-800">{row.name}</p>
                                  {row.area ? <p className="break-words text-xs text-slate-400">{row.area}</p> : null}
                                </td>
                                <td className="px-3 py-2.5">
                                  <div className="flex items-center gap-2">
                                    <div className="relative h-2 w-20 bg-slate-100">
                                      <div className="absolute inset-y-0 left-0 bg-phx-accent" style={{ width: `${managerProfile.maxVisits ? (row.visits / managerProfile.maxVisits) * 100 : 0}%` }} />
                                    </div>
                                    <span className="text-sm font-black tabular-nums text-slate-950">{row.visits}</span>
                                    {managerProfile.overFocusedKeys.has(row.key) && (
                                      <span className="rounded bg-orange-100 px-1.5 py-0.5 text-phx-2xs font-black uppercase text-orange-700">Over-focused</span>
                                    )}
                                  </div>
                                </td>
                                <td className="px-3 py-2.5 text-right text-sm font-bold tabular-nums text-slate-800">{row.days}</td>
                                <td className={`px-3 py-2.5 text-right text-sm tabular-nums ${row.visitsPerDay > 4 ? "font-black text-orange-600" : "text-slate-600"}`}>{fmt(row.visitsPerDay)}</td>
                                <td className="px-3 py-2.5 text-xs text-slate-500">{fmtDate(row.firstDate)} – {fmtDate(row.lastDate)}</td>
                                <td className="px-3 py-2.5 text-right text-sm tabular-nums text-orange-600">{row.am > 0 ? row.am : <span className="text-slate-300">—</span>}</td>
                                <td className="px-3 py-2.5 text-right text-sm tabular-nums text-slate-600">{row.pm > 0 ? row.pm : <span className="text-slate-300">—</span>}</td>
                                <td className="px-3 py-2.5 text-right text-sm tabular-nums text-emerald-700">{pharmacyCellContent(figureSplit(row.am, row.pm, row.pharmacies, row.phoenix))}</td>
                                <td className="px-3 py-2.5">
                                  {row.score ? (
                                    <span className={`rounded px-2 py-0.5 text-xs font-black uppercase ring-1 ${bandClass(row.score.band)}`}>{row.score.band}</span>
                                  ) : <span className="text-xs text-slate-400">—</span>}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </PortalDesktopTable>
                      </div>
                    )}
                  />
                </Card>

                {/* Resigned / vacant-territory visits — resigned reps' accounts renamed to their area */}
                {managerProfile.vacantTerritories.length > 0 && (
                  <Card className="rounded border border-slate-200 bg-white p-0 shadow-sm">
                    <div className="border-b border-slate-100 px-5 py-4">
                      <h3 className="text-base font-black text-slate-950">Resigned / Vacant Territory · {fmt(managerProfile.vacantVisits)} visits</h3>
                      <p className="text-sm text-slate-500">Visits to territories whose rep resigned (the CRM renames the account to the area). These are real effort — already counted in this manager&apos;s Total DVs above — but there is no active MR to credit, so they are listed by territory exactly as recorded.</p>
                    </div>
                    <PortalResponsiveDataList
                      empty={<PortalEmptyState title="No vacant territories" message="No resigned/vacant territory visits in this period." />}
                      getKey={(row) => row.key}
                      items={managerProfile.vacantTerritories}
                      renderCard={(row) => <VacantTerritoryCard row={row} />}
                      renderTable={() => (
                        <div className="max-h-[320px] overflow-y-auto">
                          <PortalDesktopTable
                            cols={
                              <colgroup>
                                <col className="w-[28%]" />
                                <col className="w-[12%]" />
                                <col className="w-[12%]" />
                                <col className="w-[12%]" />
                                <col className="w-[12%]" />
                                <col className="w-[12%]" />
                                <col className="w-[12%]" />
                              </colgroup>
                            }
                          >
                            <thead className="sticky top-0 bg-slate-50 text-xs font-black uppercase tracking-wide text-slate-500">
                              <tr>
                                <th className="px-3 py-3">Territory (as recorded)</th>
                                <th className="px-3 py-3 text-right">Visits</th>
                                <th className="px-3 py-3 text-right">Days</th>
                                <th className="px-3 py-3 text-right">AM</th>
                                <th className="px-3 py-3 text-right">PM</th>
                                <th className="px-3 py-3 text-right">Pharmacies</th>
                                <th className="px-3 py-3">Span</th>
                              </tr>
                            </thead>
                            <tbody>
                              {managerProfile.vacantTerritories.map((row) => (
                                <tr key={row.key} className="border-t border-slate-100">
                                  <td className="px-3 py-2.5">
                                    <span className="text-sm font-semibold text-slate-800">{territoryLabel(row)}</span>
                                    <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-phx-2xs font-black uppercase text-slate-500">Resigned / vacant</span>
                                  </td>
                                  <td className="px-3 py-2.5 text-right text-sm font-black tabular-nums text-slate-950">{row.visits}</td>
                                  <td className="px-3 py-2.5 text-right text-sm tabular-nums text-slate-700">{row.days}</td>
                                  <td className="px-3 py-2.5 text-right text-sm tabular-nums text-orange-600">{row.am > 0 ? row.am : <span className="text-slate-300">—</span>}</td>
                                  <td className="px-3 py-2.5 text-right text-sm tabular-nums text-slate-600">{row.pm > 0 ? row.pm : <span className="text-slate-300">—</span>}</td>
                                  <td className="px-3 py-2.5 text-right text-sm tabular-nums text-emerald-700">{pharmacyCellContent(figureSplit(row.am, row.pm, row.pharmacies, row.phoenix))}</td>
                                  <td className="px-3 py-2.5 text-xs text-slate-500">{fmtDate(row.firstDate)} – {fmtDate(row.lastDate)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </PortalDesktopTable>
                        </div>
                      )}
                    />
                  </Card>
                )}

                {/* Neglected MRs (his whole team, not visited — owner, 2026-10-20) */}
                {managerProfile.neglectedMrs.length > 0 && (
                  <Card className="rounded border border-rose-200 bg-rose-50 p-0 shadow-sm">
                    <div className="border-b border-rose-200 px-5 py-4">
                      <h3 className="text-base font-black text-rose-800">
                        {managerProfile.neglectedMrs.length} Team MR{managerProfile.neglectedMrs.length !== 1 ? "s" : ""} Not Visited
                      </h3>
                      <p className="text-sm text-rose-600">These MRs are in this manager&apos;s team but received zero DVs in the current snapshot. Click one to see its history.</p>
                    </div>
                    <div className="px-5 py-3">
                      <div className="flex flex-wrap gap-2">
                        {managerProfile.neglectedMrs.map((m) => (
                          <button
                            key={m.hrId}
                            type="button"
                            onClick={() => focusMr(m)}
                            className="rounded border border-rose-200 bg-white px-2 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-100"
                          >
                            {m.mrName}
                          </button>
                        ))}
                      </div>
                    </div>
                  </Card>
                )}
              </>
            ) : null}
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════
          BY MR TAB
      ═══════════════════════════════════════════════════════════════════ */}
      {activeTab === "mr-status" && (
        <Card className="rounded border border-slate-200 bg-white p-0 shadow-sm">
          <div className="flex items-center justify-between gap-4 border-b border-slate-100 px-5 py-4">
            <div>
              <h2 className="text-lg font-black text-slate-950">MR Support Score</h2>
              <p className="text-sm text-slate-500">Click any row to expand visit history. Total DVs · 90-day frequency · last DV · days since · visitor diversity.</p>
            </div>
            <span className="rounded bg-slate-100 px-3 py-1 text-sm font-black text-slate-600">
              {filteredMrScores.length} MRs
            </span>
          </div>
          <PortalResponsiveDataList
            breakpoint="lg"
            empty={
              <PortalEmptyState
                title={mrSearch ? "No matches" : "No MRs"}
                message={mrSearch ? "No MRs match your search — clear it to see all." : "No MRs in this snapshot."}
              />
            }
            getKey={(score) => score.hrId}
            items={filteredMrScores}
            renderCard={(score) => {
              const sKey = hk(score.hrId);
              return (
                <MrScoreCard
                  score={score}
                  visitLog={visitLog}
                  periodFilter={periodFilter}
                  open={expandedMrKeys.has(sKey)}
                  onToggle={() => toggleMr(sKey)}
                  onSelectManager={openManager}
                />
              );
            }}
            renderTable={() => (
              <PortalDesktopTable
                breakpoint="lg"
                cols={
                  <colgroup>
                    <col className="w-[4%]" />
                    <col className="w-[18%]" />
                    <col className="w-[11%]" />
                    <col className="w-[14%]" />
                    <col className="w-[9%]" />
                    <col className="w-[9%]" />
                    <col className="w-[11%]" />
                    <col className="w-[6%]" />
                    <col className="w-[10%]" />
                    <col className="w-[8%]" />
                  </colgroup>
                }
              >
                <thead className="sticky top-0 bg-slate-50 text-xs font-black uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="w-8 px-3 py-3" />
                    <th className="px-3 py-3">MR</th>
                    <th className="px-3 py-3">Hire Date</th>
                    <th className="px-3 py-3">Manager</th>
                    <th className="px-3 py-3 text-right">Total DVs</th>
                    <th className="px-3 py-3 text-right">DVs (90d)</th>
                    <th className="px-3 py-3">Last DV</th>
                    <th className="px-3 py-3 text-right">Days</th>
                    <th className="px-3 py-3">Last By</th>
                    <th className="px-3 py-3">Band</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredMrScores.map((score) => {
                    const sKey = hk(score.hrId);
                    return (
                      <ExpandableMrRow
                        key={score.hrId}
                        score={score}
                        visitLog={visitLog}
                        periodFilter={periodFilter}
                        open={expandedMrKeys.has(sKey)}
                        onToggle={() => toggleMr(sKey)}
                        onSelectManager={openManager}
                      />
                    );
                  })}
                </tbody>
              </PortalDesktopTable>
            )}
          />
        </Card>
      )}

      {/* ═══════════════════════════════════════════════════════════════════
          TRENDS TAB
      ═══════════════════════════════════════════════════════════════════ */}
      {activeTab === "trends" && (
        <>
          <Card className="rounded border border-slate-200 bg-white p-0 shadow-sm">
            <div className="border-b border-slate-100 px-5 py-4">
              <h2 className="flex items-center gap-2 text-lg font-black text-slate-950"><TrendingUp className="h-5 w-5" /> Weekly double-visit trend</h2>
              <p className="text-sm text-slate-500">Total DVs, the AM · PM · Pharmacies split, and MR coverage by ISO week within the selected range.</p>
            </div>
            <PortalResponsiveDataList
              empty={<PortalEmptyState title="No trend data" message="No double visits in this range." />}
              getKey={(week) => week.weekStart}
              items={dashboard.trend}
              renderCard={(week) => <TrendCard week={week} />}
              renderTable={() => (
                <PortalDesktopTable
                  cols={
                    <colgroup>
                      <col className="w-[28%]" />
                      <col className="w-[22%]" />
                      <col className="w-[28%]" />
                      <col className="w-[22%]" />
                    </colgroup>
                  }
                >
                  <thead className="bg-slate-50 text-xs font-black uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-3 py-3">Week Of</th>
                      <th className="px-3 py-3 text-right">Total DVs</th>
                      <th className="px-3 py-3">AM · PM · Pharmacies</th>
                      <th className="px-3 py-3 text-right">MRs Covered</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dashboard.trend.map((week) => (
                      <tr key={week.weekStart} className="border-t border-slate-100">
                        <td className="px-3 py-2.5 font-semibold text-slate-800">{fmtDate(week.weekStart)}</td>
                        <td className="px-3 py-2.5 text-right font-black tabular-nums text-slate-950">{fmt(week.totalDvs)}</td>
                        <td className="px-3 py-2.5"><div className="w-28"><AmPmBar am={week.amVisits} pharmacies={week.pharmacyVisits} phoenix={week.phoenixVisits} pm={week.pmVisits} /></div></td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">{week.distinctMrs}</td>
                      </tr>
                    ))}
                  </tbody>
                </PortalDesktopTable>
              )}
            />
          </Card>

          <Card className="rounded border border-slate-200 bg-white p-0 shadow-sm">
            <div className="border-b border-slate-100 px-5 py-4">
              <h2 className="flex items-center gap-2 text-lg font-black text-slate-950"><Flame className="h-5 w-5 text-rose-500" /> Neglected MRs ({dashboard.neglectedMrs.length})</h2>
              <p className="text-sm text-slate-500">Warning/critical band — click a row to open the MR&apos;s full history. Trend compares the current vs prior 90-day window.</p>
            </div>
            <PortalResponsiveDataList
              empty={<PortalEmptyState title="No neglected MRs" message="No neglected MRs in this range." />}
              getKey={(score) => score.hrId}
              items={dashboard.neglectedMrs}
              renderCard={(score) => <NeglectedMrCard score={score} onOpen={focusMr} />}
              renderTable={() => (
                <PortalDesktopTable
                  cols={
                    <colgroup>
                      <col className="w-[24%]" />
                      <col className="w-[20%]" />
                      <col className="w-[12%]" />
                      <col className="w-[12%]" />
                      <col className="w-[16%]" />
                      <col className="w-[16%]" />
                    </colgroup>
                  }
                >
                  <thead className="bg-slate-50 text-xs font-black uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-3 py-3">MR</th>
                      <th className="px-3 py-3">Manager</th>
                      <th className="px-3 py-3 text-right">Last 90d</th>
                      <th className="px-3 py-3 text-right">Prev 90d</th>
                      <th className="px-3 py-3">Trend</th>
                      <th className="px-3 py-3">Band</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dashboard.neglectedMrs.map((score) => (
                      <tr key={score.hrId} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50" onClick={() => focusMr(score)}>
                        <td className="px-3 py-2.5">
                          <p className="font-semibold text-slate-800">{score.mrName}</p>
                          {score.areaName ? <p className="break-words text-xs text-slate-400">{score.areaName}</p> : null}
                        </td>
                        <td className="px-3 py-2.5 text-slate-600">{score.managerName ?? "—"}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums font-bold text-slate-800">{score.dvsLast90Days}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-slate-500">{score.dvsPrev90Days}</td>
                        <td className="px-3 py-2.5">
                          {score.trendDirection === "improving" ? (
                            <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-600"><TrendingUp className="h-3.5 w-3.5" /> Improving</span>
                          ) : score.trendDirection === "declining" ? (
                            <span className="inline-flex items-center gap-1 text-xs font-bold text-rose-600"><TrendingDown className="h-3.5 w-3.5" /> Declining</span>
                          ) : (
                            <span className="text-xs font-semibold text-slate-400">Flat</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          <span className={`rounded px-2 py-1 text-xs font-black uppercase ring-1 ${bandClass(score.band)}`}>{score.band}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </PortalDesktopTable>
              )}
            />
          </Card>
        </>
      )}
    </div>
  );
}
