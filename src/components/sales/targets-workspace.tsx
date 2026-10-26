"use client";

import { Fragment, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ChevronDown,
  Layers,
  MapPin,
  Table2,
  Upload,
  Users,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CountUpNumber } from "@/components/ui/count-up";
import {
  ACTUAL_COLOR,
  AchievementMeter,
  AchievementRing,
  BandChoice,
  BandStat,
  CommandBand,
  LABEL_CLASS,
  ProportionBar,
  SectionCard,
  TABLE_HEAD_CLASS,
  TABLE_ROW_CLASS,
  achievementHex,
  achievementTone,
  chipClass,
  formatEgp,
  formatEgpFull,
  formatPct,
  formatPeriod,
} from "@/components/sales/target-visuals";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// Phase 6 Targets workspace. Set targets per (area, product) for a line + month —
// by bulk Excel upload or by editing the grid inline — and see achievement vs the
// SoS actuals.
//
// EDIT vs VIEW: `canEdit` drives whether the write affordances render at all (bulk upload,
// template download, inline target inputs, Save edits, and the line-wide audit export). It is
// PRESENTATION ONLY — every write route still asserts `sales:import` server-side, so a tampered
// client gets a 403. Never move a write behind `canEdit` alone.
//
// Read-only callers: the District / Regional / National Sales Manager portal view
// (/employee-portals/targets) and the CEO on the admin page, both of which hold `sales:read` but not
// `sales:import`. `basePath` exists because the period/line picker navigates by URL and the portal
// surface lives at a different path than /sales/targets.
//
// PRESENTATION (rebuilt 2026-09-04): this module shares its visual language with its sibling
// `VsTargetDashboard` through `@/components/sales/target-visuals` — the same command band, the same
// achievement ring, the same bars and tones. Before that it had no visual encoding at all: the
// region and DM rollups were bare percentages in a `max-h-40` scroll box, so the two screens that
// answer the same question ("how are we doing against target?") looked like two different products.
// The owner's rule is to match the sibling pages in a module, never to invent a look per screen.
// ─────────────────────────────────────────────────────────────────────────────

export type TargetGridRow = {
  areaCode: string;
  areaName: string;
  regionCode: string | null;
  regionName: string | null;
  areaState: string | null;
  productCode: string;
  productName: string;
  unitPrice: number | null;
  actualValue: number;
  targetUnits: number | null;
  targetValue: number | null;
  achievementValue: number | null;
  hasActual: boolean;
  repHrId: string | null;
  repName: string | null;
  dmHrId: string | null;
  dmName: string | null;
};

// `coveredActualValue` is the slice of `actualValue` that sits on a product with a target this
// month. It USED to be the figure `achievementValue` divided, and was carried into the UI so the
// card's numbers would tie. Since 2026-09-05 the percentage divides `actualValue` — the Monthly
// Closing's own rule, which this page must now match exactly — so Actual and Target divide into
// Achievement on their own. It stays as a COVERAGE fact (how much of this line carries a target at
// all), and must never be put back inside the percentage.
export type RegionRollup = { region: string; actualValue: number; coveredActualValue: number; targetValue: number; achievementValue: number | null };
export type DmRollup = { dmName: string; actualValue: number; coveredActualValue: number; targetValue: number; achievementValue: number | null };
export type LineTotal = { actualValue: number; coveredActualValue: number; targetValue: number; achievementValue: number | null } | null;
export type SourceFile = {
  distributorName: string;
  fileName: string;
  uploadedBy: string;
  uploadedAt: string;
  totalQty: number;
  totalValue: number;
  importableRows: number;
  status: string;
};

export type TargetsWorkspaceProps = {
  lines: ReadonlyArray<{ code: string; label: string }>;
  periods: string[];
  selectedLine: string;
  selectedPeriod: string;
  rows: TargetGridRow[];
  lineTotal: LineTotal;
  byRegion: RegionRollup[];
  byDm: DmRollup[];
  sourceFiles: SourceFile[];
  error: string | null;
  /** Render the write affordances. Server still enforces `sales:import` on every write route. */
  canEdit?: boolean;
  /** Route the period/line picker navigates to. Defaults to the admin surface. */
  basePath?: string;
  /** "portal" swaps the light command band for the employee-portal identity; see CommandBand. */
  surface?: "sales" | "portal";
};

type UploadPreview = { totalRows: number; validRows: number; errors: Array<{ rowNumber: number; field: string; code: string; message: string }> };

type BreakdownLine = { brickName: string; distributorName: string; customerName: string; units: number; value: number };
type TrendPoint = { period: string; units: number; value: number };
type BreakdownState = { loading: boolean; rows: BreakdownLine[]; trend: TrendPoint[]; totalUnits: number; totalValue: number; error: string | null };

const money = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const price = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const fmtUnits = (value: number): string => money.format(Math.round(value));
const fmtUnitCount = (value: number): string => `${fmtUnits(value)} ${Math.round(value) === 1 ? "unit" : "units"}`;
const fmtPrice = (value: number | null): string => (value == null ? "—" : price.format(value));

/**
 * The exact division behind a rolled-up percentage, for the `title` of the row that shows it.
 * The bar and the number carry the shape; this carries the arithmetic for anyone who wants it.
 */
const divisionHint = (actual: number, target: number): string =>
  target === 0 ? "No target loaded — not graded." : `${formatEgpFull(actual)} sales / ${formatEgpFull(target)} target`;

const keyOf = (row: TargetGridRow): string => `${row.areaCode}|${row.productCode}`;

/** A quiet white action (a download link, a toggle) that turns orange on hover and focus. */
const OUTLINE_ACTION_CLASS =
  "inline-flex h-8 items-center gap-1.5 border border-slate-200 bg-white px-3 text-phx-xs font-bold text-slate-700 transition-colors hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-orange-500";

type CustomerLine = { customerName: string; units: number; value: number };
type DistGroup = { distributorName: string; units: number; value: number; customers: CustomerLine[] };
type BrickGroup = { brickName: string; units: number; value: number; distributors: DistGroup[] };

/** Nest the raw lines into brick → distributor → customer (largest first at each level). */
function groupSource(rows: BreakdownLine[]): BrickGroup[] {
  const bricks = new Map<string, BrickGroup>();
  for (const line of rows) {
    let brick = bricks.get(line.brickName);
    if (!brick) {
      brick = { brickName: line.brickName, units: 0, value: 0, distributors: [] };
      bricks.set(line.brickName, brick);
    }
    brick.units += line.units;
    brick.value += line.value;
    let dist = brick.distributors.find((d) => d.distributorName === line.distributorName);
    if (!dist) {
      dist = { distributorName: line.distributorName, units: 0, value: 0, customers: [] };
      brick.distributors.push(dist);
    }
    dist.units += line.units;
    dist.value += line.value;
    dist.customers.push({ customerName: line.customerName, units: line.units, value: line.value });
  }
  const result = [...bricks.values()];
  for (const brick of result) {
    brick.distributors.sort((a, b) => b.value - a.value);
    for (const dist of brick.distributors) dist.customers.sort((a, b) => b.value - a.value);
  }
  result.sort((a, b) => b.value - a.value);
  return result;
}

/**
 * The drill-down body — brick → distributor → customer for one area × product.
 *
 * ONE implementation, rendered both by the desktop grid's `<td colSpan>` and by the phone
 * card below it. Two copies would let the same expander show two different numbers, which is the
 * failure this module exists to prevent.
 *
 * The customer lines were a nested table until 2026-08-16. Inside a drill-down on a phone
 * there is nothing to scroll it sideways, so the customer NAME — the whole point of the panel —
 * was the column that ran off the screen. Rows are flex now, matching the brick and distributor
 * headers directly above them; the fixed number widths keep the desktop columns aligned.
 */
function SourceBreakdown({ detail, selectedPeriod }: { detail: BreakdownState; selectedPeriod: string }) {
  const groups = useMemo(() => groupSource(detail.rows), [detail.rows]);

  if (detail.loading) return <div className="text-xs text-slate-500">Loading source…</div>;
  if (detail.error) return <div className="text-xs font-semibold text-red-600">{detail.error}</div>;
  if (detail.rows.length === 0) return <div className="text-xs text-slate-500">No source rows.</div>;

  const maxBrick = Math.max(...groups.map((brick) => Math.abs(brick.value)), 1);
  const maxTrend = Math.max(...detail.trend.map((point) => Math.abs(point.value)), 1);

  return (
    <div className="space-y-3">
      {detail.trend.length > 1 ? (
        <div className="border border-slate-200 bg-white p-3">
          <p className={`mb-2 ${LABEL_CLASS}`}>
            Month over month — this area &amp; product
          </p>
          {/* A row of mini columns rather than a line of text figures: the SHAPE of the trend is
              the point, and twelve bare numbers separated by colons is not a shape. */}
          <div className="flex items-end gap-1.5">
            {detail.trend.map((point) => {
              const isCurrent = point.period === selectedPeriod;
              return (
                <div key={point.period} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                  <span
                    className={cn("w-full", isCurrent ? "bg-orange-500" : "bg-slate-200")}
                    style={{ height: `${Math.max(2, (Math.abs(point.value) / maxTrend) * 44)}px` }}
                    aria-hidden
                  />
                  <span
                    className={cn(
                      "text-phx-3xs tabular-nums",
                      isCurrent ? "font-black text-orange-600" : "text-slate-500",
                    )}
                  >
                    {point.period.slice(2)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
      <div>
        <p className={`mb-2 ${LABEL_CLASS}`}>
          Source of {formatEgpFull(detail.totalValue)} · {fmtUnits(detail.totalUnits)} units — brick → distributor → customer
        </p>
        <div className="max-h-96 space-y-2 overflow-y-auto pr-1">
          {groups.map((brick) => (
            <div key={brick.brickName} className="border border-slate-200 bg-white">
              {/* The brick header: an orange left rule on a quiet slate ground. No wrapper
                  overflow-hidden and no nowrap, so the figures wrap under the name on a phone
                  instead of being cut at the card's edge. */}
              <div className="border-b border-slate-200 border-l-[3px] border-l-orange-500 bg-slate-50 px-3 py-2">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                  <span className="min-w-0 break-words text-phx-xs font-black text-slate-900">{brick.brickName}</span>
                  <span className="text-phx-xs font-black tabular-nums text-orange-600">
                    {fmtUnits(brick.units)} units · {formatEgpFull(brick.value)}
                  </span>
                </div>
                <div className="mt-1.5">
                  <ProportionBar fraction={Math.abs(brick.value) / maxBrick} color={ACTUAL_COLOR} />
                </div>
              </div>
              {brick.distributors.map((dist, di) => (
                <div key={`${dist.distributorName}-${di}`} className="border-t border-slate-100 first:border-t-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 bg-white px-3 py-1.5 text-phx-xs font-bold text-slate-800">
                    <span className="min-w-0 break-words">{dist.distributorName}</span>
                    <span className="tabular-nums text-slate-900">
                      {fmtUnits(dist.units)} · {formatEgpFull(dist.value)}
                    </span>
                  </div>
                  {dist.customers.map((cust, ci) => (
                    <div
                      key={`${cust.customerName}-${ci}`}
                      className="flex items-baseline gap-x-3 border-t border-slate-100 py-1 pl-6 pr-3 text-phx-xs transition-colors hover:bg-orange-50/40"
                    >
                      <span className="min-w-0 flex-1 break-words text-slate-500">{cust.customerName}</span>
                      <span className="w-16 shrink-0 text-right tabular-nums text-slate-600">{fmtUnits(cust.units)}</span>
                      <span className="w-24 shrink-0 text-right font-semibold tabular-nums text-slate-900">{formatEgp(cust.value)}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * One ranked rollup panel — region or district manager.
 *
 * Rows are ordered by the money they carry, largest first, because the bar beside each is a
 * proportion of the largest and an unordered bar chart is a puzzle. Until 2026-09-04 this was a
 * bare `name ......... 87%` list in a 10rem scroll box: no ordering, no magnitude, nothing to
 * tell a 4-million-pound region from a 40-thousand-pound one.
 */
function RollupList({
  entries,
  emptyLabel,
}: {
  entries: ReadonlyArray<{ name: string; actualValue: number; coveredActualValue: number; targetValue: number; achievementValue: number | null }>;
  emptyLabel: string;
}) {
  if (entries.length === 0) {
    return <p className="px-4 py-8 text-center text-xs text-slate-500">{emptyLabel}</p>;
  }
  const max = Math.max(...entries.map((entry) => Math.abs(entry.actualValue)), 1);
  return (
    <ol className="max-h-72 divide-y divide-slate-100 overflow-y-auto">
      {entries.map((entry, index) => (
        <li
          key={entry.name}
          className="grid grid-cols-[1.5rem_minmax(0,1fr)_5.5rem] items-center gap-x-3 gap-y-1.5 px-4 py-3 transition-colors hover:bg-orange-50/40"
          title={divisionHint(entry.actualValue, entry.targetValue)}
        >
          <span
            className="flex h-6 w-6 shrink-0 items-center justify-center text-phx-2xs font-black text-white"
            style={{ backgroundColor: achievementHex(entry.achievementValue) }}
          >
            {index + 1}
          </span>
          <p className="min-w-0 break-words text-phx-md font-bold text-slate-900">{entry.name}</p>
          <span className="whitespace-nowrap text-right text-phx-md font-black tabular-nums text-slate-900">
            {formatEgp(entry.actualValue)}
          </span>
          <span aria-hidden />
          <ProportionBar fraction={Math.abs(entry.actualValue) / max} color={ACTUAL_COLOR} />
          <span className={cn("whitespace-nowrap text-right text-phx-xs font-black tabular-nums", achievementTone(entry.achievementValue))}>
            {formatPct(entry.achievementValue)}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function TargetsWorkspace(props: TargetsWorkspaceProps) {
  const router = useRouter();
  const canEdit = props.canEdit !== false;
  const basePath = props.basePath ?? "/sales/targets";
  const surface = props.surface ?? "sales";
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [unitEdits, setUnitEdits] = useState<Record<string, string>>({});
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<UploadPreview | null>(null);
  const [busy, setBusy] = useState<null | "preview" | "commit" | "save">(null);
  const [message, setMessage] = useState<string | null>(null);

  const rowByKey = useMemo(() => new Map(props.rows.map((row) => [keyOf(row), row])), [props.rows]);
  const editedKeys = useMemo(
    () => Array.from(new Set([...Object.keys(edits), ...Object.keys(unitEdits)])),
    [edits, unitEdits],
  );
  const [expanded, setExpanded] = useState<Record<string, BreakdownState>>({});
  const [showFiles, setShowFiles] = useState(false);

  async function toggleBreakdown(row: TargetGridRow) {
    const key = keyOf(row);
    if (expanded[key]) {
      setExpanded((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      return;
    }
    setExpanded((current) => ({ ...current, [key]: { loading: true, rows: [], trend: [], totalUnits: 0, totalValue: 0, error: null } }));
    try {
      const params = new URLSearchParams({
        period: props.selectedPeriod,
        line: props.selectedLine,
        area: row.areaCode,
        product: row.productCode,
      });
      const res = await fetch(`/api/sales/targets/breakdown?${params.toString()}`);
      const json = await res.json();
      if (!json.success) {
        setExpanded((current) => ({ ...current, [key]: { loading: false, rows: [], trend: [], totalUnits: 0, totalValue: 0, error: json.error ?? "Failed to load." } }));
        return;
      }
      setExpanded((current) => ({
        ...current,
        [key]: { loading: false, rows: json.rows ?? [], trend: json.trend ?? [], totalUnits: json.totalUnits ?? 0, totalValue: json.totalValue ?? 0, error: null },
      }));
    } catch {
      setExpanded((current) => ({ ...current, [key]: { loading: false, rows: [], trend: [], totalUnits: 0, totalValue: 0, error: "Failed to load (network)." } }));
    }
  }

  function navigate(line: string, period: string) {
    setEdits({});
    setUnitEdits({});
    setPreview(null);
    setMessage(null);
    router.push(`${basePath}?line=${encodeURIComponent(line)}&period=${encodeURIComponent(period)}`);
  }

  async function runUpload(commit: boolean) {
    if (!file) {
      setMessage("Choose an .xlsx file first.");
      return;
    }
    setBusy(commit ? "commit" : "preview");
    setMessage(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("commit", commit ? "true" : "false");
      const res = await fetch("/api/sales/targets/upload", { method: "POST", body: form });
      const json = await res.json();
      if (!json.success) {
        setMessage(json.error ?? "Upload failed.");
        return;
      }
      if (commit) {
        setPreview(null);
        setFile(null);
        setMessage(`Saved ${json.upserted} target row(s).${json.errors?.length ? ` ${json.errors.length} row(s) rejected.` : ""}`);
        router.refresh();
      } else {
        setPreview({ totalRows: json.totalRows, validRows: json.validRows, errors: json.errors ?? [] });
      }
    } catch {
      setMessage("Upload failed (network).");
    } finally {
      setBusy(null);
    }
  }

  async function saveEdits() {
    const parse = (raw: string | undefined, fallback: number | null): number | null => {
      if (raw === undefined) return fallback;
      if (raw === "") return null;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const rows = editedKeys
      .map((key) => {
        const [areaCode, productCode] = key.split("|");
        const existing = rowByKey.get(key);
        const targetUnits = parse(unitEdits[key], existing?.targetUnits ?? null);
        const targetValue = parse(edits[key], existing?.targetValue ?? null);
        return { areaCode, productCode, targetUnits, targetValue };
      })
      // Keep a row only if at least one of units/value is a valid non-negative number.
      .filter(
        (row) =>
          (row.targetUnits != null && Number.isFinite(row.targetUnits) && row.targetUnits >= 0) ||
          (row.targetValue != null && Number.isFinite(row.targetValue) && row.targetValue >= 0),
      );
    if (rows.length === 0) {
      setMessage("No valid edited values to save.");
      return;
    }
    setBusy("save");
    setMessage(null);
    try {
      const res = await fetch("/api/sales/targets/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ period: props.selectedPeriod, line: props.selectedLine, rows }),
      });
      const json = await res.json();
      if (!json.success) {
        setMessage(json.error ?? "Save failed.");
        return;
      }
      setEdits({});
      setUnitEdits({});
      setMessage(`Saved ${json.upserted} target row(s).${json.errors?.length ? ` ${json.errors.length} rejected.` : ""}`);
      router.refresh();
    } catch {
      setMessage("Save failed (network).");
    } finally {
      setBusy(null);
    }
  }

  // Every per-row number is derived HERE, once, and read by both the desktop grid and the phone
  // cards. The two surfaces render the same target or they are a bug — the same reason the
  // drill-down is a single <SourceBreakdown />.
  const viewRow = (row: TargetGridRow) => {
    const key = keyOf(row);
    const editValue = edits[key] ?? (row.targetValue == null ? "" : String(row.targetValue));
    const unitValue = unitEdits[key] ?? (row.targetUnits == null ? "" : String(row.targetUnits));
    const liveTarget = editValue === "" ? null : Number(editValue);
    return {
      canDrill: row.actualValue !== 0,
      detail: expanded[key],
      editValue,
      key,
      liveAch: liveTarget && liveTarget !== 0 ? row.actualValue / liveTarget : null,
      unitValue,
    };
  };

  /** Typing units auto-fills Target value = units x unit price. The value stays editable after. */
  const onUnitsChange = (row: TargetGridRow, raw: string) => {
    const key = keyOf(row);
    setUnitEdits((current) => ({ ...current, [key]: raw }));
    const units = Number(raw);
    if (row.unitPrice != null && raw !== "" && Number.isFinite(units)) {
      setEdits((current) => ({ ...current, [key]: String(Math.round(units * row.unitPrice!)) }));
    }
  };

  const onValueChange = (key: string, raw: string) => setEdits((current) => ({ ...current, [key]: raw }));

  const lineLabel = props.lines.find((line) => line.code === props.selectedLine)?.label ?? props.selectedLine;
  const total = props.lineTotal;
  const notGraded = total ? total.actualValue - total.coveredActualValue : 0;
  // "Measured" is the share of this line's sales sitting on a product that carries a target of its
  // own. It no longer explains the percentage — Actual over Target is the percentage now — but it
  // is still the first thing a manager asks when a number looks off, because a line that is barely
  // targeted produces a percentage built on very little.
  const measured = total && total.actualValue !== 0 ? total.coveredActualValue / total.actualValue : null;

  // Ranked, because the bar beside each row is a proportion of the largest and an unordered bar
  // chart is a puzzle. `.map` already copies, so neither `.sort` touches the prop array.
  const rankedRegions = useMemo(
    () =>
      props.byRegion
        .map((entry) => ({ ...entry, name: entry.region }))
        .sort((left, right) => Math.abs(right.actualValue) - Math.abs(left.actualValue)),
    [props.byRegion],
  );
  const rankedDms = useMemo(
    () =>
      props.byDm
        .map((entry) => ({ ...entry, name: entry.dmName }))
        .sort((left, right) => Math.abs(right.actualValue) - Math.abs(left.actualValue)),
    [props.byDm],
  );

  return (
    <div className="space-y-4 p-3 sm:p-4">
      <CommandBand
        surface={surface}
        kicker={canEdit ? "Sales Operations · Authoring" : "Sales Operations · View only"}
        title="Targets"
        subtitle={`${lineLabel} · ${formatPeriod(props.selectedPeriod)} · one target per product, per area`}
        stats={
          total ? (
            <>
              <BandStat
                label="With a target"
                value={<CountUpNumber value={total.coveredActualValue} format={formatEgp} />}
                note={
                  notGraded === 0
                    ? "every pound has a target behind it"
                    : `${formatEgp(notGraded)} more has none, and still counts`
                }
              />
              <BandStat
                label="Target"
                tone="sky"
                value={<CountUpNumber value={total.targetValue} format={formatEgp} />}
                note={`${props.rows.length.toLocaleString("en-US")} area x product rows`}
              />
              <BandStat
                label="Total sales"
                value={<CountUpNumber value={total.actualValue} format={formatEgp} />}
                note="every pound — this over Target is the Achievement"
              />
            </>
          ) : undefined
        }
        ring={total ? <AchievementRing value={total.achievementValue} size={150} stroke={13} label="Achievement" premium={surface === "portal"} /> : undefined}
        aside={
          total ? (
            <div className="border-l border-slate-100 pl-6">
              <p className={LABEL_CLASS}>Measured</p>
              <p className="mt-1 whitespace-nowrap text-2xl font-black tabular-nums text-slate-900">{formatPct(measured)}</p>
              <p className="mt-1 max-w-[13rem] text-phx-xs leading-4 text-slate-500">
                of this line&apos;s sales sits on a product with a target of its own
              </p>
            </div>
          ) : undefined
        }
        // The ring and the "Measured" aside together never shrink, so beside the headline from 1024px
        // they left it a 100px column next to the portal sidebar (measured 2026-09-16). They sit under
        // the headline until 1280px instead.
        besideFrom="xl"
        footer={
          <>
            <BandChoice
              label="Line"
              options={props.lines.map((line) => ({ value: line.code, label: line.label }))}
              selected={props.selectedLine}
              onSelect={(value) => navigate(value, props.selectedPeriod)}
            />
            <span aria-hidden className="mx-2 hidden h-4 w-px bg-slate-200 sm:block" />
            <BandChoice
              label="Month"
              options={props.periods.map((period) => ({ value: period, label: formatPeriod(period) }))}
              selected={props.selectedPeriod}
              onSelect={(value) => navigate(props.selectedLine, value)}
            />
          </>
        }
      />

      {props.error ? (
        <div className="flex items-start gap-3 border border-l-[3px] border-red-200 border-l-red-500 bg-red-50 px-4 py-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
          <p className="min-w-0 text-xs font-semibold leading-5 text-red-800">{props.error}</p>
        </div>
      ) : null}

      {message ? (
        <div className="border border-l-[3px] border-slate-200 border-l-orange-500 bg-white px-4 py-3 text-xs font-semibold text-slate-800">{message}</div>
      ) : null}

      {/* Ungraded sales banner — the same explanation Sales vs Target gives, in the same words, so
          the two screens cannot be read as disagreeing about what achievement measures. */}
      {total && notGraded !== 0 ? (
        <div className="flex items-start gap-3 border border-l-[3px] border-amber-200 border-l-amber-500 bg-amber-50 px-4 py-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <div className="min-w-0 text-xs leading-5 text-amber-900">
            {/* One template literal, not `{expr} text`: a JSX text chunk that carries an HTML
                entity (`&apos;`) and follows an expression on the same line loses its LEADING
                space in the SWC transform, and the banner rendered "EGP 617,990of this line's".
                Nothing else on the page is affected — `{a} · {b}` is fine — so this is the one
                place that needs the literal. */}
            <p className="font-bold">
              {`${formatEgpFull(notGraded)} of this line's sales sits on a product with no target this month.`}
            </p>
            <p>
              Achievement is every sale in a targeted month over that month&apos;s target — the same Ach % the
              Monthly Closing prints — so this untargeted value is counted in it too.
            </p>
          </div>
        </div>
      ) : null}

      {/* ── Rollups: the same figures the old flat cards printed as bare text, now with a shape ── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SectionCard
          title="By region"
          subtitle={`${rankedRegions.length.toLocaleString("en-US")} region${rankedRegions.length === 1 ? "" : "s"} · ranked by sales`}
          icon={MapPin}
        >
          <RollupList entries={rankedRegions} emptyLabel="No regional sales in this line and month." />
        </SectionCard>
        <SectionCard
          title="By district manager"
          subtitle={`${rankedDms.length.toLocaleString("en-US")} manager${rankedDms.length === 1 ? "" : "s"} · ranked by sales`}
          icon={Users}
        >
          <RollupList entries={rankedDms} emptyLabel="No sales attributed to a district manager here." />
        </SectionCard>
      </div>

      {/* ── The grid ── */}
      <SectionCard
        title={`Targets & achievement — ${lineLabel}`}
        subtitle={`${formatPeriod(props.selectedPeriod)} · open a row to trace its sales to distributor and brick`}
        icon={Table2}
        actions={
          canEdit ? (
            <div className="flex items-center gap-2">
              {/* Line-WIDE audit export (no area parameter, so there is nothing to scope) — stays
                  with the authoring roles. */}
              <a
                className={OUTLINE_ACTION_CLASS}
                href={`/api/sales/targets/breakdown/export?line=${encodeURIComponent(props.selectedLine)}&period=${encodeURIComponent(props.selectedPeriod)}`}
              >
                Export audit
              </a>
              <Button size="sm" disabled={editedKeys.length === 0 || busy !== null} onClick={saveEdits}>
                {busy === "save" ? "Saving…" : `Save edits${editedKeys.length ? ` (${editedKeys.length})` : ""}`}
              </Button>
            </div>
          ) : (
            <span className="border border-slate-200 bg-slate-50 px-2.5 py-1 text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500">
              View only
            </span>
          )
        }
      >
        {props.rows.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-sm font-bold text-slate-900">
              Nothing loaded for {lineLabel} in {formatPeriod(props.selectedPeriod)}.
            </p>
            <p className="mx-auto mt-1.5 max-w-xl text-xs leading-5 text-slate-500">
              {canEdit
                ? "No targets and no sales yet for this line and month. Download the template, fill it and upload it — or pick a month whose distributor sales have been loaded."
                : "No targets or sales for your territory in this line and month."}
            </p>
          </div>
        ) : (
          <>
            {/* Phone: one card per area x product. A ten-column grid — four of them names, two of
                them editable inputs — cannot be read on a 375px screen, and this workspace is
                reachable from the portal by every DM, RM and NSM (read-only) as well as by the
                admin surface. Desktop keeps the full table below, per the owner's rule. */}
            <div className="max-h-[60vh] space-y-2 overflow-y-auto p-3 md:hidden">
              {props.rows.map((row) => {
                const view = viewRow(row);
                return (
                  <div className="flex border border-slate-200 bg-white" key={view.key}>
                    <span className="w-1 shrink-0" style={{ backgroundColor: achievementHex(view.liveAch) }} aria-hidden />
                    <div className="min-w-0 flex-1 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="break-words text-sm font-black text-slate-900">
                            {row.areaName || "—"}
                            {row.areaState === "vacant_will_hire" ? <Badge className="ml-1.5 align-middle">vacant</Badge> : null}
                          </p>
                          <p className="break-words text-phx-xs text-slate-500">
                            {row.productName || "—"} · {row.regionName ?? "—"}
                          </p>
                          <p className="break-words text-phx-xs text-slate-500">Rep: {row.repName ?? "vacant"}</p>
                        </div>
                        <div className="w-24 shrink-0">
                          <AchievementMeter value={view.liveAch} />
                        </div>
                      </div>

                      <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-slate-100 pt-2.5 text-phx-xs">
                        <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                          <dt className="text-slate-500">Actual</dt>
                          <dd className="whitespace-nowrap font-black tabular-nums text-slate-900">{formatEgp(row.actualValue)}</dd>
                        </div>
                        <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                          <dt className="text-slate-500">Unit price</dt>
                          <dd className="whitespace-nowrap tabular-nums text-slate-600">{fmtPrice(row.unitPrice)}</dd>
                        </div>
                      </dl>

                      {canEdit ? (
                        <div className="mt-2 grid grid-cols-2 gap-2">
                          <label className="block">
                            <span className={LABEL_CLASS}>Target units</span>
                            <Input
                              type="number"
                              inputMode="decimal"
                              className="mt-0.5 h-9 w-full text-right tabular-nums"
                              placeholder="units"
                              value={view.unitValue}
                              onChange={(event) => onUnitsChange(row, event.target.value)}
                            />
                          </label>
                          <label className="block">
                            <span className={LABEL_CLASS}>Target value</span>
                            <Input
                              type="number"
                              inputMode="decimal"
                              className="mt-0.5 h-9 w-full text-right tabular-nums"
                              placeholder="value"
                              value={view.editValue}
                              onChange={(event) => onValueChange(view.key, event.target.value)}
                            />
                          </label>
                        </div>
                      ) : (
                        <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-phx-xs">
                          <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                            <dt className="text-slate-500">Target units</dt>
                            <dd className="whitespace-nowrap tabular-nums text-slate-700">
                              {row.targetUnits == null ? "—" : fmtUnits(row.targetUnits)}
                            </dd>
                          </div>
                          <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                            <dt className="text-slate-500">Target value</dt>
                            <dd className="whitespace-nowrap font-black tabular-nums text-sky-600">
                              {row.targetValue == null ? "—" : formatEgp(row.targetValue)}
                            </dd>
                          </div>
                        </dl>
                      )}

                      {view.canDrill ? (
                        <button
                          type="button"
                          aria-expanded={Boolean(view.detail)}
                          className={cn("mt-2.5 inline-flex items-center gap-1.5", chipClass(Boolean(view.detail)))}
                          onClick={() => toggleBreakdown(row)}
                        >
                          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", view.detail ? "" : "-rotate-90")} />
                          {view.detail ? "Hide source" : "Show source"}
                        </button>
                      ) : null}
                      {view.detail ? (
                        <div className="mt-2 border border-slate-100 bg-slate-50 p-2">
                          <SourceBreakdown detail={view.detail} selectedPeriod={props.selectedPeriod} />
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Desktop. `table-fixed` with an explicit colgroup, never a min-width floor: the
                owner's golden rule is that the page fits its screen, and the way this table was
                made to fit is by MERGING columns — area carries its region, product carries its
                rep, and one Target cell carries the value, its units and the unit price — not by
                shrinking the type. Ten columns became six. The last merge (Target units into
                Target value, 2026-09-16) is what gives Achievement room for its header:
                "ACHIEVEMENT" cannot wrap, and at 11% of the 572px table the portal has at a
                1024px screen it spilled out of its cell into a sideways scroll.
                tests/sales-target-tables-fit-the-screen.test.ts holds the arithmetic. */}
            <div className="hidden max-h-[60vh] overflow-y-auto md:block">
              <table className="w-full table-fixed border-collapse text-sm" data-portal-desktop-table>
                <colgroup>
                  <col style={{ width: "2.25rem" }} />
                  <col style={{ width: "21%" }} />
                  <col style={{ width: "21%" }} />
                  <col style={{ width: "16%" }} />
                  <col style={{ width: "16%" }} />
                  <col style={{ width: "26%" }} />
                </colgroup>
                <thead className="sticky top-0 z-10">
                  <tr className={`text-left ${TABLE_HEAD_CLASS}`}>
                    <th className="px-2 py-2.5" />
                    <th className="px-3 py-2.5">Area</th>
                    <th className="px-3 py-2.5">Product</th>
                    <th className="px-3 py-2.5 text-right">Actual</th>
                    <th className="px-3 py-2.5 text-right">Target</th>
                    <th className="px-3 py-2.5 text-right">Achievement</th>
                  </tr>
                </thead>
                <tbody>
                  {props.rows.map((row) => {
                    const { canDrill, detail, editValue, key, liveAch, unitValue } = viewRow(row);
                    return (
                      <Fragment key={key}>
                        <tr className={cn(TABLE_ROW_CLASS, detail ? "bg-orange-50" : undefined)}>
                          <td className="px-2 py-3 align-top">
                            {canDrill ? (
                              <button
                                type="button"
                                aria-label={detail ? "Hide source" : "Show source"}
                                aria-expanded={Boolean(detail)}
                                className={cn(
                                  "flex h-6 w-6 items-center justify-center border transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-orange-500",
                                  detail
                                    ? "border-orange-300 bg-white text-orange-600"
                                    : "border-transparent text-slate-400 hover:border-orange-200 hover:bg-orange-50 hover:text-orange-600",
                                )}
                                onClick={() => toggleBreakdown(row)}
                              >
                                <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", detail ? "" : "-rotate-90")} />
                              </button>
                            ) : null}
                          </td>
                          <td className="px-3 py-3 align-top">
                            <p className="break-words font-bold text-slate-900">
                              {row.areaName || "—"}
                              {row.areaState === "vacant_will_hire" ? <Badge className="ml-1.5 align-middle">vacant</Badge> : null}
                            </p>
                            <p className="break-words text-phx-xs text-slate-500">{row.regionName ?? "—"}</p>
                          </td>
                          <td className="px-3 py-3 align-top">
                            <p className="break-words font-medium text-slate-800">{row.productName || "—"}</p>
                            <p className="break-words text-phx-xs text-slate-500">
                              {row.repName ?? <span className="italic">vacant</span>}
                            </p>
                          </td>
                          <td className="px-3 py-3 text-right align-top font-bold tabular-nums text-slate-900">
                            {formatEgpFull(row.actualValue)}
                          </td>
                          <td className="px-3 py-3 text-right align-top">
                            {canEdit ? (
                              <>
                                <label className="block">
                                  <span className={LABEL_CLASS}>Value</span>
                                  <Input
                                    type="number"
                                    inputMode="decimal"
                                    className="mt-0.5 h-8 w-full text-right tabular-nums"
                                    placeholder="value"
                                    value={editValue}
                                    onChange={(event) => onValueChange(key, event.target.value)}
                                  />
                                </label>
                                <label className="mt-1.5 block">
                                  <span className={LABEL_CLASS}>Units</span>
                                  <Input
                                    type="number"
                                    inputMode="decimal"
                                    className="mt-0.5 h-8 w-full text-right tabular-nums"
                                    placeholder="units"
                                    value={unitValue}
                                    onChange={(event) => onUnitsChange(row, event.target.value)}
                                  />
                                </label>
                              </>
                            ) : (
                              <>
                                <p className="font-semibold tabular-nums text-sky-600">
                                  {row.targetValue == null ? "—" : formatEgpFull(row.targetValue)}
                                </p>
                                {row.targetUnits == null ? null : (
                                  <p className="tabular-nums text-slate-700">{fmtUnitCount(row.targetUnits)}</p>
                                )}
                              </>
                            )}
                            <p className="mt-1 text-phx-xs tabular-nums text-slate-500">@ {fmtPrice(row.unitPrice)}</p>
                          </td>
                          <td className="px-3 py-3 align-top">
                            <AchievementMeter value={liveAch} />
                          </td>
                        </tr>
                        {detail ? (
                          <tr className="border-b border-slate-200 bg-slate-50">
                            <td className="px-4 py-4" colSpan={6}>
                              <SourceBreakdown detail={detail} selectedPeriod={props.selectedPeriod} />
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </SectionCard>

      {/* Bulk upload — authoring only. */}
      {canEdit ? (
        <SectionCard
          title="Bulk upload"
          subtitle="Preview first, then commit — a preview writes nothing"
          icon={Upload}
          actions={
            <a
              className={OUTLINE_ACTION_CLASS}
              href={`/api/sales/targets/template?line=${encodeURIComponent(props.selectedLine)}`}
            >
              Download template
            </a>
          }
        >
          <div className="space-y-3 p-5">
            <div className="flex flex-wrap items-center gap-3">
              <Input
                type="file"
                accept=".xlsx"
                className="max-w-xs"
                onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPreview(null); }}
              />
              <Button variant="outline" disabled={!file || busy !== null} onClick={() => runUpload(false)}>
                {busy === "preview" ? "Checking…" : "Preview"}
              </Button>
              <Button disabled={!file || busy !== null} onClick={() => runUpload(true)}>
                {busy === "commit" ? "Saving…" : "Commit upload"}
              </Button>
            </div>
            {preview ? (
              <div className="border border-slate-200 bg-slate-50 p-4">
                <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
                  <span>
                    <span className="text-xl font-black tabular-nums text-emerald-600">
                      {preview.validRows.toLocaleString("en-US")}
                    </span>{" "}
                    <span className="text-xs text-slate-500">
                      valid of {preview.totalRows.toLocaleString("en-US")}
                    </span>
                  </span>
                  {preview.errors.length > 0 ? (
                    <span>
                      <span className="text-xl font-black tabular-nums text-red-600">
                        {preview.errors.length.toLocaleString("en-US")}
                      </span>{" "}
                      <span className="text-xs text-slate-500">rejected</span>
                    </span>
                  ) : null}
                </div>
                <div className="mt-2">
                  <ProportionBar
                    fraction={preview.totalRows === 0 ? 0 : preview.validRows / preview.totalRows}
                    color="#10B981"
                  />
                </div>
                {preview.errors.length > 0 ? (
                  <ul className="mt-2.5 max-h-40 space-y-1 overflow-y-auto text-phx-xs text-slate-600">
                    {preview.errors.slice(0, 50).map((issue, index) => (
                      <li key={`${issue.rowNumber}-${index}`}>Row {issue.rowNumber}: {issue.message}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </div>
        </SectionCard>
      ) : null}

      {/* Source files — provenance / paper trail. COMPANY-WIDE distributor-upload metadata (file
          names, who uploaded, totals across every line), so it is an authoring concern only and is
          hidden from the scoped read-only view. The portal page also passes an empty array, so this
          panel could never leak even if it did render. */}
      {canEdit ? (
        <SectionCard
          title="Source files this month"
          subtitle={`${props.sourceFiles.length.toLocaleString("en-US")} validated distributor upload(s) behind these actuals`}
          icon={Layers}
          actions={
            <button
              type="button"
              aria-expanded={showFiles}
              className={OUTLINE_ACTION_CLASS}
              onClick={() => setShowFiles((value) => !value)}
            >
              <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", showFiles ? "" : "-rotate-90")} />
              {showFiles ? "Hide" : "Show"}
            </button>
          }
        >
          {!showFiles ? null : props.sourceFiles.length === 0 ? (
            <p className="px-4 py-8 text-center text-xs text-slate-500">
              No validated distributor files for {formatPeriod(props.selectedPeriod)}.
            </p>
          ) : (
            <>
              {/* Phone: cards. Seven columns, three of them free text (distributor, file name,
                  uploader), is the widest table in this module — and a file name is exactly the
                  value nobody may see truncated. Authoring-only, but it is still opened on a phone. */}
              <div className="max-h-80 space-y-2 overflow-y-auto p-3 md:hidden">
                {props.sourceFiles.map((sourceFile, index) => (
                  <div className="flex border border-slate-200 bg-white" key={`${sourceFile.fileName}-${index}`}>
                    <span className="w-1 shrink-0 bg-sky-500" aria-hidden />
                    <div className="min-w-0 flex-1 p-3">
                      <p className="break-words text-sm font-black text-slate-900">{sourceFile.distributorName}</p>
                      <p className="break-all text-phx-xs text-slate-500" dir="auto">{sourceFile.fileName}</p>
                      <p className="mt-0.5 text-phx-xs text-slate-500">
                        {sourceFile.uploadedBy || "—"} · {sourceFile.uploadedAt ? sourceFile.uploadedAt.slice(0, 10) : "—"}
                      </p>
                      <dl className="mt-2 grid grid-cols-3 gap-x-3 border-t border-slate-100 pt-2 text-phx-xs">
                        <div>
                          <dt className={LABEL_CLASS}>Rows</dt>
                          <dd className="tabular-nums text-slate-700">{fmtUnits(sourceFile.importableRows)}</dd>
                        </div>
                        <div>
                          <dt className={LABEL_CLASS}>Units</dt>
                          <dd className="tabular-nums text-slate-700">{fmtUnits(sourceFile.totalQty)}</dd>
                        </div>
                        <div>
                          <dt className={LABEL_CLASS}>Value</dt>
                          <dd className="font-black tabular-nums text-slate-900">{formatEgp(sourceFile.totalValue)}</dd>
                        </div>
                      </dl>
                    </div>
                  </div>
                ))}
              </div>
              <div className="hidden max-h-80 overflow-y-auto md:block">
                <table className="w-full table-fixed text-xs" data-portal-desktop-table>
                  <colgroup>
                    <col style={{ width: "20%" }} />
                    <col style={{ width: "28%" }} />
                    <col style={{ width: "16%" }} />
                    <col style={{ width: "10%" }} />
                    <col style={{ width: "8%" }} />
                    <col style={{ width: "8%" }} />
                    <col style={{ width: "10%" }} />
                  </colgroup>
                  <thead className="sticky top-0 z-10">
                    <tr className={`text-left ${TABLE_HEAD_CLASS}`}>
                      <th className="px-3 py-2.5">Distributor</th>
                      <th className="px-3 py-2.5">File</th>
                      <th className="px-3 py-2.5">Uploaded by</th>
                      <th className="px-3 py-2.5">When</th>
                      <th className="px-3 py-2.5 text-right">Rows</th>
                      <th className="px-3 py-2.5 text-right">Units</th>
                      <th className="px-3 py-2.5 text-right">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {props.sourceFiles.map((sourceFile, index) => (
                      <tr key={`${sourceFile.fileName}-${index}`} className={TABLE_ROW_CLASS}>
                        <td className="break-words px-3 py-2.5 font-bold text-slate-900">{sourceFile.distributorName}</td>
                        <td className="break-all px-3 py-2.5 text-slate-500" dir="auto">{sourceFile.fileName}</td>
                        <td className="break-words px-3 py-2.5 text-slate-700">{sourceFile.uploadedBy || "—"}</td>
                        <td className="px-3 py-2.5 tabular-nums text-slate-700">{sourceFile.uploadedAt ? sourceFile.uploadedAt.slice(0, 10) : "—"}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">{fmtUnits(sourceFile.importableRows)}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums text-slate-700">{fmtUnits(sourceFile.totalQty)}</td>
                        <td className="px-3 py-2.5 text-right font-black tabular-nums text-slate-900">{formatEgp(sourceFile.totalValue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </SectionCard>
      ) : null}
    </div>
  );
}
