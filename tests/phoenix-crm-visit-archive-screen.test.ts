import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { scopeForRole, type AccessContext, type PhoenixRole } from "../src/lib/auth/permissions.ts";
import { canUseAdminCrmWorkspace } from "../src/lib/crm/admin-access.ts";
import {
  VISIT_ARCHIVE_PAGE_SIZE,
  VISIT_ARCHIVE_REASON_LABELS,
  VISIT_ARCHIVE_REASONS,
  VISIT_ARCHIVE_TAB_LABELS,
  VISIT_ARCHIVE_TAB_REASONS,
  VISIT_ARCHIVE_TABS,
  decodeVisitArchiveCursor,
  encodeVisitArchiveCursor,
  parseVisitArchiveFilter,
  parseVisitArchiveMonth,
  visitArchiveDateText,
  visitArchiveDistanceText,
  visitArchiveHref,
  visitArchiveMonthBounds,
  visitArchiveMonthLabel,
  visitArchivePersonLeft,
  visitArchivePointText,
  visitArchiveReasonLabel,
} from "../src/lib/phoenix-crm/visit-archive-rules.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — the visits archive screen (owner, 2026-11-07): the old iReports360 visits Phoenix CRM did
 * not take over as visits, read-only, on /admin/phoenix-crm/visits-archive.
 *
 * What would break silently:
 * - a Medical Rep or a District Manager reading the archive (the admin CRM workspace is the Super Admin's
 *   and the SFE Manager's), or the page or a loader reading without asking the gate;
 * - a stored reason code on the screen instead of its words;
 * - a page cursor that does not survive the address bar, or that lets typed text into the filter;
 * - a plain visit date shifted a day by a time zone;
 * - the screen reading anything but the archive (and the employee names), or reading it in a way that is
 *   not the keyset the table's index serves.
 */

const ROOT = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, ROOT), "utf8");

const PAGE = "app/(admin)/admin/phoenix-crm/visits-archive/page.tsx";
const READER = "src/lib/phoenix-crm/server/visit-archive.ts";

function viewer(role: PhoenixRole): Pick<AccessContext, "role" | "scope"> {
  return { role, scope: scopeForRole(role) };
}

function checkGate(): void {
  // The real gate, with each role's real scope.
  assert.equal(canUseAdminCrmWorkspace(viewer("Super Admin")), true, "the Super Admin reads the archive");
  assert.equal(canUseAdminCrmWorkspace(viewer("SFE Manager")), true, "and so does the SFE Manager, who owns CRM data quality");
  assert.equal(canUseAdminCrmWorkspace(viewer("Medical Rep")), false, "a Medical Rep never reads it");
  assert.equal(canUseAdminCrmWorkspace(viewer("District Manager")), false, "nor does a District Manager");

  // The reader's own predicate IS that gate, and every loader asks it before it reads.
  const reader = stripComments(read(READER));
  assert.match(
    reader,
    /export function canReadVisitArchive\([^)]*\): boolean \{\s*return canUseAdminCrmWorkspace\(access\);\s*\}/,
    "canReadVisitArchive is canUseAdminCrmWorkspace and nothing wider",
  );
  for (const loader of ["loadVisitArchiveOptions", "loadVisitArchivePage", "loadVisitArchiveTotals"]) {
    const start = reader.indexOf(`export async function ${loader}(`);
    assert.ok(start !== -1, `${loader} exists`);
    const body = reader.slice(start, reader.indexOf("\n}\n", start));
    const gate = body.indexOf("assertReader(access)");
    assert.ok(gate !== -1, `${loader} asks the gate`);
    for (const read of ["getSupabaseAdmin(", "cachedOptions(", "applyFilter(", "countWhere("]) {
      const at = body.indexOf(read);
      assert.ok(at === -1 || gate < at, `${loader} asks the gate before ${read}`);
    }
  }

  // The page asks the same gate before any loader runs.
  const page = stripComments(read(PAGE));
  const pageGate = page.indexOf("canUseAdminCrmWorkspace(access)");
  assert.ok(pageGate !== -1, "the page asks canUseAdminCrmWorkspace");
  assert.ok(pageGate < page.indexOf("loadVisitArchiveOptions("), "before the filter lists");
  assert.ok(pageGate < page.indexOf("loadVisitArchivePage("), "and before the rows");
  assert.match(page.slice(pageGate, pageGate + 200), /redirect\(/, "a refused viewer is redirected, never told what the page holds");

  // THE FAR TAB HAS THE SAME GATE (owner, 7 Nov 2026): the tab is read only after the gate, both tabs are this
  // one page with these loaders, and every loader asks the gate before it reads the filter that carries the tab.
  assert.ok(pageGate < page.indexOf("parseVisitArchiveFilter("), "the tab is read from the address only after the gate");
  assert.equal(page.match(/export default async function/g)?.length, 1, "one page serves both tabs — no second route to gate");
  assert.doesNotMatch(page.slice(0, page.indexOf("parseVisitArchiveFilter(")), /\btab\b/, "nothing before the gate depends on the tab");
  for (const loader of ["loadVisitArchivePage", "loadVisitArchiveTotals"]) {
    const start = reader.indexOf(`export async function ${loader}(`);
    const body = reader.slice(reader.indexOf("{", reader.indexOf(")", start)), reader.indexOf("\n}\n", start));
    const gate = body.indexOf("assertReader(access)");
    assert.ok(gate !== -1 && gate < body.indexOf("filter"), `${loader} asks the gate before it reads the tab`);
  }
}

function checkLabels(): void {
  assert.deepEqual([...VISIT_ARCHIVE_REASONS], ["campaign", "no_checkin_location", "far"], "the three reasons the archive stores");
  assert.equal(VISIT_ARCHIVE_REASON_LABELS.campaign, "Campaign visit");
  assert.equal(VISIT_ARCHIVE_REASON_LABELS.no_checkin_location, "No check-in location");
  assert.equal(VISIT_ARCHIVE_REASON_LABELS.far, "Far from the doctor");
  assert.equal(visitArchiveReasonLabel("far"), "Far from the doctor");

  // The two tabs, and every reason under exactly one of them.
  assert.deepEqual([...VISIT_ARCHIVE_TABS], ["retired", "far"]);
  assert.equal(VISIT_ARCHIVE_TAB_LABELS.retired, "Campaign and no location");
  assert.equal(VISIT_ARCHIVE_TAB_LABELS.far, "Far from the doctor");
  assert.deepEqual(
    VISIT_ARCHIVE_TABS.flatMap((tab) => [...VISIT_ARCHIVE_TAB_REASONS[tab]]).sort(),
    [...VISIT_ARCHIVE_REASONS].sort(),
    "every reason is listed under exactly one tab",
  );
  assert.equal(visitArchiveDistanceText(752.4), "752 m");
  assert.equal(visitArchiveDistanceText(12345), "12,345 m");
  assert.equal(visitArchiveDistanceText(null), "—");
  assert.equal(visitArchivePointText(30.044412, 31.235712), "30.04441, 31.23571");
  assert.equal(visitArchivePointText(null, 31.2), "—");
  assert.equal(visitArchiveReasonLabel("campaign"), "Campaign visit");
  assert.equal(visitArchiveReasonLabel("no_checkin_location"), "No check-in location");
  assert.equal(visitArchiveReasonLabel("some_new_reason"), "Some new reason", "an unknown reason reads as words, never as its code");
  assert.doesNotMatch(visitArchiveReasonLabel("some_new_reason"), /_/);
  assert.equal(visitArchiveReasonLabel(null), "—");

  assert.equal(visitArchivePersonLeft("active"), false);
  assert.equal(visitArchivePersonLeft("Active"), false, "the status is read without regard to case");
  assert.equal(visitArchivePersonLeft("resigned"), true, "anything but active is marked as left");
  assert.equal(visitArchivePersonLeft(null), false, "no record is not a leaver");
}

function checkCursorAndMonths(): void {
  const cursor = { visitDate: "2026-11-07", crmVisitId: "9007199254740993" };
  const encoded = encodeVisitArchiveCursor(cursor);
  assert.deepEqual(decodeVisitArchiveCursor(encoded), cursor, "the cursor survives the round trip, a bigint id beyond 2^53 included");
  assert.deepEqual(decodeVisitArchiveCursor(new URLSearchParams(`after=${encodeURIComponent(encoded)}`).get("after")), cursor, "and the address bar");
  for (const junk of ["", "2026-11-07", "2026-13-01.5", "2026-11-07.-1", "2026-11-07.1,visit_date.gt.2000-01-01", "abc.123", "2026-11-07.12345678901234567890"]) {
    assert.equal(decodeVisitArchiveCursor(junk), null, `"${junk}" is not a cursor`);
  }
  // The next page is an earlier day, or the same day with a smaller id — built on the server, both parts through
  // the shared PostgREST quoting helper (tests/postgrest-search-filter.test.ts), so the rules stay pure.
  {
    const server = stripComments(readFileSync(new URL("../src/lib/phoenix-crm/server/visit-archive.ts", import.meta.url), "utf8"));
    assert.match(server, /const day = quotePostgrestValue\(cursor\.visitDate\);\s*const id = quotePostgrestValue\(cursor\.crmVisitId\);/);
    assert.ok(server.includes("return `visit_date.lt.${day},and(visit_date.eq.${day},crm_visit_id.lt.${id})`;"), "the keyset filter");
  }

  assert.deepEqual(visitArchiveMonthBounds("2026-11"), { from: "2026-11-01", before: "2026-12-01" });
  assert.deepEqual(visitArchiveMonthBounds("2026-12"), { from: "2026-12-01", before: "2027-01-01" }, "December runs into the next year");
  assert.equal(visitArchiveMonthBounds("2026-13"), null);
  assert.equal(parseVisitArchiveMonth("2026-1"), null);
  assert.equal(visitArchiveMonthLabel("2026-11"), "November 2026");

  assert.equal(visitArchiveDateText("2026-11-07"), "Sat, 7 Nov 2026", "a plain date is printed from its own digits, never shifted by a zone");
  assert.equal(visitArchiveDateText("2024-02-29"), "Thu, 29 Feb 2024");
  assert.equal(visitArchiveDateText("2026-01-01"), "Thu, 1 Jan 2026");
  assert.equal(visitArchiveDateText("not a date"), "—");

  const filter = parseVisitArchiveFilter({ month: "2026-10", reason: "campaign", rep: "B-10", line: "CNS", after: encoded });
  assert.deepEqual(filter, { tab: "retired", month: "2026-10", reason: "campaign", rep: "B-10", line: "CNS", cursor });
  const dropped = parseVisitArchiveFilter({ tab: "everything", month: "October", reason: "violation", rep: "b-10';drop", line: "x".repeat(60) });
  assert.deepEqual(dropped, { tab: "retired", month: null, reason: null, rep: null, line: null, cursor: null }, "a value that does not parse is not applied");
  assert.equal(parseVisitArchiveFilter({ tab: "far" }).tab, "far");
  assert.equal(parseVisitArchiveFilter({ tab: "far", reason: "campaign" }).reason, null, "a reason outside the tab is not applied");
  assert.equal(parseVisitArchiveFilter({ tab: "retired", reason: "far" }).reason, null, "nor a far reason under the first tab");
  assert.equal(
    visitArchiveHref({ tab: "retired", month: "2026-10", reason: null, rep: "B-10", line: null }, cursor),
    `/admin/phoenix-crm/visits-archive?month=2026-10&rep=B-10&after=${encodeURIComponent(encoded)}`,
    "the next-page link keeps the filter",
  );
  assert.equal(
    visitArchiveHref({ tab: "far", month: null, reason: null, rep: "B-10", line: null }, cursor),
    `/admin/phoenix-crm/visits-archive?tab=far&rep=B-10&after=${encodeURIComponent(encoded)}`,
    "and the tab",
  );
  assert.equal(VISIT_ARCHIVE_PAGE_SIZE, 100);
}

function checkReadsOnlyTheArchive(): void {
  const reader = stripComments(read(READER));
  const tables = [...reader.matchAll(/\.from\(\s*([A-Za-z_"'`]+)/g)].map((match) => match[1]);
  assert.ok(tables.length > 0, "the reader reads something");
  for (const table of tables) {
    assert.ok(table === "ARCHIVE_TABLE" || table === '"employees"', `the reader reads only the archive and the employee names, not ${table}`);
  }
  assert.match(reader, /const ARCHIVE_TABLE = "phoenix_crm_visit_archive";/, "and the archive is phoenix_crm_visit_archive");
  assert.doesNotMatch(reader, /ireports360_|phoenix_crm_visits\b/, "never the old mirror or the live visits");
  assert.doesNotMatch(reader, /\.(?:insert|update|upsert|delete|rpc)\(/, "it writes nothing");
  assert.match(reader, /\.order\("visit_date", \{ ascending: false \}\)\s*\.order\("crm_visit_id", \{ ascending: false \}\)/, "the list is keyset-ordered as the index is");
  assert.match(reader, /\.or\(visitArchiveKeysetFilter\(filter\.cursor\)\)/, "and the next page is a keyset, never an offset");
  assert.doesNotMatch(reader, /\.range\(/, "no offset read on the list");
  assert.match(reader, /if \(options\.tab\) next = next\.in\("reason", \[\.\.\.VISIT_ARCHIVE_TAB_REASONS\[filter\.tab\]\]\);/, "every read is held to the open tab's reasons");
  assert.doesNotMatch(reader, /tab: false/, "and no read opts out of it");

  const page = stripComments(read(PAGE));
  assert.doesNotMatch(page, /\.from\(|getSupabaseAdmin|createClient/, "the page reads only through the reader");
  assert.doesNotMatch(page, /\brounded(?:-|\b)|\btruncate\b|line-clamp|overflow-x-auto|min-w-\[|…/, "square, never cut, never a sideways scroll");
  assert.match(page, /<table className="w-full table-fixed border-collapse">/, "the desktop table fits the screen");
  assert.match(page, /<colgroup>/);
  assert.match(page, /lg:hidden/, "and a phone gets cards");
  assert.doesNotMatch(page, /hrId\s*\|\||\{row\.hrId\}|\{rep\.hrId\}<|agentHrId/, "an HR id is never printed");

  const navigation = read("src/config/system-navigation.ts");
  const at = navigation.indexOf('href: "/admin/phoenix-crm/visits-archive"');
  assert.ok(at !== -1, "the CRM hub draws a card for the archive");
  const card = navigation.slice(at, navigation.indexOf("\n  },", at));
  assert.match(card, /label: "Visits archive"/);
  assert.match(card, /roles: \["Super Admin", "SFE Manager"\]/, "for exactly the admin CRM workspace's two people");
  assert.ok(navigation.includes('          "/admin/phoenix-crm/visits-archive",'), "and it sits in a band of the CRM hub");
}

export function runPhoenixCrmVisitArchiveScreenTests(): void {
  const sections: Array<[string, () => void]> = [
    ["the gate", checkGate],
    ["the labels", checkLabels],
    ["the cursor and the months", checkCursorAndMonths],
    ["reads only the archive", checkReadsOnlyTheArchive],
  ];
  const failures: string[] = [];
  for (const [name, check] of sections) {
    try {
      check();
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  assert.deepEqual(failures, [], `Phoenix CRM visits archive:\n${failures.join("\n")}`);
}
