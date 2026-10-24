// Master Map — the payload the Google Apps Script pulls.
//
// Apps Script cannot hold the whole workbook: it gets six minutes per execution and the full paint
// is ~155,000 rows across fourteen tabs. So the sheet asks for a PLAN first — one line per tab, with
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
  flatShopCount,
  renderFlatRows,
  renderMasterRows,
  renderRegionRows,
  type MasterMapTree,
} from "@/lib/sales/master-map/tree";
import { loadMasterMapSource } from "@/lib/sales/master-map/load";
import { readMasterMapStamp } from "@/lib/sales/master-map/fingerprint";
import { GAPS_TAB, renderGapsSheet } from "@/lib/sales/master-map/gaps-tab";
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

/**
 * Folded into every tab's hash. The hash reads TEXT only, so a change that touches nothing but
 * formatting — a column width, a colour — would never reach a tab whose shops did not move. Bump
 * this with any such change and every tab repaints once at the next check.
 *
 * f2: the organogram region columns went from 180 to 230 because the live sheet clipped their
 * header, and All customers and Gaps would otherwise have kept the clipped width.
 * f3: All customers' Brick code column went from 100 to 150 for the same reason.
 */
export const FORMAT_VERSION = "f3";

/** How long a loaded snapshot may be reused for slices without re-checking the source. */
const CACHE_TTL_MS = 15 * 60 * 1000;

export type MasterMapTabPlan = {
  /** Widest row on this tab. The script grows the tab to fit before it writes into it. */
  columns: number;
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
  /** The plan cut from this snapshot, kept so an unchanged hour costs nothing — see the factory below. */
  plan: Promise<MasterMapPlan> | null;
  /**
   * The tabs rendered for slice requests, by `title|sheetId`, newest last and at most
   * RENDERS_KEPT of them. A repaint asks for one tab in dozens of slices, and each used to render
   * the whole tab again just to cut its piece out.
   */
  renders: Map<string, RenderedSheet | null>;
  /** Content fingerprint of every input the tree is built from — see fingerprintMasterMapSource. */
  sourceKey: string;
  stamp: string;
  tree: MasterMapTree;
};

/** What `loadMasterMapSource` hands back. The fingerprint below is typed against it, field by field. */
type LoadedSource = Awaited<ReturnType<typeof loadMasterMapSource>>;

/**
 * Let the event loop run. The web process answers every page and every button on ONE thread, so a
 * stretch of synchronous work longer than a few dozen milliseconds is a pause for everyone: the
 * hourly plan used to hold that thread for about five seconds (24 Oct 2026, nine of nine freezes
 * read in Railway's request logs landed with this request).
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Rendered tabs kept per snapshot. Two, because the script repaints one tab at a time and the
 * master tab is the big one (about 15 MB of text); a third would only hold memory nobody asks for.
 */
const RENDERS_KEPT = 2;

/** Rows hashed between two yields: about ten milliseconds of work on the customer rows. */
const FINGERPRINT_SLICE = 2_000;

/**
 * 🔴 EVERY FIELD `loadMasterMapSource` RETURNS MUST BE LISTED HERE — the type says so. A missing field
 * would be an input the tree is built from that the fingerprint cannot see, and a change in it would
 * be served from the cached plan for ever. Adding a field to the loader fails the typecheck until it
 * is added here too.
 */
const FINGERPRINTED_FIELDS: Record<keyof LoadedSource, true> = {
  areaManagers: true,
  areas: true,
  bricks: true,
  customers: true,
  distributorNames: true,
  organogramAreas: true,
  regions: true,
};

function sortedEntries(map: ReadonlyMap<string, string>): Array<[string, string]> {
  return [...map.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * One short fingerprint of everything the workbook is built from, hashed in small slices with a yield
 * between each so reading it never holds the thread.
 *
 * ORDER-SENSITIVE ON PURPOSE. If the database hands the same rows back in a different order the key
 * moves and the workbook is rebuilt — a wasted rebuild, never a stale plan. The one unordered input, the
 * distributor Map, is sorted, because its order is the order PostgREST answered in and carries no meaning.
 *
 * This is the hourly full-content comparison the sync relies on (see fingerprint.ts): it looks at the
 * rows themselves, so a hand-applied edit the cheap stamp cannot see still moves it.
 */
export async function fingerprintMasterMapSource(
  source: LoadedSource,
  pause: () => Promise<void> = yieldToEventLoop,
): Promise<string> {
  const digest = createHash("sha1");
  const fields = (Object.keys(FINGERPRINTED_FIELDS) as Array<keyof LoadedSource>).sort();
  for (const field of fields) {
    const value = source[field];
    const rows: readonly unknown[] = value instanceof Map ? sortedEntries(value) : (value as readonly unknown[]);
    digest.update(`${field}:${rows.length}\n`);
    for (let start = 0; start < rows.length; start += FINGERPRINT_SLICE) {
      digest.update(JSON.stringify(rows.slice(start, start + FINGERPRINT_SLICE)));
      await pause();
    }
  }
  return digest.digest("hex").slice(0, 16);
}

/** Every tab the sync owns, rendered on demand. */
function renderTab(workbook: CachedWorkbook, title: string, sheetId: number): RenderedSheet | null {
  // The two control tabs carry no data of their own — they are formulas over "All customers", so
  // they never need the tree and never move when a pharmacy changes.
  if (title === LOOKUP_TAB) return renderLookupSheet(sheetId);
  if (title === LISTS_TAB) return renderListsSheet(sheetId, flatShopCount(workbook.tree));

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
  if (title === GAPS_TAB) {
    return renderGapsSheet(workbook.tree, workbook.distributorName, sheetId);
  }
  // The per-region renderer STAYS, although tabTitles no longer lists one, and deliberately.
  //
  // A script mid-repaint holds a queue cut from the PREVIOUS plan, and that queue can still name a
  // region tab. Answering it with a real slice lets that run finish cleanly; returning null would
  // make the route 404, which the script treats as fatal and does not retry (see fetchJson), so the
  // one tick that straddles this change would die instead of draining.
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
 *
 * THE TEN PER-REGION TABS ARE GONE, by the owner's decision on 2026-09-28, and this is the whole
 * change: they repeated what "Master" already groups, region by region, and cost 1.4 MILLION of the
 * workbook's 10,000,000 cells — 115,741 rows across twelve columns, measured live. The master grew
 * 50,622 -> 63,510 -> 73,937 shops in six weeks, so the ceiling was roughly two months away at that
 * rate; dropping these puts the workbook at about 4.45 million and moves the ceiling out to around
 * 165,000 shops.
 *
 * Every region is still on the sheet. "Master" holds all of them, grouped and banded, and the
 * finder searches all of them. What is lost is the one-region-at-a-time view, which is why this
 * needed the owner's word rather than being a tidy-up.
 *
 * 🔴 A TITLE REMOVED FROM THIS LIST MUST ALSO BE RETIRED BY THE SCRIPT, or it is worse than leaving
 * it. Nothing in Apps Script ever deleted a tab before this change: a tab Phoenix stops serving
 * simply stops being repainted, so it sits there holding the day's data for ever, looking exactly
 * as current as the tabs beside it. `retireTabs` in Code.gs closes that, and it is the reason this
 * list is not just edited.
 */
function tabTitles(): string[] {
  return [LOOKUP_TAB, MASTER_TAB, FLAT_TAB, GAPS_TAB, LISTS_TAB];
}

/**
 * Hash the text row by row rather than joining it — the master tab's text alone is ~15 MB.
 *
 * JSON.stringify rather than a plain join, because a join loses the cell boundaries: ["ab", "c"]
 * and ["a", "bc"] would hash identically, so a pharmacy whose name had lost a character into the
 * next column would read as no change at all.
 */
export async function hashValues(
  values: readonly (readonly string[])[],
  pause: () => Promise<void>,
): Promise<string> {
  const digest = createHash("sha1");
  digest.update(FORMAT_VERSION);
  // The same bytes in the same order as hashing the whole list in one go, so no tab's hash moves — the
  // yield between slices is the whole difference.
  for (let start = 0; start < values.length; start += FINGERPRINT_SLICE) {
    const end = Math.min(start + FINGERPRINT_SLICE, values.length);
    for (let index = start; index < end; index += 1) digest.update(JSON.stringify(values[index]));
    await pause();
  }
  return digest.digest("hex").slice(0, 16);
}

/** What the payload needs from the outside world — injected so a test can run it without a database. */
export type MasterMapPayloadDeps = {
  buildTree: typeof buildMasterMapTree;
  loadSource: () => Promise<LoadedSource>;
  now: () => number;
  pause: () => Promise<void>;
  readStamp: () => Promise<string>;
};

/**
 * The plan and the slices, with their one cached snapshot.
 *
 * 🔴 AN HOUR WITH NOTHING CHANGED COSTS THE WEB PROCESS NO TREE, NO RENDER AND NO HASH. The sheet's
 * script asks for the plan once an hour whatever the stamp says (Code.gs `FULL_CHECK_EVERY_MS`, tested on
 * five-minute ticks, so every 65:00). Until 24 Oct 2026 each of those asked for a full reload and rebuild
 * of ~74,000 shops on the one thread that serves every page — a five-second freeze of the whole site, once
 * an hour, at the same second as that request. The source is still read in full every time (that is the
 * hourly content check, and it is I/O, which does not block), and fingerprinted in small slices; only when
 * the fingerprint MOVED is the tree rebuilt and the plan re-cut, and even then with a yield between steps.
 */
export function createMasterMapPayload(deps: MasterMapPayloadDeps) {
  let cached: CachedWorkbook | null = null;
  let inFlight: Promise<CachedWorkbook> | null = null;

  async function loadWorkbook(): Promise<CachedWorkbook> {
    const stamp = await deps.readStamp();
    const source = await deps.loadSource();
    const sourceKey = await fingerprintMasterMapSource(source, deps.pause);

    const previous = cached;
    if (previous && previous.sourceKey === sourceKey) {
      // Same inputs, so the same tree and the same plan. Keep everything built from them; only the stamp
      // and the age move (a slice cut under an older stamp is told to restart, exactly as before).
      const reused: CachedWorkbook = { ...previous, loadedAt: deps.now(), stamp };
      cached = reused;
      return reused;
    }

    await deps.pause();
    const workbook: CachedWorkbook = {
      distributorName: (code: string) => source.distributorNames.get(code) ?? code,
      loadedAt: deps.now(),
      plan: null,
      renders: new Map(),
      sourceKey,
      stamp,
      tree: deps.buildTree(source),
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
    if (cached && !expectedStamp && deps.now() - cached.loadedAt < CACHE_TTL_MS) {
      // Still cheap to confirm the snapshot is current before handing out a plan built from it.
      const stamp = await deps.readStamp();
      if (stamp === cached.stamp) return cached;
    }
    if (!inFlight) {
      inFlight = loadWorkbook().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  async function cutPlan(workbook: CachedWorkbook): Promise<MasterMapPlan> {
    const tabs: MasterMapTabPlan[] = [];
    for (const title of tabTitles()) {
      await deps.pause();
      // sheetId 0 is a placeholder — the plan needs only the text, never the formatting requests,
      // and the real tab id is supplied by the caller when it comes back for the slices.
      const rendered = renderTab(workbook, title, 0);
      if (!rendered) continue;
      tabs.push({
        columns: rendered.values.reduce((widest, row) => Math.max(widest, row.length), 1),
        hash: await hashValues(rendered.values, deps.pause),
        requestChunks: Math.ceil(rendered.requests.length / REQUESTS_PER_CHUNK),
        rows: rendered.values.length,
        title,
        valueChunks: Math.ceil(rendered.values.length / VALUES_PER_CHUNK),
      });
    }
    return { generatedAt: new Date(deps.now()).toISOString(), stamp: workbook.stamp, tabs };
  }

  async function getMasterMapPlan(): Promise<MasterMapPlan> {
    const workbook = await getWorkbook(null);
    if (!workbook.plan) {
      // Shared by concurrent callers, and dropped on a failure so the next call tries again.
      const planning = cutPlan(workbook);
      workbook.plan = planning;
      planning.catch(() => {
        if (workbook.plan === planning) workbook.plan = null;
      });
    }
    const plan = await workbook.plan;
    // The tabs are the snapshot's; the stamp and the time are this answer's.
    return { ...plan, generatedAt: new Date(deps.now()).toISOString(), stamp: workbook.stamp };
  }

  /**
   * The tab as the slices see it, rendered once per snapshot and tab id. The render is a pure
   * function of the tree and the sheet id, so a kept one is the same answer; a new snapshot starts
   * with an empty map, so a changed tree is never answered from an old render.
   */
  function renderedForSlices(workbook: CachedWorkbook, title: string, sheetId: number): RenderedSheet | null {
    const key = `${title}\u001F${sheetId}`;
    if (workbook.renders.has(key)) {
      const kept = workbook.renders.get(key) ?? null;
      workbook.renders.delete(key);
      workbook.renders.set(key, kept);
      return kept;
    }
    const rendered = renderTab(workbook, title, sheetId);
    workbook.renders.set(key, rendered);
    while (workbook.renders.size > RENDERS_KEPT) {
      const oldest = workbook.renders.keys().next().value;
      if (oldest === undefined) break;
      workbook.renders.delete(oldest);
    }
    return rendered;
  }

  async function getMasterMapSlice(options: {
    chunk: number;
    part: MasterMapPart;
    sheetId: number;
    stamp: string;
    title: string;
  }): Promise<MasterMapSlice | null> {
    const workbook = await getWorkbook(options.stamp);
    const restart = workbook.stamp !== options.stamp;

    const rendered = renderedForSlices(workbook, options.title, options.sheetId);
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

  return { getMasterMapPlan, getMasterMapSlice };
}

const payload = createMasterMapPayload({
  buildTree: buildMasterMapTree,
  loadSource: loadMasterMapSource,
  now: () => Date.now(),
  pause: yieldToEventLoop,
  readStamp: readMasterMapStamp,
});

export const getMasterMapPlan = payload.getMasterMapPlan;
export const getMasterMapSlice = payload.getMasterMapSlice;
