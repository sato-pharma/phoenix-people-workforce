"use client";

import { AlertTriangle, CheckCircle2, ChevronDown, Copy, Download, Info, Loader2, Plus, Search, Sparkles, UploadCloud, XCircle } from "lucide-react";
import Link from "next/link";
import { useRef, useState, type ReactNode } from "react";

import { AdminCallout } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { SalesDistributorOption } from "@/lib/sales/monthly-distributor-import";
import { cn } from "@/lib/utils";
import { SearchableSelect } from "@/components/ui/searchable-select";


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

type HeaderValidationFailure = { label: string; expected: string[] };
type DistinctUnknown = { count: number; raw: string; rawName: string; suggestionCode: string | null; suggestionLabel: string | null };
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
type AiResponse = { success: boolean; data?: { suggestions: { raw: string; code: string }[] }; error?: string };

const panelClassName = "rounded-3xl border border-[#D8E0EA] bg-white/95 shadow-[0_18px_42px_rgba(15,23,42,0.07)]";

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
                    {detail ? <span className="text-[#64748B]"> ({detail})</span> : null}
                  </li>
                );
              })}
            </ul>
            {blocked.length > 50 ? <p className="mt-1 text-xs text-[#64748B]">…and {blocked.length - 50} more.</p> : null}
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
}: {
  title: string;
  description: string;
  templateHref: string;
  templateLabel: string;
  uploadUrl: string;
  uploadFields?: Record<string, string>;
  children?: ReactNode;
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
    <Card className={cn(panelClassName, "space-y-4 p-5")}>
      <div>
        <h3 className="text-lg font-black tracking-tight text-slate-950">{title}</h3>
        <p className="mt-1 text-sm leading-6 text-[#64748B]">{description}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <a
          className="inline-flex h-10 items-center gap-2 rounded-xl border border-[#D8E0EA] bg-white px-4 text-sm font-bold text-[#0F172A] transition hover:border-[#F97316] hover:text-[#F97316]"
          href={templateHref}
        >
          <Download className="h-4 w-4" />
          {templateLabel}
        </a>
        <Button
          className="h-10 gap-2 rounded-xl bg-[#0B0B0B] font-black text-white transition hover:bg-[#F97316]"
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
      {children ? <div className="border-t border-dashed border-[#E2E8F0] pt-4">{children}</div> : null}
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

function TipsPanel() {
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
    <div className="rounded-2xl border border-[#FED7AA] bg-[#FFF7ED]">
      <button className="flex w-full items-center justify-between px-4 py-3 text-left" onClick={toggle} type="button">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-[#F97316]" />
          <span className="text-sm font-black text-[#0F172A]">5 mapping tips &amp; tricks</span>
        </div>
        <ChevronDown className={cn("h-4 w-4 text-[#F97316] transition-transform duration-200", open && "rotate-180")} />
      </button>
      {open ? (
        <div className="grid gap-4 border-t border-[#FED7AA] px-4 pb-4 pt-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {TIPS.map((tip) => (
            <div className="flex gap-2.5" key={tip.title}>
              <span className="mt-0.5 shrink-0 text-base leading-none">{tip.icon}</span>
              <div className="flex flex-col gap-1.5">
                <p className="text-xs font-black text-[#0F172A]">{tip.title}</p>
                <p className="text-xs leading-5 text-[#64748B]">{tip.body}</p>
                {tip.href ? (
                  <Link className="inline-flex w-fit items-center gap-1 rounded-lg border border-[#F97316] px-2.5 py-1 text-[11px] font-black text-[#F97316] transition hover:bg-[#F97316] hover:text-white" href={tip.href}>{tip.actionLabel}</Link>
                ) : tip.scrollId ? (
                  <button className="inline-flex w-fit items-center gap-1 rounded-lg border border-[#F97316] px-2.5 py-1 text-[11px] font-black text-[#F97316] transition hover:bg-[#F97316] hover:text-white" onClick={() => document.getElementById(tip.scrollId!)?.scrollIntoView({ behavior: "smooth", block: "start" })} type="button">{tip.actionLabel}</button>
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
        <p className="mt-1 text-sm leading-6 text-[#64748B]">
          Already have a sheet with the Phoenix codes filled in (raw columns + <b>Product ID</b> / <b>Brick ID</b>)?
          Upload it for <b>{distributorCode || "(pick a distributor)"}</b> and the system learns every product and
          customer→brick pair at once — so most of your mapping is done in one click.
        </p>
      </div>
      {hasProfile ? null : <NoProfileNote distributorCode={distributorCode} />}
      <Button
        className="h-10 w-fit gap-2 rounded-xl bg-[#0B0B0B] font-black text-white transition hover:bg-[#F97316]"
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
    const mappings: { type: "product" | "territory" | "customer"; raw: string; code: string }[] = [];
    for (const [raw, code] of Object.entries(productCodes)) if (code.trim()) mappings.push({ type: "product", raw, code: code.trim() });
    for (const [raw, code] of Object.entries(territoryCodes)) if (code.trim()) mappings.push({ type: "territory", raw, code: code.trim() });
    for (const [raw, code] of Object.entries(customerCodes)) if (code.trim()) mappings.push({ type: "customer", raw, code: code.trim() });
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

  async function handleImportNow(file: File) {
    setImporting(true); setImportResult(null); setImportMessage(null); setImportError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("distributorCode", distributorCode);
      if (preview?.period) formData.append("period", preview.period);
      const response = await fetch("/api/sales/monthly-import/validate", { body: formData, method: "POST" });
      const payload = await readJson<ImportResponse>(response, { success: false });
      setImportResult(payload.result ?? null);
      if (payload.success) setImportMessage(payload.message ?? "Import complete.");
      else setImportError(payload.error ?? "Import failed.");
    } catch (caught) {
      setImportError(caught instanceof Error ? caught.message : "Import failed.");
    } finally {
      setImporting(false);
      if (importRef.current) importRef.current.value = "";
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
        <p className="mt-1 text-sm leading-6 text-[#64748B]">
          Upload the distributor&apos;s <b>raw sheet</b> here to preview how much already maps — <b>nothing is saved</b>.
          The few unmatched products and areas are listed below with a suggested Phoenix code; let AI fill them, adjust
          if needed, then save. They&apos;re remembered for every future upload.
        </p>
      </div>
      {hasProfile ? null : <NoProfileNote distributorCode={distributorCode} />}
      <Button
        className="h-10 w-fit gap-2 rounded-xl bg-[#0B0B0B] font-black text-white transition hover:bg-[#F97316]"
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
            <p className="mt-0.5 text-xs text-[#64748B]">The Analyzer is for raw distributor files only. Coded sheets (containing Phoenix product IDs) should go straight to the Import raw file button below.</p>
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
            <span className="rounded-full border border-[#E2E8F0] bg-[#FCFDFE] px-3 py-1 text-[#0F172A]">{preview.summary.totalRows} rows</span>
            <span className="rounded-full border border-[#E2E8F0] bg-[#FCFDFE] px-3 py-1 text-[#0F172A]">{preview.unknownProducts.length} unknown products</span>
            <span className="rounded-full border border-[#E2E8F0] bg-[#FCFDFE] px-3 py-1 text-[#0F172A]">{preview.unknownTerritories.length} unknown areas</span>
            <span className="rounded-full border border-[#E2E8F0] bg-[#FCFDFE] px-3 py-1 text-[#0F172A]">{preview.unknownCustomers.length} unknown customers</span>
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
                  <span className="w-16 shrink-0 text-xs font-semibold text-[#64748B]">Products</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#E2E8F0]">
                    <div className={cn("h-full rounded-full transition-all duration-300", productsMapped === productsTotal ? "bg-emerald-500" : "bg-[#F97316]")} style={{ width: `${Math.round((productsMapped / productsTotal) * 100)}%` }} />
                  </div>
                  <span className={cn("w-10 shrink-0 text-right text-xs font-black tabular-nums", productsMapped === productsTotal ? "text-emerald-600" : "text-[#F97316]")}>{productsMapped}/{productsTotal}</span>
                </div>
              ) : null}
              {territoriesTotal > 0 ? (
                <div className="flex items-center gap-3">
                  <span className="w-16 shrink-0 text-xs font-semibold text-[#64748B]">Areas</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#E2E8F0]">
                    <div className={cn("h-full rounded-full transition-all duration-300", territoriesMapped === territoriesTotal ? "bg-emerald-500" : "bg-[#F97316]")} style={{ width: `${Math.round((territoriesMapped / territoriesTotal) * 100)}%` }} />
                  </div>
                  <span className={cn("w-10 shrink-0 text-right text-xs font-black tabular-nums", territoriesMapped === territoriesTotal ? "text-emerald-600" : "text-[#F97316]")}>{territoriesMapped}/{territoriesTotal}</span>
                </div>
              ) : null}
              {customersTotal > 0 ? (
                <div className="flex items-center gap-3">
                  <span className="w-16 shrink-0 text-xs font-semibold text-[#64748B]">Customers</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#E2E8F0]">
                    <div className={cn("h-full rounded-full transition-all duration-300", customersMapped === customersTotal ? "bg-emerald-500" : "bg-[#F97316]")} style={{ width: customersTotal > 0 ? `${Math.round((customersMapped / customersTotal) * 100)}%` : "0%" }} />
                  </div>
                  <span className={cn("w-10 shrink-0 text-right text-xs font-black tabular-nums", customersMapped === customersTotal ? "text-emerald-600" : "text-[#F97316]")}>{customersMapped}/{customersTotal}</span>
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
                <Button className="h-8 shrink-0 gap-1.5 rounded-xl bg-[#F97316] font-black text-white hover:bg-[#EA6A0C]" disabled={saving} onClick={() => void save()} type="button">
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
              className="h-10 w-fit gap-2 rounded-xl bg-[#F97316] font-black text-white transition hover:bg-[#EA6A0C]"
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
            <Button className="h-9 gap-2 rounded-xl bg-[#0B0B0B] font-black text-white hover:bg-[#F97316]" disabled={importing} onClick={() => importRef.current?.click()} type="button">
              {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
              {importing ? "Importing…" : "Import raw file"}
            </Button>
            <input accept=".xlsx" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void handleImportNow(file); }} ref={importRef} type="file" />
          </div>
          <p className="mt-2 text-xs text-[#64748B]">Upload the same raw file you just analyzed — it will be imported with your saved mappings applied.</p>
        </div>
      ) : null}

      {importMessage || importError || (importResult?.blockedRows?.length ?? 0) > 0 ? (
        <ResultBanner error={importError} message={importMessage} result={importResult} />
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
  const inputRef = useRef<HTMLInputElement | null>(null);

  function openWithPos() {
    if (disabled) return;
    if (inputRef.current) {
      const r = inputRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 2, left: r.left, width: r.width });
    }
    setOpen(true);
  }


  const q = value.toLowerCase();
  const filtered = q
    ? options.filter((o) => o.code.toLowerCase().includes(q) || o.name.toLowerCase().includes(q)).slice(0, 25)
    : options.slice(0, 25);

  return (
    <div className="relative">
      <input
        ref={inputRef}
        disabled={disabled}
        className="h-9 w-full rounded-lg border border-[#E2E8F0] px-2 text-sm focus:border-[#FDBA74] focus:outline-none"
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => { onChange(e.target.value); openWithPos(); }}
        onFocus={openWithPos}
        placeholder={placeholder}
        value={value}
      />
      {open && filtered.length > 0 && pos && (
        <div
          className="z-9999 max-h-48 overflow-auto rounded-lg border border-[#E2E8F0] bg-white shadow-lg"
          style={{ position: "fixed", top: pos.top, left: pos.left, width: Math.max(pos.width, 240) }}
        >
          {filtered.map((o) => (
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-[#FFF7ED]"
              key={o.code}
              onMouseDown={() => {
                if (disabled) return;
                onChange(o.code);
                setOpen(false);
              }}
              type="button"
            >
              <span className="shrink-0 font-mono text-xs font-bold text-[#F97316]">{o.code}</span>
              <span className="truncate text-xs text-[#64748B]">{o.name}</span>
            </button>
          ))}
        </div>
      )}
      {open && filtered.length === 0 && pos && (
        <div
          className="z-9999 rounded-lg border border-[#E2E8F0] bg-white p-2 text-xs text-[#64748B] shadow-lg"
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
  const codeLabel = kind === "product" ? "Product ID" : "Brick ID";
  return (
    <div className="rounded-2xl border border-[#E2E8F0]">
      <div className="flex items-center justify-between gap-3 border-b border-[#E2E8F0] px-4 py-2.5">
        <div className="flex items-center gap-2">
          <p className="text-xs font-black uppercase tracking-[0.14em] text-[#64748B]">
            Unknown {label} ({rows.length})
          </p>
          {busyAi ? <span className="animate-pulse text-xs font-bold text-[#F97316]">AI working…</span> : null}
        </div>
        {onAi ? (
          <Button className="h-8 gap-2" disabled={busyAi} onClick={onAi} type="button" variant="secondary">
            {busyAi ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            AI suggest
          </Button>
        ) : null}
      </div>
      <div className="max-h-72 overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-[#020617] text-left text-[11px] font-black uppercase tracking-[0.12em] text-white">
            <tr>
              <th className="px-4 py-2">Raw {rawLabel}</th>
              <th className="px-4 py-2 text-right">Rows</th>
              <th className="px-4 py-2">Phoenix {codeLabel}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr className="border-b border-[#FFE8D6]" key={row.raw}>
                <td className="px-4 py-2">
                  <span className="block font-semibold text-[#0F172A]">{row.rawName || row.raw}</span>
                  {row.rawName && row.rawName !== row.raw ? <span className="block text-xs text-[#64748B]">{row.raw}</span> : null}
                  {row.suggestionLabel ? <span className="block text-xs text-[#F97316]">suggest: {row.suggestionLabel}</span> : null}
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-[#64748B]">{row.count}</td>
                <td className="px-4 py-2">
                  <div className="flex items-center gap-2">
                    <MappingCombobox
                      onChange={(code) => onChange(row.raw, code)}
                      options={options}
                      placeholder={kind === "product" ? "e.g. TE001" : "e.g. B100-11"}
                      value={codes[row.raw] ?? ""}
                    />
                    {codes[row.raw] ? (
                      <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-black text-emerald-700">✓</span>
                    ) : (
                      <span className="shrink-0 rounded-full bg-rose-50 px-2 py-0.5 text-[10px] font-black text-rose-500">○</span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const fieldInputClass = "h-9 border border-[#E2E8F0] px-2 text-sm text-[#0F172A] outline-none focus:border-[#FDBA74]";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-black uppercase tracking-[0.12em] text-[#94A3B8]">{label}</span>
      {children}
    </label>
  );
}

/** Inline "add one" — distributor item code/name -> Phoenix product (no upload needed). */
function ProductAddForm({ distributorCode, products }: { distributorCode: string; products: { code: string; name: string }[] }) {
  const [alias, setAlias] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      if (payload.success) { setMessage(payload.message ?? "Mapping added."); setAlias(""); setCode(""); }
      else setError(payload.error ?? "Add failed.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Add failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs font-black uppercase tracking-[0.14em] text-[#64748B]">Or add one by field</p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Alias (item code or name)">
          <input className={cn(fieldInputClass, "w-56")} disabled={busy} onChange={(event) => setAlias(event.target.value)} placeholder="distributor's item code or name" value={alias} />
        </Field>
        <Field label="Phoenix product">
          <div className="w-64">
            <MappingCombobox
              disabled={busy}
              onChange={(value) => setCode(value)}
              options={products.map((product) => ({ code: product.code, name: product.name }))}
              placeholder="Search product code or name"
              value={code}
            />
          </div>
        </Field>
        <Button className="h-9 gap-1 rounded-xl bg-[#F97316] font-black text-white transition hover:bg-[#EA6A0C]" disabled={busy || !distributorCode} onClick={() => void add()} type="button">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add
        </Button>
      </div>
      {message ? <p className="text-xs font-bold text-emerald-600">{message}</p> : null}
      {error ? <p className="text-xs font-bold text-rose-600">{error}</p> : null}
    </div>
  );
}

/** Inline "add one" — customer code -> brick (Area/Region derive from the brick). */
function CustomerBrickAddForm({ distributorCode, bricks }: { distributorCode: string; bricks: { id: string; name: string }[] }) {
  const [customerCode, setCustomerCode] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [address, setAddress] = useState("");
  const [brickId, setBrickId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      if (payload.success) { setMessage(payload.message ?? "Mapping added."); setCustomerCode(""); setCustomerName(""); setAddress(""); setBrickId(""); }
      else setError(payload.error ?? "Add failed.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Add failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs font-black uppercase tracking-[0.14em] text-[#64748B]">Or add one by field</p>
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
              onChange={(value) => setBrickId(value)}
              options={bricks.map((brick) => ({ code: brick.id, name: brick.name }))}
              placeholder="Search brick code or name (ex: B10, Mont)"
              value={brickId}
            />
          </div>
        </Field>
        <Button className="h-9 gap-1 rounded-xl bg-[#F97316] font-black text-white transition hover:bg-[#EA6A0C]" disabled={busy || !distributorCode} onClick={() => void add()} type="button">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add
        </Button>
      </div>
      {message ? <p className="text-xs font-bold text-emerald-600">{message}</p> : null}
      {error ? <p className="text-xs font-bold text-rose-600">{error}</p> : null}
    </div>
  );
}

export { MappingCombobox };

export function SourceOfSalesMappingTab({ distributors, distributorCode, onDistributorChange, profiledDistributorCodes, products, bricks }: Props) {
  const [headersCopied, setHeadersCopied] = useState(false);
  const profiled = new Set(profiledDistributorCodes.map((code) => code.trim().toUpperCase()));
  const hasProfile = profiled.has((distributorCode ?? "").trim().toUpperCase());

  return (
    <div className="space-y-5">
      <AdminCallout tone="neutral">
        <UploadCloud className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <p className="font-semibold">Map once, then upload the raw sheet as-is — no coded columns to add by hand.</p>
          <p className="text-sm">
            Set up the product and customer mappings below (the AI assist and &ldquo;learn from a coded file&rdquo; do most of
            the work). Then upload each distributor&apos;s <b>raw export</b> on the <b>Uploaded Sheets</b> tab — no coded
            columns to add by hand. Anything still unmapped appears in{" "}
            <Link className="font-semibold text-[#F97316] underline" href="/sales/missing-data">Missing Data</Link>.
          </p>
        </div>
      </AdminCallout>

      <TipsPanel />

      <Card className={cn(panelClassName, "flex flex-wrap items-center gap-3 p-4")}>
        <span className="text-xs font-bold uppercase tracking-[0.16em] text-[#64748B]">Distributor</span>
        <SearchableSelect
          className="h-10 rounded-2xl border border-[#D8E0EA] bg-[#F8FAFC] px-3.5 text-sm font-semibold text-[#0F172A] outline-none transition focus:border-[#FDBA74] focus:ring-4 focus:ring-[#F97316]/10"
          onChange={(event) => onDistributorChange(event.target.value)}
          value={distributorCode}
        >
          {distributors.map((distributor) => (
            <option key={distributor.code} value={distributor.code}>
              {distributor.name} / {distributor.code}
            </option>
          ))}
        </SearchableSelect>
        <span className="text-xs text-[#64748B]">Shared with the Uploaded Sheets tab and the tools below.</span>
      </Card>

      <TemplateCard
        description="Map this distributor's raw item code or item name to a Phoenix Product ID. The Distrub ID column is locked to the selected distributor — you never fill it. The downloaded file is pre-filled with everything already mapped for this distributor and includes a read-only Master Products reference sheet. Update it any time and re-upload."
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
        templateHref={`/api/sales/monthly-import/customer-mapping/template?distributor=${encodeURIComponent(distributorCode)}`}
        templateLabel="Download Customer / Brick template"
        title={`Customer / Brick Mapping — ${distributorCode || "(pick a distributor)"}`}
        uploadFields={{ distributorCode }}
        uploadUrl="/api/sales/monthly-import/customer-mapping"
      >
        <CustomerBrickAddForm bricks={bricks} distributorCode={distributorCode} />
      </TemplateCard>

      <BootstrapCard distributorCode={distributorCode} hasProfile={hasProfile} />

      <MissingPanel bricks={bricks} distributorCode={distributorCode} hasProfile={hasProfile} products={products} />

      <Card className={cn(panelClassName, "space-y-3 p-5")}>
        <div>
          <h3 className="text-sm font-black uppercase tracking-[0.14em] text-[#64748B]">Advanced — manual coded columns</h3>
          <p className="mt-1 text-sm leading-6 text-[#64748B]">
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
    </div>
  );
}
