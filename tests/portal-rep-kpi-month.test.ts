import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { CRM_DATA_FLOOR_MONTH, kpiMonthOptions, selectKpiCoverageRep, type KpiRepRow } from "../src/lib/crm/kpis-board.ts";
import { resolveKpiTab } from "../src/lib/crm/kpis-tabs.ts";
import { repsPlansRange } from "../src/lib/crm/reps-plans.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * THE MEDICAL REP PICKS THE MONTH HIS LANDING KEYCARDS SHOW.
 *
 * Owner, 2026-10-01: *"in medical rep emp portal I want to be able in overview landing page to choose
 * the month of the KPIs showing data — example now I /10 no any KPIs, I chose Sep I got full view in
 * keycards of Sep KPIs."* On the 1st of a month all four keycards are empty and each is empty for a
 * different, correct reason — no closing may be published for a running month (the closing golden
 * rule), no plan has been scored, no visit logged — so the page reads as broken when nothing is
 * broken. The remedy is to let him name the month.
 *
 * Two halves, and the first is the one that can go wrong silently:
 *
 *  1. BEHAVIOUR. Handing the picked month to the KPI board must actually score the WHOLE of that
 *     month. The board takes a month AND today, and it needs both: `repsPlansRange` scores a window
 *     that is entirely in the past to its own end and one still running only as far as it has run.
 *     Passing the picked month as `todayIso` — the obvious-looking simplification — would score
 *     September as if it were still mid-flight, which on the 1st of October means one day of it.
 *  2. SHAPE. The month travels from the URL through `getPortalHomeSnapshot` to every one of the four
 *     tiles, and the two easy ways to break that are to re-derive it from today inside a loader, or
 *     to let achievement keep labelling itself with the running Cairo month while the other three
 *     tiles show the picked one. Both are pinned below.
 *
 * Comments are stripped before every source read: this file's own prose spells the strings it pins,
 * and a test that matched its own explanation would pin nothing (AGENTS.md §2.1).
 */

const SNAPSHOT = "src/lib/employee-portal/home-snapshot.ts";
const PAGE = "app/employee-portals/page.tsx";
const CENTER = "src/components/employee-portal/portal-command-center.tsx";
const PICKER = "src/components/employee-portal/rep-kpi-month-picker.tsx";

/** Source with comments removed and whitespace flattened — these files are hard-wrapped at ~100 cols. */
const flat = (path: string) => stripComments(readFileSync(path, "utf8")).replace(/\s+/g, " ");

export function runPortalRepKpiMonthTests() {
  // ── 1. The month list ────────────────────────────────────────────────────────────────────────
  // One authority on which months exist, shared with the KPIs board's own picker. Newest first, the
  // running month at the head (so the fallback and the list can never disagree), and nothing below
  // the CRM data floor — a month with no data behind it is not an option, it is an empty screen.
  const options = kpiMonthOptions("2026-10-01");
  assert.ok(options.length > 0, "kpiMonthOptions returned nothing for a date inside the CRM window");
  assert.equal(options[0].value, "2026-10", "the running month must be the first option");
  assert.ok(
    options.some((option) => option.value === "2026-09"),
    "the month before the running one must be offered — it is the whole point of the picker",
  );
  assert.ok(
    options.every((option) => option.value <= "2026-10"),
    "a future month must never be offered: it can only ever score empty",
  );
  assert.ok(
    options.every((option) => option.value >= CRM_DATA_FLOOR_MONTH),
    `no option may predate the CRM data floor ${CRM_DATA_FLOOR_MONTH}`,
  );

  // ── 2. A picked past month scores WHOLE ──────────────────────────────────────────────────────
  // The feature is worth nothing if this is not true. On 1 October, September must score 1–30
  // September, not one day and not an empty window.
  const september = repsPlansRange("2026-09", "2026-10-01");
  assert.equal(september.dateFrom, "2026-09-01", "a picked past month must start on its own first day");
  assert.equal(september.dateTo, "2026-09-30", "a picked past month must be scored to its OWN end, not to today");
  assert.equal(september.notStarted, false, "a month already over has plainly started");

  // And the running month is still capped where it always was, so picking it changes nothing.
  const october = repsPlansRange("2026-10", "2026-10-09");
  assert.equal(october.dateFrom, "2026-10-01");
  assert.ok(october.dateTo <= "2026-10-09", "the running month must never be scored past today");

  // The trap this replaced: the picked month standing in for today. It reads as a tidy
  // simplification and it silently truncates every past month to a single day.
  const asIfToday = repsPlansRange("2026-09", "2026-09-01");
  assert.equal(
    asIfToday.dateTo,
    "2026-09-01",
    "control: passing the picked month as todayIso scores ONE day — which is why both values travel",
  );

  // ── 3. The month travels; no loader re-derives it ────────────────────────────────────────────
  const snapshot = flat(SNAPSHOT);

  assert.ok(
    /getPortalHomeSnapshot\(\s*access: AccessContext,\s*options\?:/.test(snapshot),
    `${SNAPSHOT}: getPortalHomeSnapshot must accept the picked month from its caller`,
  );
  assert.ok(
    snapshot.includes("kpiMonthOptions(today)"),
    `${SNAPSHOT}: the month list must come from kpiMonthOptions, never a second opinion on which months exist`,
  );
  assert.ok(
    /kpiMonths\.some\(\s*\(option\) => option\.value === requestedKpiMonth\s*\)\s*\? requestedKpiMonth\s*: runningMonth/.test(
      snapshot,
    ),
    `${SNAPSHOT}: a month off the URL must be validated by MEMBERSHIP of that list and fall back to the running month`,
  );
  assert.ok(
    snapshot.includes("loadMrFieldKpis(access, hrId, kpiMonth)"),
    `${SNAPSHOT}: the CRM KPI read must be given the month on screen`,
  );
  assert.ok(
    snapshot.includes("loadMrCanonicalSales(hrId, kpiMonth)"),
    `${SNAPSHOT}: achievement must follow the same month as the other three tiles`,
  );
  assert.ok(
    !/month:\s*todayIso\.slice/.test(snapshot),
    `${SNAPSHOT}: the KPI board's month must not be re-derived from today inside the loader — that ignores the picker`,
  );
  // `includeReports: false` may sit between them: the tile never shows the two per-rep reports, so the
  // landing page skips that read (pinned in tests/portal-rep-navigation-speed.test.ts).
  assert.ok(
    /getKpisBoard\(\{\s*access,(?:\s*includeReports:\s*false,)?\s*month,\s*todayIso\s*\}\)/.test(snapshot),
    `${SNAPSHOT}: the board needs BOTH the picked month and the real Cairo day (see the control above)`,
  );

  // ── 4. The URL is the carrier ────────────────────────────────────────────────────────────────
  const page = flat(PAGE);
  assert.ok(
    page.includes("searchParams"),
    `${PAGE}: the month rides in the URL so every change re-runs the page's access gates server-side`,
  );
  assert.ok(
    /getPortalHomeSnapshot\(access,\s*\{\s*kpiMonth: one\(params\.kpiMonth\)(,\s*streamRepCards: true)?(,\s*streamRoleExtras: true)?(,\s*streamDvFocus: true)?,?\s*\}\)/.test(page),
    `${PAGE}: ?kpiMonth must reach the snapshot, first value only`,
  );

  // ── 5. Four tiles, one month ─────────────────────────────────────────────────────────────────
  const center = flat(CENTER);
  assert.ok(
    center.includes("<RepKpiMonthPicker"),
    `${CENTER}: the rep layout must mount the month picker`,
  );
  assert.ok(
    /const selectedYear = Number\(kpiMonth\.slice\(0, 4\)\)/.test(center) &&
      /const selectedMonth = Number\(kpiMonth\.slice\(5, 7\)\)/.test(center),
    `${CENTER}: the achievement tile's month label must come from the picked month`,
  );
  assert.ok(
    !center.includes("currentCairoDateParts"),
    `${CENTER}: the achievement label must not be stamped with the running Cairo month — that is the two-windows bug`,
  );
  assert.ok(
    center.includes("mrSalesAchievement.targetValue > 0"),
    `${CENTER}: a published month with no target has an achievement of 0 by arithmetic, and must not be drawn as one`,
  );
  // 🔒 THE FALLBACK IS HIS RULING, NOT AN ACCIDENT — put to him as an open question the morning the
  // picker shipped and answered in his own words (owner, 2026-10-01): "keep the achievement tile
  // falling back to the last published month". Pick September before its closing is published and
  // the tile reads AUG 2026 beside three tiles reading SEP 2026, which LOOKS like a defect and is a
  // decision. Both halves must survive: the fallback itself, and the label naming the month it fell
  // back to — without that label the tile would silently pass August off as September's achievement,
  // which is the only version of this that would genuinely be a bug.
  assert.ok(
    /const achValue = achFromSelected \? mrSalesAchievement : latestClosed/.test(center),
    `${CENTER}: an unpublished picked month must fall back to the last published one, never to an empty tile`,
  );
  assert.ok(
    /: latestClosed \? monthName\(latestClosed\.month, latestClosed\.year\)/.test(center),
    `${CENTER}: the fallback must NAME the month it is showing — that label is what keeps it honest`,
  );
  // The alert row under the tiles names the month in its own detail line — "20 of 90 covered ·
  // September 2026" — and its Open button must land on that same month. A bare link was correct
  // only while the landing page could show nothing but the running month; with the picker it makes
  // one row name September and open October, which is the page contradicting itself in one click.
  // The tab is the owner's own instruction (2026-10-01): the row counts doctors he has not reached,
  // and Coverage is the ONE tab that lists them by name — Summary answers with three percentages.
  assert.ok(
    /href=\{`\/employee-portals\/kpis\/coverage\?month=\$\{kpiMonth\}`\}/.test(center),
    `${CENTER}: the missed-doctors row must open the Coverage report on the month it just named (a page of its own since the 2026-10-14 split)`,
  );
  // Both halves of that URL must be ones the page honours, so the link cannot rot into a silent
  // no-op: an unrecognised tab WIDENS to Summary rather than erroring, which is exactly the screen
  // this change moved off, and nothing on the page would say so.
  assert.equal(resolveKpiTab("coverage"), "coverage", "the KPIs page must still recognise ?tab=coverage");
  assert.equal(resolveKpiTab("covrage"), "summary", "control: an unrecognised tab falls back to Summary with no error");
  // And the Coverage tab opens a MEDICAL REP's own list with no `?rep=` in the link, because his
  // board holds exactly one row — himself. That is what the href relies on; putting a `rep` key in
  // it instead would mean guessing the doctor-list builder's own key for him on the landing page.
  const soleRep = { coverageRepKey: "crm:4210", repName: "Aya Ibrahim" } as unknown as KpiRepRow;
  assert.equal(
    selectKpiCoverageRep([soleRep], null),
    soleRep,
    "a one-row board (a medical rep looking at himself) must open his doctor list unasked",
  );
  assert.equal(
    selectKpiCoverageRep([soleRep, { coverageRepKey: "crm:99", repName: "Other" } as unknown as KpiRepRow], null),
    null,
    "control: a manager's board names nobody until the URL does — the one-row case is what makes the rep's link work",
  );

  // ── 6. The control itself ────────────────────────────────────────────────────────────────────
  const pickerRaw = readFileSync(PICKER, "utf8");
  assert.ok(pickerRaw.startsWith('"use client"'), `${PICKER}: the picker navigates, so it is a client component`);
  const picker = flat(PICKER);
  assert.ok(picker.includes("<select"), `${PICKER}: a native select — the control the fits-the-screen rule names`);
  assert.ok(
    picker.includes("text-base"),
    `${PICKER}: a select under 16px makes iOS zoom the whole page — it keeps text-base and the row wraps around it`,
  );
  assert.ok(
    !/\brounded(-|\b)/.test(picker),
    `${PICKER}: the square-edge golden rule — no round or semi-round corners anywhere`,
  );
  assert.ok(
    !picker.includes("overflow-x-auto"),
    `${PICKER}: a horizontal scroll is the bug the fits-the-screen rule names, never the fix`,
  );
  assert.ok(
    !picker.includes("kpiMonthOptions"),
    `${PICKER}: the options arrive as plain data — importing the board module into the browser bundle 500s at runtime`,
  );
}
