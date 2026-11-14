import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  AREA_PICKER_EMPTY_VALUE,
  blankedStoredAreaRefusal,
  storedAreaOptionLabel,
  withStoredAreaOption,
} from "../src/lib/employees/stored-area-guard.ts";

// A District Sales Manager hired on 1 November 2026 had his area emptied by an edit of his own
// record on 3 November, and nothing recorded it. The form could not show the area he held (his
// seat was filled, and the Operating Area list offers open vacancies only), could not give it back
// once Job Position or Business Line had cleared it, and the save wrote the blank as NULL.
//
// Two halves, both pinned here: the save refuses to empty the area of someone who holds a seat,
// and the form offers the area already on the record.

const NO_OPEN_VACANCY = [
  { label: "No open vacancy for this position and line", value: AREA_PICKER_EMPTY_VALUE },
];

const ALEX_BHR = { areaId: 23, areaName: "Alex-BHR", lineId: 1 };

export async function runEmployeeStoredAreaGuardTests() {
  // ── The save ────────────────────────────────────────────────────────────────────────────────
  const seatedSave = {
    employeeName: "Mohamed Saad",
    holdsSeat: true as boolean | null,
    incomingAreaId: null as number | null,
    storedAreaId: 23 as number | null,
    storedAreaName: "Alex-BHR" as string | null,
  };

  const refusal = blankedStoredAreaRefusal(seatedSave);
  assert.ok(
    refusal,
    "the headline assertion: emptying the area of someone who holds a seat must be refused",
  );
  assert.ok(
    refusal.includes("required"),
    "the refusal must say 'required' — that word is what makes the employees route answer 400 with the message",
  );
  assert.ok(
    refusal.includes("Mohamed Saad") && refusal.includes("Alex-BHR"),
    "the refusal names the person and the area by NAME, so HR knows what to choose",
  );
  assert.ok(!/\b23\b/.test(refusal), "and never by id");

  const unreadSeat = blankedStoredAreaRefusal({ ...seatedSave, holdsSeat: null });
  assert.ok(
    unreadSeat && unreadSeat.includes("required"),
    "a seat model that could not be read is never 'holds no seat' — the save is still refused",
  );
  assert.notEqual(unreadSeat, refusal, "and it says so, instead of claiming a seat it did not read");

  assert.equal(
    blankedStoredAreaRefusal({ ...seatedSave, holdsSeat: false }),
    null,
    "someone with no seat (head office) may have a carried area cleared",
  );
  assert.equal(
    blankedStoredAreaRefusal({ ...seatedSave, incomingAreaId: 23 }),
    null,
    "a save that carries the same area is not this rule's business",
  );
  assert.equal(
    blankedStoredAreaRefusal({ ...seatedSave, incomingAreaId: 24 }),
    null,
    "nor is a save that changes one area for another",
  );
  assert.equal(
    blankedStoredAreaRefusal({ ...seatedSave, storedAreaId: null }),
    null,
    "a record that holds no area has nothing to empty",
  );

  const nameless = blankedStoredAreaRefusal({ ...seatedSave, employeeName: " ", storedAreaName: null });
  assert.ok(
    nameless && nameless.includes("required") && !nameless.includes("null") && !nameless.includes("undefined"),
    "a lost name costs the message a word, never the refusal, and never prints 'null'",
  );

  // ── The form ────────────────────────────────────────────────────────────────────────────────
  assert.deepEqual(
    withStoredAreaOption(NO_OPEN_VACANCY, ALEX_BHR, "1"),
    [{ label: storedAreaOptionLabel("Alex-BHR"), value: "23" }],
    "the headline assertion: with no open vacancy, the area on the record is offered and the 'nothing to choose' row is gone",
  );
  assert.ok(
    storedAreaOptionLabel("Alex-BHR").startsWith("Alex-BHR"),
    "the offered row leads with the area's name",
  );

  const openSeats = [
    { label: "Behira 1", value: "31" },
    { label: "Behira 2", value: "32" },
  ];
  assert.deepEqual(
    withStoredAreaOption(openSeats, ALEX_BHR, "1").map((option) => option.value),
    ["23", "31", "32"],
    "beside open vacancies, the area on the record comes first and every vacancy stays",
  );
  assert.deepEqual(
    withStoredAreaOption([{ label: "Alex-BHR · open seat", value: "23" }, ...openSeats], ALEX_BHR, "1"),
    [{ label: "Alex-BHR · open seat", value: "23" }, ...openSeats],
    "an open vacancy that already names the same area is left alone — the area is never offered twice",
  );
  assert.deepEqual(
    withStoredAreaOption(openSeats, ALEX_BHR, "2"),
    openSeats,
    "on a DIFFERENT business line the stored area is not offered — that is a move to another seat",
  );
  assert.deepEqual(
    withStoredAreaOption(NO_OPEN_VACANCY, ALEX_BHR, ""),
    [{ label: storedAreaOptionLabel("Alex-BHR"), value: "23" }],
    "with no line chosen yet the stored area is still offered",
  );
  for (const nothingStored of [null, undefined, { areaId: null, areaName: null, lineId: 1 }, { areaId: "", areaName: "", lineId: 1 }]) {
    assert.deepEqual(
      withStoredAreaOption(NO_OPEN_VACANCY, nothingStored, "1"),
      NO_OPEN_VACANCY,
      "a new record, or one with no area, changes nothing",
    );
  }
  const source = [...openSeats];
  withStoredAreaOption(source, ALEX_BHR, "1").length = 0;
  assert.equal(source.length, 2, "the options list is a copy, never the caller's array");

  // ── Both are wired where the defect was ─────────────────────────────────────────────────────
  const root = process.cwd();
  const directorySource = fs.readFileSync(path.join(root, "src/lib/employees/employee-directory.ts"), "utf8");
  const upsertStart = directorySource.indexOf("export async function upsertEmployee(");
  assert.ok(upsertStart > -1, "upsertEmployee must exist");
  const upsertBody = directorySource.slice(upsertStart, upsertStart + 6000);
  const guardAt = upsertBody.indexOf("await assertStoredAreaIsNotBlanked(");
  const writeAt = upsertBody.indexOf("on_conflict");
  assert.ok(guardAt > -1, "upsertEmployee must run the stored-area guard");
  assert.ok(writeAt > -1, "upsertEmployee's write must still be the merge-duplicates POST this test anchors on");
  assert.ok(guardAt < writeAt, "the guard must run BEFORE the write, or the refusal comes after the damage");
  assert.ok(
    /select=hr_id,manager_hr_id,hire_date,area_id/.test(upsertBody),
    "the update's own read of the record must carry area_id — the guard compares against it",
  );
  assert.ok(
    directorySource.includes("blankedStoredAreaRefusal({"),
    "the save must decide through blankedStoredAreaRefusal, not a rule of its own",
  );
  const seatReadStart = directorySource.indexOf("async function readHoldsOrganogramSeat(");
  assert.ok(seatReadStart > -1, "the seat read must exist");
  const seatRead = directorySource.slice(seatReadStart, seatReadStart + 900);
  assert.ok(
    /catch\s*\{\s*return null;\s*\}/.test(seatRead),
    "a failed seat read must come back as null (unknown), never as false (no seat)",
  );
  assert.ok(
    !directorySource.includes("FILTERED OUT rather than nulled"),
    "the comment that said an unsent field is kept must stay corrected — an unsent area is written NULL",
  );

  const formSource = fs.readFileSync(
    path.join(root, "src/components/employees/employee-management.tsx"),
    "utf8",
  );
  assert.ok(
    formSource.includes("withStoredAreaOption(vacancyOptions, storedAreaOnRecord, form.lineId)"),
    "the Operating Area list must pass its vacancy options through withStoredAreaOption",
  );
  assert.ok(
    formSource.includes("options={operatingAreaPickerOptions}"),
    "and the picker must render that list, not one built inline",
  );
}
