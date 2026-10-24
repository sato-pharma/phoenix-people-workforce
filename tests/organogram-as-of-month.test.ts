import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import {
  ORGANOGRAM_HISTORY_START_MONTH,
  formatOrganogramAsOfDay,
  formatOrganogramAsOfMonth,
  isValidOrganogramAsOfMonth,
  listOrganogramAsOfMonths,
  organogramAsOfMonthEnd,
  parseOrganogramAsOfParam,
} from "../src/lib/reports/organogram-as-of.ts";
import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

/**
 * The organogram can be drawn as it stood at the end of a finished month. The answer is the seat
 * model's own dated history (one read-only database function), never an interpolation — so this
 * pins the month rules, the database function's shape, and the places the read-only past picture
 * must differ from the live chart.
 */
export async function runOrganogramAsOfMonthTests() {
  // ── Which months can be asked for ─────────────────────────────────────────────────────────
  assert.equal(ORGANOGRAM_HISTORY_START_MONTH, "2026-07", "the seat model's first seat starts 2026-07-13");

  const now = "2026-10";
  assert.equal(isValidOrganogramAsOfMonth("2026-09", now), true, "a finished month in range is choosable");
  assert.equal(isValidOrganogramAsOfMonth("2026-07", now), true, "the first month of the seat model is choosable");
  assert.equal(isValidOrganogramAsOfMonth("2026-06", now), false, "before the seat model there are no seats to draw");
  assert.equal(isValidOrganogramAsOfMonth("2026-10", now), false, "the current month has not ended — that is the live chart");
  assert.equal(isValidOrganogramAsOfMonth("2026-11", now), false, "a future month has no history");
  for (const bad of ["", "2026", "2026-9", "2026-13", "2026-00", "26-09", "2026-09-30", "september", "2026-09; drop"]) {
    assert.equal(isValidOrganogramAsOfMonth(bad, now), false, `"${bad}" is not a month the chart can be asked for`);
  }
  assert.equal(isValidOrganogramAsOfMonth(null, now), false);
  assert.equal(isValidOrganogramAsOfMonth(undefined, now), false);

  // ── The date the history is read at: the LAST day of the month ────────────────────────────
  assert.equal(organogramAsOfMonthEnd("2026-07"), "2026-07-31");
  assert.equal(organogramAsOfMonthEnd("2026-09"), "2026-09-30");
  assert.equal(organogramAsOfMonthEnd("2026-12"), "2026-12-31", "December must not roll into month 13");
  assert.equal(organogramAsOfMonthEnd("2027-02"), "2027-02-28");
  assert.equal(organogramAsOfMonthEnd("2028-02"), "2028-02-29", "a leap February ends on the 29th");
  assert.throws(() => organogramAsOfMonthEnd("2026-9"), /not YYYY-MM/, "a malformed month is a programming error, not a guess");

  // ── What the picker offers: newest first, back to the start, across a year boundary ───────
  assert.deepEqual(listOrganogramAsOfMonths("2026-10"), ["2026-09", "2026-08", "2026-07"]);
  assert.deepEqual(listOrganogramAsOfMonths("2026-08"), ["2026-07"]);
  assert.deepEqual(listOrganogramAsOfMonths("2026-07"), [], "nothing has finished since the seat model began");
  assert.deepEqual(
    listOrganogramAsOfMonths("2027-02"),
    ["2027-01", "2026-12", "2026-11", "2026-10", "2026-09", "2026-08", "2026-07"],
    "January rolls back into December of the year before",
  );
  for (const month of listOrganogramAsOfMonths("2027-02")) {
    assert.equal(isValidOrganogramAsOfMonth(month, "2027-02"), true, `${month}: the picker only offers what the API accepts`);
  }
  assert.deepEqual(listOrganogramAsOfMonths("garbage"), [], "an unreadable clock offers nothing rather than throwing");

  assert.equal(formatOrganogramAsOfMonth("2026-09"), "September 2026");
  assert.equal(formatOrganogramAsOfDay("2026-09"), "30 September 2026");
  assert.equal(formatOrganogramAsOfDay("2028-02"), "29 February 2028");

  // ── The query parameter: blank is live, a bad month is REFUSED, never turned into today ───
  assert.deepEqual(parseOrganogramAsOfParam(null, now), { ok: true, month: null });
  assert.deepEqual(parseOrganogramAsOfParam("   ", now), { ok: true, month: null });
  assert.deepEqual(parseOrganogramAsOfParam("2026-08", now), { ok: true, month: "2026-08" });
  for (const bad of ["2026-10", "2026-06", "nonsense", "2026-09-30"]) {
    const parsed = parseOrganogramAsOfParam(bad, now);
    assert.equal(parsed.ok, false, `"${bad}" must be refused — a link that asked for a date never gets another date's chart`);
  }

  // ── The database function: shape, grants, and the rules that make it a record of the past ──
  const migrationDir = "supabase/migrations";
  const migrationFile = readdirSync(migrationDir).find((name) => name.endsWith("_org_tree_as_of_month.sql"));
  assert.ok(migrationFile, "the as-of function ships as a migration");
  const code = stripSqlComments(readFileSync(`${migrationDir}/${migrationFile}`, "utf8"));
  assert.match(code, /create or replace function public\.au_f_org_tree_as_of\(p_date date\)/, "one function, taking a date");
  assert.match(
    code,
    /revoke execute on function public\.au_f_org_tree_as_of\(date\) from public, anon, authenticated;/,
    "seat history names people and their moves: never reachable with the browser key",
  );
  assert.match(code, /grant execute on function public\.au_f_org_tree_as_of\(date\) to service_role;/);
  assert.match(code, /set search_path = ''/, "a definer function pins its search path");
  assert.match(code, /s\.effective_from <= p_date/, "a seat is drawn from the day it begins");
  assert.match(code, /s\.effective_to is null or s\.effective_to > p_date/, "and not after it is retired (half-open)");
  assert.doesNotMatch(code, /\bs\.is_active\b/, "is_active says whether a seat is live NOW — the retired Upper Egypt seat must still draw for July and August");
  assert.doesNotMatch(code, /f_seat_occupant_asof/, "that resolver credits today's holder with a seat's whole history; the picture of the past reads the raw spans");
  assert.doesNotMatch(code, /current_date/, "a past picture takes its date as an argument; the only clock is Cairo's, in the proof block");
  assert.match(code, /coalesce\(o\.region_code, s\.region_code\)/, "region comes from the span first — re-parented seats carried a different region");
  assert.match(code, /exists \(select 1 from alive m where m\.seat_id = o\.manager_seat_id\)/, "a span whose manager seat is not on the chart that day falls back to the seat's own parent instead of dropping the rep");

  // ── The report builder: the past is the structure only ───────────────────────────────────
  const source = stripComments(readFileSync("src/lib/reports/organogram-au-source.ts", "utf8"));
  assert.match(source, /supabase\.rpc\("au_f_org_tree_as_of", \{ p_date: organogramAsOfMonthEnd\(asOfMonth\) \}\)/, "a month is read through the dated function");
  assert.match(source, /: await supabase\s*\.from\("au_v_org_tree"\)/, "the live chart still reads the live view");
  assert.match(source, /const offerLoad[^;]*= asOfMonth\s*\? Promise\.resolve\(new Map\(\)\)\s*: loadOfferOutBySeat\(\)/, "no open offers on a past month's empty chairs");
  assert.match(source, /const vacancyLoad = asOfMonth\s*\? null/, "nor a read of today's open Head Office seats for a past month");
  assert.match(source, /getMergedAreaName\(s\.line_code, s\.area_code \?\? "", asOfMonth\)/, "area merges follow the month shown, like the closings do");
  const asOfExit = source.indexOf("if (asOfMonth) {");
  const headOffice = source.indexOf("buildHeadOfficeOrganogramRows(");
  assert.ok(asOfExit !== -1 && headOffice !== -1 && asOfExit < headOffice, "a past month returns BEFORE the undated Head Office branch is built");

  // ── The API and the scoped report: same access, no silent substitution ───────────────────
  const route = stripComments(readFileSync("app/api/reports/organogram/route.ts", "utf8"));
  assert.match(route, /parseOrganogramAsOfParam\(new URL\(request\.url\)\.searchParams\.get\("asOf"\)\)/);
  assert.match(route, /organogram_as_of_invalid[\s\S]*?status: 400/, "a bad month is a 400, not today's chart");
  assert.ok(
    route.indexOf('assertPermission(access, "organogram", "read")') < route.indexOf("parseOrganogramAsOfParam("),
    "the permission check comes before anything about the date is read",
  );
  assert.equal((route.match(/getOrganogramReport\(access, \{ asOfMonth,/g) ?? []).length, 2, "company and line scope both carry the month");

  const report = stripComments(readFileSync("src/lib/reports/organogram.ts", "utf8"));
  assert.match(report, /buildOrganogramSeatReport\(\{ asOfMonth \}\)/);
  assert.match(report, /!isValidOrganogramAsOfMonth\(asOfMonth\)\) \{\s*throw new Error/, "the builder itself refuses an unfinished month");

  // ── The chart: a past picture is read-only ───────────────────────────────────────────────
  const chart = stripComments(readFileSync("src/components/organogram/org-chart.tsx", "utf8"));
  assert.match(chart, /const mayChangeEmployees = canAddEmployee && !asOfMonth;/, "no Edit, Resign or Add-employee on a past picture — decided once");
  assert.match(chart, /<OrgChartTreeBody \{\.\.\.props\} canAddEmployee=\{mayChangeEmployees\} \/>/, "the popup receives the same decision");
  assert.match(chart, /\{asOfMonth \? <OrganogramAsOfBanner month=\{asOfMonth\} \/> : null\}/, "the page says it is a picture of the past");
  assert.match(chart, /\{asOfMonth \? null : \(\s*<>\s*<ExportXlsxButton/, "no spreadsheet of today's contact details under a past month");
  assert.match(chart, /audienceOpen && !asOfMonth/, "and no email picker");

  const banner = stripComments(readFileSync("src/components/organogram/organogram-as-of.tsx", "utf8"));
  assert.doesNotMatch(banner, /print:hidden/, "the banner prints: a page taken off this screen must say it is the past");
  assert.doesNotMatch(banner, /rounded/, "square edges");

  // The two screens fetch the month and label the chart by the date of the report they HOLD.
  for (const file of [
    "src/components/reports/organogram-report.tsx",
    "src/components/employee-portal/employee-organogram-dashboard.tsx",
  ]) {
    const screen = stripComments(readFileSync(file, "utf8"));
    assert.match(screen, /\/api\/reports\/organogram\?asOf=/, `${file} asks the API for the month`);
    assert.match(screen, /asOfMonth=\{reportAsOf\}/, `${file} labels the chart with the report it holds, never with the picker`);
    assert.match(screen, /setAsOfMonth\(reportAsOfRef\.current\)/, `${file} puts the picker back when a pick fails`);
    assert.match(screen, /request !== latestRequest\.current/, `${file} ignores a late answer for a date nobody is looking at`);
  }

  // ── Edit and Resign are also in the person's popup ───────────────────────────────────────
  const modal = stripComments(readFileSync("src/components/organogram/organogram-node-detail-modal.tsx", "utf8"));
  assert.match(modal, /!isVacancy && canAddEmployee && row\.hrId \? \(/, "people only, and only for a viewer who may change employees");
  assert.match(modal, /buildEmployeeMasterHref\(masterBasePath, "edit", row\.hrId\)/);
  assert.match(modal, /buildEmployeeMasterHref\(masterBasePath, "resign", row\.hrId\)/);

  // ── Layout (measured at 375, 768, 1024 and 1280 on the real markup, 14 Oct 2026) ───────────
  // As a third column the status box was squeezed to 91px (and 186px tall) between 768 and about
  // 1100px. Two columns at tablet width, three only from xl, and the box takes its own row below.
  const adminScreen = readFileSync("src/components/reports/organogram-report.tsx", "utf8");
  assert.match(
    adminScreen,
    /md:grid-cols-\[minmax\(240px,360px\)_minmax\(200px,260px\)\] xl:grid-cols-\[minmax\(240px,360px\)_minmax\(200px,260px\)_1fr\]/,
    "search and the month picker are two columns at tablet width; the third column waits for xl",
  );
  assert.match(adminScreen, /flex items-end md:col-span-2 xl:col-span-1/, "below xl the status box spans both columns instead of being squeezed into a third");
  assert.match(adminScreen, /labelClassName="text-xs font-medium text-text-secondary"/, "the picker's label matches the Search label beside it");
}
