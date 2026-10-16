import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

// "THE EMPLOYEE PORTAL, SPECIALLY THE MEDICAL REP ROLE, IS SLOW TO TRANSFER BETWEEN PAGE AND PAGE"
// (owner, 2026-10-01 — "scan every single page, and the Phoenix CRM is the most priority").
//
// Every fix below took a read that WAITED for another read it did not need, and started the two
// together, or removed a read whose answer was thrown away. None of them changes a figure, a rule or
// what a screen shows — so nothing on a screen can catch one of them coming undone. A later edit
// that puts an `await` back in the wrong place is invisible in review and silent in every other
// test; the page just gets slow again. These pins are that missing signal.
//
// Each pin names the ORDER or the ABSENCE that made the page fast, never the exact text around it.
// The prefetch half of the same work — the sidebar no longer rendering fifteen pages in the
// background — has its own pin, tests/portal-link-prefetch.test.ts.

function source(path: string): string {
  return stripComments(readFileSync(path, "utf8").replace(/\r\n/g, "\n"));
}

/** A top-level function's text, from its declaration to the first column-0 closing brace. */
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

export function runPortalRepNavigationSpeedTests(): void {
  // ── Phoenix CRM · the List ─────────────────────────────────────────────────────────────────────
  {
    // The board route used to run the WHOLE List load a second time just to learn whose board it
    // was — the reference mint, the six-way read, names, bricks and four mirror reads, the
    // company-wide roster among them — on top of the /list request the tab had already made.
    const route = source("app/api/phoenix-crm/list/board/route.ts");
    assert.match(
      route,
      /const \{ seat \} = territoryForRead\(viewer, search\.get\("seatId"\), readTestFlag\(search\.get\("test"\)\)\);/,
      "the board route authorises through the seat gate alone",
    );
    assert.doesNotMatch(route, /loadTerritoryList/, "and never re-runs the List load to do it");

    // The board was fetched by the section that shows it, so switching sections away and back
    // fetched it again. It is asked for once, by the tab, the first time it is on screen.
    const tab = source("src/components/phoenix-crm/list-tab.tsx");
    assert.match(
      tab,
      /const board = useCrmGet<RepsListBoard \| null>\(boardWanted \? listBoardUrl\(seatId, test\) : null, "board"\);/,
      "the List tab owns the one board read",
    );
    assert.doesNotMatch(functionBody(tab, "function BoardSection("), /useCrmGet\(/, "and the board section never reads it again");

    // No partner can be named, so no customer can be shown as shared: the company-wide roster
    // (the 420 ms-mean crm_contact_assignments read) is never read to arrive at that empty answer.
    const shared = functionBody(source("src/lib/crm/shared-customers.ts"), "export async function loadSharedCustomersFor(");
    assertBefore(shared, "if (repNames.size === 0) return new Map();", "await loadContactRoster()", "no name, no match — so no roster");

    // The names, the brick names and the four mirror reads need only what the first wave answered.
    const list = functionBody(source("src/lib/phoenix-crm/server/list.ts"), "export async function loadTerritoryList(");
    assertBefore(
      list,
      "loadSharedCustomersFor(sharedKeys, occupantHrId)",
      "loadPeopleNames([",
      "the List's mirror reads start before the names are awaited, not after",
    );
    assert.match(list, /mirrorReads\??\.catch\(\(\) => undefined\);/, "and are handled the moment they start, so a failure is never unhandled");
    assert.match(list, /await mirrorReads;/, "and are still awaited inside the block that logs their failure");

    // 2026-10-16 performance audit: the List starts its whole wave BESIDE the reference mint, the
    // visit form's pattern. Only the two reads the mint can change wait for it.
    assert.match(list, /ensured\.then\(\(\) => loadReference\(/, "the List's reference waits for the mint — the mint fills in its customer ids");
    assert.match(list, /ensured\.then\(\(\) => loadTerritoryCustomers\(/, "and so does its customer list — the mint adds to it");
    assert.doesNotMatch(list, /await ensureReferenceCustomers\(/, "and nothing else waits for the mint");
    assertBefore(list, "const wave = Promise.all([", "await ensured;", "every other List read starts before the mint is awaited");
    assert.ok(list.includes("wave.catch(() => undefined);"), "the early wave is handled the moment it starts");
    assertBefore(list, "const mirrorReads = customersRead.then(", "const wave = Promise.all([", "the mirror reads start the moment the customer list lands");
    // The List counts its reference states itself; from readiness it takes only the stamped day, read
    // straight off its row — never the second whole seat-reference computation `loadReadiness` runs.
    assert.doesNotMatch(list, /loadReadiness\(/, "the List never runs the readiness computation for one stamped date");
    assert.ok(list.includes("loadStoredReadyAt(seat.seatId)"), "it reads the stamped day off the readiness row");
  }

  // ── Phoenix CRM · the visit form, the screen a rep opens most ──────────────────────────────────
  {
    const form = functionBody(source("src/lib/phoenix-crm/server/visits.ts"), "export async function loadVisitForm(");
    assert.match(
      form,
      /ensured\.then\(\(\) => loadTerritoryCustomers\(/,
      "only the customer list waits for the reference mint — the mint is what can add to it",
    );
    assertBefore(form, "const wave = Promise.all([", "await ensured;", "every other read of the form starts before the mint is awaited");
    assert.match(form, /loadLastVisits\(seat\.seatId, isTest, today, lineProductsRead\)/, "the last visits' read no longer waits for the product families");
    assert.match(form, /visitRowsRead\.then\(\(rows\) =>\s*loadPeopleNames\(/, "and the names ride on the day's visits alone");
    for (const handled of ["lineProductsRead.catch(() => undefined);", "wave.catch(() => undefined);"]) {
      assert.ok(form.includes(handled), `${handled} — a read started early is handled the moment it starts`);
    }
  }

  // ── Phoenix CRM · the rep's day (also on his landing page) ─────────────────────────────────────
  {
    const today = functionBody(source("src/lib/phoenix-crm/server/today.ts"), "export async function loadPhoenixCrmToday(");
    assert.match(
      today,
      /const plannedStopsRead = Promise\.all\(\[customersRead, plannedRead\]\)\.then\(/,
      "the day's references start the moment the list and the plan land, not after the whole wave",
    );
    assert.doesNotMatch(today, /const names = await loadPeopleNames\(/, "and the territory's names are read with the rest, never after it");
    // His own week (owner, 2026-10-02) is one more read of the same wave — never awaited after it.
    assertBefore(today, "loadWeekProgress(seat.seatId, isTest, date, { planRow: planRowRead }),", "const stops: PlannedStop[] = [];", "the week's read is inside the day's one wave");
    assert.doesNotMatch(today, /await loadWeekProgress\(/, "and never awaited on its own");
    // 🔴 The week's plan row is read ONCE (2026-10-16) and handed to the stops, the planned activities
    // and the week, rather than three reads of one row.
    assert.ok(today.includes("const planRowRead = loadWeekPlanRow(seat.seatId, isTest, date);"), "the plan row is read once");
    for (const reader of [
      "plannedCustomersOn(seat.seatId, isTest, date, { planRow: planRowRead })",
      "loadPlannedActivitiesOn(seat.seatId, isTest, date, { planRow: planRowRead })",
      "loadWeekProgress(seat.seatId, isTest, date, { planRow: planRowRead })",
    ]) {
      assert.ok(today.includes(reader), `${reader} — handed the one row`);
    }
    // And the stops' customers are read for the day's approved plan alone, never the whole territory.
    assert.match(
      today,
      /const customersRead = plannedRead\.then\(\(planned\) =>\s*loadTerritoryCustomers\(seat\.seatId, isTest, \{ onListOnly: true, customerIds: planned\.status === "approved" \? planned\.customerIds : \[\] \}\),\s*\);/,
      "Today reads only the customers its stops can be",
    );
    const territoryCustomers = functionBody(source("src/lib/phoenix-crm/server/list.ts"), "export async function loadTerritoryCustomers(");
    assert.ok(territoryCustomers.includes('if (only) query = query.in("id", only);'), "the narrowed read keeps every other filter on the customers");
    assert.ok(territoryCustomers.includes('return only ? query.in("customer_id", only) : query;'), "and reads those customers' places alone");
    for (const reader of ["export async function loadPlannedActivitiesOn(", "export async function loadWeekProgress("]) {
      const path = reader.includes("Week") ? "src/lib/phoenix-crm/server/week-progress.ts" : "src/lib/phoenix-crm/server/plan-activities.ts";
      assert.ok(functionBody(source(path), reader).includes("await options.planRow;"), `${reader} uses the row it is handed`);
    }
    const week = functionBody(source("src/lib/phoenix-crm/server/week-progress.ts"), "export async function loadWeekProgress(");
    assertBefore(week, "visitsRead.catch(() => undefined);", "await supabase", "and inside it, the visits' read starts beside the plan's, not after it");
  }

  // ── Phoenix CRM · the week and month planners ──────────────────────────────────────────────────
  {
    const planners: Array<[string, string]> = [
      ["src/lib/phoenix-crm/server/plans.ts", "export async function loadPlanner("],
      ["src/lib/phoenix-crm/server/monthly-plans.ts", "export async function loadMonthlyPlanner("],
    ];
    for (const [path, declaration] of planners) {
      const planner = functionBody(source(path), declaration);
      // What reads the reference list the mint can change still follows the mint...
      assert.match(planner, /ensured\.then\(\(\) => loadTerritoryCustomers\(/, `${declaration} keeps the customer list behind the mint`);
      assert.match(planner, /ensured\.then\(\(\) => territoryReadiness\(/, `${declaration} keeps the readiness count behind the mint`);
      assert.match(
        planner,
        /customersRead\.then\(\(\{ customers \}\) => loadPlannerReferences\(seat\.seatId, isTest, customers\)\)/,
        `${declaration} reads the references off the customer list, not after the whole first wave`,
      );
      // ...and nothing else waits for it.
      assertBefore(planner, "const wave = Promise.all([", "await ensured;", `${declaration} starts every other read before the mint is awaited`);
      assert.ok(planner.includes("wave.catch(() => undefined);"), `${declaration} handles the early wave the moment it starts`);
    }
  }

  // ── Phoenix CRM · the chunked mirror reads ─────────────────────────────────────────────────────
  {
    const chunked: Array<[string, string]> = [
      ["src/lib/crm/reps-list.ts", "async function loadContactBrickMap("],
      ["src/lib/crm/reps-list.ts", "export async function loadCheckins("],
      ["src/lib/crm/reps-list.ts", "export async function loadPinsFor("],
      // Since 2026-10-16 these two are gathered in the database, with the page walk kept for a database
      // the function has not reached — both halves read their chunks a few at a time.
      ["src/lib/crm/shared-customers.ts", "async function loadPlanDatesCounted("],
      ["src/lib/crm/shared-customers.ts", "async function loadPlanDatesPaged("],
      ["src/lib/crm/reads.ts", "async function readContactVisitHistoryCounted("],
      ["src/lib/crm/reads.ts", "async function readContactVisitHistoryPaged("],
    ];
    for (const [path, declaration] of chunked) {
      const body = functionBody(source(path), declaration);
      assert.match(body, /mapWithConcurrency\(/, `${declaration} reads its chunks a few at a time`);
      assert.doesNotMatch(body, /for \(let from = 0;/, `${declaration} has no one-chunk-at-a-time loop left`);
    }

    // The check-ins page by KEYSET on their own total order, never by OFFSET over the union view.
    const checkins = functionBody(source("src/lib/crm/reps-list.ts"), "export async function loadCheckins(");
    assert.doesNotMatch(checkins, /\.range\(/, "loadCheckins never pages by OFFSET");
    assert.match(checkins, /\.limit\(PAGE_SIZE\)/, "loadCheckins pages a thousand at a time");
    assert.ok(
      checkins.includes('query.or(`check_date.lt."${after.at}",and(check_date.eq."${after.at}",crm_checkin_id.lt.${after.id})`)'),
      "each page starts strictly after the last row of the one before, on the order the walk reads in",
    );
    assertBefore(checkins, '.order("check_date", { ascending: false })', '.order("crm_checkin_id", { ascending: false })', "newest first, the check-in id breaking a tie");

    // The plan days and the iReports360 history are gathered in the database first, the walk kept behind.
    const planDates = functionBody(source("src/lib/crm/shared-customers.ts"), "export async function loadPlanDatesFor(");
    assert.match(planDates, /const counted = await loadPlanDatesCounted\(ids, fromIsoDay\);/, "the plan days are gathered in the database");
    assert.match(planDates, /return counted \?\? loadPlanDatesPaged\(ids, fromIsoDay\);/, "and walked only where the function is missing");
    const planCounted = functionBody(source("src/lib/crm/shared-customers.ts"), "async function loadPlanDatesCounted(");
    assert.match(planCounted, /if \(error && isMissingCrmRpcError\(error\)\) return null;/, "only a missing function falls back to the walk");
    assert.match(planCounted, /phoenix_crm_plan_pattern_failed/, "any other failure costs the one column, logged as it always was");

    // The loader's rep-independent reads start with the rep's list, not after it.
    const loader = functionBody(source("src/lib/crm/reps-list.ts"), "export async function getRepsListForAgent(");
    for (const read of ["const regionBrickMapRead = loadRegionBrickMap();", "const rosterRead = loadContactRoster();", "const counterpartiesRead = loadTradeCounterparties();"]) {
      assertBefore(loader, read, "await getRepContactList(hrId)", `${read} starts before the rep's list is awaited`);
    }

    // The month activity needs the rep and the month, never the list.
    const board = functionBody(source("src/lib/crm/reps-list-board.ts"), "async function assembleBoard(");
    assertBefore(board, "const activityRead", "await getRepsListForAgent(", "the board's activity starts beside the list, not after it");
  }

  // ── Phoenix CRM · Validate and Add place (2026-10-16) ──────────────────────────────────────────
  {
    const list = source("src/lib/phoenix-crm/server/list.ts");
    for (const declaration of ["export async function validateCustomer(", "export async function addPlace("]) {
      const save = functionBody(list, declaration);
      // The place row is built while the Google and signboard checks run, never after them...
      assert.ok(save.includes("const placeRowRead = place ? placePayload(place, seat) : null;"), `${declaration} starts the place row early`);
      assert.ok(save.includes("placeRowRead?.catch(() => undefined);"), `${declaration} handles it the moment it starts`);
      assertBefore(save, "const placeRowRead = ", "googleCheckForSave(subject, place,", `${declaration} starts it before the Google check`);
      // ...and the records kept after the save no longer hold the reply open.
      assert.ok(save.includes("await afterResponse("), `${declaration} keeps its post-save records after the reply`);
      assertBefore(save, "await afterResponse(", "await recordPlaceSignboard(", `${declaration}: the signboard verdict is kept after the reply`);
      assertBefore(save, "await afterResponse(", "await judgeCaptureForPlace(", `${declaration}: the capture is judged after the reply`);
      const deferred = save.slice(save.indexOf("await afterResponse("), save.indexOf("\n  });", save.indexOf("await afterResponse(")));
      assert.doesNotMatch(deferred, /notify/i, `${declaration}: a notice is never deferred from here — the notices own their own timing`);
    }
    const validate = functionBody(list, "export async function validateCustomer(");
    assertBefore(validate, "await afterResponse(", "restampVisitLocationsQuietly(", "the restamp of his earlier visits runs after the reply");
    assertBefore(validate, "});\n  if (validated.requestId && validated.requestKind) {", "await notifyRequestRaised(", "and the request's notice is sent as it always was, outside it");

    // The reference entry is read for one contact, beside his own row id.
    const subject = functionBody(list, "async function validationSubject(");
    assert.ok(
      subject.includes("await Promise.all([loadReferenceEntry(seatId, isTest, contact), customerIdForReference(seatId, isTest, contact)])"),
      "the carried-over entry and his row id are read at once",
    );
    assert.doesNotMatch(subject, /loadReference\(seatId, isTest\)/, "never the whole territory's reference for one contact");
    const entry = functionBody(list, "async function loadReferenceEntry(");
    assert.ok(entry.includes('.eq("contact_crm_id", contactCrmId)'), "only his rows travel");
    assert.ok(entry.includes('.order("list_type", { ascending: true })'), "in the order the whole list holds them");
    assert.ok(entry.includes("withoutCertainWholesalers("), "after the same wholesaler rule");
    assertBefore(functionBody(list, "export async function addPlace("), "const subjectRead = validationSubject(", "await sharedPlaceForSeating(", "Add place reads its customer beside the venue");
  }

  // ── Phoenix CRM · Reports and the shared chunk ─────────────────────────────────────────────────
  {
    // Outside the test world the default Visits address reads nothing the scope answers.
    const reports = source("src/components/phoenix-crm/reports-tab.tsx");
    assert.match(
      reports,
      /if \(!view && \(test \|\| name !== "visits"\)\) return null;/,
      "the first Reports figures are asked for beside the scope, not after it",
    );

    // The app shell is in the chunk every Phoenix CRM page loads; the camera must not be.
    const shell = source("src/components/phoenix-crm/phoenix-crm-app.tsx");
    assert.match(shell, /import \{ releaseCapturedPhoto \} from "@\/components\/phoenix-crm\/captured-photo";/, "the shell frees a preview through the leaf module");
    assert.doesNotMatch(
      shell,
      /^import (?!type )[^;]*from "@\/components\/phoenix-crm\/live-photo-capture";/m,
      "and never imports the camera module at run time — that put the whole camera in every page's chunk",
    );
    const leaf = source("src/components/phoenix-crm/captured-photo.ts");
    for (const line of leaf.split("\n").filter((text) => text.startsWith("import "))) {
      assert.match(line, /^import type /, `captured-photo.ts must stay a leaf — only type imports, never: ${line}`);
    }
  }

  // ── The landing page ───────────────────────────────────────────────────────────────────────────
  {
    const snapshotSource = source("src/lib/employee-portal/home-snapshot.ts");
    const snapshot = functionBody(snapshotSource, "export async function getPortalHomeSnapshot(");
    const firstAwait = snapshot.indexOf("await ");
    const shellStart = snapshot.indexOf("const shellPromise = getEmployeePortalShellData(access);");
    assert.ok(shellStart >= 0 && shellStart < firstAwait, "the landing snapshot starts the shell read without waiting on it");
    for (const started of [
      "const earlyBirdStarsPromise = ",
      "const planAdherencePromise = ",
      "const leaveDaysRemainingPromise = ",
      "const myInterviewsPromise",
    ]) {
      assertBefore(snapshot, started, "const shell = await shellPromise;", `${started.trim()} is started with the rest, not after every other read`);
    }
    assertBefore(
      snapshot,
      "const [vacationResult, excuseResult, batchResult] = await",
      "const shell = await shellPromise;",
      "and the shell is only awaited once the other reads are all in flight",
    );

    // The rep's KPI tile never reads the board's two per-rep reports.
    assert.match(
      functionBody(snapshotSource, "async function loadMrFieldKpis("),
      /getKpisBoard\(\{ access, includeReports: false,/,
      "the rep's KPI tile does not pay for the reports it never shows",
    );
  }

  console.log("portal rep navigation speed: OK");
}
