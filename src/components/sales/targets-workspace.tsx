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
// SoS actuals. Edit access is gated server-side (Super Admin + SFE Manager); this
// component is only rendered when the caller may edit.
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

export type RegionRollup = { region: string; actualValue: number; targetValue: number; achievementValue: number | null };
export type DmRollup = { dmName: string; actualValue: number; targetValue: number; achievementValue: number | null };
export type LineTotal = { actualValue: number; targetValue: number; achievementValue: number | null } | null;
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

export function TargetsWorkspace(props: TargetsWorkspaceProps) {
  const router = useRouter();
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
    router.push(`/sales/targets?line=${encodeURIComponent(line)}&period=${encodeURIComponent(period)}`);
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
        <a
          className="inline-flex h-9 items-center rounded-md border border-input px-3 text-sm font-medium hover:bg-accent"
          href={`/api/sales/targets/template?line=${encodeURIComponent(props.selectedLine)}`}
        >
          Download template
        </a>
      </div>

      {/* Upload panel */}
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

      {message ? <div className="rounded-md border bg-muted/40 p-3 text-sm">{message}</div> : null}
      {props.error ? <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300">{props.error}</div> : null}

      {/* Roll-up summary */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="p-4">
          <div className="text-xs uppercase text-muted-foreground">Line total</div>
          {props.lineTotal ? (
            <div className="mt-1 space-y-0.5 text-sm">
              <div>Actual: <span className="font-semibold">{fmtMoney(props.lineTotal.actualValue)}</span></div>
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
                <span className={achievementTone(region.achievementValue)}>{fmtPct(region.achievementValue)}</span>
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
                <span className={achievementTone(dm.achievementValue)}>{fmtPct(dm.achievementValue)}</span>
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
          <div className="flex items-center gap-2">
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
        </div>
        {props.rows.length === 0 ? (
          <div className="p-6 text-sm text-muted-foreground">
            No targets or sales yet for this line and month. Download the template, fill it, and upload — or pick a month with loaded sales.
          </div>
        ) : (
          <div className="max-h-[60vh] overflow-auto">
            <table className="w-full border-collapse text-sm">
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
                  const key = keyOf(row);
                  const editValue = edits[key] ?? (row.targetValue == null ? "" : String(row.targetValue));
                  const unitValue = unitEdits[key] ?? (row.targetUnits == null ? "" : String(row.targetUnits));
                  const liveTarget = editValue === "" ? null : Number(editValue);
                  const liveAch = liveTarget && liveTarget !== 0 ? row.actualValue / liveTarget : null;
                  const canDrill = row.actualValue !== 0;
                  const detail = expanded[key];
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
                          <Input
                            type="number"
                            inputMode="decimal"
                            className="h-8 w-24 text-right tabular-nums"
                            placeholder="units"
                            value={unitValue}
                            onChange={(event) => {
                              const raw = event.target.value;
                              setUnitEdits((current) => ({ ...current, [key]: raw }));
                              // Auto-fill Target value = units × unit price (still editable below).
                              const units = Number(raw);
                              if (row.unitPrice != null && raw !== "" && Number.isFinite(units)) {
                                setEdits((current) => ({ ...current, [key]: String(Math.round(units * row.unitPrice!)) }));
                              }
                            }}
                          />
                        </td>
                        <td className="p-2 text-right tabular-nums text-muted-foreground">{fmtPrice(row.unitPrice)}</td>
                        <td className="p-2 text-right">
                          <Input
                            type="number"
                            inputMode="decimal"
                            className="h-8 w-28 text-right tabular-nums"
                            placeholder="value"
                            value={editValue}
                            onChange={(event) => setEdits((current) => ({ ...current, [key]: event.target.value }))}
                          />
                        </td>
                        <td className={`p-2 text-right tabular-nums ${achievementTone(liveAch)}`}>{fmtPct(liveAch)}</td>
                      </tr>
                      {detail ? (
                        <tr className="border-b bg-muted/30">
                          <td className="p-2" />
                          <td className="p-2" colSpan={9}>
                            {detail.loading ? (
                              <div className="text-xs text-muted-foreground">Loading source…</div>
                            ) : detail.error ? (
                              <div className="text-xs text-red-600 dark:text-red-400">{detail.error}</div>
                            ) : detail.rows.length === 0 ? (
                              <div className="text-xs text-muted-foreground">No source rows.</div>
                            ) : (
                              <div className="space-y-3">
                                {detail.trend.length > 1 ? (
                                  <div className="rounded border p-2">
                                    <div className="mb-1 text-xs font-medium text-muted-foreground">Month-over-month (this area &amp; product)</div>
                                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums">
                                      {detail.trend.map((point) => (
                                        <span key={point.period} className={point.period === props.selectedPeriod ? "font-semibold" : "text-muted-foreground"}>
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
                                        <div className="flex items-center justify-between bg-muted/60 px-2 py-1 text-xs font-semibold">
                                          <span>{brick.brickName}</span>
                                          <span className="tabular-nums">{money.format(Math.round(brick.units))} units · {fmtMoney(brick.value)} EGP</span>
                                        </div>
                                        {brick.distributors.map((dist, di) => (
                                          <div key={`${dist.distributorName}-${di}`} className="border-t">
                                            <div className="flex items-center justify-between bg-muted/25 px-2 py-1 text-xs font-medium">
                                              <span className="pl-2">{dist.distributorName}</span>
                                              <span className="tabular-nums">{money.format(Math.round(dist.units))} · {fmtMoney(dist.value)}</span>
                                            </div>
                                            <table className="w-full text-xs">
                                              <tbody>
                                                {dist.customers.map((cust, ci) => (
                                                  <tr key={`${cust.customerName}-${ci}`} className="border-t border-border/40">
                                                    <td className="py-0.5 pl-6 pr-3 text-muted-foreground">{cust.customerName}</td>
                                                    <td className="py-0.5 pr-3 text-right tabular-nums">{money.format(Math.round(cust.units))}</td>
                                                    <td className="py-0.5 pr-2 text-right tabular-nums">{fmtMoney(cust.value)}</td>
                                                  </tr>
                                                ))}
                                              </tbody>
                                            </table>
                                          </div>
                                        ))}
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              </div>
                            )}
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Source files — provenance / paper trail */}
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
            <div className="max-h-80 overflow-auto">
              <table className="w-full text-xs">
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
          )
        ) : null}
      </Card>
    </div>
  );
}
