import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { distanceMeters } from "../src/lib/phoenix-crm/geo.ts";
import {
  accuracySentence,
  answersEachReading,
  buildPlaceMatchBoard,
  classifyPair,
  customerPairKey,
  foldOneCustomer,
  insightsOf,
  MAX_ANSWER_PAIRS,
  median,
  oneCustomerJoins,
  orderedPair,
  pairId,
  pairLimits,
  questionSignature,
  SAME_GROUP_DIAMETER_METERS,
  splitAnswerPairs,
  subjectAccuracy,
  type MatchAnswerRow,
  type MatchSubject,
  type OneCustomerCandidate,
} from "../src/lib/phoenix-crm/place-match-groups.ts";
import { twinNameWords } from "../src/lib/phoenix-crm/line-twins.ts";

/**
 * Phoenix CRM — the same place validated by more than one rep, side by side (owner, 2026-10-17: "a place
 * validated by more than a rep … put the validations beside each other and show me insights … which one
 * is the most accurate … if you are in doubt, ask — but not every place; what is clear and confident,
 * put it direct … the admin only").
 *
 * The rule is a pure module, exercised directly. The loader, the route and the screen are server and
 * client code the harness does not run, so the last section pins by source what they wire.
 */

const ROOT = new URL("../", import.meta.url);

function read(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n/g, "\n"));
}

/** One degree of latitude, in metres, on the sphere the module measures with. */
const METERS_PER_DEGREE = 111_195;

/** A point `meters` north of a fixed starting point, so two of them are exactly that far apart. */
function at(meters: number): { lat: number; lon: number } {
  return { lat: 30 + meters / METERS_PER_DEGREE, lon: 31 };
}

let counter = 0;

function subject(overrides: Partial<MatchSubject> & { meters?: number } = {}): MatchSubject {
  counter += 1;
  const id = `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
  const { meters = 0, ...rest } = overrides;
  return {
    key: `place:${id}`,
    kind: "place",
    id,
    seatId: `seat-${counter}`,
    repName: `Rep ${counter}`,
    territory: "Cairo 1",
    line: "CNS",
    region: "Cairo",
    title: "Customer",
    subtitle: null,
    listType: "AM",
    speciality: null,
    nameKey: "",
    point: at(meters),
    accuracyMeters: null,
    pinGapMeters: null,
    pointSource: "photo",
    signboard: null,
    brickName: null,
    areaName: null,
    address: null,
    capturedAt: "2026-10-10T08:00:00.000Z",
    capturedAtText: "10 Oct 2026, 11:00",
    photoPath: null,
    seated: 0,
    waiting: false,
    ...rest,
  };
}

function board(subjects: MatchSubject[], answers: MatchAnswerRow[] = []) {
  return buildPlaceMatchBoard({ subjects, answers });
}

export function runPhoenixCrmPlaceMatchGroupsTests(): void {
  // The fixture's own ruler: a test that mis-measured would pin nothing.
  assert.ok(Math.abs(distanceMeters(at(0), at(39)) - 39) <= 1, "the helper places two points the distance apart");

  // ── The pair rule: three answers, set by the readings' own accuracy ───────────────────────────
  assert.equal(subjectAccuracy({ accuracyMeters: null }), 25, "a reading with no accuracy is assumed to be about 25 m");
  assert.equal(subjectAccuracy({ accuracyMeters: 0 }), 25, "and so is a zero, which no phone really has");
  assert.equal(subjectAccuracy({ accuracyMeters: 1 }), 5, "a claim of 1 m is held to 5 m");
  assert.equal(subjectAccuracy({ accuracyMeters: 12 }), 12, "a sane report stands");
  assert.equal(subjectAccuracy({ accuracyMeters: 500 }), 100, "and a hopeless one is held to 100 m");
  assert.equal(subjectAccuracy({ accuracyMeters: Number.NaN }), 25, "a number that is not one is unknown");

  assert.deepEqual(pairLimits({ accuracyMeters: 5 }, { accuracyMeters: 5 }), { same: 30, different: 100 }, "two sharp phones: never tighter than 30 m, never looser than 100 m");
  assert.deepEqual(pairLimits({ accuracyMeters: 100 }, { accuracyMeters: 100 }), { same: 60, different: 200 }, "two hopeless phones: never wider than 60 m, never beyond 200 m");
  const unknown = pairLimits({ accuracyMeters: null }, { accuracyMeters: null });
  assert.ok(Math.abs(unknown.same - 35.36) < 0.01 && Math.abs(unknown.different - 106.07) < 0.01, "two unknown readings sit between the two");

  assert.equal(classifyPair(subject({ meters: 0 }), subject({ meters: 20 })).relation, "same", "close enough that the system is confident");
  assert.equal(classifyPair(subject({ meters: 0 }), subject({ meters: 50 })).relation, "unsure", "in the middle band the system will not decide");
  assert.equal(classifyPair(subject({ meters: 0 }), subject({ meters: 120 })).relation, "different", "far enough that the system is confident the other way");
  assert.equal(
    classifyPair(subject({ meters: 0, nameKey: "ahmed" }), subject({ meters: 50, nameKey: "mona" })).relation,
    "different",
    "🔴 two differently named customers in the middle band are two doors — never worth a question (261 questions on the live data before this rule)",
  );
  assert.equal(
    classifyPair(subject({ meters: 0, nameKey: "ahmed" }), subject({ meters: 10, nameKey: "mona" })).relation,
    "same",
    "and the name rule only ever applies in the middle band: a few metres apart is one door whatever the names say",
  );
  assert.equal(classifyPair(subject({ meters: 0, nameKey: "ahmed" }), subject({ meters: 50, nameKey: "ahmed" })).relation, "unsure", "the same name in the middle band IS the question");
  assert.equal(
    classifyPair(subject({ meters: 0, kind: "venue" }), subject({ meters: 50, nameKey: "mona" })).relation,
    "unsure",
    "a building has no customer name, so the name rule never settles a pair with one",
  );
  assert.equal(classifyPair(subject({ meters: 0, nameKey: "" }), subject({ meters: 50, nameKey: "mona" })).relation, "unsure", "and neither does a name that folds away");

  const first = subject({ meters: 0 });
  const second = subject({ meters: 5 });
  assert.deepEqual(orderedPair(first.key, second.key), orderedPair(second.key, first.key), "a pair is the same whichever way round it is asked");
  assert.equal(pairId(first.key, second.key), pairId(second.key, first.key), "and has one identity");
  assert.equal(median([]), null, "no readings, no median");
  assert.equal(median([3, null, 1, undefined, 2]), 2, "unknowns are left out");
  assert.equal(median([1, 2, 3, 4]), 2.5, "an even count averages the middle two");

  // ── Who is a comparison: two REPS, not two rows ───────────────────────────────────────────────
  const oneRep = subject({ meters: 0, seatId: "seat-solo" });
  const sameRep = subject({ meters: 10, seatId: "seat-solo" });
  assert.equal(board([oneRep, sameRep]).groups.length, 0, "🔴 two places ONE rep validated in the same building are one rep's work, not a comparison");
  const lone = subject({ meters: 0 });
  const other = subject({ meters: 20 });
  const far = subject({ meters: 300 });
  const pair = board([lone, other, far]);
  assert.equal(pair.groups.length, 1, "two reps 20 m apart are one place");
  assert.equal(pair.groups[0].members.length, 2, "and a third 300 m away is not part of it");
  assert.equal(pair.groups[0].seats, 2, "counted by seat");
  assert.equal(pair.groups[0].spreadMeters, 20, "the group says how far its own readings spread");
  assert.equal(pair.questions.length, 0, "confident pairs raise no question");

  const building = subject({ meters: 0, kind: "venue", seatId: "seat-venue" });
  const customerNearIt = subject({ meters: 20, seatId: "seat-other" });
  assert.equal(board([building, customerNearIt]).groups.length, 1, "a place a second rep validated at a polyclinic's door is compared with the polyclinic");
  assert.equal(board([building, subject({ meters: 20, seatId: "seat-venue" })]).groups.length, 0, "but never with the same rep's own place");

  // ── Ranking: the most accurate, honestly ──────────────────────────────────────────────────────
  const sharp = subject({ meters: 0, accuracyMeters: 5, repName: "Alpha" });
  const middling = subject({ meters: 12, accuracyMeters: 40, repName: "Bravo" });
  const weak = subject({ meters: 24, accuracyMeters: 80, repName: "Charlie" });
  const ranked = board([weak, sharp, middling]);
  assert.equal(ranked.groups.length, 1, "three reps within the weakest pair's 60 m are one place");
  const group = ranked.groups[0];
  assert.deepEqual(group.members.map((member) => member.repName), ["Alpha", "Bravo", "Charlie"], "best first, whatever order they arrived in");
  assert.deepEqual(group.members.map((member) => member.rank), [1, 2, 3], "ranked");
  assert.equal(group.bestKey, sharp.key, "the sharp reading clearly beats the next one");
  assert.ok(group.members[0].flags.includes("most_accurate"), "and is flagged");
  assert.ok(group.members[2].flags.includes("weak_gps"), "a phone that reported 80 m says so");
  assert.deepEqual(group.members.map((member) => member.nearestOtherMeters), [12, 12, 12], "each is held against the nearest OTHER rep's reading");
  assert.deepEqual(group.members.map((member) => member.likelyErrorMeters), [13, 42, 81], "the likely error combines the phone's accuracy with how far the others sit");
  const sentence = accuracySentence(group);
  assert.ok(sentence.startsWith("Most accurate: Alpha") && sentence.includes("about 5 m") && sentence.includes("12 m away"), `the screen says why — got: ${sentence}`);
  const insights = ranked.insights;
  assert.deepEqual(
    [insights.groups, insights.validations, insights.reps, insights.tooCloseToCall, insights.withOutlier, insights.medianSpreadMeters],
    [1, 3, 3, 0, 0, 24],
    "the figures across every place",
  );
  assert.deepEqual(insights.byRep.map((rep) => rep.repName), ["Alpha", "Bravo", "Charlie"], "the per-rep table is most trustworthy first, ties by name");
  assert.equal(insights.byRep[0].mostAccurate, 1, "and counts the places each was clearly the most accurate on");
  assert.deepEqual(insightsOf(ranked.groups), insights, "the screen recomputes the same figures over the places the filters leave");
  assert.deepEqual(insightsOf([]).byRep, [], "and none over no places");

  const tieA = subject({ meters: 0, accuracyMeters: 20, repName: "Alpha" });
  const tieB = subject({ meters: 10, accuracyMeters: 20, repName: "Bravo" });
  const tie = board([tieA, tieB]);
  assert.equal(tie.groups[0].bestKey, null, "🔴 'too close to call' is an honest answer: a tie names nobody the most accurate");
  assert.ok(tie.groups[0].members.every((member) => !member.flags.includes("most_accurate")), "and flags nobody");
  assert.ok(accuracySentence(tie.groups[0]).startsWith("Too close to call: the two readings"), "and says so");
  assert.equal(tie.insights.tooCloseToCall, 1, "and counts it");

  const a = subject({ meters: 0, accuracyMeters: 25, repName: "Alpha" });
  const b = subject({ meters: 8, accuracyMeters: 25, repName: "Bravo" });
  const c = subject({ meters: 16, accuracyMeters: 25, repName: "Charlie" });
  const d = subject({ meters: 61, accuracyMeters: 100, repName: "Delta" });
  const outlier = board([a, b, c, d]);
  assert.equal(outlier.groups.length, 1, "a weak phone 45 m from the nearest rep is still within its pair limit, so it is in the place");
  const byRep = new Map(outlier.groups[0].members.map((member) => [member.repName, member]));
  assert.ok(byRep.get("Delta")?.flags.includes("outlier"), "🔴 a reading far from every other rep, when the rest agree with each other, is the outlier");
  assert.ok(byRep.get("Delta")?.flags.includes("weak_gps"), "and its weak signal is flagged beside it");
  for (const name of ["Alpha", "Bravo", "Charlie"]) assert.ok(!byRep.get(name)?.flags.includes("outlier"), `${name} agrees with the others and is not an outlier`);
  assert.equal(outlier.insights.withOutlier, 1, "the figures count it");
  assert.equal(outlier.insights.byRep.find((rep) => rep.repName === "Delta")?.outliers, 1, "and put it against the rep");
  const twoReps = board([
    subject({ meters: 0, accuracyMeters: 25, seatId: "seat-one" }),
    subject({ meters: 60, accuracyMeters: 100, seatId: "seat-one" }),
    subject({ meters: 1, accuracyMeters: 25, seatId: "seat-two" }),
    subject({ meters: 2, accuracyMeters: 25, seatId: "seat-two" }),
    subject({ meters: 3, accuracyMeters: 25, seatId: "seat-two" }),
  ]);
  assert.equal(twoReps.groups.length, 1, "five readings by two reps are one place");
  assert.equal(twoReps.groups[0].seats, 2, "with two reps in it");
  assert.ok(twoReps.groups[0].members.every((member) => !member.flags.includes("outlier")), "🔴 two reps cannot out-vote each other: a reading 57 m from the other rep's cluster is NOT called an outlier without a third rep to say which of them is wrong");

  const signs = board([subject({ meters: 0, signboard: "other_name" }), subject({ meters: 10, signboard: "no_name" })]);
  assert.ok(signs.groups[0].members.some((member) => member.flags.includes("sign_other_name")), "a sign that names somebody else is flagged");
  assert.ok(signs.groups[0].members.some((member) => member.flags.includes("sign_no_name")), "and one that names nobody");
  const moved = board([subject({ meters: 0, pinGapMeters: 80 }), subject({ meters: 10 })]);
  assert.ok(moved.groups[0].members.some((member) => member.flags.includes("moved_pin")), "a pin 80 m from its own photograph was moved");
  assert.equal(board([subject({ meters: 0, waiting: true }), subject({ meters: 10 })]).groups[0].waiting, true, "a place waiting for a decision says so");

  // ── A group is tight, never a chain ───────────────────────────────────────────────────────────
  assert.equal(SAME_GROUP_DIAMETER_METERS, 120, "the diameter the module holds a group to");
  const chain = [0, 39, 78, 117, 156].map((meters) => subject({ meters, accuracyMeters: 60 }));
  const chained = board(chain);
  assert.equal(chained.groups.length, 1, "a street of readings 39 m apart is not one 156 m 'place'");
  assert.equal(chained.groups[0].members.length, 4, "the group stops where it would grow wider than the cap");
  assert.equal(chained.groups[0].spreadMeters, 117, "and its spread is inside it");
  assert.ok(!chained.groups[0].members.some((member) => member.key === chain[4].key), "the last reading is left out");
  assert.equal(chained.questions.length, 1, "and is asked about instead of being dropped");
  assert.equal(chained.questions[0].pairs.length, 3, "with every in-doubt pair it has against the group (the 39 m one is 'same', only refused for width)");
  assert.equal(chained.questions[0].closestMeters, 78, "and the question names the closest distance");
  const asking = chained.questions[0];
  assert.equal(asking.left.length + asking.right.length + asking.moreLeft + asking.moreRight, 5, "naming every reading on both sides");
  assert.equal(asking.left.length + asking.right.length, 4, "three readings a side at most are drawn — the rest are counted, 'and 1 more beside these'");
  assert.equal(asking.moreLeft + asking.moreRight, 1, "and the count is what is left over");

  // ── The question: only the in-between, and an answer is kept ──────────────────────────────────
  const left = subject({ meters: 0, nameKey: "ahmed" });
  const right = subject({ meters: 60, nameKey: "ahmed" });
  const asked = board([left, right]);
  assert.equal(asked.groups.length, 0, "an in-doubt pair is not grouped on the system's own say-so");
  assert.equal(asked.questions.length, 1, "it is put to the Super Admin");
  assert.equal(asked.questions[0].sameName, true, "with the hint that the same name sits on both sides");
  assert.equal(asked.questions[0].closestMeters, 60, "and the distance");
  assert.deepEqual(asked.questions[0].pairs, [orderedPair(left.key, right.key)], "and the pair an answer will be stored for");
  assert.equal(board([subject({ meters: 0, nameKey: "ahmed" }), subject({ meters: 60, nameKey: "mona" })]).questions.length, 0, "🔴 differently named customers are never asked about");
  assert.equal(board([subject({ meters: 0, nameKey: "ahmed" }), subject({ meters: 60, nameKey: "mona" })]).groups.length, 0, "nor grouped");
  assert.equal(board([subject({ meters: 0 }), subject({ meters: 150 })]).questions.length, 0, "readings clearly apart are never asked about");
  assert.equal(board([subject({ meters: 0, seatId: "seat-solo" }), subject({ meters: 60, seatId: "seat-solo" })]).questions.length, 0, "and one rep's own two places are never asked about");

  const yes = board([left, right], [{ a: left.key, b: right.key, answer: "same" }]);
  assert.equal(yes.questions.length, 0, "a 'same place' answer closes the question");
  assert.equal(yes.groups.length, 1, "and the two readings are one place");
  assert.deepEqual(yes.groups[0].confirmedPairs, [orderedPair(left.key, right.key)], "🔴 remembered on the group, so he can take it back");
  const reversed = board([left, right], [{ a: right.key, b: left.key, answer: "same" }]);
  assert.equal(reversed.groups.length, 1, "whichever way round the pair was stored");

  const farLeft = subject({ meters: 0 });
  const farRight = subject({ meters: 150 });
  const forced = board([farLeft, farRight], [{ a: farLeft.key, b: farRight.key, answer: "same" }]);
  assert.equal(forced.groups.length, 1, "🔴 his 'same' is never capped by the width rule — he knows the place");
  assert.equal(forced.groups[0].spreadMeters, 150, "even 150 m apart");

  const no = board([left, right], [{ a: left.key, b: right.key, answer: "different" }]);
  assert.equal(no.questions.length, 0, "a 'different places' answer closes the question too");
  assert.equal(no.groups.length, 0, "and the pair is not grouped");
  assert.equal(no.answeredDifferent.length, 1, "it is listed so he can take it back");
  assert.deepEqual(no.answeredDifferent[0].pairs, [orderedPair(left.key, right.key)], "with its pair");
  const closeLeft = subject({ meters: 0 });
  const closeRight = subject({ meters: 20 });
  const closeNo = board([closeLeft, closeRight], [{ a: closeLeft.key, b: closeRight.key, answer: "different" }]);
  assert.equal(closeNo.groups.length, 0, "a 'different' overrules even a pair the system was confident about");
  assert.equal(closeNo.answeredDifferent[0].meters, 20, "and says how far apart they are");

  const inert = board([left, right], [
    { a: left.key, b: "place:00000000-0000-4000-8000-ffffffffffff", answer: "different" },
    { a: left.key, b: left.key, answer: "same" },
  ]);
  assert.equal(inert.questions.length, 1, "🔴 an answer about a validation that is gone changes nothing");
  assert.equal(inert.answeredDifferent.length, 0, "and is not listed");

  // ── Reading by reading (owner, 2026-11-17: "i want to accept 1 and reject 1") ────────────────────
  // His card, as it stood on production: one rep's customer and a second rep's other customer 3 m apart
  // (one door, so the system joined them), and the second rep's reading of the FIRST customer 34 m away.
  const essamFirst = subject({ meters: 0, nameKey: "essam", accuracyMeters: 5, seatId: "seat-cns", repName: "First rep" });
  const solimanSecond = subject({ meters: -3, nameKey: "soliman", accuracyMeters: 5, seatId: "seat-ai", repName: "Second rep" });
  const essamSecond = subject({ meters: 34, nameKey: "essam", accuracyMeters: 5, seatId: "seat-ai", repName: "Second rep" });
  const kom = board([essamFirst, solimanSecond, essamSecond]);
  assert.equal(kom.questions.length, 1, "the 34 m reading of the same customer is the question");
  const komQuestion = kom.questions[0];
  const twoSide = komQuestion.left.length === 2 ? komQuestion.left : komQuestion.right;
  const oneSide = komQuestion.left.length === 2 ? komQuestion.right : komQuestion.left;
  const twoSpread = komQuestion.left.length === 2 ? komQuestion.leftSpreadMeters : komQuestion.rightSpreadMeters;
  const oneSpread = komQuestion.left.length === 2 ? komQuestion.rightSpreadMeters : komQuestion.leftSpreadMeters;
  assert.deepEqual(
    [twoSide.map((reading) => reading.key).sort(), oneSide.map((reading) => reading.key)],
    [[essamFirst.key, solimanSecond.key].sort(), [essamSecond.key]],
    "the 3 m pair is one side and the far reading the other",
  );
  assert.deepEqual(
    twoSide.map((reading) => [reading.key, reading.otherSideMeters]),
    [
      [essamFirst.key, 34],
      [solimanSecond.key, 37],
    ],
    "🔴 each reading says how far it sits from the nearest reading on the other side, closest first by that number (his 'tell me the diff in m')",
  );
  assert.equal(oneSide[0].otherSideMeters, 34, "and so does the reading on the other side, to the nearest one facing it");
  assert.deepEqual([twoSpread, oneSpread], [3, 0], "each side says how far apart its own readings are, 0 for a side of one");
  assert.equal(answersEachReading(komQuestion), true, "a side of several readings can be answered reading by reading");
  assert.equal(answersEachReading(asked.questions[0]), false, "a question of one reading a side has nothing to split");

  assert.equal(splitAnswerPairs(komQuestion, {}), null, "🔴 nothing is saved while a reading that needs a mark has none");
  assert.equal(splitAnswerPairs(komQuestion, { [essamFirst.key]: "same" }), null, "not even one of the two");
  assert.deepEqual(
    splitAnswerPairs(komQuestion, { [essamFirst.key]: "same", [solimanSecond.key]: "different" }),
    { same: [orderedPair(essamFirst.key, essamSecond.key)], different: [orderedPair(solimanSecond.key, essamSecond.key)] },
    "🔴 accept one and reject one: the side of one is what the others are compared with and takes no mark",
  );
  assert.deepEqual(
    splitAnswerPairs(komQuestion, { [essamFirst.key]: "same", [solimanSecond.key]: "same" }),
    { same: [orderedPair(essamFirst.key, essamSecond.key), orderedPair(solimanSecond.key, essamSecond.key)], different: [] },
    "every reading the same is the whole question's 'same place'",
  );
  assert.deepEqual(
    splitAnswerPairs(komQuestion, { [essamFirst.key]: "different", [solimanSecond.key]: "different" }),
    { same: [], different: [orderedPair(essamFirst.key, essamSecond.key), orderedPair(solimanSecond.key, essamSecond.key)] },
    "and every reading different is its 'different places'",
  );
  assert.deepEqual(splitAnswerPairs(asked.questions[0], {}), { same: [orderedPair(left.key, right.key)], different: [] }, "a side of one never needs a mark");

  const komAnswered = board(
    [essamFirst, solimanSecond, essamSecond],
    [
      { a: essamFirst.key, b: essamSecond.key, answer: "same" },
      { a: solimanSecond.key, b: essamSecond.key, answer: "different" },
    ],
  );
  assert.equal(komAnswered.questions.length, 0, "his split answer closes the question");
  assert.equal(komAnswered.groups.length, 1, "and the reading he accepted makes one place");
  assert.deepEqual(
    komAnswered.groups[0].members.map((member) => member.key).sort(),
    [essamFirst.key, essamSecond.key].sort(),
    "🔴 HIS 'DIFFERENT' IS A WALL: the reading he rejected stays out of the place he confirmed, though it sits 3 m from one of its readings",
  );
  assert.equal(komAnswered.answeredDifferent.length, 1, "the rejected pair is listed so he can take it back");
  // The wall is reached through ANY chain: here his "same" links E1 to Y, Y sits 3 m from NE, and S sits
  // 3 m from E1, so two distance joins and one "same" would put S and NE — answered different — together.
  const chainS = subject({ meters: 0, accuracyMeters: 5 });
  const chainE1 = subject({ meters: 3, accuracyMeters: 5 });
  const chainY = subject({ meters: 80, accuracyMeters: 5 });
  const chainNe = subject({ meters: 83, accuracyMeters: 5 });
  const chained2 = board(
    [chainS, chainE1, chainY, chainNe],
    [
      { a: chainS.key, b: chainNe.key, answer: "different" },
      { a: chainE1.key, b: chainY.key, answer: "same" },
    ],
  );
  assert.ok(
    !chained2.groups.some((group) => group.members.some((member) => member.key === chainS.key) && group.members.some((member) => member.key === chainNe.key)),
    "🔴 the wall holds through a chain of distance joins and his 'same' answers, in whatever order they fall",
  );
  assert.deepEqual(
    chained2.groups.map((group) => group.members.length),
    [3],
    "and the place still forms with the readings the wall does not keep apart",
  );

  // A side bigger than the card draws: answering reading by reading draws and answers every reading, so
  // no pair that raised the question is left open behind "and 1 more".
  const wideA = subject({ meters: 0, nameKey: "wide", accuracyMeters: 5 });
  const wideB = subject({ meters: 2, nameKey: "wide", accuracyMeters: 5 });
  const wideC = subject({ meters: 4, nameKey: "wide", accuracyMeters: 5 });
  const wideD = subject({ meters: 6, nameKey: "wide", accuracyMeters: 5 });
  const wideF = subject({ meters: 45, nameKey: "wide", accuracyMeters: 5 });
  const wideBoard = board([wideA, wideB, wideC, wideD, wideF]);
  const wide = wideBoard.questions[0];
  const wideSide = wide.left.length === 3 ? wide : { ...wide, left: wide.right, leftMore: wide.rightMore, right: wide.left, rightMore: wide.leftMore };
  assert.deepEqual([wideSide.left.length, wideSide.leftMore.length], [3, 1], "three readings drawn and one counted");
  assert.equal(wideSide.leftMore[0].key, wideA.key, "the counted one is the farthest from the other side");
  assert.equal(answersEachReading(wide), true, "it can still be answered reading by reading");
  assert.equal(splitAnswerPairs(wide, { [wideB.key]: "different", [wideC.key]: "different", [wideD.key]: "different" }), null, "🔴 the counted reading needs its own choice too");
  const wideSplit = splitAnswerPairs(wide, { [wideA.key]: "different", [wideB.key]: "different", [wideC.key]: "different", [wideD.key]: "different" });
  assert.equal(wideSplit?.different.length, 4, "every reading's pair is answered, the counted one's included");
  const wideAnswered = board(
    [wideA, wideB, wideC, wideD, wideF],
    (wideSplit?.different ?? []).map(([a, b]) => ({ a, b, answer: "different" as const })),
  );
  assert.equal(wideAnswered.questions.length, 0, "🔴 so the question closes instead of coming back behind 'and 1 more'");
  assert.notEqual(
    questionSignature(wide),
    questionSignature({ id: wide.id, pairs: wide.pairs.slice(0, 1) }),
    "🔴 a question raised again over other pairs is a different question to the screen, so it is never hidden as answered",
  );
  const crowd = Array.from({ length: 9 }, (_, index) => subject({ meters: index, nameKey: "crowd", accuracyMeters: 5 }));
  assert.equal(
    answersEachReading({ left: crowd.slice(0, 3).map((one) => ({ ...one, otherSideMeters: 0 })), leftMore: crowd.slice(3).map((one) => ({ ...one, otherSideMeters: 0 })), right: crowd.map((one) => ({ ...one, otherSideMeters: 0 })), rightMore: crowd.map((one) => ({ ...one, otherSideMeters: 0 })) }),
    false,
    "a question with more pairs than one request holds (9 × 18) is answered whole",
  );
  assert.deepEqual(
    board(
      [essamFirst, solimanSecond, essamSecond],
      [
        { a: solimanSecond.key, b: essamSecond.key, answer: "different" },
        { a: essamFirst.key, b: essamSecond.key, answer: "same" },
        { a: essamFirst.key, b: solimanSecond.key, answer: "same" },
      ],
    ).groups.map((group) => group.members.length),
    [3],
    "🔴 and the wall never refuses his own 'same': only a join made on distance alone",
  );

  const twice = subject({ meters: 0 });
  assert.equal(board([twice, { ...twice }, subject({ meters: 10 })]).groups[0].members.length, 2, "one validation is counted once however often it arrives");
  assert.equal(board([subject({ meters: 0 }), { ...subject({ meters: 5 }), point: { lat: Number.NaN, lon: 31 } }]).groups.length, 0, "a reading with no usable point is left out");
  assert.equal(MAX_ANSWER_PAIRS, 80, "the route's per-request ceiling, which the screen sends a bigger question in pieces to stay under");

  // ── The server: the deciders' alone, read in full, a seated customer never a subject ──────
  const server = read("src/lib/phoenix-crm/server/place-match-groups.ts");
  assert.match(server, /export function canReadPlaceMatches\(viewer: PhoenixCrmViewer\): boolean \{\s*return readsCompanyPlaceChecks\(viewer\);/, "🔴 the same readers as every Place check — the Super Admin and the SFE Manager");
  assert.equal(server.split("throw forbiddenError(").length - 1, 2, "both the read and the answer refuse everyone else");
  assert.ok(/export async function loadPlaceMatchBoard[\s\S]*?if \(!canReadPlaceMatches\(viewer\)\) throw forbiddenError/.test(server), "the read checks first");
  assert.ok(/export async function answerPlaceMatch[\s\S]*?if \(!canDecideValidationReviews\(viewer\)\) throw forbiddenError\("Only the Super Admin answers this\."\)/.test(server), "🔴 and the answer is the decider's alone — the SFE Manager reads the groups and answers none (owner, 2026-11-19)");
  assert.ok(server.split("readEveryPage<Row>(").length - 1 >= 3, "🔴 places, polyclinics and answers are each read in full — a bare read stops at 1,000 rows without saying so");
  assert.ok(server.includes('.eq("status", "active").eq("is_test", false)'), "only places in use, never a test row");
  assert.ok(server.includes('.in("status", ["active", "held"])'), "polyclinics in use or waiting for a decision");
  assert.ok(server.includes("allPlaces.filter((row) => !text(row.shared_place_id))"), "🔴 a customer seated in a building is never a subject — they sit on the building's own point");
  assert.ok(server.includes("seatedByVenue"), "the building says how many are seated in it");
  assert.ok(server.includes('"phoenix_crm_customers", "id, name, list_type, speciality, customer_type"'), "the customer's name comes from the customer");
  assert.ok(server.includes("function isSubjectKey(key: string)") && server.includes("isUuid(key.slice(colon + 1))") && server.includes('import { isUuid } from "@/lib/http/uuid"'), "an answer's keys are validated by shape, through the shared isUuid");
  assert.ok(server.includes('{ onConflict: "subject_a,subject_b" }'), "an answer is an upsert on the ordered pair");
  assert.ok(server.includes("decided_by_hr_id: viewer.hrId"), "stamped with who answered");
  assert.ok(server.includes('.delete().eq("subject_a", low).eq("subject_b", high)'), "and taking one back deletes the pair");
  assert.ok(server.includes("rawPairs.length > MAX_ANSWER_PAIRS"), "a request is bounded");
  assert.ok(server.includes('body.answer === "split" ? "split"'), "his answer reading by reading is a fourth kind");
  assert.ok(server.includes("total === 0 || total > MAX_ANSWER_PAIRS"), "bounded the same way, over both lists");
  assert.ok(server.includes("if (different.some(([low, high]) => sameIds.has(`${low}|${high}`)))"), "🔴 one pair cannot be answered both ways in one request");
  assert.ok(
    server.includes('.upsert([...same.map(([low, high]) => row(low, high, "same")), ...different.map(([low, high]) => row(low, high, "different"))], {'),
    "🔴 both kinds in ONE write, so a half-saved answer cannot confirm a place without walling out the reading he rejected",
  );

  // ── The route: read behind `read`, write behind `approve` and the origin check ─────────────────
  const route = read("app/api/phoenix-crm/validation-reviews/same-place/route.ts");
  const getPart = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function POST"));
  const postPart = route.slice(route.indexOf("export async function POST"));
  assert.ok(getPart.includes('assertPermission(access, "phoenix_crm", "read")') && getPart.includes("loadPlaceMatchBoard(viewer)"), "the read is a read of the module and the loader checks the viewer");
  assert.ok(!getPart.includes("assertSameOriginMutation"), "a GET carries no origin check");
  assert.ok(postPart.includes("assertSameOriginMutation(request)"), "the write checks the origin");
  assert.ok(postPart.includes('assertPermission(access, "phoenix_crm", "approve")') && postPart.includes("answerPlaceMatch(viewer, await request.json())"), "behind `approve`, and the service refuses everyone but the Super Admin and the SFE Manager");
  assert.ok(getPart.includes("board: { ...board, capped }") && postPart.includes("{ saved, success: true }"), "under the keys the screen reads");

  // ── The screen and the board ──────────────────────────────────────────────────────────────────
  const screen = read("src/components/phoenix-crm/place-match-board.tsx");
  assert.ok(screen.includes('useCrmGet<BoardView>(ROUTE, "board")'), "🔴 read by the key the route answers under, the value and never the envelope");
  assert.ok(screen.includes('crmPost<unknown>(ROUTE, { answer, pairs: pairs.slice(index, index + MAX_ANSWER_PAIRS) }, "saved")'), "an answer is posted in pieces the route accepts");
  assert.ok(!screen.includes("mode="), "🔴 the board has no manager mode: it is never handed to one");
  assert.ok(screen.indexOf("<CrmCardsOnPhone") < screen.indexOf("<CrmTable"), "phone cards first, then the table");
  assert.doesNotMatch(screen, /\brounded-(?!none\b)|\boverflow-x-auto\b|\btruncate\b|\bmin-w-\[|line-clamp|text-ellipsis/, "square, no sideways scroll, no ellipsis");
  assert.doesNotMatch(screen.toLowerCase(), /\b(doctor|doctors|account|accounts)\b/, "AM and PM customers — never the old words");
  const columns = /<CrmTable columns=\{\[([^\]]*)\]\}/.exec(screen);
  assert.ok(columns, "the per-rep table names its column widths");
  const widths = [...columns[1].matchAll(/"(\d+)%"/g)].map((match) => Number(match[1]));
  assert.ok(widths.length === 5 && widths.reduce((total, width) => total + width, 0) <= 100, "five columns that fit the panel — a sixth clipped its header on a laptop");
  assert.equal((screen.match(/<th /g) ?? []).length, 5, "with a header for each");
  assert.ok(screen.includes('if (answer === "forget") setAnswered(new Set());'), "🔴 a question taken back must be able to return: the hidden-ids set is emptied on a forget");
  assert.ok(screen.includes("{meters(subject.otherSideMeters)} from the nearest reading on the other side"), "🔴 every reading on a question says how far it is from the other side");
  assert.ok(screen.includes("The {countText(all.length)} readings on this side are up to {meters(spreadMeters)} apart"), "and a side of several says how many readings its spread covers");
  assert.ok(screen.includes("const drawn = choosing ? all : subjects;"), "🔴 while he answers reading by reading, the counted readings are drawn too");
  assert.ok(screen.includes("{answersEachReading(question) ? ("), "'Answer each reading' is offered only when a side holds several");
  assert.ok(screen.includes("<CrmChoice") && screen.includes('{ value: "different", label: "A different place", disabled: busy }'), "each reading's choice is the module's one-of-two pick");
  assert.ok(screen.includes("!answered.has(questionSignature(question))"), "🔴 an answered question is hidden by its pairs, not its id alone");
  assert.ok(screen.includes('{oneRep ? "Take my answer back" : "Ask me again"}'), "🔴 one rep's own pair is never promised a question it will not get");
  assert.ok(screen.includes("disabled={busy || split === null}"), "🔴 nothing is saved until every reading that needs a choice has one");
  assert.ok(
    screen.includes('crmPost<unknown>(ROUTE, { answer: "split", same: split.same, different: split.different }, "saved")'),
    "and the answer goes in one request, both kinds together",
  );
  assert.ok(screen.includes("anyPasses(group.members, filters, cutoff)"), "🔴 a place stays whole when any of its validations passes the shared filters");

  const shell = read("src/components/phoenix-crm/validation-reviews-board.tsx");
  assert.ok(shell.includes("...(team ? [] : [{ key: \"samePlace\" as const"), "🔴 the third tab is not drawn on a manager's board");
  assert.ok(shell.includes("{!team && samePlaceOpened ? ("), "and neither is its panel, or the read behind it");
  assert.ok(shell.includes("<PlaceMatchBoardView filters={filters} />"), "the panel hands it the shared filters");
  assert.ok(shell.includes("if (key === \"samePlace\") setSamePlaceOpened(true);"), "the read starts when the tab is first opened");
  assert.ok(shell.includes('hidden={view !== "samePlace"}'), "and the board stays mounted afterwards");
  assert.ok(shell.includes('label: "Same place, several reps"'), "named for what it holds");
  assert.ok(
    shell.includes("border-orange-500 text-slate-900") && shell.includes("-mb-px") && shell.includes("rounded-none"),
    "the active tab wears the house orange and sits on the rule",
  );
  assert.ok(shell.includes("tabIndex={view === key ? 0 : -1}") && shell.includes('event.key === "ArrowRight"'), "the strip is a real tab list: one stop, arrow keys between tabs");
  assert.ok(shell.includes("aria-controls={view === key ? `vr-panel-${key}` : undefined}"), "and names a panel only when it is on the page");

  // ── The migration ─────────────────────────────────────────────────────────────────────────────
  const migration = read("supabase/migrations/20261017160000_phoenix_crm_place_match_answers.sql");
  assert.ok(migration.includes("create table if not exists public.phoenix_crm_place_match_answers"), "one new table");
  assert.ok(migration.includes("check (subject_a < subject_b)"), "stored as an ordered pair, so 'A with B' and 'B with A' are one row");
  assert.ok(migration.includes("answer in ('same', 'different')"), "with two answers");
  assert.ok(/subject_a ~ '\^\(place\|venue\):/.test(migration), "its keys are held to their shape");
  assert.ok(
    /create unique index if not exists phoenix_crm_place_match_answers_pair_uidx\s+on public\.phoenix_crm_place_match_answers \(subject_a, subject_b\);/.test(migration),
    "🔴 the unique index is PLAIN: PostgREST's on_conflict emits column names, and a partial index would never be inferred",
  );
  assert.ok(migration.includes("enable row level security") && migration.includes("to service_role") && migration.includes("from public, anon, authenticated"), "service role only");

  // ── One customer is one reading (owner, 2026-11-17) ─────────────────────────────────────────────────
  // The live case: Mohamed Salah validated عصام السيد يوسف on CNS, Nahla on Anti Infective; the three-lines
  // rule moved Nahla's record onto his point, but her photograph's fix sits 34 m off, so the board put the
  // one doctor to the owner as two readings to judge.
  {
    const name = twinNameWords("عصام السيد يوسف");
    const cns = subject({ meters: 0, repName: "Mohamed Salah", line: "CNS", listType: "PM", nameKey: "issam" });
    const ai = subject({ meters: 34, repName: "Nahla", line: "Anti Infective", territory: "Dakahlia 2", listType: "PM", nameKey: "issam" });
    const candidate = (of: MatchSubject, extra: Partial<OneCustomerCandidate> = {}): OneCustomerCandidate => ({
      key: of.key,
      customerId: `customer-${of.id}`,
      seatId: of.seatId,
      line: of.line,
      listType: "PM",
      nameWords: name,
      stored: at(0),
      movedByLineRule: false,
      capturedAt: of.capturedAt,
      ...extra,
    });
    const joined = candidate(ai, { movedByLineRule: true, capturedAt: "2026-11-10T13:04:53.000Z" });
    const kept = candidate(cns, { capturedAt: "2026-11-15T12:12:09.000Z" });

    const joins = oneCustomerJoins([joined, kept]);
    assert.deepEqual([...joins], [[ai.key, cns.key]], "the moved record folds into the one it was moved onto, though it was captured first");

    assert.equal(oneCustomerJoins([{ ...joined, movedByLineRule: false }, kept]).size, 0, "two records on one point that the rule never joined stay two");
    assert.equal(oneCustomerJoins([{ ...joined, line: "CNS" }, kept]).size, 0, "two records of one line are never folded here");
    assert.equal(oneCustomerJoins([{ ...joined, stored: at(2) }, kept]).size, 0, "a record 2 m off is not on the rule's one point");
    assert.equal(oneCustomerJoins([{ ...joined, nameWords: twinNameWords("عصام علي دفيه") }, kept]).size, 0, "another name is another doctor");
    assert.equal(oneCustomerJoins([{ ...joined, listType: "Pharmacy" }, { ...kept, listType: "Pharmacy" }]).size, 0, "a pharmacy is never folded");
    assert.equal(oneCustomerJoins([{ ...joined, customerId: kept.customerId }, kept]).size, 0, "one customer's two places are not two lines");

    const pedia = subject({ meters: 0, repName: "Pedia rep", line: "Pedia", listType: "PM", nameKey: "issam" });
    const three = oneCustomerJoins([joined, kept, candidate(pedia, { movedByLineRule: true })]);
    assert.equal(three.get(ai.key), cns.key, "three lines fold into one");
    assert.equal(three.get(pedia.key), cns.key, "…onto the record nobody was moved off");

    const before = board([cns, ai]);
    assert.ok(before.questions.length + before.groups.length > 0, "unfolded, the one doctor is two readings on the board");

    const elsewhere = subject({ meters: 400 });
    const folded = foldOneCustomer(
      [cns, ai, elsewhere],
      [
        { a: ai.key, b: cns.key, answer: "same" },
        { a: ai.key, b: elsewhere.key, answer: "different" },
      ],
      joins,
    );
    assert.deepEqual(folded.subjects.map((held) => held.key), [cns.key, elsewhere.key], "her record leaves the board as a reading of its own");
    assert.deepEqual(folded.subjects[0].sameCustomer, [{ key: ai.key, repName: "Nahla", territory: "Dakahlia 2", line: "Anti Infective" }], "and is named on his");
    const [low, high] = orderedPair(cns.key, elsewhere.key);
    assert.deepEqual(folded.answers, [{ a: low, b: high, answer: "different" }], "an answer about her record moves onto his; one between the two is dropped");

    const after = buildPlaceMatchBoard(foldOneCustomer([cns, ai], [], joins));
    assert.equal(after.questions.length + after.groups.length, 0, "folded, he is one doctor and nothing is asked");
    assert.equal(foldOneCustomer([cns], [], joins).subjects[0].sameCustomer, undefined, "a join whose other half is not on the board folds nothing");

    // His word joins two spellings the rule never would: عصام المزين (CNS) and عصام احمد مزين (Pedia).
    const spelledOtherwise = { ...kept, nameWords: twinNameWords("عصام المزين") };
    const pediaRecord = candidate(pedia, { customerId: "customer-pedia", nameWords: twinNameWords("عصام احمد مزين"), movedByLineRule: true });
    assert.equal(oneCustomerJoins([spelledOtherwise, pediaRecord]).size, 0, "two spellings on one point stay two without his word");
    const confirmedJoin = oneCustomerJoins([spelledOtherwise, pediaRecord], new Set([customerPairKey("customer-pedia", spelledOtherwise.customerId)]));
    assert.equal(confirmedJoin.get(pedia.key), cns.key, "confirmed on Same customer, other line: one reading");
    assert.equal(
      oneCustomerJoins([spelledOtherwise, { ...pediaRecord, stored: at(40) }], new Set([customerPairKey("customer-pedia", spelledOtherwise.customerId)])).size,
      0,
      "his word folds them only once they share the point",
    );
    assert.equal(customerPairKey("b", "a"), customerPairKey("a", "b"), "the confirmed key reads in either order");
  }

  {
    const loader = read("src/lib/phoenix-crm/server/place-match-groups.ts");
    assert.ok(loader.includes("move_reason") && loader.includes("LINE_TWIN_MOVE_REASON"), "the loader reads which records the three-lines rule moved");
    assert.ok(loader.includes('.from("phoenix_crm_line_lookalike_answers")') && loader.includes("oneCustomerJoins(oneCustomerCandidates, confirmedCustomers)"), "the loader folds what he confirmed");
    assert.ok(/buildPlaceMatchBoard\(folded\)/.test(loader) && /foldOneCustomer\(subjects, answers, oneCustomerJoins\(/.test(loader), "and folds before it builds the board");
    const screen = read("src/components/phoenix-crm/place-match-board.tsx");
    assert.ok(screen.includes("The same customer") && screen.includes("subject.sameCustomer"), "the reading names the other lines' reps");
  }

  console.log("phoenix-crm place match groups: OK");
}
