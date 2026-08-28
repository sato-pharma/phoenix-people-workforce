"use client";

import { AlertTriangle, ArrowRight, CalendarDays, CheckCircle2, Database, Download, History, Layers, Loader2, MapPin, Package, Save, Sparkles, Upload } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

type IconType = typeof Sparkles;

import { AdminCallout, AdminInsightChip, AdminPageHero, AdminTableShell } from "@/components/admin/admin-design-system";
import { ComboBox, ConfidenceBadge, CopyBtn } from "@/components/sales/normalizer-controls";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SearchableSelect } from "@/components/ui/searchable-select";


type DistributorOption = { code: string; name: string };
type MappingReferences = { bricks: { id: string; name: string }[]; products: { code: string; name: string }[] };

type CodedRow = { areaCode: string; brickId: string; brickName: string; productCode: string; productName: string; qty: number; regionCode: string; clientName: string | null };
type Unknown = { raw: string; rawName: string; rawAddress?: string; rawTerritory?: string; count: number; suggestionCode: string | null; suggestionLabel: string | null };
type CustomerCluster = {
  key: string;
  kind: "geo" | "territory" | "none";
  label: string;
  governorate: string | null;
  markaz: string | null;
  members: { raw: string; rawName?: string; rawAddress?: string; rawTerritory?: string; count?: number }[];
  suggestedBricks: { brickId: string; distanceKm: number | null }[];
};
type Preview = {
  distributorName: string; period: string | null;
  periods: { period: string; rows: number }[];
  sampleCoded: CodedRow[];
  unknownProducts: Unknown[]; unknownTerritories: Unknown[]; unknownCustomers: Unknown[];
  summary: { totalRows: number; productResolved: number; brickResolved: number; fullyCoded: number; ignored: number };
};

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "—");

function requestErrorMessage(error: unknown, fallback: string) {
  if (error instanceof TypeError && error.message === "Failed to fetch") {
    return "Could not reach the server. Please check the connection and try again.";
  }
  return error instanceof Error ? error.message : fallback;
}

export function NormalizerWorkspace({ aiEnabled, distributors, references }: { aiEnabled: boolean; distributors: DistributorOption[]; references: MappingReferences }) {
  const [distributorCode, setDistributorCode] = useState(distributors[0]?.code ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [aiConfidence, setAiConfidence] = useState<Record<string, number>>({});
  const [aiOrigin, setAiOrigin] = useState<Record<string, { source: "ai" | "propagated"; matchedFrom?: { distributorCode: string; customerCode: string; customerName: string } }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<"coded" | "map">("coded");
  const [advanced, setAdvanced] = useState(false);
  const [geoCoverage, setGeoCoverage] = useState<{ totalBricks: number; cached: number; success: number; mismatch: number } | null>(null);
  const [backfillHistory, setBackfillHistory] = useState(true);
  const [clusterView, setClusterView] = useState(false);
  const [clusters, setClusters] = useState<CustomerCluster[] | null>(null);
  const mapFileRef = useRef<HTMLInputElement>(null);
  const cleanFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/sales/normalizer/brick-centroids");
        const json = await res.json().catch(() => null) as { data?: { totalBricks: number; cached: number; success: number; mismatch: number }; success?: boolean } | null;
        if (json?.success && json.data) setGeoCoverage(json.data);
      } catch { /* geo readiness line simply stays hidden */ }
    })();
  }, []);

  async function buildGeoIndex() {
    await run("centroids", async () => {
      const res = await fetch("/api/sales/normalizer/brick-centroids", { method: "POST" });
      const json = await res.json().catch(() => null) as { data?: { fieldGps: number; geocoded: number; mismatched: number; remaining: number }; error?: string; success?: boolean } | null;
      if (!json?.success || !json.data) throw new Error(json?.error ?? "Geo index build failed.");
      const d = json.data;
      setNotice(`Geo index updated: ${d.fieldGps} from field GPS, ${d.geocoded} geocoded, ${d.mismatched} flagged for review, ${d.remaining} remaining${d.remaining > 0 ? " — click Build geo index again to continue" : ""}.`);
      const cov = await fetch("/api/sales/normalizer/brick-centroids");
      const covJson = await cov.json().catch(() => null) as { data?: { totalBricks: number; cached: number; success: number; mismatch: number }; success?: boolean } | null;
      if (covJson?.success && covJson.data) setGeoCoverage(covJson.data);
    });
  }

  function fd(extra?: File) {
    const f = new FormData();
    f.set("distributorCode", distributorCode);
    if (extra) f.set("file", extra);
    else if (file) f.set("file", file);
    return f;
  }

  async function analyze(keepNotice = false, options: { quietFailure?: boolean } = {}): Promise<Preview | null> {
    if (!file) {
      if (!options.quietFailure) setError("Choose a raw distributor file first.");
      return null;
    }
    setBusy("analyze"); setError(null); if (!keepNotice) setNotice(null);
    try {
      const res = await fetch("/api/sales/normalizer/preview", { body: fd(), method: "POST" });
      const json = await res.json().catch(() => null) as { data?: Preview; error?: string; success?: boolean } | null;
      if (json?.success && json.data) {
        const p: Preview = json.data;
        setPreview(p);
        const seed: Record<string, string> = {};
        p.unknownProducts.forEach((u) => { if (u.suggestionCode) seed[`p:${u.raw}`] = u.suggestionCode; });
        setPicks(seed);
        setAiConfidence({});
        setAiOrigin({});
        setClusters(null);
        setClusterView(false);
        return p;
      }
      if (!options.quietFailure) setError(json?.error ?? `Failed to analyze. (${res.status})`);
      return null;
    } catch (e) {
      if (!options.quietFailure) setError(requestErrorMessage(e, "Failed to analyze."));
      return null;
    }
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
    const mappings: { type: "product" | "territory" | "customer"; raw: string; code: string; distributorCode?: string; confidence?: number }[] = [];
    preview.unknownProducts.forEach((u) => { const c = picks[`p:${u.raw}`]; if (c) mappings.push({ type: "product", raw: u.raw, code: c, distributorCode }); });
    preview.unknownTerritories.forEach((u) => { const c = picks[`t:${u.raw}`]; if (c) mappings.push({ type: "territory", raw: u.raw, code: c, distributorCode }); });
    preview.unknownCustomers.forEach((u) => { const c = picks[`c:${u.raw}`]; if (c) mappings.push({ type: "customer", raw: u.raw, code: c, distributorCode, confidence: aiConfidence[`c:${u.raw}`] }); });
    if (mappings.length === 0) { setError("Pick at least one Phoenix code to save."); return; }
    setBusy("save"); setError(null); setNotice(null);
    try {
      const res = await fetch("/api/sales/normalizer/mappings/save", { body: JSON.stringify({ backfill: backfillHistory, mappings }), headers: { "Content-Type": "application/json" }, method: "POST" });
      const json = await res.json().catch(() => null) as { data?: { backfilled?: number; invalid?: number; saved?: number; skipped?: number }; error?: string; success?: boolean } | null;
      if (!res.ok || !json?.success || !json.data) { setError(json?.error ?? `Save failed. (${res.status})`); return; }
      const saved = Number(json.data.saved ?? 0);
      const skipped = Number(json.data.skipped ?? 0);
      const invalid = Number(json.data.invalid ?? 0);
      const backfilled = Number(json.data.backfilled ?? 0);
      const detail = [
        skipped || invalid ? ` ${skipped} skipped, ${invalid} invalid.` : "",
        backfilled ? ` ${backfilled} historical row(s) healed.` : "",
      ].join("");
      setNotice(`Saved ${saved} mapping(s). Refreshing coverage...`);
      const p = await analyze(true, { quietFailure: true });
      if (p) {
        const remaining = p.unknownProducts.length + p.unknownTerritories.length + p.unknownCustomers.length;
        setNotice(remaining === 0
          ? `Saved ${saved} mapping(s). Everything is mapped now.${detail}`
          : `Saved ${saved} mapping(s). ${remaining} item(s) still need mapping.${detail}`);
      } else {
        setNotice(`Saved ${saved} mapping(s). Automatic coverage refresh could not complete. Click Analyze to refresh coverage.${detail}`);
      }
    } catch (e) { setError(requestErrorMessage(e, "Save failed.")); }
    finally { setBusy(null); }
  }

  async function aiSuggestAll() {
    if (!preview) return;
    setBusy("ai"); setError(null); setNotice(null);
    try {
      let filled = 0; let failed = false;
      for (const [kind, list, prefix] of [["product", preview.unknownProducts, "p"], ["territory", preview.unknownTerritories, "t"], ["customer", preview.unknownCustomers, "c"]] as const) {
        if (list.length === 0) continue;
        const res = await fetch("/api/sales/normalizer/mappings/ai-suggest", { body: JSON.stringify({ kind, unknowns: list.map((u) => ({ raw: u.raw, rawName: u.rawName, rawAddress: u.rawAddress, rawTerritory: u.rawTerritory })) }), headers: { "Content-Type": "application/json" }, method: "POST" });
        // Guard the parse: a timed-out / crashed function returns a non-JSON platform page, so a
        // bare res.json() would throw "Unexpected token 'A' … is not valid JSON". Surface the real status instead.
        const json = await res.json().catch(() => null) as { success?: boolean; data?: { suggestions?: { raw: string; code: string; confidence?: number; source?: "ai" | "propagated"; matchedFrom?: { distributorCode: string; customerCode: string; customerName: string } }[] }; error?: string } | null;
        if (!res.ok || !json?.success || !json.data) {
          failed = true;
          setError(json?.error ?? `AI suggest failed for ${kind}${res.status === 504 ? " — the analyzer timed out; try fewer rows at once" : ` (${res.status})`}.`);
          continue;
        }
        {
          const sugg = json.data.suggestions ?? [];
          if (sugg.length) {
            setPicks((p) => { const n = { ...p }; sugg.forEach((s) => { n[`${prefix}:${s.raw}`] = s.code; }); return n; });
            filled += sugg.length;
            if (kind === "customer") {
              const newConf: Record<string, number> = {};
              const newOrigin: Record<string, { source: "ai" | "propagated"; matchedFrom?: { distributorCode: string; customerCode: string; customerName: string } }> = {};
              sugg.forEach((s) => {
                if (typeof s.confidence === "number") newConf[`c:${s.raw}`] = s.confidence;
                if (s.source) newOrigin[`c:${s.raw}`] = { matchedFrom: s.matchedFrom, source: s.source };
              });
              if (Object.keys(newConf).length) setAiConfidence((prev) => ({ ...prev, ...newConf }));
              if (Object.keys(newOrigin).length) setAiOrigin((prev) => ({ ...prev, ...newOrigin }));
            }
          }
        }
      }
      if (filled) setNotice(`AI pre-filled ${filled} suggestion(s) — review the dropdowns, fix any wrong ones, then Save.`);
      else if (!failed) setNotice("AI found no confident matches — map them by hand.");
    } catch (e) { setError(e instanceof Error ? e.message : "AI suggest failed."); }
    finally { setBusy(null); }
  }

  async function autoMapCustomers() {
    if (!preview || preview.unknownCustomers.length === 0) return;
    setBusy("automap"); setError(null); setNotice(null);
    try {
      const res = await fetch("/api/sales/normalizer/mappings/auto-map", {
        body: JSON.stringify({
          distributorCode,
          unknowns: preview.unknownCustomers.map((u) => ({ raw: u.raw, rawAddress: u.rawAddress, rawName: u.rawName, rawTerritory: u.rawTerritory })),
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const json = await res.json().catch(() => null) as {
        data?: {
          applied?: { raw: string; code: string; confidence?: number; source?: "ai" | "propagated"; matchedFrom?: { distributorCode: string; customerCode: string; customerName: string } }[];
          parked?: { raw: string; code: string; confidence?: number; source?: "ai" | "propagated"; matchedFrom?: { distributorCode: string; customerCode: string; customerName: string } }[];
          backfilled?: number;
          minConfidence?: number;
        };
        error?: string;
        success?: boolean;
      } | null;
      if (!res.ok || !json?.success || !json.data) { setError(json?.error ?? `Auto-map failed. (${res.status})`); return; }
      const applied = json.data.applied ?? [];
      const parked = json.data.parked ?? [];
      const backfilled = Number(json.data.backfilled ?? 0);
      // Parked suggestions pre-fill the dropdowns for manual review; applied ones are saved already.
      const newPicks: Record<string, string> = {};
      const newConf: Record<string, number> = {};
      const newOrigin: typeof aiOrigin = {};
      for (const s of [...applied, ...parked]) {
        newPicks[`c:${s.raw}`] = s.code;
        if (typeof s.confidence === "number") newConf[`c:${s.raw}`] = s.confidence;
        if (s.source) newOrigin[`c:${s.raw}`] = { matchedFrom: s.matchedFrom, source: s.source };
      }
      if (Object.keys(newPicks).length) setPicks((p) => ({ ...p, ...newPicks }));
      if (Object.keys(newConf).length) setAiConfidence((p) => ({ ...p, ...newConf }));
      if (Object.keys(newOrigin).length) setAiOrigin((p) => ({ ...p, ...newOrigin }));
      if (applied.length > 0) {
        setNotice(`Auto-mapped ${applied.length} customer(s) (gate ≥${json.data.minConfidence ?? 95}%)${backfilled ? `, healed ${backfilled} historical row(s)` : ""}. ${parked.length} parked for your review — undo any auto-mapping from the Mapping Database page. Refreshing coverage...`);
        const p = await analyze(true, { quietFailure: true });
        if (p) setNotice(`Auto-mapped ${applied.length} customer(s)${backfilled ? `, healed ${backfilled} historical row(s)` : ""}. ${p.unknownCustomers.length} customer(s) still need manual mapping.`);
      } else {
        setNotice(`Nothing cleared the auto-map gate — ${parked.length} suggestion(s) pre-filled for manual review instead.`);
      }
    } catch (e) { setError(requestErrorMessage(e, "Auto-map failed.")); }
    finally { setBusy(null); }
  }

  async function loadClusters() {
    if (!preview || preview.unknownCustomers.length === 0) return;
    await run("clusters", async () => {
      const res = await fetch("/api/sales/normalizer/mappings/clusters", {
        body: JSON.stringify({ unknowns: preview.unknownCustomers.map((u) => ({ count: u.count, raw: u.raw, rawAddress: u.rawAddress, rawName: u.rawName, rawTerritory: u.rawTerritory })) }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const json = await res.json().catch(() => null) as { data?: { clusters: CustomerCluster[] }; error?: string; success?: boolean } | null;
      if (!json?.success || !json.data) throw new Error(json?.error ?? "Clustering failed.");
      setClusters(json.data.clusters);
      setClusterView(true);
    });
  }

  function assignClusterBrick(cluster: CustomerCluster, brickId: string) {
    if (!brickId) return;
    setPicks((p) => {
      const next = { ...p };
      cluster.members.forEach((m) => { next[`c:${m.raw}`] = brickId; });
      return next;
    });
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
      const form = new FormData(); form.set("file", f); form.set("distributorCode", distributorCode);
      const res = await fetch("/api/sales/normalizer/mappings/learn", { body: form, method: "POST" });
      const json = await res.json();
      if (!json.success) { setError(json.error ?? "Learn failed."); return; }
      setNotice(`Learned ${json.data.saved} mapping(s) from Excel (${json.data.skipped} already known, ${json.data.invalid} invalid). Re-analyzing…`);
      await analyze(true);
    } catch (e) { setError(e instanceof Error ? e.message : "Learn failed."); }
    finally { setBusy(null); if (mapFileRef.current) mapFileRef.current.value = ""; }
  }

  async function mineHistory() {
    setBusy("mine"); setError(null); setNotice(null);
    try {
      const res = await fetch("/api/sales/normalizer/mappings/learn-from-history", {
        body: JSON.stringify({ distributorCode }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const json = await res.json();
      if (!json.success) { setError(json.error ?? "Mine history failed."); return; }
      setNotice(`Mined ${json.data.scannedRows.toLocaleString()} import rows — saved ${json.data.saved} new mapping(s) (${json.data.skipped} already known). Re-analyzing…`);
      if (file) await analyze(true);
    } catch (e) { setError(e instanceof Error ? e.message : "Mine history failed."); }
    finally { setBusy(null); }
  }

  const s = preview?.summary;
  const distinctCount = (preview?.unknownProducts.length ?? 0) + (preview?.unknownTerritories.length ?? 0) + (preview?.unknownCustomers.length ?? 0);
  const productOptions = [{ label: "🚫 Ignore — we don't sell this", value: "IGNORE" }, ...references.products.map((p) => ({ label: `${p.name} (${p.code})`, value: p.code }))];
  const brickOptions = references.bricks.map((b) => ({ label: b.name, value: b.id }));
  const selectClass = "h-11 w-full border border-slate-300 bg-white px-3.5 text-sm font-semibold text-slate-900 outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 disabled:opacity-60";

  return (
    <div className="min-h-[calc(100vh-7rem)] space-y-7">
      <AdminPageHero
        badges={(<><AdminInsightChip>Auto-codes Product / Brick / Area / Region</AdminInsightChip><AdminInsightChip tone="orange">Drop the raw distributor file as-is</AdminInsightChip><Link className="inline-flex items-center gap-1 text-xs font-semibold text-orange-400 transition hover:text-orange-300 hover:underline" href="/sales/mapping-database"><Database className="h-3.5 w-3.5" /> Mapping Database</Link><Link className="inline-flex items-center gap-1 text-xs font-semibold text-white/70 transition hover:text-white hover:underline" href="/sales/upload"><Upload className="h-3.5 w-3.5" /> Sales Upload</Link></>)}
        description="Drop a raw distributor sheet untouched. The normalizer translates the distributor's own item and territory codes into Phoenix Product ID + Brick ID and derives Area + Region automatically. Map the few unknown codes once (in bulk) and they're remembered forever."
        eyebrow="Source Normalizer" icon={<Sparkles className="h-4 w-4" />} title="Source Normalizer"
      />

      <div className="border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center gap-2 bg-slate-900 px-4 py-3">
          <span className="h-4 w-1 bg-orange-500" />
          <p className="text-sm font-black uppercase tracking-wide text-white">Teach the dictionary from a cleaned file</p>
          <span className="text-xs font-medium normal-case tracking-normal text-slate-400">(one-time per distributor)</span>
        </div>
        <div className="flex flex-wrap items-center gap-3 p-4">
          <div className="flex-1 min-w-[260px]">
            <p className="text-xs text-slate-600">Drop a file you already cleaned by hand (it has the raw codes + your Phoenix IDs side by side) for the distributor selected below. The system learns every raw → Phoenix translation at once, so future raw files auto-code. Insert-only — it never overwrites.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className="inline-flex h-10 shrink-0 items-center gap-2 border border-orange-600 bg-orange-600 px-4 text-sm font-bold text-white transition hover:bg-orange-700 disabled:opacity-50"
              disabled={busy !== null}
              onClick={() => cleanFileRef.current?.click()}
              type="button"
            >
              {busy === "bootstrap" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Learn from cleaned file
            </button>
            <button
              className="inline-flex h-10 shrink-0 items-center gap-2 border border-slate-300 bg-white px-4 text-sm font-bold text-slate-700 transition hover:bg-slate-100 disabled:opacity-50"
              disabled={busy !== null}
              onClick={() => void mineHistory()}
              title="Scan all previously imported rows for this distributor and save any new product or customer mappings"
              type="button"
            >
              {busy === "mine" ? <Loader2 className="h-4 w-4 animate-spin" /> : <History className="h-4 w-4" />} Mine import history
            </button>
          </div>
          <input accept=".xlsx,.xls" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void learnFromCleaned(f); }} ref={cleanFileRef} type="file" />
        </div>
      </div>

      <AdminTableShell
        action={(
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <label className="flex flex-col gap-1 sm:w-44">
              <span className="text-phx-2xs font-bold uppercase tracking-[0.16em] text-slate-500">Distributor</span>
              <SearchableSelect className={selectClass} disabled={busy !== null} onChange={(e) => { setDistributorCode(e.target.value); setPreview(null); }} value={distributorCode}>
                {distributors.map((d) => <option key={d.code} value={d.code}>{d.name} / {d.code}</option>)}
              </SearchableSelect>
            </label>
            <label className="flex flex-col gap-1 sm:w-60">
              <span className="text-phx-2xs font-bold uppercase tracking-[0.16em] text-slate-500">Raw file</span>
              <input accept=".xlsx,.xls" className="h-11 border border-slate-300 bg-white px-3 py-2 text-xs outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20" disabled={busy !== null} onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); }} type="file" />
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
                {([
                  { label: "Rows", value: s!.totalRows.toLocaleString(), icon: Layers },
                  { label: "Product coded", value: pct(s!.productResolved, s!.totalRows), ratio: s!.totalRows ? s!.productResolved / s!.totalRows : 0, icon: Package },
                  { label: "Brick coded", value: pct(s!.brickResolved, s!.totalRows), ratio: s!.totalRows ? s!.brickResolved / s!.totalRows : 0, icon: MapPin },
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
                  <span className="text-phx-2xs font-bold uppercase tracking-[0.16em] text-slate-500">Detected month</span>
                  <span className="inline-flex items-center gap-1.5 border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-bold text-slate-900"><CalendarDays className="h-3.5 w-3.5 text-orange-500" />{preview.period ?? "—"}</span>
                </div>
                <div className="ml-auto flex flex-col items-end gap-1">
                  <div className="flex gap-2">
                    <button className="inline-flex h-10 items-center gap-2 border border-slate-300 bg-white px-4 text-sm font-bold text-slate-700 transition hover:bg-slate-100 disabled:opacity-50" disabled={busy !== null} onClick={() => void run("download", () => blobPost("/api/sales/normalizer/download", "phoenix-coded.xlsx"))} type="button">
                      {busy === "download" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Download coded XLSX
                    </button>
                    <button className="inline-flex h-10 items-center gap-2 border border-orange-600 bg-orange-600 px-4 text-sm font-bold text-white transition hover:bg-orange-700 disabled:opacity-50" disabled={busy !== null || s!.fullyCoded === 0} onClick={() => void run("import", async () => {
                      const res = await fetch("/api/sales/normalizer/import-validated", { body: fd(), method: "POST" });
                      const json = await res.json();
                      if (json.success) setNotice(`Imported ${json.data.importableRows} validated row(s) for ${json.data.period ?? "—"} into Source of Sales.`);
                      else { const reasons = (json.data?.blockingReasons ?? []) as string[]; setError(`${json.error ?? "Import failed."}${reasons.length ? " — " + reasons.slice(0, 3).join("; ") : ""}`); }
                    })} type="button">
                      {busy === "import" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Import (validated)
                    </button>
                  </div>
                  <div className="flex items-center gap-2 text-phx-xs text-slate-400">
                    <span>Download → upload on Source of Sales (it now passes validation), or import straight here.</span>
                    <button className="underline transition hover:text-orange-600" onClick={() => setAdvanced((v) => !v)} type="button">{advanced ? "Hide advanced" : "Advanced"}</button>
                  </div>
                  {advanced ? (
                    <button className="inline-flex h-8 items-center gap-2 border border-amber-300 bg-amber-50 px-3 text-phx-xs font-semibold text-amber-800 transition hover:bg-amber-100 disabled:opacity-50" disabled={busy !== null || s!.fullyCoded === 0} onClick={() => {
                      // Writing unvalidated rows straight to Source of Sales is irreversible from here —
                      // require an explicit confirmation, not just the Advanced toggle.
                      if (!window.confirm("Direct import SKIPS Source of Sales validation and writes the coded rows straight to the database. This cannot be previewed or undone here. Proceed?")) return;
                      void run("import-direct", async () => {
                        const res = await fetch("/api/sales/normalizer/import", { body: fd(), method: "POST" });
                        const json = await res.json();
                        if (json.success) setNotice(`Direct import: ${json.data.importedRows} row(s) for ${json.data.period ?? "—"} (validation skipped).`);
                        else setError(json.error ?? "Import failed.");
                      });
                    }} title="Skips the Source of Sales validation — use only if you trust the coded rows." type="button">
                      {busy === "import-direct" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <AlertTriangle className="h-3.5 w-3.5" />} Direct import (skip validation)
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="flex gap-1 border-b border-slate-200">
                {([["coded", `Coded preview (${preview.sampleCoded.length})`], ["map", `Needs mapping — ${distinctCount} codes (${Math.max(0, s!.totalRows - s!.fullyCoded - s!.ignored).toLocaleString()} rows${s!.ignored ? `, ${s!.ignored.toLocaleString()} ignored` : ""})`]] as const).map(([key, label]) => (
                  <button className={cn("-mb-px border-b-2 px-3.5 py-2 text-sm font-semibold transition-colors", tab === key ? "border-orange-500 text-slate-900" : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-900")} key={key} onClick={() => setTab(key)} type="button">{label}</button>
                ))}
              </div>

              {tab === "coded" ? (
                <div className="overflow-x-auto border border-phx-line">
                  <table className="w-full text-sm">
                    <thead className="bg-[#0B0B0B] text-phx-paper-2"><tr>{["Product ID", "Product", "Brick ID", "Brick", "Area", "Region", "Qty", "Customer"].map((h) => <th className="whitespace-nowrap px-3 py-2 text-left" key={h}>{h}</th>)}</tr></thead>
                    <tbody>
                      {preview.sampleCoded.map((r, i) => (
                        <tr className={cn("transition-colors hover:bg-orange-50/50", i % 2 && "bg-slate-50/60")} key={i}>
                          <td className="px-3 py-1.5 font-mono text-phx-md font-semibold text-slate-900">{r.productCode}</td>
                          <td className="px-3 py-1.5 text-slate-600">{r.productName}</td>
                          <td className="px-3 py-1.5 font-mono text-phx-md font-semibold text-slate-700">{r.brickId}</td>
                          <td className="px-3 py-1.5 text-slate-600">{r.brickName}</td>
                          <td className="px-3 py-1.5 text-slate-600">{r.areaCode}</td>
                          <td className="px-3 py-1.5 text-slate-600">{r.regionCode}</td>
                          <td className="px-3 py-1.5 text-right font-semibold tabular-nums text-slate-900">{r.qty.toLocaleString()}</td>
                          <td className="px-3 py-1.5 text-slate-600">{r.clientName ?? ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center gap-2 border border-slate-200 bg-slate-50 p-4 shadow-sm">
                    <p className="text-xs text-slate-600">Pick the right Phoenix code for each unknown (suggestions are pre-filled), then <b>Save</b>. Or do it in Excel: download the list, fill the codes, upload it back.</p>
                    <div className="ml-auto flex flex-wrap gap-2">
                      <button className="inline-flex h-9 items-center gap-2 border border-slate-300 bg-white px-3 text-xs font-bold text-slate-700 transition hover:bg-slate-100 disabled:opacity-50" disabled={busy !== null} onClick={() => void run("template", () => blobPost("/api/sales/normalizer/mappings/template", "phoenix-unmapped.xlsx"))} type="button">
                        {busy === "template" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Download list (Excel)
                      </button>
                      <button className="inline-flex h-9 items-center gap-2 border border-slate-300 bg-white px-3 text-xs font-bold text-slate-700 transition hover:bg-slate-100 disabled:opacity-50" disabled={busy !== null} onClick={() => mapFileRef.current?.click()} type="button">
                        {busy === "learn" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Upload filled list
                      </button>
                      <input accept=".xlsx,.xls" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void learnFromExcel(f); }} ref={mapFileRef} type="file" />
                      {aiEnabled ? (
                        <button className="inline-flex h-9 items-center gap-2 border border-violet-600 bg-violet-600 px-3 text-xs font-bold text-white transition hover:bg-violet-700 disabled:opacity-50" disabled={busy !== null} onClick={() => void aiSuggestAll()} title="Let AI pre-fill the dropdowns" type="button">
                          {busy === "ai" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} AI suggest
                        </button>
                      ) : null}
                      {aiEnabled && preview.unknownCustomers.length > 0 ? (
                        <button className="inline-flex h-9 items-center gap-2 border border-emerald-600 bg-emerald-600 px-3 text-xs font-bold text-white transition hover:bg-emerald-700 disabled:opacity-50" disabled={busy !== null} onClick={() => void autoMapCustomers()} title="Apply only the suggestions that pass the multi-signal geographic gate — everything applied is listed and undoable" type="button">
                          {busy === "automap" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Auto-map high-confidence
                        </button>
                      ) : null}
                      <button className="inline-flex h-9 items-center gap-2 border border-orange-600 bg-orange-600 px-3 text-xs font-bold text-white transition hover:bg-orange-700 disabled:opacity-50" disabled={busy !== null} onClick={() => void saveMappings()} type="button">
                        {busy === "save" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save mappings
                      </button>
                      <label className="inline-flex h-9 cursor-pointer items-center gap-1.5 px-1 text-xs font-semibold text-slate-600" title="When a customer mapping is saved, also fill the brick on already-imported rows that had no brick (never overwrites an existing brick)">
                        <input checked={backfillHistory} className="h-3.5 w-3.5 accent-orange-600" onChange={(e) => setBackfillHistory(e.target.checked)} type="checkbox" />
                        heal history
                      </label>
                      <Link className="inline-flex h-9 items-center gap-1.5 border border-slate-900 bg-slate-900 px-3 text-xs font-bold text-white transition hover:bg-slate-800" href="/sales/mapping-database">
                        <Database className="h-4 w-4" /> Mapping Database <ArrowRight className="h-3.5 w-3.5" />
                      </Link>
                    </div>
                  </div>

                  {preview.unknownProducts.length > 0 ? (
                    <div className="overflow-x-auto border border-phx-line">
                      <p className="flex items-center gap-2 bg-slate-900 px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-white"><span className="h-3.5 w-1 bg-orange-500" />Unknown products ({preview.unknownProducts.length})</p>
                      <table className="w-full text-sm">
                        <thead className="bg-slate-100"><tr>{["Raw code", "Raw name", "Rows", "Phoenix product"].map((h) => <th className="px-3 py-2 text-left font-semibold text-slate-600" key={h}>{h}</th>)}</tr></thead>
                        <tbody>
                          {preview.unknownProducts.map((u) => (
                            <tr className="border-t border-slate-100 transition-colors hover:bg-orange-50/40" key={u.raw}>
                              <td className="px-3 py-1.5 font-semibold text-slate-900"><span className="inline-flex items-center">{u.raw}<CopyBtn text={u.raw} /></span></td>
                              <td className="px-3 py-1.5 text-slate-600"><span className="inline-flex items-center">{u.rawName}<CopyBtn text={u.rawName} /></span></td>
                              <td className="px-3 py-1.5 text-right font-semibold tabular-nums text-slate-700">{u.count.toLocaleString()}</td>
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
                    <div className="overflow-x-auto border border-phx-line">
                      <p className="flex items-center gap-2 bg-slate-900 px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-white"><span className="h-3.5 w-1 bg-orange-500" />Unknown territories ({preview.unknownTerritories.length})</p>
                      <table className="w-full text-sm">
                        <thead className="bg-slate-100"><tr>{["Raw territory", "Rows", "Phoenix brick"].map((h) => <th className="px-3 py-2 text-left font-semibold text-slate-600" key={h}>{h}</th>)}</tr></thead>
                        <tbody>
                          {preview.unknownTerritories.map((u) => (
                            <tr className="border-t border-slate-100 transition-colors hover:bg-orange-50/40" key={u.raw}>
                              <td className="px-3 py-1.5 text-slate-700"><span className="inline-flex items-center">{u.raw}<CopyBtn text={u.raw} /></span></td>
                              <td className="px-3 py-1.5 text-right font-semibold tabular-nums text-slate-700">{u.count.toLocaleString()}</td>
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
                    <div className="overflow-x-auto border border-phx-line">
                      <p className="flex items-center gap-2 bg-slate-900 px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-white"><span className="h-3.5 w-1 shrink-0 bg-orange-500" />Unknown customers / pharmacies ({preview.unknownCustomers.length}) — map by pharmacy when the area text is unreliable</p>
                      <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 bg-slate-50 px-3 py-1.5 text-xs text-slate-600">
                        {geoCoverage ? (
                          <>
                            <span className="inline-flex items-center gap-1.5 font-semibold"><MapPin aria-hidden="true" className="h-3.5 w-3.5 text-orange-500" />Geo readiness: {geoCoverage.success} / {geoCoverage.totalBricks} bricks located{geoCoverage.mismatch > 0 ? ` (${geoCoverage.mismatch} flagged)` : ""}</span>
                            {geoCoverage.success < geoCoverage.totalBricks ? (
                              <button className="inline-flex h-7 items-center gap-1.5 border border-slate-300 bg-white px-2 text-xs font-bold text-slate-700 transition hover:bg-slate-100 disabled:opacity-50" disabled={busy !== null} onClick={() => void buildGeoIndex()} title="Locate brick territories once so confidence can use real distances" type="button">
                                {busy === "centroids" ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : <MapPin aria-hidden="true" className="h-3.5 w-3.5" />}Build geo index
                              </button>
                            ) : <span className="font-semibold text-emerald-600">distance-level confidence active</span>}
                          </>
                        ) : null}
                        <button className={cn("ml-auto inline-flex h-7 items-center gap-1.5 border px-2 text-xs font-bold transition disabled:opacity-50", clusterView ? "border-orange-500 bg-orange-50 text-orange-700" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100")} disabled={busy !== null} onClick={() => { if (clusterView) setClusterView(false); else void loadClusters(); }} title="Group unknowns by real location and assign one brick per group" type="button">
                          {busy === "clusters" ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : <Layers aria-hidden="true" className="h-3.5 w-3.5" />}{clusterView ? "Flat view" : "Cluster view"}
                        </button>
                      </div>
                      {clusterView && clusters ? (
                        <div className="divide-y divide-slate-100">
                          {clusters.map((c) => (
                            <div className="px-3 py-2" key={c.key}>
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-sm font-bold text-slate-900">{c.label}</span>
                                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">{c.members.length} pharmac{c.members.length === 1 ? "y" : "ies"}</span>
                                {c.suggestedBricks.slice(0, 3).map((s) => (
                                  <button className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-phx-xs font-bold text-emerald-700 transition hover:bg-emerald-100" key={s.brickId} onClick={() => assignClusterBrick(c, s.brickId)} title={s.distanceKm != null ? `~${s.distanceKm} km from cluster center — click to assign to all` : "Click to assign to all"} type="button">
                                    {s.brickId}{s.distanceKm != null ? ` · ${s.distanceKm}km` : ""}
                                  </button>
                                ))}
                                <div className="w-64">
                                  <ComboBox onChange={(v) => assignClusterBrick(c, v)} options={brickOptions} placeholder="Assign brick to whole group…" value="" />
                                </div>
                              </div>
                              <div className="mt-1.5 space-y-1">
                                {c.members.map((m) => (
                                  <div className="flex flex-wrap items-center gap-2 pl-2 text-xs text-slate-600" key={m.raw}>
                                    <span className="font-mono font-semibold text-slate-800">{m.raw}</span>
                                    <span>{m.rawName}</span>
                                    <div className="ml-auto w-56">
                                      <ComboBox onChange={(v) => setPicks((p) => ({ ...p, [`c:${m.raw}`]: v }))} options={brickOptions} placeholder="brick…" value={picks[`c:${m.raw}`] ?? ""} />
                                    </div>
                                    {aiConfidence[`c:${m.raw}`] != null ? <ConfidenceBadge pct={aiConfidence[`c:${m.raw}`]} /> : null}
                                  </div>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : null}
                      {!clusterView ? (
                      <table className="w-full text-sm">
                        <thead className="bg-slate-100"><tr>{["Customer code", "Pharmacy name", "Address", "Territory / Gov", "Rows", "Phoenix brick", "Confidence"].map((h) => <th className="px-3 py-2 text-left font-semibold text-slate-600" key={h}>{h}</th>)}</tr></thead>
                        <tbody>
                          {preview.unknownCustomers.map((u) => (
                            <tr className="border-t border-slate-100 transition-colors hover:bg-orange-50/40" key={u.raw}>
                              <td className="px-3 py-1.5 font-semibold text-slate-900"><span className="inline-flex items-center">{u.raw}<CopyBtn text={u.raw} /></span></td>
                              <td className="px-3 py-1.5 text-slate-600"><span className="inline-flex items-center">{u.rawName}<CopyBtn text={u.rawName} /></span></td>
                              <td className="px-3 py-1.5 text-slate-500 text-xs max-w-[200px]">{u.rawAddress ? <span className="inline-flex items-center gap-0.5">{u.rawAddress}<CopyBtn text={u.rawAddress} /></span> : <span className="text-slate-300">—</span>}</td>
                              <td className="px-3 py-1.5 text-slate-500 text-xs max-w-[140px]">{u.rawTerritory ? <span className="inline-flex items-center gap-0.5">{u.rawTerritory}<CopyBtn text={u.rawTerritory} /></span> : <span className="text-slate-300">—</span>}</td>
                              <td className="px-3 py-1.5 text-right font-semibold tabular-nums text-slate-700">{u.count.toLocaleString()}</td>
                              <td className="px-3 py-1.5">
                                <ComboBox onChange={(v) => setPicks((p) => ({ ...p, [`c:${u.raw}`]: v }))} options={brickOptions} placeholder="Type brick id or name…" value={picks[`c:${u.raw}`] ?? ""} />
                              </td>
                              <td className="px-3 py-1.5 text-center">
                                {aiConfidence[`c:${u.raw}`] != null ? (
                                  <span className="inline-flex flex-col items-center gap-0.5">
                                    <ConfidenceBadge pct={aiConfidence[`c:${u.raw}`]} />
                                    {aiOrigin[`c:${u.raw}`]?.source === "propagated" ? (
                                      <span
                                        className="inline-flex items-center gap-1 text-phx-2xs font-semibold text-violet-600"
                                        title={aiOrigin[`c:${u.raw}`]?.matchedFrom
                                          ? `Matched from ${aiOrigin[`c:${u.raw}`]!.matchedFrom!.distributorCode}/${aiOrigin[`c:${u.raw}`]!.matchedFrom!.customerCode} — ${aiOrigin[`c:${u.raw}`]!.matchedFrom!.customerName}`
                                          : "Matched from an existing mapping"}
                                      >
                                        <Layers aria-hidden="true" className="h-3 w-3" />known twin
                                      </span>
                                    ) : null}
                                  </span>
                                ) : <span className="text-slate-300">—</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      ) : null}
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
