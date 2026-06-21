"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, FileText, FileUp, Info, Loader2, Lock, ShieldCheck, Sparkles, Upload, UploadCloud, XCircle } from "lucide-react";

import { AdminCallout, AdminPageHero } from "@/components/admin/admin-design-system";
import { DistributorWorkspaceShell } from "@/components/sales/distributor-workspace-shell";
import { MappingCombobox } from "@/components/sales/source-of-sales-mapping-tab";
import { UploadedSheetsPanel } from "@/components/sales/uploaded-sheets-panel";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { DistributorProfileSummary, SalesDistributorEntry } from "@/lib/sales/distributor-registry";
import type { SourceOfSalesUploadBatch } from "@/lib/sales/monthly-distributor-import";
import { resolveVerificationStep } from "@/lib/sales/upload-verification-step";
import { cn } from "@/lib/utils";

type MapOption = { code: string; name: string };
type Props = {
  distributors: SalesDistributorEntry[];
  summaries: Record<string, DistributorProfileSummary>;
  batches: SourceOfSalesUploadBatch[];
  products: MapOption[];
  bricks: { id: string; name: string }[];
};

type Reconciliation = { rowsRead: number; rowsCoded: number; rowsIgnored: number; rowsBlankCustomer: number; rowsBlocked: number; totalQty: number; totalValue: number };
type UnknownItem = { count: number; raw: string; rawName: string; suggestionCode: string | null; suggestionLabel: string | null };
type Preview = { summary: { totalRows: number; fullyCoded: number }; unknownProducts: UnknownItem[]; unknownTerritories: UnknownItem[]; unknownCustomers: UnknownItem[]; period: string | null };
type Severity = "error" | "warning" | "info";
type Finding = { code: string; severity: Severity; title: string; detail: string; count: number; sampleRows: number[]; fixHint?: string };
type ValidationReport = { ok: boolean; errorCount: number; warningCount: number; infoCount: number; findings: Finding[] };
type BreakdownRow = { code: string; label: string; parent: string | null; rowCount: number; totalQty: number; totalBonusQty: number; totalValue: number };
type Breakdowns = { byProduct: BreakdownRow[]; byRegion: BreakdownRow[]; byBrick: BreakdownRow[]; byLine: BreakdownRow[] };
type AiExplanation = { aiUsed: boolean; summary: string; suggestions: { expected: string; suggestedHeader: string | null; note?: string }[] };
type AnalyzeResponse = { success: boolean; data?: Preview; reconciliation?: Reconciliation; breakdowns?: Breakdowns; needsPeriod?: boolean; validation?: ValidationReport; error?: string; code?: string; missingGroups?: { label: string; expected: string[] }[]; fingerprintWarning?: { likelyCode: string; likelyName: string } | null; aiExplanation?: AiExplanation | null };
type CommitResponse = { success: boolean; message?: string; error?: string; importedRows?: number; period?: string | null; reconciliation?: Reconciliation; validation?: ValidationReport; data?: Preview; code?: string };
type DetectResponse = { success?: boolean; data?: { best?: { distributorCode: string; distributorName: string }; confidence: string }; error?: string };

const panel = "rounded-2xl border border-[#D8E0EA] bg-white/95 shadow-[0_8px_22px_rgba(15,23,42,0.06)]";
// Weekly-style step UI tokens (match /sales/weekly exactly).
const stepCard = "rounded-[6px] border border-[#E2E8F0] bg-white shadow-sm";
const darkHead = "bg-[#020617] px-3 py-2 text-xs font-black uppercase tracking-wide text-white";
const money = (value: number) => `EGP ${Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const num = (value: number) => Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });

function StepBadge({ n, label, done, active }: { n: number; label: string; done?: boolean; active?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className={cn("inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-black", done ? "bg-emerald-500 text-white" : active ? "bg-[#020617] text-white" : "bg-[#E2E8F0] text-[#64748B]")}>
        {done ? <CheckCircle2 className="h-3.5 w-3.5" /> : n}
      </span>
      <span className="text-[11px] font-black uppercase tracking-[0.16em] text-[#0F172A]">{label}</span>
    </div>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="bg-white px-3 py-2.5">
      <div className="text-[10px] font-black uppercase tracking-wide text-[#94A3B8]">{label}</div>
      <div className={cn("mt-0.5 text-sm font-black tabular-nums", accent ? "text-[#F97316]" : "text-[#0F172A]")}>{value}</div>
    </div>
  );
}

function BreakdownTable({ title, headLabel, rows }: { title: string; headLabel: string; rows: BreakdownRow[] }) {
  return (
    <div className="overflow-hidden rounded-[6px] border border-[#E2E8F0]">
      <div className={darkHead}>{title}</div>
      <div className="max-h-72 overflow-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-[11px] font-bold uppercase text-[#94A3B8]">
            <tr>
              <th className="px-3 py-1.5">{headLabel}</th>
              <th className="px-3 py-1.5 text-right">Qty</th>
              <th className="px-3 py-1.5 text-right">Bonus</th>
              <th className="px-3 py-1.5 text-right">Value</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td className="px-3 py-3 text-center text-[#94A3B8]" colSpan={4}>—</td></tr>}
            {rows.map((r) => (
              <tr className="border-t border-[#FFE8D6]" key={r.code}>
                <td className="px-3 py-1.5 font-semibold text-[#0F172A]">{r.label}{r.parent ? <span className="ml-1 text-[11px] font-medium text-[#94A3B8]">· {r.parent}</span> : null}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-[#334155]">{num(r.totalQty)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-[#334155]">{num(r.totalBonusQty)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-[#334155]">{money(r.totalValue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

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

const SEVERITY_STYLE: Record<Severity, { row: string; icon: typeof Info; iconClass: string; label: string }> = {
  error: { row: "border-l-rose-500 bg-rose-50/60", icon: XCircle, iconClass: "text-rose-600", label: "Error" },
  warning: { row: "border-l-amber-500 bg-amber-50/60", icon: AlertTriangle, iconClass: "text-amber-600", label: "Warning" },
  info: { row: "border-l-slate-300 bg-slate-50/60", icon: Info, iconClass: "text-slate-500", label: "Info" },
};

// Strict validation report shown after Analyze. The upload is BLOCKED only by an "error" — a duplicate
// sheet, an unreadable/unrecognized file, or broken geography (plus the separately-gated unmapped rows).
// Warnings are advisory data-quality notes — shown so the operator can review, but they NEVER block;
// info is advisory too. The same findings are re-checked server-side at commit, so this panel mirrors
// the gate exactly.
function ValidationPanel({ report }: { report: ValidationReport }) {
  const order: Severity[] = ["error", "warning", "info"];
  const sorted = [...report.findings].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  const headline = report.errorCount > 0
    ? { tone: "border-rose-200 bg-rose-50 text-rose-700", text: `${report.errorCount} issue(s) block this upload — resolve below.` }
    : report.warningCount > 0
      ? { tone: "border-amber-200 bg-amber-50 text-amber-800", text: `${report.warningCount} warning(s) — review, but you can still import.` }
      : { tone: "border-emerald-200 bg-emerald-50 text-emerald-700", text: "Strict validation passed — no warnings." };
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
    </div>
  );
}

// Inline mapping panel: the exact items the system could NOT recognize, each editable RIGHT HERE.
// Per row: a combobox pre-filled with the engine's suggestion, a checkbox to include it, and type-to-
// search to pick a different target. "Save mappings" writes them all via the shared save-mappings
// endpoint, then re-validates so the now-mapped rows clear and the upload can proceed.
type MapType = "product" | "customer" | "territory";
const mapKey = (t: MapType, raw: string) => `${t}::${raw}`;

function UnmappedList({ products, customers, territories, productOptions, brickOptions, distributorCode, onSaved }: { products: UnknownItem[]; customers: UnknownItem[]; territories: UnknownItem[]; productOptions: MapOption[]; brickOptions: MapOption[]; distributorCode: string; onSaved: () => void }) {
  const allGroups: { type: MapType; label: string; items: UnknownItem[]; options: MapOption[]; placeholder: string }[] = [
    { type: "product", label: "Products", items: products, options: productOptions, placeholder: "product code (e.g. TE001)" },
    { type: "customer", label: "Customers", items: customers, options: brickOptions, placeholder: "brick (e.g. B10)" },
    { type: "territory", label: "Territories / bricks", items: territories, options: brickOptions, placeholder: "brick (e.g. B10)" },
  ];
  const groups = allGroups.filter((g) => g.items.length > 0);

  // Seed each row's chosen code from the engine suggestion, and pre-confirm rows that HAVE a suggestion
  // (the common case → just press Save). Math.random/Date are unavailable here; keys are type+raw.
  const seedSelected: Record<string, string> = {};
  const seedConfirmed: Record<string, boolean> = {};
  for (const g of groups) for (const u of g.items) {
    const k = mapKey(g.type, u.raw);
    seedSelected[k] = u.suggestionCode ?? "";
    seedConfirmed[k] = Boolean(u.suggestionCode);
  }
  const [selected, setSelected] = useState<Record<string, string>>(seedSelected);
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>(seedConfirmed);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (groups.length === 0) return null;

  const ready = groups.flatMap((g) => g.items
    .filter((u) => confirmed[mapKey(g.type, u.raw)] && (selected[mapKey(g.type, u.raw)] ?? "").trim())
    .map((u) => ({ type: g.type, raw: u.raw, code: selected[mapKey(g.type, u.raw)].trim() })));

  function setCode(type: MapType, raw: string, code: string) {
    const k = mapKey(type, raw);
    setSelected((p) => ({ ...p, [k]: code }));
    setConfirmed((p) => ({ ...p, [k]: code.trim().length > 0 })); // picking a value confirms; clearing un-confirms
  }
  function toggle(type: MapType, raw: string, on: boolean) {
    setConfirmed((p) => ({ ...p, [mapKey(type, raw)]: on }));
  }

  async function save() {
    if (ready.length === 0) return;
    setBusy(true); setErr(null); setMsg(null);
    try {
      const res = await fetch("/api/sales/monthly-import/save-mappings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ distributorCode, mappings: ready }),
      });
      const payload = await readJson<{ success: boolean; message?: string; error?: string; result?: { invalid: number; invalidEntries?: { raw: string; reason: string }[] } }>(res);
      if (!payload.success) { setErr(payload.error ?? "Save failed."); return; }
      const invalid = payload.result?.invalidEntries ?? [];
      setMsg(invalid.length ? `${payload.message} Some couldn't be saved: ${invalid.map((e) => e.raw).join(", ")}.` : (payload.message ?? "Mappings saved."));
      onSaved(); // re-validate the same file so the mapped rows drop out and the upload can proceed
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed.");
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-2 rounded-[6px] border border-amber-200 bg-amber-50/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] font-black uppercase tracking-[0.14em] text-amber-800">Map these here, then re-validate</p>
        <div className="flex items-center gap-2">
          {msg ? <span className="text-xs font-semibold text-emerald-700">{msg}</span> : null}
          {err ? <span className="text-xs font-semibold text-rose-700">{err}</span> : null}
          <button
            className="inline-flex h-8 items-center gap-1.5 rounded-[6px] bg-[#0F172A] px-3 text-xs font-black text-white transition hover:bg-[#1E293B] disabled:cursor-not-allowed disabled:bg-[#CBD5E1]"
            disabled={busy || ready.length === 0}
            onClick={() => void save()}
            type="button"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            {busy ? "Saving…" : `Save ${ready.length} mapping${ready.length === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
      {groups.map((g) => (
        <div key={g.type}>
          <div className="mb-1 text-[11px] font-bold uppercase tracking-wide text-amber-700">{g.label} ({g.items.length})</div>
          <div className="overflow-visible rounded-[6px] border border-amber-200 bg-white">
            <table className="w-full text-sm">
              <thead className="text-left text-[11px] font-bold uppercase text-[#94A3B8]">
                <tr>
                  <th className="px-3 py-1.5">Value in sheet</th>
                  <th className="px-3 py-1.5">Name in sheet</th>
                  <th className="px-3 py-1.5 text-right">Rows</th>
                  <th className="px-3 py-1.5">Map to {g.type === "product" ? "product" : "brick"}</th>
                </tr>
              </thead>
              <tbody>
                {g.items.map((u) => {
                  const k = mapKey(g.type, u.raw);
                  return (
                    <tr className="border-t border-[#FFE8D6]" key={k}>
                      <td className="px-3 py-1.5 align-top font-mono text-xs font-semibold text-[#0F172A]">{u.raw || <span className="italic text-[#94A3B8]">(blank)</span>}</td>
                      <td className="px-3 py-1.5 align-top text-[#334155]">{u.rawName || <span className="italic text-[#94A3B8]">—</span>}</td>
                      <td className="px-3 py-1.5 text-right align-top tabular-nums text-[#334155]">{u.count.toLocaleString()}</td>
                      <td className="px-3 py-1.5">
                        <div className="flex items-center gap-2">
                          <input
                            aria-label="include this mapping"
                            checked={Boolean(confirmed[k])}
                            className="h-4 w-4 shrink-0 accent-[#F97316]"
                            onChange={(e) => toggle(g.type, u.raw, e.target.checked)}
                            type="checkbox"
                          />
                          <div className="w-56"><MappingCombobox onChange={(c) => setCode(g.type, u.raw, c)} options={g.options} placeholder={g.placeholder} value={selected[k] ?? ""} /></div>
                        </div>
                        {u.suggestionLabel && (selected[k] ?? "") === (u.suggestionCode ?? "") ? (
                          <p className="mt-0.5 pl-6 text-[11px] text-[#64748B]">Suggested: {u.suggestionLabel}{u.suggestionCode ? ` (${u.suggestionCode})` : ""}</p>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

function MonthlyUpload({ distributorCode, distributorName, hasProfile, hasDateColumn, onUploaded, productOptions, brickOptions }: { distributorCode: string; distributorName: string; hasProfile: boolean; hasDateColumn: boolean; onUploaded?: () => void; productOptions: MapOption[]; brickOptions: MapOption[] }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [period, setPeriod] = useState("");
  const [busy, setBusy] = useState<"verify" | "analyze" | "commit" | null>(null);
  const [analysis, setAnalysis] = useState<AnalyzeResponse | null>(null);
  const [committed, setCommitted] = useState<CommitResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detected, setDetected] = useState<{ code: string; name: string; confidence: string } | null>(null);
  const [verified, setVerified] = useState(false);
  // True once an auto-detection attempt has finished — even when it found nothing. Lets the UI always
  // show a result (and a way to continue) instead of silently leaving the operator with a locked step.
  const [verifyRan, setVerifyRan] = useState(false);
  // Any change to file/period/distributor invalidates the verification + validation downstream.
  function resetDownstream() { setVerified(false); setVerifyRan(false); setAnalysis(null); setCommitted(null); setError(null); }
  function changePeriod(value: string) { setPeriod(value); setAnalysis(null); setCommitted(null); }
  function onPickFile(f: File | null) { setFile(f); setDetected(null); resetDownstream(); if (f) void detect(f); }

  async function detect(f: File) {
    setDetected(null); setVerifyRan(false);
    try {
      const fd = new FormData(); fd.append("file", f);
      const res = await fetch("/api/sales/monthly-import/detect", { method: "POST", body: fd });
      const payload = await readJson<DetectResponse>(res);
      // best is null when detection is ambiguous (a tie) or matched no profile — leave detected null
      // and let verifyRan drive the "couldn't recognize, confirm to continue" panel below.
      if (payload.data?.best) setDetected({ code: payload.data.best.distributorCode, name: payload.data.best.distributorName, confidence: payload.data.confidence });
    } catch { /* detection is advisory only */ }
    finally { setVerifyRan(true); }
  }

  const unknowns = analysis?.data ? analysis.data.unknownProducts.length + analysis.data.unknownTerritories.length + analysis.data.unknownCustomers.length : 0;
  const validation = analysis?.validation ?? null;
  // Only the duplicate-sheet error (report.ok === false) blocks here; warnings are advisory and never
  // block (mirrors the server gate exactly). Unmapped rows are gated separately via `unknowns`.
  const validationBlocks = validation ? !validation.ok : false;
  const canImport = Boolean(analysis?.success) && unknowns === 0 && (!analysis?.needsPeriod || /^\d{4}-\d{2}$/.test(period)) && !validationBlocks;
  const breakdowns = analysis?.breakdowns ?? null;

  // Step-1 panel decision (pure, regression-tested): guarantees a Confirm path for EVERY finished
  // detection outcome so the operator can never be silently locked out of Step 2. See
  // src/lib/sales/upload-verification-step.ts.
  const verifyStep = resolveVerificationStep({ ran: verifyRan, detectedCode: detected?.code ?? null, selectedCode: distributorCode });
  const confirmClass = verifyStep.panel === "mismatch"
    ? "border border-amber-300 bg-white text-amber-800 hover:bg-amber-50"
    : verifyStep.panel === "unrecognized"
      ? "bg-[#0F172A] text-white hover:bg-[#1E293B]"
      : "bg-[#F97316] text-white hover:bg-[#EA6A0C]";
  const confirmLabel = verifyStep.panel === "mismatch"
    ? `Yes, this is the ${distributorCode} sheet — continue`
    : verifyStep.panel === "unrecognized"
      ? `Confirm — this is the ${distributorCode} sheet`
      : "Confirm — this looks correct";

  // ── Step 1 — AI verification (detect distributor + confirm the column mapping) ──
  async function handleVerify() {
    if (!file) { setError("Choose a raw sheet first."); return; }
    setBusy("verify"); setError(null);
    try { await detect(file); } finally { setBusy(null); }
  }

  // ── Step 2 — Strict validation (dry run; persists nothing) ──
  async function analyze() {
    if (!file) { setError("Choose a file first."); return; }
    setBusy("analyze"); setError(null); setAnalysis(null); setCommitted(null);
    try {
      const fd = new FormData(); fd.append("file", file); fd.append("distributorCode", distributorCode); if (period) fd.append("period", period);
      const res = await fetch("/api/sales/sales-upload/analyze", { method: "POST", body: fd });
      const payload = await readJson<AnalyzeResponse>(res);
      setAnalysis(payload);
      if (!payload.success) setError(payload.error ?? "Validation failed.");
    } catch (e) { setError(e instanceof Error ? e.message : "Validation failed."); }
    finally { setBusy(null); }
  }

  // ── Step 3 — Confirm & upload (persist) ──
  async function commit() {
    if (!file) return;
    setBusy("commit"); setError(null);
    try {
      const fd = new FormData(); fd.append("file", file); fd.append("distributorCode", distributorCode); if (period) fd.append("period", period);
      const res = await fetch("/api/sales/sales-upload/commit", { method: "POST", body: fd });
      const payload = await readJson<CommitResponse>(res);
      setCommitted(payload);
      if (!payload.success) setError(payload.error ?? "Import failed.");
      else onUploaded?.();
    } catch (e) { setError(e instanceof Error ? e.message : "Import failed."); }
    finally { setBusy(null); }
  }

  const rec = analysis?.success ? analysis.reconciliation : null;

  return (
    <div className="space-y-4">
      {/* File + period selectors */}
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-black uppercase tracking-[0.12em] text-[#94A3B8]">Period{hasDateColumn ? " (optional)" : " (required)"}</span>
          <input className="h-9 rounded-[6px] border border-[#E2E8F0] px-2 text-sm" disabled={busy !== null} onChange={(e) => changePeriod(e.target.value)} type="month" value={period} />
        </label>
        <Button className="h-9 gap-2 bg-[#0B0B0B] font-black text-white hover:bg-[#F97316]" disabled={!hasProfile || busy !== null} onClick={() => fileRef.current?.click()} type="button">
          <FileText className="h-4 w-4" />{file ? file.name.slice(0, 28) : "Choose raw sheet"}
        </Button>
        <input accept=".xlsx" className="hidden" onChange={(e) => onPickFile(e.target.files?.[0] ?? null)} ref={fileRef} type="file" />
      </div>

      {error ? <AdminCallout tone="danger"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span></AdminCallout> : null}

      {/* ── Step 1: AI verification ── */}
      <div className="border-t border-dashed border-[#E2E8F0] pt-4">
        <StepBadge active={!verified} done={verified} label="AI verification" n={1} />
        <p className="mt-1 text-xs font-medium text-[#64748B]">
          Reads the file&apos;s headers and confirms which distributor it is and which column feeds product, quantity, date, customer and territory (shown above). Nothing is stored.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button className="inline-flex h-10 items-center gap-2 rounded-[6px] border border-[#020617] bg-white px-4 text-sm font-black text-[#0F172A] transition hover:bg-[#F8FAFC] disabled:opacity-60" disabled={busy !== null || !file} onClick={handleVerify} type="button">
            {busy === "verify" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4 text-[#F97316]" />}
            {busy === "verify" ? "Analyzing…" : verifyRan ? "Re-run verification" : "Run AI verification"}
          </button>
          {!file && <span className="text-xs font-medium text-[#94A3B8]">Pick the raw sheet above first.</span>}
        </div>

        {/* Verification result — one block, three outcomes. The Confirm control is driven by
            resolveVerificationStep().canConfirm, which is true for EVERY finished outcome (match,
            different-distributor, couldn't-recognize), so the operator is never silently locked out. */}
        {verifyStep.panel !== "idle" && (
          <div className="mt-3 space-y-2">
            {verifyStep.panel === "match" && detected ? (
              <div className="rounded-[6px] border border-emerald-200 bg-emerald-50/60 px-3 py-2">
                <span className="text-sm font-bold text-emerald-700">Recognized as {detected.name} ({detected.code}) · confidence {detected.confidence}</span>
              </div>
            ) : null}
            {verifyStep.panel === "mismatch" && detected ? (
              <AdminCallout tone="warning"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>This file looks like <b>{detected.name}</b> ({detected.code}), but you selected <b>{distributorName} ({distributorCode})</b>. Switch to the right distributor above — or, if you&apos;re sure this is the {distributorName} sheet, confirm to continue (the next step still strictly checks every column).</span></AdminCallout>
            ) : null}
            {verifyStep.panel === "unrecognized" ? (
              <AdminCallout tone="neutral"><Info className="mt-0.5 h-4 w-4 shrink-0" /><span>Couldn&apos;t auto-recognize a single distributor from this file&apos;s column headers (they didn&apos;t clearly match one profile, or matched more than one). If this really is the <b>{distributorName} ({distributorCode})</b> sheet, confirm to continue — the next step strictly checks every column before anything is stored.</span></AdminCallout>
            ) : null}

            {verified ? (
              <span className="inline-flex items-center gap-1 text-sm font-black text-emerald-700"><ShieldCheck className="h-4 w-4" /> Verified</span>
            ) : verifyStep.canConfirm ? (
              <button className={cn("inline-flex h-9 items-center gap-2 rounded-[6px] px-4 text-sm font-black transition", confirmClass)} onClick={() => setVerified(true)} type="button">
                <ShieldCheck className="h-4 w-4" /> {confirmLabel}
              </button>
            ) : null}
          </div>
        )}
      </div>

      {/* ── Step 2: Strict validation ── */}
      <div className={cn("border-t border-dashed border-[#E2E8F0] pt-4", !verified && "opacity-60")}>
        <StepBadge active={verified && !analysis?.success} done={Boolean(analysis?.success)} label="Strict validation" n={2} />
        <p className="mt-1 text-xs font-medium text-[#64748B]">
          Parses the sheet, maps every product / territory / customer, runs the strict rules, and shows totals per product, per region and per brick. Nothing is stored yet.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button className="inline-flex h-10 items-center gap-2 rounded-[6px] bg-[#0F172A] px-4 text-sm font-black text-white transition hover:bg-[#1E293B] disabled:cursor-not-allowed disabled:bg-[#CBD5E1]" disabled={busy !== null || !verified || !hasProfile} onClick={() => void analyze()} type="button">
            {busy === "analyze" ? <Loader2 className="h-4 w-4 animate-spin" /> : !verified ? <Lock className="h-4 w-4" /> : <FileUp className="h-4 w-4" />}
            {busy === "analyze" ? "Validating…" : "Validate"}
          </button>
          {!verified && <span className="inline-flex items-center gap-1 text-xs font-semibold text-[#94A3B8]"><Lock className="h-3.5 w-3.5" /> Complete AI verification above to unlock.</span>}
        </div>
      </div>

      {/* Header-template error */}
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
          <p className="mt-1 text-xs">Do not rename or remove the template&apos;s required columns. Fix the header(s) above, then re-validate.</p>
          {analysis.fingerprintWarning ? <p className="mt-1 text-xs">Tip: this looks more like {analysis.fingerprintWarning.likelyName} ({analysis.fingerprintWarning.likelyCode}). Did you pick the right distributor?</p> : null}
          {analysis.aiExplanation?.aiUsed && (analysis.aiExplanation.summary || analysis.aiExplanation.suggestions.length > 0) ? (
            <div className="mt-2 rounded-[6px] border border-[#F59E0B]/40 bg-amber-50/60 px-3 py-2">
              <p className="flex items-center gap-1 text-xs font-black text-amber-900"><Sparkles className="h-3.5 w-3.5" /> AI help</p>
              {analysis.aiExplanation.summary ? <p className="mt-0.5 text-xs text-amber-900">{analysis.aiExplanation.summary}</p> : null}
              {analysis.aiExplanation.suggestions.length > 0 ? (
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-amber-900">
                  {analysis.aiExplanation.suggestions.map((s) => (
                    <li key={s.expected}><span className="font-semibold">{s.expected}</span>{s.suggestedHeader ? <> → likely your column <span className="font-mono">&quot;{s.suggestedHeader}&quot;</span></> : " → no matching column found"}{s.note ? <span className="text-amber-800"> · {s.note}</span> : null}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div></AdminCallout>
      ) : null}

      {/* ── Validation result + Step 3 confirm ── */}
      {analysis?.success && rec ? (
        <div className={stepCard}>
          {/* Header */}
          <div className={cn("flex flex-wrap items-center gap-2 border-b border-[#E2E8F0] px-4 py-3 text-sm font-black", canImport ? "text-emerald-700" : "text-amber-700")}>
            {canImport ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
            {canImport ? `Validation passed — ${num(rec.rowsCoded)} rows ready to upload` : "Validation blocked — resolve the items below"}
          </div>

          {/* KPI strip (reconciliation receipt) */}
          <div className="grid grid-cols-2 gap-px bg-[#E2E8F0] sm:grid-cols-3 lg:grid-cols-6">
            <Metric label="Rows read" value={num(rec.rowsRead)} />
            <Metric accent label="Coded" value={num(rec.rowsCoded)} />
            <Metric label="Ignored" value={num(rec.rowsIgnored)} />
            <Metric label="Blank cust." value={num(rec.rowsBlankCustomer)} />
            <Metric label="Blocked" value={num(rec.rowsBlocked)} />
            <Metric accent label="Total value" value={money(rec.totalValue)} />
          </div>

          {/* Unmapped / period gates */}
          <div className="space-y-2 px-4 pt-4">
            {unknowns > 0 ? (
              <div className="space-y-2">
                <AdminCallout tone="warning"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><div>
                  <p className="font-semibold">{unknowns} unmapped item(s) — upload is blocked until they&apos;re mapped.</p>
                  <p className="text-xs">These {num(rec.rowsBlocked)} row(s) can&apos;t be coded yet. Map the items below in <Link className="font-semibold text-[#C2410C] underline" href="/sales/mapping-database">Mapping Database</Link>, then re-validate.</p>
                </div></AdminCallout>
                <UnmappedList brickOptions={brickOptions} customers={analysis.data?.unknownCustomers ?? []} distributorCode={distributorCode} onSaved={() => void analyze()} productOptions={productOptions} products={analysis.data?.unknownProducts ?? []} territories={analysis.data?.unknownTerritories ?? []} />
              </div>
            ) : analysis.needsPeriod && !/^\d{4}-\d{2}$/.test(period) ? (
              <AdminCallout tone="neutral"><span>This sheet has no date column — pick a period above to upload.</span></AdminCallout>
            ) : null}
            {validation ? <ValidationPanel report={validation} /> : null}
          </div>

          {/* Per product / region / brick / line breakdowns */}
          {breakdowns ? (
            <div className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-2">
              <BreakdownTable headLabel="Product" rows={breakdowns.byProduct} title="By product" />
              <BreakdownTable headLabel="Region" rows={breakdowns.byRegion} title="By region" />
              <BreakdownTable headLabel="Brick" rows={breakdowns.byBrick} title="By brick" />
              <BreakdownTable headLabel="Line" rows={breakdowns.byLine} title="By line" />
            </div>
          ) : null}

          {/* Step 3 — Confirm & Upload */}
          <div className="border-t border-[#E2E8F0] px-4 py-4">
            <div className="mb-3"><StepBadge active label="Confirm & Upload" n={3} /></div>
            {committed?.success ? (
              <div className="flex items-center gap-2 rounded-[6px] border border-emerald-200 bg-emerald-50 px-4 py-3">
                <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" />
                <div>
                  <p className="text-sm font-black text-emerald-700">{committed.message}</p>
                  <p className="mt-0.5 text-xs font-medium text-emerald-600">Any earlier upload for {committed.period} was replaced — no double count.</p>
                </div>
              </div>
            ) : canImport ? (
              <div className="flex flex-wrap items-center gap-3">
                <button className="inline-flex h-10 items-center gap-2 rounded-[6px] bg-[#F97316] px-5 text-sm font-black text-white transition hover:bg-[#EA6A0C] disabled:cursor-not-allowed disabled:bg-[#CBD5E1]" disabled={busy !== null} onClick={() => void commit()} type="button">
                  {busy === "commit" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                  {busy === "commit" ? "Uploading…" : "Confirm & Upload"}
                </button>
                <span className="text-xs font-medium text-[#64748B]">Review the totals above, then confirm to store the data.</span>
              </div>
            ) : (
              <p className="text-xs font-semibold text-amber-700">Resolve the items above, then re-validate before uploading.</p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// Weekly uploads run through the full guided weekly wizard (/sales/weekly) — the same AI verify →
// validate → confirm flow as monthly, plus the weekly column checks and per-week replace. Rather than
// keep a degraded one-click weekly path on the hub (and a second weekly UI to maintain), the hub hands
// off to that single canonical wizard.
function WeeklyUpload({ distributorName }: { distributorName: string }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-[6px] border border-[#E2E8F0] bg-[#FCFDFE] px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-[#0F172A]">Weekly sales use the guided weekly wizard</p>
        <p className="mt-0.5 text-xs text-[#64748B]">Same AI verify → validate → confirm flow as monthly, with the weekly column checks and per-week replace. Upload {distributorName}&apos;s weekly sheet there.</p>
      </div>
      <Link className="inline-flex h-10 shrink-0 items-center gap-2 rounded-[6px] bg-[#0B0B0B] px-4 text-sm font-black text-white transition hover:bg-[#F97316]" href="/sales/weekly">
        <UploadCloud className="h-4 w-4" /> Open Weekly Upload
      </Link>
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

function DistributorUpload({ selected, summary, productOptions, brickOptions }: { selected: SalesDistributorEntry; summary?: DistributorProfileSummary; productOptions: MapOption[]; brickOptions: MapOption[] }) {
  // Bumped after a successful upload so the health panel ("Last monthly") re-reads.
  const [uploadNonce, setUploadNonce] = useState(0);
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
        <HealthDashboard distributorCode={selected.code} key={`health-${selected.code}-${uploadNonce}`} />
        <ProfileViewer summary={summary} />
      </Card>

      <Card className={cn(panel, "space-y-3 p-5")}>
        <h3 className="text-base font-black tracking-tight text-slate-950">Upload Monthly Sales</h3>
        <MonthlyUpload brickOptions={brickOptions} distributorCode={selected.code} distributorName={selected.name} hasDateColumn={summary?.hasDateColumn ?? true} hasProfile={Boolean(summary)} onUploaded={() => setUploadNonce((n) => n + 1)} productOptions={productOptions} />
      </Card>

      {selected.weeklySupported ? (
        <Card className={cn(panel, "space-y-3 p-5")}>
          <h3 className="text-base font-black tracking-tight text-slate-950">Upload Weekly Sales</h3>
          <WeeklyUpload distributorName={selected.name} />
        </Card>
      ) : null}
    </div>
  );
}

export function SalesUploadWorkspace({ distributors, summaries, batches, products, bricks }: Props) {
  const brickOptions: MapOption[] = bricks.map((b) => ({ code: b.id, name: b.name }));
  return (
    <div className="space-y-5">
      <AdminPageHero
        description="The single upload hub. Pick a distributor, analyze its raw sheet, then import — the analyzer and the importer use the exact same engine, so what's recognized always imports."
        eyebrow="Sales · One connected module"
        icon={<UploadCloud className="h-4 w-4" />}
        title="Sales Upload"
      />
      <UploadedSheetsPanel batches={batches} distributors={distributors} />
      <DistributorWorkspaceShell distributors={distributors}>
        {(selected) => <DistributorUpload brickOptions={brickOptions} productOptions={products} selected={selected} summary={summaries[selected.code]} />}
      </DistributorWorkspaceShell>
    </div>
  );
}
