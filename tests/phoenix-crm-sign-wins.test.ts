import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { GOOGLE_SIGN_MATCH_CODE, type SignEvidence } from "../src/lib/phoenix-crm/place-check-advice.ts";
import {
  adviceOnReviewRecord,
  AGREEMENT_READY_MIN_DECISIONS,
  agreementSentence,
  placeCheckAgreement,
  storedAdviceOf,
  type AgreementDecision,
} from "../src/lib/phoenix-crm/place-check-stored-advice.ts";
import {
  GOOGLE_HOLD_REASONS,
  SIGN_WINS_NOTE,
  SIGN_WINS_RULE,
  SIGN_WINS_STARTED_AT,
  signWinsSentence,
  signWinsSwitch,
  signWinsVerdict,
  type SignWinsCandidate,
} from "../src/lib/phoenix-crm/sign-wins-rules.ts";
import { stripComments } from "./support/comment-strip.ts";
import { placeCheckSplitSource } from "./support/place-check-split-source.ts";

/**
 * "The sign wins", the advice a decision keeps, and the 30-day agreement (the Place checks rebuild,
 * owner 23 Nov 2026: "REBUILD FROM SCRATCH", then "Yes, the sign wins (Recommended)").
 *
 * What would break silently, each pinned below:
 * - the system approving a place it was told to leave: a short-named clinic customer, a place with an
 *   open integrity case, one the SFE Manager recommended on, a seating, a sign or timetable hold, a test
 *   entry, a place captured before the rule began;
 * - the rule staying on after he took back more than 1 in 20;
 * - a failed read approving something;
 * - the Super Admin being told about a hold that is approved a second later, or NOT being told about
 *   one the rule left;
 * - a take-back overwriting the advice the first decision kept;
 * - "Check it yourself" being scored as an agreement or a disagreement;
 * - a place the system approved itself being counted as his agreement.
 */

const ROOT = new URL("../", import.meta.url);

function read(path: string): string {
  return readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n");
}

function code(path: string): string {
  return stripComments(read(path));
}

/** A place the rule approves: every other case below changes one thing about it. */
function candidate(overrides: Partial<SignWinsCandidate> = {}): SignWinsCandidate {
  return {
    reviewStatus: "pending",
    isTest: false,
    holdVerdict: "held",
    holdReason: "no_confident_listing",
    createdAt: "2026-11-24T09:00:00+02:00",
    placeStatus: "active",
    sharedPlaceId: null,
    hasPhoto: true,
    signVerdict: "match",
    needsFullName: false,
    openIntegrityCase: false,
    sfeRecommended: false,
    ...overrides,
  };
}

function left(overrides: Partial<SignWinsCandidate>): string {
  const verdict = signWinsVerdict(candidate(overrides));
  return verdict.applies ? "approved" : verdict.because;
}

function checkTheRule() {
  assert.deepEqual(signWinsVerdict(candidate()), { applies: true }, "only Google held it and the sign names the customer: the system approves");
  for (const reason of GOOGLE_HOLD_REASONS) {
    assert.equal(left({ holdReason: reason }), "approved", `every kind of Google hold is the rule's (${reason})`);
  }

  assert.equal(left({ reviewStatus: "approved" }), "decided", "a place already decided is never touched");
  assert.equal(left({ reviewStatus: "rejected" }), "decided");
  assert.equal(left({ isTest: true }), "test_entry", "a test entry is never approved");
  assert.equal(left({ holdVerdict: "signboard", holdReason: "sign_other_name" }), "not_a_google_hold", "a hold the sign raised is the re-read's, never this rule's");
  assert.equal(left({ holdVerdict: "signboard" }), "not_a_google_hold", "even when the record names a Google reason beside it");
  assert.equal(left({ holdVerdict: "schedule", holdReason: "schedule_missing" }), "not_a_google_hold", "a timetable hold is his");
  assert.equal(left({ holdReason: "refused_by_admin" }), "not_a_google_hold", "a place he refused by hand is not a Google hold");
  assert.equal(left({ holdReason: null }), "not_a_google_hold", "a hold with no reason on record is left");
  assert.equal(left({ createdAt: "2026-11-22T23:59:59+02:00" }), "before_the_rule", "nothing that waited before he chose the rule is approved by it");
  assert.equal(left({ createdAt: null }), "before_the_rule", "a row with no date cannot be read, so it is left");
  assert.equal(left({ createdAt: "not a date" }), "before_the_rule");
  assert.equal(left({ createdAt: SIGN_WINS_STARTED_AT }), "approved", "the instant the rule began is inside it");
  assert.equal(left({ placeStatus: "retired" }), "place_not_in_use", "a place no longer in use is nobody's to approve");
  // Owner, 20 Nov 2026: "must have a photo except i tell u". A sign reading with no photograph behind it approves nothing.
  assert.equal(left({ hasPhoto: false }), "no_photo", "the system never approves a place nobody photographed, whatever its sign reading says");
  assert.ok(
    code("src/lib/phoenix-crm/server/sign-wins.ts").includes("hasPhoto: text(place.photo_path) !== null"),
    "the photograph is read from the place itself, and an empty path is no photograph",
  );
  assert.equal(left({ sharedPlaceId: "b0b0b0b0-0000-4000-8000-000000000001" }), "seated_in_a_building", "a customer seated in a building is his alone");
  for (const sign of ["other_name", "no_name", "unjudged", null]) {
    assert.equal(left({ signVerdict: sign }), "sign_does_not_name_the_customer", `only a sign that names the customer wins (${String(sign)})`);
  }
  assert.equal(left({ needsFullName: true }), "short_name", "a clinic customer short of three names is never approved (owner, 2026-11-07)");
  assert.equal(left({ openIntegrityCase: true }), "integrity_case_open", "a place with an unsettled integrity case is his to read first");
  assert.equal(left({ sfeRecommended: true }), "sfe_recommended", "a place the SFE Manager recommended on waits on that page");

  assert.equal(SIGN_WINS_RULE, "sign_wins", "the value the migration's CHECK allows");
  const migration = read("supabase/migrations/20261123052511_place_check_system_advice.sql");
  assert.ok(migration.includes(`system_approved_rule in ('${SIGN_WINS_RULE}')`), "and the database allows exactly that value");
  assert.ok(!/reject|refus/i.test(SIGN_WINS_NOTE), "the note beside the system's approval never speaks of a rejection");
  assert.ok(!SIGN_WINS_NOTE.includes("doctor") && !SIGN_WINS_NOTE.includes("account"), "nor uses a word the module's screens never use");
}

function checkTheSwitch() {
  assert.equal(signWinsSwitch({ approvals: 0, takeBacks: 0 }).on, true, "the rule starts on");
  assert.equal(signWinsSwitch({ approvals: 40, takeBacks: 2 }).on, true, "2 in 40 is exactly 1 in 20: still on");
  assert.equal(signWinsSwitch({ approvals: 40, takeBacks: 3 }).on, false, "3 in 40 is more than 1 in 20: off");
  assert.equal(signWinsSwitch({ approvals: 10, takeBacks: 1 }).on, false, "with few approvals the first take-back stops it");
  assert.equal(signWinsSwitch({ approvals: 20, takeBacks: 1 }).on, true);
  assert.deepEqual(signWinsSwitch({ approvals: 3, takeBacks: 9 }), { on: false, approvals: 3, takeBacks: 3 }, "take-backs are never more than what was approved");
  assert.deepEqual(signWinsSwitch({ approvals: -4, takeBacks: -1 }), { on: true, approvals: 0, takeBacks: 0 });

  const none = signWinsSentence(signWinsSwitch({ approvals: 0, takeBacks: 0 }));
  assert.ok(none.includes("It has approved none in the last 30 days."), "an empty window says none, never a count of nothing");
  const some = signWinsSentence(signWinsSwitch({ approvals: 12, takeBacks: 0 }));
  assert.ok(some.includes("approved 12 places by itself") && some.includes("You took none back."), some);
  assert.ok(signWinsSentence(signWinsSwitch({ approvals: 1, takeBacks: 0 })).includes("approved 1 place by itself"), "one place is singular");
  const off = signWinsSentence(signWinsSwitch({ approvals: 10, takeBacks: 1 }));
  assert.ok(off.startsWith("The system has stopped approving by itself"), "a rule that is off says so first");
  assert.ok(off.includes("you took back 1 of the 10 places"), off);
  for (const sentence of [none, some, off]) {
    assert.ok(!sentence.includes("…") && !sentence.includes("..."), "no ellipsis on a screen string");
    assert.ok(!/sign_wins|google_/.test(sentence), "and never a code");
  }
}

function checkTheServer() {
  const server = code("src/lib/phoenix-crm/server/sign-wins.ts");
  assert.ok(server.includes("signWinsVerdict(candidate)"), "the server asks the rule, and decides nothing itself");
  assert.ok(server.includes("approveHeldSignboardBySystem(reviewId, SIGN_WINS_NOTE)"), "one approve path: the system's own, with this rule's sentence");
  assert.ok(!server.includes("phoenix_crm_decide_validation_review"), "it never calls the decision function directly, which would pass the short-name gate by");
  assert.ok(!/decision: "reject"|refusal_reason/.test(server), "it only ever says yes");
  assert.ok(server.includes("isSettledIntegrityRow(row)"), "an integrity case is open or settled by the table's one rule");
  assert.ok(server.includes('query.eq("subject_kind", "place")'), "and only a case about a place");
  assert.ok(server.includes('row.writer_role === "sfe_manager" && parsePlaceRecommendation(row.recommendation) !== null'), "an SFE recommendation is read as the board reads it");
  assert.ok(server.includes("if (!place || !customer) continue;"), "a place or customer that was not read is left");
  assert.ok(server.includes('if (!(await readSignWinsSwitch()).on) return { approved: false, because: "switched_off" };'), "the door asks the switch before approving");
  assert.ok(server.includes("if (!(await readSignWinsSwitch()).on) return { ...result, switchedOff: true };"), "and so does the hourly pass");
  // A switch that could not be read is never read as "nothing was taken back": the read throws, and both
  // callers above answer a throw by approving nothing.
  const switchRead = server.slice(server.indexOf("export async function readSignWinsSwitch("), server.indexOf("async function loadCandidates("));
  const failsAt = switchRead.indexOf("if (read.error) throw read.error;");
  assert.ok(failsAt > 0 && failsAt < switchRead.indexOf("return signWinsSwitch("), "a failed read of the switch throws before any count is made of it");
  assert.ok(server.includes("if (read.error) throw read.error;"), "a switch that cannot be read is never read as on");
  assert.ok(server.includes('.eq("is_test", false)'), "test entries are in neither the count nor the pass");
  assert.ok(server.includes('.gte("created_at", SIGN_WINS_STARTED_AT)'), "the pass never reaches back before the rule");
  assert.ok(server.includes("passing.slice(0, SIGN_WINS_SWEEP_LIMIT)"), "one run approves a bounded number");
  // The mark is written only on the row the system itself approved.
  const mark = server.slice(server.indexOf("system_approved_rule: SIGN_WINS_RULE"));
  assert.ok(mark.includes('.eq("status", "approved")') && mark.includes('.eq("decided_by_hr_id", SIGNBOARD_SYSTEM_ACTOR)'), "his own decision is never marked as the rule's");
  assert.ok(server.includes(`storedAdviceOf({ kind: "approve", code: GOOGLE_SIGN_MATCH_CODE })`), "the mark keeps the advice the system acted on");
  assert.equal(GOOGLE_SIGN_MATCH_CODE, "google_sign_match");
  // 🔴 THE MARK IS WRITTEN AGAIN WHEN IT FAILS: the switch counts marked rows only, so an approval left
  // unmarked is one whose take-back could never stop the rule (the CRM review of pull request 700).
  assert.ok(server.includes("const SIGN_WINS_MARK_ATTEMPTS = 3;"), "three tries");
  const tries = server.slice(server.indexOf("for (let attempt = 1; attempt <= SIGN_WINS_MARK_ATTEMPTS; attempt += 1) {"), server.indexOf("Phoenix CRM sign-wins approval was not marked"));
  assert.ok(tries.includes("system_approved_rule: SIGN_WINS_RULE") && tries.includes("if (!error) break;"), "the same guarded write each time, and it stops at the first one that lands");
  assert.ok(tries.includes("system_approved_at: approvedAt"), "one instant for every try, so a second write never moves when it was approved");
  // A take-back is the row turned rejected with its mark still on it.
  assert.ok(server.includes('takeBacks: read.rows.filter((row) => row.status === "rejected").length'), "a take-back is counted from the review's own status");

  const holds = code("src/lib/phoenix-crm/server/signboard-holds.ts");
  assert.ok(holds.includes("export async function approveHeldSignboardBySystem(reviewId: string, note: string = SIGNBOARD_SYSTEM_APPROVAL_NOTE)"), "the held-sign approval keeps its own sentence by default");
  const approve = holds.slice(holds.indexOf("export async function approveHeldSignboardBySystem"), holds.indexOf("export async function settleHeldSignboard"));
  assert.ok(approve.indexOf("heldReviewNeedsFullName(reviewId)") < approve.indexOf("phoenix_crm_decide_validation_review"), "and still asks the short-name gate before approving");

  // Both doors: told only if the rule left it, and the rule runs after the door's record is on the place.
  //
  // 🔴 THE DOOR READS NO SIGN FOR A PLACE GOOGLE HOLDS, so the condition must name that state and the
  // sign must be read after the reply. On the rule's first day (23 Nov 2026) the condition asked for a
  // door reading of "match", which a Google hold can never carry: all four Google holds of the day were
  // `held_elsewhere` and the system approved none.
  const list = code("src/lib/phoenix-crm/server/list.ts");
  assert.match(list, /const check = heldElsewhere\s+\? signboardUnjudged\("held_elsewhere"\)/, "a place Google holds is given held_elsewhere at the door, with no read");
  for (const [who, name] of [
    ["validated", "validateCustomer"],
    ["added", "the second place's door"],
  ] as const) {
    const may = `const signMayWin = ${who}.held && !heldBySignboard && heldReviewId !== null && signboard?.check.reason === "held_elsewhere";`;
    assert.ok(list.includes(may), `${name} offers the rule every place Google held whose sign the door did not read`);
    assert.ok(!list.includes(`const signMayWin = ${who}.held && !heldBySignboard && heldReviewId !== null && signboard?.check.verdict === "match";`), `${name} never waits for a door reading a Google hold cannot have`);
    assert.ok(list.includes(`if (${who}.held && !isTest && !signboardHold && !signMayWin) {`), `${name} does not tell him at once about a hold the rule may clear`);
    const body = list.slice(list.indexOf(may));
    const record = body.indexOf(`recordPlaceSignboard(${who}.placeId, keptSignboard.check)`);
    const win = body.indexOf(`const won = await signWinsAfterGoogleHold(heldReviewId, ${who}.placeId);`);
    assert.ok(record > 0 && win > record, `${name} reads the sign and runs the rule after its own record is on the place`);
    const after = body.slice(win, win + 400);
    assert.ok(
      after.includes("if (!won.approved && !isTest) {") && after.includes(`notifyValidationReviewWaiting({ customerName: ${who}.customerName, seat, repHrId: viewer.hrId, reviewId: heldReviewId })`),
      `${name} tells him about every hold the rule left`,
    );
  }
  assert.ok(!list.includes("signWinsAtTheDoor("), "no door asks the rule without reading the sign first");
  const afterHold = server.slice(server.indexOf("export async function signWinsAfterGoogleHold"), server.indexOf("export type SignWinsSweepResult"));
  assert.ok(
    afterHold.indexOf("await readPlaceSignboardNow(placeId);") > 0 && afterHold.indexOf("await readPlaceSignboardNow(placeId);") < afterHold.indexOf("return signWinsAtTheDoor(reviewId);"),
    "the sign is read before the rule is asked",
  );
  // The read is the night's own, for one place: same backlog test, same step, so a photo is paid for once.
  const sweep = code("src/lib/phoenix-crm/server/signboard-sweep.ts");
  const now = sweep.slice(sweep.indexOf("export async function readPlaceSignboardNow"), sweep.indexOf("export async function runPhoenixCrmSignboardSweep"));
  assert.ok(now.includes("const [place] = await loadBacklog(1, placeId);") && now.includes("return place ? await readRecordAndFlag(place) : null;"), "one place is read through the night's backlog test and the night's step");
  assert.ok(sweep.includes("      const check = await readRecordAndFlag(place);"), "and the night runs that same step");
  const rereads = sweep.slice(sweep.indexOf("export const SIGNBOARD_REREAD_REASONS = ["), sweep.indexOf("] as const;", sweep.indexOf("export const SIGNBOARD_REREAD_REASONS = [")));
  assert.ok(rereads.includes(`"held_elsewhere"`), "a place the door left unread is one the pass reads");

  const cron = code("app/api/cron/phoenix-crm-visit-rollup/route.ts");
  assert.ok(cron.includes('await afterResponse("phoenix_crm_sign_wins_sweep", async () => {') && cron.includes("await runSignWinsSweep();"), "the hourly pass rides the roll-up, after the reply");
  assert.ok(cron.indexOf("runHeldSignboardRecheck()") < cron.indexOf("runSignWinsSweep()"), "after the held signs are re-read");
}

const MATCH: SignEvidence = { verdict: "match", reason: null, signText: "صيدلية النور" };

function checkTheStoredAdvice() {
  const google = adviceOnReviewRecord({ google: { verdict: "held", reason: "listing_far" }, signboard: MATCH, nearestListingMeters: 640, buildingHasNoTimetable: false });
  assert.deepEqual(storedAdviceOf(google), { system_advice_at_decision: "approve", system_advice_code_at_decision: GOOGLE_SIGN_MATCH_CODE }, "a Google hold whose sign names the customer keeps the kind the rule acts on");
  assert.ok(google.reason.includes("640 m"), "and it is the advice the page showed, the listing's distance included");

  const sign = adviceOnReviewRecord({
    google: { verdict: "signboard", reason: "sign_other_name", signText: "مركز الشفاء" },
    signboard: { verdict: "other_name", reason: null, signText: "مركز الشفاء" },
    nearestListingMeters: null,
    buildingHasNoTimetable: false,
  });
  assert.deepEqual(storedAdviceOf(sign), { system_advice_at_decision: "look", system_advice_code_at_decision: "sign_other_name" }, "another name on the sign keeps Check it yourself");
  assert.equal(sign.quote, "مركز الشفاء", "read from the hold's own record");

  const timetable = { verdict: "schedule", reason: "schedule_missing", scheduleText: null, problem: "not_a_timetable" };
  const missing = adviceOnReviewRecord({ google: timetable, signboard: null, nearestListingMeters: null, buildingHasNoTimetable: false });
  assert.equal(missing.kind, "reject", "a photo that is not a timetable keeps Reject");
  assert.equal(missing.code, "timetable_missing");
  const exempt = adviceOnReviewRecord({ google: timetable, signboard: null, nearestListingMeters: null, buildingHasNoTimetable: true });
  assert.equal(exempt.code, "timetable_exempt", "in a building declared to have no timetable, the decision keeps what its panel showed");
  const notSeated = adviceOnReviewRecord({ google: { verdict: "held", reason: "listing_far" }, signboard: MATCH, nearestListingMeters: 640, buildingHasNoTimetable: true });
  assert.equal(notSeated.code, GOOGLE_SIGN_MATCH_CODE, "the building's declaration never reaches a place that is not a timetable hold");

  for (const broken of [null, undefined, "x", 4, [], { verdict: 7, reason: 9 }]) {
    const advice = adviceOnReviewRecord({ google: broken, signboard: null, nearestListingMeters: null, buildingHasNoTimetable: false });
    assert.equal(advice.kind, "look", "a record that cannot be read keeps Check it yourself, never an answer");
  }

  // The decisions keep it: read before, written after, only on a waiting row, never overwritten.
  const reviews = placeCheckSplitSource("validation-reviews", code);
  const decide = reviews.slice(reviews.indexOf("export async function decideValidationReview"), reviews.indexOf("export async function restoreValidation"));
  const readAt = decide.indexOf("const adviceThen = await adviceOnWaitingReview(reviewId);");
  const rpcAt = decide.indexOf('callPhoenixCrm<Row>("phoenix_crm_decide_validation_review"');
  const keepAt = decide.indexOf("await keepReviewAdviceQuietly(reviewId, adviceThen);");
  assert.ok(readAt > 0 && readAt < rpcAt && rpcAt < keepAt, "a review's advice is read while it waits and kept once the decision has landed");
  const waiting = reviews.slice(reviews.indexOf("async function adviceOnWaitingReview"), reviews.indexOf("export async function decideValidationReview"));
  assert.ok(waiting.includes('review.status !== "pending") return null;'), "a take-back of a decided review keeps nothing new");
  assert.ok(waiting.includes("signboardOf(place.signboard_check)") && waiting.includes("listingsOf(google,"), "built by the board row's own readers");
  assert.ok(waiting.includes("} catch (error) {") && waiting.includes("return null;"), "and a decision is never refused because its advice could not be read");
  const restore = reviews.slice(reviews.indexOf("export async function restoreValidation"), reviews.indexOf("export type ValidatedPlaceRow"));
  assert.ok(!restore.includes("keepReviewAdviceQuietly"), "approving a rejection after all changes the outcome, never the advice");

  const buildings = code("src/lib/phoenix-crm/server/shared-places.ts");
  const decideBuilding = buildings.slice(buildings.indexOf("export async function decideSharedPlace"));
  const readB = decideBuilding.indexOf("const adviceThen = await adviceOnHeldBuilding(");
  const rpcB = decideBuilding.indexOf('callPhoenixCrm<Row>("phoenix_crm_decide_shared_place"');
  const keepB = decideBuilding.indexOf("await keepBuildingAdviceQuietly(String(result.shared_place_id), adviceThen);");
  assert.ok(readB > 0 && readB < rpcB && rpcB < keepB, "a building's advice is read while it is held and kept once decided");
  assert.ok(buildings.includes('if (!venue || venue.status !== "held") return null;'), "only a building still held");

  const kept = code("src/lib/phoenix-crm/server/stored-advice.ts");
  assert.ok(kept.includes('.update(storedAdviceOf(advice)).eq("id", id).is("system_advice_at_decision", null)'), "the first decision's advice is never overwritten");
  assert.ok(kept.includes("if (!advice) return;"), "and nothing is written where none was read");
  assert.equal((kept.match(/\.eq\("is_test", false\)/g) ?? []).length, 2, "test entries are in neither half of the meter");
  assert.equal((kept.match(/whenFull: "refuse"/g) ?? []).length, 2, "and a count that cannot be read whole is refused, never a share of part of it");
}

function decided(advice: string | null, kind: string | null, outcome: "approved" | "rejected", bySystem = false): AgreementDecision {
  return { advice, code: kind, outcome, bySystem };
}

function checkTheAgreement() {
  const empty = placeCheckAgreement([]);
  assert.deepEqual(empty, { decided: 0, scored: 0, agreed: 0, bySystem: 0, takenBack: 0, kinds: [] });
  assert.ok(agreementSentence(empty).startsWith("No decision has kept the system's advice yet."), "the meter starts empty and says so");

  const meter = placeCheckAgreement([
    decided("approve", "sign_match", "approved"),
    decided("approve", "sign_match", "approved"),
    decided("approve", "sign_match", "rejected"),
    decided("reject", "timetable_missing", "rejected"),
    decided("reject", "timetable_missing", "approved"),
    decided("look", "sign_other_name", "approved"),
    decided("look", "sign_other_name", "rejected"),
    decided("approve", GOOGLE_SIGN_MATCH_CODE, "approved", true),
    decided("approve", GOOGLE_SIGN_MATCH_CODE, "approved", true),
    decided("approve", GOOGLE_SIGN_MATCH_CODE, "rejected", true),
    decided(null, null, "approved"),
    decided("maybe", "sign_match", "approved"),
    decided("approve", null, "approved"),
  ]);
  assert.equal(meter.decided, 8, "his decisions that kept an advice, the take-back included; rows from before the count are left out");
  assert.equal(meter.scored, 6, "Check it yourself is counted and never scored");
  assert.equal(meter.agreed, 3, "an approve he approved and a reject he rejected are agreements");
  assert.equal(meter.bySystem, 2, "a place the system approved itself that still stands is not his agreement");
  assert.equal(meter.takenBack, 1, "and one he took back is a disagreement");
  const kind = (code: string) => meter.kinds.find((row) => row.code === code);
  assert.deepEqual(
    { decided: kind("sign_match")?.decided, agreed: kind("sign_match")?.agreed, approved: kind("sign_match")?.approved, rejected: kind("sign_match")?.rejected },
    { decided: 3, agreed: 2, approved: 2, rejected: 1 },
  );
  assert.equal(kind("sign_other_name")?.agreed, null, "a kind that only says look has no agreement to show");
  assert.equal(kind("sign_other_name")?.decided, 2);
  assert.deepEqual({ decided: kind(GOOGLE_SIGN_MATCH_CODE)?.decided, agreed: kind(GOOGLE_SIGN_MATCH_CODE)?.agreed }, { decided: 1, agreed: 0 }, "the take-back sits under its own kind");
  assert.equal(kind(GOOGLE_SIGN_MATCH_CODE)?.label, "Google held · Sign matches the name", "a kind is shown in words");
  assert.equal(meter.kinds[0].code, "sign_match", "the kinds he decided most come first");
  assert.ok(meter.kinds.every((row) => !row.meetsReady), "three decisions never earn ready");
  const sentence = agreementSentence(meter);
  assert.ok(sentence.includes("on 3 of the 6 decisions it had an answer for") && sentence.includes("On 2 more it said to check yourself."), sentence);
  assert.ok(!sentence.includes("%"), "a share of a handful is never printed as a percentage");

  const many = (agreed: number, total: number) =>
    placeCheckAgreement(Array.from({ length: total }, (_, index) => decided("approve", "timetable_match", index < agreed ? "approved" : "rejected"))).kinds[0];
  assert.equal(many(19, 20).meetsReady, true, "19 in 20 over 20 decisions is the number ready asks for");
  assert.equal(many(18, 20).meetsReady, false, "18 in 20 is not");
  assert.equal(many(AGREEMENT_READY_MIN_DECISIONS - 1, AGREEMENT_READY_MIN_DECISIONS - 1).meetsReady, false, "nor is a perfect record over too few decisions");
  assert.equal(many(116, 143).meetsReady, false, "a timetable naming the customer, on his real record, is not ready");
  const looks = placeCheckAgreement(Array.from({ length: 40 }, () => decided("look", "sign_other_name", "approved")));
  assert.equal(looks.kinds[0].meetsReady, false, "a kind that never gave an answer is never ready");
  assert.ok(agreementSentence(looks).includes("said to check yourself on all 40 decisions"), "and the sentence says so, never a share");
}

export async function runPhoenixCrmSignWinsTests(): Promise<void> {
  checkTheRule();
  checkTheSwitch();
  checkTheServer();
  checkTheStoredAdvice();
  checkTheAgreement();
}
