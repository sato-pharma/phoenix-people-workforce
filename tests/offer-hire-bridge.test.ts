import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildOfferHireDraft,
  offerHireDate,
  readOfferVacancyId,
} from "../src/lib/offers/hire-draft.ts";
import { formatOfferVacancyLabel } from "../src/lib/offers/vacancy-label.ts";
import type { OfferVacancyOption } from "../src/lib/offers/types.ts";

/**
 * From an ACCEPTED offer, to the vacant seat, into Add Employee (owner, 2026-09-29).
 *
 * Until this, pressing Accepted wrote one word on one row and stopped there. The name, the job
 * title, the agreed package and the first working day were read off the Offers screen and retyped
 * into the hire form standing next to it, and then the right open seat was hunted by hand among 44
 * — 42 of which are Medical Representative, telling each other apart only by line and area.
 *
 * These assertions pin the chain and, as much, the four things it must NOT do: guess a seat, guess
 * a work email, derive any money, or learn that a candidate record exists.
 */
export function runOfferHireBridgeTests() {
  const seat: OfferVacancyOption = {
    areaId: 1089,
    areaName: "Alex East",
    departmentId: 1,
    jobTitle: "Medical Representative",
    lineId: 2,
    lineName: "Pedia",
    managerHrId: "PD-0012",
    managerName: "Mohamed Alaa Eleiwa Abozaid",
    positionId: 2,
    positionTitle: "Medical Representative",
    regionName: "Alex-BHR",
    vacancyCode: "VAC-B82-E3Z",
    vacancyId: 351,
  };

  const offer = {
    candidateName: "Abdallah Saad",
    // The LETTER's form, which is what the column actually holds — every one of the 28 offers on
    // production reads like this, not like an ISO date.
    startDate: "01 October 2026",
    title: "Medical Representative",
    totalMonthly: 18000,
  };

  // ── 1 · The start date comes back out of the letter's own wording ───────────────────────────
  //
  // `offers.start_date` stores "01 October 2026" because that is what the letter prints. An
  // `<input type="date">` will not take it, so a draft that handed it over raw would arrive blank
  // and nobody would know why.
  assert.equal(offerHireDate("01 October 2026"), "2026-10-01", "the letter's English date becomes ISO");
  assert.equal(offerHireDate("1 october 2026"), "2026-10-01", "a bare day and any casing still read");
  assert.equal(offerHireDate("2026-10-01"), "2026-10-01", "an ISO value from the free-text era passes through");
  assert.equal(offerHireDate(""), "", "no date is no date");
  assert.equal(
    offerHireDate("next Sunday"),
    "",
    "anything unreadable is BLANK, never a guess — a candidate turning up on the wrong day is the failure this refuses",
  );

  // ── 2 · With a seat, the whole hire is filled in ────────────────────────────────────────────
  const withSeat = buildOfferHireDraft({ offer, vacancy: seat });
  assert.equal(withSeat.fullName, "Abdallah Saad");
  assert.equal(withSeat.hireDate, "2026-10-01");
  // The NET, corrected 2026-09-29 — this pinned `grossSalary` for half a day and that was wrong.
  // The letter's total monthly package is take-home; the Employee Master derives gross ABOVE it.
  // `tests/offer-out-on-seats.test.ts` checks the derivation against five real hires.
  assert.equal(withSeat.netSalary, "18000", "the agreed package is carried across exactly as typed");
  assert.equal(withSeat.lineId, "2", "the seat's line");
  assert.equal(withSeat.areaId, "1089", "the seat's area");
  assert.equal(withSeat.departmentId, "1", "the seat's department — this is what keeps the vacancy closer department-safe");
  assert.equal(withSeat.positionId, "2", "the seat's position");
  assert.equal(withSeat.managerHrId, "PD-0012", "the seat's manager, by HR id and not by name");
  assert.equal(withSeat.regionName, "Alex-BHR", "the seat's region");

  // ── 3 · Without a seat, every seat field is EMPTY and nothing is inferred ───────────────────
  //
  // This is the case that matters most. The offer's `territory` is free text — production holds
  // "Qena" where the organogram holds "Qena 1" and "Qena 2" — and `reportsTo` is a ROLE, not a
  // person: all 28 rows read "District Sales Manager". Matching on either would silently pick one
  // of three lines' Medical Representative seats in the same area, and the hire would close the
  // wrong vacancy with no error anywhere.
  const withoutSeat = buildOfferHireDraft({ offer, vacancy: null });
  assert.equal(withoutSeat.fullName, "Abdallah Saad", "the person is still carried");
  assert.equal(withoutSeat.hireDate, "2026-10-01", "so are the terms");
  assert.equal(withoutSeat.netSalary, "18000");
  for (const key of ["areaId", "departmentId", "lineId", "managerHrId", "positionId", "regionName"] as const) {
    assert.equal(withoutSeat[key], "", `${key} must be blank when no seat is known — the form's own picker decides it`);
  }

  // ── 4 · The seat's own position title wins over the letter's wording ────────────────────────
  assert.equal(
    buildOfferHireDraft({
      offer: { ...offer, title: "Medical Rep (Alex)" },
      vacancy: seat,
    }).jobTitle,
    "Medical Representative",
    "the organogram's words go on the employee record; the letter's words were written for a candidate to read",
  );
  assert.equal(
    buildOfferHireDraft({ offer: { ...offer, title: "Product Manager" }, vacancy: null }).jobTitle,
    "Product Manager",
    "with no seat, the letter's title is all there is",
  );

  // ── 5 · NO work email, and NO derived money ────────────────────────────────────────────────
  //
  // Both are absences, so both have to be asserted as absences or nothing would catch them coming
  // back. `work_email` is a COMPANY address and is UNIQUE; the address on an offer is the personal
  // one the letter was sent to. And every salary derivation in this system belongs to
  // src/lib/payroll/policy.ts (owner-locked) or to src/lib/offers/pay.ts, which documents at
  // length why those two must not be bound together — a third opinion here is the one thing this
  // bridge must never become.
  const keys = Object.keys(withSeat).sort();
  assert.deepEqual(
    keys,
    [
      "areaId",
      "departmentId",
      "fullName",
      "hireDate",
      "jobTitle",
      "lineId",
      "managerHrId",
      "netSalary",
      "positionId",
      "regionName",
    ],
    "the draft carries exactly these fields — the NET and nothing else of the money; no workEmail, no basic, no base, no gross, no contract type",
  );

  assert.equal(
    buildOfferHireDraft({ offer: { ...offer, totalMonthly: 0 }, vacancy: seat }).netSalary,
    "",
    "a zero package is no package — a 0 in the salary box would look like a real answer",
  );

  // ── 6 · A seat id off the wire ─────────────────────────────────────────────────────────────
  assert.equal(readOfferVacancyId(351), 351);
  assert.equal(readOfferVacancyId("351"), 351, "a select sends text");
  assert.equal(readOfferVacancyId(""), null, "empty is 'no seat chosen', which is a real answer");
  assert.equal(readOfferVacancyId(null), null);
  assert.equal(readOfferVacancyId(undefined), null);
  assert.equal(readOfferVacancyId(0), null, "0 is not a vacancy id — it would read as a seat that does not exist");
  assert.equal(readOfferVacancyId(-4), null);
  assert.equal(readOfferVacancyId("not a number"), null, "unreadable collapses to null, never throws — a letter must still be writable");

  // ── 7 · How a seat reads ───────────────────────────────────────────────────────────────────
  assert.equal(
    formatOfferVacancyLabel(seat),
    "Pedia · Medical Representative · Alex East (Alex-BHR) · Manager: Mohamed Alaa Eleiwa Abozaid",
    "the LINE is named first: 42 of the 44 open seats are Medical Representative across three lines",
  );
  assert.equal(
    formatOfferVacancyLabel({ ...seat, managerName: null }),
    "Pedia · Medical Representative · Alex East (Alex-BHR)",
    "a seat with no manager does not trail an empty 'Manager:'",
  );
  assert.equal(
    formatOfferVacancyLabel({ ...seat, areaName: "Cairo", regionName: "Cairo", managerName: null }),
    "Pedia · Medical Representative · Cairo",
    "a single-area district never prints its own name twice",
  );

  // ── 8 · The route hires only against an ACCEPTED offer ─────────────────────────────────────
  //
  // Source-asserted because the handler is env-bound. A draft has not been asked, a sent one has
  // not been answered, a declined one was refused and a withdrawn one was taken back: hiring
  // against any of them is hiring somebody who never said yes.
  const route = readFileSync("app/api/offers/[id]/hire-draft/route.ts", "utf8");
  assert.match(route, /offer\.status !== "accepted"/, "the route refuses anything but an accepted offer");
  assert.match(route, /status: 409/, "and refuses it as a conflict, not as a 404 that reads like a missing offer");
  assert.match(
    route,
    /const seatCheck = await checkOfferVacancy\(offer\.vacancyId\);[\s\S]*const vacancy = seatCheck\.status === "open" \? seatCheck\.vacancy : null;/,
    "the seat is re-read LIVE and only when still open — a seat filled while the letter was out must never be pre-selected",
  );
  assert.match(route, /assertPermission\(access, "offers", "read"\)/, "gated, like every other route under /api/offers");

  // ── 9 · The button exists, only on an accepted offer, on BOTH surfaces ──────────────────────
  //
  // Counted rather than merely matched: the desktop table and the phone card are two renderings of
  // the same decision, and this module has already shipped a control that existed in one of them
  // and not the other.
  const composer = readFileSync("src/components/offers/offer-composer.tsx", "utf8");
  const addEmployeeGates = composer.match(/canManage && offer\.status === "accepted"/g) ?? [];
  assert.equal(
    addEmployeeGates.length,
    2,
    "Add employee is gated on an accepted offer in BOTH the desktop row and the phone card",
  );
  assert.equal(
    (composer.match(/\?fromOffer=\$\{encodeURIComponent\(offer\.id\)\}/g) ?? []).length,
    2,
    "and both carry the offer id to the employees screen",
  );

  // ── 10 · Withdraw, beside Accepted and Declined ────────────────────────────────────────────
  //
  // Lives in this file rather than one of its own because it is the same row of controls and the
  // same hole: "withdrawn" has been a valid status and an accepted PATCH value since the module
  // shipped, and NOTHING ever sent it — so Abdallah Saad's SP-HR-MR-2026-025 was withdrawn by a
  // hand-written row on production on 2026-09-29, as were the five withdrawn offers before it.
  //
  // Counted on both surfaces, like Add employee above: the desktop table and the phone card are two
  // renderings of one decision, and this module has already shipped a control that reached one of
  // them and not the other.
  assert.equal(
    (composer.match(/withdrawOffer\(offer\)/g) ?? []).length,
    2,
    "Withdraw is on the desktop row AND the phone card",
  );
  assert.match(
    composer,
    /async function withdrawOffer[\s\S]{0,600}window\.confirm\(/,
    "it asks first — a withdrawn offer cannot be answered, cannot be resent, and cannot go back to draft",
  );
  assert.match(
    composer,
    /withdrawOffer[\s\S]{0,900}PATCH", \{ status: "withdrawn" \}/,
    "and it goes through the same PATCH the other answers use, not a second write path",
  );
  // The gate: it belongs to a SENT offer only. Both Withdraw buttons sit inside the same
  // `status === "sent"` block that already holds Accepted, Declined and Resend, so counting that
  // block is what proves it cannot appear on a draft or on an offer already answered.
  assert.equal(
    (composer.match(/canManage && offer\.status === "sent"/g) ?? []).length,
    2,
    "the sent-only gate is stated once per surface and holds every control inside it",
  );

  // ── 11 · The seat never reaches the letter ─────────────────────────────────────────────────
  //
  // `OfferFields` is what fills the template's {{tokens}} and what is frozen into the snapshot at
  // send time. A seat id prints on no letter and must not be in there — if it were, it would be
  // baked into every PDF and into the resend path's frozen copy.
  const types = readFileSync("src/lib/offers/types.ts", "utf8");
  const fieldsBlock = types.slice(types.indexOf("export type OfferFields = {"), types.indexOf("export type OfferRecord"));
  assert.ok(!/vacancyId/.test(fieldsBlock), "vacancyId belongs to the RECORD, never to the letter's fields");
  assert.match(types, /vacancyId: number \| null;/, "the record carries it");
}
