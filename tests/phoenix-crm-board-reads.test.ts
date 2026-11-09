import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { repDoctorListRepKey } from "../src/lib/crm/rep-doctor-lists.ts";
import { panelAssignmentFromTuple, toPanelContactRecord } from "../src/lib/crm/rep-kpi-reports-data.ts";
import { brickMetaFromTuple, checkinRowFromTuple, foldCheckinRows } from "../src/lib/crm/reps-list.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM board reads in ONE statement (1 Nov 2026 — the speed root cause).
 *
 * Measured that day: every read costs about 450 ms at Supabase's edge for 2-7 ms of SQL on the saturated
 * 2-core host, so the number of REQUESTS behind a page is what a rep waits for. Three readers of the Reps
 * List / My List board and the KPI boards asked in waves of chunked requests what one statement answers:
 *   1. `loadPanelRows` — every open `crm_contact_assignments` row (14,440), fifteen parallel OFFSET pages on
 *      every KPI open: 5,488 pages a day, the heaviest statement on the database.
 *   2. `loadBrickMeta` — the bricks, then their areas, then the regions: three waves of chunked reads.
 *   3. `loadCheckins` — each chunk of fifty contacts walked through the union view by keyset.
 * Each now asks ONE function (migration 20261102010000) and keeps its page walk only for a database the
 * function has not reached (PGRST202). The region -> brick map and the trade counterparties, read whole on
 * every board open, are shared copies dropped by the writes that change them; the KPI panel's rows are
 * shared only by a caller that opts in. The List and Add Visit mint reference customers through the
 * planners' five-minute throttle; the unvalidated-visit counts read four chunks at a time; and the three
 * routes answer with Server-Timing. The IO is pinned on the source; the mappers are pure and pinned on
 * behaviour. Every source assertion reads comment-stripped text.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const code = (path: string) => stripComments(read(path)).replace(/\r\n/g, "\n");

export const BOARD_READS_MIGRATION = "supabase/migrations/20261102010000_phx_crm_board_reads_in_one_statement.sql";

/** The three functions, with the argument list each is declared and granted with. */
export const BOARD_READ_FUNCTIONS = [
  { args: "()", name: "phx_crm_open_assignments", params: "()" },
  { args: "(text[])", name: "phx_crm_brick_meta", params: "(p_brick_ids text[])" },
  { args: "(bigint[])", name: "phx_crm_contact_checkins", params: "(p_contact_ids bigint[])" },
] as const;

/** The three routes that gained Server-Timing, with their labels. */
export const BOARD_TIMED_ROUTES = [
  { file: "app/api/phoenix-crm/list/route.ts", label: "crm_list" },
  { file: "app/api/phoenix-crm/list/board/route.ts", label: "crm_list_board" },
  { file: "app/api/phoenix-crm/visits/form/route.ts", label: "crm_visit_form" },
] as const;

/** The body of a top-level function, from its declaration to the first close at column zero. */
function functionBody(text: string, declaration: string): string {
  const start = text.indexOf(declaration);
  assert.ok(start >= 0, `${declaration} must still exist`);
  const rest = text.slice(start);
  const end = rest.indexOf("\n}\n");
  return rest.slice(0, end > 0 ? end : rest.length);
}

/** `first` appears, `second` appears, and `first` comes before `second`. */
function assertBefore(text: string, first: string, second: string, message: string): void {
  const a = text.indexOf(first);
  const b = text.indexOf(second);
  assert.ok(a >= 0, `${message} — missing: ${first}`);
  assert.ok(b >= 0, `${message} — missing: ${second}`);
  assert.ok(a < b, message);
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** One function's `create or replace … $$;` block of the migration. */
export function migrationFunctionBlock(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}`);
  assert.ok(start >= 0, `${name} is created by the migration`);
  const end = sql.indexOf("$$;", start);
  assert.ok(end > start, `${name} is closed`);
  return sql.slice(start, end);
}

export function runPhoenixCrmBoardReadsTests(): void {
  // ── 1. The migration: three functions, one jsonb value each, the service role's alone ───────────────
  {
    const sql = read(BOARD_READS_MIGRATION);
    for (const { args, name, params } of BOARD_READ_FUNCTIONS) {
      const block = migrationFunctionBlock(sql, name);
      assert.ok(block.startsWith(`create or replace function public.${name}${params}`), `${name} takes exactly ${params}`);
      assert.match(block, /\nreturns jsonb\n/, `${name} returns ONE jsonb value — PostgREST's 1,000-row cap applies to a set too`);
      assert.match(block, /\nstable\n/, `${name} is stable`);
      assert.match(block, /\nsecurity definer\nset search_path to 'public'\n/, `${name} is security definer with search_path pinned`);
      assert.match(block, /coalesce\(\s*jsonb_agg\(/, `${name} aggregates to an array`);
      assert.match(block, /'\[\]'::jsonb/, `${name} answers an empty array, never null`);
      assert.ok(sql.includes(`revoke execute on function public.${name}${args} from public, anon, authenticated;`), `${name} is revoked from the browser roles`);
      assert.ok(sql.includes(`grant execute on function public.${name}${args} to service_role;`), `${name} is the service role's alone`);
      assert.ok(sql.includes(`comment on function public.${name}${args} is`), `${name} says what it is for`);
    }
    const open = migrationFunctionBlock(sql, "phx_crm_open_assignments");
    assert.match(open, /jsonb_build_array\(a\.id, a\.agent_crm_id, a\.agent_hr_id, a\.contact_crm_id, a\.grade, a\.list_type\)/, "the open assignments carry the page walk's six columns in its order");
    assert.match(open, /order by a\.id\s*\)/, "ordered by id — the page walk's order");
    assert.match(open, /where a\.effective_to is null;/, "the open periods only: a closed period is a doctor the rep no longer holds");
    const bricks = migrationFunctionBlock(sql, "phx_crm_brick_meta");
    assert.match(bricks, /jsonb_build_array\(b\.brick_id, b\.brick_name, b\.area_code, a\.area_name, r\.region_name\)/, "the brick's five fields in the mapper's order");
    assert.match(bricks, /left join public\.source_of_sales_areas a on a\.area_code = b\.area_code/, "the area is a LEFT join — a brick with no area row still names itself");
    assert.match(bricks, /on r\.region_code = coalesce\(nullif\(btrim\(a\.region_code\), ''\), nullif\(btrim\(b\.region_code\), ''\)\)/, "the area's region code first, else the brick's own — the three-wave read's fall-through");
    assert.match(bricks, /and b\.active is distinct from false;/, "a retired brick is left out, as the walk left it");
    const checkins = migrationFunctionBlock(sql, "phx_crm_contact_checkins");
    assert.match(checkins, /jsonb_build_array\(c\.contact_crm_id, c\.agent_crm_id, c\.agent_hr_id, c\.lat, c\.lon, c\.address, c\.check_date\)/, "the check-in's seven fields in the mapper's order");
    assert.match(checkins, /order by c\.check_date desc, c\.crm_checkin_id desc/, "newest first, the check-in id breaking a tie — the walk's order, so the first row seen is the pin");
    assert.match(checkins, /where c\.source = 'ireports360'/, "iReports360 check-ins only — a Phoenix visit's position never reaches a rep's screen (golden rule #1)");
    assert.match(checkins, /and c\.contact_crm_id = any \(coalesce\(p_contact_ids, '\{\}'::bigint\[\]\)\)/, "the contact ids are the PARAMETER — an array_agg sublink planned a 346 ms full scan");
    assert.match(checkins, /and c\.lat is not null\s+and c\.lon is not null;/, "a check-in with no pin is skipped outright, as the walk skipped it");
    for (const { name } of BOARD_READ_FUNCTIONS) {
      assert.doesNotMatch(migrationFunctionBlock(sql, name), /array_agg/, `${name} has no array_agg sublink — the header records why`);
    }
    assert.match(sql, /\nset local lock_timeout = '5s';\n/, "the migration waits five seconds for a lock, never a working day");
    assert.match(sql, /\nnotify pgrst, 'reload schema';\n/, "PostgREST learns the functions at once");
    assert.match(sql, /-- ROLLBACK:\n(--   drop function if exists public\.phx_crm_\w+\([a-z\[\]]*\);\n){3}/, "the header says how to take all three back");
  }

  // ── 2. The readers ask the function, fold its tuples, and fall back only on a missing function ──────
  {
    const repsList = code("src/lib/crm/reps-list.ts");
    assert.match(repsList, /const CONTACT_CHECKINS_RPC = "phx_crm_contact_checkins";/, "loadCheckins names its function");
    const checkins = functionBody(repsList, "export async function loadCheckins(");
    assert.match(checkins, /if \(ids\.length === 0\) return new Map\(\);/, "no contacts, no request");
    assert.match(checkins, /\.rpc\(CONTACT_CHECKINS_RPC, \{ p_contact_ids: ids \}\)/, "loadCheckins asks the function with the distinct contact ids as its parameter");
    assert.match(checkins, /if \(isMissingCrmRpcError\(error\)\) return loadCheckinsByPages\(ids\);/, "only a missing function falls back to the walk");
    assert.match(checkins, /if \(isCrmSchemaMissingError\(error\)\) return new Map\(\);/, "a missing check-in table costs the observed address and nothing else");
    assert.match(checkins, /return foldCheckinRows\(\(\(Array\.isArray\(data\) \? data : \[\]\) as CheckinTuple\[\]\)\.map\(checkinRowFromTuple\)\);/, "the function's tuples go through the one mapper and the one fold");
    assert.doesNotMatch(checkins, /\.from\(CRM_CHECKINS_UNIFIED_VIEW\)/, "loadCheckins itself never walks the view");
    assertBefore(repsList, "export async function loadCheckins(", "async function loadCheckinsByPages(", "the walk is declared after the reader it serves");
    const walk = functionBody(repsList, "async function loadCheckinsByPages(");
    assert.match(walk, /const answers = await mapWithConcurrency\(inChunks\(ids\), CHUNK_CONCURRENCY, readChunk\);/, "the walk still reads its chunks a few at a time");
    assert.match(walk, /const byContact = foldCheckinRows\(rows\);/, "and folds through the same fold");
    assert.match(walk, /if \(isCrmSchemaMissingError\(failure\)\) return byContact;/, "and meets a failed chunk exactly where the old serial loop did");

    assert.match(repsList, /const BRICK_META_RPC = "phx_crm_brick_meta";/, "loadBrickMeta names its function");
    const brickMeta = functionBody(repsList, "async function loadBrickMeta(");
    assert.match(brickMeta, /if \(brickIds\.length === 0\) return meta;/, "no bricks, no request");
    assert.match(brickMeta, /\.rpc\(BRICK_META_RPC, \{ p_brick_ids: \[\.\.\.new Set\(brickIds\)\] \}\)/, "loadBrickMeta asks the function with the distinct brick ids");
    assert.match(brickMeta, /if \(isMissingCrmRpcError\(error\)\) return loadBrickMetaByPages\(brickIds\);/, "only a missing function falls back to the three-wave walk");
    assert.match(brickMeta, /const \[brickId, entry\] = brickMetaFromTuple\(tuple\);\s*if \(!meta\.has\(brickId\)\) meta\.set\(brickId, entry\);/, "every tuple goes through the one mapper, the first seen winning");
    assert.doesNotMatch(brickMeta, /loadAreaNames\(|loadRegionNames\(/, "loadBrickMeta no longer chains the areas and the regions");
    const brickWalk = functionBody(repsList, "async function loadBrickMetaByPages(");
    assert.match(brickWalk, /const areas = await loadAreaNames\(/, "the walk keeps the three-wave read");
    assert.match(brickWalk, /if \(row\.active === false\) continue;/, "and leaves a retired brick out, as the function does");

    const regionMap = functionBody(repsList, "async function loadRegionBrickMap(");
    assert.match(regionMap, /await getOrLoadShared\(CRM_REGION_BRICK_MAP, "mapped", readRegionBrickMap, REGION_BRICK_MAP_LIMITS\);/, "the region -> brick map is a shared copy");
    assert.match(regionMap, /if \(!map\.has\(row\.key\)\) map\.set\(row\.key, row\.brickId\);/, "the first mapping seen for a key wins, as the page walk folded it");
    const regionRead = functionBody(repsList, "async function readRegionBrickMap(");
    assert.match(regionRead, /if \(isCrmSchemaMissingError\(error\)\) return null;/, "a missing mapping table is never stored");
    assert.match(regionRead, /\.eq\("status", "mapped"\)/, "mapped rows only, as before");
    assert.match(repsList, /import \{ CRM_CONTACT_ROSTER, CRM_REGION_BRICK_MAP \} from "@\/lib\/crm\/shared-windows";/, "the namespace comes from the shared windows, beside the roster's");

    const trade = code("src/lib/crm/contact-trade.ts");
    const counterparties = functionBody(trade, "export async function loadTradeCounterparties(");
    assert.match(counterparties, /await getOrLoadShared\(CRM_TRADE_COUNTERPARTIES, "all", readTradeCounterparties, TRADE_COUNTERPARTIES_LIMITS\);/, "the trade counterparties are a shared copy");
    assert.match(counterparties, /return rows \?\? \[\];/, "a source that is missing answers an empty board, as before");
    assertBefore(trade, "export async function loadTradeCounterparties(", "async function readTradeCounterparties(): Promise<TradeCounterparty[]> {", "the six reads are the copy's loader, declared after the wrapper");
    const tradeRead = functionBody(trade, "async function readTradeCounterparties(");
    assert.equal(count(tradeRead, "supabase.from("), 5, "the loader's five direct reads, plus the shared areas — unchanged");

    const panel = code("src/lib/crm/rep-kpi-reports-data.ts");
    assert.match(panel, /const OPEN_ASSIGNMENTS_RPC = "phx_crm_open_assignments";/, "loadPanelRows names its function");
    const loadPanel = functionBody(panel, "export async function loadPanelRows(");
    assert.match(loadPanel, /if \(options\.reuseRecentWindow !== true\) return readPanelRows\(\);/, "a caller that did not opt in reads live");
    assert.match(loadPanel, /await getOrLoadShared\(CRM_OPEN_ASSIGNMENTS, "open", readPanelRows, OPEN_ASSIGNMENTS_LIMITS\);/, "an opted-in display board shares the minute-old copy");
    const readPanel = functionBody(panel, "async function readPanelRows(");
    assert.match(readPanel, /\.rpc\(OPEN_ASSIGNMENTS_RPC\)/, "the panel asks the function");
    assert.match(readPanel, /if \(isMissingCrmRpcError\(error\)\) return readPanelRowsByPages\(\);/, "only a missing function falls back to the page walk");
    assert.match(readPanel, /\.map\(\(tuple\) => toPanelContactRecord\(panelAssignmentFromTuple\(tuple\)\)\)/, "every tuple goes through the one grade mapper");
    const pages = functionBody(panel, "async function readPanelRowsByPages(");
    assert.match(pages, /\.range\(page \* PAGE_SIZE, page \* PAGE_SIZE \+ PAGE_SIZE - 1\)/, "the page walk is kept for a database without the function");
    assert.match(panel, /loadPanelRows\(\{ reuseRecentWindow: input\.reuseRecentWindow === true \}\),/, "loadRepKpiReports shares the copy only when its caller opted in");
    const phoenixKpis = code("src/lib/crm/phoenix-kpi-data.ts");
    assert.match(phoenixKpis, /loadPanelRows\(\{ reuseRecentWindow \}\),/, "loadPhoenixRepKpis passes its own opt-in through");
    // The system audit reads the open assignments live: no file of it opts in.
    const auditDir = new URL("../src/lib/system-audit/", import.meta.url);
    const auditFiles = readdirSync(auditDir, { recursive: true }).map(String).filter((name) => name.endsWith(".ts"));
    const auditReaders = auditFiles.filter((name) => /loadPhoenixRepKpis\(|loadRepKpiReports\(/.test(readFileSync(new URL(name.replace(/\\/g, "/"), auditDir), "utf8")));
    assert.ok(auditReaders.length > 0, "the system audit reads the KPI loaders somewhere (detectors/visit-lifecycle.ts)");
    for (const name of auditReaders) {
      assert.doesNotMatch(stripComments(readFileSync(new URL(name.replace(/\\/g, "/"), auditDir), "utf8")), /reuseRecentWindow: true/, `src/lib/system-audit/${name} reads the open assignments live`);
    }
  }

  // ── 3. The shared windows, and the writes that drop them ──────────────────────────────────────────
  {
    const windows = code("src/lib/crm/shared-windows.ts");
    assert.match(windows, /export const CRM_REGION_BRICK_MAP = "crm:region-brick-map";/, "the region -> brick map has a namespace");
    assert.match(windows, /export const CRM_TRADE_COUNTERPARTIES = "crm:trade-counterparties";/, "the trade counterparties have a namespace");
    assert.match(windows, /export const CRM_OPEN_ASSIGNMENTS = "crm:open-assignments";/, "the open assignments have a namespace");
    const roster = functionBody(windows, "export function refreshSharedContactRoster(");
    assert.match(roster, /bumpSharedReadGeneration\(CRM_CONTACT_ROSTER, reason\);/, "an applied list change still drops the roster");
    assert.match(roster, /bumpSharedReadGeneration\(CRM_OPEN_ASSIGNMENTS, reason\);/, "and drops the KPI panel's copy with it — the same table, the same filter");
    assert.match(functionBody(windows, "export function refreshSharedRegionBrickMap("), /bumpSharedReadGeneration\(CRM_REGION_BRICK_MAP, reason\);/, "the region map's refresh drops its namespace");
    assert.match(functionBody(windows, "export function refreshSharedTradeCounterparties("), /bumpSharedReadGeneration\(CRM_TRADE_COUNTERPARTIES, reason\);/, "the counterparties' refresh drops its namespace");

    const regionBrick = code("src/lib/crm/region-brick.ts");
    const resolution = functionBody(regionBrick, "export async function setCrmRegionBrickResolution(");
    assertBefore(resolution, 'refreshSharedRegionBrickMap("crm region mapping saved");', "return { areaId: resolvedAreaId", "a saved mapping drops the shared map before it answers");
    assertBefore(resolution, "if (upsertError) throw new Error(upsertError.message);", 'refreshSharedRegionBrickMap("crm region mapping saved");', "and only once the row is written");
    const bulk = functionBody(regionBrick, "export async function bulkImportCrmRegionBrickMappings(");
    assertBefore(bulk, 'if (upserts.length > 0) refreshSharedRegionBrickMap("crm region mappings imported");', "return { blockedRows, ignored, mapped, skipped", "an import that wrote rows drops the shared map before it answers");

    const orders = code("src/lib/direct-orders/service.ts");
    assert.equal(count(orders, 'refreshSharedTradeCounterparties("direct order submitted");'), 1, "a submitted direct order drops the counterparties");
    assert.equal(count(orders, 'refreshSharedTradeCounterparties("direct order decided");'), 1, "a decided direct order drops the counterparties");
    assertBefore(orders, 'invalidateFinanceDashboardCache("direct order submitted");', 'refreshSharedTradeCounterparties("direct order submitted");', "beside the finance landing's own invalidation");
    assertBefore(orders, 'invalidateFinanceDashboardCache("direct order decided");', 'refreshSharedTradeCounterparties("direct order decided");', "beside the finance landing's own invalidation");
    const marketing = code("src/lib/marketing-requests/service.ts");
    assert.equal(count(marketing, 'refreshSharedTradeCounterparties("marketing request step decided");'), 1, "a decided marketing step drops the counterparties");
    assertBefore(marketing, 'invalidateFinanceDashboardCache("marketing request step decided");', 'refreshSharedTradeCounterparties("marketing request step decided");', "beside the finance landing's own invalidation");
    assertBefore(marketing, 'refreshSharedTradeCounterparties("marketing request submitted");', 'pingMarketingRequestSheet("request_submitted");', "a submitted request drops the copy before the sheet is pinged");
  }

  // ── 4. The List and Add Visit mint through the throttle; the unvalidated counts read four chunks at a time ──
  {
    const list = code("src/lib/phoenix-crm/server/list.ts");
    const territoryList = functionBody(list, "export async function loadTerritoryList(");
    // Through the read-side wrapper (2026-11-09): a test login reading a real territory mints nothing.
    assert.match(territoryList, /const ensured = ensureReferenceCustomersForView\(viewer, seat, isTest\);/, "the List mints through the planners' throttle");
    assert.doesNotMatch(territoryList, /ensureReferenceCustomers\(seat/, "and never the every-time mint");
    assert.match(territoryList, /const customersRead = ensured\.then\(\(\) => loadTerritoryCustomers\(seat\.seatId, isTest\)\);/, "its customers still wait for the mint, when there is one");
    const visits = code("src/lib/phoenix-crm/server/visits.ts");
    const form = functionBody(visits, "export async function loadVisitForm(");
    assert.match(form, /const ensured = ensureReferenceCustomersRecently\(seat, isTest\);/, "Add Visit mints through the planners' throttle");
    assert.doesNotMatch(form, /ensureReferenceCustomers\(seat/, "and never the every-time mint");
    assert.doesNotMatch(visits, /import \{[^}]*\bensureReferenceCustomers\b[^}]*\} from "@\/lib\/phoenix-crm\/server\/list";/, "visits.ts no longer imports the every-time mint");
    const missed = code("src/lib/phoenix-crm/server/missed-records.ts");
    assert.match(missed, /const ensured = ensureReferenceCustomers\(seat, isTest\);/, "missed records still mints on every read — the one reader left that does, and the one that restarts the window");
    const counts = functionBody(visits, "async function loadUnvalidatedVisitCounts(");
    assert.doesNotMatch(counts, /for \(let start = 0;/, "the hundred-id chunks are no longer read one after another");
    assert.match(counts, /const answers = await mapWithConcurrency\(chunks, 4, \(ids\) =>/, "they are read four at a time");
    assert.match(counts, /unvalidated\.slice\(index \* 100, index \* 100 \+ 100\)/, "a hundred ids a read, as before");
    assert.match(counts, /\.in\("customer_id", ids\)/, "each chunk is still the same read");
    assert.match(counts, /for \(const rows of answers\) \{\s*for \(const row of rows\) \{/, "every chunk's rows are counted — a count is a sum, whatever order they land in");
  }

  // ── 5. The three routes answer with Server-Timing ────────────────────────────────────────────────────
  {
    for (const { file, label } of BOARD_TIMED_ROUTES) {
      const route = code(file);
      assert.ok(route.includes(`const timer = startServerTimer("${label}");`), `${file} starts its timer before the try`);
      assert.match(route, /timer\.lap\("access"\);/, `${file} laps the access resolution`);
      assert.match(route, /await timer\.measure\("viewer", \(\) => resolvePhoenixCrmViewer\(access\)\);/, `${file} measures the viewer`);
      assert.match(route, /await timer\.measure\("load", /, `${file} measures the load`);
      assert.equal(count(route, "{ headers: timer.headers() }"), count(route, "NextResponse.json({"), `${file}: every JSON answer of the GET carries the header`);
      assert.ok(count(route, "NextResponse.json({") >= 1, `${file} answers JSON`);
    }
  }

  // ── 6. The pure mappers ───────────────────────────────────────────────────────────────────────────────
  {
    assert.deepEqual(
      toPanelContactRecord(panelAssignmentFromTuple([91, 1201, "B-40", 55, "A", "PM"])),
      { agent_crm_id: 1201, agent_hr_id: "B-40", contact_crm_id: 55, contact_grade: "A", list_type: "PM" },
      "an open assignment's tuple is the page walk's record — the assignment's grade is the panel's contact_grade",
    );
    assert.deepEqual(
      panelAssignmentFromTuple([92, null, "b-41", null, null, "AM"]),
      { agent_crm_id: null, agent_hr_id: "b-41", contact_crm_id: null, grade: null, list_type: "AM" },
      "a null stays null — never 0, never an empty string",
    );
    assert.deepEqual(
      brickMetaFromTuple(["GZ3-1", " Dokki ", "GZ3", " Giza 3 ", " Giza "]),
      ["GZ3-1", { areaCode: "GZ3", areaName: "Giza 3", name: "Dokki", regionName: "Giza" }],
      "names are trimmed exactly as the three-wave walk trimmed them",
    );
    assert.deepEqual(
      brickMetaFromTuple(["X-9", null, null, "   ", null]),
      ["X-9", { areaCode: null, areaName: null, name: "", regionName: null }],
      "a blank area or region name is null, so the page falls back instead of printing a code",
    );
    const newest = checkinRowFromTuple([7, 1201, "B-40", 30.05, 31.2, " 12 Tahrir St ", "2026-10-22T09:30:00+00:00"]);
    assert.deepEqual(
      newest,
      { address: " 12 Tahrir St ", agent_crm_id: 1201, agent_hr_id: "B-40", check_date: "2026-10-22T09:30:00+00:00", contact_crm_id: 7, lat: 30.05, lon: 31.2 },
      "a check-in tuple is the row the walk read, untouched — the fold trims the address",
    );
    const folded = foldCheckinRows([
      newest,
      checkinRowFromTuple([7, null, "B-41", 30.06, 31.21, "older", "2026-10-20T09:30:00+00:00"]),
      checkinRowFromTuple([8, 1202, null, 29.9, 31.1, null, "2026-10-21T09:30:00+00:00"]),
    ]);
    assert.equal(folded.size, 2, "one entry per contact");
    assert.deepEqual(
      folded.get(7)?.seenAt,
      { address: "12 Tahrir St", at: "2026-10-22T09:30:00+00:00", lat: 30.05, lon: 31.2 },
      "the FIRST row seen for a contact is the pin — newest first in, so it is the latest fix",
    );
    assert.equal(folded.get(7)?.points.length, 2, "every check-in becomes a point");
    assert.deepEqual(
      folded.get(7)?.points.map((point) => point.repKey),
      [repDoctorListRepKey(1201, "B-40"), repDoctorListRepKey(null, "B-41")],
      "a point is keyed like the roster, so a rep with no CRM account counts as an observer",
    );
    assert.equal(folded.get(8)?.seenAt.address, null, "no address is null, never an empty string");
    assert.equal(foldCheckinRows([]).size, 0, "nothing in, nothing out");
  }
}
