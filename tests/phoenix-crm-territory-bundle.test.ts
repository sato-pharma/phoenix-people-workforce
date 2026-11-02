import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { columnKeys, emptyTerritoryCustomers, foldTerritoryCustomers, territoryBundleOf } from "../src/lib/phoenix-crm/server/list.ts";
import { foldReturnedFrom } from "../src/lib/phoenix-crm/server/plan-day-status.ts";
import { venueNamesOf } from "../src/lib/phoenix-crm/server/plans.ts";
import { weeklyStockCacheKeyParts, type WeeklyStockRequestFilters } from "../src/lib/sales/weekly/stock-dashboard-service.ts";
import type { WeeklyAccessScope } from "../src/lib/sales/weekly/access.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * The speed root cause, Stage 2 (2 Nov 2026). Stage 1 measured that every request costs ~450 ms at
 * Supabase's edge for 2–7 ms of SQL, so the number of REQUESTS behind a page is what a rep waits for.
 *
 *   1. `phoenix_crm_territory_customers` answers a seat's customers, their active places and the buildings
 *      they sit in from ONE statement, with the List's status filter and a day's customer-id filter; the
 *      two keyset reads and the venue wave stand only for a database without it (PGRST202), and both
 *      doors fold through ONE function, so they cannot drift.
 *   2. `phoenix_crm_planned_day` answers the call prep's whole day — the week's plan row, the day's items,
 *      the edit requests, the returns and the stops — where it stood on five sequential waves. The day's
 *      status is still `plannedCustomersOn`'s rule, asked of the same rows.
 *   3. The month planner's first wave is two reads, not four; the venue names come from the territory read.
 *   4. The Ranks board draws each insignia once (a sprite the badges `<use>`), and the board and the
 *      profiles are remembered for an hour under a tag the nightly compute drops.
 *   5. Weekly Stock is remembered per SCOPE and filters — never per viewer — under a tag every weekly
 *      write and a price edit drop; an oversize payload is served without being kept.
 *
 * The IO is pinned on comment-stripped source; the folds and the key are pure and pinned on behaviour.
 */

const MIGRATION = "supabase/migrations/20261102040000_phoenix_crm_territory_bundle.sql";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const code = (path: string) => stripComments(read(path)).replace(/\r\n/g, "\n");
const count = (source: string, needle: string) => source.split(needle).length - 1;

/** From the function's `create or replace` to its own `revoke` — the one block the pins read. */
function migrationFunctionBlock(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `${name} is created`);
  const end = sql.indexOf(`revoke execute on function public.${name}(`, start);
  assert.ok(end > start, `${name} is revoked after it is created`);
  return sql.slice(start, end);
}

/** The source from the function's declaration — exported or not — to the next exported symbol. */
function functionBody(source: string, name: string): string {
  const start = source.search(new RegExp(`(?:export )?(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} must exist`);
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

const TERRITORY_SCOPE: Extract<WeeklyAccessScope, { tier: "territory" }> = {
  tier: "territory",
  canViewHeadOffice: false,
  allowedLineNames: new Set(["Pedia"]),
  allowedRegionCodes: new Set(["D12", "D11"]),
  allowedAreaCodes: null,
};

export async function runPhoenixCrmTerritoryBundleTests(): Promise<void> {
  // ── 1. The migration: two functions, one jsonb value each, the service role's alone ─────────────────
  {
    const sql = read(MIGRATION);
    const functions = [
      {
        name: "phoenix_crm_territory_customers",
        params: "(p_seat_id text, p_is_test boolean, p_statuses text[] default null, p_customer_ids uuid[] default null)",
        args: "(text, boolean, text[], uuid[])",
      },
      { name: "phoenix_crm_planned_day", params: "(p_seat_id text, p_is_test boolean, p_week_start date, p_day date)", args: "(text, boolean, date, date)" },
    ];
    for (const { args, name, params } of functions) {
      const block = migrationFunctionBlock(sql, name);
      assert.ok(block.startsWith(`create or replace function public.${name}${params}`), `${name} takes exactly ${params}`);
      assert.match(block, /\nreturns jsonb\n/, `${name} returns ONE jsonb value — PostgREST's 1,000-row cap applies to a set too`);
      assert.match(block, /\nstable\n/, `${name} is stable`);
      assert.match(block, /\nsecurity definer\nset search_path to 'public'\n/, `${name} is security definer with search_path pinned`);
      assert.match(block, /'\[\]'::jsonb/, `${name} answers an empty array, never null`);
      assert.ok(sql.includes(`revoke execute on function public.${name}${args} from public, anon, authenticated;`), `${name} is revoked from the browser roles`);
      assert.ok(sql.includes(`grant execute on function public.${name}${args} to service_role;`), `${name} is the service role's alone`);
    }
    const territory = migrationFunctionBlock(sql, "phoenix_crm_territory_customers");
    assert.ok(territory.includes("(p_statuses is null or c.status = any(p_statuses))"), "the List's status filter is the function's own");
    assert.ok(territory.includes("(p_customer_ids is null or c.id = any(p_customer_ids))"), "a day's customer ids narrow the customers");
    assert.ok(territory.includes("(p_customer_ids is null or p.customer_id = any(p_customer_ids))"), "and their places");
    assert.ok(territory.includes("- 'signboard_check' - 'schedule_check'"), "the two whole checks never leave the database");
    assert.ok(territory.includes("'signboard_retake', p.signboard_check -> 'retake'"), "only the retake the screens read");
    const day = migrationFunctionBlock(sql, "phoenix_crm_planned_day");
    assert.ok(day.includes("pl.status <> 'draft'"), "a draft week has no stops — nobody is planned until the week is sent");
    assert.ok(day.includes("order by e.created_at desc, e.id desc"), "the edit requests come newest first, as loadPlanEditState reads them");
    assert.ok(day.includes("order by r.created_at desc, r.id desc"), "the returns come newest first, as foldReturnedFrom keeps the first");
    assert.ok(sql.includes("notify pgrst, 'reload schema';"), "PostgREST learns the functions at once");
    assert.ok(read("tests/phoenix-crm-boundary.test.ts").includes("20261102040000_phoenix_crm_territory_bundle.sql"), "the boundary test lists the migration");
  }

  // ── 2. columnKeys: a select string to the keys a row is cut down to ─────────────────────────────────
  {
    assert.deepEqual(columnKeys("id, name, signboard_retake:signboard_check->retake"), ["id", "name", "signboard_retake"]);
    assert.deepEqual(columnKeys("a, b:c->d, e(f, g), h"), ["a", "b", "e(f, g)", "h"], "a comma inside parentheses belongs to an embed");
    assert.deepEqual(columnKeys(" id ,, name "), ["id", "name"], "blanks and empties never become keys");
  }

  // ── 3. territoryBundleOf: any shape in, three arrays of rows out ────────────────────────────────────
  {
    assert.deepEqual(territoryBundleOf(null), { customers: [], places: [], venues: [] });
    assert.deepEqual(territoryBundleOf({ customers: [{ id: "c1" }], places: "nope" }), { customers: [{ id: "c1" }], places: [], venues: [] });
    assert.deepEqual(emptyTerritoryCustomers().customers, []);
    assert.equal(emptyTerritoryCustomers().venueNames.size, 0);
  }

  // ── 4. foldTerritoryCustomers: the one fold both doors share ────────────────────────────────────────
  {
    const folded = foldTerritoryCustomers({
      customers: [
        { id: "c2", name: "Dr B", status: "pending", hidden_column: "never reaches the screen" },
        { id: "c1", name: "Dr A", status: "active", hidden_column: "nor this" },
      ],
      places: [
        {
          id: "p2",
          customer_id: "c1",
          label: "Clinic 2",
          captured_at: "2026-10-02T10:00:00+00:00",
          shared_place_id: "v1",
          lat: 30.1,
          lon: 31.2,
          photo_path: "p2.jpg",
          signboard_check: { whole: "check" },
          schedule_check: { whole: "check" },
        },
        { id: "p1", customer_id: "c1", label: "Clinic 1", captured_at: "2026-10-01T10:00:00+00:00", shared_place_id: null, lat: 30, lon: 31, photo_path: "p1.jpg" },
      ],
      venues: [
        { id: "v1", name: "Tower", kind: "polyclinic", schedule_photo_path: "board.jpg", status: "held" },
        { id: "v2", name: "Mall", kind: "not-a-kind", schedule_photo_path: null, status: "open" },
      ],
    });
    assert.deepEqual(
      folded.customers.map((row) => row.id),
      ["c2", "c1"],
      "customers come out in the order they came in",
    );
    assert.equal(folded.customers[0]?.name, "Dr B");
    assert.ok(!("hidden_column" in (folded.customers[0] ?? {})), "a column the select never named is cut off a whole row");
    assert.equal(folded.customers[0]?.dropped_reason, null, "a selected column the row lacks reads null, as a select of it would");
    const places = folded.placesByCustomer.get("c1") ?? [];
    assert.deepEqual(
      places.map((place) => place.placeId),
      ["p1", "p2"],
      "a customer's places are in capture order, whatever order the rows came in",
    );
    assert.equal(places[1]?.venueTimetableOnFile, true, "a place in a building with its timetable on file says so");
    assert.equal(places[1]?.venueHeld, true, "and one in a held building says so");
    assert.ok(!places[0]?.venueTimetableOnFile && !places[0]?.venueHeld, "a place in no building carries neither");
    assert.ok(!("signboard_check" in (places[1] as object)) && !("schedule_check" in (places[1] as object)), "the whole checks never reach a mapped place");
    assert.deepEqual(folded.venueNames.get("v1"), { sharedPlaceId: "v1", name: "Tower", kind: "polyclinic" }, "the venues are named as loadSharedPlaceNames names them");
    assert.equal(folded.venueNames.get("v2")?.kind, "polyclinic", "a kind that no longer parses is still shown, as the commonest");
    assert.equal(folded.venueNames.size, 2);
  }

  // ── 5. venueNamesOf answers from the territory read when it names every seated place ────────────────
  {
    const known = new Map([
      ["v1", { sharedPlaceId: "v1", name: "Tower", kind: "polyclinic" as const }],
      ["v2", { sharedPlaceId: "v2", name: "Mall", kind: "polyclinic" as const }],
      ["v3", { sharedPlaceId: "v3", name: "Unused", kind: "polyclinic" as const }],
    ]);
    const placesByCustomer = new Map([
      ["c1", [{ sharedPlaceId: "v1" }, { sharedPlaceId: null }]],
      ["c2", [{ sharedPlaceId: "v2" }]],
    ]);
    const names = await venueNamesOf(placesByCustomer, known);
    assert.deepEqual([...names.keys()].sort(), ["v1", "v2"], "exactly the seated buildings, never the rest of what was known");
    assert.equal(names.get("v1")?.name, "Tower");
    const plans = code("src/lib/phoenix-crm/server/plans.ts");
    const body = functionBody(plans, "venueNamesOf");
    assert.match(body, /if \(known && seated\.every\(\(id\) => known\.has\(id\)\)\)/, "the answer is in hand only when every seated building is known");
    assert.match(body, /return loadSharedPlaceNames\(sharedPlaceIds\);/, "any building it misses sends the whole question to the read, as before");
    assert.ok(count(plans, "venueNamesOf(placesByCustomer, venueNames)") >= 2, "the week planner and the save hand the territory read's names in");
    assert.ok(code("src/lib/phoenix-crm/server/monthly-plans.ts").includes("venueNamesOf(placesByCustomer, venueNames)"), "and so does the month board");
  }

  // ── 6. foldReturnedFrom keeps the newest return per plan ────────────────────────────────────────────
  {
    const returned = foldReturnedFrom([
      { plan_id: "p1", from_status: "submitted" },
      { plan_id: "p1", from_status: "approved" },
      { plan_id: "p2", from_status: "not-a-status" },
    ]);
    assert.equal(returned.get("p1"), "submitted", "rows arrive newest first and the first wins");
    assert.equal(returned.get("p2"), null, "a status that no longer parses reads null, never a guess");
    assert.equal(returned.size, 2);
    const status = code("src/lib/phoenix-crm/server/plan-day-status.ts");
    assert.match(functionBody(status, "loadReturnedFrom"), /foldReturnedFrom\(/, "the read folds through the same function the bundle does");
  }

  // ── 7. loadTerritoryCustomers: the function first, the reads only for a database without it ────────
  {
    const list = code("src/lib/phoenix-crm/server/list.ts");
    const body = functionBody(list, "loadTerritoryCustomers");
    assert.match(body, /\.rpc\("phoenix_crm_territory_customers", \{\s*p_seat_id: seatId,\s*p_is_test: isTest,\s*p_statuses: statuses,\s*p_customer_ids: only,\s*\}\)/, "ONE request, with the same filters the reads apply");
    assert.match(body, /if \(!bundle\.error\) return foldTerritoryCustomers\(territoryBundleOf\(bundle\.data\)\);/, "the function's answer folds through the shared fold");
    assert.match(body, /if \(!isMissingCrmRpcError\(bundle\.error\)\) throwIfError\(bundle\.error\);/, "only a missing function falls back; any other error is raised");
    assert.match(body, /if \(statuses\) query = query\.in\("status", statuses\);/, "the fallback applies the status filter");
    assert.match(body, /if \(only\) query = query\.in\("id", only\);/, "and the customer-id filter");
    assert.match(body, /return only \? query\.in\("customer_id", only\) : query;/, "to the places too");
    assert.match(body, /return foldTerritoryCustomers\(\{ customers, places, venues \}\);/, "and folds through the same function, so the two doors cannot drift");
  }

  // ── 8. loadPlannedDay: the call prep's whole day from one function, the rule unchanged ──────────────
  {
    const visits = code("src/lib/phoenix-crm/server/visits.ts");
    const body = functionBody(visits, "loadPlannedDay");
    assert.match(body, /\.rpc\("phoenix_crm_planned_day", \{\s*p_seat_id: seatId,\s*p_is_test: isTest,\s*p_week_start: fieldWeekStart\(date\),\s*p_day: date,\s*\}\)/, "ONE request for the week, the day and the stops");
    assert.match(body, /if \(!isMissingCrmRpcError\(bundle\.error\)\) throwIfError\(bundle\.error\);/, "only a missing function falls back");
    assert.match(body, /const planned = await plannedCustomersOn\(seatId, isTest, date\);/, "the fallback asks the old rule first");
    assert.match(
      body,
      /loadTerritoryCustomers\(seatId, isTest, \{\s*onListOnly: true,\s*customerIds: isPlanSentForReview\(planned\.status\) \? planned\.customerIds : \[\],\s*\}\)/,
      "and then the stops, nobody on a day that is not sent",
    );
    assert.match(body, /loadPlanDayFacts\(\[day\.plan\], isTest, \{ edits: day\.edits, returns: day\.returns \}\)/, "the day's status is plannedCustomersOn's rule, asked of the bundle's rows");
    assert.match(body, /planDayStatus\(\{ \.\.\.dayFacts, date \}\)/, "a week returned for one day still stands on its other days");
    assert.match(body, /stops: isPlanSentForReview\(planned\.status\) \? foldTerritoryCustomers\(day\.stops\) : emptyTerritoryCustomers\(\)/, "the stops fold through the shared fold, and a day that is not sent reads nobody");
    const callPrep = code("src/lib/phoenix-crm/server/call-prep.ts");
    assert.match(callPrep, /loadPlannedDay\(/, "the call prep reads its day through it");
    assert.doesNotMatch(callPrep, /plannedCustomersOn\(/, "never the old chain beside it");
    assert.match(callPrep, /const customersRead = dayRead\.then\(\(\{ stops \}\) => stops\);/, "the stops are the bundle's, not a second territory read");
    const facts = code("src/lib/phoenix-crm/server/plan-edits.ts");
    assert.match(facts, /options: \{ names\?: boolean; rows\?: ReadonlyArray<Row> \} = \{\}/, "the edit state takes the bundle's rows");
    assert.match(facts, /options\.rows\.filter\(\(row\) => wanted\.has\(String\(row\.plan_id\)\) && row\.is_test === isTest\)/, "and still keeps only the asked plans of the asked kind");
  }

  // ── 9. The month planner's first wave is two reads, and the sends read four chunks at a time ───────
  {
    const monthly = code("src/lib/phoenix-crm/server/monthly-plans.ts");
    assert.match(monthly, /const monthStarts = \[\.\.\.new Set\(\[\.\.\.months, monthStart\]\)\];/, "every month header in one read");
    assert.match(monthly, /const weekStarts = leadingWeek && !weeks\.includes\(leadingWeek\) \? \[\.\.\.weeks, leadingWeek\] : weeks;/, "every week row in one read, the leading week included");
    assert.match(monthly, /\.in\("month_start", monthStarts\)/);
    assert.match(monthly, /\.in\("week_start", weekStarts\)/);
    const review = code("src/lib/phoenix-crm/server/plan-review.ts");
    assert.match(review, /mapWithConcurrency\(chunk\(ids, 50\), 4,/, "the sends read four chunks at a time, never one after another");
    for (const [route, name] of [
      ["app/api/phoenix-crm/call-prep/route.ts", "crm_call_prep"],
      ["app/api/phoenix-crm/monthly-plans/route.ts", "crm_monthly_plans"],
    ] as const) {
      const source = code(route);
      assert.ok(source.includes(`startServerTimer("${name}")`), `${route} times its stages`);
      assert.ok(source.includes("timer.headers()"), `${route} answers with Server-Timing`);
    }
  }

  // ── 10. The Ranks board: each insignia drawn once, the board and the profiles remembered ───────────
  {
    const insignia = code("src/components/rep-ranks/rank-insignia.tsx");
    assert.match(insignia, /export function RankInsigniaSprite\(\)/, "the sprite exists");
    assert.match(insignia, /RANK_LADDER\.map\(\(rank\) => \(\s*<symbol/, "one symbol per ladder rank");
    assert.match(insignia, /id=\{insigniaSymbolId\(rank\)\}/, "named by the shared id");
    assert.match(insignia, /className="absolute h-0 w-0 overflow-hidden"/, "hidden by size — a display:none sprite loses its gradients");
    assert.doesNotMatch(functionBody(insignia, "RankInsigniaSprite"), /display:\s*none|\shidden[\s>]|sr-only/, "never hidden by display or clipped off-screen — the gradients would go with it");
    const badge = functionBody(insignia, "RankInsigniaBadge");
    assert.match(badge, /<use href=\{`#\$\{insigniaSymbolId\(rank\)\}`\} \/>/, "a badge is a reference, a few bytes");
    assert.doesNotMatch(badge, /dangerouslySetInnerHTML/, "a badge never carries the drawing");
    const board = code("src/components/rep-ranks/rep-ranks-board.tsx");
    const sprite = board.indexOf("<RankInsigniaSprite />");
    assert.ok(sprite >= 0, "the board renders the sprite");
    assert.ok(sprite < board.indexOf("<WindowTabs"), "once, at the top, ahead of the first badge");
    const readSource = code("src/lib/rep-ranks/server/read.ts");
    assert.equal(count(readSource, "unstable_cache("), 2, "the board and the profile are remembered, nothing else");
    assert.equal(count(readSource, "tags: [REP_RANKS_CACHE_TAG]"), 2, "both under the one tag");
    assert.match(readSource, /\["rep-ranks-board", input\.kind, input\.windowKey \?\? "-", input\.audience\]/, "the board key carries the AUDIENCE — the admin twin's metrics never reach a portal entry");
    assert.match(readSource, /\["rep-ranks-profile", key\]/, "a profile is keyed by the rep");
    const compute = code("src/lib/rep-ranks/server/compute.ts");
    assert.match(functionBody(compute, "rebuildWindows"), /invalidateRepRanksCache\(/, "the one writer drops the tag when it finishes");
  }

  // ── 11. Weekly Stock: remembered per scope and filters, never per viewer ───────────────────────────
  {
    const filters: WeeklyStockRequestFilters = { distributorCodes: ["B", "A"], statuses: ["low"], asOfWeekStart: null };
    const base = weeklyStockCacheKeyParts("Medical Rep", TERRITORY_SCOPE, new Set(["PED|D12", "PED|D11"]), true, filters);
    const reordered = weeklyStockCacheKeyParts(
      "Medical Rep",
      { ...TERRITORY_SCOPE, allowedRegionCodes: new Set(["D11", "D12"]) },
      new Set(["PED|D11", "PED|D12"]),
      true,
      { ...filters, distributorCodes: ["A", "B"] },
    );
    assert.deepEqual(reordered, base, "the order a set or a list arrived in never makes a second entry");
    assert.ok(base.join("|").includes("role:Medical Rep"), "the role is in the key — the scope line names it");
    assert.ok(base.join("|").includes("head-office:false"), "and the Head Office flag");
    const otherRegion = weeklyStockCacheKeyParts("Medical Rep", { ...TERRITORY_SCOPE, allowedRegionCodes: new Set(["D12"]) }, new Set(["PED|D12"]), true, filters);
    assert.notDeepEqual(otherRegion, base, "a different region bound is a different entry");
    assert.notDeepEqual(weeklyStockCacheKeyParts("District Manager", TERRITORY_SCOPE, new Set(["PED|D12", "PED|D11"]), true, filters), base, "a different role too");
    assert.notDeepEqual(weeklyStockCacheKeyParts("Medical Rep", TERRITORY_SCOPE, new Set(["PED|D12", "PED|D11"]), true, { ...filters, statuses: ["over"] }), base, "and a different filter");
    const service = code("src/lib/sales/weekly/stock-dashboard-service.ts");
    assert.match(
      service,
      /export function weeklyStockCacheKeyParts\(\s*role: PhoenixRole,\s*scope: WeeklyAccessScope,\s*ownAreaKeys: ReadonlySet<string>,\s*liftGrain: boolean,\s*filters: WeeklyStockRequestFilters,\s*\)/,
      "the key takes the scope, never the viewer",
    );
    const load = functionBody(service, "loadWeeklyStockDashboard");
    assert.doesNotMatch(load, /hrId|loginId/, "nothing in the load names the person");
    assert.match(load, /weeklyStockCacheKeyParts\(ctx\.role, accessScope, ownAreaKeys, liftGrain, filters\)/, "the key is what the build reads from the viewer");
    assert.match(load, /tags: \[WEEKLY_STOCK_CACHE_TAG\]/, "under the one tag");
    assert.match(load, /revalidate: WEEKLY_STOCK_CACHE_SECONDS/, "with the backstop");
    assert.match(load, /serveWithoutCaching\(payload,/, "an oversize payload is served, not kept");
    assert.match(load, /unwrapServedWithoutCaching</, "and unwrapped outside the cache");
    assert.match(load, /resolveWeeklyAccessScope\(ctx\)[\s\S]*unstable_cache\(/, "the scope is resolved on every open, before the cache");
    const invalidation = code("src/lib/dashboard/invalidation.ts");
    assert.match(invalidation, /export const WEEKLY_STOCK_CACHE_TAG = "weekly-stock-payload";/);
    assert.match(invalidation, /export const REP_RANKS_CACHE_TAG = "rep-ranks";/);
    assert.match(invalidation, /revalidateTag\(WEEKLY_STOCK_CACHE_TAG, \{ expire: 0 \}\)/, "expired at once — the uploader's next screen shows the upload");
    assert.match(invalidation, /revalidateTag\(REP_RANKS_CACHE_TAG, \{ expire: 0 \}\)/);
    assert.match(
      invalidation,
      /for \(const tag of \[CLOSING_STORE_SPLIT_CACHE_TAG, SALES_ACHIEVEMENT_STAMPED_CACHE_TAG, WEEKLY_STOCK_CACHE_TAG\]\)/,
      "a price edit drops it — a stock value is units at the factory price",
    );
    const rowCache = code("src/lib/sales/weekly/row-cache.ts");
    assert.match(functionBody(rowCache, "bumpWeeklyRowsGeneration"), /invalidateWeeklyStockCache\(reason\)/, "every weekly write drops it through the one bump they all call");
  }
}
