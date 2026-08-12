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
  ArrowDownRight,
  ArrowUpRight,
  Boxes,
  Building2,
  ChevronDown,
  Loader2,
  MapPin,
  Minus,
  Package,
  Target,
  TrendingDown,
  TrendingUp,
  Trophy,
  Users,
} from "lucide-react";

import { CountUpNumber } from "@/components/ui/count-up";
import { cn } from "@/lib/utils";
import type { BrickNode, VsTargetNode, VsTargetTotals } from "@/lib/sales/vs-target";
import type { VsTargetDashboardData } from "@/lib/sales/vs-target-page";

const ACTUAL_COLOR = "#F97316";
const TARGET_COLOR = "#38BDF8";

// ── Formatting ───────────────────────────────────────────────────────────────

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
  return `${value > 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
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

/** Null (no target) is NEUTRAL, never red — an untargeted area has not underperformed. */
function achievementTone(value: number | null): string {
  if (value == null) return "text-slate-400";
  if (value >= 1) return "text-emerald-600";
  if (value >= 0.8) return "text-amber-600";
  if (value >= 0.5) return "text-orange-600";
  return "text-red-600";
}

function achievementHex(value: number | null): string {
  if (value == null) return "#94A3B8";
  if (value >= 1) return "#10B981";
  if (value >= 0.8) return "#F59E0B";
  if (value >= 0.5) return "#F97316";
  return "#EF4444";
}

function growthTone(value: number | null): string {
  if (value == null) return "text-slate-400";
  if (value > 0) return "text-emerald-600";
  if (value < 0) return "text-red-600";
  return "text-slate-500";
}

// ── Primitives ───────────────────────────────────────────────────────────────

function GrowthPill({ value, dark = false }: { value: number | null; dark?: boolean }) {
  const Icon = value == null ? Minus : value > 0 ? ArrowUpRight : value < 0 ? ArrowDownRight : Minus;
  const tone = dark
    ? value == null
      ? "text-slate-400"
      : value > 0
        ? "text-emerald-400"
        : value < 0
          ? "text-red-400"
          : "text-slate-400"
    : growthTone(value);
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap text-xs font-bold", tone)}>
      <Icon className="h-3.5 w-3.5 shrink-0" />
      {formatSignedPct(value)}
    </span>
  );
}

/**
 * Achievement as an SVG arc.
 *
 * Drawn by hand rather than with a chart library: it must render identically at four sizes,
 * animate nothing, and never leave an empty frame when the value is null — which is exactly
 * where the first build's recharts panels failed.
 */
function AchievementRing({
  value,
  size = 132,
  stroke = 11,
  label,
  dark = false,
}: {
  value: number | null;
  size?: number;
  stroke?: number;
  label?: string;
  dark?: boolean;
}) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  // Cap the ARC at 100% so an over-achiever cannot wrap the circle, while the printed
  // number below stays uncapped and truthful.
  const fraction = value == null ? 0 : Math.max(0, Math.min(1, value));
  const color = achievementHex(value);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={dark ? "rgba(148,163,184,0.22)" : "#E2E8F0"}
          strokeWidth={stroke}
        />
        {value != null ? (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="butt"
            strokeDasharray={`${circumference * fraction} ${circumference}`}
          />
        ) : null}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span
          className={cn("whitespace-nowrap font-black tabular-nums", dark ? "" : achievementTone(value))}
          style={{ fontSize: size / 4.6, color: dark ? color : undefined }}
        >
          {formatPct(value)}
        </span>
        {label ? (
          <span
            className={cn(
              "mt-0.5 whitespace-nowrap font-bold uppercase tracking-[0.14em]",
              dark ? "text-slate-400" : "text-muted-foreground",
            )}
            style={{ fontSize: Math.max(8, size / 15) }}
          >
            {label}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Horizontal proportion bar used in the ranked lists and product mix. */
function ProportionBar({ fraction, color }: { fraction: number; color: string }) {
  return (
    <span className="block h-1.5 w-full overflow-hidden bg-slate-200" aria-hidden>
      <span
        className="block h-full"
        style={{ width: `${Math.max(0, Math.min(1, fraction)) * 100}%`, backgroundColor: color }}
      />
    </span>
  );
}

function AchievementCell({ value }: { value: number | null }) {
  return (
    <div className="flex items-center justify-end gap-2 whitespace-nowrap">
      <span className="h-1.5 w-20 shrink-0 overflow-hidden bg-slate-200" aria-hidden>
        <span
          className="block h-full"
          style={{
            width: `${(value == null ? 0 : Math.max(0, Math.min(1, value))) * 100}%`,
            backgroundColor: achievementHex(value),
          }}
        />
      </span>
      <span className={cn("w-16 text-right font-black tabular-nums", achievementTone(value))}>{formatPct(value)}</span>
    </div>
  );
}

function SectionCard({
  title,
  subtitle,
  icon: Icon,
  children,
  actions,
  className,
}: {
  title: string;
  subtitle?: string;
  icon: typeof Target;
  children: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex flex-col border border-border bg-card shadow-sm", className)}>
      <header className="flex items-center justify-between gap-3 border-b border-border bg-muted/30 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <Icon className="h-4 w-4 shrink-0 text-orange-500" />
          <div className="min-w-0">
            <h2 className="whitespace-nowrap text-[13px] font-black tracking-tight text-foreground">{title}</h2>
            {subtitle ? (
              <p className="whitespace-nowrap text-[11px] text-muted-foreground">{subtitle}</p>
            ) : null}
          </div>
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </header>
      <div className="flex-1">{children}</div>
    </section>
  );
}

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
    <div className="border border-slate-700 bg-slate-900 px-3 py-2 shadow-xl">
      {label != null ? (
        <p className="mb-1 whitespace-nowrap text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">
          {label}
        </p>
      ) : null}
      <div className="space-y-1">
        {payload.map((entry, index) => (
          <div key={`${entry.name ?? index}`} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 shrink-0" style={{ backgroundColor: entry.color }} aria-hidden />
              <span className="whitespace-nowrap text-[11px] font-semibold text-slate-300">{entry.name}</span>
            </span>
            <span className="whitespace-nowrap text-[11px] font-black tabular-nums text-white">
              {formatEgpFull(Number(entry.value ?? 0))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Hierarchy table ──────────────────────────────────────────────────────────

type LevelKey = "teams" | "regions" | "areas" | "reps" | "managers" | "products";

const LEVEL_META: Record<LevelKey, { label: string; column: string; icon: typeof Target }> = {
  teams: { label: "Teams", column: "Team", icon: Boxes },
  regions: { label: "Regions", column: "Region", icon: MapPin },
  areas: { label: "Areas", column: "Area", icon: Building2 },
  reps: { label: "Medical Reps", column: "Medical Rep", icon: Users },
  managers: { label: "District Managers", column: "District Manager", icon: Users },
  products: { label: "Products", column: "Product", icon: Package },
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
  const maxSales = Math.max(...nodes.map((node) => Math.abs(node.current.actualValue)), 1);

  if (nodes.length === 0) {
    return (
      <div className="px-4 py-10 text-center text-sm text-muted-foreground">
        No sales or targets at this level in your scope this month.
      </div>
    );
  }

  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 z-10">
            <tr className="bg-slate-900 text-[10px] uppercase tracking-[0.14em] text-slate-300">
              <th className="whitespace-nowrap px-4 py-2.5 font-black">{columnLabel}</th>
              <th className="whitespace-nowrap px-4 py-2.5 text-right font-black">Sales</th>
              <th className="whitespace-nowrap px-4 py-2.5 font-black">Share</th>
              <th className="whitespace-nowrap px-4 py-2.5 text-right font-black">Target</th>
              <th className="whitespace-nowrap px-4 py-2.5 text-right font-black">Achievement</th>
              <th className="whitespace-nowrap px-4 py-2.5 text-right font-black">vs {priorLabel}</th>
              <th className="whitespace-nowrap px-4 py-2.5 text-right font-black">No target</th>
            </tr>
          </thead>
          <tbody>
            {nodes.map((node, index) => {
              const isOpen = drillKey === node.key;
              return (
                <Fragment key={node.key}>
                  <tr
                    className={cn(
                      "border-b border-border/60 transition-colors",
                      index % 2 === 1 ? "bg-muted/20" : undefined,
                      onDrill ? "cursor-pointer hover:bg-orange-50" : "hover:bg-muted/40",
                      isOpen ? "bg-orange-50" : undefined,
                    )}
                    onClick={onDrill ? () => onDrill(node) : undefined}
                  >
                    <td className="whitespace-nowrap px-4 py-2.5 font-bold text-foreground">
                      <span className="flex items-center gap-1.5">
                        {onDrill ? (
                          <ChevronDown
                            className={cn(
                              "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                              isOpen ? "" : "-rotate-90",
                            )}
                          />
                        ) : null}
                        {node.name}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right font-semibold tabular-nums">
                      {formatEgpFull(node.current.actualValue)}
                    </td>
                    <td className="w-28 px-4 py-2.5">
                      <ProportionBar fraction={Math.abs(node.current.actualValue) / maxSales} color={ACTUAL_COLOR} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                      {node.current.targetValue === 0 ? (
                        <span className="italic text-slate-400">No target set</span>
                      ) : (
                        formatEgpFull(node.current.targetValue)
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <AchievementCell value={node.current.achievementValue} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right">
                      {hasPrior ? <GrowthPill value={node.growth} /> : <span className="text-xs text-slate-400">—</span>}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums">
                      {node.current.uncoveredActualValue === 0 ? (
                        <span className="text-slate-300">—</span>
                      ) : (
                        <span className="font-semibold text-amber-600">
                          {formatEgpFull(node.current.uncoveredActualValue)}
                        </span>
                      )}
                    </td>
                  </tr>
                  {isOpen ? (
                    <tr className="border-b border-border bg-slate-50">
                      <td className="px-4 py-3" colSpan={7}>
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

      {/* Mobile: cards, never a table. */}
      <div className="space-y-2 p-3 md:hidden">
        {nodes.map((node) => (
          <div key={node.key} className="flex overflow-hidden border border-border bg-background">
            <span className="w-1 shrink-0" style={{ backgroundColor: achievementHex(node.current.achievementValue) }} aria-hidden />
            <div className="min-w-0 flex-1 p-3">
              <div className="flex items-baseline justify-between gap-3">
                <p className="min-w-0 overflow-x-auto whitespace-nowrap text-sm font-bold text-foreground">{node.name}</p>
                <span className={cn("shrink-0 text-sm font-black tabular-nums", achievementTone(node.current.achievementValue))}>
                  {formatPct(node.current.achievementValue)}
                </span>
              </div>
              <div className="mt-2">
                <ProportionBar fraction={Math.abs(node.current.actualValue) / maxSales} color={ACTUAL_COLOR} />
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
                    <dt className="text-muted-foreground">No target</dt>
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

function BrickPanel({ bricks, loading }: { bricks: BrickNode[] | null; loading: boolean }) {
  if (loading) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading bricks…
      </p>
    );
  }
  if (!bricks) return <p className="text-xs text-muted-foreground">Bricks could not be loaded for this row.</p>;
  if (bricks.length === 0) return <p className="text-xs text-muted-foreground">No brick-level sales recorded here this month.</p>;

  const total = bricks.reduce((sum, brick) => sum + brick.salesValue, 0);
  const max = Math.max(...bricks.map((brick) => Math.abs(brick.salesValue)), 1);
  return (
    <div>
      <p className="mb-2 text-[10px] font-black uppercase tracking-[0.14em] text-muted-foreground">
        Bricks — {bricks.length.toLocaleString("en-US")} in this area, {formatEgpFull(total)}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-border text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              <th className="whitespace-nowrap py-1.5 pr-4 font-black">Brick</th>
              <th className="w-32 py-1.5 pr-4 font-black">Share</th>
              <th className="whitespace-nowrap py-1.5 pr-4 text-right font-black">Source of Sales</th>
              <th className="whitespace-nowrap py-1.5 pr-4 text-right font-black">Direct Orders</th>
              <th className="whitespace-nowrap py-1.5 text-right font-black">Total</th>
            </tr>
          </thead>
          <tbody>
            {bricks.map((brick) => (
              <tr key={brick.key} className="border-b border-border/40 last:border-0">
                <td className={cn("whitespace-nowrap py-1.5 pr-4", brick.isUnassigned ? "italic text-muted-foreground" : "font-medium")}>
                  {brick.name}
                </td>
                <td className="py-1.5 pr-4">
                  <ProportionBar fraction={Math.abs(brick.salesValue) / max} color={ACTUAL_COLOR} />
                </td>
                <td className="whitespace-nowrap py-1.5 pr-4 text-right tabular-nums">{formatEgpFull(brick.indirectValue)}</td>
                <td className="whitespace-nowrap py-1.5 pr-4 text-right tabular-nums">
                  {brick.directValue === 0 ? <span className="text-slate-300">—</span> : formatEgpFull(brick.directValue)}
                </td>
                <td className="whitespace-nowrap py-1.5 text-right font-bold tabular-nums">{formatEgpFull(brick.salesValue)}</td>
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
    return <p className="px-4 py-6 text-center text-xs text-muted-foreground">{emptyLabel}</p>;
  }
  return (
    <ol className="divide-y divide-border">
      {nodes.map((node, index) => (
        <li key={node.key} className="flex items-center gap-3 px-4 py-2.5">
          <span
            className={cn(
              "flex h-6 w-6 shrink-0 items-center justify-center text-[11px] font-black text-white",
              tone === "top" ? "bg-emerald-500" : "bg-red-500",
            )}
          >
            {index + 1}
          </span>
          <div className="min-w-0 flex-1">
            <p className="overflow-x-auto whitespace-nowrap text-[13px] font-bold text-foreground">{node.name}</p>
            <p className="whitespace-nowrap text-[11px] text-muted-foreground">
              {formatEgpFull(node.current.actualValue)} of {formatEgpFull(node.current.targetValue)}
            </p>
          </div>
          <span className={cn("shrink-0 whitespace-nowrap text-sm font-black tabular-nums", achievementTone(node.current.achievementValue))}>
            {formatPct(node.current.achievementValue)}
          </span>
        </li>
      ))}
    </ol>
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
    if (data.products.length > 0) levels.push("products");
    return levels;
  }, [data.levels, data.products.length]);

  const nodesForLevel: Record<LevelKey, VsTargetNode[]> = {
    teams: data.teams,
    regions: data.regions,
    areas: data.areas,
    reps: data.reps,
    managers: data.managers,
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
    <div className="space-y-3">
      {/* ── Command band: the headline lives INSIDE the hero, not in separate flat tiles ── */}
      <section className="relative overflow-hidden border border-slate-800 bg-slate-900">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-orange-500/0 via-orange-400/90 to-orange-500/0"
        />
        <div aria-hidden className="pointer-events-none absolute -right-24 -top-28 h-80 w-80 rounded-full bg-orange-500/10 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -bottom-20 -left-20 h-64 w-64 rounded-full bg-sky-500/10 blur-3xl" />

        <div className="relative flex flex-col gap-6 px-5 py-6 sm:px-8 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <p className="text-[11px] font-black uppercase tracking-[0.28em] text-orange-400">{kicker}</p>
            <h1 className="mt-1 text-3xl font-black leading-none tracking-tight text-white sm:text-[2.3rem]">
              Sales vs Target
            </h1>
            <p className="mt-2 whitespace-nowrap text-sm text-slate-400">
              {formatPeriod(data.period)} · {data.scopeLabel} · Source of Sales + Direct Orders
            </p>

            {data.salesLoaded ? (
              <div className="mt-5 flex flex-wrap items-end gap-x-9 gap-y-4">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-500">Total sales</p>
                  <p className="mt-0.5 whitespace-nowrap text-3xl font-black tabular-nums text-white">
                    <CountUpNumber value={data.totals.actualValue} format={formatEgp} />
                  </p>
                  <p className="mt-1 whitespace-nowrap text-[11px] text-slate-400">
                    {data.priorPeriod ? (
                      <span className="inline-flex items-center gap-1.5">
                        <GrowthPill dark value={data.growth} /> vs {priorLabel}
                      </span>
                    ) : (
                      "First month — no prior period"
                    )}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-500">Target</p>
                  <p className="mt-0.5 whitespace-nowrap text-3xl font-black tabular-nums text-sky-300">
                    <CountUpNumber value={data.totals.targetValue} format={formatEgp} />
                  </p>
                  <p className="mt-1 whitespace-nowrap text-[11px] text-slate-400">
                    {data.totals.coveredKeys.toLocaleString("en-US")} targeted product lines
                  </p>
                </div>
                <div>
                  <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-500">Units sold</p>
                  <p className="mt-0.5 whitespace-nowrap text-3xl font-black tabular-nums text-white">
                    <CountUpNumber value={data.totals.actualUnits} format={formatNumber} />
                  </p>
                  <p className="mt-1 whitespace-nowrap text-[11px] text-slate-400">
                    {data.totals.targetUnits === 0 ? "No unit target" : `Target ${formatNumber(data.totals.targetUnits)}`}
                  </p>
                </div>
              </div>
            ) : null}
          </div>

          {data.salesLoaded ? (
            <div className="flex shrink-0 items-center gap-6">
              <AchievementRing dark value={data.totals.achievementValue} size={150} stroke={13} label="Achievement" />
              <div className="hidden sm:block">
                <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-500">Measured</p>
                <p className="mt-1 whitespace-nowrap text-2xl font-black tabular-nums text-white">
                  {formatPct(data.coverage)}
                </p>
                <p className="mt-1 max-w-[13rem] text-[11px] leading-4 text-slate-400">
                  of sales has a target to be measured against
                </p>
              </div>
            </div>
          ) : null}
        </div>

        {/* Month selector, inside the band so the page starts with content, not chrome. */}
        <div className="relative flex flex-wrap items-center gap-1.5 border-t border-slate-800 px-5 py-2.5 sm:px-8">
          <span className="mr-1 whitespace-nowrap text-[10px] font-black uppercase tracking-[0.18em] text-slate-500">
            Month
          </span>
          {data.periods.map((period) => (
            <button
              key={period}
              type="button"
              onClick={() => router.push(`${basePath}?period=${encodeURIComponent(period)}`)}
              className={cn(
                "whitespace-nowrap border px-3 py-1 text-xs font-bold transition-colors",
                period === data.period
                  ? "border-orange-500 bg-orange-500 text-white"
                  : "border-slate-700 bg-slate-800/60 text-slate-300 hover:border-orange-400 hover:text-white",
              )}
            >
              {formatPeriod(period)}
            </button>
          ))}
        </div>
      </section>

      {!data.salesLoaded ? (
        <div className="border border-border bg-card px-4 py-12 text-center">
          <p className="text-sm font-bold text-foreground">
            Source of Sales for {formatPeriod(data.period)} has not been uploaded yet.
          </p>
          <p className="mx-auto mt-1.5 max-w-xl text-xs leading-5 text-muted-foreground">
            This is not a zero. The distributor files for this month have not arrived, so there is nothing to measure
            against target yet.
            {data.pendingDirectValue !== 0
              ? ` ${formatEgpFull(data.pendingDirectValue)} of Direct Orders is already booked into this month and joins the total the moment the upload lands.`
              : ""}
            {data.totals.targetValue !== 0
              ? ` A target of ${formatEgpFull(data.totals.targetValue)} is already loaded and will be measured as soon as the sales arrive.`
              : ""}
          </p>
          <p className="mt-3 text-xs text-muted-foreground">Pick an earlier month above to see loaded results.</p>
        </div>
      ) : data.isEmptyScope ? (
        <div className="border border-border bg-card px-4 py-12 text-center">
          <p className="text-sm font-bold text-foreground">No sales in your scope for {formatPeriod(data.period)}.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            This is not a zero — no sales rows were attributed to your territory for this month.
          </p>
        </div>
      ) : (
        <>
          {/* Coverage banner */}
          {missingTargetValue !== 0 || data.byDesignUntargetedValue !== 0 ? (
            <div
              className={cn(
                "flex items-start gap-3 border px-4 py-2.5",
                missingTargetValue !== 0 ? "border-amber-300 bg-amber-50" : "border-border bg-muted/40",
              )}
            >
              <AlertTriangle
                className={cn("mt-0.5 h-4 w-4 shrink-0", missingTargetValue !== 0 ? "text-amber-600" : "text-muted-foreground")}
              />
              <div className={cn("min-w-0 text-xs leading-5", missingTargetValue !== 0 ? "text-amber-900" : "text-muted-foreground")}>
                {missingTargetValue !== 0 ? (
                  <p className="font-bold">
                    {formatEgpFull(missingTargetValue)} sits in {data.uncovered.length.toLocaleString("en-US")}{" "}
                    {data.uncovered.length === 1 ? "area that should" : "areas that should"} carry a target but has none.
                  </p>
                ) : null}
                <p className={missingTargetValue !== 0 ? "" : "font-semibold"}>
                  Achievement counts only sales that have a target, so an untargeted area is never shown as
                  under-performing.
                  {data.byDesignUntargetedValue !== 0
                    ? ` A further ${formatEgpFull(data.byDesignUntargetedValue)} is in "Other" areas that carry no target by design.`
                    : ""}
                </p>
              </div>
            </div>
          ) : null}

          {/* ── Team gauges: the single densest read on the page ── */}
          {data.teams.length > 0 ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {data.teams.map((team) => (
                <div key={team.key} className="flex items-center gap-4 border border-border bg-card p-4 shadow-sm">
                  <AchievementRing value={team.current.achievementValue} size={104} stroke={9} />
                  <div className="min-w-0 flex-1">
                    <p className="overflow-x-auto whitespace-nowrap text-base font-black tracking-tight text-foreground">
                      {team.name}
                    </p>
                    <dl className="mt-2 space-y-1 text-xs">
                      <div className="flex justify-between gap-3">
                        <dt className="text-muted-foreground">Sales</dt>
                        <dd className="whitespace-nowrap font-black tabular-nums">{formatEgpFull(team.current.actualValue)}</dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt className="text-muted-foreground">Target</dt>
                        <dd className="whitespace-nowrap font-semibold tabular-nums text-muted-foreground">
                          {team.current.targetValue === 0 ? "No target set" : formatEgpFull(team.current.targetValue)}
                        </dd>
                      </div>
                      {team.current.uncoveredActualValue !== 0 ? (
                        <div className="flex justify-between gap-3">
                          <dt className="text-muted-foreground">No target</dt>
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
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
            <SectionCard
              title="Top products"
              subtitle={`${data.products.length.toLocaleString("en-US")} products sold this month`}
              icon={Package}
              className="xl:col-span-2"
            >
              <ul className="divide-y divide-border">
                {topProducts.map((product) => (
                  <li key={product.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-2">
                    <p className="overflow-x-auto whitespace-nowrap text-[13px] font-bold text-foreground">{product.name}</p>
                    <span className="whitespace-nowrap text-[13px] font-black tabular-nums">
                      {formatEgpFull(product.current.actualValue)}
                    </span>
                    <ProportionBar fraction={Math.abs(product.current.actualValue) / maxProduct} color={ACTUAL_COLOR} />
                    <span className={cn("whitespace-nowrap text-right text-[11px] font-bold tabular-nums", achievementTone(product.current.achievementValue))}>
                      {product.current.achievementValue == null ? "no target" : formatPct(product.current.achievementValue)}
                    </span>
                  </li>
                ))}
              </ul>
            </SectionCard>

            <SectionCard title="Where the sales came from" subtitle="Both sources, same period" icon={Boxes}>
              {data.channels && channelTotal !== 0 ? (
                /* Top-aligned, not centred: this card sits beside a tall product list, and
                   centring its short content leaves a dead band across the top of the card. */
                <div className="flex flex-col gap-4 p-4">
                  {[
                    { name: "Source of Sales", value: data.channels.indirect, color: ACTUAL_COLOR },
                    { name: "Direct Orders", value: data.channels.direct, color: "#8B5CF6" },
                  ].map((entry) => (
                    <div key={entry.name}>
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="h-2.5 w-2.5 shrink-0" style={{ backgroundColor: entry.color }} aria-hidden />
                          <span className="whitespace-nowrap text-xs font-bold text-foreground">{entry.name}</span>
                        </span>
                        <span className="whitespace-nowrap text-sm font-black tabular-nums">{formatEgpFull(entry.value)}</span>
                      </div>
                      <div className="mt-1.5">
                        <ProportionBar fraction={Math.abs(entry.value) / Math.abs(channelTotal)} color={entry.color} />
                      </div>
                      <p className="mt-1 whitespace-nowrap text-[11px] text-muted-foreground">
                        {((entry.value / channelTotal) * 100).toFixed(1)}% of total sales
                      </p>
                    </div>
                  ))}
                  {data.areaUnattributedValue !== 0 ? (
                    <p className="border-t border-border pt-3 text-[11px] leading-4 text-muted-foreground">
                      {formatEgpFull(data.areaUnattributedValue)} of Direct Orders could not be placed in a single area, so
                      it counts at team and region level only.
                    </p>
                  ) : null}
                  {data.unplacedValue !== 0 ? (
                    <p className="border-t border-border pt-3 text-[11px] leading-4 text-muted-foreground">
                      A further {formatEgpFull(data.unplacedValue)} could not be placed in any area or region. It is real
                      invoiced sales and is counted in the total above — the same figure Monthly Closing reports — but it
                      reaches no region, area or rep, and no target measures it.
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="px-4 py-10 text-center text-xs text-muted-foreground">
                  Channel split unavailable for this month.
                </p>
              )}
            </SectionCard>
          </div>

          {/* Leaderboards — only where there is something to rank. */}
          {data.leaders.top.length > 0 ? (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <SectionCard title={`Top ${data.leaders.level}s`} subtitle="By achievement against target" icon={Trophy}>
                <LeaderList nodes={data.leaders.top} tone="top" emptyLabel="Nothing measurable yet." />
              </SectionCard>
              <SectionCard title="Needs attention" subtitle="Lowest achievement against a real target" icon={TrendingDown}>
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
            <SectionCard title="Sales vs Target trend" subtitle="From July 2026, when the dashboard starts" icon={TrendingUp}>
              <div className="h-72 w-full p-3">
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
                    <Tooltip content={<ChartTooltipContent />} cursor={{ fill: "rgba(148,163,184,0.12)" }} />
                    <Bar dataKey="actualValue" fill={ACTUAL_COLOR} name="Sales" maxBarSize={56}>
                      {trendData.map((point) => (
                        <Cell key={point.period} fill={ACTUAL_COLOR} />
                      ))}
                    </Bar>
                    <Line dataKey="targetValue" stroke={TARGET_COLOR} strokeWidth={2.5} dot={{ r: 3 }} name="Target" type="monotone" />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </SectionCard>
          ) : null}

          {/* Breakdown */}
          <SectionCard
            title="Performance breakdown"
            subtitle={canDrill ? "Select an area to open its bricks" : undefined}
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
            {(data.areaUnattributedValue !== 0 || data.unplacedValue !== 0) &&
            level !== "teams" &&
            level !== "regions" &&
            level !== "products" ? (
              <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
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
            <SectionCard
              title="Areas missing a target"
              subtitle={`${data.uncovered.length} areas · ${formatEgpFull(missingTargetValue)} unmeasured`}
              icon={AlertTriangle}
            >
              <div className="hidden max-h-80 overflow-auto md:block">
                <table className="w-full text-left text-sm">
                  <thead className="sticky top-0 z-10">
                    <tr className="bg-slate-900 text-[10px] uppercase tracking-[0.14em] text-slate-300">
                      <th className="whitespace-nowrap px-4 py-2.5 font-black">Team</th>
                      <th className="whitespace-nowrap px-4 py-2.5 font-black">Region</th>
                      <th className="whitespace-nowrap px-4 py-2.5 font-black">Area</th>
                      <th className="whitespace-nowrap px-4 py-2.5 text-right font-black">Unmeasured sales</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.uncovered.map((entry, index) => (
                      <tr key={entry.key} className={cn("border-b border-border/60 last:border-0", index % 2 === 1 ? "bg-muted/20" : undefined)}>
                        <td className="whitespace-nowrap px-4 py-2 font-bold">{entry.teamName}</td>
                        <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">{entry.regionName}</td>
                        <td className="whitespace-nowrap px-4 py-2">{entry.areaName}</td>
                        <td className="whitespace-nowrap px-4 py-2 text-right font-black tabular-nums text-amber-600">
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

export type { VsTargetDashboardData, VsTargetTotals };
