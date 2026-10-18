import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cairoLocalToUtc } from "../src/lib/recruitment/interview-calendar-week.ts";
import {
  DECISION_WINDOW_DAYS,
  inferInterviewOutcome,
  type SettleEvidence,
} from "../src/lib/recruitment/interview-outcome-settle.ts";
import { stripComments } from "./support/comment-strip.ts";

const read = (relative: string) => readFileSync(join(process.cwd(), relative), "utf8");

// Interview outcomes that the record already proves settle themselves (owner, 2026-10-17): a finished
// interview whose candidate was rejected, shortlisted, hired or given an offer afterwards is not asked
// about again; everything the record does not prove stays for a person.

const at = (day: string, hour: number) => cairoLocalToUtc(day, hour * 60).toISOString();

// The interview: Tuesday 2026-09-29, 12:00 Cairo, 30 minutes.
function evidence(overrides: Partial<SettleEvidence> = {}): SettleEvidence {
  return {
    durationMinutes: 30,
    nextInterviewStartsAt: null,
    offerCreatedAt: null,
    startsAt: at("2026-09-29", 12),
    statusEvents: [],
    ...overrides,
  };
}

export async function runInterviewOutcomeSettleTests() {
  // Nothing happened to the candidate: nothing is proven.
  assert.equal(inferInterviewOutcome(evidence()), null, "no movement after the interview proves nothing");

  // A person's decision after the interview becomes the outcome, in that person's own word.
  const shortlisted = inferInterviewOutcome(
    evidence({ statusEvents: [{ actorHrId: "B-10", createdAt: at("2026-09-29", 22), toStatus: "shortlisted" }] }),
  );
  assert.equal(shortlisted?.outcome, "shortlisted", "shortlisted after the interview → shortlisted");
  const rejected = inferInterviewOutcome(evidence({ statusEvents: [{ actorHrId: "B-10", createdAt: at("2026-10-05", 10), toStatus: "rejected" }] }));
  assert.equal(rejected?.outcome, "rejected", "rejected after the interview → rejected");
  const backup = inferInterviewOutcome(evidence({ statusEvents: [{ actorHrId: "B-10", createdAt: at("2026-09-30", 10), toStatus: "backup" }] }));
  assert.equal(backup?.outcome, "backup", "moved to back-up after the interview → backup");

  // A status that predates the interview is not a verdict on it.
  assert.equal(
    inferInterviewOutcome(evidence({ statusEvents: [{ actorHrId: "B-10", createdAt: at("2026-09-20", 10), toStatus: "shortlisted" }] })),
    null,
    "shortlisted BEFORE the interview proves nothing about it",
  );
  // Moves made DURING the interview (before it ended) do not count either.
  assert.equal(
    inferInterviewOutcome(evidence({ statusEvents: [{ actorHrId: "B-10", createdAt: at("2026-09-29", 12), toStatus: "rejected" }] })),
    null,
    "a move before the interview ended is not its verdict",
  );

  // A batch sweep is not a person's judgement of this interview.
  assert.equal(
    inferInterviewOutcome(evidence({ statusEvents: [{ actorHrId: "ops:non-egyptian-reject-20260828", createdAt: at("2026-09-30", 10), toStatus: "rejected" }] })),
    null,
    "a batch actor's rejection is not read as the interview's outcome",
  );
  assert.equal(
    inferInterviewOutcome(evidence({ statusEvents: [{ actorHrId: null, createdAt: at("2026-09-30", 10), toStatus: "rejected" }] })),
    null,
    "an unattributed move is not read as a person's decision",
  );

  // Too late to be about this interview.
  const late = new Date(Date.parse(at("2026-09-29", 12)) + (DECISION_WINDOW_DAYS + 2) * 86_400_000).toISOString();
  assert.equal(
    inferInterviewOutcome(evidence({ statusEvents: [{ actorHrId: "B-10", createdAt: late, toStatus: "rejected" }] })),
    null,
    "a decision weeks later is not read as the verdict on this interview",
  );

  // A later interview closes the window: what follows it belongs to that one.
  assert.equal(
    inferInterviewOutcome(
      evidence({
        nextInterviewStartsAt: at("2026-10-02", 12),
        statusEvents: [{ actorHrId: "B-10", createdAt: at("2026-10-04", 10), toStatus: "rejected" }],
      }),
    ),
    null,
    "a decision after the candidate's next interview is about that one",
  );
  assert.equal(
    inferInterviewOutcome(evidence({ nextInterviewStartsAt: at("2026-10-02", 12) })),
    null,
    "booking a second interview alone proves nothing — it can follow a no-show",
  );

  // Hired or an offer: they came.
  assert.equal(
    inferInterviewOutcome(evidence({ statusEvents: [{ actorHrId: null, createdAt: at("2026-10-12", 9), toStatus: "hired" }] }))?.outcome,
    "attended",
    "hired after the interview → attended, whoever moved it",
  );
  assert.equal(
    inferInterviewOutcome(evidence({ offerCreatedAt: at("2026-10-01", 9) }))?.outcome,
    "attended",
    "an offer drawn up after the interview → attended",
  );
  assert.equal(
    inferInterviewOutcome(evidence({ offerCreatedAt: at("2026-09-01", 9) })),
    null,
    "an offer that predates the interview proves nothing about it",
  );

  // The FIRST decision wins, in time order, whatever order the rows arrive in.
  const first = inferInterviewOutcome(
    evidence({
      statusEvents: [
        { actorHrId: "B-10", createdAt: at("2026-10-03", 10), toStatus: "rejected" },
        { actorHrId: "B-10", createdAt: at("2026-09-30", 10), toStatus: "shortlisted" },
      ],
    }),
  );
  assert.equal(first?.outcome, "shortlisted", "the earliest decision after the interview is the outcome");

  // Shortlisted and THEN hired is hired (owner, 2026-10-17: Shahd Ghoniem and Yomna Gamal were labelled
  // "shortlisted" although both accepted their offers).
  const shortlistedThenHired = inferInterviewOutcome(
    evidence({
      statusEvents: [
        { actorHrId: "B-10", createdAt: at("2026-09-30", 10), toStatus: "shortlisted" },
        { actorHrId: null, createdAt: at("2026-10-14", 10), toStatus: "hired" },
      ],
    }),
  );
  assert.equal(shortlistedThenHired?.outcome, "attended", "a hire after an earlier shortlist is not recorded as 'shortlisted'");
  assert.equal(
    inferInterviewOutcome(
      evidence({
        offerCreatedAt: at("2026-10-05", 9),
        statusEvents: [{ actorHrId: "B-10", createdAt: at("2026-09-30", 10), toStatus: "shortlisted" }],
      }),
    )?.outcome,
    "attended",
    "an offer after an earlier shortlist outranks it",
  );
  assert.equal(
    inferInterviewOutcome(
      evidence({
        offerCreatedAt: at("2026-10-05", 9),
        statusEvents: [{ actorHrId: "B-10", createdAt: at("2026-10-06", 10), toStatus: "rejected" }],
      }),
    )?.outcome,
    "rejected",
    "a rejection is not overridden by an offer that may have been drawn up before it",
  );

  // Taking a CV back from a manager files `sent_to_manager → shortlisted` under a real person; it is not
  // anyone's verdict on the interview, while a shortlist from any other status still is.
  assert.equal(
    inferInterviewOutcome(
      evidence({ statusEvents: [{ actorHrId: "B-10", createdAt: at("2026-09-30", 10), fromStatus: "sent_to_manager", toStatus: "shortlisted" }] }),
    ),
    null,
    "a recall or Hide of a CV a manager held is not a decision",
  );
  assert.equal(
    inferInterviewOutcome(
      evidence({ statusEvents: [{ actorHrId: "B-10", createdAt: at("2026-09-30", 10), fromStatus: "new", toStatus: "shortlisted" }] }),
    )?.outcome,
    "shortlisted",
    "a shortlist from any other status still is",
  );
  assert.equal(
    inferInterviewOutcome(evidence({ statusEvents: [{ actorHrId: "B-10", createdAt: at("2026-09-30", 10), toStatus: "toString" }] })),
    null,
    "a status named like an Object.prototype key is not a decision word",
  );

  // Wiring: the ten-minute cron settles BEFORE it nags, a failure there never stops the reminders, and
  // the write only lands where the outcome is still empty, with no setter and no candidate effect.
  const route = stripComments(read("app/api/cron/interview-reminders/route.ts"));
  const settleAt = route.indexOf("await settleWithinBudget()");
  const remindAt = route.indexOf("runInterviewReminders()");
  assert.ok(settleAt > -1 && remindAt > settleAt, "the cron settles outcomes before it plans reminders");
  assert.match(
    route,
    /settleFinishedInterviewOutcomes\(new Date\(\), \{ deadlineMs: Date\.now\(\) \+ SETTLE_BUDGET_MS \}\)\.catch\(/,
    "a settling failure is caught so the reminders still run, and the settle stops writing at its own deadline",
  );
  assert.doesNotMatch(
    route,
    /Promise\.race/,
    "the settle is awaited, never raced: one left running behind the reminders reports nothing settled, lets them nag about what it is answering, and overlaps the next run",
  );
  const service = stripComments(read("src/lib/recruitment/interview-outcome-settle.ts"));
  assert.match(
    service,
    /candidatesHiredOrOfferedSince\(db, sinceIso\)/,
    "an interview older than the scan is still read when its candidate is hired or offered later — a hire or an offer has no time limit",
  );
  assert.match(service, /Date\.now\(\) >= options\.deadlineMs/, "past its deadline the run starts no new write");
  assert.match(service, /\.is\("outcome", null\)\s*\.select\("id"\)/, "the write lands only where the outcome is still empty");
  assert.match(service, /outcome_set_by_hr_id: null/, "an automatic outcome carries no setter, so nobody mistakes it for a person's word");
  assert.doesNotMatch(service, /setCandidateStatus|updateCandidateStatus|setCandidateRating|createSystemNotification/, "it applies no candidate effect and sends no notice");
}
