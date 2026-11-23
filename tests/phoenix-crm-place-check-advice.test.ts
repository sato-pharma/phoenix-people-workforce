import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  adviseOnBuilding,
  adviseOnHeldRow,
  adviseOnPlaceInUse,
  adviseOnReview,
  adviseOnSign,
  adviseOnTimetable,
  GOOGLE_SIGN_MATCH_CODE,
  PLACE_CHECK_ADVICE_KIND_CODES,
  PLACE_CHECK_ADVICE_LABEL,
  placeCheckAdviceKindLabel,
  type HeldRowEvidence,
  type PlaceCheckAdvice,
} from "../src/lib/phoenix-crm/place-check-advice.ts";
import { stripComments } from "./support/comment-strip.ts";
import { placeCheckListSourceAt } from "./support/place-check-list-source.ts";

/**
 * The system's recommendation on every place check (owner, 2026-10-17: "add system recommendations to
 * approve or no on every validation", then "and the reason of system recommendation").
 *
 * 🔴 THE TABLE IS HIS OWN DECISIONS (the rebuild, 23 Nov 2026;
 * `docs/approvals-rebuild-2026-11-place-checks.md`). The advice said Reject, reason filled in, on
 * evidence he mostly approved. Each case below that reads "look" where it once read "reject" carries the count that moved it.
 *
 * Four things here would break silently:
 * - a Reject that opens on a reason the system never actually saw — an unreadable photo pre-picking
 *   "the timetable does not name this customer" is one click from telling a rep something false;
 * - a kind the page calls ready, or sure, that he did not agree with 19 times in 20;
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

  assert.equal(match.code, "sign_match");
  assert.equal(match.confident, true, "a sign naming the customer is one the page may call ready (117 of 117, and 0 of 167 rejected since)");

  // 🔴 HE APPROVED 135 OF THE 182 THE DOOR HELD FOR THIS, AND 46 OF 49 GOOGLE HELD (23 Nov 2026).
  const other = note(adviseOnSign({ verdict: "other_name", reason: null, signText: "صيدلية النور" }));
  assert.equal(other.kind, "look", "HEADLINE: a sign naming somebody else is his own look, never a recommended rejection");
  assert.equal(other.refusal, null, "HEADLINE: and Reject opens on no reason");
  assert.equal(other.code, "sign_other_name");
  assert.equal(other.confident, false);
  assert.match(other.reason, /names somebody else, not the customer\. Compare the two names yourself\./);
  assert.equal(other.quote, "صيدلية النور", "what was read is still quoted");

  // 🔴 HE APPROVED 21 OF 34 (23 Nov 2026): a sign is in the photo, the name was not found on it.
  const none = note(adviseOnSign({ verdict: "no_name", reason: null, signText: null }));
  assert.equal(none.kind, "look", "HEADLINE: a photo with no sign NAMING the customer is his own look");
  assert.equal(none.refusal, null);
  assert.equal(none.code, "sign_no_name");
  // The one kind he rejected almost every time (20 of 21): no sign in the photo at all.
  const noPlate = note(adviseOnSign({ verdict: "no_name", reason: null, signText: null, problem: "no_plate" }));
  assert.equal(noPlate.kind, "reject", "HEADLINE: a photo with no sign in it at all is still a recommended rejection");
  assert.equal(noPlate.refusal, "no_signboard");
  assert.equal(noPlate.confident, true, "and the one rejection the page may call sure");
  assert.equal(noPlate.code, "sign_no_plate");

  // 🔴 A SIGN NOBODY COULD READ IS HIS LOOK (23 Nov 2026): he approved more of them than he rejected.
  const final = note(adviseOnSign({ verdict: "unjudged", reason: "unreadable_final", signText: null }));
  assert.equal(final.kind, "look", "HEADLINE: a sign never once legible is his own look, never a recommended rejection");
  assert.equal(final.refusal, null, "🔴 and an unreadable photo NEVER pre-picks a reason — the system did not see what is wrong");
  assert.equal(final.code, "sign_unreadable");

  for (const reason of ["unreadable", "unconfirmed", "name_unusable", "call_failed", "no_api_key", "something_new"]) {
    const advice = note(adviseOnSign({ verdict: "unjudged", reason, signText: null }));
    assert.equal(advice.kind, "look", `an unjudged sign (${reason}) is the admin's own look, never a verdict`);
    assert.equal(advice.refusal, null);
  }
  assert.equal(note(adviseOnSign(null)).kind, "look", "a sign never read has no recommendation either way");

  const building = note(adviseOnBuilding({ signboard: { verdict: "other_name", reason: null, signText: "مستشفى طنطا" } }));
  assert.match(building.reason, /a different place, not the building/, "a polyclinic's sign is judged as the BUILDING's name, never a person's");
  // 🔴 A BUILDING IS RE-TABLED ON ITS OWN DECISIONS (23 Nov 2026): another name approved 20 of 33, no
  // name rejected 15 of 15, a matching sign approved 100 of 120.
  assert.equal(building.kind, "look", "HEADLINE: a building whose sign names another place is his own look");
  assert.equal(building.refusal, null);
  assert.equal(building.code, "building_sign_other_name", "a building's kinds are counted apart from a customer's");
  const buildingMatch = note(adviseOnBuilding({ signboard: { verdict: "match", reason: null, signText: "مجمع عيادات" } }));
  assert.equal(buildingMatch.kind, "approve");
  assert.equal(buildingMatch.confident, false, "HEADLINE: a building's matching sign says Approve and is NOT called ready (100 of 120)");
  const buildingBare = note(adviseOnBuilding({ signboard: { verdict: "no_name", reason: null, signText: null } }));
  assert.equal(buildingBare.kind, "reject", "a building with no sign naming it is a recommended rejection (15 of 15)");
  assert.equal(buildingBare.refusal, "no_signboard");
  assert.equal(buildingBare.confident, true);
  assert.equal(buildingBare.code, "building_sign_no_name");

  // 🔴 A LEGIBLE SIGN THAT DID NOT CONFIRM IS THE ADMIN'S LOOK, NEVER A REJECT (2026-10-18): the one-off
  // read kept "د. محمد زكي" for محمد ذكي, and five AM hospitals at their own building's sign, final.
  const legible = note(adviseOnSign({ verdict: "unjudged", reason: "unreadable_final", signText: "د. محمد زكي", problem: "none" }));
  assert.equal(legible.kind, "look", "🔴 a sign the reader called legible is never recommended for rejection as unreadable");
  assert.equal(legible.quote, "د. محمد زكي", "and the admin reads what it says");
  const buildingSign = note(adviseOnSign({ verdict: "unjudged", reason: "unreadable_final", signText: "مستشفى صدر المحلة", problem: "building_sign_only" }));
  assert.equal(buildingSign.kind, "look", "a building's own sign is the admin's look too");
  assert.equal(
    note(adviseOnSign({ verdict: "unjudged", reason: "unreadable_final", signText: "دكتور سلامة السيد البيودي", problem: "stylised" })).kind,
    "look",
    "a decorative plate is the admin's look: a new photo would read the same",
  );
  assert.equal(note(adviseOnSign({ verdict: "unjudged", reason: "unreadable_final", signText: null, problem: "too_far" })).kind, "look", "a plate too far to read is his own look too");

  // 🔴 A NEW PHOTO ALREADY ASKED FOR IS WAITED FOR, NEVER REJECTED (owner, 2026-10-19: 289 of the 349
  // Not readable places were sent back and each still recommended Reject).
  const asked = note(adviseOnSign({ verdict: "unjudged", reason: "unreadable_final", signText: null, problem: "too_far", retake: true }));
  assert.equal(asked.kind, "look", "🔴 a place whose rep is retaking the photo is never recommended for rejection");
  assert.match(asked.reason, /asked for a new photo/, "and the advice says the new photo is on its way");
  assert.equal(asked.refusal, null);
}

function checkTimetable() {
  const match = note(adviseOnTimetable({ verdict: "match", scheduleText: "د. جورج موسى", hoursRead: "السبت ٤-٨" }));
  assert.equal(match.kind, "approve");
  assert.equal(match.quote, "السبت ٤-٨", "a match quotes the hours read beside the name");
  assert.equal(match.confident, false, "HEADLINE: a timetable naming the customer says Approve and is NOT called ready (he approved 116 of 143)");
  assert.equal(match.code, "timetable_match");

  // 🔴 HE APPROVED 10 OF THESE 16 (23 Nov 2026): the name written another way, or on a part not read.
  const other = note(adviseOnTimetable({ verdict: "other_name", scheduleText: "د. كريم · د. سلمى", hoursRead: null, legibility: "clear" }));
  assert.equal(other.kind, "look", "HEADLINE: a timetable read without the customer's name is his own look");
  assert.equal(other.refusal, null, "HEADLINE: and Reject opens on no reason");
  assert.equal(other.code, "timetable_other_name");
  assert.match(other.reason, /may be written another way/);
  const otherPaper = note(adviseOnTimetable({ verdict: "other_name", scheduleText: null, hoursRead: null, problem: "not_a_timetable" }));
  assert.equal(otherPaper.kind, "reject", "unless the reading said the photo is not a timetable at all");
  assert.equal(otherPaper.refusal, "schedule_missing");

  // 🔴 A HOLD FROM BEFORE THE READING SAID WHY: he approved 19 of those 22, so it is his look. Once the
  // reading says the photo is not a timetable, he rejected 57 of 68: Reject, its reason filled in, and
  // still not one the page calls sure.
  const missing = note(adviseOnTimetable({ verdict: "no_schedule", scheduleText: null, hoursRead: null }));
  assert.equal(missing.kind, "look", "HEADLINE: 'no timetable' with no reason kept is his own look");
  assert.equal(missing.refusal, null);
  assert.equal(missing.code, "timetable_not_found");
  const notOne = note(adviseOnTimetable({ verdict: "no_schedule", scheduleText: null, hoursRead: null, problem: "not_a_timetable" }));
  assert.equal(notOne.kind, "reject", "a photo of a street or a floor is not a timetable");
  assert.equal(notOne.refusal, "schedule_missing");
  assert.equal(notOne.confident, false, "HEADLINE: 57 of 68 is not 19 in 20, so the page never calls it sure");
  assert.equal(note(adviseOnTimetable({ verdict: "no_schedule", scheduleText: null, hoursRead: null, heldBecause: "timetable_missing" })).refusal, "schedule_missing");

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
  const onScreen = note(adviseOnTimetable({ verdict: "no_schedule", scheduleText: null, hoursRead: null, reason: "schedule_missing", problem: "on_a_screen" }));
  // 🔴 A SCREEN PHOTO IS HELD FOR HIM, NEVER REFUSED (owner, 2026-10-28: "some polyclinics have their timetable only online").
  assert.equal(onScreen.kind, "look", "🔴 a timetable photographed off a screen is his to look at, never a recommended rejection");
  assert.equal(onScreen.refusal, null, "and no refusal is pre-picked");
  assert.match(onScreen.reason, /phone or computer screen/, "the reason says it was a screen, not a missing timetable");
  assert.match(onScreen.reason, /only online/, "and why that can be right");
  const heldOnScreen = note(adviseOnTimetable({ verdict: "unjudged", scheduleText: null, hoursRead: null, reason: null, heldBecause: "timetable_on_a_screen" }));
  assert.equal(heldOnScreen.kind, "look", "the scanner's own on-a-screen hold reads the same");

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
  // The door's own hold speaks, whatever the place's stored reading has become since.
  const signOther = note(adviseOnHeldRow(held({ reason: "sign_other_name", signText: "عيادة اخرى", evidence: { signboard: { verdict: "match", reason: null, signText: "x" } } })));
  assert.equal(signOther.kind, "look", "HEADLINE: the 197 the door held for another name open on no recommended rejection");
  assert.equal(signOther.refusal, null);
  assert.equal(signOther.quote, "عيادة اخرى", "and it quotes what the HOLD read, not a later reading");
  const signNone = note(adviseOnHeldRow(held({ reason: "sign_no_name" })));
  assert.equal(signNone.kind, "look");
  assert.equal(signNone.refusal, null);
  const signBare = note(adviseOnHeldRow(held({ reason: "sign_no_name", evidence: { signboard: { verdict: "no_name", reason: "sign_no_name", signText: null, problem: "no_plate" } } })));
  assert.equal(signBare.kind, "reject", "a hold whose reading found no sign at all keeps its recommended rejection (12 of 12)");
  assert.equal(signBare.refusal, "no_signboard");
  assert.equal(signBare.confident, true);

  // A Google hold: the sign at the door is the stronger witness, and Google is named beside it.
  const googleButSign = note(
    adviseOnHeldRow(held({ reason: "no_confident_listing", evidence: { signboard: { verdict: "match", reason: null, signText: "مستشفى السلام" } } })),
  );
  assert.equal(googleButSign.kind, "approve", "the sign names the customer, so Google's silence does not sink the place");
  assert.match(googleButSign.reason, /although Google has no listing/);
  // 🔴 THE SIGN WINS (owner, 23 Nov 2026): this kind is the one the system approves itself.
  assert.equal(googleButSign.code, GOOGLE_SIGN_MATCH_CODE);
  assert.equal(GOOGLE_SIGN_MATCH_CODE, "google_sign_match");
  assert.equal(googleButSign.confident, true, "he approved all 117");

  const far = note(adviseOnHeldRow(held({ reason: "listing_far", nearestListingMeters: 1840, evidence: { signboard: null } })));
  assert.equal(far.kind, "look", "Google far away and no sign read: no recommendation either way");
  assert.match(far.reason, /1\.8 km from where the rep stood/, "and the distance is said in plain units");
  assert.match(far.reason, /^Google's listing .+\. This sign has not been read/, "Google's half, then the sign's own sentence");
  assert.equal(far.code, "google_sign_unread");

  const farAndWrong = note(
    adviseOnHeldRow(held({ reason: "listing_far", nearestListingMeters: 640, evidence: { signboard: { verdict: "other_name", reason: null, signText: "x" } } })),
  );
  assert.equal(farAndWrong.kind, "look", "HEADLINE: Google far AND a sign naming somebody else is still his look (he approved 46 of 49)");
  assert.equal(farAndWrong.refusal, null);
  assert.equal(farAndWrong.code, "google_sign_other_name");
  assert.match(farAndWrong.reason, /640 m/);
  const farAndBare = note(
    adviseOnHeldRow(held({ reason: "listing_far", nearestListingMeters: 640, evidence: { signboard: { verdict: "no_name", reason: null, signText: null, problem: "no_plate" } } })),
  );
  assert.equal(farAndBare.kind, "reject");
  assert.equal(farAndBare.refusal, "no_signboard");
  assert.match(farAndBare.reason, /no sign at all: a street, a wall or a bare door, and Google's listing for this customer is 640 m/);

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
    // The kind, kept with his decision and counted by the meter: a code, and never one without words.
    assert.match(advice.code, /^[a-z]+(_[a-z]+)+$/, `a kind is a code: ${advice.code}`);
    assert.notEqual(placeCheckAdviceKindLabel(advice.code), "Another kind", `every kind the advice can give has its words: ${advice.code}`);
    assert.ok(!/[a-z]+_[a-z]+/.test(placeCheckAdviceKindLabel(advice.code)), "and the words are never the code");
    // 🔴 What the page may call ready, or sure: never a look, and a sure rejection always has its reason.
    if (advice.kind === "look") assert.equal(advice.confident, false, `a look is never called sure: ${advice.code}`);
    if (advice.kind === "reject" && advice.confident) assert.notEqual(advice.refusal, null, `a sure rejection opens on its reason: ${advice.code}`);
  }
  // One kind, one answer: the meter counts agreement per kind, so a kind never means two things.
  const kindOf = new Map<string, string>();
  for (const advice of seen) {
    assert.equal(kindOf.get(advice.code) ?? advice.kind, advice.kind, `${advice.code} is always ${advice.kind}`);
    kindOf.set(advice.code, advice.kind);
  }
  // 🔴 THE WHOLE LIST OF WHAT THE PAGE MAY CALL READY OR SURE. Adding to it needs the number that earns it.
  assert.deepEqual(
    [...new Set(seen.filter((advice) => advice.confident).map((advice) => `${advice.kind}:${advice.code}`))].sort(),
    ["approve:google_sign_match", "approve:sign_match", "reject:building_sign_no_name", "reject:google_sign_no_plate", "reject:sign_no_plate"],
    "HEADLINE: these five kinds, and no other, are confident",
  );
  for (const code of PLACE_CHECK_ADVICE_KIND_CODES) {
    assert.ok(placeCheckAdviceKindLabel(code).length > 5, `${code} has words`);
    assert.equal(placeCheckAdviceKindLabel(`google_${code}`), `Google held · ${placeCheckAdviceKindLabel(code)}`);
    assert.equal(placeCheckAdviceKindLabel(`building_${code}`), `Building · ${placeCheckAdviceKindLabel(code)}`);
  }
  assert.equal(placeCheckAdviceKindLabel("a_kind_from_an_older_build"), "Another kind", "an unknown kind is never shown as its code");
  assert.equal(placeCheckAdviceKindLabel(null), "Not recorded");
}

function checkScreens() {
  const files = [
    "src/components/phoenix-crm/validation-review-queue.tsx",
    "src/components/phoenix-crm/validated-place-list.tsx",
    "src/components/phoenix-crm/shared-place-list.tsx",
    "src/components/phoenix-crm/shared-place-customers.tsx",
  ];
  for (const file of files) {
    const source = stripComments(placeCheckListSourceAt(file, read));
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
