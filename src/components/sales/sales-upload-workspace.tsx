"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, FileText, Loader2, Search, UploadCloud, XCircle } from "lucide-react";

import { AdminCallout, AdminPageHero } from "@/components/admin/admin-design-system";
import { DistributorWorkspaceShell } from "@/components/sales/distributor-workspace-shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { DistributorProfileSummary, SalesDistributorEntry } from "@/lib/sales/distributor-registry";
import { cn } from "@/lib/utils";

type Props = {
  distributors: SalesDistributorEntry[];
  summaries: Record<string, DistributorProfileSummary>;
};

type Reconciliation = { rowsRead: number; rowsCoded: number; rowsIgnored: number; rowsBlankCustomer: number; rowsBlocked: number; totalQty: number; totalValue: number };
type Preview = { summary: { totalRows: number; fullyCoded: number }; unknownProducts: unknown[]; unknownTerritories: unknown[]; unknownCustomers: unknown[]; period: string | null };
type AnalyzeResponse = { success: boolean; data?: Preview; reconciliation?: Reconciliation; needsPeriod?: boolean; error?: string; code?: string; missingGroups?: { label: string; expected: string[] }[]; fingerprintWarning?: { likelyCode: string; likelyName: string } | null };
type CommitResponse = { success: boolean; message?: string; error?: string; importedRows?: number; period?: string | null; reconciliation?: Reconciliation; data?: Preview; code?: string };

const panel = "rounded-2xl border border-[#D8E0EA] bg-white/95 shadow-[0_8px_22px_rgba(15,23,42,0.06)]";

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  try { return JSON.parse(text) as T; } catch { return { success: false, error: text } as unknown as T; }
}

function ProfileViewer({ summary }: { summary?: DistributorProfileSummary }) {
  if (!summary) {
    return <AdminCallout tone="neutral"><span>No recognition profile for this distributor yet. Set one up in <Link className="font-semibold text-[#F97316] underline" href="/sales/database-mapping">Master Data &amp; Profiles</Link>.</span></AdminCallout>;
  }
  const rows: { label: string; value: string[] }[] = [
    { label: "Product", value: summary.productColumns },
    { label: "Quantity", value: summary.quantityColumns },
    { label: "Date", value: summary.dateColumns },
    { label: "Customer code", value: summary.customerCodeColumns },
    { label: "Customer name", value: summary.customerNameColumns },
    { label: "Territory", value: summary.territoryColumns },
    { label: "Discount", value: summary.discountColumns },
  ];
  return (
    <div className="rounded-xl border border-[#E2E8F0]">
      <div className="border-b border-[#E2E8F0] px-4 py-2 text-xs font-black uppercase tracking-[0.14em] text-[#64748B]">What the system reads in this distributor&apos;s file</div>
      <table className="w-full text-sm">
        <tbody>
          {rows.map((r) => (
            <tr className="border-b border-[#F1F5F9] last:border-0" key={r.label}>
              <td className="w-40 px-4 py-1.5 font-semibold text-[#0F172A]">{r.label}</td>
              <td className="px-4 py-1.5 font-mono text-xs text-[#64748B]">{r.value.length ? r.value.join(", ") : <span className="italic text-[#94A3B8]">—</span>}</td>
            </tr>
          ))}
          <tr>
            <td className="px-4 py-1.5 font-semibold text-[#0F172A]">Value</td>
            <td className="px-4 py-1.5 text-xs text-[#64748B]">{summary.valueSource === "sheet" ? "taken from the sheet" : "recomputed from master price"}{summary.hasDateColumn ? "" : " · no date column — pick a period"}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function ReceiptChips({ r }: { r: Reconciliation }) {
  const chip = (label: string, value: number, tone: string) => (
    <span className={cn("rounded-full border px-3 py-1 text-xs font-bold", tone)}>{label}: {value.toLocaleString()}</span>
  );
  return (
    <div className="flex flex-wrap gap-2">
      {chip("Rows read", r.rowsRead, "border-[#E2E8F0] bg-[#FCFDFE] text-[#0F172A]")}
      {chip("Coded", r.rowsCoded, "border-[#BBF7D0] bg-[#F0FDF4] text-[#166534]")}
      {r.rowsIgnored ? chip("Ignored", r.rowsIgnored, "border-[#E2E8F0] bg-[#FCFDFE] text-[#64748B]") : null}
      {r.rowsBlankCustomer ? chip("Blank", r.rowsBlankCustomer, "border-[#E2E8F0] bg-[#FCFDFE] text-[#64748B]") : null}
      {r.rowsBlocked ? chip("Blocked", r.rowsBlocked, "border-rose-200 bg-rose-50 text-rose-700") : null}
    </div>
  );
}

function MonthlyUpload({ distributorCode, hasProfile, hasDateColumn }: { distributorCode: string; hasProfile: boolean; hasDateColumn: boolean }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [period, setPeriod] = useState("");
  const [busy, setBusy] = useState<"analyze" | "commit" | null>(null);
  const [analysis, setAnalysis] = useState<AnalyzeResponse | null>(null);
  const [committed, setCommitted] = useState<CommitResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const unknowns = analysis?.data ? analysis.data.unknownProducts.length + analysis.data.unknownTerritories.length + analysis.data.unknownCustomers.length : 0;
  const canImport = analysis?.success && unknowns === 0 && (!analysis.needsPeriod || /^\d{4}-\d{2}$/.test(period));

  async function analyze() {
    if (!file) { setError("Choose a file first."); return; }
    setBusy("analyze"); setError(null); setAnalysis(null); setCommitted(null);
    try {
      const fd = new FormData(); fd.append("file", file); fd.append("distributorCode", distributorCode);
      const res = await fetch("/api/sales/sales-upload/analyze", { method: "POST", body: fd });
      const payload = await readJson<AnalyzeResponse>(res);
      setAnalysis(payload);
      if (!payload.success) setError(payload.error ?? "Analysis failed.");
    } catch (e) { setError(e instanceof Error ? e.message : "Analysis failed."); }
    finally { setBusy(null); }
  }

  async function commit() {
    if (!file) return;
    setBusy("commit"); setError(null);
    try {
      const fd = new FormData(); fd.append("file", file); fd.append("distributorCode", distributorCode); if (period) fd.append("period", period);
      const res = await fetch("/api/sales/sales-upload/commit", { method: "POST", body: fd });
      const payload = await readJson<CommitResponse>(res);
      setCommitted(payload);
      if (!payload.success) setError(payload.error ?? "Import failed.");
    } catch (e) { setError(e instanceof Error ? e.message : "Import failed."); }
    finally { setBusy(null); }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-black uppercase tracking-[0.12em] text-[#94A3B8]">Period{hasDateColumn ? " (optional)" : " (required)"}</span>
          <input className="h-9 rounded-[6px] border border-[#E2E8F0] px-2 text-sm" onChange={(e) => setPeriod(e.target.value)} type="month" value={period} />
        </label>
        <Button className="h-9 gap-2 bg-[#0B0B0B] font-black text-white hover:bg-[#F97316]" disabled={!hasProfile} onClick={() => fileRef.current?.click()} type="button">
          <FileText className="h-4 w-4" />{file ? file.name.slice(0, 28) : "Choose raw sheet"}
        </Button>
        <input accept=".xlsx" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) { setFile(f); setAnalysis(null); setCommitted(null); } }} ref={fileRef} type="file" />
        <Button className="h-9 gap-2" disabled={!file || busy !== null || !hasProfile} onClick={() => void analyze()} type="button" variant="secondary">
          {busy === "analyze" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}Analyze
        </Button>
      </div>

      {error ? <AdminCallout tone="danger"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span></AdminCallout> : null}

      {analysis?.code === "header_validation_error" ? (
        <AdminCallout tone="danger"><XCircle className="mt-0.5 h-4 w-4 shrink-0" /><div>
          <p className="font-semibold">Wrong or mismatched sheet.</p>
          {analysis.fingerprintWarning ? <p className="text-xs">Looks more like {analysis.fingerprintWarning.likelyName} ({analysis.fingerprintWarning.likelyCode}). Did you pick the right distributor?</p> : null}
        </div></AdminCallout>
      ) : null}

      {analysis?.success && analysis.reconciliation ? (
        <div className="space-y-2 rounded-xl border border-[#E2E8F0] p-3">
          <ReceiptChips r={analysis.reconciliation} />
          {unknowns > 0 ? (
            <AdminCallout tone="warning"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><div>
              <p className="font-semibold">{unknowns} unmapped item(s) — import is blocked until they&apos;re mapped.</p>
              <p className="text-xs">Map them in <Link className="font-semibold text-[#C2410C] underline" href="/sales/mapping-database">Mapping Database</Link>, then re-analyze.</p>
            </div></AdminCallout>
          ) : analysis.needsPeriod && !/^\d{4}-\d{2}$/.test(period) ? (
            <AdminCallout tone="neutral"><span>This sheet has no date column — pick a period above to import.</span></AdminCallout>
          ) : (
            <AdminCallout tone="success"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /><span>Everything is recognized — ready to import.</span></AdminCallout>
          )}
          <Button className="h-9 gap-2 bg-[#F97316] font-black text-white hover:bg-[#EA6A0C]" disabled={!canImport || busy !== null} onClick={() => void commit()} type="button">
            {busy === "commit" ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}Import
          </Button>
        </div>
      ) : null}

      {committed?.success ? (
        <AdminCallout tone="success"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /><span>{committed.message} (any earlier upload for {committed.period} was replaced — no double count.)</span></AdminCallout>
      ) : null}
      {committed && !committed.success && committed.reconciliation ? (
        <AdminCallout tone="danger"><XCircle className="mt-0.5 h-4 w-4 shrink-0" /><span>{committed.error}</span></AdminCallout>
      ) : null}
    </div>
  );
}

function WeeklyUpload({ distributorCode }: { distributorCode: string }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File) {
    setBusy(true); setMsg(null); setError(null);
    try {
      const fd = new FormData(); fd.append("file", file); fd.append("distributorCode", distributorCode);
      const res = await fetch("/api/sales/weekly/validate", { method: "POST", body: fd });
      const payload = await readJson<{ success?: boolean; status?: string; message?: string; error?: string }>(res);
      if (payload.error) setError(payload.error);
      else setMsg(payload.message ?? "Weekly sheet processed.");
    } catch (e) { setError(e instanceof Error ? e.message : "Weekly upload failed."); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  }

  return (
    <div className="space-y-2">
      <Button className="h-9 gap-2 bg-[#0B0B0B] font-black text-white hover:bg-[#F97316]" disabled={busy} onClick={() => fileRef.current?.click()} type="button">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}Upload weekly sheet
      </Button>
      <input accept=".xlsx" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} ref={fileRef} type="file" />
      {msg ? <AdminCallout tone="success"><span>{msg}</span></AdminCallout> : null}
      {error ? <AdminCallout tone="danger"><span>{error}</span></AdminCallout> : null}
    </div>
  );
}

function DistributorUpload({ selected, summary }: { selected: SalesDistributorEntry; summary?: DistributorProfileSummary }) {
  return (
    <div className="space-y-4">
      <Card className={cn(panel, "space-y-3 p-5")}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-black tracking-tight text-slate-900">{selected.name} <span className="font-mono text-sm text-[#94A3B8]">{selected.code}</span></h2>
            <p className="text-xs text-[#64748B]">{selected.monthlySupported ? "Monthly ✓" : "No monthly profile"}{selected.weeklySupported ? " · Weekly ✓" : ""}</p>
          </div>
          <a className="inline-flex h-9 items-center gap-2 rounded-[6px] border border-[#D8E0EA] bg-white px-3 text-sm font-bold text-[#0F172A] transition hover:border-[#F97316] hover:text-[#F97316]" href={`/api/sales/source-of-sales/raw-template?distributor=${encodeURIComponent(selected.code)}`}>
            <Download className="h-4 w-4" />Emergency template
          </a>
        </div>
        <ProfileViewer summary={summary} />
      </Card>

      <Card className={cn(panel, "space-y-3 p-5")}>
        <h3 className="text-base font-black tracking-tight text-slate-950">Upload Monthly Sales</h3>
        <MonthlyUpload distributorCode={selected.code} hasDateColumn={summary?.hasDateColumn ?? true} hasProfile={Boolean(summary)} />
      </Card>

      {selected.weeklySupported ? (
        <Card className={cn(panel, "space-y-3 p-5")}>
          <h3 className="text-base font-black tracking-tight text-slate-950">Upload Weekly Sales</h3>
          <WeeklyUpload distributorCode={selected.code} />
        </Card>
      ) : null}
    </div>
  );
}

export function SalesUploadWorkspace({ distributors, summaries }: Props) {
  return (
    <div className="space-y-5">
      <AdminPageHero
        description="The single upload hub. Pick a distributor, analyze its raw sheet, then import — the analyzer and the importer use the exact same engine, so what's recognized always imports."
        eyebrow="Sales · One connected module"
        icon={<UploadCloud className="h-4 w-4" />}
        title="Sales Upload"
      />
      <DistributorWorkspaceShell distributors={distributors}>
        {(selected) => <DistributorUpload selected={selected} summary={summaries[selected.code]} />}
      </DistributorWorkspaceShell>
    </div>
  );
}
