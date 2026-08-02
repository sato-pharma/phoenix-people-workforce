import assert from "node:assert/strict";
import { resolveRepDayCheckinOwners } from "../src/lib/crm/rep-day.ts";

/** A-7 (crm 1234) on 2026-06-14, as it really is in production. */
const MANAGER = 1234;
const REP = 1483;

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
}
