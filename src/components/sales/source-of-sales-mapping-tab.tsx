"use client";

import { AlertTriangle, CheckCircle2, ChevronDown, Copy, Download, Info, Loader2, Plus, Search, Sparkles, UploadCloud, XCircle } from "lucide-react";
import Link from "next/link";
import { useRef, useState, type ReactNode } from "react";

import { ImportPreviewModal, type PreviewResult } from "@/components/sales/import-preview-modal";

import { AdminCallout } from "@/components/admin/admin-design-system";
import { CrmCard, CrmCardsOnPhone, CrmFacts, CrmTable } from "@/components/phoenix-crm/ui";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { SalesDistributorOption } from "@/lib/sales/monthly-distributor-import";
import { cn } from "@/lib/utils";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { phxFieldClassName } from "@/components/ui/form-tokens";


type Props = {
  distributors: SalesDistributorOption[];
  distributorCode: string;
  onDistributorChange: (code: string) => void;
  /** Distributor codes that have a normalizer layout profile (Learn/Analyze need one). */
  profiledDistributorCodes: string[];
  /** Master products + bricks for the inline "add by field" dropdowns. */
  products: { code: string; name: string }[];
  bricks: { id: string; name: string }[];
};

type BlockedRow = { reason: string; row?: number; rowNumber?: number; values?: string; key?: string };
type InvalidEntry = { raw: string; type: string; reason: string };
type ImportResult = { saved?: number; skipped?: number; inserted?: number; updated?: number; totalRead?: number; scannedRows?: number; invalid?: number; invalidEntries?: InvalidEntry[]; blockedRows?: BlockedRow[] };
type ImportResponse = { success: boolean; result?: ImportResult; invalidEntries?: InvalidEntry[]; message?: string; error?: string };
type SosPreviewResponse = { success: boolean; data?: PreviewResult; error?: string };
type SosCommitResponse = { success: boolean; data?: { batchId?: string; period?: string; rowCount?: number }; error?: string };

type HeaderValidationFailure = { label: string; expected: string[] };
type DistinctUnknown = { count: number; raw: string; rawName: string; rawAddress?: string; suggestionCode: string | null; suggestionLabel: string | null };
type NormalizePreview = {
  distributorName: string;
  period: string | null;
  summary: { brickResolved: number; fullyCoded: number; ignored: number; productResolved: number; totalRows: number; blankCustomerSkipped: number };
  unknownCustomers: DistinctUnknown[];
  unknownProducts: DistinctUnknown[];
  unknownTerritories: DistinctUnknown[];
  blankCustomerSkipped: number;
  blankCustomerErrors: number;
  darkCount: number;
};
type PreviewResponse = {
  success: boolean;
  data?: NormalizePreview;
  error?: string;
  code?: string;
  distributorName?: string;
  missingGroups?: HeaderValidationFailure[];
  fingerprintWarning?: { likelyCode: string; likelyName: string } | null;
};
type AiResponse = { success: boolean; data?: { suggestions: { raw: string; code: string; confidence?: number }[] }; error?: string };

const panelClassName = "rounded-3xl border border-phx-line bg-white/95 shadow-[0_18px_42px_rgba(15,23,42,0.07)]";

async function readJson<T>(response: Response, fallback: T): Promise<T> {
  const text = await response.text();
  if (!text) return { ...fallback, success: response.ok } as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return { ...fallback, success: false, error: text } as T;
  }
}

const CODED_PASTE_HEADERS = `${["Discount%", "Product ID", "Brick ID", "Area ID", "Region ID", "Distrub ID"].join("\t")}\r\n`;
async function copyCodedHeaders() {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(CODED_PASTE_HEADERS);
    return;
  }
  const textArea = document.createElement("textarea");
  textArea.value = CODED_PASTE_HEADERS;
  textArea.style.position = "fixed";
  textArea.style.left = "-9999px";
  document.body.appendChild(textArea);
  textArea.select();
  try { document.execCommand("copy"); } finally { document.body.removeChild(textArea); }
}

function ResultBanner({ result, message, error }: { result: ImportResult | null; message: string | null; error: string | null }) {
  const blocked = result?.blockedRows ?? [];
  if (blocked.length === 0 && !error && !message) return null;
  return (
    <div className="space-y-2">
      {message ? (
        <AdminCallout tone="success">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{message}</p>
        </AdminCallout>
      ) : null}
      {error ? (
        <AdminCallout tone="danger">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{error}</p>
        </AdminCallout>
      ) : null}
      {blocked.length > 0 ? (
        <AdminCallout tone="neutral">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-semibold">{blocked.length} row{blocked.length === 1 ? "" : "s"} could not be imported — fix these and re-upload:</p>
            <ul className="mt-2 max-h-44 space-y-1 overflow-auto text-sm">
              {blocked.slice(0, 50).map((row, index) => {
                const detail = row.values || row.key;
                return (
                  <li key={`${row.rowNumber ?? row.row ?? index}:${index}`}>
                    <b>Row {row.rowNumber ?? row.row ?? "?"}</b>: {row.reason}
                    {detail ? <span className="text-phx-ink-soft"> ({detail})</span> : null}
                  </li>
                );
              })}
            </ul>
            {blocked.length > 50 ? <p className="mt-1 text-xs text-phx-ink-soft">…and {blocked.length - 50} more.</p> : null}
          </div>
        </AdminCallout>
      ) : null}
    </div>
  );
}

/** Download + upload one mapping template. uploadUrl receives a multipart "file". */
function TemplateCard({
  title,
  description,
  templateHref,
  templateLabel,
  uploadUrl,
  uploadFields,
  children,
  step,
}: {
  title: string;
  description: string;
  templateHref: string;
  templateLabel: string;
  uploadUrl: string;
  uploadFields?: Record<string, string>;
  children?: ReactNode;
  /** When set, marks this as a primary step: shows a numbered badge + orange accent. */
  step?: number;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleUpload(file: File) {
    setBusy(true); setResult(null); setMessage(null); setError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      for (const [key, value] of Object.entries(uploadFields ?? {})) formData.append(key, value);
      const response = await fetch(uploadUrl, { body: formData, method: "POST" });
      const payload = await readJson<ImportResponse>(response, { success: false });
      setResult(payload.result ?? null);
      if (payload.success) setMessage(payload.message ?? "Mapping imported.");
      else setError(payload.error ?? "Import failed.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Import failed.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <Card className={cn(panelClassName, "space-y-4 p-5", step ? "border-l-4 border-l-phx-accent" : "")}>
      <div className="flex items-start gap-3">
        {step ? (
          <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#0B0B0B] text-sm font-black text-white">{step}</span>
        ) : null}
        <div>
          <h3 className="text-lg font-black tracking-tight text-slate-950">{title}</h3>
          <p className="mt-1 text-sm leading-6 text-phx-ink-soft">{description}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <a
          className="inline-flex h-10 items-center gap-2 rounded-xl border border-phx-line bg-white px-4 text-sm font-bold text-phx-ink transition hover:border-phx-accent hover:text-phx-accent"
          href={templateHref}
        >
          <Download className="h-4 w-4" />
          {templateLabel}
        </a>
        <Button
          className="h-10 gap-2 rounded-xl bg-[#0B0B0B] font-black text-white transition hover:bg-phx-accent"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          type="button"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
          Upload filled template
        </Button>
        <input
          accept=".xlsx"
          className="hidden"
          onChange={(event) => { const file = event.target.files?.[0]; if (file) void handleUpload(file); }}
          ref={inputRef}
          type="file"
        />
      </div>
      {children ? <div className="border-t border-dashed border-phx-line pt-4">{children}</div> : null}
      <ResultBanner error={error} message={message} result={result} />
    </Card>
  );
}

type Tip = { icon: string; title: string; body: string; href?: string; scrollId?: string; actionLabel?: string };
const TIPS: Tip[] = [
  { icon: "⚡", title: "Bootstrap from a coded file", body: "Have a sheet with Phoenix codes already? Upload it once — the system maps 100+ products and areas instantly.", scrollId: "sos-bootstrap", actionLabel: "Go to Bootstrap ↓" },
  { icon: "🤖", title: "AI fills the gaps for you", body: "Upload a raw file in the Analyze section, click AI Suggest — GPT-4o fills every product and area code. Review, save, done.", scrollId: "sos-analyze", actionLabel: "Go to Analyze ↓" },
  { icon: "💾", title: "Map once, reuse forever", body: "Once saved, those raw values auto-map forever on every future upload — zero repeat work each month." },
  { icon: "🎯", title: "Leave blanks intentionally", body: "Empty code = exclude those rows cleanly. Good for discontinued products or invalid territories." },
  { icon: "🔗", title: "Fix Missing Data first", body: "Red product or area codes block rows from importing. Fix them here before uploading raw files.", href: "/sales/missing-data", actionLabel: "Open Missing Data →" },
];

function TipsPanel({ onNavigate }: { onNavigate?: (scrollId: string) => void }) {
  const [open, setOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    try { return localStorage.getItem("sos-tips-open") === "true"; } catch { return false; }
  });
  function toggle() {
    setOpen((prev) => {
      const next = !prev;
      try { localStorage.setItem("sos-tips-open", String(next)); } catch { }
      return next;
    });
  }
  return (
    <div className="rounded-2xl border border-[#FED7AA] bg-phx-accent-soft">
      <button className="flex w-full items-center justify-between px-4 py-3 text-left" onClick={toggle} type="button">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-phx-accent" />
          <span className="text-sm font-black text-phx-ink">5 mapping tips &amp; tricks</span>
        </div>
        <ChevronDown className={cn("h-4 w-4 text-phx-accent transition-transform duration-200", open && "rotate-180")} />
      </button>
      {open ? (
        <div className="grid gap-4 border-t border-[#FED7AA] px-4 pb-4 pt-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {TIPS.map((tip) => (
            <div className="flex gap-2.5" key={tip.title}>
              <span className="mt-0.5 shrink-0 text-base leading-none">{tip.icon}</span>
              <div className="flex flex-col gap-1.5">
                <p className="text-xs font-black text-phx-ink">{tip.title}</p>
                <p className="text-xs leading-5 text-phx-ink-soft">{tip.body}</p>
                {tip.href ? (
                  <Link className="inline-flex w-fit items-center gap-1 rounded-lg border border-phx-accent px-2.5 py-1 text-phx-xs font-black text-phx-accent transition hover:bg-phx-accent hover:text-white" href={tip.href}>{tip.actionLabel}</Link>
                ) : tip.scrollId ? (
                  <button className="inline-flex w-fit items-center gap-1 rounded-lg border border-phx-accent px-2.5 py-1 text-phx-xs font-black text-phx-accent transition hover:bg-phx-accent hover:text-white" onClick={() => { if (onNavigate) onNavigate(tip.scrollId!); else document.getElementById(tip.scrollId!)?.scrollIntoView({ behavior: "smooth", block: "start" }); }} type="button">{tip.actionLabel}</button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function NoProfileNote({ distributorCode }: { distributorCode: string }) {
  return (
    <AdminCallout tone="neutral">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <p>
        <b>{distributorCode || "This distributor"}</b> has no automatic layout profile yet, so &ldquo;Learn&rdquo; and
        &ldquo;Analyze&rdquo; can&apos;t read its raw file. You can still use the Product and Customer / Brick templates
        above, or add coded columns manually.
      </p>
    </AdminCallout>
  );
}

/** "Learn from my coded file" — bootstrap the dictionary in bulk from a sheet that already has the codes. */
function BootstrapCard({ distributorCode, hasProfile }: { distributorCode: string; hasProfile: boolean }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleUpload(file: File) {
    setBusy(true); setMessage(null); setError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("distributorCode", distributorCode);
      const response = await fetch("/api/sales/monthly-import/bootstrap", { body: formData, method: "POST" });
      const payload = await readJson<ImportResponse>(response, { success: false });
      if (payload.success) setMessage(payload.message ?? "Mappings learned.");
      else setError(payload.error ?? "Bootstrap failed.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Bootstrap failed.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <Card className={cn(panelClassName, "space-y-4 p-5")} id="sos-bootstrap">
      <div>
        <h3 className="text-lg font-black tracking-tight text-slate-950">Learn from a coded file</h3>
        <p className="mt-1 text-sm leading-6 text-phx-ink-soft">
          Already have a sheet with the Phoenix codes filled in (raw columns + <b>Product ID</b> / <b>Brick ID</b>)?
          Upload it for <b>{distributorCode || "(pick a distributor)"}</b> and the system learns every product and
          customer→brick pair at once — so most of your mapping is done in one click.
        </p>
      </div>
      {hasProfile ? null : <NoProfileNote distributorCode={distributorCode} />}
      <Button
        className="h-10 w-fit gap-2 rounded-xl bg-[#0B0B0B] font-black text-white transition hover:bg-phx-accent"
        disabled={busy || !distributorCode || !hasProfile}
        onClick={() => inputRef.current?.click()}
        type="button"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
        Learn from coded file
      </Button>
      <input
        accept=".xlsx"
        className="hidden"
        onChange={(event) => { const file = event.target.files?.[0]; if (file) void handleUpload(file); }}
        ref={inputRef}
        type="file"
      />
      <ResultBanner error={error} message={message} result={null} />
    </Card>
  );
}

/** Upload a raw sheet → coverage + DISTINCT unknowns with editable codes + AI suggest + save. */
function MissingPanel({ distributorCode, hasProfile, products, bricks }: { distributorCode: string; hasProfile: boolean; products: { code: string; name: string }[]; bricks: { id: string; name: string }[] }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [aiKind, setAiKind] = useState<"product" | "territory" | null>(null);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<NormalizePreview | null>(null);
  const [productCodes, setProductCodes] = useState<Record<string, string>>({});
  const [territoryCodes, setTerritoryCodes] = useState<Record<string, string>>({});
  const [customerCodes, setCustomerCodes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [codedSheetDetected, setCodedSheetDetected] = useState(false);
  const [headerErrors, setHeaderErrors] = useState<HeaderValidationFailure[] | null>(null);
  const [fingerprintWarning, setFingerprintWarning] = useState<{ likelyCode: string; likelyName: string } | null>(null);
  const [saveInvalidEntries, setSaveInvalidEntries] = useState<InvalidEntry[] | null>(null);
  const importRef = useRef<HTMLInputElement | null>(null);
  const [mappingsSaved, setMappingsSaved] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const importPreviewFileRef = useRef<File | null>(null);
  const [importPreviewResult, setImportPreviewResult] = useState<PreviewResult | null>(null);
  const [importPreviewOpen, setImportPreviewOpen] = useState(false);
  const [importCommitting, setImportCommitting] = useState(false);

  async function analyze(file: File) {
    setBusy(true); setError(null); setMessage(null); setPreview(null);
    setCodedSheetDetected(false); setHeaderErrors(null); setFingerprintWarning(null);
    setMappingsSaved(false); setImportMessage(null); setImportError(null); setImportResult(null);
    setSaveInvalidEntries(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("distributorCode", distributorCode);
      const response = await fetch("/api/sales/monthly-import/missing", { body: formData, method: "POST" });
      const payload = await readJson<PreviewResponse>(response, { success: false });
      if (payload.code === "coded_sheet_detected") {
        setCodedSheetDetected(true);
      } else if (payload.code === "header_validation_error") {
        setHeaderErrors(payload.missingGroups ?? []);
        setFingerprintWarning(payload.fingerprintWarning ?? null);
      } else if (payload.success && payload.data) {
        setPreview(payload.data);
        setProductCodes(Object.fromEntries(payload.data.unknownProducts.map((u) => [u.raw, u.suggestionCode ?? ""])));
        setTerritoryCodes(Object.fromEntries(payload.data.unknownTerritories.map((u) => [u.raw, u.suggestionCode ?? ""])));
        setCustomerCodes(Object.fromEntries(payload.data.unknownCustomers.map((u) => [u.raw, ""])));
      } else {
        setError(payload.error ?? "Analysis failed.");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Analysis failed.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function aiSuggest(kind: "product" | "territory") {
    if (!preview) return;
    setAiKind(kind); setError(null);
    try {
      const unknowns = (kind === "product" ? preview.unknownProducts : preview.unknownTerritories).map((u) => ({ raw: u.raw, rawName: u.rawName }));
      const response = await fetch("/api/sales/monthly-import/ai-suggest", {
        body: JSON.stringify({ kind, unknowns }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = await readJson<AiResponse>(response, { success: false });
      if (payload.success && payload.data) {
        const fill = Object.fromEntries(payload.data.suggestions.map((s) => [s.raw, s.code]));
        if (kind === "product") setProductCodes((prev) => ({ ...prev, ...fill }));
        else setTerritoryCodes((prev) => ({ ...prev, ...fill }));
        setMessage(`AI suggested ${payload.data.suggestions.length} ${kind} match${payload.data.suggestions.length === 1 ? "" : "es"}.`);
      } else {
        setError(payload.error ?? "AI suggestion failed.");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "AI suggestion failed.");
    } finally {
      setAiKind(null);
    }
  }

  async function save() {
    const mappings: { type: "product" | "territory" | "customer"; raw: string; code: string; name?: string; address?: string }[] = [];
    for (const [raw, code] of Object.entries(productCodes)) if (code.trim()) mappings.push({ type: "product", raw, code: code.trim() });
    for (const [raw, code] of Object.entries(territoryCodes)) if (code.trim()) mappings.push({ type: "territory", raw, code: code.trim() });
    // A customer mapping carries the pharmacy's name and address from the sheet, stored where the
    // mapping's own fields are blank so the next pharmacy can be matched against it.
    const customerByRaw = new Map((preview?.unknownCustomers ?? []).map((u) => [u.raw, u]));
    for (const [raw, code] of Object.entries(customerCodes)) {
      if (!code.trim()) continue;
      const customer = customerByRaw.get(raw);
      mappings.push({ type: "customer", raw, code: code.trim(), name: customer?.rawName, address: customer?.rawAddress });
    }
    if (mappings.length === 0) { setError("Fill at least one Phoenix code before saving."); return; }
    setSaving(true); setError(null); setMessage(null);
    try {
      const response = await fetch("/api/sales/monthly-import/save-mappings", {
        body: JSON.stringify({ distributorCode, mappings }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = await readJson<ImportResponse>(response, { success: false });
      if (payload.success) {
        setMessage(payload.message ?? "Mappings saved."); setMappingsSaved(true);
        const entries = payload.invalidEntries ?? payload.result?.invalidEntries;
        if (entries?.length) setSaveInvalidEntries(entries);
      }
      else setError(payload.error ?? "Save failed.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  async function handlePreviewFile(file: File) {
    setImporting(true); setImportResult(null); setImportMessage(null); setImportError(null);
    setImportPreviewResult(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("distributorCode", distributorCode);
      if (preview?.period) formData.append("period", preview.period);
      const response = await fetch("/api/sales/monthly-import/preview", { body: formData, method: "POST" });
      const payload = await readJson<SosPreviewResponse>(response, { success: false });
      if (payload.success && payload.data) {
        importPreviewFileRef.current = file;
        setImportPreviewResult(payload.data);
        setImportPreviewOpen(true);
      } else {
        setImportError(payload.error ?? "Preview failed.");
      }
    } catch (caught) {
      setImportError(caught instanceof Error ? caught.message : "Preview failed.");
    } finally {
      setImporting(false);
    }
  }

  async function handleCommitImport() {
    if (!importPreviewFileRef.current || !importPreviewResult || importPreviewResult.status !== "validated") return;
    setImportCommitting(true);
    try {
      const formData = new FormData();
      formData.append("file", importPreviewFileRef.current);
      formData.append("distributorCode", distributorCode);
      if (preview?.period) formData.append("period", preview.period);
      if (importPreviewResult.previewDiff) formData.append("previewDiff", JSON.stringify(importPreviewResult.previewDiff));
      if (importPreviewResult.unmappedCustomers?.length) formData.append("unmappedCustomers", JSON.stringify(importPreviewResult.unmappedCustomers));
      const response = await fetch("/api/sales/monthly-import/commit", { body: formData, method: "POST" });
      const payload = await readJson<SosCommitResponse>(response, { success: false });
      if (payload.success) {
        setImportPreviewOpen(false);
        importPreviewFileRef.current = null;
        setImportPreviewResult(null);
        setImportMessage(payload.data?.rowCount !== undefined ? `Import complete — ${payload.data.rowCount} rows saved.` : "Import complete.");
        if (importRef.current) importRef.current.value = "";
      } else {
        setImportError(payload.error ?? "Import failed.");
      }
    } catch (caught) {
      setImportError(caught instanceof Error ? caught.message : "Import failed.");
    } finally {
      setImportCommitting(false);
    }
  }

  const productsMapped = Object.values(productCodes).filter(Boolean).length;
  const productsTotal = preview?.unknownProducts.length ?? 0;
  const territoriesMapped = Object.values(territoryCodes).filter(Boolean).length;
  const territoriesTotal = preview?.unknownTerritories.length ?? 0;
  const customersMapped = Object.values(customerCodes).filter(Boolean).length;
  const customersTotal = preview?.unknownCustomers.length ?? 0;
  const hasUnknowns = productsTotal > 0 || territoriesTotal > 0 || customersTotal > 0;
  const allReady = hasUnknowns && productsMapped === productsTotal && territoriesMapped === territoriesTotal && customersMapped === customersTotal;
  const darkCount = preview?.darkCount ?? 0;
  const blankCustomerErrors = preview?.blankCustomerErrors ?? 0;
  const blankCustomerSkipped = preview?.blankCustomerSkipped ?? 0;
  // "all mapped" is only truly safe when there are no dark exceptions and no blank-customer errors
  const trulyAllMapped = !hasUnknowns && darkCount === 0 && blankCustomerErrors === 0;

  const fullyCodedPct = preview && preview.summary.totalRows > 0
    ? Math.round((preview.summary.fullyCoded / preview.summary.totalRows) * 100)
    : 0;

  return (
    <Card className={cn(panelClassName, "space-y-4 p-5")} id="sos-analyze">
      <div>
        <h3 className="text-lg font-black tracking-tight text-slate-950">Find unmapped items (AI assist)</h3>
        <p className="mt-1 text-sm leading-6 text-phx-ink-soft">
          Upload the distributor&apos;s <b>raw sheet</b> here to preview how much already maps — <b>nothing is saved</b>.
          The few unmatched products and areas are listed below with a suggested Phoenix code; let AI fill them, adjust
          if needed, then save. They&apos;re remembered for every future upload.
        </p>
      </div>
      {hasProfile ? null : <NoProfileNote distributorCode={distributorCode} />}
      <Button
        className="h-10 w-fit gap-2 rounded-xl bg-[#0B0B0B] font-black text-white transition hover:bg-phx-accent"
        disabled={busy || !distributorCode || !hasProfile}
        onClick={() => inputRef.current?.click()}
        type="button"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
        Analyze raw sheet
      </Button>
      <input
        accept=".xlsx"
        className="hidden"
        onChange={(event) => { const file = event.target.files?.[0]; if (file) void analyze(file); }}
        ref={inputRef}
        type="file"
      />

      {codedSheetDetected ? (
        <AdminCallout tone="neutral">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="text-sm font-semibold">This sheet has already been processed — use Import directly.</p>
            <p className="mt-0.5 text-xs text-phx-ink-soft">The Analyzer is for raw distributor files only. Coded sheets (containing Phoenix product IDs) should go straight to the Import raw file button below.</p>
          </div>
        </AdminCallout>
      ) : null}

      {headerErrors && headerErrors.length > 0 ? (
        <AdminCallout tone="danger">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="flex-1 space-y-1.5">
            <p className="text-sm font-semibold">Wrong or mismatched sheet — required columns not found.</p>
            <ul className="list-disc pl-4 text-xs">
              {headerErrors.map((g) => (
                <li key={g.label}><span className="font-semibold">{g.label}</span>: expected one of <code className="rounded bg-black/10 px-1">{g.expected.join(", ")}</code></li>
              ))}
            </ul>
            {fingerprintWarning ? (
              <p className="mt-1 rounded-lg border border-[#FDE68A] bg-[#FFFBEB] px-3 py-2 text-xs font-medium text-[#92400E]">
                This sheet looks more like <span className="font-bold">{fingerprintWarning.likelyName}</span> ({fingerprintWarning.likelyCode}). Did you select the right distributor?
              </p>
            ) : null}
          </div>
        </AdminCallout>
      ) : null}

      {preview ? (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2 text-xs font-bold">
            <span className="rounded-full border border-[#BBF7D0] bg-[#F0FDF4] px-3 py-1 text-[#166534]">{fullyCodedPct}% fully coded</span>
            <span className="rounded-full border border-phx-line bg-[#FCFDFE] px-3 py-1 text-phx-ink">{preview.summary.totalRows} rows</span>
            <span className="rounded-full border border-phx-line bg-[#FCFDFE] px-3 py-1 text-phx-ink">{preview.unknownProducts.length} unknown products</span>
            <span className="rounded-full border border-phx-line bg-[#FCFDFE] px-3 py-1 text-phx-ink">{preview.unknownTerritories.length} unknown areas</span>
            <span className="rounded-full border border-phx-line bg-[#FCFDFE] px-3 py-1 text-phx-ink">{preview.unknownCustomers.length} unknown customers</span>
          </div>

          {blankCustomerErrors > 0 ? (
            <AdminCallout tone="danger">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="text-sm font-semibold">{blankCustomerErrors} row{blankCustomerErrors === 1 ? "" : "s"} missing a required customer code.</p>
                <p className="mt-0.5 text-xs">Every row in this distributor&apos;s sheet must have an entity code. These rows will block import — fix the raw sheet and re-upload.</p>
              </div>
            </AdminCallout>
          ) : null}

          {blankCustomerSkipped > 0 ? (
            <AdminCallout tone="neutral">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              <p className="text-sm"><span className="font-semibold">{blankCustomerSkipped} row{blankCustomerSkipped === 1 ? "" : "s"} skipped</span> — no customer code or territory (blank footer rows). Not a blocker.</p>
            </AdminCallout>
          ) : null}

          {hasUnknowns ? (
            <div className="space-y-1.5">
              {productsTotal > 0 ? (
                <div className="flex items-center gap-3">
                  <span className="w-16 shrink-0 text-xs font-semibold text-phx-ink-soft">Products</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-phx-line">
                    <div className={cn("h-full rounded-full transition-all duration-300", productsMapped === productsTotal ? "bg-emerald-500" : "bg-phx-accent")} style={{ width: `${Math.round((productsMapped / productsTotal) * 100)}%` }} />
                  </div>
                  <span className={cn("w-10 shrink-0 text-right text-xs font-black tabular-nums", productsMapped === productsTotal ? "text-emerald-600" : "text-phx-accent")}>{productsMapped}/{productsTotal}</span>
                </div>
              ) : null}
              {territoriesTotal > 0 ? (
                <div className="flex items-center gap-3">
                  <span className="w-16 shrink-0 text-xs font-semibold text-phx-ink-soft">Areas</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-phx-line">
                    <div className={cn("h-full rounded-full transition-all duration-300", territoriesMapped === territoriesTotal ? "bg-emerald-500" : "bg-phx-accent")} style={{ width: `${Math.round((territoriesMapped / territoriesTotal) * 100)}%` }} />
                  </div>
                  <span className={cn("w-10 shrink-0 text-right text-xs font-black tabular-nums", territoriesMapped === territoriesTotal ? "text-emerald-600" : "text-phx-accent")}>{territoriesMapped}/{territoriesTotal}</span>
                </div>
              ) : null}
              {customersTotal > 0 ? (
                <div className="flex items-center gap-3">
                  <span className="w-16 shrink-0 text-xs font-semibold text-phx-ink-soft">Customers</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-phx-line">
                    <div className={cn("h-full rounded-full transition-all duration-300", customersMapped === customersTotal ? "bg-emerald-500" : "bg-phx-accent")} style={{ width: customersTotal > 0 ? `${Math.round((customersMapped / customersTotal) * 100)}%` : "0%" }} />
                  </div>
                  <span className={cn("w-10 shrink-0 text-right text-xs font-black tabular-nums", customersMapped === customersTotal ? "text-emerald-600" : "text-phx-accent")}>{customersMapped}/{customersTotal}</span>
                </div>
              ) : null}
            </div>
          ) : null}

          {allReady ? (
            <AdminCallout tone="success">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="flex flex-1 items-center justify-between gap-3">
                <p className="text-sm font-semibold">
                  {[productsMapped > 0 ? `${productsMapped} product${productsMapped === 1 ? "" : "s"}` : "", territoriesMapped > 0 ? `${territoriesMapped} area${territoriesMapped === 1 ? "" : "s"}` : "", customersMapped > 0 ? `${customersMapped} customer${customersMapped === 1 ? "" : "s"}` : ""].filter(Boolean).join(" + ")} ready — save now
                </p>
                <Button className="h-8 shrink-0 gap-1.5 rounded-xl bg-phx-accent font-black text-white hover:bg-[#EA6A0C]" disabled={saving} onClick={() => void save()} type="button">
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                  Save All
                </Button>
              </div>
            </AdminCallout>
          ) : null}

          {preview.unknownProducts.length > 0 ? (
            <UnknownTable
              busyAi={aiKind === "product"}
              codes={productCodes}
              kind="product"
              onAi={() => void aiSuggest("product")}
              onChange={(raw, code) => setProductCodes((prev) => ({ ...prev, [raw]: code }))}
              options={products}
              rows={preview.unknownProducts}
            />
          ) : null}

          {preview.unknownTerritories.length > 0 ? (
            <UnknownTable
              busyAi={aiKind === "territory"}
              codes={territoryCodes}
              kind="territory"
              onAi={() => void aiSuggest("territory")}
              onChange={(raw, code) => setTerritoryCodes((prev) => ({ ...prev, [raw]: code }))}
              options={bricks.map((b) => ({ code: b.id, name: b.name }))}
              rows={preview.unknownTerritories}
            />
          ) : null}

          {preview.unknownCustomers.length > 0 ? (
            <UnknownTable
              codes={customerCodes}
              kind="customer"
              onChange={(raw, code) => setCustomerCodes((prev) => ({ ...prev, [raw]: code }))}
              options={bricks.map((b) => ({ code: b.id, name: b.name }))}
              rows={preview.unknownCustomers}
            />
          ) : null}

          {hasUnknowns ? (
            <Button
              className="h-10 w-fit gap-2 rounded-xl bg-phx-accent font-black text-white transition hover:bg-[#EA6A0C]"
              disabled={saving}
              onClick={() => void save()}
              type="button"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              Save mappings
            </Button>
          ) : trulyAllMapped ? (
            <AdminCallout tone="success">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <p>Every product, area, and customer in this sheet is already mapped — import it now below.</p>
            </AdminCallout>
          ) : darkCount > 0 ? (
            <AdminCallout tone="warning">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="text-sm font-semibold">Mappings complete — but {darkCount} row{darkCount === 1 ? "" : "s"} will be blocked at import.</p>
                <p className="mt-0.5 text-xs">These rows have a blank customer code and territory — the sheet may have footer rows or a column-mapping issue. Re-analyze with the correct distributor file to investigate.</p>
              </div>
            </AdminCallout>
          ) : null}
        </div>
      ) : null}

      <ResultBanner error={error} message={message} result={null} />

      {saveInvalidEntries && saveInvalidEntries.length > 0 ? (
        <AdminCallout tone="warning">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="flex-1 space-y-1.5">
            <p className="text-sm font-semibold">{saveInvalidEntries.length} mapping{saveInvalidEntries.length === 1 ? "" : "s"} could not be saved.</p>
            <ul className="space-y-0.5 text-xs">
              {saveInvalidEntries.map((e, i) => (
                <li key={i}><span className="font-semibold">{e.raw}</span> ({e.type}) — {e.reason}</li>
              ))}
            </ul>
          </div>
        </AdminCallout>
      ) : null}

      {(mappingsSaved || (preview !== null && trulyAllMapped)) && !importMessage ? (
        <div className="rounded-2xl border border-[#E0F2FE] bg-[#F0F9FF] p-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 text-sm font-bold text-[#0369A1]">
              <UploadCloud className="h-4 w-4 shrink-0" />
              <span>{mappingsSaved ? "Mappings saved — upload the same raw file to import:" : "All items already mapped — upload the raw file to import:"}</span>
            </div>
            <Button className="h-9 gap-2 rounded-xl bg-[#0B0B0B] font-black text-white hover:bg-phx-accent" disabled={importing} onClick={() => importRef.current?.click()} type="button">
              {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
              {importing ? "Importing…" : "Import raw file"}
            </Button>
            <input accept=".xlsx" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void handlePreviewFile(file); }} ref={importRef} type="file" />
          </div>
          <p className="mt-2 text-xs text-phx-ink-soft">Upload the same raw file you just analyzed — it will be imported with your saved mappings applied.</p>
        </div>
      ) : null}

      {importMessage || importError || (importResult?.blockedRows?.length ?? 0) > 0 ? (
        <ResultBanner error={importError} message={importMessage} result={importResult} />
      ) : null}

      {importPreviewOpen && importPreviewResult ? (
        <ImportPreviewModal
          committing={importCommitting}
          onCancel={() => {
            setImportPreviewOpen(false);
            importPreviewFileRef.current = null;
            setImportPreviewResult(null);
            if (importRef.current) importRef.current.value = "";
          }}
          onConfirm={() => void handleCommitImport()}
          result={importPreviewResult}
        />
      ) : null}
    </Card>
  );
}

function MappingCombobox({
  value,
  onChange,
  options,
  placeholder,
  disabled = false,
}: {
  value: string;
  onChange: (code: string) => void;
  options: { code: string; name: string }[];
  placeholder: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // When closed: show the selected ID up front (with its name), so the operator always sees the
  // brick/product CODE they mapped — not just the name. When open: show the live search query.
  const selectedOption = options.find((o) => o.code === value);
  const displayValue = open
    ? searchQuery
    : selectedOption
      ? `${selectedOption.code} — ${selectedOption.name}`
      : value;

  function openDropdown() {
    if (disabled) return;
    if (inputRef.current) {
      const r = inputRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 2, left: r.left, width: r.width });
    }
    setOpen(true);
  }

  const q = searchQuery.toLowerCase();
  const filtered = q
    ? options.filter((o) => o.code.toLowerCase().includes(q) || o.name.toLowerCase().includes(q)).slice(0, 50)
    : options.slice(0, 50);

  return (
    <div className="relative">
      <input
        ref={inputRef}
        disabled={disabled}
        className={phxFieldClassName}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => { setSearchQuery(e.target.value); onChange(e.target.value); openDropdown(); }}
        onFocus={() => { setSearchQuery(""); openDropdown(); }}
        placeholder={placeholder}
        value={displayValue}
      />
      {open && filtered.length > 0 && pos && (
        <div
          className="z-9999 max-h-60 overflow-auto rounded-lg border border-phx-line bg-white shadow-lg"
          style={{ position: "fixed", top: pos.top, left: pos.left, width: Math.max(pos.width, 360) }}
        >
          {filtered.map((o) => (
            <button
              className="flex w-full min-w-0 items-start gap-3 px-3 py-1.5 text-left hover:bg-phx-accent-soft"
              key={o.code}
              onMouseDown={() => {
                if (disabled) return;
                onChange(o.code);
                setOpen(false);
              }}
              type="button"
            >
              <span className="shrink-0 font-mono text-xs font-bold text-phx-ink">{o.code}</span>
              <span className="min-w-0 break-words text-xs text-phx-ink-2">{o.name}</span>
            </button>
          ))}
        </div>
      )}
      {open && filtered.length === 0 && pos && (
        <div
          className="z-9999 rounded-lg border border-phx-line bg-white p-2 text-xs text-phx-ink-soft shadow-lg"
          style={{ position: "fixed", top: pos.top, left: pos.left, width: Math.max(pos.width, 240) }}
        >
          No results
        </div>
      )}
    </div>
  );
}

function UnknownTable({
  rows,
  codes,
  kind,
  options,
  busyAi,
  onAi,
  onChange,
}: {
  rows: DistinctUnknown[];
  codes: Record<string, string>;
  kind: "product" | "territory" | "customer";
  options: { code: string; name: string }[];
  busyAi?: boolean;
  onAi?: () => void;
  onChange: (raw: string, code: string) => void;
}) {
  const label = kind === "product" ? "products" : kind === "territory" ? "areas" : "customers";
  const rawLabel = kind === "product" ? "item" : kind === "territory" ? "area" : "customer code";
  const codeLabel = kind === "product" ? "Product" : "Brick";
  const mapCell = (row: DistinctUnknown) => (
    <div className="flex items-center gap-2">
      <MappingCombobox
        onChange={(code) => onChange(row.raw, code)}
        options={options}
        placeholder={kind === "product" ? "e.g. TE001" : "e.g. B100-11"}
        value={codes[row.raw] ?? ""}
      />
      {codes[row.raw] ? (
        <span className="shrink-0 rounded-full bg-phx-ok-bg px-2 py-0.5 text-phx-2xs font-black text-phx-ok">✓</span>
      ) : (
        <span className="shrink-0 rounded-full bg-phx-danger-bg px-2 py-0.5 text-phx-2xs font-black text-phx-danger">○</span>
      )}
    </div>
  );
  return (
    <div className="rounded-2xl border border-phx-line">
      <div className="flex items-center justify-between gap-3 border-b border-phx-line px-4 py-2.5">
        <div className="flex items-center gap-2">
          <p className="text-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">
            Unknown {label} ({rows.length})
          </p>
          {busyAi ? <span className="animate-pulse text-xs font-bold text-phx-accent">AI working…</span> : null}
        </div>
        {onAi ? (
          <Button className="h-8 gap-2" disabled={busyAi} onClick={onAi} type="button" variant="secondary">
            {busyAi ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            AI suggest
          </Button>
        ) : null}
      </div>
      <div className="max-h-72 overflow-y-auto">
        <CrmCardsOnPhone>
          {rows.map((row) => (
            <CrmCard
              key={row.raw}
              meta={row.rawName && row.rawName !== row.raw ? row.raw : undefined}
              title={row.rawName || row.raw}
            >
              {row.suggestionLabel ? <p className="mb-2 break-words text-xs text-phx-accent">suggest: {row.suggestionLabel}</p> : null}
              <CrmFacts facts={[{ label: "Rows", value: row.count }]} />
              <div className="mt-2">{mapCell(row)}</div>
            </CrmCard>
          ))}
        </CrmCardsOnPhone>
        <CrmTable className="text-sm" columns={["40%", "12%", "48%"]}>
          <thead className="sticky top-0 bg-[#020617] text-left text-phx-xs font-black uppercase tracking-[0.12em] text-white">
            <tr>
              <th className="px-4 py-2">Raw {rawLabel}</th>
              <th className="px-4 py-2 text-right">Rows</th>
              <th className="px-4 py-2">Phoenix {codeLabel}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr className="border-b border-[#FFE8D6]" key={row.raw}>
                <td className="break-words px-4 py-2 align-top">
                  <span className="block font-semibold text-phx-ink">{row.rawName || row.raw}</span>
                  {row.rawName && row.rawName !== row.raw ? <span className="block text-xs text-phx-ink-soft">{row.raw}</span> : null}
                  {row.suggestionLabel ? <span className="block text-xs text-phx-accent">suggest: {row.suggestionLabel}</span> : null}
                </td>
                <td className="px-4 py-2 text-right align-top tabular-nums text-phx-ink-soft">{row.count}</td>
                <td className="px-4 py-2 align-top">{mapCell(row)}</td>
              </tr>
            ))}
          </tbody>
        </CrmTable>
      </div>
    </div>
  );
}

const fieldInputClass = phxFieldClassName;

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-phx-2xs font-black uppercase tracking-[0.12em] text-phx-ink-faint">{label}</span>
      {children}
    </label>
  );
}

/** Small violet "AI suggest" trigger + confidence badge, shared by the three add-one forms below. */
function AiSuggestButton({ busy, disabled, onClick }: { busy: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <button
      className="inline-flex h-9 items-center gap-1 rounded-[6px] border border-violet-600 bg-violet-600 px-3 text-xs font-bold text-white transition hover:bg-violet-700 disabled:opacity-60"
      disabled={disabled}
      onClick={onClick}
      title="Let AI pre-fill the match from the raw text"
      type="button"
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} AI suggest
    </button>
  );
}

function AiConfidenceBadge({ confidence }: { confidence: number }) {
  return (
    <span
      className={`inline-flex h-9 items-center rounded-[6px] px-2 text-xs font-black tabular-nums ${
        confidence >= 80 ? "bg-emerald-100 text-emerald-700" : confidence >= 50 ? "bg-amber-100 text-amber-700" : "bg-rose-100 text-rose-700"
      }`}
    >
      {Math.round(confidence)}% confidence
    </span>
  );
}

/** Inline "add one" — distributor item code/name -> Phoenix product (no upload needed). */
export function ProductAddForm({
  distributorCode,
  products,
  prefillAlias,
  onSaved,
}: {
  distributorCode: string;
  products: { code: string; name: string }[];
  /** Pre-fill the alias field with the exact raw text that blocked an upload. */
  prefillAlias?: string;
  /** Called after a successful save — lets a caller (e.g. the monthly wizard) re-run its preview in place. */
  onSaved?: () => void;
}) {
  const [alias, setAlias] = useState(prefillAlias ?? "");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiConfidence, setAiConfidence] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function aiSuggestOne() {
    if (!alias.trim()) { setError("Enter the alias first."); return; }
    setAiBusy(true); setError(null); setAiConfidence(null);
    try {
      const response = await fetch("/api/sales/monthly-import/ai-suggest", {
        body: JSON.stringify({ kind: "product", unknowns: [{ raw: alias.trim() }] }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = await readJson<AiResponse>(response, { success: false });
      const suggestion = payload.success ? payload.data?.suggestions[0] : undefined;
      if (suggestion?.code) { setCode(suggestion.code); if (typeof suggestion.confidence === "number") setAiConfidence(suggestion.confidence); }
      else setError(payload.error ?? "AI found no confident match — pick the product manually.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "AI suggestion failed.");
    } finally {
      setAiBusy(false);
    }
  }

  async function add() {
    if (!alias.trim() || !code) { setError("Enter the alias and pick a product."); return; }
    if (!distributorCode) { setError("Pick a distributor first — product mappings are per-distributor."); return; }
    setBusy(true); setMessage(null); setError(null);
    try {
      const response = await fetch("/api/sales/monthly-import/save-mappings", {
        body: JSON.stringify({ distributorCode, mappings: [{ type: "product", raw: alias.trim(), code, distributorCode }] }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = await readJson<ImportResponse>(response, { success: false });
      if (payload.success) { setMessage(payload.message ?? "Mapping added."); setAlias(""); setCode(""); setAiConfidence(null); onSaved?.(); }
      else setError(payload.error ?? "Add failed.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Add failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">Or add one by field</p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Alias (item code or name)">
          <input className={cn(fieldInputClass, "w-56")} disabled={busy} onChange={(event) => { setAlias(event.target.value); setAiConfidence(null); }} placeholder="distributor's item code or name" value={alias} />
        </Field>
        <Field label="Phoenix product">
          <div className="w-64">
            <MappingCombobox
              disabled={busy}
              onChange={(value) => { setCode(value); setAiConfidence(null); }}
              options={products.map((product) => ({ code: product.code, name: product.name }))}
              placeholder="Search product code or name"
              value={code}
            />
          </div>
        </Field>
        <AiSuggestButton busy={aiBusy} disabled={aiBusy || busy || !alias.trim()} onClick={() => void aiSuggestOne()} />
        {aiConfidence != null ? <AiConfidenceBadge confidence={aiConfidence} /> : null}
        <Button className="h-9 gap-1 rounded-xl bg-phx-accent font-black text-white transition hover:bg-[#EA6A0C]" disabled={busy || !distributorCode} onClick={() => void add()} type="button">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add
        </Button>
      </div>
      {message ? <p className="text-xs font-bold text-emerald-600">{message}</p> : null}
      {error ? <p className="text-xs font-bold text-rose-600">{error}</p> : null}
    </div>
  );
}

/** Inline "add one" — customer code -> brick (Area/Region derive from the brick). */
export function CustomerBrickAddForm({
  distributorCode,
  bricks,
  prefillCustomerCode,
  onSaved,
}: {
  distributorCode: string;
  bricks: { id: string; name: string }[];
  /** Pre-fill the customer code field with the exact raw code that blocked an upload. */
  prefillCustomerCode?: string;
  onSaved?: () => void;
}) {
  const [customerCode, setCustomerCode] = useState(prefillCustomerCode ?? "");
  const [customerName, setCustomerName] = useState("");
  const [address, setAddress] = useState("");
  const [brickId, setBrickId] = useState("");
  const [busy, setBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiConfidence, setAiConfidence] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function aiSuggestOne() {
    const raw = customerName.trim() || customerCode.trim();
    if (!raw) { setError("Enter the customer code or name first."); return; }
    setAiBusy(true); setError(null); setAiConfidence(null);
    try {
      const response = await fetch("/api/sales/monthly-import/ai-suggest", {
        body: JSON.stringify({ kind: "territory", unknowns: [{ raw }] }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = await readJson<AiResponse>(response, { success: false });
      const suggestion = payload.success ? payload.data?.suggestions[0] : undefined;
      if (suggestion?.code) { setBrickId(suggestion.code); if (typeof suggestion.confidence === "number") setAiConfidence(suggestion.confidence); }
      else setError(payload.error ?? "AI found no confident match — pick the brick manually.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "AI suggestion failed.");
    } finally {
      setAiBusy(false);
    }
  }

  async function add() {
    if (!customerCode.trim() || !brickId) { setError("Enter the customer code and pick a brick."); return; }
    setBusy(true); setMessage(null); setError(null);
    try {
      const response = await fetch("/api/sales/monthly-import/customer-mapping/add", {
        body: JSON.stringify({ distributorCode, customerCode: customerCode.trim(), customerName: customerName.trim(), address: address.trim(), brickId }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = await readJson<ImportResponse>(response, { success: false });
      if (payload.success) { setMessage(payload.message ?? "Mapping added."); setCustomerCode(""); setCustomerName(""); setAddress(""); setBrickId(""); setAiConfidence(null); onSaved?.(); }
      else setError(payload.error ?? "Add failed.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Add failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">Or add one by field</p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Customer code">
          <input className={cn(fieldInputClass, "w-40")} disabled={busy} onChange={(event) => setCustomerCode(event.target.value)} value={customerCode} />
        </Field>
        <Field label="Customer name (optional)">
          <input className={cn(fieldInputClass, "w-48")} disabled={busy} onChange={(event) => setCustomerName(event.target.value)} value={customerName} />
        </Field>
        <Field label="Address (optional)">
          <input className={cn(fieldInputClass, "w-48")} disabled={busy} onChange={(event) => setAddress(event.target.value)} value={address} />
        </Field>
        <Field label="Brick">
          <div className="w-64">
            <MappingCombobox
              disabled={busy}
              onChange={(value) => { setBrickId(value); setAiConfidence(null); }}
              options={bricks.map((brick) => ({ code: brick.id, name: brick.name }))}
              placeholder="Search brick code or name (ex: B10, Mont)"
              value={brickId}
            />
          </div>
        </Field>
        <AiSuggestButton busy={aiBusy} disabled={aiBusy || busy || !(customerName.trim() || customerCode.trim())} onClick={() => void aiSuggestOne()} />
        {aiConfidence != null ? <AiConfidenceBadge confidence={aiConfidence} /> : null}
        <Button className="h-9 gap-1 rounded-xl bg-phx-accent font-black text-white transition hover:bg-[#EA6A0C]" disabled={busy || !distributorCode} onClick={() => void add()} type="button">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add
        </Button>
      </div>
      {message ? <p className="text-xs font-bold text-emerald-600">{message}</p> : null}
      {error ? <p className="text-xs font-bold text-rose-600">{error}</p> : null}
    </div>
  );
}

/** Inline "add one" — raw territory/district text -> brick. Global (not per-distributor), unlike
 * product and customer aliases, matching how territoryAliasByKey is looked up in the normalizer. */
export function TerritoryAddForm({
  bricks,
  prefillRaw,
  onSaved,
}: {
  bricks: { id: string; name: string }[];
  /** Pre-fill the raw-text field with the exact territory text that blocked an upload. */
  prefillRaw?: string;
  onSaved?: () => void;
}) {
  const [raw, setRaw] = useState(prefillRaw ?? "");
  const [brickId, setBrickId] = useState("");
  const [busy, setBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiConfidence, setAiConfidence] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function aiSuggestOne() {
    if (!raw.trim()) { setError("Enter the raw territory text first."); return; }
    setAiBusy(true); setError(null); setAiConfidence(null);
    try {
      const response = await fetch("/api/sales/monthly-import/ai-suggest", {
        body: JSON.stringify({ kind: "territory", unknowns: [{ raw: raw.trim() }] }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = await readJson<AiResponse>(response, { success: false });
      const suggestion = payload.success ? payload.data?.suggestions[0] : undefined;
      if (suggestion?.code) { setBrickId(suggestion.code); if (typeof suggestion.confidence === "number") setAiConfidence(suggestion.confidence); }
      else setError(payload.error ?? "AI found no confident match — pick the brick manually.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "AI suggestion failed.");
    } finally {
      setAiBusy(false);
    }
  }

  async function add() {
    if (!raw.trim() || !brickId) { setError("Enter the raw territory text and pick a brick."); return; }
    setBusy(true); setMessage(null); setError(null);
    try {
      const response = await fetch("/api/sales/monthly-import/save-mappings", {
        body: JSON.stringify({ mappings: [{ type: "territory", raw: raw.trim(), code: brickId }] }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = await readJson<ImportResponse>(response, { success: false });
      if (payload.success) { setMessage(payload.message ?? "Mapping added."); setRaw(""); setBrickId(""); setAiConfidence(null); onSaved?.(); }
      else setError(payload.error ?? "Add failed.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Add failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft">Or add one by field</p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Raw territory / district text">
          <input className={cn(fieldInputClass, "w-56")} disabled={busy} onChange={(event) => { setRaw(event.target.value); setAiConfidence(null); }} placeholder="exact text from the distributor sheet" value={raw} />
        </Field>
        <Field label="Brick">
          <div className="w-64">
            <MappingCombobox
              disabled={busy}
              onChange={(value) => { setBrickId(value); setAiConfidence(null); }}
              options={bricks.map((brick) => ({ code: brick.id, name: brick.name }))}
              placeholder="Search brick code or name (ex: B10, Mont)"
              value={brickId}
            />
          </div>
        </Field>
        <AiSuggestButton busy={aiBusy} disabled={aiBusy || busy || !raw.trim()} onClick={() => void aiSuggestOne()} />
        {aiConfidence != null ? <AiConfidenceBadge confidence={aiConfidence} /> : null}
        <Button className="h-9 gap-1 rounded-xl bg-phx-accent font-black text-white transition hover:bg-[#EA6A0C]" disabled={busy} onClick={() => void add()} type="button">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add
        </Button>
      </div>
      {message ? <p className="text-xs font-bold text-emerald-600">{message}</p> : null}
      {error ? <p className="text-xs font-bold text-rose-600">{error}</p> : null}
    </div>
  );
}

export { MappingCombobox };

// Lightweight disclosure used to fold the optional/power tools away so the default screen only shows
// the everyday path. It's just a clickable header bar; the existing Cards render unchanged inside it.
function CollapsibleSection({ title, subtitle, open, onToggle, children }: { title: string; subtitle?: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <div>
      <button
        className="flex w-full items-center justify-between gap-3 rounded-2xl border border-phx-line bg-phx-paper px-5 py-3.5 text-left transition hover:bg-phx-paper-2"
        onClick={onToggle}
        type="button"
      >
        <div>
          <h3 className="text-sm font-black text-slate-950">{title}</h3>
          {subtitle ? <p className="mt-0.5 text-xs text-phx-ink-soft">{subtitle}</p> : null}
        </div>
        <ChevronDown className={cn("h-5 w-5 shrink-0 text-phx-ink-soft transition-transform duration-200", open && "rotate-180")} />
      </button>
      {open ? <div className="mt-3 space-y-4">{children}</div> : null}
    </div>
  );
}

export function SourceOfSalesMappingTab({ distributors, distributorCode, onDistributorChange, profiledDistributorCodes, products, bricks }: Props) {
  const [headersCopied, setHeadersCopied] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const profiled = new Set(profiledDistributorCodes.map((code) => code.trim().toUpperCase()));
  const hasProfile = profiled.has((distributorCode ?? "").trim().toUpperCase());

  // A Tips deep-link (Bootstrap / Analyze) opens the tools section, then scrolls to the target.
  function navigateToTools(scrollId: string) {
    setToolsOpen(true);
    setTimeout(() => document.getElementById(scrollId)?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  }

  return (
    <div className="space-y-4">
      {/* Slim intro — one line, not three paragraphs. */}
      <AdminCallout tone="neutral">
        <UploadCloud className="mt-0.5 h-4 w-4 shrink-0" />
        <p className="text-sm">
          <b>Map once, reuse forever.</b> Pick a distributor, set its <b>Product</b> and <b>Customer / Brick</b> mappings,
          then upload the raw sheet on the <b>Upload &amp; Status</b> tab. Anything still unmapped appears in{" "}
          <Link className="font-semibold text-phx-accent underline" href="/sales/missing-data">Missing Data</Link>.
        </p>
      </AdminCallout>

      {/* Step 1 — the one required choice. */}
      <Card className={cn(panelClassName, "flex flex-wrap items-center gap-3 p-4")}>
        <span className="text-xs font-bold uppercase tracking-[0.16em] text-phx-ink-soft">Distributor</span>
        <SearchableSelect
          className="px-3.5"
          onChange={(event) => onDistributorChange(event.target.value)}
          value={distributorCode}
        >
          {distributors.map((distributor) => (
            <option key={distributor.code} value={distributor.code}>
              {distributor.name} / {distributor.code}
            </option>
          ))}
        </SearchableSelect>
        <span className="text-xs text-phx-ink-soft">Shared with the Upload &amp; Status tab and the tools below.</span>
      </Card>

      {/* Primary — the two everyday mapping cards stay visible, numbered as the steps to do. */}
      <TemplateCard
        description="Map this distributor's raw item code or item name to a Phoenix Product ID. The Distrub ID column is locked to the selected distributor — you never fill it. The downloaded file is pre-filled with everything already mapped for this distributor and includes a read-only Master Products reference sheet. Update it any time and re-upload."
        step={1}
        templateHref={`/api/sales/monthly-import/product-mapping/template?distributor=${encodeURIComponent(distributorCode)}`}
        templateLabel="Download Product Mapping template"
        title={`Product Mapping — ${distributorCode || "(pick a distributor)"}`}
        uploadFields={{ distributorCode }}
        uploadUrl="/api/sales/monthly-import/product-mapping"
      >
        <ProductAddForm distributorCode={distributorCode} products={products} />
      </TemplateCard>

      <TemplateCard
        description="Map this distributor's customer codes to Phoenix Brick IDs (Area and Region fill automatically from the brick). You only need Customer code + Brick ID — leave Distrub ID blank and it's filled in from the selected distributor. Pre-filled with what's already saved, plus a read-only Master Bricks reference sheet."
        step={2}
        templateHref={`/api/sales/monthly-import/customer-mapping/template?distributor=${encodeURIComponent(distributorCode)}`}
        templateLabel="Download Customer / Brick template"
        title={`Customer / Brick Mapping — ${distributorCode || "(pick a distributor)"}`}
        uploadFields={{ distributorCode }}
        uploadUrl="/api/sales/monthly-import/customer-mapping"
      >
        <CustomerBrickAddForm bricks={bricks} distributorCode={distributorCode} />
      </TemplateCard>

      {/* Everything optional folds into ONE collapsed section, closed by default. */}
      <CollapsibleSection
        onToggle={() => setToolsOpen((v) => !v)}
        open={toolsOpen}
        subtitle="AI-assist a raw sheet, learn from a coded file, global territory mapping, manual columns, and tips."
        title="More mapping tools (optional)"
      >
        <MissingPanel bricks={bricks} distributorCode={distributorCode} hasProfile={hasProfile} products={products} />
        <BootstrapCard distributorCode={distributorCode} hasProfile={hasProfile} />

        <TemplateCard
          description="Map raw territory / area text (as it appears in distributor sheets) to a Phoenix Brick ID. This mapping is global — it applies to all distributors. Download the template to see every alias already saved and the full Master Bricks reference, fill in any new rows, then re-upload."
          templateHref="/api/sales/monthly-import/territory-mapping/template"
          templateLabel="Download Territory Mapping template"
          title="Territory Mapping (global — all distributors)"
          uploadFields={{}}
          uploadUrl="/api/sales/monthly-import/territory-mapping"
        />

        <Card className={cn(panelClassName, "space-y-3 p-5")}>
          <div>
            <h3 className="text-sm font-black uppercase tracking-[0.14em] text-phx-ink-soft">Advanced — manual coded columns</h3>
            <p className="mt-1 text-sm leading-6 text-phx-ink-soft">
              Optional fallback. If you still prefer to paste the coded columns onto a sheet by hand, copy the headers and
              paste them as the last columns. The importer accepts coded sheets too.
            </p>
          </div>
          <Button
            className="h-10 w-fit gap-2"
            onClick={async () => {
              try {
                await copyCodedHeaders();
                setHeadersCopied(true);
                setTimeout(() => setHeadersCopied(false), 1800);
              } catch { /* clipboard blocked */ }
            }}
            type="button"
            variant="secondary"
          >
            {headersCopied ? <CheckCircle2 className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
            {headersCopied ? "Copied!" : "Copy coded headers"}
          </Button>
        </Card>

        <TipsPanel onNavigate={navigateToTools} />
      </CollapsibleSection>
    </div>
  );
}
