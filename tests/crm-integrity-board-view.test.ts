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
import { caseStory, INTEGRITY_SOURCE_STORY_LABELS, integritySourceStoryLabel, integritySubjectKindLabel, type CaseStoryInput } from "../src/lib/crm-integrity/integrity-case-story.ts";
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
  assert.ok(/for \(const caseId of caseIds\)[\s\S]*\.update\(/.test(bulk), "the update is per row, inside the loop");
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
  assert.ok(exportRoute.includes("writeAuditLog("), "who took the board, and how much of it, is on the record");
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

export function runCrmIntegrityBoardViewTests() {
  runFilterGroupTests();
  runUrlMirrorTests();
  runStoryTests();
  runMapTests();
  runOneSourceTests();
  runBulkSettleTests();
  runRouteTests();
  runScreenTests();
}
