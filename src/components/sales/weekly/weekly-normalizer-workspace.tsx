"use client";

import { AlertTriangle, ArrowRight, CalendarDays, CheckCircle2, Database, Download, FileSpreadsheet, Layers, Loader2, MapPin, Package, Save, Sparkles, Upload } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";

import { AdminCallout, AdminInsightChip, AdminPageHero, AdminTableShell } from "@/components/admin/admin-design-system";
import { ComboBox, ConfidenceBadge, CopyBtn } from "@/components/sales/normalizer-controls";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { CrmCard, CrmCardsOnPhone, CrmFacts } from "@/components/phoenix-crm/ui";
import { cn } from "@/lib/utils";
import {
  phxFieldClassName,
  phxSelectClassName,
} from "@/components/ui/form-tokens";

type IconType = typeof Sparkles;

export type WeeklyNormalizerDistributor = { code: string; name: string; separateSalesStockFiles: boolean };
export type WeeklyNormalizerReferences = {
  products: { code: string; name: string; line: string; priced: boolean }[];
  regions: { regionCode: string; regionName: string }[];
  areas: { areaCode: string; areaName: string; regionCode: string }[];
};

type UnknownProduct = { key: string; itemCode: string; itemName: string; aliasKind: "code" | "name"; alias: string; rows: number; netQty: number; stockQty: number };
type UnknownBranch = { key: string; rawBranch: string; branchName: string; sourceFileType: "any" | "sales" | "stock"; branchColumnIndex: number | null; branchColumnHeader: string; rows: number; netQty: number; stockQty: number };
type BlockedIssue = { field: string; message: string; value: string | null; rows: number };
type ExcludedItem = { itemCode: string; itemName: string; rows: number; netQty: number; stockQty: number };
type ExcludedBranch = { rawBranch: string; branchName: string; branchColumnIndex: number | null; rows: number; netQty: number; stockQty: number };
type CodedRow = {
  itemCode: string; productCode: string; productName: string; officialLine: string;
  branchCode: string; branchName: string; regionCode: string; regionName: string;
  areaCode: string | null; netQty: number; stockQty: number; salesValue: number;
};
type Template = {
  source: "code" | "override"; name: string; matching: "header-name" | "position"; splitFiles: boolean;
  sheets: { role: string; sheetName: string; headerRow: number; fields: number; matrix: boolean }[];
};
type Preview = {
  distributorCode: string; distributorName: string; fileName: string; sheetName: string;
  template: Template | null;
  weekStart: string | null; status: "blocked" | "validated"; blockingReasons: string[];
  summary: { totalRows: number; productResolved: number; regionResolved: number; fullyCoded: number; excludedItems: number; excludedBranches: number };
  sampleCoded: CodedRow[];
  unknownProducts: UnknownProduct[];
  unknownBranches: UnknownBranch[];
  blockedIssues: BlockedIssue[];
  excludedItems: ExcludedItem[];
  excludedBranches: ExcludedBranch[];
};

/** Region option meaning "this depot's rows never count" — mirrors the product list's IGNORE. */
const BRANCH_EXCLUDE_CODE = "__EXCLUDE__";
const IGNORE_PRODUCT_CODE = "IGNORE";

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "—");
const num = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });

function requestErrorMessage(error: unknown, fallback: string) {
  if (error instanceof TypeError && error.message === "Failed to fetch") {
    return "Could not reach the server. Please check the connection and try again.";
  }
  return error instanceof Error ? error.message : fallback;
}

async function readJson<T>(res: Response): Promise<T | null> {
  return (await res.json().catch(() => null)) as T | null;
}

/**
 * Weekly Normalizer — the weekly twin of the monthly Source Normalizer, deliberately the same shape:
 * drop the raw distributor file, see how much of it auto-codes, map the handful of values the
 * dictionary has never seen, watch coverage climb. Nothing here writes a sales row; the only writes
 * are the mappings themselves, into the same two dictionaries every weekly upload reads. When the
 * file reaches 100% the operator goes to Weekly Upload and it now passes validation first time.
 */
export function WeeklyNormalizerWorkspace({
  aiEnabled,
  distributors,
  references,
}: {
  aiEnabled: boolean;
  distributors: WeeklyNormalizerDistributor[];
  references: WeeklyNormalizerReferences;
}) {
  const [distributorCode, setDistributorCode] = useState(distributors[0]?.code ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [stockFile, setStockFile] = useState<File | null>(null);
  const [periodDate, setPeriodDate] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [productPicks, setProductPicks] = useState<Record<string, string>>({});
  const [regionPicks, setRegionPicks] = useState<Record<string, string>>({});
  const [areaPicks, setAreaPicks] = useState<Record<string, string>>({});
  const [aiConfidence, setAiConfidence] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<"coded" | "map">("map");
  const filledListRef = useRef<HTMLInputElement>(null);

  const distributor = distributors.find((d) => d.code === distributorCode);
  const needsTwoFiles = Boolean(distributor?.separateSalesStockFiles);
  const canAnalyze = Boolean(file) && (!needsTwoFiles || Boolean(stockFile));

  function resetPreview() {
    setPreview(null);
    setProductPicks({});
    setRegionPicks({});
    setAreaPicks({});
    setAiConfidence({});
  }

  function fd() {
    const form = new FormData();
    form.set("distributorCode", distributorCode);
    if (needsTwoFiles) {
      if (file) form.set("salesFile", file);
      if (stockFile) form.set("stockFile", stockFile);
    } else if (file) {
      form.set("file", file);
    }
    if (periodDate) form.set("periodDate", periodDate);
    return form;
  }

  // keepError exists for the re-analyze that follows a PARTIAL save: the per-item rejection reasons
  // (alias already committed elsewhere, area outside its region) are the whole point of that message,
  // and clearing them a second later would leave the operator with no idea which picks were refused.
  async function analyze(keepNotice = false, options: { quietFailure?: boolean; keepError?: boolean } = {}): Promise<Preview | null> {
    if (!canAnalyze) {
      if (!options.quietFailure) setError(needsTwoFiles ? "Overseas needs both the sales and the stock matrix file." : "Choose a raw weekly file first.");
      return null;
    }
    setBusy("analyze"); if (!options.keepError) setError(null); if (!keepNotice) setNotice(null);
    try {
      const res = await fetch("/api/sales/weekly/normalizer/preview", { body: fd(), method: "POST" });
      const json = await readJson<{ data?: Preview; error?: string; success?: boolean }>(res);
      if (json?.success && json.data) {
        setPreview(json.data);
        setProductPicks({});
        setRegionPicks({});
        setAreaPicks({});
        setAiConfidence({});
        setTab(json.data.unknownProducts.length + json.data.unknownBranches.length > 0 ? "map" : "coded");
        return json.data;
      }
      if (!options.quietFailure) setError(json?.error ?? `Failed to analyze. (${res.status})`);
      return null;
    } catch (e) {
      if (!options.quietFailure) setError(requestErrorMessage(e, "Failed to analyze."));
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function run(name: string, fn: () => Promise<void>) {
    setBusy(name); setError(null);
    try { await fn(); } catch (e) { setError(requestErrorMessage(e, "Failed.")); } finally { setBusy(null); }
  }

  async function downloadTemplate() {
    const res = await fetch("/api/sales/weekly/normalizer/mappings/template", { body: fd(), method: "POST" });
    if (!res.ok) {
      const json = await readJson<{ error?: string }>(res);
      throw new Error(json?.error ?? "Could not build the list.");
    }
    const blob = await res.blob();
    const match = /filename="(.+?)"/.exec(res.headers.get("Content-Disposition") ?? "");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = match?.[1] ?? `phoenix-weekly-unmapped-${distributorCode}.xlsx`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
  }

  async function learnFromFilledList(filled: File) {
    setBusy("learn"); setError(null); setNotice(null);
    try {
      const form = new FormData();
      form.set("distributorCode", distributorCode);
      form.set("file", filled);
      const res = await fetch("/api/sales/weekly/normalizer/mappings/learn", { body: form, method: "POST" });
      const json = await readJson<{ data?: { savedProducts: number; savedBranches: number; scannedRows: number; failed: { kind: string; label: string; reason: string }[] }; error?: string; success?: boolean }>(res);
      if (!res.ok || !json?.success || !json.data) { setError(json?.error ?? `Learn failed. (${res.status})`); return; }
      const d = json.data;
      const failedNote = d.failed.length ? ` ${d.failed.length} could not be saved — ${d.failed.slice(0, 3).map((f) => `${f.label}: ${f.reason}`).join("; ")}` : "";
      setNotice(`Read ${d.scannedRows.toLocaleString()} row(s) — saved ${d.savedProducts} product and ${d.savedBranches} branch mapping(s).${failedNote} Re-analyzing…`);
      await analyze(true, { quietFailure: true });
    } catch (e) {
      setError(requestErrorMessage(e, "Learn failed."));
    } finally {
      setBusy(null);
      if (filledListRef.current) filledListRef.current.value = "";
    }
  }

  async function aiSuggestAll() {
    if (!preview) return;
    setBusy("ai"); setError(null); setNotice(null);
    try {
      let filled = 0;
      let filledAreas = 0;
      let failed = false;
      const jobs = [
        { kind: "product" as const, unknowns: preview.unknownProducts.map((u) => ({ raw: u.key, rawName: u.itemName || u.itemCode })) },
        { kind: "branch" as const, unknowns: preview.unknownBranches.map((b) => ({ raw: b.key, rawName: b.branchName || b.rawBranch || b.branchColumnHeader })) },
      ];
      for (const job of jobs) {
        if (job.unknowns.length === 0) continue;
        const res = await fetch("/api/sales/weekly/normalizer/mappings/ai-suggest", {
          // distributorCode puts THIS distributor's already-confirmed mappings at the front of the
          // examples the model is shown — its own naming habits are the strongest signal there is.
          body: JSON.stringify({ distributorCode, kind: job.kind, unknowns: job.unknowns }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        // Guard the parse: a timed-out function returns a non-JSON platform page, so a bare
        // res.json() would throw and hide the real status.
        const json = await readJson<{
          data?: {
            suggestions?: { raw: string; code: string; confidence?: number }[];
            areaSuggestions?: { raw: string; code: string; confidence?: number }[];
          };
          error?: string;
          success?: boolean;
        }>(res);
        if (!res.ok || !json?.success || !json.data) {
          failed = true;
          setError(json?.error ?? `AI suggest failed for ${job.kind}${res.status === 504 ? " — the analyzer timed out; try fewer rows at once" : ` (${res.status})`}.`);
          continue;
        }
        const suggestions = json.data.suggestions ?? [];
        if (suggestions.length === 0) continue;
        filled += suggestions.length;
        const confidence: Record<string, number> = {};
        for (const s of suggestions) if (typeof s.confidence === "number") confidence[s.raw] = s.confidence;
        if (job.kind === "product") setProductPicks((p) => { const n = { ...p }; suggestions.forEach((s) => { n[s.raw] = s.code; }); return n; });
        else {
          // The server derives each branch's region FROM the area it suggested, so the pair is always
          // valid. A branch it could not place to an area gets a region-only suggestion and its area
          // is cleared — an area must sit inside its branch's region, and the save rejects a
          // mismatched pair rather than silently fixing it.
          const areaSuggestions = json.data.areaSuggestions ?? [];
          const areaByRaw = new Map(areaSuggestions.map((s) => [s.raw, s.code]));
          filledAreas += areaSuggestions.length;
          setRegionPicks((p) => { const n = { ...p }; suggestions.forEach((s) => { n[s.raw] = s.code; }); return n; });
          setAreaPicks((p) => { const n = { ...p }; suggestions.forEach((s) => { n[s.raw] = areaByRaw.get(s.raw) ?? ""; }); return n; });
        }
        if (Object.keys(confidence).length) setAiConfidence((prev) => ({ ...prev, ...confidence }));
      }
      if (filled) {
        // Areas are called out separately because they are the scarce half: a branch with a region
        // but no area still cannot be cut by territory, and cannot resolve a line whose organogram
        // splits that region across two managers.
        const areaNote = filledAreas > 0 ? `, ${filledAreas} of them down to the area` : "";
        setNotice(`AI pre-filled ${filled} suggestion(s)${areaNote} — review the dropdowns, fix any wrong ones, then Save.`);
      }
      else if (!failed) setNotice("AI found no confident matches — map them by hand.");
    } catch (e) {
      setError(requestErrorMessage(e, "AI suggest failed."));
    } finally {
      setBusy(null);
    }
  }

  async function saveMappings() {
    if (!preview) return;
    const products = preview.unknownProducts
      .filter((u) => (productPicks[u.key] ?? "").trim())
      .map((u) => ({ alias: u.alias, aliasKind: u.aliasKind, productCode: productPicks[u.key] }));
    const branches = preview.unknownBranches
      .filter((b) => (regionPicks[b.key] ?? "").trim())
      .map((b) => ({
        rawBranch: b.rawBranch,
        branchName: b.branchName || b.branchColumnHeader || null,
        sourceFileType: b.sourceFileType,
        branchColumnIndex: b.branchColumnIndex,
        regionCode: regionPicks[b.key],
        areaCode: (areaPicks[b.key] ?? "").trim() || null,
      }));
    if (products.length === 0 && branches.length === 0) { setError("Pick at least one Phoenix code to save."); return; }

    setBusy("save"); setError(null); setNotice(null);
    try {
      const res = await fetch("/api/sales/weekly/normalizer/mappings/save", {
        body: JSON.stringify({ branches, distributorCode, products }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const json = await readJson<{ data?: { savedProducts: number; savedBranches: number; failed: { kind: string; label: string; reason: string }[] }; error?: string; success?: boolean }>(res);
      if (!res.ok || !json?.success || !json.data) { setError(json?.error ?? `Save failed. (${res.status})`); return; }
      const saved = json.data.savedProducts + json.data.savedBranches;
      const failures = json.data.failed;
      if (failures.length > 0) {
        setError(`${failures.length} mapping(s) could not be saved — ${failures.slice(0, 3).map((f) => `${f.label}: ${f.reason}`).join("; ")}`);
      }
      setNotice(`Saved ${saved} mapping(s). Refreshing coverage…`);
      const next = await analyze(true, { quietFailure: true, keepError: failures.length > 0 });
      if (next) {
        const remaining = next.unknownProducts.length + next.unknownBranches.length;
        setNotice(remaining === 0
          ? `Saved ${saved} mapping(s). Everything is mapped now — this file will pass the weekly upload.`
          : `Saved ${saved} mapping(s). ${remaining} item(s) still need mapping.`);
      } else {
        setNotice(`Saved ${saved} mapping(s). Automatic coverage refresh could not complete — click Analyze to refresh it.`);
      }
    } catch (e) {
      setError(requestErrorMessage(e, "Save failed."));
    } finally {
      setBusy(null);
    }
  }

  const s = preview?.summary;
  const distinctCount = (preview?.unknownProducts.length ?? 0) + (preview?.unknownBranches.length ?? 0);
  const filledCount =
    (preview?.unknownProducts.filter((u) => (productPicks[u.key] ?? "").trim()).length ?? 0) +
    (preview?.unknownBranches.filter((b) => (regionPicks[b.key] ?? "").trim()).length ?? 0);

  const productOptions = [
    { label: "🚫 Ignore — we don't sell this", value: IGNORE_PRODUCT_CODE },
    ...references.products
      .filter((p) => p.code.toUpperCase() !== IGNORE_PRODUCT_CODE)
      .map((p) => ({ label: `${p.name} (${p.code})${p.priced ? "" : " · no price"}`, value: p.code })),
  ];
  const regionOptions = [
    { label: "🚫 Exclude — this branch never counts", value: BRANCH_EXCLUDE_CODE },
    ...references.regions.map((r) => ({ label: `${r.regionName} (${r.regionCode})`, value: r.regionCode })),
  ];
  // An area must sit inside the region picked beside it — the server enforces this, so the picker
  // never offers a combination it would reject.
  const areaOptionsFor = (regionCode: string) =>
    references.areas
      .filter((a) => a.regionCode === regionCode)
      .map((a) => ({ label: `${a.areaName} (${a.areaCode})`, value: a.areaCode }));

  const selectClass  = phxSelectClassName;
  const fileClass = cn(phxFieldClassName, "px-3 py-2 text-xs");

  return (
    <div className="min-h-[calc(100vh-7rem)] space-y-7">
      <AdminPageHero
        badges={(
          <>
            <AdminInsightChip>Codes Product / Branch → Region / Area</AdminInsightChip>
            <AdminInsightChip tone="orange">Drop the raw weekly file as-is</AdminInsightChip>
            <Link className="inline-flex items-center gap-1 text-xs font-semibold text-orange-400 transition hover:text-orange-300 hover:underline" href="/sales/weekly/mapping"><Database className="h-3.5 w-3.5" /> Weekly Mapping</Link>
            <Link className="inline-flex items-center gap-1 text-xs font-semibold text-white/70 transition hover:text-white hover:underline" href="/sales/weekly"><Upload className="h-3.5 w-3.5" /> Weekly Upload</Link>
          </>
        )}
        description="Drop a raw weekly distributor sheet untouched. The normalizer translates the distributor's own item codes into Phoenix products and its own branches into Region + Area, then shows exactly what did not resolve. Map each unknown once (in bulk) and it is remembered for every future weekly upload. Nothing is imported here — this only teaches the dictionary."
        eyebrow="Weekly Normalizer" icon={<Sparkles className="h-4 w-4" />} title="Weekly Normalizer"
      />

      <AdminTableShell
        action={(
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <label className="flex flex-col gap-1 sm:w-44">
              <span className="text-phx-2xs font-bold uppercase tracking-[0.16em] text-slate-500">Distributor</span>
              <SearchableSelect className={selectClass} disabled={busy !== null} onChange={(e) => { setDistributorCode(e.target.value); setStockFile(null); resetPreview(); }} value={distributorCode}>
                {distributors.map((d) => <option key={d.code} value={d.code}>{d.name} / {d.code}</option>)}
              </SearchableSelect>
            </label>
            <label className="flex flex-col gap-1 sm:w-56">
              <span className="text-phx-2xs font-bold uppercase tracking-[0.16em] text-slate-500">{needsTwoFiles ? "Sales matrix" : "Raw file"}</span>
              <input accept=".xlsx,.xls" className={fileClass} disabled={busy !== null} onChange={(e) => { setFile(e.target.files?.[0] ?? null); resetPreview(); }} type="file" />
            </label>
            {needsTwoFiles ? (
              <label className="flex flex-col gap-1 sm:w-56">
                <span className="text-phx-2xs font-bold uppercase tracking-[0.16em] text-slate-500">Stock matrix</span>
                <input accept=".xlsx,.xls" className={fileClass} disabled={busy !== null} onChange={(e) => { setStockFile(e.target.files?.[0] ?? null); resetPreview(); }} type="file" />
              </label>
            ) : null}
            <label className="flex flex-col gap-1 sm:w-40">
              <span className="text-phx-2xs font-bold uppercase tracking-[0.16em] text-slate-500">Week date (optional)</span>
              <input className={fileClass} disabled={busy !== null} onChange={(e) => { setPeriodDate(e.target.value); }} title="Only needed when the sheet carries no date, or several" type="date" value={periodDate} />
            </label>
            <Button className="gap-2" disabled={busy !== null || !canAnalyze} onClick={() => void analyze()}>
              {busy === "analyze" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Analyze
            </Button>
          </div>
        )}
        description="Anything the weekly dictionary has not learned yet is grouped under Needs mapping — map each distinct code once and it fixes every row that uses it."
        title="Clean & Convert"
      >
        <div className="space-y-5 p-4 md:p-5">
          {error ? <AdminCallout tone="danger"><AlertTriangle className="mt-0.5 h-4 w-4" /><p>{error}</p></AdminCallout> : null}
          {notice ? <AdminCallout tone="success"><Sparkles className="mt-0.5 h-4 w-4" /><p>{notice}</p></AdminCallout> : null}

          {!preview ? (
            <AdminCallout tone="neutral">
              <Upload className="mt-0.5 h-4 w-4" />
              <p>Pick the distributor, choose its raw weekly export{needsTwoFiles ? " (Overseas ships a sales matrix and a stock matrix — both are needed)" : ""}, and click Analyze. Nothing is uploaded and no sales row is written — only the mappings you choose to save.</p>
            </AdminCallout>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {([
                  { label: "Rows", value: s!.totalRows.toLocaleString(), icon: Layers },
                  { label: "Product coded", value: pct(s!.productResolved, s!.totalRows), ratio: s!.totalRows ? s!.productResolved / s!.totalRows : 0, icon: Package },
                  { label: "Branch coded", value: pct(s!.regionResolved, s!.totalRows), ratio: s!.totalRows ? s!.regionResolved / s!.totalRows : 0, icon: MapPin },
                  { label: "Fully auto-coded", value: pct(s!.fullyCoded, s!.totalRows), ratio: s!.totalRows ? s!.fullyCoded / s!.totalRows : 0, icon: CheckCircle2, strong: true },
                ] as { label: string; value: string; icon: IconType; ratio?: number; strong?: boolean }[]).map((k) => {
                  const Icon = k.icon;
                  return (
                    <div className={cn("group relative overflow-hidden border border-slate-200 bg-gradient-to-br from-white to-slate-50/60 p-3.5 shadow-sm transition duration-200 hover:-translate-y-0.5 hover:shadow-md", k.strong && "border-orange-200 from-orange-50 to-white")} key={k.label}>
                      <span aria-hidden="true" className={cn("absolute inset-x-0 top-0 h-1 bg-gradient-to-r", k.strong ? "from-orange-500 via-orange-400 to-amber-300" : "from-slate-400 via-slate-300 to-slate-200")} />
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-phx-2xs font-bold uppercase tracking-[0.16em] text-slate-500">{k.label}</p>
                          <p className={cn("mt-1 text-xl font-black tabular-nums", k.strong ? "text-orange-700" : "text-slate-900")}>{k.value}</p>
                        </div>
                        <Icon aria-hidden="true" className={cn("h-4 w-4 shrink-0 transition-colors", k.strong ? "text-orange-400" : "text-slate-300 group-hover:text-orange-400")} />
                      </div>
                      {k.ratio != null ? (
                        <div className="mt-2.5 h-1 w-full overflow-hidden bg-slate-100">
                          <div className={cn("h-full bg-gradient-to-r transition-all duration-500", k.strong ? "from-orange-500 to-amber-400" : "from-slate-400 to-slate-300")} style={{ width: `${Math.min(100, Math.max(0, k.ratio * 100)).toFixed(1)}%` }} />
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-phx-2xs font-bold uppercase tracking-[0.16em] text-slate-500">Detected week</span>
                  <span className="inline-flex items-center gap-1.5 border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-bold text-slate-900"><CalendarDays className="h-3.5 w-3.5 text-orange-500" />{preview.weekStart ?? "—"}</span>
                  <span className="inline-flex items-center gap-1.5 border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-semibold text-slate-600">{preview.sheetName || preview.fileName}</span>
                  {/* Which column layout the file was read with — the same one the real upload uses. */}
                  {preview.template ? (
                    <span
                      className={cn(
                        "inline-flex items-center gap-1.5 border px-2.5 py-1 text-xs font-semibold",
                        preview.template.source === "override" ? "border-violet-200 bg-violet-50 text-violet-700" : "border-slate-200 bg-slate-50 text-slate-600",
                      )}
                      title={preview.template.sheets.map((sheet) => `${sheet.role}: ${sheet.sheetName || "(first sheet)"} · header row ${sheet.headerRow} · ${sheet.fields} pinned column${sheet.fields === 1 ? "" : "s"}${sheet.matrix ? " + matrix block" : ""}`).join("\n")}
                    >
                      <FileSpreadsheet className="h-3.5 w-3.5" />
                      {preview.template.matching === "header-name"
                        ? "Template: matched by header name"
                        : `${preview.template.source === "override" ? "Saved template" : "Built-in template"} · ${preview.template.sheets.reduce((total, sheet) => total + sheet.fields, 0)} pinned columns`}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800" title="No pinned column layout for this distributor — the adapter reads the sheet by its own rules.">
                      <FileSpreadsheet className="h-3.5 w-3.5" />No pinned template
                    </span>
                  )}
                </div>
                <div className="ml-auto flex flex-col items-end gap-1">
                  {distinctCount === 0 && preview.status === "validated" ? (
                    <Link className="inline-flex h-10 items-center gap-2 border border-orange-600 bg-orange-600 px-4 text-sm font-bold text-white transition hover:bg-orange-700" href="/sales/weekly">
                      <Upload className="h-4 w-4" /> Upload it on Weekly Sales <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                  ) : null}
                  <span className="text-phx-xs text-slate-400">Mapping here never imports. When the file is fully coded, upload it on Weekly Sales — it will pass validation first time.</span>
                </div>
              </div>

              {preview.blockingReasons.length > 0 ? (
                <AdminCallout tone="warning">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <div>
                    <p className="font-semibold">The weekly upload would block this file today:</p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4">
                      {preview.blockingReasons.map((reason) => <li key={reason}>{reason}</li>)}
                    </ul>
                  </div>
                </AdminCallout>
              ) : null}

              <div className="flex gap-1 border-b border-slate-200">
                {([
                  ["coded", `Coded preview (${preview.sampleCoded.length})`],
                  ["map", `Needs mapping — ${distinctCount} codes (${Math.max(0, s!.totalRows - s!.fullyCoded).toLocaleString()} rows)`],
                ] as const).map(([key, label]) => (
                  <button className={cn("-mb-px border-b-2 px-3.5 py-2 text-sm font-semibold transition-colors", tab === key ? "border-orange-500 text-slate-900" : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-900")} key={key} onClick={() => setTab(key)} type="button">{label}</button>
                ))}
              </div>

              {tab === "coded" ? (
                <div className="border border-phx-line">
                  {/* Ten columns did not fit, so three pairs are MERGED rather than shrunk:
                      Product ID rides under Product, and Branch/Region/Area become one
                      Territory cell. table-fixed + the colgroup below make the width
                      structural, so no data can push this sideways. */}
                  <CrmCardsOnPhone>
                    {preview.sampleCoded.map((r, i) => (
                      <CrmCard key={`${r.itemCode}|${r.branchCode}|${i}`} meta={r.officialLine} title={r.productName}>
                        <CrmFacts
                          facts={[
                            { label: "Code", value: r.itemCode || "—" },
                            { label: "Territory", value: `${r.branchName || r.branchCode} · ${r.regionName || r.regionCode || "—"} · ${r.areaCode ?? "—"}` },
                            { label: "Net units", value: num(r.netQty) },
                            { label: "Stock", value: num(r.stockQty) },
                            { label: "Value", value: num(r.salesValue) },
                          ]}
                        />
                      </CrmCard>
                    ))}
                  </CrmCardsOnPhone>
                  <table className="hidden w-full table-fixed text-sm md:table">
                    <colgroup>
                      <col className="w-[10%]" />
                      <col className="w-[22%]" />
                      <col className="w-[10%]" />
                      <col className="w-[22%]" />
                      <col className="w-[12%]" />
                      <col className="w-[12%]" />
                      <col className="w-[12%]" />
                    </colgroup>
                    <thead className="bg-[#0B0B0B] text-phx-paper-2"><tr>{["Code", "Product", "Line", "Territory", "Net units", "Stock", "Value"].map((h) => <th className="px-3 py-2 text-left" key={h}>{h}</th>)}</tr></thead>
                    <tbody>
                      {preview.sampleCoded.map((r, i) => (
                        <tr className={cn("transition-colors hover:bg-orange-50/50", i % 2 && "bg-slate-50/60")} key={`${r.itemCode}|${r.branchCode}|${i}`}>
                          <td className="break-words px-3 py-1.5 font-mono text-phx-md text-slate-600">{r.itemCode}</td>
                          <td className="break-words px-3 py-1.5 text-slate-600">
                            <span className="block">{r.productName}</span>
                          </td>
                          <td className="break-words px-3 py-1.5 text-slate-600">{r.officialLine}</td>
                          <td className="break-words px-3 py-1.5 text-slate-600">
                            <span className="block text-slate-900">{r.branchName || r.branchCode}</span>
                            <span className="block text-phx-md text-slate-500">{r.regionName || r.regionCode || "—"} · {r.areaCode ?? "—"}</span>
                          </td>
                          <td className="px-3 py-1.5 text-right font-semibold tabular-nums text-slate-900">{num(r.netQty)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-slate-600">{num(r.stockQty)}</td>
                          <td className="px-3 py-1.5 text-right font-semibold tabular-nums text-slate-900">{num(r.salesValue)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center gap-2 border border-slate-200 bg-slate-50 p-4 shadow-sm">
                    <p className="text-xs text-slate-600">Pick the right Phoenix code for each unknown, then <b>Save</b>. Or do it in Excel: download the list, fill the dropdowns, upload it back. AI suggest is shown every mapping already confirmed for this distributor, so it repeats your own answers instead of guessing afresh.</p>
                    <div className="ml-auto flex flex-wrap gap-2">
                      <button className="inline-flex h-9 items-center gap-2 border border-slate-300 bg-white px-3 text-xs font-bold text-slate-700 transition hover:bg-slate-100 disabled:opacity-50" disabled={busy !== null} onClick={() => void run("template", downloadTemplate)} type="button">
                        {busy === "template" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Download list (Excel)
                      </button>
                      <button className="inline-flex h-9 items-center gap-2 border border-slate-300 bg-white px-3 text-xs font-bold text-slate-700 transition hover:bg-slate-100 disabled:opacity-50" disabled={busy !== null} onClick={() => filledListRef.current?.click()} type="button">
                        {busy === "learn" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Upload filled list
                      </button>
                      <input accept=".xlsx,.xls" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void learnFromFilledList(f); }} ref={filledListRef} type="file" />
                      {aiEnabled && distinctCount > 0 ? (
                        <button className="inline-flex h-9 items-center gap-2 border border-violet-600 bg-violet-600 px-3 text-xs font-bold text-white transition hover:bg-violet-700 disabled:opacity-50" disabled={busy !== null} onClick={() => void aiSuggestAll()} title="Pre-fill the dropdowns. The AI is shown the mappings already confirmed for this distributor, so it reuses your own answers rather than guessing afresh." type="button">
                          {busy === "ai" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} AI suggest
                        </button>
                      ) : null}
                      <button className="inline-flex h-9 items-center gap-2 border border-orange-600 bg-orange-600 px-3 text-xs font-bold text-white transition hover:bg-orange-700 disabled:opacity-50" disabled={busy !== null || filledCount === 0} onClick={() => void saveMappings()} type="button">
                        {busy === "save" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save {filledCount || ""} mapping{filledCount === 1 ? "" : "s"}
                      </button>
                      <Link className="inline-flex h-9 items-center gap-1.5 border border-slate-900 bg-slate-900 px-3 text-xs font-bold text-white transition hover:bg-slate-800" href="/sales/weekly/mapping">
                        <Database className="h-4 w-4" /> Weekly Mapping <ArrowRight className="h-3.5 w-3.5" />
                      </Link>
                    </div>
                  </div>

                  {preview.unknownProducts.length > 0 ? (
                    <div className="border border-phx-line">
                      <p className="flex items-center gap-2 bg-slate-900 px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-white"><span aria-hidden="true" className="h-3.5 w-1 shrink-0 bg-orange-500" />Unknown products ({preview.unknownProducts.length})</p>
                      <CrmCardsOnPhone>
                        {preview.unknownProducts.map((u) => (
                          <CrmCard
                            key={u.key}
                            status={aiConfidence[u.key] != null ? <ConfidenceBadge pct={aiConfidence[u.key]} /> : undefined}
                            title={u.itemName || u.itemCode || "—"}
                          >
                            <CrmFacts
                              facts={[
                                { label: "Raw code", value: u.itemCode || "—" },
                                { label: "Rows", value: u.rows.toLocaleString() },
                                { label: "Net units", value: num(u.netQty) },
                              ]}
                            />
                            <div className="mt-2 min-w-0">
                              <ComboBox onChange={(v) => setProductPicks((p) => ({ ...p, [u.key]: v }))} options={productOptions} placeholder="Type product or code…" value={productPicks[u.key] ?? ""} />
                            </div>
                          </CrmCard>
                        ))}
                      </CrmCardsOnPhone>
                      <table className="hidden w-full table-fixed text-sm md:table">
                        <colgroup>
                          <col className="w-[16%]" />
                          <col className="w-[24%]" />
                          <col className="w-[9%]" />
                          <col className="w-[11%]" />
                          <col className="w-[30%]" />
                          <col className="w-[10%]" />
                        </colgroup>
                        <thead className="bg-slate-100"><tr>{["Raw code", "Raw name", "Rows", "Net units", "Phoenix product", "Confidence"].map((h) => <th className="px-3 py-2 text-left font-semibold text-slate-600" key={h}>{h}</th>)}</tr></thead>
                        <tbody>
                          {preview.unknownProducts.map((u) => (
                            <tr className="border-t border-slate-100 transition-colors hover:bg-orange-50/40" key={u.key}>
                              <td className="px-3 py-1.5 font-semibold text-slate-900"><span className="flex items-start gap-1"><span className="min-w-0 break-words">{u.itemCode || "—"}</span><CopyBtn text={u.itemCode} /></span></td>
                              <td className="px-3 py-1.5 text-slate-600"><span className="flex items-start gap-1"><span className="min-w-0 break-words">{u.itemName || "—"}</span><CopyBtn text={u.itemName} /></span></td>
                              <td className="px-3 py-1.5 text-right font-semibold tabular-nums text-slate-700">{u.rows.toLocaleString()}</td>
                              <td className="px-3 py-1.5 text-right tabular-nums text-slate-700">{num(u.netQty)}</td>
                              <td className="min-w-0 px-3 py-1.5">
                                <ComboBox onChange={(v) => setProductPicks((p) => ({ ...p, [u.key]: v }))} options={productOptions} placeholder="Type product or code…" value={productPicks[u.key] ?? ""} />
                              </td>
                              <td className="px-3 py-1.5 text-center">
                                {aiConfidence[u.key] != null ? <ConfidenceBadge pct={aiConfidence[u.key]} /> : <span className="text-slate-300">—</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}

                  {preview.unknownBranches.length > 0 ? (
                    <div className="border border-phx-line">
                      <p className="flex items-center gap-2 bg-slate-900 px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-white"><span aria-hidden="true" className="h-3.5 w-1 shrink-0 bg-orange-500" />Unknown branches ({preview.unknownBranches.length}) — a branch is a distributor depot, so the Area is optional: leave it blank to keep the branch region-only</p>
                      {/* Nine columns did not fit. Side+Col merge into Source, and Rows+Net
                          units into Volume, rather than shrinking the type. */}
                      <CrmCardsOnPhone>
                        {preview.unknownBranches.map((b) => {
                          const region = regionPicks[b.key] ?? "";
                          const areaOptions = areaOptionsFor(region);
                          return (
                            <CrmCard
                              key={b.key}
                              meta={b.rawBranch || "—"}
                              status={aiConfidence[b.key] != null ? <ConfidenceBadge pct={aiConfidence[b.key]} /> : undefined}
                              title={b.branchName || b.branchColumnHeader || b.rawBranch || "—"}
                            >
                              <CrmFacts
                                facts={[
                                  { label: "Source", value: `${b.sourceFileType} · col ${b.branchColumnIndex ?? "—"}` },
                                  { label: "Volume", value: `${b.rows.toLocaleString()} rows · ${num(b.netQty)} units` },
                                ]}
                              />
                              <div className="mt-2 min-w-0 space-y-2">
                                <ComboBox onChange={(v) => { setRegionPicks((p) => ({ ...p, [b.key]: v })); setAreaPicks((p) => ({ ...p, [b.key]: "" })); }} options={regionOptions} placeholder="Type region…" value={region} />
                                <ComboBox
                                  disabled={!region || region === BRANCH_EXCLUDE_CODE}
                                  onChange={(v) => setAreaPicks((p) => ({ ...p, [b.key]: v }))}
                                  options={areaOptions}
                                  placeholder={region === BRANCH_EXCLUDE_CODE ? "not applicable" : region ? "region-only — or pick an area" : "pick a region first"}
                                  value={areaPicks[b.key] ?? ""}
                                />
                              </div>
                            </CrmCard>
                          );
                        })}
                      </CrmCardsOnPhone>
                      <table className="hidden w-full table-fixed text-sm md:table">
                        <colgroup>
                          <col className="w-[13%]" />
                          <col className="w-[17%]" />
                          <col className="w-[9%]" />
                          <col className="w-[11%]" />
                          <col className="w-[20%]" />
                          <col className="w-[20%]" />
                          <col className="w-[10%]" />
                        </colgroup>
                        <thead className="bg-slate-100"><tr>{["Branch", "Name", "Source", "Volume", "Phoenix region", "Area (optional)", "Confidence"].map((h) => <th className="px-3 py-2 text-left font-semibold text-slate-600" key={h}>{h}</th>)}</tr></thead>
                        <tbody>
                          {preview.unknownBranches.map((b) => {
                            const region = regionPicks[b.key] ?? "";
                            const areaOptions = areaOptionsFor(region);
                            return (
                              <tr className="border-t border-slate-100 transition-colors hover:bg-orange-50/40" key={b.key}>
                                <td className="px-3 py-1.5 font-semibold text-slate-900"><span className="flex items-start gap-1"><span className="min-w-0 break-words">{b.rawBranch || "—"}</span><CopyBtn text={b.rawBranch} /></span></td>
                                <td className="px-3 py-1.5 text-slate-600"><span className="flex items-start gap-1"><span className="min-w-0 break-words">{b.branchName || b.branchColumnHeader || "—"}</span><CopyBtn text={b.branchName || b.branchColumnHeader} /></span></td>
                                <td className="break-words px-3 py-1.5 text-xs text-slate-500">
                                  <span className="block">{b.sourceFileType}</span>
                                  <span className="block tabular-nums">col {b.branchColumnIndex ?? "—"}</span>
                                </td>
                                <td className="px-3 py-1.5 text-right text-slate-700">
                                  <span className="block font-semibold tabular-nums">{b.rows.toLocaleString()}</span>
                                  <span className="block text-xs tabular-nums text-slate-500">{num(b.netQty)} units</span>
                                </td>
                                <td className="min-w-0 px-3 py-1.5">
                                  <ComboBox onChange={(v) => { setRegionPicks((p) => ({ ...p, [b.key]: v })); setAreaPicks((p) => ({ ...p, [b.key]: "" })); }} options={regionOptions} placeholder="Type region…" value={region} />
                                </td>
                                <td className="min-w-0 px-3 py-1.5">
                                  <ComboBox
                                    disabled={!region || region === BRANCH_EXCLUDE_CODE}
                                    onChange={(v) => setAreaPicks((p) => ({ ...p, [b.key]: v }))}
                                    options={areaOptions}
                                    placeholder={region === BRANCH_EXCLUDE_CODE ? "not applicable" : region ? "region-only — or pick an area" : "pick a region first"}
                                    value={areaPicks[b.key] ?? ""}
                                  />
                                </td>
                                <td className="px-3 py-1.5 text-center">
                                  {aiConfidence[b.key] != null ? <ConfidenceBadge pct={aiConfidence[b.key]} /> : <span className="text-slate-300">—</span>}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : null}

                  {preview.blockedIssues.length > 0 ? (
                    <div className="border border-amber-200">
                      <p className="flex items-center gap-2 bg-amber-500 px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-white"><AlertTriangle className="h-3.5 w-3.5 shrink-0" />No mapping here can fix these ({preview.blockedIssues.length}) — they are master-data repairs</p>
                      <CrmCardsOnPhone>
                        {preview.blockedIssues.map((issue) => (
                          <CrmCard key={`${issue.field}|${issue.message}`} title={issue.field}>
                            <CrmFacts
                              facts={[
                                { label: "What is wrong", value: issue.message },
                                { label: "Value", value: issue.value ?? "—" },
                                { label: "Rows", value: issue.rows.toLocaleString() },
                              ]}
                            />
                          </CrmCard>
                        ))}
                      </CrmCardsOnPhone>
                      <table className="hidden w-full table-fixed text-sm md:table">
                        <colgroup>
                          <col className="w-[18%]" />
                          <col className="w-[46%]" />
                          <col className="w-[22%]" />
                          <col className="w-[14%]" />
                        </colgroup>
                        <thead className="bg-amber-50"><tr>{["Field", "What is wrong", "Value", "Rows"].map((h) => <th className="px-3 py-2 text-left font-semibold text-amber-900" key={h}>{h}</th>)}</tr></thead>
                        <tbody>
                          {preview.blockedIssues.map((issue) => (
                            <tr className="border-t border-amber-100" key={`${issue.field}|${issue.message}`}>
                              <td className="break-words px-3 py-1.5 font-semibold text-slate-900">{issue.field}</td>
                              <td className="break-words px-3 py-1.5 text-slate-600">{issue.message}</td>
                              <td className="break-words px-3 py-1.5 text-slate-600">{issue.value ?? "—"}</td>
                              <td className="px-3 py-1.5 text-right font-semibold tabular-nums text-slate-700">{issue.rows.toLocaleString()}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}

                  {preview.excludedItems.length > 0 ? (
                    <div className="border border-phx-line">
                      <p className="flex items-center gap-2 bg-slate-700 px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-white"><span aria-hidden="true" className="h-3.5 w-1 shrink-0 bg-slate-300" />Held out on purpose ({preview.excludedItems.length}) — mapped to IGNORE, counted here so nothing is dropped silently</p>
                      <CrmCardsOnPhone>
                        {preview.excludedItems.map((item) => (
                          <CrmCard key={`${item.itemCode}|${item.itemName}`} title={item.itemName || item.itemCode || "—"}>
                            <CrmFacts
                              facts={[
                                { label: "Item code", value: item.itemCode || "—" },
                                { label: "Rows", value: item.rows.toLocaleString() },
                                { label: "Net units", value: num(item.netQty) },
                                { label: "Stock", value: num(item.stockQty) },
                              ]}
                            />
                          </CrmCard>
                        ))}
                      </CrmCardsOnPhone>
                      <table className="hidden w-full table-fixed text-sm md:table">
                        <colgroup>
                          <col className="w-[20%]" />
                          <col className="w-[32%]" />
                          <col className="w-[16%]" />
                          <col className="w-[16%]" />
                          <col className="w-[16%]" />
                        </colgroup>
                        <thead className="bg-slate-100"><tr>{["Item code", "Item name", "Rows", "Net units", "Stock"].map((h) => <th className="px-3 py-2 text-left font-semibold text-slate-600" key={h}>{h}</th>)}</tr></thead>
                        <tbody>
                          {preview.excludedItems.map((item) => (
                            <tr className="border-t border-slate-100" key={`${item.itemCode}|${item.itemName}`}>
                              <td className="break-words px-3 py-1.5 font-mono text-phx-md text-slate-700">{item.itemCode || "—"}</td>
                              <td className="break-words px-3 py-1.5 text-slate-600">{item.itemName || "—"}</td>
                              <td className="px-3 py-1.5 text-right tabular-nums text-slate-700">{item.rows.toLocaleString()}</td>
                              <td className="px-3 py-1.5 text-right tabular-nums text-slate-700">{num(item.netQty)}</td>
                              <td className="px-3 py-1.5 text-right tabular-nums text-slate-700">{num(item.stockQty)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}

                  {preview.excludedBranches.length > 0 ? (
                    <div className="border border-phx-line">
                      <p className="flex items-center gap-2 bg-slate-700 px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-white"><span aria-hidden="true" className="h-3.5 w-1 shrink-0 bg-slate-300" />Branches held out on purpose ({preview.excludedBranches.length}) — mapped to Exclude, counted here so nothing is dropped silently</p>
                      <CrmCardsOnPhone>
                        {preview.excludedBranches.map((branch) => (
                          <CrmCard key={`${branch.rawBranch}|${branch.branchColumnIndex ?? ""}`} title={branch.branchName || branch.rawBranch || (branch.branchColumnIndex != null ? `Column ${branch.branchColumnIndex}` : "—")}>
                            <CrmFacts
                              facts={[
                                { label: "Branch", value: branch.rawBranch || (branch.branchColumnIndex != null ? `Column ${branch.branchColumnIndex}` : "—") },
                                { label: "Rows", value: branch.rows.toLocaleString() },
                                { label: "Net units", value: num(branch.netQty) },
                                { label: "Stock", value: num(branch.stockQty) },
                              ]}
                            />
                          </CrmCard>
                        ))}
                      </CrmCardsOnPhone>
                      <table className="hidden w-full table-fixed text-sm md:table">
                        <colgroup>
                          <col className="w-[20%]" />
                          <col className="w-[32%]" />
                          <col className="w-[16%]" />
                          <col className="w-[16%]" />
                          <col className="w-[16%]" />
                        </colgroup>
                        <thead className="bg-slate-100"><tr>{["Branch", "Branch name", "Rows", "Net units", "Stock"].map((h) => <th className="px-3 py-2 text-left font-semibold text-slate-600" key={h}>{h}</th>)}</tr></thead>
                        <tbody>
                          {preview.excludedBranches.map((branch) => (
                            <tr className="border-t border-slate-100" key={`${branch.rawBranch}|${branch.branchColumnIndex ?? ""}`}>
                              <td className="break-words px-3 py-1.5 font-mono text-phx-md text-slate-700">{branch.rawBranch || (branch.branchColumnIndex != null ? `Column ${branch.branchColumnIndex}` : "—")}</td>
                              <td className="break-words px-3 py-1.5 text-slate-600">{branch.branchName || "—"}</td>
                              <td className="px-3 py-1.5 text-right tabular-nums text-slate-700">{branch.rows.toLocaleString()}</td>
                              <td className="px-3 py-1.5 text-right tabular-nums text-slate-700">{num(branch.netQty)}</td>
                              <td className="px-3 py-1.5 text-right tabular-nums text-slate-700">{num(branch.stockQty)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}

                  {distinctCount === 0 ? <AdminCallout tone="success"><Sparkles className="mt-0.5 h-4 w-4" /><p>Everything coded — nothing to map. 🎉</p></AdminCallout> : null}
                </div>
              )}
            </>
          )}
        </div>
      </AdminTableShell>
    </div>
  );
}
