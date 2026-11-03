import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";
import {
  lastDayOfOneMonth,
  parseRepExceptionAction,
  REP_EXCEPTION_DATES_TEXT,
  repExceptionDatesProblem,
  repExceptionStateLabel,
  repExceptionsExplainer,
  repStanding,
  suggestedRepExceptionWindow,
  type StoredRepWindow,
} from "../src/lib/phoenix-crm/rep-exception-rules.ts";

const MIGRATION = "supabase/migrations/20261103132005_phoenix_crm_rep_offplan_exception_admin.sql";

function read(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

/**
 * Owner, 2026-11-03: "build a module for admin only to open or close this feature by a toggle or be able to control
 * duration for any rep if needed exception".
 */
export function runPhoenixCrmRepExceptionsTests(): void {
  runDateRules();
  runStandingRules();
  runMigrationRules();
  runGateRules();
  runScreenRules();
}

function runDateRules(): void {
  const today = "2026-11-03";
  assert.equal(repExceptionDatesProblem("2026-11-01", "2026-11-30", today), null, "a window already running may start in the past");
  assert.equal(repExceptionDatesProblem("2026-11-03", "2026-11-03", today), null, "one day, today, is allowed");
  for (const [from, until] of [
    ["2026-11-30", "2026-11-01"],
    ["2026-10-01", "2026-11-02"],
    ["", "2026-11-30"],
    ["2026-11-01", ""],
    ["2026-02-31", "2026-11-30"],
    [null, undefined],
  ]) {
    assert.equal(repExceptionDatesProblem(from, until, today), REP_EXCEPTION_DATES_TEXT, `${String(from)} to ${String(until)} is refused`);
  }

  assert.equal(lastDayOfOneMonth("2026-10-24"), "2026-11-23", "Aya Mamdouh's own month");
  assert.equal(lastDayOfOneMonth("2026-11-01"), "2026-11-30", "Nora Kamal's own month");
  assert.equal(lastDayOfOneMonth("2027-01-31"), "2027-02-27", "a short month lands inside itself");
  assert.equal(lastDayOfOneMonth("2026-12-15"), "2027-01-14", "across a new year");

  assert.deepEqual(suggestedRepExceptionWindow("2026-11-01", "2026-11-03"), { from: "2026-11-01", until: "2026-11-30" }, "🔴 a new hire's first month is offered from the hire date");
  assert.deepEqual(suggestedRepExceptionWindow("2024-05-01", "2026-11-03"), { from: "2026-11-03", until: "2026-12-02" }, "an established rep starts today");
  assert.deepEqual(suggestedRepExceptionWindow("2026-11-20", "2026-11-03"), { from: "2026-11-03", until: "2026-12-02" }, "a hire date ahead of today is never offered");
  assert.deepEqual(suggestedRepExceptionWindow(null, "2026-11-03"), { from: "2026-11-03", until: "2026-12-02" }, "no hire date starts today");

  assert.equal(parseRepExceptionAction("open"), "open");
  assert.equal(parseRepExceptionAction("delete"), null, "nothing off the wire is trusted to be an action");

  const said = repExceptionsExplainer({ offPlanDailyCap: 2, offPlanWeeklyCap: 8 });
  assert.ok(said.includes("2 unplanned visits a day") && said.includes("8 a week"), "the page states the settings it was given");
  assert.ok(!/\b(account|accounts|doctor|doctors)\b/i.test(said), "the module's banned screen words");

  const day = (value: string) => value;
  assert.equal(repExceptionStateLabel({ on: false, from: "2026-11-01", until: "2026-11-30" }, today, day), "Usual limit");
  assert.equal(repExceptionStateLabel({ on: true, from: "2026-11-01", until: "2026-11-30" }, today, day), "No limit until 2026-11-30");
  assert.ok(repExceptionStateLabel({ on: true, from: "2026-12-01", until: "2026-12-31" }, today, day).startsWith("No limit from 2026-12-01"), "a window ahead says when it starts");
}

function runStandingRules(): void {
  const today = "2026-11-03";
  const row = (change: Partial<StoredRepWindow>): StoredRepWindow => ({ seatId: "S1", from: "2026-11-01", until: "2026-11-30", endedAt: null, grantedBy: "B-10", createdAt: null, ...change });

  assert.equal(repStanding([row({})], ["S1"], today).on, true, "an open row on the rep's seat is on");
  assert.equal(repStanding([row({ until: "2026-11-03" })], ["S1"], today).on, true, "🔴 the last day is still covered, as the door's between says");
  assert.equal(repStanding([row({ until: "2026-11-02" })], ["S1"], today).on, false, "🔴 past its last day it is off, with no job and no hand");
  assert.equal(repStanding([row({ endedAt: "2026-11-02T10:00:00Z" })], ["S1"], today).on, false, "a closed row is off");
  assert.equal(repStanding([row({ seatId: "OLD" })], ["S1"], today).on, false, "🔴 a row on a seat the rep has left never matches at the door, so it never reads as on");
  assert.equal(repStanding([row({ from: "2026-12-01", until: "2026-12-31" })], ["S1"], today).on, true, "a window ahead is on, so the switch can close it");
  assert.equal(repStanding([row({ until: "2026-11-20" }), row({ seatId: "S2", until: "2026-11-30" })], ["S1", "S2"], today).live?.seatId, "S2", "the latest last day speaks for a person on two seats");
}

function runMigrationRules(): void {
  const sql = read(MIGRATION);
  const code = sql.replace(/^--.*$/gm, "");

  assert.ok(code.includes("upper(btrim(e.hr_id)) = upper(btrim(p_rep))"), "🔴 the row takes the employee's stored spelling, because the door compares it exactly");
  assert.ok(code.includes("where e.rep_hr_id = v_rep\n    and e.ended_at is null;"), "🔴 ending reaches only this rep's open dated rows, never a venue row or another rep");
  assert.ok(code.includes("set ended_at = now(), ended_by_hr_id = p_actor"), "who closed it is kept");
  assert.ok(!/delete\s+from/i.test(code), "ended rows stay, so history stays");
  assert.ok(code.includes("p_from is null\n    or p_until is null\n    or p_from > p_until"), "🔴 the database refuses dates as the page does, a NULL included");
  assert.ok(code.includes("p_until < (now() at time zone 'Africa/Cairo')::date"), "a window wholly in the past is refused");
  assert.ok(code.includes("(seat_id, rep_hr_id, valid_from, valid_until, label, note, granted_by_hr_id)"), "the row the door already reads");
  assert.ok(code.includes("pg_advisory_xact_lock"), "two presses take turns");
  assert.ok(code.includes("on public.phoenix_crm_offplan_exemptions (seat_id, rep_hr_id)\n  where ended_at is null and rep_hr_id is not null;"), "🔴 one open window per seat and rep");
  assert.ok(!/update public\.phoenix_crm_settings/.test(code), "🔴 the settings are never raised");
  assert.ok(!/phoenix_crm_visits/.test(code), "🔴 no visit is rewritten");
  assert.ok(!/PD-\d+|SEAT-[A-Z]+-REP/.test(code), "the migration names no rep: every row comes from the page");

  const signature = "phoenix_crm_rep_exception_set(text[], text, text, date, date, text)";
  assert.ok(code.includes(`revoke execute on function public.${signature} from public, anon, authenticated;`), "closed to the browser roles");
  assert.ok(code.includes(`grant execute on function public.${signature} to service_role;`), "the service role's");
}

function runGateRules(): void {
  const service = read("src/lib/phoenix-crm/server/rep-exceptions.ts");
  assert.match(service, /export function canManageRepExceptions\(viewer: PhoenixCrmViewer\): boolean \{\s*return canUseSfeFieldControls\(viewer\);/, "🔴 the Super Admin and the SFE Manager (owner, 2026-11-03)");
  const access = read("src/lib/phoenix-crm/server/access.ts");
  const gate = access.slice(access.indexOf("export function canUseSfeFieldControls("));
  assert.match(gate.slice(0, 220), /if \(viewer\.isTestPersona\) return false;\s*if \(viewer\.isSuperAdmin\) return viewer\.canUpdate;\s*return viewer\.isSfeManager && viewer\.canApprove;/, "🔴 no test account, and no other holder of approve: a district manager holds it too");
  for (const fn of ["loadRepExceptionsAdmin", "setRepException"]) {
    const body = service.slice(service.indexOf(`export async function ${fn}(`));
    assert.match(body.slice(0, 220), /assertManager\(viewer\);/, `${fn} refuses everybody but those two itself`);
  }
  assert.ok(service.includes("seatsByPerson(viewer).get(hrId)"), "🔴 the seats are read here, never taken from the page");
  assert.ok(service.includes("repExceptionDatesProblem(body.from, body.until, viewer.cairoToday)"), "the server asks the dates again");
  assert.ok(!/notifyPhoenixCrm|sendEmail/.test(service), "no message and no email goes to anybody");
  assert.ok(service.includes("reps.filter((rep) => standings.get(rep.hrId)?.on).map(toRow)"), "🔴 every live exception is read, whatever the filter says");
  assert.ok(service.includes("stored.has(rep.hrId) && !standings.get(rep.hrId)?.on"), "a live one is not listed twice when no rep is chosen");

  const page = read("app/(admin)/admin/field-crm/rep-exceptions/page.tsx");
  assert.match(page, /if \(!viewer \|\| !canManageRepExceptions\(viewer\)\) redirect\("\/admin"\);/, "the page redirects anybody else");
  assert.ok(page.indexOf("canManageRepExceptions(viewer)") < page.indexOf("loadRepExceptionsAdmin("), "the gate runs before the read");

  const route = read("app/api/phoenix-crm/rep-exceptions/route.ts");
  assert.match(route, /assertSameOriginMutation\(request\)/, "a same-origin POST");
  assert.match(route, /await assertPermission\(access, "phoenix_crm", "approve"\)/, "it asks approve, which the SFE Manager holds and update is not");

  assert.ok(read("src/lib/security/access-registry.ts").includes('pattern: "/api/phoenix-crm/rep-exceptions"'), "the route is on the registry");
  assert.ok(read("src/lib/system-audit/api-page-map.ts").includes('"/api/phoenix-crm/rep-exceptions": { admin: "/admin/field-crm/rep-exceptions" }'), "an error on it names its page");
  const nav = read("src/config/system-navigation.ts");
  const at = nav.indexOf('href: "/admin/field-crm/rep-exceptions"');
  assert.ok(nav.slice(at, at + 400).includes('roles: ["Super Admin", "SFE Manager"]'), "🔴 the card draws for those two");
  assert.ok(nav.slice(at, at + 400).includes('{ resource: "phoenix_crm", action: "approve" }'), "🔴 and asks the verb the SFE Manager holds");
}

function runScreenRules(): void {
  const screen = read("src/components/phoenix-crm/rep-exceptions-admin.tsx");
  const block = screen.slice(screen.indexOf("const REP_COLUMNS = ["), screen.indexOf("] as const;"));
  const widths = [...block.matchAll(/width: "(\d+)%"/g)].map((match) => Number(match[1]));
  assert.equal(widths.length, 3, "the table names its widths");
  assert.equal(widths.reduce((sum, width) => sum + width, 0), 100, "under table-fixed anything over 100% is cut, never scrolled");
  assert.ok(screen.indexOf("<CrmCardsOnPhone>") < screen.indexOf("<CrmTable"), "the phone's cards come before the desktop table");
  assert.ok(!/overflow-x|truncate|rounded-(?!none)/.test(stripComments(screen)), "no horizontal scroll, no ellipsis, no round corners");
  assert.ok(screen.includes('"/api/phoenix-crm/rep-exceptions"'), "the page posts to its own route");
  assert.ok(screen.includes('next ? "open" : "close"'), "🔴 the switch sends what it now says");
  assert.ok(screen.includes('dir="auto"'), "an Arabic name carries its own direction");
  assert.ok(screen.indexOf("Exceptions in force") >= 0 && screen.indexOf("Exceptions in force") < screen.indexOf("Unplanned visit limit"), "🔴 the exceptions come first, the ordinary module under them (owner, 2026-11-03)");
  assert.ok(screen.includes('"Not recorded"'), "a row with no setter says so rather than leaving a blank");
  assert.ok(screen.includes("`rep-exception-${place}-from-${row.hrId}`"), "🔴 a chosen live rep is drawn twice, so an id carries its section");
}
