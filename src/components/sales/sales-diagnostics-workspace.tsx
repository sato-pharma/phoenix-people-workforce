"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, FileText, Loader2, Stethoscope, XCircle } from "lucide-react";

import { AdminCallout, AdminPageHero } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type { SalesDistributorEntry } from "@/lib/sales/distributor-registry";
import { importDiagnosticsVerdict } from "@/lib/sales/import-diagnostics-verdict";
import { cn } from "@/lib/utils";

type Props = { distributors: SalesDistributorEntry[] };

type Detection = {
  ambiguous: boolean;
  confidence: "high" | "low" | "none";
  best: { distributorCode: string; distributorName: string; score: number } | null;
  matches: { distributorCode: string; distributorName: string; score: number; matchedRequired: number; requiredTotal: number }[];
};
type Reconciliation = { rowsRead: number; rowsCoded: number; rowsBlocked: number; totalQty: number; totalValue: number };
type Preview = { summary: { totalRows: number; fullyCoded: number }; unknownProducts: unknown[]; unknownTerritories: unknown[]; unknownCustomers: unknown[] };
type ProfileSummary = { productColumns: string[]; quantityColumns: string[]; dateColumns: string[]; customerCodeColumns: string[]; territoryColumns: string[]; valueSource: string; hasDateColumn: boolean };
type Severity = "error" | "warning" | "info";
type Finding = { code: string; severity: Severity; title: string; detail: string };
type ValidationReport = { ok: boolean; errorCount: number; warningCount: number; infoCount: number; findings: Finding[] };
type AnalyzeResult =
  | { status: "ok"; preview: Preview; reconciliation: Reconciliation; period: string | null; needsPeriod: boolean; validation?: ValidationReport }
  | { status: "header_error"; distributorName: string; missingGroups: { label: string; expected: string[] }[] }
  | { status: "coded_sheet"; distributorName: string };
type Diag = { detection: Detection; chosenDistributor: string | null; profileSummary: ProfileSummary | null; analyze: AnalyzeResult | null };
type Resp = { success: boolean; data?: Diag; error?: string };

const panel = "rounded-2xl border border-phx-line bg-white/95 shadow-[0_8px_22px_rgba(15,23,42,0.06)]";

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  try { return JSON.parse(text) as T; } catch { return { success: false, error: text } as unknown as T; }
}

export function SalesDiagnosticsWorkspace({ distributors }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [override, setOverride] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Diag | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!file) { setError("Choose a file first."); return; }
    setBusy(true); setError(null); setResult(null);
    try {
      const fd = new FormData(); fd.append("file", file); if (override) fd.append("distributor", override);
      const res = await fetch("/api/sales/diagnostics", { method: "POST", body: fd });
      const payload = await readJson<Resp>(res);
      if (!payload.success || !payload.data) { setError(payload.error ?? "Diagnostics failed."); return; }
      setResult(payload.data);
    } catch (e) { setError(e instanceof Error ? e.message : "Diagnostics failed."); }
    finally { setBusy(false); }
  }

  const analyze = result?.analyze;
  const unknowns = analyze?.status === "ok" ? analyze.preview.unknownProducts.length + analyze.preview.unknownTerritories.length + analyze.preview.unknownCustomers.length : 0;
  // Strict-check errors are rendered further down but used to have no say in the verdict banner, so
  // a file with errors and no unmapped items was told it "would import cleanly".
  const verdict = importDiagnosticsVerdict({
    unmappedCount: unknowns,
    strictErrorCount: analyze?.status === "ok" ? (analyze.validation?.errorCount ?? 0) : 0,
  });

  return (
    <div className="space-y-5">
      <AdminPageHero
        description="Upload any file to see what the system would do — detected distributor, the profile it uses, recognition coverage, unknown items, expected totals and the strict checks. Reads every worksheet, is Arabic-aware, and flags a wrong-distributor pick. Nothing is imported."
        eyebrow="Sales · One connected module"
        icon={<Stethoscope className="h-4 w-4" />}
        title="Sales Diagnostics"
      />

      <Card className={cn(panel, "space-y-3 p-5")}>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-phx-sm font-black uppercase tracking-[0.12em] text-phx-ink-faint">Force distributor (optional)</span>
            <div className="w-56"><SearchableSelect onValueChange={setOverride} placeholder="auto-detect" value={override}>
              <option value="">Auto-detect</option>
              {distributors.map((d) => <option key={d.code} value={d.code}>{d.name} ({d.code})</option>)}
            </SearchableSelect></div>
          </label>
          <Button className="h-9 gap-2 bg-[#0B0B0B] font-black text-white hover:bg-phx-accent" onClick={() => fileRef.current?.click()} type="button">
            <FileText className="h-4 w-4" />{file ? file.name.slice(0, 28) : "Choose file"}
          </Button>
          <input accept=".xlsx" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) { setFile(f); setResult(null); } }} ref={fileRef} type="file" />
          <Button className="h-9 gap-2 bg-phx-accent font-black text-white hover:bg-[#EA6A0C]" disabled={!file || busy} onClick={() => void run()} type="button">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Stethoscope className="h-4 w-4" />}Diagnose
          </Button>
        </div>
        {error ? <AdminCallout tone="danger"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span></AdminCallout> : null}
      </Card>

      {result ? (
        <Card className={cn(panel, "space-y-4 p-5")}>
          <div>
            <h3 className="text-sm font-black uppercase tracking-[0.14em] text-phx-ink-soft">Detection</h3>
            <p className="mt-1 text-sm">
              {result.detection.best
                ? <>Best match: <b>{result.detection.best.distributorName}</b> ({result.detection.best.distributorCode}) · confidence <b className={result.detection.confidence === "high" ? "text-emerald-600" : "text-amber-600"}>{result.detection.confidence}</b>{result.detection.ambiguous ? " · ambiguous" : ""}</>
                : "No distributor matched this file's headers."}
              {result.chosenDistributor ? <> · analyzed as <b>{result.chosenDistributor}</b></> : null}
            </p>
            {result.detection.matches.length > 1 ? (
              <div className="mt-2 flex flex-wrap gap-2 text-xs">
                {result.detection.matches.slice(0, 5).map((m) => (
                  <span className="rounded-full border border-phx-line bg-[#FCFDFE] px-3 py-1 text-phx-ink" key={m.distributorCode}>{m.distributorCode}: {m.matchedRequired}/{m.requiredTotal} req</span>
                ))}
              </div>
            ) : null}
          </div>

          {result.profileSummary ? (
            <div className="rounded-xl border border-phx-line p-3 text-xs text-phx-ink-soft">
              <span className="font-bold text-phx-ink">Profile used:</span> product [{result.profileSummary.productColumns.join(", ") || "—"}] · qty [{result.profileSummary.quantityColumns.join(", ") || "—"}] · date [{result.profileSummary.dateColumns.join(", ") || "—"}] · customer [{result.profileSummary.customerCodeColumns.join(", ") || "—"}] · value {result.profileSummary.valueSource}
            </div>
          ) : null}

          {analyze?.status === "header_error" ? (
            <AdminCallout tone="danger"><XCircle className="mt-0.5 h-4 w-4 shrink-0" /><span>Header validation would fail — missing: {analyze.missingGroups.map((g) => g.label).join(", ")}.</span></AdminCallout>
          ) : analyze?.status === "coded_sheet" ? (
            <AdminCallout tone="warning"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>This sheet looks already-coded. Upload the raw distributor export instead.</span></AdminCallout>
          ) : analyze?.status === "ok" ? (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2 text-xs font-bold">
                <span className="rounded-full border border-[#BBF7D0] bg-[#F0FDF4] px-3 py-1 text-[#166534]">{analyze.reconciliation.rowsRead ? Math.round((analyze.reconciliation.rowsCoded / analyze.reconciliation.rowsRead) * 100) : 0}% recognized</span>
                <span className="rounded-full border border-phx-line bg-[#FCFDFE] px-3 py-1 text-phx-ink">{analyze.reconciliation.rowsRead} rows</span>
                <span className="rounded-full border border-phx-line bg-[#FCFDFE] px-3 py-1 text-phx-ink">qty {analyze.reconciliation.totalQty.toLocaleString()}</span>
                <span className="rounded-full border border-phx-line bg-[#FCFDFE] px-3 py-1 text-phx-ink">value {Math.round(analyze.reconciliation.totalValue).toLocaleString()}</span>
                {unknowns > 0 ? <span className="rounded-full border border-rose-200 bg-rose-50 px-3 py-1 text-rose-700">{unknowns} unmapped</span> : null}
              </div>
              {/* The green verdict needs BOTH clean. Strict-check errors used to be rendered only in
                  the box below and had no say here, so a file with zero unmapped items and a dozen
                  errors was told it "would import cleanly". */}
              {verdict === "danger" ? (
                <AdminCallout tone="danger"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{analyze.validation?.errorCount} strict-check error(s) — this file would NOT import cleanly. See Strict checks below.</span></AdminCallout>
              ) : verdict === "warning" ? (
                <AdminCallout tone="warning"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{unknowns} unmapped item(s) would block import. Fix them in <Link className="font-semibold text-phx-accent-press underline" href="/sales/mapping-database">Mapping Database</Link>.</span></AdminCallout>
              ) : (
                <AdminCallout tone="success"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /><span>Fully recognized — this file would import cleanly{analyze.needsPeriod ? " (pick a period — no date column)" : ""}.</span></AdminCallout>
              )}
              {analyze.validation ? (
                <div className="rounded-xl border border-phx-line p-3">
                  <div className="flex items-center gap-2 text-xs font-bold">
                    <span className="uppercase tracking-[0.12em] text-phx-ink-soft">Strict checks</span>
                    <span className="ml-auto flex gap-2">
                      <span className={cn("rounded-full border px-2 py-0.5", analyze.validation.errorCount > 0 ? "border-rose-200 bg-rose-50 text-rose-700" : "border-phx-line bg-[#FCFDFE] text-phx-ink-soft")}>{analyze.validation.errorCount} error</span>
                      <span className={cn("rounded-full border px-2 py-0.5", analyze.validation.warningCount > 0 ? "border-amber-200 bg-amber-50 text-amber-800" : "border-phx-line bg-[#FCFDFE] text-phx-ink-soft")}>{analyze.validation.warningCount} warning</span>
                    </span>
                  </div>
                  {analyze.validation.findings.filter((f) => f.severity !== "info").length > 0 ? (
                    <ul className="mt-2 space-y-1">
                      {analyze.validation.findings.filter((f) => f.severity !== "info").map((f) => (
                        <li className="text-xs" key={f.code}>
                          <span className={cn("font-bold", f.severity === "error" ? "text-rose-700" : "text-amber-800")}>{f.title}</span>
                          <span className="text-phx-ink-soft"> — {f.detail}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-1 text-xs font-semibold text-[#16A34A]">No blocking errors or warnings.</p>
                  )}
                </div>
              ) : null}
            </div>
          ) : (
            <AdminCallout tone="neutral"><span>No distributor could be analyzed. Try forcing one above.</span></AdminCallout>
          )}
        </Card>
      ) : null}
    </div>
  );
}
