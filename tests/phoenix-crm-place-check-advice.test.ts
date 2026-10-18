import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  adviseOnBuilding,
  adviseOnHeldRow,
  adviseOnPlaceInUse,
  adviseOnReview,
  adviseOnSign,
  adviseOnTimetable,
  PLACE_CHECK_ADVICE_LABEL,
  type HeldRowEvidence,
  type PlaceCheckAdvice,
} from "../src/lib/phoenix-crm/place-check-advice.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * The system's recommendation on every place check (owner, 2026-10-17: "add system recommendations to
 * approve or no on every validation", then "and the reason of system recommendation").
 *
 * Three things here would break silently:
 * - a Reject that opens on a reason the system never actually saw — an unreadable photo pre-picking
 *   "the timetable does not name this customer" is one click from telling a rep something false;
 * - the recommendation reaching a district manager's board, whose screen must say nothing about who
 *   decides (owner, 2026-10-13) — or the rep's;
 * - a reason that is a code, an ellipsis, or a banned word on a screen string.
 */

const ROOT = new URL("../", import.meta.url);

function read(path: string): string {
  return readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n");
}

const seen: PlaceCheckAdvice[] = [];
function note(advice: PlaceCheckAdvice): PlaceCheckAdvice {
  seen.push(advice);
  return advice;
}

function held(overrides: Omit<Partial<HeldRowEvidence>, "evidence"> & { evidence?: Partial<HeldRowEvidence["evidence"]> }): HeldRowEvidence {
  const { evidence, ...rest } = overrides;
  return {
    photoKind: "signboard",
    reason: null,
    signText: null,
    hoursRead: null,
    nearestListingMeters: null,
    ...rest,
    evidence: { checkReason: null, heldBecause: null, legibility: null, problem: null, signboard: null, ...evidence },
  };
}

function checkSign() {
  const match = note(adviseOnSign({ verdict: "match", reason: null, signText: "عيادة د. احمد" }));
  assert.equal(match.kind, "approve", "a sign naming the customer recommends approving");
  assert.equal(match.quote, "عيادة د. احمد", "and quotes what was read, in its own script");
  assert.equal(match.refusal, null, "an approval opens no refusal");

  const other = note(adviseOnSign({ verdict: "other_name", reason: null, signText: "صيدلية النور" }));
  assert.equal(other.kind, "reject");
  assert.equal(other.refusal, "wrong_name", "a sign clearly naming somebody else opens Reject on 'The sign is not this customer'");

  const none = note(adviseOnSign({ verdict: "no_name", reason: null, signText: null }));
  assert.equal(none.kind, "reject");
  assert.equal(none.refusal, "no_signboard");

  const final = note(adviseOnSign({ verdict: "unjudged", reason: "unreadable_final", signText: null }));
  assert.equal(final.kind, "reject", "a sign read every time it gets and never once legible cannot show who it is");
  assert.equal(final.refusal, null, "🔴 but an unreadable photo NEVER pre-picks a reason — the system did not see what is wrong");

  for (const reason of ["unreadable", "unconfirmed", "name_unusable", "call_failed", "no_api_key", "something_new"]) {
    const advice = note(adviseOnSign({ verdict: "unjudged", reason, signText: null }));
    assert.equal(advice.kind, "look", `an unjudged sign (${reason}) is the admin's own look, never a verdict`);
    assert.equal(advice.refusal, null);
  }
  assert.equal(note(adviseOnSign(null)).kind, "look", "a sign never read has no recommendation either way");

  const building = note(adviseOnBuilding({ signboard: { verdict: "other_name", reason: null, signText: "مستشفى طنطا" } }));
  assert.match(building.reason, /a different place, not the building/, "a polyclinic's sign is judged as the BUILDING's name, never a person's");
  assert.equal(note(adviseOnBuilding({ signboard: { verdict: "match", reason: null, signText: "مجمع عيادات" } })).kind, "approve");
}

function checkTimetable() {
  const match = note(adviseOnTimetable({ verdict: "match", scheduleText: "د. جورج موسى", hoursRead: "السبت ٤-٨" }));
  assert.equal(match.kind, "approve");
  assert.equal(match.quote, "السبت ٤-٨", "a match quotes the hours read beside the name");

  const other = note(adviseOnTimetable({ verdict: "other_name", scheduleText: "د. كريم · د. سلمى", hoursRead: null, legibility: "clear" }));
  assert.equal(other.kind, "reject");
  assert.equal(other.refusal, "schedule_other_name", "a clear board without the name opens on the request's own reason");

  const missing = note(adviseOnTimetable({ verdict: "no_schedule", scheduleText: null, hoursRead: null }));
  assert.equal(missing.refusal, "schedule_missing", "a photo of a street or a floor is not a timetable");

  const threeMissing = note(adviseOnTimetable({ verdict: "unjudged", scheduleText: null, hoursRead: null, reason: "schedule_missing", heldBecause: "timetable_missing" }));
  assert.equal(threeMissing.kind, "reject");
  assert.equal(threeMissing.refusal, "schedule_missing", "the scanner's own hold after three photos with no timetable is confident");
  assert.match(threeMissing.reason, /3 photos/);

  const blank = note(adviseOnTimetable({ verdict: "unjudged", scheduleText: null, hoursRead: null, reason: "unreadable", heldBecause: "timetable_unreadable", problem: "too_far" }));
  assert.equal(blank.kind, "reject", "nothing legible after three photos cannot show the customer's name");
  assert.equal(blank.refusal, null, "🔴 and still pre-picks NOTHING — the reason he gives the rep is his own choice");
  assert.match(blank.reason, /too far away/, "the reason says what was wrong with the photo");

  const partial = note(adviseOnTimetable({ verdict: "unjudged", scheduleText: "د. نبيل · د. نادي", hoursRead: null, reason: "unreadable", legibility: "partial" }));
  assert.equal(partial.kind, "look", "🔴 part of the board was read: the name may be exactly the part that was not — look, never reject");
  assert.match(partial.reason, /Turn or zoom/);

  const paper = note(adviseOnTimetable({ verdict: "unjudged", scheduleText: null, hoursRead: null, reason: "unreadable", problem: "not_a_timetable" }));
  assert.equal(paper.refusal, "schedule_missing");

  for (const reason of ["call_failed", "no_api_key", "no_bytes", "held_elsewhere"]) {
    const advice = note(adviseOnTimetable({ verdict: "unjudged", scheduleText: null, hoursRead: null, reason }));
    assert.equal(advice.kind, "look", `a reading that never came back (${reason}) recommends nothing either way`);
  }
  assert.equal(note(adviseOnTimetable(null)).kind, "look");

  // The administrator's exception (owner, 2026-10-18, City clinic has no timetable): no photograph can
  // name anybody there, so the system gives NO verdict and pre-picks NO refusal — whatever was read.
  const readings = [
    { verdict: "other_name" as const, scheduleText: "د. كريم", hoursRead: null, legibility: "clear" as const },
    { verdict: "no_schedule" as const, scheduleText: null, hoursRead: null },
    null,
  ];
  for (const timetable of readings) {
    const none = note(adviseOnTimetable(timetable, true));
    assert.equal(none.kind, "look", "🔴 a building the administrator declared has no timetable is never a rejection");
    assert.equal(none.refusal, null, "and no timetable refusal is pre-picked for the rep to be told");
    assert.match(none.reason, /no timetable/);
  }
  assert.equal(note(adviseOnTimetable({ verdict: "match", scheduleText: "د. جورج موسى", hoursRead: null })).kind, "approve", "without the exception a match still approves");
}

function checkHeldRows() {
  const signOther = note(adviseOnHeldRow(held({ reason: "sign_other_name", signText: "عيادة اخرى" })));
  assert.equal(signOther.refusal, "wrong_name");
  const signNone = note(adviseOnHeldRow(held({ reason: "sign_no_name" })));
  assert.equal(signNone.refusal, "no_signboard");

  // A Google hold: the sign at the door is the stronger witness, and Google is named beside it.
  const googleButSign = note(
    adviseOnHeldRow(held({ reason: "no_confident_listing", evidence: { signboard: { verdict: "match", reason: null, signText: "مستشفى السلام" } } })),
  );
  assert.equal(googleButSign.kind, "approve", "the sign names the customer, so Google's silence does not sink the place");
  assert.match(googleButSign.reason, /although Google has no listing/);

  const far = note(adviseOnHeldRow(held({ reason: "listing_far", nearestListingMeters: 1840, evidence: { signboard: null } })));
  assert.equal(far.kind, "look", "Google far away and no sign read: no recommendation either way");
  assert.match(far.reason, /1\.8 km from where the rep stood/, "and the distance is said in plain units");

  const farAndWrong = note(
    adviseOnHeldRow(held({ reason: "listing_far", nearestListingMeters: 640, evidence: { signboard: { verdict: "other_name", reason: null, signText: "x" } } })),
  );
  assert.equal(farAndWrong.kind, "reject");
  assert.equal(farAndWrong.refusal, "wrong_name");
  assert.match(farAndWrong.reason, /640 m/);

  const timetableHold = note(
    adviseOnHeldRow(
      held({ photoKind: "schedule", reason: null, signText: null, evidence: { checkReason: "unreadable", heldBecause: "timetable_unreadable", problem: "blurred" } }),
    ),
  );
  assert.equal(timetableHold.kind, "reject", "a timetable hold is judged on the timetable, never on Google");
  assert.equal(timetableHold.refusal, null);

  const reviewRow = note(adviseOnReview({ ...held({ reason: "listing_far", evidence: { signboard: null } }), listings: [{ distanceMeters: 2500 }, { distanceMeters: 1200 }] }));
  assert.match(reviewRow.reason, /1\.2 km/, "the queue names the NEAREST listing");

  assert.equal(note(adviseOnPlaceInUse({ photoKind: "schedule", signboard: { verdict: "match", reason: null, signText: "x" }, schedule: null })).kind, "look",
    "a seated place is judged on its timetable even when a sign was read");
  assert.equal(note(adviseOnPlaceInUse({ photoKind: "signboard", signboard: { verdict: "match", reason: null, signText: "x" }, schedule: null })).kind, "approve");
}

function checkWords() {
  assert.deepEqual(Object.keys(PLACE_CHECK_ADVICE_LABEL).sort(), ["approve", "look", "reject"]);
  for (const advice of seen) {
    assert.ok(advice.reason.length > 10, "every recommendation carries its reason");
    assert.ok(!/…|\.\.\./.test(advice.reason), `no ellipsis in a reason: ${advice.reason}`);
    assert.ok(!/\b(doctors?|accounts?)\b/i.test(advice.reason), `no banned screen word in: ${advice.reason}`);
    assert.ok(!/\b(AI|model|GPT|OpenAI)\b/.test(advice.reason), `a reason never names how it was read: ${advice.reason}`);
    assert.ok(!/[a-z]+_[a-z]+/.test(advice.reason), `a reason is never a code: ${advice.reason}`);
    if (advice.kind !== "reject") assert.equal(advice.refusal, null, "only a Reject can open on a reason");
  }
}

function checkScreens() {
  const files = [
    "src/components/phoenix-crm/validation-review-queue.tsx",
    "src/components/phoenix-crm/validated-place-list.tsx",
    "src/components/phoenix-crm/shared-place-list.tsx",
    "src/components/phoenix-crm/shared-place-customers.tsx",
  ];
  for (const file of files) {
    const source = stripComments(read(file));
    const lines = source.split("\n").filter((line) => line.includes("<SystemAdvice"));
    assert.ok(lines.length >= 1, `${file} draws the system's recommendation`);
    for (const line of lines) {
      assert.match(line, /mode === "team"[^?]*\? null : <SystemAdvice/, `🔴 ${file}: a district manager's board never draws the recommendation`);
    }
    assert.match(source, /\.refusal \?\? ""/, `${file}: a reject opens on the recommendation's confident reason, and on nothing otherwise`);
  }

  const bulk = stripComments(read("src/components/phoenix-crm/place-check-bulk.tsx"));
  assert.match(bulk, /pickWhere: \(test\) =>/, "the bar can tick exactly the rows the system recommends");
  assert.match(bulk, /Pick the \{toApprove\} the system recommends approving/);
  assert.match(bulk, /Pick the \{toReject\} the system recommends rejecting/);
  assert.ok(!/run\(action\)[^\n]*pickWhere/.test(bulk), "ticking never runs an action: the answer is still his own press");
}

export async function runPhoenixCrmPlaceCheckAdviceTests() {
  checkSign();
  checkTimetable();
  checkHeldRows();
  checkWords();
  checkScreens();
}
