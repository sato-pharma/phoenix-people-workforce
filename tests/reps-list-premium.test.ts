import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { brickCoverage, groupRepsByTeam, listMix, meterPercent, repInitials, shareSlices, teamHeading, type TeamOfRep } from "../src/lib/crm/reps-list-groups.ts";
import { planWeekMix } from "../src/lib/crm/plan-week-mix.ts";
import { districtSeatAbove, groupByRegionAndManager } from "../src/lib/phoenix-crm/region-manager-groups.ts";
import type { OrgSeat } from "../src/lib/phoenix-crm/scope.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * The Reps List premium pass (owner, 2026-11-09: "premium polish big work every single component", then "group reps
 * by district manager"). Three things are pinned here: the cards are grouped by region and district manager through
 * the one shared rule, the arithmetic behind the meters and the share bars, and the print-like finish of the shared
 * chrome — flat ink, square edges, nothing that scrolls sideways.
 */

const CHROME = "src/components/crm/reps-list-chrome.tsx";
const BOARDS = [
  "src/components/crm/reps-list-board.tsx",
  "src/components/crm/reps-weekly-plans-board.tsx",
  "src/components/crm/reps-list-vacant-areas.tsx",
] as const;
const CONTROLS = [
  "src/components/crm/reps-list-filters.tsx",
  "src/components/crm/plan-week-picker.tsx",
  "src/components/crm/plan-status-picker.tsx",
  "src/components/crm/reps-list-tabs.tsx",
] as const;

function seat(seatId: string, tier: string, path: string[], extra: Partial<OrgSeat> = {}): OrgSeat {
  return {
    areaName: null,
    lineCode: "PD",
    lineName: "Pedia",
    occupantHrId: null,
    parentSeatId: path.length > 1 ? path[path.length - 2]! : null,
    path,
    regionName: null,
    seatId,
    seatLabel: null,
    tier,
    ...extra,
  };
}

/** A source file without its comments — the repo's one comment stripper, which tracks an open comment across lines. */
function codeOnly(source: string): string {
  return stripComments(source);
}

function team(key: string, order: number, regionName: string, managerName: string | null): TeamOfRep {
  return { key, managerName, order, regionName };
}

function groupsFollowTheSharedRule() {
  // The organogram: an RSM over two districts in two regions, one rep reporting straight to the RSM, and the per-line
  // "Others" bucket, which is never a district.
  const seats = new Map<string, OrgSeat>(
    [
      seat("RSM", "RSM", ["RSM"], { occupantHrId: "PD-0001", regionName: "Alex-BHR" }),
      seat("DM-D2", "DM", ["RSM", "DM-D2"], { occupantHrId: "PD-0100", regionName: "Delta (2)" }),
      seat("DM-AB", "ACTING_DM", ["RSM", "DM-AB"], { occupantHrId: null, regionName: "Alex-BHR" }),
      seat("OTHERS", "DM", ["RSM", "OTHERS"], { isOtherPseudoDm: true, regionName: "Delta (1)" }),
      seat("R1", "REP", ["RSM", "DM-D2", "R1"], { regionName: "Delta (2)" }),
      seat("R2", "REP", ["RSM", "DM-AB", "R2"], { regionName: "Alex-BHR" }),
      seat("R3", "REP", ["RSM", "R3"], { regionName: "Delta (1)" }),
      seat("R4", "REP", ["RSM", "OTHERS", "R4"], { regionName: "Delta (1)" }),
    ].map((row) => [row.seatId, row]),
  );

  assert.equal(districtSeatAbove(seats, seats.get("R1")!)?.seatId, "DM-D2", "a rep's district is the nearest DM seat on his path");
  assert.equal(districtSeatAbove(seats, seats.get("R2")!)?.seatId, "DM-AB", "an acting district manager's seat is a district too");
  assert.equal(districtSeatAbove(seats, seats.get("R3")!), null, "a rep straight under the RSM has no district manager");
  assert.equal(districtSeatAbove(seats, seats.get("R4")!), null, "the per-line Others bucket is never a district");
  assert.equal(districtSeatAbove(seats, seats.get("DM-D2")!), null, "a district seat is not its own district");

  const groups = groupByRegionAndManager(["R1", "R2", "R3", "R4"], (id) => seats.get(id)!, (row) => districtSeatAbove(seats, row));
  assert.deepEqual(
    groups.map((group) => [group.regionName, group.district?.seatId ?? null, group.items]),
    [
      ["Alex-BHR", "DM-AB", ["R2"]],
      ["Delta (1)", null, ["R3", "R4"]],
      ["Delta (2)", "DM-D2", ["R1"]],
    ],
    "the cascade's teams are the shared rule's groups — region order, then the district seat",
  );

  // The cards come out in the team order the cascade resolved, every rep exactly once, the incoming order kept inside.
  const reps = [
    { name: "Zeinab", team: team("Delta (2)|DM-D2", 2, "Delta (2)", "Sahar El Gallad") },
    { name: "Amr", team: team("Alex-BHR|DM-AB", 0, "Alex-BHR", "District manager seat vacant") },
    { name: "Basma", team: team("Delta (2)|DM-D2", 2, "Delta (2)", "Sahar El Gallad") },
    { name: "Hoda", team: team("Delta (1)|", 1, "Delta (1)", "No district manager") },
  ];
  const cards = groupRepsByTeam(reps);
  assert.deepEqual(
    cards.map((group) => [group.label, group.reps.map((rep) => rep.name)]),
    [
      ["Alex-BHR · District manager seat vacant", ["Amr"]],
      ["Delta (1) · No district manager", ["Hoda"]],
      ["Delta (2) · Sahar El Gallad", ["Zeinab", "Basma"]],
    ],
    "each heading names the region and the district manager, and the groups run in region order",
  );
  assert.equal(
    cards.reduce((sum, group) => sum + group.reps.length, 0),
    reps.length,
    "grouping never hides a rep: the group sizes add up to the tile above",
  );
  assert.equal(teamHeading(team("x", 0, "Delta (1)", null)), "Delta (1)", "a failed organogram read heads the group by its region alone");
  assert.deepEqual(groupRepsByTeam([]), [], "no reps, no groups");
}

function theArithmetic() {
  const { slices, total } = shareSlices([
    { key: "verified", label: "Verified", value: 8 },
    { key: "awaiting", label: "Awaiting you", value: 0 },
    { key: "missing", label: "No plan filed", value: 5 },
  ]);
  assert.equal(total, 13);
  assert.deepEqual(slices.map((slice) => slice.percent), [62, 0, 38], "the legend's whole percents");
  assert.ok(Math.abs(slices.reduce((sum, slice) => sum + slice.width, 0) - 100) < 1e-9, "the segments fill the bar exactly");
  assert.equal(slices[1]!.width, 0, "a zero segment keeps its legend entry and takes no width");
  assert.deepEqual(
    shareSlices([{ key: "a", label: "A", value: 0 }]).slices.map((slice) => slice.width),
    [0],
    "a total of zero draws an empty bar, never NaN",
  );
  assert.equal(shareSlices([{ key: "a", label: "A", value: -3 }]).total, 0, "a negative count is read as zero");

  assert.equal(meterPercent(185, 185), 100, "the largest list reads full");
  assert.equal(meterPercent(109, 185), 59);
  assert.equal(meterPercent(5, 0), 0, "a view of zeros reads empty");
  assert.equal(meterPercent(400, 185), 100, "never past full");

  assert.equal(repInitials("Nora Kamal Mohamed Ahmed Srour"), "NK");
  assert.equal(repInitials("Ibrahim hawas"), "IH");
  assert.equal(repInitials("Momen"), "M");
  assert.equal(repInitials("  "), "–", "an empty name is a dash, never an empty square");
  assert.equal(repInitials("(Dakahlia) 2"), "D2", "punctuation is not an initial");

  // A brick's month: every visit counts as visited, untouched and missed are the Not visited tile's own set, a doctor
  // planned for later is neither, and a row the month could not score is left out of the bar altogether.
  const row = (status: string | null) => ({ activity: status ? ({ status } as never) : null });
  assert.deepEqual(
    brickCoverage([row("on_plan"), row("over"), row("under"), row("off_plan"), row("untouched"), row("missed"), row("not_due"), row(null)]),
    { notDue: 1, scored: 7, unvisited: 2, visited: 4 },
  );
  assert.deepEqual(brickCoverage([]), { notDue: 0, scored: 0, unvisited: 0, visited: 0 }, "an empty brick draws no bar");
}

function theFinish() {
  const chrome = readFileSync(CHROME, "utf8");
  for (const [file, whole] of [[CHROME, chrome], ...[...BOARDS, ...CONTROLS].map((file) => [file, readFileSync(file, "utf8")] as const)]) {
    // The CODE only: the comments name what is forbidden ("never a drop shadow"), and naming it is not drawing it.
    const source = codeOnly(whole);
    // Square edges and flat ink — the owner's golden rules and "nothing you design may look AI-made".
    assert.doesNotMatch(source, /\brounded(-[a-z0-9]+)?\b/, `${file}: no round corners, anywhere`);
    assert.doesNotMatch(source, /\bshadow(-[a-z0-9]+)?\b/, `${file}: no drop shadows`);
    assert.doesNotMatch(source, /\bbg-gradient-|\bfrom-[a-z]+-\d|\bvia-[a-z]+-\d/, `${file}: no gradients`);
    assert.doesNotMatch(source, /\bblur\b|backdrop-blur|\bglow\b/, `${file}: no glass or glow`);
    // Nothing scrolls sideways and nothing is cut short.
    assert.ok(!source.includes("overflow-x-auto"), `${file}: no horizontal scroll container`);
    assert.ok(!source.includes("min-w-["), `${file}: no min-width floor`);
    assert.ok(!source.includes("truncate") && !source.includes("text-ellipsis") && !source.includes("…"), `${file}: no ellipsis`);
  }

  // Figures are tabular, so a row of tiles lines up digit for digit.
  assert.ok(/text-2xl font-black leading-none tabular-nums/.test(chrome), "a tile's figure uses tabular numerals");
  // A row of tiles is sized by its count, so a fifth tile never sits alone under four.
  assert.ok(chrome.includes('5: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5"'), "five tiles fill one row on a desktop");
  assert.ok(chrome.includes('7: "grid-cols-2 sm:grid-cols-4 xl:grid-cols-7"'), "seven tiles fill one row on a wide screen");
  // One accent rule per part: the tile's tone rides on its top rule, a card's status on its left rule.
  assert.ok(chrome.includes("border border-t-[3px] ${TONE_TOP_RULE[key]}"), "the tile carries its tone on a 3px top rule");
  assert.ok(chrome.includes("border border-l-[3px] border-slate-200 ${TONE_LEFT_RULE[tone]}"), "the card carries its status on a 3px left rule");
  // Every tab draws its cards through the one frame and groups them through the one rule.
  for (const board of BOARDS) {
    const source = readFileSync(board, "utf8");
    assert.ok(source.includes("<RepCardFrame"), `${board} draws its cards in the shared frame`);
    assert.ok(/const groups = groupRepsByTeam\((reps|areas)\);/.test(source), `${board} groups its cards by region and district manager`);
    assert.ok(source.includes("<EmptyNote"), `${board} says an empty state in the shared note, never a bare paragraph`);
    assert.ok(!source.includes('className="px-5 py-6"'), `${board} has no hand-rolled empty state left`);
    // Desktop tables, phone cards (owner's standing rule): the same groups drawn twice, never two different lists.
    const code = codeOnly(source);
    assert.equal((code.match(/groups=\{groups\}/g) ?? []).length, 3, `${board}: the cards, the table and the teams roll-up read the one grouping`);
    assert.ok(code.includes("phoneOnly") && code.includes("<TeamTable"), `${board}: cards on a phone, the table from md up`);
    // An opened card starts with the band that names whose screen it is, and his team.
    assert.ok(code.includes("<RepProfileBand") && code.includes("team={teamHeading(selected.team)}"), `${board}: an opened card names its team`);
    // Every tab downloads what it shows, region and district manager first.
    assert.ok(code.includes("<ExportXlsxButton") && code.includes('{ key: "manager", label: "District manager" }'), `${board}: the team downloads`);
    // A count of contacts or plans is never summed down the rows: two reps can share a doctor.
    for (const column of code.match(/\{[^{}]*numeric: true[^{}]*\}/g) ?? []) {
      assert.ok(column.includes("excludeFromTotal: true"), `${board}: ${column} is never added into a TOTAL row`);
    }
  }
  assert.ok(chrome.includes('`space-y-6 p-5 ${phoneOnly ? "md:hidden" : ""}`'), "the cards step aside from md up when a table draws them");
  assert.ok(chrome.includes('<div className="hidden p-5 md:block">'), "and the table is the desktop's alone");
  assert.ok(chrome.includes('<table className="w-full table-fixed border border-slate-200 text-left">'), "the table fits by its colgroup");
  assert.ok(chrome.includes("<col className={column.width}"), "every column is a share of the whole");
  const lib = readFileSync("src/lib/crm/reps-list-board.ts", "utf8");
  assert.ok(lib.includes("groupByRegionAndManager(seatIds, seatOf"), "the cascade's teams come from the shared Regional Sales Manager rule");
  assert.ok(lib.includes("loadPhoenixCrmOrg().catch(() => null)"), "a failed organogram read costs the grouping its manager names and nothing else");
  const vacant = readFileSync("src/components/crm/reps-list-vacant-areas.tsx", "utf8");
  assert.ok(
    vacant.includes('<BackToAllReps href={hrefWithVacancy(basePath, board, null)} label="Back to all vacant areas" />'),
    "an opened vacant area starts with the same back bar as a rep's screen",
  );
  const plans = readFileSync("src/components/crm/reps-weekly-plans-board.tsx", "utf8");
  const tables = readFileSync("src/components/crm/reps-list-tables.tsx", "utf8");
  assert.ok(plans.includes("href={`#plan-day-${day.date}`}"), "the day strip jumps to a day");
  assert.ok(tables.includes("id={day.date ? `plan-day-${day.date}` : undefined}"), "and every dated day carries the id it jumps to");
  // The PM and AM bar is a share of the CONTACTS — a pharmacy is not a contact and is never on it.
  const contact = readFileSync("src/components/crm/reps-list-board.tsx", "utf8");
  const bar = contact.slice(contact.indexOf('caption="Contacts by list"'), contact.indexOf("/>", contact.indexOf('caption="Contacts by list"')));
  assert.ok(bar.includes("list.counts.pm") && bar.includes("list.counts.am") && !bar.includes("pharmacy"), "the contacts bar is PM against AM only");
  // The bricks chart counts contacts only, for the same reason.
  const bricks = contact.slice(contact.indexOf("function BrickBars"), contact.indexOf("function hasListOf"));
  assert.ok(bricks.includes('row.listType !== "Pharmacy"'), "the bricks chart counts contacts, never pharmacies");
  assert.ok(contact.includes("<BrickBars list={list} />"), "an opened list shows where its contacts sit");

  // The contact table, shared with My List and Phoenix CRM: the month bar is the manager board's alone, the dialogs
  // are flat, and an emptied filter carries its own way out.
  const table = codeOnly(tables);
  assert.match(contact, /<RepsListContacts[^>]*\sbrickCoverage\s/, "the manager board turns the brick month bar on");
  assert.ok(table.includes("showBrickCoverage && activityAvailable"), "and only when the month could be read");
  assert.ok(!readFileSync("src/components/phoenix-crm/list-tab.tsx", "utf8").includes("brickCoverage"), "Phoenix CRM keeps its headings");
  assert.doesNotMatch(table, /\bshadow(-[a-z0-9]+)?\b/, "the contact dialogs carry no drop shadow");
  assert.ok(table.includes("onClick={clearFilters}"), "the table's filters clear in one press");
  assert.ok(table.includes("{day.actual ? <PlanDayKeptBar actual={day.actual} /> : null}"), "an ended plan day shows how it went as a bar");
}

/** One planned call, as `planWeekMix` reads it: the doctor, his grade on the plan, and whether he joined the list. */
function call(contactCrmId: number | null, contactName: string, grade: string | null, onList: boolean, listGrade: string | null = null) {
  return {
    ampm: null,
    contact: onList ? { brick: { heading: "Smouha", mapped: true }, contact: { grade: listGrade } } : null,
    entry: { contactCrmId, contactName, grade },
    key: `${contactCrmId ?? contactName}:${Math.random()}`,
    verdict: "unknown",
  };
}

function dayOf(rows: unknown[], actual: { missed: number; moved: number; planned: number; upcoming: boolean; visited: number } | null) {
  return { actual: actual ? { ...actual, campaignCalls: 0 } : null, date: "2026-11-08", label: "Sat 8 Nov", rows } as never;
}

function thePlanWeek() {
  const mix = planWeekMix([
    // Doctor 1 planned AM and PM: one doctor, two calls. Doctor 2 is off the list. Doctor 3 has no grade on the
    // plan and takes the list's. Doctor 4 is known only by name and has no grade anywhere.
    dayOf([call(1, "Dr Amr", "A", true), call(1, "Dr Amr", "A", true), call(2, "Dr Hoda", "b", false)], {
      missed: 1,
      moved: 0,
      planned: 3,
      upcoming: false,
      visited: 2,
    }),
    dayOf([call(3, "Dr Sara", null, true, "C"), call(null, " Dr Nour ", null, false), call(null, "dr nour", null, false)], {
      missed: 0,
      moved: 1,
      planned: 3,
      upcoming: false,
      visited: 0,
    }),
    // A day still ahead: its doctors count, its zeros never reach the kept bar.
    dayOf([call(1, "Dr Amr", "A", true)], { missed: 0, moved: 0, planned: 1, upcoming: true, visited: 0 }),
    // A day whose visits could not be read: no kept figures at all.
    dayOf([call(5, "Dr Mona", "A", false)], null),
  ]);
  assert.deepEqual(
    mix.grades,
    [
      { count: 2, grade: "A" },
      { count: 1, grade: "B" },
      { count: 1, grade: "C" },
      { count: 1, grade: "No grade" },
    ],
    "the grades count doctors once each, A first and No grade last, the list's grade filling a blank one",
  );
  assert.equal(mix.onList + mix.offList, 5, "five distinct doctors — a doctor planned twice is one, and a name is one doctor");
  assert.deepEqual([mix.onList, mix.offList], [2, 3], "on the list when any of his rows joined to it");
  assert.deepEqual(mix.kept, { missed: 1, moved: 1, visited: 2 }, "kept is the ended days' calls, the day headings added up");
  assert.deepEqual(planWeekMix([]), { grades: [], kept: { missed: 0, moved: 0, visited: 0 }, offList: 0, onList: 0 });

  const chrome = readFileSync(CHROME, "utf8");
  assert.ok(chrome.includes("if (groups.length < 2) return null;"), "one team's roll-up is never drawn — it would repeat the bar above it");
  for (const board of BOARDS) {
    assert.ok(codeOnly(readFileSync(board, "utf8")).includes('<TeamRollup\n            caption="The teams at a glance"\n            groups={groups}'), `${board}: every team on one screen, from the one grouping`);
  }
  const plans = codeOnly(readFileSync("src/components/crm/reps-weekly-plans-board.tsx", "utf8"));
  assert.ok(plans.includes("<PlanWeekCharts days={board.days} />"), "an opened plan says what it is made of before its doctors");
}

function theListMix() {
  const rows = [
    { grade: "a", listType: "PM", speciality: "Pediatrics" },
    { grade: "A", listType: "AM", speciality: "Pediatrics" },
    { grade: "B", listType: "PM", speciality: " Neurology " },
    { grade: null, listType: "PM", speciality: null },
    { grade: "X", listType: "AM", speciality: "Chest" },
    // A pharmacy is not a contact: it reaches neither chart.
    { grade: "A", listType: "Pharmacy", speciality: "Pharmacist" },
  ];
  const mix = listMix(rows, 2);
  assert.deepEqual(
    mix.grades,
    [
      { count: 2, grade: "A" },
      { count: 1, grade: "B" },
      { count: 1, grade: "X" },
      { count: 1, grade: "No grade" },
    ],
    "grades in the order a manager reads them, an unknown grade after D, No grade last",
  );
  assert.deepEqual(
    mix.specialties,
    [
      { count: 2, label: "Pediatrics" },
      { count: 1, label: "Chest" },
      { count: 2, label: "Other specialties", other: true },
    ],
    "the largest specialties, and the rest folded into one line — never dropped",
  );
  const contacts = rows.filter((row) => row.listType !== "Pharmacy").length;
  assert.equal(mix.grades.reduce((sum, entry) => sum + entry.count, 0), contacts, "the grade bar adds up to the Contacts tile");
  assert.equal(mix.specialties.reduce((sum, entry) => sum + entry.count, 0), contacts, "and so do the specialty bars");
  assert.deepEqual(listMix([]), { grades: [], specialties: [] });

  const vacant = codeOnly(readFileSync("src/components/crm/reps-list-vacant-areas.tsx", "utf8"));
  const widths = [...vacant.slice(vacant.indexOf("function vacancyColumns"), vacant.indexOf("function TeamVacancyLine")).matchAll(/width: "w-\[(\d+)%\]"/g)].map(
    (match) => Number(match[1]),
  );
  assert.equal(widths.reduce((sum, width) => sum + width, 0), 100, "the vacant areas table's columns share exactly the whole width");
  for (const board of ["src/components/crm/reps-list-board.tsx", "src/components/crm/reps-weekly-plans-board.tsx"]) {
    const source = codeOnly(readFileSync(board, "utf8"));
    const name = board.includes("weekly") ? "planColumns" : "contactColumns";
    const block = source.slice(source.indexOf(`function ${name}`));
    const columns = [...block.slice(0, block.indexOf("\n}\n")).matchAll(/width: "w-\[(\d+)%\]"/g)].map((match) => Number(match[1]));
    assert.equal(columns.reduce((sum, width) => sum + width, 0), 100, `${board}: the team table's columns share exactly the whole width`);
  }
}

export function runRepsListPremiumTests() {
  groupsFollowTheSharedRule();
  theArithmetic();
  thePlanWeek();
  theListMix();
  theFinish();
}
