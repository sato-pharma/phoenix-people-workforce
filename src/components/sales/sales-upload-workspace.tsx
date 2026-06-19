"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, FileText, Info, Loader2, Search, ShieldCheck, UploadCloud, XCircle } from "lucide-react";

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
type Severity = "error" | "warning" | "info";
type Finding = { code: string; severity: Severity; title: string; detail: string; count: number; sampleRows: number[]; fixHint?: string };
type ValidationReport = { ok: boolean; errorCount: number; warningCount: number; infoCount: number; findings: Finding[] };
type AnalyzeResponse = { success: boolean; data?: Preview; reconciliation?: Reconciliation; needsPeriod?: boolean; validation?: ValidationReport; error?: string; code?: string; missingGroups?: { label: string; expected: string[] }[]; fingerprintWarning?: { likelyCode: string; likelyName: string } | null };
type CommitResponse = { success: boolean; message?: string; error?: string; importedRows?: number; period?: string | null; reconciliation?: Reconciliation; validation?: ValidationReport; data?: Preview; code?: string };

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

const SEVERITY_STYLE: Record<Severity, { row: string; icon: typeof Info; iconClass: string; label: string }> = {
  error: { row: "border-l-rose-500 bg-rose-50/60", icon: XCircle, iconClass: "text-rose-600", label: "Error" },
  warning: { row: "border-l-amber-500 bg-amber-50/60", icon: AlertTriangle, iconClass: "text-amber-600", label: "Warning" },
  info: { row: "border-l-slate-300 bg-slate-50/60", icon: Info, iconClass: "text-slate-500", label: "Info" },
};

// Strict validation report shown after Analyze. Errors block import outright; warnings block until the
// user ticks the acknowledge box; info is advisory. The same findings are re-checked server-side at
// commit, so this panel mirrors the gate exactly.
function ValidationPanel({ report, acknowledged, onAcknowledge }: { report: ValidationReport; acknowledged: boolean; onAcknowledge: (v: boolean) => void }) {
  const order: Severity[] = ["error", "warning", "info"];
  const sorted = [...report.findings].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  const headline = report.errorCount > 0
    ? { tone: "border-rose-200 bg-rose-50 text-rose-700", text: `${report.errorCount} error(s) must be fixed before importing.` }
    : report.warningCount > 0
      ? { tone: "border-amber-200 bg-amber-50 text-amber-800", text: `${report.warningCount} warning(s) — review and acknowledge to import.` }
      : { tone: "border-emerald-200 bg-emerald-50 text-emerald-700", text: "Strict validation passed — no errors or warnings." };
  return (
    <div className="space-y-2 rounded-xl border border-[#E2E8F0] p-3">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-[#0F172A]" />
        <span className="text-xs font-black uppercase tracking-[0.12em] text-[#64748B]">Strict validation</span>
        <span className={cn("ml-auto rounded-full border px-2.5 py-0.5 text-[11px] font-bold", headline.tone)}>{headline.text}</span>
      </div>
      <ul className="space-y-1.5">
        {sorted.map((f) => {
          const st = SEVERITY_STYLE[f.severity];
          const Icon = st.icon;
          return (
            <li className={cn("rounded-r-md border border-[#EEF2F7] border-l-4 px-3 py-2", st.row)} key={f.code}>
              <div className="flex items-start gap-2">
                <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", st.iconClass)} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-[#0F172A]">{f.title}{f.count > 1 ? <span className="ml-1 font-mono text-xs text-[#64748B]">×{f.count.toLocaleString()}</span> : null}</p>
                  <p className="text-xs text-[#475569]">{f.detail}</p>
                  {f.fixHint ? <p className="mt-0.5 text-xs italic text-[#64748B]">{f.fixHint}</p> : null}
                  {f.sampleRows.length > 0 ? <p className="mt-0.5 font-mono text-[11px] text-[#94A3B8]">rows: {f.sampleRows.join(", ")}{f.count > f.sampleRows.length ? "…" : ""}</p> : null}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {report.errorCount === 0 && report.warningCount > 0 ? (
        <label className="flex cursor-pointer items-center gap-2 rounded-md border border-amber-200 bg-amber-50/40 px-3 py-2 text-sm font-semibold text-amber-900">
          <input checked={acknowledged} className="h-4 w-4 accent-[#F97316]" onChange={(e) => onAcknowledge(e.target.checked)} type="checkbox" />
          I have reviewed the {report.warningCount} warning(s) above and want to import anyway.
        </label>
      ) : null}
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
  const [detected, setDetected] = useState<{ code: string; name: string; confidence: string } | null>(null);
  const [ackWarnings, setAckWarnings] = useState(false);

  // The validation report is period-specific, so changing the period invalidates a prior analysis.
  function changePeriod(value: string) {
    setPeriod(value);
    setAnalysis(null);
    setCommitted(null);
    setAckWarnings(false);
  }

  async function detect(f: File) {
    setDetected(null);
    try {
      const fd = new FormData(); fd.append("file", f);
      const res = await fetch("/api/sales/monthly-import/detect", { method: "POST", body: fd });
      const payload = await readJson<{ success?: boolean; data?: { best?: { distributorCode: string; distributorName: string }; confidence: string } }>(res);
      if (payload.data?.best) setDetected({ code: payload.data.best.distributorCode, name: payload.data.best.distributorName, confidence: payload.data.confidence });
    } catch { /* detection is advisory only */ }
  }

  const unknowns = analysis?.data ? analysis.data.unknownProducts.length + analysis.data.unknownTerritories.length + analysis.data.unknownCustomers.length : 0;
  const validation = analysis?.validation ?? null;
  // Strict gate: errors always block; warnings block until acknowledged.
  const validationBlocks = validation ? (!validation.ok || (validation.warningCount > 0 && !ackWarnings)) : false;
  const canImport = Boolean(analysis?.success) && unknowns === 0 && (!analysis?.needsPeriod || /^\d{4}-\d{2}$/.test(period)) && !validationBlocks;

  async function analyze() {
    if (!file) { setError("Choose a file first."); return; }
    setBusy("analyze"); setError(null); setAnalysis(null); setCommitted(null); setAckWarnings(false);
    try {
      const fd = new FormData(); fd.append("file", file); fd.append("distributorCode", distributorCode); if (period) fd.append("period", period);
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
      if (ackWarnings) fd.append("acknowledgeWarnings", "true");
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
          <input className="h-9 rounded-[6px] border border-[#E2E8F0] px-2 text-sm" onChange={(e) => changePeriod(e.target.value)} type="month" value={period} />
        </label>
        <Button className="h-9 gap-2 bg-[#0B0B0B] font-black text-white hover:bg-[#F97316]" disabled={!hasProfile} onClick={() => fileRef.current?.click()} type="button">
          <FileText className="h-4 w-4" />{file ? file.name.slice(0, 28) : "Choose raw sheet"}
        </Button>
        <input accept=".xlsx" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) { setFile(f); setAnalysis(null); setCommitted(null); void detect(f); } }} ref={fileRef} type="file" />
        <Button className="h-9 gap-2" disabled={!file || busy !== null || !hasProfile} onClick={() => void analyze()} type="button" variant="secondary">
          {busy === "analyze" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}Analyze
        </Button>
      </div>

      {detected && detected.code !== distributorCode ? (
        <AdminCallout tone="warning"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>This file looks like <b>{detected.name}</b> ({detected.code}), but you selected <b>{distributorCode}</b>. Pick the right distributor or you&apos;ll get unmapped rows.</span></AdminCallout>
      ) : detected ? (
        <p className="text-xs text-[#64748B]">Auto-detected <b className="text-[#0F172A]">{detected.name}</b> ({detected.code}) · confidence {detected.confidence} ✓</p>
      ) : null}

      {error ? <AdminCallout tone="danger"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span></AdminCallout> : null}

      {analysis?.code === "header_validation_error" ? (
        <AdminCallout tone="danger"><XCircle className="mt-0.5 h-4 w-4 shrink-0" /><div>
          <p className="font-semibold">This distributor&apos;s template was not followed — the sheet is rejected.</p>
          {analysis.missingGroups && analysis.missingGroups.length > 0 ? (
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
              {analysis.missingGroups.map((g) => (
                <li key={g.label}><span className="font-semibold">{g.label}</span> — expected column {g.expected.map((e) => `"${e}"`).join(" / ")}</li>
              ))}
            </ul>
          ) : null}
          <p className="mt-1 text-xs">Do not rename or remove the template&apos;s required columns. Fix the header(s) above, then re-analyze.</p>
          {analysis.fingerprintWarning ? <p className="mt-1 text-xs">Tip: this looks more like {analysis.fingerprintWarning.likelyName} ({analysis.fingerprintWarning.likelyCode}). Did you pick the right distributor?</p> : null}
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
          ) : null}

          {validation ? <ValidationPanel acknowledged={ackWarnings} onAcknowledge={setAckWarnings} report={validation} /> : null}

          {unknowns === 0 && canImport ? (
            <AdminCallout tone="success"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /><span>{validation && validation.warningCount > 0 ? "Warnings acknowledged — ready to import." : "Everything checks out — ready to import."}</span></AdminCallout>
          ) : null}
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

type Health = { customerMappings: number; productAliases: number; lastMonthlyPeriod: string | null; lastWeeklyWeek: string | null };
type Readiness = { score: number; band: "Healthy" | "Attention" | "High-Risk" };

function HealthDashboard({ distributorCode }: { distributorCode: string }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [certification, setCertification] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Defer the reset off the synchronous effect tick (avoids cascading-render lint).
      await Promise.resolve();
      if (cancelled) return;
      setHealth(null); setReadiness(null); setCertification(null);
      try {
        const res = await fetch(`/api/sales/distributors/health?distributor=${encodeURIComponent(distributorCode)}`);
        const payload = await readJson<{ success: boolean; health?: Health; readiness?: Readiness; certification?: string }>(res);
        if (cancelled || !payload.success) return;
        setHealth(payload.health ?? null); setReadiness(payload.readiness ?? null); setCertification(payload.certification ?? null);
      } catch { /* health is advisory */ }
    })();
    return () => { cancelled = true; };
  }, [distributorCode]);

  if (!health) return null;
  const bandTone = readiness?.band === "Healthy" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : readiness?.band === "Attention" ? "border-amber-200 bg-amber-50 text-amber-800" : "border-rose-200 bg-rose-50 text-rose-700";
  const chip = (label: string, value: string) => <span className="rounded-full border border-[#E2E8F0] bg-[#FCFDFE] px-3 py-1 text-xs font-bold text-[#0F172A]">{label}: {value}</span>;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {readiness ? <span className={cn("rounded-full border px-3 py-1 text-xs font-black", bandTone)}>{readiness.band} · {readiness.score}</span> : null}
      {certification ? <span className="rounded-full border border-[#E2E8F0] bg-[#FCFDFE] px-3 py-1 text-xs font-bold text-[#475569]">Cert: {certification}</span> : null}
      {chip("Customers", health.customerMappings.toLocaleString())}
      {chip("Products", health.productAliases.toLocaleString())}
      {chip("Last monthly", health.lastMonthlyPeriod ?? "—")}
      {health.lastWeeklyWeek ? chip("Last weekly", health.lastWeeklyWeek) : null}
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
        <HealthDashboard distributorCode={selected.code} />
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
