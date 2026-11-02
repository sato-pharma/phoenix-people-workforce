import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";
import { resolvePlanItems } from "../src/lib/phoenix-crm/plan-rules.ts";
import { sharedPlanCapRefusal } from "../src/lib/phoenix-crm/shared-place-rules.ts";
import {
  effectiveVenueCap,
  parseVenueCapAction,
  VENUE_CAP_MAX,
  VENUE_CAP_OUT_OF_RANGE_TEXT,
  venueCapNumberProblem,
  venueCapStateLabel,
  venueCapsExplainer,
} from "../src/lib/phoenix-crm/venue-cap-rules.ts";

const MIGRATION = "supabase/migrations/20261102130045_phoenix_crm_venue_cap_admin.sql";
const ROUND_TRIP_MIGRATION = "supabase/migrations/20261102133258_phoenix_crm_venue_cap_round_trip.sql";

function read(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

/** One function's body out of the migration, so a rule is asked of the function that must obey it. */
function functionBody(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `the migration replaces ${name}`);
  return sql.slice(start, sql.indexOf("\n$$;", start));
}

/**
 * Owner, 2026-11-02: "This module I filter by the medical rep. Then after I filter by the medical rep, all his
 * polyclinics appear ... When I open the toggle, then no cap for this rep in this polyclinic. And also have the
 * option to, for example, instead of making the cap 3, make it 5, make it 7."
 */
export function runPhoenixCrmVenueCapsTests(): void {
  runNumberRules();
  runPlanRules();
  runMigrationRules();
  runGateRules();
  runScreenRules();
}

function runNumberRules(): void {
  assert.equal(effectiveVenueCap(3, null), 3, "no number of its own: the company's");
  assert.equal(effectiveVenueCap(3, 7), 7, "a raised venue holds its own");
  assert.equal(effectiveVenueCap(8, 5), 8, "🔴 a company number raised later is never undercut by an older venue number");

  assert.equal(venueCapNumberProblem("5", 3), null);
  assert.equal(venueCapNumberProblem(String(VENUE_CAP_MAX), 3), null, "the top of the range is allowed");
  for (const bad of ["3", "2", "0", String(VENUE_CAP_MAX + 1), "", "abc", "4.5", "-5", null, undefined]) {
    assert.equal(venueCapNumberProblem(bad, 3), VENUE_CAP_OUT_OF_RANGE_TEXT, `${String(bad)} is refused: a raise must stand above the company number`);
  }

  assert.equal(parseVenueCapAction("lift"), "lift");
  assert.equal(parseVenueCapAction("drop"), null, "nothing off the wire is trusted to be an action");

  assert.equal(venueCapStateLabel({ lifted: true, dailyCap: 7 }, 3), "No cap", "the switch wins over a stored number");
  assert.ok(venueCapStateLabel({ lifted: false, dailyCap: 7 }, 3).startsWith("7 visits a day"));
  assert.ok(venueCapStateLabel({ lifted: false, dailyCap: null }, 3).startsWith("3 visits a day"));
  assert.ok(venueCapStateLabel({ lifted: false, dailyCap: 5 }, 8).startsWith("8 visits a day"), "the label says what the door holds");

  const said = venueCapsExplainer({ companyCap: 3, offPlanDailyCap: 2, offPlanWeeklyCap: 8 });
  assert.ok(said.includes("2 a day") && said.includes("8 a week"), "🔴 the page says the unplanned limit still applies under a raised number");
  assert.ok(!/\b(account|accounts|doctor|doctors)\b/i.test(said), "the module's banned screen words");
}

function runPlanRules(): void {
  const dayLabel = (isoDay: string) => isoDay;
  const at = (venue: string, count: number) => Array.from({ length: count }, () => ({ planDate: "2026-11-03", sharedPlaceId: venue }));
  const venueCaps = new Map([["nile", 5]]);

  assert.ok(sharedPlanCapRefusal({ items: at("nile", 4), venues: new Map(), cap: 3, dayLabel }) !== null, "without a number the 4th is refused");
  assert.equal(sharedPlanCapRefusal({ items: at("nile", 5), venues: new Map(), cap: 3, dayLabel, venueCaps }), null, "🔴 raised to five, five fit");

  const six = sharedPlanCapRefusal({ items: at("nile", 6), venues: new Map(), cap: 3, dayLabel, venueCaps });
  assert.ok(six?.includes("has 6 visits") && six.includes("holds 5 visits"), "🔴 the sixth is refused, and the sentence states the venue's own number");

  assert.ok(
    sharedPlanCapRefusal({ items: [...at("nile", 5), ...at("other", 4)], venues: new Map(), cap: 3, dayLabel, venueCaps })?.includes("has 4 visits"),
    "🔴 every other venue keeps the company number",
  );
  assert.equal(
    sharedPlanCapRefusal({ items: at("nile", 3), venues: new Map(), cap: 3, dayLabel, venueCaps: new Map([["nile", 2]]) }),
    null,
    "🔴 a stored number below the company's never narrows it, the same as the door's greatest()",
  );

  const planRules = read("src/lib/phoenix-crm/plan-rules.ts");
  assert.ok(resolvePlanItems.length === 1 && planRules.includes("venueCaps: input.venueCaps,"), "resolvePlanItems hands the numbers to the venue count");

  const plans = read("src/lib/phoenix-crm/server/plans.ts");
  assert.ok(plans.includes("loadVenueCaps(seat.seatId),\n    // The venues the owner lifted outright"), "the save reads the numbers");
  assert.ok(plans.includes("sharedPlaces: planVenues,\n    liftedVenues,\n    venueCaps,\n  });"), "🔴 and passes them to the plan rules");
  assert.ok(plans.includes("sharedPlanCapRefusal({ ...venueCheck, venues, liftedVenues, venueCaps })"), "🔴 the send counts with them too");
  assert.ok(read("src/lib/phoenix-crm/server/shared-places.ts").includes('.select("id, daily_cap")'), "the plan reads the column the door reads");
}

function runMigrationRules(): void {
  const sql = read(MIGRATION);

  for (const name of ["phoenix_crm_offplan_exempt", "phoenix_crm_offplan_exempt_customers", "phoenix_crm_venue_cap_lifted"]) {
    assert.ok(functionBody(sql, name).includes("e.shared_place_id = sp.id"), `🔴 ${name} reads a row naming the exact venue`);
  }
  assert.ok(functionBody(sql, "phoenix_crm_offplan_exempt").includes("e.seat_id = p_seat"), "🔴 per seat: no other rep is reached");
  assert.ok(functionBody(sql, "phoenix_crm_venue_cap_lifted").includes("e.seat_id = p_seat"), "🔴 per seat: no other rep is reached");

  // The door and the write were replaced by the round-trip migration, so they are asked of the latest definition.
  const latest = read(ROUND_TRIP_MIGRATION);
  const door = functionBody(latest, "phoenix_crm_shared_place_day_cap");
  assert.ok(door.includes("v_cap := greatest(coalesce(v_cap, 3), coalesce(v_own, 0));"), "🔴 the door holds the greater of the company number and the venue's");
  assert.ok(door.includes("where sp.id = v_shared and sp.seat_id = new.seat_id;"), "🔴 a raised number holds for the seat that owns the venue: a moved customer's new rep keeps the company number, as that rep's plan does");
  assert.ok(door.indexOf("phoenix_crm_venue_cap_lifted(new.seat_id)") < door.indexOf("v_cap := greatest"), "a lifted venue returns before any number is read");
  assert.ok(door.includes("and not v.offplan_exempt"), "a stamped visit stays out of the count");

  const write = functionBody(latest, "phoenix_crm_venue_cap_set");
  assert.ok(write.includes("sp.seat_id = any(p_seats)") && write.includes("for update"), "🔴 only the rep's own seats, under the venue's lock");
  assert.ok(
    write.indexOf("e.ended_at is not null") < write.indexOf("(seat_id, label, shared_place_id, customer_id, note") && write.includes("(v_place.seat_id, v_place.name, v_place.id, v_account, 'Switched on"),
    "🔴 switching on looks up the account the last switch-off ended and writes it on the new row, so off then on is a round trip",
  );
  assert.ok(write.includes("set customer_id = coalesce(kept.customer_id, v_account)"), "🔴 the account moves to the second venue's row");
  assert.ok(/pl\.customer_id = v_account and pl\.shared_place_id = v_place\.id and pl\.retired_at is null\s+\) then\s+v_account := null;/.test(write), "🔴 unless it sits in the venue being switched off");
  assert.ok(!/other\.retired_at is null\s+and/.test(write), "🔴 a retired venue keeps its row, inert until it is restored");
  assert.ok(write.includes("p_cap <= coalesce(v_setting, 3) or p_cap > 20"), "🔴 the database refuses a number that is not a raise");
  assert.ok(write.includes("other.id <> v_place.id"), "🔴 a name key row reaching a second venue hands it a row of its own before it ends");
  assert.ok(write.indexOf("other.id <> v_place.id") < write.indexOf("set ended_at = now(), ended_by_hr_id = p_actor"), "and it does so first");
  assert.ok(write.includes("e.lifts_venue_cap = v_flag"), "🔴 the switch ends lifting rows only: a row freeing unplanned visits needs its own action");
  assert.ok(!/delete\s+from/i.test(write), "ended rows stay, so history stays");

  const code = sql.replace(/^--.*$/gm, "");
  assert.ok(!/update public\.phoenix_crm_settings/.test(code), "🔴 the settings are never raised");
  assert.ok(!/SEAT-[A-Z]+-REP/.test(code), "the migration names no rep: every row comes from the page");
  for (const signature of ["phoenix_crm_venue_cap_board(text[])", "phoenix_crm_venue_cap_set(text[], uuid, text, integer, text)"]) {
    assert.ok(code.includes(`revoke execute on function public.${signature} from public, anon, authenticated;`), `${signature} is closed to the browser roles`);
    assert.ok(code.includes(`grant execute on function public.${signature} to service_role;`), `${signature} is the service role's`);
  }
  assert.ok(code.includes("check (daily_cap is null or (daily_cap >= 1 and daily_cap <= 20))"), "the column holds the setting's own bound");
  assert.ok(code.includes("and shared_place_id is null"), "🔴 a whole-rep dated row can never name a venue");
}

function runGateRules(): void {
  const service = read("src/lib/phoenix-crm/server/venue-caps.ts");
  assert.match(service, /export function canManageVenueCaps\(viewer: PhoenixCrmViewer\): boolean \{\s*return viewer\.isSuperAdmin && viewer\.canUpdate && !viewer\.isTestPersona;/, "the Super Admin, never a test account");
  for (const fn of ["loadVenueCapsAdmin", "setVenueCap"]) {
    const body = service.slice(service.indexOf(`export async function ${fn}(`));
    assert.match(body.slice(0, 200), /assertManager\(viewer\);/, `${fn} refuses everybody but the Super Admin itself`);
  }
  assert.ok(service.includes("seatsByPerson(viewer).get(hrId)"), "🔴 the seats are read here, never taken from the page");
  assert.ok(!/notifyPhoenixCrm|sendEmail/.test(service), "no message and no email goes to anybody");

  const page = read("app/(admin)/admin/field-crm/venue-caps/page.tsx");
  assert.match(page, /if \(!viewer \|\| !canManageVenueCaps\(viewer\)\) redirect\("\/admin"\);/, "the page redirects anybody else");
  assert.ok(page.indexOf("canManageVenueCaps(viewer)") < page.indexOf("loadVenueCapsAdmin("), "the gate runs before the read");

  const route = read("app/api/phoenix-crm/venue-caps/route.ts");
  assert.match(route, /assertSameOriginMutation\(request\)/, "a same-origin POST");
  assert.match(route, /await assertPermission\(access, "phoenix_crm", "update"\)/, "it asks the permission first");

  assert.ok(read("src/lib/security/access-registry.ts").includes('pattern: "/api/phoenix-crm/venue-caps"'), "the route is on the registry");
  assert.ok(read("src/lib/system-audit/api-page-map.ts").includes('"/api/phoenix-crm/venue-caps": { admin: "/admin/field-crm/venue-caps" }'), "an error on it names its page");
  const nav = read("src/config/system-navigation.ts");
  const card = nav.slice(nav.indexOf('href: "/admin/field-crm/venue-caps"'), nav.indexOf('href: "/admin/field-crm/venue-caps"') + 400);
  assert.ok(card.includes('roles: ["Super Admin"]'), "🔴 the card draws for the Super Admin alone");
}

function runScreenRules(): void {
  const screen = read("src/components/phoenix-crm/venue-caps-admin.tsx");
  const block = screen.slice(screen.indexOf("const VENUE_COLUMNS = ["), screen.indexOf("] as const;"));
  const widths = [...block.matchAll(/width: "(\d+)%"/g)].map((match) => Number(match[1]));
  assert.equal(widths.length, 4, "the table names its widths");
  assert.equal(widths.reduce((sum, width) => sum + width, 0), 100, "under table-fixed anything over 100% is cut, never scrolled");
  assert.ok(screen.indexOf("<CrmCardsOnPhone>") < screen.indexOf("<CrmTable"), "the phone's cards come before the desktop table");
  assert.ok(!/overflow-x|truncate|rounded-(?!none)/.test(stripComments(screen)), "no horizontal scroll, no ellipsis, no round corners");
  assert.ok(screen.includes('"/api/phoenix-crm/venue-caps"'), "the page posts to its own route");
  assert.ok(screen.includes('next ? "lift" : "unlift"'), "🔴 the switch sends what it now says");
  assert.ok(screen.includes('dir="auto"'), "an Arabic venue name carries its own direction");
}
