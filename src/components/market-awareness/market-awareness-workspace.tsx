"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  CalendarRange,
  ChartColumnBig,
  CheckCircle2,
  CircleDashed,
  ClipboardList,
  MapPin,
  Plus,
  RefreshCcw,
  Send,
  Sparkles,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
  UserRound,
  X,
} from "lucide-react";

import { Conversation } from "@/components/market-awareness/market-awareness-conversation";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";
import { phxSelectClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

/**
 * Market Awareness — one page, two tabs, exactly as the owner described it.
 *
 * ── THE RULES THIS FILE IS BOUND BY ──────────────────────────────────────────
 *
 *  · NEVER A HORIZONTAL SCROLL, at desktop OR 375px. Every table is `w-full table-fixed` with a
 *    colgroup; mobile gets cards instead. `overflow-x-auto` over a min-width floor IS the bug, not
 *    the fix, so it appears nowhere here. Long values WRAP — they are never cut with an ellipsis.
 *  · SQUARE EDGES, everywhere. Not one `rounded-*` class in this file, so it does not lean on the
 *    globals.css sweep — which cannot reach a hand-written border-radius or a scrollbar pseudo
 *    element anyway. The chart's bars are plain rects with no rx.
 *  · HUMAN NAMES, NEVER CODES. An area renders "Alex East", not "AB1"; a rep renders their name.
 *    A code appears only where the code IS the identity — a brick, an activity reference.
 *  · CAIRO TIME on every date.
 *
 * ── WHY THE CHART IS HAND-BUILT ──────────────────────────────────────────────
 *
 * No charting library. The one thing this page must show is "did this brick move, against what it
 * was already doing" — two series over a dozen months with the activity marked. That is a grouped
 * bar chart with a divider, and hand-drawn SVG renders it at any width with no dependency, no
 * hydration cost, and colours that come from the same tokens as the rest of the page.
 *
 * Colour is carried by LINES AND TYPE, not by filled areas: hairline gridlines, a dashed marker,
 * two bar series. The house ink rule, applied to a chart.
 */

/* ────────────────────────────────── types ────────────────────────────────── */

type Line = { id: number; lineCode: string; name: string };
type ActivityType = { id: number; code: string; name: string };
type ProductOption = { productCode: string; productName: string; lineName: string };
type AreaOption = {
  areaCode: string;
  areaName: string;
  selectable: boolean;
  unselectableReason: string | null;
  repName: string | null;
  repVacant: boolean;
  dmName: string | null;
};
type RegionOption = { regionCode: string; regionName: string; areas: AreaOption[] };
type BrickOption = { brickId: string; brickName: string };

type SeatHolder = {
  hrId: string | null;
  name: string | null;
  originalName: string | null;
  replacedOriginal: boolean;
  vacant: boolean;
};

type Activity = {
  id: string;
  activityCode: string;
  status: string;
  requesterName: string | null;
  managerName: string | null;
  activityType: { name: string };
  title: string | null;
  venue: string | null;
  city: string | null;
  startDate: string;
  endDate: string | null;
  primaryLine: Line;
  lines: Line[];
  regionName: string | null;
  areaName: string | null;
  areaCode: string;
  products: Array<{ productCode: string; productName: string | null }>;
  bricks: Array<{ brickId: string; isPrimary: boolean }>;
  currency: string;
  estimatedCost: number;
  approvedCost: number | null;
  actualCost: number | null;
  durationMonths: number;
  baselineMonths: number;
  expectedUpliftPct: number | null;
  financePaid: boolean;
  rep: SeatHolder;
  districtManagers: SeatHolder[];
  outcomeNote: string | null;
  decisions: Array<{
    id: number;
    stepCode: string;
    actorName: string | null;
    action: string;
    comment: string | null;
    createdAt: string;
  }>;
};

type TrackingPoint = { period: string; totalValue: number; units: number | null };
type Tracking = {
  baselinePeriods: string[];
  windowPeriods: string[];
  lastClosedPeriod: string | null;
  windowIncompleteReason: string | null;
  series: Array<{ line: Line; brick: TrackingPoint[]; area: TrackingPoint[] }>;
  reconciliation: Array<{ period: string; reconciled: boolean; difference: number }>;
};

/* ───────────────────────── labels and formatting ───────────────────────── */

/**
 * Every status in plain words. "Held" rather than "executed", "With the CEO" rather than
 * "pending_ceo" — the owner reads these, not the state machine.
 */
const STATUS: Record<string, { label: string; tone: "neutral" | "live" | "good" | "warn" | "bad" }> = {
  draft: { label: "Draft", tone: "neutral" },
  // Named for the people, not the step code. The requester's question is "who has it", and under the
  // parallel group the answer is two or three people at once.
  pending_group: { label: "With marketing and sales", tone: "live" },
  on_hold: { label: "On hold", tone: "warn" },
  pending_ceo: { label: "With the CEO", tone: "live" },
  returned: { label: "Returned for changes", tone: "warn" },
  rejected: { label: "Rejected", tone: "bad" },
  approved: { label: "Approved", tone: "good" },
  executed: { label: "Held", tone: "good" },
  closed: { label: "Closed", tone: "neutral" },
  withdrawn: { label: "Withdrawn", tone: "neutral" },
};

const TONE_CLASS: Record<string, string> = {
  neutral: "border-phx-line bg-phx-paper-2 text-phx-ink-soft",
  live: "border-phx-accent-line bg-phx-accent-soft text-phx-accent-press",
  good: "border-phx-ok-line bg-phx-ok-bg text-phx-ok",
  warn: "border-phx-warn-line bg-phx-warn-bg text-phx-warn",
  bad: "border-phx-danger-line bg-phx-danger-bg text-phx-danger",
};

function money(amount: number | null | undefined, currency = "EGP"): string {
  if (amount === null || amount === undefined) return "Not set";
  return `${new Intl.NumberFormat("en-EG", { maximumFractionDigits: 0 }).format(amount)} ${currency}`;
}

/** Compact form for chart labels, where the full number would not fit above a bar. */
function compactMoney(amount: number): string {
  const abs = Math.abs(amount);
  if (abs >= 1_000_000) return `${(amount / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${(amount / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}K`;
  return String(Math.round(amount));
}

function cairoDate(value: string | null | undefined): string {
  if (!value) return "Not set";
  const raw = String(value);
  const parsed = new Date(raw.length <= 10 ? `${raw}T12:00:00Z` : raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  return stableEnGbFormatter({
    day: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(parsed);
}

function monthLabel(period: string): string {
  const [year, month] = period.split("-");
  const parsed = new Date(Number(year), Number(month) - 1, 1);
  if (Number.isNaN(parsed.getTime())) return period;
  return stableEnGbFormatter({ month: "short" }).format(parsed);
}

function monthYearLabel(period: string): string {
  const [year, month] = period.split("-");
  const parsed = new Date(Number(year), Number(month) - 1, 1);
  if (Number.isNaN(parsed.getTime())) return period;
  return stableEnGbFormatter({ month: "short", year: "numeric" }).format(parsed);
}

function activityName(activity: Activity): string {
  return activity.title?.trim() || activity.activityType.name;
}

/* ─────────────────────────────── primitives ─────────────────────────────── */

/** The uppercase hairline label that sits above every value on the page. */
function MicroLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="block text-phx-3xs font-bold uppercase tracking-[0.14em] text-phx-ink-faint">
      {children}
    </span>
  );
}

function StatusChip({ status }: { status: string }) {
  const entry = STATUS[status] ?? { label: status, tone: "neutral" as const };
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 border px-2 py-1 text-phx-3xs font-black uppercase tracking-[0.10em] ${TONE_CLASS[entry.tone]}`}
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 bg-current" />
      {entry.label}
    </span>
  );
}

/**
 * A panel. The 2px accent rail down the left is the only decoration on the page — it is what makes
 * a stack of sections read as one document rather than as a pile of boxes.
 */
function Panel({
  children,
  title,
  kicker,
  action,
}: {
  children: React.ReactNode;
  title: string;
  kicker?: string;
  action?: React.ReactNode;
}) {
  return (
    <section className="relative min-w-0 border border-phx-line bg-phx-paper">
      <span aria-hidden="true" className="absolute left-0 top-0 h-full w-[2px] bg-phx-accent" />
      <header className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b border-phx-line px-4 py-3 pl-5 sm:px-5 sm:pl-6">
        <div className="min-w-0">
          {kicker ? <MicroLabel>{kicker}</MicroLabel> : null}
          <h2 className="break-words text-phx-sm font-black uppercase tracking-[0.08em] text-phx-ink">
            {title}
          </h2>
        </div>
        {action}
      </header>
      <div className="min-w-0 p-4 pl-5 sm:p-5 sm:pl-6">{children}</div>
    </section>
  );
}

/** One headline figure. Square, hairline, no shadow — this page is paper, not plastic. */
function StatTile({
  label,
  value,
  hint,
  icon: Icon,
  tone = "neutral",
}: {
  label: string;
  value: string;
  hint?: string;
  icon: typeof Sparkles;
  tone?: "neutral" | "accent";
}) {
  return (
    <div className="min-w-0 border border-phx-line bg-phx-paper p-3 sm:p-4">
      <div className="flex min-w-0 items-center gap-2">
        <Icon
          className={`h-3.5 w-3.5 shrink-0 ${tone === "accent" ? "text-phx-accent" : "text-phx-ink-faint"}`}
        />
        <MicroLabel>{label}</MicroLabel>
      </div>
      <p className="mt-2 break-words text-phx-xl font-black leading-none text-phx-ink">{value}</p>
      {hint ? (
        <p className="mt-1.5 break-words text-phx-3xs font-medium text-phx-ink-faint">{hint}</p>
      ) : null}
    </div>
  );
}

function EmptyState({
  title,
  body,
  icon: Icon,
}: {
  title: string;
  body: string;
  icon: typeof Sparkles;
}) {
  return (
    <div className="flex min-w-0 flex-col items-center gap-2 border border-dashed border-phx-line bg-phx-paper-2 px-4 py-10 text-center">
      <Icon className="h-6 w-6 shrink-0 text-phx-ink-faint" />
      <p className="break-words text-phx-sm font-black text-phx-ink">{title}</p>
      <p className="max-w-md break-words text-phx-xs font-medium text-phx-ink-soft">{body}</p>
    </div>
  );
}

/** Square skeletons — a loading state that keeps the page's shape instead of collapsing it. */
function SkeletonRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {Array.from({ length: rows }).map((_, index) => (
        <div className="h-12 w-full animate-pulse border border-phx-line bg-phx-paper-2" key={index} />
      ))}
    </div>
  );
}

function Notice({ tone, children }: { tone: "info" | "warn" | "good"; children: React.ReactNode }) {
  const cls =
    tone === "warn"
      ? "border-phx-warn-line bg-phx-warn-bg text-phx-warn"
      : tone === "good"
        ? "border-phx-ok-line bg-phx-ok-bg text-phx-ok"
        : "border-phx-info-line bg-phx-info-bg text-phx-info";
  return (
    <div className={`flex min-w-0 items-start gap-2 border px-3 py-2.5 ${cls}`}>
      <TriangleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <p className="min-w-0 break-words text-phx-xs font-bold">{children}</p>
    </div>
  );
}

const INPUT = cn(phxSelectClassName, "w-full px-3 text-phx-sm disabled:text-phx-ink-faint");
const BTN_PRIMARY =
  "inline-flex items-center justify-center gap-2 border border-phx-accent bg-phx-accent px-4 py-2.5 text-phx-xs font-black uppercase tracking-[0.10em] text-phx-accent-ink transition hover:bg-phx-accent-hover disabled:cursor-not-allowed disabled:opacity-60";
const BTN_QUIET =
  "inline-flex items-center justify-center gap-2 border border-phx-line bg-phx-paper px-3 py-2 text-phx-2xs font-black uppercase tracking-[0.10em] text-phx-ink-soft transition hover:border-phx-line-strong hover:text-phx-ink";

function Field({
  children,
  label,
  hint,
  required,
}: {
  children: React.ReactNode;
  label: string;
  hint?: string;
  required?: boolean;
}) {
  return (
    <label className="block min-w-0">
      <span className="mb-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <MicroLabel>{label}</MicroLabel>
        {required ? (
          <span className="text-phx-3xs font-black uppercase tracking-[0.10em] text-phx-accent">
            Required
          </span>
        ) : null}
      </span>
      {children}
      {hint ? (
        <span className="mt-1.5 block break-words text-phx-3xs font-medium text-phx-ink-faint">
          {hint}
        </span>
      ) : null}
    </label>
  );
}

/* ─────────────────────────────── the chart ─────────────────────────────── */

/**
 * Brick against area, month by month, with the baseline and the measurement window separated.
 *
 * ONE SHARED SCALE, deliberately. The area is always the larger number, and drawing each series to
 * its own maximum would make a brick that sold nothing look identical to one that carried the whole
 * area. The bars mean what they look like.
 */
function TrackingChart({
  areaValues,
  baselineCount,
  brickValues,
  periods,
}: {
  areaValues: number[];
  baselineCount: number;
  brickValues: number[];
  periods: string[];
}) {
  const width = 720;
  const height = 244;
  const padLeft = 8;
  const padRight = 8;
  const padTop = 26;
  const padBottom = 34;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const max = Math.max(1, ...areaValues, ...brickValues);
  const slot = plotW / Math.max(1, periods.length);
  const gap = Math.min(6, slot * 0.08);
  const barW = Math.max(3, (slot - gap * 3) / 2);
  const y = (value: number) => padTop + plotH - (value / max) * plotH;

  return (
    <figure className="m-0 min-w-0">
      <svg
        className="block h-auto w-full"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        viewBox={`0 0 ${width} ${height}`}
      >
        <title>
          Brick and area sales by month, with the baseline before the activity and the measurement
          window after it
        </title>

        {/* Hairline grid. Rules, never filled bands — colour is carried by lines. */}
        {[0, 0.25, 0.5, 0.75, 1].map((step) => (
          <line
            key={step}
            stroke="var(--phx-line)"
            strokeWidth={1}
            x1={padLeft}
            x2={width - padRight}
            y1={padTop + plotH * step}
            y2={padTop + plotH * step}
          />
        ))}

        {/* The divider: everything to its left happened before the activity. */}
        {baselineCount > 0 && baselineCount < periods.length ? (
          <g>
            <line
              stroke="var(--phx-accent)"
              strokeDasharray="3 3"
              strokeWidth={1.5}
              x1={padLeft + slot * baselineCount}
              x2={padLeft + slot * baselineCount}
              y1={padTop - 12}
              y2={padTop + plotH}
            />
            <text
              fill="var(--phx-accent)"
              fontSize={8.5}
              fontWeight={800}
              letterSpacing="1.4"
              textAnchor="middle"
              x={padLeft + slot * baselineCount}
              y={padTop - 16}
            >
              ACTIVITY
            </text>
          </g>
        ) : null}

        {periods.map((period, index) => {
          const x0 = padLeft + slot * index;
          const areaX = x0 + gap;
          const brickX = areaX + barW + gap;
          const areaV = areaValues[index] ?? 0;
          const brickV = brickValues[index] ?? 0;
          const inWindow = index >= baselineCount;
          return (
            <g key={period}>
              {/* Area: the context. Muted, so the brick reads as the subject. */}
              <rect
                fill="var(--phx-line-strong)"
                height={Math.max(0, padTop + plotH - y(areaV))}
                opacity={inWindow ? 0.55 : 0.3}
                width={barW}
                x={areaX}
                y={y(areaV)}
              />
              {/* Brick: the subject. Accent inside the window, faint ink outside it. */}
              <rect
                fill={inWindow ? "var(--phx-accent)" : "var(--phx-ink-faint)"}
                height={Math.max(0, padTop + plotH - y(brickV))}
                width={barW}
                x={brickX}
                y={y(brickV)}
              />
              {brickV > 0 ? (
                <text
                  fill={inWindow ? "var(--phx-accent-press)" : "var(--phx-ink-faint)"}
                  fontSize={8}
                  fontWeight={800}
                  textAnchor="middle"
                  x={brickX + barW / 2}
                  y={Math.max(padTop - 2, y(brickV) - 4)}
                >
                  {compactMoney(brickV)}
                </text>
              ) : null}
              <text
                fill="var(--phx-ink-soft)"
                fontSize={9}
                fontWeight={700}
                textAnchor="middle"
                x={x0 + slot / 2}
                y={height - 18}
              >
                {monthLabel(period)}
              </text>
              <text
                fill="var(--phx-ink-faint)"
                fontSize={7}
                fontWeight={600}
                textAnchor="middle"
                x={x0 + slot / 2}
                y={height - 6}
              >
                {period.slice(0, 4)}
              </text>
            </g>
          );
        })}
      </svg>

      <figcaption className="mt-3 flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2">
        {[
          { fill: "var(--phx-accent)", label: "Brick, in the window" },
          { fill: "var(--phx-ink-faint)", label: "Brick, baseline" },
          { fill: "var(--phx-line-strong)", label: "Whole area" },
        ].map((entry) => (
          <span className="inline-flex min-w-0 items-center gap-2" key={entry.label}>
            <span
              aria-hidden="true"
              className="h-2.5 w-2.5 shrink-0"
              style={{ backgroundColor: entry.fill }}
            />
            <span className="break-words text-phx-3xs font-bold uppercase tracking-[0.10em] text-phx-ink-soft">
              {entry.label}
            </span>
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

/** Before → after, with the movement stated rather than left to be worked out. */
function DeltaBlock({ after, before, label }: { after: number; before: number; label: string }) {
  const hasBaseline = before > 0;
  const pct = hasBaseline ? ((after - before) / before) * 100 : 0;
  const up = pct >= 0;
  const Icon = up ? TrendingUp : TrendingDown;

  return (
    <div className="min-w-0 border border-phx-line bg-phx-paper p-4">
      <MicroLabel>{label}</MicroLabel>
      <div className="mt-3 flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="break-words text-phx-md font-bold text-phx-ink-faint">{money(before)}</span>
        <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-phx-ink-faint" />
        <span className="break-words text-phx-xl font-black leading-none text-phx-ink">
          {money(after)}
        </span>
      </div>
      <p className="mt-2.5 inline-flex min-w-0 items-center gap-1.5">
        <Icon
          aria-hidden="true"
          className={`h-3.5 w-3.5 shrink-0 ${up ? "text-phx-ok" : "text-phx-danger"}`}
        />
        <span className={`break-words text-phx-sm font-black ${up ? "text-phx-ok" : "text-phx-danger"}`}>
          {hasBaseline ? `${up ? "+" : ""}${pct.toFixed(1)}%` : "No baseline to compare"}
        </span>
      </p>
    </div>
  );
}

/* ─────────────────────────────── workspace ─────────────────────────────── */

export function MarketAwarenessWorkspace({ canCreate, seesAll = false }: { canCreate: boolean; seesAll?: boolean }) {
  const [tab, setTab] = useState<"request" | "tracking">("request");
  // `null` means "not loaded yet", so loading is DERIVED. An effect that calls a loader which sets
  // state before its first `await` is still a synchronous setState, and that is a lint ERROR here.
  const [activities, setActivities] = useState<Activity[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tracking, setTracking] = useState<Tracking | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const loading = activities === null;
  const rows = useMemo(() => activities ?? [], [activities]);

  const [busyId, setBusyId] = useState<string | null>(null);

  const loadActivities = useCallback(async () => {
    try {
      const response = await fetch("/api/market-awareness", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || payload.success === false) {
        throw new Error(payload.message ?? "Could not load awareness activities.");
      }
      setActivities(payload.activities ?? []);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load awareness activities.");
      setActivities([]);
    }
  }, []);

  useEffect(() => {
    // Through an async wrapper: every setState in loadActivities already sits after `await fetch`,
    // but the lint rule is static and cannot see through the callback.
    void (async () => {
      await loadActivities();
    })();
  }, [loadActivities]);

  const selected = useMemo(
    () => rows.find((activity) => activity.id === selectedId) ?? null,
    [rows, selectedId],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (tab !== "tracking" || !selectedId) {
        if (!cancelled) setTracking(null);
        return;
      }
      try {
        const response = await fetch(`/api/market-awareness/${selectedId}/tracking`, {
          cache: "no-store",
        });
        const payload = await response.json();
        if (cancelled) return;
        if (!response.ok || payload.success === false) {
          throw new Error(payload.message ?? "Could not load the tracking.");
        }
        setTracking(payload.tracking);
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "Could not load the tracking.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId, tab]);

  /**
   * Submit a draft. Without this the module is a drawer: an activity could be created and never
   * reach anybody, which is exactly how it shipped the first time.
   */
  const submitActivity = useCallback(
    async (activityId: string) => {
      setBusyId(activityId);
      setError(null);
      try {
        const response = await fetch(`/api/market-awareness/${activityId}/submit`, {
          method: "POST",
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.success) {
          throw new Error(
            payload?.message ?? `Could not submit that activity (HTTP ${response.status}).`,
          );
        }
        await loadActivities();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not submit that activity.");
      } finally {
        setBusyId(null);
      }
    },
    [loadActivities],
  );

  const stats = useMemo(() => {
    // A held one is still live. It has not been answered, and dropping it out of the count is how a
    // frozen request comes to be forgotten by the person who raised it.
    const live = rows.filter((a) =>
      ["pending_group", "on_hold", "pending_ceo"].includes(a.status),
    );
    const settled = rows.filter((a) => ["approved", "executed", "closed"].includes(a.status));
    const approvedValue = settled.reduce((sum, a) => sum + (a.approvedCost ?? a.estimatedCost), 0);
    return { approvedValue, live: live.length, total: rows.length, tracked: settled.length };
  }, [rows]);

  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      {/* The figures first. Four tiles, wrapping to two columns on a tablet and one on a phone. */}
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          hint="Everything raised so far"
          icon={ClipboardList}
          label="Activities"
          value={loading ? "—" : String(stats.total)}
        />
        <StatTile
          hint="Sitting with a manager or the CEO"
          icon={CircleDashed}
          label="Awaiting a decision"
          tone="accent"
          value={loading ? "—" : String(stats.live)}
        />
        <StatTile
          hint="Approved, held or closed"
          icon={CheckCircle2}
          label="Approved value"
          value={loading ? "—" : money(stats.approvedValue)}
        />
        <StatTile
          hint="Have sales to follow"
          icon={ChartColumnBig}
          label="Being tracked"
          value={loading ? "—" : String(stats.tracked)}
        />
      </div>

      {/* Tabs as an underline rail. A pill row would need round corners. */}
      <nav aria-label="Market Awareness sections" className="flex min-w-0 border-b border-phx-line">
        {(
          [
            { icon: ClipboardList, key: "request" as const, label: "Request" },
            { icon: ChartColumnBig, key: "tracking" as const, label: "Tracking" },
          ]
        ).map((entry) => {
          const Icon = entry.icon;
          const active = tab === entry.key;
          return (
            <button
              aria-current={active ? "page" : undefined}
              className={`-mb-px inline-flex min-w-0 items-center justify-center gap-2 border-b-2 px-4 py-3 text-phx-xs font-black uppercase tracking-[0.10em] transition sm:px-6 ${
                active
                  ? "border-phx-accent text-phx-accent-press"
                  : "border-transparent text-phx-ink-faint hover:text-phx-ink"
              }`}
              key={entry.key}
              onClick={() => setTab(entry.key)}
              type="button"
            >
              <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              <span>{entry.label}</span>
            </button>
          );
        })}
      </nav>

      {error ? <Notice tone="warn">{error}</Notice> : null}

      {tab === "request" ? (
        <RequestTab
          activities={rows}
          busyId={busyId}
          canCreate={canCreate}
          seesAll={seesAll}
          loading={loading}
          onSubmitActivity={(id) => void submitActivity(id)}
          onCreated={() => {
            setShowForm(false);
            void loadActivities();
          }}
          onRefresh={() => void loadActivities()}
          onTrack={(id) => {
            setSelectedId(id);
            setTab("tracking");
          }}
          setShowForm={setShowForm}
          showForm={showForm}
        />
      ) : (
        <TrackingTab
          activities={rows}
          onSelect={setSelectedId}
          selected={selected}
          tracking={tracking}
        />
      )}
    </div>
  );
}

/* ────────────────────────────── request tab ────────────────────────────── */

function RequestTab({
  activities,
  busyId,
  canCreate,
  loading,
  onCreated,
  onRefresh,
  onSubmitActivity,
  onTrack,
  seesAll,
  setShowForm,
  showForm,
}: {
  activities: Activity[];
  busyId: string | null;
  canCreate: boolean;
  loading: boolean;
  onCreated: () => void;
  onRefresh: () => void;
  onSubmitActivity: (id: string) => void;
  onTrack: (id: string) => void;
  /** A see-every-activity role (scope.ts) reads everyone's activities here, not only its own. */
  seesAll: boolean;
  setShowForm: (value: boolean) => void;
  showForm: boolean;
}) {
  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      {canCreate && !showForm ? (
        <button className={BTN_PRIMARY} onClick={() => setShowForm(true)} type="button">
          <Plus aria-hidden="true" className="h-4 w-4 shrink-0" />
          <span>Raise an awareness activity</span>
        </button>
      ) : null}

      {canCreate && showForm ? (
        <ActivityForm onCancel={() => setShowForm(false)} onCreated={onCreated} />
      ) : null}

      <Panel
        action={
          <button className={BTN_QUIET} onClick={onRefresh} type="button">
            <RefreshCcw aria-hidden="true" className="h-3 w-3 shrink-0" />
            <span>Refresh</span>
          </button>
        }
        kicker={activities.length === 1 ? "1 in total" : `${activities.length} in total`}
        title={seesAll ? "All activities" : "Your activities"}
      >
        {loading ? (
          <SkeletonRows />
        ) : activities.length === 0 ? (
          <EmptyState
            body="Raise one and it goes to the marketing manager and the national sales manager of each line you target, all at the same time. Once every one of them has approved, it goes to the CEO. Once the CEO approves, every district manager in that region, the national sales manager, the SFE manager, the area's rep and Finance are told."
            icon={Sparkles}
            title="No awareness activities yet"
          />
        ) : (
          <>
            {/* Desktop: fixed table with a colgroup. Never a min-width floor in a scroll box. */}
            <table className="hidden w-full table-fixed border-collapse lg:table">
              <colgroup>
                <col style={{ width: "27%" }} />
                <col style={{ width: "13%" }} />
                <col style={{ width: "20%" }} />
                <col style={{ width: "13%" }} />
                <col style={{ width: "14%" }} />
                <col style={{ width: "13%" }} />
              </colgroup>
              <thead>
                <tr className="border-b border-phx-line-strong">
                  {["Activity", "Line", "Where", "Starts", "Value", "Status"].map((heading) => (
                    <th
                      className="px-2 py-2.5 text-left text-phx-3xs font-bold uppercase tracking-[0.12em] text-phx-ink-faint"
                      key={heading}
                      scope="col"
                    >
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {activities.map((activity) => (
                  <tr
                    className="cursor-pointer border-b border-phx-line align-top transition hover:bg-phx-accent-soft"
                    key={activity.id}
                    onClick={() => onTrack(activity.id)}
                  >
                    <td className="break-words px-2 py-3">
                      <span className="block break-words text-phx-sm font-black text-phx-ink">
                        {activityName(activity)}
                      </span>
                      <span className="mt-0.5 block break-words text-phx-3xs font-medium text-phx-ink-faint">
                        {activity.activityCode}
                      </span>
                    </td>
                    <td className="break-words px-2 py-3 text-phx-xs font-bold text-phx-ink-soft">
                      {activity.primaryLine.name}
                    </td>
                    <td className="break-words px-2 py-3">
                      <span className="block break-words text-phx-xs font-bold text-phx-ink-soft">
                        {activity.areaName ?? activity.areaCode}
                      </span>
                      <span className="mt-0.5 block break-words text-phx-3xs font-medium text-phx-ink-faint">
                        {activity.regionName ?? ""}
                      </span>
                    </td>
                    <td className="break-words px-2 py-3 text-phx-xs font-bold text-phx-ink-soft">
                      {cairoDate(activity.startDate)}
                    </td>
                    <td className="break-words px-2 py-3 text-phx-xs font-black text-phx-ink">
                      {money(activity.approvedCost ?? activity.estimatedCost, activity.currency)}
                    </td>
                    <td className="px-2 py-3">
                      <StatusChip status={activity.status} />
                      {["draft", "returned"].includes(activity.status) ? (
                        <button
                          className="mt-1.5 inline-flex items-center gap-1.5 border border-phx-accent bg-phx-accent px-2 py-1 text-phx-3xs font-black uppercase tracking-[0.10em] text-phx-accent-ink transition hover:bg-phx-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
                          disabled={busyId === activity.id}
                          onClick={(event) => {
                            event.stopPropagation();
                            onSubmitActivity(activity.id);
                          }}
                          type="button"
                        >
                          <Send aria-hidden="true" className="h-3 w-3 shrink-0" />
                          <span>{busyId === activity.id ? "Sending" : "Submit"}</span>
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Tablet and phone: cards. The admin shell never shows a full table on a phone. */}
            <ul className="flex min-w-0 flex-col gap-2.5 lg:hidden">
              {activities.map((activity) => (
                <li className="min-w-0" key={activity.id}>
                  <button
                    className="flex w-full min-w-0 flex-col gap-2 border border-phx-line bg-phx-paper p-3.5 text-left transition hover:border-phx-accent-line"
                    onClick={() => onTrack(activity.id)}
                    type="button"
                  >
                    <span className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                      <span className="min-w-0 break-words text-phx-sm font-black text-phx-ink">
                        {activityName(activity)}
                      </span>
                      <StatusChip status={activity.status} />
                    </span>
                    <span className="block break-words text-phx-3xs font-medium text-phx-ink-faint">
                      {activity.activityCode}
                    </span>
                    {["draft", "returned"].includes(activity.status) ? (
                      <span
                        className="inline-flex w-fit items-center gap-1.5 border border-phx-accent bg-phx-accent px-2.5 py-1.5 text-phx-3xs font-black uppercase tracking-[0.10em] text-phx-accent-ink"
                        onClick={(event) => {
                          event.stopPropagation();
                          onSubmitActivity(activity.id);
                        }}
                        role="button"
                        tabIndex={-1}
                      >
                        <Send aria-hidden="true" className="h-3 w-3 shrink-0" />
                        <span>{busyId === activity.id ? "Sending" : "Submit for approval"}</span>
                      </span>
                    ) : null}
                    <span className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-phx-line pt-2">
                      <span className="inline-flex min-w-0 items-center gap-1.5 text-phx-2xs font-bold text-phx-ink-soft">
                        <MapPin aria-hidden="true" className="h-3 w-3 shrink-0 text-phx-ink-faint" />
                        <span className="break-words">
                          {activity.areaName ?? activity.areaCode} · {activity.primaryLine.name}
                        </span>
                      </span>
                      <span className="inline-flex min-w-0 items-center gap-1.5 text-phx-2xs font-bold text-phx-ink-soft">
                        <CalendarRange
                          aria-hidden="true"
                          className="h-3 w-3 shrink-0 text-phx-ink-faint"
                        />
                        <span className="break-words">{cairoDate(activity.startDate)}</span>
                      </span>
                      <span className="break-words text-phx-2xs font-black text-phx-ink">
                        {money(activity.approvedCost ?? activity.estimatedCost, activity.currency)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </Panel>
    </div>
  );
}

/* ────────────────────────────── tracking tab ────────────────────────────── */

function TrackingTab({
  activities,
  onSelect,
  selected,
  tracking,
}: {
  activities: Activity[];
  onSelect: (id: string) => void;
  selected: Activity | null;
  tracking: Tracking | null;
}) {
  const trackable = activities.filter((a) => ["approved", "executed", "closed"].includes(a.status));
  const choices = trackable.length > 0 ? trackable : activities;

  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      <Panel kicker="Pick what to measure" title="Activity">
        {choices.length === 0 ? (
          <EmptyState
            body="Once an activity is approved, its brick and its area are followed here for the months you set, against the months before it."
            icon={ChartColumnBig}
            title="Nothing to track yet"
          />
        ) : (
          <Field
            hint="Sales come from the published Monthly Closing — both halves of it, distributor invoices and direct orders."
            label="Which activity"
          >
            <select
              className={INPUT}
              onChange={(event) => onSelect(event.target.value)}
              value={selected?.id ?? ""}
            >
              <option value="">Pick an activity</option>
              {choices.map((activity) => (
                <option key={activity.id} value={activity.id}>
                  {`${activityName(activity)} — ${activity.areaName ?? activity.areaCode} — ${cairoDate(activity.startDate)}`}
                </option>
              ))}
            </select>
          </Field>
        )}
      </Panel>

      {selected ? <ActivitySummary activity={selected} /> : null}

      {selected && !tracking ? (
        <Panel kicker="Reading the closing" title="Sales">
          <SkeletonRows rows={2} />
        </Panel>
      ) : null}

      {tracking ? (
        <>
          {tracking.windowIncompleteReason ? (
            <Notice tone="info">{tracking.windowIncompleteReason}</Notice>
          ) : null}

          {tracking.series.map((series) => {
            const all = [...tracking.baselinePeriods, ...tracking.windowPeriods];
            const cut = tracking.baselinePeriods.length;
            const sum = (points: TrackingPoint[], from: number, to: number) =>
              points.slice(from, to).reduce((total, point) => total + point.totalValue, 0);
            return (
              <Panel
                key={series.line.id}
                kicker={`${tracking.baselinePeriods.length} months before · ${tracking.windowPeriods.length} after`}
                title={series.line.name}
              >
                <div className="flex min-w-0 flex-col gap-5">
                  <div className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2">
                    <DeltaBlock
                      after={sum(series.brick, cut, all.length)}
                      before={sum(series.brick, 0, cut)}
                      label="The brick"
                    />
                    <DeltaBlock
                      after={sum(series.area, cut, all.length)}
                      before={sum(series.area, 0, cut)}
                      label="The whole area"
                    />
                  </div>

                  <TrackingChart
                    areaValues={series.area.map((point) => point.totalValue)}
                    baselineCount={cut}
                    brickValues={series.brick.map((point) => point.totalValue)}
                    periods={all}
                  />

                  <table className="w-full table-fixed border-collapse">
                    <colgroup>
                      <col style={{ width: "34%" }} />
                      <col style={{ width: "33%" }} />
                      <col style={{ width: "33%" }} />
                    </colgroup>
                    <thead>
                      <tr className="border-b border-phx-line-strong">
                        {["Month", "Brick", "Area"].map((heading) => (
                          <th
                            className="px-2 py-2 text-left text-phx-3xs font-bold uppercase tracking-[0.12em] text-phx-ink-faint"
                            key={heading}
                            scope="col"
                          >
                            {heading}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {all.map((period, index) => {
                        const inWindow = index >= cut;
                        return (
                          <tr
                            className={`border-b border-phx-line ${inWindow ? "bg-phx-accent-soft" : ""}`}
                            key={period}
                          >
                            <td className="break-words px-2 py-2">
                              <span className="block break-words text-phx-xs font-bold text-phx-ink">
                                {monthYearLabel(period)}
                              </span>
                              <span className="mt-0.5 block text-phx-3xs font-medium text-phx-ink-faint">
                                {inWindow ? "In the window" : "Baseline"}
                              </span>
                            </td>
                            <td className="break-words px-2 py-2 text-phx-xs font-black text-phx-ink">
                              {money(series.brick[index]?.totalValue ?? 0)}
                            </td>
                            <td className="break-words px-2 py-2 text-phx-xs font-bold text-phx-ink-soft">
                              {money(series.area[index]?.totalValue ?? 0)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Panel>
            );
          })}

          {tracking.reconciliation.some((row) => !row.reconciled) ? (
            <Notice tone="warn">
              {`Some months do not reconcile against the published closing — the bricks of this area do not add up to the area total. Affected: ${tracking.reconciliation
                .filter((row) => !row.reconciled)
                .map((row) => monthYearLabel(row.period))
                .join(", ")}. That gap is value the source data could not place in any brick; the area figure is still the published one.`}
            </Notice>
          ) : (
            <p className="inline-flex min-w-0 items-center gap-2">
              <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-phx-ok" />
              <span className="break-words text-phx-3xs font-bold uppercase tracking-[0.10em] text-phx-ink-faint">
                Every month reconciles against the published Monthly Closing
              </span>
            </p>
          )}
        </>
      ) : null}
    </div>
  );
}

function ActivitySummary({ activity }: { activity: Activity }) {
  const facts: Array<[string, string]> = [
    ["Type", activity.activityType.name],
    ["Primary line", activity.primaryLine.name],
    ["Area", activity.areaName ?? activity.areaCode],
    ["Region", activity.regionName ?? "Not recorded"],
    ["Starts", cairoDate(activity.startDate)],
    ["Approved value", money(activity.approvedCost ?? activity.estimatedCost, activity.currency)],
    ["Window", `${activity.durationMonths} months, against ${activity.baselineMonths} before`],
    ["Requested by", activity.requesterName ?? "Not recorded"],
    ["Finance", activity.financePaid ? "Marked paid" : "Not marked paid"],
  ];

  return (
    <Panel kicker={activity.activityCode} title={activityName(activity)}>
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <StatusChip status={activity.status} />
          {activity.expectedUpliftPct !== null ? (
            <span className="border border-phx-line bg-phx-paper-2 px-2 py-1 text-phx-3xs font-black uppercase tracking-[0.10em] text-phx-ink-soft">
              {`Expected uplift ${activity.expectedUpliftPct}%`}
            </span>
          ) : null}
        </div>

        <dl className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {facts.map(([label, value]) => (
            <div className="min-w-0 border border-phx-line bg-phx-paper-2 px-3 py-2.5" key={label}>
              <dt>
                <MicroLabel>{label}</MicroLabel>
              </dt>
              <dd className="mt-1 break-words text-phx-sm font-black text-phx-ink">{value}</dd>
            </div>
          ))}
        </dl>

        <div className="min-w-0 border border-phx-line bg-phx-paper-2 px-3 py-2.5">
          <MicroLabel>Targeted products</MicroLabel>
          <p className="mt-1 break-words text-phx-xs font-bold text-phx-ink">
            {activity.products.map((p) => p.productName ?? p.productCode).join(" · ") || "None"}
          </p>
        </div>

        {/* Owner answer 33: show today's holder, and say plainly when it is not who it was. */}
        {activity.rep.replacedOriginal ? (
          <Notice tone="warn">
            {`The medical rep here is now ${activity.rep.name ?? "vacant"}. ${activity.rep.originalName ?? "The original rep"} held this area when the activity was approved and has since been replaced.`}
          </Notice>
        ) : activity.rep.vacant ? (
          <Notice tone="info">
            This area is vacant — will hire. The district managers of the region still receive the
            activity.
          </Notice>
        ) : activity.rep.name ? (
          <p className="inline-flex min-w-0 items-center gap-2">
            <UserRound aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-phx-ink-faint" />
            <span className="break-words text-phx-2xs font-bold text-phx-ink-soft">
              {`Medical rep: ${activity.rep.name}`}
            </span>
          </p>
        ) : null}

        {activity.decisions.length > 0 ? (
          <div className="min-w-0">
            <MicroLabel>Decision trail</MicroLabel>
            <ol className="mt-2 flex min-w-0 flex-col gap-2">
              {activity.decisions.map((decision) => (
                <li
                  className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 border-l-2 border-phx-line pl-3"
                  key={decision.id}
                >
                  <span className="break-words text-phx-xs font-black text-phx-ink">
                    {decision.actorName ?? "Unknown"}
                  </span>
                  <span className="text-phx-2xs font-bold uppercase tracking-[0.08em] text-phx-ink-soft">
                    {decision.action}
                  </span>
                  <span className="text-phx-3xs font-medium text-phx-ink-faint">
                    {cairoDate(decision.createdAt)}
                  </span>
                  {decision.comment ? (
                    <span className="block w-full break-words text-phx-2xs font-medium text-phx-ink-soft">
                      {decision.comment}
                    </span>
                  ) : null}
                </li>
              ))}
            </ol>
          </div>
        ) : null}

        {/*
          The thread lives here as well as in the approvals inbox, and this is the copy that matters
          most: when a manager asks a question the server emails whoever raised the activity, and the
          link in that email lands HERE. A conversation that only existed on the decider's screen
          would email someone a question with nowhere to answer it.

          A draft has no thread — nobody has been told about it yet, so there is nobody to talk to.
        */}
        {activity.status === "draft" ? null : <Conversation activityId={activity.id} />}
      </div>
    </Panel>
  );
}

/* ─────────────────────────────── the form ─────────────────────────────── */

/** A numbered band. Four short sections read as progress; one long one reads as a wall. */
function FormSection({
  children,
  step,
  title,
}: {
  children: React.ReactNode;
  step: string;
  title: string;
}) {
  return (
    <section className="min-w-0">
      <div className="mb-3 flex min-w-0 items-center gap-2.5 border-b border-phx-line pb-2">
        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center border border-phx-accent bg-phx-accent text-phx-3xs font-black text-phx-accent-ink">
          {step}
        </span>
        <h3 className="break-words text-phx-xs font-black uppercase tracking-[0.10em] text-phx-ink">
          {title}
        </h3>
      </div>
      <div className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-4 md:grid-cols-2">{children}</div>
    </section>
  );
}

/**
 * A real multi-select: a scrollable list of square checkboxes.
 *
 * NOT a native `<select multiple>`. That control needs ctrl-click to pick a second item, silently
 * clears the whole selection on a plain click, and is close to unusable on a phone — for a picker
 * where choosing several products is the NORMAL case, it is the wrong control. Checkboxes say what
 * they are, survive a mis-click, and work with a thumb.
 *
 * Scrolls VERTICALLY only. The golden rule forbids horizontal scroll; a tall list inside a fixed
 * height is the ordinary way to show many options and costs no width.
 */
function MultiSelectList<T>({
  disabled,
  emptyText,
  items,
  keyOf,
  labelOf,
  onChange,
  selected,
  subLabelOf,
}: {
  disabled?: boolean;
  emptyText: string;
  items: T[];
  keyOf: (item: T) => string;
  labelOf: (item: T) => string;
  onChange: (next: string[]) => void;
  selected: string[];
  subLabelOf?: (item: T) => string | null;
}) {
  const chosen = new Set(selected);

  const toggle = (key: string) => {
    const next = new Set(chosen);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange([...next]);
  };

  if (disabled) {
    return (
      <p className="border border-phx-line bg-phx-paper-2 px-3 py-3 text-phx-xs font-bold text-phx-ink-faint">
        {emptyText}
      </p>
    );
  }

  if (items.length === 0) {
    return (
      <p className="border border-phx-line bg-phx-paper-2 px-3 py-3 text-phx-xs font-bold text-phx-ink-faint">
        {emptyText}
      </p>
    );
  }

  return (
    <div className="min-w-0 border border-phx-line bg-phx-paper">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-phx-line bg-phx-paper-2 px-3 py-2">
        <span className="text-phx-3xs font-bold uppercase tracking-[0.10em] text-phx-ink-faint">
          {selected.length === 0
            ? `${items.length} available`
            : `${selected.length} of ${items.length} chosen`}
        </span>
        <span className="flex flex-wrap gap-2">
          <button
            className="text-phx-3xs font-black uppercase tracking-[0.10em] text-phx-accent transition hover:text-phx-accent-press"
            onClick={() => onChange(items.map(keyOf))}
            type="button"
          >
            Select all
          </button>
          <button
            className="text-phx-3xs font-black uppercase tracking-[0.10em] text-phx-ink-faint transition hover:text-phx-ink"
            onClick={() => onChange([])}
            type="button"
          >
            Clear
          </button>
        </span>
      </div>
      {/* Vertical scroll only — never horizontal. */}
      <ul className="max-h-56 min-w-0 overflow-y-auto">
        {items.map((item) => {
          const key = keyOf(item);
          const isOn = chosen.has(key);
          const sub = subLabelOf?.(item) ?? null;
          return (
            <li className="min-w-0 border-b border-phx-line last:border-b-0" key={key}>
              <label className="flex min-w-0 cursor-pointer items-start gap-2.5 px-3 py-2 transition hover:bg-phx-accent-soft">
                <input
                  checked={isOn}
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-phx-accent"
                  onChange={() => toggle(key)}
                  type="checkbox"
                />
                <span className="min-w-0">
                  <span
                    className={`block break-words text-phx-xs ${isOn ? "font-black text-phx-ink" : "font-bold text-phx-ink-soft"}`}
                  >
                    {labelOf(item)}
                  </span>
                  {sub ? (
                    <span className="mt-0.5 block break-words text-phx-3xs font-medium text-phx-ink-faint">
                      {sub}
                    </span>
                  ) : null}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ActivityForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: () => void }) {
  const [types, setTypes] = useState<ActivityType[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [regions, setRegions] = useState<RegionOption[]>([]);
  const [bricks, setBricks] = useState<BrickOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [activityTypeId, setActivityTypeId] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [venue, setVenue] = useState("");
  const [city, setCity] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [expectedAttendees, setExpectedAttendees] = useState("");
  const [speakers, setSpeakers] = useState("");
  const [primaryLineId, setPrimaryLineId] = useState<number | null>(null);
  const [extraLineIds, setExtraLineIds] = useState<number[]>([]);
  const [regionCode, setRegionCode] = useState("");
  const [areaCode, setAreaCode] = useState("");
  const [primaryBrickId, setPrimaryBrickId] = useState("");
  const [extraBrickIds, setExtraBrickIds] = useState<string[]>([]);
  const [estimatedCost, setEstimatedCost] = useState("");
  const [durationMonths, setDurationMonths] = useState("3");
  const [baselineMonths, setBaselineMonths] = useState("3");
  const [expectedUpliftPct, setExpectedUpliftPct] = useState("");

  /**
   * Products are held PER LINE, not in one flat list.
   *
   * A product belongs to exactly one line, and the tracking reports each line apart — so a flat
   * list could not say which line a chosen product belonged to, and the earlier version simply
   * stamped every product with the primary line. That made a second line's products unpickable and
   * would have mis-attributed any that were.
   */
  const [productsByLine, setProductsByLine] = useState<Record<number, ProductOption[]>>({});
  const [chosenByLine, setChosenByLine] = useState<Record<number, string[]>>({});

  useEffect(() => {
    // A FAILED OPTIONS CALL MUST SAY SO. Silently keeping the empty arrays renders as "the dropdowns
    // are empty" with nothing explaining why — a confident zero, worse than an error.
    void (async () => {
      try {
        const response = await fetch("/api/market-awareness/options", { cache: "no-store" });
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.success) {
          throw new Error(
            payload?.message ??
              `Could not load the form options (HTTP ${response.status}). The lists below stay empty until this succeeds.`,
          );
        }
        setTypes(payload.activityTypes ?? []);
        setLines(payload.lines ?? []);
        if ((payload.activityTypes ?? []).length === 0 || (payload.lines ?? []).length === 0) {
          setFormError(
            "The form loaded but the activity types or lines came back empty. That is a data problem, not a permission one — tell whoever maintains the module.",
          );
        }
      } catch (caught) {
        setFormError(caught instanceof Error ? caught.message : "Could not load the form options.");
      }
    })();
  }, []);

  const primaryLine = useMemo(
    () => lines.find((line) => line.id === primaryLineId) ?? null,
    [lines, primaryLineId],
  );

  /** Primary first, then the extras — the order the pickers render in. */
  const targetedLines = useMemo(() => {
    const ids = [primaryLineId, ...extraLineIds].filter((id): id is number => id !== null);
    const seen = new Set<number>();
    const out: Line[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const line = lines.find((entry) => entry.id === id);
      if (line) out.push(line);
    }
    return out;
  }, [extraLineIds, lines, primaryLineId]);

  // The region cascade is driven by the PRIMARY line alone: the region map is per line, so an area
  // sits in a different region depending on which line you ask.
  useEffect(() => {
    void (async () => {
      if (!primaryLine) {
        setRegions([]);
        return;
      }
      const response = await fetch(
        `/api/market-awareness/options?lineCode=${encodeURIComponent(primaryLine.lineCode)}`,
        { cache: "no-store" },
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) {
        setFormError(
          payload?.message ??
            `Could not load the regions for that line (HTTP ${response.status}).`,
        );
        return;
      }
      setRegions(payload.regions ?? []);
      setFormError(null);
    })();
  }, [primaryLine]);

  // One products fetch per targeted line, primary included. Already-loaded lines are not re-fetched.
  useEffect(() => {
    void (async () => {
      for (const line of targetedLines) {
        if (productsByLine[line.id]) continue;
        const response = await fetch(
          `/api/market-awareness/options?lineCode=${encodeURIComponent(line.lineCode)}`,
          { cache: "no-store" },
        );
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.success) {
          setFormError(
            payload?.message ??
              `Could not load the products for ${line.name} (HTTP ${response.status}).`,
          );
          continue;
        }
        setProductsByLine((current) => ({ ...current, [line.id]: payload.products ?? [] }));
      }
    })();
  }, [productsByLine, targetedLines]);

  useEffect(() => {
    void (async () => {
      if (!areaCode) {
        setBricks([]);
        return;
      }
      const response = await fetch(
        `/api/market-awareness/options?areaCode=${encodeURIComponent(areaCode)}`,
        { cache: "no-store" },
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) {
        setFormError(
          payload?.message ?? `Could not load the bricks for that area (HTTP ${response.status}).`,
        );
        return;
      }
      setBricks(payload.bricks ?? []);
    })();
  }, [areaCode]);

  const areas = useMemo(
    () => regions.find((region) => region.regionCode === regionCode)?.areas ?? [],
    [regionCode, regions],
  );
  const selectedArea = useMemo(
    () => areas.find((area) => area.areaCode === areaCode) ?? null,
    [areaCode, areas],
  );

  const totalProducts = useMemo(
    () =>
      targetedLines.reduce((sum, line) => sum + (chosenByLine[line.id]?.length ?? 0), 0),
    [chosenByLine, targetedLines],
  );

  const ready =
    activityTypeId !== null &&
    primaryLineId !== null &&
    regionCode !== "" &&
    areaCode !== "" &&
    primaryBrickId !== "" &&
    totalProducts > 0 &&
    startDate !== "" &&
    Number(estimatedCost) > 0;

  const submit = async () => {
    setSaving(true);
    setFormError(null);
    try {
      // Each product carries ITS OWN line, so a second line's products are attributed to that line
      // rather than stamped with the primary.
      const productCodes = targetedLines.flatMap((line) =>
        (chosenByLine[line.id] ?? []).map((code) => ({
          lineId: line.id,
          productCode: code,
          productName:
            (productsByLine[line.id] ?? []).find((p) => p.productCode === code)?.productName ?? null,
        })),
      );

      const response = await fetch("/api/market-awareness", {
        body: JSON.stringify({
          activityTypeId,
          areaCode,
          baselineMonths: Number(baselineMonths),
          brickIds: [...new Set([primaryBrickId, ...extraBrickIds])].filter(Boolean),
          city: city.trim() || null,
          durationMonths: Number(durationMonths),
          endDate: endDate || null,
          estimatedCost: Number(estimatedCost),
          expectedAttendees: expectedAttendees ? Number(expectedAttendees) : null,
          expectedUpliftPct: expectedUpliftPct ? Number(expectedUpliftPct) : null,
          lineIds: targetedLines.map((line) => line.id),
          primaryBrickId,
          primaryLineId,
          productCodes,
          regionCode,
          speakers: speakers.trim() || null,
          startDate,
          title: title.trim() || null,
          venue: venue.trim() || null,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) {
        throw new Error(payload?.message ?? `Could not create the activity (HTTP ${response.status}).`);
      }
      onCreated();
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : "Could not create the activity.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel
      action={
        <button className={BTN_QUIET} onClick={onCancel} type="button">
          <X aria-hidden="true" className="h-3 w-3 shrink-0" />
          <span>Close</span>
        </button>
      }
      kicker="Saved as a draft — you submit it when you are ready"
      title="New awareness activity"
    >
      <div className="flex w-full min-w-0 flex-col gap-6">
        {formError ? <Notice tone="warn">{formError}</Notice> : null}

        <FormSection step="1" title="What it is">
          <Field label="Activity type" required>
            <select
              className={INPUT}
              onChange={(event) => setActivityTypeId(Number(event.target.value) || null)}
              value={activityTypeId ?? ""}
            >
              <option value="">Pick a type</option>
              {types.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
            </select>
          </Field>
          <Field hint="Optional — but it is what makes this findable in a year." label="Title">
            <input className={INPUT} onChange={(e) => setTitle(e.target.value)} value={title} />
          </Field>
          <Field label="Start date" required>
            <input
              className={INPUT}
              onChange={(event) => setStartDate(event.target.value)}
              type="date"
              value={startDate}
            />
          </Field>
          <Field hint="Optional. A conference may run several days." label="End date">
            <input
              className={INPUT}
              onChange={(event) => setEndDate(event.target.value)}
              type="date"
              value={endDate}
            />
          </Field>
        </FormSection>

        <FormSection step="2" title="Which lines, and which products">
          <Field
            hint="Drives the region list and orders the geography. Several lines can be targeted, but only one can order it."
            label="Primary line"
            required
          >
            <select
              className={INPUT}
              onChange={(event) => {
                const next = Number(event.target.value) || null;
                setPrimaryLineId(next);
                // Changing the line invalidates everything under it: the region map is per line.
                setRegionCode("");
                setAreaCode("");
                setPrimaryBrickId("");
                setExtraBrickIds([]);
                setExtraLineIds((current) => current.filter((id) => id !== next));
              }}
              value={primaryLineId ?? ""}
            >
              <option value="">Pick the primary line</option>
              {lines.map((line) => (
                <option key={line.id} value={line.id}>
                  {line.name}
                </option>
              ))}
            </select>
          </Field>

          <Field
            hint="Each line you add gets its own product list below. Lines are reported apart, never added together."
            label="Other lines targeted"
          >
            <MultiSelectList
              disabled={!primaryLine}
              emptyText={primaryLine ? "No other lines available." : "Pick the primary line first."}
              items={lines.filter((line) => line.id !== primaryLineId)}
              keyOf={(line) => String(line.id)}
              labelOf={(line) => line.name}
              onChange={(next) => {
                const ids = next.map(Number);
                setExtraLineIds(ids);
                // Drop the products of a line that has just been removed, so a deselected line
                // cannot leave its products attached to the activity.
                setChosenByLine((current) => {
                  const keep: Record<number, string[]> = {};
                  for (const id of [primaryLineId, ...ids]) {
                    if (id !== null && current[id]) keep[id] = current[id];
                  }
                  return keep;
                });
              }}
              selected={extraLineIds.map(String)}
            />
          </Field>

          {/* One products picker per targeted line — the owner's ask: choose another line and
              another list appears, each one multi-select. */}
          <div className="flex min-w-0 flex-col gap-4 md:col-span-2">
            {targetedLines.length === 0 ? (
              <Field label="Targeted products" required>
                <MultiSelectList
                  disabled
                  emptyText="Pick the primary line first — the product list follows the line."
                  items={[]}
                  keyOf={() => ""}
                  labelOf={() => ""}
                  onChange={() => undefined}
                  selected={[]}
                />
              </Field>
            ) : (
              targetedLines.map((line) => {
                const available = productsByLine[line.id];
                const chosen = chosenByLine[line.id] ?? [];
                return (
                  <Field
                    hint={
                      line.id === primaryLineId
                        ? "The primary line. Head Office products are never offered — they carry no closing figure, so they could only show a permanent zero."
                        : "Reported apart from the primary line, never added to it."
                    }
                    key={line.id}
                    label={`${line.name} products${chosen.length > 0 ? ` · ${chosen.length} chosen` : ""}`}
                    required={line.id === primaryLineId}
                  >
                    <MultiSelectList
                      emptyText={
                        available === undefined
                          ? `Loading ${line.name} products.`
                          : `No trackable products on ${line.name}.`
                      }
                      items={available ?? []}
                      keyOf={(product) => product.productCode}
                      labelOf={(product) => product.productName}
                      onChange={(next) =>
                        setChosenByLine((current) => ({ ...current, [line.id]: next }))
                      }
                      selected={chosen}
                      subLabelOf={(product) => product.productCode}
                    />
                  </Field>
                );
              })
            )}
          </div>
        </FormSection>

        <FormSection step="3" title="Where it happens">
          <Field label="Region" required>
            <select
              className={INPUT}
              disabled={!primaryLine}
              onChange={(event) => {
                setRegionCode(event.target.value);
                setAreaCode("");
                setPrimaryBrickId("");
                setExtraBrickIds([]);
              }}
              value={regionCode}
            >
              <option value="">
                {primaryLine ? "Pick a region" : "Pick the primary line first"}
              </option>
              {regions.map((region) => (
                <option key={region.regionCode} value={region.regionCode}>
                  {region.regionName}
                </option>
              ))}
            </select>
          </Field>
          <Field
            hint={
              selectedArea
                ? selectedArea.repVacant
                  ? "Medical rep: Vacant — will hire"
                  : `Medical rep: ${selectedArea.repName ?? "Not recorded"}`
                : "Vacant areas can be chosen — they are marked in the list."
            }
            label="Area"
            required
          >
            <select
              className={INPUT}
              disabled={!regionCode}
              onChange={(event) => {
                setAreaCode(event.target.value);
                setPrimaryBrickId("");
                setExtraBrickIds([]);
              }}
              value={areaCode}
            >
              <option value="">{regionCode ? "Pick an area" : "Pick a region first"}</option>
              {areas.map((area) => (
                // Non-territory areas are SHOWN and disabled rather than hidden (owner answer 30):
                // a greyed row with a reason beats a list that silently lacks what someone expects.
                <option disabled={!area.selectable} key={area.areaCode} value={area.areaCode}>
                  {area.areaName}
                  {area.selectable
                    ? area.repVacant
                      ? " — vacant, will hire"
                      : ""
                    : " — not a territory"}
                </option>
              ))}
            </select>
          </Field>
          <Field hint="Its sales are tracked apart from the area's." label="Main brick" required>
            <select
              className={INPUT}
              disabled={!areaCode}
              onChange={(event) => setPrimaryBrickId(event.target.value)}
              value={primaryBrickId}
            >
              <option value="">{areaCode ? "Pick the main brick" : "Pick an area first"}</option>
              {bricks.map((brick) => (
                <option key={brick.brickId} value={brick.brickId}>
                  {brick.brickName}
                </option>
              ))}
            </select>
          </Field>
          <Field
            hint="Optional. Others the activity is expected to reach."
            label={`Other bricks${extraBrickIds.length > 0 ? ` · ${extraBrickIds.length} chosen` : ""}`}
          >
            <MultiSelectList
              disabled={!areaCode}
              emptyText={areaCode ? "No other bricks in this area." : "Pick an area first."}
              items={bricks.filter((brick) => brick.brickId !== primaryBrickId)}
              keyOf={(brick) => brick.brickId}
              labelOf={(brick) => brick.brickName}
              onChange={setExtraBrickIds}
              selected={extraBrickIds}
              subLabelOf={(brick) => brick.brickId}
            />
          </Field>
          <Field hint="Optional." label="Venue">
            <input className={INPUT} onChange={(e) => setVenue(e.target.value)} value={venue} />
          </Field>
          <Field hint="Optional." label="City">
            <input className={INPUT} onChange={(e) => setCity(e.target.value)} value={city} />
          </Field>
        </FormSection>

        <FormSection step="4" title="What it costs, and how it is judged">
          <Field label="Estimated cost (EGP)" required>
            <input
              className={INPUT}
              inputMode="decimal"
              onChange={(event) => setEstimatedCost(event.target.value)}
              placeholder="0"
              value={estimatedCost}
            />
          </Field>
          <Field
            hint="How long you expect awareness, then sales, to rise for. Between 1 and 12."
            label="Window (months)"
          >
            <input
              className={INPUT}
              inputMode="numeric"
              onChange={(event) => setDurationMonths(event.target.value)}
              value={durationMonths}
            />
          </Field>
          <Field hint="Months before it, to judge the rise against." label="Baseline (months)">
            <input
              className={INPUT}
              inputMode="numeric"
              onChange={(event) => setBaselineMonths(event.target.value)}
              value={baselineMonths}
            />
          </Field>
          <Field
            hint="Optional. Turns a movement into a target that was met or missed."
            label="Expected uplift (%)"
          >
            <input
              className={INPUT}
              inputMode="decimal"
              onChange={(event) => setExpectedUpliftPct(event.target.value)}
              value={expectedUpliftPct}
            />
          </Field>
          <Field hint="Optional." label="Expected attendees">
            <input
              className={INPUT}
              inputMode="numeric"
              onChange={(event) => setExpectedAttendees(event.target.value)}
              value={expectedAttendees}
            />
          </Field>
          <Field hint="Optional." label="Speakers">
            <input className={INPUT} onChange={(e) => setSpeakers(e.target.value)} value={speakers} />
          </Field>
        </FormSection>

        <div className="flex min-w-0 flex-wrap items-center gap-3 border-t border-phx-line pt-4">
          <button
            className={BTN_PRIMARY}
            disabled={saving || !ready}
            onClick={() => void submit()}
            type="button"
          >
            {saving ? "Saving" : "Save as draft"}
          </button>
          <button className={BTN_QUIET} onClick={onCancel} type="button">
            Cancel
          </button>
          {!ready ? (
            <span className="break-words text-phx-3xs font-bold uppercase tracking-[0.10em] text-phx-ink-faint">
              {totalProducts === 0
                ? "Choose at least one product to save"
                : "Fill the required fields to save"}
            </span>
          ) : (
            <span className="break-words text-phx-3xs font-bold uppercase tracking-[0.10em] text-phx-ink-faint">
              {`${totalProducts} product${totalProducts === 1 ? "" : "s"} across ${targetedLines.length} line${targetedLines.length === 1 ? "" : "s"}`}
            </span>
          )}
        </div>
      </div>
    </Panel>
  );
}
