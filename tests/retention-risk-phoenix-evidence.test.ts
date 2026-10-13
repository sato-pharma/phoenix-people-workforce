import assert from "node:assert/strict";

import { buildRetentionRiskSignals } from "../src/lib/retention-risk/detector.ts";
import { mergePhoenixWorkEvidence } from "../src/lib/retention-risk/phoenix-evidence.ts";
import type { PhoenixWorkEvidenceDay } from "../src/lib/crm/phoenix-work-evidence.ts";

const day = (over: Partial<PhoenixWorkEvidenceDay>): PhoenixWorkEvidenceDay => ({
  date: "2026-10-11",
  dayActivities: [],
  dayStarts: 0,
  hrId: "AI-0024",
  visits: 0,
  ...over,
});

function signalsFor(days: PhoenixWorkEvidenceDay[]) {
  const activity = new Map([["ai-0024", new Set(["2026-10-04", "2026-10-05"])]]);
  const firstSeen = new Map([["ai-0024", "2026-10-04"]]);
  mergePhoenixWorkEvidence(activity, firstSeen, days);
  return buildRetentionRiskSignals({
    crmActivityByHrId: activity,
    leaveByHrId: new Map(),
    measurableThrough: "2026-10-12",
    openRunsOnly: true,
    publicHolidays: new Set<string>(),
    subjects: [
      {
        areaName: "Cairo 1",
        displayName: "Test Rep",
        firstCrmActivityDate: firstSeen.get("ai-0024") ?? null,
        hireDate: "2026-01-01",
        hrId: "AI-0024",
        jobTitle: "Medical Representative",
        lastWorkingDate: null,
        lineName: "CNS",
        managerHrId: null,
        managerName: null,
        positionTitle: null,
        watchCrmSilence: true,
      },
    ],
    thresholdWorkingDays: 3,
    windowEnd: "2026-10-31",
    windowStart: "2026-09-28",
  }).filter((signal) => signal.trigger === "crm_silence");
}

export function runRetentionRiskPhoenixEvidenceTests() {
  assert.equal(signalsFor([]).length, 1, "silent in the view with no Phoenix work is flagged");

  assert.equal(
    signalsFor([day({ date: "2026-10-12", visits: 5 })]).length,
    0,
    "a Phoenix visit on the latest day ends the run",
  );

  assert.equal(
    signalsFor([day({ date: "2026-10-12", dayActivities: ["Training"] })]).length,
    0,
    "a Phoenix day activity proves the day",
  );

  assert.equal(
    signalsFor([day({ date: "2026-10-12", dayStarts: 1 })]).length,
    1,
    "a day start alone proves nothing",
  );

  const activity = new Map<string, Set<string>>();
  const firstSeen = new Map<string, string>();
  mergePhoenixWorkEvidence(activity, firstSeen, [day({ hrId: "ai-0024", visits: 1 })]);
  assert.equal(firstSeen.get("ai-0024"), "2026-10-11", "mixed-case hr id lands on the canonical key");
}
