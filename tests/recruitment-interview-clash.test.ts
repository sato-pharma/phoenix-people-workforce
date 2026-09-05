import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  findInterviewClash,
  interviewClashMessage,
  INTERVIEW_SLOT_MINUTES,
} from "../src/lib/recruitment/interview-clash.ts";

/**
 * One interviewer cannot be in two interviews at once.
 *
 * ── THE ASSUMPTION, STATED ────────────────────────────────────────────────────────────────────
 *
 * `ats_interviews` has `scheduled_at` and nothing else about time — no duration, no end. A true
 * overlap is therefore not computable, and adding a duration column to make it computable would be
 * a schema change made to satisfy a check rather than to record anything real.
 *
 * So the rule is proximity: two interviews for the same person starting LESS than one slot apart.
 * Strictly less than, so back-to-back is allowed — two interviews exactly a slot apart are a normal
 * morning, and a guard that refuses them gets switched off within a week.
 */
export function runRecruitmentInterviewClashTests() {
  const at = (hour: number, minute = 0) =>
    new Date(Date.UTC(2026, 8, 10, hour, minute)).toISOString();

  const existing = [
    { id: "i1", interviewerHrId: "B-10", scheduledAt: at(10) },
  ];

  // ── the case with no legitimate reading ──────────────────────────────────────────────────────
  {
    const clash = findInterviewClash({ interviewerHrId: "B-10", scheduledAt: at(10, 30) }, existing);
    assert.equal(clash?.clashesWithInterviewId, "i1", "half an hour apart is the same slot");
    assert.equal(clash?.minutesApart, 30);
  }

  // ── back-to-back is a normal morning, not a clash ────────────────────────────────────────────
  assert.equal(
    findInterviewClash({ interviewerHrId: "B-10", scheduledAt: at(11) }, existing),
    null,
    `exactly ${INTERVIEW_SLOT_MINUTES} minutes apart must be allowed - a guard that refuses `
      + "back-to-back interviews is one people turn off",
  );

  // ── and it works in both directions ──────────────────────────────────────────────────────────
  assert.ok(
    findInterviewClash({ interviewerHrId: "B-10", scheduledAt: at(9, 45) }, existing),
    "a booking BEFORE the existing one clashes too - the check is on distance, not order",
  );

  // ── a different interviewer is free at the same moment ───────────────────────────────────────
  assert.equal(
    findInterviewClash({ interviewerHrId: "A-12", scheduledAt: at(10) }, existing),
    null,
    "two interviewers may run at the same time - this guards one person, not the diary",
  );

  // ── casing must not let a double-booking through ─────────────────────────────────────────────
  //
  // HR ids are mixed case throughout this database. If "b-10" read as a different person from
  // "B-10", the check would report the interviewer free and book them twice.
  for (const spelling of ["b-10", " B-10 ", "B-10"]) {
    assert.ok(
      findInterviewClash({ interviewerHrId: spelling, scheduledAt: at(10, 15) }, existing),
      `"${spelling}" is the same person as B-10 and must still clash`,
    );
  }

  // ── a scorecard record is not a booking ──────────────────────────────────────────────────────
  //
  // recordScreeningOutcome writes interview rows with no scheduled_at. Treating one as an occupied
  // slot would refuse a real interview because somebody was screened that day.
  assert.equal(
    findInterviewClash(
      { interviewerHrId: "B-10", scheduledAt: at(10) },
      [{ id: "i2", interviewerHrId: "B-10", scheduledAt: null }],
    ),
    null,
    "an interview row with no time is a scorecard, not a slot",
  );

  // ── nothing to check ─────────────────────────────────────────────────────────────────────────
  assert.equal(
    findInterviewClash({ interviewerHrId: null, scheduledAt: at(10) }, existing),
    null,
    "an unassigned interview has nobody to double-book",
  );
  assert.equal(
    findInterviewClash({ interviewerHrId: "B-10", scheduledAt: null }, existing),
    null,
    "and an interview with no time occupies no slot",
  );
  assert.equal(
    findInterviewClash({ interviewerHrId: "B-10", scheduledAt: "not a date" }, existing),
    null,
    "an unparseable time must not be treated as midnight and clash with the morning",
  );

  // ── rescheduling must not clash with itself ──────────────────────────────────────────────────
  assert.equal(
    findInterviewClash(
      { interviewerHrId: "B-10", scheduledAt: at(10, 10) },
      existing,
      { excludeInterviewId: "i1" },
    ),
    null,
    "moving an interview by ten minutes must not be refused by the row being moved - without the "
      + "exclusion, rescheduling is impossible",
  );

  // ── the message is readable and in Cairo ─────────────────────────────────────────────────────
  {
    const clash = findInterviewClash({ interviewerHrId: "B-10", scheduledAt: at(10, 30) }, existing)!;
    const message = interviewClashMessage(clash, "Omar Anwar Ibrahim Ahmed Gawish");
    assert.match(message, /Omar Anwar/, "the owner's rule is human names, never raw ids");
    assert.match(message, /Cairo/, "and every time in this system is reported in Cairo");
    assert.match(
      message,
      /13:00/,
      "10:00 UTC is 13:00 in Cairo on 10 September - Egypt is on DST (+3) then, not +2. A UTC time "
        + "in this message is how somebody 'fixes' a clash by moving the booking three hours the "
        + "wrong way, and a +2 assumption moves it one",
    );
    assert.equal(/\.\.\.|…/.test(message), false, "no ellipsis");
  }

  // ── wired into the scheduling path, before the insert ────────────────────────────────────────
  const service = readFileSync("src/lib/recruitment/interviews.ts", "utf8");
  const checkAt = service.indexOf("findInterviewClash(");
  const insertAt = service.indexOf('.from("ats_interviews")\n    .insert(');
  assert.ok(checkAt > -1, "createInterview must check for a clash");
  assert.ok(insertAt > -1, "and must still insert the interview");
  assert.ok(checkAt < insertAt, "the check must run BEFORE the insert, not after the double-booking exists");
  assert.match(
    service,
    /hrIdLookupKeys\(interviewerHrId\)/,
    "the interviewer lookup must be casing-blind - a plain .eq returns nothing, which reads as "
      + "'this interviewer is free' and books them twice",
  );

  // ── and the actor write in the same function stays canonical ─────────────────────────────────
  assert.match(
    service,
    /created_by: hrIdForStorage\(access\.hrId\) \?\? access\.loginId \?\? null,/,
    "created_by must store the canonical hr id - this is a THIRD shape of the actor bug, with no "
      + "resolveEmployeeIdentityId call and a column not named *_hr_id, so no repo-wide sweep sees it",
  );
}
