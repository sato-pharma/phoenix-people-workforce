"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ArrowLeft, BookmarkCheck, Layers, RotateCcw, Save, Sparkles, Users } from "lucide-react";

import {
  AchievementMeter,
  AchievementRing,
  BandChoice,
  BandStat,
  CommandBand,
  SectionCard,
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
  type TrendReading,
} from "@/lib/sales/make-it-happen/engine";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// Make It Happen — the planner screen.
//
// The user types UNITS only. Value (units × factory price) and achievement % are recomputed here on
// every keystroke from the same pure engine the server saves with. Units are never totalled across
// concentrations; every total above a product row is VALUE.
//
// Owner rule 2026-08-04: nothing on this screen says AI. Phoenix builds the plan.
// ─────────────────────────────────────────────────────────────────────────────

type Coach = { message: string; reachable: boolean | null };

function trendNote(trend: TrendReading): string {
  switch (trend.kind) {
    case "none":
      return "No closed sales yet";
    case "early":
      return `Average of ${trend.historyMonths} closed month${trend.historyMonths === 1 ? "" : "s"}`;
    case "growing":
      return "Growing month by month";
    case "flat":
      return "Steady month by month";
    case "declining":
      return "Declining, held at its recent level";
  }
}

function monthsText(count: number): string {
  return `${count} month${count === 1 ? "" : "s"}`;
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
  const [units, setUnits] = useState<Record<string, string>>({});
  const [coach, setCoach] = useState<Coach | null>(null);
  const [busy, setBusy] = useState<"suggest" | "save" | null>(null);
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

  async function makeItHappen() {
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
      return;
    }
    if (hasInvalid) {
      setError("Units must be whole numbers of zero or more. Fix the highlighted boxes first.");
      return;
    }
    setBusy("save");
    setError(null);
    setNotice(null);
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
    setPlanName(plan.name);
    setActivePlanId(data.canSave ? plan.id : null);
    setCoach(null);
    setError(null);
    setNotice(`Opened "${plan.name}".`);
  }

  function clearForecast() {
    setUnits({});
    setCoach(null);
    setActivePlanId(null);
    setPlanName("");
    setNotice(null);
    setError(null);
  }

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
        <div className="flex flex-wrap items-center justify-between gap-2 border border-sky-200 bg-sky-50 px-4 py-2.5 text-sm">
          <p className="font-bold text-sky-900">You are looking at {data.viewingRep.name}&apos;s own plan.</p>
          <Link
            className="inline-flex items-center gap-1.5 border border-sky-300 bg-white px-3 py-1 text-xs font-bold text-sky-800 hover:border-sky-500"
            href={href({ period: data.periodKey })}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to the team
          </Link>
        </div>
      ) : null}

      {data.isEmptyScope ? (
        <section className="border border-border bg-card px-5 py-8 text-center">
          <p className="text-sm font-bold text-foreground">There are no sales or targets to plan for {data.periodLabel} in your scope.</p>
          <p className="mt-1 text-phx-xs text-muted-foreground">Pick another period above, or check back once a target is loaded.</p>
        </section>
      ) : (
        <>
          <section className="border border-orange-200 bg-orange-50/60 px-4 py-4 sm:px-6">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
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
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  className="inline-flex items-center justify-center gap-2 border border-orange-600 bg-orange-500 px-5 py-3 text-sm font-black text-white shadow-sm transition-colors hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={!openForForecast || busy !== null}
                  onClick={makeItHappen}
                  type="button"
                >
                  <Sparkles className="h-4 w-4 shrink-0" />
                  {busy === "suggest" ? "Phoenix is building your plan" : "Press here and Phoenix will Make It Happen"}
                </button>
                <button
                  className="inline-flex items-center gap-1.5 border border-slate-300 bg-white px-3 py-3 text-xs font-bold text-slate-700 hover:border-slate-500 disabled:opacity-60"
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
              <p
                className={cn(
                  "mt-3 border-l-4 bg-white px-3 py-2 text-sm font-semibold",
                  coach.reachable === false ? "border-amber-500 text-amber-900" : "border-emerald-500 text-emerald-900",
                )}
                role="status"
              >
                {coach.message}
              </p>
            ) : null}
            {error ? (
              <p className="mt-3 border-l-4 border-red-500 bg-white px-3 py-2 text-sm font-semibold text-red-700" role="alert">
                {error}
              </p>
            ) : null}
            {notice ? (
              <p className="mt-3 border-l-4 border-sky-500 bg-white px-3 py-2 text-sm font-semibold text-sky-900" role="status">
                {notice}
              </p>
            ) : null}
          </section>

          {data.lines.map((line) => (
            <LineSection
              key={line.lineCode}
              forecastValue={lineForecasts.get(line.lineCode) ?? 0}
              invalid={isInvalid}
              line={line}
              onUnits={(code, raw) => setUnits((current) => ({ ...current, [code]: raw }))}
              units={units}
            />
          ))}

          {data.reps.length > 0 ? <TeamSection data={data} href={href} /> : null}

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
              <div className="flex flex-wrap items-end gap-2 border-b border-border px-4 py-3">
                <label className="min-w-0 flex-1 basis-56">
                  <span className="text-phx-2xs font-black uppercase tracking-[0.14em] text-muted-foreground">Plan name</span>
                  <input
                    className="mt-1 w-full border border-border bg-background px-3 py-2 text-sm"
                    maxLength={80}
                    onChange={(event) => setPlanName(event.target.value)}
                    placeholder="For example: September push"
                    value={planName}
                  />
                </label>
                <button
                  className="inline-flex items-center gap-1.5 border border-orange-600 bg-orange-500 px-4 py-2 text-sm font-bold text-white hover:bg-orange-600 disabled:opacity-60"
                  disabled={busy !== null}
                  onClick={() => savePlan(false)}
                  type="button"
                >
                  <Save className="h-4 w-4" />
                  {activePlanId ? "Save changes" : "Save plan"}
                </button>
                {activePlanId ? (
                  <button
                    className="inline-flex items-center gap-1.5 border border-slate-300 bg-white px-4 py-2 text-sm font-bold text-slate-700 hover:border-slate-500 disabled:opacity-60"
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
              <p className="px-4 py-4 text-sm text-muted-foreground">No plans saved for this period yet.</p>
            ) : (
              <ul className="divide-y divide-border">
                {data.plans.map((plan) => (
                  <li key={plan.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
                    <div className="min-w-0">
                      <p className="break-words text-sm font-bold text-foreground">{plan.name}</p>
                      <p className="text-phx-xs text-muted-foreground">
                        Saved {plan.updatedAtLabel} · {formatEgpFull(plan.forecastValue)} forecast ·{" "}
                        <span className={cn("font-bold", achievementTone(plan.forecastAchievement))}>
                          {formatPct(plan.forecastAchievement)}
                        </span>
                      </p>
                    </div>
                    <button
                      className="border border-slate-300 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:border-orange-400"
                      onClick={() => openPlan(plan)}
                      type="button"
                    >
                      Open
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </>
      )}
    </div>
  );
}

function LineSection({
  line,
  units,
  forecastValue,
  invalid,
  onUnits,
}: {
  line: LinePlanGroup;
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

  const rowFigures = (row: ConcentrationPlanRow) => {
    const typedUnits = open ? (parseForecastUnits(units[row.productCode]) ?? 0) : 0;
    const value = typedUnits * row.price;
    return {
      typedUnits,
      value,
      valuePct: achievementOf(row.gradedValue, value, row.targetValue),
      unitsPct: achievementOf(row.gradedUnits, typedUnits, row.targetUnits),
    };
  };

  const unitsInput = (row: ConcentrationPlanRow, label: string) => (
    <input
      aria-label={label}
      className={cn(
        "w-full border bg-background px-2 py-1.5 text-right text-sm font-bold tabular-nums disabled:bg-muted disabled:text-muted-foreground",
        invalid(row.productCode) ? "border-red-500 text-red-700" : "border-border",
      )}
      disabled={!open}
      inputMode="numeric"
      onChange={(event) => onUnits(row.productCode, event.target.value)}
      placeholder="0"
      value={units[row.productCode] ?? ""}
    />
  );

  const historyText = (row: ConcentrationPlanRow) =>
    row.history.length === 0 ? "" : row.history.map((point) => `${point.label} ${formatNumber(point.units)}`).join(" · ");

  return (
    <SectionCard
      actions={
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>
            Target <b className="text-foreground">{line.targetValue == null ? "—" : formatEgpFull(line.targetValue)}</b>
          </span>
          <span>
            Forecast <b className={achievementTone(linePct)}>{formatPct(linePct)}</b>
          </span>
        </div>
      }
      icon={Layers}
      subtitle={subtitle}
      title={line.lineName}
    >
      <div className="hidden lg:block">
        <table className="w-full table-fixed text-sm">
          <colgroup>
            <col className="w-[27%]" />
            <col className="w-[15%]" />
            <col className="w-[15%]" />
            <col className="w-[13%]" />
            <col className="w-[15%]" />
            <col className="w-[15%]" />
          </colgroup>
          <thead className="bg-muted/40 text-phx-2xs font-black uppercase tracking-[0.14em] text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left">Product</th>
              <th className="px-3 py-2 text-right">Target</th>
              <th className="px-3 py-2 text-right">Sold so far</th>
              <th className="px-3 py-2 text-right">Forecast units</th>
              <th className="px-3 py-2 text-right">Forecast value</th>
              <th className="px-3 py-2 text-right">Achievement</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {line.rows.map((row) => {
              const figures = rowFigures(row);
              return (
                <tr key={row.productCode} className="align-top">
                  <td className="px-3 py-2.5">
                    <p className="break-words font-bold text-foreground">{row.name}</p>
                    <p className="break-words text-phx-xs text-muted-foreground">
                      {row.family ? `${row.family} · ` : ""}
                      {formatEgpFull(row.price)} a unit
                    </p>
                    <p className="mt-0.5 break-words text-phx-2xs text-muted-foreground">
                      {trendNote(row.trend)}
                      {open ? ` · realistic up to ${formatNumber(row.trend.realisticMaxUnits)} units` : ""}
                    </p>
                    {historyText(row) ? (
                      <p className="break-words text-phx-2xs tabular-nums text-muted-foreground">{historyText(row)}</p>
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
                    {invalid(row.productCode) ? <p className="mt-0.5 text-right text-phx-2xs text-red-600">Whole units only</p> : null}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    <p className="break-words font-bold">{formatEgpFull(figures.value)}</p>
                    <p className="text-phx-xs text-muted-foreground">
                      Units <span className={achievementTone(figures.unitsPct)}>{formatPct(figures.unitsPct)}</span>
                    </p>
                  </td>
                  <td className="px-3 py-2.5">
                    <AchievementMeter value={figures.valuePct} />
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="border-t-2 border-border bg-muted/30 font-black tabular-nums">
            <tr>
              <td className="px-3 py-2.5">{line.lineName} total</td>
              <td className="px-3 py-2.5 text-right">{line.targetValue == null ? "—" : formatEgpFull(line.targetValue)}</td>
              <td className="px-3 py-2.5 text-right">{formatEgpFull(line.gradedValue)}</td>
              <td className="px-3 py-2.5 text-right text-phx-xs font-bold text-muted-foreground">By value</td>
              <td className="px-3 py-2.5 text-right">{formatEgpFull(forecastValue)}</td>
              <td className="px-3 py-2.5">
                <AchievementMeter value={linePct} />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="divide-y divide-border lg:hidden">
        {line.rows.map((row) => {
          const figures = rowFigures(row);
          return (
            <div key={row.productCode} className="space-y-2 px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="break-words font-bold text-foreground">{row.name}</p>
                  <p className="break-words text-phx-xs text-muted-foreground">
                    {row.family ? `${row.family} · ` : ""}
                    {formatEgpFull(row.price)} a unit
                  </p>
                </div>
                <div className="w-24 shrink-0">
                  <AchievementMeter value={figures.valuePct} />
                </div>
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
              </dl>
              <div className="grid grid-cols-2 items-end gap-2">
                <label className="block">
                  <span className="text-phx-2xs font-black uppercase tracking-[0.12em] text-muted-foreground">Forecast units</span>
                  {unitsInput(row, `Forecast units for ${row.name}`)}
                </label>
                <div className="text-right text-xs">
                  <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-muted-foreground">Forecast value</p>
                  <p className="font-bold tabular-nums">{formatEgpFull(figures.value)}</p>
                  <p className="text-muted-foreground">
                    Units <span className={achievementTone(figures.unitsPct)}>{formatPct(figures.unitsPct)}</span>
                  </p>
                </div>
              </div>
              {invalid(row.productCode) ? <p className="text-phx-2xs text-red-600">Whole units only</p> : null}
              <p className="break-words text-phx-2xs text-muted-foreground">
                {trendNote(row.trend)}
                {open ? ` · realistic up to ${formatNumber(row.trend.realisticMaxUnits)} units` : ""}
                {historyText(row) ? ` · ${historyText(row)}` : ""}
              </p>
            </div>
          );
        })}
        <div className="flex items-center justify-between gap-3 bg-muted/30 px-4 py-3 text-sm font-black tabular-nums">
          <span className="min-w-0 break-words">
            {line.lineName} forecast {formatEgpFull(forecastValue)}
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
  const repHref = (key: string) => href({ period: data.periodKey, rep: key });
  return (
    <SectionCard
      icon={Users}
      subtitle="At current pace is where each person lands if their own trend simply continues. Open anyone to see and plan their products."
      title="Your team"
    >
      <div className="hidden lg:block">
        <table className="w-full table-fixed text-sm">
          <colgroup>
            <col className="w-[28%]" />
            <col className="w-[18%]" />
            <col className="w-[18%]" />
            <col className="w-[18%]" />
            <col className="w-[18%]" />
          </colgroup>
          <thead className="bg-muted/40 text-phx-2xs font-black uppercase tracking-[0.14em] text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left">Person</th>
              <th className="px-3 py-2 text-right">Target</th>
              <th className="px-3 py-2 text-right">Sold so far</th>
              <th className="px-3 py-2 text-right">At current pace</th>
              <th className="px-3 py-2 text-right">Saved plans</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {data.reps.map((rep) => (
              <tr key={rep.key}>
                <td className="px-3 py-2.5">
                  <Link className="break-words font-bold text-foreground hover:text-orange-600" href={repHref(rep.key)}>
                    {rep.name}
                  </Link>
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">{rep.targetValue == null ? "—" : formatEgpFull(rep.targetValue)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{formatEgpFull(rep.gradedValue)}</td>
                <td className="px-3 py-2.5">
                  <AchievementMeter value={rep.expectedAchievement} />
                </td>
                <td className="px-3 py-2.5 text-right">
                  <Link
                    className="inline-block border border-slate-300 bg-white px-3 py-1 text-xs font-bold text-slate-700 hover:border-orange-400"
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
        {data.reps.map((rep) => (
          <li key={rep.key} className="space-y-1.5 px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <Link className="min-w-0 break-words font-bold text-foreground" href={repHref(rep.key)}>
                {rep.name}
              </Link>
              <span className="w-24 shrink-0">
                <AchievementMeter value={rep.expectedAchievement} />
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Target {rep.targetValue == null ? "—" : formatEgpFull(rep.targetValue)} · sold {formatEgpFull(rep.gradedValue)} ·{" "}
              {rep.savedPlans.length} saved plan{rep.savedPlans.length === 1 ? "" : "s"}
            </p>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}
