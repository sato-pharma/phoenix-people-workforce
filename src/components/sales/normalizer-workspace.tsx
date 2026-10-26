"use client";

import { AlertTriangle, ArrowRight, CalendarDays, CheckCircle2, Database, Download, History, Layers, Loader2, MapPin, Package, Save, Signpost, Sparkles, Upload } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

type IconType = typeof Sparkles;

import { AdminCallout, AdminInsightChip, AdminPageHero, AdminTableShell } from "@/components/admin/admin-design-system";
import { useBrickMovesListener } from "@/components/sales/brick-move-refresh";
import { ComboBox, ConfidenceBadge, CopyBtn } from "@/components/sales/normalizer-controls";
import { NormalizerIgnoredRows } from "@/components/sales/normalizer-ignored-rows";
import { Button } from "@/components/ui/button";
import {
  brickCorrectionHref,
  followMovedBrick,
  followMovedPicks,
  pickedBrick,
  type MappingBrickReference,
  type MappingReferences,
} from "@/lib/sales/normalizer/brick-area";
import { packCustomersByPharmacy } from "@/lib/sales/normalizer/customer-request-packing";
import { mappingLeft, needsMappingTabLabel, stillNeedMappingSentence } from "@/lib/sales/normalizer/mapping-left";
import { pickConfidence } from "@/lib/sales/normalizer/pick-confidence";
import { isPhoenixTemplateCode } from "@/lib/sales/normalizer/phoenix-template-code";
import type { PreviewIgnoredRow } from "@/lib/sales/recognize";
import { MAX_UPLOAD_FILES } from "@/lib/sales/sales-upload-files";
import { cn } from "@/lib/utils";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  phxButtonApproveDenseClassName,
  phxSelectClassName,
} from "@/components/ui/form-tokens";


type DistributorOption = { code: string; name: string };

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
  // The RESOLVED distributor. Equals the picked code for a named distributor; for a Phoenix-template
  // upload the picker posted a sentinel and the sheet named its own distributor, so every mapping,
  // auto-map and history call below must use THIS code, never the one in the picker.
  distributorCode: string;
  distributorName: string; period: string | null;
  periods: { period: string; rows: number }[];
  sampleCoded: CodedRow[];
  unknownProducts: Unknown[]; unknownTerritories: Unknown[]; unknownCustomers: Unknown[];
  // Distinct unknowns BEFORE the preview's per-list cap — so the screen can say "showing 2,000 of
  // 7,318" instead of silently presenting a truncated list as the whole job.
  unknownTotals?: { customers: number; products: number; territories: number; rows?: number };
  summary: { totalRows: number; productResolved: number; brickResolved: number; fullyCoded: number; ignored: number };
  // Every row the analyzer dropped, uncut (the Ignored rows tab). Absent on a preview built before this field.
  ignoredRows?: PreviewIgnoredRow[];
  // The sheets this part was read from, when several sheets of one distributor were chosen together.
  fileNames?: string[];
};

type UnknownKind = "p" | "t" | "c";

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "—");

// Where a customer suggestion came from: the AI, or one of the free steps (customer-free-steps.ts).
type CustomerSuggestionSource = "ai" | "address" | "place" | "propagated";
type CustomerSuggestionRow = { raw: string; code: string; confidence?: number; source?: CustomerSuggestionSource; matchedFrom?: { distributorCode: string; customerCode: string; customerName: string } };

// Customers go to the server in groups, in two passes (owner, 2026-09-18: "make it by steps", and
// "group them and don't duplicate the work"):
//
//   1. FREE — every customer, CUSTOMER_FREE_REQUEST_SIZE a request, with `freeOnly`. The server answers
//      what the map itself can (customer-free-steps.ts) and what the AI already answered before, and
//      makes no AI call. On the 3,348 unmapped Pharma Overseas pharmacies of 2026-09-18 this answered
//      1,646 of them.
//   2. AI — only what pass 1 left unanswered or could not reach, CUSTOMER_AI_REQUEST_SIZE distinct
//      pharmacies a request. Identical pharmacies travel together (customer-request-packing.ts), so
//      the AI is asked once for all their codes.
//
// Why the sizes. Every request loads the 50,000-row customer map (~4 s) and geocodes new pharmacies,
// and an AI call takes ~6 s. On 2026-09-15 a hop between the browser and Railway cut a request of
// ~300 customers at 41 s and answered 502 while the server was still working (Railway logged
// "client closed"), so finished suggestions never arrived — which is why the AI pass went down to
// 20 a request. 20 a request cost 2.4 times as much per pharmacy as 60, because every AI call re-sends
// the same ~15,000-token brick list (measured 2026-09-18: $1.29 against $0.54 per 1,000 pharmacies,
// no more accurate). 60 is one AI call a request; a request that is cut is not lost either, because
// the server keeps every answer it finishes (customer-ai-answers.ts) and the retry reads them free.
// The free pass makes no AI call, so it can take more a request. Neither passes the 300 a route reads.
const CUSTOMER_FREE_REQUEST_SIZE = 100;
const CUSTOMER_AI_REQUEST_SIZE = 60;
const ROUTE_MAX_CUSTOMERS = 300;

function inGroups<T>(list: readonly T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let i = 0; i < list.length; i += size) groups.push(list.slice(i, i + size));
  return groups;
}

// Exactly the fields the customer pipeline reads.
function customerPayload(u: Unknown) {
  return { raw: u.raw, rawAddress: u.rawAddress, rawName: u.rawName, rawTerritory: u.rawTerritory };
}

// "1,646 answered free, 1,702 by the AI" — for the notices after a customer run.
function customerSourceSplit(free: number, ai: number) {
  return `${free.toLocaleString("en-US")} answered free (same address, known twin or place in the name), ${ai.toLocaleString("en-US")} by the AI`;
}

// Groups used to run strictly one after another, so 400 customers meant 20 round trips end to end —
// the whole reason one click mapped so few. They now run several at a time: the groups stay small
// (each request is still short and still isolated from its neighbours' failures) but the wall-clock
// is divided by the pool size. Four is deliberate — enough to matter, few enough that the AI and
// geocode calls behind each request are not stampeded.
const GROUP_CONCURRENCY = 4;

/** Run `worker` over `items` with at most `limit` in flight, preserving result order. */
async function inPool<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length) as R[];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    }),
  );
  return results;
}

// One Save posts every pick in a single request, and with bulk assign a person can now pick
// thousands at once. The save route is capped at 60 s and each customer mapping can heal history
// rows behind it, so the picks go up in chunks — a slow save shows progress and a failed chunk
// leaves every earlier chunk saved.
const SAVE_CHUNK_SIZE = 200;

// How many unknown rows each table renders before "Show all". Every row carries a live combo box, so
// painting several thousand at once locks the tab — but SELECTION and bulk assign always cover the
// full list, not just what is painted.
const ROW_RENDER_LIMIT = 300;

// A timed-out or cut request returns a non-JSON platform page, so the status is all there is to report.
function failedStatusReason(status: number) {
  return status === 502 || status === 504
    ? `the connection was cut before the server answered (${status})`
    : `the server answered ${status}`;
}

function requestErrorMessage(error: unknown, fallback: string) {
  if (error instanceof TypeError && error.message === "Failed to fetch") {
    return "Could not reach the server. Please check the connection and try again.";
  }
  return error instanceof Error ? error.message : fallback;
}

/**
 * The bar above each unknown table: tick everything, see how many are ticked, and give all of them
 * ONE code in a single action.
 *
 * This is the bulk mapping the owner asked for. Before it, a person could only pick a code on one
 * row at a time, so a file with 800 unknown pharmacies in the same district cost 800 pickers. Select
 * all covers the WHOLE list, not the rows painted on screen, so the cap below never limits a bulk
 * assign.
 */
function BulkAssignBar({ assignLabel, busy, onAssign, onSelectAll, options, selectedCount, total }: {
  assignLabel: string;
  busy: boolean;
  onAssign: (code: string) => void;
  onSelectAll: (on: boolean) => void;
  options: { label: string; value: string }[];
  selectedCount: number;
  total: number;
}) {
  const allTicked = total > 0 && selectedCount >= total;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-600">
      <label className="inline-flex cursor-pointer items-center gap-1.5 font-bold text-slate-700">
        <input
          checked={allTicked}
          className="h-3.5 w-3.5 accent-orange-600"
          disabled={busy}
          onChange={(e) => onSelectAll(e.target.checked)}
          type="checkbox"
        />
        Select all {total.toLocaleString()}
      </label>
      <span className={cn("font-semibold tabular-nums", selectedCount > 0 ? "text-orange-700" : "text-slate-400")}>
        {selectedCount.toLocaleString()} ticked
      </span>
      {selectedCount > 0 ? (
        <button className="font-semibold text-slate-500 underline transition hover:text-orange-600" onClick={() => onSelectAll(false)} type="button">Clear</button>
      ) : null}
      <div className="ml-auto flex items-center gap-2">
        <span className="font-semibold text-slate-500">{assignLabel}</span>
        <ComboBox disabled={busy || selectedCount === 0} onChange={onAssign} options={options} placeholder={selectedCount === 0 ? "Tick rows first…" : `Give all ${selectedCount.toLocaleString()} this code…`} value="" />
      </div>
    </div>
  );
}

/**
 * Under each unknown table: how many rows are painted, the way to paint the rest, and - when the
 * preview itself capped the list - how many distinct unknowns the file actually holds. The count is
 * said out loud rather than quietly showing a cut list as if it were the whole job.
 */
function RowLimitFoot({ listLength, onShowAll, previewTotal, shown }: { listLength: number; onShowAll: () => void; previewTotal: number; shown: number }) {
  if (shown >= listLength && previewTotal <= listLength) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-600">
      {shown < listLength ? (
        <>
          <span>Showing {shown.toLocaleString()} of {listLength.toLocaleString()} — ticking, Select all and bulk assign still cover all {listLength.toLocaleString()}.</span>
          <button className="font-bold text-orange-700 underline transition hover:text-orange-800" onClick={onShowAll} type="button">Show all {listLength.toLocaleString()}</button>
        </>
      ) : null}
      {previewTotal > listLength ? (
        <span className="font-semibold text-amber-700">This file has {previewTotal.toLocaleString()} distinct unknowns here. Map these {listLength.toLocaleString()}, save, then Analyze again for the rest.</span>
      ) : null}
    </div>
  );
}

// THE UNKNOWN TERRITORY AND CUSTOMER TABLES FIT THE SCREEN (the owner's golden rule): on a desktop a
// fixed-layout table over a <colgroup> of percentages, so nothing pushes it wider than the page; on a
// phone the SAME rows stack as cards, each value under its own label. One copy of every row, never a
// table plus a separate card list: each row carries a live brick picker, and a second copy would
// double thousands of them after "Show all". Columns are merged to fit (code with name, address with
// territory), never shrunk, and long text wraps.
const stackTable = "block w-full text-left text-sm md:table md:table-fixed";
const stackCols = "hidden md:table-column-group";
const stackHead = "hidden bg-slate-100 md:table-header-group";
const stackBody = "block md:table-row-group";
const stackRow = "block border-t border-slate-100 px-2 py-2 transition-colors hover:bg-orange-50/40 md:table-row md:p-0";
const stackCell = "block px-1 py-1 align-top md:table-cell md:px-3 md:py-1.5";
const stackTickCell = "block px-1 py-1 align-top md:table-cell md:px-2 md:py-2";
const stackHeadCell = "px-3 py-2 text-left font-semibold text-slate-600";

/** A card's field name on a phone; the column header says it on a desktop. */
function StackLabel({ children }: { children: ReactNode }) {
  return <span className="mb-0.5 block text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-400 md:hidden">{children}</span>;
}

/** The tick for bulk mapping; on a phone it says what it is for, since the header is hidden there. */
function RowTick({ checked, label, onChange }: { checked: boolean; label: string; onChange: (on: boolean) => void }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2">
      <input aria-label={`Tick ${label}`} checked={checked} className="h-3.5 w-3.5 accent-orange-600" onChange={(e) => onChange(e.target.checked)} type="checkbox" />
      <span className="text-xs font-semibold text-slate-500 md:hidden">Tick for bulk map</span>
    </label>
  );
}

/**
 * The area a picked brick credits, straight from the brick master (the area of the brick's block).
 * It is never edited here (owner, 2026-09-18: "I will not be able to edit the area in this page"). A
 * wrong one is fixed where it lives: "Correct in database" opens that brick's correction on the
 * Database Mapping page in a new tab, so the picks on this page survive, and a move made there
 * reloads this page's lists (useBrickMovesListener) so the Area shown here follows it.
 */
function BrickAreaCell({ brick }: { brick: MappingBrickReference | null }) {
  if (!brick) return <span className="text-slate-300">—</span>;
  return (
    <span className="block space-y-0.5">
      <span className="block font-semibold text-slate-800 [overflow-wrap:anywhere]">{brick.areaName || "No area on the brick master"}</span>
      {brick.regionName ? <span className="block text-slate-500 [overflow-wrap:anywhere]">{brick.regionName}</span> : null}
      <a
        className="inline-block font-bold text-orange-700 underline underline-offset-2 transition hover:text-orange-800"
        href={brickCorrectionHref(brick.id)}
        rel="noopener"
        target="_blank"
        title={`Opens ${brick.name} on the Database Mapping page, where its area is corrected`}
      >
        Correct in database
      </a>
    </span>
  );
}

// Territory and customer picks name a brick; product picks name a product.
function isBrickPick(key: string) {
  return key.startsWith("t:") || key.startsWith("c:");
}

/** The heading over the part tabs: distributors of one template, or months of several sheets. */
function partsHeading(parts: readonly Preview[], fileCount: number): string {
  const distributors = new Set(parts.map((p) => p.distributorCode)).size;
  if (fileCount < 2) return `${parts.length} distributors in this file`;
  if (distributors === 1) return `${parts.length} months in these ${fileCount} sheets`;
  return `${parts.length} batches in these ${fileCount} sheets — one per distributor and month`;
}

/** A part's tab: its distributor, and its month when the same distributor has more than one part. */
function partTabLabel(part: Preview, parts: readonly Preview[]): string {
  const same = parts.filter((p) => p.distributorCode === part.distributorCode).length;
  return same > 1 ? `${part.distributorName} · ${part.period ?? "no month"}` : part.distributorName;
}

export function NormalizerWorkspace({ aiEnabled, distributors, references }: { aiEnabled: boolean; distributors: DistributorOption[]; references: MappingReferences }) {
  // The template is offered FIRST in the picker (the owner asked for it beside the distributors), but
  // the default selection stays a real distributor — the per-distributor path is still the daily one.
  const [distributorCode, setDistributorCode] = useState(
    distributors.find((d) => !isPhoenixTemplateCode(d.code))?.code ?? distributors[0]?.code ?? "",
  );
  // One raw sheet, or several of the same distributor chosen together (up to MAX_UPLOAD_FILES): sheets
  // of the same month are analyzed, mapped and imported as ONE part, so the month is one batch.
  const [files, setFiles] = useState<File[]>([]);
  // A filled Phoenix template may name SEVERAL distributors, so one Analyze answers with one preview
  // per distributor. `preview` is the one on screen, and everything below reads it exactly as it did
  // when a file was always a single distributor.
  const [parts, setParts] = useState<Preview[]>([]);
  const [activePart, setActivePart] = useState(0);
  const preview = parts[activePart] ?? null;
  function resetParts() { setParts([]); setActivePart(0); }
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [aiConfidence, setAiConfidence] = useState<Record<string, number>>({});
  // The brick the suggestion itself chose, kept beside the pick so a pick changed by hand can be told
  // from one left as suggested. A confidence describes THAT brick and no other.
  const [aiPick, setAiPick] = useState<Record<string, string>>({});
  const [aiOrigin, setAiOrigin] = useState<Record<string, { source: CustomerSuggestionSource; matchedFrom?: { distributorCode: string; customerCode: string; customerName: string } }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<"coded" | "map" | "ignored">("coded");
  const [advanced, setAdvanced] = useState(false);
  const [geoCoverage, setGeoCoverage] = useState<{ totalBricks: number; cached: number; success: number; mismatch: number } | null>(null);
  const [backfillHistory, setBackfillHistory] = useState(true);
  const [clusterView, setClusterView] = useState(false);
  const [clusters, setClusters] = useState<CustomerCluster[] | null>(null);
  // Bulk mapping: which unknown rows are ticked, keyed exactly like `picks` (`p:`/`t:`/`c:` + raw).
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [showAll, setShowAll] = useState<Record<UnknownKind, boolean>>({ c: false, p: false, t: false });
  const mapFileRef = useRef<HTMLInputElement>(null);
  const cleanFileRef = useRef<HTMLInputElement>(null);

  // A brick moved in another tab ("Correct in database"): reload this page's brick lists so every
  // Area shown is the one the database holds now. The file, the picks and the ticks stay as they are.
  const router = useRouter();
  useBrickMovesListener(() => router.refresh());
  const movedBricks = references.movedBricks;
  const bricksById = useMemo(() => new Map(references.bricks.map((b) => [b.id, b])), [references.bricks]);
  // A pick that names a brick kept only as history after a move follows it to the brick it moved to,
  // so the Area shown and the mapping saved are the new brick's. The suggestion's own brick follows
  // too: it is the same place under a new id, so its confidence still describes the pick. Adjusted
  // while rendering, React's pattern for state that follows a prop, rather than in an effect.
  const [followedMoves, setFollowedMoves] = useState(movedBricks);
  if (followedMoves !== movedBricks) {
    setFollowedMoves(movedBricks);
    setPicks((current) => followMovedPicks(current, movedBricks, isBrickPick));
    setAiPick((current) => followMovedPicks(current, movedBricks, isBrickPick));
  }

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

  // What the picker posted — the sentinel on the Phoenix-template path.
  const templateSelected = isPhoenixTemplateCode(distributorCode);
  // What the sheet turned out to BE. Mappings, auto-map and history mining are filed under this, so a
  // template upload teaches the real distributor's dictionary rather than a distributor that isn't.
  const effectiveDistributorCode = preview?.distributorCode || distributorCode;
  const effectiveDistributorName = preview?.distributorName
    || distributors.find((d) => d.code === distributorCode)?.name
    || distributorCode;

  // Learn, Learn from Excel and Mine history each file what they learn under ONE distributor. On the
  // template path that distributor is only known once the sheet has been read, so they wait for it
  // rather than writing a dictionary under the sentinel.
  function resolvedDistributor(): string | null {
    if (!isPhoenixTemplateCode(effectiveDistributorCode)) return effectiveDistributorCode;
    setError("Analyze the filled template first — the distributor is read off the sheet, and this saves what it learns under that distributor.");
    return null;
  }

  function fd(extra?: File) {
    const f = new FormData();
    f.set("distributorCode", distributorCode);
    // Which distributor of the file is on SCREEN. Only a Phoenix template can hold more than one,
    // and only a route that answers per distributor reads it (the unmapped list, whose Phoenix Code
    // column is learned under one distributor). The rest act on the whole file and ignore it.
    if (preview?.distributorCode) f.set("partDistributorCode", preview.distributorCode);
    if (extra) f.set("file", extra);
    else for (const chosen of files) f.append("file", chosen);
    return f;
  }

  /** The product suggestions a preview already carries, pre-ticked, and every other pick cleared. */
  function seedPicks(p: Preview) {
    const seed: Record<string, string> = {};
    p.unknownProducts.forEach((u) => { if (u.suggestionCode) seed[`p:${u.raw}`] = u.suggestionCode; });
    setPicks(seed);
    setAiConfidence({});
    setAiPick({});
    setAiOrigin({});
    setClusters(null);
    setClusterView(false);
    setSelected({});
    setShowAll({ c: false, p: false, t: false });
  }

  /**
   * Show another distributor from the same file.
   *
   * Nothing carries across: a customer CODE belongs to the distributor who issued it, so the same
   * "10025" is a different pharmacy under a different distributor. Keeping the picks or the ticks
   * would quietly offer one distributor's answers for another one's rows.
   */
  function switchPart(index: number) {
    const p = parts[index];
    if (!p) return;
    setActivePart(index);
    seedPicks(p);
    setError(null);
  }

  async function analyze(keepNotice = false, options: { quietFailure?: boolean } = {}): Promise<Preview | null> {
    if (files.length === 0) {
      if (!options.quietFailure) setError("Choose a raw distributor file first.");
      return null;
    }
    setBusy("analyze"); setError(null); if (!keepNotice) setNotice(null);
    try {
      const res = await fetch("/api/sales/normalizer/preview", { body: fd(), method: "POST" });
      const json = await res.json().catch(() => null) as { data?: { parts?: Preview[] }; error?: string; success?: boolean } | null;
      const list = json?.success ? json.data?.parts ?? [] : [];
      if (list.length > 0) {
        // Re-analyzing after a save keeps you on the distributor you were working on.
        const index = Math.min(activePart, list.length - 1);
        setParts(list);
        setActivePart(index);
        const p = list[index];
        seedPicks(p);
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
    await saveBlob(await fetch(url, { body: fd(), method: "POST" }), fallback);
  }

  async function blobGet(url: string, fallback: string) {
    await saveBlob(await fetch(url), fallback);
  }

  async function saveBlob(res: Response, fallback: string) {
    if (!res.ok) {
      // A refused download answers JSON, and that sentence is the one worth showing.
      const json = await res.json().catch(() => null) as { error?: string } | null;
      throw new Error(json?.error ?? failedStatusReason(res.status));
    }
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
    const mappings: { type: "product" | "territory" | "customer"; raw: string; code: string; distributorCode?: string; confidence?: number; name?: string; address?: string }[] = [];
    const dist = effectiveDistributorCode;
    preview.unknownProducts.forEach((u) => { const c = picks[`p:${u.raw}`]; if (c) mappings.push({ type: "product", raw: u.raw, code: c, distributorCode: dist }); });
    preview.unknownTerritories.forEach((u) => { const c = picks[`t:${u.raw}`]; if (c) mappings.push({ type: "territory", raw: u.raw, code: c, distributorCode: dist }); });
    // A customer pick carries the suggestion's confidence only while it is still the suggestion's own
    // brick, and the pharmacy's name and address travel with it so the saved mapping can teach.
    preview.unknownCustomers.forEach((u) => { const c = picks[`c:${u.raw}`]; if (c) mappings.push({ type: "customer", raw: u.raw, code: c, distributorCode: dist, confidence: shownConfidence(`c:${u.raw}`), name: u.rawName, address: u.rawAddress }); });
    if (mappings.length === 0) { setError("Pick at least one Phoenix code to save."); return; }
    setBusy("save"); setError(null); setNotice(null);
    try {
      // Sent in chunks, two at a time: a bulk assign can now carry thousands of picks, and one
      // 60-second request holding all of them (each customer mapping able to heal history behind it)
      // is exactly the shape that times out and loses the lot. A failed chunk keeps the rest saved.
      const chunks = inGroups(mappings, SAVE_CHUNK_SIZE);
      let saved = 0; let skipped = 0; let invalid = 0; let backfilled = 0;
      let failedMappings = 0; let failureReason = "";
      let doneChunks = 0;
      await inPool(chunks, 2, async (chunk) => {
        try {
          const res = await fetch("/api/sales/normalizer/mappings/save", { body: JSON.stringify({ backfill: backfillHistory, mappings: chunk }), headers: { "Content-Type": "application/json" }, method: "POST" });
          const json = await res.json().catch(() => null) as { data?: { backfilled?: number; invalid?: number; saved?: number; skipped?: number }; error?: string; success?: boolean } | null;
          if (!res.ok || !json?.success || !json.data) {
            failedMappings += chunk.length;
            failureReason = json?.error ?? failedStatusReason(res.status);
            return;
          }
          saved += Number(json.data.saved ?? 0);
          skipped += Number(json.data.skipped ?? 0);
          invalid += Number(json.data.invalid ?? 0);
          backfilled += Number(json.data.backfilled ?? 0);
        } catch (e) {
          failedMappings += chunk.length;
          failureReason = requestErrorMessage(e, "the request failed");
        } finally {
          doneChunks += 1;
          if (chunks.length > 1) setNotice(`Saving — ${Math.min(doneChunks * SAVE_CHUNK_SIZE, mappings.length).toLocaleString()} of ${mappings.length.toLocaleString()} mapping(s) sent…`);
        }
      });
      if (saved === 0 && failedMappings > 0) { setError(`Save failed for all ${failedMappings.toLocaleString()} mapping(s) — ${failureReason.replace(/\.$/, "")}.`); return; }
      const detail = [
        failedMappings ? ` ${failedMappings.toLocaleString()} could not be sent (${failureReason.replace(/\.$/, "")}) — click Save mappings again for those.` : "",
        skipped || invalid ? ` ${skipped} skipped, ${invalid} invalid.` : "",
        backfilled ? ` ${backfilled} historical row(s) healed.` : "",
      ].join("");
      setNotice(`Saved ${saved} mapping(s). Refreshing coverage...`);
      const p = await analyze(true, { quietFailure: true });
      if (p) {
        // The true totals, never the lists: those refill to 2,000 after every save while more are left.
        setNotice(`Saved ${saved} mapping(s). ${stillNeedMappingSentence(mappingLeft(p))}${detail}`);
      } else {
        setNotice(`Saved ${saved} mapping(s). Automatic coverage refresh could not complete. Click Analyze to refresh coverage.${detail}`);
      }
    } catch (e) { setError(requestErrorMessage(e, "Save failed.")); }
    finally { setBusy(null); }
  }

  // Customer suggestions carry a confidence and where they came from; both routes answer in this shape.
  // A new suggestion REPLACES the old one's confidence and origin, rather than merging over them: a
  // suggestion that carries none must not inherit the number an earlier run gave a different brick.
  function applyCustomerSuggestions(rows: CustomerSuggestionRow[]) {
    if (rows.length === 0) return;
    const newPicks: Record<string, string> = {};
    for (const s of rows) newPicks[`c:${s.raw}`] = s.code;
    setPicks((p) => ({ ...p, ...newPicks }));
    setAiPick((p) => ({ ...p, ...newPicks }));
    setAiConfidence((p) => {
      const next = { ...p };
      for (const s of rows) {
        if (typeof s.confidence === "number") next[`c:${s.raw}`] = s.confidence;
        else delete next[`c:${s.raw}`];
      }
      return next;
    });
    setAiOrigin((p) => {
      const next = { ...p };
      for (const s of rows) {
        if (s.source) next[`c:${s.raw}`] = { matchedFrom: s.matchedFrom, source: s.source };
        else delete next[`c:${s.raw}`];
      }
      return next;
    });
  }

  /** The confidence a customer row shows and saves - only while its pick is the suggestion's own brick. */
  function shownConfidence(key: string): number | undefined {
    return pickConfidence(picks[key], aiPick[key], aiConfidence[key]);
  }

  async function aiSuggestAll() {
    if (!preview) return;
    setBusy("ai"); setError(null); setNotice(null);
    try {
      let filled = 0;
      let customerSplit = "";
      const failures: string[] = [];
      // One request to the suggest route. Guard the parse: a timed-out / crashed function returns a
      // non-JSON platform page, so a bare res.json() would throw "Unexpected token 'A' … is not valid
      // JSON". Surface the real status instead.
      const post = async (body: object): Promise<{ suggestions: CustomerSuggestionRow[] } | { failed: string }> => {
        try {
          const res = await fetch("/api/sales/normalizer/mappings/ai-suggest", { body: JSON.stringify(body), headers: { "Content-Type": "application/json" }, method: "POST" });
          const json = await res.json().catch(() => null) as { success?: boolean; data?: { suggestions?: CustomerSuggestionRow[] }; error?: string } | null;
          if (!res.ok || !json?.success || !json.data) return { failed: json?.error ?? failedStatusReason(res.status) };
          return { suggestions: json.data.suggestions ?? [] };
        } catch (e) {
          return { failed: requestErrorMessage(e, "the request failed") };
        }
      };
      for (const [kind, list, prefix] of [["product", preview.unknownProducts, "p"], ["territory", preview.unknownTerritories, "t"]] as const) {
        if (list.length === 0) continue;
        const result = await post({ kind, unknowns: list.map((u) => ({ raw: u.raw, rawAddress: u.rawAddress, rawName: u.rawName, rawTerritory: u.rawTerritory })) });
        if ("failed" in result) { failures.push(`${list.length} of ${list.length} ${kind} rows — ${result.failed.replace(/\.$/, "")}`); continue; }
        filled += result.suggestions.length;
        setPicks((p) => { const n = { ...p }; result.suggestions.forEach((s) => { n[`${prefix}:${s.raw}`] = s.code; }); return n; });
      }
      const customers = preview.unknownCustomers;
      if (customers.length > 0) {
        const answered = new Set<string>();
        let free = 0; let ai = 0;
        const take = (rows: CustomerSuggestionRow[]) => {
          applyCustomerSuggestions(rows);
          for (const s of rows) { answered.add(s.raw); if (s.source === "ai") ai += 1; else free += 1; }
          filled += rows.length;
        };
        // Pass 1 — free. A group that fails here is not an error yet: pass 2 runs the free steps again.
        // Several groups are in flight at once; one failing never throws away the groups around it.
        let checked = 0;
        await inPool(inGroups(customers, CUSTOMER_FREE_REQUEST_SIZE), GROUP_CONCURRENCY, async (group) => {
          const result = await post({ freeOnly: true, kind: "customer", unknowns: group.map(customerPayload) });
          if (!("failed" in result)) take(result.suggestions);
          checked += group.length;
          setNotice(`AI suggest — free steps: ${checked.toLocaleString("en-US")} of ${customers.length.toLocaleString("en-US")} customers checked, ${free.toLocaleString("en-US")} answered…`);
        });
        // Pass 2 — the AI, for what pass 1 left.
        const forAi = customers.filter((u) => !answered.has(u.raw));
        let failedRows = 0; let reason = ""; let asked = 0;
        await inPool(packCustomersByPharmacy(forAi, CUSTOMER_AI_REQUEST_SIZE, ROUTE_MAX_CUSTOMERS), GROUP_CONCURRENCY, async (group) => {
          const result = await post({ kind: "customer", unknowns: group.map(customerPayload) });
          if ("failed" in result) { failedRows += group.length; reason = result.failed; }
          else take(result.suggestions);
          asked += group.length;
          setNotice(`AI suggest — ${free.toLocaleString("en-US")} answered free; the AI is on ${asked.toLocaleString("en-US")} of the ${forAi.length.toLocaleString("en-US")} left…`);
        });
        if (failedRows) failures.push(`${failedRows} of ${customers.length} customer rows — ${reason.replace(/\.$/, "")}`);
        customerSplit = ` Customers: ${customerSourceSplit(free, ai)}.`;
      }
      if (failures.length) setError(`AI suggest failed for ${failures.join("; ")}. Click AI suggest again to retry them.`);
      if (filled) setNotice(`AI pre-filled ${filled} suggestion(s) — review the dropdowns, fix any wrong ones, then Save.${customerSplit}`);
      else setNotice(failures.length ? null : "AI found no confident matches — map them by hand.");
    } catch (e) { setError(e instanceof Error ? e.message : "AI suggest failed."); }
    finally { setBusy(null); }
  }

  async function autoMapCustomers() {
    if (!preview || preview.unknownCustomers.length === 0) return;
    setBusy("automap"); setError(null); setNotice(null);
    try {
      const customers = preview.unknownCustomers;
      let applied = 0; let parked = 0; let backfilled = 0; let minConfidence: number | undefined;
      let failedRows = 0; let reason = "";
      const answered = new Set<string>();
      let free = 0; let ai = 0;
      // One request to the auto-map route. Each is saved and audited on its own, so a failed request
      // leaves every earlier one applied.
      const post = async (group: Unknown[], freeOnly: boolean): Promise<string | null> => {
        try {
          const res = await fetch("/api/sales/normalizer/mappings/auto-map", {
            body: JSON.stringify({ distributorCode: effectiveDistributorCode, freeOnly, unknowns: group.map(customerPayload) }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          });
          const json = await res.json().catch(() => null) as {
            data?: { applied?: CustomerSuggestionRow[]; parked?: CustomerSuggestionRow[]; backfilled?: number; minConfidence?: number };
            error?: string;
            success?: boolean;
          } | null;
          if (!res.ok || !json?.success || !json.data) return json?.error ?? failedStatusReason(res.status);
          // Parked suggestions pre-fill the dropdowns for manual review; applied ones are saved already.
          const rows = [...(json.data.applied ?? []), ...(json.data.parked ?? [])];
          applyCustomerSuggestions(rows);
          for (const s of rows) { answered.add(s.raw); if (s.source === "ai") ai += 1; else free += 1; }
          applied += json.data.applied?.length ?? 0;
          parked += json.data.parked?.length ?? 0;
          backfilled += Number(json.data.backfilled ?? 0);
          minConfidence = json.data.minConfidence ?? minConfidence;
          return null;
        } catch (e) {
          return requestErrorMessage(e, "the request failed");
        }
      };
      // Pass 1 — free. A group that fails here is not an error yet: pass 2 runs the free steps again.
      let checked = 0;
      await inPool(inGroups(customers, CUSTOMER_FREE_REQUEST_SIZE), GROUP_CONCURRENCY, async (group) => {
        await post(group, true);
        checked += group.length;
        setNotice(`Auto-map — free steps: ${checked.toLocaleString("en-US")} of ${customers.length.toLocaleString("en-US")} customers checked, ${applied.toLocaleString("en-US")} applied so far…`);
      });
      // Pass 2 — the AI, for what pass 1 left.
      const forAi = customers.filter((u) => !answered.has(u.raw));
      let asked = 0;
      await inPool(packCustomersByPharmacy(forAi, CUSTOMER_AI_REQUEST_SIZE, ROUTE_MAX_CUSTOMERS), GROUP_CONCURRENCY, async (group) => {
        const failed = await post(group, false);
        if (failed) { failedRows += group.length; reason = failed; }
        asked += group.length;
        setNotice(`Auto-map — the AI is on ${asked.toLocaleString("en-US")} of the ${forAi.length.toLocaleString("en-US")} customers the free steps left, ${applied.toLocaleString("en-US")} applied so far…`);
      });
      const healed = backfilled ? `, healed ${backfilled} historical row(s)` : "";
      const split = free + ai > 0 ? ` Suggestions: ${customerSourceSplit(free, ai)}.` : "";
      if (applied > 0) {
        setNotice(`Auto-mapped ${applied} customer(s) (gate ≥${minConfidence ?? 95}%)${healed}. ${parked} parked for your review — undo any auto-mapping from the Mapping Database page.${split} Refreshing coverage...`);
        const p = await analyze(true, { quietFailure: true });
        if (p) {
          const left = mappingLeft(p).pharmacies;
          setNotice(`Auto-mapped ${applied} customer(s)${healed}. ${left.toLocaleString("en-US")} ${left === 1 ? "pharmacy still needs" : "pharmacies still need"} manual mapping.`);
        }
      } else {
        setNotice(failedRows === customers.length ? null : `Nothing cleared the auto-map gate — ${parked} suggestion(s) pre-filled for manual review instead.${split}`);
      }
      // Set after the coverage refresh, which clears the error line.
      if (failedRows) setError(`Auto-map failed for ${failedRows} of ${customers.length} customers — ${reason.replace(/\.$/, "")}. Everything counted as applied is saved; click Auto-map again for the rest.`);
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
    // The nearest-brick chips come from the place index, which can still name a brick kept only as
    // history after a move; the pharmacies go to the brick it moved to.
    const live = followMovedBrick(brickId, movedBricks);
    if (!live) return;
    setPicks((p) => {
      const next = { ...p };
      cluster.members.forEach((m) => { next[`c:${m.raw}`] = live; });
      return next;
    });
  }

  async function learnFromCleaned(f: File) {
    const dist = resolvedDistributor();
    if (!dist) { if (cleanFileRef.current) cleanFileRef.current.value = ""; return; }
    setBusy("bootstrap"); setError(null); setNotice(null);
    try {
      const form = new FormData(); form.set("distributorCode", dist); form.set("file", f);
      const res = await fetch("/api/sales/normalizer/mappings/bootstrap", { body: form, method: "POST" });
      const json = await res.json();
      if (json.success) setNotice(`Learned ${json.data.saved} new mapping(s) from ${json.data.scannedRows.toLocaleString()} rows of the cleaned ${effectiveDistributorName} file (${json.data.skipped} already known). Re-analyze a raw file to see the higher coverage.`);
      else setError(json.error ?? "Learn failed.");
    } catch (e) { setError(e instanceof Error ? e.message : "Learn failed."); }
    finally { setBusy(null); if (cleanFileRef.current) cleanFileRef.current.value = ""; }
  }

  async function learnFromExcel(f: File) {
    const dist = resolvedDistributor();
    if (!dist) { if (mapFileRef.current) mapFileRef.current.value = ""; return; }
    setBusy("learn"); setError(null); setNotice(null);
    try {
      const form = new FormData(); form.set("file", f); form.set("distributorCode", dist);
      const res = await fetch("/api/sales/normalizer/mappings/learn", { body: form, method: "POST" });
      const json = await res.json();
      if (!json.success) { setError(json.error ?? "Learn failed."); return; }
      setNotice(`Learned ${json.data.saved} mapping(s) from Excel (${json.data.skipped} already known, ${json.data.invalid} invalid). Re-analyzing…`);
      await analyze(true);
    } catch (e) { setError(e instanceof Error ? e.message : "Learn failed."); }
    finally { setBusy(null); if (mapFileRef.current) mapFileRef.current.value = ""; }
  }

  async function mineHistory() {
    const dist = resolvedDistributor();
    if (!dist) return;
    setBusy("mine"); setError(null); setNotice(null);
    try {
      const res = await fetch("/api/sales/normalizer/mappings/learn-from-history", {
        body: JSON.stringify({ distributorCode: dist }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const json = await res.json();
      if (!json.success) { setError(json.error ?? "Mine history failed."); return; }
      setNotice(`Mined ${json.data.scannedRows.toLocaleString()} import rows — saved ${json.data.saved} new mapping(s) (${json.data.skipped} already known). Re-analyzing…`);
      if (files.length > 0) await analyze(true);
    } catch (e) { setError(e instanceof Error ? e.message : "Mine history failed."); }
    finally { setBusy(null); }
  }

  // ── Bulk mapping ───────────────────────────────────────────────────────────────────────────────
  // Everything below works on the FULL unknown list, never on the rows painted on screen.
  function keyOf(kind: UnknownKind, raw: string) { return `${kind}:${raw}`; }

  function countSelected(kind: UnknownKind) {
    let n = 0;
    for (const [k, on] of Object.entries(selected)) if (on && k.startsWith(`${kind}:`)) n += 1;
    return n;
  }

  function toggleRow(kind: UnknownKind, raw: string, on: boolean) {
    setSelected((prev) => {
      const next = { ...prev };
      if (on) next[keyOf(kind, raw)] = true;
      else delete next[keyOf(kind, raw)];
      return next;
    });
  }

  function selectAll(kind: UnknownKind, list: readonly Unknown[], on: boolean) {
    setSelected((prev) => {
      const next = { ...prev };
      for (const u of list) {
        if (on) next[keyOf(kind, u.raw)] = true;
        else delete next[keyOf(kind, u.raw)];
      }
      return next;
    });
  }

  /** One code onto every ticked row of that table — the owner's bulk map. */
  function bulkAssign(kind: UnknownKind, list: readonly Unknown[], options: { label: string; value: string }[], code: string) {
    if (!code) return;
    const keys = list.map((u) => keyOf(kind, u.raw)).filter((k) => selected[k]);
    if (keys.length === 0) { setError("Tick the rows you want to map first, or use Select all."); return; }
    setPicks((prev) => {
      const next = { ...prev };
      for (const k of keys) next[k] = code;
      return next;
    });
    setError(null);
    const label = options.find((o) => o.value === code)?.label ?? code;
    setNotice(`${keys.length.toLocaleString()} row(s) set to ${label}. Review them, then click Save mappings.`);
  }

  /** Rows painted before "Show all" — a live combo box per row makes several thousand at once unusable. */
  function visibleRows(kind: UnknownKind, list: readonly Unknown[]): Unknown[] {
    return showAll[kind] || list.length <= ROW_RENDER_LIMIT ? [...list] : list.slice(0, ROW_RENDER_LIMIT);
  }

  /** The preview caps each list, so say "N of M" rather than presenting a cut list as the whole job. */
  function unknownTotal(kind: UnknownKind, shown: number) {
    const totals = preview?.unknownTotals;
    const total = kind === "c" ? totals?.customers : kind === "p" ? totals?.products : totals?.territories;
    return typeof total === "number" && total > shown ? total : shown;
  }

  function countLabel(kind: UnknownKind, shown: number) {
    const total = unknownTotal(kind, shown);
    return total > shown ? `${shown.toLocaleString()} of ${total.toLocaleString()}` : shown.toLocaleString();
  }

  const s = preview?.summary;
  // The two buttons below act on the WHOLE file, not on the distributor showing: a template naming
  // three of them downloads one coded sheet and imports three batches in a single click. So they are
  // enabled by what the FILE can code, never by the tab you happen to be looking at.
  const fileCoded = parts.reduce((n, part) => n + part.summary.fullyCoded, 0);
  // What is really left, from the true totals: the lists stop at 2,000 and refill after every save.
  const codesLeft = preview ? mappingLeft(preview).codes : 0;
  const productOptions = [{ label: "🚫 Ignore — we don't sell this", value: "IGNORE" }, ...references.products.map((p) => ({ label: `${p.name} (${p.code})`, value: p.code }))];
  const brickOptions = references.bricks.map((b) => ({ label: b.name, value: b.id }));
  const selectClass  = phxSelectClassName;

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
              <SearchableSelect className={selectClass} disabled={busy !== null} onChange={(e) => { setDistributorCode(e.target.value); resetParts(); }} value={distributorCode}>
                {distributors.map((d) => <option key={d.code} value={d.code}>{isPhoenixTemplateCode(d.code) ? d.name : `${d.name} / ${d.code}`}</option>)}
              </SearchableSelect>
            </label>
            <label className="flex flex-col gap-1 sm:w-60">
              <span className="text-phx-2xs font-bold uppercase tracking-[0.16em] text-slate-500">Raw file(s)</span>
              <input
                accept=".xlsx,.xls"
                className="h-11 border border-slate-300 bg-white px-3 py-2 text-xs outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20"
                disabled={busy !== null}
                multiple
                onChange={(e) => {
                  const chosen = Array.from(e.target.files ?? []);
                  resetParts();
                  if (chosen.length > MAX_UPLOAD_FILES) {
                    setFiles([]);
                    e.target.value = "";
                    setError(`Choose at most ${MAX_UPLOAD_FILES} files at a time (${chosen.length} were chosen).`);
                    return;
                  }
                  setError(null);
                  setFiles(chosen);
                }}
                type="file"
              />
              {files.length > 1 ? (
                <span className="text-phx-xs text-slate-500">{files.length} sheets chosen — sheets of the same month are analyzed and imported as one batch.</span>
              ) : null}
            </label>
            <Button className="gap-2" disabled={busy !== null || files.length === 0} onClick={() => void analyze()}>
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

          {templateSelected ? (
            <div className="border border-orange-200 bg-orange-50/50">
              <div className="flex flex-wrap items-center gap-2 bg-slate-900 px-4 py-3">
                <span className="h-4 w-1 bg-orange-500" />
                <p className="text-sm font-black uppercase tracking-wide text-white">Phoenix template — one sheet for any distributor</p>
              </div>
              <div className="flex flex-wrap items-center gap-3 p-4">
                <p className="min-w-[260px] flex-1 text-xs leading-relaxed text-slate-700">
                  Download it, then pick the distributor from the dropdown inside the sheet — its code fills in by itself. Customer code, customer name, customer address, the product, the quantity and the invoice date are obligatory; the product code fills in from the product name. Two Helper columns are yours for anything you need (invoice number, branch, a note) and the system keeps them and ignores them. Fill it, choose it as the Raw file above, and click Analyze: from there it behaves exactly like a distributor’s own export, and everything it teaches is filed under the distributor named in the sheet. You may put SEVERAL distributors in one file — name the first one, fill its rows, name the next one below it — and each is mapped on its own tab here and imported as its own batch.
                </p>
                <button
                  className="inline-flex h-10 shrink-0 items-center gap-2 border border-orange-600 bg-orange-600 px-4 text-sm font-bold text-white transition hover:bg-orange-700 disabled:opacity-50"
                  disabled={busy !== null}
                  onClick={() => void run("phoenix-template", () => blobGet("/api/sales/normalizer/phoenix-template", "phoenix-sales-template.xlsx"))}
                  type="button"
                >
                  {busy === "phoenix-template" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Download the template
                </button>
              </div>
            </div>
          ) : null}

          {!preview ? (
            <AdminCallout tone="neutral"><Upload className="mt-0.5 h-4 w-4" /><p>{templateSelected
              ? "Download the template above, fill it, choose it as the Raw file and click Analyze. Nothing is saved until you choose Download or Import."
              : "Pick the distributor, choose its raw export file, and click Analyze. Nothing is saved until you choose Download or Import."}</p></AdminCallout>
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
                {parts.length > 1 ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-phx-2xs font-bold uppercase tracking-[0.16em] text-slate-500">{partsHeading(parts, files.length)}</span>
                    {parts.map((part, i) => (
                      <button
                        className={`inline-flex items-center gap-1.5 border px-2.5 py-1 text-xs font-bold transition ${i === activePart ? "border-orange-600 bg-orange-600 text-white" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"}`}
                        disabled={busy !== null}
                        key={`${part.distributorCode}|${part.period ?? ""}`}
                        onClick={() => switchPart(i)}
                        type="button"
                      >
                        {partTabLabel(part, parts)}
                        <span className={i === activePart ? "text-orange-100" : "text-slate-400"}>{part.summary.totalRows.toLocaleString()}</span>
                      </button>
                    ))}
                  </div>
                ) : templateSelected ? (
                  <div className="flex items-center gap-2">
                    <span className="text-phx-2xs font-bold uppercase tracking-[0.16em] text-slate-500">Detected distributor</span>
                    <span className="inline-flex items-center gap-1.5 border border-orange-200 bg-orange-50 px-2.5 py-1 text-xs font-bold text-orange-800"><Sparkles className="h-3.5 w-3.5 text-orange-500" />{preview.distributorName}</span>
                  </div>
                ) : null}
                <div className="flex items-center gap-2">
                  <span className="text-phx-2xs font-bold uppercase tracking-[0.16em] text-slate-500">Detected month</span>
                  <span className="inline-flex items-center gap-1.5 border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-bold text-slate-900"><CalendarDays className="h-3.5 w-3.5 text-orange-500" />{preview.period ?? "—"}</span>
                </div>
                <div className="ml-auto flex flex-col items-end gap-1">
                  <div className="flex gap-2">
                    <button className="inline-flex h-10 items-center gap-2 border border-slate-300 bg-white px-4 text-sm font-bold text-slate-700 transition hover:bg-slate-100 disabled:opacity-50" disabled={busy !== null} onClick={() => void run("download", () => blobPost("/api/sales/normalizer/download", "phoenix-coded.xlsx"))} type="button">
                      {busy === "download" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Download coded XLSX
                    </button>
                    <button className="inline-flex h-10 items-center gap-2 border border-orange-600 bg-orange-600 px-4 text-sm font-bold text-white transition hover:bg-orange-700 disabled:opacity-50" disabled={busy !== null || fileCoded === 0} onClick={() => void run("import", async () => {
                      const res = await fetch("/api/sales/normalizer/import-validated", { body: fd(), method: "POST" });
                      const json = await res.json();
                      if (json.success) {
                        const landed = (json.data?.batches ?? []) as Array<{ distributorName: string; importableRows: number }>;
                        setNotice(landed.length > 1
                          ? `Imported ${json.data.importableRows.toLocaleString()} validated row(s) for ${json.data.period ?? "—"} into Source of Sales, as ${landed.length} batches: ${landed.map((b) => `${b.distributorName} (${b.importableRows.toLocaleString()})`).join(", ")}.`
                          : `Imported ${json.data.importableRows} validated row(s) for ${json.data.period ?? "—"} into Source of Sales.`);
                      }
                      else { const reasons = (json.data?.blockingReasons ?? []) as string[]; setError(`${json.error ?? "Import failed."}${reasons.length ? " — " + reasons.slice(0, 3).join("; ") : ""}`); }
                    })} type="button">
                      {busy === "import" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Import (validated)
                    </button>
                  </div>
                  <div className="flex items-center gap-2 text-phx-xs text-slate-400">
                    <span>Download → upload on Source of Sales (it now passes validation), or import straight here.{parts.length > 1 ? ` Both cover all ${parts.length} ${files.length > 1 ? "batches of these sheets" : "distributors in this file"}.` : ""}</span>
                    <button className="underline transition hover:text-orange-600" onClick={() => setAdvanced((v) => !v)} type="button">{advanced ? "Hide advanced" : "Advanced"}</button>
                  </div>
                  {advanced ? (
                    <button className="inline-flex h-8 items-center gap-2 border border-amber-300 bg-amber-50 px-3 text-phx-xs font-semibold text-amber-800 transition hover:bg-amber-100 disabled:opacity-50" disabled={busy !== null || fileCoded === 0} onClick={() => {
                      // Writing unvalidated rows straight to Source of Sales is irreversible from here —
                      // require an explicit confirmation, not just the Advanced toggle.
                      if (!window.confirm("Direct import SKIPS Source of Sales validation and writes the coded rows straight to the database. This cannot be previewed or undone here. Proceed?")) return;
                      void run("import-direct", async () => {
                        const res = await fetch("/api/sales/normalizer/import", { body: fd(), method: "POST" });
                        const json = await res.json();
                        if (json.success) {
                          const landed = (json.data?.batches ?? []) as Array<{ distributorName: string; importedRows: number }>;
                          setNotice(landed.length > 1
                            ? `Direct import: ${json.data.importedRows.toLocaleString()} row(s) for ${json.data.period ?? "—"} as ${landed.length} batches (${landed.map((b) => b.distributorName).join(", ")}) — validation skipped.`
                            : `Direct import: ${json.data.importedRows} row(s) for ${json.data.period ?? "—"} (validation skipped).`);
                        }
                        else setError(json.error ?? "Import failed.");
                      });
                    }} title="Skips the Source of Sales validation — use only if you trust the coded rows." type="button">
                      {busy === "import-direct" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <AlertTriangle className="h-3.5 w-3.5" />} Direct import (skip validation)
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="flex gap-1 border-b border-slate-200">
                {([["coded", `Coded preview (${preview.sampleCoded.length})`], ["map", needsMappingTabLabel(preview)], ["ignored", `Ignored rows (${(preview.ignoredRows?.length ?? preview.summary.ignored).toLocaleString("en-US")})`]] as const).map(([key, label]) => (
                  <button className={cn("-mb-px border-b-2 px-3.5 py-2 text-sm font-semibold transition-colors", tab === key ? "border-orange-500 text-slate-900" : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-900")} key={key} onClick={() => setTab(key)} type="button">{label}</button>
                ))}
              </div>

              {tab === "coded" ? (
                <div className="border border-phx-line">
                  {/* Eight columns did not fit. Each id rides with its own name, and
                      Area+Region become one Territory cell, so nothing is lost. */}
                  <table className="w-full table-fixed text-sm">
                    <colgroup>
                      <col className="w-[26%]" />
                      <col className="w-[22%]" />
                      <col className="w-[16%]" />
                      <col className="w-[12%]" />
                      <col className="w-[24%]" />
                    </colgroup>
                    <thead className="bg-[#0B0B0B] text-phx-paper-2"><tr>{["Product", "Brick", "Territory", "Qty", "Customer"].map((h) => <th className="px-3 py-2 text-left" key={h}>{h}</th>)}</tr></thead>
                    <tbody>
                      {preview.sampleCoded.map((r, i) => (
                        <tr className={cn("transition-colors hover:bg-orange-50/50", i % 2 && "bg-slate-50/60")} key={i}>
                          <td className="break-words px-3 py-1.5 align-top text-slate-600">
                            <span className="block font-mono text-phx-md font-semibold text-slate-900">{r.productCode}</span>
                            <span className="block">{r.productName}</span>
                          </td>
                          <td className="break-words px-3 py-1.5 align-top text-slate-600">
                            <span className="block font-mono text-phx-md font-semibold text-slate-700">{r.brickId}</span>
                            <span className="block">{r.brickName}</span>
                          </td>
                          <td className="break-words px-3 py-1.5 align-top text-slate-600">{r.areaCode} · {r.regionCode}</td>
                          <td className="px-3 py-1.5 text-right align-top font-semibold tabular-nums text-slate-900">{r.qty.toLocaleString()}</td>
                          <td className="break-words px-3 py-1.5 align-top text-slate-600">{r.clientName ?? ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : tab === "ignored" ? (
                <NormalizerIgnoredRows ignoredCount={preview.summary.ignored} rows={preview.ignoredRows ?? []} />
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
                        <button className={cn(phxButtonApproveDenseClassName, "inline-flex h-9 items-center gap-2 border px-3 text-xs font-bold transition disabled:opacity-50")} disabled={busy !== null} onClick={() => void autoMapCustomers()} title="Apply only the suggestions that pass the multi-signal geographic gate — everything applied is listed and undoable" type="button">
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
                    <div className="border border-phx-line">
                      <p className="flex items-center gap-2 bg-slate-900 px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-white"><span className="h-3.5 w-1 shrink-0 bg-orange-500" />Unknown products ({countLabel("p", preview.unknownProducts.length)})</p>
                      <BulkAssignBar
                        assignLabel="Bulk map to"
                        busy={busy !== null}
                        onAssign={(v) => bulkAssign("p", preview.unknownProducts, productOptions, v)}
                        onSelectAll={(on) => selectAll("p", preview.unknownProducts, on)}
                        options={productOptions}
                        selectedCount={countSelected("p")}
                        total={preview.unknownProducts.length}
                      />
                      <table className="w-full table-fixed text-sm">
                        <colgroup>
                          <col className="w-[5%]" />
                          <col className="w-[18%]" />
                          <col className="w-[26%]" />
                          <col className="w-[11%]" />
                          <col className="w-[40%]" />
                        </colgroup>
                        <thead className="bg-slate-100"><tr><th className="px-2 py-2" scope="col"><span className="sr-only">Tick</span></th>{["Raw code", "Raw name", "Rows", "Phoenix product"].map((h) => <th className="px-3 py-2 text-left font-semibold text-slate-600" key={h}>{h}</th>)}</tr></thead>
                        <tbody>
                          {visibleRows("p", preview.unknownProducts).map((u) => (
                            <tr className="border-t border-slate-100 transition-colors hover:bg-orange-50/40" key={u.raw}>
                              <td className="px-2 py-1.5 align-top"><input aria-label={`Tick ${u.rawName || u.raw}`} checked={selected[`p:${u.raw}`] ?? false} className="h-3.5 w-3.5 accent-orange-600" onChange={(e) => toggleRow("p", u.raw, e.target.checked)} type="checkbox" /></td>
                              <td className="px-3 py-1.5 align-top font-semibold text-slate-900"><span className="flex items-start gap-1"><span className="min-w-0 break-words">{u.raw}</span><CopyBtn text={u.raw} /></span></td>
                              <td className="px-3 py-1.5 align-top text-slate-600"><span className="flex items-start gap-1"><span className="min-w-0 break-words">{u.rawName}</span><CopyBtn text={u.rawName} /></span></td>
                              <td className="px-3 py-1.5 text-right align-top font-semibold tabular-nums text-slate-700">{u.count.toLocaleString()}</td>
                              <td className="min-w-0 px-3 py-1.5 align-top">
                                <ComboBox onChange={(v) => setPicks((p) => ({ ...p, [`p:${u.raw}`]: v }))} options={productOptions} placeholder="Type product or code…" value={picks[`p:${u.raw}`] ?? ""} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <RowLimitFoot
                        listLength={preview.unknownProducts.length}
                        onShowAll={() => setShowAll((v) => ({ ...v, p: true }))}
                        previewTotal={unknownTotal("p", preview.unknownProducts.length)}
                        shown={visibleRows("p", preview.unknownProducts).length}
                      />
                    </div>
                  ) : null}

                  {preview.unknownTerritories.length > 0 ? (
                    <div className="border border-phx-line">
                      <p className="flex items-center gap-2 bg-slate-900 px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-white"><span className="h-3.5 w-1 shrink-0 bg-orange-500" />Unknown territories ({countLabel("t", preview.unknownTerritories.length)})</p>
                      <BulkAssignBar
                        assignLabel="Bulk map to"
                        busy={busy !== null}
                        onAssign={(v) => bulkAssign("t", preview.unknownTerritories, brickOptions, v)}
                        onSelectAll={(on) => selectAll("t", preview.unknownTerritories, on)}
                        options={brickOptions}
                        selectedCount={countSelected("t")}
                        total={preview.unknownTerritories.length}
                      />
                      <table className={stackTable}>
                        <colgroup className={stackCols}>
                          <col style={{ width: "5%" }} />
                          <col style={{ width: "31%" }} />
                          <col style={{ width: "9%" }} />
                          <col style={{ width: "32%" }} />
                          <col style={{ width: "23%" }} />
                        </colgroup>
                        <thead className={stackHead}><tr><th className="px-2 py-2" scope="col"><span className="sr-only">Tick</span></th>{["Raw territory", "Rows", "Phoenix brick", "Area"].map((h) => <th className={cn(stackHeadCell, h === "Rows" && "text-right")} key={h} scope="col">{h}</th>)}</tr></thead>
                        <tbody className={stackBody}>
                          {visibleRows("t", preview.unknownTerritories).map((u) => (
                            <tr className={stackRow} key={u.raw}>
                              <td className={stackTickCell}><RowTick checked={selected[`t:${u.raw}`] ?? false} label={u.raw} onChange={(on) => toggleRow("t", u.raw, on)} /></td>
                              <td className={cn(stackCell, "text-slate-700 [overflow-wrap:anywhere]")}><StackLabel>Raw territory</StackLabel>{u.raw}<CopyBtn text={u.raw} /></td>
                              <td className={cn(stackCell, "font-semibold tabular-nums text-slate-700 md:text-right")}><StackLabel>Rows</StackLabel>{u.count.toLocaleString()}</td>
                              <td className={stackCell}>
                                <StackLabel>Phoenix brick</StackLabel>
                                <ComboBox className="min-w-0" onChange={(v) => setPicks((p) => ({ ...p, [`t:${u.raw}`]: v }))} options={brickOptions} placeholder="Type brick id or name…" value={picks[`t:${u.raw}`] ?? ""} />
                              </td>
                              <td className={cn(stackCell, "text-xs")}>
                                <StackLabel>Area</StackLabel>
                                <BrickAreaCell brick={pickedBrick(picks[`t:${u.raw}`], bricksById, movedBricks)} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <RowLimitFoot
                        listLength={preview.unknownTerritories.length}
                        onShowAll={() => setShowAll((v) => ({ ...v, t: true }))}
                        previewTotal={unknownTotal("t", preview.unknownTerritories.length)}
                        shown={visibleRows("t", preview.unknownTerritories).length}
                      />
                    </div>
                  ) : null}

                  {preview.unknownCustomers.length > 0 ? (
                    <div className="border border-phx-line">
                      <p className="flex items-center gap-2 bg-slate-900 px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-white"><span className="h-3.5 w-1 shrink-0 bg-orange-500" />Unknown customers / pharmacies ({countLabel("c", preview.unknownCustomers.length)}) — map by pharmacy when the area text is unreliable</p>
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
                                <span className="text-sm font-bold text-slate-900 [overflow-wrap:anywhere]">{c.label}</span>
                                <span className="bg-phx-paper px-2 py-0.5 text-xs font-semibold text-phx-ink-soft">{c.members.length} pharmac{c.members.length === 1 ? "y" : "ies"}</span>
                                {c.suggestedBricks.slice(0, 3).map((s) => {
                                  // The chip names the brick, never its id, and a brick kept as history names the brick it moved to.
                                  const suggested = bricksById.get(followMovedBrick(s.brickId, movedBricks));
                                  return (
                                    <button className="border border-phx-ok-line bg-phx-ok-bg px-2 py-0.5 text-phx-xs font-bold text-phx-ok transition hover:bg-phx-ok-bg" key={s.brickId} onClick={() => assignClusterBrick(c, s.brickId)} title={s.distanceKm != null ? `~${s.distanceKm} km from cluster center — click to assign to all` : "Click to assign to all"} type="button">
                                      {suggested?.name ?? s.brickId}{s.distanceKm != null ? ` · ${s.distanceKm} km` : ""}
                                    </button>
                                  );
                                })}
                                <div className="w-full sm:w-64">
                                  <ComboBox className="min-w-0" onChange={(v) => assignClusterBrick(c, v)} options={brickOptions} placeholder="Assign brick to whole group…" value="" />
                                </div>
                              </div>
                              <div className="mt-1.5 space-y-1">
                                {c.members.map((m) => (
                                  <div className="flex flex-wrap items-start gap-2 pl-2 text-xs text-slate-600" key={m.raw}>
                                    <span className="font-mono font-semibold text-slate-800">{m.raw}</span>
                                    <span className="min-w-0 [overflow-wrap:anywhere]">{m.rawName}</span>
                                    <div className="w-full sm:ml-auto sm:w-56">
                                      <ComboBox className="min-w-0" onChange={(v) => setPicks((p) => ({ ...p, [`c:${m.raw}`]: v }))} options={brickOptions} placeholder="brick…" value={picks[`c:${m.raw}`] ?? ""} />
                                    </div>
                                    <div className="w-full sm:w-40">
                                      <BrickAreaCell brick={pickedBrick(picks[`c:${m.raw}`], bricksById, movedBricks)} />
                                    </div>
                                    {shownConfidence(`c:${m.raw}`) != null ? <ConfidenceBadge pct={shownConfidence(`c:${m.raw}`)!} /> : null}
                                  </div>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : null}
                      {!clusterView ? (
                      <>
                      <BulkAssignBar
                        assignLabel="Bulk map to"
                        busy={busy !== null}
                        onAssign={(v) => bulkAssign("c", preview.unknownCustomers, brickOptions, v)}
                        onSelectAll={(on) => selectAll("c", preview.unknownCustomers, on)}
                        options={brickOptions}
                        selectedCount={countSelected("c")}
                        total={preview.unknownCustomers.length}
                      />
                      <table className={stackTable}>
                        <colgroup className={stackCols}>
                          <col style={{ width: "4%" }} />
                          <col style={{ width: "19%" }} />
                          <col style={{ width: "21%" }} />
                          <col style={{ width: "7%" }} />
                          <col style={{ width: "22%" }} />
                          <col style={{ width: "16%" }} />
                          <col style={{ width: "11%" }} />
                        </colgroup>
                        <thead className={stackHead}><tr><th className="px-2 py-2" scope="col"><span className="sr-only">Tick</span></th>{["Customer", "Address / Territory", "Rows", "Phoenix brick", "Area", "Confidence"].map((h) => <th className={cn(stackHeadCell, h === "Rows" && "text-right", h === "Confidence" && "text-center")} key={h} scope="col">{h}</th>)}</tr></thead>
                        <tbody className={stackBody}>
                          {visibleRows("c", preview.unknownCustomers).map((u) => (
                            <tr className={stackRow} key={u.raw}>
                              <td className={stackTickCell}><RowTick checked={selected[`c:${u.raw}`] ?? false} label={u.rawName || u.raw} onChange={(on) => toggleRow("c", u.raw, on)} /></td>
                              <td className={cn(stackCell, "[overflow-wrap:anywhere]")}>
                                <StackLabel>Customer</StackLabel>
                                <span className="block font-semibold text-slate-900">{u.raw}<CopyBtn text={u.raw} /></span>
                                {u.rawName ? <span className="block text-slate-600">{u.rawName}<CopyBtn text={u.rawName} /></span> : null}
                              </td>
                              <td className={cn(stackCell, "text-xs text-slate-500 [overflow-wrap:anywhere]")}>
                                <StackLabel>Address / Territory</StackLabel>
                                {u.rawAddress ? <span className="block">{u.rawAddress}<CopyBtn text={u.rawAddress} /></span> : null}
                                {u.rawTerritory ? <span className="block text-slate-400">{u.rawTerritory}<CopyBtn text={u.rawTerritory} /></span> : null}
                                {!u.rawAddress && !u.rawTerritory ? <span className="text-slate-300">—</span> : null}
                              </td>
                              <td className={cn(stackCell, "font-semibold tabular-nums text-slate-700 md:text-right")}><StackLabel>Rows</StackLabel>{u.count.toLocaleString()}</td>
                              <td className={stackCell}>
                                <StackLabel>Phoenix brick</StackLabel>
                                <ComboBox className="min-w-0" onChange={(v) => setPicks((p) => ({ ...p, [`c:${u.raw}`]: v }))} options={brickOptions} placeholder="Type brick id or name…" value={picks[`c:${u.raw}`] ?? ""} />
                              </td>
                              <td className={cn(stackCell, "text-xs")}>
                                <StackLabel>Area</StackLabel>
                                <BrickAreaCell brick={pickedBrick(picks[`c:${u.raw}`], bricksById, movedBricks)} />
                              </td>
                              <td className={cn(stackCell, "md:text-center")}>
                                <StackLabel>Confidence</StackLabel>
                                {shownConfidence(`c:${u.raw}`) != null ? (
                                  <span className="inline-flex flex-col items-start gap-0.5 md:items-center">
                                    <ConfidenceBadge pct={shownConfidence(`c:${u.raw}`)!} />
                                    {aiOrigin[`c:${u.raw}`]?.source === "propagated" ? (
                                      <span
                                        className="inline-flex items-center gap-1 text-phx-2xs font-semibold text-violet-600"
                                        title={aiOrigin[`c:${u.raw}`]?.matchedFrom
                                          ? `Matched from ${aiOrigin[`c:${u.raw}`]!.matchedFrom!.distributorCode}/${aiOrigin[`c:${u.raw}`]!.matchedFrom!.customerCode} — ${aiOrigin[`c:${u.raw}`]!.matchedFrom!.customerName}`
                                          : "Matched from an existing mapping"}
                                      >
                                        <Layers aria-hidden="true" className="h-3 w-3" />known twin
                                      </span>
                                    ) : aiOrigin[`c:${u.raw}`]?.source === "address" ? (
                                      <span className="inline-flex items-center gap-1 text-phx-2xs font-semibold text-violet-600" title="Same address as pharmacies you already mapped">
                                        <MapPin aria-hidden="true" className="h-3 w-3" />address match
                                      </span>
                                    ) : aiOrigin[`c:${u.raw}`]?.source === "place" ? (
                                      <span className="inline-flex items-center gap-1 text-phx-2xs font-semibold text-violet-600" title="The pharmacy's name holds this brick's place name">
                                        <Signpost aria-hidden="true" className="h-3 w-3" />place in name
                                      </span>
                                    ) : null}
                                  </span>
                                ) : <span className="text-slate-300">—</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <RowLimitFoot
                        listLength={preview.unknownCustomers.length}
                        onShowAll={() => setShowAll((v) => ({ ...v, c: true }))}
                        previewTotal={unknownTotal("c", preview.unknownCustomers.length)}
                        shown={visibleRows("c", preview.unknownCustomers).length}
                      />
                      </>
                      ) : null}
                    </div>
                  ) : null}

                  {codesLeft === 0 ? <AdminCallout tone="success"><Sparkles className="mt-0.5 h-4 w-4" /><p>Everything coded — nothing to map. 🎉</p></AdminCallout> : null}
                </div>
              )}
            </>
          )}
        </div>
      </AdminTableShell>
    </div>
  );
}
