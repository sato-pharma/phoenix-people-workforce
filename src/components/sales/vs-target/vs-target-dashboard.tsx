"use client";

import { Fragment, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Boxes,
  Building2,
  Loader2,
  MapPin,
  Minus,
  Package,
  Target,
  TrendingUp,
  Users,
} from "lucide-react";

import { PremiumHero } from "@/components/ui/premium-hero";
import { CountUpNumber } from "@/components/ui/count-up";
import { cn } from "@/lib/utils";
import type { BrickNode } from "@/lib/sales/vs-target";
import type { VsTargetDashboardData } from "@/lib/sales/vs-target-page";
import type { VsTargetNode, VsTargetTotals } from "@/lib/sales/vs-target";

// Orange-led categorical palette, matching the Source of Sales dashboard so the two
// surfaces read as one module rather than two products.
const ACTUAL_COLOR = "#F97316";
const TARGET_COLOR = "#0EA5E9";
const CHANNEL_COLORS = ["#F97316", "#8B5CF6"];

// ── Formatting ───────────────────────────────────────────────────────────────
// Compact for chart axes and tiles; full for tables, where the exact figure matters.

function formatEgp(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}EGP ${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}EGP ${(abs / 1_000).toFixed(1)}K`;
  return `${sign}EGP ${Math.round(abs).toLocaleString("en-US")}`;
}

function formatEgpFull(value: number): string {
  return `EGP ${Math.round(value).toLocaleString("en-US")}`;
}

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/** A null percentage is "—", never "0%". The difference is the whole point. */
function formatPct(value: number | null): string {
  return value == null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function formatSignedPct(value: number | null): string {
  if (value == null) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(1)}%`;
}

function formatPeriod(period: string | null): string {
  if (!period) return "—";
  const match = /^(\d{4})-(\d{2})$/.exec(period.trim());
  if (!match) return period;
  return new Date(Number(match[1]), Number(match[2]) - 1, 1).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
  });
}

/**
 * Colour for an achievement figure. Null (no target) is deliberately NEUTRAL, not red —
 * an area nobody set a target for has not underperformed.
 */
function achievementTone(value: number | null): string {
  if (value == null) return "text-slate-400";
  if (value >= 1) return "text-emerald-600";
  if (value >= 0.8) return "text-amber-600";
  return "text-red-600";
}

function achievementBarColor(value: number | null): string {
  if (value == null) return "bg-slate-300";
  if (value >= 1) return "bg-emerald-500";
  if (value >= 0.8) return "bg-amber-500";
  return "bg-red-500";
}

function growthTone(value: number | null): string {
  if (value == null) return "text-slate-400";
  if (value > 0) return "text-emerald-600";
  if (value < 0) return "text-red-600";
  return "text-slate-500";
}

// ── Small building blocks ────────────────────────────────────────────────────

function GrowthPill({ value }: { value: number | null }) {
  const Icon = value == null ? Minus : value > 0 ? ArrowUpRight : value < 0 ? ArrowDownRight : Minus;
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap text-xs font-bold", growthTone(value))}>
      <Icon className="h-3.5 w-3.5 shrink-0" />
      {formatSignedPct(value)}
    </span>
  );
}

/**
 * Achievement rendered as a capped bar plus the true figure.
 *
 * The bar caps at 100% of its track so a 400% achiever cannot blow out the column width,
 * but the number beside it is never capped — the reader always sees the real value.
 */
function AchievementBar({ value }: { value: number | null }) {
  const pct = value == null ? 0 : Math.max(0, Math.min(1, value));
  return (
    <div className="flex items-center justify-end gap-2 whitespace-nowrap">
      <span className="h-1.5 w-16 shrink-0 overflow-hidden bg-slate-200" aria-hidden>
        <span className={cn("block h-full", achievementBarColor(value))} style={{ width: `${pct * 100}%` }} />
      </span>
      <span className={cn("w-16 text-right font-bold tabular-nums", achievementTone(value))}>{formatPct(value)}</span>
    </div>
  );
}

/**
 * Chart tooltip.
 *
 * A `content` render prop rather than recharts' `formatter`, matching the convention in
 * src/components/charts — and giving us square corners and full EGP figures, since a
 * tooltip is exactly where the reader wants the un-abbreviated number.
 */
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
    <div className="border border-border bg-popover px-3 py-2 shadow-lg">
      {label != null ? (
        <p className="mb-1 whitespace-nowrap text-[10px] font-black uppercase tracking-[0.12em] text-muted-foreground">
          {label}
        </p>
      ) : null}
      <div className="space-y-1">
        {payload.map((entry, index) => (
          <div key={`${entry.name ?? index}`} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 shrink-0" style={{ backgroundColor: entry.color }} aria-hidden />
              <span className="whitespace-nowrap text-[11px] font-semibold text-muted-foreground">{entry.name}</span>
            </span>
            <span className="whitespace-nowrap text-[11px] font-black tabular-nums text-foreground">
              {formatEgpFull(Number(entry.value ?? 0))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

type KpiProps = {
  label: string;
  value: number;
  format: (value: number) => string;
  accent: string;
  icon: typeof Target;
  footer?: React.ReactNode;
};

function KpiTile({ label, value, format, accent, icon: Icon, footer }: KpiProps) {
  return (
    <div className="flex overflow-hidden border border-border bg-card">
      <span className="w-1 shrink-0" style={{ backgroundColor: accent }} aria-hidden />
      <div className="min-w-0 flex-1 p-4">
        <div className="flex items-center justify-between gap-2">
          <p className="whitespace-nowrap text-[10px] font-black uppercase tracking-[0.16em] text-muted-foreground">
            {label}
          </p>
          <Icon className="h-4 w-4 shrink-0" style={{ color: accent }} />
        </div>
        <p className="mt-2 whitespace-nowrap text-xl font-black tabular-nums text-foreground sm:text-2xl">
          <CountUpNumber value={value} format={format} />
        </p>
        {footer ? <div className="mt-1.5 whitespace-nowrap text-xs text-muted-foreground">{footer}</div> : null}
      </div>
    </div>
  );
}

function SectionCard({
  title,
  subtitle,
  icon: Icon,
  children,
  actions,
}: {
  title: string;
  subtitle?: string;
  icon: typeof Target;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <section className="border border-border bg-card">
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <Icon className="h-4 w-4 shrink-0 text-orange-500" />
          <div className="min-w-0">
            <h2 className="whitespace-nowrap text-sm font-bold text-foreground">{title}</h2>
            {subtitle ? <p className="text-xs text-muted-foreground">{subtitle}</p> : null}
          </div>
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

// ── Hierarchy table ──────────────────────────────────────────────────────────

type LevelKey = "teams" | "regions" | "areas" | "reps" | "managers";

const LEVEL_META: Record<LevelKey, { label: string; column: string; icon: typeof Target }> = {
  teams: { label: "Teams", column: "Team", icon: Boxes },
  regions: { label: "Regions", column: "Region", icon: MapPin },
  areas: { label: "Areas", column: "Area", icon: Building2 },
  reps: { label: "Medical Reps", column: "Medical Rep", icon: Users },
  managers: { label: "District Managers", column: "District Manager", icon: Users },
};

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
  if (nodes.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-sm text-muted-foreground">
        No sales or targets for this level in your scope this month.
      </div>
    );
  }

  return (
    <>
      {/* Desktop: the full table. Horizontal scroll rather than wrapping or truncating. */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              <th className="whitespace-nowrap px-4 py-2.5 font-black">{columnLabel}</th>
              <th className="whitespace-nowrap px-4 py-2.5 text-right font-black">Sales</th>
              <th className="whitespace-nowrap px-4 py-2.5 text-right font-black">Target</th>
              <th className="whitespace-nowrap px-4 py-2.5 text-right font-black">Achievement</th>
              <th className="whitespace-nowrap px-4 py-2.5 text-right font-black">vs {priorLabel}</th>
              <th className="whitespace-nowrap px-4 py-2.5 text-right font-black">Untargeted sales</th>
            </tr>
          </thead>
          <tbody>
            {nodes.map((node) => {
              const isOpen = drillKey === node.key;
              return (
                <Fragment key={node.key}>
                  <tr
                    className={cn(
                      "border-b border-border/70 transition-colors hover:bg-muted/40",
                      onDrill ? "cursor-pointer" : undefined,
                      isOpen ? "bg-muted/50" : undefined,
                    )}
                    onClick={onDrill ? () => onDrill(node) : undefined}
                  >
                    <td className="whitespace-nowrap px-4 py-2.5 font-semibold text-foreground">{node.name}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums">
                      {formatEgpFull(node.current.actualValue)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                      {node.current.targetValue === 0 ? "No target set" : formatEgpFull(node.current.targetValue)}
                    </td>
                    <td className="px-4 py-2.5">
                      <AchievementBar value={node.current.achievementValue} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right">
                      {hasPrior ? <GrowthPill value={node.growth} /> : <span className="text-xs text-slate-400">—</span>}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums">
                      {node.current.uncoveredActualValue === 0 ? (
                        <span className="text-slate-400">—</span>
                      ) : (
                        <span className="text-amber-600">{formatEgpFull(node.current.uncoveredActualValue)}</span>
                      )}
                    </td>
                  </tr>
                  {isOpen ? (
                    <tr className="border-b border-border bg-muted/20">
                      <td className="px-4 py-3" colSpan={6}>
                        <BrickPanel bricks={bricks ?? null} loading={Boolean(bricksLoading)} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile: cards, never a table (admin shell golden rule). */}
      <div className="space-y-2 p-3 md:hidden">
        {nodes.map((node) => (
          <div key={node.key} className="flex overflow-hidden border border-border bg-background">
            <span className={cn("w-1 shrink-0", achievementBarColor(node.current.achievementValue))} aria-hidden />
            <div className="min-w-0 flex-1 p-3">
              <div className="flex items-baseline justify-between gap-3">
                <p className="min-w-0 overflow-x-auto whitespace-nowrap text-sm font-bold text-foreground">
                  {node.name}
                </p>
                <span className={cn("shrink-0 text-sm font-black tabular-nums", achievementTone(node.current.achievementValue))}>
                  {formatPct(node.current.achievementValue)}
                </span>
              </div>
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">Sales</dt>
                  <dd className="whitespace-nowrap font-semibold tabular-nums">{formatEgp(node.current.actualValue)}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">Target</dt>
                  <dd className="whitespace-nowrap font-semibold tabular-nums">
                    {node.current.targetValue === 0 ? "None" : formatEgp(node.current.targetValue)}
                  </dd>
                </div>
                {hasPrior ? (
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">vs {priorLabel}</dt>
                    <dd><GrowthPill value={node.growth} /></dd>
                  </div>
                ) : null}
                {node.current.uncoveredActualValue !== 0 ? (
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Untargeted</dt>
                    <dd className="whitespace-nowrap font-semibold tabular-nums text-amber-600">
                      {formatEgp(node.current.uncoveredActualValue)}
                    </dd>
                  </div>
                ) : null}
              </dl>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// ── Brick drill-down ─────────────────────────────────────────────────────────

function BrickPanel({ bricks, loading }: { bricks: BrickNode[] | null; loading: boolean }) {
  if (loading) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading bricks…
      </p>
    );
  }
  if (!bricks) {
    return <p className="text-xs text-muted-foreground">Bricks could not be loaded for this row.</p>;
  }
  if (bricks.length === 0) {
    return <p className="text-xs text-muted-foreground">No brick-level sales recorded here this month.</p>;
  }
  const total = bricks.reduce((sum, brick) => sum + brick.salesValue, 0);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="border-b border-border text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            <th className="whitespace-nowrap py-1.5 pr-4 font-black">Brick</th>
            <th className="whitespace-nowrap py-1.5 pr-4 text-right font-black">Source of Sales</th>
            <th className="whitespace-nowrap py-1.5 pr-4 text-right font-black">Direct Orders</th>
            <th className="whitespace-nowrap py-1.5 pr-4 text-right font-black">Total</th>
            <th className="whitespace-nowrap py-1.5 text-right font-black">Share</th>
          </tr>
        </thead>
        <tbody>
          {bricks.map((brick) => (
            <tr key={brick.key} className="border-b border-border/50 last:border-0">
              <td className={cn("whitespace-nowrap py-1.5 pr-4", brick.isUnassigned ? "italic text-muted-foreground" : "font-medium")}>
                {brick.name}
              </td>
              <td className="whitespace-nowrap py-1.5 pr-4 text-right tabular-nums">{formatEgpFull(brick.indirectValue)}</td>
              <td className="whitespace-nowrap py-1.5 pr-4 text-right tabular-nums">
                {brick.directValue === 0 ? <span className="text-slate-400">—</span> : formatEgpFull(brick.directValue)}
              </td>
              <td className="whitespace-nowrap py-1.5 pr-4 text-right font-semibold tabular-nums">{formatEgpFull(brick.salesValue)}</td>
              <td className="whitespace-nowrap py-1.5 text-right tabular-nums text-muted-foreground">
                {total === 0 ? "—" : `${((brick.salesValue / total) * 100).toFixed(1)}%`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Main workspace ───────────────────────────────────────────────────────────

export function VsTargetDashboard({
  data,
  basePath,
  kicker,
}: {
  data: VsTargetDashboardData;
  basePath: string;
  kicker: string;
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
    return levels;
  }, [data.levels]);

  const nodesForLevel: Record<LevelKey, VsTargetNode[]> = {
    teams: data.teams,
    regions: data.regions,
    areas: data.areas,
    reps: data.reps,
    managers: data.managers,
  };

  const priorLabel = data.priorPeriod ? formatPeriod(data.priorPeriod) : "prior month";

  /** Area rows drill to bricks; every other level has no brick grain of its own. */
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

  const channelData = data.channels
    ? [
        { name: "Source of Sales", value: data.channels.indirect },
        { name: "Direct Orders", value: data.channels.direct },
      ].filter((entry) => entry.value !== 0)
    : [];

  const trendData = data.trend.map((point) => ({
    ...point,
    label: formatPeriod(point.period),
  }));

  /** Only the areas that SHOULD carry a target — the actionable half of the untargeted total. */
  const missingTargetValue = data.uncovered.reduce((sum, entry) => sum + entry.actualValue, 0);

  return (
    <div className="space-y-4">
      <PremiumHero
        kicker={kicker}
        title="Sales vs Target"
        subtitle={`Source of Sales and Direct Orders measured against target for ${formatPeriod(data.period)} — ${data.scopeLabel.toLowerCase()}.`}
        badge={
          <span className="whitespace-nowrap border border-orange-400/40 bg-orange-500/10 px-3 py-1 text-[11px] font-black uppercase tracking-[0.16em] text-orange-300">
            {data.scopeLabel}
          </span>
        }
      />

      {/* Period picker */}
      <div className="flex flex-wrap items-center gap-2 border border-border bg-card px-4 py-3">
        <span className="whitespace-nowrap text-[10px] font-black uppercase tracking-[0.16em] text-muted-foreground">
          Month
        </span>
        <div className="flex flex-wrap gap-1.5">
          {data.periods.map((period) => (
            <button
              key={period}
              type="button"
              onClick={() => router.push(`${basePath}?period=${encodeURIComponent(period)}`)}
              className={cn(
                "whitespace-nowrap border px-3 py-1 text-xs font-bold transition-colors",
                period === data.period
                  ? "border-orange-500 bg-orange-500 text-white"
                  : "border-border bg-background text-muted-foreground hover:border-orange-400 hover:text-foreground",
              )}
            >
              {formatPeriod(period)}
            </button>
          ))}
        </div>
      </div>

      {!data.salesLoaded ? (
        /* Targets can exist for a month whose sales file has not arrived. Rendering the usual
           tiles here would show a confident EGP 0 / 0.0% against a real target — i.e. tell the
           whole field force they sold nothing, when the truth is nobody has uploaded yet. */
        <div className="border border-border bg-card px-4 py-10 text-center">
          <p className="text-sm font-semibold text-foreground">
            Sales for {formatPeriod(data.period)} have not been uploaded yet.
          </p>
          <p className="mx-auto mt-1 max-w-xl text-xs leading-5 text-muted-foreground">
            This is not a zero. No Source of Sales or Direct Order rows exist for this month, so there is nothing
            to measure against target yet.
            {data.totals.targetValue !== 0
              ? ` A target of ${formatEgpFull(data.totals.targetValue)} is already loaded and will be measured as soon as the sales arrive.`
              : ""}
          </p>
          <p className="mt-3 text-xs text-muted-foreground">Pick an earlier month above to see loaded results.</p>
        </div>
      ) : data.isEmptyScope ? (
        <div className="border border-border bg-card px-4 py-10 text-center">
          <p className="text-sm font-semibold text-foreground">No sales in your scope for {formatPeriod(data.period)}.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            This is not a zero — it means no sales rows were attributed to your territory for this month.
          </p>
        </div>
      ) : (
        <>
          {/* Honesty banner. Only the genuinely-missing targets raise an alert; "Other" areas that
              carry no target by design are reported in the same breath but never framed as a gap. */}
          {missingTargetValue !== 0 || data.byDesignUntargetedValue !== 0 ? (
            <div
              className={cn(
                "flex items-start gap-3 border px-4 py-3",
                missingTargetValue !== 0 ? "border-amber-300 bg-amber-50" : "border-border bg-muted/40",
              )}
            >
              <AlertTriangle
                className={cn("mt-0.5 h-4 w-4 shrink-0", missingTargetValue !== 0 ? "text-amber-600" : "text-muted-foreground")}
              />
              <div className={cn("min-w-0 text-xs leading-5", missingTargetValue !== 0 ? "text-amber-900" : "text-muted-foreground")}>
                {missingTargetValue !== 0 ? (
                  <p className="font-bold">
                    {formatEgpFull(missingTargetValue)} of these sales sits in{" "}
                    {data.uncovered.length.toLocaleString("en-US")}{" "}
                    {data.uncovered.length === 1 ? "area that should" : "areas that should"} carry a target but has
                    none{data.coverage != null ? ` — ${formatPct(data.coverage)} of sales is measured` : ""}.
                  </p>
                ) : null}
                <p className={missingTargetValue !== 0 ? "mt-0.5" : "font-semibold"}>
                  Achievement is calculated only on sales that have a target, so an untargeted area is never counted
                  as under-performing.
                  {data.byDesignUntargetedValue !== 0
                    ? ` A further ${formatEgpFull(data.byDesignUntargetedValue)} sits in "Other" areas that carry no target by design — nothing to load there.`
                    : ""}
                </p>
              </div>
            </div>
          ) : null}

          {/* KPI row */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <KpiTile
              label="Total Sales"
              value={data.totals.actualValue}
              format={formatEgp}
              accent={ACTUAL_COLOR}
              icon={TrendingUp}
              footer={
                data.priorPeriod ? (
                  <span className="inline-flex items-center gap-1.5">
                    <GrowthPill value={data.growth} /> vs {priorLabel}
                  </span>
                ) : (
                  "First month of the dashboard — no prior period"
                )
              }
            />
            <KpiTile
              label="Target"
              value={data.totals.targetValue}
              format={formatEgp}
              accent={TARGET_COLOR}
              icon={Target}
              footer={
                data.totals.targetValue === 0
                  ? "No target loaded for this scope"
                  : `${data.totals.coveredKeys.toLocaleString("en-US")} targeted product lines`
              }
            />
            <div className="flex overflow-hidden border border-border bg-card">
              <span
                className="w-1 shrink-0"
                style={{ backgroundColor: data.totals.achievementValue == null ? "#94A3B8" : ACTUAL_COLOR }}
                aria-hidden
              />
              <div className="min-w-0 flex-1 p-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="whitespace-nowrap text-[10px] font-black uppercase tracking-[0.16em] text-muted-foreground">
                    Achievement
                  </p>
                  <Target className="h-4 w-4 shrink-0 text-orange-500" />
                </div>
                <p
                  className={cn(
                    "mt-2 whitespace-nowrap text-xl font-black tabular-nums sm:text-2xl",
                    achievementTone(data.totals.achievementValue),
                  )}
                >
                  {formatPct(data.totals.achievementValue)}
                </p>
                <p className="mt-1.5 whitespace-nowrap text-xs text-muted-foreground">
                  {data.totals.achievementValue == null
                    ? "No target to measure against"
                    : `${formatEgp(data.totals.coveredActualValue)} of targeted sales`}
                </p>
              </div>
            </div>
            <KpiTile
              label="Units Sold"
              value={data.totals.actualUnits}
              format={formatNumber}
              accent="#22C55E"
              icon={Package}
              footer={
                data.totals.targetUnits === 0
                  ? "No unit target loaded"
                  : `Target ${formatNumber(data.totals.targetUnits)} units`
              }
            />
          </div>

          {/* Trend + channel */}
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
            <div className="xl:col-span-2">
              <SectionCard
                title="Sales vs Target trend"
                subtitle={`From ${formatPeriod(data.trend[0]?.period ?? data.period)} — the dashboard starts at July 2026`}
                icon={TrendingUp}
              >
                <div className="h-72 w-full p-3">
                  <ResponsiveContainer height="100%" width="100%">
                    <ComposedChart data={trendData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                      <CartesianGrid stroke="#E2E8F0" strokeDasharray="3 3" vertical={false} />
                      <XAxis
                        dataKey="label"
                        tick={{ fontSize: 11, fill: "#64748B" }}
                        tickLine={false}
                        axisLine={{ stroke: "#E2E8F0" }}
                      />
                      <YAxis
                        tick={{ fontSize: 11, fill: "#64748B" }}
                        tickFormatter={(value: number) => formatEgp(value)}
                        tickLine={false}
                        axisLine={false}
                        width={80}
                      />
                      <Tooltip content={<ChartTooltipContent />} cursor={{ fill: "rgba(148,163,184,0.12)" }} />
                      <Bar dataKey="actualValue" fill={ACTUAL_COLOR} name="Sales" maxBarSize={48} />
                      <Line
                        dataKey="targetValue"
                        stroke={TARGET_COLOR}
                        strokeWidth={2.5}
                        dot={{ r: 3 }}
                        name="Target"
                        type="monotone"
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </SectionCard>
            </div>

            <SectionCard title="Where the sales came from" subtitle="Both sources, same period" icon={Boxes}>
              {channelData.length === 0 ? (
                <p className="px-4 py-10 text-center text-xs text-muted-foreground">
                  Channel split unavailable for this month.
                </p>
              ) : (
                <>
                  <div className="h-52 w-full p-3">
                    <ResponsiveContainer height="100%" width="100%">
                      <PieChart>
                        <Pie data={channelData} dataKey="value" innerRadius={48} outerRadius={78} paddingAngle={2}>
                          {channelData.map((entry, index) => (
                            <Cell key={entry.name} fill={CHANNEL_COLORS[index % CHANNEL_COLORS.length]} />
                          ))}
                        </Pie>
                        <Tooltip content={<ChartTooltipContent />} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <ul className="space-y-1.5 border-t border-border px-4 py-3">
                    {channelData.map((entry, index) => (
                      <li key={entry.name} className="flex items-center justify-between gap-3 text-xs">
                        <span className="flex min-w-0 items-center gap-2">
                          <span
                            className="h-2.5 w-2.5 shrink-0"
                            style={{ backgroundColor: CHANNEL_COLORS[index % CHANNEL_COLORS.length] }}
                            aria-hidden
                          />
                          <span className="whitespace-nowrap font-medium text-foreground">{entry.name}</span>
                        </span>
                        <span className="whitespace-nowrap font-bold tabular-nums">{formatEgpFull(entry.value)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </SectionCard>
          </div>

          {/* Hierarchy */}
          <SectionCard
            title="Performance breakdown"
            subtitle={canDrill ? "Select an area to see its bricks" : undefined}
            icon={LEVEL_META[level].icon}
            actions={
              <div className="flex flex-wrap gap-1.5">
                {availableLevels.map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      setLevel(key);
                      setDrillKey(null);
                    }}
                    className={cn(
                      "whitespace-nowrap border px-2.5 py-1 text-[11px] font-bold transition-colors",
                      key === level
                        ? "border-orange-500 bg-orange-500 text-white"
                        : "border-border bg-background text-muted-foreground hover:border-orange-400 hover:text-foreground",
                    )}
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
            {/* Area / rep / brick levels foot to less than the headline whenever a direct order
                could not be placed in a single area. Saying so is the difference between an
                explained split and a table that looks like it lost rows. */}
            {data.areaUnattributedValue !== 0 && level !== "teams" && level !== "regions" ? (
              <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
                This level totals {formatEgpFull(nodesForLevel[level].reduce((sum, node) => sum + node.current.actualValue, 0))}.
                A further {formatEgpFull(data.areaUnattributedValue)} of Direct Orders could not be placed in a single
                area, so it is counted at team and region level only.
              </p>
            ) : null}
          </SectionCard>

          {/* Untargeted areas — the honesty panel */}
          {data.uncovered.length > 0 ? (
            <SectionCard
              title="Areas missing a target"
              subtitle="Areas that should carry a target but have none — excluded from achievement above"
              icon={AlertTriangle}
            >
              <div className="hidden overflow-x-auto md:block">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/40 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                      <th className="whitespace-nowrap px-4 py-2.5 font-black">Team</th>
                      <th className="whitespace-nowrap px-4 py-2.5 font-black">Region</th>
                      <th className="whitespace-nowrap px-4 py-2.5 font-black">Area</th>
                      <th className="whitespace-nowrap px-4 py-2.5 text-right font-black">Untargeted sales</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.uncovered.map((entry) => (
                      <tr key={entry.key} className="border-b border-border/70 last:border-0">
                        <td className="whitespace-nowrap px-4 py-2.5 font-semibold">{entry.teamName}</td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">{entry.regionName}</td>
                        <td className="whitespace-nowrap px-4 py-2.5">{entry.areaName}</td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-right font-bold tabular-nums text-amber-600">
                          {formatEgpFull(entry.actualValue)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="space-y-2 p-3 md:hidden">
                {data.uncovered.map((entry) => (
                  <div key={entry.key} className="flex overflow-hidden border border-border bg-background">
                    <span className="w-1 shrink-0 bg-amber-500" aria-hidden />
                    <div className="min-w-0 flex-1 p-3">
                      <div className="flex items-baseline justify-between gap-3">
                        <p className="overflow-x-auto whitespace-nowrap text-sm font-bold">{entry.areaName}</p>
                        <span className="shrink-0 whitespace-nowrap text-sm font-black tabular-nums text-amber-600">
                          {formatEgp(entry.actualValue)}
                        </span>
                      </div>
                      <p className="mt-1 overflow-x-auto whitespace-nowrap text-xs text-muted-foreground">
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

/** Re-exported so the routes can type their props without importing the domain module. */
export type { VsTargetDashboardData, VsTargetTotals };
