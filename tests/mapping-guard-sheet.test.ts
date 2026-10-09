import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import ExcelJS from "exceljs";

import {
  GUARD_ANSWER_LABEL,
  GUARD_APPLY_PAGE_SIZE,
  isOwnerRuling,
  type GuardGeo,
} from "../src/lib/sales/mapping-guard-sheet-shape.ts";
import {
  GUARD_BRICKS_SHEET_NAME,
  GUARD_GUIDE_SHEET_NAME,
  GUARD_SHEET_NAME,
  buildGuardWorkbook,
  guardPageDigest,
  parseGuardWorkbook,
  planGuardAnswers,
  sheetRowsFromInstructions,
  type GuardLiveHold,
  type GuardSheetRow,
  type ParsedSheetRow,
} from "../src/lib/sales/mapping-guard-workbook.ts";
import { loadExcelWorkbook } from "../src/lib/uploads/exceljs-rows.ts";
import { stripComments } from "./support/comment-strip.ts";

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

const geo = (brickId: string, brickName: string, areaCode: string, areaName: string, regionCode: string, regionName: string): GuardGeo => ({
  areaCode,
  areaName,
  brickId,
  brickName,
  regionCode,
  regionName,
});

const BRICKS = [
  geo("B100-1", "Aswan Centre", "UE1", "Aswan", "UE", "Upper Egypt"),
  geo("B214-M1", "El Balyana", "UE6", "Sohag 2", "UE", "Upper Egypt"),
  geo("B300-2", "Giza Dokki", "GZ1", "Giza", "GZ", "Greater Cairo"),
];
const ACTIVE = new Map(BRICKS.map((brick) => [brick.brickId.toUpperCase(), brick]));

function sheetRow(holdId: number, overrides: Partial<GuardSheetRow> = {}): GuardSheetRow {
  return {
    customerAddress: "12 Nile St, Aswan",
    customerCode: `00${holdId}`,
    customerName: `Pharmacy ${holdId}`,
    distributor: "EPDA Pharmacies",
    distributorCode: "EP-PHS",
    filed: { address: "Nile St", area: "Aswan 1", brick: "Aswan Centre", governorate: "Aswan", name: "Pharmacy", period: "September 2026" },
    holdId,
    now: BRICKS[0],
    nowBrickId: "B100-1",
    otherFiled: ["August 2026 | Other | Elsewhere"],
    ownerRuling: false,
    reasons: ["moves the customer from region UE to GZ"],
    restatedValue: 120.5,
    suggested: { brick: "El Balyana — Sohag 2, Upper Egypt", brickId: "B214-M1", verdict: "A third answer: neither side" },
    trackedValue: 500.25,
    wanted: BRICKS[2],
    ...overrides,
  };
}

function live(holdId: number, overrides: Partial<GuardLiveHold> = {}): GuardLiveHold {
  return {
    customer: `Pharmacy ${holdId}`,
    holdId,
    liveBrickId: "B100-1",
    now: BRICKS[0],
    ownerRuling: false,
    restatedValue: 10,
    rowId: holdId * 10,
    trackedValue: 100,
    wanted: BRICKS[2],
    ...overrides,
  };
}

function answer(holdId: number, overrides: Partial<ParsedSheetRow> = {}): ParsedSheetRow {
  return { holdId, moveToBrickId: "", nowBrickId: "B100-1", rawAnswer: "Allow", rawLock: "", sheetRow: holdId + 1, ...overrides };
}

const liveMap = (...holds: GuardLiveHold[]) => new Map(holds.map((hold) => [hold.holdId, hold]));

async function theSheetRoundTripsAnswersByHeaderName() {
  const buffer = await buildGuardWorkbook({ bricks: BRICKS, rows: [sheetRow(3480), sheetRow(3542)] });
  const workbook = await loadExcelWorkbook(buffer);

  assert.deepEqual(
    workbook.worksheets.map((sheet) => sheet.name),
    [GUARD_SHEET_NAME, GUARD_BRICKS_SHEET_NAME, GUARD_GUIDE_SHEET_NAME],
    "three sheets: the held changes, the geography lookup, and how to use them",
  );

  const sheet = workbook.getWorksheet(GUARD_SHEET_NAME)!;
  const headers: string[] = [];
  sheet.getRow(1).eachCell((cell) => headers.push(String(cell.value)));
  assert.deepEqual(headers.slice(0, 5), ["Hold ID", "Customer Name", "Your Answer", "Move To Brick ID", "Lock My Answer"]);
  for (const wanted of ["Customer Address (Phoenix)", "Filed Address", "Filed Brick", "Now Area", "Wanted Governorate", "Tracked Sales (EGP)"]) {
    assert.ok(headers.includes(wanted), `the sheet must carry "${wanted}"`);
  }

  // Ids are text, so a leading zero or a brick id never turns into a number.
  assert.equal(sheet.getRow(2).getCell(1).value, "3480");
  assert.equal(sheet.getRow(2).getCell(1).numFmt, "@");
  assert.equal(sheet.getRow(2).getCell(8).value, "003480", "the customer code keeps its leading zeros");
  assert.equal(sheet.getRow(2).getCell(3).dataValidation?.type, "list", "Your Answer is a dropdown");
  assert.equal(sheet.views[0].state, "frozen");

  // Answer the second row, in a DIFFERENT column order than the export wrote, to prove header names win.
  sheet.getRow(3).getCell(3).value = "Move to my brick";
  sheet.getRow(3).getCell(4).value = "b214-m1";
  sheet.getRow(3).getCell(5).value = "No";
  const rewritten = await loadExcelWorkbook((await workbook.xlsx.writeBuffer()) as ArrayBuffer);
  const parsed = parseGuardWorkbook(rewritten);

  assert.equal(parsed.length, 2);
  assert.deepEqual(
    { answer: parsed[0].rawAnswer, holdId: parsed[0].holdId, now: parsed[0].nowBrickId },
    { answer: "", holdId: 3480, now: "B100-1" },
    "an unanswered row reads back blank",
  );
  assert.deepEqual(
    { answer: parsed[1].rawAnswer, brick: parsed[1].moveToBrickId, holdId: parsed[1].holdId, lock: parsed[1].rawLock },
    { answer: "Move to my brick", brick: "B214-M1", holdId: 3542, lock: "No" },
    "the brick is upper-cased and the lock is read as typed",
  );

  const bricks = workbook.getWorksheet(GUARD_BRICKS_SHEET_NAME)!;
  assert.equal(bricks.rowCount, BRICKS.length + 1, "the Bricks sheet lists every active brick once");
}

function aSheetThatIsNotOursIsRefusedInWords() {
  const book = new ExcelJS.Workbook();
  book.addWorksheet("Other").getRow(1).getCell(1).value = "Name";
  assert.throws(() => parseGuardWorkbook(book), /not a held-changes sheet/i);
}

function planAcceptsTheThreeAnswersAndLeavesBlanksAlone() {
  const plan = planGuardAnswers({
    bricks: ACTIVE,
    live: liveMap(live(1), live(2), live(3), live(4)),
    rows: [
      answer(1, { rawAnswer: "Allow" }),
      answer(2, { rawAnswer: "keep as is", rawLock: "no" }),
      answer(3, { moveToBrickId: "B214-M1", rawAnswer: "Move to my brick" }),
      answer(4, { rawAnswer: "" }),
    ],
  });
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.skipped, 1, "a blank answer is skipped, not a problem");
  assert.deepEqual(plan.counts, { allow: 1, keep: 1, locking: 2, move: 1 });
  assert.equal(plan.rows.find((row) => row.holdId === 2)?.lock, false, "Lock = No is honoured");
  assert.equal(plan.rows.find((row) => row.holdId === 1)?.lock, true, "a blank lock means Yes");
  assert.match(plan.rows.find((row) => row.holdId === 3)!.to, /El Balyana · Sohag 2 · Upper Egypt/);
  assert.equal(plan.trackedValue, 300);
  assert.equal(plan.restatedValue, 30);
}

function planRefusesWhatItCannotCheck() {
  const plan = planGuardAnswers({
    bricks: ACTIVE,
    live: liveMap(live(1), live(2), live(3), live(4), live(5), live(6, { liveBrickId: "B300-2" })),
    rows: [
      answer(1, { rawAnswer: "maybe" }),
      answer(2, { moveToBrickId: "B999-9", rawAnswer: "Move to my brick" }),
      answer(3, { moveToBrickId: "B100-1", rawAnswer: "Move to my brick" }),
      answer(4, { moveToBrickId: "B214-M1", rawAnswer: "Keep as is" }),
      answer(5, { nowBrickId: "B300-2" }),
      answer(6, { rawLock: "perhaps" }),
      answer(77),
      answer(2, { moveToBrickId: "B214-M1", rawAnswer: "Move to my brick", sheetRow: 99 }),
      answer(5, { sheetRow: 100 }),
    ],
  });
  const reasonFor = (holdId: number | null) => plan.problems.filter((problem) => problem.holdId === holdId).map((problem) => problem.reason);

  assert.match(reasonFor(1)[0], /not an answer/);
  assert.match(reasonFor(2)[0], /not an active brick/);
  assert.match(reasonFor(3)[0], /already sits in/);
  assert.match(reasonFor(4)[0], /Move To Brick ID was typed/);
  assert.match(reasonFor(5)[0], /changed after this sheet was exported/);
  assert.match(reasonFor(6)[0], /not a lock answer/);
  assert.match(reasonFor(77)[0], /not waiting any more/);
  assert.ok(plan.problems.some((problem) => /appears twice/.test(problem.reason)), "a repeated hold is refused, not applied twice");
  assert.deepEqual(plan.rows, [], "nothing that failed a check reaches the ready list");
}

function aMappingAtFullConfidenceIsFlaggedWhenAnswerWouldOverrideIt() {
  const plan = planGuardAnswers({
    bricks: ACTIVE,
    live: liveMap(live(1, { ownerRuling: true }), live(2, { ownerRuling: true })),
    rows: [answer(1, { rawAnswer: "Allow" }), answer(2, { rawAnswer: "Keep as is" })],
  });
  assert.equal(plan.overridesRulings, 1, "Allow overrides a ruling; Keep as is does not");
  assert.equal(plan.rows.find((row) => row.holdId === 1)?.overridesRuling, true);
  assert.equal(plan.rows.find((row) => row.holdId === 2)?.overridesRuling, false);
}

function theDigestPinsExactlyWhatWasPreviewed() {
  const base = { answer: "move" as const, holdId: 1, lock: true, moveToBrickId: "B214-M1", nowBrickId: "B100-1" };
  const same = guardPageDigest([base]);
  assert.equal(same, guardPageDigest([{ ...base }]));
  assert.equal(guardPageDigest([base, { ...base, holdId: 2 }]), guardPageDigest([{ ...base, holdId: 2 }, base]), "order does not matter");
  for (const change of [{ answer: "allow" as const }, { lock: false }, { moveToBrickId: "B300-2" }, { nowBrickId: "B300-2" }, { holdId: 9 }]) {
    assert.notEqual(guardPageDigest([{ ...base, ...change }]), same, `changing ${Object.keys(change)[0]} changes the digest`);
  }
}

function pagesCarryAtMostTheRoutesCeilingAndEachHasItsOwnDigest() {
  const count = GUARD_APPLY_PAGE_SIZE * 2 + 5;
  const ids = Array.from({ length: count }, (_, index) => index + 1);
  const plan = planGuardAnswers({
    bricks: ACTIVE,
    live: liveMap(...ids.map((id) => live(id))),
    rows: ids.map((id) => answer(id)),
  });
  assert.equal(plan.pages.length, 3);
  assert.deepEqual(plan.pages.map((page) => page.holdIds.length), [GUARD_APPLY_PAGE_SIZE, GUARD_APPLY_PAGE_SIZE, 5]);
  for (const page of plan.pages) {
    const rows = plan.rows.filter((row) => page.holdIds.includes(row.holdId));
    assert.equal(page.digest, guardPageDigest(rows), "a page's digest is computed from its own rows");
  }
}

function theApplyRequestIsReadThroughTheSameInterpretationAsTheSheet() {
  const [row] = sheetRowsFromInstructions([{ answer: "move", holdId: 5, lock: false, moveToBrickId: " b214-m1 ", nowBrickId: "b100-1" }]);
  assert.equal(row.rawAnswer, GUARD_ANSWER_LABEL.move);
  assert.equal(row.moveToBrickId, "B214-M1");
  assert.equal(row.nowBrickId, "B100-1");
  assert.equal(row.rawLock, "No");
  const plan = planGuardAnswers({ bricks: ACTIVE, live: liveMap(live(5)), rows: [row] });
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.rows[0].lock, false);
  assert.equal(plan.pages[0].digest, guardPageDigest(plan.rows), "the apply request re-plans to the same digest the preview gave");
}

function everyWritePathIsTheGuardsOwnAndTheRoutesAreOwnerGated() {
  const sheet = stripComments(read("src/lib/sales/mapping-guard-sheet.ts"));
  const access = stripComments(read("src/lib/sales/mapping-guard-sheet-access.ts"));

  // Never a permit, never the bypass, never the inner decide function: the sheet presses the same
  // button the screen does, so the guard's own rules still apply to it.
  for (const forbidden of ["sos_map_guard_decide(", "sos_map_guard_permit", "map_guard_bypass", "service_role"]) {
    assert.ok(!sheet.includes(forbidden), `the sheet module must not mention ${forbidden}`);
  }
  assert.match(sheet, /decideMappingHold\(/);

  // A custom brick: approve the NEW hold first, refuse the ORIGINAL only afterwards, so a failure
  // midway leaves the original pending.
  const approveAt = sheet.indexOf('decision: "approved", holdId: created[0]');
  const refuseAt = sheet.indexOf('decision: "rejected", holdId: instruction.holdId');
  assert.ok(approveAt > 0 && refuseAt > approveAt, "the original hold is refused only after the move is released");
  assert.match(sheet, /\.eq\("brick_id", String\(entry\.map\.brick_id/, "the move only matches the row as it was planned");
  assert.match(sheet, /guardPageDigest\(plan\.rows\) !== input\.digest/, "a page must re-plan to the previewed digest");
  assert.match(sheet, /plan\.problems\.length > 0/, "a page with a problem is refused whole");

  assert.match(access, /access\.role !== "Super Admin"/);

  for (const [route, action] of [["export", "export"], ["preview", "import"], ["apply", "import"]] as const) {
    const source = stripComments(read(`app/api/sales/mapping-guard/sheet/${route}/route.ts`));
    assert.ok(source.includes(`assertPermission(access, "sales", "${action}")`), `${route} asks the ${action} permission`);
    assert.ok(source.includes("assertGuardSheetOwner(access)"), `${route} is owner-gated server-side`);
    assert.ok(source.includes("resolveAccessContext(request)"), `${route} resolves the session itself`);
    const firstUse = [".formData(", ".json()", "loadGuardSheetData(", "applyGuardPage(", "previewGuardSheet("]
      .map((needle) => source.indexOf(needle))
      .filter((at) => at >= 0);
    assert.ok(firstUse.length > 0, `${route} reads something to gate`);
    assert.ok(source.indexOf("assertPermission(") < Math.min(...firstUse), `${route} checks the owner before reading the request or the data`);
  }
  assert.match(stripComments(read("app/api/sales/mapping-guard/sheet/export/route.ts")), /export:sales:mapping-guard/);
  assert.match(stripComments(read("app/api/sales/mapping-guard/sheet/export/route.ts")), /no-store/);

  const preview = stripComments(read("app/api/sales/mapping-guard/sheet/preview/route.ts"));
  assert.ok(!/\.(insert|update|delete|rpc)\(/.test(preview), "the preview route writes nothing");
  const previewLib = stripComments(read("src/lib/sales/mapping-guard-sheet.ts"));
  const previewFn = previewLib.slice(previewLib.indexOf("export async function previewGuardSheet"), previewLib.indexOf("function cairoDate"));
  assert.ok(!/\.(insert|update|delete)\(|decideMappingHold/.test(previewFn), "previewGuardSheet writes nothing");

  const registry = read("src/lib/security/access-registry.ts");
  for (const route of ["export", "preview", "apply"]) {
    assert.ok(registry.includes(`pattern: "/api/sales/mapping-guard/sheet/${route}"`), `${route} is in the access registry`);
  }
}

function theClientPanelReachesOnlyClientSafeModules() {
  const panel = stripComments(read("src/components/sales/mapping-guard-sheet-panel.tsx"));
  assert.match(panel, /^"use client";/m);
  const imports = [...panel.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
  for (const target of imports) {
    assert.ok(
      target === "react" ||
        target.endsWith("mapping-guard-sheet-shape") ||
        target.endsWith("mapping-guard-hold-shape") ||
        target.endsWith("/form-tokens") ||
        target.endsWith("/mapping-guard"),
      `the panel may not import ${target}`,
    );
  }
  assert.ok(/import type \{ HeldMappingChange \}/.test(panel), "the one server module it names is a type import");
  assert.ok(!/ rounded|rounded-/.test(panel), "square edges: no radius in the panel");
  assert.ok(!/overflow-x-auto|min-w-\[/.test(panel), "no horizontal scroller in the panel");
  assert.ok(!panel.includes("…") && !/\.\.\.["'`<]/.test(panel), "no ellipsis in the copy");
}

function aRulingIsReadTheWayTheGuardReadsIt() {
  // The guard holds a change as "overwrites a mapping decision of yours" on the row's SOURCE, so the
  // sheet's Your Earlier Ruling column must say yes for the same rows — not only for a locked one.
  assert.equal(isOwnerRuling("owner-ruling-2026-10-10", 70), true, "an owner- source is his ruling at any confidence");
  assert.equal(isOwnerRuling("final-new-2026-09", null), true, "a final-new- source is his ruling");
  assert.equal(isOwnerRuling("sheet-verified", 0), true, "a verified-sheet row is his ruling");
  assert.equal(isOwnerRuling("distributor-upload", 100), true, "a lock stamps confidence 100");
  assert.equal(isOwnerRuling("distributor-upload", 80), false, "an ordinary upload row is not a ruling");
  assert.equal(isOwnerRuling(null, undefined), false);
  const sheet = stripComments(read("src/lib/sales/mapping-guard-sheet.ts"));
  assert.ok(sheet.includes("isOwnerRuling(map?.source, map?.confidence)"), "the server reads the ruling through the shared test");
}

export async function runMappingGuardSheetTests() {
  await theSheetRoundTripsAnswersByHeaderName();
  aSheetThatIsNotOursIsRefusedInWords();
  planAcceptsTheThreeAnswersAndLeavesBlanksAlone();
  planRefusesWhatItCannotCheck();
  aRulingIsReadTheWayTheGuardReadsIt();
  aMappingAtFullConfidenceIsFlaggedWhenAnswerWouldOverrideIt();
  theDigestPinsExactlyWhatWasPreviewed();
  pagesCarryAtMostTheRoutesCeilingAndEachHasItsOwnDigest();
  theApplyRequestIsReadThroughTheSameInterpretationAsTheSheet();
  everyWritePathIsTheGuardsOwnAndTheRoutesAreOwnerGated();
  theClientPanelReachesOnlyClientSafeModules();
}
