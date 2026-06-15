"use client";

import { AlertTriangle, CheckCircle2, Copy, Download, Loader2, Search, Sparkles, UploadCloud } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";

import { AdminCallout } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { SalesDistributorOption } from "@/lib/sales/monthly-distributor-import";
import { cn } from "@/lib/utils";

type Props = {
  distributors: SalesDistributorOption[];
  distributorCode: string;
  onDistributorChange: (code: string) => void;
  /** Distributor codes that have a normalizer layout profile (Learn/Analyze need one). */
  profiledDistributorCodes: string[];
};

type BlockedRow = { reason: string; row?: number; rowNumber?: number; values?: string; key?: string };
type ImportResult = { saved?: number; skipped?: number; inserted?: number; updated?: number; totalRead?: number; scannedRows?: number; invalid?: number; blockedRows?: BlockedRow[] };
type ImportResponse = { success: boolean; result?: ImportResult; message?: string; error?: string };

type DistinctUnknown = { count: number; raw: string; rawName: string; suggestionCode: string | null; suggestionLabel: string | null };
type NormalizePreview = {
  distributorName: string;
  period: string | null;
  summary: { brickResolved: number; fullyCoded: number; ignored: number; productResolved: number; totalRows: number };
  unknownCustomers: DistinctUnknown[];
  unknownProducts: DistinctUnknown[];
  unknownTerritories: DistinctUnknown[];
};
type PreviewResponse = { success: boolean; data?: NormalizePreview; error?: string };
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
}: {
  title: string;
  description: string;
  templateHref: string;
  templateLabel: string;
  uploadUrl: string;
  uploadFields?: Record<string, string>;
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
      <ResultBanner error={error} message={message} result={result} />
    </Card>
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
    <Card className={cn(panelClassName, "space-y-4 p-5")}>
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
function MissingPanel({ distributorCode, hasProfile }: { distributorCode: string; hasProfile: boolean }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [aiKind, setAiKind] = useState<"product" | "territory" | null>(null);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<NormalizePreview | null>(null);
  const [productCodes, setProductCodes] = useState<Record<string, string>>({});
  const [territoryCodes, setTerritoryCodes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function analyze(file: File) {
    setBusy(true); setError(null); setMessage(null); setPreview(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("distributorCode", distributorCode);
      const response = await fetch("/api/sales/monthly-import/missing", { body: formData, method: "POST" });
      const payload = await readJson<PreviewResponse>(response, { success: false });
      if (payload.success && payload.data) {
        setPreview(payload.data);
        setProductCodes(Object.fromEntries(payload.data.unknownProducts.map((u) => [u.raw, u.suggestionCode ?? ""])));
        setTerritoryCodes(Object.fromEntries(payload.data.unknownTerritories.map((u) => [u.raw, u.suggestionCode ?? ""])));
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
    const mappings: { type: "product" | "territory"; raw: string; code: string }[] = [];
    for (const [raw, code] of Object.entries(productCodes)) if (code.trim()) mappings.push({ type: "product", raw, code: code.trim() });
    for (const [raw, code] of Object.entries(territoryCodes)) if (code.trim()) mappings.push({ type: "territory", raw, code: code.trim() });
    if (mappings.length === 0) { setError("Fill at least one Phoenix code before saving."); return; }
    setSaving(true); setError(null); setMessage(null);
    try {
      const response = await fetch("/api/sales/monthly-import/save-mappings", {
        body: JSON.stringify({ mappings }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = await readJson<ImportResponse>(response, { success: false });
      if (payload.success) setMessage(payload.message ?? "Mappings saved.");
      else setError(payload.error ?? "Save failed.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  const fullyCodedPct = preview && preview.summary.totalRows > 0
    ? Math.round((preview.summary.fullyCoded / preview.summary.totalRows) * 100)
    : 0;

  return (
    <Card className={cn(panelClassName, "space-y-4 p-5")}>
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

      {preview ? (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2 text-xs font-bold">
            <span className="rounded-full border border-[#BBF7D0] bg-[#F0FDF4] px-3 py-1 text-[#166534]">{fullyCodedPct}% fully coded</span>
            <span className="rounded-full border border-[#E2E8F0] bg-[#FCFDFE] px-3 py-1 text-[#0F172A]">{preview.summary.totalRows} rows</span>
            <span className="rounded-full border border-[#E2E8F0] bg-[#FCFDFE] px-3 py-1 text-[#0F172A]">{preview.unknownProducts.length} unknown products</span>
            <span className="rounded-full border border-[#E2E8F0] bg-[#FCFDFE] px-3 py-1 text-[#0F172A]">{preview.unknownTerritories.length} unknown areas</span>
            {preview.unknownCustomers.length > 0 ? (
              <span className="rounded-full border border-[#FDE68A] bg-[#FFFBEB] px-3 py-1 text-[#92400E]">{preview.unknownCustomers.length} customers need a brick (use the Customer / Brick template)</span>
            ) : null}
          </div>

          {preview.unknownProducts.length > 0 ? (
            <UnknownTable
              busyAi={aiKind === "product"}
              codes={productCodes}
              kind="product"
              onAi={() => void aiSuggest("product")}
              onChange={(raw, code) => setProductCodes((prev) => ({ ...prev, [raw]: code }))}
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
              rows={preview.unknownTerritories}
            />
          ) : null}

          {preview.unknownProducts.length > 0 || preview.unknownTerritories.length > 0 ? (
            <Button
              className="h-10 w-fit gap-2 rounded-xl bg-[#F97316] font-black text-white transition hover:bg-[#EA6A0C]"
              disabled={saving}
              onClick={() => void save()}
              type="button"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              Save mappings
            </Button>
          ) : (
            <AdminCallout tone="success">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <p>Every product and area in this sheet is already mapped. Upload the raw sheet on the Uploaded Sheets tab.</p>
            </AdminCallout>
          )}
        </div>
      ) : null}

      <ResultBanner error={error} message={message} result={null} />
    </Card>
  );
}

function UnknownTable({
  rows,
  codes,
  kind,
  busyAi,
  onAi,
  onChange,
}: {
  rows: DistinctUnknown[];
  codes: Record<string, string>;
  kind: "product" | "territory";
  busyAi: boolean;
  onAi: () => void;
  onChange: (raw: string, code: string) => void;
}) {
  return (
    <div className="rounded-2xl border border-[#E2E8F0]">
      <div className="flex items-center justify-between gap-3 border-b border-[#E2E8F0] px-4 py-2.5">
        <p className="text-xs font-black uppercase tracking-[0.14em] text-[#64748B]">
          Unknown {kind === "product" ? "products" : "areas"} ({rows.length})
        </p>
        <Button className="h-8 gap-2" disabled={busyAi} onClick={onAi} type="button" variant="secondary">
          {busyAi ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          AI suggest
        </Button>
      </div>
      <div className="max-h-72 overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-[#020617] text-left text-[11px] font-black uppercase tracking-[0.12em] text-white">
            <tr>
              <th className="px-4 py-2">Raw {kind === "product" ? "item" : "area"}</th>
              <th className="px-4 py-2 text-right">Rows</th>
              <th className="px-4 py-2">Phoenix {kind === "product" ? "Product ID" : "Brick ID"}</th>
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
                  <input
                    className="h-9 w-full rounded-lg border border-[#E2E8F0] px-2 text-sm focus:border-[#FDBA74] focus:outline-none"
                    onChange={(event) => onChange(row.raw, event.target.value)}
                    placeholder={kind === "product" ? "e.g. TE001" : "e.g. B100-11"}
                    value={codes[row.raw] ?? ""}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function SourceOfSalesMappingTab({ distributors, distributorCode, onDistributorChange, profiledDistributorCodes }: Props) {
  const [headersCopied, setHeadersCopied] = useState(false);
  const profiled = new Set(profiledDistributorCodes.map((code) => code.trim().toUpperCase()));
  const hasProfile = profiled.has((distributorCode ?? "").trim().toUpperCase());

  return (
    <div className="space-y-5">
      <AdminCallout tone="neutral">
        <UploadCloud className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <p className="font-semibold">Map once, then upload the raw sheet as-is.</p>
          <p className="text-sm">
            Set up the product and customer mappings below (the AI assist and &ldquo;learn from a coded file&rdquo; do most of
            the work). Then upload each distributor&apos;s <b>raw export</b> on the <b>Uploaded Sheets</b> tab — no coded
            columns to add by hand. Anything still unmapped appears in{" "}
            <Link className="font-semibold text-[#F97316] underline" href="/sales/missing-data">Missing Data</Link>.
          </p>
        </div>
      </AdminCallout>

      <Card className={cn(panelClassName, "flex flex-wrap items-center gap-3 p-4")}>
        <span className="text-xs font-bold uppercase tracking-[0.16em] text-[#64748B]">Distributor</span>
        <select
          className="h-10 rounded-2xl border border-[#D8E0EA] bg-[#F8FAFC] px-3.5 text-sm font-semibold text-[#0F172A] outline-none transition focus:border-[#FDBA74] focus:ring-4 focus:ring-[#F97316]/10"
          onChange={(event) => onDistributorChange(event.target.value)}
          value={distributorCode}
        >
          {distributors.map((distributor) => (
            <option key={distributor.code} value={distributor.code}>
              {distributor.name} / {distributor.code}
            </option>
          ))}
        </select>
        <span className="text-xs text-[#64748B]">Shared with the Uploaded Sheets tab and the tools below.</span>
      </Card>

      <TemplateCard
        description="Map each distributor's raw item code or item name to a Phoenix Product ID. Shared across all distributors. The downloaded file is pre-filled with what's already mapped and includes a read-only Master Products reference sheet."
        templateHref="/api/sales/monthly-import/product-mapping/template"
        templateLabel="Download Product Mapping template"
        title="Product Mapping"
        uploadUrl="/api/sales/monthly-import/product-mapping"
      />

      <TemplateCard
        description="Map this distributor's customer codes to Phoenix Brick IDs (Area and Region fill automatically from the brick). You only need Customer code + Brick ID — leave Distrub ID blank and it's filled in from the selected distributor. Pre-filled with what's already saved, plus a read-only Master Bricks reference sheet."
        templateHref={`/api/sales/monthly-import/customer-mapping/template?distributor=${encodeURIComponent(distributorCode)}`}
        templateLabel="Download Customer / Brick template"
        title={`Customer / Brick Mapping — ${distributorCode || "(pick a distributor)"}`}
        uploadFields={{ distributorCode }}
        uploadUrl="/api/sales/monthly-import/customer-mapping"
      />

      <BootstrapCard distributorCode={distributorCode} hasProfile={hasProfile} />

      <MissingPanel distributorCode={distributorCode} hasProfile={hasProfile} />

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
