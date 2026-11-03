import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { caseStory, type CaseStoryInput } from "../src/lib/crm-integrity/integrity-case-story.ts";
import { parseVisitDraft } from "../src/lib/phoenix-crm/entry-rules.ts";
import {
  atTheDoor,
  checkHeldLocationIntegrity,
  checkLocationIntegrity,
  creditedHeldSeconds,
  HELD_WAIT_CONTACT_GRACE_MINUTES,
  PHOENIX_CRM_INTEGRITY_LABELS,
  PHOENIX_CRM_PRECISION_INTEGRITY_FLAGS,
  PHOENIX_CRM_STRONG_INTEGRITY_FLAGS,
  type PhoenixCrmHeldPriorFix,
  type PhoenixCrmPriorFix,
} from "../src/lib/phoenix-crm/location-integrity.ts";
import { countedIntegrityFlags, rankCountedFlags } from "../src/lib/rep-ranks/field-quality.ts";

/**
 * Phoenix CRM — a late save is not a trip, and a claimed wait is not an alibi (owner, 3 Nov 2026).
 *
 * A visit the phone held for want of signal arrives late, and the server dates it at arrival as it always has.
 * Three things can go wrong:
 *
 *   1. THE WAIT REACHES THE DATE. `queuedSeconds` is a duration on the evidence. If it ever reached the save
 *      function, a phone could date its own visit. So it stops at the provenance row.
 *   2. THE WAIT LOOKS LIKE A TRIP. Three visits held through a dead spot arrive seconds apart, kilometres apart.
 *      Judged at arrival alone that reads as impossible travel, on an honest rep who only lost signal.
 *   3. THE WAIT HIDES A TRIP. Believed outright, a forged wait makes an impossible reading disappear. His words:
 *      "this rsik is not accpeted at all must fix", then "Lower rank until settled (Recommended)".
 *
 * So the check runs twice. A trip that fits only if the wait is true is `travel_rests_on_held_wait`: never called
 * impossible, never erased, and it costs the rank until a person settles it.
 */

const source = (path: string) => readFileSync(path, "utf8");
const code = (path: string) => stripComments(source(path));

const TEN_KM_NORTH = 0.09;
const CAIRO = { lat: 30.0444, lon: 31.2357 };

/** A reading the check treats as precise, on the rep's own record. */
function fixAt(iso: string, kmNorth = 0): { lat: number; lon: number; accuracyMeters: number; capturedAt: Date } {
  return { lat: CAIRO.lat + (kmNorth / 10) * TEN_KM_NORTH, lon: CAIRO.lon + 0.000013, accuracyMeters: 15, capturedAt: new Date(iso) };
}

function prior(fix: ReturnType<typeof fixAt>, customerId: string): PhoenixCrmPriorFix {
  return { ...fix, repHrId: "MR-0412", customerId };
}

function judge(fix: ReturnType<typeof fixAt>, history: PhoenixCrmPriorFix[]) {
  return checkLocationIntegrity({ fix, repHrId: "MR-0412", customerId: "next", deviceMocked: null, readerReplaced: null, readerFindings: [], history });
}

const HELD_FLAG = "travel_rests_on_held_wait" as const;

/** Judged the way the server judges it: at arrival, and again at the door. */
function held(fix: ReturnType<typeof fixAt>, history: PhoenixCrmHeldPriorFix[], queuedSeconds: number | null, ownArrivals: Date[] = []) {
  return checkHeldLocationIntegrity({ fix, queuedSeconds, ownArrivals, repHrId: "MR-0412", customerId: "next", deviceMocked: null, readerReplaced: null, readerFindings: [], history });
}

export function runPhoenixCrmQueuedEvidenceTests(): void {
  checkTheMarkerStopsAtTheEvidence();
  checkALoneHeldVisitRaisesNothing();
  checkAWaitCorrectsAReadingAndNeverErasesIt();
  checkAClaimTheServerContradictsIsNotCredited();
  checkAWaitCannotHideAnotherReading();
  checkItCostsTheRankUntilSettled();
  checkTheCaseReadsInPlainWords();
  checkTheWiring();
  checkTheRepIsNeverTold();
}

function checkTheMarkerStopsAtTheEvidence(): void {
  const visits = code("src/lib/phoenix-crm/server/visits.ts");

  // The marker has one road in, and only a browser may walk it.
  assert.ok(visits.includes('const queuedSeconds = client === "browser" ? visit.queuedSeconds : null;'), "only a browser has this queue");
  assert.equal(visits.split("visit.queuedSeconds").length - 1, 1, "and nothing else reads the parsed value");

  // Everything sent to the save function, by name. The block runs from the call to its closing parenthesis.
  const call = visits.indexOf('callPhoenixCrm<Row>("phoenix_crm_save_visit"');
  assert.ok(call !== -1, "the save function is called from here");
  const end = visits.indexOf("\n  });", call);
  assert.ok(end > call, "and the call has an end");
  const toTheSave = visits.slice(call, end + 1);
  // One argument may use it: the phone-clock gap, in minutes, which the save stores and dates nothing by.
  const skewArgument = /^\s*device_skew_minutes: deviceClockSkewMinutes\(.*queuedSeconds\),$/m;
  assert.ok(skewArgument.test(toTheSave), "the clock check is corrected by the wait, before the save");
  assert.equal(/queued/i.test(toTheSave.replace(skewArgument, "")), false, "🔴 nothing else near the save names the wait, so it can never date a visit");

  // The wait is not a date anywhere on the way in.
  const rules = code("src/lib/phoenix-crm/visit-resend-rules.ts");
  for (const banned of ["capturedAt", "visitDate", "time-anchor", "offlineCapturedAt"]) {
    assert.equal(rules.includes(banned), false, `the retry's rules never touch ${banned}`);
  }
  const outbox = code("src/lib/phoenix-crm/visit-outbox.ts");
  assert.equal(outbox.includes("capturedAt"), false, "the sending pass adds a duration and nothing else");

  // A forged wait is a number the server bounds, and a date is simply not one.
  const draft = {
    accuracyMeters: 15,
    comment: "Discussed the new dose.",
    customerId: "11111111-1111-4111-8111-111111111111",
    kind: "single",
    lat: CAIRO.lat,
    lon: CAIRO.lon,
    pharmacyName: "El Ezaby",
    products: ["Lacto Advanced"],
  };
  const parsedWait = (queuedSeconds: unknown): number | null => {
    const parsed = parseVisitDraft({ ...draft, queuedSeconds });
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
    return parsed.value.queuedSeconds;
  };
  assert.equal(parsedWait(600), 600, "an honest wait is read");
  assert.equal(parsedWait("2026-11-01T10:00:00.000Z"), null, "a date in the field is not a wait");
  assert.equal(parsedWait(7_201), null, "nor is anything past two hours");
  assert.equal(parsedWait(undefined), null, "and a save that never waited claims nothing");
}

function checkALoneHeldVisitRaisesNothing(): void {
  // Arriving late only widens the gap from the reading before, so the arrival pass cannot trip a lone held visit.
  const before = prior(fixAt("2026-11-03T10:00:00.000Z", 0), "before");
  const fix = fixAt("2026-11-03T12:00:00.000Z", 10);
  const verdict = held(fix, [before], 3_600, [before.capturedAt, fix.capturedAt]);
  assert.deepEqual(verdict.flags, [], "🔴 a lone held visit raises nothing, so nothing is filed against the rep");
  assert.equal(verdict.strong, false);
}

function checkAWaitCorrectsAReadingAndNeverErasesIt(): void {
  // A rep logged three visits ten kilometres apart through a dead spot, each an hour apart. All three arrive together.
  const first = { ...prior(fixAt("2026-11-03T12:00:00.000Z", 0), "first"), queuedSeconds: 7_200 };
  const secondFix = fixAt("2026-11-03T12:00:03.000Z", 10);
  const second = { ...prior(secondFix, "second"), queuedSeconds: 3_603 };
  const third = fixAt("2026-11-03T12:00:06.000Z", 20);
  const contacts = [first.capturedAt, second.capturedAt, third.capturedAt];

  // The proof the correction is worth having: with no claim at all, the same visits read as an impossible trip.
  assert.ok(judge(secondFix, [first]).flags.includes("impossible_travel"), "compared at arrival, a drained queue reads as an impossible trip");

  const drained = held(third, [first, second], 6, contacts);
  assert.equal(drained.flags.includes("impossible_travel"), false, "🔴 an honest drain is never called impossible: on the phone's word, they made the trip");
  assert.ok(drained.flags.includes(HELD_FLAG), "🔴 and it is not erased either: a drained queue is read by a person");
  assert.equal(drained.strong, true, "🔴 a drained queue is strong, on his word: Lower rank until settled");
  assert.ok(Number((drained.signals.travel as { meters: number }).meters) > 9_000, "the arrival pass's numbers survive for the case story");
  assert.deepEqual(drained.signals.heldWait, { claimedSeconds: 6, creditedSeconds: 6, priorClaimedSeconds: 3_603 }, "and what was claimed and believed is on the row");

  // 🔴 THE HOLE HE REFUSED TO ACCEPT. Two hundred kilometres in thirty seconds, with a forged two-hour wait.
  const before = prior(fixAt("2026-11-03T12:00:00.000Z", 0), "before");
  const forgedFix = fixAt("2026-11-03T12:00:30.000Z", 200);
  assert.ok(judge(forgedFix, [before]).flags.includes("impossible_travel"), "with no claim it fires");
  assert.equal(judge(atTheDoor(forgedFix, 7_200), [before]).flags.includes("impossible_travel"), false, "moved back by its own claim, the trip vanishes");
  const forged = held(forgedFix, [before], 7_200, [before.capturedAt, forgedFix.capturedAt]);
  assert.ok(forged.flags.includes(HELD_FLAG), "🔴 a forged wait no longer makes the reading disappear");
  assert.equal(forged.strong, true, "🔴 and a forged wait costs the rank until he settles it");

  // A trip nobody could make even on the phone's word is still what it always was.
  const onward = { ...prior(fixAt("2026-11-03T11:59:00.000Z", 0), "onward"), queuedSeconds: 60 };
  const stillImpossible = held(fixAt("2026-11-03T12:00:30.000Z", 200), [onward], 90, []);
  assert.ok(stillImpossible.flags.includes("impossible_travel"), "impossible at the door stays impossible_travel");
  assert.equal(stillImpossible.flags.includes(HELD_FLAG), false, "and is not softened into the other flag");

  // The next normal visit, with no wait of its own, one minute after the held one arrived.
  const heldBefore = { ...prior(fixAt("2026-11-03T12:29:00.000Z", 20), "held"), queuedSeconds: 3_540 };
  const soon = held(fixAt("2026-11-03T12:30:00.000Z", 30), [heldBefore], null, [heldBefore.capturedAt]);
  assert.ok(soon.flags.includes(HELD_FLAG), "🔴 the next normal visit, too soon after a held one, is read by a person");
  assert.equal(soon.flags.includes("impossible_travel"), false, "and is not called impossible for the queue before it");
  assert.deepEqual(soon.signals.heldWait, { claimedSeconds: 0, creditedSeconds: 0, priorClaimedSeconds: 3_540 }, "the wait it rests on is the previous visit's");

  // Half an hour later it is an ordinary drive.
  assert.deepEqual(held(fixAt("2026-11-03T13:00:00.000Z", 30), [heldBefore], null, [heldBefore.capturedAt]).flags, [], "a next visit with time to drive raises nothing");

  // A capture with no claim on either side gets exactly what it always got.
  const plain = [prior(fixAt("2026-11-03T12:00:00.000Z", 0), "first")];
  const plainFix = fixAt("2026-11-03T12:00:30.000Z", 200);
  assert.deepEqual(held(plainFix, plain, null), judge(plainFix, plain), "🔴 no claim anywhere: the check is untouched");

  // The pure rule.
  const fix = fixAt("2026-11-03T12:00:00.000Z");
  assert.equal(atTheDoor(fix, null), fix, "a save never held is returned as it is");
  assert.equal(atTheDoor(fix, undefined), fix);
  assert.equal(atTheDoor(fix, 0), fix);
  assert.equal(atTheDoor(fix, Number.NaN), fix, "a failed read of the wait shifts nothing");
  assert.equal(atTheDoor(fix, 600).capturedAt.toISOString(), "2026-11-03T11:50:00.000Z");
  assert.equal(fix.capturedAt.toISOString(), "2026-11-03T12:00:00.000Z", "the fix itself is not changed");
}

function checkAClaimTheServerContradictsIsNotCredited(): void {
  const at = new Date("2026-11-03T12:00:00.000Z");
  const minutesBefore = (minutes: number) => new Date(at.getTime() - minutes * 60_000);

  assert.equal(creditedHeldSeconds(3_600, at, []), 3_600, "with nothing against it, the claim stands");
  assert.equal(creditedHeldSeconds(3_600, at, [minutesBefore(30)]), 0, "🔴 their own phone reached Phoenix inside the wait, so the claim is contradicted");
  assert.equal(creditedHeldSeconds(3_600, at, [minutesBefore(HELD_WAIT_CONTACT_GRACE_MINUTES - 1)]), 3_600, "🔴 a contact inside the grace does not contradict: the sender lands them together");
  assert.equal(creditedHeldSeconds(3_600, at, [at]), 3_600, "nor does its own arrival");
  assert.equal(creditedHeldSeconds(3_600, at, [minutesBefore(61)]), 3_600, "nor a contact from before the wait began");
  assert.equal(creditedHeldSeconds(null, at, []), 0, "no claim, nothing credited");
  assert.equal(creditedHeldSeconds(Number.NaN, at, []), 0, "a failed read credits nothing");
  assert.equal(creditedHeldSeconds(-60, at, []), 0, "a negative wait credits nothing");

  // The capture's own claim: their phone was online at 11:00, inside the two hours it claims.
  const online = prior(fixAt("2026-11-03T11:00:00.000Z", 0), "online");
  const last = prior(fixAt("2026-11-03T12:00:00.000Z", 0.2), "last");
  const claimed = fixAt("2026-11-03T12:00:30.000Z", 200);
  const contradicted = held(claimed, [online, last], 7_200, [online.capturedAt, last.capturedAt, claimed.capturedAt]);
  assert.ok(contradicted.flags.includes("impossible_travel"), "🔴 a claim the server contradicts buys nothing: the trip is impossible");
  assert.equal(contradicted.flags.includes(HELD_FLAG), false, "and it does not read as resting on a wait");
  assert.deepEqual(contradicted.signals.heldWait, { claimedSeconds: 7_200, creditedSeconds: 0, priorClaimedSeconds: 0 }, "the row shows the claim and that it was not believed");

  // The same on a claim already on record.
  const heldBefore = { ...prior(fixAt("2026-11-03T12:29:00.000Z", 20), "held"), queuedSeconds: 3_540 };
  const after = held(fixAt("2026-11-03T12:30:00.000Z", 30), [heldBefore], null, [new Date("2026-11-03T12:00:00.000Z"), heldBefore.capturedAt]);
  assert.ok(after.flags.includes("impossible_travel"), "🔴 a prior's contradicted claim buys nothing either");
  assert.equal(after.flags.includes(HELD_FLAG), false);
}

function checkAWaitCannotHideAnotherReading(): void {
  // The same coordinate, half an hour apart on the server's clock. A 25 minute wait would bring them inside the gap
  // a preset is excused by.
  const spot = fixAt("2026-11-03T11:00:00.000Z", 3);
  const repeated = { ...spot, capturedAt: new Date("2026-11-03T11:30:00.000Z") };
  const before = prior(spot, "before");
  assert.equal(judge(atTheDoor(repeated, 1_500), [before]).flags.includes("coordinate_replay"), false, "moved back alone, the wait hides the replayed coordinate");
  const verdict = held(repeated, [before], 1_500, [spot.capturedAt, repeated.capturedAt]);
  assert.ok(verdict.flags.includes("coordinate_replay"), "🔴 a wait cannot hide a replayed coordinate");
  assert.equal(verdict.strong, true);
}

function checkItCostsTheRankUntilSettled(): void {
  assert.ok(PHOENIX_CRM_STRONG_INTEGRITY_FLAGS.includes(HELD_FLAG), "🔴 strong, on his word: Lower rank until settled");
  assert.equal(PHOENIX_CRM_PRECISION_INTEGRITY_FLAGS.includes(HELD_FLAG), false, "an approximate fix does not excuse it");
  assert.deepEqual(countedIntegrityFlags([HELD_FLAG], 12), [HELD_FLAG], "it counts on a precise fix");
  assert.deepEqual(countedIntegrityFlags([HELD_FLAG], 2_000), [HELD_FLAG], "and on a coarse one");

  const row = { accuracyMeters: 12, flags: [HELD_FLAG] };
  const unsettled = { settledAt: null, settledBy: null, settledFlags: null, settledNote: null };
  assert.deepEqual(rankCountedFlags({ ...row, ...unsettled }), [HELD_FLAG], "🔴 it costs the rank until it is settled");
  const settled = { settledAt: "2026-11-04T09:00:00.000Z", settledBy: "B-10", settledFlags: [HELD_FLAG], settledNote: "No signal on that road that morning; the rep was there." };
  assert.deepEqual(rankCountedFlags({ ...row, ...settled }), [], "🔴 and his settle clears it");
}

function checkTheCaseReadsInPlainWords(): void {
  const first = { ...prior(fixAt("2026-11-03T12:00:00.000Z", 0), "first"), queuedSeconds: 7_200 };
  const verdict = held(fixAt("2026-11-03T12:00:03.000Z", 10), [first], 3_603, [first.capturedAt]);
  const label = PHOENIX_CRM_INTEGRITY_LABELS[HELD_FLAG];
  assert.ok(label.length > 10, "the flag has plain English");

  const input: CaseStoryInput = {
    source: "gps",
    subjectKind: "visit",
    strong: verdict.strong,
    flags: verdict.flags,
    reasons: verdict.flags.map((flag) => PHOENIX_CRM_INTEGRITY_LABELS[flag]),
    repName: "A rep",
    customerName: "A doctor",
    customerList: "AM",
    customerSpeciality: "Psychiatry",
    subjectLabel: "A clinic",
    brickName: null,
    brickDistanceKm: null,
    placeDistanceMeters: null,
    readings: [],
    nearbyVisits: [],
    spreadMeters: null,
    accuracyMeters: 15,
    deviceMocked: null,
    signText: null,
    companionNames: [],
    replayByName: null,
    signals: verdict.signals,
    photoPath: null,
    visitDate: "2026-11-03",
  };
  const story = caseStory(input);
  assert.ok(story.headline.includes("less than a minute apart"), "the case says how far apart they reached Phoenix");
  assert.ok(story.headline.includes("km/h"), "with the speed it would take");
  assert.ok(story.headline.includes("for up to 2 hours"), "and the wait it rests on");
  assert.ok(story.headline.includes("cannot confirm"), "and it says plainly what cannot be known");
  assert.ok(story.story.join(" ").includes("A phone with no signal holds visits"), "🔴 and it closes on the ordinary cause, never a verdict");
  assert.equal(/fraud|forged|fake/i.test(story.story.join(" ")), false, "it never says more than was measured");
}

function checkTheWiring(): void {
  const integrity = code("src/lib/phoenix-crm/server/location-integrity.ts");
  assert.ok(integrity.includes("const verdict = checkHeldLocationIntegrity({"), "🔴 the capture is judged at arrival and at the door");
  assert.ok(integrity.includes("fix: input.fix,"), "the capture goes in at its arrival");
  assert.ok(integrity.includes("queuedSeconds: input.queuedSeconds,"), "with its own claim");
  assert.ok(integrity.includes("queuedSeconds: heldSeconds.get(String(row.id)) ?? null"), "and each one on record with its own");
  assert.equal(integrity.includes("atTheDoor"), false, "🔴 this file moves nothing itself, so nothing is moved twice");
  assert.ok(integrity.includes("ownArrivals,"), "🔴 what can contradict a claim reaches the check");
  assert.ok(integrity.includes("for (const row of (ownVisits.data ?? []) as Row[]) {"), "🔴 a contact is this rep's own visit, never a place or somebody else's row");
  assert.ok(integrity.includes('String(row.entered_by_hr_id ?? "").toUpperCase() === repHrId'), "🔴 a save by a manager or an admin is not this phone online");
  assert.ok(integrity.includes("captured_at: input.fix.capturedAt.toISOString()"), "what is FILED keeps the arrival, so it agrees with the visit");
  assert.ok(integrity.includes("prior.capturedAt.getTime() !== input.fix.capturedAt.getTime()"), "the capture itself is still left out of its own history");
  assert.ok(integrity.includes('"id, lat, lon, accuracy_meters, captured_at, rep_hr_id, customer_id, entered_by_hr_id"'), "the visit's id is read, or no wait can be matched to it, and who entered it, or nothing can contradict one");

  // The wait is filed AFTER the judgement, so the visit being judged carries no claim in its own history.
  const visits = code("src/lib/phoenix-crm/server/visits.ts");
  const judged = visits.indexOf("await judgeCapture(");
  const filed = visits.indexOf("await recordCaptureProvenance(", judged);
  assert.ok(judged !== -1 && filed > judged, "🔴 judged first, then filed: the visit being judged must not carry a claim in its own history");

  // The clock check gets the same courtesy, and a truly wrong clock still shows (visit-resend-rules test).
  assert.ok(visits.includes("deviceClockSkewMinutes(visit.deviceCapturedAt, issuedAt ? new Date(issuedAt) : new Date(), queuedSeconds)"));

  const provenance = code("src/lib/phoenix-crm/server/capture-provenance.ts");
  assert.ok(provenance.includes("queued_seconds: input.queuedSeconds"), "the wait is filed on the provenance row");
}

function checkTheRepIsNeverTold(): void {
  // The rep's screen names nothing from the evidence. Its sentences live with the rules, pinned there.
  const note = code("src/components/phoenix-crm/visit-outbox-note.tsx");
  for (const banned of ["queuedSeconds", "queued_seconds", "sentLate", "clock", "distance"]) {
    assert.equal(note.toLowerCase().includes(banned.toLowerCase()), false, `the rep's note never says ${banned}`);
  }

  // The status read answers the switch, the clock and their own ids, and nothing that would teach a rep the window.
  const log = code("src/lib/phoenix-crm/server/visit-resend-log.ts");
  assert.ok(log.includes("savedVisitIds"));
  assert.equal(/\.select\([^)]*queued_seconds/.test(log), false, "the status read never reads a wait back");

  // The save's answer to the rep carries nothing about it.
  const fields = code("src/lib/phoenix-crm/visit-report-fields.ts");
  assert.ok(/F\("location", "sentLateMinutes", "Sent late \(min\)", "minutes", 10, \{ sight: "sfe", sparse: true \}\)/.test(fields), "the SFE Manager can see a forged value, and a district manager is not offered it");
}
