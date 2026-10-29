"use client";

// Weekly Sales — the FIELD FORCE tab (the default tab).
//
// WHAT THE OWNER ASKED FOR, IN HIS WORDS: "their main objective is to know their medical reps week
// by week per product". The other tab answers "what did the region do"; this one answers "what did
// each of my people do". So the row is a PERSON, the columns are WEEKS, and opening a person gives
// products down the side with the same weeks across the top.
//
// THREE RULES THIS FILE IS BUILT AROUND
//
//  1. UNITS ARE NEVER ADDED ACROSS PRODUCTS (owner rule). So the league table — where one row spans
//     every product a rep sold — is in EGP, and units appear ONLY inside the expanded product grid,
//     where each number sits under exactly one product code. There is no "total units" anywhere.
//
//  2. AN ALLOCATED NUMBER IS NEVER SHOWN AS AN OBSERVED ONE. A weekly row is a depot shipment.
//     Where the owner mapped the branch by hand the credit is exact; everywhere else it is spread
//     by the branch name. Every rep row therefore carries its exact/allocated mix, and a rep whose
//     number is mostly allocated is marked so the owner does not manage someone on an estimate.
//
//  3. FITS THE SCREEN, NEVER TRUNCATED (owner golden rules). Nothing scrolls sideways: each table is
//     fixed-layout with every column width declared, so it can never grow past its container, and a
//     long name WRAPS instead (vertical space is free, horizontal is not). It fits by MERGING columns,
//     never by shrinking type: area, region and district manager sit under the rep's name, and the
//     share sits under the period total. Mobile gets cards, never a squeezed table. Corners are square.

import { Fragment, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Crosshair,
  Layers,
  MapPin,
  Package,
  Search,
  Target,
  UserRound,
  Users,
} from "lucide-react";

import {
  fieldForceLeagueColumns,
  fieldForceProductColumns,
} from "@/components/sales/weekly/weekly-table-widths";
import { rowDetailToggleProps, TableRowDetail } from "@/components/ui/table-row-detail";
import type {
  FieldForceRep,
  PortalWeeklyFieldForce,
} from "@/lib/sales/weekly/portal-weekly-field-force";
import { weeklyAreaLabel, weeklyPersonLabel, weeklyRegionLabel } from "@/lib/sales/weekly/display-labels";
import { WEEKLY_UNITS_UNDER_ONE, weeklyUnitsUnderOne } from "@/lib/sales/weekly/unit-totals";

// ── formatting (kept identical to the sibling tab so one screen speaks one language) ──────────
function formatEgp(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `EGP ${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `EGP ${(value / 1_000).toFixed(1)}K`;
  return `EGP ${Math.round(value).toLocaleString("en-US")}`;
}
function formatEgpFull(value: number): string {
  return `EGP ${Math.round(value).toLocaleString("en-US")}`;
}
function formatNumber(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}
function formatPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** A unit figure in a week cell: a share under one unit reads "<1", never the dash of an empty week. */
function unitsCell(units: number): string {
  if (weeklyUnitsUnderOne(units)) return WEEKLY_UNITS_UNDER_ONE;
  return units > 0 ? formatNumber(units) : "—";
}
/** A product's unit total: a share under one unit reads "<1", never a "0" beside the money it earned. */
function unitsTotal(units: number): string {
  return weeklyUnitsUnderOne(units) ? WEEKLY_UNITS_UNDER_ONE : formatNumber(units);
}

type SortKey = "value" | "name" | "area";

export function PortalWeeklyFieldForceView({
  fieldForce,
  scopeSummary,
}: {
  fieldForce: PortalWeeklyFieldForce | null;
  scopeSummary: string;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("value");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showVacant, setShowVacant] = useState(true);

  const weeks = fieldForce?.weekNumbers ?? [];
  const gapWeeks = useMemo(() => new Set(fieldForce?.gapWeekNumbers ?? []), [fieldForce]);

  const rows = useMemo(() => {
    const all = fieldForce?.reps ?? [];
    const needle = query.trim().toLowerCase();
    const filtered = all.filter((rep) => {
      if (!showVacant && rep.kind === "vacant") return false;
      if (!needle) return true;
      return (
        rep.label.toLowerCase().includes(needle) ||
        (rep.areaName ?? "").toLowerCase().includes(needle) ||
        (rep.regionName ?? "").toLowerCase().includes(needle) ||
        (rep.managerName ?? "").toLowerCase().includes(needle) ||
        rep.lineName.toLowerCase().includes(needle)
      );
    });
    const sorted = [...filtered];
    if (sort === "name") sorted.sort((a, b) => a.label.localeCompare(b.label));
    else if (sort === "area") sorted.sort((a, b) => (a.areaName ?? "~").localeCompare(b.areaName ?? "~"));
    // "value" keeps the server's own ordering: reps by value, then vacant seats, then the residue.
    return sorted;
  }, [fieldForce, query, sort, showVacant]);

  /**
   * Section the list by LINE, then by REGION inside each line.
   *
   * A CEO or Super Admin sees every seat in the business — 112 rows the day this was built — and a
   * flat list of them is a directory, not a dashboard. CNS, Anti Infective and Pedia are three
   * businesses with three different managers; a region is the unit a district actually reports in.
   *
   * Each level's header appears ONLY when that level has more than one value, so the same component
   * renders three shapes without a flag: a company viewer gets line bands with regions inside them,
   * an NSM (one line) gets plain region bands, and a DM (one line, one region) gets neither and is
   * spared two headers that would repeat what his own scope line already told him.
   *
   * Ordered by VALUE at both levels, never alphabetically, and every band states its own subtotal —
   * so the sections add up to the headline above them in the order a reader checks them.
   */
  const groups = useMemo(() => {
    const byLine = new Map<string, Map<string, FieldForceRep[]>>();
    for (const rep of rows) {
      const line = rep.lineName || rep.lineCode || "Unassigned line";
      const region = weeklyRegionLabel(rep.regionName) || "No region";
      const regions = byLine.get(line) ?? new Map<string, FieldForceRep[]>();
      regions.set(region, [...(regions.get(region) ?? []), rep]);
      byLine.set(line, regions);
    }
    const sum = (reps: FieldForceRep[]) => reps.reduce((total, rep) => total + rep.value, 0);
    return [...byLine.entries()]
      .map(([line, regions]) => {
        const built = [...regions.entries()]
          .map(([region, reps]) => ({ region, reps, value: sum(reps) }))
          .sort((a, b) => b.value - a.value);
        return {
          line,
          regions: built,
          value: built.reduce((total, group) => total + group.value, 0),
          reps: built.flatMap((group) => group.reps),
        };
      })
      .sort((a, b) => b.value - a.value);
  }, [rows]);

  const showLineBands = groups.length > 1;
  // One region across the whole view means the region is the viewer's own scope, not a grouping.
  const showRegionBands = new Set(rows.map((rep) => weeklyRegionLabel(rep.regionName) || "No region")).size > 1;

  if (!fieldForce || fieldForce.reps.length === 0) {
    return (
      <FieldForceEmpty
        seatIndexUnavailable={fieldForce?.seatIndexUnavailable ?? false}
        scopeSummary={scopeSummary}
      />
    );
  }

  const { totals } = fieldForce;
  // ONE base for every number on this screen: `totals.value`, which is exactly what the rows below
  // add up to. An earlier cut showed "Field value" net of the residue while the strip divided by the
  // gross, so the same quantity appeared twice at two percentages and the table did not sum to its
  // own headline. A reader who finds one discrepancy stops believing the other four tiles too.
  const fieldValue = totals.value;
  const exactShare = fieldValue > 0 ? totals.exactValue / fieldValue : 0;
  const maxValue = rows.reduce((max, rep) => Math.max(max, rep.value), 0) || 1;
  const columns = fieldForceLeagueColumns(weeks.length);

  return (
    <div className="space-y-5">
      {/* KPI strip — every tile is a question a manager actually asks about his people. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <FieldTile
          accent="#F97316"
          icon={Users}
          label="Reps with sales"
          value={formatNumber(totals.repsWithSales)}
          sub={`${formatNumber(fieldForce.reps.filter((r) => r.kind === "rep").length)} in your scope`}
        />
        <FieldTile
          accent="#0EA5E9"
          icon={Target}
          label="Field value"
          value={formatEgp(fieldValue)}
          sub="total of every row below"
        />
        <FieldTile
          accent={exactShare >= 0.5 ? "#22C55E" : "#F59E0B"}
          icon={Crosshair}
          label="Exact credit"
          value={formatPct(exactShare)}
          sub="rest is allocated or reached no rep"
        />
        <FieldTile
          accent="#8B5CF6"
          icon={MapPin}
          label="Vacant areas selling"
          value={formatNumber(totals.vacantAreasWithSales)}
          sub="no rep in the seat"
        />
      </div>

      {/* The honesty strip. This is not decoration — see rule 2 in the file header. */}
      <AttributionStrip
        exactValue={totals.exactValue}
        allocatedValue={totals.allocatedValue}
        unattributedValue={totals.unattributedValue}
        total={totals.value}
      />

      {gapWeeks.size > 0 ? (
        <div className="flex items-start gap-2.5 border border-amber-200 bg-amber-50 px-4 py-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <p className="text-xs font-semibold text-amber-900">
            {`${gapWeeks.size === 1 ? "Week" : "Weeks"} ${[...gapWeeks].join(", ")} ${
              gapWeeks.size === 1 ? "carries" : "carry"
            } sales from a branch that sent no sheet for the week before, so the figure also holds the week(s) it skipped and reads high. Marked with a dot in the table below.`}
          </p>
        </div>
      ) : null}

      {/* The league table */}
      <div className="overflow-hidden border border-slate-200 bg-white shadow-[0_10px_30px_rgba(15,23,42,0.05)] ring-1 ring-slate-200/60">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 bg-slate-900 px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="h-3.5 w-[3px] shrink-0 bg-orange-500" />
            <h2 className="break-words text-phx-2xs font-black uppercase tracking-[0.18em] text-slate-200">
              Medical reps · week by week
            </h2>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative flex items-center">
              <Search className="pointer-events-none absolute left-2 h-3 w-3 text-slate-400" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Find a rep, area or district"
                className="w-52 border border-slate-700 bg-slate-800 py-1 pl-7 pr-2 text-xs font-semibold text-slate-100 placeholder:text-slate-500 focus:border-orange-500 focus:outline-none"
              />
            </label>
            <div className="flex overflow-hidden border border-slate-700">
              {([
                { key: "value", label: "Value" },
                { key: "name", label: "Name" },
                { key: "area", label: "Area" },
              ] as { key: SortKey; label: string }[]).map((option) => (
                <button
                  key={option.key}
                  type="button"
                  onClick={() => setSort(option.key)}
                  className={`whitespace-nowrap px-2.5 py-1 text-phx-2xs font-black uppercase tracking-wide transition ${
                    sort === option.key
                      ? "bg-orange-500 text-white"
                      : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setShowVacant((previous) => !previous)}
              className={`whitespace-nowrap border px-2.5 py-1 text-phx-2xs font-black uppercase tracking-wide transition ${
                showVacant
                  ? "border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700"
                  : "border-orange-500 bg-orange-500 text-white"
              }`}
            >
              {showVacant ? "Hide vacant" : "Vacant hidden"}
            </button>
          </div>
        </div>

        {/* DESKTOP — the full grid, fixed to its container. A long name wraps; nothing scrolls sideways. */}
        <div className="hidden lg:block">
          <table className="w-full table-fixed border-collapse">
            <colgroup>
              <col style={{ width: `${columns.rep}%` }} />
              {weeks.map((week) => (
                <col key={week} style={{ width: `${columns.week}%` }} />
              ))}
              <col style={{ width: `${columns.period}%` }} />
            </colgroup>
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50">
                <th className="px-3 py-2 text-left text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">
                  Medical rep · Area · District manager
                </th>
                {weeks.map((week) => (
                  <th
                    key={week}
                    className="px-1.5 py-2 text-right text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500"
                    title={gapWeeks.has(week) ? "Also holds a week a branch never uploaded" : undefined}
                  >
                    {`W${week}`}
                    {gapWeeks.has(week) ? <span className="ml-0.5 text-amber-500">•</span> : null}
                  </th>
                ))}
                <th className="px-2 py-2 text-right text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">
                  Period · Share
                </th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <Fragment key={group.line}>
                  {showLineBands ? (
                    <tr>
                      <td colSpan={weeks.length + 2} className="bg-slate-900 px-3 py-2">
                        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                            <span className="break-words text-phx-2xs font-black uppercase tracking-[0.18em] text-white">
                              {group.line}
                            </span>
                            <span className="break-words text-phx-2xs font-semibold text-slate-400">
                              {`${formatNumber(group.reps.filter((r) => r.kind === "rep").length)} reps · ${formatNumber(
                                group.reps.filter((r) => r.kind === "vacant").length,
                              )} vacant`}
                            </span>
                          </span>
                          <span className="flex items-baseline gap-2">
                            <span className="whitespace-nowrap text-xs font-black tabular-nums text-white">
                              {formatEgp(group.value)}
                            </span>
                            <span className="whitespace-nowrap text-phx-2xs font-bold tabular-nums text-slate-400">
                              {formatPct(totals.value > 0 ? group.value / totals.value : 0)}
                            </span>
                          </span>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                  {group.regions.map((region) => (
                    <Fragment key={`${group.line}|${region.region}`}>
                      {showRegionBands ? (
                        <tr>
                          <td
                            colSpan={weeks.length + 2}
                            className="border-y border-slate-200 bg-slate-50 px-3 py-1.5"
                          >
                            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                              <span className="flex min-w-0 items-center gap-2">
                                <span className="h-2.5 w-[3px] shrink-0 bg-orange-500" />
                                <span className="break-words text-phx-2xs font-black tracking-[0.06em] text-slate-600">
                                  {region.region}
                                </span>
                              </span>
                              <span className="whitespace-nowrap text-phx-2xs font-black tabular-nums text-slate-600">
                                {formatEgp(region.value)}
                              </span>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                      {region.reps.map((rep) => (
                        <RepRow
                          key={rep.key}
                          rep={rep}
                          weeks={weeks}
                          gapWeeks={gapWeeks}
                          maxValue={maxValue}
                          totalValue={totals.value}
                          expanded={expanded === rep.key}
                          onToggle={() => setExpanded((current) => (current === rep.key ? null : rep.key))}
                        />
                      ))}
                    </Fragment>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>

        {/* MOBILE — cards, never a table (owner rule: mobile never shows a full table). */}
        <div className="divide-y divide-slate-100 lg:hidden">
          {groups.map((group) => (
            <Fragment key={group.line}>
              {showLineBands ? (
                <div className="flex items-baseline justify-between gap-3 bg-slate-900 px-4 py-2">
                  <span className="min-w-0 break-words text-phx-2xs font-black uppercase tracking-[0.18em] text-white">
                    {group.line}
                  </span>
                  <span className="whitespace-nowrap text-xs font-black tabular-nums text-white">
                    {formatEgp(group.value)}
                  </span>
                </div>
              ) : null}
              {group.regions.map((region) => (
                <Fragment key={`${group.line}|${region.region}`}>
                  {showRegionBands ? (
                    <div className="flex items-baseline justify-between gap-3 border-y border-slate-200 bg-slate-50 px-4 py-1.5">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="h-2.5 w-[3px] shrink-0 bg-orange-500" />
                        <span className="break-words text-phx-2xs font-black tracking-[0.06em] text-slate-600">
                          {region.region}
                        </span>
                      </span>
                      <span className="whitespace-nowrap text-phx-2xs font-black tabular-nums text-slate-600">
                        {formatEgp(region.value)}
                      </span>
                    </div>
                  ) : null}
                  {region.reps.map((rep) => (
                    <RepCard
                      key={rep.key}
                      rep={rep}
                      weeks={weeks}
                      gapWeeks={gapWeeks}
                      totalValue={totals.value}
                      expanded={expanded === rep.key}
                      onToggle={() => setExpanded((current) => (current === rep.key ? null : rep.key))}
                    />
                  ))}
                </Fragment>
              ))}
            </Fragment>
          ))}
        </div>

        {rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-xs font-semibold text-slate-400">
            No rep matches that search.
          </p>
        ) : (
          /* The scale has to be stated. Shading that looks table-wide but is row-wise would invite
             the exact misreading it exists to prevent — comparing one rep's blue against another's. */
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-slate-100 px-4 py-2.5">
            <span className="inline-flex items-center gap-1.5 text-phx-2xs font-semibold text-slate-500">
              <span className="shrink-0 border-b-2 border-orange-400 pb-0.5 font-bold text-slate-900">1,234</span>
              <span className="min-w-0 break-words">that rep&rsquo;s strongest week</span>
            </span>
            <span className="inline-flex items-center gap-1.5 text-phx-2xs font-semibold text-slate-500">
              <span className="shrink-0 border-b-2 border-dotted border-amber-400 pb-0.5 font-semibold text-slate-700">
                1,234
              </span>
              <span className="min-w-0 break-words">spans a week that was never uploaded</span>
            </span>
            <span className="inline-flex items-center gap-1.5 text-phx-2xs font-semibold text-slate-500">
              <ArrowUp className="h-2 w-2 shrink-0 text-emerald-500" strokeWidth={4} />
              <ArrowDown className="h-2 w-2 shrink-0 text-rose-400" strokeWidth={4} />
              <span className="min-w-0 break-words">up or down on the week before</span>
            </span>
            <span className="break-words text-phx-2xs font-semibold text-slate-400">
              Weight is read across one rep&rsquo;s own row, never between reps.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── the rep row, and the product grid it opens ───────────────────────────────────────────────

function RepRow({
  rep,
  weeks,
  gapWeeks,
  maxValue,
  totalValue,
  expanded,
  onToggle,
}: {
  rep: FieldForceRep;
  weeks: number[];
  gapWeeks: Set<number>;
  maxValue: number;
  totalValue: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const share = totalValue > 0 ? rep.value / totalValue : 0;
  const tone = toneOf(rep);
  const weekPeak = peakOf(weeks, rep.valueByWeek);
  const detailId = `field-force-products-${rep.key.replace(/[^A-Za-z0-9_-]/g, "-")}`;

  return (
    <>
      <tr
        onClick={onToggle}
        {...rowDetailToggleProps(detailId, expanded)}
        className={`cursor-pointer border-b border-slate-100 transition hover:bg-orange-50/40 ${
          expanded ? "bg-orange-50/60" : ""
        }`}
      >
        {/* Rep, area and district manager share one column: stacked, they cost height, which is free;
            side by side they cost width, which pushed this table past the screen. */}
        <td className="px-3 py-2.5">
          <div className="flex items-start gap-2">
            {expanded ? (
              <ChevronDown className="mt-1 h-3.5 w-3.5 shrink-0 text-orange-500" />
            ) : (
              <ChevronRight className="mt-1 h-3.5 w-3.5 shrink-0 text-slate-300" />
            )}
            <span className={`flex h-6 w-6 shrink-0 items-center justify-center ${tone.chip}`}>
              <UserRound className="h-3 w-3" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="min-w-0 break-words text-sm font-black text-slate-900">{weeklyPersonLabel(rep.label)}</span>
                <AttributionDot rep={rep} />
              </div>
              <p className="mt-0.5 break-words text-xs font-semibold text-slate-600">
                {rep.areaName ? weeklyAreaLabel(rep.areaName) : "—"}
                {rep.regionName ? (
                  <span className="ml-1.5 text-phx-2xs font-bold tracking-wide text-slate-400">
                    {weeklyRegionLabel(rep.regionName)}
                  </span>
                ) : null}
              </p>
              {rep.managerName ? (
                <p className="break-words text-xs font-semibold text-slate-500">
                  <span className="mr-1.5 text-phx-2xs font-bold uppercase tracking-wide text-slate-400">
                    District manager
                  </span>
                  {weeklyPersonLabel(rep.managerName)}
                </p>
              ) : null}
            </div>
          </div>
        </td>
        {weeks.map((week, index) => {
          const value = rep.valueByWeek[week] ?? 0;
          const previous = index === 0 ? null : rep.valueByWeek[weeks[index - 1]] ?? 0;
          return (
            <td key={week} className="px-1.5 py-2.5 text-right text-xs">
              <WeekFigure
                text={value > 0 ? formatEgp(value) : "—"}
                rank={rankWeek(value, weekPeak)}
                gap={gapWeeks.has(week)}
                direction={weekDirection(value, previous, gapWeeks.has(week))}
              />
            </td>
          );
        })}
        {/* px-2, not px-3: the sibling tab measured px-3 breaking "EGP 81.2K" onto two lines at 1024px. */}
        <td className="px-2 py-2.5 text-right">
          <p className="break-words text-sm font-black tabular-nums text-slate-900">{formatEgp(rep.value)}</p>
          <div className="mt-1 flex flex-wrap items-center justify-end gap-x-1.5 gap-y-1">
            <div className="h-1.5 w-12 overflow-hidden bg-slate-100">
              <div
                className={`h-full ${tone.bar}`}
                style={{ width: `${Math.max(2, (rep.value / maxValue) * 100)}%` }}
              />
            </div>
            <span className="text-phx-2xs font-bold tabular-nums text-slate-500">{formatPct(share)}</span>
          </div>
        </td>
      </tr>
      {expanded ? (
        <TableRowDetail colSpan={weeks.length + 2} id={detailId}>
          <ProductGrid rep={rep} weeks={weeks} gapWeeks={gapWeeks} layout="table" />
        </TableRowDetail>
      ) : null}
    </>
  );
}

/**
 * The answer to the owner's actual question: this rep, week by week, PER PRODUCT.
 *
 * Units here and only here — one column of this grid is one product code, which is the only level
 * at which a unit figure means anything (owner rule, 2026-08-27). The row total is that product's
 * own units; there is deliberately no column totalling units across products.
 *
 * A fixed table inside the desktop row, cards inside the phone card: the same product figures either
 * way, and neither can grow past the screen.
 */
function ProductGrid({
  rep,
  weeks,
  gapWeeks,
  layout,
}: {
  rep: FieldForceRep;
  weeks: number[];
  gapWeeks: Set<number>;
  layout: "table" | "cards";
}) {
  if (rep.products.length === 0) {
    return <p className="py-2 text-center text-xs font-semibold text-slate-400">No product sales in this period.</p>;
  }
  const maxUnits = rep.products.reduce((max, product) => Math.max(max, product.units), 0) || 1;
  const columns = fieldForceProductColumns(weeks.length);

  return (
    <div className="overflow-hidden border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-slate-200 bg-white px-3 py-2">
        <Package className="h-3.5 w-3.5 shrink-0 text-orange-500" />
        <p className="min-w-0 break-words text-phx-2xs font-black tracking-[0.04em] text-slate-500">
          Units per product, week by week
        </p>
        <span className="min-w-0 break-words text-phx-2xs font-bold uppercase tracking-wide text-slate-400">
          {`${rep.products.length} product${rep.products.length === 1 ? "" : "s"} · ${rep.lineName}`}
        </span>
      </div>
      {layout === "table" ? (
        <table className="w-full table-fixed border-collapse">
          <colgroup>
            <col style={{ width: `${columns.product}%` }} />
            {weeks.map((week) => (
              <col key={week} style={{ width: `${columns.week}%` }} />
            ))}
            <col style={{ width: `${columns.units}%` }} />
            <col style={{ width: `${columns.value}%` }} />
          </colgroup>
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50/80">
              <th className="px-3 py-1.5 text-left text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">
                Product
              </th>
              {weeks.map((week) => (
                <th
                  key={week}
                  className="px-1.5 py-1.5 text-right text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500"
                  title={gapWeeks.has(week) ? "Includes a week that was never uploaded" : undefined}
                >
                  {`W${week}`}
                  {gapWeeks.has(week) ? <span className="ml-0.5 text-amber-500">•</span> : null}
                </th>
              ))}
              <th className="px-2 py-1.5 text-right text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">
                Units
              </th>
              <th className="px-2 py-1.5 text-right text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">
                Value
              </th>
            </tr>
          </thead>
          <tbody>
            {rep.products.map((product) => (
              <tr key={product.productCode} className="border-b border-slate-100 last:border-0">
                <td className="px-3 py-1.5">
                  <span className="block break-words text-xs font-bold text-slate-800">{product.productName}</span>
                  <UnitsBar units={product.units} maxUnits={maxUnits} />
                </td>
                {weeks.map((week, index) => {
                  const units = product.unitsByWeek[week] ?? 0;
                  const previous = index === 0 ? null : product.unitsByWeek[weeks[index - 1]] ?? 0;
                  return (
                    <td key={week} className="px-1.5 py-1.5 text-right text-xs">
                      <WeekFigure
                        text={unitsCell(units)}
                        rank={rankWeek(units, peakOf(weeks, product.unitsByWeek))}
                        gap={gapWeeks.has(week)}
                        direction={weekDirection(units, previous, gapWeeks.has(week))}
                      />
                    </td>
                  );
                })}
                <td className="px-2 py-1.5 text-right text-xs font-black tabular-nums text-slate-900">
                  {unitsTotal(product.units)}
                </td>
                <td className="px-2 py-1.5 text-right text-xs font-bold tabular-nums text-slate-500">
                  {formatEgp(product.value)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="divide-y divide-slate-100">
          {rep.products.map((product) => {
            const peak = peakOf(weeks, product.unitsByWeek);
            return (
              <div key={product.productCode} className="px-3 py-2.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-xs font-black text-slate-900">{product.productName}</p>
                    <UnitsBar units={product.units} maxUnits={maxUnits} />
                  </div>
                  <div className="text-right">
                    <p className="whitespace-nowrap text-xs font-black tabular-nums text-slate-900">
                      {`${unitsTotal(product.units)} units`}
                    </p>
                    <p className="whitespace-nowrap text-phx-2xs font-bold tabular-nums text-slate-400">
                      {formatEgp(product.value)}
                    </p>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {weeks.map((week, index) => {
                    const units = product.unitsByWeek[week] ?? 0;
                    const previous = index === 0 ? null : product.unitsByWeek[weeks[index - 1]] ?? 0;
                    return (
                      <WeekChip
                        key={week}
                        week={week}
                        text={unitsCell(units)}
                        rank={rankWeek(units, peak)}
                        gap={gapWeeks.has(week)}
                        direction={weekDirection(units, previous, gapWeeks.has(week))}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <p className="border-t border-slate-100 px-3 py-1.5 text-phx-2xs font-semibold text-slate-400">
        Units are shown per product only — units of different products are never added together.
      </p>
    </div>
  );
}

/** The product's units against the rep's biggest product: a scale bar under the product name. */
function UnitsBar({ units, maxUnits }: { units: number; maxUnits: number }) {
  return (
    <div className="mt-1 h-1.5 w-12 max-w-full overflow-hidden bg-slate-100">
      <div className="h-full bg-sky-400" style={{ width: `${Math.max(3, (units / maxUnits) * 100)}%` }} />
    </div>
  );
}

function RepCard({
  rep,
  weeks,
  gapWeeks,
  totalValue,
  expanded,
  onToggle,
}: {
  rep: FieldForceRep;
  weeks: number[];
  gapWeeks: Set<number>;
  totalValue: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const share = totalValue > 0 ? rep.value / totalValue : 0;
  const tone = toneOf(rep);
  const weekPeak = peakOf(weeks, rep.valueByWeek);
  return (
    <div className="px-4 py-3">
      <button type="button" onClick={onToggle} className="flex w-full items-center justify-between gap-3 text-left">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className={`flex h-7 w-7 shrink-0 items-center justify-center ${tone.chip}`}>
            <UserRound className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="break-words text-sm font-black text-slate-900">{weeklyPersonLabel(rep.label)}</p>
            <p className="break-words text-phx-2xs font-bold tracking-wide text-slate-400">
              {[
                rep.areaName ? weeklyAreaLabel(rep.areaName) : null,
                rep.regionName ? weeklyRegionLabel(rep.regionName) : null,
                rep.managerName ? weeklyPersonLabel(rep.managerName) : null,
              ]
                .filter(Boolean)
                .join(" · ") || rep.lineName}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="text-right">
            <p className="whitespace-nowrap text-sm font-black tabular-nums text-slate-900">{formatEgp(rep.value)}</p>
            <p className="whitespace-nowrap text-phx-2xs font-bold tabular-nums text-slate-400">{formatPct(share)}</p>
          </div>
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-orange-500" />
          ) : (
            <ChevronRight className="h-4 w-4 text-slate-300" />
          )}
        </div>
      </button>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {weeks.map((week, index) => {
          const value = rep.valueByWeek[week] ?? 0;
          const previous = index === 0 ? null : rep.valueByWeek[weeks[index - 1]] ?? 0;
          return (
            <WeekChip
              key={week}
              week={week}
              text={value > 0 ? formatEgp(value) : "—"}
              rank={rankWeek(value, weekPeak)}
              gap={gapWeeks.has(week)}
              direction={weekDirection(value, previous, gapWeeks.has(week))}
            />
          );
        })}
      </div>
      {expanded ? (
        <div className="mt-3">
          <ProductGrid rep={rep} weeks={weeks} gapWeeks={gapWeeks} layout="cards" />
        </div>
      ) : null}
    </div>
  );
}

// ── supporting pieces ────────────────────────────────────────────────────────────────────────

/**
 * Rank one week against the PEAK WEEK OF ITS OWN ROW, and express it in INK, not in fill.
 *
 * The first cut of this shaded every cell with one of five blues. It read as noise: 450 tinted cells
 * on one screen is a heat map competing with the numbers it is supposed to serve, and on a table a
 * finance reader takes to a board meeting that is the opposite of legible.
 *
 * So the weight of the type carries the signal and colour is spent ONCE — a hairline under each
 * rep's single best week. The eye lands on four underlines down the column, not on a wash. Ink is
 * row-normalized: the comparison is this person's month against itself, never against another rep,
 * whose scale the Share column already gives.
 */
type WeekRank = { text: string; peak: boolean };

function rankWeek(value: number, peak: number): WeekRank {
  if (!(value > 0) || !(peak > 0)) return { text: "font-medium text-slate-300", peak: false };
  const share = value / peak;
  if (share >= 0.999) return { text: "font-bold text-slate-900", peak: true };
  if (share >= 0.5) return { text: "font-semibold text-slate-700", peak: false };
  if (share >= 0.2) return { text: "font-medium text-slate-500", peak: false };
  return { text: "font-medium text-slate-400", peak: false };
}

/** The row's own biggest week — the denominator rankWeek scales against. */
function peakOf(weeks: number[], byWeek: Record<number, number>): number {
  return weeks.reduce((max, week) => Math.max(max, byWeek[week] ?? 0), 0);
}

/**
 * Which way this week moved against the week before it.
 *
 * Deliberately blind on two cases. The FIRST week has nothing behind it — an arrow there would be
 * inventing a comparison. And a GAP week's figure spans an upload that never happened, so it reads
 * high for a reason that has nothing to do with selling; an arrow would turn a data hole into a
 * green success. Those are exactly the two cells a manager would act on wrongly.
 */
function weekDirection(value: number, previous: number | null, gap: boolean): "up" | "down" | null {
  if (gap || previous === null) return null;
  if (value > previous) return "up";
  if (value < previous) return "down";
  return null;
}

/**
 * One week figure: the number, a direction arrow, and a hairline under the row's best week.
 *
 * The arrow is 8px and sits LEFT of the number so the column stays right-aligned on the digits — a
 * trailing arrow would ragged the decimal edge on every row that has one, which is most of them.
 */
function WeekFigure({
  text,
  rank,
  gap,
  direction,
}: {
  text: string;
  rank: WeekRank;
  gap: boolean;
  direction: "up" | "down" | null;
}) {
  // Wraps rather than spilling into the next column: on the narrowest desktop the arrow drops above the
  // figure first, and only a figure wider than its whole column breaks at its space.
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-x-1">
      {direction === "up" ? (
        <ArrowUp className="h-2 w-2 shrink-0 text-emerald-500" strokeWidth={4} />
      ) : direction === "down" ? (
        <ArrowDown className="h-2 w-2 shrink-0 text-rose-400" strokeWidth={4} />
      ) : null}
      <span
        className={`inline-block min-w-0 break-words tabular-nums ${rank.text} ${
          rank.peak ? "border-b-2 border-orange-400 pb-0.5" : ""
        } ${gap ? "border-b-2 border-dotted border-amber-400 pb-0.5" : ""}`}
      >
        {text}
      </span>
    </span>
  );
}

/** One week as a chip on a phone card: the same ink, arrow and marks as a table cell. */
function WeekChip({
  week,
  text,
  rank,
  gap,
  direction,
}: {
  week: number;
  text: string;
  rank: WeekRank;
  gap: boolean;
  direction: "up" | "down" | null;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap bg-slate-50 px-1.5 py-0.5 text-phx-2xs tabular-nums ${
        rank.text
      } ${rank.peak ? "ring-1 ring-orange-300" : ""} ${gap ? "ring-1 ring-amber-300" : ""}`}
    >
      <span className="text-slate-400">{`W${week}`}</span>
      {direction === "up" ? (
        <ArrowUp className="h-2 w-2 shrink-0 text-emerald-500" strokeWidth={4} />
      ) : direction === "down" ? (
        <ArrowDown className="h-2 w-2 shrink-0 text-rose-400" strokeWidth={4} />
      ) : null}
      {text}
    </span>
  );
}

function toneOf(rep: FieldForceRep): { chip: string; bar: string } {
  if (rep.kind === "vacant") return { chip: "bg-amber-100 text-amber-700", bar: "bg-amber-400" };
  if (rep.kind === "manager") return { chip: "bg-sky-100 text-sky-700", bar: "bg-sky-400" };
  if (rep.kind === "unattributed") return { chip: "bg-slate-200 text-slate-500", bar: "bg-slate-300" };
  return { chip: "bg-orange-100 text-orange-600", bar: "bg-orange-400" };
}

/**
 * Marks a rep whose number is mostly an allocation rather than a hand-mapped credit.
 *
 * Deliberately shown per ROW and not only in the summary strip: the mix varies enormously between
 * reps, and the owner's decision ("do I ask this person about this number") is made on the row.
 */
function AttributionDot({ rep }: { rep: FieldForceRep }) {
  if (rep.kind === "unattributed" || rep.value <= 0) return null;
  const exactShare = rep.value > 0 ? rep.exactValue / rep.value : 0;
  if (exactShare >= 0.5) return null;
  return (
    <span
      title={`${formatPct(1 - exactShare)} of this figure is allocated from branch names, not mapped by hand.`}
      className="inline-flex items-center gap-1 whitespace-nowrap bg-amber-50 px-1.5 py-0.5 text-phx-2xs font-black uppercase tracking-wide text-amber-700"
    >
      Allocated
    </span>
  );
}

function AttributionStrip({
  exactValue,
  allocatedValue,
  unattributedValue,
  total,
}: {
  exactValue: number;
  allocatedValue: number;
  unattributedValue: number;
  total: number;
}) {
  const safe = total > 0 ? total : 1;
  const parts = [
    { label: "Mapped by hand", value: exactValue, className: "bg-emerald-500", tone: "text-emerald-700" },
    { label: "Allocated from branch name", value: allocatedValue, className: "bg-amber-400", tone: "text-amber-700" },
    { label: "Reached no rep", value: unattributedValue, className: "bg-slate-300", tone: "text-slate-500" },
  ];
  return (
    <div className="overflow-hidden border border-slate-200 bg-white shadow-[0_10px_30px_rgba(15,23,42,0.05)] ring-1 ring-slate-200/60">
      <div className="flex items-center gap-2 border-b border-slate-800 bg-slate-900 px-4 py-2.5">
        <span className="h-3.5 w-[3px] shrink-0 bg-orange-500" />
        <h2 className="min-w-0 break-words text-phx-2xs font-black uppercase tracking-[0.18em] text-slate-200">
          How these numbers reached a rep
        </h2>
      </div>
      <div className="space-y-3 p-4">
        <div className="flex h-2 w-full overflow-hidden bg-slate-100">
          {parts.map((part) => (
            <div
              key={part.label}
              className={part.className}
              style={{ width: `${(part.value / safe) * 100}%` }}
              title={`${part.label}: ${formatEgpFull(part.value)}`}
            />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          {parts.map((part) => (
            <div key={part.label} className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
              <span className={`h-2 w-2 shrink-0 ${part.className}`} />
              <span className="min-w-0 break-words text-phx-2xs font-black uppercase tracking-wide text-slate-500">
                {part.label}
              </span>
              <span className={`whitespace-nowrap text-xs font-black tabular-nums ${part.tone}`}>
                {formatEgp(part.value)}
              </span>
              <span className="whitespace-nowrap text-phx-2xs font-bold tabular-nums text-slate-400">
                {formatPct(part.value / safe)}
              </span>
            </div>
          ))}
        </div>
        <p className="text-xs font-semibold leading-relaxed text-slate-500">
          Weekly sales arrive at distributor-branch level, not per customer. A branch mapped to an area by
          hand credits that area&rsquo;s rep exactly. Any other branch has its money spread evenly across the
          governorates its name states, then evenly again across that governorate&rsquo;s areas on that line —
          so a rep&rsquo;s figure here is an allocation of branch shipments, not a record of visits or of sales
          observed in their territory.
        </p>
      </div>
    </div>
  );
}

function FieldTile({
  accent,
  icon: Icon,
  label,
  value,
  sub,
}: {
  accent: string;
  icon: typeof Users;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="group relative overflow-hidden border border-slate-200 bg-white shadow-[0_8px_22px_rgba(15,23,42,0.04)] ring-1 ring-slate-200/60 transition duration-200 hover:-translate-y-0.5 hover:shadow-[0_16px_34px_rgba(15,23,42,0.08)]">
      <span
        className="absolute inset-x-0 top-0 h-1 transition-all duration-200 group-hover:h-1.5"
        style={{ backgroundColor: accent }}
      />
      {/* Two tiles share a phone's width, so every line here wraps: the tile clips, and a clipped
          label is a truncated one. */}
      <div className="p-3.5 sm:p-4">
        <span
          className="flex h-7 w-7 items-center justify-center"
          style={{ backgroundColor: `${accent}1A`, color: accent }}
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        <p className="mt-2.5 break-words text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">
          {label}
        </p>
        <p className="mt-0.5 break-words text-lg font-black tabular-nums tracking-tight text-slate-900 sm:text-xl">
          {value}
        </p>
        {sub ? <p className="mt-0.5 break-words text-phx-2xs font-semibold text-slate-400">{sub}</p> : null}
      </div>
    </div>
  );
}

function FieldForceEmpty({
  seatIndexUnavailable,
  scopeSummary,
}: {
  seatIndexUnavailable: boolean;
  scopeSummary: string;
}) {
  return (
    <div className="border border-slate-200 bg-white p-10 text-center shadow-[0_10px_30px_rgba(15,23,42,0.05)] ring-1 ring-slate-200/60">
      <span className="mx-auto flex h-11 w-11 items-center justify-center bg-orange-50 text-orange-500">
        <Layers className="h-5 w-5" />
      </span>
      <p className="mt-3 text-sm font-black text-slate-900">
        {seatIndexUnavailable ? "The organogram could not be read" : "No rep-level sales in this selection"}
      </p>
      <p className="mx-auto mt-1.5 max-w-md text-xs font-semibold leading-relaxed text-slate-500">
        {seatIndexUnavailable
          ? "Rep attribution needs the seat model, which did not answer just now. The Distribution tab is unaffected — reload in a moment to try again."
          : `Nothing in this filter selection reached an area with a rep seat. Widen the month or week filter, or check the Distribution tab for what did arrive. Scope: ${scopeSummary}.`}
      </p>
    </div>
  );
}
