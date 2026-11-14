import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";

import { AR_MESSAGES } from "../src/components/offers/joining-form-copy.ts";
import { JOINING_FORM_STATE_MESSAGE, joiningFormState } from "../src/lib/offers/joining-form.ts";
import type { OfferVacancyOption } from "../src/lib/offers/types.ts";
import { classifyOfferVacancy } from "../src/lib/offers/vacancy-check.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * A FAILED SEAT READ IS NOT A FILLED SEAT (enterprise audit REC-034, 14 Nov 2026).
 *
 * The joining form, the hire draft and the Offers screen asked "is the seat on this offer still
 * open?" by looking it up in a list a failed read had emptied. So a database timeout:
 *  - refused the candidate with "Your position is being confirmed";
 *  - sent HR a high-priority "the seat on the offer is no longer open in the organogram" — false;
 *  - let a non-sales offer that named a seat go through WITHOUT it (hire unseated, vacancy left open);
 *  - showed every sent offer on the Offers screen as "no longer open".
 * Now the answer has three values — open, closed, unread — and unread is never read as closed.
 *
 * PURE: the rule and the form state are called directly; the wiring is read as source.
 */

const root = process.cwd();
const code = (relative: string) => stripComments(readFileSync(path.join(root, relative), "utf8"));
const flat = (relative: string) => code(relative).replace(/\s+/g, " ");

const seat = (vacancyId: number): OfferVacancyOption => ({
  areaId: 1,
  areaName: "Nasr City",
  departmentId: null,
  jobTitle: "Medical Representative",
  lineId: 1,
  lineName: "CNS",
  managerHrId: null,
  managerName: null,
  positionId: null,
  positionTitle: "Medical Representative",
  regionName: "Cairo",
  vacancyCode: `V-${vacancyId}`,
  vacancyId,
});

export function runOfferVacancyReadFailureTests() {
  // ── 1 · The rule: three answers, and a failed read is its own ──────────────────────────────
  assert.deepEqual(classifyOfferVacancy(null, { ok: false }), { status: "none" }, "an offer naming no seat has nothing to check");
  assert.deepEqual(classifyOfferVacancy(7, { ok: false }), { status: "unread" }, "a failed read is UNREAD — never closed");
  assert.deepEqual(classifyOfferVacancy(7, { ok: true, options: [] }), { status: "closed" }, "a seat missing from a list that WAS read is closed");
  const open = classifyOfferVacancy(7, { ok: true, options: [seat(3), seat(7)] });
  assert.equal(open.status, "open");
  assert.equal(open.status === "open" ? open.vacancy.vacancyId : null, 7, "the open seat comes back with it");

  // ── 2 · The reproduction: a failed read reaches the form as "try again", not "seat filled" ───
  const unread = classifyOfferVacancy(7, { ok: false });
  for (const requiresSeat of [true, false]) {
    const state = joiningFormState({
      employeeHrId: null,
      requiresSeat,
      revision: 0,
      seatOpen: false,
      seatUnread: unread.status === "unread",
      status: "sent",
    });
    assert.equal(
      state,
      "seat_unread",
      requiresSeat
        ? "a sales offer is not told its position is being confirmed because a read failed"
        : "a non-sales offer that names a seat does not go through without it because a read failed",
    );
  }
  // The real "seat filled" path is untouched.
  assert.equal(joiningFormState({ employeeHrId: null, requiresSeat: true, seatOpen: false, seatUnread: false, status: "sent" }), "seat_unavailable");
  assert.equal(joiningFormState({ employeeHrId: null, requiresSeat: true, seatOpen: true, status: "sent" }), "open");
  // Only a sent or accepted offer gets that far: a withdrawn one says withdrawn, whatever the read.
  assert.equal(joiningFormState({ employeeHrId: null, requiresSeat: true, seatOpen: false, seatUnread: true, status: "withdrawn" }), "withdrawn");

  const message = JOINING_FORM_STATE_MESSAGE.seat_unread;
  assert.match(message.body, /try again in a few minutes/, "he is asked to try again");
  assert.doesNotMatch(`${message.title} ${message.body}`, /being confirmed|no longer open|filled/i, "and never told the seat is in doubt");
  assert.ok(AR_MESSAGES[message.title] && AR_MESSAGES[message.body], "the message has its Arabic");

  // ── 3 · The reads: the throwing one exists, and the offer side never turns a fault into [] ───
  const closer = flat("src/lib/employees/vacancy-closer.ts");
  assert.match(closer, /export async function getOpenWorkforceVacanciesOrThrow\(\): Promise<VacancyLookupRow\[\]> \{ return loadOpenVacancyRows\(\); \}/, "the strict read calls the loader directly, past the cached swallow");
  const loader = closer.slice(closer.indexOf("async function loadOpenVacancyRows"), closer.indexOf("const getOpenVacancies = cache("));
  assert.ok(loader.length > 500, "the loader is found");
  assert.doesNotMatch(loader, /return \[\];/, "the loader never answers a failed read with an empty list");

  const vacancies = flat("src/lib/offers/vacancies.ts");
  assert.match(vacancies, /return \{ ok: true, options: await loadOfferVacancyOptionsStrict\(\) \};/, "a good read carries its seats");
  assert.match(vacancies, /labels: \{ event: "offer_vacancy_read_failed" \}, \}\); return \{ ok: false \};/, "a failed read is logged and says it failed");
  assert.match(vacancies, /return classifyOfferVacancy\(vacancyId, await readOfferVacancies\(\)\);/, "the seat check goes through the one rule");
  assert.match(vacancies, /const rows = await getOpenWorkforceVacanciesOrThrow\(\);/, "the offer reads the strict list");
  assert.doesNotMatch(vacancies, /findOpenOfferVacancy/, "the lookup that collapsed unread into closed is gone");

  // ── 4 · Every caller asks the three-way check ────────────────────────────────────────────────
  const service = flat("src/lib/offers/joining-form-service.ts");
  assert.match(service, /seatUnread: seatCheck\?\.status === "unread",/, "the joining form passes a failed read on as unread");
  assert.match(service, /const vacancy = seatCheck\?\.status === "open" \? seatCheck\.vacancy : null;/);
  assert.match(
    service,
    /if \(state === "seat_unavailable"\) \{ await announceJoiningFormBlocked\(offer, "the seat on the offer is no longer open in the organogram\."\); \}/,
    "HR is told the seat is gone only when it is gone",
  );
  assert.doesNotMatch(service, /seat_unread"\) \{ await announceJoiningFormBlocked/, "a failed read alerts nobody");

  const route = flat("app/api/offers/[id]/hire-draft/route.ts");
  assert.match(route, /const seatCheck = await checkOfferVacancy\(offer\.vacancyId\);/);
  assert.match(route, /const seatTaken = seatCheck\.status === "closed";/, "the hire draft says 'filled by somebody else' only for a closed seat");
  assert.match(route, /const seatUnread = seatCheck\.status === "unread";/);
  assert.match(route, /seatTaken, seatUnread, success: true,/);
  const addEmployee = flat("src/components/employees/employee-management.tsx");
  assert.match(addEmployee, /: payload\.seatUnread \? "The open seats could not be checked just now/, "Add Employee says the seats could not be checked");

  const workspace = flat("src/lib/offers/workspace.ts");
  assert.match(workspace, /const vacanciesUnread = !vacancyRead\.ok;/, "the Offers screen learns the seats were not read");
  const composer = flat("src/components/offers/offer-composer.tsx");
  assert.match(composer, /vacanciesUnread \? "could not be checked just now" : offer\.status === "sent"/, "a sent offer is not called 'no longer open' over a failed read");
  assert.equal(composer.split("<OfferSeat offer={offer} vacancies={vacancies} vacanciesUnread={vacanciesUnread} />").length - 1, 2, "on the desktop row AND the phone card");
  for (const page of ["app/(admin)/offers/page.tsx", "app/employee-portals/offers/page.tsx"]) {
    assert.match(code(page), /vacanciesUnread=\{workspace\.vacanciesUnread\}/, `${page} passes it on`);
  }
}
