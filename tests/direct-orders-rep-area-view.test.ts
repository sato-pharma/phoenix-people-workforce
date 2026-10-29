import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  monthsBetween,
  repAreaCodesForMonth,
  repAreaDisplayName,
  UNNAMED_AREA,
  UNNAMED_PRODUCT,
} from "@/lib/direct-orders/rep-area-view-service";
import {
  directOrderLineKey,
  isDirectOrderOnRepLine,
  lineHasDirectOrders,
} from "@/lib/direct-orders/line-scope";

// ─────────────────────────────────────────────────────────────────────────────
// "Direct Orders in my area" — the Medical Rep's VIEW-ONLY window (owner, 2026-09-24).
//
// The rep never RAISES a direct order (that is DIRECT_ORDER_REQUESTER_ROLES). This tab lets him
// SEE the ones his District Manager booked on pharmacies in his own area: to whom, when, and which
// sales month Finance counted them in. Supabase-bound, so this pins the properties that would fail
// QUIETLY rather than loudly:
//   · the access gate is rep-only (a wider role would leak a sibling manager's spend);
//   · only COUNTED orders show — approved AND a Finance-booked sales_month, 2026-07 onward
//     (the direct-order GOLDEN RULE: a sale counts in the month Finance books it);
//   · reversed and duplicate rows are excluded so nothing is double-shown;
//   · the read is area-scoped through the pharmacy's area_code, never re-derived;
//   · read-only — it computes, it never writes;
//   · it is REACHABLE — a sidebar row, a nav-registry entry and a catalog entry, all rep-only.
// ─────────────────────────────────────────────────────────────────────────────

export function runDirectOrdersRepAreaViewTests() {
  const service = readFileSync(new URL("../src/lib/direct-orders/rep-area-view-service.ts", import.meta.url), "utf8");
  const page = readFileSync(new URL("../app/employee-portals/direct-orders-in-my-area/page.tsx", import.meta.url), "utf8");
  const ui = readFileSync(new URL("../src/components/direct-orders/rep-area-direct-orders.tsx", import.meta.url), "utf8");
  const navigation = readFileSync(new URL("../src/lib/employee-portal/navigation.ts", import.meta.url), "utf8");
  const registry = readFileSync(new URL("../src/components/employee-portal/employee-portal-nav-registry.ts", import.meta.url), "utf8");
  const catalog = readFileSync(new URL("../src/config/system-navigation.ts", import.meta.url), "utf8");

  // ── THE HEADLINE: the gate is rep-only ───────────────────────────────────────────────────
  // A wider role here would show a manager the direct orders in a rep's area that are not his to
  // see — silently, because a read that returns rows never looks wrong. The system scope (exports,
  // internal callers) is the only bypass.
  assert.match(
    service,
    /if \(access\.scope === "system"\) return;/,
    "a system-scoped caller may read; that is the one bypass",
  );
  assert.match(
    service,
    /if \(access\.role !== "Medical Rep"\) \{\s*\n\s*throw forbiddenError\(/,
    "REP-ONLY GATE: any non-rep, non-system caller must be thrown out — flipping this to `===` must fail here",
  );
  assert.match(
    navigation,
    /return resolvePortalRole\(roleLabel, accessRole\) === "Medical Rep";/,
    "the sidebar predicate must resolve rep-only too, or a manager sees the tab the page then bounces",
  );

  // ── Only COUNTED orders, from July, the system path only ─────────────────────────────────
  // The direct-order golden rule: a sale counts in the month FINANCE books it (sales_month). A null
  // sales_month is "not yet counted" and is deliberately excluded (owner: "only counted orders").
  assert.match(service, /export const AREA_DIRECT_ORDERS_FROM_MONTH = "2026-07";/, "counted from July onward (owner: from July)");
  assert.match(service, /\.eq\("status", "approved"\)/, "only approved orders");
  assert.match(service, /\.not\("sales_month", "is", null\)/, "a null sales_month is not yet counted — excluded");
  assert.match(
    service,
    /\.gte\("sales_month", AREA_DIRECT_ORDERS_FROM_MONTH\)/,
    "scoped to 2026-07 onward, so the legacy July XLSX overlay's earlier months are never re-shown here",
  );
  // Superseded and duplicate rows must drop out, or an order double-counts.
  assert.match(service, /\.is\("reversed_by_request_id", null\)/, "a reversed order must not show");
  assert.match(service, /\.is\("duplicate_of_request_id", null\)/, "a duplicate row must not show");
  // The SYSTEM direct-request path only — never the legacy XLSX overlay module. Guard the IMPORT,
  // not prose: the service's own header names the overlay to say it is deliberately NOT used, so a
  // bare word match would flag that comment. Only an actual `import … from "…/july-2026-direct-orders"`
  // is the regression this exists to catch.
  assert.match(service, /\.from\("direct_order_requests"\)/, "reads the system request table");
  assert.doesNotMatch(
    service,
    /import[^\n]*july-2026-direct-orders/,
    "must NOT import the legacy July overlay module (owner: the system direct request way)",
  );

  // ── Area-scoped, and the scope is the pharmacy's own area_code ───────────────────────────
  // employees.area_id (bigint) → areas.id → areas.code (text) = direct_order_pharmacies.area_code.
  // The rep can only ever reach pharmacies in his own area(s); nothing widens that.
  assert.match(service, /\.from\("areas"\)/, "the numeric area id is resolved to its text code");
  assert.match(service, /\.from\("direct_order_pharmacies"\)/, "pharmacies are found by their area");
  assert.match(service, /\.in\("area_code", part\)/, "the area bound is the pharmacy's area_code — the rep's own territory");

  // ── ALL the rep's areas, merged areas expanded for the COUNTED month (owner, 2026-09-25) ──
  // One `employees.area_id` used to be the whole scope, so the rep of Anti Infective's "Ismailia
  // and Suez" (OT2 + OT9, one area from 2026-09) saw only Suez's orders, and a rep whose seat
  // covers two areas saw one — while Sales vs Target counted both.
  const merged = { lineCode: "anti_infective", homeAreaCode: "OT2", seatAreas: [] };
  assert.deepEqual(
    [...repAreaCodesForMonth(merged, "2026-09")].sort(),
    ["OT2", "OT9"],
    "MERGED AREA: from 2026-09 the Ismailia and Suez rep must see BOTH halves — OT9 (Ismailia) carries its own orders",
  );
  assert.deepEqual(
    [...repAreaCodesForMonth(merged, "2026-08")],
    ["OT2"],
    "the merge starts 2026-09: an August order in Ismailia was a separate Others area, never this rep's",
  );
  assert.equal(
    repAreaDisplayName("anti_infective", "OT9", "2026-09", new Map([["OT9", "Ismailia"]])),
    "Ismailia and Suez",
    "a folded half shows under the merged area's name from the month the merge starts",
  );
  assert.equal(
    repAreaDisplayName("anti_infective", "OT9", "2026-08", new Map([["OT9", "Ismailia"]])),
    "Ismailia",
    "before the merge, the half keeps its own name",
  );

  // A seat covering two areas (the live OT2 seat carries OT9 too) brings both, dated by the seat
  // map as of the counted month's LAST day — a row opening 2026-09-01 does not reach August.
  const twoAreas = {
    lineCode: "cns",
    homeAreaCode: "CA1",
    seatAreas: [
      { lineCode: "cns", areaCode: "CA1", effectiveFrom: "2026-07-13", effectiveTo: null },
      { lineCode: "cns", areaCode: "CA2", effectiveFrom: "2026-09-01", effectiveTo: null },
      { lineCode: "cns", areaCode: "CA3", effectiveFrom: "2026-07-13", effectiveTo: "2026-09-01" },
    ],
  };
  assert.deepEqual([...repAreaCodesForMonth(twoAreas, "2026-09")].sort(), ["CA1", "CA2"], "TWO AREAS: the seat's second area counts");
  assert.deepEqual(
    [...repAreaCodesForMonth(twoAreas, "2026-08")].sort(),
    ["CA1", "CA3"],
    "a seat row counts only while in force (effective_to EXCLUSIVE, as of the month end)",
  );
  // Never wider than the rep's own seat and home area.
  assert.deepEqual(
    [...repAreaCodesForMonth({ lineCode: null, homeAreaCode: "GZ3", seatAreas: [] }, "2026-09")],
    ["GZ3"],
    "a rep with no seat keeps exactly the home area",
  );
  assert.equal(repAreaCodesForMonth({ lineCode: null, homeAreaCode: null, seatAreas: [] }, "2026-09").size, 0, "no area, no orders");
  assert.deepEqual(monthsBetween("2026-11", "2027-02"), ["2026-11", "2026-12", "2027-01", "2027-02"], "the window spans a year end");
  assert.match(service, /scopeFor\(request\.sales_month\)\.has\(pharmacy\.areaCode\)/, "each order is scoped by its OWN counted month");
  assert.match(service, /\.from\("au_v_line_area_map_all"\)[\s\S]{0,120}\.in\("rep_seat_id", seatIds\)/, "the rep's own REP seat areas are read");

  // ── No raw code ever renders as a name ──────────────────────────────────────────────────
  assert.equal(UNNAMED_AREA, "Unnamed area");
  assert.equal(UNNAMED_PRODUCT, "Unnamed product");
  assert.equal(repAreaDisplayName("cns", "ZZ9", "2026-09", new Map()), "Unnamed area", "an area with no name shows 'Unnamed area', never its code");
  assert.match(service, /productName: \(line\.productName \?\? ""\)\.trim\(\) \|\| UNNAMED_PRODUCT,/, "a product with no name shows 'Unnamed product'");
  assert.doesNotMatch(service, /\|\| code;|\(line\.productCode \?\? ""\)/, "no fallback to a raw area or product code");

  // ── The "Order date" is when the order was PLACED, never the collection date ──────────────
  // An order raised and approved in August but COLLECTED in September still counts in August.
  // Sourcing the displayed order date from collection_date made such a row read as "ordered
  // September, counted August" — a phantom contradiction (owner, 2026-09-24). created_at (the rep
  // raising it) must come first in the fallback chain.
  assert.match(
    service,
    /orderDate:\s*request\.created_at\s*\?\?\s*request\.decided_at\s*\?\?\s*request\.collection_date/,
    "the order date must be the placement stamp (created_at) first — never collection_date, or a later collection reads as a later order",
  );

  // ── Baskets: one row per product, header fallback so nothing is dropped ───────────────────
  assert.match(service, /\.from\("direct_order_request_items"\)/, "product lines come from the item table (baskets)");
  assert.match(
    service,
    /if \(requestsWithItems\.has\(request\.id\)\) continue;/,
    "a legacy single-product order with no item rows must fall back to its header, never be dropped",
  );

  // ── Read-only: it computes, it never writes ──────────────────────────────────────────────
  for (const forbidden of [".insert(", ".update(", ".delete(", ".upsert("]) {
    assert.ok(!service.includes(forbidden), `a view-only window must never write (${forbidden} found)`);
  }

  // ── The page's gate mirrors the service, and it is dynamic ───────────────────────────────
  assert.match(page, /export const dynamic = "force-dynamic";/, "the page must render per-request");
  assert.match(
    page,
    /if \(!canUseEmployeePortalAreaDirectOrders\(access\.role\)\) \{\s*\n\s*redirect\(/,
    "the page must bounce any non-rep — UX in front of the service's own throw",
  );

  // ── Owner's UI rules: fits the screen, shows product/units/value, no ellipsis ────────────
  assert.match(ui, /w-full table-fixed/, "the table must be table-fixed so it always fits — never a sideways scroll");
  assert.match(ui, /<colgroup>/, "table-fixed needs a colgroup to hold the column widths");
  assert.match(ui, /md:hidden/, "mobile must get cards, never the table");
  assert.doesNotMatch(ui, /overflow-x-auto|min-w-\[|truncate|text-ellipsis|line-clamp/, "no sideways scroll and no ellipsis (owner's rules)");
  // Owner asked for product, units AND value on each row.
  for (const column of [">Product<", ">Units<", ">Value<"]) {
    assert.ok(ui.includes(column), `the owner asked to see product, units & value — the ${column} column must be present`);
  }
  // An empty result must explain itself, not render as a zero.
  assert.match(ui, /No direct orders counted to sales/, "an empty result must say so in words");

  // ── It is REACHABLE — the flag, the registry entry and the catalog entry all rep-only ────
  // The exact bug from #1762: a page that works but no role can open reads as nobody using it.
  assert.match(navigation, /showAreaDirectOrdersTab\??:/, "the visibility flag must exist");
  assert.match(
    registry,
    /href: "\/employee-portals\/direct-orders-in-my-area"[\s\S]{0,160}?flags: \["showAreaDirectOrdersTab"\]/,
    "the nav-registry must carry the entry behind its own flag",
  );
  const catalogEntry = catalog.slice(catalog.indexOf('href: "/employee-portals/direct-orders-in-my-area"'));
  const catalogLine = catalogEntry.slice(0, catalogEntry.indexOf("},"));
  assert.ok(catalogLine.length > 0, "the catalog must declare the page");
  assert.match(catalogLine, /roles: \["Medical Rep"\]/, "the catalog entry is Medical-Rep only");

  // ── THE LINE BOUND (owner, 2026-10-29: "a leak between orders products between lines") ─────
  // An area is shared by every line. Read by area alone, the window showed Pedia reps 40 Anti
  // Infective orders and Anti Infective reps 20 Pedia ones on production; CNS reps saw 87.
  assert.equal(directOrderLineKey("Anti Infective"), directOrderLineKey("anti_infective"), "the order's line name and the seat map's line code must compare equal");
  assert.equal(directOrderLineKey("Anti-Infective"), "antiinfective");
  assert.equal(isDirectOrderOnRepLine("Pedia", "pedia"), true, "a Pedia order belongs on a Pedia rep's screen");
  assert.equal(isDirectOrderOnRepLine("Anti Infective", "pedia"), false, "LEAK: an Anti Infective order must never reach a Pedia rep");
  assert.equal(isDirectOrderOnRepLine("Pedia", "anti_infective"), false, "LEAK: a Pedia order must never reach an Anti Infective rep");
  assert.equal(isDirectOrderOnRepLine("Pedia", ""), false, "a rep with no line sees nothing — fail closed, never every line");
  assert.equal(isDirectOrderOnRepLine("", "pedia"), false, "an order with no line belongs to no rep's line");
  assert.equal(lineHasDirectOrders("CNS"), false, "CNS runs no direct orders");
  assert.equal(lineHasDirectOrders("cns"), false, "CNS by its seat code too");
  assert.equal(lineHasDirectOrders(""), false, "a blank line is never a window onto every line");
  assert.equal(lineHasDirectOrders("Pedia"), true);
  assert.equal(lineHasDirectOrders("anti_infective"), true);

  // The service reads the order's line and filters on it; a CNS rep is answered empty and sent home.
  assert.match(service, /"id, pharmacy_id, sales_month, collection_date, decided_at, created_at, line, /, "the order's own line must be read");
  assert.match(service, /if \(!isDirectOrderOnRepLine\(request\.line, repLine\)\) return false;/, "LEAK: every order must be tested against the rep's own line");
  assert.match(service, /if \(!lineHasDirectOrders\(repLine\)\) \{/, "a line with no direct orders (CNS) or no line at all must read nothing");
  assert.match(page, /if \(report\.lineRunsNoDirectOrders\) \{\s*redirect\(/, "a CNS rep typing the address is sent home");
  assert.match(
    navigation,
    /const showAreaDirectOrdersTab = !isCnsLine && canUseEmployeePortalAreaDirectOrders\(resolvedRole\);/,
    "the sidebar must not offer the window to a CNS rep",
  );
}
