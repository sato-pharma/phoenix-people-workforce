import assert from "node:assert/strict";
import { resolveRepDayCheckinOwners, resolveRepDayCheckinOwnerKeys, selectRepDayCheckins } from "../src/lib/crm/rep-day.ts";
import type { IReports360Checkin, IReports360Visit } from "../src/lib/crm/vendor-row-types.ts";

/** A-7 (crm 1234) on 2026-06-14, as it really is in production. */
const MANAGER = 1234;
const REP = 1483;

/** A complete vendor visit row, submitted by the REP, optionally tagging a double-visit partner.
 * Every field of the vendor shape is present — a partial fixture compiles locally under type
 * stripping and fails the typecheck in CI, where the test file is checked like any other source. */
function dayVisit(contactID: number, saveDate: string, doubleID: number | null): IReports360Visit & { agentHrId?: string | null; doubleHrId?: string | null } {
  return {
    agentID: REP,
    agentName: "Mostafa.Saied ( Behira 2 / A )",
    ampm: "AM",
    attendance: null,
    callType: null,
    comment: null,
    contactGrade: "A",
    contactID,
    contactName: contactID === 0 ? null : "A Doctor",
    customerName: null,
    doubleID,
    doubleName: doubleID == null ? null : "Ahmed.Elkawass",
    id: 900000 + contactID,
    region: null,
    regionID: null,
    saveDate,
    speciality: null,
    visitDate: saveDate.slice(0, 10),
    visitType: 0,
    visitTypeDescription: "Regular Visit",
  };
}

/** A complete vendor check-in row, recorded by the REP's phone. */
function dayCheckin(contactID: number, checkDate: string): IReports360Checkin & { agentHrId?: string | null } {
  return {
    address: "A street, A city, Egypt",
    agentHrId: null,
    agentID: REP,
    checkDate,
    contactID,
    contactName: contactID === 0 ? null : "A Doctor",
    id: 700000 + contactID,
    lat: 30.46,
    lon: 31.17,
  };
}

export function runCrmRepDayCheckinAttributionTests() {
  // --- the bug: a manager submits nothing, so their own id alone yields an empty route ---

  const managerDay = resolveRepDayCheckinOwners(MANAGER, [
    { agentID: REP, agentName: "Mostafa.Saied ( Behira 2 / A ) " },
    { agentID: REP, agentName: "Mostafa.Saied ( Behira 2 / A ) " },
  ]);
  assert.equal(
    managerDay.has(REP),
    true,
    "the rep who submitted the visit owns the check-ins that make up the manager's route — without this the manager's map is blank while their visits list fine (verified in production: 0 own check-ins vs 4 borrowed)",
  );
  assert.equal(
    managerDay.get(REP),
    "Mostafa Saied",
    "a borrowed check-in is labelled with the rep it came from, so the map never implies the manager checked in personally",
  );
  assert.equal(
    managerDay.get(MANAGER),
    null,
    "the person's own id is always an owner and is never labelled as borrowed",
  );

  // --- a rep who submits their own visits keeps exactly the old behaviour ---

  const repDay = resolveRepDayCheckinOwners(REP, [
    { agentID: REP, agentName: "Mostafa.Saied" },
    { agentID: REP, agentName: "Mostafa.Saied" },
  ]);
  assert.deepEqual(
    [...repDay.keys()],
    [REP],
    "a rep who submitted every visit borrows nothing — this fix must not widen an ordinary rep's route",
  );
  assert.equal(repDay.get(REP), null, "their own check-ins are not marked borrowed");

  // --- triple visit: a DM submits while tagging the NSM, so the NSM borrows the DM's check-ins ---

  const NSM = 900;
  const DM = 1234;
  const tripleVisit = resolveRepDayCheckinOwners(NSM, [{ agentID: DM, agentName: "Ahmed.Elkawass" }]);
  assert.equal(tripleVisit.get(DM), "Ahmed Elkawass", "the triple-visitor borrows the submitting DM's check-ins");
  assert.equal(tripleVisit.has(NSM), true, "and still keeps their own id as an owner");

  // --- no visits at all: falls back to just the person, never to everyone ---

  const idle = resolveRepDayCheckinOwners(MANAGER, []);
  assert.deepEqual(
    [...idle.keys()],
    [MANAGER],
    "with no visits the owner set is just this person — it must never fail open and pull in unrelated reps' routes",
  );

  // --- several reps in one day are all owners, each labelled with its own name ---

  const REP_B = 1500;
  const busyDay = resolveRepDayCheckinOwners(MANAGER, [
    { agentID: REP, agentName: "Mostafa.Saied" },
    { agentID: REP_B, agentName: "Sara.Ali" },
    { agentID: MANAGER, agentName: "Ahmed.Elkawass" },
  ]);
  assert.equal(busyDay.size, 3, "a manager who double-visited two reps borrows from both, plus their own id");
  assert.equal(busyDay.get(REP), "Mostafa Saied");
  assert.equal(busyDay.get(REP_B), "Sara Ali");
  assert.equal(busyDay.get(MANAGER), null, "their own submitted visit does not make their own check-ins 'borrowed'");

  // ── WHOSE stops, not just whose phone ────────────────────────────────────────────────────────
  //
  // The owner set above says whose phone may speak for this person. It does NOT say that every
  // stop that phone made is his. Until this was fixed the screen attributed the rep's WHOLE day to
  // any manager who rode along for part of it — which is how a manager who was out until lunch was
  // reported as finishing at the rep's last check-in.
  {
    const DAY = "2026-09-20";
    const REP_KEY = String(REP);
    const MANAGER_KEY = String(MANAGER);
    const together = [dayVisit(111, `${DAY} 11:00:00`, MANAGER), dayVisit(222, `${DAY} 12:30:00`, MANAGER)];
    const alone = [dayVisit(333, `${DAY} 15:10:00`, null), dayVisit(444, `${DAY} 16:40:00`, null)];
    const repsWholeDay = [
      dayCheckin(111, `${DAY}T10:42:00`),
      dayCheckin(222, `${DAY}T12:05:00`),
      dayCheckin(333, `${DAY}T14:55:00`),
      dayCheckin(444, `${DAY}T16:20:00`),
    ];

    // The MANAGER's day: he is on the first two visits only.
    const managerStops = selectRepDayCheckins({
      checkins: repsWholeDay,
      day: DAY,
      dayVisits: together,
      owners: resolveRepDayCheckinOwnerKeys(MANAGER_KEY, together),
      selfKey: MANAGER_KEY,
    });
    assert.deepEqual(
      managerStops.map((stop) => stop.contactID),
      [111, 222],
      "a manager's route is the calls he was ON — the rep's later solo stops are NOT his, and attributing them is what made this screen report a late finish for a morning in the field",
    );
    assert.equal(
      managerStops.every((stop) => stop.via === "Mostafa Saied"),
      true,
      "and every borrowed stop still names the rep it came from, so the map never implies he checked in himself",
    );
    assert.equal(
      managerStops[managerStops.length - 1].checkDate,
      `${DAY}T12:05:00`,
      "so his last stop is the last call he attended, not the rep's last of the day",
    );

    // The REP's own day is untouched: his own phone is his whole day, calls and solo stops alike.
    const repStops = selectRepDayCheckins({
      checkins: repsWholeDay,
      day: DAY,
      dayVisits: [...together, ...alone],
      owners: resolveRepDayCheckinOwnerKeys(REP_KEY, [...together, ...alone]),
      selfKey: REP_KEY,
    });
    assert.deepEqual(
      repStops.map((stop) => stop.contactID),
      [111, 222, 333, 444],
      "an ordinary rep's own route must not be narrowed by this fix — his own check-ins are his whole day",
    );
    assert.equal(repStops.every((stop) => stop.via === null), true, "and none of his own stops is marked borrowed");
  }

  // ── a borrowed row with no real contact matches nothing ──────────────────────────────────────
  //
  // Meeting / Traveling / leave rows carry the vendor's `0` contact placeholder and have no GPS of
  // their own. Keyed without a real-contact guard they would all collapse onto one key and take
  // each other's coordinates — the same asymmetry indexCheckinsByAgentContactDay rejects.
  {
    const DAY = "2026-09-21";
    const MANAGER_KEY = String(MANAGER);
    const meeting = [{ ...dayVisit(0, `${DAY} 09:00:00`, MANAGER), visitDate: DAY, visitType: -19 }];
    const elsewhere = [{ ...dayCheckin(0, `${DAY}T17:45:00`), lat: 30.79, lon: 30.99 }];
    const stops = selectRepDayCheckins({
      checkins: elsewhere,
      day: DAY,
      dayVisits: meeting,
      owners: resolveRepDayCheckinOwnerKeys(MANAGER_KEY, meeting),
      selfKey: MANAGER_KEY,
    });
    assert.deepEqual(
      stops,
      [],
      "a contact-less row borrows no GPS — it must never inherit an unrelated stop's coordinates and be drawn with a time",
    );
  }
}
