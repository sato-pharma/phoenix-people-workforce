"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useMemo, useRef, useState } from "react";
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

import { PortalEmptyState } from "@/components/employee-portal/portal-primitives";
import {
  AchievementMeter,
  AchievementRing,
  BandChoice,
  BandStat,
  CommandBand,
  LABEL_CLASS,
  ProportionBar,
  SURFACE_CLASS,
  SectionCard,
  TABLE_HEAD_CLASS,
  TABLE_ROW_CLASS,
  achievementHex,
  achievementTone,
  chipClass,
  formatEgpFull,
  formatNumber,
  formatPct,
} from "@/components/sales/target-visuals";
import {
  PERIOD_KINDS,
  achievementOf,
  brickUnitsFor,
  parseForecastUnits,
  splitAcrossBricks,
  type BrickPlanRow,
  type ConcentrationPlanRow,
  type LinePlanGroup,
  type MakeItHappenWorkspace,
  type RepPlanSummary,
  type SavedPlanSummary,
  type TrendKind,
  type TrendReading,
} from "@/lib/sales/make-it-happen/engine";
import {
  DEFAULT_GOAL_PCT,
  GAP_OPTIONS,
  GOAL_PRESETS,
  INCENTIVE_FLOOR,
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
  pediaHalves,
  plannerFiltersActive,
  scenarioSummary,
  suggestedScenario,
  trendLabel,
  type FilteredRow,
  type GoalCheck,
  type PlanScenario,
  type PlannerFilters,
} from "@/lib/sales/make-it-happen/scenarios";
import { cn } from "@/lib/utils";
import {
  phxFieldClassName,
  phxSelectClassName,
} from "@/components/ui/form-tokens";
import { TableRowDetail } from "@/components/ui/table-row-detail";

// ─────────────────────────────────────────────────────────────────────────────
// Make It Happen — the planner screen.
//
// The user types UNITS only. Value (units × factory price) and achievement % are recomputed here on
// every keystroke from the same pure engine the server saves with. Units are never totalled across
// concentrations; every total above a product row is VALUE.
//
// Owner rule 2026-08-04: nothing on this screen says AI. Phoenix builds the plan.
//
// THE LOOK (owner, 2026-09-14): light, clean Phoenix orange — the same surfaces, table heads and
// chips as Sales vs Target and Targets, taken from `target-visuals.tsx`. White cards, thin slate
// borders, orange accents and selected state, calm dark numbers. No dark bands, no glows, no
// gradients. The square-edge golden rule binds, so nothing here carries a `rounded` class.
// ─────────────────────────────────────────────────────────────────────────────

type Coach = { message: string; reachable: boolean | null };
type TeamSort = "name" | "low" | "high";
type TeamBucket = "all" | "ahead" | "close" | "behind" | "none";

/** Keyboard focus: a square orange outline, the same one the shared chips draw. */
const FOCUS_RING = phxSelectClassName;

/** A white text box or select: slate hairline, orange focus ring, square. */
const FIELD = phxFieldClassName;

/** The one primary action shape: solid orange, no gradient. */
const PRIMARY_BUTTON =
  "border border-orange-500 bg-orange-500 text-white shadow-[0_2px_8px_rgba(249,115,22,0.25)] transition-colors hover:border-orange-600 hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none";

/** A quiet secondary action: white with a slate hairline, orange on hover. */
const SECONDARY_BUTTON =
  "border border-slate-200 bg-white text-slate-700 transition-colors hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700 disabled:cursor-not-allowed disabled:opacity-60";

/** The pale strip a card's controls sit on, under its header. */
const CONTROL_STRIP = "border-b border-slate-100 bg-slate-50/70";

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
  pace: { frame: "border-t-slate-400", kicker: "text-slate-500" },
  realistic: { frame: "border-t-orange-500", kicker: "text-orange-600" },
  stretch: { frame: "border-t-amber-500", kicker: "text-amber-600" },
};

const SELECT = cn(FIELD, "h-10 w-full appearance-none px-2 text-xs font-bold text-slate-700 lg:h-8");

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

type BrickTyping = Record<string, Record<string, string>>;

/**
 * Each planned product's units per brick (engine.ts rule 9): the bricks as typed when the user typed
 * any, else the product split by its bricks' own pace. Only products with bricks and units appear.
 */
function resolveBricks(
  rowsByCode: ReadonlyMap<string, ConcentrationPlanRow>,
  units: Record<string, string>,
  typed: BrickTyping,
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [code, raw] of Object.entries(units)) {
    const row = rowsByCode.get(code);
    const total = parseForecastUnits(raw) ?? 0;
    if (!row || row.bricks.length === 0 || total <= 0) continue;
    const given = typed[code]
      ? Object.fromEntries(Object.entries(typed[code]).map(([brickId, value]) => [brickId, parseForecastUnits(value) ?? 0]))
      : null;
    out[code] = brickUnitsFor(row.bricks, total, given);
  }
  return out;
}

/** "Not saved yet" means the numbers changed — a product's units or how they sit on its bricks. */
function planFingerprint(
  rowsByCode: ReadonlyMap<string, ConcentrationPlanRow>,
  units: Record<string, string>,
  typed: BrickTyping,
): string {
  const bricks = Object.entries(resolveBricks(rowsByCode, units, typed))
    .flatMap(([code, split]) =>
      Object.entries(split)
        .filter(([, value]) => value > 0)
        .map(([brickId, value]) => `${code}|${brickId}|${value}`),
    )
    .sort();
  return `${unitsFingerprint(units)}${bricks.length > 0 ? JSON.stringify(bricks) : ""}`;
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
  surface = "sales",
}: {
  data: MakeItHappenWorkspace;
  basePath: string;
  kicker: string;
  /** "portal" swaps the light command band for the employee-portal identity; see CommandBand. */
  surface?: "sales" | "portal";
}) {
  const router = useRouter();
  const planNameRef = useRef<HTMLInputElement>(null);
  const [units, setUnits] = useState<Record<string, string>>({});
  // Bricks the user typed, per product. A product missing here is split by its bricks' pace (rule 9).
  const [brickUnits, setBrickUnits] = useState<BrickTyping>({});
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
  const brickInvalid = (code: string, brickId: string) => {
    const raw = brickUnits[code]?.[brickId];
    return raw != null && parseForecastUnits(raw) == null;
  };
  const isInvalid = (code: string) =>
    (units[code] != null && parseForecastUnits(units[code]) == null) ||
    Object.keys(brickUnits[code] ?? {}).some((brickId) => brickInvalid(code, brickId));

  const rowsByCode = useMemo(() => {
    const map = new Map<string, ConcentrationPlanRow>();
    for (const line of data.lines) for (const row of line.rows) map.set(row.productCode, row);
    return map;
  }, [data.lines]);
  const resolvedBricks = useMemo(() => resolveBricks(rowsByCode, units, brickUnits), [rowsByCode, units, brickUnits]);

  /** What each brick box shows: the typed text, else the product's pace split. */
  const brickTextOf = (row: ConcentrationPlanRow): Record<string, string> => {
    const typed = brickUnits[row.productCode];
    if (typed) return typed;
    const split = splitAcrossBricks(unitsOf(row.productCode), row.bricks);
    const text: Record<string, string> = {};
    for (const brick of row.bricks) text[brick.brickId] = split[brick.brickId] ? String(split[brick.brickId]) : "";
    return text;
  };

  /** Typing the product re-splits it over its bricks by pace. */
  const setProductUnits = (code: string, raw: string) => {
    setUnits((current) => ({ ...current, [code]: raw }));
    setBrickUnits((current) => {
      if (!(code in current)) return current;
      const next = { ...current };
      delete next[code];
      return next;
    });
  };

  /** Typing a brick makes the product the sum of its bricks. */
  const setBrick = (row: ConcentrationPlanRow, brickId: string, raw: string) => {
    const next = { ...brickTextOf(row), [brickId]: raw };
    const sum = Object.values(next).reduce((total, value) => total + (parseForecastUnits(value) ?? 0), 0);
    setBrickUnits((current) => ({ ...current, [row.productCode]: next }));
    setUnits((current) => ({ ...current, [row.productCode]: sum > 0 ? String(sum) : "" }));
  };

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
  const hasInvalid = [...new Set([...Object.keys(units), ...Object.keys(brickUnits)])].some(isInvalid);
  const openForForecast = monthsLeft > 0;
  const fingerprint = planFingerprint(rowsByCode, units, brickUnits);
  const hasUnits = unitsFingerprint(units) !== EMPTY_FINGERPRINT;
  const isDirty = fingerprint !== baseline;
  // What is still missing once sales so far and the typed forecast are both counted.
  const gapValue =
    data.totals.targetValue == null ? null : data.totals.targetValue - data.totals.gradedValue - forecastTotal;

  // The goal, the three scenarios and the filters run the same pure functions the export route runs,
  // so the screen and a downloaded file can never disagree.
  const goalPct = parseGoalPct(goalInput);
  const hasTarget = data.totals.targetValue != null;
  const scenarios = useMemo(() => (goalPct == null ? [] : buildPlanScenarios(data, goalPct)), [data, goalPct]);
  // The card "Make It Happen" fills in — Scenario 3 when your goal is realistic, Scenario 2 otherwise.
  const suggestedKey = scenarios.length > 0 ? suggestedScenario(scenarios).key : null;
  const typedUnits = useMemo(() => {
    const parsed: Record<string, number> = {};
    for (const [code, raw] of Object.entries(units)) {
      const value = parseForecastUnits(raw);
      if (value != null && value > 0) parsed[code] = value;
    }
    return parsed;
  }, [units]);
  const filteredLines = useMemo(() => filterPlanLines(data.lines, filters, typedUnits), [data.lines, filters, typedUnits]);
  // The two Pedia halves on the typed forecast — empty on every plan without the Pedia split.
  const halves = useMemo(
    () => pediaHalves(data, typedUnits, goalPct ?? DEFAULT_GOAL_PCT),
    [data, typedUnits, goalPct],
  );
  const untargetedLabels = [...new Set(data.lines.flatMap((line) => line.untargetedMonthLabels))];
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
      setBrickUnits({});
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
          bricks: resolvedBricks,
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
    const nextBricks: BrickTyping = {};
    for (const [code, split] of Object.entries(plan.bricks ?? {})) {
      const row = rowsByCode.get(code);
      if (!row || row.bricks.length === 0) continue;
      const resolved = brickUnitsFor(row.bricks, plan.units[code] ?? 0, split);
      nextBricks[code] = Object.fromEntries(
        row.bricks.map((brick) => [brick.brickId, resolved[brick.brickId] ? String(resolved[brick.brickId]) : ""]),
      );
    }
    setUnits(next);
    setBrickUnits(nextBricks);
    setBaseline(planFingerprint(rowsByCode, next, nextBricks));
    setPlanName(plan.name);
    setActivePlanId(data.canSave ? plan.id : null);
    setCoach(null);
    setError(null);
    setNotice(`Opened "${plan.name}".`);
  }

  function clearForecast() {
    setUnits({});
    setBrickUnits({});
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
    // A scenario is split by pace, so typed bricks make the forecast your own, not the card's.
    return Object.keys(brickUnits).length === 0 && unitsFingerprint(asText) === unitsFingerprint(units);
  }

  function applyScenario(scenario: PlanScenario) {
    const next: Record<string, string> = {};
    for (const [code, value] of Object.entries(scenario.units)) {
      if (value > 0) next[code] = String(value);
    }
    setUnits(next);
    setBrickUnits({});
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
          bricks: resolvedBricks,
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
      ? { icon: CircleAlert, frame: "border-l-amber-500 bg-amber-50/40", kicker: "text-amber-700", iconTone: "text-amber-500" }
      : coach?.reachable === true
        ? { icon: CheckCircle2, frame: "border-l-emerald-500 bg-emerald-50/40", kicker: "text-emerald-700", iconTone: "text-emerald-500" }
        : { icon: Target, frame: "border-l-sky-500 bg-sky-50/40", kicker: "text-sky-700", iconTone: "text-sky-500" };
  const CoachIcon = coachTone.icon;

  const bandSubtitle = `${data.periodLabel} · ${data.viewingRep ? data.viewingRep.name : data.scopeLabel}`;
  const bandStats = (
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
  );
  const bandFooter = (
    <>
      <BandChoice
        surface={surface}
        label="Plan by"
        options={PERIOD_KINDS}
        selected={data.periodKind}
        onSelect={(kind) => router.push(href({ kind }))}
      />
      <span aria-hidden className="mx-1 hidden h-4 w-px bg-slate-200 sm:inline-block" />
      <BandChoice
        surface={surface}
        label="Period"
        options={data.offered[data.periodKind]}
        selected={data.periodKey}
        onSelect={(period) => router.push(href({ period, rep: data.viewingRep?.key ?? null }))}
      />
    </>
  );

  return (
    <div className="space-y-4">
      {surface === "portal" ? (
        // The portal lays the ring out in a panel of its own, where a lone ring sat in a full-width
        // strip; the aside gives it the same companion figure Sales vs Target and Targets carry. The
        // admin band below is unchanged — its ring sits beside the headline and needs no aside.
        <CommandBand
          surface="portal"
          besideFrom="xl"
          kicker={kicker}
          title="Make It Happen"
          subtitle={bandSubtitle}
          stats={bandStats}
          ring={<AchievementRing value={overallPct} size={132} stroke={13} label="Forecast" premium />}
          aside={
            <div>
              <p className={LABEL_CLASS}>Months left</p>
              <p className="mt-1 whitespace-nowrap text-2xl font-black tabular-nums text-slate-900">{formatNumber(monthsLeft)}</p>
              <p className="mt-1 max-w-[13rem] text-phx-xs leading-4 text-slate-500">
                {openForForecast ? `still open to forecast in ${data.periodLabel}` : "every month of this period is closed"}
              </p>
            </div>
          }
          footer={bandFooter}
        />
      ) : (
        <CommandBand
          kicker={kicker}
          title="Make It Happen"
          subtitle={bandSubtitle}
          stats={bandStats}
          ring={<AchievementRing value={overallPct} label="Forecast" />}
          footer={bandFooter}
        />
      )}

      {data.viewingRep ? (
        <div className={cn(SURFACE_CLASS, "flex flex-wrap items-center justify-between gap-2 border-l-[3px] border-l-sky-500 px-4 py-3 text-sm")}>
          <p className="flex min-w-0 items-center gap-2 font-bold text-slate-900">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center bg-sky-50 text-sky-600 ring-1 ring-inset ring-sky-100">
              <Users className="h-3.5 w-3.5" />
            </span>
            <span className="min-w-0 break-words">You are looking at {data.viewingRep.name}&apos;s own plan.</span>
          </p>
          <Link
            className={cn("inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold", SECONDARY_BUTTON, FOCUS_RING)}
            href={href({ period: data.periodKey })}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to the team
          </Link>
        </div>
      ) : null}

      {data.isEmptyScope && surface === "portal" ? (
        // The portal's one empty panel (PortalEmptyState), shared by every sales page; same wording.
        <section className={SURFACE_CLASS}>
          <PortalEmptyState
            title={`There are no sales or targets to plan for ${data.periodLabel} in your scope.`}
            message="Pick another period above, or check back once a target is loaded."
          />
        </section>
      ) : data.isEmptyScope ? (
        <section className={cn(SURFACE_CLASS, "flex flex-col items-center px-5 py-10 text-center")}>
          <span className="flex h-12 w-12 items-center justify-center bg-orange-50 text-orange-600 ring-1 ring-inset ring-orange-100">
            <Target className="h-6 w-6" />
          </span>
          <p className="mt-4 text-sm font-bold text-slate-900">There are no sales or targets to plan for {data.periodLabel} in your scope.</p>
          <p className="mt-1 text-phx-xs text-slate-500">Pick another period above, or check back once a target is loaded.</p>
        </section>
      ) : (
        <>
          <section className={cn(SURFACE_CLASS, "border-l-[3px] border-l-orange-500 px-4 py-4 sm:px-6")}>
            {/* Side by side from xl, not lg: beside the portal sidebar a 1024px screen left the text
                about 430px and wrapped the Make It Happen button under itself. */}
            <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-black text-slate-900">
                  {openForForecast
                    ? "Type the units you expect to sell for each product, or let Phoenix build the plan from your own sales."
                    : untargetedLabels.length > 0
                      ? `No open month of this period carries a target yet (${untargetedLabels.join(", ")}), so there is nothing to forecast against.`
                      : "Every month of this period is closed, so there is nothing left to forecast."}
                </p>
                {openForForecast && untargetedLabels.length > 0 ? (
                  <p className="mt-0.5 text-phx-xs font-bold text-amber-700">
                    {untargetedLabels.join(", ")} {untargetedLabels.length === 1 ? "carries" : "carry"} no target yet, so Phoenix does
                    not forecast {untargetedLabels.length === 1 ? "it" : "them"}: a forecast is only ever measured against a target
                    for the same months.
                  </p>
                ) : null}
                <p className="mt-0.5 text-phx-xs text-slate-500">
                  Value and achievement calculate as you type. Phoenix reads every product from its own closed months and
                  never plans above its best normal month.
                </p>
                {openForForecast ? (
                  <ul className="mt-2.5 flex flex-wrap gap-1.5">
                    {PACE_RULES.map((rule) => (
                      <li
                        key={rule}
                        className="inline-flex items-center gap-1.5 border border-slate-200 bg-slate-50/70 px-2 py-1 text-phx-xs font-bold text-slate-700"
                      >
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-orange-500" />
                        {rule}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {openForForecast && hasTarget ? (
                  <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                    <span className={LABEL_CLASS}>Your goal</span>
                    <div aria-label="Choose your achievement goal" className="flex flex-wrap gap-1" role="group">
                      {GOAL_PRESETS.map((preset) => {
                        const selected = goalPct === preset;
                        return (
                          <button
                            key={preset}
                            aria-pressed={selected}
                            className={cn(chipClass(selected, surface), "h-10 px-2.5 font-black tabular-nums lg:h-8")}
                            onClick={() => setGoalInput(String(preset))}
                            type="button"
                          >
                            {preset}%
                          </button>
                        );
                      })}
                    </div>
                    <label className="flex items-center gap-1.5 text-xs font-bold text-slate-500">
                      or type
                      <span className="relative block w-20">
                        <input
                          aria-invalid={goalPct == null}
                          aria-label="Achievement goal, percent of target"
                          className={cn(
                            FIELD,
                            "w-full pl-2 pr-6 text-right tabular-nums lg:h-8",
                            goalPct == null && "border-red-500 text-red-700 hover:border-red-500",
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
                  className={cn("inline-flex items-center justify-center gap-2 px-5 py-3 text-sm font-black", PRIMARY_BUTTON, FOCUS_RING)}
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
                  className={cn("inline-flex items-center gap-1.5 px-3 py-3 text-xs font-bold", SECONDARY_BUTTON, FOCUS_RING)}
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
                className={cn("mt-4 flex gap-3 border border-slate-200 border-l-[3px] px-4 py-3", coachTone.frame)}
                role="status"
              >
                <CoachIcon className={cn("mt-0.5 h-5 w-5 shrink-0", coachTone.iconTone)} />
                <div className="min-w-0">
                  <p className={cn("text-phx-2xs font-black uppercase tracking-[0.2em]", coachTone.kicker)}>Phoenix&apos;s plan</p>
                  <p className="mt-0.5 break-words text-sm font-semibold leading-6 text-slate-800">{coach.message}</p>
                </div>
              </div>
            ) : null}
            {openForForecast && scenarios.length > 0 ? (
              <div className="mt-5 border-t border-slate-100 pt-4">
                <p className={LABEL_CLASS}>
                  {hasTarget ? `Three ways to plan for ${goalPct}% of target` : "Your plan at your own pace"}
                </p>
                <div className={cn("mt-2 grid gap-3", hasTarget && "md:grid-cols-3")}>
                  {(hasTarget ? scenarios : scenarios.slice(0, 1)).map((scenario) => {
                    const style = SCENARIO_STYLE[scenario.key];
                    const inUse = scenarioInUse(scenario);
                    return (
                      <article
                        key={scenario.key}
                        className={cn(
                          "flex min-w-0 flex-col border border-slate-200 border-t-[3px] bg-white px-3.5 py-3 transition-colors hover:border-x-orange-200 hover:border-b-orange-200",
                          style.frame,
                          inUse && "bg-orange-50/40",
                        )}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className={cn("text-phx-2xs font-black uppercase tracking-[0.18em]", style.kicker)}>
                            Scenario {scenario.number}
                          </p>
                          {inUse ? (
                            <span className="border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-emerald-700">
                              In your forecast
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-0.5 break-words text-sm font-black text-slate-900">{scenario.title}</p>
                        <p className="mt-2 text-lg font-black tabular-nums text-slate-900">{formatEgpFull(scenario.value)}</p>
                        <div className="mt-1">
                          <AchievementMeter value={scenario.achievement} />
                        </div>
                        {scenario.checks.length > 0 ? <ScenarioHalves checks={scenario.checks} /> : null}
                        <p className="mt-2 flex-1 break-words text-phx-xs leading-5 text-slate-500">
                          {scenarioSummary(scenario, goalPct ?? DEFAULT_GOAL_PCT, formatEgpFull)}
                        </p>
                        <button
                          className={cn(
                            "mt-3 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-black",
                            scenario.key === suggestedKey ? PRIMARY_BUTTON : SECONDARY_BUTTON,
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
                className="mt-3 flex items-start gap-2 border border-red-200 border-l-[3px] border-l-red-500 bg-red-50/40 px-3 py-2 text-sm font-semibold text-red-700"
                role="alert"
              >
                <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="min-w-0 break-words">{error}</span>
              </p>
            ) : null}
            {notice ? (
              <p
                className="mt-3 flex items-start gap-2 border border-sky-200 border-l-[3px] border-l-sky-500 bg-sky-50/40 px-3 py-2 text-sm font-semibold text-slate-800"
                role="status"
              >
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-sky-600" />
                <span className="min-w-0 break-words">{notice}</span>
              </p>
            ) : null}
          </section>

          {halves.length > 0 ? (
            <PediaHalvesPanel
              goalPct={goalPct ?? DEFAULT_GOAL_PCT}
              halves={halves}
              open={openForForecast}
              semester={data.periodKind === "semester"}
            />
          ) : null}

          {!data.bricksAvailable ? (
            <p className={cn(SURFACE_CLASS, "border-l-4 border-l-amber-500 px-4 py-3 text-sm text-amber-800")}>
              The bricks could not be read right now, so each product is planned on its own. Reload the page to try again.
            </p>
          ) : null}

          <FilterBar
            surface={surface}
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
            <section className={cn(SURFACE_CLASS, "flex flex-col items-center gap-3 px-5 py-8 text-center")}>
              <p className="text-sm font-bold text-slate-900">No product matches these filters.</p>
              <button
                className={cn("inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold", SECONDARY_BUTTON, FOCUS_RING)}
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
                  surface={surface}
                  key={entry.line.lineCode}
                  forecastValue={lineForecasts.get(entry.line.lineCode) ?? 0}
                  invalid={isInvalid}
                  line={entry.line}
                  onUnits={setProductUnits}
                  bricksOpenAtFirst={data.reps.length === 0}
                  brickText={brickTextOf}
                  brickInvalid={brickInvalid}
                  onBrick={setBrick}
                  rows={entry.rows}
                  totalRows={entry.totalRows}
                  units={units}
                />
              ))
          )}

          {data.reps.length > 0 ? <TeamSection data={data} href={href} surface={surface} /> : null}

          <div className="scroll-mt-6" id="make-it-happen-saved-plans">
            <SectionCard
              surface={surface}
              icon={BookmarkCheck}
              subtitle={
                data.viewingRep
                  ? `Plans ${data.viewingRep.name} saved for ${data.periodLabel}.`
                  : `Save this forecast and reopen it any time during ${data.periodLabel}.`
              }
              title="Saved plans"
            >
              {data.canSave ? (
                <div className={cn("flex flex-wrap items-end gap-2 px-4 py-3", CONTROL_STRIP)}>
                  <label className="min-w-0 flex-1 basis-56">
                    <span className={LABEL_CLASS}>Plan name</span>
                    <input
                      ref={planNameRef}
                      className={cn(FIELD, "mt-1 w-full px-3")}
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
                    className={cn("inline-flex h-10 items-center gap-1.5 px-4 text-sm font-bold", PRIMARY_BUTTON, FOCUS_RING)}
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
                      className={cn("inline-flex h-10 items-center gap-1.5 px-4 text-sm font-bold", SECONDARY_BUTTON, FOCUS_RING)}
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
                <p className="px-4 py-4 text-sm text-slate-500">
                  Saving plans is not switched on yet. Your forecast still calculates; it just cannot be kept for now.
                </p>
              ) : data.plans.length === 0 ? (
                <div className="flex items-center gap-3 px-4 py-5">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center bg-slate-50 text-slate-400 ring-1 ring-inset ring-slate-200">
                    <BookmarkCheck className="h-4 w-4" />
                  </span>
                  <p className="text-sm text-slate-500">No plans saved for this period yet.</p>
                </div>
              ) : (
                <ul>
                  {data.plans.map((plan) => {
                    const active = activePlanId === plan.id;
                    return (
                      <li
                        key={plan.id}
                        className={cn(
                          "flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3",
                          TABLE_ROW_CLASS,
                          active && "bg-orange-50/60 shadow-[inset_3px_0_0_#F97316]",
                        )}
                      >
                        <div className="min-w-0 flex-1 basis-56">
                          <p className="flex flex-wrap items-center gap-2 break-words text-sm font-bold text-slate-900">
                            <span className="min-w-0 break-words">{plan.name}</span>
                            {active ? (
                              <span className="border border-orange-200 bg-white px-1.5 py-0.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-orange-700">
                                Open now
                              </span>
                            ) : null}
                          </p>
                          <p className="text-phx-xs text-slate-500">
                            Saved {plan.updatedAtLabel} · {formatEgpFull(plan.forecastValue)} forecast
                          </p>
                        </div>
                        <div className="w-28">
                          <AchievementMeter value={plan.forecastAchievement} />
                        </div>
                        <button
                          className={cn("px-3 py-1.5 text-xs font-bold", SECONDARY_BUTTON, FOCUS_RING)}
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
            // Below lg the portal's fixed bottom nav (z-40, 60px + the safe area) covered the bottom of
            // this bar — on a 375px phone its Save plan / Clear row. In the portal it stops above the
            // nav; it stays `sticky`, never `fixed`, because the page-transition wrapper keeps its
            // transform and a fixed bar would anchor to the page, not the screen. The admin shell has
            // no bottom nav, so it keeps `bottom-0`.
            <div
              className={cn(
                "sticky z-20 border border-slate-200 border-t-[3px] border-t-orange-500 bg-white px-4 py-3 shadow-[0_-8px_24px_rgba(15,23,42,0.08)] sm:px-6",
                surface === "portal" ? "bottom-[calc(env(safe-area-inset-bottom,0px)+4.25rem)] lg:bottom-0" : "bottom-0",
              )}
            >
              <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
                <div className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-2">
                  <div>
                    <p className={LABEL_CLASS}>Your forecast</p>
                    <p className="text-lg font-black tabular-nums text-amber-600">{formatEgpFull(forecastTotal)}</p>
                  </div>
                  <div className="w-36">
                    <p className="flex items-baseline justify-between gap-2 text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500">
                      Achievement
                      <span className={cn("text-sm tabular-nums tracking-normal", achievementTone(overallPct))}>
                        {formatPct(overallPct)}
                      </span>
                    </p>
                    <span className="mt-1.5 block">
                      <ProportionBar color={achievementHex(overallPct)} fraction={overallPct ?? 0} />
                    </span>
                  </div>
                  {/* Pedia alone: its total half IS the achievement beside it, so only the Sato half is added. */}
                  {halves.filter((half) => half.key === "sato" || data.lines.length > 1).map((half) => (
                    <div key={half.key} className="w-36">
                      <p className="flex items-baseline justify-between gap-2 text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500">
                        {half.key === "sato" ? "Sato half" : "Total half"}
                        <span className={cn("text-sm tabular-nums tracking-normal", achievementTone(half.achievement))}>
                          {formatPct(half.achievement)}
                        </span>
                      </p>
                      <span className="mt-1.5 block">
                        <ProportionBar color={achievementHex(half.achievement)} fraction={half.achievement ?? 0} />
                      </span>
                    </div>
                  ))}
                  {data.canSave && isDirty ? (
                    <span className="inline-flex items-center gap-1.5 border border-amber-200 bg-amber-50 px-2 py-1 text-phx-xs font-bold text-amber-700">
                      <CircleAlert className="h-3.5 w-3.5 shrink-0" />
                      Not saved yet
                    </span>
                  ) : data.canSave && activePlanId ? (
                    <span className="inline-flex items-center gap-1.5 border border-emerald-200 bg-emerald-50 px-2 py-1 text-phx-xs font-bold text-emerald-700">
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                      Saved
                    </span>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {data.canSave ? (
                    <button
                      className={cn("inline-flex items-center gap-1.5 px-4 py-2 text-sm font-black", PRIMARY_BUTTON, FOCUS_RING)}
                      onClick={jumpToSave}
                      type="button"
                    >
                      <Save className="h-4 w-4" />
                      {activePlanId ? "Save changes" : "Save plan"}
                    </button>
                  ) : null}
                  <button
                    className={cn("inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold", SECONDARY_BUTTON, FOCUS_RING)}
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
  if (gap == null) return <p className="text-phx-xs text-slate-500">No target</p>;
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
      <p className="text-phx-xs text-slate-500">
        {units != null && units > 0 ? `${formatNumber(units)} units to go` : "still to go"}
      </p>
    </>
  );
}

/** The Pedia halves under one scenario card: each on its own target, red while it falls short. */
function ScenarioHalves({ checks }: { checks: GoalCheck[] }) {
  return (
    <ul className="mt-1.5 space-y-0.5 text-phx-xs">
      {checks.map((check) => (
        <li key={check.key} className="flex flex-wrap items-baseline justify-between gap-x-2">
          <span className="min-w-0 break-words font-bold text-slate-600">{check.key === "sato" ? "Sato half" : check.label}</span>
          <span className={cn("font-black tabular-nums", check.reachesGoal === false ? "text-red-700" : achievementTone(check.achievement))}>
            {formatPct(check.achievement)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Pedia is paid on two halves from Semester 2 2026 (src/lib/incentives/pedia-split.ts): one month
 * of basic on the Sato products alone, one on the whole line. The plan shows both, live, so a
 * forecast can never read 100% while the Sato half sits below the 90% floor unseen.
 */
function PediaHalvesPanel({
  halves,
  goalPct,
  open,
  semester,
}: {
  halves: GoalCheck[];
  goalPct: number;
  open: boolean;
  /** The incentive is a SEMESTER figure: only a semester plan may say what a half will pay. */
  semester: boolean;
}) {
  return (
    <section className={cn(SURFACE_CLASS, "border-l-[3px] border-l-orange-500 px-4 py-4 sm:px-6")}>
      <p className="text-sm font-black text-slate-900">Pedia is paid on two halves, and Phoenix plans both</p>
      <p className="mt-0.5 break-words text-phx-xs text-slate-500">
        One month of basic on the Sato products against their own target, one month on the whole line. Other products lift only the
        total half, so Phoenix plans the Sato products to your {goalPct}% goal first. Below 90% a half pays nothing.
      </p>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {halves.map((half) => {
          const belowFloor = half.achievement != null && half.achievement < INCENTIVE_FLOOR;
          return (
            <div key={half.key} className="min-w-0 border border-slate-200 bg-white px-3.5 py-3">
              <p className="break-words text-xs font-black text-slate-900">{half.label}</p>
              <div className="mt-1.5">
                <AchievementMeter value={half.achievement} />
              </div>
              <dl className="mt-2 grid grid-cols-3 gap-2 text-phx-xs">
                <div className="min-w-0">
                  <dt className="font-black uppercase tracking-[0.12em] text-slate-500">Target</dt>
                  <dd className="break-words font-bold tabular-nums text-slate-900">
                    {half.targetValue == null ? "No target" : formatEgpFull(half.targetValue)}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="font-black uppercase tracking-[0.12em] text-slate-500">Sold so far</dt>
                  <dd className="break-words font-bold tabular-nums text-slate-900">{formatEgpFull(half.gradedValue)}</dd>
                </div>
                <div className="min-w-0">
                  <dt className="font-black uppercase tracking-[0.12em] text-slate-500">Forecast</dt>
                  <dd className="break-words font-bold tabular-nums text-orange-700">{formatEgpFull(half.forecastValue)}</dd>
                </div>
              </dl>
              {half.reachesGoal == null ? null : half.reachesGoal ? (
                <p className="mt-2 break-words text-phx-xs font-bold text-emerald-700">Reaches your {goalPct}% goal.</p>
              ) : (
                <p className="mt-2 break-words text-phx-xs font-bold text-red-700">
                  {formatEgpFull(half.shortOfGoal ?? 0)} short of your {goalPct}% goal{open ? " on this forecast" : ""}.
                </p>
              )}
              {belowFloor ? (
                <p className="mt-1 break-words text-phx-xs font-bold text-red-700">
                  {semester
                    ? "Below 90%, this half of the incentive pays nothing."
                    : "Below 90%, the floor this half of the semester incentive pays from."}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function FilterBar({
  surface,
  lines,
  filters,
  onFilters,
  shownRows,
  totalRows,
  busy,
  exportStatus,
  onExport,
}: {
  surface: "sales" | "portal";
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
        <span className="w-full text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500 sm:w-16">{label}</span>
        <div aria-label={`Filter by ${label.toLowerCase()}`} className="flex min-w-0 flex-1 flex-wrap gap-1.5" role="group">
          {options.map((option) => {
            const selected = filters[key].includes(option.value);
            return (
              <button
                key={option.value}
                aria-pressed={selected}
                className={cn(chipClass(selected, surface), "inline-flex items-center gap-1.5 px-2.5")}
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
        className={cn(SECONDARY_BUTTON, "inline-flex h-10 items-center gap-1.5 px-3 text-xs font-black lg:h-8", FOCUS_RING)}
        disabled={busy !== null}
        onClick={() => onExport(format)}
        type="button"
      >
        {busy === format ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Icon className={cn("h-3.5 w-3.5", format === "xlsx" ? "text-emerald-600" : "text-red-600")} />
        )}
        {format === "xlsx" ? "Export Excel" : "Export PDF"}
      </button>
    );
  };

  // The portal header matches SectionCard's `surface="portal"` scale, so this card reads as one with
  // the line sections and Saved plans below it. The admin header is unchanged.
  const portal = surface === "portal";

  return (
    <section className={SURFACE_CLASS}>
      <header
        className={cn(
          "flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4",
          portal ? "py-4 sm:px-5" : "py-3",
        )}
      >
        <div className={cn("flex min-w-0 flex-1 basis-64 gap-2.5", portal ? "items-start gap-3" : "items-center")}>
          <span
            className={cn(
              "flex shrink-0 items-center justify-center bg-orange-50 text-orange-600 ring-1 ring-inset ring-orange-100",
              portal ? "h-9 w-9" : "h-7 w-7",
            )}
          >
            <SlidersHorizontal className={portal ? "h-4 w-4" : "h-3.5 w-3.5"} />
          </span>
          <div className="min-w-0">
            <h2
              className={
                portal
                  ? "break-words text-lg font-black leading-tight tracking-tight text-slate-950 sm:text-xl"
                  : "text-phx-md font-black tracking-tight text-slate-900"
              }
            >
              Filter and export
            </h2>
            <p className={portal ? "mt-1 break-words text-sm font-medium leading-6 text-slate-500" : "break-words text-phx-xs text-slate-500"}>
              Showing {formatNumber(shownRows)} of {formatNumber(totalRows)} products. The totals above always cover the whole plan;
              a file holds exactly what you see here.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {active ? (
            <button
              className={cn(SECONDARY_BUTTON, "inline-flex h-10 items-center gap-1.5 px-3 text-xs font-bold lg:h-8", FOCUS_RING)}
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
      <div className="space-y-2.5 bg-slate-50/70 px-4 py-3">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <label className="relative block min-w-0">
            <span className="sr-only">Find a product or family</span>
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              className={cn(FIELD, "w-full pl-8 pr-2 lg:h-8")}
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
              "flex items-start gap-2 border border-l-[3px] px-3 py-2 text-sm font-semibold",
              exportStatus.ok
                ? "border-emerald-200 border-l-emerald-500 bg-emerald-50/40 text-emerald-800"
                : "border-red-200 border-l-red-500 bg-red-50/40 text-red-700",
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
        "inline-flex max-w-full items-center gap-1 border px-1.5 py-0.5 text-phx-2xs font-black uppercase tracking-[0.08em]",
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
          className="block w-2 bg-orange-400"
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
    return <p className="mt-1 text-right text-phx-2xs font-bold text-emerald-700">At its realistic level</p>;
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

/**
 * A product's bricks and their forecast (engine.ts rule 9). Each brick's share comes from its own
 * sales of the product; its history is never shown. Open at first for one person's plan, folded on a
 * team plan, where one product can sell on dozens of bricks.
 */
function BrickList({
  productName,
  bricks,
  price,
  text,
  invalid,
  onBrick,
  openAtFirst,
}: {
  productName: string;
  bricks: BrickPlanRow[];
  price: number;
  text: Record<string, string>;
  invalid: (brickId: string) => boolean;
  onBrick: (brickId: string, raw: string) => void;
  openAtFirst: boolean;
}) {
  const [open, setOpen] = useState(openAtFirst);
  const held = bricks.filter((brick) => (parseForecastUnits(text[brick.brickId]) ?? 0) > 0).length;
  return (
    <div className="border border-slate-200 bg-white">
      <button
        aria-expanded={open}
        className={cn(
          "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-bold text-slate-700 hover:bg-orange-50",
          FOCUS_RING,
        )}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span className="min-w-0 break-words">
          By brick · {bricks.length} brick{bricks.length === 1 ? "" : "s"}
          {held > 0 ? <span className="font-normal text-slate-500"> · {held} planned</span> : null}
        </span>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-slate-400 transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <>
          <p className="border-t border-slate-100 px-3 py-1.5 text-phx-2xs text-slate-500">
            Each brick&apos;s share comes from its own sales of {productName}. Change any brick and the product total follows.
          </p>
          <table className="w-full table-fixed text-sm">
            <colgroup>
              <col className="w-[40%]" />
              <col className="w-[30%]" />
              <col className="w-[30%]" />
            </colgroup>
            <thead className={TABLE_HEAD_CLASS}>
              <tr>
                <th className="px-3 py-1.5 text-left">Brick</th>
                <th className="px-3 py-1.5 text-right">Forecast units</th>
                <th className="px-3 py-1.5 text-right">Forecast value</th>
              </tr>
            </thead>
            <tbody>
              {bricks.map((brick) => {
                const units = parseForecastUnits(text[brick.brickId]) ?? 0;
                const bad = invalid(brick.brickId);
                return (
                  <tr key={brick.brickId} className="border-t border-slate-100 align-top">
                    <td className="px-3 py-1.5">
                      <p className="break-words text-left font-bold text-slate-800" dir="auto">
                        {brick.name}
                      </p>
                    </td>
                    <td className="px-3 py-1.5">
                      <input
                        aria-label={`Forecast units for ${productName} in ${brick.name}`}
                        className={cn(
                          FIELD,
                          "w-full text-right tabular-nums",
                          bad && "border-red-500 text-red-700 hover:border-red-500",
                        )}
                        enterKeyHint="next"
                        inputMode="numeric"
                        onChange={(event) => onBrick(brick.brickId, event.target.value)}
                        onFocus={(event) => event.currentTarget.select()}
                        placeholder="0"
                        value={text[brick.brickId] ?? ""}
                      />
                      {bad ? <p className="mt-1 text-right text-phx-2xs font-bold text-red-600">Whole units only</p> : null}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      <p className={cn("break-words font-bold", units > 0 ? "text-orange-700" : "text-slate-500")}>
                        {formatEgpFull(units * price)}
                      </p>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      ) : null}
    </div>
  );
}

function LineSection({
  surface,
  line,
  rows,
  totalRows,
  units,
  forecastValue,
  invalid,
  onUnits,
  bricksOpenAtFirst,
  brickText,
  brickInvalid,
  onBrick,
}: {
  surface: "sales" | "portal";
  line: LinePlanGroup;
  rows: FilteredRow[];
  totalRows: number;
  units: Record<string, string>;
  forecastValue: number;
  invalid: (code: string) => boolean;
  onUnits: (code: string, raw: string) => void;
  bricksOpenAtFirst: boolean;
  brickText: (row: ConcentrationPlanRow) => Record<string, string>;
  brickInvalid: (code: string, brickId: string) => boolean;
  onBrick: (row: ConcentrationPlanRow, brickId: string, raw: string) => void;
}) {
  const open = line.remainingMonths > 0;
  const linePct = achievementOf(line.gradedValue, forecastValue, line.targetValue);
  const untargetedText =
    line.untargetedMonthLabels.length > 0 ? ` · ${line.untargetedMonthLabels.join(", ")} not forecast, no target yet` : "";
  const subtitle = !open
    ? line.untargetedMonthLabels.length > 0
      ? `No open month carries a target yet${untargetedText}`
      : "Every month of this period is closed"
    : line.closedMonthLabels.length === 0
      ? `Nothing closed yet · forecasting ${line.forecastMonthLabels.join(", ")}${untargetedText}`
      : `Closed ${line.closedMonthLabels.join(", ")} · forecasting ${line.forecastMonthLabels.join(", ")}${untargetedText}`;
  const shownText = rows.length < totalRows ? ` · showing ${rows.length} of ${totalRows} products` : "";
  const lineGap = line.targetValue == null ? null : line.targetValue - line.gradedValue - forecastValue;

  const unitsInput = (row: ConcentrationPlanRow, label: string) => (
    <input
      aria-label={label}
      className={cn(
        FIELD,
        "w-full text-right tabular-nums",
        invalid(row.productCode) && "border-red-500 text-red-700 hover:border-red-500",
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

  const brickList = (row: ConcentrationPlanRow) =>
    open && row.bricks.length > 0 ? (
      <BrickList
        bricks={row.bricks}
        invalid={(brickId) => brickInvalid(row.productCode, brickId)}
        onBrick={(brickId, raw) => onBrick(row, brickId, raw)}
        openAtFirst={bricksOpenAtFirst}
        price={row.price}
        productName={row.name}
        text={brickText(row)}
      />
    ) : null;

  const detailText = (row: ConcentrationPlanRow) =>
    [
      open && row.trend.realisticMaxUnits > 0 ? `Realistic up to ${formatNumber(row.trend.realisticMaxUnits)} units` : null,
      row.history.length > 0 ? row.history.map((point) => `${point.label} ${formatNumber(point.units)}`).join(" · ") : null,
    ]
      .filter(Boolean)
      .join(" · ");

  return (
    <SectionCard
      surface={surface}
      actions={
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
          <span>
            Target <b className="tabular-nums text-slate-900">{line.targetValue == null ? "—" : formatEgpFull(line.targetValue)}</b>
          </span>
          <span>
            Forecast <b className="tabular-nums text-orange-600">{formatEgpFull(forecastValue)}</b>
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
          <thead className={TABLE_HEAD_CLASS}>
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
          <tbody>
            {rows.map(({ row, figures }) => {
              const planned = figures.typedUnits > 0;
              const bricks = brickList(row);
              return (
                <Fragment key={row.productCode}>
                <tr className={cn(TABLE_ROW_CLASS, "align-top", planned && "bg-orange-50/50")}>
                  <td className={cn("px-3 py-2.5", planned && "shadow-[inset_3px_0_0_#F97316]")}>
                    <p className="break-words font-bold text-slate-900">{row.name}</p>
                    <p className="break-words text-phx-xs text-slate-500">
                      {row.family ? `${row.family} · ` : ""}
                      {formatEgpFull(row.price)} a unit
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-end gap-x-2 gap-y-1">
                      <TrendBadge trend={row.trend} />
                      <HistoryBars history={row.history} />
                    </div>
                    {detailText(row) ? (
                      <p className="mt-1 break-words text-phx-2xs tabular-nums text-slate-500">{detailText(row)}</p>
                    ) : null}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    <p className="break-words font-bold">{row.targetValue == null ? "—" : formatEgpFull(row.targetValue)}</p>
                    <p className="text-phx-xs text-slate-500">
                      {row.targetUnits == null ? "No target" : `${formatNumber(row.targetUnits)} units`}
                    </p>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    <p className="break-words font-bold">{formatEgpFull(row.gradedValue)}</p>
                    <p className="text-phx-xs text-slate-500">{formatNumber(row.gradedUnits)} units</p>
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
                    <p className={cn("break-words font-bold", planned ? "text-orange-700" : "text-slate-900")}>
                      {formatEgpFull(figures.value)}
                    </p>
                    <p className="text-phx-xs text-slate-500">
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
                {bricks ? (
                  <TableRowDetail className="pl-8 pt-0" colSpan={7}>
                    {bricks}
                  </TableRowDetail>
                ) : null}
                </Fragment>
              );
            })}
          </tbody>
          <tfoot className="border-t-2 border-slate-200 bg-slate-50 font-black tabular-nums text-slate-900">
            <tr>
              <td className="px-3 py-3">{line.lineName} total</td>
              <td className="px-3 py-3 text-right">{line.targetValue == null ? "—" : formatEgpFull(line.targetValue)}</td>
              <td className="px-3 py-3 text-right">{formatEgpFull(line.gradedValue)}</td>
              <td className="px-3 py-3 text-right text-phx-xs font-bold text-slate-500">By value</td>
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

      <div className="divide-y divide-slate-100 xl:hidden">
        {rows.map(({ row, figures }) => {
          const planned = figures.typedUnits > 0;
          return (
            <div
              key={row.productCode}
              className={cn(
                "space-y-2.5 px-4 py-3 transition-colors hover:bg-orange-50/40",
                planned && "bg-orange-50/50 shadow-[inset_3px_0_0_#F97316]",
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="break-words font-bold text-slate-900">{row.name}</p>
                  <p className="break-words text-phx-xs text-slate-500">
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
                  <dt className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">Target</dt>
                  <dd className="font-bold tabular-nums">{row.targetValue == null ? "—" : formatEgpFull(row.targetValue)}</dd>
                  <dd className="text-slate-500">
                    {row.targetUnits == null ? "No target" : `${formatNumber(row.targetUnits)} units`}
                  </dd>
                </div>
                <div>
                  <dt className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">Sold so far</dt>
                  <dd className="font-bold tabular-nums">{formatEgpFull(row.gradedValue)}</dd>
                  <dd className="text-slate-500">{formatNumber(row.gradedUnits)} units</dd>
                </div>
                <div className="col-span-2 border-t border-dashed border-slate-200 pt-2">
                  <dt className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">Gap to target</dt>
                  <dd className="tabular-nums">
                    <GapToTarget gap={figures.gapValue} units={figures.gapUnits} />
                  </dd>
                </div>
              </dl>
              <div className="grid grid-cols-2 items-start gap-2">
                <label className="block">
                  <span className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">Forecast units</span>
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
                  <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">Forecast value</p>
                  <p className={cn("text-sm font-black tabular-nums", planned ? "text-orange-700" : "text-slate-900")}>
                    {formatEgpFull(figures.value)}
                  </p>
                  <p className="text-slate-500">
                    Units <span className={achievementTone(figures.unitsAchievement)}>{formatPct(figures.unitsAchievement)}</span>
                  </p>
                </div>
              </div>
              {detailText(row) ? (
                <p className="break-words text-phx-2xs tabular-nums text-slate-500">{detailText(row)}</p>
              ) : null}
              {brickList(row)}
            </div>
          );
        })}
        <div className="flex items-center justify-between gap-3 border-t-2 border-slate-200 bg-slate-50 px-4 py-3 text-sm font-black tabular-nums text-slate-900">
          <span className="min-w-0 break-words">
            {line.lineName} forecast {formatEgpFull(forecastValue)}
            <span className="block text-phx-xs font-bold text-slate-500">
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

/**
 * A team row's "at current pace" cell. For a Pedia rep (engine.ts rule 7) it shows BOTH halves —
 * Total (the rep's `expectedAchievement`) and Sato (Guamusin + Ivyronc at pace) — because one
 * number would hide a Sato half that pays nothing while the line total looks fine. Every other rep
 * keeps the single pace meter.
 */
function TeamPaceCell({ rep }: { rep: RepPlanSummary }) {
  if (!rep.pediaSato) return <AchievementMeter value={rep.expectedAchievement} />;
  return (
    <div className="space-y-1.5">
      <div>
        <p className="flex items-baseline justify-between gap-2 text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-500">
          Total
          <span className={cn("text-phx-xs tabular-nums tracking-normal", achievementTone(rep.expectedAchievement))}>
            {formatPct(rep.expectedAchievement)}
          </span>
        </p>
        <ProportionBar color={achievementHex(rep.expectedAchievement)} fraction={rep.expectedAchievement ?? 0} />
      </div>
      <div>
        <p className="flex items-baseline justify-between gap-2 text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-500">
          Sato
          <span
            className={cn(
              "text-phx-xs tabular-nums tracking-normal",
              rep.pediaSato.achievement != null && rep.pediaSato.achievement < INCENTIVE_FLOOR
                ? "text-red-700"
                : achievementTone(rep.pediaSato.achievement),
            )}
          >
            {rep.pediaSato.hasTarget ? formatPct(rep.pediaSato.achievement) : "No target"}
          </span>
        </p>
        <ProportionBar color={achievementHex(rep.pediaSato.achievement)} fraction={rep.pediaSato.achievement ?? 0} />
      </div>
    </div>
  );
}

function TeamSection({
  data,
  href,
  surface,
}: {
  surface: "sales" | "portal";
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
      surface={surface}
      icon={Users}
      subtitle="At current pace is where each person lands if their own trend simply continues. On track is 100% or more, close is 80 to 99%. Open anyone to see and plan their products."
      title="Your team"
    >
      <div className={cn(CONTROL_STRIP, "flex flex-col gap-3 px-4 py-3 xl:flex-row xl:items-center xl:justify-between")}>
        <div aria-label="Filter the team by pace" className="flex flex-wrap gap-1.5" role="group">
          {TEAM_BUCKETS.map((option) => {
            const selected = bucket === option.value;
            return (
              <button
                key={option.value}
                aria-pressed={selected}
                className={cn(chipClass(selected, surface), "inline-flex items-center gap-1.5 px-2.5")}
                onClick={() => setBucket(option.value)}
                type="button"
              >
                <span aria-hidden className={cn("h-2 w-2 shrink-0", option.swatch, selected && "ring-1 ring-white")} />
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
              className={cn(FIELD, "w-full pl-8 pr-2 lg:h-8")}
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
                className={cn(chipClass(sort === option.value, surface), "h-10 px-2.5 lg:h-8")}
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
        <p className="px-4 py-6 text-center text-sm text-slate-500">Nobody in your team matches that filter.</p>
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
              <thead className={TABLE_HEAD_CLASS}>
                <tr>
                  <th className="px-3 py-2 text-left">Person</th>
                  <th className="px-3 py-2 text-right">Target</th>
                  <th className="px-3 py-2 text-right">Sold so far</th>
                  <th className="px-3 py-2 text-right">At current pace</th>
                  <th className="px-3 py-2 text-right">Saved plans</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((rep) => (
                  <tr key={rep.key} className={TABLE_ROW_CLASS}>
                    <td className="px-3 py-2.5">
                      <Link
                        className={cn("break-words font-bold text-slate-900 transition-colors hover:text-orange-600", FOCUS_RING)}
                        href={repHref(rep.key)}
                      >
                        {rep.name}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5 text-right font-bold tabular-nums text-slate-900">
                      {rep.targetValue == null ? "—" : formatEgpFull(rep.targetValue)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-bold tabular-nums text-slate-900">{formatEgpFull(rep.gradedValue)}</td>
                    <td className="px-3 py-2.5">
                      <TeamPaceCell rep={rep} />
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <Link
                        className={cn(SECONDARY_BUTTON, "inline-flex items-center gap-1.5 px-3 py-1 text-xs font-bold", FOCUS_RING)}
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
          <ul className="divide-y divide-slate-100 lg:hidden">
            {visible.map((rep) => (
              <li key={rep.key}>
                <Link className={cn("block space-y-1.5 px-4 py-3 transition-colors hover:bg-orange-50/40", FOCUS_RING)} href={repHref(rep.key)}>
                  <span className="flex items-start justify-between gap-3">
                    <span className="min-w-0 break-words font-bold text-slate-900">{rep.name}</span>
                    <span className="w-28 shrink-0">
                      <TeamPaceCell rep={rep} />
                    </span>
                  </span>
                  <span className="block text-xs text-slate-500">
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
