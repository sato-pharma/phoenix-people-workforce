"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ArrowLeft,
  BookmarkCheck,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  FileSpreadsheet,
  FileText,
  Gauge,
  Layers,
  Loader2,
  Minus,
  MoveRight,
  RotateCcw,
  Save,
  Search,
  SlidersHorizontal,
  Sparkles,
  Target,
  TrendingDown,
  TrendingUp,
  Users,
  X,
} from "lucide-react";

import {
  AchievementMeter,
  AchievementRing,
  BandChoice,
  BandStat,
  CommandBand,
  ProportionBar,
  SectionCard,
  achievementHex,
  achievementTone,
  formatEgpFull,
  formatNumber,
  formatPct,
} from "@/components/sales/target-visuals";
import {
  PERIOD_KINDS,
  achievementOf,
  parseForecastUnits,
  type ConcentrationPlanRow,
  type LinePlanGroup,
  type MakeItHappenWorkspace,
  type SavedPlanSummary,
  type TrendKind,
  type TrendReading,
} from "@/lib/sales/make-it-happen/engine";
import {
  DEFAULT_GOAL_PCT,
  GAP_OPTIONS,
  GOAL_PRESETS,
  MAX_GOAL_PCT,
  MIN_GOAL_PCT,
  NO_PLANNER_FILTERS,
  PLANNED_OPTIONS,
  ROW_STATUS_OPTIONS,
  SORT_OPTIONS,
  TREND_OPTIONS,
  buildPlanScenarios,
  filterPlanLines,
  parseGoalPct,
  plannerFiltersActive,
  scenarioSummary,
  trendLabel,
  type FilteredRow,
  type PlanScenario,
  type PlannerFilters,
} from "@/lib/sales/make-it-happen/scenarios";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// Make It Happen — the planner screen.
//
// The user types UNITS only. Value (units × factory price) and achievement % are recomputed here on
// every keystroke from the same pure engine the server saves with. Units are never totalled across
// concentrations; every total above a product row is VALUE.
//
// Owner rule 2026-08-04: nothing on this screen says AI. Phoenix builds the plan.
//
// Premium-polish golden rule (owner, 2026-09-08): depth is the default — two-layer shadows,
// gradients, glows. The square-edge golden rule still binds, and the employee portal zeroes no
// radius, so nothing here carries a `rounded` class.
// ─────────────────────────────────────────────────────────────────────────────

type Coach = { message: string; reachable: boolean | null };
type TeamSort = "name" | "low" | "high";
type TeamBucket = "all" | "ahead" | "close" | "behind" | "none";

/** A card sitting on the page: a hairline contact shadow under a wide ambient one. */
const PANEL_DEPTH = "shadow-[0_1px_2px_rgba(15,23,42,0.05),0_12px_28px_rgba(15,23,42,0.055)]";

const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500/60 focus-visible:ring-offset-1";

/** What the realistic plan is built from — each line is a rule the engine actually enforces. */
const PACE_RULES = [
  "Your own closed months",
  "One-off bulk months ignored",
  "Never above a product's best normal month",
];

const TREND_STYLE: Record<TrendKind, { icon: LucideIcon; className: string }> = {
  none: { icon: Minus, className: "border-slate-200 bg-slate-50 text-slate-500" },
  early: { icon: Gauge, className: "border-amber-200 bg-amber-50 text-amber-700" },
  growing: { icon: TrendingUp, className: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  flat: { icon: MoveRight, className: "border-sky-200 bg-sky-50 text-sky-700" },
  declining: { icon: TrendingDown, className: "border-red-200 bg-red-50 text-red-700" },
};

const TEAM_BUCKETS: ReadonlyArray<{ value: TeamBucket; label: string; swatch: string }> = [
  { value: "all", label: "Everyone", swatch: "bg-slate-500" },
  { value: "ahead", label: "On track", swatch: "bg-emerald-500" },
  { value: "close", label: "Close", swatch: "bg-amber-500" },
  { value: "behind", label: "Behind", swatch: "bg-red-500" },
  { value: "none", label: "No target", swatch: "bg-slate-300" },
];

const TEAM_SORTS: ReadonlyArray<{ value: TeamSort; label: string }> = [
  { value: "name", label: "A to Z" },
  { value: "low", label: "Lowest pace first" },
  { value: "high", label: "Highest pace first" },
];

const SCENARIO_STYLE: Record<PlanScenario["key"], { frame: string; kicker: string }> = {
  pace: { frame: "border-slate-300 shadow-[inset_0_3px_0_#64748B,0_1px_2px_rgba(15,23,42,0.05),0_10px_24px_rgba(15,23,42,0.06)]", kicker: "text-slate-600" },
  realistic: { frame: "border-orange-300 shadow-[inset_0_3px_0_#F97316,0_1px_2px_rgba(15,23,42,0.05),0_12px_28px_rgba(249,115,22,0.12)]", kicker: "text-orange-700" },
  stretch: { frame: "border-amber-300 shadow-[inset_0_3px_0_#F59E0B,0_1px_2px_rgba(15,23,42,0.05),0_10px_24px_rgba(245,158,11,0.10)]", kicker: "text-amber-700" },
};

const CHIP = "inline-flex items-center gap-1.5 border px-2.5 py-1 text-xs font-bold transition";
const CHIP_ON = "border-slate-900 bg-slate-900 text-white shadow-[0_6px_16px_rgba(15,23,42,0.2)]";
const CHIP_OFF = "border-slate-200 bg-white text-slate-700 hover:border-orange-400";
const SELECT =
  "h-8 w-full appearance-none rounded-none border border-slate-300 bg-white px-2 text-xs font-bold text-slate-700 shadow-[inset_0_1px_2px_rgba(15,23,42,0.05)] focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500/20";

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

function monthsText(count: number): string {
  return `${count} month${count === 1 ? "" : "s"}`;
}

const EMPTY_FINGERPRINT = "[]";

/**
 * One comparable fingerprint of the typed units, so "Not saved yet" means the numbers really
 * changed — a box emptied back to 0 is the same plan, an invalid box is a change.
 */
function unitsFingerprint(units: Record<string, string>): string {
  return JSON.stringify(
    Object.entries(units)
      .map(([code, raw]) => [code, parseForecastUnits(raw) ?? -1] as const)
      .filter(([, value]) => value !== 0)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

function teamBucket(value: number | null): Exclude<TeamBucket, "all"> {
  if (value == null) return "none";
  if (value >= 1) return "ahead";
  if (value >= 0.8) return "close";
  return "behind";
}

export function MakeItHappenPlanner({
  data,
  basePath,
  kicker,
}: {
  data: MakeItHappenWorkspace;
  basePath: string;
  kicker: string;
}) {
  const router = useRouter();
  const planNameRef = useRef<HTMLInputElement>(null);
  const [units, setUnits] = useState<Record<string, string>>({});
  const [baseline, setBaseline] = useState(EMPTY_FINGERPRINT);
  const [coach, setCoach] = useState<Coach | null>(null);
  const [busy, setBusy] = useState<"suggest" | "save" | "xlsx" | "pdf" | null>(null);
  const [goalInput, setGoalInput] = useState(String(DEFAULT_GOAL_PCT));
  const [filters, setFilters] = useState<PlannerFilters>(NO_PLANNER_FILTERS);
  const [exportStatus, setExportStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [planName, setPlanName] = useState("");
  const [activePlanId, setActivePlanId] = useState<string | null>(null);

  const href = (params: { kind?: string; period?: string; rep?: string | null }) => {
    const search = new URLSearchParams();
    search.set("kind", params.kind ?? data.periodKind);
    if (params.period) search.set("period", params.period);
    if (params.rep) search.set("rep", params.rep);
    return `${basePath}?${search.toString()}`;
  };

  const unitsOf = (code: string) => parseForecastUnits(units[code]) ?? 0;
  const isInvalid = (code: string) => units[code] != null && parseForecastUnits(units[code]) == null;

  const lineForecasts = useMemo(() => {
    const byLine = new Map<string, number>();
    for (const line of data.lines) {
      if (line.remainingMonths <= 0) {
        byLine.set(line.lineCode, 0);
        continue;
      }
      let value = 0;
      for (const row of line.rows) value += (parseForecastUnits(units[row.productCode]) ?? 0) * row.price;
      byLine.set(line.lineCode, value);
    }
    return byLine;
  }, [data.lines, units]);

  const forecastTotal = [...lineForecasts.values()].reduce((sum, value) => sum + value, 0);
  const overallPct = achievementOf(data.totals.gradedValue, forecastTotal, data.totals.targetValue);
  const monthsLeft = data.lines.reduce((max, line) => Math.max(max, line.remainingMonths), 0);
  const hasInvalid = Object.keys(units).some(isInvalid);
  const openForForecast = monthsLeft > 0;
  const fingerprint = unitsFingerprint(units);
  const hasUnits = fingerprint !== EMPTY_FINGERPRINT;
  const isDirty = fingerprint !== baseline;
  // What is still missing once sales so far and the typed forecast are both counted.
  const gapValue =
    data.totals.targetValue == null ? null : data.totals.targetValue - data.totals.gradedValue - forecastTotal;

  // The goal, the three scenarios and the filters run the same pure functions the export route runs,
  // so the screen and a downloaded file can never disagree.
  const goalPct = parseGoalPct(goalInput);
  const hasTarget = data.totals.targetValue != null;
  const scenarios = useMemo(() => (goalPct == null ? [] : buildPlanScenarios(data, goalPct)), [data, goalPct]);
  const typedUnits = useMemo(() => {
    const parsed: Record<string, number> = {};
    for (const [code, raw] of Object.entries(units)) {
      const value = parseForecastUnits(raw);
      if (value != null && value > 0) parsed[code] = value;
    }
    return parsed;
  }, [units]);
  const filteredLines = useMemo(() => filterPlanLines(data.lines, filters, typedUnits), [data.lines, filters, typedUnits]);
  const shownRows = filteredLines.reduce((sum, entry) => sum + entry.rows.length, 0);
  const totalRows = data.lines.reduce((sum, line) => sum + line.rows.length, 0);

  async function makeItHappen() {
    if (goalPct == null) {
      setError(`Choose an achievement goal between ${MIN_GOAL_PCT}% and ${MAX_GOAL_PCT}% first.`);
      return;
    }
    setBusy("suggest");
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/sales/make-it-happen/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          periodKind: data.periodKind,
          periodKey: data.periodKey,
          rep: data.viewingRep?.key ?? null,
          goalPct,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) {
        throw new Error(payload?.message ?? `Phoenix could not build a plan right now (HTTP ${response.status}).`);
      }
      const next: Record<string, string> = {};
      for (const [code, value] of Object.entries((payload.suggestion.units ?? {}) as Record<string, number>)) {
        next[code] = String(value);
      }
      setUnits(next);
      setCoach({ message: String(payload.suggestion.message ?? ""), reachable: payload.suggestion.reachable ?? null });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Phoenix could not build a plan right now.");
    } finally {
      setBusy(null);
    }
  }

  async function savePlan(asNew: boolean) {
    const name = planName.trim();
    if (!name) {
      setError("Give the plan a name before saving it.");
      planNameRef.current?.focus();
      return;
    }
    if (hasInvalid) {
      setError("Units must be whole numbers of zero or more. Fix the highlighted boxes first.");
      return;
    }
    setBusy("save");
    setError(null);
    setNotice(null);
    const sentFingerprint = fingerprint;
    try {
      const planUnits: Record<string, number> = {};
      for (const code of Object.keys(units)) {
        const value = unitsOf(code);
        if (value > 0) planUnits[code] = value;
      }
      const response = await fetch("/api/sales/make-it-happen/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          periodKind: data.periodKind,
          periodKey: data.periodKey,
          name,
          units: planUnits,
          planId: asNew ? null : activePlanId,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) {
        throw new Error(payload?.message ?? `The plan could not be saved (HTTP ${response.status}).`);
      }
      setActivePlanId(String(payload.plan.id));
      setBaseline(sentFingerprint);
      setNotice(`"${name}" is saved.`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The plan could not be saved.");
    } finally {
      setBusy(null);
    }
  }

  function openPlan(plan: SavedPlanSummary) {
    const next: Record<string, string> = {};
    for (const [code, value] of Object.entries(plan.units)) next[code] = String(value);
    setUnits(next);
    setBaseline(unitsFingerprint(next));
    setPlanName(plan.name);
    setActivePlanId(data.canSave ? plan.id : null);
    setCoach(null);
    setError(null);
    setNotice(`Opened "${plan.name}".`);
  }

  function clearForecast() {
    setUnits({});
    setBaseline(EMPTY_FINGERPRINT);
    setCoach(null);
    setActivePlanId(null);
    setPlanName("");
    setNotice(null);
    setError(null);
  }

  function scenarioInUse(scenario: PlanScenario): boolean {
    if (!hasUnits) return false;
    const asText: Record<string, string> = {};
    for (const [code, value] of Object.entries(scenario.units)) asText[code] = String(value);
    return unitsFingerprint(asText) === fingerprint;
  }

  function applyScenario(scenario: PlanScenario) {
    const next: Record<string, string> = {};
    for (const [code, value] of Object.entries(scenario.units)) {
      if (value > 0) next[code] = String(value);
    }
    setUnits(next);
    setCoach(null);
    setError(null);
    setNotice(`Scenario ${scenario.number} is now your forecast below. Change any product before you save.`);
  }

  async function exportForecast(format: "xlsx" | "pdf") {
    if (goalPct == null) {
      setExportStatus({ ok: false, text: `Choose an achievement goal between ${MIN_GOAL_PCT}% and ${MAX_GOAL_PCT}% first.` });
      return;
    }
    if (hasInvalid) {
      setExportStatus({ ok: false, text: "Units must be whole numbers of zero or more. Fix the highlighted boxes before exporting." });
      return;
    }
    setBusy(format);
    setExportStatus(null);
    try {
      const response = await fetch("/api/sales/make-it-happen/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          periodKind: data.periodKind,
          periodKey: data.periodKey,
          rep: data.viewingRep?.key ?? null,
          units: typedUnits,
          goalPct,
          filters,
          format,
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.message ?? `The file could not be produced (HTTP ${response.status}).`);
      }
      const blob = await response.blob();
      const name =
        /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "")?.[1] ?? `make-it-happen.${format}`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 5_000);
      setExportStatus({ ok: true, text: `${format === "xlsx" ? "Excel" : "PDF"} file ready: ${name}` });
    } catch (caught) {
      setExportStatus({ ok: false, text: caught instanceof Error ? caught.message : "The file could not be produced." });
    } finally {
      setBusy(null);
    }
  }

  function jumpToSave() {
    document.getElementById("make-it-happen-saved-plans")?.scrollIntoView({ behavior: "smooth", block: "center" });
    planNameRef.current?.focus({ preventScroll: true });
  }

  const coachTone =
    coach?.reachable === false
      ? { icon: CircleAlert, frame: "border-amber-300 shadow-[inset_4px_0_0_#F59E0B]", kicker: "text-amber-700", iconTone: "text-amber-500" }
      : coach?.reachable === true
        ? { icon: CheckCircle2, frame: "border-emerald-300 shadow-[inset_4px_0_0_#10B981]", kicker: "text-emerald-700", iconTone: "text-emerald-500" }
        : { icon: Target, frame: "border-sky-300 shadow-[inset_4px_0_0_#0EA5E9]", kicker: "text-sky-700", iconTone: "text-sky-500" };
  const CoachIcon = coachTone.icon;

  return (
    <div className="space-y-4">
      <CommandBand
        kicker={kicker}
        title="Make It Happen"
        subtitle={`${data.periodLabel} · ${data.viewingRep ? data.viewingRep.name : data.scopeLabel}`}
        stats={
          <>
            <BandStat
              label="Target"
              value={data.totals.targetValue == null ? "—" : formatEgpFull(data.totals.targetValue)}
              note={data.totals.targetValue == null ? "No target set for this period" : undefined}
            />
            <BandStat label="Sold so far" tone="sky" value={formatEgpFull(data.totals.gradedValue)} note="Closed months only" />
            <BandStat
              label="Your forecast"
              tone="amber"
              value={formatEgpFull(forecastTotal)}
              note={openForForecast ? `${monthsText(monthsLeft)} left to forecast` : "Every month of this period is closed"}
            />
            {gapValue != null ? (
              <BandStat
                label={gapValue > 0 ? "Still to target" : "Above target by"}
                value={formatEgpFull(Math.abs(gapValue))}
                note={gapValue > 0 ? "After sales so far and your forecast" : "Sales so far plus your forecast"}
              />
            ) : null}
          </>
        }
        ring={<AchievementRing value={overallPct} label="Forecast" dark />}
        footer={
          <>
            <BandChoice
              label="Plan by"
              options={PERIOD_KINDS}
              selected={data.periodKind}
              onSelect={(kind) => router.push(href({ kind }))}
            />
            <span aria-hidden className="mx-1 hidden h-4 w-px bg-slate-700 sm:inline-block" />
            <BandChoice
              label="Period"
              options={data.offered[data.periodKind]}
              selected={data.periodKey}
              onSelect={(period) => router.push(href({ period, rep: data.viewingRep?.key ?? null }))}
            />
          </>
        }
      />

      {data.viewingRep ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border border-sky-200 bg-[linear-gradient(90deg,#F0F9FF_0%,#FFFFFF_100%)] px-4 py-3 text-sm shadow-[inset_4px_0_0_#0EA5E9,0_1px_2px_rgba(15,23,42,0.05),0_12px_28px_rgba(15,23,42,0.055)]">
          <p className="flex min-w-0 items-center gap-2 font-bold text-sky-900">
            <Users className="h-4 w-4 shrink-0 text-sky-600" />
            <span className="min-w-0 break-words">You are looking at {data.viewingRep.name}&apos;s own plan.</span>
          </p>
          <Link
            className={cn(
              "inline-flex items-center gap-1.5 border border-sky-300 bg-white px-3 py-1.5 text-xs font-bold text-sky-800 shadow-[0_4px_12px_rgba(14,165,233,0.12)] transition hover:border-sky-500",
              FOCUS_RING,
            )}
            href={href({ period: data.periodKey })}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to the team
          </Link>
        </div>
      ) : null}

      {data.isEmptyScope ? (
        <section className={cn("flex flex-col items-center border border-border bg-card px-5 py-10 text-center", PANEL_DEPTH)}>
          <span className="flex h-12 w-12 items-center justify-center border border-orange-200 bg-orange-50 text-orange-600 shadow-[0_8px_20px_rgba(249,115,22,0.18)]">
            <Target className="h-6 w-6" />
          </span>
          <p className="mt-4 text-sm font-bold text-foreground">There are no sales or targets to plan for {data.periodLabel} in your scope.</p>
          <p className="mt-1 text-phx-xs text-muted-foreground">Pick another period above, or check back once a target is loaded.</p>
        </section>
      ) : (
        <>
          <section className="relative overflow-hidden border border-orange-200 bg-[linear-gradient(135deg,#FFF7ED_0%,#FFFFFF_55%,#FFFBF5_100%)] px-4 py-4 shadow-[inset_4px_0_0_#F97316,0_1px_2px_rgba(15,23,42,0.05),0_14px_32px_rgba(249,115,22,0.10)] sm:px-6">
            <div aria-hidden className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 bg-orange-400/15 blur-[80px]" />
            <div className="relative flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-black text-slate-900">
                  {openForForecast
                    ? "Type the units you expect to sell for each product, or let Phoenix build the plan from your own sales."
                    : "Every month of this period is closed, so there is nothing left to forecast."}
                </p>
                <p className="mt-0.5 text-phx-xs text-slate-600">
                  Value and achievement calculate as you type. Phoenix only plans what each product&apos;s own month-by-month
                  pace supports.
                </p>
                {openForForecast ? (
                  <ul className="mt-2.5 flex flex-wrap gap-1.5">
                    {PACE_RULES.map((rule) => (
                      <li
                        key={rule}
                        className="inline-flex items-center gap-1.5 border border-orange-200 bg-white/85 px-2 py-1 text-[11px] font-bold text-slate-700 shadow-[0_2px_6px_rgba(249,115,22,0.08)]"
                      >
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-orange-500" />
                        {rule}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {openForForecast && hasTarget ? (
                  <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                    <span className="text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-600">Your goal</span>
                    <div aria-label="Choose your achievement goal" className="flex flex-wrap gap-1" role="group">
                      {GOAL_PRESETS.map((preset) => {
                        const selected = goalPct === preset;
                        return (
                          <button
                            key={preset}
                            aria-pressed={selected}
                            className={cn(
                              "h-8 border px-2.5 text-xs font-black tabular-nums transition",
                              selected
                                ? "border-orange-600 bg-orange-500 text-white shadow-[0_6px_16px_rgba(249,115,22,0.3)]"
                                : "border-orange-200 bg-white text-slate-700 hover:border-orange-400",
                              FOCUS_RING,
                            )}
                            onClick={() => setGoalInput(String(preset))}
                            type="button"
                          >
                            {preset}%
                          </button>
                        );
                      })}
                    </div>
                    <label className="flex items-center gap-1.5 text-xs font-bold text-slate-600">
                      or type
                      <span className="relative block w-20">
                        <input
                          aria-invalid={goalPct == null}
                          aria-label="Achievement goal, percent of target"
                          className={cn(
                            "h-8 w-full border bg-white pl-2 pr-6 text-right text-sm font-black tabular-nums shadow-[inset_0_1px_2px_rgba(15,23,42,0.06)] focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500/20",
                            goalPct == null ? "border-red-500 text-red-700" : "border-slate-300 text-slate-900",
                          )}
                          inputMode="numeric"
                          maxLength={3}
                          onChange={(event) => setGoalInput(event.target.value)}
                          onFocus={(event) => event.currentTarget.select()}
                          value={goalInput}
                        />
                        <span aria-hidden className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs font-black text-slate-400">
                          %
                        </span>
                      </span>
                    </label>
                    {goalPct == null ? (
                      <span className="text-phx-2xs font-bold text-red-600">
                        A whole number from {MIN_GOAL_PCT} to {MAX_GOAL_PCT}
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  className={cn(
                    "inline-flex items-center justify-center gap-2 border border-orange-600 bg-[linear-gradient(180deg,#FB923C_0%,#F97316_55%,#EA580C_100%)] px-5 py-3 text-sm font-black text-white shadow-[0_10px_24px_rgba(249,115,22,0.35)] transition hover:shadow-[0_14px_32px_rgba(249,115,22,0.45)] hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none",
                    FOCUS_RING,
                  )}
                  aria-busy={busy === "suggest"}
                  disabled={!openForForecast || busy !== null}
                  onClick={makeItHappen}
                  type="button"
                >
                  {busy === "suggest" ? (
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                  ) : (
                    <Sparkles className="h-4 w-4 shrink-0" />
                  )}
                  {busy === "suggest" ? "Phoenix is building your plan" : "Press here and Phoenix will Make It Happen"}
                </button>
                <button
                  className={cn(
                    "inline-flex items-center gap-1.5 border border-slate-300 bg-white px-3 py-3 text-xs font-bold text-slate-700 shadow-[0_2px_6px_rgba(15,23,42,0.06)] transition hover:border-slate-500 disabled:opacity-60",
                    FOCUS_RING,
                  )}
                  disabled={busy !== null || Object.keys(units).length === 0}
                  onClick={clearForecast}
                  type="button"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Clear
                </button>
              </div>
            </div>
            {coach?.message ? (
              <div
                className={cn(
                  "relative mt-4 flex gap-3 border bg-white px-4 py-3 shadow-[0_1px_2px_rgba(15,23,42,0.05),0_8px_20px_rgba(15,23,42,0.06)]",
                  coachTone.frame,
                )}
                role="status"
              >
                <CoachIcon className={cn("mt-0.5 h-5 w-5 shrink-0", coachTone.iconTone)} />
                <div className="min-w-0">
                  <p className={cn("text-[10px] font-black uppercase tracking-[0.2em]", coachTone.kicker)}>Phoenix&apos;s plan</p>
                  <p className="mt-0.5 break-words text-sm font-semibold leading-6 text-slate-800">{coach.message}</p>
                </div>
              </div>
            ) : null}
            {openForForecast && scenarios.length > 0 ? (
              <div className="relative mt-4">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-600">
                  {hasTarget ? `Three ways to plan for ${goalPct}% of target` : "Your plan at your own pace"}
                </p>
                <div className={cn("mt-2 grid gap-3", hasTarget && "md:grid-cols-3")}>
                  {(hasTarget ? scenarios : scenarios.slice(0, 1)).map((scenario) => {
                    const style = SCENARIO_STYLE[scenario.key];
                    const inUse = scenarioInUse(scenario);
                    return (
                      <article key={scenario.key} className={cn("flex min-w-0 flex-col border bg-white px-3.5 py-3", style.frame)}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className={cn("text-[10px] font-black uppercase tracking-[0.18em]", style.kicker)}>
                            Scenario {scenario.number}
                          </p>
                          {inUse ? (
                            <span className="border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-black uppercase tracking-[0.12em] text-emerald-700">
                              In your forecast
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-0.5 break-words text-sm font-black text-slate-900">{scenario.title}</p>
                        <p className="mt-2 text-lg font-black tabular-nums text-slate-900">{formatEgpFull(scenario.value)}</p>
                        <div className="mt-1">
                          <AchievementMeter value={scenario.achievement} />
                        </div>
                        <p className="mt-2 flex-1 break-words text-phx-xs leading-5 text-slate-600">
                          {scenarioSummary(scenario, goalPct ?? DEFAULT_GOAL_PCT, formatEgpFull)}
                        </p>
                        <button
                          className={cn(
                            "mt-3 inline-flex items-center justify-center gap-1.5 border px-3 py-2 text-xs font-black transition disabled:opacity-60",
                            scenario.key === "realistic"
                              ? "border-orange-600 bg-orange-500 text-white shadow-[0_6px_16px_rgba(249,115,22,0.3)] hover:bg-orange-600"
                              : "border-slate-300 bg-white text-slate-800 hover:border-orange-400",
                            FOCUS_RING,
                          )}
                          disabled={busy !== null}
                          onClick={() => applyScenario(scenario)}
                          type="button"
                        >
                          Use scenario {scenario.number}
                        </button>
                      </article>
                    );
                  })}
                </div>
              </div>
            ) : null}
            {error ? (
              <p
                className="relative mt-3 flex items-start gap-2 border border-red-200 bg-white px-3 py-2 text-sm font-semibold text-red-700 shadow-[inset_4px_0_0_#EF4444]"
                role="alert"
              >
                <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="min-w-0 break-words">{error}</span>
              </p>
            ) : null}
            {notice ? (
              <p
                className="relative mt-3 flex items-start gap-2 border border-sky-200 bg-white px-3 py-2 text-sm font-semibold text-sky-900 shadow-[inset_4px_0_0_#0EA5E9]"
                role="status"
              >
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-sky-600" />
                <span className="min-w-0 break-words">{notice}</span>
              </p>
            ) : null}
          </section>

          <FilterBar
            busy={busy}
            exportStatus={exportStatus}
            filters={filters}
            lines={data.lines}
            onExport={exportForecast}
            onFilters={setFilters}
            shownRows={shownRows}
            totalRows={totalRows}
          />

          {shownRows === 0 ? (
            <section className={cn("flex flex-col items-center gap-3 border border-border bg-card px-5 py-8 text-center", PANEL_DEPTH)}>
              <p className="text-sm font-bold text-foreground">No product matches these filters.</p>
              <button
                className={cn(
                  "inline-flex items-center gap-1.5 border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 shadow-[0_2px_6px_rgba(15,23,42,0.06)] transition hover:border-orange-400",
                  FOCUS_RING,
                )}
                onClick={() => setFilters(NO_PLANNER_FILTERS)}
                type="button"
              >
                <X className="h-3.5 w-3.5" />
                Clear filters
              </button>
            </section>
          ) : (
            filteredLines
              .filter((entry) => entry.rows.length > 0)
              .map((entry) => (
                <LineSection
                  key={entry.line.lineCode}
                  forecastValue={lineForecasts.get(entry.line.lineCode) ?? 0}
                  invalid={isInvalid}
                  line={entry.line}
                  onUnits={(code, raw) => setUnits((current) => ({ ...current, [code]: raw }))}
                  rows={entry.rows}
                  totalRows={entry.totalRows}
                  units={units}
                />
              ))
          )}

          {data.reps.length > 0 ? <TeamSection data={data} href={href} /> : null}

          <div className="scroll-mt-6" id="make-it-happen-saved-plans">
            <SectionCard
              icon={BookmarkCheck}
              subtitle={
                data.viewingRep
                  ? `Plans ${data.viewingRep.name} saved for ${data.periodLabel}.`
                  : `Save this forecast and reopen it any time during ${data.periodLabel}.`
              }
              title="Saved plans"
            >
              {data.canSave ? (
                <div className="flex flex-wrap items-end gap-2 border-b border-border bg-[#FBFCFD] px-4 py-3 shadow-[inset_0_1px_2px_rgba(15,23,42,0.04)]">
                  <label className="min-w-0 flex-1 basis-56">
                    <span className="text-phx-2xs font-black uppercase tracking-[0.14em] text-muted-foreground">Plan name</span>
                    <input
                      ref={planNameRef}
                      className="mt-1 h-10 w-full border border-slate-300 bg-white px-3 text-sm shadow-[inset_0_1px_2px_rgba(15,23,42,0.05)] focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500/20"
                      enterKeyHint="done"
                      maxLength={80}
                      onChange={(event) => setPlanName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && busy === null) {
                          event.preventDefault();
                          void savePlan(false);
                        }
                      }}
                      placeholder="For example: September push"
                      value={planName}
                    />
                  </label>
                  <button
                    className={cn(
                      "inline-flex h-10 items-center gap-1.5 border border-orange-600 bg-[linear-gradient(180deg,#FB923C_0%,#F97316_55%,#EA580C_100%)] px-4 text-sm font-bold text-white shadow-[0_8px_20px_rgba(249,115,22,0.3)] transition hover:brightness-105 disabled:opacity-60 disabled:shadow-none",
                      FOCUS_RING,
                    )}
                    aria-busy={busy === "save"}
                    disabled={busy !== null}
                    onClick={() => savePlan(false)}
                    type="button"
                  >
                    {busy === "save" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    {activePlanId ? "Save changes" : "Save plan"}
                  </button>
                  {activePlanId ? (
                    <button
                      className={cn(
                        "inline-flex h-10 items-center gap-1.5 border border-slate-300 bg-white px-4 text-sm font-bold text-slate-700 shadow-[0_2px_6px_rgba(15,23,42,0.06)] transition hover:border-slate-500 disabled:opacity-60",
                        FOCUS_RING,
                      )}
                      disabled={busy !== null}
                      onClick={() => savePlan(true)}
                      type="button"
                    >
                      Save as a new plan
                    </button>
                  ) : null}
                </div>
              ) : null}
              {!data.plansAvailable ? (
                <p className="px-4 py-4 text-sm text-muted-foreground">
                  Saving plans is not switched on yet. Your forecast still calculates; it just cannot be kept for now.
                </p>
              ) : data.plans.length === 0 ? (
                <div className="flex items-center gap-3 px-4 py-5">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center border border-slate-200 bg-slate-50 text-slate-400">
                    <BookmarkCheck className="h-4 w-4" />
                  </span>
                  <p className="text-sm text-muted-foreground">No plans saved for this period yet.</p>
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {data.plans.map((plan) => {
                    const active = activePlanId === plan.id;
                    return (
                      <li
                        key={plan.id}
                        className={cn(
                          "flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 transition-colors",
                          active ? "bg-orange-50/60 shadow-[inset_4px_0_0_#F97316]" : "hover:bg-slate-50/80",
                        )}
                      >
                        <div className="min-w-0 flex-1 basis-56">
                          <p className="flex flex-wrap items-center gap-2 break-words text-sm font-bold text-foreground">
                            <span className="min-w-0 break-words">{plan.name}</span>
                            {active ? (
                              <span className="border border-orange-300 bg-white px-1.5 py-0.5 text-[10px] font-black uppercase tracking-[0.12em] text-orange-700">
                                Open now
                              </span>
                            ) : null}
                          </p>
                          <p className="text-phx-xs text-muted-foreground">
                            Saved {plan.updatedAtLabel} · {formatEgpFull(plan.forecastValue)} forecast
                          </p>
                        </div>
                        <div className="w-28">
                          <AchievementMeter value={plan.forecastAchievement} />
                        </div>
                        <button
                          className={cn(
                            "border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 shadow-[0_2px_6px_rgba(15,23,42,0.06)] transition hover:border-orange-400",
                            FOCUS_RING,
                          )}
                          onClick={() => openPlan(plan)}
                          type="button"
                        >
                          {active ? "Reopen" : "Open"}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </SectionCard>
          </div>

          {openForForecast && hasUnits ? (
            <div className="sticky bottom-0 z-20 border border-slate-800 bg-slate-900/95 px-4 py-3 text-white shadow-[0_-12px_32px_rgba(15,23,42,0.28)] backdrop-blur sm:px-6">
              <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
                <div className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-2">
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">Your forecast</p>
                    <p className="text-lg font-black tabular-nums text-amber-300">{formatEgpFull(forecastTotal)}</p>
                  </div>
                  <div className="w-36">
                    <p className="flex items-baseline justify-between gap-2 text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">
                      Achievement
                      <span className="text-sm tabular-nums tracking-normal" style={{ color: achievementHex(overallPct) }}>
                        {formatPct(overallPct)}
                      </span>
                    </p>
                    <span className="mt-1.5 block">
                      <ProportionBar color={achievementHex(overallPct)} fraction={overallPct ?? 0} />
                    </span>
                  </div>
                  {data.canSave && isDirty ? (
                    <span className="inline-flex items-center gap-1.5 border border-amber-400/50 bg-amber-400/15 px-2 py-1 text-[11px] font-bold text-amber-200">
                      <CircleAlert className="h-3.5 w-3.5 shrink-0" />
                      Not saved yet
                    </span>
                  ) : data.canSave && activePlanId ? (
                    <span className="inline-flex items-center gap-1.5 border border-emerald-400/50 bg-emerald-400/15 px-2 py-1 text-[11px] font-bold text-emerald-200">
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                      Saved
                    </span>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {data.canSave ? (
                    <button
                      className={cn(
                        "inline-flex items-center gap-1.5 border border-orange-500 bg-orange-500 px-4 py-2 text-sm font-black text-white shadow-[0_8px_20px_rgba(249,115,22,0.35)] transition hover:bg-orange-600",
                        FOCUS_RING,
                      )}
                      onClick={jumpToSave}
                      type="button"
                    >
                      <Save className="h-4 w-4" />
                      {activePlanId ? "Save changes" : "Save plan"}
                    </button>
                  ) : null}
                  <button
                    className={cn(
                      "inline-flex items-center gap-1.5 border border-white/20 bg-white/10 px-3 py-2 text-xs font-bold text-slate-100 transition hover:bg-white/15 disabled:opacity-60",
                      FOCUS_RING,
                    )}
                    disabled={busy !== null}
                    onClick={clearForecast}
                    type="button"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Clear
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Target − sold so far − forecast. Red while there is still value to find; green once it is covered. */
function GapToTarget({ gap, units }: { gap: number | null; units: number | null }) {
  if (gap == null) return <p className="text-phx-xs text-muted-foreground">No target</p>;
  if (gap <= 0) {
    return (
      <>
        <p className="break-words font-bold text-emerald-700">{gap === 0 ? "Met" : `${formatEgpFull(-gap)} above`}</p>
        <p className="text-phx-xs text-emerald-700">Target covered</p>
      </>
    );
  }
  return (
    <>
      <p className="break-words font-bold text-red-700">{formatEgpFull(gap)}</p>
      <p className="text-phx-xs text-muted-foreground">
        {units != null && units > 0 ? `${formatNumber(units)} units to go` : "still to go"}
      </p>
    </>
  );
}

function FilterBar({
  lines,
  filters,
  onFilters,
  shownRows,
  totalRows,
  busy,
  exportStatus,
  onExport,
}: {
  lines: LinePlanGroup[];
  filters: PlannerFilters;
  onFilters: (next: PlannerFilters) => void;
  shownRows: number;
  totalRows: number;
  busy: string | null;
  exportStatus: { ok: boolean; text: string } | null;
  onExport: (format: "xlsx" | "pdf") => void;
}) {
  const families = useMemo(
    () =>
      [...new Set(lines.flatMap((line) => line.rows.map((row) => row.family)).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b),
      ),
    [lines],
  );
  const trends = useMemo(() => {
    const present = new Set(lines.flatMap((line) => line.rows.map((row) => row.trend.kind)));
    return TREND_OPTIONS.filter((option) => present.has(option.value));
  }, [lines]);
  const active = plannerFiltersActive(filters);
  const set = (patch: Partial<PlannerFilters>) => onFilters({ ...filters, ...patch });

  const chipGroup = (
    label: string,
    options: ReadonlyArray<{ value: string; label: string }>,
    key: "lines" | "families" | "trends" | "statuses",
  ) =>
    options.length > 1 ? (
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="w-full text-phx-2xs font-black uppercase tracking-[0.14em] text-muted-foreground sm:w-16">{label}</span>
        <div aria-label={`Filter by ${label.toLowerCase()}`} className="flex min-w-0 flex-1 flex-wrap gap-1.5" role="group">
          {options.map((option) => {
            const selected = filters[key].includes(option.value);
            return (
              <button
                key={option.value}
                aria-pressed={selected}
                className={cn(CHIP, selected ? CHIP_ON : CHIP_OFF, FOCUS_RING)}
                onClick={() => set({ [key]: toggle(filters[key], option.value) })}
                type="button"
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>
    ) : null;

  const selectField = (
    label: string,
    value: string,
    options: ReadonlyArray<{ value: string; label: string }>,
    onChange: (value: string) => void,
    prefix = "",
  ) => (
    <label className="block min-w-0">
      <span className="sr-only">{label}</span>
      <span className="relative block">
        <select aria-label={label} className={cn(SELECT, "pr-7", FOCUS_RING)} onChange={(event) => onChange(event.target.value)} value={value}>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {prefix}
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown aria-hidden className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
      </span>
    </label>
  );

  const exportButton = (format: "xlsx" | "pdf") => {
    const Icon = format === "xlsx" ? FileSpreadsheet : FileText;
    return (
      <button
        aria-busy={busy === format}
        className={cn(
          "inline-flex h-8 items-center gap-1.5 border px-3 text-xs font-black transition disabled:opacity-60",
          format === "xlsx"
            ? "border-emerald-700 bg-[linear-gradient(180deg,#10B981_0%,#059669_100%)] text-white shadow-[0_6px_16px_rgba(5,150,105,0.25)] hover:brightness-105"
            : "border-slate-900 bg-[linear-gradient(180deg,#334155_0%,#0F172A_100%)] text-white shadow-[0_6px_16px_rgba(15,23,42,0.25)] hover:brightness-110",
          FOCUS_RING,
        )}
        disabled={busy !== null}
        onClick={() => onExport(format)}
        type="button"
      >
        {busy === format ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
        {format === "xlsx" ? "Export Excel" : "Export PDF"}
      </button>
    );
  };

  return (
    <section className={cn("border border-border bg-card", PANEL_DEPTH)}>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 flex-1 basis-64 items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center border border-slate-200 bg-slate-50 text-slate-600">
            <SlidersHorizontal className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-black text-foreground">Filter and export</h2>
            <p className="break-words text-phx-xs text-muted-foreground">
              Showing {formatNumber(shownRows)} of {formatNumber(totalRows)} products. The totals above always cover the whole plan;
              a file holds exactly what you see here.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {active ? (
            <button
              className={cn(
                "inline-flex h-8 items-center gap-1.5 border border-slate-300 bg-white px-3 text-xs font-bold text-slate-700 transition hover:border-orange-400",
                FOCUS_RING,
              )}
              onClick={() => onFilters({ ...NO_PLANNER_FILTERS, sort: filters.sort })}
              type="button"
            >
              <X className="h-3.5 w-3.5" />
              Clear filters
            </button>
          ) : null}
          {exportButton("xlsx")}
          {exportButton("pdf")}
        </div>
      </header>
      <div className="space-y-2.5 bg-[#FBFCFD] px-4 py-3 shadow-[inset_0_1px_2px_rgba(15,23,42,0.04)]">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <label className="relative block min-w-0">
            <span className="sr-only">Find a product or family</span>
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              className="h-8 w-full border border-slate-300 bg-white pl-8 pr-2 text-sm shadow-[inset_0_1px_2px_rgba(15,23,42,0.05)] focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500/20"
              maxLength={80}
              onChange={(event) => set({ search: event.target.value })}
              placeholder="Find a product or family"
              type="search"
              value={filters.search}
            />
          </label>
          {selectField("Planned or not", filters.planned, PLANNED_OPTIONS, (planned) => set({ planned }))}
          {selectField("Gap to target", filters.gap, GAP_OPTIONS, (gap) => set({ gap }))}
          {selectField("Sort products", filters.sort, SORT_OPTIONS, (sort) => set({ sort }), "Sort: ")}
        </div>
        {chipGroup("Line", lines.map((line) => ({ value: line.lineCode, label: line.lineName })), "lines")}
        {chipGroup("Family", families.map((family) => ({ value: family, label: family })), "families")}
        {chipGroup("Trend", trends, "trends")}
        {chipGroup("Status", ROW_STATUS_OPTIONS, "statuses")}
        {exportStatus ? (
          <p
            className={cn(
              "flex items-start gap-2 border bg-white px-3 py-2 text-sm font-semibold",
              exportStatus.ok
                ? "border-emerald-200 text-emerald-800 shadow-[inset_4px_0_0_#10B981]"
                : "border-red-200 text-red-700 shadow-[inset_4px_0_0_#EF4444]",
            )}
            role={exportStatus.ok ? "status" : "alert"}
          >
            {exportStatus.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />}
            <span className="min-w-0 break-words">{exportStatus.text}</span>
          </p>
        ) : null}
      </div>
    </section>
  );
}

function TrendBadge({ trend }: { trend: TrendReading }) {
  const style = TREND_STYLE[trend.kind];
  const Icon = style.icon;
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 border px-1.5 py-0.5 text-[10px] font-black uppercase tracking-[0.08em]",
        style.className,
      )}
    >
      <Icon className="h-3 w-3 shrink-0" />
      <span className="min-w-0 break-words">{trendLabel(trend)}</span>
    </span>
  );
}

/** Closed months as small bars — the pace the plan is read from, at a glance. The numbers stay in text beside it. */
function HistoryBars({ history }: { history: ConcentrationPlanRow["history"] }) {
  const peak = history.reduce((max, point) => Math.max(max, point.units), 0);
  if (history.length === 0 || peak <= 0) return null;
  return (
    <span aria-hidden className="flex h-5 items-end gap-0.5">
      {history.map((point) => (
        <span
          key={point.period}
          className="block w-2 bg-[linear-gradient(180deg,#FB923C_0%,#F97316_100%)]"
          style={{ height: `${Math.max(12, (Math.max(0, point.units) / peak) * 100)}%` }}
          title={`${point.label} ${formatNumber(point.units)}`}
        />
      ))}
    </span>
  );
}

function UnitsHint({
  row,
  open,
  typedUnits,
  invalid,
  onUse,
}: {
  row: ConcentrationPlanRow;
  open: boolean;
  typedUnits: number;
  invalid: boolean;
  onUse: (units: number) => void;
}) {
  if (invalid) return <p className="mt-1 text-right text-phx-2xs font-bold text-red-600">Whole units only</p>;
  if (!open) return null;
  const realistic = row.trend.realisticMaxUnits;
  if (realistic <= 0) return null;
  if (typedUnits > realistic) {
    return (
      <p className="mt-1 text-right text-phx-2xs font-bold text-amber-700">
        Above its realistic {formatNumber(realistic)}
      </p>
    );
  }
  if (typedUnits === realistic) {
    return <p className="mt-1 text-right text-phx-2xs font-bold text-emerald-700">At its realistic pace</p>;
  }
  return (
    <button
      className={cn("mt-1 block w-full text-right text-phx-2xs font-bold text-orange-600 underline-offset-2 hover:underline", FOCUS_RING)}
      onClick={() => onUse(realistic)}
      type="button"
    >
      Use realistic {formatNumber(realistic)}
    </button>
  );
}

function LineSection({
  line,
  rows,
  totalRows,
  units,
  forecastValue,
  invalid,
  onUnits,
}: {
  line: LinePlanGroup;
  rows: FilteredRow[];
  totalRows: number;
  units: Record<string, string>;
  forecastValue: number;
  invalid: (code: string) => boolean;
  onUnits: (code: string, raw: string) => void;
}) {
  const open = line.remainingMonths > 0;
  const linePct = achievementOf(line.gradedValue, forecastValue, line.targetValue);
  const subtitle = !open
    ? "Every month of this period is closed"
    : line.closedMonthLabels.length === 0
      ? `Nothing closed yet · forecasting ${line.forecastMonthLabels.join(", ")}`
      : `Closed ${line.closedMonthLabels.join(", ")} · forecasting ${line.forecastMonthLabels.join(", ")}`;
  const shownText = rows.length < totalRows ? ` · showing ${rows.length} of ${totalRows} products` : "";
  const lineGap = line.targetValue == null ? null : line.targetValue - line.gradedValue - forecastValue;

  const unitsInput = (row: ConcentrationPlanRow, label: string) => (
    <input
      aria-label={label}
      className={cn(
        "h-9 w-full border bg-white px-2 text-right text-sm font-bold tabular-nums shadow-[inset_0_1px_2px_rgba(15,23,42,0.06)] focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500/20 disabled:bg-muted disabled:text-muted-foreground",
        invalid(row.productCode) ? "border-red-500 text-red-700" : "border-slate-300",
      )}
      disabled={!open}
      enterKeyHint="next"
      inputMode="numeric"
      onChange={(event) => onUnits(row.productCode, event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      placeholder="0"
      value={units[row.productCode] ?? ""}
    />
  );

  const detailText = (row: ConcentrationPlanRow) =>
    [
      open && row.trend.realisticMaxUnits > 0 ? `Realistic up to ${formatNumber(row.trend.realisticMaxUnits)} units` : null,
      row.history.length > 0 ? row.history.map((point) => `${point.label} ${formatNumber(point.units)}`).join(" · ") : null,
    ]
      .filter(Boolean)
      .join(" · ");

  return (
    <SectionCard
      actions={
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>
            Target <b className="text-foreground">{line.targetValue == null ? "—" : formatEgpFull(line.targetValue)}</b>
          </span>
          <span>
            Forecast <b className="text-foreground">{formatEgpFull(forecastValue)}</b>
          </span>
          <span className="flex items-center gap-2">
            <span className="block w-20">
              <ProportionBar color={achievementHex(linePct)} fraction={linePct ?? 0} />
            </span>
            <b className={achievementTone(linePct)}>{formatPct(linePct)}</b>
          </span>
        </div>
      }
      icon={Layers}
      subtitle={`${subtitle}${shownText}`}
      title={line.lineName}
    >
      <div className="hidden xl:block">
        <table className="w-full table-fixed text-sm">
          <colgroup>
            <col className="w-[23%]" />
            <col className="w-[12%]" />
            <col className="w-[12%]" />
            <col className="w-[13%]" />
            <col className="w-[13%]" />
            <col className="w-[14%]" />
            <col className="w-[13%]" />
          </colgroup>
          <thead className="bg-slate-900 text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-200">
            <tr>
              <th className="px-3 py-2 text-left">Product</th>
              <th className="px-3 py-2 text-right">Target</th>
              <th className="px-3 py-2 text-right">Sold so far</th>
              <th className="px-3 py-2 text-right">Forecast units</th>
              <th className="px-3 py-2 text-right">Forecast value</th>
              <th className="px-3 py-2 text-right">Achievement</th>
              <th className="px-3 py-2 text-right">Gap to target</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map(({ row, figures }) => {
              const planned = figures.typedUnits > 0;
              return (
                <tr
                  key={row.productCode}
                  className={cn("align-top transition-colors", planned ? "bg-orange-50/50" : "hover:bg-slate-50/80")}
                >
                  <td className={cn("px-3 py-2.5", planned && "shadow-[inset_3px_0_0_#F97316]")}>
                    <p className="break-words font-bold text-foreground">{row.name}</p>
                    <p className="break-words text-phx-xs text-muted-foreground">
                      {row.family ? `${row.family} · ` : ""}
                      {formatEgpFull(row.price)} a unit
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-end gap-x-2 gap-y-1">
                      <TrendBadge trend={row.trend} />
                      <HistoryBars history={row.history} />
                    </div>
                    {detailText(row) ? (
                      <p className="mt-1 break-words text-phx-2xs tabular-nums text-muted-foreground">{detailText(row)}</p>
                    ) : null}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    <p className="break-words font-bold">{row.targetValue == null ? "—" : formatEgpFull(row.targetValue)}</p>
                    <p className="text-phx-xs text-muted-foreground">
                      {row.targetUnits == null ? "No target" : `${formatNumber(row.targetUnits)} units`}
                    </p>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    <p className="break-words font-bold">{formatEgpFull(row.gradedValue)}</p>
                    <p className="text-phx-xs text-muted-foreground">{formatNumber(row.gradedUnits)} units</p>
                  </td>
                  <td className="px-3 py-2.5">
                    {unitsInput(row, `Forecast units for ${row.name}`)}
                    <UnitsHint
                      invalid={invalid(row.productCode)}
                      onUse={(value) => onUnits(row.productCode, String(value))}
                      open={open}
                      row={row}
                      typedUnits={figures.typedUnits}
                    />
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    <p className={cn("break-words font-bold", planned ? "text-orange-700" : "text-foreground")}>
                      {formatEgpFull(figures.value)}
                    </p>
                    <p className="text-phx-xs text-muted-foreground">
                      Units <span className={achievementTone(figures.unitsAchievement)}>{formatPct(figures.unitsAchievement)}</span>
                    </p>
                  </td>
                  <td className="px-3 py-2.5">
                    <AchievementMeter value={figures.achievement} />
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    <GapToTarget gap={figures.gapValue} units={figures.gapUnits} />
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="border-t-2 border-slate-900 bg-[linear-gradient(180deg,#F8FAFC_0%,#F1F5F9_100%)] font-black tabular-nums">
            <tr>
              <td className="px-3 py-3">{line.lineName} total</td>
              <td className="px-3 py-3 text-right">{line.targetValue == null ? "—" : formatEgpFull(line.targetValue)}</td>
              <td className="px-3 py-3 text-right">{formatEgpFull(line.gradedValue)}</td>
              <td className="px-3 py-3 text-right text-phx-xs font-bold text-muted-foreground">By value</td>
              <td className="px-3 py-3 text-right">{formatEgpFull(forecastValue)}</td>
              <td className="px-3 py-3">
                <AchievementMeter value={linePct} />
              </td>
              <td className="px-3 py-3 text-right">
                <GapToTarget gap={lineGap} units={null} />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="divide-y divide-border xl:hidden">
        {rows.map(({ row, figures }) => {
          const planned = figures.typedUnits > 0;
          return (
            <div
              key={row.productCode}
              className={cn("space-y-2.5 px-4 py-3", planned && "bg-orange-50/50 shadow-[inset_3px_0_0_#F97316]")}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="break-words font-bold text-foreground">{row.name}</p>
                  <p className="break-words text-phx-xs text-muted-foreground">
                    {row.family ? `${row.family} · ` : ""}
                    {formatEgpFull(row.price)} a unit
                  </p>
                </div>
                <div className="w-24 shrink-0">
                  <AchievementMeter value={figures.achievement} />
                </div>
              </div>
              <div className="flex flex-wrap items-end gap-x-2 gap-y-1">
                <TrendBadge trend={row.trend} />
                <HistoryBars history={row.history} />
              </div>
              <dl className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <dt className="text-phx-2xs font-black uppercase tracking-[0.12em] text-muted-foreground">Target</dt>
                  <dd className="font-bold tabular-nums">{row.targetValue == null ? "—" : formatEgpFull(row.targetValue)}</dd>
                  <dd className="text-muted-foreground">
                    {row.targetUnits == null ? "No target" : `${formatNumber(row.targetUnits)} units`}
                  </dd>
                </div>
                <div>
                  <dt className="text-phx-2xs font-black uppercase tracking-[0.12em] text-muted-foreground">Sold so far</dt>
                  <dd className="font-bold tabular-nums">{formatEgpFull(row.gradedValue)}</dd>
                  <dd className="text-muted-foreground">{formatNumber(row.gradedUnits)} units</dd>
                </div>
                <div className="col-span-2 border-t border-dashed border-border pt-2">
                  <dt className="text-phx-2xs font-black uppercase tracking-[0.12em] text-muted-foreground">Gap to target</dt>
                  <dd className="tabular-nums">
                    <GapToTarget gap={figures.gapValue} units={figures.gapUnits} />
                  </dd>
                </div>
              </dl>
              <div className="grid grid-cols-2 items-start gap-2">
                <label className="block">
                  <span className="text-phx-2xs font-black uppercase tracking-[0.12em] text-muted-foreground">Forecast units</span>
                  {unitsInput(row, `Forecast units for ${row.name}`)}
                  <UnitsHint
                    invalid={invalid(row.productCode)}
                    onUse={(value) => onUnits(row.productCode, String(value))}
                    open={open}
                    row={row}
                    typedUnits={figures.typedUnits}
                  />
                </label>
                <div className="text-right text-xs">
                  <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-muted-foreground">Forecast value</p>
                  <p className={cn("text-sm font-black tabular-nums", planned ? "text-orange-700" : "text-foreground")}>
                    {formatEgpFull(figures.value)}
                  </p>
                  <p className="text-muted-foreground">
                    Units <span className={achievementTone(figures.unitsAchievement)}>{formatPct(figures.unitsAchievement)}</span>
                  </p>
                </div>
              </div>
              {detailText(row) ? (
                <p className="break-words text-phx-2xs tabular-nums text-muted-foreground">{detailText(row)}</p>
              ) : null}
            </div>
          );
        })}
        <div className="flex items-center justify-between gap-3 border-t-2 border-slate-900 bg-[linear-gradient(180deg,#F8FAFC_0%,#F1F5F9_100%)] px-4 py-3 text-sm font-black tabular-nums">
          <span className="min-w-0 break-words">
            {line.lineName} forecast {formatEgpFull(forecastValue)}
            <span className="block text-phx-xs font-bold text-muted-foreground">
              {lineGap == null ? "No target" : lineGap > 0 ? `${formatEgpFull(lineGap)} still to target` : "Target covered"}
            </span>
          </span>
          <span className="w-24 shrink-0">
            <AchievementMeter value={linePct} />
          </span>
        </div>
      </div>
    </SectionCard>
  );
}

function TeamSection({
  data,
  href,
}: {
  data: MakeItHappenWorkspace;
  href: (params: { kind?: string; period?: string; rep?: string | null }) => string;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<TeamSort>("name");
  const [bucket, setBucket] = useState<TeamBucket>("all");
  const repHref = (key: string) => href({ period: data.periodKey, rep: key });

  const counts = useMemo(() => {
    const tally: Record<TeamBucket, number> = { all: data.reps.length, ahead: 0, close: 0, behind: 0, none: 0 };
    for (const rep of data.reps) tally[teamBucket(rep.expectedAchievement)] += 1;
    return tally;
  }, [data.reps]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const rows = data.reps.filter(
      (rep) =>
        (bucket === "all" || teamBucket(rep.expectedAchievement) === bucket) &&
        (!needle || rep.name.toLowerCase().includes(needle)),
    );
    if (sort === "name") return rows;
    const direction = sort === "low" ? 1 : -1;
    // A person with no target has no pace to rank, so they sit at the end either way.
    return [...rows].sort((a, b) => {
      if (a.expectedAchievement == null) return b.expectedAchievement == null ? 0 : 1;
      if (b.expectedAchievement == null) return -1;
      return (a.expectedAchievement - b.expectedAchievement) * direction;
    });
  }, [data.reps, query, sort, bucket]);

  return (
    <SectionCard
      icon={Users}
      subtitle="At current pace is where each person lands if their own trend simply continues. On track is 100% or more, close is 80 to 99%. Open anyone to see and plan their products."
      title="Your team"
    >
      <div className="flex flex-col gap-3 border-b border-border bg-[#FBFCFD] px-4 py-3 shadow-[inset_0_1px_2px_rgba(15,23,42,0.04)] xl:flex-row xl:items-center xl:justify-between">
        <div aria-label="Filter the team by pace" className="flex flex-wrap gap-1.5" role="group">
          {TEAM_BUCKETS.map((option) => {
            const selected = bucket === option.value;
            return (
              <button
                key={option.value}
                aria-pressed={selected}
                className={cn(
                  "inline-flex items-center gap-1.5 border px-2.5 py-1 text-xs font-bold transition",
                  selected
                    ? "border-slate-900 bg-slate-900 text-white shadow-[0_6px_16px_rgba(15,23,42,0.2)]"
                    : "border-slate-200 bg-white text-slate-700 hover:border-orange-400",
                  FOCUS_RING,
                )}
                onClick={() => setBucket(option.value)}
                type="button"
              >
                <span aria-hidden className={cn("h-2 w-2 shrink-0", option.swatch)} />
                {option.label}
                <span className="tabular-nums opacity-70">{counts[option.value]}</span>
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative block min-w-0 flex-1 basis-44">
            <span className="sr-only">Find a person</span>
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              className="h-8 w-full border border-slate-300 bg-white pl-8 pr-2 text-sm shadow-[inset_0_1px_2px_rgba(15,23,42,0.05)] focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500/20"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find a person"
              type="search"
              value={query}
            />
          </label>
          <div aria-label="Sort the team" className="flex flex-wrap gap-1" role="group">
            {TEAM_SORTS.map((option) => (
              <button
                key={option.value}
                aria-pressed={sort === option.value}
                className={cn(
                  "h-8 border px-2.5 text-xs font-bold transition",
                  sort === option.value
                    ? "border-orange-500 bg-orange-500 text-white shadow-[0_6px_16px_rgba(249,115,22,0.25)]"
                    : "border-slate-200 bg-white text-slate-700 hover:border-orange-400",
                  FOCUS_RING,
                )}
                onClick={() => setSort(option.value)}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">Nobody in your team matches that filter.</p>
      ) : (
        <>
          <div className="hidden lg:block">
            <table className="w-full table-fixed text-sm">
              <colgroup>
                <col className="w-[28%]" />
                <col className="w-[18%]" />
                <col className="w-[18%]" />
                <col className="w-[18%]" />
                <col className="w-[18%]" />
              </colgroup>
              <thead className="bg-slate-900 text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-200">
                <tr>
                  <th className="px-3 py-2 text-left">Person</th>
                  <th className="px-3 py-2 text-right">Target</th>
                  <th className="px-3 py-2 text-right">Sold so far</th>
                  <th className="px-3 py-2 text-right">At current pace</th>
                  <th className="px-3 py-2 text-right">Saved plans</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {visible.map((rep) => (
                  <tr key={rep.key} className="transition-colors hover:bg-slate-50/80">
                    <td className="px-3 py-2.5">
                      <Link
                        className={cn("break-words font-bold text-foreground transition-colors hover:text-orange-600", FOCUS_RING)}
                        href={repHref(rep.key)}
                      >
                        {rep.name}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {rep.targetValue == null ? "—" : formatEgpFull(rep.targetValue)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{formatEgpFull(rep.gradedValue)}</td>
                    <td className="px-3 py-2.5">
                      <AchievementMeter value={rep.expectedAchievement} />
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <Link
                        className={cn(
                          "inline-flex items-center gap-1.5 border border-slate-300 bg-white px-3 py-1 text-xs font-bold text-slate-700 shadow-[0_2px_6px_rgba(15,23,42,0.06)] transition hover:border-orange-400",
                          FOCUS_RING,
                        )}
                        href={repHref(rep.key)}
                      >
                        {rep.savedPlans.length === 0 ? "Open" : `Open · ${rep.savedPlans.length} saved`}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="divide-y divide-border lg:hidden">
            {visible.map((rep) => (
              <li key={rep.key}>
                <Link className={cn("block space-y-1.5 px-4 py-3 transition-colors hover:bg-slate-50/80", FOCUS_RING)} href={repHref(rep.key)}>
                  <span className="flex items-start justify-between gap-3">
                    <span className="min-w-0 break-words font-bold text-foreground">{rep.name}</span>
                    <span className="w-24 shrink-0">
                      <AchievementMeter value={rep.expectedAchievement} />
                    </span>
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Target {rep.targetValue == null ? "—" : formatEgpFull(rep.targetValue)} · sold {formatEgpFull(rep.gradedValue)} ·{" "}
                    {rep.savedPlans.length} saved plan{rep.savedPlans.length === 1 ? "" : "s"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </SectionCard>
  );
}
