import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  EMPTY_INTEGRITY_FILTERS,
  hasActiveIntegrityFilter,
  integrityDistanceBandOf,
  integrityFilterOptions,
  integrityFiltersFromParams,
  integrityFiltersToQuery,
  matchesIntegrityFilters,
  type IntegrityFilterable,
  type IntegrityFilters,
} from "../src/lib/crm-integrity/integrity-board-filters.ts";
import { buildCaseMap, caseSpreadMeters, OSM_TILE_HOST } from "../src/lib/crm-integrity/integrity-case-map.ts";
import {
  CASE_READING_LABELS,
  caseStory,
  INTEGRITY_SOURCE_STORY_LABELS,
  integritySourceStoryLabel,
  integritySubjectKindLabel,
  oddReadingSentence,
  type CaseStoryInput,
} from "../src/lib/crm-integrity/integrity-case-story.ts";
import { INTEGRITY_SETTLE_PRESETS } from "../src/lib/crm-integrity/integrity-settle-presets.ts";
import { stripComments } from "./support/comment-strip.ts";

// THE LOCATION-INTEGRITY BOARD AS A BOARD HE CAN JUDGE FROM (owner, 2026-10-13: "first of all me abl
// to filter by everypossible thing secoond make me ble to multi slect and settle third put more شرح
// للcase fouth show me live the difference in locations sixth if pics avaulable show me 7th make
// every case a story tellling in clear simple english").
//
// 🔴 THE MEASUREMENT THAT SAID THE OLD BOARD WAS UNUSABLE IS THAT NOTHING HAD EVER BEEN SETTLED ON
// IT — 0 of 165 cases, read on production that morning, over 20 reps and ten days. It was not unused;
// it was unjudgeable. Five columns and a per-row button, the signboard's own words on the row and
// never rendered, the photograph a visit away, 130 of the 165 carrying the same weak finding and
// burying the 13 that stood on their own.
//
// What this file pins is therefore not "the screen has a filter bar". It is the handful of things
// that, done wrong, would quietly give him a board that LOOKS right and is not:
//
//   1. A FILTER GROUP THAT SILENTLY MATCHES NOTHING. Sixteen groups and a free-text box; each one is
//      asserted to narrow AND to let the right row through. A group that always returned false would
//      read as "no such cases" and he would never know the board had been narrowed away.
//   2. A URL THAT DOES NOT ROUND-TRIP. The view mirrors the filters into the address so a view
//      survives a reload and can be bookmarked, and the export route rebuilds the filters FROM that
//      address. A key written one way and read another hands him a workbook that is not what is on
//      the screen.
//   3. A DETECTOR OR A FLAG PRINTING AS A CODE. A detector added later must read as words, never as
//      `capture_trust`. The fallback is asserted on an invented source.
//   4. THE BULK SETTLE STAMPING ONE CASE'S FLAGS ON THE BATCH. `settled_flags` is the row's OWN
//      flags; they are what reopens the case by itself when a detector files something different. One
//      `.update()` per row, read from the row, is the whole point.
//   5. THE REFUSAL TURNING INTO A 403. Naming this board is the disclosure, so both new routes refuse
//      with a 404 — and the export's own template (`app/api/admin/activity/export/route.ts`) ends in
//      exactly the 403 branch that must not be copied.
//   6. THE SCREEN AND THE EXPORT DRIFTING APART. One mapping module, used by both.

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const VIEW_PATH = "../src/components/crm-integrity/integrity-board-view.tsx";
const ROWS_PATH = "../src/lib/crm-integrity/integrity-board-rows.ts";
const LOADER_PATH = "../src/lib/phoenix-crm/server/integrity-board.ts";
const SETTLE_MANY_ROUTE = "../app/api/admin/phoenix-crm/integrity/settle-many/route.ts";
const EXPORT_ROUTE = "../app/api/admin/phoenix-crm/integrity/export/route.ts";

/** A filterable row with every field set, so a test narrows one field at a time from a known pass. */
function filterable(overrides: Partial<IntegrityFilterable> = {}): IntegrityFilterable {
  return {
    repName: "Nada Saied",
    repLine: "CNS",
    repArea: "Shoubra",
    repRegion: "Cairo",
    customerName: "Ebtissam Alaa ElDin Anwar",
    customerList: "AM",
    customerSpeciality: "Psychiatry",
    subjectLabel: "El Nozha Clinic",
    brickName: "أشمون",
    source: "capture_trust",
    sourceLabel: "Pin and photograph",
    flags: ["photo_pin_far"],
    reasons: ["The pin and the photograph are 2,768 m apart"],
    strong: true,
    standing: "open",
    hasPhoto: true,
    visitDay: "2026-10-03",
    filedDay: "2026-10-04",
    spreadMeters: 2768,
    headline: "The pin and the photograph are 2,768 m apart",
    story: ["A long gap usually means the picture was taken at the door and the pin saved from the car."],
    ...overrides,
  };
}

function filters(overrides: Partial<IntegrityFilters> = {}): IntegrityFilters {
  return { ...EMPTY_INTEGRITY_FILTERS, ...overrides };
}

/**
 * 1. EVERY FILTER GROUP ANSWERS — it narrows, and it lets the matching row through.
 *
 * Both directions on every group, because the two failures are different and only one of them is
 * visible. A group that never matches empties the board, which at least looks wrong; a group that
 * always matches silently does nothing, and he would read a narrowed board that was not narrowed.
 */
function runFilterGroupTests() {
  const row = filterable();
  assert.equal(matchesIntegrityFilters(row, EMPTY_INTEGRITY_FILTERS), true, "nothing set must match every row");
  assert.equal(hasActiveIntegrityFilter(EMPTY_INTEGRITY_FILTERS), false);

  const groups: Array<[string, IntegrityFilters, IntegrityFilters]> = [
    ["rep", filters({ rep: "Nada Saied" }), filters({ rep: "Someone Else" })],
    ["line", filters({ line: "CNS" }), filters({ line: "Pedia" })],
    ["area", filters({ area: "Shoubra" }), filters({ area: "Giza" })],
    ["region", filters({ region: "Cairo" }), filters({ region: "Delta" })],
    ["source", filters({ source: "Pin and photograph" }), filters({ source: "Signboard" })],
    ["flag", filters({ flag: "The pin and the photograph are 2,768 m apart" }), filters({ flag: "Something else entirely" })],
    ["strength", filters({ strength: "strong" }), filters({ strength: "corroborating" })],
    ["standing", filters({ standing: "open" }), filters({ standing: "settled" })],
    ["photo", filters({ photo: "kept" }), filters({ photo: "none" })],
    ["customer", filters({ customer: "Ebtissam Alaa ElDin Anwar" }), filters({ customer: "Nobody" })],
    ["speciality", filters({ speciality: "Psychiatry" }), filters({ speciality: "Paediatrics" })],
    ["list", filters({ list: "AM" }), filters({ list: "PM" })],
    ["distance", filters({ distance: "far" }), filters({ distance: "identical" })],
    ["visit day", filters({ visitFrom: "2026-10-03", visitTo: "2026-10-03" }), filters({ visitFrom: "2026-10-05" })],
    ["filed day", filters({ filedFrom: "2026-10-04", filedTo: "2026-10-04" }), filters({ filedTo: "2026-10-03" })],
    ["free text", filters({ text: "2,768" }), filters({ text: "a phrase nothing holds" })],
  ];
  // Sixteen groups and a free-text box is what he was told he was getting; a group quietly dropped
  // from the bar would leave this count behind.
  assert.equal(groups.length, 16, "every filter group he asked for must be covered here");
  for (const [name, passing, failing] of groups) {
    assert.equal(matchesIntegrityFilters(row, passing), true, `the ${name} filter must let its own row through`);
    assert.equal(matchesIntegrityFilters(row, failing), false, `the ${name} filter must narrow the board`);
    assert.equal(hasActiveIntegrityFilter(passing), true, `the ${name} filter must count as active`);
  }

  // The free-text box reads the WORDS, not the codes: he searches for what he can see.
  assert.equal(matchesIntegrityFilters(row, filters({ text: "nozha" })), true, "free text must reach the subject's own name");
  assert.equal(matchesIntegrityFilters(row, filters({ text: "car" })), true, "free text must reach the story itself");

  // 🔴 A ROW WITH NO DAY OF ITS OWN IS KEPT UNTIL A DAY FILTER IS SET, then dropped — never dropped
  // by a field it never had while nothing was asked of it. 161 of the 164 live cases are place cases
  // with no visit date, and the loader falls back to the capture day for exactly this reason.
  const dayless = filterable({ visitDay: null });
  assert.equal(matchesIntegrityFilters(dayless, EMPTY_INTEGRITY_FILTERS), true);
  assert.equal(matchesIntegrityFilters(dayless, filters({ visitFrom: "2026-10-01" })), false);

  // The dropdowns are built from the rows the board actually holds — never a fixed list, which would
  // offer a line with no cases and hide a line that has them.
  const options = integrityFilterOptions([row, filterable({ repName: "Mohamed Ali", repLine: "Pedia", customerList: "PM" })]);
  assert.deepEqual(options.reps, ["Mohamed Ali", "Nada Saied"], "the rep list is derived and sorted");
  assert.deepEqual(options.lines, ["CNS", "Pedia"]);
  assert.deepEqual(options.lists, ["AM", "PM"]);

  // The distance bands, at every boundary. `identical` means the same reading to the bit, which is
  // the 130-case band that was burying everything else.
  assert.equal(integrityDistanceBandOf(null), null, "a case with one reading is in no band at all");
  assert.equal(integrityDistanceBandOf(0), "identical");
  assert.equal(integrityDistanceBandOf(100), "nearby");
  assert.equal(integrityDistanceBandOf(101), "apart");
  assert.equal(integrityDistanceBandOf(1_001), "far");
}

/**
 * 2. THE URL ROUND-TRIPS — exactly, in both directions.
 *
 * The screen writes the filters into the address and the EXPORT ROUTE reads them back out of it. A
 * key written one way and read another would hand him a workbook that is not what is on his screen,
 * and nothing would go red: each half would still be self-consistent.
 */
function runUrlMirrorTests() {
  const chosen = filters({
    rep: "Nada Saied",
    line: "CNS",
    area: "Shoubra",
    region: "Cairo",
    source: "Pin and photograph",
    flag: "The pin and the photograph are 2,768 m apart",
    strength: "strong",
    standing: "open",
    photo: "kept",
    customer: "Ebtissam Alaa ElDin Anwar",
    speciality: "Psychiatry",
    list: "AM",
    distance: "far",
    visitFrom: "2026-10-01",
    visitTo: "2026-10-12",
    filedFrom: "2026-10-02",
    filedTo: "2026-10-13",
    text: "2,768",
  });
  const query = integrityFiltersToQuery(chosen);
  assert.deepEqual(integrityFiltersFromParams(query), chosen, "params → filters → params must round-trip exactly");
  // Re-serialising the parsed filters gives the same address, so a bookmarked link is stable.
  assert.equal(integrityFiltersToQuery(integrityFiltersFromParams(query)).toString(), query.toString());

  // Nothing narrowed is a CLEAN address — not eighteen empty keys.
  assert.equal(integrityFiltersToQuery(EMPTY_INTEGRITY_FILTERS).toString(), "", "an unnarrowed board has a clean address");

  // 🔴 A HAND-EDITED OR TRUNCATED LINK MUST SHOW THE BOARD, NEVER AN EMPTY SCREEN. An unknown value
  // for a fixed group falls back to "all"; an empty screen reads as "no cases", which is a lie.
  const mangled = integrityFiltersFromParams(new URLSearchParams("strength=stron&standing=&photo=maybe&distance=12"));
  assert.equal(mangled.strength, "all");
  assert.equal(mangled.standing, "all");
  assert.equal(mangled.photo, "all");
  assert.equal(mangled.distance, "all");

  // A plain object of search params — what a server component is handed — reads the same as a
  // URLSearchParams, including the repeated-key case a hand-built link can produce.
  assert.equal(integrityFiltersFromParams({ rep: ["Nada Saied", "Someone Else"] }).rep, "Nada Saied");
}

/**
 * 3. EVERY CASE IS A STORY, AND AN UNKNOWN DETECTOR IS STILL ENGLISH.
 *
 * One headline sentence and a paragraph per source, in the house voice: the measured fact, then the
 * ordinary innocent explanation. Never a verdict, never the word fraud, and never a code on screen.
 */
function runStoryTests() {
  const base: CaseStoryInput = {
    source: "capture_trust",
    subjectKind: "visit",
    strong: true,
    flags: ["photo_pin_far"],
    reasons: ["The pin and the photograph are far apart"],
    repName: "Nada Saied",
    customerName: "Ebtissam Alaa ElDin Anwar",
    customerList: "AM",
    customerSpeciality: "Psychiatry",
    subjectLabel: "El Nozha Clinic",
    brickName: "أشمون",
    brickDistanceKm: 1.06,
    placeDistanceMeters: 42,
    readings: [
      { label: "The pin", lat: 30.0444, lon: 31.2357, accuracyMeters: 12, atIso: "2026-10-03T08:20:00Z" },
      { label: "The photograph", lat: 30.0689, lon: 31.2357, accuracyMeters: 20, atIso: "2026-10-03T08:19:40Z" },
    ],
    nearbyVisits: [],
    spreadMeters: 2768,
    accuracyMeters: 12,
    deviceMocked: false,
    signText: null,
    companionNames: [],
    replayByName: null,
    signals: {},
    photoPath: "phoenix-crm/visits/one.jpg",
    visitDate: "2026-10-03",
  };

  // Every detector the board knows, plus one that does not exist yet.
  for (const source of [...Object.keys(INTEGRITY_SOURCE_STORY_LABELS), "a_detector_added_later"]) {
    const story = caseStory({ ...base, source });
    assert.ok(story.headline.length > 0, `${source} must have a headline sentence`);
    assert.ok(story.story.length > 0, `${source} must have a story`);
    const text = [story.headline, ...story.story, ...story.evidence.map((item) => `${item.label} ${item.value}`)].join(" ");
    // 🔴 NO CODE REACHES THE SCREEN. A detector added later must read as its own words opened out,
    // which is the only reason the fallback exists at all.
    assert.ok(!text.includes("_"), `${source} must not print an underscored code: ${text}`);
    // 🔴 AND NO FLAG IS EVER CALLED FRAUD, ON ANY SOURCE (standing rule — a flag is where to look).
    assert.ok(!/\bfraud|\bcheat|\blie[ds]?\b|\bfaked?\b/i.test(text), `${source} must not accuse anybody: ${text}`);
  }

  // The unknown detector reads as words, and the unknown subject kind does too.
  assert.equal(integritySourceStoryLabel("a_detector_added_later"), "a detector added later");
  assert.equal(integritySubjectKindLabel("a_kind_added_later"), "a kind added later");
  assert.equal(integritySourceStoryLabel("signboard"), "Signboard");

  // A flag with no sentence of its own falls back to the reason the board already prints, rather
  // than to its code.
  const unknownFlag = caseStory({ ...base, flags: ["a_flag_added_later"], reasons: ["Something the detector measured"] });
  assert.ok(
    [unknownFlag.headline, ...unknownFlag.story].join(" ").includes("Something the detector measured"),
    "an unknown flag must fall back to the words the board already prints",
  );

  // The measured numbers are in the evidence, so a reader can check the sentences rather than trust
  // them — that is what "more شرح للcase" asked for.
  assert.ok(base.readings.length === 2 && caseStory(base).evidence.length > 0, "the story must carry its own measurements");
}

/**
 * 4. THE LOCATION DIFFERENCE IS MEASURED IN THE PURE MODULE — never in the loader.
 *
 * The loader hands over the POINTS; the metres between them are measured here. Two derivations of one
 * number drift, and then this board and the place-vs-actual report disagree about the same visit with
 * no way for a reader to know which is right.
 */
// THE PANEL HE COULD NOT READ (owner, 13 Oct 2026, 03:05 Cairo: he pasted one capture-trust case
// back and said "i donot understand anything"). Four defects in one panel, every one of them a
// WORDING defect rather than a wrong number — which is exactly why nothing caught them:
//
//   1. THE CUSTOMER NAME PRINTED TWICE. A place case with no venue name of its own built its subject
//      as "the place saved for <customer>" and the sentence then appended "for <customer>" again, so
//      the first line of the panel read "... the place saved for X for X".
//   2. "FILED BY: PIN AND PHOTOGRAPH" — the label says a person and the value is a check.
//   3. "BETWEEN THE PIN AND THE PICTURE: 20 SECONDS", sitting in a list of distances.
//   4. THREE COORDINATES, TWO OF THEM IDENTICAL, AND NOTHING SAYING WHICH ONE WAS DOUBTED. A one-tap
//      capture saves ONE reading and the panel printed it under two names, so a case about two points
//      read as three disagreeing ones — and the reader still had to work out for himself that the odd
//      one is the place pin, and that it is the least precise of them.
//
// Every assertion below fails on the panel he was sent, and that is the point.
function runReadablePanelTests() {
  // His own case, from the panel he pasted: a one-tap capture 2.8 km from the place saved pin.
  const hisCase: CaseStoryInput = {
    source: "capture_trust",
    subjectKind: "place",
    subjectLabel: null,
    strong: true,
    flags: ["photo_pin_far"],
    reasons: ["The pin and the photograph are far apart"],
    repName: "Yasmeen Samy",
    customerName: "Linda Eskandar",
    customerList: "PM",
    customerSpeciality: "Internal Medicine",
    brickName: null,
    brickDistanceKm: 3.2,
    placeDistanceMeters: null,
    readings: [
      { label: "Where the place was captured", lat: 30.439637, lon: 31.171245, accuracyMeters: 25, atIso: null },
      { label: "The pin saved for the place", lat: 30.463103, lon: 31.180882, accuracyMeters: 100, atIso: null },
      { label: "Where the photograph was taken", lat: 30.439637, lon: 31.171245, accuracyMeters: 25, atIso: null },
    ],
    // The visit she saved 96 seconds after validating the place, read from production: 56 m from the
    // pin and 2,822 m from the photograph. It is the whole reason the panel may not rank the two
    // readings by their accuracy figures, and the evidence the new sentence reports.
    nearbyVisits: [{ lat: 30.463512, lon: 31.181219, accuracyMeters: 36, atIso: "2026-10-12T12:58:42Z" }],
    spreadMeters: 2800,
    accuracyMeters: 25,
    deviceMocked: null,
    signText: null,
    companionNames: [],
    replayByName: null,
    signals: { gapSeconds: -20 },
    photoPath: "phoenix-crm/places/one.jpg",
    visitDate: "2026-09-28",
  };

  const story = caseStory(hisCase);
  const opening = story.story[0] ?? "";

  // 1 — the name once, not twice.
  assert.equal(
    opening.split("Linda Eskandar").length - 1,
    1,
    'the opening sentence names the customer ONCE: "the place saved for X for X" is what he was sent',
  );

  const labels = story.evidence.map((item) => item.label);

  // 2 — a check is not a person.
  assert.ok(!labels.includes("Filed by"), 'a check is not a person: "Filed by: Pin and photograph"');
  assert.ok(labels.includes("What raised it"), "the detector is labelled as what raised the case");

  // 3 — a duration is not a distance.
  const gapLabel = labels.find((label) => label.includes("the pin and the picture"));
  assert.equal(gapLabel, "Time between the pin and the picture", "a label in a list of distances held a duration");

  // 4 — one tap is ONE reading, said once, with the odd one out named.
  const coordinateLines = story.evidence.filter((item) => item.value.includes("30.4"));
  assert.equal(coordinateLines.length, 2, "the two identical readings collapse to one line — three coordinates read as three points");
  const shared = coordinateLines.find((item) => item.value.includes("one reading, under both names"));
  assert.ok(shared !== undefined, "the shared line says it is one reading under both names");
  assert.equal(
    shared?.label,
    "Where the place was captured and where the photograph was taken",
    "only the first label of a joined phrase keeps its capital",
  );

  const oddSentence = story.story.find((line) => line.includes("The one that disagrees is"));
  assert.ok(oddSentence !== undefined, "the paragraph names WHICH reading disagrees — the reader should not have to work it out");
  assert.ok(
    oddSentence?.includes("the pin saved for the place"),
    "the odd one out is the place pin, named in lower case mid-sentence",
  );
  // 🔴 AND IT MUST NOT CONCLUDE FROM THE ACCURACY FIGURES. The first draft said "the least precise
  // of them ... so the likelier to be the stale one", and this very case proves that backwards: the
  // photograph carried the TIGHTER figure (25 m against the pin's 100 m) and was the outlier, while
  // the pin and the visit saved 96 seconds later agreed with each other to 56 m. A phone reports a
  // cached position just as confidently as a live one.
  assert.ok(
    oddSentence?.includes("a tighter figure is not a truer reading"),
    "the panel reports both accuracies and refuses to rank them as truth",
  );
  assert.ok(
    oddSentence?.includes("about 100 m") && oddSentence?.includes("about 25 m"),
    "both accuracies are still reported, so the reader can see them",
  );
  for (const banned of ["likelier to be the stale one", "least precise of them"]) {
    assert.ok(!oddSentence?.includes(banned), `the panel does not guess which reading is wrong: "${banned}"`);
  }

  // 5 — THE PHOTOGRAPH IS THE ANCHOR, AND THE VISITS ARE WHAT IS MEASURED AGAINST IT (owner,
  // 13 October 2026: "since u have the accurate validation the photo with location then drop the
  // suspected one and compare visits vs the accurate"). The sentence above can only say that the
  // question is settled by whether anything else from that day sits near one of the readings; this
  // one answers it from the customer's own visits, which the case already carries.
  const visitSentence = story.story.find((line) => line.includes("from the photograph"));
  assert.ok(
    visitSentence !== undefined,
    "the paragraph says how far the customer's own visits sit from the photograph — the pin is dropped from the judgement",
  );
  assert.ok(
    visitSentence?.includes("2.8 km from the photograph"),
    `the metres from the photograph are reported: ${visitSentence}`,
  );
  assert.ok(
    visitSentence?.includes("56 m from the pin saved for the place"),
    `and the metres from the other reading, named: ${visitSentence}`,
  );
  assert.ok(
    visitSentence?.includes("sits with the pin saved for the place, not with the photograph"),
    `it says which of the two the later visit sits with: ${visitSentence}`,
  );
  assert.ok(
    visitSentence?.includes("which is not always the door"),
    "and it closes on the ordinary cause, never on a verdict",
  );
  for (const banned of ["stale", "wrong", "should", "fraud", "faked"]) {
    assert.ok(!visitSentence?.includes(banned), `the sentence concludes nothing: "${banned}"`);
  }

  // Silent where there is nothing to compare: no visit at all, and no photograph reading. Both would
  // otherwise read as "the visits agree with the photograph", which is the opposite of no evidence.
  assert.ok(
    caseStory({ ...hisCase, nearbyVisits: [] }).story.every((line) => !line.includes("from the photograph")),
    "a customer with no visit gets no sentence, never a sentence saying nothing disagrees",
  );
  assert.ok(
    caseStory({ ...hisCase, readings: [hisCase.readings[1]!] }).story.every((line) => !line.includes("from the photograph")),
    "a case with no photograph reading gets no sentence",
  );

  // The other way round, which is the commoner shape: a visit at the door, so the later evidence
  // sits with the photograph and the pin is the one that is out.
  const atTheDoor = caseStory({ ...hisCase, nearbyVisits: [{ lat: 30.439651, lon: 31.171198, accuracyMeters: 9, atIso: null }] });
  const atTheDoorSentence = atTheDoor.story.find((line) => line.includes("from the photograph")) ?? "";
  assert.ok(
    atTheDoorSentence.includes("sits with the photograph, not with the pin saved for the place"),
    `a visit at the door sits with the photograph: ${atTheDoorSentence}`,
  );

  // And it refuses to pick a side on a margin a phone could produce: 1,275 m from the photograph
  // against 1,493 m from the pin is NEARER the photograph, and still no evidence for it — 218 m
  // between them is well inside what a cached fix moves. A point exactly equidistant would prove
  // nothing here, because "nearer" and "clearly nearer" agree on a tie.
  const halfway = caseStory({ ...hisCase, nearbyVisits: [{ lat: 30.450448, lon: 31.175684, accuracyMeters: 20, atIso: null }] });
  const halfwaySentence = halfway.story.find((line) => line.includes("from the photograph")) ?? "";
  assert.ok(
    halfwaySentence.includes("the later visits settle nothing between them"),
    `a visit between the two readings picks no side: ${halfwaySentence}`,
  );

  // 5 — the map block said the same thing twice. Three readings give three pairs, and with two of
  // them on one point two of those pairs carry the identical number: he was sent "... are 2.8 km
  // apart" twice, right above a line saying two of the three are one reading.
  const map = buildCaseMap(hisCase.readings.map((reading) => ({ ...reading })));
  assert.ok(map !== null, "his case draws a map");
  assert.equal(map!.pairs.length, 2, "one line per pair of distinct POINTS, not per pair of labels");
  assert.equal(
    new Set(map!.pairs.map((pair) => pair.text)).size,
    map!.pairs.length,
    "no two lines in the map block say the same thing",
  );
  assert.ok(
    map!.pairs.some((pair) => pair.text.includes("are the same reading, to the bit")),
    "the zero-distance pair is kept — naming both labels IS the finding",
  );
  assert.equal(map!.markers.length, 3, "the markers stay undeduped: two on one pixel is the evidence");

  // A replay case carries ONE coordinate by definition, so the sentence stays silent there rather
  // than inventing a second point for it to disagree with.
  const replay = caseStory({
    ...hisCase,
    source: "position",
    flags: ["coordinate_replay"],
    reasons: ["This coordinate was recorded before"],
    readings: [hisCase.readings[0]!],
    spreadMeters: 0,
    signals: {},
  });
  assert.ok(
    replay.story.every((line) => !line.includes("The one that disagrees is")),
    "a single-reading case names no odd one out",
  );
  assert.ok(
    replay.story.every((line) => !line.includes("from the photograph")),
    "and it measures nothing against a photograph it does not have",
  );
}

function runMapTests() {
  const map = buildCaseMap([
    { label: "The pin", lat: 30.0444, lon: 31.2357, accuracyMeters: 12 },
    { label: "The photograph", lat: 30.0689, lon: 31.2357, accuracyMeters: 20 },
  ]);
  assert.ok(map !== null, "two usable readings must draw a map");
  assert.equal(map.markers.length, 2);
  assert.equal(map.pairs.length, 1, "two readings are one pair");
  assert.ok(map.spreadMeters !== null && Math.round(map.spreadMeters) === 2724, `the spread must be measured, got ${map.spreadMeters}`);
  assert.ok(map.tiles.length > 0 && map.tiles.every((tile) => tile.url.startsWith(OSM_TILE_HOST)), "the tiles are free OpenStreetMap tiles");
  assert.ok(map.attribution.includes("OpenStreetMap"), "the tiles must be attributed");

  // 🔴 ONE READING DRAWS NO SPREAD, AND NO SECOND PIN. A replay case has one coordinate by
  // definition, and inventing a second point for it would be inventing evidence.
  const single = buildCaseMap([{ label: "The pin", lat: 30.0444, lon: 31.2357, accuracyMeters: 12 }]);
  assert.ok(single !== null && single.spreadMeters === null && single.markers.length === 1);
  assert.equal(buildCaseMap([]), null, "a case with no usable reading draws nothing, and the panel says so in words");
  assert.equal(caseSpreadMeters([{ lat: 30, lon: 31 }]), null);

  // 🔴 EVERY FIELD A FILTER READS IS REALLY SET BY THE LOADER'S OWN MAPPING. `filedAt` was
  // declared on `IntegrityCase` and assigned by nothing: the type was satisfied by the OTHER object
  // in the file that happens to carry a `filedAt` key, so the filed-on group read `null` for all 165
  // cases and matched nobody — "no cases" on screen, meaning "no such field". The compiler caught it
  // on the day; this keeps it caught.
  const caseMapping = stripComments(read(LOADER_PATH)).split("const allCases")[1] ?? "";
  assert.notEqual(caseMapping, "", "the board's own case mapping must still be `const allCases`");
  for (const field of ["capturedAt", "filedAt", "visitDate", "photoPath", "readings", "history"]) {
    assert.ok(
      new RegExp(`\\b${field}:`).test(caseMapping),
      `the loader's case mapping must set ${field} — a field nothing assigns is a filter that matches nobody`,
    );
  }

  // The loader still measures nothing at all.
  const loader = stripComments(read(LOADER_PATH));
  assert.ok(
    !/haversine|EARTH_RADIUS|Math\.asin|distanceMeters\(/.test(loader),
    "the loader hands over the points — it must not measure the metres between them",
  );
  const rows = stripComments(read(ROWS_PATH));
  assert.ok(rows.includes("buildCaseMap("), "the row mapping measures the spread once, where the story and the filter both read it");
}

/**
 * 5. ONE MAPPING FOR THE SCREEN AND THE EXPORT, and one copy of every map of words.
 *
 * He asked for an export of what he is looking at. The only thing that keeps that true as either side
 * is touched is that there is ONE mapping and ONE matcher — a second copy in the route would drift the
 * first time a filter learned a new field, and nothing would go red.
 */
function runOneSourceTests() {
  const view = stripComments(read(VIEW_PATH));
  const exportRoute = stripComments(read(EXPORT_ROUTE));

  assert.ok(view.includes("integrityBoardRow("), "the view builds its rows from the shared mapping");
  assert.ok(exportRoute.includes("integrityBoardRows("), "the export builds its rows from the same shared mapping");
  assert.ok(exportRoute.includes("matchesIntegrityFilters("), "the export narrows with the screen's own matcher");
  assert.ok(exportRoute.includes("integrityFiltersFromParams("), "the export reads the filters the screen wrote into the address");
  for (const [name, code] of [["the view", view], ["the export route", exportRoute]] as const) {
    assert.ok(
      !/const [A-Z_]*SUBJECT_KIND_LABELS|const [A-Z_]*SOURCE_STORY_LABELS/.test(code),
      `${name} must read the one map of words, never keep a copy a new kind would not reach`,
    );
  }

  // 🔴 THE EXPORT READS THE BOARD, NOT THE TABLE. Every audience narrowing then applies for free —
  // the SFE's detector allow-list, the `device_mocked` tiering, `is_test = false` — and no second
  // paged read lands in a loader whose read shapes are pinned at exactly two occurrences each.
  assert.ok(exportRoute.includes("loadIntegrityBoard(viewer)"), "the export must read the board");
  assert.ok(
    !/from\(["']phoenix_crm_location_integrity/.test(exportRoute),
    "the export must not query the integrity table itself",
  );

  // Both sheets he was promised, and the Cairo stamp in the filename.
  assert.ok(exportRoute.includes('sheetName: "Cases"') && exportRoute.includes('sheetName: "By rep"'), "two sheets: Cases and By rep");
  assert.ok(/filename = `location-integrity-\$\{stamp\}?/.test(exportRoute) || exportRoute.includes("location-integrity-"), "the file names itself");
  assert.ok(exportRoute.includes("cairoDateTimeSortable"), "the stamp is Cairo local, never raw UTC");
  // 🔴 NO HR ID IN ANY CELL (standing rule: names, never codes). The loader resolves the settling
  // person's name, so the route has no reason to reach for `byHrId` — and `repHrId` is on every case.
  assert.ok(exportRoute.includes("settlement?.byName"), "who settled a case is named");
  assert.ok(!/byHrId|repHrId|\bhrId\b/.test(exportRoute.replace(/access\.hrId/g, "")), "no HR id may reach a cell");

  // 🔴 THE PERSON COLUMN DOES NOT CALL EVERYBODY A REP. A manager's own single visit is filed under
  // his own name (`personOnTheVisit`), and two District Sales Managers already hold 17 such visits on
  // production — printing their names under a column headed "Rep" states something false about a real
  // person, on the one board whose whole purpose is that every line of it is true.
  assert.ok(view.includes('<th className="px-5 py-3">Who</th>'), "the board's person column is headed Who, not Rep");
  assert.ok(!/<th className="px-5 py-3">Rep<\/th>/.test(view), "and never Rep again");
  assert.ok(!/label="Rep"/.test(view), "nor may the filter for that person be labelled Rep");
  assert.equal(
    exportRoute.split('label: "Who"').length - 1,
    2,
    "both export sheets head that column Who — the Cases sheet and the By rep summary",
  );
  assert.ok(!/label: "Rep"/.test(exportRoute), "and neither says Rep");
}

/**
 * 6. THE BULK SETTLE — one note, each case's OWN flags, a 404, and nobody told.
 */
function runBulkSettleTests() {
  const loader = read(LOADER_PATH);
  const at = loader.indexOf("export async function settleManyIntegrityCases");
  assert.ok(at > 0, "the bulk settle lives in the loader beside the single settle");
  const bulk = stripComments(loader.slice(at));

  // 🔴 ONE `.update()` PER ROW, WITH FLAGS READ FROM THE ROW. `settled_flags` is that row's own
  // flags: they are what reopens the case by itself when a detector files a different finding. A
  // single statement over an `.in()` would stamp one case's flags onto the whole batch, which is
  // exactly the state that holds a case closed through a genuinely different finding.
  assert.ok(bulk.includes("settled_flags: flagsNow"), "each row is stamped with its own flags");
  assert.ok(
    /flagsNow = \(Array\.isArray\(row\.flags\)/.test(bulk),
    "the flags are read from the ROW, never from the request",
  );
  // The updates run a few at a time since 2026-10-16 (Phoenix CRM performance audit) — still ONE per
  // ticked case, inside the per-case callback, and read back in the order he ticked them.
  assert.ok(
    /mapWithConcurrency\(caseIds, SETTLE_UPDATES_AT_ONCE, async \(caseId\)[\s\S]*\.update\(\{[\s\S]*\}\)\s*\.eq\("id", caseId\)/.test(bulk),
    "the update is per row, one call per ticked case, narrowed to that case's own id",
  );
  assert.ok(
    /for \(const \[position, caseId\] of caseIds\.entries\(\)\)[\s\S]*outcomes\[position\]/.test(bulk),
    "the answers are read back in the order the cases were ticked, so settled and failed keep his order",
  );
  assert.ok(!/\.update\(\{[\s\S]*\}\)\s*\n?\s*\.in\(/.test(bulk), "a single update over an .in() would stamp one case's flags on the batch");

  // A 404 and never a 403: naming this board is the disclosure.
  assert.ok(bulk.includes("canSettleIntegrityCases(viewer)") && bulk.includes('notFoundError("Not found.")'), "the gate is a 404");
  assert.ok(!/forbidden|403/i.test(bulk), "the refusal must not say forbidden");

  // The note is REQUIRED, capped, and stamped on every selected case (his own answer on shape).
  assert.ok(bulk.includes("cleanText(body.note, INTEGRITY_NOTE_LIMIT)"), "the note is cleaned and capped");
  assert.ok(bulk.includes("validationError(INTEGRITY_NOTE_REQUIRED)"), "the note is required");
  assert.ok(bulk.includes("INTEGRITY_BULK_SETTLE_CAP"), "the batch is capped");

  // Every id is checked, and a failure on one row never stops the rest.
  assert.ok(bulk.includes("isUuid(given)"), "every id is checked");
  assert.ok(/failed\.push\(/.test(bulk) && /return \{ settled, failed \}/.test(bulk), "each failure comes back named");
  assert.ok(/index \+= 50/.test(bulk), "the lookup is chunked — an over-long .in() returns an empty set with no error");

  // Nothing deleted, nobody notified: no rep is ever told he was flagged, so none can be told a flag
  // about him was closed.
  assert.ok(!/\.delete\(/.test(bulk), "nothing is deleted");
  for (const [name, code] of [
    ["the bulk settle", bulk],
    ["the bulk settle route", stripComments(read(SETTLE_MANY_ROUTE))],
    ["the board view", stripComments(read(VIEW_PATH))],
  ] as const) {
    assert.ok(!/createSystemNotification|sendEmail|notifyRep/.test(code), `${name} must not notify anybody`);
  }

  // The seven ready-made reasons, as starting text — no code, no verdict, nobody accused.
  assert.ok(INTEGRITY_SETTLE_PRESETS.length >= 4, "he was promised ready-made reasons");
  for (const preset of INTEGRITY_SETTLE_PRESETS) {
    assert.ok(preset.note.length > 0 && !preset.note.includes("_"), `${preset.id} must read as a sentence`);
    assert.ok(!/\bfraud|\bcheat|\bfaked?\b/i.test(preset.note), `${preset.id} must not accuse anybody`);
  }
}

/**
 * 7. BOTH NEW ROUTES WEAR THE MODULE'S OWN GATE, AND THE EXPORT DID NOT COPY ITS TEMPLATE'S 403.
 */
function runRouteTests() {
  const settleMany = stripComments(read(SETTLE_MANY_ROUTE));
  assert.ok(settleMany.includes("assertSameOriginMutation(request)"), "a mutation is same-origin only");
  assert.ok(settleMany.includes('assertPermission(access, "phoenix_crm", "update")'), "gate one is the module permission");
  assert.ok(settleMany.includes("resolvePhoenixCrmViewer(access)"), "the viewer decides what the service allows");
  assert.ok(settleMany.includes("settleManyIntegrityCases(viewer"), "the route calls the service");
  assert.ok(settleMany.includes("phoenixCrmFailure(error"), "errors go through the module's own failure shape");
  // The answer the view reads: `{ result: { settled, failed } }`.
  assert.ok(/NextResponse\.json\(\{ result, success: true \}\)/.test(settleMany), "the view reads the result under `result`");

  const exportRoute = stripComments(read(EXPORT_ROUTE));
  assert.ok(exportRoute.includes('assertPermission(access, "phoenix_crm", "read")'), "the export is a read");
  assert.ok(exportRoute.includes("assertExportRateLimit("), "an export is rate-limited per person");
  // Asked beside the viewer since 2026-10-16, but still answered BEFORE the heavy read it protects.
  assert.ok(
    exportRoute.indexOf("assertExportRateLimit(") < exportRoute.indexOf("loadIntegrityBoard(viewer)"),
    "the rate limit must refuse before the board is loaded",
  );
  assert.ok(exportRoute.includes("writeAuditLog("), "who took the board, and how much of it, is on the record");
  // Written after the file has gone — never dropped: the best-effort insert is handed to afterResponse.
  assert.ok(
    /afterResponse\("phoenix-crm-integrity-export-audit", \(\) =>\s*writeAuditLog\(/.test(exportRoute),
    "the audit row is deferred past the response, not removed",
  );
  assert.ok(exportRoute.includes("phoenixCrmFailure(error"), "the refusal is the module's — a 404, not a 403");
  // 🔴 THE ONE LINE OF ITS TEMPLATE THAT MUST NOT BE HERE. `app/api/admin/activity/export/route.ts`
  // ends in an `isForbiddenError` branch answering 403 with the resource named; on this board that
  // tells whoever asked that a location-integrity board exists and that they are not allowed on it.
  assert.ok(
    !/isForbiddenError|status: 403|"forbidden"/.test(exportRoute),
    "the export must not answer 403 — naming this board is the disclosure",
  );

  // Both are registered, and both under /api/admin/ — the rep's own app calls /api/phoenix-crm/*, so
  // an address there that reaches the evidence is a disclosure surface whatever it answers.
  const registry = read("../src/lib/security/access-registry.ts");
  assert.ok(
    registry.includes('pattern: "/api/admin/phoenix-crm/integrity/settle-many"'),
    "the bulk settle is in the access registry",
  );
  assert.ok(
    registry.includes('pattern: "/api/admin/phoenix-crm/integrity/export"'),
    "the export is in the access registry",
  );
  const view = stripComments(read(VIEW_PATH));
  assert.ok(
    view.includes('"/api/admin/phoenix-crm/integrity/settle-many"') && view.includes('"/api/admin/phoenix-crm/integrity/export"'),
    "the view calls both addresses under /api/admin/",
  );
}

/**
 * 8. THE SCREEN ITSELF — it fits, it is square, it says nothing it should not, and nothing is cut.
 */
function runScreenTests() {
  const raw = read(VIEW_PATH);
  const view = stripComments(raw);

  // 🔴 THE FITS-THE-SCREEN GOLDEN RULE. `table-fixed` with a colgroup whose widths sum to exactly
  // 100 — an `overflow-x-auto` over a min-width IS the bug this rule exists for.
  assert.ok(view.includes("table-fixed"), "the desktop table is table-fixed");
  const widths = [...view.matchAll(/<col className="w-\[(\d+)%\]"/g)].map((match) => Number(match[1]));
  assert.ok(widths.length > 0, "the table has a colgroup");
  assert.equal(widths.reduce((sum, width) => sum + width, 0), 100, `the colgroup widths must sum to 100, got ${widths.join("+")}`);
  assert.ok(!/overflow-x-auto|min-w-\[\d/.test(view), "a scroller over a min-width is the bug, not the fix");

  // 🔴 THE SQUARE-EDGE GOLDEN RULE — including the native checkboxes, which round themselves.
  // The lookahead has to sit immediately after `rounded`, not after an optional suffix group: with
  // `rounded(-(?!none)[a-z]+)?` the group simply declines to match and the bare `rounded` still does,
  // so the sweep went red on `rounded-none` itself — a square-edge test failing on the square edge.
  assert.ok(!/\brounded(?!-none\b)/.test(view), "no round or semi-round corners anywhere");
  assert.ok(view.includes("rounded-none"), "the native checkbox is squared off explicitly");

  // 🔴 NOTHING ON THIS BOARD IS TRUNCATED. The story paragraph is the longest string the board has
  // ever printed, and a half-printed sign names the wrong person.
  // Comments stripped first: a comment may SAY "never truncated", and the rule is about what the
  // screen prints. An ellipsis inside the hydration note at the top of the view is not a cut string.
  assert.ok(!view.includes("…") && !/\btruncate\b|\bline-clamp-/.test(view), "nothing may be truncated");

  // 🔴 AM AND PM, NEVER DOCTOR OR ACCOUNT (owner, 2026-09-23). The module-wide sweep in
  // `phoenix-crm-am-pm-words.test.ts` does not reach `src/components/crm-integrity/` or
  // `src/lib/crm-integrity/`, so these new files are swept here instead of being quietly exempt.
  for (const path of [
    VIEW_PATH,
    ROWS_PATH,
    "../src/lib/crm-integrity/integrity-board-filters.ts",
    "../src/lib/crm-integrity/integrity-case-story.ts",
    "../src/lib/crm-integrity/integrity-case-map.ts",
    "../src/lib/crm-integrity/integrity-settle-presets.ts",
    EXPORT_ROUTE,
    SETTLE_MANY_ROUTE,
  ]) {
    const offenders = stripComments(read(path))
      .split("\n")
      .filter((line) => /\b(doctor|doctors|account|accounts)\b/i.test(line));
    assert.deepEqual(offenders, [], `${path} must say AM and PM, never doctor or account:\n${offenders.join("\n")}`);
  }

  // The photograph is lazy, and a missing one says so in words rather than leaving a hole: a 165-row
  // board draws every row twice, and the hidden copy of an eager image still loads.
  assert.ok(view.includes("CrmPhotoThumb") && /lazy/.test(view), "the photograph is loaded lazily");
  assert.ok(view.includes("None kept"), "a case with no photograph says so in words");

  // Tiles load only for a case he has actually opened, so a tile host learns an area only for a case
  // he looked at — and the markers and the metres are ours, so the panel is still true with no
  // basemap behind it.
  assert.ok(view.includes("CaseMapPanel"), "the map is its own panel, rendered inside an opened case");
  // The attribution is rendered from the map's own field (its words are `OSM_ATTRIBUTION`, asserted
  // above) — and beside it, the sentence that keeps the panel honest when the tiles do not load: the
  // markers and every metre are ours, so the numbers stand with no streets behind them.
  assert.ok(view.includes("{map.attribution}"), "the basemap is attributed on screen");
  assert.ok(view.includes("the tiles did not load"), "the panel must say when the streets are missing");

  // The URL mirror is `replaceState`, never `router.replace`: the page is ONE server render of about
  // ten chunked reads, and a `router.replace` per keystroke would re-run every one of them.
  assert.ok(view.includes("window.history.replaceState"), "the filters are mirrored with replaceState");
  assert.ok(!/router\.replace\(/.test(view), "a router.replace per keystroke would re-run the whole server read");

  // 🔴 THE ACTED-ON SELECTION IS INTERSECTED WITH WHAT IS ON SCREEN. A tick left behind by a filter
  // change or a fold must never reach the route, and only the ids the route reports as settled are
  // un-ticked — so a failure stays selected for a retry.
  assert.ok(/selectableIds\.filter\(\(id\) => selected\.has\(id\)\)/.test(view), "only ids on screen may be acted on");

  // Strong first, weak folded into a counted band — his own answer on shape. Nothing is hidden: the
  // band SAYS HOW MANY and opens, which is what is pinned here: the counted sentence and the control
  // that lifts the fold. Pinning the identifiers that build the two lists instead pinned a spelling —
  // it went red on a pure refactor that changed no behaviour at all, and would have gone green on a
  // fold that hid the weak cases with no way back to them.
  assert.ok(view.includes("more cases carry corroborating signals only"), "the band says how many cases it folded");
  assert.ok(view.includes("setShowWeak(true)"), "the band opens — nothing is hidden behind the fold");
  assert.ok(/folded \? \(/.test(view), "the fold is a condition on the band, not on the cases");

  // The page keeps the gate and hands its answer in; the view never decides who may settle.
  const page = stripComments(read("../app/(admin)/admin/phoenix-crm/integrity/page.tsx"));
  assert.ok(page.includes("canReadIntegrityBoard") && page.includes("canSettleIntegrityCases"), "the page still gates the board");
  assert.ok(!view.includes("canSettleIntegrityCases("), "the view is handed the answer, it does not decide it");
}

/**
 * 10. THE VISIT AGAINST THE PHOTOGRAPH OF ITS PLACE — the case the owner asked to be able to read.
 *
 * "yes with same requirments i told u before i want the integrity report to show exactly this with
 * story with the pictures and live loc numbers and photos" (13 Oct 2026). So the panel must carry
 * the story, the photograph and the live coordinates with the metres between them — and every number
 * it prints must be the one the detector JUDGED, not a second derivation of it.
 */
function runVisitPhotographCaseTests() {
  // Nourhan Fawzy's worst case, as the detector filed it on production: a visit saved 5,864 m from
  // the photograph the place was validated with, the place's kept point sitting on that photograph.
  const doorLat = 30.0444;
  const doorLon = 31.2357;
  const base: CaseStoryInput = {
    source: "visit_photo",
    subjectKind: "visit",
    strong: false,
    flags: ["visit_far_from_photo", "visit_very_far_from_photo"],
    reasons: ["The visit is far from the photograph of the place", "And more than a kilometre from it"],
    repName: "Nourhan Fawzy Ahmed Ali Moussa",
    customerName: "ليندا اسكندر",
    customerList: "PM",
    customerSpeciality: "Pediatrics",
    subjectLabel: null,
    brickName: null,
    brickDistanceKm: null,
    placeDistanceMeters: 5864,
    readings: [
      { label: CASE_READING_LABELS.visitSaved, lat: 30.0971, lon: 31.2357, accuracyMeters: 18, atIso: "2026-10-08T19:12:00Z" },
      { label: CASE_READING_LABELS.placeOnList, lat: doorLat, lon: doorLon, accuracyMeters: 25, atIso: "2026-09-21T09:02:00Z" },
      { label: CASE_READING_LABELS.placePhotograph, lat: doorLat, lon: doorLon, accuracyMeters: 25, atIso: "2026-09-21T09:02:00Z" },
    ],
    nearbyVisits: [],
    spreadMeters: 5864,
    accuracyMeters: 18,
    deviceMocked: false,
    signText: null,
    companionNames: [],
    replayByName: null,
    signals: { metresFromPhotograph: 5864, farMeters: 300, placeId: "a3f1c2d4-0000-4000-8000-000000000001", photographAtIso: "2026-09-21T09:02:00Z" },
    photoPath: "phoenix-crm/places/one.jpg",
    visitDate: "2026-10-08",
  };

  const story = caseStory(base);
  const text = [story.headline, ...story.story].join(" ");

  // 1 — THE HEADLINE IS THE MEASUREMENT, with the filed metres and the line it was judged against.
  // 🔴 "5.9 km" must come from signals.metresFromPhotograph and not from the coordinates: the
  // detector measured against the photograph it CHOSE (the nearest captured before the visit), and a
  // panel re-deriving it would print a different number for a customer with two clinics.
  assert.match(story.headline, /5\.9 km/, `the headline must print the judged distance: ${story.headline}`);
  assert.match(story.headline, /photograph/i, "and say what it was measured against");
  assert.match(story.headline, /300 m/, "and name the line the settings call far");
  // 2 — the second flag is a different question, and it says so.
  assert.ok(text.includes("more than a kilometre"), `the kilometre sentence must be in the story: ${text}`);

  // 3 — THE PHOTOGRAPH IS THE PLACE'S, NOT THIS CALL'S, AND THE PANEL STILL SAYS SO — in the heading
  // and the alt text over the picture itself, rather than as one of the numbered points. A one-tap
  // visit keeps no picture at all, so "the photograph is below, as it was sent" would tell the
  // reader he is looking at this rep's own photograph of this visit. Moved out of the story on
  // 2026-10-13 at the owner's instruction ("too much text … story listed pointed 1, 2, 3"): a line
  // describing the picture directly beneath it spent one of five points saying what he can see.
  assert.ok(!text.includes("as it was sent"), "it is not this rep's own photograph of this call");
  const photoViewSource = readFileSync(
    new URL("../src/components/crm-integrity/integrity-board-view.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(photoViewSource.includes("The photograph of the place"), "the heading says whose photograph it is");
  assert.ok(
    photoViewSource.includes("The photograph the place was validated with"),
    "and the alt text says it too, for a reader who cannot see the picture",
  );

  // 4 — THE ODD READING, WITHOUT THE ONE-TAP CLAIM. The two agreeing readings here are the point
  // kept for the place and the place's own photograph, which coincide because the kept point was
  // TAKEN from the photograph — not because somebody saved both in a single tap.
  const odd = oddReadingSentence(base);
  assert.ok(odd !== null, "three readings with two identical must name the odd one out");
  assert.ok(!odd.includes("single tap"), `the one-tap clause is wrong on this case: ${odd}`);
  assert.ok(odd.includes("the point kept for the place is the photograph's own reading"), `and the real reason must be given: ${odd}`);
  assert.ok(odd.includes("where the visit was saved"), `the odd reading is the visit's own fix: ${odd}`);
  // And the one-tap clause is still right where it IS right — a place's pin and its photograph.
  const oneTap = oddReadingSentence({
    ...base,
    readings: [
      { label: CASE_READING_LABELS.pin, lat: doorLat, lon: doorLon, accuracyMeters: 12, atIso: null },
      { label: CASE_READING_LABELS.photograph, lat: doorLat, lon: doorLon, accuracyMeters: 12, atIso: null },
      { label: CASE_READING_LABELS.placeOnList, lat: 30.0971, lon: 31.2357, accuracyMeters: 30, atIso: null },
    ],
  });
  assert.ok(oneTap !== null && oneTap.includes("saved in a single tap"), `a one-tap capture must still say so: ${oneTap}`);

  // 5 — THE LIVE COORDINATES AND THE METRES, so he can check the sentence instead of trusting it.
  const evidence = new Map(story.evidence.map((item) => [item.label, item.value]));
  assert.ok([...evidence.keys()].some((label) => /photograph of the place/i.test(label)), `the filed metres must be in the evidence: ${[...evidence.keys()].join(" | ")}`);
  assert.equal(
    story.evidence.find((item) => /photograph of the place/i.test(item.label))?.value,
    "5.9 km",
    "and it must be the judged figure",
  );
  const coordinates = story.evidence.filter((item) => /\d+\.\d{6}, \d+\.\d{6}/.test(item.value));
  assert.equal(coordinates.length, 2, `two distinct points, not three lines for them: ${coordinates.map((item) => item.label).join(" | ")}`);
  assert.ok(
    coordinates.some((item) => item.value.includes("one reading, under both names")),
    "the place's kept point and its photograph are one reading and must be grouped, not printed twice",
  );

  // 6 — NOTHING IS CONCLUDED, AND THE ORDINARY CAUSE CLOSES IT. A visit is saved where the phone is
  // when the box is filled in, which is not always the door — that is an ordinary day.
  assert.ok(/Usually/.test(text), `the ordinary cause must be given: ${text}`);
  assert.ok(/car outside|lift|next clinic/.test(text), "and it must be the real one for this detector");
  assert.ok(!/fraud|cheat|fake|lying|dishonest/i.test(text), `no case accuses anybody: ${text}`);
  assert.ok(!text.includes("_"), `no code reaches the screen: ${text}`);

  // 7 — THE LOADER HANDS OVER THE ANCHOR'S OWN PHOTOGRAPH, and only on the cases judged against it.
  const loader = read(LOADER_PATH);
  assert.match(loader, /function anchorPlaceIdOf\(row: Row\)/, "the loader must resolve the place the case was JUDGED against");
  assert.match(loader, /signals\.placeId/, "and it is signals.placeId, which is not always the visit's own place_id");
  assert.match(
    loader,
    /if \(row\.source === "visit_photo"\) \{\s*\n\s*add\(CASE_READING_LABELS\.placePhotograph/,
    "the place's photograph is a reading only on the cases that were measured against it",
  );
  assert.match(
    loader,
    /\.\.\.rows\.map\(\(row\) => anchorPlaceIdOf\(row\)\)/,
    "and that place must be READ, or the panel resolves to the visit's own place or to nothing",
  );

  // 8 — AND THE PANEL CAPTIONS IT AS WHAT IT IS. The picture was taken by whoever validated the
  // place, on whatever day that was: this rep's name and this visit's time belong to neither.
  const view = read(VIEW_PATH);
  assert.match(view, /entry\.source === "visit_photo"/, "the caption must switch on the source");
  assert.match(view, /The photograph of the place/, "and say it is the place's photograph");
  assert.match(view, /photographAtIso/, "stamped with the photograph's own Cairo time, not the visit's");
}

// THE PANEL HE CAN READ IN SECONDS (owner, 2026-10-13: "you are putting too much text with which
// will make me not understand … I want it as easy as visits, location versus the validation location
// with a story listed pointed 1, 2, 3 and the life map photo and clear English. Don't make me enter
// a loop."). Four things are pinned here, because each one is a way the panel grew back: the story
// is NUMBERED and capped, the two locations are a comparison of their own ABOVE the words, the
// measurements are FOLDED AWAY, and the cap can never eat the ordinary cause.
function runShortPanelTests() {
  const caseOf = (over: Partial<CaseStoryInput>): CaseStoryInput => ({
    source: "visit_photo",
    subjectKind: "visit",
    subjectLabel: null,
    strong: false,
    flags: ["visit_far_from_photo"],
    reasons: ["The visit is far from the photograph"],
    repName: "Mahmoud ElHassanin",
    customerName: "Linda Eskandar",
    customerList: "AM",
    customerSpeciality: "Pediatrics",
    brickName: null,
    brickDistanceKm: null,
    placeDistanceMeters: null,
    readings: [
      { label: CASE_READING_LABELS.visitSaved, lat: 30.44, lon: 31.17, accuracyMeters: 11.9, atIso: "2026-10-12T09:10:00Z" },
      { label: CASE_READING_LABELS.placePhotograph, lat: 30.47, lon: 31.2, accuracyMeters: 42.6, atIso: "2026-10-03T08:48:22Z" },
      { label: CASE_READING_LABELS.pin, lat: 30.465, lon: 31.195, accuracyMeters: 100, atIso: null },
    ],
    nearbyVisits: [],
    spreadMeters: 3236,
    accuracyMeters: 11.9,
    deviceMocked: null,
    signText: null,
    companionNames: [],
    replayByName: null,
    signals: { metresFromPhotograph: 3236, farMeters: 300 },
    photoPath: "phoenix-crm/places/one.jpg",
    visitDate: "2026-10-12",
    ...over,
  });

  // 1 — FIVE POINTS AT MOST, for every detector the board knows. The paragraph that replaced used to
  // run to eight and twelve lines, which is the complaint itself.
  for (const source of Object.keys(INTEGRITY_SOURCE_STORY_LABELS)) {
    const story = caseStory(caseOf({ source }));
    assert.ok(
      story.story.length <= 5,
      `${source} prints ${story.story.length} points — the panel is capped at five (owner, 2026-10-13)`,
    );
    assert.ok(story.story.length > 0, `${source} must still say something`);
  }

  // 1b — AND THE CAP IS REAL ON A CROWDED CASE, not merely true of a thin one. This case has every
  // optional line the module can produce — two findings, an odd reading, the visits against the
  // photograph, the ordinary cause and no photograph kept — which is seven points uncapped.
  const crowded = caseStory(
    caseOf({
      flags: ["visit_far_from_photo", "visit_very_far_from_photo"],
      reasons: ["far from the photograph", "more than a kilometre"],
      photoPath: null,
      nearbyVisits: [{ lat: 30.4705, lon: 31.2005, accuracyMeters: 36, atIso: "2026-10-12T09:12:00Z" }],
      readings: [
        { label: CASE_READING_LABELS.visitSaved, lat: 30.44, lon: 31.17, accuracyMeters: 11.9, atIso: "2026-10-12T09:10:00Z" },
        { label: CASE_READING_LABELS.placePhotograph, lat: 30.47, lon: 31.2, accuracyMeters: 42.6, atIso: "2026-10-03T08:48:22Z" },
        { label: CASE_READING_LABELS.placeOnList, lat: 30.47, lon: 31.2, accuracyMeters: 42.6, atIso: null },
      ],
    }),
  );
  assert.ok(
    crowded.story.length <= 5,
    `a crowded case prints ${crowded.story.length} points — the panel is capped at five (owner, 2026-10-13)`,
  );

  // 2 — THE CAP CANNOT EAT THE ORDINARY CAUSE. A case with four findings prints the strongest two and
  // the cause, never four accusations and no explanation.
  const manyFlags = caseStory(
    caseOf({
      flags: ["visit_far_from_photo", "visit_very_far_from_photo", "photo_pin_far", "device_mocked"],
      reasons: ["far from the photograph", "more than a kilometre", "pin and photograph far apart", "the phone reported a mock location"],
    }),
  );
  assert.ok(manyFlags.story.length <= 5, `four flags must still fit in five points: ${manyFlags.story.length}`);
  assert.ok(
    manyFlags.story.some((line) => line.startsWith("Usually:")),
    `the ordinary cause survives the cap: ${manyFlags.story.join(" | ")}`,
  );

  // 3 — THE TWO LOCATIONS ARE A COMPARISON OF THEIR OWN, and the validation side is the PHOTOGRAPH,
  // never the pin — the anchor he ruled on, with the pin dropped from the judgement.
  const comparison = caseStory(caseOf({})).comparison;
  assert.ok(comparison !== null, "a case with two distinct readings has a comparison");
  assert.equal(comparison.capture.label, CASE_READING_LABELS.visitSaved, "the capture side is where the visit was saved");
  assert.equal(
    comparison.validation.label,
    CASE_READING_LABELS.placePhotograph,
    `the validation side is the photograph, not the pin: ${comparison.validation.label}`,
  );
  assert.match(comparison.apart, /km|m/, `the distance is printed in words: ${comparison.apart}`);
  assert.ok(comparison.apartMeters > 300, `and the metres come through for the view to colour on: ${comparison.apartMeters}`);
  assert.match(comparison.capture.coordinates, /^30\.440000, 31\.170000$/, "each side prints its own coordinate");

  // A single-coordinate case — every replay case — says so instead of inventing a second location.
  const oneReading = caseStory(caseOf({ readings: [caseOf({}).readings[0]!] })).comparison;
  assert.equal(oneReading, null, "one reading cannot be a comparison");

  // 4 — THE PANEL'S OWN SHAPE: the comparison first, the story as an ORDERED list, the measurements
  // folded into a details element rather than open beside the photograph.
  const view = readFileSync(new URL("../src/components/crm-integrity/integrity-board-view.tsx", import.meta.url), "utf8");
  const panel = stripComments(view);
  assert.ok(panel.includes("<CaseComparisonPanel comparison={story.comparison} />"), "the panel opens with the two locations");
  assert.ok(panel.includes("list-decimal"), "the story is a numbered list, not a paragraph (owner: 1, 2, 3)");
  assert.ok(/<ol[^>]*list-decimal/.test(panel), "and it is an <ol>, so the numbers are the list's own");
  assert.ok(panel.includes("The measurements behind this"), "the measurements are folded away behind a summary");
  assert.ok(
    panel.indexOf("<CaseComparisonPanel") < panel.indexOf("list-decimal"),
    "the comparison comes BEFORE the words, which is how he reads a case",
  );
  assert.ok(
    panel.indexOf("list-decimal") < panel.indexOf("The measurements behind this"),
    "and the measurements come after the story, not in front of it",
  );
  assert.ok(panel.includes("The two locations on the map"), "the map is labelled as the two locations");
}

export function runCrmIntegrityBoardViewTests() {
  runFilterGroupTests();
  runUrlMirrorTests();
  runStoryTests();
  runReadablePanelTests();
  runShortPanelTests();
  runMapTests();
  runOneSourceTests();
  runBulkSettleTests();
  runRouteTests();
  runScreenTests();
  runVisitPhotographCaseTests();
}
