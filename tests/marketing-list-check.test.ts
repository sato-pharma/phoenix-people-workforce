import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { marketingRoiPageItems } from "../src/config/system-navigation.ts";
import { metresBetween } from "../src/lib/crm/location-confidence.ts";
import {
  CHECKED_NOT_ON_CRM_LIST_FLAG,
  CRM_LIST_NEEDS_CHECK_FLAG,
  CRM_LIST_NO_HOLDER_FLAG,
  CRM_LIST_NURSERY_FLAG,
  crmListFlag,
  crmListFlagChip,
  LEFT_CRM_LIST_FLAG,
  NOT_ON_CRM_LIST_FLAG,
} from "../src/lib/marketing-requests/crm-doctor-pick.ts";
import {
  buildListCheckBoard,
  checkForRequest,
  latestRaisedObjection,
  type ListCheckBoardRow,
  visitsSinceThen,
} from "../src/lib/marketing-requests/crm-list-check-board.ts";
import { buildListCheckWorkbook } from "../src/lib/marketing-requests/crm-list-check-export.ts";
import { nearestDoctorPhotoPath, worstListCheckFlagFacts } from "../src/lib/marketing-requests/crm-list-check-flags.ts";
import {
  canDecideListCheck,
  canReadListCheckBoard,
  compareNames,
  currentListCheckRows,
  judgeListCheck,
  LIST_CHECK_STATE_LABELS,
  LIST_CHECK_STATE_ORDER,
  listCheckIsFar,
  listCheckSpokesmanIndex,
  listTypesForCustomerType,
  looksLikeNursery,
  planListCheckCustomerWrite,
  type ListCheckCandidate,
  type ListCheckInput,
  type ListCheckVerdict,
} from "../src/lib/marketing-requests/crm-list-check-rules.ts";

/** Metres become a latitude step through the same measure the rule reads, so 500 is exactly 500. */
const HOME = { lat: 30.05, lon: 31.25 };
const METRES_PER_DEGREE = metresBetween(HOME.lat, HOME.lon, HOME.lat + 1, HOME.lon);
function metresNorth(metres: number) {
  return { lat: HOME.lat + metres / METRES_PER_DEGREE, lon: HOME.lon };
}

function candidate(overrides: Partial<ListCheckCandidate> & { name: string }, metres: number | null = 0): ListCheckCandidate {
  return {
    contactBrickId: null,
    contactId: null,
    crmCustomerId: "crm-1",
    listType: "PM",
    places: metres === null ? [] : [{ brickId: null, photoPath: null, point: metresNorth(metres) }],
    seatId: "seat-1",
    ...overrides,
  };
}

function input(overrides: Partial<ListCheckInput> = {}): ListCheckInput {
  return {
    areaCode: "AREA",
    brickId: "brick-1",
    candidates: [],
    crmListSource: null,
    crmListStatus: null,
    customerType: "clinic",
    declaredCrmCodes: [],
    displayName: "محمد علي موسي",
    holderOccupied: true,
    linkedRow: null,
    lineKnown: true,
    now: "2026-11-03T00:00:00.000Z",
    point: HOME,
    prior: null,
    ...overrides,
  };
}

function boardRow(overrides: Partial<ListCheckBoardRow> & { checkId: string; customerId: string; state: ListCheckBoardRow["state"] }): ListCheckBoardRow {
  return {
    approvedCost: 0,
    approvedRequests: 0,
    customerName: "Customer",
    customerPhotoUrl: null,
    decidedAt: null,
    decidedByName: null,
    doctorPhotoUrl: null,
    far: false,
    firstPayDate: null,
    lastVisitDate: null,
    latestObjection: null,
    leftListAt: null,
    lineName: "Pedia",
    listAreaName: null,
    listType: null,
    looksLikeNursery: false,
    marketingAreaName: "Giza",
    matchedCrmCustomerId: null,
    matchedName: null,
    metresApart: null,
    open: false,
    reason: "",
    repNames: [],
    requesterNames: [],
    stateLabel: LIST_CHECK_STATE_LABELS[overrides.state],
    visitsSincePay: null,
    ...overrides,
  };
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

export async function runMarketingListCheckTests() {
  // ------------------------------------------------------------ names: his one letter, and no further

  assert.equal(compareNames("محمد علي موسي", "محمد علي موسى"), "same", "the folding every Arabic comparison uses");
  assert.equal(compareNames("عبدالحميد علي", "عبد الحميد علي"), "same", "a glued name is one spelling");
  assert.equal(compareNames("كريم الشناوي", "كريم الشناوى"), "same", "ى and ي are one letter");
  assert.equal(compareNames("كريم الشناوي", "كريم شناوي"), "same", "the article is not a letter of the name");
  assert.equal(compareNames("كريم سرحان", "كريم سرحانة"), "one_letter", "one letter per word is his tolerance");
  assert.equal(compareNames("كريم سرحان", "كريم سلطان"), "none", "two letters is another person");
  assert.equal(compareNames("احمد علي", "محمد علي"), "none", "أحمد and محمد are one letter apart and two people");
  assert.equal(compareNames("كمال سرحان", "جمال سرحان"), "none", "كمال and جمال are one letter apart and two people");
  assert.equal(compareNames("كريم سرحان عبده", "كريم سرحان"), "part", "the shorter name inside the longer one is only part of a name");
  assert.equal(compareNames("كريم", "كريم"), "part", "the same single word is never evidence on its own");
  assert.equal(compareNames("", "كريم"), "none");

  // ------------------------------------------------------------ which list

  assert.deepEqual(listTypesForCustomerType("clinic"), { certain: true, listTypes: ["PM"] }, "a clinic is on the PM list");
  assert.deepEqual(listTypesForCustomerType("Doctor"), { certain: true, listTypes: ["PM"] });
  assert.deepEqual(listTypesForCustomerType("hospital"), { certain: true, listTypes: ["AM"] }, "a hospital is on the AM list");
  assert.deepEqual(listTypesForCustomerType("account"), { certain: true, listTypes: ["AM"] });
  assert.equal(listTypesForCustomerType("other").certain, false, "`other` could be either, so it can never reach on_list alone");

  // ------------------------------------------------------------ the verdict: 500 m, his number

  const name = "محمد علي موسي";
  const onDoor = judgeListCheck(input({ candidates: [candidate({ name }, 499)] }));
  assert.equal(onDoor.state, "on_list", "same name within 500 m is on the list");
  assert.equal(onDoor.metresApart, 499);
  assert.equal(judgeListCheck(input({ candidates: [candidate({ name }, 500)] })).state, "on_list", "500 m itself is inside his number");
  const justOver = judgeListCheck(input({ candidates: [candidate({ name }, 501)] }));
  assert.equal(justOver.state, "check", "over 500 m is a person's question, never on_list");
  assert.match(justOver.reason, /m apart/);

  // Measured on production, 2026-11-03: a doctor 7.5 km away in the same brick read as proven.
  const sameBrickFar = judgeListCheck(
    input({ candidates: [candidate({ name, places: [{ brickId: "brick-1", photoPath: null, point: metresNorth(7_500) }] }, null)] }),
  );
  assert.equal(sameBrickFar.state, "check", "7.5 km apart is his flag whatever brick they share");
  const sameBrickUnmeasured = judgeListCheck(input({ candidates: [candidate({ contactBrickId: "brick-1", name }, null)] }));
  assert.equal(sameBrickUnmeasured.state, "on_list", "with no distance to read, the same name and the same brick is his sheet's own answer");
  assert.equal(judgeListCheck(input({ candidates: [candidate({ name }, null)] })).state, "check", "no place and no brick proves nothing");

  // Seen on the Check queue, 2026-11-03: both photos on screen, 243 m apart, and the sentence said "no photo to compare".
  const partName = "محمد علي";
  const partMeasured = judgeListCheck(
    input({ candidates: [candidate({ name: partName, places: [{ brickId: "brick-1", photoPath: "doctor.jpg", point: metresNorth(243) }] }, null)] }),
  );
  assert.equal(partMeasured.state, "check");
  assert.match(partMeasured.reason, /243 m apart/, "a distance that was measured is what the sentence says, whatever brick they share");
  assert.doesNotMatch(partMeasured.reason, /no photo/, "the sentence never denies a photo the page is showing");
  const partUnmeasured = judgeListCheck(input({ candidates: [candidate({ contactBrickId: "brick-1", name: partName }, null)] }));
  assert.match(partUnmeasured.reason, /in the same brick, with no photo to compare/, "with nothing measured, the brick is still what is left to say");

  // Thinner evidence must stand closer.
  assert.equal(
    judgeListCheck(input({ candidates: [candidate({ name: "محمد علي" }, 99)] })).state,
    "on_list",
    "part of a name within 100 m is proven",
  );
  assert.equal(
    judgeListCheck(input({ candidates: [candidate({ name: "محمد علي" }, 101)] })).state,
    "check",
    "part of a name beyond 100 m is only a question",
  );
  assert.equal(
    judgeListCheck(input({ candidates: [candidate({ name: "خالد سرحان" }, 99)] })).state,
    "check",
    "a different name at the same door is worth a person's look",
  );
  assert.equal(
    judgeListCheck(input({ candidates: [candidate({ name: "خالد سرحان" }, 101)] })).state,
    "not_on_list",
    "a different name past 100 m is nobody: 500 m sent 15 unrelated names to the queue",
  );

  // Code declared, two people, the two lists.
  assert.equal(
    judgeListCheck(input({ candidates: [candidate({ contactId: 77, name: "خالد سرحان" }, 3_000)], declaredCrmCodes: ["77"] })).state,
    "on_list",
    "a CRM code already declared on the customer proves it",
  );
  assert.equal(
    judgeListCheck(
      input({ candidates: [candidate({ contactId: 1, crmCustomerId: "a", name }, 10), candidate({ contactId: 2, crmCustomerId: "b", name }, 20)] }),
    ).state,
    "check",
    "two different people who fit is a person's question",
  );
  assert.equal(
    judgeListCheck(
      input({ candidates: [candidate({ contactId: 1, crmCustomerId: "a", name, seatId: "s1" }, 10), candidate({ contactId: 1, crmCustomerId: "b", name, seatId: "s2" }, 20)] }),
    ).state,
    "on_list",
    "one person on two reps' rows is one match, not two doctors",
  );
  assert.equal(
    judgeListCheck(input({ candidates: [candidate({ name }, 10)], customerType: "other" })).state,
    "check",
    "`other` never reaches on_list without a person",
  );

  // ------------------------------------------------------------ the states that are not a match

  assert.equal(judgeListCheck(input({ point: null })).state, "no_location", "no GPS, no area");
  assert.equal(judgeListCheck(input({ lineKnown: false })).state, "check", "no line, no list to choose");
  assert.equal(judgeListCheck(input({ areaCode: null })).state, "check", "a point in no area");
  const vacant = judgeListCheck(input({ holderOccupied: false }));
  assert.equal(vacant.state, "no_holder", "no list and nobody on the seat");
  assert.equal(
    judgeListCheck(input({ candidates: [candidate({ name: "خالد سرحان" }, 5_000)], holderOccupied: false })).state,
    "no_holder",
    "a vacant seat with no match is not a real not-on-list",
  );
  assert.equal(judgeListCheck(input({ candidates: [candidate({ name: "خالد سرحان" }, 5_000)] })).state, "not_on_list");

  // ------------------------------------------------------------ the nursery rule: flags, never blocks, never on_list

  assert.equal(looksLikeNursery("حضانة النور"), true);
  assert.equal(looksLikeNursery("الحضانات"), true);
  assert.equal(looksLikeNursery("د. احمد"), false);
  const nursery = judgeListCheck(input({ candidates: [candidate({ name: "حضانة النور" }, 5)], displayName: "حضانة النور" }));
  assert.equal(nursery.state, "check", "a nursery never reads on_list without a person");
  assert.equal(nursery.looksLikeNursery, true);
  assert.equal(judgeListCheck(input({ displayName: "حضانة النور", point: null })).state, "check", "a nursery with no GPS still asks");
  assert.equal(
    judgeListCheck(input({ candidates: [candidate({ name: "حضانة النور" }, 5)], displayName: "حضانة النور", prior: { decidedState: "on_list", leftListAt: null, matchedCrmCustomerId: "crm-1", state: "check" }, linkedRow: { ...candidate({ name: "حضانة النور" }, 5), onList: true } })).state,
    "on_list",
    "a person's answer beats the name",
  );

  // ------------------------------------------------------------ a person's answer and a pick outrank every re-check

  const decidedNot = judgeListCheck(input({ candidates: [candidate({ name }, 5)], prior: { decidedState: "not_on_list", leftListAt: null, matchedCrmCustomerId: null, state: "check" } }));
  assert.equal(decidedNot.state, "not_on_list", "a person's 'not the same' survives a perfect match");
  const picked = judgeListCheck(input({ crmListSource: "picked", crmListStatus: "on_list", linkedRow: { ...candidate({ name: "خالد سرحان" }, 9_000), onList: true } }));
  assert.equal(picked.state, "on_list", "a pick stands, whatever the names say");
  assert.equal(picked.metresApart, 9_000, "and the distance is still read, so the approver sees the flag");
  assert.equal(listCheckIsFar(picked.metresApart), true);
  assert.equal(listCheckIsFar(500), false);
  assert.equal(listCheckIsFar(501), true);
  assert.equal(listCheckIsFar(null), false, "not measured is not far");

  // ------------------------------------------------------------ left the list

  const gone = judgeListCheck(input({ crmListSource: "picked", crmListStatus: "on_list", linkedRow: { ...candidate({ name }, 5), onList: false } }));
  assert.equal(gone.state, "left_list", "a picked doctor no longer on the list");
  assert.equal(gone.leftListAt, "2026-11-03T00:00:00.000Z", "stamped the first time it is seen");
  const stillGone = judgeListCheck(input({ candidates: [], prior: { decidedState: null, leftListAt: "2026-10-01T00:00:00.000Z", matchedCrmCustomerId: "crm-1", state: "left_list" } }));
  assert.equal(stillGone.state, "left_list");
  assert.equal(stillGone.leftListAt, "2026-10-01T00:00:00.000Z", "the first day it was seen never moves");
  assert.equal(
    judgeListCheck(input({ candidates: [], prior: { decidedState: null, leftListAt: null, matchedCrmCustomerId: "crm-1", state: "on_list" } })).state,
    "left_list",
    "a checked doctor whose list no longer holds him",
  );

  // ------------------------------------------------------------ 🔴 the customer's own columns

  const onVerdict: ListCheckVerdict = judgeListCheck(input({ candidates: [candidate({ crmCustomerId: "crm-9", name }, 5)] }));
  assert.equal(
    planListCheckCustomerWrite({ current: { crmListSource: "picked", crmListStatus: "on_list", phoenixCrmCustomerId: "crm-1" }, decidedState: "not_on_list", verdict: decidedNot }),
    null,
    "🔴 A PICK IS NEVER OVERWRITTEN, not even by a decision",
  );
  assert.equal(
    planListCheckCustomerWrite({ current: { crmListSource: null, crmListStatus: "on_list", phoenixCrmCustomerId: "crm-1" }, decidedState: null, verdict: decidedNot }),
    null,
    "a row saved before the column tells its source by its status",
  );
  assert.equal(
    planListCheckCustomerWrite({ current: { crmListSource: "typed", crmListStatus: "not_on_list", phoenixCrmCustomerId: null }, decidedState: null, verdict: onVerdict }),
    null,
    "🔴 a typed name changes only on a person's 'same doctor'",
  );
  assert.deepEqual(
    planListCheckCustomerWrite({ current: { crmListSource: "typed", crmListStatus: "not_on_list", phoenixCrmCustomerId: null }, decidedState: "on_list", verdict: onVerdict }),
    { crm_list_source: "checked", crm_list_status: "on_list", phoenix_crm_customer_id: "crm-9" },
    "a person's 'same doctor' moves a typed name",
  );
  assert.deepEqual(
    planListCheckCustomerWrite({ current: { crmListSource: null, crmListStatus: null, phoenixCrmCustomerId: null }, decidedState: null, verdict: onVerdict }),
    { crm_list_source: "checked", crm_list_status: "on_list", phoenix_crm_customer_id: "crm-9" },
  );
  assert.equal(
    planListCheckCustomerWrite({ current: { crmListSource: "checked", crmListStatus: "on_list", phoenixCrmCustomerId: "crm-9" }, decidedState: null, verdict: onVerdict }),
    null,
    "nothing to write when nothing changed, so the hourly pass stays quiet",
  );
  assert.deepEqual(
    planListCheckCustomerWrite({ current: { crmListSource: "checked", crmListStatus: "on_list", phoenixCrmCustomerId: "crm-9" }, decidedState: null, verdict: justOver }),
    { crm_list_source: "checked", crm_list_status: null, phoenix_crm_customer_id: null },
    "an unsure row claims neither answer",
  );

  // ------------------------------------------------------------ the flag every approver reads

  assert.equal(crmListFlag("not_on_list"), NOT_ON_CRM_LIST_FLAG, "no check, no source: as it always read");
  assert.equal(crmListFlag("not_on_list", { source: "typed" }), NOT_ON_CRM_LIST_FLAG);
  assert.equal(crmListFlag("not_on_list", { source: "checked" }), CHECKED_NOT_ON_CRM_LIST_FLAG, "🔴 never 'typed by hand' about a row nobody typed");
  assert.doesNotMatch(CHECKED_NOT_ON_CRM_LIST_FLAG, /typed/i);
  assert.equal(crmListFlag(null), null, "a customer the check has not reached stays unflagged");
  assert.equal(crmListFlag("on_list"), null);
  assert.equal(crmListFlag("on_list", { check: { metresApart: 500, state: "on_list" } }), null, "500 m is inside his number");
  const farFlag = crmListFlag("on_list", { check: { metresApart: 501, state: "on_list" } });
  assert.match(String(farFlag), /501 m/, "over 500 m names the distance");
  assert.match(String(crmListFlag("on_list", { check: { metresApart: 7_553, state: "on_list" } })), /7\.6 km/);
  assert.equal(crmListFlag("not_on_list", { check: { state: "left_list" } }), LEFT_CRM_LIST_FLAG);
  assert.equal(crmListFlag(null, { check: { state: "check" } }), CRM_LIST_NEEDS_CHECK_FLAG);
  assert.equal(crmListFlag("not_on_list", { check: { state: "no_holder" } }), CRM_LIST_NO_HOLDER_FLAG);
  assert.equal(crmListFlag("on_list", { check: { looksLikeNursery: true, state: "on_list" } }), CRM_LIST_NURSERY_FLAG, "the nursery sentence comes first");
  assert.equal(crmListFlag("not_on_list", { check: { state: "not_on_list" }, source: "checked" }), CHECKED_NOT_ON_CRM_LIST_FLAG);
  for (const flag of [NOT_ON_CRM_LIST_FLAG, CHECKED_NOT_ON_CRM_LIST_FLAG, LEFT_CRM_LIST_FLAG, CRM_LIST_NEEDS_CHECK_FLAG, CRM_LIST_NO_HOLDER_FLAG, CRM_LIST_NURSERY_FLAG, String(farFlag)]) {
    assert.ok(crmListFlagChip(flag).length > 0);
  }
  assert.match(crmListFlagChip(NOT_ON_CRM_LIST_FLAG), /typed by hand/);
  assert.doesNotMatch(crmListFlagChip(CHECKED_NOT_ON_CRM_LIST_FLAG), /typed/, "🔴 the chip tells the same truth as the sentence");
  assert.equal(crmListFlagChip(String(farFlag)), "Check the two photos");

  assert.equal(worstListCheckFlagFacts([]), null);
  assert.deepEqual(
    worstListCheckFlagFacts([
      { looks_like_nursery: false, metres_apart: 10, state: "on_list" },
      { looks_like_nursery: true, metres_apart: 900, state: "check" },
    ]),
    { looksLikeNursery: true, metresApart: 900, state: "check" },
    "the worst line speaks for a customer on two lines",
  );

  assert.equal(
    nearestDoctorPhotoPath(
      [
        { photo_lat: metresNorth(900).lat, photo_lon: HOME.lon, photo_path: "far.jpg" },
        { photo_lat: metresNorth(20).lat, photo_lon: HOME.lon, photo_path: "near.jpg" },
        { photo_lat: metresNorth(1).lat, photo_lon: HOME.lon, photo_path: null },
      ],
      HOME,
    ),
    "near.jpg",
    "the two photos compare the nearest place that kept a photo",
  );
  assert.equal(nearestDoctorPhotoPath([], HOME), null);

  // ------------------------------------------------------------ who reads, who answers

  for (const role of ["Super Admin", "SFE Manager", "CEO", "Marketing Manager"]) assert.equal(canReadListCheckBoard(role), true, role);
  for (const role of ["Medical Rep", "District Manager", "Finance Manager", "HR Manager", null]) assert.equal(canReadListCheckBoard(role), false, String(role));
  for (const role of ["Super Admin", "SFE Manager"]) assert.equal(canDecideListCheck(role), true, role);
  for (const role of ["CEO", "Marketing Manager", "Medical Rep", null]) assert.equal(canDecideListCheck(role), false, String(role));
  const navItem = marketingRoiPageItems.find((item) => item.href === "/admin/marketing-requests/list-check");
  assert.deepEqual(new Set(navItem?.roles ?? []), new Set(["Super Admin", "CEO", "SFE Manager", "Marketing Manager"]), "the card and the door are one list");

  // ------------------------------------------------------------ the board's sums: no pound counted twice

  const rows = [
    boardRow({ approvedCost: 1_000, approvedRequests: 1, checkId: "a1", customerId: "a", lineName: "Pedia", state: "on_list" }),
    boardRow({ approvedCost: 500, approvedRequests: 1, checkId: "a2", customerId: "a", lineName: "CNS", state: "check", open: true }),
    boardRow({ approvedCost: 250, approvedRequests: 1, checkId: "b1", customerId: "b", lineName: "Pedia", state: "no_holder", marketingAreaName: null }),
    boardRow({ checkId: "c1", customerId: "c", leftListAt: "2026-10-01", state: "left_list" }),
  ];
  const board = buildListCheckBoard({
    canDecide: true,
    generatedAtIso: "2026-11-03T00:00:00.000Z",
    labels: LIST_CHECK_STATE_LABELS,
    order: LIST_CHECK_STATE_ORDER,
    requesterShares: [
      { checkId: "a1", cost: 1_000, requesterName: "Requester One" },
      { checkId: "a2", cost: 500, requesterName: "Requester One" },
      { checkId: "b1", cost: 250, requesterName: "Requester Two" },
      { checkId: "gone", cost: 9_999, requesterName: "Nobody" },
    ],
    rows,
    showObjections: false,
  });
  assert.deepEqual(board.totals, { approvedCost: 1_750, approvedCostOffList: 750, customers: 3, onListCustomers: 1, openChecks: 1 });
  assert.equal(board.cards.find((card) => card.state === "no_holder")?.approvedCost, 250, "money spent on doctors no rep holds is its own card");
  assert.equal(board.cards.find((card) => card.state === "on_list")?.customers, 1);
  assert.deepEqual(board.rows.map((row) => row.checkId), ["c1", "a2", "b1", "a1"], "worst state first, the place to look on top");
  const one = board.byRequester.find((row) => row.name === "Requester One");
  assert.deepEqual(one, { approvedCost: 1_500, approvedCostOffList: 500, customers: 1, name: "Requester One", onListCustomers: 1 });
  assert.equal(board.byRequester.some((row) => row.name === "Nobody"), false, "a share with no row is no money");
  assert.equal(board.byArea.some((row) => row.name === "No area read"), true, "an unread area is said, never dropped");
  assert.equal(board.byLine.reduce((sum, row) => sum + row.approvedCost, 0), board.totals.approvedCost, "the breakdown sums to the card");

  assert.deepEqual(checkForRequest([{ lineId: 1 }, { lineId: 2 }], 2), { lineId: 2 }, "a request's money lands on its own line");
  assert.deepEqual(checkForRequest([{ lineId: 1 }, { lineId: 2 }], null), { lineId: 1 }, "with no line, on the customer's first row, once");
  assert.equal(checkForRequest([], 1), null);

  const describe = (value: unknown) => (value === "none" || !value ? null : String(value));
  assert.deepEqual(
    latestRaisedObjection(
      [
        { objection: "price", objectionNote: null, visitDate: "2026-10-01" },
        { objection: "none", objectionNote: null, visitDate: "2026-11-01" },
        { objection: "efficacy", objectionNote: "said so", visitDate: "2026-10-15" },
      ],
      describe,
    ),
    { date: "2026-10-15", label: "efficacy", note: "said so" },
    "🔴 the newest objection RAISED: 'None' never reaches the board",
  );
  assert.equal(latestRaisedObjection([{ objection: "none", objectionNote: null, visitDate: "2026-11-01" }], describe), null);

  // ------------------------------------------------------------ the sheet, his layout

  const workbook = await buildListCheckWorkbook(board);
  const sheet = workbook.getWorksheet("List Check");
  assert.ok(sheet);
  const headers = sheet.getRow(1).values as unknown[];
  assert.deepEqual(headers.slice(1, 5), ["Marketing Name", "Rep List Name", "Marketing Area", "Rep List Area"], "the two names, then the two areas");
  const fill = (column: number) => (sheet.getRow(1).getCell(column).fill as { fgColor?: { argb?: string } }).fgColor?.argb;
  assert.equal(fill(1), "FF0A527D", "dark blue is customer validation");
  assert.equal(fill(2), "FF1482C2", "light blue is doctor validation");
  assert.equal(fill(3), "FF0A527D");
  assert.equal(fill(4), "FF1482C2");
  assert.equal(headers.includes("Latest Objection"), false, "🔴 a reader outside the managers' audience gets no objection column");
  const managers = await buildListCheckWorkbook({ ...board, showObjections: true });
  assert.equal((managers.getWorksheet("List Check")?.getRow(1).values as unknown[]).includes("Latest Objection"), true);

  // ------------------------------------------------------------ the wiring (source pins)

  const service = read("src/lib/marketing-requests/crm-list-check-board-service.ts");
  assert.match(service, /canReadListCheckBoard\(access\.role\)\) throw forbiddenError/, "the board refuses a role before it reads anything");
  assert.match(service, /phoenix_crm_countable_visits/, "visits come from the one predicate for a visit that counts");
  assert.match(service, /\.eq\("customer_validated", true\)/);
  assert.match(service, /const showObjections = readsDoctorObjections\(access\.role\)/, "🔴 the objection is withheld by role on the server, not hidden by the page");
  assert.match(service, /latestObjection: showObjections/);
  assert.doesNotMatch(service, /objections-by-customer/, "the board reads no rep-scoring path");

  const check = read("src/lib/marketing-requests/crm-list-check.ts");
  assert.match(check, /if \(!canDecideListCheck\(access\.role\)\) throw forbiddenError/, "the answer's role check is before any read");
  assert.match(check, /writeRequiredAuditLog/, "every answer leaves an audit row");
  assert.doesNotMatch(check, /from\("phoenix_crm_(customers|places)"\)\s*\.(update|insert|upsert|delete)/, "🔴 nothing here writes to Phoenix CRM");

  const save = read("src/lib/marketing-requests/service.ts");
  const hook = save.slice(save.indexOf('afterResponse("marketing_list_check"') - 400, save.indexOf('afterResponse("marketing_list_check"') + 400);
  assert.match(hook, /try \{/, "🔴 the check after a save can never refuse the save");
  assert.match(hook, /catch \(error\)/);
  assert.match(save, /crm_list_source: doctorPicks\.get\(normalizedCustomer\)\?\.crmListStatus === "on_list" \? "picked" : "typed"/, "a new customer records who answered");

  const route = read("app/api/marketing-requests/list-check/decide/route.ts");
  assert.match(route, /assertSameOriginMutation/, "the answer is a same-origin mutation");
  const cron = read("app/api/cron/marketing-list-check/route.ts");
  assert.match(cron, /assertCronAuthorized\(request, "cron\/marketing-list-check"\)/);
  assert.match(cron, /withDeadMansSwitch\("phoenix-marketing-list-check"/);
  assert.doesNotMatch(cron, /sendEmail|notify|enqueue/i, "the hourly pass sends nothing to anyone");

  const approver = read("src/components/marketing-requests/marketing-request-approver-detail.tsx");
  assert.match(approver, /<NotOnCrmListFlag flag=\{detail\.customerCrmListFlag\} \/>\s*\{\/\*[\s\S]*?\*\/\}\s*\{detail\.customerListCheckPhotos \?/, "the two photos stand beside the flag");
  const flags = read("src/lib/marketing-requests/crm-list-check-flags.ts");
  assert.match(flags, /console\.error\("\[marketing-list-check\] the two photos could not be read/, "🔴 a failed read degrades; the decision screen always opens");

  const board2 = read("src/components/marketing-requests/marketing-list-check-board.tsx");
  assert.equal(visitsSinceThen(1), "1 visit since then");
  assert.equal(visitsSinceThen(0), "0 visits since then");
  assert.equal(visitsSinceThen(1200), "1,200 visits since then");
  assert.match(board2, /visitsSinceThen\(row\.visitsSincePay\)/, "the board prints the sentence that counts properly");
  assert.match(board2, /w-full table-fixed/, "the fits-the-screen rule");
  assert.doesNotMatch(board2, /overflow-x-auto|rounded|truncate/, "no sideways scroll, no round corner, no ellipsis");
  assert.doesNotMatch(read("src/components/marketing-requests/list-check-two-photos.tsx"), /rounded|truncate/);

  // ------------------------------------------------------------ one answer per customer

  const spokesman = (...rows: Array<[("on_list" | "not_on_list" | null), string]>) => listCheckSpokesmanIndex(rows.map(([decidedState, state]) => ({ decidedState, state })));
  assert.equal(spokesman([null, "not_on_list"], [null, "on_list"]), 1, "a line on a list speaks for the customer, whichever came first, so two lines never flip him hourly");
  assert.equal(spokesman([null, "on_list"], ["on_list", "on_list"]), 1, "a person's same doctor outranks a line the check found by itself");
  assert.equal(spokesman([null, "no_holder"], [null, "check"], [null, "not_on_list"]), 1, "with nothing on a list, the worst of the rest speaks");
  const checkService = read("src/lib/marketing-requests/crm-list-check.ts");
  assert.match(checkService, /return at === speaker \? row : \{ \.\.\.row, write: null \}/, "only the row that speaks writes the customer's own columns");
  assert.match(checkService, /item\.prior\?\.decidedState\s*\? \(item\.prior\.matchedCrmCustomerId \?\? phoenixCrmCustomerId\)/, "a person's answer points at that row's own doctor");

  // ------------------------------------------------------------ a row left behind

  const pass = (customer_id: string, checked_at: string, state: string) => ({ checked_at, customer_id, state });
  const left = currentListCheckRows([
    pass("A", "2026-11-03T01:00:00+00:00", "check"),
    pass("A", "2026-11-03T02:00:00+00:00", "on_list"),
    pass("A", "2026-11-03T02:00:00+00:00", "not_on_list"),
    pass("B", "2026-11-03T01:00:00+00:00", "check"),
  ]);
  assert.deepEqual(left.map((row) => `${row.customer_id}:${row.state}`), ["A:on_list", "A:not_on_list", "B:check"], "a customer's older row is gone, and another customer's pass is not compared with his");
  assert.match(read("src/lib/marketing-requests/crm-list-check-flags.ts"), /of currentListCheckRows\(\(data \?\? \[\]\) as FlagRow\[\]\)/, "a row left behind can never hold a flag on every approval step");
  const boardService = read("src/lib/marketing-requests/crm-list-check-board-service.ts");
  assert.match(boardService, /currentListCheckRows\(\(checkRead\.data \?\? \[\]\) as unknown as Row\[\]\)/, "nor a row on the board");
  assert.match(boardService, /customer\?\.active !== false && !customer\?\.merged_into_customer_id && validated\.has/, "a customer who left the check leaves its counts");
  assert.match(checkService, /\.delete\(\)\s*\.in\("customer_id", part\)\s*\.is\("decided_state", null\)\s*\.lt\("checked_at", now\)/, "only an unanswered row of an older pass is ever removed");

  // ------------------------------------------------------------ the first run

  const script = read("scripts/marketing-list-check.ts");
  assert.match(script, /\.is\("decided_state", null\); \/\/ A re-run never overwrites/, "🔴 a re-run of the seed never overwrites a person's answer");
  assert.doesNotMatch(script, /supabase\.schema\(PRE_IMAGE/, "the API exposes no dated schema, so a guard through it could never pass");
  assert.match(script, /customerIds\.filter\(\(id\) => !preImage\.has\(id\)\)/, "the guard is by customer, so a stale pre-image cannot pass on its size");
  assert.match(script, /reads as more than one doctor/, "two doctors are reported, never chosen between");

  // ------------------------------------------------------------ the portal's door, and the record of an export

  const portal = read("app/employee-portals/marketing-requests/list-check/page.tsx");
  assert.match(portal, /if \(!canReadListCheckBoard\(access\.role\)\) redirect/, "the portal page keeps the board's own readers");
  assert.match(read("app/(admin)/admin/marketing-requests/list-check/page.tsx"), /isPortalShellRole\(access\.role\)\) redirect\("\/employee-portals\/marketing-requests\/list-check"\)/, "the Marketing Manager reaches the board, not the portal home");
  for (const route of ["list-check", "finance-ageing"]) {
    assert.match(read(`app/api/marketing-requests/${route}/export/route.ts`), /afterResponse\("marketing_[a-z_]+_export_audit", \(\) =>\s*writeAuditLog\(/, `the ${route} export records who took it, as the registry declares`);
  }
}
