// Master Map — the payload the Google Apps Script pulls.
//
// Apps Script cannot hold the whole workbook: it gets six minutes per execution and the full paint
// is ~155,000 rows across eleven tabs. So the sheet asks for a PLAN first — one line per tab, with
// a content hash — repaints only the tabs whose hash actually moved, and pulls each of those in
// slices small enough to finish.
//
// TWO THINGS THIS FILE EXISTS TO PREVENT:
//
// 1. Reloading the database once per slice. A tab can take a dozen requests; loading 52,614 rows
//    for each of them would turn a five-second sync into a minute of Atlantic round trips. The
//    loaded tree is cached and every slice of a repaint is served from that one snapshot.
//
// 2. Stitching one tab together out of two different snapshots. Every slice carries the stamp it
//    was cut from. If the data moves mid-repaint the server says so instead of quietly handing
//    back rows that never coexisted, and the script starts that tab again.

import { createHash } from "node:crypto";

import {
  MASTER_MAP_FLAT_COLUMNS,
  buildMasterMapTree,
  renderFlatRows,
  renderMasterRows,
  renderRegionRows,
  type MasterMapTree,
} from "@/lib/sales/master-map/tree";
import { loadMasterMapSource } from "@/lib/sales/master-map/load";
import { readMasterMapStamp } from "@/lib/sales/master-map/fingerprint";
import {
  LISTS_TAB,
  LOOKUP_TAB,
  renderListsSheet,
  renderLookupSheet,
} from "@/lib/sales/master-map/lookup-tab";
import {
  renderFlatSheet,
  renderSheet,
  rgb,
  tabColorFor,
  type RenderedSheet,
} from "@/lib/sales/master-map/sheet-render";
import { FLAT_TAB, MASTER_TAB } from "@/lib/sales/master-map/sync";

/** Google rejects an oversized write, and Apps Script runs out of memory well before that. */
const VALUES_PER_CHUNK = 4_000;
const REQUESTS_PER_CHUNK = 300;

/** How long a loaded snapshot may be reused for slices without re-checking the source. */
const CACHE_TTL_MS = 15 * 60 * 1000;

export type MasterMapTabPlan = {
  /** Content hash of this tab's text. The sheet repaints only when this moves. */
  hash: string;
  requestChunks: number;
  rows: number;
  title: string;
  valueChunks: number;
};

export type MasterMapPlan = {
  generatedAt: string;
  stamp: string;
  tabs: MasterMapTabPlan[];
};

/** The three phases of painting a tab, in the order they must be applied. */
export type MasterMapPart = "clear" | "values" | "requests";

export type MasterMapSlice = {
  /** True when the source moved since the plan was cut — the caller must restart this tab. */
  restart: boolean;
  stamp: string;
} & (
  | { part: "clear" | "requests"; requests: unknown[] }
  | { part: "values"; startRow: number; values: string[][] }
);

type CachedWorkbook = {
  distributorName: (code: string) => string;
  loadedAt: number;
  stamp: string;
  tree: MasterMapTree;
};

let cached: CachedWorkbook | null = null;
let inFlight: Promise<CachedWorkbook> | null = null;

async function loadWorkbook(): Promise<CachedWorkbook> {
  const stamp = await readMasterMapStamp();
  const source = await loadMasterMapSource();
  const workbook: CachedWorkbook = {
    distributorName: (code: string) => source.distributorNames.get(code) ?? code,
    loadedAt: Date.now(),
    stamp,
    tree: buildMasterMapTree(source),
  };
  cached = workbook;
  return workbook;
}

/**
 * The current snapshot, reloaded only when it has to be.
 *
 * Concurrent callers share one load — otherwise the first burst of slice requests after a change
 * would each start their own pass over the crosswalk.
 */
async function getWorkbook(expectedStamp: string | null): Promise<CachedWorkbook> {
  if (cached && expectedStamp && cached.stamp === expectedStamp) return cached;
  if (cached && !expectedStamp && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
    // Still cheap to confirm the snapshot is current before handing out a plan built from it.
    const stamp = await readMasterMapStamp();
    if (stamp === cached.stamp) return cached;
  }
  if (!inFlight) {
    inFlight = loadWorkbook().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

/** Every tab the sync owns, rendered on demand. */
function renderTab(workbook: CachedWorkbook, title: string, sheetId: number): RenderedSheet | null {
  // The two control tabs carry no data of their own — they are formulas over "All customers", so
  // they never need the tree and never move when a pharmacy changes.
  if (title === LOOKUP_TAB) return renderLookupSheet(sheetId);
  if (title === LISTS_TAB) return renderListsSheet(sheetId);

  if (title === MASTER_TAB) {
    return renderSheet(renderMasterRows(workbook.tree, workbook.distributorName), sheetId, {
      tabColor: rgb(15, 23, 42),
    });
  }
  if (title === FLAT_TAB) {
    return renderFlatSheet(
      MASTER_MAP_FLAT_COLUMNS,
      renderFlatRows(workbook.tree, workbook.distributorName),
      sheetId,
      { tabColor: rgb(71, 85, 105) },
    );
  }
  const region = workbook.tree.regions.find((candidate) => candidate.regionName === title);
  if (!region) return null;
  return renderSheet(renderRegionRows(region, workbook.distributorName), sheetId, {
    tabColor: tabColorFor(title),
  });
}

/**
 * Tab titles in reading order — the same order the sync writes them in.
 *
 * "Find a pharmacy" leads because it is the one tab that answers a question rather than storing
 * an answer. "Lists" trails because it is hidden plumbing, and it must come AFTER the flat tab it
 * reads: on a first run the tabs are created in this order, and its formulas resolve to #REF!
 * until "All customers" exists.
 */
function tabTitles(workbook: CachedWorkbook): string[] {
  return [
    LOOKUP_TAB,
    MASTER_TAB,
    FLAT_TAB,
    ...workbook.tree.regions.map((region) => region.regionName),
    LISTS_TAB,
  ];
}

/**
 * Hash the text row by row rather than joining it — the master tab's text alone is ~15 MB.
 *
 * JSON.stringify rather than a plain join, because a join loses the cell boundaries: ["ab", "c"]
 * and ["a", "bc"] would hash identically, so a pharmacy whose name had lost a character into the
 * next column would read as no change at all.
 */
function hashValues(values: readonly (readonly string[])[]): string {
  const digest = createHash("sha1");
  for (const row of values) {
    digest.update(JSON.stringify(row));
  }
  return digest.digest("hex").slice(0, 16);
}

export async function getMasterMapPlan(): Promise<MasterMapPlan> {
  const workbook = await getWorkbook(null);
  const tabs: MasterMapTabPlan[] = [];

  for (const title of tabTitles(workbook)) {
    // sheetId 0 is a placeholder — the plan needs only the text, never the formatting requests,
    // and the real tab id is supplied by the caller when it comes back for the slices.
    const rendered = renderTab(workbook, title, 0);
    if (!rendered) continue;
    tabs.push({
      hash: hashValues(rendered.values),
      requestChunks: Math.ceil(rendered.requests.length / REQUESTS_PER_CHUNK),
      rows: rendered.values.length,
      title,
      valueChunks: Math.ceil(rendered.values.length / VALUES_PER_CHUNK),
    });
  }

  return { generatedAt: new Date().toISOString(), stamp: workbook.stamp, tabs };
}

export async function getMasterMapSlice(options: {
  chunk: number;
  part: MasterMapPart;
  sheetId: number;
  stamp: string;
  title: string;
}): Promise<MasterMapSlice | null> {
  const workbook = await getWorkbook(options.stamp);
  const restart = workbook.stamp !== options.stamp;

  const rendered = renderTab(workbook, options.title, options.sheetId);
  if (!rendered) return null;

  // The clear is small and never chunked — it is two requests at most.
  if (options.part === "clear") {
    return { part: "clear", requests: rendered.clearRequests, restart, stamp: workbook.stamp };
  }

  if (options.part === "requests") {
    const start = options.chunk * REQUESTS_PER_CHUNK;
    return {
      part: "requests",
      requests: rendered.requests.slice(start, start + REQUESTS_PER_CHUNK),
      restart,
      stamp: workbook.stamp,
    };
  }

  const start = options.chunk * VALUES_PER_CHUNK;
  return {
    part: "values",
    restart,
    stamp: workbook.stamp,
    startRow: start,
    values: rendered.values.slice(start, start + VALUES_PER_CHUNK),
  };
}
