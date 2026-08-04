import assert from "node:assert/strict";
import {
  rollupHopsForRole,
  rollUpManagerTripWorkload,
} from "../src/lib/outstation/workload-rollup.ts";

/**
 * Owner's rule (2026-08-04) for whose field work counts as a manager's own on a trip day:
 *   - a District Manager's ride-alongs with his reps are already his (0 hops);
 *   - a National Sales Manager also gets the rep visits under the DMs he was with — but ONLY on
 *     the days he was with them (1 hop).
 */
export function runOutstationWorkloadRollupTests() {
  const DAY1 = "2026-10-17";
  const DAY2 = "2026-10-18";

  // NSM out with DM-A on day 1 only. DM-A with REP-1 both days; DM-B (never with the NSM) with
  // REP-3 on day 1.
  const scenario = {
    dates: [DAY1, DAY2],
    partnersByPersonDate: {
      "HR-NSM": { [DAY1]: ["HR-DM-A"] },
      "HR-DM-A": { [DAY1]: ["HR-REP-1"], [DAY2]: ["HR-REP-1"] },
      "HR-DM-B": { [DAY1]: ["HR-REP-3"] },
    },
    rootHrId: "HR-NSM",
    workloadByPerson: {
      "HR-NSM": [{ am: 1, date: DAY1, pm: 0 }],
      "HR-DM-A": [
        { am: 2, date: DAY1, pm: 1 },
        { am: 5, date: DAY2, pm: 5 },
      ],
      "HR-REP-1": [
        { am: 3, date: DAY1, pm: 2 },
        { am: 9, date: DAY2, pm: 9 },
      ],
      "HR-REP-3": [{ am: 7, date: DAY1, pm: 7 }],
    },
  };

  const nsm = rollUpManagerTripWorkload({ ...scenario, hops: 1 });

  // Day 1: NSM (1/0) + DM-A (2/1) — one hop reaches the DM he was with, and stops there.
  const day1 = nsm.days.find((day) => day.date === DAY1);
  assert.ok(day1, "day 1 must be present");
  assert.equal(day1.am, 3, "day 1 AM is the NSM's own plus the DM he was actually out with");
  assert.equal(day1.pm, 1, "day 1 PM likewise");
  assert.ok(
    !day1.countedHrIds.includes("HR-REP-3"),
    "a rep under a DM the NSM was NEVER with must not count — that is the wide reading the owner rejected",
  );

  // Day 2: the NSM was with nobody. DM-A worked and was with REP-1, but the NSM was not there.
  const day2 = nsm.days.find((day) => day.date === DAY2);
  assert.ok(day2, "day 2 must be present");
  assert.equal(
    day2.am,
    0,
    "a day the NSM was not in the field counts zero, even though his DM worked that day — 'only reps present on his DM days'",
  );
  assert.equal(day2.pm, 0, "same for PM");
  assert.deepEqual(day2.countedHrIds, ["HR-NSM"], "and only he is listed");

  // ── A District Manager is 0 hops: his ride-alongs are already counted as his own ──
  const dm = rollUpManagerTripWorkload({
    dates: [DAY1],
    hops: 0,
    partnersByPersonDate: scenario.partnersByPersonDate,
    rootHrId: "HR-DM-A",
    workloadByPerson: scenario.workloadByPerson,
  });
  assert.equal(
    dm.days[0].am,
    2,
    "a DM counts only his own row — getRepTripVisitWorkload already credits him as the double-visit partner, so a hop would double-count his rep",
  );
  assert.deepEqual(dm.days[0].countedHrIds, ["HR-DM-A"], "and nobody else is pulled in");

  // ── Two hops does reach the rep, which is why the DM case must stay at zero ──────
  const twoHops = rollUpManagerTripWorkload({ ...scenario, hops: 2 });
  const twoHopDay1 = twoHops.days.find((day) => day.date === DAY1);
  assert.equal(twoHopDay1?.am, 6, "two hops reaches NSM + DM-A + REP-1 (1 + 2 + 3)");

  // ── One person is counted once per day, however many paths reach them ────────────
  const shared = rollUpManagerTripWorkload({
    dates: [DAY1],
    hops: 2,
    partnersByPersonDate: {
      "HR-NSM": { [DAY1]: ["HR-DM-A", "HR-DM-B"] },
      "HR-DM-A": { [DAY1]: ["HR-REP-1"] },
      "HR-DM-B": { [DAY1]: ["HR-REP-1"] },
    },
    rootHrId: "HR-NSM",
    workloadByPerson: {
      "HR-NSM": [{ am: 1, date: DAY1, pm: 0 }],
      "HR-DM-A": [{ am: 2, date: DAY1, pm: 0 }],
      "HR-DM-B": [{ am: 4, date: DAY1, pm: 0 }],
      "HR-REP-1": [{ am: 8, date: DAY1, pm: 0 }],
    },
  });
  assert.equal(
    shared.days[0].am,
    15,
    "the rep both DMs were with counts ONCE (1 + 2 + 4 + 8), not twice",
  );

  // ── A partnership cycle must terminate, not loop ─────────────────────────────────
  const cyclic = rollUpManagerTripWorkload({
    dates: [DAY1],
    hops: 5,
    partnersByPersonDate: {
      "HR-A": { [DAY1]: ["HR-B"] },
      "HR-B": { [DAY1]: ["HR-A"] },
    },
    rootHrId: "HR-A",
    workloadByPerson: {
      "HR-A": [{ am: 1, date: DAY1, pm: 1 }],
      "HR-B": [{ am: 2, date: DAY1, pm: 2 }],
    },
  });
  assert.equal(cyclic.days[0].am, 3, "A and B each count once despite pointing at each other");

  // ── HR IDs differing only in case are the same person ───────────────────────────
  const messyCase = rollUpManagerTripWorkload({
    dates: [DAY1],
    hops: 1,
    partnersByPersonDate: { "hr-nsm": { [DAY1]: ["hr-dm-a"] } },
    rootHrId: "HR-NSM",
    workloadByPerson: {
      "HR-NSM": [{ am: 1, date: DAY1, pm: 0 }],
      "HR-DM-A": [{ am: 2, date: DAY1, pm: 0 }],
    },
  });
  assert.equal(messyCase.days[0].am, 3, "a lower-case partner id must still resolve to the same person");

  // ── Trip totals are the sum of the days ─────────────────────────────────────────
  assert.equal(nsm.amWorkload, 3, "trip AM total is the sum across days");
  assert.equal(nsm.pmWorkload, 1, "trip PM total likewise");

  // ── A day nobody worked is a real zero, and is still reported ───────────────────
  const idle = rollUpManagerTripWorkload({
    dates: [DAY1],
    hops: 1,
    partnersByPersonDate: {},
    rootHrId: "HR-NSM",
    workloadByPerson: {},
  });
  assert.equal(idle.days.length, 1, "an idle day is still listed, never dropped from the breakdown");
  assert.equal(idle.days[0].am, 0, "with an explicit zero");

  // ── Role → hops ─────────────────────────────────────────────────────────────────
  assert.equal(rollupHopsForRole("District Manager"), 0, "a DM's ride-alongs are already his own");
  assert.equal(rollupHopsForRole("National Sales Manager"), 1, "an NSM reaches one hop out");
  assert.equal(rollupHopsForRole("Regional Manager"), 1, "an RM rides with DMs the same way");
  assert.equal(
    rollupHopsForRole("Medical Rep"),
    0,
    "a rep logs his own work — a hop would credit him with his colleagues'",
  );
  assert.equal(rollupHopsForRole(null), 0, "an unknown seat defaults to own-visits-only, never wider");
}
