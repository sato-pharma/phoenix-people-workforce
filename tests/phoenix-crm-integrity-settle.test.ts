import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { INTEGRITY_NOTE_LIMIT, isSettledIntegrityRow, readIntegritySettlement, sameIntegrityFlags } from "@/lib/phoenix-crm/integrity-settlement";
import { PHOENIX_CRM_INTEGRITY_LABELS, PHOENIX_CRM_STRONG_INTEGRITY_FLAGS } from "@/lib/phoenix-crm/location-integrity";
import { INTEGRITY_SOURCES, INTEGRITY_SUBJECT_KINDS, integritySourceLabel, integritySubjectKindLabel } from "@/lib/phoenix-crm/server/integrity-board";

// 🔴 `stripSqlComments`, never a line filter. A `--` written after code on the same line survives a
// line-wise strip, and a `/* … */` block survives entirely — so a negative assertion fails on the
// comment and a positive one passes on a file that no longer has the thing it pins
// (`tests/comment-strip-ratchet.test.ts` refuses the shape in the required `validate` job).
import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

// SETTLING A LOCATION-INTEGRITY CASE, AND THE FIFTH DETECTOR THAT WAS NOT IN THE READER (2026-10-09).
//
// Two things ship together here, and they are the same defect seen from two sides: the board could
// only be read, so there was nowhere for the owner to record that he had looked — and the reader did
// not know every detector by name, so a case could be labelled as evidence it is not.
//
//   1. `capture_trust` WAS MISSING FROM `IntegritySource`, exactly as `signboard` had been. Both were
//      allowed by the table's `source` CHECK in migration 20261008023051 and only `signboard` was
//      added to the reader a day later. `capture_trust` escaped the same bug by accident: it files on
//      a place VALIDATION rather than on a nightly pass, so production held 0 of its rows on the 9th
//      and the first rep whose photo fix and capture pin disagreed would have had his case printed as
//      **Position**. The fix is one exported list every other piece derives from, and the pin below
//      reads the FILERS' own string literals — because the column is text and the compiler cannot.
//
//   2. SETTLING IS FOUR COLUMNS AND A COMPARISON, never a status. `settled_flags` holds the flags the
//      settlement was taken on, and a case counts as settled only while those still equal the row's.
//      So a detector filing a new finding on the same subject — the filers upsert on
//      (subject_kind, subject_id, source), replacing `flags` in place — reopens the case by itself,
//      and not one filer had to learn that settling exists. A status enum would have been the earlier
//      mistake one step along: it says a case is closed without saying WHAT was closed.

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const BOARD = read("../src/lib/phoenix-crm/server/integrity-board.ts");
const PAGE = read("../app/(admin)/admin/phoenix-crm/integrity/page.tsx");
// The three case lists, with the filter bar, the stories, the maps and the BULK settle. They left
// the page on 2026-10-13 because every one of those is interaction; the page keeps the counters, the
// callouts and the gate whose answer it passes through.
const VIEW = read("../src/components/crm-integrity/integrity-board-view.tsx");
// 🔴 OUTSIDE `src/components/phoenix-crm/`, WHICH IS THE REP'S OWN BUNDLE. Every file under that
// directory is swept by `tests/phoenix-crm-blind-half.test.ts` and may not say "integrity" at all —
// the rep must never learn the judging exists. The admin board's own button therefore lives with the
// other integrity UI, and the same reasoning puts its routes under `/api/admin/`.
const CONTROL = read("../src/components/crm-integrity/integrity-settle.tsx");
const REGISTRY = read("../src/lib/security/access-registry.ts");
// The other two readers of the table that must honour a settlement — the behaviour board's
// strong-case gate and Phoenix Ranks' nightly score. Section 5.
const BEHAVIOUR = read("../src/lib/phoenix-crm/server/behaviour.ts");
const RANKS = read("../src/lib/rep-ranks/server/compute.ts");
const MIGRATION = read("../supabase/migrations/20261009190708_phoenix_crm_integrity_settlement.sql");

/** Every file that writes a row into `phoenix_crm_location_integrity`. */
const FILERS = [
  "../src/lib/phoenix-crm/server/location-integrity.ts",
  "../src/lib/phoenix-crm/server/photo-dupes.ts",
];

/** The nightly pass that drives the three 2026-10-12 detectors, and the board's own page. */
const SILENT = read("../src/lib/phoenix-crm/server/silent-detectors.ts");
const SILENT_MIGRATION = read("../supabase/migrations/20261012210000_phoenix_crm_silent_detectors.sql");
/**
 * The migration that CURRENTLY describes the `source` CHECK — widened again on 2026-10-13 for the
 * ninth detector, the visit against the photograph of its place.
 *
 * 🔴 IT IS A SEPARATE READ FROM `SILENT_MIGRATION` ON PURPOSE. Only the newest `drop constraint` +
 * `add constraint` pair describes the table, and the two constraints have moved on different days:
 * `subject_kind` was last restated by the 2026-10-12 migration and `source` by this one. One
 * constant for both would make widening either silently compare the reader against the wrong file —
 * which is exactly how this pin went red on correct code on 2026-10-12.
 */
const VISIT_PHOTO_MIGRATION = read("../supabase/migrations/20261013150000_phoenix_crm_visit_photograph_source.sql");

const SETTLED = {
  settledAt: "2026-10-09T18:40:00.000Z",
  settledBy: "B-10",
  settledNote: "Spoke to him; the sign is the landlord's and the plate is inside.",
};

// ── 1. Every detector that files is in the list the board reads ───────────────

function sourceUnionTests(): void {
  // 🔴 THE FILERS' OWN LITERALS, not a list written here. `source` is a text column and each filer
  // writes a string, so nothing in the type system connects the two — this is the only place the
  // connection is made, and it is why `signboard` could print as Position for a day.
  const filed = new Set<string>();
  for (const path of FILERS) {
    const source = stripComments(read(path));
    for (const match of source.matchAll(/source:\s*"([a-z_]+)"/g)) filed.add(match[1]);
  }
  assert.ok(filed.size >= 3, `no integrity filer literals were found at all — the scan is reading the wrong files (${[...filed].join(", ")})`);
  for (const source of filed) {
    assert.ok(
      (INTEGRITY_SOURCES as readonly string[]).includes(source),
      `the detector filing source: "${source}" is not in INTEGRITY_SOURCES — its cases will print as Position on the owner's board, which is what happened to signboard on 2026-10-08`,
    );
  }
  // The two the 2026-10-08 migration added, named explicitly: a scan that silently stopped finding
  // literals would otherwise pass with an empty set.
  for (const source of ["signboard", "capture_trust"]) {
    assert.ok((INTEGRITY_SOURCES as readonly string[]).includes(source), `${source} must be in INTEGRITY_SOURCES`);
  }

  // The database's own CHECK and the reader's list must hold the same five values. A value the table
  // allows but the reader does not know is a case waiting to be mislabelled; one the reader knows and
  // the table refuses is a filer that will fail at 23514.
  // 🔴 THE LATEST MIGRATION THAT RESTATES THE CHECK, NOT THE ONE THAT FIRST WIDENED IT. This read
  // pointed at 20261008023051 until 2026-10-12, when the three roster/cadence/coverage detectors
  // replaced that constraint — and the pin then compared the reader's eight values with that
  // migration's five and went red on correct code. A `drop constraint` + `add constraint` pair means
  // only the newest one describes the table, so moving this path is part of widening the CHECK.
  const check = stripSqlComments(VISIT_PHOTO_MIGRATION).match(/check\s*\(source in \(([^)]*)\)\)/i);
  assert.ok(check, "the source CHECK is no longer readable from migration 20261013150000");
  const allowed = [...check[1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
  assert.deepEqual(
    [...allowed].sort(),
    [...INTEGRITY_SOURCES].sort(),
    "the table's source CHECK and INTEGRITY_SOURCES have drifted apart",
  );
  // The three the 2026-10-12 migration added, named explicitly, for the same reason `signboard` and
  // `capture_trust` are above: a scan that silently stopped finding literals would pass on an empty set.
  for (const source of ["roster", "cadence", "coverage"]) {
    assert.ok((INTEGRITY_SOURCES as readonly string[]).includes(source), `${source} must be in INTEGRITY_SOURCES`);
  }
  // And the ninth (2026-10-13). Named here as well as read out of the migration, for the same reason
  // the five above are: a scan that silently stopped matching would pass on an empty set.
  assert.ok((INTEGRITY_SOURCES as readonly string[]).includes("visit_photo"), "visit_photo must be in INTEGRITY_SOURCES");
  assert.equal(integritySourceLabel("visit_photo"), "Visit against the photograph");
  // 🔴 The label names what was COMPARED and never what it means. A detector that reads as an
  // accusation on this board is the one thing the owner's standing rule refuses outright.
  assert.ok(
    !/suspic|fake|fraud|lying|dishonest/i.test(integritySourceLabel("visit_photo")),
    "a detector label is a measurement, never a verdict about a person",
  );

  // AND THE WEEKLY SCAN'S OWN COPY OF THE LIST. `FraudScanCase.source` in `fraud-scan-rules.ts`
  // restates the eight values by hand, and it is NOT free to import the authority: that file sits in
  // a rep's bundle, so `tests/phoenix-crm-blind-half.test.ts` check 2 refuses any comment-stripped
  // mention of `integrity-board` there — an `import type` included, though the compiler erases it.
  // 🔴 SO THE DRIFT HAS TO BE CAUGHT HERE, AND IT BIT ON 2026-10-12: the three new detectors widened
  // `INTEGRITY_SOURCES` while this union still named five, and the board's reader — which stamps the
  // source onto each `FraudScanCase` — stopped compiling (TS2322). The type was right to refuse the
  // assignment; nothing was mislabelled. But a compile error is the LAST line, not a check: had the
  // reader still collapsed its sources into `gps`, the union would have been satisfied and three
  // detectors would have been invisible to every Thursday scan, which is the 2026-10-08 defect again.
  const scanRules = stripComments(read("../src/lib/phoenix-crm/fraud-scan-rules.ts"));
  const union = scanRules.match(/source:\s*((?:"[a-z_]+"\s*\|\s*)*"[a-z_]+")\s*;/);
  assert.ok(union, "FraudScanCase.source is no longer readable as a union of string literals");
  assert.deepEqual(
    [...union[1].matchAll(/"([a-z_]+)"/g)].map((match) => match[1]).sort(),
    [...INTEGRITY_SOURCES].sort(),
    "FraudScanCase.source and INTEGRITY_SOURCES have drifted apart — the weekly scan cannot import the authority, so this is the only thing holding them equal",
  );

  // Every member has plain English. A label that falls back to the code would print `capture_trust`
  // at the owner, who reads names and never codes.
  for (const source of INTEGRITY_SOURCES) {
    const label = integritySourceLabel(source);
    assert.notEqual(label, source, `${source} has no label of its own — the board would print the raw code`);
    assert.match(label, /^[A-Z]/, `${source}'s label should read as a word, not a code (${label})`);
  }
  assert.equal(integritySourceLabel("capture_trust"), "Capture trust");
  // 🔴 It must NOT read as a position verdict. That confusion is the whole defect being fixed.
  assert.ok(!/position/i.test(integritySourceLabel("capture_trust")), "capture trust is not position evidence");

  // The tally is derived, never a second list. The hard-coded tuple is exactly what let the breakdown
  // hide the signboard cases while the mapper hid them too.
  const board = stripComments(BOARD);
  assert.match(board, /bySource: INTEGRITY_SOURCES\.flatMap/, "the detector tally must iterate INTEGRITY_SOURCES");
  // There must be exactly ONE such array in the file: the declaration itself. The check removes it
  // first — anything of that shape left over is the second list this whole refactor exists to kill.
  const declaration = /export const INTEGRITY_SOURCES = \[[^\]]*\] as const;/;
  assert.match(board, declaration, "INTEGRITY_SOURCES must be declared as one `as const` array");
  assert.ok(
    !/\["gps", "photo", "behaviour"/.test(board.replace(declaration, "")),
    "integrity-board.ts still carries a hand-written list of detectors beside INTEGRITY_SOURCES",
  );
  // And the row's own coercion goes through the list, not a chain of ORs — the shape that swept an
  // unknown source into `gps`.
  assert.match(board, /source: isIntegritySource\(row\.source\) \? row\.source : "gps"/, "a row's source must be read through the list");
}

// ── 1b. Every subject kind the table allows is a kind the board knows ────────

/**
 * THE SAME DEFECT AS `signboard`, ONE COLUMN ACROSS (2026-10-12).
 *
 * `subject_kind` is text with a CHECK, exactly as `source` is, and until today it had no exported
 * list: the reader coerced it with `row.subject_kind === "place" ? "place" : "visit"` and the visit
 * distance lookup gathered ids with `!== "place"`. So a third kind would have printed on the owner's
 * board as a VISIT and had its id looked up in `phoenix_crm_visits`, which answers nothing and leaves
 * the case reading as a visit saved at its place. Two of the new detectors file exactly such a kind.
 */
function subjectKindTests(): void {
  const board = stripComments(BOARD);

  const check = stripSqlComments(SILENT_MIGRATION).match(/check\s*\(subject_kind in \(([^)]*)\)\)/i);
  assert.ok(check, "the subject_kind CHECK is no longer readable from migration 20261012210000");
  const allowed = [...check[1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
  assert.deepEqual(
    [...allowed].sort(),
    [...INTEGRITY_SUBJECT_KINDS].sort(),
    "the table's subject_kind CHECK and INTEGRITY_SUBJECT_KINDS have drifted apart",
  );
  for (const kind of ["shared_place", "customer"]) {
    assert.ok((INTEGRITY_SUBJECT_KINDS as readonly string[]).includes(kind), `${kind} must be in INTEGRITY_SUBJECT_KINDS`);
  }

  // Every kind has plain English, and none of them prints the raw code at the owner.
  for (const kind of INTEGRITY_SUBJECT_KINDS) {
    const label = integritySubjectKindLabel(kind);
    assert.notEqual(label, kind, `${kind} has no label of its own — the board would print the raw code`);
    assert.match(label, /^[A-Z]/, `${kind}'s label should read as a sentence, not a code (${label})`);
  }
  assert.equal(integritySubjectKindLabel("shared_place"), "A shared venue");
  assert.equal(integritySubjectKindLabel("customer"), "A customer");

  // 🔴 THE POSITIVE FORM, in all three places a kind decides something. A negative test
  // (`!== "place"`) reads "everything that is not a place is a visit id", which is the bug.
  assert.match(board, /subjectKind: isIntegritySubjectKind\(row\.subject_kind\) \? row\.subject_kind : "visit"/, "a row's subject kind must be read through the list");
  assert.match(board, /rows\.filter\(\(row\) => row\.subject_kind === "visit"\)/, "only a visit's id may be looked up in phoenix_crm_visits");
  assert.equal(
    /row\.subject_kind !== "place"/.test(board),
    false,
    "integrity-board.ts still decides a subject by what it is NOT — the shape that would read a customer id as a visit",
  );

  // And the BOARD prints the label rather than its own two-way guess. The markup moved to the client
  // view on 2026-10-13 and this pin moved with it; the loader's map moved too, into the pure story
  // module, so there is still exactly ONE of them (a client component cannot import this server
  // file, and the view's first draft had carried a second copy).
  const view = stripComments(VIEW);
  // 🔴 BOTH SITES, COUNTED — the desktop table row and the mobile card each print the kind. A
  // `match` here was satisfied by either one, so a break that left the other as its own
  // place-or-visit guess passed on 2026-10-12. The same hole as `getLeaveDayMap`'s two branches.
  assert.equal(
    [...view.matchAll(/integritySubjectKindLabel\(row\.entry\.subjectKind\)/g)].length,
    2,
    "both the desktop row and the mobile card must print the subject kind through its label",
  );
  for (const [name, code] of [["the board page", stripComments(PAGE)], ["the board view", view]] as const) {
    assert.equal(
      /\bsubjectKind === "place"/.test(code),
      false,
      `${name} still carries its own place-or-visit guess, so a venue or a customer would print as a visit`,
    );
  }
  assert.equal(
    [...view.matchAll(/const INTEGRITY_SUBJECT_KIND_LABELS|SUBJECT_KIND_LABELS: Record/g)].length,
    0,
    "the view must read the one subject-kind map, never keep a copy that a new kind would not reach",
  );
}

// ── 1c. The three silent detectors file weak, tell nobody, and refuse nothing ─

function silentDetectorTests(): void {
  const silent = stripComments(SILENT);

  // The pass is wired into the nightly sweep. A detector nothing calls is a detector that files nothing.
  const sweep = stripComments(read("../src/lib/phoenix-crm/server/photo-dupes.ts"));
  assert.match(sweep, /await runPhoenixCrmSilentSweep\(/, "the nightly sweep must run the silent pass");

  // 🔴 EVERY NEW FLAG IS WEAK. `PHOENIX_CRM_STRONG_INTEGRITY_FLAGS` is the one gate between this
  // table and a rep's own score, so a promotion here moves a number he can read.
  for (const flag of ["visit_on_leave", "visit_on_full_day_activity", "companion_off_duty", "customer_revisited_fast", "place_brick_far"]) {
    assert.ok(
      PHOENIX_CRM_INTEGRITY_LABELS[flag as keyof typeof PHOENIX_CRM_INTEGRITY_LABELS],
      `${flag} has no plain English — the board would print the raw code at the owner`,
    );
    assert.equal(
      (PHOENIX_CRM_STRONG_INTEGRITY_FLAGS as readonly string[]).includes(flag),
      false,
      `${flag} is STRONG, so it now moves the rep-visible Integrity score — every detector the 2026-10-12 audit added files weak`,
    );
  }

  // 🔴 EACH FILES UNDER ITS OWN `source`. Filing under "gps" would replace judgeCapture's verdict on
  // the same subject through the (subject_kind, subject_id, source) unique key.
  const filer = stripComments(read("../src/lib/phoenix-crm/server/location-integrity.ts"));
  for (const [fn, source] of [["fileVisitRosterFlags", "roster"], ["fileCustomerCadenceFlag", "cadence"], ["filePlaceCoverageFlag", "coverage"]]) {
    const start = filer.indexOf(`export async function ${fn}(`);
    assert.ok(start > 0, `${fn} is no longer in server/location-integrity.ts`);
    // 🔴 THE SLICE ENDS ON `onConflict`, which the upsert itself must produce. A window running to the
    // end of the file would reach the NEXT filer's own `source:` literal and pass on a deleted one.
    const body = filer.slice(start);
    const end = body.indexOf("onConflict");
    assert.ok(end > 0, `${fn}'s upsert no longer names its conflict target`);
    const upsert = body.slice(0, end);
    assert.ok(upsert.includes(`source: "${source}"`), `${fn} must file under source: "${source}", never another detector's`);
    assert.ok(
      upsert.includes("PHOENIX_CRM_STRONG_INTEGRITY_FLAGS.includes(flag)"),
      `${fn} must compute strong from the shared list, never write it by hand`,
    );
  }

  // 🔴 IT TELLS NOBODY AND HOLDS NOTHING. The owner's two standing rules on this module, as source.
  for (const banned of [/sendNotification/, /sendEmail/, /hold_review/, /\.update\(/, /\.delete\(/]) {
    assert.equal(banned.test(silent), false, `the silent pass must not ${banned.source} — it reads, files evidence, and stops`);
  }

  // The full-day door, and the measurement behind it: a half-day leave is not a day off.
  assert.match(silent, /getFullDayApprovedLeaveMap\(/, "the roster check must read FULL-DAY approved leave, never every approved leave");
  assert.match(silent, /\.eq\("half_day", false\)/, "a half-day activity is not a day away from the field");
  const workingDays = stripComments(read("../src/lib/attendance/working-days.ts"));
  // 🔴 BOTH BRANCHES, COUNTED. `getLeaveDayMap` has two: a batched one when `employeeHrIds` is
  // given and an unfiltered one when it is not — and the CRM sweep uses the FIRST. A `match` here
  // was satisfied by either, so on 2026-10-12 a break that removed the narrowing from the batched
  // branch left this test GREEN while every half-day leave came back for the one caller that matters.
  assert.equal(
    [...workingDays.matchAll(/if \(dayParts\) query = query\.in\("day_part", dayParts\);/g)].length,
    2,
    "both of getLeaveDayMap's branches must narrow on day_part in the QUERY — the batched one is what Phoenix CRM uses",
  );
  assert.match(workingDays, /statuses: \["approved"\], dayParts: \["full_day"\]/, "getFullDayApprovedLeaveMap must ask for full_day only");
  // 🔴 AND THE MONEY PATH IS UNTOUCHED. Absence counting wants every approved leave whatever its part.
  assert.match(
    workingDays,
    /getApprovedLeaveDayMap[\s\S]{0,400}?getLeaveDayMap\(\{ \.\.\.input, statuses: \["approved"\] \}\)/,
    "getApprovedLeaveDayMap must still ask for every day part — absence counting and pay read it",
  );

  // The two refusals, recorded in the source so a later session does not re-chase them from the
  // audit workbook. Both were measured on production 2026-10-12.
  const silentWithComments = SILENT;
  assert.match(silentWithComments, /SHARED PHONE NUMBER ACROSS CUSTOMERS/, "the refused shared-phone detector and its measurement must stay recorded here");
  assert.match(silentWithComments, /10,397 of 11,560/, "the refused no-place-to-compare detector must keep its measurement");
  // And neither was built after all. Read from the COMMENT-STRIPPED source, so the explanation of the
  // refusal cannot satisfy the check that the refusal holds.
  assert.equal(/phoneKey|shared_phone\b|no_place_to_compare/.test(silent), false, "a refused detector must not be half-built");
}

// ── 2. The settlement rule: stamped flags, and reopening by itself ────────────

// ── 8. The fifth silent pass: the visit against the photograph of its place ───

/**
 * Added 2026-10-13 on the owner's own instruction — "since u have the accurate validation the photo
 * with location then drop the suspected one and compare visits vs the accurate", then "i want the
 * integrity report to show exactly this with story with the pictures and live loc numbers and
 * photos".
 *
 * Measured on production that day: of 1,286 visits measurable against a photograph captured before
 * them, 48 sit past the live 300 m line, 46 survive the accuracy guard, 14 are over a kilometre and
 * the worst is 5,864 m, across 16 named reps. 45 are filed — the 46th names no rep.
 */
function visitPhotographPassTests(): void {
  const silent = stripComments(SILENT);

  // 🔴 WIRED INTO THE RUNNER, NOT MERELY WRITTEN. A detector nothing calls files nothing, and the
  // only thing that would ever say so is this assertion: the pass would compile, keep its tests, and
  // the board would stay empty for ever.
  assert.match(silent, /async function runVisitPhotographGap\(/, "the fifth pass must exist");
  assert.match(
    silent,
    /await runVisitPhotographGap\(todayIso, result, \{ visits: windowVisits, places: activePlaces \}\);/,
    "runPhoenixCrmSilentSweep must CALL the fifth pass — a detector nothing calls files nothing",
  );

  // ── The fifth pass reuses passes 1 and 3's reads (Phoenix CRM performance audit, 2026-10-16) ──
  // 🔴 ONLY A WHOLE READ IS HANDED ON. The fifth pass asks a narrower question of the same window;
  // below the ceiling that is the matching rows of the wider read, but a wider read that stopped at
  // its ceiling holds FEWER of them than the narrower read would, and the pass would quietly look at
  // less. So a capped read is handed on as null, and the pass then reads for itself.
  assert.match(silent, /const whole: WholeRead = read\.capped \? null : visits;/, "pass 1 hands its window on only when it was read whole");
  assert.match(silent, /return read\.capped \? null : read\.rows;/, "and pass 3 its places only when they were read whole");
  // The narrowing is the narrower read's own filter, nothing more and nothing less.
  assert.match(
    silent,
    /narrowedFrom\(wholeReads\.visits, \(visit\) => visit\.lat !== null && visit\.lat !== undefined\)/,
    "the window is kept to the visits with a reading — the photograph read's own .not(\"lat\", \"is\", null)",
  );
  assert.match(
    silent,
    /narrowedFrom\(wholeReads\.places, \(place\) => place\.photo_lat !== null && place\.photo_lat !== undefined\)/,
    "and the places to those whose photograph carries a fix — its own .not(\"photo_lat\", \"is\", null)",
  );
  // The wider reads carry every column the fifth pass reads off a row.
  assert.match(silent, /product_manager_hr_id, lat, lon, accuracy_meters"\)/, "pass 1's read carries each visit's own reading");
  assert.match(silent, /status, photo_lat, photo_lon, photo_accuracy_meters, photo_captured_at, photo_path"/, "pass 3's read carries each place's photograph fix and path");
  // And the passes keep their order — the fifth still runs last.
  const runner = silent.slice(silent.indexOf("export async function runPhoenixCrmSilentSweep("));
  const order = ["runRosterAndCadence(", "runCoverage(", "runSharedVenues(", "runVisitPhotographGap("].map((name) => runner.indexOf(name));
  assert.ok(order.every((at, index) => at > 0 && (index === 0 || at > order[index - 1]!)), "the five passes still run one after another, in their order");

  // 🔴 THE CADENCE FILINGS OF ONE CUSTOMER STAY IN WALK ORDER. The customer is the subject, two
  // people can each have called the same one, and both findings upsert one row — the later one
  // stands. Filed side by side they would race, and which finding stands would be chance.
  assert.match(
    silent,
    /mapWithConcurrency\(\[\.\.\.cadenceByCustomer\.values\(\)\], FILINGS_AT_ONCE, async \(filings\) => \{\s*for \(const filing of filings\) await fileCustomerCadenceFlag\(filing\);\s*\}\)/,
    "a customer's cadence filings go one after another; only different customers go side by side",
  );

  // The far line is the module's own live setting, never a constant in the pass. A second copy of
  // 300 m would let this detector and the visit's own stored location_flag disagree about what far
  // means, on the same row, on the same screen.
  assert.match(silent, /const config = await loadPhoenixCrmConfig\(\);/, "the far line is read live from the module's settings");
  assert.match(silent, /const farMeters = config\.settings\.visitFarMeters;/, "and it is visitFarMeters, the one the rep's own flag already uses");

  // 🔴 A MANAGER'S OWN VISIT IS FILED UNDER HIS OWN NAME, NOT SKIPPED. An empty rep_hr_id is the
  // design and not a lost rep — scope.ts writes manager_hr_id and no rep when a manager enters a
  // single visit — so reading the rep column alone left all 17 such rows on production checked by
  // nothing, one of them 3,236 m from the photograph of the place it names. Both visit-keyed walks
  // resolve the subject through personOnTheVisit, and there are exactly two of them.
  assert.equal(
    silent.split("personOnTheVisit({").length - 1,
    2,
    "both visit-keyed walks (roster/cadence and the photograph) must resolve the subject through personOnTheVisit",
  );
  assert.ok(
    !/const repHrId = visit\.rep_hr_id \? String\(visit\.rep_hr_id\)\.toUpperCase\(\) : "";/.test(silent),
    "no pass may take the rep column alone as the subject — that is what made a manager's own visit invisible",
  );
  // The photograph pass reads the column it now depends on. Without it personOnTheVisit is handed
  // undefined for ever and the fix silently does nothing.
  assert.match(
    silent,
    /select\("id, seat_id, rep_hr_id, manager_hr_id, customer_id, visit_date, captured_at, lat, lon, accuracy_meters"\)/,
    "the photograph pass must read manager_hr_id, or the subject can never resolve to the manager",
  );
  // 🔴 AND THE SUBJECT IS NEVER HIS OWN COMPANION: on a manager's own single visit he is both the
  // person and the row's manager_hr_id, so leaving him in the companion list files his own leave day
  // twice — once as his, once as "somebody else was with him".
  assert.match(
    silent,
    /\.filter\(\(hrId\) => hrId !== "" && hrId !== repHrId\)/,
    "the subject must be excluded from his own companions",
  );
  // A visit naming nobody at all is still filed against nobody.
  assert.match(
    silent,
    /if \(!repHrId \|\| !customerId \|\| !visitDate\) continue;/,
    "a visit naming nobody, no customer or no day is skipped, never filed against nobody",
  );

  // The anchor is a photograph captured BEFORE the visit: a clinic validated in October must not
  // retroactively make a September visit far — nor near.
  assert.match(silent, /String\(place\.captured_at \?\? ""\) <= capturedAtIso/, "the anchor must be a photograph captured before the visit");
  // And the NEAREST eligible one, because a customer with two clinics is at whichever door the rep
  // stood at: judging him against the further one files a finding the data itself refutes.
  assert.match(silent, /verdict\.metres < nearest\.metres/, "the nearest eligible photograph is the anchor, not the first one read");

  // Keyed on customer AND seat, as the rest of the module is — a customer is a row per seat here,
  // and keying on the customer alone measures one territory's visit against another's door.
  assert.match(silent, /customerId\}\|\$\{String\(visit\.seat_id/, "the anchor lookup must be keyed on customer AND seat");

  // The filer, and what it stamps. subject_kind is the VISIT: the finding is about one visit, and
  // filing it against the place would collide with that place's own capture-trust case through
  // UNIQUE (subject_kind, subject_id, source).
  const filer = stripComments(read("../src/lib/phoenix-crm/server/location-integrity.ts"));
  assert.match(filer, /export async function fileVisitPhotographGap\(/, "the filer must exist");
  assert.match(filer, /source: "visit_photo"/, "it files under the ninth detector's own source");
  // 🔴 STRENGTH COMES FROM THE SHARED LIST, NEVER FROM A LITERAL HERE. That list is the one gate the
  // rep's own Integrity score and countedIntegrityFlags share, so a filer writing strong: true by
  // hand would move a number every rep can read — which "flag it, never stop the rep" refuses.
  //
  // 🔴 READ OUT OF THIS FILER'S OWN BODY, not out of the file. Eight other filers in it already name
  // the list, so a whole-file match stayed green with this one hard-coding its strength — which is
  // the only defect the assertion exists to catch.
  const gapFilerStart = filer.indexOf("export async function fileVisitPhotographGap(");
  assert.ok(gapFilerStart > 0, "fileVisitPhotographGap must be readable as its own function");
  const gapFilerEnd = filer.indexOf("\nexport ", gapFilerStart + 1);
  const gapFiler = filer.slice(gapFilerStart, gapFilerEnd === -1 ? undefined : gapFilerEnd);
  assert.match(
    gapFiler,
    /strong: input\.flags\.some\(\(flag\) => PHOENIX_CRM_STRONG_INTEGRITY_FLAGS\.includes\(flag\)\)/,
    "strength must come from the shared strong-flag list, never from a literal in this filer",
  );
  assert.ok(!/strong: (true|false)/.test(gapFiler), "and never from a literal");
  assert.match(gapFiler, /subject_kind: "visit"/, "the finding is about one visit, not about the place");

  // The metres the panel prints are the metres the detector JUDGED, filed on the row. Re-deriving
  // them in the loader or the view would let the sentence and the evidence table disagree about the
  // same pair of coordinates.
  assert.match(silent, /metresFromPhotograph: Math\.round\(nearest\.metres\)/, "the judged distance must be filed, not re-derived later");

  // Nothing is sent to anybody. The whole board is silent by design (owner, 2026-10-02).
  assert.ok(
    !/notify|sendEmail|telegram/i.test(silent),
    "no detector in the nightly sweep may notify anybody — this board is read, never sent",
  );
}

function settlementRuleTests(): void {
  const flags = ["sign_other_name", "photo_pin_drifted"];

  const standing = readIntegritySettlement({ ...SETTLED, settledFlags: flags, flagsNow: flags });
  assert.ok(standing, "a settlement whose stamped flags still match the row must be read");
  assert.equal(standing.byHrId, "B-10");
  assert.equal(standing.note, SETTLED.settledNote);
  assert.deepEqual(standing.flagsThen, flags);

  // 🔴 THE REOPENING. A NEW finding on the same subject replaces `flags` in place (the filers upsert
  // on subject_kind, subject_id, source), and the settlement stops describing the row — so the case
  // is standing again, in the counters and in the weekly scan, with no filer and no job involved.
  assert.equal(
    readIntegritySettlement({ ...SETTLED, settledFlags: flags, flagsNow: [...flags, "device_mocked"] }),
    null,
    "a case flagged again after it was settled must read as standing",
  );
  // A flag going AWAY is a different row too, and the same answer: the settlement was taken on a
  // case that no longer exists in that shape.
  assert.equal(readIntegritySettlement({ ...SETTLED, settledFlags: flags, flagsNow: ["sign_other_name"] }), null);
  // Order is the detector's business. A filer rebuilding the same flags in a different order must
  // not look like a new finding — that would reopen every case it touched.
  assert.ok(readIntegritySettlement({ ...SETTLED, settledFlags: flags, flagsNow: [...flags].reverse() }));
  assert.ok(sameIntegrityFlags(["a", "b"], ["b", "a"]));
  assert.ok(!sameIntegrityFlags(["a", "b"], ["a", "a"]));

  // Never settled at all, and a settlement nobody owns: both are somewhere to look.
  assert.equal(readIntegritySettlement({ settledAt: null, settledBy: null, settledNote: null, settledFlags: null, flagsNow: flags }), null);
  assert.equal(readIntegritySettlement({ ...SETTLED, settledNote: null, settledFlags: flags, flagsNow: flags }), null, "a settlement with no reason is not read");
  assert.equal(readIntegritySettlement({ ...SETTLED, settledBy: null, settledFlags: flags, flagsNow: flags }), null, "a settlement with no author is not read");

  // The migration refuses a half-written settlement rather than relying on the reader above.
  assert.match(MIGRATION, /settled_at timestamptz/);
  assert.match(MIGRATION, /settled_flags text\[\]/);
  assert.match(
    MIGRATION,
    /check\s*\(\s*\(settled_at is null and settled_by is null and settled_note is null and settled_flags is null\)/,
    "the migration must refuse a settlement that is only partly written",
  );
  // 🔴 ADDITIVE ONLY. Nothing in this migration may drop, delete or rewrite a row — the evidence is
  // the point of the table, and the board's whole reason for having no resolution column before was
  // that clearing a flag meant destroying it.
  const sql = stripSqlComments(MIGRATION);
  for (const forbidden of [/\bdelete\s+from\b/i, /\bdrop\s+column\b/i, /\btruncate\b/i, /\bupdate\s+public\./i]) {
    assert.ok(!forbidden.test(sql), `the settlement migration must not ${String(forbidden)} — it only adds columns`);
  }
}

// ── 3. Who may settle, and the three gates that say so ───────────────────────

function settleGateTests(): void {
  const board = stripComments(BOARD);
  // The Super Admin alone, and not a test persona — the same shape as every other decision in the
  // module. 🔴 THE SFE MANAGER READS THIS BOARD AND DOES NOT SETTLE ON IT (owner, 2026-10-09).
  assert.match(
    board,
    /export function canSettleIntegrityCases\(viewer: PhoenixCrmViewer\): boolean \{\s*return viewer\.isSuperAdmin && viewer\.canUpdate && !viewer\.isTestPersona;/,
    "settling is the Super Admin's alone, never a test persona, and never the SFE Manager",
  );
  assert.ok(!/canSettleIntegrityCases[\s\S]{0,120}isSfeManager/.test(board), "the SFE Manager must not reach the settle gate");

  // Both mutations refuse before they read anything.
  for (const name of ["settleIntegrityCase", "reopenIntegrityCase"]) {
    const body = board.slice(board.indexOf(`export async function ${name}`));
    // 🔴 A 404, NEVER A 403 — the same refusal the board's own read uses. "Only the Super Admin
    // settles these" would tell whoever asked that the board exists and that cases are closed on it.
    assert.match(body.slice(0, 700), /if \(!canSettleIntegrityCases\(viewer\)\) throw notFoundError/, `${name} must refuse before it reads a row`);
    assert.ok(!/forbiddenError/.test(body), `${name} must not explain itself with a 403`);
  }

  // The note is required to settle and NOT to reopen: closing a case about a named person has to be
  // answerable later, deciding to look again must never be discouraged.
  const settle = board.slice(board.indexOf("export async function settleIntegrityCase"), board.indexOf("export async function reopenIntegrityCase"));
  assert.match(settle, /INTEGRITY_NOTE_REQUIRED/, "settling without a reason must be refused");
  const reopen = board.slice(board.indexOf("export async function reopenIntegrityCase"));
  assert.ok(!/INTEGRITY_NOTE_REQUIRED/.test(reopen.slice(0, 900)), "reopening must not demand a note");

  // 🔴 THE STAMPED FLAGS ARE READ FROM THE ROW, never taken from the request. A client-supplied list
  // could claim to cover flags the row does not carry, which is precisely the state that would keep a
  // case closed through a new finding.
  assert.match(settle, /\.select\("id, flags"\)/, "settling must read the row's current flags itself");
  assert.match(settle, /settled_flags: flagsNow/, "the settlement stamps the flags read from the row");
  assert.ok(!/body\.flags|raw\.flags/.test(settle), "the flags a settlement is stamped with must never come from the browser");

  // Reopening clears all four together, because the table's CHECK allows nothing else.
  assert.match(reopen, /settled_at: null, settled_by: null, settled_note: null, settled_flags: null/);

  // Neither mutation deletes or rewrites the evidence.
  for (const body of [settle, reopen.slice(0, 1200)]) {
    assert.ok(!/\.delete\(\)/.test(body), "settling never deletes a row");
    assert.ok(!/flags:|strong:|signals:/.test(body.replace(/settled_flags:/g, "")), "settling never rewrites what the detector found");
  }

  // 🔴 NEITHER ROUTE LIVES IN THE REP'S NAMESPACE. `/api/phoenix-crm/*` is the address space the
  // rep's own app calls, and nothing there may reach the evidence — `integrity-board` is a silent
  // module (`tests/phoenix-crm-blind-half.test.ts`, check 4), and the registry records why the old
  // `/api/phoenix-crm/integrity` GET was deleted in 2026-09-26: an address a curious rep can probe
  // is itself a disclosure. The admin namespace keeps that space empty.
  assert.ok(
    !REGISTRY.includes('pattern: "/api/phoenix-crm/integrity'),
    "the settle routes must not be registered in the rep's own /api/phoenix-crm namespace",
  );

  // Both routes exist, are registered as audited CSRF-guarded mutations, and ask for `update`.
  for (const pattern of ["/api/admin/phoenix-crm/integrity/settle", "/api/admin/phoenix-crm/integrity/reopen"]) {
    const line = REGISTRY.split("\n").find((entry) => entry.includes(`pattern: "${pattern}"`));
    assert.ok(line, `${pattern} is not in the access registry`);
    assert.match(line, /classification: "mutation", required: true/, `${pattern} is an audited mutation`);
    assert.match(line, /permission: \{ resource: "phoenix_crm", action: "update" \}/, `${pattern} asks for phoenix_crm.update`);
    assert.match(line, /csrfRequired: true/, `${pattern} is same-origin only`);
  }
  for (const route of ["../app/api/admin/phoenix-crm/integrity/settle/route.ts", "../app/api/admin/phoenix-crm/integrity/reopen/route.ts"]) {
    const source = stripComments(read(route));
    assert.match(source, /assertSameOriginMutation/, `${route} must assert same origin`);
    assert.match(source, /assertPermission\(access, "phoenix_crm", "update"\)/, `${route} must assert the permission`);
  }
}

// ── 4. The board and the page keep their promises ────────────────────────────

function boardAndPageTests(): void {
  const board = stripComments(BOARD);
  // A settled case leaves the live list and the counters, and the withdrawn section keeps its meaning.
  assert.match(board, /const cases = standing\.filter\(\(entry\) => entry\.settlement === null\)/, "a settled case must leave the findings");
  assert.match(board, /const settled = standing\.filter\(\(entry\) => entry\.settlement !== null\)/);
  assert.match(board, /strongCount: cases\.filter\(\(entry\) => entry\.strong\)\.length/, "the strong counter counts the live cases only");

  // 🔴 SETTLING MEANS THE SAME THING ON EVERY SURFACE THAT READS THIS TABLE — the weekly fraud scan
  // here, and the other two readers in section 5. A case he closed on the board must not arrive on
  // Saturday as a fresh finding.
  const window = board.slice(board.indexOf("export async function loadIntegrityCasesForWindow"));
  assert.match(window, /settled_at, settled_by, settled_note, settled_flags/, "the weekly scan must read the settlement columns");
  assert.match(window, /\.filter\(\(row\) => !isSettledIntegrityRow\(row\)\)/, "the weekly scan must drop settled cases by the shared row test");

  // The page: the button is the Super Admin's, the withdrawn list offers no decision, and every
  // state has a counter rather than vanishing.
  const page = stripComments(PAGE);
  assert.match(page, /const canSettle = canSettleIntegrityCases\(viewer\)/, "the page asks the same predicate the service does");
  const view = stripComments(VIEW);
  assert.match(view, /<CaseList canSettle=\{false\} entries=\{filtered\.filter/, "a withdrawn case has nothing to settle");
  assert.match(view, /<CaseList canSettle=\{canSettle\} entries=\{filtered\.filter\(\(row\) => row\.standing === "settled"\)\}/);
  assert.match(page, /label="Settled"/, "a settled case is counted by name, never silently absent");
  // 🔴 WHOLE TAILWIND CLASSES. A grid class assembled at runtime is never generated, and the row
  // would quietly stay one-up at every width.
  assert.match(page, /const COUNTER_GRID = \["sm:grid-cols-3", "sm:grid-cols-2 xl:grid-cols-4", "sm:grid-cols-2 xl:grid-cols-5"\]/);
  assert.ok(!/grid-cols-" \+|grid-cols-\$\{/.test(page), "the counter grid must not build a Tailwind class at runtime");

  // The control wears the system's skin — no hand-written box (the one form design, owner 2026-10-06).
  const control = stripComments(CONTROL);
  assert.match(control, /crmTextareaClassName/, "the note field uses the system's textarea token");
  assert.ok(!/className="[^"]*\bborder border-slate-300\b[^"]*bg-white/.test(control), "the settle control must not paint its own field");
  assert.match(control, /maxLength=\{INTEGRITY_NOTE_LIMIT\}/);
  assert.equal(INTEGRITY_NOTE_LIMIT, 500);
  // 🔴 NOBODY IS NOTIFIED. No rep is ever told he was flagged, so none can be told a flag about him
  // was closed — not from the control, and not from the service.
  for (const [name, source] of [
    ["the settle control", control],
    ["the board view", view],
    ["integrity-board.ts", board],
  ] as const) {
    assert.ok(!/createSystemNotification|sendEmail|notifyRep/.test(source), `${name} must not notify anybody about a settlement`);
  }
}

// ── 5. Every reader of the table honours a settlement ────────────────────────

/**
 * Four readers now, and ONE rule between them — `readIntegritySettlement` for the board, which
 * prints the settlement, and `isSettledIntegrityRow` for the three that need only the yes/no.
 *
 * 🔴 A READER THAT RE-IMPLEMENTS `settled_flags = flags` IS THE DEFECT THIS SECTION EXISTS TO CATCH.
 * The first implementation of the comparison compared lengths and then membership one way, which
 * answered "unchanged" for ["a","b"] against ["a","a"] and would have held a case closed through a
 * genuinely different finding. One function, or that mistake returns per reader.
 *
 * And each reader must actually ASK for the four columns: a PostgREST select is a string the
 * compiler never checks, and a missing column fails the whole read rather than one field.
 */
function everyReaderHonoursSettlementTests(): void {
  const flags = ["mock_provider", "impossible_travel"];
  const row = (extra: Record<string, unknown>) => ({ flags, ...extra });

  // The row-shaped test, on the database's own column names.
  assert.ok(isSettledIntegrityRow(row({ settled_at: SETTLED.settledAt, settled_by: SETTLED.settledBy, settled_note: SETTLED.settledNote, settled_flags: flags })));
  assert.ok(!isSettledIntegrityRow(row({ settled_at: null, settled_by: null, settled_note: null, settled_flags: null })), "a case nobody settled is standing");
  assert.ok(
    !isSettledIntegrityRow(row({ settled_at: SETTLED.settledAt, settled_by: SETTLED.settledBy, settled_note: SETTLED.settledNote, settled_flags: ["mock_provider"] })),
    "a case flagged again since it was settled is standing — the reopening, at row level",
  );
  assert.ok(
    !isSettledIntegrityRow(row({ settled_at: SETTLED.settledAt, settled_by: null, settled_note: SETTLED.settledNote, settled_flags: flags })),
    "a settlement nobody owns must not clear anything",
  );
  // Order is the detector's business here too, and a repeated flag is not a new finding.
  assert.ok(isSettledIntegrityRow(row({ settled_at: SETTLED.settledAt, settled_by: SETTLED.settledBy, settled_note: SETTLED.settledNote, settled_flags: [...flags].reverse() })));

  // Reader 3 — the behaviour board's strong-case gate (owner, 2026-10-09). A settled case is not the
  // company a save-time pattern needs: using a closed case to unlock a new suspicion about the same
  // person is precisely what settling decided against.
  const behaviour = stripComments(BEHAVIOUR);
  const gate = behaviour.slice(behaviour.indexOf("async function readStrongCaseReps"));
  assert.match(gate, /settled_at, settled_by, settled_note, settled_flags/, "the strong-case gate must read the settlement columns");
  assert.match(gate, /flags,/, "and `flags`, or the comparison has nothing to compare against");
  assert.match(gate, /\.filter\(\(row\) => !isSettledIntegrityRow\(row\)\)/, "the strong-case gate must drop settled cases");

  // Reader 4 — Phoenix Ranks' nightly score (owner, 2026-10-09). Its own suite pins the arithmetic;
  // what belongs here is that it goes through the shared rule at all.
  const ranks = stripComments(RANKS);
  const ranksRead = ranks.slice(ranks.indexOf("async function readIntegrityFlags"));
  assert.match(ranksRead, /settled_at, settled_by, settled_note, settled_flags/, "the rank read must read the settlement columns");
  assert.match(ranksRead, /rankCountedFlags\(/, "the rank penalty must go through the function that honours a settlement");

  // 🔴 NOBODY HAND-ROLLS THE COMPARISON. A reader writing its own `settled_flags` test is how the
  // length-check bug comes back, one file at a time.
  for (const [name, source] of [["behaviour.ts", gate], ["compute.ts", ranksRead]] as const) {
    assert.ok(
      !/settled_flags\s*(===|!==|\.length)/.test(source),
      `${name} must not compare settled_flags itself — isSettledIntegrityRow is the one test`,
    );
  }
}

export function runPhoenixCrmIntegritySettleTests() {
  sourceUnionTests();
  subjectKindTests();
  silentDetectorTests();
  visitPhotographPassTests();
  settlementRuleTests();
  settleGateTests();
  boardAndPageTests();
  everyReaderHonoursSettlementTests();
  console.log("phoenix-crm integrity settle: OK");
}
