"use client";

import * as React from "react";
import { CheckCircle2, FileUp, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

// Sales Operations upload workspace. Analyze (dry-run) → preview + strict validation → Import (commit).
// Same engine + validator both stages (server-enforced); nothing persists with unmapped rows, errors,
// or unacknowledged warnings. In diagnosticsOnly mode the Import action is hidden (analyze only).

type Distributor = { code: string; name: string };

type Finding = { code: string; severity: "error" | "warning" | "info"; title: string; detail: string; count: number; fixHint?: string };
type ValidationReport = { ok: boolean; errorCount: number; warningCount: number; infoCount: number; findings: Finding[] };
type Reconciliation = { rowsRead: number; rowsCoded: number; rowsExcluded: number; rowsBlankKey: number; rowsBlocked: number; totalQty: number; totalValue: number };
type Preview = { period: string | null; summary: { fullyCoded: number; exceptions: number }; unknownProducts: { value: string; count: number }[]; unknownBricks: { value: string; count: number }[]; blockedCount: number };

type AnalyzeOk = { kind: "ok"; preview: Preview; reconciliation: Reconciliation; validation: ValidationReport; period: string | null; needsPeriod: boolean };
type AnalyzeBad = { kind: "header_error"; missingGroups: string[]; fingerprintWarning?: { likelyCode: string; likelyName: string } } | { kind: "coded_sheet" } | { kind: "error"; message: string };
type AnalyzeState = AnalyzeOk | AnalyzeBad;

const SEV_STYLE: Record<Finding["severity"], string> = {
  error: "border-[#FECACA] bg-[#FEF2F2] text-[#B91C1C]",
  warning: "border-[#FED7AA] bg-[#FFF7ED] text-[#9A3412]",
  info: "border-[#E2E8F0] bg-[#F8FAFC] text-[#475569]",
};

export function SalesOpsUploadWorkspace({ distributors, diagnosticsOnly = false }: { distributors: Distributor[]; diagnosticsOnly?: boolean }) {
  const [distributorCode, setDistributorCode] = React.useState(distributors[0]?.code ?? "");
  const [file, setFile] = React.useState<File | null>(null);
  const [period, setPeriod] = React.useState("");
  const [analyzing, setAnalyzing] = React.useState(false);
  const [committing, setCommitting] = React.useState(false);
  const [acknowledge, setAcknowledge] = React.useState(false);
  const [state, setState] = React.useState<AnalyzeState | null>(null);
  const [committed, setCommitted] = React.useState<{ batchId: string; period: string; importedRows: number } | null>(null);

  const analyze = async () => {
    if (!file || !distributorCode) return;
    setAnalyzing(true);
    setState(null);
    setCommitted(null);
    setAcknowledge(false);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("distributorCode", distributorCode);
      if (period.trim()) form.set("period", period.trim());
      const res = await fetch("/api/sales-operations/upload/analyze", { method: "POST", credentials: "same-origin", body: form });
      const body = await res.json();
      if (body?.code === "coded_sheet_detected") setState({ kind: "coded_sheet" });
      else if (body?.code === "header_validation_error") setState({ kind: "header_error", missingGroups: body.missingGroups ?? [], fingerprintWarning: body.fingerprintWarning ?? undefined });
      else if (!body?.success) setState({ kind: "error", message: body?.error ?? "Analyze failed." });
      else setState({ kind: "ok", preview: body.data, reconciliation: body.reconciliation, validation: body.validation, period: body.period, needsPeriod: body.needsPeriod });
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : "Analyze failed." });
    } finally {
      setAnalyzing(false);
    }
  };

  const commit = async () => {
    if (!file || !distributorCode) return;
    setCommitting(true);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("distributorCode", distributorCode);
      if (period.trim()) form.set("period", period.trim());
      if (acknowledge) form.set("acknowledgeWarnings", "true");
      const res = await fetch("/api/sales-operations/upload/commit", { method: "POST", credentials: "same-origin", body: form });
      const body = await res.json();
      if (body?.success) setCommitted({ batchId: body.batchId, period: body.period, importedRows: body.importedRows });
      else setState({ kind: "error", message: body?.error ?? "Import failed." });
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : "Import failed." });
    } finally {
      setCommitting(false);
    }
  };

  const ok = state?.kind === "ok" ? state : null;
  const canImport = !diagnosticsOnly && ok && ok.validation.errorCount === 0 && ok.preview.blockedCount === 0 && (ok.validation.warningCount === 0 || acknowledge) && !ok.needsPeriod;

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex flex-wrap items-end gap-3 border border-[#D8E0EA] bg-white p-3">
        <label className="flex flex-col gap-1 text-xs font-semibold text-[#475569]">
          Distributor
          <select className="h-9 min-w-[12rem] border border-[#E2E8F0] bg-white px-2 text-sm text-[#0F172A]" value={distributorCode} onChange={(e) => setDistributorCode(e.target.value)}>
            {distributors.map((d) => (
              <option key={d.code} value={d.code}>{d.code} · {d.name}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-[#475569]">
          Raw sheet (.xlsx)
          <input type="file" accept=".xlsx" className="text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-[#475569]">
          Period (YYYY-MM){ok?.needsPeriod ? <span className="text-[#B91C1C]"> required</span> : ""}
          <input className="h-9 w-32 border border-[#E2E8F0] bg-white px-2 text-sm text-[#0F172A]" placeholder="2026-04" value={period} onChange={(e) => setPeriod(e.target.value)} />
        </label>
        <button type="button" disabled={!file || !distributorCode || analyzing} onClick={analyze} className="inline-flex h-9 items-center gap-1 bg-[#020617] px-4 text-sm font-bold text-white disabled:opacity-50">
          {analyzing ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileUp className="h-4 w-4" />} Analyze
        </button>
      </div>

      {committed ? (
        <div className="flex items-center gap-2 border border-[#BBF7D0] bg-[#F0FDF4] px-3 py-2 text-sm text-[#15803D]">
          <CheckCircle2 className="h-4 w-4" /> Imported {committed.importedRows.toLocaleString()} rows for {committed.period} (batch {committed.batchId.slice(0, 8)}). The dashboard rollups were recomputed.
        </div>
      ) : null}

      {state?.kind === "error" ? <div className="border border-[#FECACA] bg-[#FEF2F2] px-3 py-2 text-sm text-[#B91C1C]">{state.message}</div> : null}
      {state?.kind === "coded_sheet" ? <div className="border border-[#FED7AA] bg-[#FFF7ED] px-3 py-2 text-sm text-[#9A3412]">This sheet is already coded — upload the raw distributor export instead.</div> : null}
      {state?.kind === "header_error" ? (
        <div className="border border-[#FED7AA] bg-[#FFF7ED] px-3 py-2 text-sm text-[#9A3412]">
          Sheet is missing required columns: <strong>{state.missingGroups.join(", ")}</strong>.
          {state.fingerprintWarning ? <span> This looks more like <strong>{state.fingerprintWarning.likelyName}</strong> ({state.fingerprintWarning.likelyCode}) — check the distributor.</span> : null}
        </div>
      ) : null}

      {ok ? (
        <div className="space-y-3">
          {/* Reconciliation receipt */}
          <div className="grid grid-cols-2 gap-px border border-[#E2E8F0] bg-[#E2E8F0] sm:grid-cols-4 lg:grid-cols-7">
            {[
              ["Rows read", ok.reconciliation.rowsRead],
              ["Coded", ok.reconciliation.rowsCoded],
              ["Blocked", ok.reconciliation.rowsBlocked],
              ["Excluded", ok.reconciliation.rowsExcluded],
              ["Blank-key", ok.reconciliation.rowsBlankKey],
              ["Total qty", ok.reconciliation.totalQty],
              ["Total value", Math.round(ok.reconciliation.totalValue).toLocaleString()],
            ].map(([label, value]) => (
              <div key={String(label)} className="bg-white px-3 py-2">
                <div className="text-[10px] font-bold uppercase tracking-wider text-[#94A3B8]">{label}</div>
                <div className="text-sm font-semibold text-[#0F172A]">{typeof value === "number" ? value.toLocaleString() : value}</div>
              </div>
            ))}
          </div>

          {/* Validation findings */}
          {ok.validation.findings.length > 0 ? (
            <div className="space-y-2">
              <div className="text-xs font-semibold text-[#475569]">
                Validation: {ok.validation.errorCount} error · {ok.validation.warningCount} warning · {ok.validation.infoCount} info
              </div>
              {ok.validation.findings.map((f) => (
                <div key={f.code} className={cn("border px-3 py-2 text-xs", SEV_STYLE[f.severity])}>
                  <div className="font-bold">[{f.severity}] {f.title}{f.count > 1 ? ` ×${f.count}` : ""}</div>
                  <div>{f.detail}</div>
                  {f.fixHint ? <div className="mt-0.5 italic opacity-80">{f.fixHint}</div> : null}
                </div>
              ))}
            </div>
          ) : null}

          {/* Commit */}
          {!diagnosticsOnly ? (
            <div className="flex flex-wrap items-center gap-3 border border-[#D8E0EA] bg-white p-3">
              {ok.preview.blockedCount > 0 ? (
                <span className="text-sm text-[#B91C1C]">{ok.preview.blockedCount} unmapped row(s) — map them before importing.</span>
              ) : ok.validation.warningCount > 0 ? (
                <label className="flex items-center gap-2 text-sm text-[#9A3412]">
                  <input type="checkbox" checked={acknowledge} onChange={(e) => setAcknowledge(e.target.checked)} />
                  I&rsquo;ve reviewed the {ok.validation.warningCount} warning(s) and want to import.
                </label>
              ) : (
                <span className="text-sm text-[#15803D]">Ready to import.</span>
              )}
              <button type="button" disabled={!canImport || committing} onClick={commit} className="inline-flex h-9 items-center gap-1 bg-[#F97316] px-4 text-sm font-bold text-white disabled:opacity-50">
                {committing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Import (replace {ok.period ?? period})
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
