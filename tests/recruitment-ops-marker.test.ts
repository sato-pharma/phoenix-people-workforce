// Recruitment / ATS — the ops re-read stamp must carry the day the run actually happened, and every
// reader of it must match on the prefix rather than on a whole marker.
//
// The incident this pins, found 2026-08-29. `ats_candidate_cv_extractions.created_by` separates an
// unattended batch from a human Talent Acquisition review. The batch side was a hardcoded literal,
// `ops:cv-reread-20260816`, so every run after the first inherited the first one's date. Production
// (ozucdzovmcqvepbozvqf), that evening:
//
//     created_by                  rows   first Cairo         last Cairo
//     ops:cv-reread-20260816       579   2026-08-16 01:27    2026-08-29 20:13
//
// Fourteen days and at least four separate runs, all claiming the sixteenth. `created_at` was never
// wrong so nothing was mis-decided, but the stamp exists so that `created_by` can be read ON ITS
// OWN — and read on its own it stated a false date.
//
// THE PAIR IS THE POINT. scripts/recruitment-apply-reread-fields.ts counted re-read rows with
// `created_by === OPS_MARKER` against its own copy of the same literal. The two files agreed only
// because both were frozen, so correcting either one alone would have silently zeroed the other's
// count — a fix that looks complete and reports nothing. Sections 5 and 6 below are what stop that
// pair being re-formed, in either direction.
//
// The day is Africa/Cairo and that is not decoration: the original batch began 01:27 Cairo, which is
// 23:27 UTC on the fifteenth. A UTC stamp would have dated it `20260815`. The one window where the
// two calendars disagree is the window these long unattended jobs are actually started in.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  CV_REREAD_MARKER_PREFIX,
  cvRereadOpsMarker,
  isCvRereadMarker,
} from "../src/lib/recruitment/ops-marker.ts";

const MODULE = "src/lib/recruitment/ops-marker.ts";
const WRITERS = [
  "scripts/recruitment-reread-never-read-cvs.ts",
  "scripts/recruitment-reread-legacy-schema-cvs.ts",
];
const READER = "scripts/recruitment-apply-reread-fields.ts";
// A finished one-shot, kept here so section 5b can assert it is left alone.
const ONE_SHOT = "scripts/recruitment-split-forwarded-candidates.ts";

const read = (relative: string) => readFileSync(path.join(process.cwd(), relative), "utf8");

// Only line-leading `//` is stripped, so a `//` inside a URL survives. Comments go first wherever
// this file scans for a frozen VALUE: the paragraphs above the constants deliberately quote
// `ops:cv-reread-20260816` as history, and a guard that cannot tell a quotation from code would
// force that explanation to be deleted to stay green.
const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");

/** Today in Africa/Cairo as YYYYMMDD, derived here so the module cannot certify its own answer. */
const cairoDayNow = () => new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" }).split("-").join("");

export function runRecruitmentOpsMarkerTests() {
  // --- 1. The prefix is a DATA CONTRACT, not a naming choice -------------------------------------
  // 579 rows in production already carry a value beginning with it. Renaming the prefix does not
  // rename them: isCvRereadMarker would simply stop recognising every re-read ever made, and the
  // count that reports them would read zero without erroring.
  assert.equal(CV_REREAD_MARKER_PREFIX, "ops:cv-reread-");
  for (const historical of ["ops:cv-reread-20260816", "ops:cv-reread-legacy-schema-20260824"]) {
    assert.ok(
      isCvRereadMarker(historical),
      `${historical} is already stored in production and must keep matching — a prefix change orphans the rows written under the old one`,
    );
  }

  // --- 2. THE HEADLINE. The stamp is today's Cairo day, not a frozen date ------------------------
  const marker = cvRereadOpsMarker();
  assert.ok(marker.startsWith(CV_REREAD_MARKER_PREFIX), `${marker} must start with ${CV_REREAD_MARKER_PREFIX}`);
  const day = marker.slice(CV_REREAD_MARKER_PREFIX.length);
  assert.match(day, /^\d{8}$/, `the marker's suffix must be a bare YYYYMMDD day, got "${day}"`);
  assert.equal(
    day,
    cairoDayNow(),
    "the marker must carry TODAY's Africa/Cairo day — if this reads as a past date the literal has been frozen again, and if it is one day off the stamp has been computed in UTC",
  );
  assert.notEqual(
    marker,
    "ops:cv-reread-20260816",
    "the marker is the frozen literal again; that value dated 579 rows across 14 days as though they were one batch",
  );

  // --- 3. A variant batch keeps its name, and still reads as a re-read ---------------------------
  const variant = cvRereadOpsMarker("legacy-schema");
  assert.equal(variant, `ops:cv-reread-legacy-schema-${cairoDayNow()}`);
  assert.ok(isCvRereadMarker(variant), "a variant batch is still a re-read and must match the prefix");

  // --- 4. It never claims a person's review was a machine's --------------------------------------
  // These are real created_by values from production. A matcher loose enough to catch the older
  // ad-hoc `cv-reread-universal-2026-08-24` run would have to drop the `ops:` namespace, and the
  // namespace is the only thing keeping a login id from matching. A frozen historical count of 14
  // is the smaller problem.
  for (const human of ["admin-HR", "dev.preview", "b-10", "B-10", "a-16", "cv-reread-universal-2026-08-24"]) {
    assert.equal(isCvRereadMarker(human), false, `"${human}" is not an ops re-read marker and must not match`);
  }
  for (const empty of [null, undefined, ""]) {
    assert.equal(isCvRereadMarker(empty), false, "an absent created_by must not read as a re-read");
  }

  // --- 5. No writer may hold a frozen marker literal in CODE -------------------------------------
  // This is the regression that regenerates: the literal is easier to read than a function call, so
  // it invites being "simplified" back. Comments are stripped first precisely so the history can
  // stay written down.
  for (const writer of [...WRITERS, MODULE, READER]) {
    const code = withoutComments(read(writer));
    const frozen = code.match(/["'`]ops:cv-reread-[^"'`]*\d{8}[^"'`]*["'`]/g) ?? [];
    assert.deepEqual(
      frozen,
      [],
      `${writer} contains a hardcoded dated marker (${frozen.join(", ")}) — it must come from cvRereadOpsMarker() so the stamp follows the run`,
    );
  }

  // --- 5b. ...but the completed one-shot must KEEP its literal ----------------------------------
  // The mirror of section 5, and the reason it exists: section 5 makes a dated literal look like a
  // defect wherever it appears, so the next reader of the forwarded-split script sees a bug rather
  // than a receipt. That script finished 2026-08-16 and fails closed at its expectName guard, so a
  // run-date stamp there would date a run that cannot happen. If this assertion ever fails, the
  // change that broke it is the mistake, not this test.
  const oneShot = read(ONE_SHOT);
  assert.match(
    withoutComments(oneShot),
    /const OPS_MARKER = "ops:forwarded-split-20260816";/,
    `${ONE_SHOT} must KEEP its hardcoded dated marker — it is a completed one-shot whose date records when it ran, and it can never legitimately run again`,
  );
  assert.doesNotMatch(
    withoutComments(oneShot),
    /cvRereadOpsMarker\(/,
    `${ONE_SHOT} must not stamp a run date — it is not a re-runnable batch, and a future date on it would be a receipt for a run that never happened`,
  );

  // --- 6. ...and every writer actually stamps from the helper ------------------------------------
  // Section 5 alone is satisfied by deleting the marker altogether, which would write a null
  // created_by and lose the human/machine separation entirely.
  for (const writer of WRITERS) {
    const source = read(writer);
    assert.match(
      source,
      /import \{ cvRereadOpsMarker \} from "@\/lib\/recruitment\/ops-marker";/,
      `${writer} must import cvRereadOpsMarker rather than declaring its own marker`,
    );
    assert.match(
      source,
      /const OPS_MARKER = cvRereadOpsMarker\(/,
      `${writer} must build OPS_MARKER from the helper`,
    );
    assert.match(
      source,
      /loginId: OPS_MARKER,/,
      `${writer} must stamp created_by from OPS_MARKER — without it the row is indistinguishable from a human review`,
    );
  }

  // --- 7. The reader matches the FAMILY, never one marker ----------------------------------------
  // The `===` this replaces is what froze the writer. Re-introducing an equality against a marker
  // would not error; it would just report zero re-reads forever.
  const readerSource = read(READER);
  assert.match(
    readerSource,
    /import \{ isCvRereadMarker \} from "@\/lib\/recruitment\/ops-marker";/,
    `${READER} must import isCvRereadMarker`,
  );
  assert.match(
    readerSource,
    /isCvRereadMarker\(row\.created_by\)/,
    `${READER} must test created_by through isCvRereadMarker`,
  );
  assert.doesNotMatch(
    withoutComments(readerSource),
    /created_by === /,
    `${READER} must not compare created_by with === — that is the exact coupling that pinned the writer to 2026-08-16`,
  );

  // --- 8. The day is derived in Cairo, never in UTC ----------------------------------------------
  // `toISOString().slice(0, 10)` is the idiom everywhere else in scripts/ and is wrong HERE: these
  // batches are started after midnight Cairo, inside the three-hour window where the UTC calendar
  // still reads yesterday.
  const moduleCode = withoutComments(read(MODULE));
  assert.match(
    moduleCode,
    /cairoTodayIso/,
    `${MODULE} must derive the day from cairoTodayIso, not from a fourth hand-rolled Cairo helper`,
  );
  assert.doesNotMatch(
    moduleCode,
    /toISOString\(\)/,
    `${MODULE} must not build the day from a UTC ISO string — a run started at 01:27 Cairo would be stamped with the previous day`,
  );
}
