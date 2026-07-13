"use client";

import { useMemo, useState } from "react";
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
  areaState: string | null;
  productCode: string;
  actualValue: number;
  targetValue: number | null;
  achievementValue: number | null;
  hasActual: boolean;
  repHrId: string | null;
  dmHrId: string | null;
};

export type RegionRollup = { region: string; actualValue: number; targetValue: number; achievementValue: number | null };
export type DmRollup = { dmHrId: string; actualValue: number; targetValue: number; achievementValue: number | null };
export type LineTotal = { actualValue: number; targetValue: number; achievementValue: number | null } | null;

export type TargetsWorkspaceProps = {
  lines: ReadonlyArray<{ code: string; label: string }>;
  periods: string[];
  selectedLine: string;
  selectedPeriod: string;
  rows: TargetGridRow[];
  lineTotal: LineTotal;
  byRegion: RegionRollup[];
  byDm: DmRollup[];
  error: string | null;
};

type UploadPreview = { totalRows: number; validRows: number; errors: Array<{ rowNumber: number; field: string; code: string; message: string }> };

const money = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const fmtMoney = (value: number): string => money.format(Math.round(value));
const fmtPct = (value: number | null): string => (value == null ? "—" : `${Math.round(value * 100)}%`);

function achievementTone(value: number | null): string {
  if (value == null) return "text-muted-foreground";
  if (value >= 1) return "text-green-600 dark:text-green-400";
  if (value >= 0.8) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

const keyOf = (row: TargetGridRow): string => `${row.areaCode}|${row.productCode}`;

export function TargetsWorkspace(props: TargetsWorkspaceProps) {
  const router = useRouter();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<UploadPreview | null>(null);
  const [busy, setBusy] = useState<null | "preview" | "commit" | "save">(null);
  const [message, setMessage] = useState<string | null>(null);

  const editedKeys = useMemo(() => Object.keys(edits), [edits]);

  function navigate(line: string, period: string) {
    setEdits({});
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
    const rows = editedKeys
      .map((key) => {
        const [areaCode, productCode] = key.split("|");
        const raw = edits[key];
        const value = raw === "" ? null : Number(raw);
        return { areaCode, productCode, targetValue: value };
      })
      .filter((row) => row.targetValue != null && Number.isFinite(row.targetValue) && row.targetValue >= 0);
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
              <div key={dm.dmHrId} className="flex justify-between gap-2">
                <span>{dm.dmHrId}</span>
                <span className={achievementTone(dm.achievementValue)}>{fmtPct(dm.achievementValue)}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Grid */}
      <Card className="p-0">
        <div className="flex items-center justify-between border-b p-3">
          <div className="text-sm font-semibold">Targets &amp; achievement — {props.selectedLine} · {props.selectedPeriod}</div>
          <Button size="sm" disabled={editedKeys.length === 0 || busy !== null} onClick={saveEdits}>
            {busy === "save" ? "Saving…" : `Save edits${editedKeys.length ? ` (${editedKeys.length})` : ""}`}
          </Button>
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
                  <th className="p-2">Area</th>
                  <th className="p-2">Region</th>
                  <th className="p-2">Product</th>
                  <th className="p-2">Rep</th>
                  <th className="p-2 text-right">Actual</th>
                  <th className="p-2 text-right">Target</th>
                  <th className="p-2 text-right">Ach%</th>
                </tr>
              </thead>
              <tbody>
                {props.rows.map((row) => {
                  const key = keyOf(row);
                  const editValue = edits[key] ?? (row.targetValue == null ? "" : String(row.targetValue));
                  const liveTarget = editValue === "" ? null : Number(editValue);
                  const liveAch = liveTarget && liveTarget !== 0 ? row.actualValue / liveTarget : null;
                  return (
                    <tr key={key} className="border-b hover:bg-muted/40">
                      <td className="p-2">
                        <span>{row.areaCode}</span>
                        <span className="ml-1 text-xs text-muted-foreground">{row.areaName}</span>
                        {row.areaState === "vacant_will_hire" ? <Badge className="ml-1 align-middle">vacant</Badge> : null}
                      </td>
                      <td className="p-2">{row.regionCode ?? "—"}</td>
                      <td className="p-2">{row.productCode}</td>
                      <td className="p-2">{row.repHrId ?? <span className="text-muted-foreground">vacant</span>}</td>
                      <td className="p-2 text-right tabular-nums">{fmtMoney(row.actualValue)}</td>
                      <td className="p-2 text-right">
                        <Input
                          type="number"
                          inputMode="decimal"
                          className="h-8 w-28 text-right tabular-nums"
                          value={editValue}
                          onChange={(event) => setEdits((current) => ({ ...current, [key]: event.target.value }))}
                        />
                      </td>
                      <td className={`p-2 text-right tabular-nums ${achievementTone(liveAch)}`}>{fmtPct(liveAch)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
