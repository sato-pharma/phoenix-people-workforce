import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import { distanceMeters } from "../src/lib/phoenix-crm/geo.ts";
import {
  accuracySentence,
  buildPlaceMatchBoard,
  classifyPair,
  insightsOf,
  MAX_ANSWER_PAIRS,
  median,
  orderedPair,
  pairId,
  pairLimits,
  SAME_GROUP_DIAMETER_METERS,
  subjectAccuracy,
  type MatchAnswerRow,
  type MatchSubject,
} from "../src/lib/phoenix-crm/place-match-groups.ts";

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

  const twice = subject({ meters: 0 });
  assert.equal(board([twice, { ...twice }, subject({ meters: 10 })]).groups[0].members.length, 2, "one validation is counted once however often it arrives");
  assert.equal(board([subject({ meters: 0 }), { ...subject({ meters: 5 }), point: { lat: Number.NaN, lon: 31 } }]).groups.length, 0, "a reading with no usable point is left out");
  assert.equal(MAX_ANSWER_PAIRS, 80, "the route's per-request ceiling, which the screen sends a bigger question in pieces to stay under");

  // ── The server: the Super Admin's alone, read in full, a seated customer never a subject ──────
  const server = read("src/lib/phoenix-crm/server/place-match-groups.ts");
  assert.match(server, /export function canReadPlaceMatches\(viewer: PhoenixCrmViewer\): boolean \{\s*return canDecideValidationReviews\(viewer\);/, "🔴 the same decider as every Place check — the Super Admin alone");
  assert.equal(server.split("throw forbiddenError(").length - 1, 2, "both the read and the answer refuse everyone else");
  assert.ok(/export async function loadPlaceMatchBoard[\s\S]*?if \(!canReadPlaceMatches\(viewer\)\) throw forbiddenError/.test(server), "the read checks first");
  assert.ok(/export async function answerPlaceMatch[\s\S]*?if \(!canReadPlaceMatches\(viewer\)\) throw forbiddenError/.test(server), "and so does the answer");
  assert.ok(server.split("readEveryPage<Row>(").length - 1 >= 3, "🔴 places, polyclinics and answers are each read in full — a bare read stops at 1,000 rows without saying so");
  assert.ok(server.includes('.eq("status", "active").eq("is_test", false)'), "only places in use, never a test row");
  assert.ok(server.includes('.in("status", ["active", "held"])'), "polyclinics in use or waiting for a decision");
  assert.ok(server.includes("allPlaces.filter((row) => !text(row.shared_place_id))"), "🔴 a customer seated in a building is never a subject — they sit on the building's own point");
  assert.ok(server.includes("seatedByVenue"), "the building says how many are seated in it");
  assert.ok(server.includes('"phoenix_crm_customers", "id, name, list_type, speciality"'), "the customer's name comes from the customer");
  assert.ok(server.includes("const SUBJECT_KEY = /^(place|venue):"), "an answer's keys are validated by shape");
  assert.ok(server.includes('{ onConflict: "subject_a,subject_b" }'), "an answer is an upsert on the ordered pair");
  assert.ok(server.includes("decided_by_hr_id: viewer.hrId"), "stamped with who answered");
  assert.ok(server.includes('.delete().eq("subject_a", low).eq("subject_b", high)'), "and taking one back deletes the pair");
  assert.ok(server.includes("rawPairs.length > MAX_ANSWER_PAIRS"), "a request is bounded");

  // ── The route: read behind `read`, write behind `update` and the origin check ─────────────────
  const route = read("app/api/phoenix-crm/validation-reviews/same-place/route.ts");
  const getPart = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function POST"));
  const postPart = route.slice(route.indexOf("export async function POST"));
  assert.ok(getPart.includes('assertPermission(access, "phoenix_crm", "read")') && getPart.includes("loadPlaceMatchBoard(viewer)"), "the read is a read of the module and the loader checks the viewer");
  assert.ok(!getPart.includes("assertSameOriginMutation"), "a GET carries no origin check");
  assert.ok(postPart.includes("assertSameOriginMutation(request)"), "the write checks the origin");
  assert.ok(postPart.includes('assertPermission(access, "phoenix_crm", "update")') && postPart.includes("answerPlaceMatch(viewer, await request.json())"), "behind `update`, and the service refuses everyone but the Super Admin");
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
  assert.ok(widths.length === 6 && widths.reduce((total, width) => total + width, 0) <= 100, "six columns that fit the panel");
  assert.equal((screen.match(/<th /g) ?? []).length, 6, "with a header for each");
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
  const migration = read("supabase/migrations/20261017150000_phoenix_crm_place_match_answers.sql");
  assert.ok(migration.includes("create table if not exists public.phoenix_crm_place_match_answers"), "one new table");
  assert.ok(migration.includes("check (subject_a < subject_b)"), "stored as an ordered pair, so 'A with B' and 'B with A' are one row");
  assert.ok(migration.includes("answer in ('same', 'different')"), "with two answers");
  assert.ok(/subject_a ~ '\^\(place\|venue\):/.test(migration), "its keys are held to their shape");
  assert.ok(
    /create unique index if not exists phoenix_crm_place_match_answers_pair_uidx\s+on public\.phoenix_crm_place_match_answers \(subject_a, subject_b\);/.test(migration),
    "🔴 the unique index is PLAIN: PostgREST's on_conflict emits column names, and a partial index would never be inferred",
  );
  assert.ok(migration.includes("enable row level security") && migration.includes("to service_role") && migration.includes("from public, anon, authenticated"), "service role only");

  console.log("phoenix-crm place match groups: OK");
}
