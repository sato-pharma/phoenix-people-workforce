"use client";

import { Fragment, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

// ─────────────────────────────────────────────────────────────────────────────
// Phase 6 Targets workspace. Set targets per (area, product) for a line + month —
// by bulk Excel upload or by editing the grid inline — and see achievement vs the
// SoS actuals.
//
// EDIT vs VIEW: `canEdit` drives whether the write affordances render at all (bulk upload, template
// download, inline target inputs, Save edits, and the line-wide audit export). It is PRESENTATION
// ONLY — every write route still asserts `sales:import` server-side, so a tampered client gets a 403.
// Never move a write behind `canEdit` alone.
//
// Read-only callers: the District / Regional / National Sales Manager portal view
// (/employee-portals/targets) and the CEO on the admin page, both of which hold `sales:read` but not
// `sales:import`. `basePath` exists because the period/line picker navigates by URL and the portal
// surface lives at a different path than /sales/targets.
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

// `coveredActualValue` is the slice of `actualValue` that sits on a product with a target
// this month — the figure `achievementValue` actually divides. It is carried into the UI so
// the percentage is legible: without it the card shows an Actual and a Target that do not
// divide into the Achievement beside them, and the reader concludes the page is broken.
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
};

type UploadPreview = { totalRows: number; validRows: number; errors: Array<{ rowNumber: number; field: string; code: string; message: string }> };

type BreakdownLine = { brickName: string; distributorName: string; customerName: string; units: number; value: number };
type TrendPoint = { period: string; units: number; value: number };
type BreakdownState = { loading: boolean; rows: BreakdownLine[]; trend: TrendPoint[]; totalUnits: number; totalValue: number; error: string | null };

const money = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const price = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const fmtMoney = (value: number): string => money.format(Math.round(value));
const fmtPrice = (value: number | null): string => (value == null ? "—" : price.format(value));
const fmtPct = (value: number | null): string => (value == null ? "—" : `${Math.round(value * 100)}%`);

/**
 * The exact division behind a rolled-up percentage, for the `title` of the cell that shows it.
 * Hover-only on purpose: the region and DM cards are one line per row and the owner's standing
 * rule is that nothing wraps and nothing is truncated, so the arithmetic cannot live inline.
 */
const divisionHint = (covered: number, target: number): string =>
  target === 0 ? "No target loaded — not graded." : `${fmtMoney(covered)} graded / ${fmtMoney(target)} target`;

function achievementTone(value: number | null): string {
  if (value == null) return "text-muted-foreground";
  if (value >= 1) return "text-green-600 dark:text-green-400";
  if (value >= 0.8) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

const keyOf = (row: TargetGridRow): string => `${row.areaCode}|${row.productCode}`;

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
 * ONE implementation, rendered both by the desktop grid's `<td colSpan={9}>` and by the phone
 * card below it. Two copies would let the same expander show two different numbers, which is the
 * failure this module exists to prevent.
 *
 * The customer lines were a nested `<table>` until 2026-08-16. Inside a drill-down on a phone
 * there is nothing to scroll it sideways, so the customer NAME — the whole point of the panel —
 * was the column that ran off the screen. Rows are flex now, matching the brick and distributor
 * headers directly above them; the fixed number widths keep the desktop columns aligned.
 */
function SourceBreakdown({ detail, selectedPeriod }: { detail: BreakdownState; selectedPeriod: string }) {
  if (detail.loading) return <div className="text-xs text-muted-foreground">Loading source…</div>;
  if (detail.error) return <div className="text-xs text-red-600 dark:text-red-400">{detail.error}</div>;
  if (detail.rows.length === 0) return <div className="text-xs text-muted-foreground">No source rows.</div>;
  return (
    <div className="space-y-3">
      {detail.trend.length > 1 ? (
        <div className="rounded border p-2">
          <div className="mb-1 text-xs font-medium text-muted-foreground">Month-over-month (this area &amp; product)</div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums">
            {detail.trend.map((point) => (
              <span key={point.period} className={point.period === selectedPeriod ? "font-semibold" : "text-muted-foreground"}>
                {point.period}: {fmtMoney(point.value)}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      <div>
        <div className="mb-1 text-xs font-medium text-muted-foreground">
          Source of {fmtMoney(detail.totalValue)} EGP · {money.format(Math.round(detail.totalUnits))} units — brick → distributor → customer
        </div>
        <div className="max-h-96 space-y-2 overflow-y-auto pr-1">
          {groupSource(detail.rows).map((brick) => (
            <div key={brick.brickName} className="overflow-hidden rounded border">
              <div className="flex items-baseline justify-between gap-x-2 bg-muted/60 px-2 py-1 text-xs font-semibold">
                <span className="min-w-0">{brick.brickName}</span>
                <span className="shrink-0 tabular-nums">{money.format(Math.round(brick.units))} units · {fmtMoney(brick.value)} EGP</span>
              </div>
              {brick.distributors.map((dist, di) => (
                <div key={`${dist.distributorName}-${di}`} className="border-t">
                  <div className="flex items-baseline justify-between gap-x-2 bg-muted/25 px-2 py-1 text-xs font-medium">
                    <span className="min-w-0 pl-2">{dist.distributorName}</span>
                    <span className="shrink-0 tabular-nums">{money.format(Math.round(dist.units))} · {fmtMoney(dist.value)}</span>
                  </div>
                  {dist.customers.map((cust, ci) => (
                    <div
                      key={`${cust.customerName}-${ci}`}
                      className="flex items-baseline gap-x-3 border-t border-border/40 py-0.5 pl-6 pr-2 text-xs"
                    >
                      <span className="min-w-0 flex-1 text-muted-foreground">{cust.customerName}</span>
                      <span className="w-16 shrink-0 text-right tabular-nums">{money.format(Math.round(cust.units))}</span>
                      <span className="w-24 shrink-0 text-right tabular-nums">{fmtMoney(cust.value)}</span>
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

export function TargetsWorkspace(props: TargetsWorkspaceProps) {
  const router = useRouter();
  const canEdit = props.canEdit !== false;
  const basePath = props.basePath ?? "/sales/targets";
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

  /** Typing units auto-fills Target value = units × unit price. The value stays editable after. */
  const onUnitsChange = (row: TargetGridRow, raw: string) => {
    const key = keyOf(row);
    setUnitEdits((current) => ({ ...current, [key]: raw }));
    const units = Number(raw);
    if (row.unitPrice != null && raw !== "" && Number.isFinite(units)) {
      setEdits((current) => ({ ...current, [key]: String(Math.round(units * row.unitPrice!)) }));
    }
  };

  const onValueChange = (key: string, raw: string) => setEdits((current) => ({ ...current, [key]: raw }));

  return (
    <div className="space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Targets</h1>
        <p className="text-sm text-muted-foreground">
          One target per product, per area, per month. Targets attach to the area (a vacant area keeps its
          target; a new hire inherits it). Achievement is measured against the automatic Source-of-Sales closing.
        </p>
      </header>

      {/* Controls */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs font-medium">
          Line
          <select
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            value={props.selectedLine}
            onChange={(event) => navigate(event.target.value, props.selectedPeriod)}
          >
            {props.lines.map((line) => (
              <option key={line.code} value={line.code}>{line.label}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">
          Month
          <select
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            value={props.selectedPeriod}
            onChange={(event) => navigate(props.selectedLine, event.target.value)}
          >
            {props.periods.map((period) => (
              <option key={period} value={period}>{period}</option>
            ))}
          </select>
        </label>
        {canEdit ? (
          <a
            className="inline-flex h-9 items-center rounded-md border border-input px-3 text-sm font-medium hover:bg-accent"
            href={`/api/sales/targets/template?line=${encodeURIComponent(props.selectedLine)}`}
          >
            Download template
          </a>
        ) : null}
      </div>

      {/* Upload panel — authoring only. */}
      {canEdit ? (
        <Card className="space-y-3 p-4">
          <div className="text-sm font-semibold">Bulk upload</div>
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
            <div className="rounded-md border p-3 text-sm">
              <div>
                <span className="font-medium">{preview.validRows}</span> valid of {preview.totalRows} row(s)
                {preview.errors.length > 0 ? <span className="text-red-600 dark:text-red-400"> · {preview.errors.length} rejected</span> : null}
              </div>
              {preview.errors.length > 0 ? (
                <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto text-xs text-muted-foreground">
                  {preview.errors.slice(0, 50).map((issue, index) => (
                    <li key={`${issue.rowNumber}-${index}`}>Row {issue.rowNumber}: {issue.message}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </Card>
      ) : null}

      {message ? <div className="rounded-md border bg-muted/40 p-3 text-sm">{message}</div> : null}
      {props.error ? <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300">{props.error}</div> : null}

      {/* Roll-up summary */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="p-4">
          <div className="text-xs uppercase text-muted-foreground">Line total</div>
          {props.lineTotal ? (
            <div className="mt-1 space-y-0.5 text-sm">
              <div>Actual: <span className="font-semibold">{fmtMoney(props.lineTotal.actualValue)}</span></div>
              {/* Only shown when the two differ, so a fully-targeted line stays as terse as it was. */}
              {props.lineTotal.coveredActualValue !== props.lineTotal.actualValue ? (
                <>
                  <div className="whitespace-nowrap">Graded vs target: <span className="font-semibold">{fmtMoney(props.lineTotal.coveredActualValue)}</span></div>
                  <div className="whitespace-nowrap text-xs text-muted-foreground">Not graded (no target): {fmtMoney(props.lineTotal.actualValue - props.lineTotal.coveredActualValue)}</div>
                </>
              ) : null}
              <div>Target: <span className="font-semibold">{fmtMoney(props.lineTotal.targetValue)}</span></div>
              <div className={achievementTone(props.lineTotal.achievementValue)}>Achievement: <span className="font-semibold">{fmtPct(props.lineTotal.achievementValue)}</span></div>
            </div>
          ) : <div className="mt-1 text-sm text-muted-foreground">No data.</div>}
        </Card>
        <Card className="p-4">
          <div className="text-xs uppercase text-muted-foreground">By region</div>
          <div className="mt-1 max-h-40 space-y-1 overflow-y-auto text-sm">
            {props.byRegion.length === 0 ? <div className="text-muted-foreground">—</div> : props.byRegion.map((region) => (
              <div key={region.region} className="flex justify-between gap-2">
                <span>{region.region}</span>
                <span className={achievementTone(region.achievementValue)} title={divisionHint(region.coveredActualValue, region.targetValue)}>{fmtPct(region.achievementValue)}</span>
              </div>
            ))}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-xs uppercase text-muted-foreground">By DM</div>
          <div className="mt-1 max-h-40 space-y-1 overflow-y-auto text-sm">
            {props.byDm.length === 0 ? <div className="text-muted-foreground">—</div> : props.byDm.map((dm) => (
              <div key={dm.dmName} className="flex justify-between gap-2">
                <span>{dm.dmName}</span>
                <span className={achievementTone(dm.achievementValue)} title={divisionHint(dm.coveredActualValue, dm.targetValue)}>{fmtPct(dm.achievementValue)}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Grid */}
      <Card className="p-0">
        <div className="flex items-center justify-between border-b p-3">
          <div>
            <div className="text-sm font-semibold">Targets &amp; achievement — {props.lines.find((l) => l.code === props.selectedLine)?.label ?? props.selectedLine} · {props.selectedPeriod}</div>
            <div className="text-xs text-muted-foreground">Click a row to trace its sales to source (distributor &amp; brick).</div>
          </div>
          {canEdit ? (
            <div className="flex items-center gap-2">
              {/* Line-WIDE audit export (no area parameter, so there is nothing to scope) — stays
                  with the authoring roles. */}
              <a
                className="inline-flex h-8 items-center rounded-md border border-input px-3 text-xs font-medium hover:bg-accent"
                href={`/api/sales/targets/breakdown/export?line=${encodeURIComponent(props.selectedLine)}&period=${encodeURIComponent(props.selectedPeriod)}`}
              >
                Export audit (Excel)
              </a>
              <Button size="sm" disabled={editedKeys.length === 0 || busy !== null} onClick={saveEdits}>
                {busy === "save" ? "Saving…" : `Save edits${editedKeys.length ? ` (${editedKeys.length})` : ""}`}
              </Button>
            </div>
          ) : (
            <span className="rounded-full border border-input px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              View only
            </span>
          )}
        </div>
        {props.rows.length === 0 ? (
          <div className="p-6 text-sm text-muted-foreground">
            {canEdit
              ? "No targets or sales yet for this line and month. Download the template, fill it, and upload — or pick a month with loaded sales."
              : "No targets or sales for your territory in this line and month."}
          </div>
        ) : (
          <>
            {/* Phone: one card per area × product. A ten-column grid — four of them names, two of
                them editable inputs — cannot be read on a 375px screen, and this workspace is
                reachable from the portal by every DM, RM and NSM (read-only) as well as by the
                admin surface. Desktop keeps the full table below, per the owner's rule. */}
            <div className="max-h-[60vh] divide-y overflow-auto md:hidden">
              {props.rows.map((row) => {
                const view = viewRow(row);
                return (
                  <div className="p-3" key={view.key}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold">
                          {row.areaName || "—"}
                          {row.areaState === "vacant_will_hire" ? <Badge className="ml-1 align-middle">vacant</Badge> : null}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {row.productName || "—"} · {row.regionName ?? "—"}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Rep: {row.repName ?? "vacant"}
                        </div>
                      </div>
                      <div className={`shrink-0 text-right text-sm font-semibold tabular-nums ${achievementTone(view.liveAch)}`}>
                        {fmtPct(view.liveAch)}
                        <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Ach%</div>
                      </div>
                    </div>

                    <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs">
                      <div className="flex items-baseline gap-1.5">
                        <dt className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Actual</dt>
                        <dd className="font-semibold tabular-nums">{fmtMoney(row.actualValue)}</dd>
                      </div>
                      <div className="flex items-baseline gap-1.5">
                        <dt className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Unit price</dt>
                        <dd className="tabular-nums text-muted-foreground">{fmtPrice(row.unitPrice)}</dd>
                      </div>
                    </dl>

                    {canEdit ? (
                      <div className="mt-2 grid grid-cols-2 gap-2">
                        <label className="block">
                          <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Target units</span>
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
                          <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Target value</span>
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
                      <dl className="mt-1 flex flex-wrap gap-x-5 gap-y-1 text-xs">
                        <div className="flex items-baseline gap-1.5">
                          <dt className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Target units</dt>
                          <dd className="tabular-nums">{row.targetUnits == null ? "—" : row.targetUnits.toLocaleString("en-EG")}</dd>
                        </div>
                        <div className="flex items-baseline gap-1.5">
                          <dt className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Target value</dt>
                          <dd className="font-semibold tabular-nums">{row.targetValue == null ? "—" : fmtMoney(row.targetValue)}</dd>
                        </div>
                      </dl>
                    )}

                    {view.canDrill ? (
                      <button
                        type="button"
                        className="mt-2 rounded border px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-accent"
                        onClick={() => toggleBreakdown(row)}
                      >
                        {view.detail ? "▾ Hide source" : "▸ Show source"}
                      </button>
                    ) : null}
                    {view.detail ? (
                      <div className="mt-2 rounded bg-muted/30 p-2">
                        <SourceBreakdown detail={view.detail} selectedPeriod={props.selectedPeriod} />
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>

          <div className="hidden max-h-[60vh] overflow-auto md:block">
            <table className="w-full border-collapse text-sm" data-portal-desktop-table>
              <thead className="sticky top-0 bg-background">
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="w-6 p-2"></th>
                  <th className="p-2">Area</th>
                  <th className="p-2">Region</th>
                  <th className="p-2">Product</th>
                  <th className="p-2">Rep</th>
                  <th className="p-2 text-right">Actual</th>
                  <th className="p-2 text-right">Target units</th>
                  <th className="p-2 text-right">Unit price</th>
                  <th className="p-2 text-right">Target value</th>
                  <th className="p-2 text-right">Ach%</th>
                </tr>
              </thead>
              <tbody>
                {props.rows.map((row) => {
                  const { canDrill, detail, editValue, key, liveAch, unitValue } = viewRow(row);
                  return (
                    <Fragment key={key}>
                      <tr className="border-b hover:bg-muted/40">
                        <td className="p-2 align-middle">
                          {canDrill ? (
                            <button
                              type="button"
                              aria-label={detail ? "Hide source" : "Show source"}
                              className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent"
                              onClick={() => toggleBreakdown(row)}
                            >
                              {detail ? "▾" : "▸"}
                            </button>
                          ) : null}
                        </td>
                        <td className="p-2">
                          <span>{row.areaName || "—"}</span>
                          {row.areaState === "vacant_will_hire" ? <Badge className="ml-1 align-middle">vacant</Badge> : null}
                        </td>
                        <td className="p-2">{row.regionName ?? "—"}</td>
                        <td className="p-2">{row.productName || "—"}</td>
                        <td className="p-2">{row.repName ?? <span className="text-muted-foreground">vacant</span>}</td>
                        <td className="p-2 text-right tabular-nums">{fmtMoney(row.actualValue)}</td>
                        <td className="p-2 text-right">
                          {canEdit ? (
                            <Input
                              type="number"
                              inputMode="decimal"
                              className="h-8 w-24 text-right tabular-nums"
                              placeholder="units"
                              value={unitValue}
                              onChange={(event) => onUnitsChange(row, event.target.value)}
                            />
                          ) : (
                            <span className="tabular-nums">{row.targetUnits == null ? "—" : row.targetUnits.toLocaleString("en-EG")}</span>
                          )}
                        </td>
                        <td className="p-2 text-right tabular-nums text-muted-foreground">{fmtPrice(row.unitPrice)}</td>
                        <td className="p-2 text-right">
                          {canEdit ? (
                            <Input
                              type="number"
                              inputMode="decimal"
                              className="h-8 w-28 text-right tabular-nums"
                              placeholder="value"
                              value={editValue}
                              onChange={(event) => onValueChange(key, event.target.value)}
                            />
                          ) : (
                            <span className="tabular-nums">{row.targetValue == null ? "—" : fmtMoney(row.targetValue)}</span>
                          )}
                        </td>
                        <td className={`p-2 text-right tabular-nums ${achievementTone(liveAch)}`}>{fmtPct(liveAch)}</td>
                      </tr>
                      {detail ? (
                        <tr className="border-b bg-muted/30">
                          <td className="p-2" />
                          <td className="p-2" colSpan={9}>
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
      </Card>

      {/* Source files — provenance / paper trail. COMPANY-WIDE distributor-upload metadata (file
          names, who uploaded, totals across every line), so it is an authoring concern only and is
          hidden from the scoped read-only view. The portal page also passes an empty array, so this
          panel could never leak even if it did render. */}
      {!canEdit ? null : (
      <Card className="p-0">
        <button
          type="button"
          className="flex w-full items-center justify-between border-b p-3 text-left"
          onClick={() => setShowFiles((value) => !value)}
        >
          <div className="text-sm font-semibold">Source files this month — {props.sourceFiles.length} validated upload(s)</div>
          <span className="text-muted-foreground">{showFiles ? "▾" : "▸"}</span>
        </button>
        {showFiles ? (
          props.sourceFiles.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">No validated distributor files for {props.selectedPeriod}.</div>
          ) : (
            <>
            {/* Phone: cards. Seven columns, three of them free text (distributor, file name,
                uploader), is the widest table in this module — and a file name is exactly the
                value nobody may see truncated. Authoring-only, but it is still opened on a phone. */}
            <div className="max-h-80 divide-y overflow-auto md:hidden">
              {props.sourceFiles.map((sourceFile, index) => (
                <div className="p-3" key={`${sourceFile.fileName}-${index}`}>
                  <p className="text-sm font-semibold">{sourceFile.distributorName}</p>
                  <p className="break-all text-xs text-muted-foreground" dir="auto">{sourceFile.fileName}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {sourceFile.uploadedBy || "—"} · {sourceFile.uploadedAt ? sourceFile.uploadedAt.slice(0, 10) : "—"}
                  </p>
                  <dl className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1 text-xs">
                    <div className="flex items-baseline gap-1.5">
                      <dt className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Rows</dt>
                      <dd className="tabular-nums">{money.format(Math.round(sourceFile.importableRows))}</dd>
                    </div>
                    <div className="flex items-baseline gap-1.5">
                      <dt className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Units</dt>
                      <dd className="tabular-nums">{money.format(Math.round(sourceFile.totalQty))}</dd>
                    </div>
                    <div className="flex items-baseline gap-1.5">
                      <dt className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Value</dt>
                      <dd className="font-semibold tabular-nums">{fmtMoney(sourceFile.totalValue)}</dd>
                    </div>
                  </dl>
                </div>
              ))}
            </div>
            <div className="hidden max-h-80 overflow-auto md:block">
              <table className="w-full text-xs" data-portal-desktop-table>
                <thead className="sticky top-0 bg-background">
                  <tr className="border-b text-left uppercase text-muted-foreground">
                    <th className="p-2">Distributor</th>
                    <th className="p-2">File</th>
                    <th className="p-2">Uploaded by</th>
                    <th className="p-2">When</th>
                    <th className="p-2 text-right">Rows</th>
                    <th className="p-2 text-right">Units</th>
                    <th className="p-2 text-right">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {props.sourceFiles.map((sourceFile, index) => (
                    <tr key={`${sourceFile.fileName}-${index}`} className="border-b hover:bg-muted/40">
                      <td className="p-2">{sourceFile.distributorName}</td>
                      <td className="p-2">{sourceFile.fileName}</td>
                      <td className="p-2">{sourceFile.uploadedBy || "—"}</td>
                      <td className="p-2">{sourceFile.uploadedAt ? sourceFile.uploadedAt.slice(0, 10) : "—"}</td>
                      <td className="p-2 text-right tabular-nums">{money.format(Math.round(sourceFile.importableRows))}</td>
                      <td className="p-2 text-right tabular-nums">{money.format(Math.round(sourceFile.totalQty))}</td>
                      <td className="p-2 text-right tabular-nums">{fmtMoney(sourceFile.totalValue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </>
          )
        ) : null}
      </Card>
      )}
    </div>
  );
}
