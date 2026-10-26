"use client";

import Link from "next/link";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, FileText, FileUp, Grid3x3, Info, Loader2, Lock, ShieldCheck, Sparkles, Store, Upload, UploadCloud, XCircle } from "lucide-react";

import { BulkImportWorkspace } from "@/components/sales/bulk-import-workspace";

import { AdminCallout } from "@/components/admin/admin-design-system";
import { DistributorWorkspaceShell } from "@/components/sales/distributor-workspace-shell";
import { MappingCombobox } from "@/components/sales/source-of-sales-mapping-tab";
import { UploadedSheetsPanel } from "@/components/sales/uploaded-sheets-panel";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import type { ExportColumn, ExportRow } from "@/lib/export/table-workbook";
import type { BulkSlotStage } from "@/lib/sales/bulk-import-gating";
import type { DistributorProfileSummary, SalesDistributorEntry } from "@/lib/sales/distributor-registry";
import type { SourceOfSalesUploadBatch } from "@/lib/sales/monthly-distributor-import";
import { periodToAutoFill } from "@/lib/sales/upload-period-autofill";
import { resolveVerificationStep } from "@/lib/sales/upload-verification-step";
import { cn } from "@/lib/utils";
import { phxSelectClassName } from "@/components/ui/form-tokens";

export type MapOption = { code: string; name: string };
type Props = {
  distributors: SalesDistributorEntry[];
  summaries: Record<string, DistributorProfileSummary>;
  batches: SourceOfSalesUploadBatch[];
  products: MapOption[];
  bricks: { id: string; name: string }[];
  aiEnabled: boolean;
};

export type Reconciliation = { rowsRead: number; rowsCoded: number; rowsIgnored: number; rowsBlankCustomer: number; rowsBlocked: number; totalQty: number; totalValue: number; freeGoodsQty?: number; rowsFreeGoods?: number };
type UnknownItem = { count: number; raw: string; rawName: string; rawAddress?: string; rawTerritory?: string; suggestionCode: string | null; suggestionLabel: string | null };
type IgnoredItem = { raw: string; displayName: string; count: number; totalQty: number };
type Preview = { summary: { totalRows: number; fullyCoded: number }; unknownProducts: UnknownItem[]; unknownTerritories: UnknownItem[]; unknownCustomers: UnknownItem[]; ignoredItems?: IgnoredItem[]; period: string | null; periods?: { period: string; rows: number }[] };
type Severity = "error" | "warning" | "info";
type Finding = { code: string; severity: Severity; title: string; detail: string; count: number; sampleRows: number[]; sampleProducts?: string[]; fixHint?: string };
export type ValidationReport = { ok: boolean; errorCount: number; warningCount: number; infoCount: number; findings: Finding[] };
export type BreakdownRow = { code: string; label: string; parent: string | null; rowCount: number; totalQty: number; totalBonusQty: number; totalValue: number };
export type Breakdowns = { byProduct: BreakdownRow[]; byRegion: BreakdownRow[]; byBrick: BreakdownRow[]; byLine: BreakdownRow[] };

// ── Bulk Import mode contract ───────────────────────────────────────────────────────────────────
// A slot's lifecycle, reported upward so the bulk grid can color each distributor's card without
// duplicating any of MonthlyUpload's own analyze/validate/commit logic. BulkSlotStage itself (plus
// the "which stages block Confirm & Import All" rule) lives in @/lib/sales/bulk-import-gating —
// domain logic, not UI — and is re-exported here for existing consumers.
export type { BulkSlotStage };
export type BulkSlotStatus = {
  stage: BulkSlotStage;
  canImport: boolean;
  fileName: string | null;
  reconciliation: Reconciliation | null;
  breakdowns: Breakdowns | null;
  error: string | null;
};
export type MonthlyUploadHandle = { commit: () => Promise<void> };
type AiExplanation = { aiUsed: boolean; summary: string; suggestions: { expected: string; suggestedHeader: string | null; note?: string }[] };
type AnalyzeResponse = { success: boolean; data?: Preview; reconciliation?: Reconciliation; breakdowns?: Breakdowns; needsPeriod?: boolean; validation?: ValidationReport; error?: string; code?: string; missingGroups?: { label: string; expected: string[] }[]; fingerprintWarning?: { likelyCode: string; likelyName: string } | null; aiExplanation?: AiExplanation | null; isRegionOnly?: boolean };
type CommitResponse = { success: boolean; message?: string; error?: string; importedRows?: number; period?: string | null; reconciliation?: Reconciliation; validation?: ValidationReport; data?: Preview; code?: string };
type DetectResponse = { success?: boolean; data?: { best?: { distributorCode: string; distributorName: string }; confidence: string }; error?: string };

const panel = "rounded-2xl border border-phx-line bg-white/95 shadow-[0_8px_22px_rgba(15,23,42,0.06)]";
// Weekly-style step UI tokens (match /sales/weekly exactly).
const stepCard = "rounded-[6px] border border-phx-line bg-white shadow-sm";
const darkHead = "bg-[#020617] px-3 py-2 text-xs font-black uppercase tracking-wide text-white";
export const money = (value: number) => `EGP ${Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
export const num = (value: number) => Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
export const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
export const UPLOAD_YEARS = [2024, 2025, 2026, 2027, 2028];
// Reserved sentinel already handled server-side: rows whose product alias resolves to this are
// dropped from coding (ignoredRows) rather than surfaced as unmapped exceptions.
const IGNORE_PRODUCT_CODE = "IGNORE";

// The ONE offline fix-list for unmapped customers. Header names for Distrub ID / Customer code /
// Brick ID exactly match the HEADER_ALIASES in importCustomerMap(), so after filling the Brick ID
// column the SAME file uploads straight back via Mapping tab → Customer/Brick Mapping. The extra
// helper columns (name / address / area) are IGNORED by the importer but give the operator every
// piece of context the distributor sheet carries to pick the right brick. No numeric column → no
// SUM/TOTAL row → the file round-trips cleanly with no stray rows on re-upload.
const CUSTOMER_FIX_COLUMNS: ExportColumn[] = [
  { key: "distCode", label: "Distrub ID", width: 12 },
  { key: "customerCode", label: "Customer code", width: 22 },
  { key: "customerName", label: "Customer name", width: 34 },
  { key: "address", label: "Address", width: 42 },
  { key: "area", label: "Governorate / area", width: 24 },
  { key: "brickId", label: "Brick ID", width: 14 },
];

function StepBadge({ n, label, done, active }: { n: number; label: string; done?: boolean; active?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className={cn("inline-flex h-5 w-5 items-center justify-center rounded-full text-phx-2xs font-black", done ? "bg-emerald-500 text-white" : active ? "bg-[#020617] text-white" : "bg-phx-line text-phx-ink-soft")}>
        {done ? <CheckCircle2 className="h-3.5 w-3.5" /> : n}
      </span>
      <span className="text-phx-xs font-black uppercase tracking-[0.16em] text-phx-ink">{label}</span>
    </div>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="bg-white px-3 py-2.5">
      <div className="text-phx-2xs font-black uppercase tracking-wide text-phx-ink-faint">{label}</div>
      <div className={cn("mt-0.5 text-sm font-black tabular-nums", accent ? "text-phx-accent" : "text-phx-ink")}>{value}</div>
    </div>
  );
}

export function BreakdownTable({ title, headLabel, rows }: { title: string; headLabel: string; rows: BreakdownRow[] }) {
  return (
    <div className="overflow-hidden rounded-[6px] border border-phx-line">
      <div className={darkHead}>{title}</div>
      <div className="max-h-72 overflow-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-phx-xs font-bold uppercase text-phx-ink-faint">
            <tr>
              <th className="px-3 py-1.5">{headLabel}</th>
              <th className="px-3 py-1.5 text-right">Qty</th>
              <th className="px-3 py-1.5 text-right">Bonus</th>
              <th className="px-3 py-1.5 text-right">Value</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td className="px-3 py-3 text-center text-phx-ink-faint" colSpan={4}>—</td></tr>}
            {rows.map((r) => (
              <tr className="border-t border-[#FFE8D6]" key={r.code}>
                <td className="px-3 py-1.5 font-semibold text-phx-ink">{r.label}{r.parent ? <span className="ml-1 text-phx-xs font-medium text-phx-ink-faint">· {r.parent}</span> : null}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-phx-ink-2">{num(r.totalQty)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-phx-ink-2">{num(r.totalBonusQty)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-phx-ink-2">{money(r.totalValue)}</td>
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

// Large workbooks (> ~4MB) can't be POSTed through the serverless function — Vercel caps the request
// body at ~4.5MB (FUNCTION_PAYLOAD_TOO_LARGE). Those upload straight to the "sales-imports" Storage
// bucket via a short-lived signed URL, then the endpoint is called by reference (storagePath JSON).
// Small files keep the original direct multipart POST. Mirrors the proven /sales/import path; the
// server resolves both shapes via resolveUploadedSpreadsheet and deletes the temp object afterwards.
const LARGE_FILE_THRESHOLD = 4 * 1024 * 1024;

async function postSalesUpload(endpoint: string, file: File, fields: Record<string, string | undefined>): Promise<Response> {
  const entries = Object.entries(fields).filter(([, v]) => v != null && v !== "") as [string, string][];
  if (file.size <= LARGE_FILE_THRESHOLD) {
    const fd = new FormData();
    fd.append("file", file);
    for (const [key, value] of entries) fd.append(key, value);
    return fetch(endpoint, { body: fd, method: "POST" });
  }
  const urlRes = await fetch("/api/sales/monthly-import/upload-url", {
    body: JSON.stringify({ fileName: file.name }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const urlPayload = (await urlRes.json().catch(() => ({}))) as { signedUrl?: string; path?: string; error?: string };
  if (!urlRes.ok || !urlPayload.signedUrl || !urlPayload.path) {
    throw new Error(urlPayload.error ?? "Could not start the upload for this large file.");
  }
  const putRes = await fetch(urlPayload.signedUrl, {
    body: file,
    headers: {
      "content-type": file.type || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "x-upsert": "false",
    },
    method: "PUT",
  });
  if (!putRes.ok) throw new Error("The file could not be uploaded. Please try again.");
  return fetch(endpoint, {
    body: JSON.stringify({ storagePath: urlPayload.path, ...Object.fromEntries(entries) }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

function ProfileViewer({ summary }: { summary?: DistributorProfileSummary }) {
  if (!summary) {
    return <AdminCallout tone="neutral"><span>No recognition profile for this distributor yet. Set one up in <Link className="font-semibold text-phx-accent underline" href="/sales/database-mapping">Master Data &amp; Profiles</Link>.</span></AdminCallout>;
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
    <div className="rounded-xl border border-phx-line">
      <div className="border-b border-phx-line px-4 py-2 text-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">What the system reads in this distributor&apos;s file</div>
      <table className="w-full text-sm">
        <tbody>
          {rows.map((r) => (
            <tr className="border-b border-phx-paper-2 last:border-0" key={r.label}>
              <td className="w-40 px-4 py-1.5 font-semibold text-phx-ink">{r.label}</td>
              <td className="px-4 py-1.5 font-mono text-xs text-phx-ink-soft">{r.value.length ? r.value.join(", ") : <span className="italic text-phx-ink-faint">—</span>}</td>
            </tr>
          ))}
          <tr>
            <td className="px-4 py-1.5 font-semibold text-phx-ink">Value</td>
            <td className="px-4 py-1.5 text-xs text-phx-ink-soft">{summary.valueSource === "sheet" ? "taken from the sheet" : "recomputed from master price"}{summary.hasDateColumn ? "" : " · no date column — pick a period"}</td>
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
    <div className="space-y-2 rounded-xl border border-phx-line p-3">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-phx-ink" />
        <span className="text-xs font-black uppercase tracking-[0.12em] text-phx-ink-soft">Strict validation</span>
        <span className={cn("ml-auto rounded-full border px-2.5 py-0.5 text-phx-xs font-bold", headline.tone)}>{headline.text}</span>
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
                  <p className="text-sm font-bold text-phx-ink">{f.title}{f.count > 1 ? <span className="ml-1 font-mono text-xs text-phx-ink-soft">×{f.count.toLocaleString()}</span> : null}</p>
                  <p className="text-xs text-phx-ink-2">{f.detail}</p>
                  {f.fixHint ? <p className="mt-0.5 text-xs italic text-phx-ink-soft">{f.fixHint}</p> : null}
                  {f.sampleRows.length > 0 ? <p className="mt-0.5 font-mono text-phx-xs text-phx-ink-faint">rows: {f.sampleRows.map((row, i) => f.sampleProducts?.[i] ? `${row} (${f.sampleProducts[i]})` : row).join(", ")}{f.count > f.sampleRows.length ? "…" : ""}</p> : null}
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

// One answer from /api/sales/monthly-import/ai-suggest. A product answer carries why it was chosen (a
// sister distributor's mapping of the same item code, the same name mapped elsewhere, the one product of
// that strength, or the AI's own reason) or, with no code, why nothing was safe to pick.
type AiProductAnswer = { raw: string; code: string | null; confidence: number; source?: string | null; reason?: string | null };

function AiAnswerNote({ answer, productOptions }: { answer: AiProductAnswer; productOptions: MapOption[] }) {
  if (!answer.code) {
    return <p className="mt-0.5 text-phx-xs text-phx-ink-soft">AI: no safe match{answer.reason ? ` — ${answer.reason}` : ""}</p>;
  }
  const label = answer.code === IGNORE_PRODUCT_CODE ? "keep as ignored" : (productOptions.find((o) => o.code === answer.code)?.name ?? answer.code);
  return (
    <p className="mt-0.5 text-phx-xs text-violet-700">
      AI {answer.confidence}% → {label}{answer.reason ? ` — ${answer.reason}` : ""}
    </p>
  );
}

async function fetchAiProductAnswers(distributorCode: string, unknowns: { raw: string; rawName?: string }[]): Promise<AiProductAnswer[]> {
  const res = await fetch("/api/sales/monthly-import/ai-suggest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ distributorCode, kind: "product", unknowns }),
  });
  const payload = await readJson<{ success: boolean; data?: { suggestions: AiProductAnswer[] }; error?: string }>(res);
  if (!payload.success) throw new Error(payload.error ?? "AI suggest failed.");
  return payload.data?.suggestions ?? [];
}

function IgnoredItemsReview({ items, productOptions, distributorCode, onSaved, onIgnoresConfirmed, aiEnabled }: { items: IgnoredItem[]; productOptions: MapOption[]; distributorCode: string; onSaved: () => void; onIgnoresConfirmed: (raws: string[]) => void; aiEnabled: boolean }) {
  const [decisions, setDecisions] = useState<Record<string, "ignore" | "include">>({});
  const [productCodes, setProductCodes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiAnswers, setAiAnswers] = useState<Record<string, AiProductAnswer>>({});

  // AI suggest pre-fills each decision ("keep as ignored", or "include" with the product) and never
  // applies it: Apply decisions stays the user's press. An item with no safe answer stays undecided.
  async function runAiSuggest() {
    setAiBusy(true); setErr(null);
    try {
      const answers = await fetchAiProductAnswers(distributorCode, items.map((i) => ({ raw: i.raw, rawName: i.displayName !== i.raw ? i.displayName : "" })));
      const byRaw: Record<string, AiProductAnswer> = {};
      for (const a of answers) byRaw[a.raw] = a;
      setAiAnswers(byRaw);
      setDecisions((prev) => {
        const next = { ...prev };
        for (const a of answers) if (a.code) next[a.raw] = a.code === IGNORE_PRODUCT_CODE ? "ignore" : "include";
        return next;
      });
      setProductCodes((prev) => {
        const next = { ...prev };
        for (const a of answers) if (a.code) next[a.raw] = a.code === IGNORE_PRODUCT_CODE ? "" : a.code;
        return next;
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "AI suggest failed.");
    } finally {
      setAiBusy(false);
    }
  }
  // When all items are "keep" and applied, collapse the panel into a compact done banner.
  const [doneBanner, setDoneBanner] = useState<string | null>(null);

  const allDecided = items.every((item) => {
    const d = decisions[item.raw];
    if (!d) return false;
    if (d === "ignore") return true;
    return Boolean(productCodes[item.raw]?.trim());
  });

  const undecidedCount = items.filter((item) => !decisions[item.raw]).length;

  const includeItems = items.filter((item) => decisions[item.raw] === "include" && productCodes[item.raw]?.trim());
  const keepItems = items.filter((item) => decisions[item.raw] === "ignore");

  async function apply() {
    if (!allDecided) return;
    setBusy(true); setErr(null);
    try {
      if (includeItems.length > 0) {
        const mappings = includeItems.map((item) => ({ type: "product" as const, raw: item.raw, code: productCodes[item.raw].trim() }));
        const res = await fetch("/api/sales/monthly-import/save-mappings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ distributorCode, mappings }),
        });
        const payload = await readJson<{ success: boolean; error?: string }>(res);
        if (!payload.success) { setErr(payload.error ?? "Save failed."); setBusy(false); return; }
      }
      if (keepItems.length > 0) onIgnoresConfirmed(keepItems.map((i) => i.raw));
      if (includeItems.length > 0) {
        // Re-validate so the newly-mapped products drop out of the ignored list.
        onSaved();
      } else {
        // All items kept as ignored — collapse the panel and let the user scroll to "Confirm & Upload".
        const kn = keepItems.length;
        setDoneBanner(`${kn} product${kn === 1 ? "" : "s"} confirmed as ignored — scroll down to the "Confirm & Upload" button.`);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed.");
    } finally {
      setBusy(false);
    }
  }

  // Collapsed "done" state — show compact banner so the user clearly sees something happened.
  if (doneBanner) {
    return (
      <div className="flex items-center gap-2 rounded-[6px] border border-emerald-200 bg-emerald-50 px-3 py-2.5">
        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
        <p className="text-sm font-semibold text-emerald-700">{doneBanner}</p>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-[6px] border border-slate-300 bg-slate-50/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-bold text-phx-ink">Review ignored items — {items.length} product{items.length === 1 ? "" : "s"} set to ignore</p>
        {aiEnabled ? (
          <button
            className="inline-flex h-6 items-center gap-1 rounded-[6px] border border-violet-300 bg-violet-50 px-2 text-phx-xs font-bold text-violet-700 transition hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={aiBusy || busy}
            onClick={() => void runAiSuggest()}
            title="Pre-fill each decision from what other distributors already map these items to"
            type="button"
          >
            {aiBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
            AI suggest
          </button>
        ) : null}
      </div>
      <p className="text-xs text-phx-ink-2">These products appeared in the sheet but were previously set to be ignored. You must explicitly decide what to do with each one before uploading. Nothing is silently excluded without your decision.</p>
      <div className="overflow-visible rounded-[6px] border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="text-left text-phx-xs font-bold uppercase text-phx-ink-faint">
            <tr>
              <th className="px-3 py-1.5">Product</th>
              <th className="px-3 py-1.5 text-right">Rows</th>
              <th className="px-3 py-1.5">Your decision</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const decision = decisions[item.raw];
              return (
                <tr className="border-t border-slate-100" key={item.raw}>
                  <td className="px-3 py-2">
                    {item.displayName !== item.raw ? (
                      <span className="font-medium text-phx-ink">{item.displayName}<span className="ml-1 font-mono text-phx-xs text-phx-ink-faint">({item.raw})</span></span>
                    ) : (
                      <span><span className="font-mono text-xs font-semibold text-phx-ink">{item.raw}</span><span className="ml-1 text-phx-xs text-phx-ink-faint">no name in sheet</span></span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-phx-ink-2">{item.count.toLocaleString()}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <select
                        className={phxSelectClassName}
                        onChange={(e) => {
                          const v = e.target.value as "ignore" | "include" | "";
                          setDecisions((p) => ({ ...p, [item.raw]: v as "ignore" | "include" }));
                          if (v !== "include") setProductCodes((p) => ({ ...p, [item.raw]: "" }));
                        }}
                        value={decision ?? ""}
                      >
                        <option value="">— review required —</option>
                        <option value="ignore">Keep as ignored (exclude from sales)</option>
                        <option value="include">Include → map to product</option>
                      </select>
                      {decision === "include" ? (
                        <div className="w-56">
                          <MappingCombobox
                            onChange={(code) => setProductCodes((p) => ({ ...p, [item.raw]: code }))}
                            options={productOptions}
                            placeholder="product code (e.g. TE001)"
                            value={productCodes[item.raw] ?? ""}
                          />
                        </div>
                      ) : null}
                    </div>
                    {aiAnswers[item.raw] ? <AiAnswerNote answer={aiAnswers[item.raw]} productOptions={productOptions} /> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {err ? <p className="text-xs text-rose-600">{err}</p> : null}
      <div className="flex items-center gap-3">
        <button
          className="rounded-[6px] bg-phx-ink px-4 py-2 text-xs font-bold text-white transition hover:bg-[#1E293B] disabled:cursor-not-allowed disabled:opacity-40"
          disabled={!allDecided || busy}
          onClick={() => void apply()}
          type="button"
        >
          {busy ? "Saving…" : `Apply decisions (${items.length} item${items.length === 1 ? "" : "s"})`}
        </button>
        {!allDecided && undecidedCount > 0 ? (
          <span className="text-xs font-medium text-amber-700">{undecidedCount} item{undecidedCount === 1 ? "" : "s"} still need a decision above.</span>
        ) : null}
      </div>
    </div>
  );
}

function UnmappedList({ products, customers, territories, productOptions, brickOptions, distributorCode, onSaved, aiEnabled }: { products: UnknownItem[]; customers: UnknownItem[]; territories: UnknownItem[]; productOptions: MapOption[]; brickOptions: MapOption[]; distributorCode: string; onSaved: () => void; aiEnabled: boolean }) {
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
  const [excluded, setExcluded] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState<MapType | null>(null);
  const [aiAnswers, setAiAnswers] = useState<Record<string, AiProductAnswer>>({});

  if (groups.length === 0) return null;

  // AI suggest — same engine the Normalizer page uses (src/lib/sales/normalizer/ai-suggest.ts),
  // reached here via the non-gated /api/sales/monthly-import/ai-suggest endpoint (same "sales:import"
  // permission this page already requires). Suggest-only: pre-fills the dropdowns, never auto-saves.
  // Product + territory only — customer matching needs the richer geo pipeline that's reserved for
  // the Super-Admin-only Normalizer/Mapping surfaces, so that group stays manual here.
  async function runAiSuggest(type: "product" | "territory") {
    const group = allGroups.find((g) => g.type === type);
    const items = group?.items ?? [];
    if (items.length === 0) return;
    setAiBusy(type); setErr(null); setMsg(null);
    try {
      if (type === "product") {
        // Products: every item comes back, matched with its reason, IGNORE (pre-set to Exclude), or with
        // no code and the reason nothing was safe, which leaves the row blank rather than guessing.
        const answers = await fetchAiProductAnswers(distributorCode, items.map((u) => ({ raw: u.raw, rawName: u.rawName })));
        const notes: Record<string, AiProductAnswer> = {};
        let filled = 0;
        for (const a of answers) {
          notes[mapKey("product", a.raw)] = a;
          if (a.code === IGNORE_PRODUCT_CODE) { exclude("product", a.raw); filled += 1; }
          else if (a.code) { setCode("product", a.raw, a.code); filled += 1; }
          else setCode("product", a.raw, "");
        }
        setAiAnswers((p) => ({ ...p, ...notes }));
        setMsg(`AI pre-filled ${filled} of ${items.length} — review, then save.`);
        return;
      }
      const res = await fetch("/api/sales/monthly-import/ai-suggest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: type, unknowns: items.map((u) => ({ raw: u.raw, rawName: u.rawName })) }),
      });
      const payload = await readJson<{ success: boolean; data?: { suggestions: { raw: string; code: string }[] }; error?: string }>(res);
      if (!payload.success) { setErr(payload.error ?? "AI suggest failed."); return; }
      for (const s of payload.data?.suggestions ?? []) setCode(type, s.raw, s.code);
      setMsg(`AI pre-filled ${(payload.data?.suggestions ?? []).length} of ${items.length} — review, then save.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "AI suggest failed.");
    } finally {
      setAiBusy(null);
    }
  }

  // A customer mapping carries the pharmacy's name and address from the sheet: the server stores them
  // on the mapping where its own fields are blank, so the next pharmacy can be matched against it.
  const readyMapped = groups.flatMap((g) => g.items
    .filter((u) => !excluded[mapKey(g.type, u.raw)] && confirmed[mapKey(g.type, u.raw)] && (selected[mapKey(g.type, u.raw)] ?? "").trim())
    .map((u) => ({
      type: g.type,
      raw: u.raw,
      code: selected[mapKey(g.type, u.raw)].trim(),
      ...(g.type === "customer" ? { name: u.rawName, address: u.rawAddress } : {}),
    })));
  const readyExcluded = groups
    .filter((g) => g.type === "product")
    .flatMap((g) => g.items
      .filter((u) => excluded[mapKey(g.type, u.raw)])
      .map((u) => ({ type: g.type as MapType, raw: u.raw, code: IGNORE_PRODUCT_CODE })));
  const ready = [...readyMapped, ...readyExcluded];

  // The single customer fix-list: one row per distinct unmapped customer, carrying everything the
  // distributor sheet knows (name / address / area) so the operator can pick the brick offline. Headers
  // match HEADER_ALIASES in importCustomerMap() exactly, so once Brick ID is filled the SAME file
  // uploads back via Mapping tab → Customer/Brick template slot. Blank Brick ID = leave for later.
  const customerFixRows: ExportRow[] = customers.map((u) => ({
    distCode: distributorCode,
    customerCode: u.raw,
    customerName: u.rawName ?? "",
    address: u.rawAddress ?? "",
    area: u.rawTerritory ?? "",
    brickId: "",
  }));

  function setCode(type: MapType, raw: string, code: string) {
    const k = mapKey(type, raw);
    setSelected((p) => ({ ...p, [k]: code }));
    setConfirmed((p) => ({ ...p, [k]: code.trim().length > 0 })); // picking a value confirms; clearing un-confirms
    setExcluded((p) => ({ ...p, [k]: false })); // un-exclude if user starts mapping
  }
  function toggle(type: MapType, raw: string, on: boolean) {
    setConfirmed((p) => ({ ...p, [mapKey(type, raw)]: on }));
  }
  function exclude(type: MapType, raw: string) {
    const k = mapKey(type, raw);
    setExcluded((p) => ({ ...p, [k]: true }));
    setConfirmed((p) => ({ ...p, [k]: false }));
  }
  function unexclude(type: MapType, raw: string) {
    setExcluded((p) => ({ ...p, [mapKey(type, raw)]: false }));
  }
  const mapCount = readyMapped.length;
  const exclCount = readyExcluded.length;
  const saveLabel = mapCount > 0 && exclCount > 0
    ? `Map ${mapCount}, exclude ${exclCount}`
    : mapCount > 0
      ? `Save ${mapCount} mapping${mapCount === 1 ? "" : "s"}`
      : `Exclude ${exclCount}`;

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
        <p className="text-phx-xs font-black uppercase tracking-[0.14em] text-amber-800">Map these here, then re-validate</p>
        <div className="flex items-center gap-2">
          {msg ? <span className="text-xs font-semibold text-emerald-700">{msg}</span> : null}
          {err ? <span className="text-xs font-semibold text-rose-700">{err}</span> : null}
          {customers.length > 0 ? (
            <ExportXlsxButton
              className="h-8 border border-orange-300 bg-orange-50 text-orange-700 hover:bg-orange-100"
              columns={CUSTOMER_FIX_COLUMNS}
              label="Customer fix template (XLSX)"
              rows={customerFixRows}
              sheetName="Customer Mapping"
              subtitle={`${distributorCode} · ${customerFixRows.length} customer(s) · fill the Brick ID column (name / address / area are there to help), then upload via Mapping tab → Customer/Brick Mapping`}
              title={`Customer Fix Template — ${distributorCode}`}
            />
          ) : null}
          <button
            className="inline-flex h-8 items-center gap-1.5 rounded-[6px] bg-phx-ink px-3 text-xs font-black text-white transition hover:bg-[#1E293B] disabled:cursor-not-allowed disabled:bg-phx-line-strong"
            disabled={busy || ready.length === 0}
            onClick={() => void save()}
            type="button"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            {busy ? "Saving…" : saveLabel}
          </button>
        </div>
      </div>
      {groups.map((g) => (
        <div key={g.type}>
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-phx-xs font-bold uppercase tracking-wide text-amber-700">{g.label} ({g.items.length})</span>
            {aiEnabled && g.type !== "customer" ? (
              <button
                className="inline-flex h-6 items-center gap-1 rounded-[6px] border border-violet-300 bg-violet-50 px-2 text-phx-xs font-bold text-violet-700 transition hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={aiBusy !== null}
                onClick={() => void runAiSuggest(g.type as "product" | "territory")}
                title="Let AI pre-fill these from the mapping database"
                type="button"
              >
                {aiBusy === g.type ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                AI suggest
              </button>
            ) : null}
          </div>
          <div className="overflow-visible rounded-[6px] border border-amber-200 bg-white">
            <table className="w-full text-sm">
              <thead className="text-left text-phx-xs font-bold uppercase text-phx-ink-faint">
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
                      <td className="px-3 py-1.5 align-top font-mono text-xs font-semibold text-phx-ink">{u.raw || <span className="italic text-phx-ink-faint">(blank)</span>}</td>
                      <td className="px-3 py-1.5 align-top text-phx-ink-2">{u.rawName || <span className="italic text-phx-ink-faint">—</span>}</td>
                      <td className="px-3 py-1.5 text-right align-top tabular-nums text-phx-ink-2">{u.count.toLocaleString()}</td>
                      <td className="px-3 py-1.5">
                        {excluded[k] ? (
                          <div className="flex items-center gap-2">
                            <span className="rounded-full bg-phx-paper px-2 py-0.5 text-phx-xs font-bold text-phx-ink-soft">Excluded — rows will be skipped</span>
                            <button className="text-phx-xs text-phx-ink-soft underline hover:text-phx-ink" onClick={() => unexclude(g.type, u.raw)} type="button">Undo</button>
                          </div>
                        ) : (
                          <>
                            <div className="flex items-center gap-2">
                              <input
                                aria-label="include this mapping"
                                checked={Boolean(confirmed[k])}
                                className="h-4 w-4 shrink-0 accent-phx-accent"
                                onChange={(e) => toggle(g.type, u.raw, e.target.checked)}
                                type="checkbox"
                              />
                              <div className="w-56"><MappingCombobox onChange={(c) => setCode(g.type, u.raw, c)} options={g.options} placeholder={g.placeholder} value={selected[k] ?? ""} /></div>
                              {g.type === "product" ? (
                                <button
                                  className="shrink-0 rounded px-1.5 py-0.5 text-phx-xs font-bold text-phx-ink-faint transition hover:bg-slate-100 hover:text-slate-600"
                                  onClick={() => exclude(g.type, u.raw)}
                                  title="Exclude — skip all rows with this product instead of mapping it"
                                  type="button"
                                >
                                  × Excl
                                </button>
                              ) : null}
                            </div>
                            {aiAnswers[k] && (selected[k] ?? "") === (aiAnswers[k].code ?? "") ? (
                              <div className="pl-6"><AiAnswerNote answer={aiAnswers[k]} productOptions={g.options} /></div>
                            ) : u.suggestionLabel && (selected[k] ?? "") === (u.suggestionCode ?? "") ? (
                              <p className="mt-0.5 pl-6 text-phx-xs text-phx-ink-soft">Suggested: {u.suggestionLabel}{u.suggestionCode ? ` (${u.suggestionCode})` : ""}</p>
                            ) : null}
                          </>
                        )}
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

type MonthlyUploadProps = {
  distributorCode: string;
  distributorName: string;
  hasProfile: boolean;
  hasDateColumn: boolean;
  onUploaded?: () => void;
  productOptions: MapOption[];
  brickOptions: MapOption[];
  aiEnabled: boolean;
  /** Bulk mode only: seed the period from the shared month picker (format "YYYY-MM"). */
  initialPeriod?: string;
  /** Bulk mode only: reports this slot's stage upward so the distributor grid can color its card. */
  onStatusChange?: (status: BulkSlotStatus) => void;
};

export const MonthlyUpload = forwardRef<MonthlyUploadHandle, MonthlyUploadProps>(function MonthlyUpload({ distributorCode, distributorName, hasProfile, hasDateColumn, onUploaded, productOptions, brickOptions, aiEnabled, initialPeriod, onStatusChange }, ref) {
  const fileRef = useRef<HTMLInputElement>(null);
  const analyzingRef = useRef(false);
  const [file, setFile] = useState<File | null>(null);
  const initialParts = initialPeriod && /^\d{4}-\d{2}$/.test(initialPeriod) ? initialPeriod.split("-") : null;
  const [period, setPeriod] = useState(initialPeriod && initialParts ? initialPeriod : "");
  const [periodMonth, setPeriodMonth] = useState(initialParts ? initialParts[1] : "");
  const [periodYear, setPeriodYear] = useState(initialParts ? initialParts[0] : "");
  const [busy, setBusy] = useState<"verify" | "analyze" | "commit" | null>(null);
  const [analysis, setAnalysis] = useState<AnalyzeResponse | null>(null);
  const [committed, setCommitted] = useState<CommitResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detected, setDetected] = useState<{ code: string; name: string; confidence: string } | null>(null);
  const [verified, setVerified] = useState(false);
  const [periodAutoDetected, setPeriodAutoDetected] = useState(false);
  // True once an auto-detection attempt has finished — even when it found nothing. Lets the UI always
  // show a result (and a way to continue) instead of silently leaving the operator with a locked step.
  const [verifyRan, setVerifyRan] = useState(false);
  // Tracks which ignored-product raw keys the user has explicitly confirmed "keep as ignored" this session.
  const [confirmedIgnoreRaws, setConfirmedIgnoreRaws] = useState<Set<string>>(new Set());
  // Any change to file/period/distributor invalidates the verification + validation downstream.
  function resetDownstream() { setVerified(false); setVerifyRan(false); setAnalysis(null); setCommitted(null); setError(null); setConfirmedIgnoreRaws(new Set()); }
  function changePeriod(value: string) { setPeriod(value); setPeriodAutoDetected(false); setAnalysis(null); setCommitted(null); }
  function onMonthChange(m: string) { setPeriodMonth(m); changePeriod(m && periodYear ? `${periodYear}-${m}` : ""); }
  function onYearChange(y: string) { setPeriodYear(y); changePeriod(y && periodMonth ? `${y}-${periodMonth}` : ""); }
  function onPickFile(f: File | null) { setFile(f); setDetected(null); resetDownstream(); setPeriodAutoDetected(false); if (f) void detect(f); }

  function applyAutoDetectedPeriod(detectedPeriod: string) {
    const [y, m] = detectedPeriod.split("-");
    if (!y || !m) return;
    setPeriodYear(y);
    setPeriodMonth(m);
    setPeriod(detectedPeriod);
    setPeriodAutoDetected(true);
  }

  async function detect(f: File) {
    setDetected(null); setVerifyRan(false);
    // Detection is advisory; for large files skip the extra Storage upload but still mark verification
    // as run so the operator gets the "confirm this distributor" path (Analyze re-validates anyway).
    if (f.size > LARGE_FILE_THRESHOLD) { setVerifyRan(true); return; }
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

  const productUnknowns = analysis?.data ? analysis.data.unknownProducts.length : 0;
  const blockerUnknowns = analysis?.data ? analysis.data.unknownTerritories.length + analysis.data.unknownCustomers.length : 0;
  const ignoredItems = analysis?.data?.ignoredItems ?? [];
  // Gate: every ignore_mapped item must be explicitly reviewed (either confirmed-ignore or mapped-include).
  const ignoredUnreviewed = ignoredItems.some((item) => !confirmedIgnoreRaws.has(item.raw));
  const validation = analysis?.validation ?? null;
  // Only the duplicate-sheet error (report.ok === false) blocks here; warnings are advisory and never
  // block (mirrors the server gate exactly). Unmapped customers/bricks block; unmapped products warn
  // only (auto-excluded on commit — those rows are already absent from the coded set).
  const validationBlocks = validation ? !validation.ok : false;
  const canImport = Boolean(analysis?.success) && blockerUnknowns === 0 && !ignoredUnreviewed && (!analysis?.needsPeriod || /^\d{4}-\d{2}$/.test(period)) && !validationBlocks;
  const breakdowns = analysis?.breakdowns ?? null;

  // Step-1 panel decision (pure, regression-tested): guarantees a Confirm path for EVERY finished
  // detection outcome so the operator can never be silently locked out of Step 2. See
  // src/lib/sales/upload-verification-step.ts.
  const verifyStep = resolveVerificationStep({ ran: verifyRan, detectedCode: detected?.code ?? null, selectedCode: distributorCode });
  const confirmClass = verifyStep.panel === "mismatch"
    ? "border border-amber-300 bg-white text-amber-800 hover:bg-amber-50"
    : verifyStep.panel === "unrecognized"
      ? "bg-phx-ink text-white hover:bg-[#1E293B]"
      : "bg-phx-accent text-white hover:bg-[#EA6A0C]";
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
    // Refs are synchronous — this blocks re-entry even when onSaved() auto-triggers and the
    // user also presses Validate in the same render cycle (before busy state propagates).
    if (analyzingRef.current) return;
    analyzingRef.current = true;
    setBusy("analyze"); setError(null); setAnalysis(null); setCommitted(null);
    try {
      const res = await postSalesUpload("/api/sales/sales-upload/analyze", file, { distributorCode, period });
      const payload = await readJson<AnalyzeResponse>(res);
      setAnalysis(payload);
      // Auto-fill the period dropdowns when the sheet holds one month and the user hasn't set one yet.
      // A multi-month sheet is left blank: picking the month is the operator's choice.
      const detectedPeriod = periodToAutoFill(payload.data, period);
      if (detectedPeriod) applyAutoDetectedPeriod(detectedPeriod);
      if (!payload.success) setError(payload.error ?? "Validation failed.");
    } catch (e) { setError(e instanceof Error ? e.message : "Validation failed."); }
    finally { setBusy(null); analyzingRef.current = false; }
  }

  // ── Step 3 — Confirm & upload (persist) ── wrapped in useCallback so the imperative handle below
  // (bulk mode's "Confirm & Import All") only gets a new commit reference when something it actually
  // closes over changes, instead of on every render.
  const commit = useCallback(async () => {
    if (!file) return;
    setBusy("commit"); setError(null);
    try {
      const res = await postSalesUpload("/api/sales/sales-upload/commit", file, { distributorCode, period });
      const payload = await readJson<CommitResponse>(res);
      setCommitted(payload);
      if (!payload.success) setError(payload.error ?? "Import failed.");
      else onUploaded?.();
    } catch (e) { setError(e instanceof Error ? e.message : "Import failed."); }
    finally { setBusy(null); }
  }, [file, distributorCode, period, onUploaded]);

  const rec = analysis?.success ? (analysis.reconciliation ?? null) : null;

  // Bulk mode: expose the SAME commit() this component's own "Confirm & Upload" button calls, so the
  // bulk grid's "Confirm & Import All" can trigger it externally without duplicating commit logic.
  useImperativeHandle(ref, () => ({ commit }), [commit]);

  // Bulk mode: report this slot's stage upward for the distributor grid's card coloring. No-op when
  // onStatusChange isn't passed (the single-distributor page never passes it, so its behavior is
  // unchanged). Mirrors the exact same gates the Step 2/3 UI below already renders from.
  useEffect(() => {
    if (!onStatusChange) return;
    let stage: BulkSlotStage = "idle";
    if (committed?.success) stage = "committed";
    else if (committed && !committed.success) stage = "commit_failed";
    else if (analysis?.success && canImport) stage = "ready";
    else if (analysis && (!analysis.success || blockerUnknowns > 0 || validationBlocks)) stage = "rejected";
    else if (file) stage = "working";
    onStatusChange({
      breakdowns,
      canImport,
      error,
      fileName: file?.name ?? null,
      reconciliation: rec,
      stage,
    });
  }, [committed, analysis, canImport, blockerUnknowns, validationBlocks, file, rec, breakdowns, error, onStatusChange]);

  return (
    <div className="space-y-4">
      {/* File + period selectors */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-phx-2xs font-black uppercase tracking-[0.12em] text-phx-ink-faint">Period{hasDateColumn ? " (optional)" : " (required)"}</span>
            {periodAutoDetected && <span className="inline-flex items-center gap-1 rounded-full bg-phx-ok-bg px-2 py-0.5 text-phx-2xs font-bold text-phx-ok ring-1 ring-phx-ok-line"><CheckCircle2 className="h-3 w-3" /> Auto-detected</span>}
          </div>
          <div className="flex gap-1">
            <select className={cn(phxSelectClassName, periodAutoDetected ? "border-emerald-300 bg-emerald-50/40" : "")} disabled={busy !== null} onChange={(e) => onMonthChange(e.target.value)} value={periodMonth}>
              <option value="">Month</option>
              {MONTHS.map((m, i) => <option key={m} value={String(i + 1).padStart(2, "0")}>{m}</option>)}
            </select>
            <select className={cn(phxSelectClassName, periodAutoDetected ? "border-emerald-300 bg-emerald-50/40" : "")} disabled={busy !== null} onChange={(e) => onYearChange(e.target.value)} value={periodYear}>
              <option value="">Year</option>
              {UPLOAD_YEARS.map((y) => <option key={y} value={String(y)}>{y}</option>)}
            </select>
          </div>
        </div>
        <Button className="h-9 gap-2 bg-[#0B0B0B] font-black text-white hover:bg-phx-accent" disabled={!hasProfile || busy !== null} onClick={() => fileRef.current?.click()} type="button">
          <FileText className="h-4 w-4" />{file ? file.name.slice(0, 28) : "Choose raw sheet"}
        </Button>
        <input accept=".xlsx" className="hidden" onChange={(e) => onPickFile(e.target.files?.[0] ?? null)} ref={fileRef} type="file" />
      </div>

      {error ? <AdminCallout tone="danger"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span></AdminCallout> : null}

      {/* ── Step 1: AI verification ── */}
      <div className="border-t border-dashed border-phx-line pt-4">
        <StepBadge active={!verified} done={verified} label="AI verification" n={1} />
        <p className="mt-1 text-xs font-medium text-phx-ink-soft">
          Reads the file&apos;s headers and confirms which distributor it is and which column feeds product, quantity, date, customer and territory (shown above). Nothing is stored.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button className="inline-flex h-10 items-center gap-2 rounded-[6px] border border-[#020617] bg-white px-4 text-sm font-black text-phx-ink transition hover:bg-phx-paper disabled:opacity-60" disabled={busy !== null || !file} onClick={handleVerify} type="button">
            {busy === "verify" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4 text-phx-accent" />}
            {busy === "verify" ? "Analyzing…" : verifyRan ? "Re-run verification" : "Run AI verification"}
          </button>
          {!file && <span className="text-xs font-medium text-phx-ink-faint">Pick the raw sheet above first.</span>}
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
      <div className={cn("border-t border-dashed border-phx-line pt-4", !verified && "opacity-60")}>
        <StepBadge active={verified && !analysis?.success} done={Boolean(analysis?.success)} label="Strict validation" n={2} />
        <p className="mt-1 text-xs font-medium text-phx-ink-soft">
          Parses the sheet, maps every product / territory / customer, runs the strict rules, and shows totals per product, per region and per brick. Nothing is stored yet.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button className="inline-flex h-10 items-center gap-2 rounded-[6px] bg-phx-ink px-4 text-sm font-black text-white transition hover:bg-[#1E293B] disabled:cursor-not-allowed disabled:bg-phx-line-strong" disabled={busy !== null || !verified || !hasProfile} onClick={() => void analyze()} type="button">
            {busy === "analyze" ? <Loader2 className="h-4 w-4 animate-spin" /> : !verified ? <Lock className="h-4 w-4" /> : <FileUp className="h-4 w-4" />}
            {busy === "analyze" ? "Validating…" : "Validate"}
          </button>
          {!verified && <span className="inline-flex items-center gap-1 text-xs font-semibold text-phx-ink-faint"><Lock className="h-3.5 w-3.5" /> Complete AI verification above to unlock.</span>}
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
          <div className={cn("flex flex-wrap items-center gap-2 border-b border-phx-line px-4 py-3 text-sm font-black", canImport ? "text-emerald-700" : "text-amber-700")}>
            {canImport ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
            {canImport ? `Validation passed — ${num(rec.rowsCoded)} rows ready to upload` : "Validation blocked — resolve the items below"}
          </div>

          {/* KPI strip (reconciliation receipt) */}
          <div className="grid grid-cols-2 gap-px bg-phx-line sm:grid-cols-3 lg:grid-cols-6">
            <Metric label="Rows read" value={num(rec.rowsRead)} />
            <Metric accent label="Coded" value={num(rec.rowsCoded)} />
            <Metric label="Ignored" value={num(rec.rowsIgnored)} />
            <Metric label="Blank cust." value={num(rec.rowsBlankCustomer)} />
            <Metric label="Blocked" value={num(rec.rowsBlocked)} />
            <Metric accent label="Total value" value={money(rec.totalValue)} />
          </div>

          {/* Unmapped / period gates */}
          <div className="space-y-2 px-4 pt-4">
            {/* Free goods: excluded from sales by the standing rule, never silently. Without this the
                screen showed a Qty smaller than the sheet's with nothing to explain the difference. */}
            {(rec.freeGoodsQty ?? 0) > 0 ? (
              <AdminCallout tone="neutral"><div>
                <p className="font-semibold">{num(rec.freeGoodsQty ?? 0)} unit(s) on {num(rec.rowsFreeGoods ?? 0)} row(s) are free goods — excluded from sales, not lost.</p>
                <p className="text-xs">The sheet flags these rows as free goods, and no distributor&apos;s bonus is ever counted as sales. They are listed in the <b>Bonus</b> column of <b>By product</b> below, so Qty + Bonus there equals the quantity in your file.</p>
              </div></AdminCallout>
            ) : null}
            {ignoredItems.length > 0 ? (
              <IgnoredItemsReview
                aiEnabled={aiEnabled}
                distributorCode={distributorCode}
                items={ignoredItems}
                onIgnoresConfirmed={(raws) => setConfirmedIgnoreRaws((prev) => { const next = new Set(prev); raws.forEach((r) => next.add(r)); return next; })}
                onSaved={() => void analyze()}
                productOptions={productOptions}
              />
            ) : null}
            {blockerUnknowns > 0 ? (
              <div className="space-y-2">
                <AdminCallout tone="warning"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><div>
                  <p className="font-semibold">{blockerUnknowns} unmapped customer(s) / territory(ies) — upload is blocked.</p>
                  <p className="text-xs">For customers: click <b>Customer fix template</b> below, fill in the Brick ID column in Excel, then upload the file via <b>Mapping tab → Customer/Brick Mapping</b>. Come back here and re-validate.</p>
                  <p className="text-xs">For territories: use the inline mapping or the Territory Mapping template on the Mapping tab.</p>
                </div></AdminCallout>
                <UnmappedList aiEnabled={aiEnabled} brickOptions={brickOptions} customers={analysis.data?.unknownCustomers ?? []} distributorCode={distributorCode} onSaved={() => void analyze()} productOptions={productOptions} products={[]} territories={analysis.data?.unknownTerritories ?? []} />
              </div>
            ) : null}
            {productUnknowns > 0 ? (
              <div className="space-y-2">
                <AdminCallout tone="warning"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><div>
                  <p className="font-semibold">{productUnknowns} unrecognized product(s) — {num(rec.rowsBlocked)} row(s) will be skipped unless you map them.</p>
                  <p className="text-xs">This does <b>not</b> block the upload. If any of these are our products, map them inline below and re-validate to include them. If they are not ours, leave them — those rows are skipped and you can still confirm the upload as-is.</p>
                </div></AdminCallout>
                <UnmappedList aiEnabled={aiEnabled} brickOptions={brickOptions} customers={[]} distributorCode={distributorCode} onSaved={() => void analyze()} productOptions={productOptions} products={analysis.data?.unknownProducts ?? []} territories={[]} />
              </div>
            ) : null}
            {!blockerUnknowns && !productUnknowns && analysis?.needsPeriod && !/^\d{4}-\d{2}$/.test(period) ? (
              <AdminCallout tone="neutral"><span>This sheet has no date column — pick a period above to upload.</span></AdminCallout>
            ) : null}
            {validation ? <ValidationPanel report={validation} /> : null}
          </div>

          {/* Per product / region / brick / line breakdowns */}
          {breakdowns ? (
            <div className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-2">
              <BreakdownTable headLabel="Product" rows={breakdowns.byProduct} title="By product" />
              <BreakdownTable headLabel="Region" rows={breakdowns.byRegion} title="By region" />
              {!analysis?.isRegionOnly && <BreakdownTable headLabel="Brick" rows={breakdowns.byBrick} title="By brick" />}
              <BreakdownTable headLabel="Line" rows={breakdowns.byLine} title="By line" />
            </div>
          ) : null}

          {/* Step 3 — Confirm & Upload */}
          <div className="border-t border-phx-line px-4 py-4">
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
                <button className="inline-flex h-10 items-center gap-2 rounded-[6px] bg-phx-accent px-5 text-sm font-black text-white transition hover:bg-[#EA6A0C] disabled:cursor-not-allowed disabled:bg-phx-line-strong" disabled={busy !== null} onClick={() => void commit()} type="button">
                  {busy === "commit" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                  {busy === "commit" ? "Uploading…" : "Confirm & Upload"}
                </button>
                <span className="text-xs font-medium text-phx-ink-soft">{productUnknowns > 0 ? `${num(rec.rowsBlocked)} unmapped product row(s) will be excluded — the rest will be stored.` : "Review the totals above, then confirm to store the data."}</span>
              </div>
            ) : (
              <p className="text-xs font-semibold text-amber-700">Fix unmapped customers / territories above, then re-validate before uploading.</p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
});
MonthlyUpload.displayName = "MonthlyUpload";

// Weekly uploads run through the full guided weekly wizard (/sales/weekly) — the same AI verify →
// validate → confirm flow as monthly, plus the weekly column checks and per-week replace. Rather than
// keep a degraded one-click weekly path on the hub (and a second weekly UI to maintain), the hub hands
// off to that single canonical wizard.
function WeeklyUpload({ distributorName }: { distributorName: string }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-[6px] border border-phx-line bg-[#FCFDFE] px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-phx-ink">Weekly sales use the guided weekly wizard</p>
        <p className="mt-0.5 text-xs text-phx-ink-soft">Same AI verify → validate → confirm flow as monthly, with the weekly column checks and per-week replace. Upload {distributorName}&apos;s weekly sheet there.</p>
      </div>
      <Link className="inline-flex h-10 shrink-0 items-center gap-2 rounded-[6px] bg-[#0B0B0B] px-4 text-sm font-black text-white transition hover:bg-phx-accent" href="/sales/weekly">
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
  const chip = (label: string, value: string) => <span className="rounded-full border border-phx-line bg-[#FCFDFE] px-3 py-1 text-xs font-bold text-phx-ink">{label}: {value}</span>;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {readiness ? <span className={cn("rounded-full border px-3 py-1 text-xs font-black", bandTone)}>{readiness.band} · {readiness.score}</span> : null}
      {certification ? <span className="rounded-full border border-phx-line bg-[#FCFDFE] px-3 py-1 text-xs font-bold text-phx-ink-2">Cert: {certification}</span> : null}
      {chip("Customers", health.customerMappings.toLocaleString())}
      {chip("Products", health.productAliases.toLocaleString())}
      {chip("Last monthly", health.lastMonthlyPeriod ?? "—")}
      {health.lastWeeklyWeek ? chip("Last weekly", health.lastWeeklyWeek) : null}
    </div>
  );
}

function DistributorUpload({ selected, summary, productOptions, brickOptions, aiEnabled }: { selected: SalesDistributorEntry; summary?: DistributorProfileSummary; productOptions: MapOption[]; brickOptions: MapOption[]; aiEnabled: boolean }) {
  // Bumped after a successful upload so the health panel ("Last monthly") re-reads.
  const [uploadNonce, setUploadNonce] = useState(0);
  return (
    <div className="space-y-4">
      <Card className={cn(panel, "space-y-3 p-5")}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-black tracking-tight text-slate-900">{selected.name} <span className="font-mono text-sm text-phx-ink-faint">{selected.code}</span></h2>
            <p className="text-xs text-phx-ink-soft">{selected.monthlySupported ? "Monthly ✓" : "No monthly profile"}{selected.weeklySupported ? " · Weekly ✓" : ""}</p>
          </div>
          <a className="inline-flex h-9 items-center gap-2 rounded-[6px] border border-phx-line bg-white px-3 text-sm font-bold text-phx-ink transition hover:border-phx-accent hover:text-phx-accent" href={`/api/sales/source-of-sales/raw-template?distributor=${encodeURIComponent(selected.code)}`}>
            <Download className="h-4 w-4" />Emergency template
          </a>
        </div>
        <HealthDashboard distributorCode={selected.code} key={`health-${selected.code}-${uploadNonce}`} />
        <ProfileViewer summary={summary} />
      </Card>

      <Card className={cn(panel, "space-y-3 p-5")}>
        <h3 className="text-base font-black tracking-tight text-slate-950">Upload Monthly Sales</h3>
        <MonthlyUpload aiEnabled={aiEnabled} brickOptions={brickOptions} distributorCode={selected.code} distributorName={selected.name} hasDateColumn={summary?.hasDateColumn ?? true} hasProfile={Boolean(summary)} onUploaded={() => setUploadNonce((n) => n + 1)} productOptions={productOptions} />
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

export function SalesUploadWorkspace({ distributors, summaries, batches, products, bricks, aiEnabled }: Props) {
  const brickOptions: MapOption[] = bricks.map((b) => ({ code: b.id, name: b.name }));
  const [mode, setMode] = useState<"single" | "bulk">("single");
  return (
    <div className="space-y-5 p-4 sm:p-6">
      {/* Header styled to match /sales/weekly exactly — same content as before, just re-skinned. */}
      <header>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span aria-hidden className="h-2 w-2 rounded-full bg-phx-accent" />
              <span className="text-phx-xs font-black uppercase tracking-[0.16em] text-phx-accent">Sales · One connected module</span>
            </div>
            <h1 className="mt-1 text-xl font-black text-phx-ink">Sales Upload</h1>
            <p className="mt-1 text-sm font-medium text-phx-ink-soft">
              {mode === "single"
                ? "Pick a distributor, analyze its raw sheet, then import — the analyzer and the importer use the exact same engine, so what's recognized always imports."
                : "Pick the month, then upload each distributor's sheet from the grid below — same analyzer, same importer, one screen."}
            </p>
          </div>
          <div className="inline-flex shrink-0 items-center gap-1 rounded-[6px] border border-phx-line bg-white p-1">
            <button className={cn("inline-flex h-8 items-center gap-1.5 rounded-[4px] px-3 text-xs font-black transition", mode === "single" ? "bg-phx-ink text-white" : "text-phx-ink-soft hover:text-phx-ink")} onClick={() => setMode("single")} type="button">
              <Store className="h-3.5 w-3.5" /> Single distributor
            </button>
            <button className={cn("inline-flex h-8 items-center gap-1.5 rounded-[4px] px-3 text-xs font-black transition", mode === "bulk" ? "bg-phx-ink text-white" : "text-phx-ink-soft hover:text-phx-ink")} onClick={() => setMode("bulk")} type="button">
              <Grid3x3 className="h-3.5 w-3.5" /> Bulk import
            </button>
          </div>
        </div>
      </header>
      <UploadedSheetsPanel batches={batches} distributors={distributors} />
      {mode === "single" ? (
        <DistributorWorkspaceShell distributors={distributors}>
          {(selected) => <DistributorUpload aiEnabled={aiEnabled} brickOptions={brickOptions} productOptions={products} selected={selected} summary={summaries[selected.code]} />}
        </DistributorWorkspaceShell>
      ) : (
        <BulkImportWorkspace aiEnabled={aiEnabled} brickOptions={brickOptions} distributors={distributors} productOptions={products} summaries={summaries} />
      )}
    </div>
  );
}
