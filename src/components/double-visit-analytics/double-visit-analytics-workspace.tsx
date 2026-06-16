"use client";

import { useMemo, useState } from "react";
import {
  Activity,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Download,
  FileSpreadsheet,
  Flame,
  Gauge,
  MapPinned,
  RefreshCcw,
  Sparkles,
  TrendingUp,
  Upload,
  User,
  Users,
  UsersRound,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { canonicalHrIdKey } from "@/lib/hr-id";
import type {
  DoubleVisitDashboardData,
  DoubleVisitImportListItem,
  DoubleVisitInsight,
  DoubleVisitLogEntry,
  DoubleVisitManagerSummary,
  DoubleVisitMrScore,
  DoubleVisitRoleCode,
  DoubleVisitRoleRollup,
} from "@/lib/double-visit-analytics/types";

type Tab = "summary" | "managers" | "mr-status" | "imports";
type PeriodFilter = "ALL" | "AM" | "PM";
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

function fmtDate(v: string | null | undefined) {
  if (!v) return "—";
  const d = new Date(`${v.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? v
    : new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(d);
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

// AM/PM two-tone kept on-brand: AM = orange accent, PM = neutral slate.
function periodPillClass(p: "AM" | "PM" | "UNKNOWN") {
  if (p === "AM") return "bg-orange-100 text-orange-700";
  if (p === "PM") return "bg-slate-200 text-slate-700";
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
  return <span className={`rounded px-2 py-0.5 text-[10px] font-black uppercase tracking-wide ${tone}`}>{role ?? "—"}</span>;
}

function AmPmBar({ am, pm }: { am: number; pm: number }) {
  const total = am + pm;
  const amPct = total > 0 ? (am / total) * 100 : 0;
  return (
    <div className="flex h-2 w-full overflow-hidden bg-slate-100" title={`AM ${am} · PM ${pm}`}>
      <div className="h-2 bg-[#F97316]" style={{ width: `${amPct}%` }} />
      <div className="h-2 bg-slate-400" style={{ width: `${100 - amPct}%` }} />
    </div>
  );
}

function StatChip({ label, value, sub, span }: { label: string; span?: boolean; sub?: string; value: string }) {
  return (
    <div className={["rounded border border-slate-200 bg-slate-50 px-4 py-3", span ? "col-span-2 sm:col-span-1" : ""].join(" ")}>
      <p className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-400">{label}</p>
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
          <p className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">{label}</p>
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
      <span className="text-[11px] font-semibold uppercase tracking-wide opacity-80">{label}</span>
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
          className={["px-3.5 py-2 text-xs font-black uppercase", value === option ? "bg-[#F97316] text-white" : "bg-white text-slate-500 hover:bg-slate-50"].join(" ")}
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
      <button type="button" onClick={() => onSort(field)} className={`inline-flex items-center gap-1 ${active ? "text-[#F97316]" : ""}`}>
        {label}
        {active ? (sortDir === "asc" ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />) : null}
      </button>
    </th>
  );
}

function ImportRow({
  item,
  onPublish,
  publishingId,
}: {
  item: DoubleVisitImportListItem;
  onPublish: (id: string) => void;
  publishingId: string | null;
}) {
  return (
    <tr className="border-t border-slate-100">
      <td className="px-3 py-3 text-sm font-semibold text-slate-800">{item.sourceFilename}</td>
      <td className="px-3 py-3 text-sm text-slate-600">{item.sourceType}</td>
      <td className="px-3 py-3 text-sm text-slate-600">{fmtDate(item.dateFrom)} – {fmtDate(item.dateTo)}</td>
      <td className="px-3 py-3 text-sm font-semibold text-slate-800">{fmt(item.totalVisits)}</td>
      <td className="px-3 py-3">
        <span className={["rounded px-2 py-1 text-xs font-black uppercase", item.status === "published" ? "bg-emerald-50 text-emerald-700" : item.status === "superseded" ? "bg-slate-100 text-slate-500" : "bg-amber-50 text-amber-700"].join(" ")}>
          {item.status}
        </span>
      </td>
      <td className="px-3 py-3 text-right">
        <Button className="min-h-9 rounded border border-slate-200 bg-white px-3 text-slate-700 hover:bg-slate-50" disabled={item.status === "published" || publishingId === item.id} onClick={() => onPublish(item.id)} type="button">
          {publishingId === item.id ? "Publishing…" : "Publish"}
        </Button>
      </td>
    </tr>
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
) {
  // All-period rows for this manager — drives the stable summary chips.
  const allRows = visitLog.filter((e) => hk(e.doubleVisitorHrId) === managerKey);
  const totalVisits = allRows.reduce((s, e) => s + e.visitCount, 0);
  const amVisits = allRows.filter((e) => e.period === "AM").reduce((s, e) => s + e.visitCount, 0);
  const pmVisits = allRows.filter((e) => e.period === "PM").reduce((s, e) => s + e.visitCount, 0);
  const lastDate = [...new Set(allRows.map((e) => e.date))].sort().at(-1) ?? null;

  // All-period visited set — an MR visited in any period is NOT neglected.
  const visitedKeysAll = new Set(allRows.map((e) => hk(e.visitedHrId)).filter(Boolean));

  // Period-scoped rows reshape only the breakdown table below the chips.
  const scopedRows = periodFilter === "ALL" ? allRows : allRows.filter((e) => e.period === periodFilter);

  const byMr = new Map<string, MrVisitRow>();
  for (const row of scopedRows) {
    const key = hk(row.visitedHrId) || `name:${row.visitedName ?? "unknown"}`;
    const existing =
      byMr.get(key) ??
      { am: 0, area: row.area, dates: new Set<string>(), days: 0, firstDate: null, hrId: row.visitedHrId, key, lastDate: null, name: row.visitedName ?? "Unmapped MR", pm: 0, score: null, visits: 0, visitsPerDay: 0 };
    existing.visits += row.visitCount;
    if (row.period === "AM") existing.am += row.visitCount;
    if (row.period === "PM") existing.pm += row.visitCount;
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

  // Direct-report MRs this manager never visited (any period).
  const neglectedMrs = mrScores.filter((s) => hk(s.managerHrId) === managerKey && !visitedKeysAll.has(hk(s.hrId)));

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
      (e) => hk(e.visitedHrId) === scoreKey && (periodFilter === "ALL" || e.period === periodFilter),
    );
    return [...rows].sort((a, b) => b.date.localeCompare(a.date));
  }, [visitLog, score.hrId, periodFilter]);

  return (
    <>
      <tr className="cursor-pointer border-t border-slate-100 hover:bg-slate-50" onClick={onToggle}>
        <td className="w-8 px-3 py-3 text-slate-400">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </td>
        <td className="px-3 py-3">
          <p className="text-sm font-semibold text-slate-800">{score.mrName}</p>
          <p className="text-xs text-slate-400">{score.hrId} · {score.areaName ?? "No area"}</p>
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
        <tr className="bg-slate-50">
          <td colSpan={10} className="px-6 py-4">
            {mrHistory.length === 0 ? (
              <p className="text-sm text-slate-400">
                No visits recorded for this MR{periodFilter !== "ALL" ? ` in ${periodFilter}` : ""}.
              </p>
            ) : (
              <table className="w-full text-left text-sm">
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
                      <td className="py-1.5 pr-6 text-slate-700">{e.doubleVisitorName ?? e.doubleVisitorHrId ?? "—"}</td>
                      <td className="py-1.5 pr-6 text-slate-600">{e.area ?? "—"}</td>
                      <td className="py-1.5 pr-6">
                        {e.period !== "UNKNOWN" ? (
                          <span className={`rounded px-1.5 py-0.5 text-xs font-black ${periodPillClass(e.period)}`}>{e.period}</span>
                        ) : "—"}
                      </td>
                      <td className="py-1.5 text-right font-bold text-slate-800 tabular-nums">{e.visitCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </td>
        </tr>
      )}
    </>
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
        active ? "border-l-2 border-l-[#F97316] border-slate-200 bg-orange-50" : "border-slate-200",
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
        <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-wide text-slate-400">
          <span>AM {rollup.amVisits}</span>
          <span>PM {rollup.pmVisits}</span>
        </div>
        <div className="mt-1"><AmPmBar am={rollup.amVisits} pm={rollup.pmVisits} /></div>
      </div>
    </button>
  );
}

// ─── Main workspace ───────────────────────────────────────────────────────────

export function DoubleVisitAnalyticsWorkspace({
  canImport,
  canPublish,
  dashboard,
  ireports360Configured,
}: {
  canImport: boolean;
  canPublish: boolean;
  dashboard: DoubleVisitDashboardData;
  ireports360Configured: boolean;
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
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [publishingId, setPublishingId] = useState<string | null>(null);

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
    for (const e of visitLog) {
      const mKey = hk(e.doubleVisitorHrId);
      if (!mKey) continue;
      const existing = map.get(mKey) ?? { dvs: 0, lastDate: null, mrs: new Set<string>(), name: e.doubleVisitorName ?? e.doubleVisitorHrId ?? mKey };
      existing.dvs += e.visitCount;
      const visited = hk(e.visitedHrId);
      if (visited) existing.mrs.add(visited);
      if (!existing.lastDate || e.date > existing.lastDate) existing.lastDate = e.date;
      map.set(mKey, existing);
    }
    return map;
  }, [visitLog]);

  const managerProfile = useMemo(
    () => (selectedManagerKey ? buildManagerProfile(selectedManagerKey, visitLog, dashboard.mrScores, periodFilter) : null),
    [selectedManagerKey, visitLog, dashboard.mrScores, periodFilter],
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

  function openManager(managerHrId: string | null) {
    const key = hk(managerHrId);
    if (!key) return;
    setSelectedManagerKey(key);
    setActiveTab("managers");
  }

  function focusMr(score: DoubleVisitMrScore) {
    setMrSearch(score.hrId);
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

  async function uploadExcel() {
    if (!file) { setMessage("Select a Double Visit Excel file first."); return; }
    setBusy(true); setMessage(null);
    try {
      const formData = new FormData();
      formData.set("file", file);
      const res = await fetch("/api/admin/double-visit-analytics/imports/excel", { body: formData, method: "POST" });
      const payload = await res.json();
      if (!res.ok) { setMessage(payload.message ?? "Excel import failed."); return; }
      setMessage(`Preview saved: ${fmt(payload.data.preview.summary.totalVisits)} visits.`);
      window.location.reload();
    } catch (e) { setMessage(e instanceof Error ? e.message : "Excel import failed."); }
    finally { setBusy(false); }
  }

  async function importLive() {
    setBusy(true); setMessage(null);
    try {
      const res = await fetch("/api/admin/double-visit-analytics/imports/ireports360", { body: JSON.stringify({ dateFrom, dateTo }), headers: { "Content-Type": "application/json" }, method: "POST" });
      const payload = await res.json();
      if (!res.ok) { setMessage(payload.message ?? "iReports360 import failed."); return; }
      setMessage(`Live preview saved: ${fmt(payload.data.preview.summary.totalVisits)} double visits.`);
      window.location.reload();
    } catch (e) { setMessage(e instanceof Error ? e.message : "iReports360 import failed."); }
    finally { setBusy(false); }
  }

  async function publish(id: string) {
    setPublishingId(id); setMessage(null);
    try {
      const res = await fetch(`/api/admin/double-visit-analytics/imports/${id}/publish`, { method: "POST" });
      const payload = await res.json();
      if (!res.ok) { setMessage(payload.message ?? "Publish failed."); return; }
      setMessage("Published as official Double Visit snapshot.");
      window.location.reload();
    } catch (e) { setMessage(e instanceof Error ? e.message : "Publish failed."); }
    finally { setPublishingId(null); }
  }

  const exportHref = `/api/admin/double-visit-analytics/export?dateFrom=${encodeURIComponent(dateFrom)}&dateTo=${encodeURIComponent(dateTo)}`;
  const periodLabel = periodFilter === "ALL" ? "" : periodFilter;
  const activeManagerCount = managerSummaries.length;
  const idleCount = executiveSummary?.idleManagers.length ?? 0;

  const TABS: { icon: LucideIcon; id: Tab; label: string }[] = [
    { id: "summary", icon: Sparkles, label: "Summary" },
    { id: "managers", icon: Users, label: "By Manager" },
    { id: "mr-status", icon: User, label: "By MR" },
    { id: "imports", icon: FileSpreadsheet, label: "Imports" },
  ];

  return (
    <div className="space-y-6">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.18em] text-orange-600">Field performance evidence</p>
          <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-950">Double Visit Analytics</h1>
          <p className="mt-2 max-w-3xl text-sm font-medium text-slate-600">
            {dashboard.publishedImport
              ? `${dashboard.publishedImport.sourceFilename} · ${fmtDate(dashboard.dateFrom)} – ${fmtDate(dashboard.dateTo)} · ${fmt(dashboard.kpis.totalVisits)} visits`
              : "No published snapshot — go to Imports to upload and publish a DV file."}
          </p>
        </div>
        <a href={exportHref}>
          <Button className="min-h-11 gap-2 rounded bg-slate-950 px-4 text-white hover:bg-slate-800" type="button">
            <Download className="h-4 w-4" /> Executive Excel
          </Button>
        </a>
      </div>

      {message ? <div className="rounded border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm">{message}</div> : null}

      {/* ── Tabs ───────────────────────────────────────────────────────── */}
      <div className="flex gap-0 overflow-x-auto rounded border border-slate-200 bg-white shadow-sm">
        {TABS.map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => setActiveTab(id)}
            className={[
              "flex items-center gap-2 whitespace-nowrap px-5 py-3 text-sm font-bold transition-colors",
              activeTab === id ? "border-b-2 border-[#F97316] bg-orange-50 text-slate-950" : "text-slate-500 hover:bg-slate-50 hover:text-slate-700",
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
            {(["ALL", "AM", "PM"] as PeriodFilter[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPeriodFilter(p)}
                className={["px-4 py-2 text-xs font-black uppercase", periodFilter === p ? "bg-[#F97316] text-white" : "bg-white text-slate-500 hover:bg-slate-50"].join(" ")}
              >
                {p === "ALL" ? "All Periods" : p}
              </button>
            ))}
          </div>
          {activeTab === "mr-status" && (
            <Input
              className="min-w-[220px] flex-1 rounded border-slate-200 text-sm"
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
        !dashboard.publishedImport ? (
          <Card className="rounded border border-slate-200 bg-white p-10 text-center shadow-sm">
            <FileSpreadsheet className="mx-auto h-12 w-12 text-slate-300" />
            <h2 className="mt-4 text-lg font-black text-slate-950">No published snapshot yet</h2>
            <p className="mx-auto mt-2 max-w-md text-sm font-medium text-slate-500">
              Double Visit Analytics shows data from the one published snapshot. Import a DV Excel file (or pull live iReports360) and publish it to populate every tab.
            </p>
            <Button className="mt-5 gap-2 rounded bg-[#F97316] px-4 text-white hover:bg-orange-600" onClick={() => setActiveTab("imports")} type="button">
              <Upload className="h-4 w-4" /> Go to Imports
            </Button>
          </Card>
        ) : (
          <>
            {/* Headline KPI band */}
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <KpiCard icon={Activity} label="Double Visits" value={fmt(dashboard.kpis.totalVisits)} hint="Total visit count from official snapshot." />
              <KpiCard icon={CalendarDays} label="Active DV Days" value={fmt(dashboard.kpis.activeDoubleVisitDays)} hint="Distinct manager × date combinations." />
              <KpiCard icon={Users} label="Active Double-Visitors" value={fmt(activeManagerCount)} hint={`${idleCount} eligible manager${idleCount === 1 ? "" : "s"} did zero DVs.`} />
              <KpiCard icon={Gauge} label="Avg Calls / Day" value={fmt(dashboard.kpis.averageVisitsPerDoubleVisitDay)} hint="Visits per active double visit day." />
              <KpiCard icon={UsersRound} label="MR Coverage" value={fmt(dashboard.kpis.mrCoverageCount)} hint="Mapped MRs with at least one DV in range." />
              <KpiCard icon={Flame} label="Neglected MRs" value={fmt(weakMrs.length)} hint={`${criticalMrs.length} critical (≥60 days or 0 DVs/90d).`} />
              <KpiCard icon={Activity} label="AM Visits" value={fmt(dashboard.kpis.amVisitCount)} hint="Morning double visit workload." />
              <KpiCard icon={Activity} label="PM Visits" value={fmt(dashboard.kpis.pmVisitCount)} hint="Afternoon double visit workload." />
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
                  <h2 className="flex items-center gap-2 text-lg font-black text-slate-950"><Sparkles className="h-5 w-5 text-[#F97316]" /> What the report found</h2>
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
              <div className="overflow-auto">
                <table className="w-full min-w-[980px] text-left">
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
                      <th className="px-3 py-3">AM / PM</th>
                      <SortHeader label="Last Visit" field="daysSinceLastDv" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                    </tr>
                  </thead>
                  <tbody>
                    {leaderboardRows.map((row, index) => (
                      <tr key={row.managerHrId} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50" onClick={() => openManager(row.managerHrId)}>
                        <td className="px-3 py-2.5 text-sm font-bold tabular-nums text-slate-400">{index + 1}</td>
                        <td className="px-3 py-2.5">
                          <p className="text-sm font-bold text-slate-800">{row.managerName}</p>
                          <p className="text-xs text-slate-400">{row.managerHrId.toUpperCase()}</p>
                        </td>
                        <td className="px-3 py-2.5"><RoleBadge role={row.roleCode} /></td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-2">
                            <div className="relative h-2 w-16 bg-slate-100">
                              <div className="absolute inset-y-0 left-0 bg-[#F97316]" style={{ width: `${leaderboardMaxDvs ? (row.totalDvs / leaderboardMaxDvs) * 100 : 0}%` }} />
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
                          <div className="w-24"><AmPmBar am={row.amVisits} pm={row.pmVisits} /></div>
                        </td>
                        <td className="px-3 py-2.5 text-sm text-slate-600">
                          {fmtDate(row.lastDvDate)}
                          {row.daysSinceLastDv != null && <span className="block text-xs text-slate-400">{row.daysSinceLastDv}d ago</span>}
                        </td>
                      </tr>
                    ))}
                    {leaderboardRows.length === 0 && (
                      <tr><td colSpan={11} className="px-3 py-10 text-center text-sm text-slate-400">No double-visitors{roleFilter !== "ALL" ? ` for ${roleFilter}` : ""} in this snapshot.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
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
                      <span className="truncate text-sm font-semibold text-slate-800">{row.label}</span>
                      <div className="relative h-2 rounded bg-slate-100">
                        <div className="absolute left-0 top-0 h-2 rounded bg-[#F97316]" style={{ width: `${Math.min(100, row.coveragePercent ?? 0)}%` }} />
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
                      <span className="truncate text-sm font-semibold text-slate-800">{row.label}</span>
                      <div className="relative h-2 rounded bg-slate-100">
                        <div className="absolute left-0 top-0 h-2 rounded bg-[#F97316]" style={{ width: `${Math.min(100, row.coveragePercent ?? 0)}%` }} />
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
              <p className="text-[11px] font-semibold text-slate-400">Ranked by total DVs (all periods)</p>
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
                    selectedManagerKey === mKey ? "bg-orange-50 border-l-2 border-l-[#F97316]" : "",
                  ].join(" ")}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-bold text-slate-800">{m.managerName}</p>
                    <RoleBadge role={summaryByKey.get(mKey)?.roleCode ?? null} />
                  </div>
                  <p className="text-xs text-slate-400">{m.managerHrId}</p>
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
              <p className="px-4 py-6 text-sm text-slate-400">No managers{roleFilter !== "ALL" ? ` for ${roleFilter}` : ""} in published snapshot.</p>
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
                    {selectedSummary?.managerHrId.toUpperCase() ?? selectedExec?.managerHrId ?? selectedManagerKey.toUpperCase()}
                    {selectedSummary?.role ? ` · ${selectedSummary.role}` : ""}
                    {periodLabel ? ` · ${periodLabel} breakdown` : ""}
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

                {/* AM/PM + concentration / focus signal */}
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-bold uppercase tracking-wide text-slate-400">AM {selectedSummary?.amVisits ?? managerProfile.amVisits} · PM {selectedSummary?.pmVisits ?? managerProfile.pmVisits}</span>
                    <div className="w-28"><AmPmBar am={selectedSummary?.amVisits ?? managerProfile.amVisits} pm={selectedSummary?.pmVisits ?? managerProfile.pmVisits} /></div>
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
                  <div className="max-h-[480px] overflow-auto">
                    <table className="w-full min-w-[760px] text-left">
                      <thead className="sticky top-0 bg-slate-50 text-xs font-black uppercase tracking-wide text-slate-500">
                        <tr>
                          <th className="px-3 py-3">MR</th>
                          <th className="px-3 py-3">Visits</th>
                          <th className="px-3 py-3 text-right">Days</th>
                          <th className="px-3 py-3 text-right">Visits/Day</th>
                          <th className="px-3 py-3">Span</th>
                          <th className="px-3 py-3 text-right">AM</th>
                          <th className="px-3 py-3 text-right">PM</th>
                          <th className="px-3 py-3">Band</th>
                        </tr>
                      </thead>
                      <tbody>
                        {managerProfile.mrBreakdown.map((row) => (
                          <tr key={row.key} className="border-t border-slate-100">
                            <td className="px-3 py-2.5">
                              <p className="text-sm font-semibold text-slate-800">{row.name}</p>
                              <p className="text-xs text-slate-400">{row.hrId ?? "No HR ID"} · {row.area ?? "No area"}</p>
                            </td>
                            <td className="px-3 py-2.5">
                              <div className="flex items-center gap-2">
                                <div className="relative h-2 w-20 bg-slate-100">
                                  <div className="absolute inset-y-0 left-0 bg-[#F97316]" style={{ width: `${managerProfile.maxVisits ? (row.visits / managerProfile.maxVisits) * 100 : 0}%` }} />
                                </div>
                                <span className="text-sm font-black tabular-nums text-slate-950">{row.visits}</span>
                                {managerProfile.overFocusedKeys.has(row.key) && (
                                  <span className="rounded bg-orange-100 px-1.5 py-0.5 text-[10px] font-black uppercase text-orange-700">Over-focused</span>
                                )}
                              </div>
                            </td>
                            <td className="px-3 py-2.5 text-right text-sm font-bold tabular-nums text-slate-800">{row.days}</td>
                            <td className={`px-3 py-2.5 text-right text-sm tabular-nums ${row.visitsPerDay > 4 ? "font-black text-orange-600" : "text-slate-600"}`}>{fmt(row.visitsPerDay)}</td>
                            <td className="px-3 py-2.5 text-xs text-slate-500">{fmtDate(row.firstDate)} – {fmtDate(row.lastDate)}</td>
                            <td className="px-3 py-2.5 text-right text-sm tabular-nums text-orange-600">{row.am > 0 ? row.am : <span className="text-slate-300">—</span>}</td>
                            <td className="px-3 py-2.5 text-right text-sm tabular-nums text-slate-600">{row.pm > 0 ? row.pm : <span className="text-slate-300">—</span>}</td>
                            <td className="px-3 py-2.5">
                              {row.score ? (
                                <span className={`rounded px-2 py-0.5 text-xs font-black uppercase ring-1 ${bandClass(row.score.band)}`}>{row.score.band}</span>
                              ) : <span className="text-xs text-slate-400">—</span>}
                            </td>
                          </tr>
                        ))}
                        {managerProfile.mrBreakdown.length === 0 && (
                          <tr><td colSpan={8} className="px-3 py-6 text-center text-sm text-slate-400">No visits recorded{periodLabel ? ` for ${periodLabel}` : ""}.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </Card>

                {/* Resigned / vacant-territory visits — resigned reps' accounts renamed to their area */}
                {managerProfile.vacantTerritories.length > 0 && (
                  <Card className="rounded border border-slate-200 bg-white p-0 shadow-sm">
                    <div className="border-b border-slate-100 px-5 py-4">
                      <h3 className="text-base font-black text-slate-950">Resigned / Vacant Territory · {fmt(managerProfile.vacantVisits)} visits</h3>
                      <p className="text-sm text-slate-500">Visits to territories whose rep resigned (the CRM renames the account to the area). These are real effort — already counted in this manager&apos;s Total DVs above — but there is no active MR to credit, so they are listed by territory exactly as recorded.</p>
                    </div>
                    <div className="max-h-[320px] overflow-auto">
                      <table className="w-full min-w-[560px] text-left">
                        <thead className="sticky top-0 bg-slate-50 text-xs font-black uppercase tracking-wide text-slate-500">
                          <tr>
                            <th className="px-3 py-3">Territory (as recorded)</th>
                            <th className="px-3 py-3 text-right">Visits</th>
                            <th className="px-3 py-3 text-right">Days</th>
                            <th className="px-3 py-3 text-right">AM</th>
                            <th className="px-3 py-3 text-right">PM</th>
                            <th className="px-3 py-3">Span</th>
                          </tr>
                        </thead>
                        <tbody>
                          {managerProfile.vacantTerritories.map((row) => (
                            <tr key={row.key} className="border-t border-slate-100">
                              <td className="px-3 py-2.5">
                                <span className="text-sm font-semibold text-slate-800">{territoryLabel(row)}</span>
                                <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-black uppercase text-slate-500">Resigned / vacant</span>
                              </td>
                              <td className="px-3 py-2.5 text-right text-sm font-black tabular-nums text-slate-950">{row.visits}</td>
                              <td className="px-3 py-2.5 text-right text-sm tabular-nums text-slate-700">{row.days}</td>
                              <td className="px-3 py-2.5 text-right text-sm tabular-nums text-orange-600">{row.am > 0 ? row.am : <span className="text-slate-300">—</span>}</td>
                              <td className="px-3 py-2.5 text-right text-sm tabular-nums text-slate-600">{row.pm > 0 ? row.pm : <span className="text-slate-300">—</span>}</td>
                              <td className="px-3 py-2.5 text-xs text-slate-500">{fmtDate(row.firstDate)} – {fmtDate(row.lastDate)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Card>
                )}

                {/* Neglected MRs (direct reports not visited) */}
                {managerProfile.neglectedMrs.length > 0 && (
                  <Card className="rounded border border-rose-200 bg-rose-50 p-0 shadow-sm">
                    <div className="border-b border-rose-200 px-5 py-4">
                      <h3 className="text-base font-black text-rose-800">
                        {managerProfile.neglectedMrs.length} Direct-Report MR{managerProfile.neglectedMrs.length !== 1 ? "s" : ""} Not Visited
                      </h3>
                      <p className="text-sm text-rose-600">These MRs report to this manager but received zero DVs in the current snapshot. Click one to see its history.</p>
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
                            {m.mrName} <span className="text-rose-400">({m.hrId})</span>
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
          <div className="overflow-auto">
            <table className="w-full min-w-[920px] text-left">
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
                {filteredMrScores.length === 0 && (
                  <tr><td colSpan={10} className="px-3 py-10 text-center text-sm text-slate-400">
                    {mrSearch ? "No MRs match your search — clear it to see all." : "No MRs in this snapshot."}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* ═══════════════════════════════════════════════════════════════════
          IMPORTS TAB
      ═══════════════════════════════════════════════════════════════════ */}
      {activeTab === "imports" && (
        <>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
            <Card className="rounded border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-black text-slate-950">Official snapshot</h2>
                  <p className="text-sm font-medium text-slate-500">Dashboards and expense automation use the published snapshot only.</p>
                </div>
                <Badge variant={dashboard.publishedImport ? "success" : "warning"}>
                  {dashboard.publishedImport ? "Published" : "No snapshot"}
                </Badge>
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <label className="block">
                  <span className="mb-1 block text-xs font-black uppercase tracking-wide text-slate-500">From</span>
                  <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-black uppercase tracking-wide text-slate-500">To</span>
                  <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
                </label>
                <div className="flex items-end">
                  <Button className="min-h-10 w-full gap-2 rounded border border-slate-200 bg-white text-slate-700 hover:bg-slate-50" onClick={() => window.location.assign(`/admin/double-visit-analytics?dateFrom=${dateFrom}&dateTo=${dateTo}`)} type="button">
                    <RefreshCcw className="h-4 w-4" /> Refresh
                  </Button>
                </div>
              </div>
              {!dashboard.schemaReady ? (
                <p className="mt-4 rounded bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-700">Tables not provisioned. Apply migration 20260612172427.</p>
              ) : (
                <p className="mt-4 text-sm font-semibold text-slate-600">
                  {dashboard.publishedImport ? `${dashboard.publishedImport.sourceFilename} — ${fmtDate(dashboard.publishedImport.dateFrom)} to ${fmtDate(dashboard.publishedImport.dateTo)}` : "Import and publish a snapshot to populate the dashboard."}
                </p>
              )}
            </Card>
            <Card className="rounded border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="text-lg font-black text-slate-950">Import evidence</h2>
              <p className="mt-1 text-sm font-medium text-slate-500">Excel and live iReports360 imports saved as previews first.</p>
              <div className="mt-4 grid gap-3">
                <label className="flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded border border-dashed border-orange-300 bg-orange-50 px-4 text-sm font-bold text-orange-700">
                  <Upload className="h-4 w-4" /> {file ? file.name : "Select Excel DV file"}
                  <input className="hidden" type="file" accept=".xlsx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                </label>
                <Button className="min-h-11 gap-2 rounded bg-[#F97316] px-4 text-white hover:bg-orange-600" disabled={!canImport || busy || !dashboard.schemaReady} onClick={() => void uploadExcel()} type="button">
                  <FileSpreadsheet className="h-4 w-4" /> Save Excel Preview
                </Button>
                <Button className="min-h-11 gap-2 rounded border border-slate-200 bg-white px-4 text-slate-700 hover:bg-slate-50" disabled={!canImport || !ireports360Configured || busy || !dashboard.schemaReady} onClick={() => void importLive()} type="button">
                  <Activity className="h-4 w-4" /> Import Live iReports360
                </Button>
              </div>
            </Card>
          </div>
          <Card className="rounded border border-slate-200 bg-white p-0 shadow-sm">
            <div className="border-b border-slate-100 p-5">
              <h2 className="text-lg font-black text-slate-950">Import history</h2>
              <p className="text-sm font-medium text-slate-500">Publish exactly one official snapshot for dashboards and expense automation.</p>
            </div>
            <div className="overflow-auto">
              <table className="w-full min-w-[860px] text-left">
                <thead className="bg-slate-50 text-xs font-black uppercase tracking-wide text-slate-500">
                  <tr><th className="px-3 py-3">File</th><th className="px-3 py-3">Source</th><th className="px-3 py-3">Range</th><th className="px-3 py-3">Visits</th><th className="px-3 py-3">Status</th><th className="px-3 py-3 text-right">Action</th></tr>
                </thead>
                <tbody>
                  {dashboard.imports.map((item) => (
                    <ImportRow key={item.id} item={item} publishingId={publishingId} onPublish={canPublish && dashboard.schemaReady ? (id) => void publish(id) : () => undefined} />
                  ))}
                  {dashboard.imports.length === 0 && (
                    <tr><td colSpan={6} className="px-3 py-8 text-center text-sm text-slate-400">No imports yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
