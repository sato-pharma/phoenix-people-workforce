import assert from "node:assert/strict";
import { join } from "node:path";

import {
  isMeetingVisitType,
  isWorkedTripDay,
  TRIP_DAY_MEETING_VISIT_TYPES,
  tripWorkloadMatch,
} from "../src/lib/crm/trip-day-meetings.ts";
import { resolveWorkloadFreshness } from "../src/lib/outstation/workload-freshness.ts";
import { capturedWorkloadMatchStatus } from "../src/lib/outstation/workload-rollup.ts";
import { shouldRestampWorkload } from "../src/lib/outstation/workload-stamp.ts";
import { stripComments } from "./support/comment-strip.ts";
import { cachedReadFile } from "./support/source-corpus.ts";

// A recorded meeting makes its trip day a WORKED day — never "no field activity" — and is never a
// visit (owner, 2026-11-07, on Weaam Gweed's 5 Oct 2026 trip to the Sheraton head office: "since
// meeting not field work do not flag as no field work, and especially that the meeting and expense
// in Sheraton in head office").
//
// THE HOLE. Her only CRM entry that day was a Meeting (-11), saved 13:54 Cairo. The trip was stamped
// "no activity" at 13:09 when the departure photo landed, the live read counted only Regular (0) and
// Campaign (-8) as work, and the morning re-read fires only when the visit total rises — a meeting
// never raised it. The approver read "she did nothing" on a day she spent in a meeting.
//
// WHY THE SHAPE. The rule is one pure module shared by the server reads and the review screen, so it
// is pinned on behaviour; the readers that must call it are pinned on comment-stripped source.

const ROOT = process.cwd();

function code(relative: string): string {
  return stripComments(cachedReadFile(join(ROOT, relative)));
}

export function runOutstationTripDayMeetingsTests() {
  // -- which codes are a meeting -------------------------------------------------------------------
  assert.equal(isMeetingVisitType(-11), true, "the vendor's Meeting is a meeting");
  assert.equal(isMeetingVisitType(-19), true, "its undocumented twin is the same activity");
  assert.equal(isMeetingVisitType(-2), true, "a Group Meeting is a meeting");
  assert.equal(isMeetingVisitType(0), false, "a regular visit is a visit, not a meeting");
  assert.equal(isMeetingVisitType(-8), false, "a campaign visit is a visit, not a meeting");
  assert.equal(isMeetingVisitType(-3), false, "other working codes are NOT widened into a meeting");
  assert.equal(isMeetingVisitType(null), false);
  assert.equal(TRIP_DAY_MEETING_VISIT_TYPES.size, 3, "exactly the three meeting codes, nothing more");

  // -- a meeting day is worked ---------------------------------------------------------------------
  assert.equal(isWorkedTripDay({ meetings: 1, total: 0 }), true, "HEADLINE: a meeting-only day is worked");
  assert.equal(isWorkedTripDay({ meetings: 0, total: 0 }), false, "a day with nothing is still idle");
  assert.equal(isWorkedTripDay({ total: 0 }), false, "a payload with no meeting count reads as before");
  assert.equal(isWorkedTripDay({ total: 3 }), true);

  const weaam = tripWorkloadMatch([{ date: "2026-10-05", meetings: 1, total: 0 }]);
  assert.equal(weaam.matchStatus, "matched", "Weaam's 5 Oct trip, a meeting and no visit, is matched");
  assert.deepEqual(weaam.idleDates, []);
  assert.deepEqual(weaam.matchedDates, ["2026-10-05"]);
  const mixed = tripWorkloadMatch([
    { date: "2026-10-10", meetings: 1, total: 0 },
    { date: "2026-10-11", total: 0 },
    { date: "2026-10-12", total: 4 },
  ]);
  assert.equal(mixed.matchStatus, "partial", "a truly empty day still makes the trip partial");
  assert.deepEqual(mixed.idleDates, ["2026-10-11"], "only the day with neither a visit nor a meeting is idle");
  assert.equal(tripWorkloadMatch([{ date: "2026-10-05", total: 0 }]).matchStatus, "no_activity");

  // -- the stamp and the morning re-read ----------------------------------------------------------
  const zero = { amWorkload: 0, pharmacyWorkload: 0, pmWorkload: 0 };
  assert.equal(capturedWorkloadMatchStatus({ ...zero, meetingDates: ["2026-10-05"] }), "matched", "a meeting stamps matched");
  assert.equal(capturedWorkloadMatchStatus({ ...zero, meetingDates: [] }), "no_activity", "no meeting, no visit, no activity");
  assert.equal(
    shouldRestampWorkload({ ...zero, workloadMatchStatus: "no_activity" }, { ...zero, meetingDates: ["2026-10-05"] }),
    true,
    "HEADLINE: a no-activity stamp taken before the meeting was saved is re-stamped",
  );
  assert.equal(
    shouldRestampWorkload({ ...zero, workloadMatchStatus: "matched" }, { ...zero, meetingDates: ["2026-10-05"] }),
    false,
    "a stamp that already reads matched is never touched for a meeting",
  );
  assert.equal(
    shouldRestampWorkload({ ...zero, workloadMatchStatus: "no_activity" }, zero),
    false,
    "an empty day stays as it was stamped",
  );

  // -- the freshness warning ----------------------------------------------------------------------
  const freshness = resolveWorkloadFreshness({
    liveAmWorkload: 0,
    liveMatchStatus: "matched",
    liveMeetingDays: 1,
    livePharmacyWorkload: 0,
    livePmWorkload: 0,
    storedAmWorkload: 0,
    storedMatchedAt: "2026-10-05T10:09:00.000Z",
    storedMatchStatus: "no_activity",
    storedPharmacyWorkload: 0,
    storedPmWorkload: 0,
  });
  assert.equal(freshness.verdict, "stale", "a stored no-activity beside a recorded meeting is out of date");
  assert.match(freshness.headline ?? "", /recorded meeting/);
  assert.equal(freshness.liveTotal, 0, "a meeting is never counted as a visit");

  // -- the readers call the one rule ---------------------------------------------------------------
  const workload = code("src/lib/crm/visit-workload.ts");
  assert.match(workload, /tripWorkloadMatch\(dateBreakdown\)/, "the live read takes its verdict from the shared rule");
  assert.match(workload, /isMeetingVisitType\(row\.visit_type\)[\s\S]{0,400}ownerKey === selfKey/, "only the person's OWN meeting counts");
  assert.doesNotMatch(workload, /dateBreakdown\.filter\(\(day\) => day\.total === 0\)/, "no second idle definition in the live read");

  const review = code("src/components/outstation/expense-approvals/trip-review.tsx");
  assert.doesNotMatch(review, /day\.total === 0\)\.length/, "the review screen never counts a meeting day as idle");
  assert.match(review, /idleDays: days\.filter\(\(day\) => !isWorkedTripDay\(day\)\)\.length/, "no idle-day share is offered for a meeting day");

  const evidence = code("src/components/outstation/trip-workload-evidence.tsx");
  assert.doesNotMatch(evidence, /const idle = day\.total === 0/, "the evidence panel never reads a meeting day as idle");
  assert.match(evidence, /Meeting recorded/);

  const claim = code("src/lib/outstation/expense-claim-validation.ts");
  assert.match(claim, /visit\.kind !== "meeting"/, "a meeting's save time never stands in for the first visit's");
}
