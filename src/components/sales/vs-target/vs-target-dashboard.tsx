"use client";

import { Fragment, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  AlertTriangle,
  Boxes,
  Building2,
  ChevronDown,
  Loader2,
  MapPin,
  Package,
  Target,
  TrendingDown,
  TrendingUp,
  Trophy,
  Users,
} from "lucide-react";

import { PortalEmptyState } from "@/components/employee-portal/portal-primitives";
import { CountUpNumber } from "@/components/ui/count-up";
import { rowDetailToggleProps, TableRowDetail } from "@/components/ui/table-row-detail";
import { cn } from "@/lib/utils";
import type { BrickNode, VsTargetNode, VsTargetTotals } from "@/lib/sales/vs-target";
import type { VsTargetDashboardData } from "@/lib/sales/vs-target-page";
import {
  ACTUAL_COLOR,
  AchievementMeter,
  AchievementRing,
  BandChoice,
  BandStat,
  CommandBand,
  CHART_TOOLTIP_CLASS,
  GrowthPill,
  LABEL_CLASS,
  ProportionBar,
  SURFACE_CLASS,
  SectionCard,
  TABLE_HEAD_CLASS,
  TABLE_ROW_CLASS,
  TARGET_COLOR,
  achievementHex,
  achievementTone,
  chipClass,
  formatEgp,
  formatEgpFull,
  formatNumber,
  formatPct,
  formatPeriod,
} from "@/components/sales/target-visuals";

type ChartTooltipEntry = { name?: string | number; value?: unknown; color?: string };

function ChartTooltipContent({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: ChartTooltipEntry[];
  label?: string | number;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className={CHART_TOOLTIP_CLASS}>
      {label != null ? <p className={cn("mb-1 whitespace-nowrap", LABEL_CLASS)}>{label}</p> : null}
      <div className="space-y-1">
        {payload.map((entry, index) => (
          <div key={`${entry.name ?? index}`} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 shrink-0" style={{ backgroundColor: entry.color }} aria-hidden />
              <span className="whitespace-nowrap text-phx-xs font-semibold text-slate-600">{entry.name}</span>
            </span>
            <span className="whitespace-nowrap text-phx-xs font-black tabular-nums text-slate-900">
              {formatEgpFull(Number(entry.value ?? 0))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Hierarchy table ──────────────────────────────────────────────────────────

type LevelKey = "teams" | "regions" | "areas" | "reps" | "managers" | "regionalManagers" | "products";

const LEVEL_META: Record<LevelKey, { label: string; column: string; icon: typeof Target }> = {
  teams: { label: "Teams", column: "Team", icon: Boxes },
  regions: { label: "Regions", column: "Region", icon: MapPin },
  areas: { label: "Areas", column: "Area", icon: Building2 },
  reps: { label: "Medical Reps", column: "Medical Rep", icon: Users },
  managers: { label: "District Managers", column: "District Manager", icon: Users },
  // Owner, 2026-10-20: each row is the sum of the District Managers under that Regional Manager.
  regionalManagers: { label: "Regional Managers", column: "Regional Manager", icon: Users },
  products: { label: "Products", column: "Product", icon: Package },
};

/** A mobile card's figure row: label and value side by side, wrapping rather than cutting. */
const CARD_FACT_CLASS = "flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5";

function HierarchyTable({
  nodes,
  columnLabel,
  hasPrior,
  priorLabel,
  onDrill,
  drillKey,
  bricks,
  bricksLoading,
}: {
  nodes: VsTargetNode[];
  columnLabel: string;
  hasPrior: boolean;
  priorLabel: string;
  onDrill?: (node: VsTargetNode) => void;
  drillKey?: string | null;
  bricks?: BrickNode[] | null;
  bricksLoading?: boolean;
}) {
  const maxSales = Math.max(...nodes.map((node) => Math.abs(node.current.actualValue)), 1);

  if (nodes.length === 0) {
    return (
      <div className="px-4 py-10 text-center text-sm text-slate-500">
        No sales or targets at this level in your scope this month.
      </div>
    );
  }

  return (
    <>
      {/* Desktop. `table-fixed` with a colgroup and NO min-width floor — the page fits its screen.
          It fits by MERGING, never by shrinking type: the share bar rides under the Sales figure
          instead of owning a column, and so does the "no target" amount — the part of those sales
          with no target, printed only where there is some — so seven columns became five. The
          "Achievement" header and the growth pill cannot wrap, and six columns of the 619px the
          portal leaves this table at a 1024px screen were too narrow for both: they spilled into
          a sideways scroll. Below `lg` the shell's sidebar leaves too little width for the money
          columns, so a tablet gets the cards instead.
          tests/sales-target-tables-fit-the-screen.test.ts holds the arithmetic. */}
      <div className="hidden lg:block">
        <table className="w-full table-fixed text-left text-sm">
          <colgroup>
            <col style={{ width: "20%" }} />
            <col style={{ width: "18%" }} />
            <col style={{ width: "17%" }} />
            <col style={{ width: "24%" }} />
            <col style={{ width: "21%" }} />
          </colgroup>
          {/* No `sticky` head: the page scrolls, not this table, so a sticky head slid under the
              fixed top bar and did nothing. */}
          <thead>
            <tr className={TABLE_HEAD_CLASS}>
              <th className="px-4 py-2.5">{columnLabel}</th>
              <th className="px-4 py-2.5 text-right">Sales</th>
              <th className="px-4 py-2.5 text-right">Target</th>
              <th className="px-4 py-2.5 text-right">Achievement</th>
              <th className="px-4 py-2.5 text-right">vs {priorLabel}</th>
            </tr>
          </thead>
          <tbody>
            {nodes.map((node) => {
              const isOpen = drillKey === node.key;
              return (
                <Fragment key={node.key}>
                  <tr
                    className={cn(TABLE_ROW_CLASS, onDrill ? "cursor-pointer" : undefined, isOpen ? "bg-orange-50" : undefined)}
                    onClick={onDrill ? () => onDrill(node) : undefined}
                  >
                    <td className="px-4 py-3 align-top font-bold text-slate-900">
                      {onDrill ? (
                        // The row stays clickable for a mouse; this button is what a keyboard reaches.
                        <button
                          type="button"
                          {...rowDetailToggleProps(`vs-target-bricks-${node.key.replace(/[^A-Za-z0-9_-]/g, "-")}`, isOpen)}
                          onClick={(event) => {
                            event.stopPropagation();
                            onDrill(node);
                          }}
                          className="flex w-full items-start gap-1.5 text-left font-bold text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-orange-500"
                        >
                          <ChevronDown
                            className={cn(
                              "mt-0.5 h-3.5 w-3.5 shrink-0 transition-transform",
                              isOpen ? "text-orange-600" : "-rotate-90 text-slate-400",
                            )}
                          />
                          <span className="min-w-0 break-words">{node.name}</span>
                        </button>
                      ) : (
                        <span className="min-w-0 break-words">{node.name}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right align-top">
                      <span className="block font-bold tabular-nums text-slate-900">
                        {formatEgpFull(node.current.actualValue)}
                      </span>
                      <span className="mt-1.5 block">
                        <ProportionBar fraction={Math.abs(node.current.actualValue) / maxSales} color={ACTUAL_COLOR} />
                      </span>
                      {node.current.uncoveredActualValue !== 0 ? (
                        <span className="mt-1.5 flex flex-wrap items-baseline justify-end gap-x-1.5">
                          <span className="font-semibold tabular-nums text-amber-600">
                            {formatEgpFull(node.current.uncoveredActualValue)}
                          </span>
                          <span className="text-phx-xs text-slate-500">no target</span>
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-right align-top tabular-nums text-slate-600">
                      {node.current.targetValue === 0 ? (
                        <span className="italic text-slate-400">No target set</span>
                      ) : (
                        formatEgpFull(node.current.targetValue)
                      )}
                    </td>
                    <td className="px-4 py-3 align-top">
                      <AchievementMeter value={node.current.achievementValue} />
                    </td>
                    <td className="px-4 py-3 text-right align-top">
                      {hasPrior ? <GrowthPill value={node.growth} /> : <span className="text-xs text-slate-400">—</span>}
                    </td>
                  </tr>
                  {isOpen ? (
                    <TableRowDetail colSpan={5} id={`vs-target-bricks-${node.key.replace(/[^A-Za-z0-9_-]/g, "-")}`}>
                      <BrickPanel bricks={bricks ?? null} loading={Boolean(bricksLoading)} />
                    </TableRowDetail>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Phone and tablet: cards, never a table — two to a row on a tablet. `items-start` so an
          area opened to its bricks grows on its own instead of stretching the card beside it. An
          area card opens its bricks here too: the drill-down was desktop-only, so below 1024px a
          rep could not reach his bricks at all. */}
      <div className="space-y-2 p-3 md:grid md:grid-cols-2 md:items-start md:gap-2 md:space-y-0 lg:hidden">
        {nodes.map((node) => {
          const isOpen = drillKey === node.key;
          return (
            <div key={node.key} className="flex border border-slate-200 bg-white">
              <span className="w-1 shrink-0" style={{ backgroundColor: achievementHex(node.current.achievementValue) }} aria-hidden />
              <div className="min-w-0 flex-1 p-3">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="min-w-0 break-words text-sm font-bold text-slate-900">{node.name}</p>
                  <span className={cn("shrink-0 text-sm font-black tabular-nums", achievementTone(node.current.achievementValue))}>
                    {formatPct(node.current.achievementValue)}
                  </span>
                </div>
                <div className="mt-2">
                  <ProportionBar fraction={Math.abs(node.current.actualValue) / maxSales} color={ACTUAL_COLOR} />
                </div>
                <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                  <div className={CARD_FACT_CLASS}>
                    <dt className="text-slate-500">Sales</dt>
                    <dd className="whitespace-nowrap font-bold tabular-nums text-slate-900">{formatEgp(node.current.actualValue)}</dd>
                  </div>
                  <div className={CARD_FACT_CLASS}>
                    <dt className="text-slate-500">Target</dt>
                    <dd className="whitespace-nowrap font-semibold tabular-nums text-slate-700">
                      {node.current.targetValue === 0 ? "None" : formatEgp(node.current.targetValue)}
                    </dd>
                  </div>
                  {hasPrior ? (
                    <div className={CARD_FACT_CLASS}>
                      <dt className="text-slate-500">vs {priorLabel}</dt>
                      <dd><GrowthPill value={node.growth} /></dd>
                    </div>
                  ) : null}
                  {node.current.uncoveredActualValue !== 0 ? (
                    <div className={CARD_FACT_CLASS}>
                      <dt className="text-slate-500">No target</dt>
                      <dd className="whitespace-nowrap font-semibold tabular-nums text-amber-600">
                        {formatEgp(node.current.uncoveredActualValue)}
                      </dd>
                    </div>
                  ) : null}
                </dl>
                {onDrill ? (
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    onClick={() => onDrill(node)}
                    className="mt-2.5 flex min-h-11 w-full items-center justify-between gap-3 border-t border-slate-100 pt-2 text-xs font-bold text-orange-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-orange-500"
                  >
                    {isOpen ? "Hide bricks" : "Show bricks"}
                    <ChevronDown className={cn("h-4 w-4 shrink-0 transition-transform", isOpen ? "rotate-180" : undefined)} />
                  </button>
                ) : null}
                {onDrill && isOpen ? (
                  <div className="mt-1 border-t border-slate-100 pt-2.5">
                    <BrickPanel bricks={bricks ?? null} loading={Boolean(bricksLoading)} />
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function BrickPanel({ bricks, loading }: { bricks: BrickNode[] | null; loading: boolean }) {
  if (loading) {
    return (
      <p className="flex items-center gap-2 text-xs text-slate-500">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-orange-500" /> Loading bricks…
      </p>
    );
  }
  if (!bricks) return <p className="text-xs text-slate-500">Bricks could not be loaded for this row.</p>;
  if (bricks.length === 0) return <p className="text-xs text-slate-500">No brick-level sales recorded here this month.</p>;

  const total = bricks.reduce((sum, brick) => sum + brick.salesValue, 0);
  const max = Math.max(...bricks.map((brick) => Math.abs(brick.salesValue)), 1);
  return (
    <div>
      <p className={cn("mb-2", LABEL_CLASS)}>
        Bricks — {bricks.length.toLocaleString("en-US")} in this area, {formatEgpFull(total)}
      </p>
      {/* Phone and tablet: one small card per brick. The table below leaves each money column about
          33px on a phone, so it is desktop-only — the same split as the area rows above. */}
      <ul className="space-y-1.5 lg:hidden">
        {bricks.map((brick) => (
          <li key={brick.key} className="border border-slate-200 bg-white px-3 py-2.5">
            <div className="flex items-baseline justify-between gap-3">
              <p
                className={cn(
                  "min-w-0 break-words text-xs",
                  brick.isUnassigned ? "italic text-slate-400" : "font-semibold text-slate-800",
                )}
              >
                {brick.name}
              </p>
              <span className="shrink-0 whitespace-nowrap text-xs font-black tabular-nums text-slate-900">
                {formatEgpFull(brick.salesValue)}
              </span>
            </div>
            <div className="mt-1.5">
              <ProportionBar fraction={Math.abs(brick.salesValue) / max} color={ACTUAL_COLOR} />
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-phx-xs">
              <div className={CARD_FACT_CLASS}>
                <dt className="text-slate-500">Source of Sales</dt>
                <dd className="whitespace-nowrap tabular-nums text-slate-700">{formatEgpFull(brick.indirectValue)}</dd>
              </div>
              <div className={CARD_FACT_CLASS}>
                <dt className="text-slate-500">Direct Orders</dt>
                <dd className="whitespace-nowrap tabular-nums text-slate-700">
                  {brick.directValue === 0 ? <span className="text-slate-300">—</span> : formatEgpFull(brick.directValue)}
                </dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
      <div className="hidden border border-slate-200 bg-white lg:block">
        <table className="w-full table-fixed text-left text-xs">
          <colgroup>
            <col style={{ width: "28%" }} />
            <col style={{ width: "18%" }} />
            <col style={{ width: "18%" }} />
            <col style={{ width: "18%" }} />
            <col style={{ width: "18%" }} />
          </colgroup>
          <thead>
            <tr className={TABLE_HEAD_CLASS}>
              <th className="px-3 py-2">Brick</th>
              <th className="px-3 py-2">Share</th>
              <th className="px-3 py-2 text-right">Source of Sales</th>
              <th className="px-3 py-2 text-right">Direct Orders</th>
              <th className="px-3 py-2 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {bricks.map((brick) => (
              <tr key={brick.key} className={TABLE_ROW_CLASS}>
                <td className={cn("break-words px-3 py-2", brick.isUnassigned ? "italic text-slate-400" : "font-semibold text-slate-800")}>
                  {brick.name}
                </td>
                <td className="px-3 py-2">
                  <ProportionBar fraction={Math.abs(brick.salesValue) / max} color={ACTUAL_COLOR} />
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-700">{formatEgpFull(brick.indirectValue)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                  {brick.directValue === 0 ? <span className="text-slate-300">—</span> : formatEgpFull(brick.directValue)}
                </td>
                <td className="px-3 py-2 text-right font-black tabular-nums text-slate-900">{formatEgpFull(brick.salesValue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** One side of the leaderboard. */
function LeaderList({
  nodes,
  tone,
  emptyLabel,
}: {
  nodes: VsTargetNode[];
  tone: "top" | "bottom";
  emptyLabel: string;
}) {
  if (nodes.length === 0) {
    return <p className="px-4 py-6 text-center text-xs text-slate-500">{emptyLabel}</p>;
  }
  return (
    <ol className="divide-y divide-slate-100">
      {nodes.map((node, index) => (
        <li key={node.key} className="flex items-center gap-3 px-4 py-3">
          <span
            className={cn(
              "flex h-7 w-7 shrink-0 items-center justify-center text-phx-xs font-black ring-1 ring-inset",
              tone === "top" ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-red-50 text-red-700 ring-red-200",
            )}
          >
            {index + 1}
          </span>
          <div className="min-w-0 flex-1">
            <p className="break-words text-phx-md font-bold text-slate-900">{node.name}</p>
            <p className="text-phx-xs tabular-nums text-slate-500">
              {formatEgpFull(node.current.actualValue)} of {formatEgpFull(node.current.targetValue)}
            </p>
          </div>
          <span className={cn("shrink-0 whitespace-nowrap text-base font-black tabular-nums", achievementTone(node.current.achievementValue))}>
            {formatPct(node.current.achievementValue)}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * A "nothing to show" panel. In the employee portal it is the house PortalEmptyState (icon tile,
 * title, message), the one empty panel every sales page shares; the admin shell keeps its own text
 * panel exactly as it was. The wording is the caller's either way.
 */
function EmptyPanel({
  surface,
  title,
  children,
  hint,
  compact = false,
}: {
  surface: "sales" | "portal";
  title: string;
  children: React.ReactNode;
  hint?: string;
  /** The admin panel's shorter one-line spacing. */
  compact?: boolean;
}) {
  if (surface === "portal") {
    return (
      <div className={SURFACE_CLASS}>
        <PortalEmptyState
          title={title}
          message={
            <>
              <p>{children}</p>
              {hint ? <p className="mt-2">{hint}</p> : null}
            </>
          }
        />
      </div>
    );
  }
  return (
    <div className={cn(SURFACE_CLASS, "px-4 py-12 text-center")}>
      <p className="text-sm font-bold text-slate-900">{title}</p>
      <p className={compact ? "mt-1 text-xs text-slate-500" : "mx-auto mt-1.5 max-w-xl text-xs leading-5 text-slate-500"}>
        {children}
      </p>
      {hint ? <p className="mt-3 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

// ── Main workspace ───────────────────────────────────────────────────────────

export function VsTargetDashboard({
  data,
  basePath,
  kicker,
  surface = "sales",
}: {
  data: VsTargetDashboardData;
  basePath: string;
  kicker: string;
  /** "portal" swaps the light command band for the employee-portal identity; see CommandBand. */
  surface?: "sales" | "portal";
}) {
  const router = useRouter();
  const [level, setLevel] = useState<LevelKey>(() => {
    if (data.levels.team) return "teams";
    if (data.levels.region) return "regions";
    return "areas";
  });
  const [drillKey, setDrillKey] = useState<string | null>(null);
  const [bricks, setBricks] = useState<BrickNode[] | null>(null);
  const [bricksLoading, setBricksLoading] = useState(false);

  const availableLevels = useMemo(() => {
    const levels: LevelKey[] = [];
    if (data.levels.team) levels.push("teams");
    if (data.levels.region) levels.push("regions");
    if (data.levels.area) levels.push("areas");
    if (data.levels.rep) levels.push("reps", "managers");
    if (data.regionalManagers.length > 0) levels.push("regionalManagers");
    if (data.products.length > 0) levels.push("products");
    return levels;
  }, [data.levels, data.regionalManagers.length, data.products.length]);

  const nodesForLevel: Record<LevelKey, VsTargetNode[]> = {
    teams: data.teams,
    regions: data.regions,
    areas: data.areas,
    reps: data.reps,
    managers: data.managers,
    regionalManagers: data.regionalManagers,
    products: data.products,
  };

  const priorLabel = data.priorPeriod ? formatPeriod(data.priorPeriod) : "prior month";
  const canDrill = level === "areas";

  async function toggleDrill(node: VsTargetNode) {
    if (drillKey === node.key) {
      setDrillKey(null);
      return;
    }
    setDrillKey(node.key);
    setBricks(null);
    setBricksLoading(true);
    try {
      const params = new URLSearchParams({ period: data.period, area: node.key });
      const response = await fetch(`/api/sales/vs-target/bricks?${params.toString()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      const payload = (await response.json()) as { bricks?: BrickNode[] };
      setBricks(payload.bricks ?? []);
    } catch {
      setBricks(null);
    } finally {
      setBricksLoading(false);
    }
  }

  const trendData = data.trend.map((point) => ({ ...point, label: formatPeriod(point.period) }));
  const missingTargetValue = data.uncovered.reduce((sum, entry) => sum + entry.actualValue, 0);
  const channelTotal = data.channels ? data.channels.direct + data.channels.indirect : 0;
  const topProducts = data.products.slice(0, 8);
  const maxProduct = Math.max(...topProducts.map((product) => Math.abs(product.current.actualValue)), 1);

  return (
    <div className="space-y-4">
      {surface === "portal" ? (
        // Employee-portal identity: the navy shell hero above carries the title, and the same
        // figures, ring and month selector render as portal cards + a panel here. The admin shell
        // keeps its own light band in the branch below — including the literal <p> that
        // tests/section-card-header-fits-a-phone.test.ts pins.
        <CommandBand
          surface="portal"
          // besideFrom="xl" is inert in the portal layout (cards + panel, no headline row), but the
          // band is handed both a ring and an aside, and tests/sales-command-band-fits-a-laptop.test.ts
          // requires every such band to carry it.
          besideFrom="xl"
          kicker={kicker}
          title="Sales vs Target"
          subtitle={`${formatPeriod(data.period)} · ${data.scopeLabel} · Source of Sales + Direct Orders`}
          stats={
            data.salesLoaded ? (
              <>
                <BandStat
                  label="Total sales"
                  value={<CountUpNumber value={data.totals.actualValue} format={formatEgp} />}
                  note={
                    data.priorPeriod ? (
                      <span className="inline-flex flex-wrap items-center gap-1.5">
                        <GrowthPill value={data.growth} /> vs {priorLabel}
                      </span>
                    ) : (
                      "First month — no prior period"
                    )
                  }
                />
                <BandStat
                  label="Target"
                  tone="sky"
                  value={<CountUpNumber value={data.totals.targetValue} format={formatEgp} />}
                  note={`${data.totals.coveredKeys.toLocaleString("en-US")} targeted product lines`}
                />
                {/* Units of different products are never added — shown only for a one-product view. */}
                {data.unitsAddable ? (
                  <BandStat
                    label="Units sold"
                    value={<CountUpNumber value={data.totals.actualUnits} format={formatNumber} />}
                    note={data.totals.targetUnits === 0 ? "No unit target" : `Target ${formatNumber(data.totals.targetUnits)}`}
                  />
                ) : null}
              </>
            ) : null
          }
          ring={
            data.salesLoaded ? (
              <AchievementRing value={data.totals.achievementValue} size={132} stroke={13} label="Achievement" premium />
            ) : undefined
          }
          aside={
            data.salesLoaded ? (
              <div>
                <p className={LABEL_CLASS}>Measured</p>
                <p className="mt-1 whitespace-nowrap text-2xl font-black tabular-nums text-slate-900">
                  {formatPct(data.coverage)}
                </p>
                <p className="mt-1 max-w-[13rem] text-phx-xs leading-4 text-slate-500">
                  of sales has a target to be measured against
                </p>
              </div>
            ) : undefined
          }
          footer={
            <BandChoice
              surface="portal"
              label="Month"
              options={data.periods.map((period) => ({ value: period, label: formatPeriod(period) }))}
              selected={data.period}
              onSelect={(period) => router.push(`${basePath}?period=${encodeURIComponent(period)}`)}
            />
          }
        />
      ) : (
      <>
      {/* ── Page header: light, an orange rule on top, the headline INSIDE it ──
          Rendered inline rather than through the shared CommandBand because the period/scope
          line has to stay a literal <p> here (tests/section-card-header-fits-a-phone.test.ts).
          SURFACE_CLASS goes FIRST: its `border` would otherwise erase the orange top rule when
          the class list is merged.
          The ring and aside go beside the headline from xl, not lg — CommandBand's
          besideFrom="xl": at 1024px in the portal they left the headline a 132px column, with
          the stats running under the ring (measured 2026-09-16). */}
      <section className={cn(SURFACE_CLASS, "relative border-t-[3px] border-t-orange-500")}>
        <div className="flex flex-col gap-6 px-5 py-5 sm:px-7 sm:py-6 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <p className="text-phx-xs font-black uppercase tracking-[0.24em] text-orange-600">{kicker}</p>
            <h1 className="mt-1 text-3xl font-black leading-tight tracking-tight text-slate-900 sm:text-[2.2rem]">
              Sales vs Target
            </h1>
            {/* No nowrap: at 375px a nowrap line CUT "Direct Orders" off the right edge
                (61px, measured 2026-09-05). It wraps instead. */}
            <p className="mt-1.5 text-sm text-slate-500">
              {formatPeriod(data.period)} · {data.scopeLabel} · Source of Sales + Direct Orders
            </p>

            {data.salesLoaded ? (
              <div className="mt-5 flex flex-wrap items-end gap-x-10 gap-y-4">
                <BandStat
                  label="Total sales"
                  value={<CountUpNumber value={data.totals.actualValue} format={formatEgp} />}
                  note={
                    data.priorPeriod ? (
                      <span className="inline-flex flex-wrap items-center gap-1.5">
                        <GrowthPill value={data.growth} /> vs {priorLabel}
                      </span>
                    ) : (
                      "First month — no prior period"
                    )
                  }
                />
                <BandStat
                  label="Target"
                  tone="sky"
                  value={<CountUpNumber value={data.totals.targetValue} format={formatEgp} />}
                  note={`${data.totals.coveredKeys.toLocaleString("en-US")} targeted product lines`}
                />
                {/* Units of different products are never added — shown only for a one-product view. */}
                {data.unitsAddable ? (
                  <BandStat
                    label="Units sold"
                    value={<CountUpNumber value={data.totals.actualUnits} format={formatNumber} />}
                    note={data.totals.targetUnits === 0 ? "No unit target" : `Target ${formatNumber(data.totals.targetUnits)}`}
                  />
                ) : null}
              </div>
            ) : null}
          </div>

          {data.salesLoaded ? (
            <div className="flex shrink-0 items-center gap-6">
              <AchievementRing value={data.totals.achievementValue} size={150} stroke={13} label="Achievement" />
              <div className="hidden border-l border-slate-100 pl-6 sm:block">
                <p className={LABEL_CLASS}>Measured</p>
                <p className="mt-1 whitespace-nowrap text-2xl font-black tabular-nums text-slate-900">
                  {formatPct(data.coverage)}
                </p>
                <p className="mt-1 max-w-[13rem] text-phx-xs leading-4 text-slate-500">
                  of sales has a target to be measured against
                </p>
              </div>
            </div>
          ) : null}
        </div>

        {/* Month selector, on the header's bottom rail so the page starts with content, not chrome. */}
        <div className="flex flex-wrap items-center gap-1.5 border-t border-slate-100 bg-slate-50/70 px-5 py-2.5 sm:px-7">
          <BandChoice
            label="Month"
            options={data.periods.map((period) => ({ value: period, label: formatPeriod(period) }))}
            selected={data.period}
            onSelect={(period) => router.push(`${basePath}?period=${encodeURIComponent(period)}`)}
          />
        </div>
      </section>
      </>
      )}

      {!data.salesLoaded ? (
        <EmptyPanel
          surface={surface}
          title={`Monthly Closing for ${formatPeriod(data.period)} has not been published yet.`}
          hint="Pick an earlier month above to see published results."
        >
          This is not a zero. Sales for this month are not final until reconciled and published, so there is
          nothing to measure against target yet.
          {/* pendingTargetValue, never totals.targetValue: totals hold PUBLISHED rows only, so in this
              panel their target is always 0 and the sentence could never render. */}
          {data.pendingTargetValue !== 0
            ? ` A target of ${formatEgpFull(data.pendingTargetValue)} is already loaded and will be measured as soon as the closing is published.`
            : ""}
        </EmptyPanel>
      ) : data.isEmptyScope ? (
        <EmptyPanel surface={surface} title={`No sales in your scope for ${formatPeriod(data.period)}.`} compact>
          This is not a zero — no sales rows were attributed to your territory for this month.
        </EmptyPanel>
      ) : (
        <>
          {/* Coverage banner */}
          {missingTargetValue !== 0 || data.byDesignUntargetedValue !== 0 ? (
            <div
              className={cn(
                "flex items-start gap-3 border border-l-[3px] px-4 py-3",
                missingTargetValue !== 0
                  ? "border-amber-200 border-l-amber-500 bg-amber-50"
                  : "border-slate-200 border-l-slate-400 bg-white",
              )}
            >
              <AlertTriangle
                className={cn("mt-0.5 h-4 w-4 shrink-0", missingTargetValue !== 0 ? "text-amber-600" : "text-slate-400")}
              />
              <div className={cn("min-w-0 text-xs leading-5", missingTargetValue !== 0 ? "text-amber-900" : "text-slate-600")}>
                {missingTargetValue !== 0 ? (
                  <p className="font-bold">
                    {formatEgpFull(missingTargetValue)} sits in {data.uncovered.length.toLocaleString("en-US")}{" "}
                    {data.uncovered.length === 1 ? "area that should" : "areas that should"} carry a target but has none.
                  </p>
                ) : null}
                <p className={missingTargetValue !== 0 ? "" : "font-semibold"}>
                  Achievement is every sale in a targeted month over that month&apos;s target — the same Ach % the
                  Monthly Closing prints — so the sales above, targeted or not, are all counted in it.
                  {data.byDesignUntargetedValue !== 0
                    ? ` A further ${formatEgpFull(data.byDesignUntargetedValue)} is in "Other" areas that carry no target by design.`
                    : ""}
                </p>
              </div>
            </div>
          ) : null}

          {/* ── Team gauges: the single densest read on the page ── */}
          {data.teams.length > 0 ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {data.teams.map((team) => (
                <div key={team.key} className={cn(SURFACE_CLASS, "flex items-center gap-4 p-5")}>
                  <AchievementRing value={team.current.achievementValue} size={104} stroke={9} />
                  <div className="min-w-0 flex-1">
                    <p className={LABEL_CLASS}>Team</p>
                    <p className="break-words text-base font-black tracking-tight text-slate-900">{team.name}</p>
                    <dl className="mt-2.5 space-y-1.5 border-t border-slate-100 pt-2.5 text-xs">
                      <div className={CARD_FACT_CLASS}>
                        <dt className="text-slate-500">Sales</dt>
                        <dd className="whitespace-nowrap font-black tabular-nums text-slate-900">{formatEgpFull(team.current.actualValue)}</dd>
                      </div>
                      <div className={CARD_FACT_CLASS}>
                        <dt className="text-slate-500">Target</dt>
                        <dd className="whitespace-nowrap font-semibold tabular-nums text-sky-600">
                          {team.current.targetValue === 0 ? "No target set" : formatEgpFull(team.current.targetValue)}
                        </dd>
                      </div>
                      {team.current.uncoveredActualValue !== 0 ? (
                        <div className={CARD_FACT_CLASS}>
                          <dt className="text-slate-500">No target</dt>
                          <dd className="whitespace-nowrap font-semibold tabular-nums text-amber-600">
                            {formatEgpFull(team.current.uncoveredActualValue)}
                          </dd>
                        </div>
                      ) : null}
                    </dl>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {/* ── Analysis row: product mix + channel + leaderboards ── */}
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <SectionCard surface={surface}
              title="Top products"
              subtitle={`${data.products.length.toLocaleString("en-US")} products sold this month`}
              icon={Package}
              className="xl:col-span-2"
            >
              <ul className="divide-y divide-slate-100">
                {topProducts.map((product) => (
                  <li
                    key={product.key}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 px-4 py-2.5"
                  >
                    <p className="min-w-0 break-words text-phx-md font-bold text-slate-900">{product.name}</p>
                    <span className="whitespace-nowrap text-phx-md font-black tabular-nums text-slate-900">
                      {formatEgpFull(product.current.actualValue)}
                    </span>
                    <ProportionBar fraction={Math.abs(product.current.actualValue) / maxProduct} color={ACTUAL_COLOR} />
                    <span className={cn("whitespace-nowrap text-right text-phx-xs font-bold tabular-nums", achievementTone(product.current.achievementValue))}>
                      {product.current.achievementValue == null ? "no target" : formatPct(product.current.achievementValue)}
                    </span>
                  </li>
                ))}
              </ul>
            </SectionCard>

            <SectionCard surface={surface} title="Where the sales came from" subtitle="Both sources, same period" icon={Boxes}>
              {data.channels && channelTotal !== 0 ? (
                /* Top-aligned, not centred: this card sits beside a tall product list, and
                   centring its short content leaves a dead band across the top of the card. */
                <div className="flex flex-col gap-5 p-5">
                  {[
                    { name: "Source of Sales", value: data.channels.indirect, color: ACTUAL_COLOR },
                    { name: "Direct Orders", value: data.channels.direct, color: "#8B5CF6" },
                  ].map((entry) => (
                    <div key={entry.name}>
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="h-2.5 w-2.5 shrink-0" style={{ backgroundColor: entry.color }} aria-hidden />
                          <span className="text-xs font-bold text-slate-700">{entry.name}</span>
                        </span>
                        <span className="whitespace-nowrap text-base font-black tabular-nums text-slate-900">{formatEgpFull(entry.value)}</span>
                      </div>
                      <div className="mt-2">
                        <ProportionBar fraction={Math.abs(entry.value) / Math.abs(channelTotal)} color={entry.color} />
                      </div>
                      <p className="mt-1 text-phx-xs text-slate-500">
                        {((entry.value / channelTotal) * 100).toFixed(1)}% of total sales
                      </p>
                    </div>
                  ))}
                  {data.areaUnattributedValue !== 0 ? (
                    <p className="border-t border-slate-100 pt-3 text-phx-xs leading-4 text-slate-500">
                      {formatEgpFull(data.areaUnattributedValue)} of Direct Orders could not be placed in a single area, so
                      it counts at team and region level only.
                    </p>
                  ) : null}
                  {data.unplacedValue !== 0 ? (
                    <p className="border-t border-slate-100 pt-3 text-phx-xs leading-4 text-slate-500">
                      A further {formatEgpFull(data.unplacedValue)} could not be placed in any area or region. It is real
                      invoiced sales and is counted in the total above — the same figure Monthly Closing reports — but it
                      reaches no region, area or rep, and no target measures it.
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="px-4 py-10 text-center text-xs text-slate-500">
                  Channel split unavailable for this month.
                </p>
              )}
            </SectionCard>
          </div>

          {/* Leaderboards — only where there is something to rank. */}
          {data.leaders.top.length > 0 ? (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <SectionCard surface={surface} title={`Top ${data.leaders.level}s`} subtitle="By achievement against target" icon={Trophy}>
                <LeaderList nodes={data.leaders.top} tone="top" emptyLabel="Nothing measurable yet." />
              </SectionCard>
              <SectionCard surface={surface} title="Needs attention" subtitle="Lowest achievement against a real target" icon={TrendingDown}>
                <LeaderList
                  nodes={data.leaders.bottom}
                  tone="bottom"
                  emptyLabel="Not enough targeted rows to rank a bottom group."
                />
              </SectionCard>
            </div>
          ) : null}

          {/* Trend — rendered ONLY when there is more than one loaded month. A single bar in an
              empty grid reads as a broken chart, which is exactly how the first build looked. */}
          {data.trendIsMeaningful ? (
            <SectionCard surface={surface} title="Sales vs Target trend" subtitle="From July 2026, when the dashboard starts" icon={TrendingUp}>
              <div className="h-72 w-full p-4">
                <ResponsiveContainer height="100%" width="100%">
                  <ComposedChart data={trendData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke="#E2E8F0" strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#64748B" }} tickLine={false} axisLine={{ stroke: "#E2E8F0" }} />
                    <YAxis
                      tick={{ fontSize: 11, fill: "#64748B" }}
                      tickFormatter={(value: number) => formatEgp(value)}
                      tickLine={false}
                      axisLine={false}
                      width={80}
                    />
                    <Tooltip content={<ChartTooltipContent />} cursor={{ fill: "rgba(249,115,22,0.06)" }} />
                    <Bar dataKey="actualValue" fill={ACTUAL_COLOR} name="Sales" maxBarSize={56}>
                      {trendData.map((point) => (
                        <Cell key={point.period} fill={ACTUAL_COLOR} />
                      ))}
                    </Bar>
                    <Line dataKey="targetValue" stroke={TARGET_COLOR} strokeWidth={2.5} dot={{ r: 3, fill: "#FFFFFF", strokeWidth: 2 }} name="Target" type="monotone" />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </SectionCard>
          ) : null}

          {/* Breakdown */}
          <SectionCard surface={surface}
            title="Performance breakdown"
            subtitle={canDrill ? "Select an area to open its bricks" : undefined}
            icon={LEVEL_META[level].icon}
            actions={
              <div className="flex flex-wrap gap-1.5">
                {availableLevels.map((key) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={key === level}
                    onClick={() => {
                      setLevel(key);
                      setDrillKey(null);
                    }}
                    className={cn("whitespace-nowrap", chipClass(key === level, surface))}
                  >
                    {LEVEL_META[key].label}
                  </button>
                ))}
              </div>
            }
          >
            <HierarchyTable
              nodes={nodesForLevel[level]}
              columnLabel={LEVEL_META[level].column}
              hasPrior={data.priorPeriod != null}
              priorLabel={priorLabel}
              onDrill={canDrill ? toggleDrill : undefined}
              drillKey={canDrill ? drillKey : null}
              bricks={bricks}
              bricksLoading={bricksLoading}
            />
            {level === "regionalManagers" ? (
              <p className="border-t border-slate-100 bg-slate-50/70 px-4 py-3 text-xs leading-5 text-slate-500">
                Each Regional Manager&apos;s figures are the totals of the District Managers under that Regional Manager. Districts that
                report straight to the National Sales Manager, and vacant districts, are not under any Regional Manager.
              </p>
            ) : null}
            {(data.areaUnattributedValue !== 0 || data.unplacedValue !== 0) &&
            level !== "teams" &&
            level !== "regions" &&
            level !== "regionalManagers" &&
            level !== "products" ? (
              <p className="border-t border-slate-100 bg-slate-50/70 px-4 py-3 text-xs leading-5 text-slate-500">
                This level totals {formatEgpFull(nodesForLevel[level].reduce((sum, node) => sum + node.current.actualValue, 0))}.
                {data.areaUnattributedValue !== 0
                  ? ` A further ${formatEgpFull(data.areaUnattributedValue)} of Direct Orders could not be placed in a single area, so it counts at team and region level only.`
                  : ""}
                {data.unplacedValue !== 0
                  ? ` ${formatEgpFull(data.unplacedValue)} could not be placed in any area or region at all, so it counts in the headline total only.`
                  : ""}
              </p>
            ) : null}
          </SectionCard>

          {/* Missing targets */}
          {data.uncovered.length > 0 ? (
            <SectionCard surface={surface}
              title="Areas missing a target"
              subtitle={`${data.uncovered.length} areas · ${formatEgpFull(missingTargetValue)} unmeasured`}
              icon={AlertTriangle}
            >
              <div className="hidden max-h-80 overflow-y-auto md:block">
                <table className="w-full table-fixed text-left text-sm">
                  <colgroup>
                    <col style={{ width: "26%" }} />
                    <col style={{ width: "24%" }} />
                    <col style={{ width: "26%" }} />
                    <col style={{ width: "24%" }} />
                  </colgroup>
                  <thead className="sticky top-0 z-10">
                    <tr className={TABLE_HEAD_CLASS}>
                      <th className="px-4 py-2.5">Team</th>
                      <th className="px-4 py-2.5">Region</th>
                      <th className="px-4 py-2.5">Area</th>
                      <th className="px-4 py-2.5 text-right">Unmeasured sales</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.uncovered.map((entry) => (
                      <tr key={entry.key} className={TABLE_ROW_CLASS}>
                        <td className="break-words px-4 py-2.5 font-bold text-slate-900">{entry.teamName}</td>
                        <td className="break-words px-4 py-2.5 text-slate-500">{entry.regionName}</td>
                        <td className="break-words px-4 py-2.5 text-slate-700">{entry.areaName}</td>
                        <td className="px-4 py-2.5 text-right font-black tabular-nums text-amber-600">
                          {formatEgpFull(entry.actualValue)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="space-y-2 p-3 md:hidden">
                {data.uncovered.map((entry) => (
                  <div key={entry.key} className="flex border border-slate-200 bg-white">
                    <span className="w-1 shrink-0 bg-amber-500" aria-hidden />
                    <div className="min-w-0 flex-1 p-3">
                      <div className="flex items-baseline justify-between gap-3">
                        <p className="min-w-0 break-words text-sm font-bold text-slate-900">{entry.areaName}</p>
                        <span className="shrink-0 whitespace-nowrap text-sm font-black tabular-nums text-amber-600">
                          {formatEgp(entry.actualValue)}
                        </span>
                      </div>
                      <p className="mt-1 break-words text-xs text-slate-500">
                        {entry.teamName} · {entry.regionName}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </SectionCard>
          ) : null}
        </>
      )}
    </div>
  );
}

export type { VsTargetDashboardData, VsTargetTotals };
