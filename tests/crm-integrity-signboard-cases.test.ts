import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { judgeLaterSignboardReading } from "@/lib/phoenix-crm/location-integrity";
import { INTEGRITY_SOURCES } from "@/lib/phoenix-crm/server/integrity-board";

import { stripComments } from "./support/comment-strip.ts";

// THE SIGNBOARD DETECTOR ON THE SUPER ADMIN'S INTEGRITY BOARD (2026-10-09).
//
// Two defects, both found in live production data, both of them the board's and not the detector's:
//
//   1. A SIGNBOARD CASE PRINTED AS "POSITION". `source: "signboard"` began filing on 2026-10-08 and
//      was never added to `IntegritySource`, so the mapper's fallback swept it into `gps` — the one
//      kind of evidence it is not. Measured on production the next evening: 12 cases, 5 of them
//      signboard, every one of them labelled Position. The detector tally hid it as well, because it
//      renders only when two sources are present and all 12 read as one.
//
//   2. A FLAG OUTLIVED THE READING THAT MADE IT. A signboard verdict is not a property of the
//      photograph: the same frame read `other_name` at 18:12 and `unjudged` at 18:34, and another
//      read blank at 18:35 and a clear nameplate at 18:48. Four of the five flags standing that
//      evening were already contradicted by the place's own stored verdict — two of them by a plain
//      `match` — and the board presented all five as live findings about five named people. A place
//      that reads `match` also leaves the nightly backlog, so those two would never have been
//      re-read and the flags would have stood for ever.
//
// The fix is a derivation, not a column: the place row's current verdict is read at board time and
// a flag it no longer supports is listed apart from the findings. Nothing is deleted — clearing a
// flag would destroy the record of what the detector did, and acting on one is the owner's decision
// in any case. 🔴 Withdrawn is NOT settled: settling arrived the same day as four columns that say
// WHO looked and on WHICH flags (`tests/phoenix-crm-integrity-settle.test.ts`), and a withdrawn case
// is the evidence giving way with nobody having decided anything — so it offers no settle button.

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const FILED_AT = "2026-10-03T13:30:00.000Z";
const LATER = "2026-10-09T15:34:00.000Z";

function judge(stored: Partial<{ verdict: string; reason: string | null; checkedAt: string | null; signText: string | null }>, flags = ["sign_other_name"]) {
  return judgeLaterSignboardReading({
    source: "signboard",
    flags,
    filedAt: FILED_AT,
    stored: { verdict: "match", reason: null, checkedAt: LATER, signText: null, ...stored },
  });
}

/** The decision table itself, on real verdict shapes rather than on the file's text. */
function runJudgeTests() {
  // A later MATCH takes the ground out from under the flag. Both of the strong flags of 2026-10-09
  // were this case, and both would otherwise have stood for ever: a matched place leaves the backlog.
  const matched = judge({ verdict: "match", reason: null, signText: "محمد فرج" });
  assert.ok(matched, "a later reading must be reported");
  assert.equal(matched.supportsFlag, false, "a later match no longer supports a signboard flag");
  assert.equal(matched.sameFinding, false, "a match is not the same finding as a flag");

  // An `unjudged` is not a clean bill of health, but it is not a finding either — and a flag may not
  // stand on a reading that reached no verdict at all.
  for (const reason of ["unreadable", "unreadable_final", "unconfirmed", "name_unusable"]) {
    const unjudged = judge({ verdict: "unjudged", reason });
    assert.ok(unjudged, `an unjudged later reading must be reported (${reason})`);
    assert.equal(unjudged.supportsFlag, false, `an unjudged reading cannot hold a flag up (${reason})`);
    assert.ok(
      unjudged.words !== "" && !unjudged.words.includes(reason),
      `the reason must be rendered in words, never as the code ${reason}`,
    );
  }

  // Each of the four `unjudged` reasons gets its OWN sentence: "could not be read" is wrong for two
  // readings that disagreed, and it hides that a frame has had every attempt it gets.
  const sentences = new Set(
    ["unreadable", "unreadable_final", "unconfirmed", "name_unusable"].map((reason) => judge({ verdict: "unjudged", reason })?.words),
  );
  assert.equal(sentences.size, 4, "the four unjudged reasons must read as four different sentences");

  // A reason nobody has written a sentence for falls back to the verdict's own, never to a code.
  const invented = judge({ verdict: "unjudged", reason: "a_reason_added_next_month" });
  assert.ok(
    invented && typeof invented.words === "string" && invented.words !== "" && !invented.words.includes("a_reason_added_next_month"),
    "an unknown reason must fall back to the verdict's sentence — never a code, and never nothing at all",
  );

  // Still a finding, and still the SAME one: the flag stands and the board says it was confirmed.
  const again = judge({ verdict: "other_name", reason: "sign_other_name" }, ["sign_other_name"]);
  assert.ok(again?.supportsFlag && again.sameFinding, "a later reading of the same verdict confirms the flag");

  // Still a finding, but a DIFFERENT one — اسلام عبدالعال was filed `sign_no_name` and reads
  // `other_name` now. The flag stands (somebody is still named) and the board must not pretend the
  // two readings agreed.
  const changed = judge({ verdict: "other_name", reason: "sign_other_name" }, ["sign_no_name"]);
  assert.ok(changed?.supportsFlag, "a flaggable later verdict keeps the case in the findings");
  assert.equal(changed.sameFinding, false, "a different flaggable verdict is not the same finding");

  // 🔴 "Later" is measured against the FILING, never the capture. A reading at or before the filing
  // is the one that filed it — judged the other way, every signboard case withdraws itself.
  assert.equal(judge({ checkedAt: FILED_AT }), null, "a reading at the moment of filing is not a later reading");
  assert.equal(judge({ checkedAt: "2026-10-03T08:00:00.000Z" }), null, "a reading before the filing is not a later reading");

  // A date that cannot be read leaves the flag standing. Null is "nothing read it again".
  assert.equal(judge({ checkedAt: null }), null, "a stored check with no date cannot withdraw a flag");
  assert.equal(judge({ checkedAt: "not a date" }), null, "an unparseable date cannot withdraw a flag");
  assert.equal(
    judgeLaterSignboardReading({ source: "signboard", flags: ["sign_no_name"], filedAt: null, stored: { verdict: "match", reason: null, checkedAt: LATER, signText: null } }),
    null,
    "a case with no filing date cannot be withdrawn either",
  );
  assert.equal(
    judgeLaterSignboardReading({ source: "signboard", flags: ["sign_no_name"], filedAt: FILED_AT, stored: null }),
    null,
    "a place whose verdict could not be read keeps its case in the findings",
  );

  // No other detector keeps a re-readable verdict anywhere else, so none of them is ever withdrawn.
  for (const source of ["gps", "photo", "behaviour"]) {
    assert.equal(
      judgeLaterSignboardReading({ source, flags: ["mock_provider"], filedAt: FILED_AT, stored: { verdict: "match", reason: null, checkedAt: LATER, signText: null } }),
      null,
      `${source} evidence is the capture itself and can never be withdrawn by a later reading`,
    );
  }
}

/** The loader: the detector is named, the narrowing is an allow-list, and the read is chunked. */
function runLoaderTests() {
  const board = read("../src/lib/phoenix-crm/server/integrity-board.ts");

  // 🔴 ONE EXPORTED LIST SINCE 2026-10-09, and the type is derived from it. The union used to be
  // hand-written and the tally hand-written beside it, which is how `signboard` could be in one and
  // not the other; `capture_trust` was missing from both. Membership is asserted on the real array
  // rather than on the text of a type, so the pin cannot be satisfied by a comment.
  assert.ok(
    INTEGRITY_SOURCES.includes("signboard"),
    "signboard must be a source in its own right — the fallback printed it as Position for a day",
  );
  assert.ok(
    /export type IntegritySource = \(typeof INTEGRITY_SOURCES\)\[number\]/.test(board),
    "IntegritySource must derive from INTEGRITY_SOURCES, never be a second hand-written union",
  );
  assert.ok(/signboard: "Signboard"/.test(board), "the signboard detector needs its own label");
  assert.ok(
    board.includes('isIntegritySource(row.source) ? row.source : "gps"'),
    "the row mapper must read a row's source through the list rather than falling through to gps",
  );
  assert.ok(
    /bySource: INTEGRITY_SOURCES\.flatMap/.test(board),
    "every detector in the list must be counted, or its cases are tallied under another's name",
  );

  // The SFE narrowing is an ALLOW-LIST. `.eq("source", "photo")` kept signboard out of his board by
  // accident rather than by decision, and the next detector would have walked straight in.
  assert.ok(
    board.includes("const SFE_SOURCES: IntegritySource[] = [\"photo\"]"),
    "the non-Super-Admin detectors must be an explicit allow-list",
  );
  // Code only: the comment above `SFE_SOURCES` quotes the old narrowing to explain why it went. The
  // shared lexer does the stripping, never a line filter — `tests/comment-strip-ratchet.test.ts`
  // refuses one, because a line judged by how it STARTS cannot know a block comment is already open.
  const code = stripComments(board);
  assert.ok(
    !/\.eq\("source", "photo"\)/.test(code),
    "no narrowing may be written as 'only photo' — a detector added later would be readable by default",
  );
  assert.equal(
    (board.match(/\.in\("source", SFE_SOURCES\)/g) ?? []).length,
    2,
    "both readers — the board and the weekly scan's copy — must narrow through the allow-list",
  );

  // The place verdicts are read in chunks, for the reason the visit distances are.
  assert.ok(
    board.includes("signboardPlaceIds.slice(index, index + 50)"),
    "the place-verdict lookup must be chunked — an over-long .in() returns an empty set with no error",
  );
  assert.ok(
    board.includes("if (placeError) break;"),
    "a failed place-verdict lookup must not take the whole board down",
  );

  // It is DERIVED from the place row, never a second copy of the truth on the case.
  assert.ok(
    board.includes('.from("phoenix_crm_places")') && board.includes('.select("id, signboard_check")'),
    "the later reading must come from the place row the nightly pass writes",
  );
  // The SELECT string itself, not merely the name somewhere in the file: `row.created_at` reads
  // `undefined` for a column PostgREST was never asked for, no error is raised, and the whole
  // withdrawal then silently never happens — a feature that fails by doing nothing.
  assert.ok(
    /\.select\("[^"]*captured_at, created_at[^"]*"\)/.test(board),
    "the case's filing date must be SELECTED — 'later' is measured against it",
  );

  // The split, and what it must not do.
  assert.ok(
    board.includes("const withdrawn = allCases.filter((entry) => entry.laterReading !== null && !entry.laterReading.supportsFlag)"),
    "a withdrawn flag must leave the findings",
  );
  assert.ok(
    board.includes("strongCount: cases.filter((entry) => entry.strong).length"),
    "the counters must count the cases that stand, not the withdrawn ones",
  );
  assert.ok(
    !/\.delete\(\)|\.remove\(|"phoenix_crm_location_integrity"\)\s*\.\s*(delete|upsert)/.test(board),
    "this reader must never delete or re-file the evidence — a flag is the record of what a detector did",
  );
  // 🔴 ONE WRITE EXISTS SINCE 2026-10-09, AND IT IS THE SETTLEMENT (`settled_at/by/note/flags`).
  // Nothing else on the row may ever be written here: a module that can rewrite `flags`, `strong` or
  // `signals` can make the evidence agree with a later opinion, which is what deleting the row used
  // to do more honestly. Every `.update()` in the file is checked, not just the ones expected.
  const writes = [...board.matchAll(/\.update\(\{([^}]*)\}\)/g)];
  assert.ok(writes.length >= 2, "the settle and reopen writes must both be found, or this check reads nothing");
  for (const write of writes) {
    const columns = [...(write[1] ?? "").matchAll(/([a-z_]+):/g)].map((match) => match[1]);
    assert.ok(columns.length > 0, "an update with no columns — this check has lost its shape");
    assert.ok(
      columns.every((column) => column.startsWith("settled_")),
      `the board writes ${columns.join(", ")} — only the four settlement columns may ever be written here`,
    );
  }
}

/** The page: both lists shown, the sign's own words shown, and nothing truncated. */
function runRenderTests() {
  const page = read("../app/(admin)/admin/phoenix-crm/integrity/page.tsx");

  assert.ok(page.includes("<CaseList canSettle={canSettle} entries={board.cases} />"), "the live cases must render");
  assert.ok(page.includes("<CaseList canSettle={false} entries={board.withdrawn} />"), "the withdrawn flags must still be shown");
  assert.equal(
    (page.match(/<CaseList canSettle=/g) ?? []).length,
    3,
    "one list component for all three, so they can never print different facts about one row",
  );
  assert.ok(
    page.includes("board.cases.length === 0 && board.withdrawn.length === 0 && board.settled.length === 0"),
    "'nothing flagged' must require every list to be empty — a settled case is still a case",
  );
  assert.ok(
    page.includes("The sign read:"),
    "a signboard case must show the words of the sign — the evidence was on the row and never rendered",
  );
  assert.ok(
    page.includes("Read again on {cairo(later.checkedAt)}"),
    "the later reading must carry its Cairo date, not a bare claim",
  );
  // Arabic and Latin on the same board: direction belongs to the LINE, never to the block — and it
  // is pinned per paragraph rather than by counting, because a count passes while the one paragraph
  // that carries Arabic is the one that lost it.
  assert.ok(
    /dir="auto">\s*The sign read:/.test(page),
    "the transcribed sign needs its own direction",
  );
  assert.ok(
    /dir="auto">\s*That reading read:/.test(page),
    "the later reading's transcription needs its own direction too",
  );
  const pageCode = stripComments(page);
  assert.ok(
    !pageCode.includes("…") && !/\btruncate\b|\bline-clamp-/.test(pageCode),
    "nothing on this board may be truncated — a half-printed sign names the wrong person",
  );
  // The withdrawn section must say, in words, that nothing was deleted and nobody decided anything.
  // 🔴 Since settling exists (2026-10-09) it must also say why there is nothing to settle here: the
  // evidence gave way on its own, which is not a decision and must not read as one.
  assert.ok(
    /Nothing here has been deleted and no decision was taken on them/.test(page),
    "the section must state that a withdrawn flag is neither deleted nor decided on",
  );
  assert.ok(
    /nothing to settle/.test(page),
    "the section must say why a withdrawn case offers no settle button",
  );
}

export function runCrmIntegritySignboardCaseTests() {
  runJudgeTests();
  runLoaderTests();
  runRenderTests();
}
