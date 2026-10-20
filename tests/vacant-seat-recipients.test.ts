// The HR Generalist seat is empty, and its notices go to the owner until the hire (owner, 2026-10-20).
//
// That day the HR employee who held "HR Operations" moved to a seat of her own ("HR Administration",
// shown as HR Operations Specialist), and "HR Operations" — shown as HR Generalist — was left open
// for a future hire. Asked where its notices go meanwhile, the owner answered for every one of them:
// to him, and for the probation milestones, "To you only". Four ways this goes wrong, each pinned
// here with a fake account reader, so no test touches a database:
//
//  1. AN OUTAGE READ AS A VACANCY. A seat whose accounts could not be read must keep exactly the
//     audience it had. Treating the failure as "empty" would hand the owner another seat's mail on
//     every transient error, and make an outage look like a vacancy.
//  2. TWO COPIES. An audience that already names the Super Admin needs no stand-in and no read, and
//     one human with several accounts (B-10 and the console login PHX-1) is one recipient.
//  3. A STRANDED NOTICE. The vacation "informed" notice and the business-card request named one
//     person by HR id; a named recipient is stranded the day that person leaves the chair, so both
//     now address the seat.
//  4. A RE-SENT MILESTONE. The probation dedup key ends in the HR id the milestones were first
//     addressed to, and the notification layer dedupes deliveries PER RECIPIENT, so changing who
//     receives them would have re-sent every milestone due that day unless the sweep skips a key an
//     earlier recipient already holds.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { PhoenixRole } from "../src/lib/auth/permissions.ts";
import { businessCardRequestRecipients } from "../src/lib/business-cards/request-service.ts";
import {
  applyVacantSeatStandIns,
  HR_GENERALIST_SEAT,
  onePerPerson,
  resolveSeatOrStandInHrIds,
  seatsNeedingAHolderCheck,
  VACANT_SEAT_STAND_INS,
  withVacantSeatStandIns,
  type RoleHolderReader,
  type SeatState,
} from "../src/lib/notifications/vacant-seat.ts";
import {
  milestoneKeysToSend,
  PROBATION_MILESTONE_KEY_SUFFIX,
  PROBATION_MILESTONE_TO_HR_ID,
  probationMilestoneEventKey,
} from "../src/lib/probation/intelligence/milestone-emails.ts";
import { stripComments } from "./support/comment-strip.ts";

// Literal types, so `{ [GENERALIST]: [] }` below is a named property rather than an index signature.
const GENERALIST = "HR Operations" as const satisfies PhoenixRole;
const SUPER_ADMIN = "Super Admin" as const satisfies PhoenixRole;
const SFE = "SFE Manager" as const satisfies PhoenixRole;

/** A reader over a fixed seating plan that records every role it was asked about. */
function fakeReader(seating: Partial<Record<PhoenixRole, string[] | Error>>) {
  const asked: PhoenixRole[] = [];
  const read: RoleHolderReader = async (role) => {
    asked.push(role);
    const holders = seating[role];
    if (holders instanceof Error) throw holders;
    return holders ?? [];
  };
  return { read, asked };
}

function assertTheStandInMap() {
  assert.equal(HR_GENERALIST_SEAT, "HR Operations", "the HR Generalist seat keeps its role key: the title is display only");
  assert.deepEqual(
    { ...VACANT_SEAT_STAND_INS },
    { "HR Operations": "Super Admin" },
    "exactly one seat stands empty today, and its notices go to the Super Admin until the hire",
  );
}

function assertWhichSeatsNeedARead() {
  assert.deepEqual(seatsNeedingAHolderCheck([SFE, GENERALIST]), [GENERALIST], "a listed open seat is read");
  assert.deepEqual(
    seatsNeedingAHolderCheck([SUPER_ADMIN, GENERALIST]),
    [],
    "an audience already naming the Super Admin needs no read: the stand-in would only be a second copy",
  );
  assert.deepEqual(seatsNeedingAHolderCheck([SFE, SUPER_ADMIN]), [], "an audience with no open seat needs no read");
  assert.deepEqual(seatsNeedingAHolderCheck([]), [], "an empty audience needs no read");
}

function assertTheStandInIsAddedOnlyForAVacancy() {
  const roles = [SFE, GENERALIST];
  const states = (state: SeatState) => new Map<PhoenixRole, SeatState>([[GENERALIST, state]]);
  assert.deepEqual(applyVacantSeatStandIns(roles, states("vacant")), [SFE, GENERALIST, SUPER_ADMIN], "a vacant seat brings its stand-in in, after the listed roles");
  assert.deepEqual(applyVacantSeatStandIns(roles, states("held")), roles, "a held seat changes nothing");
  assert.deepEqual(
    applyVacantSeatStandIns(roles, states("unreadable")),
    roles,
    "an unreadable seat changes nothing: a failed read is never an empty seat",
  );
  assert.deepEqual(applyVacantSeatStandIns(roles, new Map()), roles, "a seat that was not read changes nothing");
  assert.deepEqual(
    applyVacantSeatStandIns([GENERALIST, SUPER_ADMIN], states("vacant")),
    [GENERALIST, SUPER_ADMIN],
    "a stand-in already on the list is never added a second time",
  );
}

async function assertTheRoleAudienceWrapper() {
  {
    const reader = fakeReader({ [GENERALIST]: [] });
    const warnings: string[] = [];
    const roles = await withVacantSeatStandIns([SFE, GENERALIST], "test", warnings, reader.read);
    assert.deepEqual(roles, [SFE, GENERALIST, SUPER_ADMIN], "nobody in the HR Generalist seat: the Super Admin receives its copy");
    assert.deepEqual(reader.asked, [GENERALIST], "only the open seat is read");
    assert.deepEqual(warnings, [], "an empty seat is a known state, not a warning");
  }
  {
    const reader = fakeReader({ [GENERALIST]: ["HR-020"] });
    const roles = await withVacantSeatStandIns([SFE, GENERALIST], "test", [], reader.read);
    assert.deepEqual(roles, [SFE, GENERALIST], "once somebody is seated the stand-in drops out, with nothing to undo");
  }
  {
    const reader = fakeReader({ [GENERALIST]: new Error("statement timeout") });
    const warnings: string[] = [];
    const roles = await withVacantSeatStandIns([SFE, GENERALIST], "Notification test", warnings, reader.read);
    assert.deepEqual(roles, [SFE, GENERALIST], "a failed read keeps today's audience and adds nobody");
    assert.equal(warnings.length, 1, "a failed read leaves exactly one warning for the caller");
    assert.match(warnings[0]!, /could not be read, so no stand-in was added/, "the warning says what was not done");
  }
  {
    const reader = fakeReader({ [GENERALIST]: new Error("network") });
    const roles = await withVacantSeatStandIns([GENERALIST], "test", undefined, reader.read);
    assert.deepEqual(roles, [GENERALIST], "a caller keeping no warnings list still gets an answer, never a throw");
  }
  {
    const reader = fakeReader({ [GENERALIST]: [] });
    const roles = await withVacantSeatStandIns([SUPER_ADMIN, GENERALIST], "test", [], reader.read);
    assert.deepEqual(roles, [SUPER_ADMIN, GENERALIST], "the Super Admin already listed is not listed twice");
    assert.deepEqual(reader.asked, [], "and no account read is spent finding that out");
  }
}

async function assertTheDirectSeatResolver() {
  {
    const reader = fakeReader({ [GENERALIST]: ["HR-020"], [SUPER_ADMIN]: ["B-10"] });
    const seat = await resolveSeatOrStandInHrIds(GENERALIST, "test", reader.read);
    assert.deepEqual(seat.hrIds, ["HR-020"], "a held seat answers with its holder");
    assert.equal(seat.standIn, null);
    assert.equal(seat.unreadable, false);
    assert.deepEqual(reader.asked, [GENERALIST], "the stand-in is never read while the seat is held");
  }
  {
    const reader = fakeReader({ [GENERALIST]: [], [SUPER_ADMIN]: ["B-10", "PHX-1", "admin-HR"] });
    const seat = await resolveSeatOrStandInHrIds(GENERALIST, "test", reader.read);
    assert.deepEqual(seat.hrIds, ["B-10"], "an empty seat answers with the Super Admin, one person however many accounts");
    assert.equal(seat.standIn, SUPER_ADMIN);
    assert.equal(seat.unreadable, false);
  }
  {
    const reader = fakeReader({ [GENERALIST]: new Error("timeout"), [SUPER_ADMIN]: ["B-10"] });
    const seat = await resolveSeatOrStandInHrIds(GENERALIST, "test", reader.read);
    assert.deepEqual(seat.hrIds, [], "an unreadable seat resolves nobody rather than guessing");
    assert.equal(seat.unreadable, true);
    assert.equal(seat.standIn, null);
    assert.equal(seat.warnings.length, 1, "and says so");
    assert.deepEqual(reader.asked, [GENERALIST], "an outage never falls through to the stand-in");
  }
  {
    const reader = fakeReader({ [GENERALIST]: [], [SUPER_ADMIN]: new Error("timeout") });
    const seat = await resolveSeatOrStandInHrIds(GENERALIST, "test", reader.read);
    assert.deepEqual(seat.hrIds, [], "an empty seat whose stand-in could not be read resolves nobody");
    assert.equal(seat.unreadable, true);
    assert.equal(seat.standIn, SUPER_ADMIN, "the stand-in that failed is named");
  }
  {
    const reader = fakeReader({ [SFE]: [] });
    const seat = await resolveSeatOrStandInHrIds(SFE, "test", reader.read);
    assert.deepEqual(seat.hrIds, [], "a seat with no stand-in that nobody holds resolves nobody");
    assert.equal(seat.standIn, null);
    assert.equal(seat.unreadable, false, "and that is a fact, not a failure");
  }
}

function assertOnePerPerson() {
  assert.deepEqual(
    onePerPerson(["PHX-1", "B-10", "b-10", "admin-HR", null, "", "HR-020", "hr-020"]),
    ["B-10", "HR-020"],
    "the console login PHX-1 (admin-HR) is B-10, spelling is ignored, and blanks are dropped",
  );
}

function assertProbationGoesToTheOwnerAloneWithoutResending() {
  assert.equal(PROBATION_MILESTONE_TO_HR_ID, "B-10", "the Day 30/60/75 emails go To the owner alone");
  assert.equal(PROBATION_MILESTONE_KEY_SUFFIX, "HR-009", "the key's last segment is frozen: changing it would re-send every milestone due");
  assert.equal(
    probationMilestoneEventKey("c1", 30),
    "probation:milestone:c1:day30:HR-009",
    "the event key is the same string it has been since 2026-09-29",
  );

  const due = ["k-earlier", "k-own", "k-new", "k-unknown"];
  const toSend = milestoneKeysToSend(
    due,
    [
      { event_key: "k-earlier", employee_hr_id: "HR-009" },
      { event_key: "k-own", employee_hr_id: "b-10" },
      { event_key: "k-unknown", employee_hr_id: null },
    ],
    PROBATION_MILESTONE_TO_HR_ID,
  );
  assert.ok(!toSend.has("k-earlier"), "a milestone the earlier recipient already received is not sent again");
  assert.ok(toSend.has("k-own"), "a milestone already addressed to the owner is handed over: the layer's own claim makes it a no-op once sent");
  assert.ok(toSend.has("k-new"), "a milestone never sent is sent");
  assert.ok(!toSend.has("k-unknown"), "a row of unknown recipient counts as sent: the safe direction is one missed email, never a second one");
  assert.equal(toSend.size, 2);
}

function assertBusinessCardRecipients() {
  assert.deepEqual(businessCardRequestRecipients(["B-10"], "X-1"), ["B-10"], "while the seat is empty its stand-in is the owner, told once");
  assert.deepEqual(businessCardRequestRecipients(["PHX-1"], "X-1"), ["B-10"], "the console login is the owner too, told once");
  assert.deepEqual(businessCardRequestRecipients(["HR-020"], "X-1"), ["B-10", "HR-020"], "once the seat is held, the owner and the holder");
  assert.deepEqual(businessCardRequestRecipients(["HR-020"], "HR-020"), ["B-10"], "the requester is never told about their own request");
  assert.deepEqual(businessCardRequestRecipients([], "X-1"), ["B-10"], "a seat that could not be read leaves the owner's copy standing");
}

function assertNoSenderNamesAPersonForTheSeat() {
  const sources: Array<[string, string]> = [
    ["src/lib/vacation/informed-recipients.ts", "the vacation informed recipients"],
    ["src/lib/business-cards/request-service.ts", "the business-card request service"],
    ["src/lib/notifications/vacant-seat.ts", "the vacant-seat stand-ins"],
  ];
  for (const [path, label] of sources) {
    const code = stripComments(readFileSync(path, "utf8"));
    assert.ok(!/["'`]HR-009["'`]/.test(code), `${label} name no person by HR id for the seat`);
  }

  const vacationService = stripComments(readFileSync("src/lib/vacation/service.ts", "utf8"));
  assert.match(
    vacationService,
    /await resolveSeatOrStandInHrIds\(VACATION_INFORMED_SEAT, /,
    "the vacation informed notice resolves the HR Generalist seat, or its stand-in while it is empty",
  );

  const roleRecipients = stripComments(readFileSync("src/lib/notifications/role-recipients.ts", "utf8"));
  assert.match(
    roleRecipients,
    /return withVacantSeatStandIns\(policy\.roles, /,
    "every role-addressed audience passes through the vacant-seat stand-ins, so no sender can skip them",
  );
}

export async function runVacantSeatRecipientsTests() {
  assertTheStandInMap();
  assertWhichSeatsNeedARead();
  assertTheStandInIsAddedOnlyForAVacancy();
  await assertTheRoleAudienceWrapper();
  await assertTheDirectSeatResolver();
  assertOnePerPerson();
  assertProbationGoesToTheOwnerAloneWithoutResending();
  assertBusinessCardRecipients();
  assertNoSenderNamesAPersonForTheSeat();
}
