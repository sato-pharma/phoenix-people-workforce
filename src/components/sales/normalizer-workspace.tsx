"use client";

import { AlertTriangle, Check, ClipboardPaste, Copy, Download, Loader2, Save, Sparkles, Upload } from "lucide-react";
import { useRef, useState } from "react";

import { AdminCallout, AdminInsightChip, AdminPageHero, AdminTableShell } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type DistributorOption = { code: string; name: string };
type MappingReferences = { bricks: { id: string; name: string }[]; products: { code: string; name: string }[] };

type CodedRow = { areaCode: string; brickId: string; brickName: string; productCode: string; productName: string; qty: number; regionCode: string; clientName: string | null };
type Unknown = { raw: string; rawName: string; count: number; suggestionCode: string | null; suggestionLabel: string | null };
type Preview = {
  distributorName: string; period: string | null;
  periods: { period: string; rows: number }[];
  sampleCoded: CodedRow[];
  unknownProducts: Unknown[]; unknownTerritories: Unknown[]; unknownCustomers: Unknown[];
  summary: { totalRows: number; productResolved: number; brickResolved: number; fullyCoded: number; ignored: number };
};

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "—");

// One-click copy of a raw value (so it can be pasted into the Phoenix search).
function CopyBtn({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  if (!text) return null;
  return (
    <button
      className="ml-1 inline-flex shrink-0 items-center text-slate-400 transition hover:text-[#1D4ED8]"
      onClick={async (e) => { e.stopPropagation(); try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1000); } catch { /* clipboard blocked */ } }}
      title="Copy"
      type="button"
    >{done ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}</button>
  );
}

// Type-to-search combobox — filter hundreds of bricks/products by typing instead of scrolling.
// Includes a paste button: paste a copied raw value to instantly filter the list.
function ComboBox({ onChange, options, placeholder, value }: { onChange: (v: string) => void; options: { label: string; value: string }[]; placeholder: string; value: string }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const selected = options.find((o) => o.value === value);
  const q = query.trim().toLowerCase();
  const filtered = open ? (q ? options.filter((o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q)) : options).slice(0, 60) : [];
  return (
    <div className="relative min-w-[240px]">
      <input
        className="h-9 w-full rounded-lg border border-[#D8E0EA] bg-white px-2 pr-8 text-sm outline-none focus:border-[#FDBA74] focus:ring-2 focus:ring-[#F97316]/15"
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => { setOpen(true); setQuery(""); }}
        placeholder={placeholder}
        ref={inputRef}
        value={open ? query : selected?.label ?? ""}
      />
      <button
        className="absolute right-1.5 top-2 text-slate-400 transition hover:text-[#1D4ED8]"
        onClick={async () => { try { const t = await navigator.clipboard.readText(); if (t) { setQuery(t); setOpen(true); inputRef.current?.focus(); } } catch { /* clipboard blocked */ } }}
        onMouseDown={(e) => e.preventDefault()}
        title="Paste to search"
        type="button"
      ><ClipboardPaste className="h-3.5 w-3.5" /></button>
      {open ? (
        <div className="absolute left-0 right-0 z-50 mt-1 max-h-64 overflow-auto border border-[#D8E0EA] bg-white shadow-lg">
          {filtered.map((o) => (
            <button
              className={cn("block w-full px-2 py-1.5 text-left text-sm hover:bg-[#EEF3FE]", o.value === value && "bg-[#EEF3FE] font-semibold")}
              key={o.value}
              onMouseDown={(e) => { e.preventDefault(); onChange(o.value); setOpen(false); setQuery(""); }}
              type="button"
            >{o.label}</button>
          ))}
          {filtered.length === 0 ? <div className="px-2 py-2 text-xs text-slate-400">Type to search… no match.</div> : null}
        </div>
      ) : null}
    </div>
  );
}

export function NormalizerWorkspace({ aiEnabled, distributors, references }: { aiEnabled: boolean; distributors: DistributorOption[]; references: MappingReferences }) {
  const [distributorCode, setDistributorCode] = useState(distributors[0]?.code ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<"coded" | "map">("coded");
  const mapFileRef = useRef<HTMLInputElement>(null);
  const cleanFileRef = useRef<HTMLInputElement>(null);

  function fd(extra?: File) {
    const f = new FormData();
    f.set("distributorCode", distributorCode);
    if (extra) f.set("file", extra);
    else if (file) f.set("file", file);
    return f;
  }

  async function analyze(keepNotice = false): Promise<Preview | null> {
    if (!file) { setError("Choose a raw distributor file first."); return null; }
    setBusy("analyze"); setError(null); if (!keepNotice) setNotice(null);
    try {
      const res = await fetch("/api/sales/normalizer/preview", { body: fd(), method: "POST" });
      const json = await res.json();
      if (json.success) {
        const p: Preview = json.data;
        setPreview(p);
        const seed: Record<string, string> = {};
        p.unknownProducts.forEach((u) => { if (u.suggestionCode) seed[`p:${u.raw}`] = u.suggestionCode; });
        setPicks(seed);
        return p;
      }
      setError(json.error ?? "Failed to analyze.");
      return null;
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to analyze."); return null; }
    finally { setBusy(null); }
  }

  async function blobPost(url: string, fallback: string) {
    const res = await fetch(url, { body: fd(), method: "POST" });
    if (!res.ok) throw new Error("Request failed");
    const blob = await res.blob();
    const match = /filename="(.+?)"/.exec(res.headers.get("Content-Disposition") ?? "");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = match?.[1] ?? fallback;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
  }

  async function run(name: string, fn: () => Promise<void>) {
    setBusy(name); setError(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : "Failed."); } finally { setBusy(null); }
  }

  async function saveMappings() {
    if (!preview) return;
    const mappings: { type: "product" | "territory" | "customer"; raw: string; code: string; distributorCode?: string }[] = [];
    preview.unknownProducts.forEach((u) => { const c = picks[`p:${u.raw}`]; if (c) mappings.push({ type: "product", raw: u.raw, code: c }); });
    preview.unknownTerritories.forEach((u) => { const c = picks[`t:${u.raw}`]; if (c) mappings.push({ type: "territory", raw: u.raw, code: c }); });
    preview.unknownCustomers.forEach((u) => { const c = picks[`c:${u.raw}`]; if (c) mappings.push({ type: "customer", raw: u.raw, code: c, distributorCode }); });
    if (mappings.length === 0) { setError("Pick at least one Phoenix code to save."); return; }
    setBusy("save"); setError(null); setNotice(null);
    try {
      const res = await fetch("/api/sales/normalizer/mappings/save", { body: JSON.stringify({ mappings }), headers: { "Content-Type": "application/json" }, method: "POST" });
      const json = await res.json();
      if (!json.success) { setError(json.error ?? "Save failed."); return; }
      setNotice(`Saved ${json.data.saved} mapping(s). Refreshing coverage…`);
      const p = await analyze(true);
      if (p) {
        const remaining = p.unknownProducts.length + p.unknownTerritories.length + p.unknownCustomers.length;
        setNotice(remaining === 0
          ? `Saved ${json.data.saved} mapping(s). Everything is mapped now.`
          : `Saved ${json.data.saved} mapping(s). ${remaining} item(s) still need mapping.`);
      } else setNotice(null);
    } catch (e) { setError(e instanceof Error ? e.message : "Save failed."); }
    finally { setBusy(null); }
  }

  async function aiSuggestAll() {
    if (!preview) return;
    setBusy("ai"); setError(null); setNotice(null);
    try {
      let filled = 0; let failed = false;
      for (const [kind, list, prefix] of [["product", preview.unknownProducts, "p"], ["territory", preview.unknownTerritories, "t"]] as const) {
        if (list.length === 0) continue;
        const res = await fetch("/api/sales/normalizer/mappings/ai-suggest", { body: JSON.stringify({ kind, unknowns: list.map((u) => ({ raw: u.raw, rawName: u.rawName })) }), headers: { "Content-Type": "application/json" }, method: "POST" });
        const json = await res.json();
        if (json.success) {
          const sugg = (json.data.suggestions ?? []) as { raw: string; code: string }[];
          if (sugg.length) { setPicks((p) => { const n = { ...p }; sugg.forEach((s) => { n[`${prefix}:${s.raw}`] = s.code; }); return n; }); filled += sugg.length; }
        } else { failed = true; if (json.error) setError(json.error); }
      }
      if (filled) setNotice(`AI pre-filled ${filled} suggestion(s) — review the dropdowns, fix any wrong ones, then Save.`);
      else if (!failed) setNotice("AI found no confident matches — map them by hand.");
    } catch (e) { setError(e instanceof Error ? e.message : "AI suggest failed."); }
    finally { setBusy(null); }
  }

  async function learnFromCleaned(f: File) {
    setBusy("bootstrap"); setError(null); setNotice(null);
    try {
      const form = new FormData(); form.set("distributorCode", distributorCode); form.set("file", f);
      const res = await fetch("/api/sales/normalizer/mappings/bootstrap", { body: form, method: "POST" });
      const json = await res.json();
      if (json.success) setNotice(`Learned ${json.data.saved} new mapping(s) from ${json.data.scannedRows.toLocaleString()} rows of the cleaned ${distributorCode} file (${json.data.skipped} already known). Re-analyze a raw file to see the higher coverage.`);
      else setError(json.error ?? "Learn failed.");
    } catch (e) { setError(e instanceof Error ? e.message : "Learn failed."); }
    finally { setBusy(null); if (cleanFileRef.current) cleanFileRef.current.value = ""; }
  }

  async function learnFromExcel(f: File) {
    setBusy("learn"); setError(null); setNotice(null);
    try {
      const form = new FormData(); form.set("file", f);
      const res = await fetch("/api/sales/normalizer/mappings/learn", { body: form, method: "POST" });
      const json = await res.json();
      if (!json.success) { setError(json.error ?? "Learn failed."); return; }
      setNotice(`Learned ${json.data.saved} mapping(s) from Excel (${json.data.skipped} already known, ${json.data.invalid} invalid). Re-analyzing…`);
      await analyze(true);
    } catch (e) { setError(e instanceof Error ? e.message : "Learn failed."); }
    finally { setBusy(null); if (mapFileRef.current) mapFileRef.current.value = ""; }
  }

  const s = preview?.summary;
  const distinctCount = (preview?.unknownProducts.length ?? 0) + (preview?.unknownTerritories.length ?? 0) + (preview?.unknownCustomers.length ?? 0);
  const productOptions = [{ label: "🚫 Ignore — we don't sell this", value: "IGNORE" }, ...references.products.map((p) => ({ label: `${p.name} (${p.code})`, value: p.code }))];
  const brickOptions = references.bricks.map((b) => ({ label: `${b.id} — ${b.name}`, value: b.id }));
  const selectClass = "h-11 w-full rounded-2xl border border-[#D8E0EA] bg-[#F8FAFC] px-3.5 text-sm font-semibold text-[#0F172A] outline-none focus:border-[#FDBA74] focus:ring-4 focus:ring-[#F97316]/10 disabled:opacity-60";

  return (
    <div className="min-h-[calc(100vh-7rem)] space-y-7">
      <AdminPageHero
        badges={(<><AdminInsightChip>Auto-codes Product / Brick / Area / Region</AdminInsightChip><AdminInsightChip tone="orange">Drop the raw distributor file as-is</AdminInsightChip></>)}
        description="Drop a raw distributor sheet untouched. The normalizer translates the distributor's own item and territory codes into Phoenix Product ID + Brick ID and derives Area + Region automatically. Map the few unknown codes once (in bulk) and they're remembered forever."
        eyebrow="Source Normalizer" icon={<Sparkles className="h-4 w-4" />} title="Source Normalizer"
      />

      <div className="border border-[#1D4ED8]/30 bg-[#EEF3FE] p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex-1 min-w-[260px]">
            <p className="text-sm font-black text-[#1E3A8A]">Teach the dictionary from a cleaned file (one-time per distributor)</p>
            <p className="mt-0.5 text-xs text-slate-600">Drop a file you already cleaned by hand (it has the raw codes + your Phoenix IDs side by side) for the distributor selected below. The system learns every raw → Phoenix translation at once, so future raw files auto-code. Insert-only — it never overwrites.</p>
          </div>
          <button
            className="inline-flex h-10 shrink-0 items-center gap-2 border border-[#1D4ED8] bg-[#1D4ED8] px-4 text-sm font-bold text-white transition hover:bg-[#1E3A8A] disabled:opacity-50"
            disabled={busy !== null}
            onClick={() => cleanFileRef.current?.click()}
            type="button"
          >
            {busy === "bootstrap" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Learn from cleaned file
          </button>
          <input accept=".xlsx,.xls" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void learnFromCleaned(f); }} ref={cleanFileRef} type="file" />
        </div>
      </div>

      <AdminTableShell
        action={(
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <label className="flex flex-col gap-1 sm:w-44">
              <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">Distributor</span>
              <select className={selectClass} disabled={busy !== null} onChange={(e) => { setDistributorCode(e.target.value); setPreview(null); }} value={distributorCode}>
                {distributors.map((d) => <option key={d.code} value={d.code}>{d.name} / {d.code}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 sm:w-60">
              <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">Raw file</span>
              <input accept=".xlsx,.xls" className="h-11 rounded-2xl border border-[#D8E0EA] bg-[#F8FAFC] px-3 py-2 text-xs" disabled={busy !== null} onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); }} type="file" />
            </label>
            <Button className="gap-2" disabled={busy !== null || !file} onClick={() => void analyze()}>
              {busy === "analyze" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Analyze
            </Button>
          </div>
        )}
        description="Anything the system has not learned yet is grouped under Needs mapping — map each distinct code once (it fixes every row that uses it)."
        title="Clean & Convert"
      >
        <div className="space-y-5 p-4 md:p-5">
          {error ? <AdminCallout tone="danger"><AlertTriangle className="mt-0.5 h-4 w-4" /><p>{error}</p></AdminCallout> : null}
          {notice ? <AdminCallout tone="success"><Sparkles className="mt-0.5 h-4 w-4" /><p>{notice}</p></AdminCallout> : null}

          {!preview ? (
            <AdminCallout tone="neutral"><Upload className="mt-0.5 h-4 w-4" /><p>Pick the distributor, choose its raw export file, and click Analyze. Nothing is saved until you choose Download or Import.</p></AdminCallout>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  { label: "Rows", value: s!.totalRows.toLocaleString() },
                  { label: "Product coded", value: pct(s!.productResolved, s!.totalRows) },
                  { label: "Brick coded", value: pct(s!.brickResolved, s!.totalRows) },
                  { label: "Fully auto-coded", value: pct(s!.fullyCoded, s!.totalRows), strong: true },
                ].map((k) => (
                  <div className={cn("border border-[#E2E8F0] bg-white p-3", k.strong && "border-[#1D4ED8] bg-[#EEF3FE]")} key={k.label}>
                    <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">{k.label}</p>
                    <p className={cn("mt-1 text-lg font-black tabular-nums", k.strong ? "text-[#1D4ED8]" : "text-slate-900")}>{k.value}</p>
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-slate-500">Month: <b>{preview.period ?? "—"}</b></span>
                <div className="ml-auto flex gap-2">
                  <button className="inline-flex h-10 items-center gap-2 border border-[#0B0B0B] bg-white px-4 text-sm font-bold text-[#0B0B0B] transition hover:bg-slate-50 disabled:opacity-50" disabled={busy !== null} onClick={() => void run("download", () => blobPost("/api/sales/normalizer/download", "phoenix-coded.xlsx"))} type="button">
                    {busy === "download" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Download coded XLSX
                  </button>
                  <button className="inline-flex h-10 items-center gap-2 border border-[#0B0B0B] bg-[#0B0B0B] px-4 text-sm font-bold text-white transition hover:bg-[#F97316] disabled:opacity-50" disabled={busy !== null || s!.fullyCoded === 0} onClick={() => void run("import", async () => {
                    const res = await fetch("/api/sales/normalizer/import", { body: fd(), method: "POST" });
                    const json = await res.json();
                    if (json.success) setNotice(`Imported ${json.data.importedRows} rows for ${json.data.period ?? "—"} into Source of Sales.`);
                    else setError(json.error ?? "Import failed.");
                  })} type="button">
                    {busy === "import" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Import to Source of Sales
                  </button>
                </div>
              </div>

              <div className="flex gap-1 border-b border-slate-200">
                {([["coded", `Coded preview (${preview.sampleCoded.length})`], ["map", `Needs mapping — ${distinctCount} codes (${Math.max(0, s!.totalRows - s!.fullyCoded - s!.ignored).toLocaleString()} rows${s!.ignored ? `, ${s!.ignored.toLocaleString()} ignored` : ""})`]] as const).map(([key, label]) => (
                  <button className={cn("border-b-2 px-3 py-2 text-sm font-semibold", tab === key ? "border-[#F97316] text-[#0B0B0B]" : "border-transparent text-slate-500")} key={key} onClick={() => setTab(key)} type="button">{label}</button>
                ))}
              </div>

              {tab === "coded" ? (
                <div className="overflow-x-auto border border-[#E2E8F0]">
                  <table className="w-full text-sm">
                    <thead className="bg-[#0B0B0B] text-[#F1F5F9]"><tr>{["Product ID", "Product", "Brick ID", "Brick", "Area", "Region", "Qty", "Customer"].map((h) => <th className="whitespace-nowrap px-3 py-2 text-left" key={h}>{h}</th>)}</tr></thead>
                    <tbody>
                      {preview.sampleCoded.map((r, i) => (
                        <tr className={i % 2 ? "bg-[#F8FAFC]" : ""} key={i}>
                          <td className="px-3 py-1.5 font-semibold text-slate-900">{r.productCode}</td>
                          <td className="px-3 py-1.5 text-slate-600">{r.productName}</td>
                          <td className="px-3 py-1.5 font-semibold text-[#1D4ED8]">{r.brickId}</td>
                          <td className="px-3 py-1.5 text-slate-600">{r.brickName}</td>
                          <td className="px-3 py-1.5 text-slate-600">{r.areaCode}</td>
                          <td className="px-3 py-1.5 text-slate-600">{r.regionCode}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{r.qty}</td>
                          <td className="px-3 py-1.5 text-slate-600">{r.clientName ?? ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center gap-2 border border-[#E2E8F0] bg-[#F8FAFC] p-3">
                    <p className="text-xs text-slate-600">Pick the right Phoenix code for each unknown (suggestions are pre-filled), then <b>Save</b>. Or do it in Excel: download the list, fill the codes, upload it back.</p>
                    <div className="ml-auto flex flex-wrap gap-2">
                      <button className="inline-flex h-9 items-center gap-2 border border-[#0B0B0B] bg-white px-3 text-xs font-bold text-[#0B0B0B] hover:bg-slate-50 disabled:opacity-50" disabled={busy !== null} onClick={() => void run("template", () => blobPost("/api/sales/normalizer/mappings/template", "phoenix-unmapped.xlsx"))} type="button">
                        {busy === "template" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Download list (Excel)
                      </button>
                      <button className="inline-flex h-9 items-center gap-2 border border-[#0B0B0B] bg-white px-3 text-xs font-bold text-[#0B0B0B] hover:bg-slate-50 disabled:opacity-50" disabled={busy !== null} onClick={() => mapFileRef.current?.click()} type="button">
                        {busy === "learn" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Upload filled list
                      </button>
                      <input accept=".xlsx,.xls" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void learnFromExcel(f); }} ref={mapFileRef} type="file" />
                      {aiEnabled ? (
                        <button className="inline-flex h-9 items-center gap-2 border border-[#7C3AED] bg-[#7C3AED] px-3 text-xs font-bold text-white transition hover:bg-[#6D28D9] disabled:opacity-50" disabled={busy !== null} onClick={() => void aiSuggestAll()} title="Let AI pre-fill the dropdowns" type="button">
                          {busy === "ai" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} AI suggest
                        </button>
                      ) : null}
                      <button className="inline-flex h-9 items-center gap-2 border border-[#0B0B0B] bg-[#0B0B0B] px-3 text-xs font-bold text-white transition hover:bg-[#F97316] disabled:opacity-50" disabled={busy !== null} onClick={() => void saveMappings()} type="button">
                        {busy === "save" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save mappings
                      </button>
                    </div>
                  </div>

                  {preview.unknownProducts.length > 0 ? (
                    <div className="overflow-x-auto border border-[#E2E8F0]">
                      <p className="bg-[#0B0B0B] px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-[#FDBA74]">Unknown products ({preview.unknownProducts.length})</p>
                      <table className="w-full text-sm">
                        <thead className="bg-slate-100"><tr>{["Raw code", "Raw name", "Rows", "Phoenix product"].map((h) => <th className="px-3 py-2 text-left font-semibold text-slate-600" key={h}>{h}</th>)}</tr></thead>
                        <tbody>
                          {preview.unknownProducts.map((u) => (
                            <tr className="border-t border-slate-100" key={u.raw}>
                              <td className="px-3 py-1.5 font-semibold text-slate-900"><span className="inline-flex items-center">{u.raw}<CopyBtn text={u.raw} /></span></td>
                              <td className="px-3 py-1.5 text-slate-600"><span className="inline-flex items-center">{u.rawName}<CopyBtn text={u.rawName} /></span></td>
                              <td className="px-3 py-1.5 text-right tabular-nums text-slate-500">{u.count}</td>
                              <td className="px-3 py-1.5">
                                <ComboBox onChange={(v) => setPicks((p) => ({ ...p, [`p:${u.raw}`]: v }))} options={productOptions} placeholder="Type product or code…" value={picks[`p:${u.raw}`] ?? ""} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}

                  {preview.unknownTerritories.length > 0 ? (
                    <div className="overflow-x-auto border border-[#E2E8F0]">
                      <p className="bg-[#0B0B0B] px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-[#FDBA74]">Unknown territories ({preview.unknownTerritories.length})</p>
                      <table className="w-full text-sm">
                        <thead className="bg-slate-100"><tr>{["Raw territory", "Rows", "Phoenix brick"].map((h) => <th className="px-3 py-2 text-left font-semibold text-slate-600" key={h}>{h}</th>)}</tr></thead>
                        <tbody>
                          {preview.unknownTerritories.map((u) => (
                            <tr className="border-t border-slate-100" key={u.raw}>
                              <td className="px-3 py-1.5 text-slate-700"><span className="inline-flex items-center">{u.raw}<CopyBtn text={u.raw} /></span></td>
                              <td className="px-3 py-1.5 text-right tabular-nums text-slate-500">{u.count}</td>
                              <td className="px-3 py-1.5">
                                <ComboBox onChange={(v) => setPicks((p) => ({ ...p, [`t:${u.raw}`]: v }))} options={brickOptions} placeholder="Type brick id or name…" value={picks[`t:${u.raw}`] ?? ""} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}

                  {preview.unknownCustomers.length > 0 ? (
                    <div className="overflow-x-auto border border-[#E2E8F0]">
                      <p className="bg-[#0B0B0B] px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-[#FDBA74]">Unknown customers / pharmacies ({preview.unknownCustomers.length}) — map by pharmacy when the area text is unreliable</p>
                      <table className="w-full text-sm">
                        <thead className="bg-slate-100"><tr>{["Customer code", "Pharmacy name", "Rows", "Phoenix brick"].map((h) => <th className="px-3 py-2 text-left font-semibold text-slate-600" key={h}>{h}</th>)}</tr></thead>
                        <tbody>
                          {preview.unknownCustomers.map((u) => (
                            <tr className="border-t border-slate-100" key={u.raw}>
                              <td className="px-3 py-1.5 font-semibold text-slate-900"><span className="inline-flex items-center">{u.raw}<CopyBtn text={u.raw} /></span></td>
                              <td className="px-3 py-1.5 text-slate-600"><span className="inline-flex items-center">{u.rawName}<CopyBtn text={u.rawName} /></span></td>
                              <td className="px-3 py-1.5 text-right tabular-nums text-slate-500">{u.count}</td>
                              <td className="px-3 py-1.5">
                                <ComboBox onChange={(v) => setPicks((p) => ({ ...p, [`c:${u.raw}`]: v }))} options={brickOptions} placeholder="Type brick id or name…" value={picks[`c:${u.raw}`] ?? ""} />
                              </td>
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
