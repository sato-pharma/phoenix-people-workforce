import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { DEFAULT_DOCTOR_COVERAGE_NORMS } from "../src/lib/crm/doctor-coverage-config.ts";
import {
  buildRepDoctorListsBoard,
  type PlanRow,
  type RepDoctorListsInput,
  type VisitRow,
} from "../src/lib/crm/rep-doctor-lists.ts";
import {
  ACTIVITY_CLASS,
  ACTIVITY_FILTER_ORDER,
  ACTIVITY_LABEL,
  ACTIVITY_MEANING,
  UNTOUCHED_ACTIVITY,
  UNVISITED_STATUSES,
  activityCountLabel,
  activityForContact,
  buildRepsListActivityIndex,
  countUnvisited,
  type RepsListActivity,
  type RepsListActivityStatus,
} from "../src/lib/crm/reps-list-activity.ts";
import { repKeyOfHrIdRead } from "../src/lib/crm/reps-list-activity-data.ts";

/**
 * Reps List — the activity column. What actually happened to each contact on a rep's own list.
 *
 * WHY THIS IS PINNED AT ALL. Every value this module produces is printed beside a named doctor and
 * read as a judgement about a named rep. "No activity" next to 84 doctors is not a missing number,
 * it is an accusation — and every way of getting it wrong here is silent:
 *
 * · joining the plan by `agent_hr_id` instead of `agent_crm_id` drops a large and VARYING share of
 *   the plan — 791 of 18,645 August 2026 rows, but 5,795 of 20,778 May rows (27.9%) — and every
 *   doctor thus dropped comes out `untouched`, a fabricated accusation across a quarter of a month;
 * · a failed read that answers "nothing happened" instead of "unavailable" accuses the whole list at
 *   once, and looks exactly like a rep who did no work;
 * · indexing several reps' rows together lets a doctor shared by two reps silently carry the other
 *   rep's visits — the last write wins and nothing errors;
 * · scoring mid-month against the WHOLE month's plan instead of the plan to date marks a rep behind
 *   on calls he is not yet due to make, which is a deviation that does not exist;
 * · and folding `not_due` into the unvisited count puts a manager on the phone about a doctor
 *   scheduled for next Tuesday.
 *
 * None of those throws. Every one of them renders as a working board.
 *
 * The fixture is one rep's August scored as if today were the 15th, with one contact per rule.
 */

const MONTH = "2026-08";
const AS_OF = "2026-08-15";
const AGENT = 101;

function plan(overrides: Partial<PlanRow> = {}): PlanRow {
  return {
    agent_crm_id: AGENT,
    agent_hr_id: "PHX-101",
    contact_crm_id: 1001,
    contact_grade: "A",
    contact_name: "Planned Contact",
    crm_region_name: "Cairo",
    plan_date: "2026-08-05",
    plan_status: 1,
    speciality: "Internal Medicine",
    synced_at: "2026-08-15T09:00:00.000Z",
    ...overrides,
  };
}

function visit(overrides: Partial<VisitRow> = {}): VisitRow {
  return {
    agent_crm_id: AGENT,
    agent_hr_id: "PHX-101",
    agent_name: "Rep One",
    contact_crm_id: 1001,
    crm_contact_grade: "A",
    speciality: "Internal Medicine",
    visit_date: "2026-08-05",
    visit_type: 0,
    ...overrides,
  };
}

/** The board exactly as `loadRepsListActivity` builds it — same builder, same defaults, same filter. */
function board(input: { planRows: PlanRow[]; repKey?: string; visitRows: VisitRow[] }) {
  const args: RepDoctorListsInput = {
    asOf: AS_OF,
    employeeNameByHrId: new Map<string, string>(),
    excludedAgentCrmIds: [],
    filters: input.repKey ? { repKey: input.repKey } : {},
    month: MONTH,
    norms: DEFAULT_DOCTOR_COVERAGE_NORMS,
    planRows: input.planRows,
    visitRows: input.visitRows,
  };
  return buildRepDoctorListsBoard(args);
}

const PLAN_ROWS: PlanRow[] = [
  // 1001 — on plan. TWO calls asked for, one of them on the 20th which has not happened yet, and one
  // visit made. This is the row that fails if the denominator is ever the whole month.
  plan({ contact_crm_id: 1001, contact_name: "On Plan", plan_date: "2026-08-05" }),
  plan({ contact_crm_id: 1001, contact_name: "On Plan", plan_date: "2026-08-20" }),
  // 1002 — missed. Asked for, due, never visited.
  plan({ contact_crm_id: 1002, contact_name: "Missed", plan_date: "2026-08-05" }),
  // 1003 — under. Two calls due, one made.
  plan({ contact_crm_id: 1003, contact_name: "Behind", plan_date: "2026-08-05" }),
  plan({ contact_crm_id: 1003, contact_name: "Behind", plan_date: "2026-08-07" }),
  // 1004 — over. One call asked for, two made. Judged against the WHOLE month: those calls cannot be
  // un-made, so it is a real deviation on the 15th.
  plan({ contact_crm_id: 1004, contact_name: "Over", plan_date: "2026-08-05" }),
  // 1006 — not due. Planned only for a day that has not arrived.
  plan({ contact_crm_id: 1006, contact_name: "Not Due", plan_date: "2026-08-25" }),
];

const VISIT_ROWS: VisitRow[] = [
  visit({ contact_crm_id: 1001, visit_date: "2026-08-05" }),
  visit({ contact_crm_id: 1003, visit_date: "2026-08-05" }),
  visit({ contact_crm_id: 1004, visit_date: "2026-08-05" }),
  visit({ contact_crm_id: 1004, visit_date: "2026-08-07" }),
  // 1005 — off plan. Visited, never asked for.
  visit({ contact_crm_id: 1005, visit_date: "2026-08-06" }),
];

export function runRepsListActivityTests() {
  // ───────────────────────────────────────────────────────────────────────────
  // The six inherited statuses, produced by the REAL builder rather than by fixtures of this
  // module's own making. If `rep-doctor-lists.ts` ever changes what "behind plan" means, this board
  // changes with it — which is the entire reason the status is re-exported and not restated.
  // ───────────────────────────────────────────────────────────────────────────
  {
    const index = buildRepsListActivityIndex(
      board({ planRows: PLAN_ROWS, repKey: String(AGENT), visitRows: VISIT_ROWS }).doctors,
    );

    assert.equal(index.get(1001)?.status, "on_plan", "one visit against one call DUE is on plan");
    assert.equal(index.get(1002)?.status, "missed", "due and never visited is missed");
    assert.equal(index.get(1003)?.status, "under", "one visit against two calls due is behind plan");
    assert.equal(index.get(1004)?.status, "over", "two visits against one call asked for is over plan");
    assert.equal(index.get(1005)?.status, "off_plan", "visited but never planned is off plan");
    assert.equal(index.get(1006)?.status, "not_due", "planned only for a future day is not due yet");

    // THE TO-DATE RULE, as a number rather than left implicit in the status above. 1001 is asked for
    // twice and has been visited once; scoring it against the month's 2 would print
    // "Behind plan · 1 of 2" beside a rep who is exactly on schedule.
    const onPlan = index.get(1001);
    assert.equal(onPlan?.plannedCalls, 2, "the month asks for two calls");
    assert.equal(onPlan?.plannedCallsToDate, 1, "only one of them is due on the 15th");
    assert.equal(onPlan?.visits, 1);
    assert.equal(onPlan?.delta, 0, "delta is measured against the calls DUE, so this rep is level");
    assert.equal(onPlan?.lastVisitDate, "2026-08-05");
  }

  // ───────────────────────────────────────────────────────────────────────────
  // `untouched` is ABSENCE, and absence is not the same as a failed read. This is the distinction
  // the whole column stands on: one is a finding about a doctor nobody planned, the other is a
  // statement the board has no right to make.
  // ───────────────────────────────────────────────────────────────────────────
  {
    const index = buildRepsListActivityIndex(
      board({ planRows: PLAN_ROWS, repKey: String(AGENT), visitRows: VISIT_ROWS }).doctors,
    );

    // A contact on the CRM list that neither the plan nor the visits ever mention. There is no
    // doctor row for it anywhere in Phoenix — that is precisely the population the owner asked to
    // surface, so it must resolve to a status rather than to nothing.
    const untouched = activityForContact(index, 9999);
    assert.equal(untouched?.status, "untouched", "a contact in neither half of the join is untouched");
    assert.equal(untouched?.visits, 0);
    assert.equal(untouched?.plannedCalls, 0);

    // AND THE CASE THAT MATTERS MORE. A read that failed answers null and the board hides the
    // column. Answering `untouched` here would put "No activity" beside every doctor on the list on
    // the strength of a query that never ran.
    assert.equal(activityForContact(null, 1001), null, "an unavailable read is null, never untouched");
    assert.equal(activityForContact(undefined, 1001), null, "so is a caller that never asked");
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Indexing MUST be narrowed to one rep, and forgetting it must throw rather than mis-attribute. A
  // doctor shared between two reps is common here — the owner calls a two-line customer a "treasure"
  // — and silently showing one rep the other's visits is the worst answer available.
  // ───────────────────────────────────────────────────────────────────────────
  {
    const shared: PlanRow[] = [
      plan({ contact_crm_id: 2001, contact_name: "Shared Doctor", plan_date: "2026-08-05" }),
      plan({
        agent_crm_id: 202,
        agent_hr_id: "PHX-202",
        contact_crm_id: 2001,
        contact_name: "Shared Doctor",
        plan_date: "2026-08-05",
      }),
    ];
    const sharedVisits: VisitRow[] = [
      visit({ agent_crm_id: 202, agent_hr_id: "PHX-202", contact_crm_id: 2001, visit_date: "2026-08-05" }),
    ];

    // Unfiltered: two doctor rows, one per rep, the same contact id on both.
    const wide = board({ planRows: shared, visitRows: sharedVisits });
    assert.equal(wide.doctors.length, 2, "the builder keys doctor rows by (rep, contact), not by contact");
    assert.throws(
      () => buildRepsListActivityIndex(wide.doctors),
      /appears twice/,
      "indexing several reps at once must throw — the last row would otherwise win silently, and rep 101 would be shown carrying rep 202's visit",
    );

    // Filtered, which is what `loadRepsListActivity` does: rep 101 planned this doctor and did not
    // visit him. The other rep's visit must not rescue him.
    const narrow = board({ planRows: shared, repKey: String(AGENT), visitRows: sharedVisits });
    const index = buildRepsListActivityIndex(narrow.doctors);
    assert.equal(index.size, 1);
    assert.equal(index.get(2001)?.status, "missed", "the OTHER rep's visit does not count for this one");
    assert.equal(index.get(2001)?.visits, 0);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // The untouched default is shared by every unmatched row on the board — 30% of production rows in
  // August 2026 — so a caller that mutated it would corrupt all of them at once.
  // ───────────────────────────────────────────────────────────────────────────
  {
    assert.ok(Object.isFrozen(UNTOUCHED_ACTIVITY), "the shared default must be frozen");
    assert.throws(
      () => {
        UNTOUCHED_ACTIVITY.visits = 7;
      },
      TypeError,
      "mutating the shared default must throw rather than quietly rewrite every untouched row on the board",
    );
    assert.equal(UNTOUCHED_ACTIVITY.visits, 0);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // The tile's population: `untouched` PLUS `missed`, and nothing else.
  // ───────────────────────────────────────────────────────────────────────────
  {
    const of = (status: RepsListActivityStatus): RepsListActivity => ({
      delta: 0,
      lastVisitDate: null,
      plannedCalls: 1,
      plannedCallsToDate: 1,
      status,
      visits: 0,
    });

    assert.deepEqual(
      [...UNVISITED_STATUSES].sort(),
      ["missed", "untouched"],
      "only these two mean nobody has been here",
    );
    assert.equal(
      countUnvisited([
        of("untouched"),
        of("missed"),
        of("not_due"),
        of("on_plan"),
        of("under"),
        of("over"),
        of("off_plan"),
      ]),
      2,
      "not_due is NOT unvisited: a doctor planned for next Tuesday has not been neglected",
    );
    // A row whose activity could not be read is not counted as unvisited either — the same refusal
    // to turn a failed read into a finding, applied to the number rather than to the chip.
    assert.equal(countUnvisited([null, null, of("missed")]), 1, "a row with no activity is not an accusation");
    assert.equal(countUnvisited([]), 0);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // "2 of 3" — and the 3 is the calls DUE, never the month's whole ask.
  // ───────────────────────────────────────────────────────────────────────────
  {
    assert.equal(
      activityCountLabel({
        delta: 0,
        lastVisitDate: "2026-08-05",
        plannedCalls: 3,
        plannedCallsToDate: 1,
        status: "on_plan",
        visits: 1,
      }),
      "1 of 1",
      "the denominator is the plan TO DATE — printing 1 of 3 mid-month would call an on-schedule rep behind",
    );
    assert.equal(
      activityCountLabel({
        delta: 2,
        lastVisitDate: "2026-08-06",
        plannedCalls: 0,
        plannedCallsToDate: 0,
        status: "off_plan",
        visits: 2,
      }),
      "2 visits",
      "an off-plan doctor has no denominator to show, so the visits stand alone",
    );
    assert.equal(
      activityCountLabel({
        delta: 1,
        lastVisitDate: "2026-08-06",
        plannedCalls: 0,
        plannedCallsToDate: 0,
        status: "off_plan",
        visits: 1,
      }),
      "1 visit",
      "singular, never 1 visits",
    );
    assert.equal(
      activityCountLabel(UNTOUCHED_ACTIVITY),
      null,
      "0 of 0 beside No activity is noise — the word already says it",
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Every status is presentable, and every status is SELECTABLE.
  //
  // A RUNTIME assertion, not a type-level one, on purpose: the build runs with `ignoreBuildErrors`,
  // so a Record missing a key compiles, builds and DEPLOYS. The failure is a chip with no word in it.
  // ───────────────────────────────────────────────────────────────────────────
  {
    const statuses: RepsListActivityStatus[] = [
      "missed",
      "not_due",
      "off_plan",
      "on_plan",
      "over",
      "under",
      "untouched",
    ];

    for (const status of statuses) {
      assert.ok(ACTIVITY_LABEL[status], `${status} needs a label on the chip`);
      assert.ok(ACTIVITY_MEANING[status], `${status} needs a full sentence for the export and the tooltip`);
      assert.ok(ACTIVITY_CLASS[status], `${status} needs a colour`);
      assert.ok(
        !/^[a-z_]+$/.test(ACTIVITY_LABEL[status]),
        `${status} must read as words, never as the raw code — the owner's naming rule`,
      );
    }

    // THE OWNER'S OWN THREE WORDS, given verbatim on 2026-09-02: "change vocab to below exact
    // above". Pinned because the pull back towards "On plan / Over plan / Behind plan" is strong and
    // reads as a harmless improvement — it is not. Those phrases imply one direction is a pass and
    // the other a failure, which is exactly the reading his frequency rule refuses: three calls
    // asked for and three made is the only pass, and either side of it is a deviation.
    assert.equal(ACTIVITY_LABEL.under, "Below");
    assert.equal(ACTIVITY_LABEL.on_plan, "Exact");
    assert.equal(ACTIVITY_LABEL.over, "Above");

    // A status the filter cannot offer is a population a manager can never call up, which is the one
    // thing this column was added to make possible.
    assert.deepEqual(
      [...ACTIVITY_FILTER_ORDER].sort(),
      [...statuses].sort(),
      "the filter must offer every status exactly once",
    );
    assert.equal(ACTIVITY_FILTER_ORDER[0], "untouched", "the two that need action lead the list");
    assert.equal(ACTIVITY_FILTER_ORDER[1], "missed");

    // ON PLAN IS THE ONLY GREEN. Owner's ruling: visiting more than the plan asked for is a
    // deviation, not a win — it is the error the retired Doctor Coverage board made.
    const green = statuses.filter((status) => ACTIVITY_CLASS[status].includes("emerald"));
    assert.deepEqual(green, ["on_plan"], "over-visiting must never be coloured as success");
    assert.ok(
      !ACTIVITY_CLASS.over.includes("emerald") && !ACTIVITY_CLASS.over.includes("amber"),
      "over is its own signal — neither a pass nor falling behind",
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // A rep with no CRM account is read by his hr id, and the builder is told whose rows those are.
  // Filtered on a key his rows do not carry, every doctor on his list reads untouched — the exact
  // accusation this column exists to avoid — so the key comes from the rows the hr id found.
  // ───────────────────────────────────────────────────────────────────────────
  {
    const hrOnlyPlan = PLAN_ROWS.map((row) => ({ ...row, agent_crm_id: null, agent_hr_id: "B-40" }));
    const hrOnlyVisits = VISIT_ROWS.map((row) => ({ ...row, agent_crm_id: null, agent_hr_id: "b-40 " }));
    const hrKey = repKeyOfHrIdRead("B-40", [...hrOnlyPlan, ...hrOnlyVisits]);
    assert.equal(hrKey, "hr:b-40", "a rep with no CRM account is keyed on his canonical hr id, whatever casing each row carries");

    const index = buildRepsListActivityIndex(board({ planRows: hrOnlyPlan, repKey: hrKey ?? undefined, visitRows: hrOnlyVisits }).doctors);
    assert.equal(index.get(1001)?.status, "on_plan", "his planned-and-visited doctor reads on plan, not untouched");
    assert.equal(index.get(1002)?.status, "missed", "his planned-and-unvisited doctor reads missed");
    assert.equal(index.get(1005)?.status, "off_plan", "his unplanned visit still counts");

    // The employee record carries a CRM id, so the unified views stamp his rows with it even though
    // the Reps List shows him with no account. The key must follow the ROWS, not the hr id.
    const stampedPlan = hrOnlyPlan.map((row) => ({ ...row, agent_crm_id: 777 }));
    const stampedVisits = hrOnlyVisits.map((row) => ({ ...row, agent_crm_id: 777 }));
    const stampedKey = repKeyOfHrIdRead("B-40", [...stampedPlan, ...stampedVisits]);
    assert.equal(stampedKey, "777", "rows his hr id found are his, so their key is his key — filtering on hr:b-40 would drop all of them");
    const stamped = buildRepsListActivityIndex(board({ planRows: stampedPlan, repKey: stampedKey ?? undefined, visitRows: stampedVisits }).doctors);
    assert.equal(stamped.get(1001)?.status, "on_plan", "and his list reads true, not every doctor untouched");

    assert.equal(
      repKeyOfHrIdRead("B-40", [...hrOnlyPlan, ...stampedVisits]),
      null,
      "rows carrying two keys split his month across two builder rows, and no single count would be true — unavailable, never a partial accusation",
    );
    assert.equal(repKeyOfHrIdRead("B-40", []), "hr:b-40", "an empty month is still his month");
    assert.equal(repKeyOfHrIdRead(null, []), null, "a read naming nobody has no key");
  }

  // ───────────────────────────────────────────────────────────────────────────
  // The IO half joins on the CRM id, on BOTH sides, whenever the rep has one. Source-pinned because
  // the failure is invisible: an hr-id join returns a shortened plan against a full visit set, so the
  // board renders perfectly and accuses a quarter of a month's doctors of being ignored.
  // ───────────────────────────────────────────────────────────────────────────
  {
    const data = readFileSync("src/lib/crm/reps-list-activity-data.ts", "utf8");

    assert.ok(
      /input\.agentCrmId != null \? \{ agentCrmIds: \[input\.agentCrmId\] \} : hrId \? \{ agentHrIds: \[hrId\] \} : null/.test(data),
      "the CRM id is the filter whenever the rep has one, and the hr id is read ONLY for a rep with none: the plan mirror leaves the hr id null on up to 27.9% of a month's rows, and every row it drops reads as an untouched doctor",
    );
    assert.ok(
      /scanPlanEntries\(from, to, narrowedTo\)/.test(data) && /\.\.\.narrowedTo,/.test(data),
      "BOTH halves — the plan scan and the visits query — must be narrowed by the SAME filter",
    );
    assert.ok(
      /filters: \{ repKey \}/.test(data) &&
        /input\.agentCrmId != null \? String\(input\.agentCrmId\) : repKeyOfHrIdRead\(hrId, \[\.\.\.planRows, \.\.\.visitRows\]\)/.test(data),
      "the builder must also be told whose list this is — it is what keeps a widened query from attributing another rep's visits, and what stops the drill-down cap truncating a long list into fabricated untouched rows",
    );
    assert.ok(
      /collapseDoubleVisits: true/.test(data),
      "the CRM client saves one real stop as several rows, so without this 2 of 3 counts saves rather than visits",
    );
    assert.ok(
      /getEffectiveExcludedAgentCrmIds\(\)[\s\S]{0,400}return null/.test(data),
      "a departed agent must answer unavailable, not visited-nobody — the visits door drops him unconditionally while the plan side does not, so reading on would mark his entire list missed",
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // The board wiring: the chip on both halves, the column never a seventh one, and the whole
  // annotation absent together when the read failed.
  // ───────────────────────────────────────────────────────────────────────────
  {
    const tables = readFileSync("src/components/crm/reps-list-tables.tsx", "utf8");

    assert.equal(
      (tables.match(/<ActivityChip activity=\{row\.activity\} \/>/g) ?? []).length,
      2,
      "the chip must render on BOTH the desktop cell and the mobile card — the owner's golden rule is that this board works on a phone, and a rep standing in a clinic reads the phone",
    );
    assert.ok(
      /function ActivityChip\([\s\S]{0,400}if \(!activity\) return null;/.test(tables),
      "an absent activity must render NOTHING — printing No activity from a failed read is the accusation this whole column exists to avoid",
    );
    assert.ok(
      /function matchesActivity\([\s\S]{0,400}if \(!status\) return false;/.test(tables),
      "a row with no activity must never match a status filter, or a failed read would present the entire list as Missed",
    );
    assert.ok(
      /\[activity, brick, grade, groups, listType, query, showValidation, speciality, tab, validation\]/.test(tables),
      "the activity choice must be in the memo's dependency list, or picking a filter would leave the rows unchanged",
    );

    // The export must match the screen, including matching it when the column is not there.
    assert.ok(
      /activityAvailable[\s\S]{0,200}key: "activity"/.test(tables),
      "the activity export columns must be conditional on the same flag as the chip",
    );
    assert.ok(
      /activity: row\.activity \? ACTIVITY_LABEL\[row\.activity\.status\] : ""/.test(tables),
      "an unscored row exports an EMPTY cell, never a word — a spreadsheet read away from the board cannot tell a judgement from a default",
    );
    assert.ok(
      /key: "planned_to_date"/.test(tables) &&
        /planned_to_date: row\.activity \? row\.activity\.plannedCallsToDate : ""/.test(tables),
      "the export carries the plan TO DATE, the same denominator the screen shows",
    );

    // THE GOLDEN RULE, MECHANICALLY. Two tables, six fixed columns each, and the activity merged
    // into one of them rather than added beside them. A seventh column could only be bought by
    // squeezing the other six, and the owner's rule is to fit by MERGING, never by shrinking type.
    assert.equal((tables.match(/<colgroup>/g) ?? []).length, 2, "both tables declare their columns");
    // Counted per table, because GroupTable's last two columns SWAP SEATS between surfaces (Phoenix
    // CRM puts Address before Actions, owner 2026-09-25) and so are declared in both orders — eight
    // <col> literals for six rendered columns. PlanDayTable still declares its six once. A genuine
    // SEVENTH column would break the width arithmetic pinned in reps-list.test.ts, where both tabs
    // must total exactly 100%.
    const groupColgroup = tables.slice(tables.indexOf("<colgroup>"), tables.indexOf("</colgroup>"));
    const planColgroup = tables.slice(tables.lastIndexOf("<colgroup>"), tables.lastIndexOf("</colgroup>"));
    assert.equal(
      (groupColgroup.match(/<col\s/g) ?? []).length,
      8,
      "GroupTable declares its first four columns once and its last two in both orders — eight <col> for six rendered columns",
    );
    assert.equal(
      (planColgroup.match(/<col\s/g) ?? []).length,
      6,
      "PlanDayTable declares its six columns, unchanged by the activity column",
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // The month is a URL parameter and must survive every other control on the page.
  // ───────────────────────────────────────────────────────────────────────────
  {
    const view = readFileSync("src/components/crm/reps-list-board.tsx", "utf8");

    assert.ok(
      /query\.set\("month", board\.activityMonth\)/.test(view),
      "opening a rep, or going back to all reps, must keep the chosen month — otherwise comparing two reps over August silently re-scores the second over September",
    );
    assert.ok(
      /<RepsListFilters[^>]*preserve=\{preserve\}/.test(view),
      "choosing a line must keep the chosen month too",
    );
    assert.ok(
      /board\.activityAvailable \? \([\s\S]{0,400}label="Not visited"/.test(view),
      "the tile appears only when the activity was actually read",
    );

    const filters = readFileSync("src/components/crm/reps-list-filters.tsx", "utf8");
    assert.ok(
      /export function RepsListMonthPicker/.test(filters),
      "the month picker lives beside the cascade selects so it inherits their classes",
    );
    assert.equal(
      (filters.match(/mt-1 \$\{SELECT_CLASS\}/g) ?? []).length,
      2,
      "the picker must reuse SELECT_CLASS, not a size of its own — globals.css floors every form control at 16px below 768px, and a smaller class is either inert or reintroduces the iOS Safari zoom defect that floor was written to kill",
    );
  }
}
