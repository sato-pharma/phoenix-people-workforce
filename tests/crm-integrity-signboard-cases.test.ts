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
//
//   3. A THIRD DEFECT, FOUND 2026-10-12: THE BOARD WITHDREW A CASE BECAUSE THE SIGN COULD NO LONGER
//      BE READ. The split asked `!supportsFlag`, which is true of `unjudged` as well as of `match`,
//      so a night on which the reader simply failed took the case off the standing list — and with
//      it the settle button, leaving a flag nobody could ever decide. Measured on production:
//      مستشفى المنشاوى العام, filed STRONG `sign_other_name` on 9 Oct, withdrawn by the 12 Oct 03:36
//      pass reading `unjudged`; and رضوان محمد the same way. Because `SIGNBOARD_REREAD_REASONS`
//      retries exactly those unreadable places, such a case flickers on and off the board with each
//      night's legibility instead of resting on its evidence, and the page's own counter text —
//      "read again to a verdict that no longer carries them" — is untrue of a reading that reached
//      no verdict at all. `withdrawsFlag` now answers the board's question and only `match` sets it.

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
  assert.equal(matched.withdrawsFlag, true, "a later match is the one reading that takes a flag off the board");

  // An `unjudged` is not a clean bill of health, but it is not a finding either — and a flag may not
  // stand on a reading that reached no verdict at all.
  //
  // 🔴 NOR MAY IT BE WITHDRAWN BY ONE. The two answers are different questions, and conflating them
  // was defect 3 above: `supportsFlag` is false because this reading is not itself a finding, and
  // `withdrawsFlag` is false because it has answered nothing. The case keeps standing, and keeps the
  // settle button that is the only way anybody can ever decide it.
  for (const reason of ["unreadable", "unreadable_final", "unconfirmed", "name_unusable"]) {
    const unjudged = judge({ verdict: "unjudged", reason });
    assert.ok(unjudged, `an unjudged later reading must be reported (${reason})`);
    assert.equal(unjudged.supportsFlag, false, `an unjudged reading cannot hold a flag up (${reason})`);
    assert.equal(
      unjudged.withdrawsFlag,
      false,
      `a reading that could not read the sign must NOT withdraw the case (${reason}) — it answered nothing`,
    );
    assert.ok(
      unjudged.words !== "" && !unjudged.words.includes(reason),
      `the reason must be rendered in words, never as the code ${reason}`,
    );
  }

  // A verdict nobody has written a rule for must leave the flag STANDING, never withdraw it. The
  // list of withdrawing verdicts is an allow-list for the same reason the SFE sources are one: a
  // verdict added next month would otherwise silently start emptying the board.
  const unknownVerdict = judge({ verdict: "a_verdict_added_next_month", reason: null });
  assert.ok(unknownVerdict, "an unknown verdict must still be reported");
  assert.equal(unknownVerdict.supportsFlag, false, "an unknown verdict is not itself a finding");
  assert.equal(unknownVerdict.withdrawsFlag, false, "an unknown verdict must never withdraw a case");

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
  assert.equal(again.withdrawsFlag, false, "a reading that confirms the flag cannot withdraw it");

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
    4,
    "all four readers — the board, the weekly scan's copy, the visit report's evidence and the Place Checks screen's per-place cases (the SFE Manager decides there since 2026-10-19) — must narrow through the allow-list",
  );

  // 🔴 AND THE WEEKLY SCAN'S IN-MEMORY TIER COMES FROM THAT SAME LIST. The scan reads the week ONCE
  // and derives the SFE's copy from the rows, so the cut is only safe while it means exactly what the
  // query would have meant. Until 2026-10-12 it did not: `sfeVisibleCases` was `source !== "gps"`.
  // The row carries the answer now, stamped here, so there is one list and no second copy to rot.
  assert.ok(
    code.includes("sfeVisible: SFE_SOURCES.includes(source)"),
    "the week's rows must carry the tier stamped from SFE_SOURCES, not leave the scan to re-derive one",
  );

  // 🔴 THE WEEKLY SCAN MUST SEE PLACE CASES. It carried `.eq("subject_kind", "visit")` until
  // 2026-10-12, on the stated ground that a place case has no visit day — which is false: both place
  // filers write `visit_date`. `signboard` and `capture_trust` file ONLY against places, so every
  // Thursday reported a week with no signboard cases in it, including the weeks that had them.
  assert.ok(
    !/\.eq\("subject_kind", "visit"\)/.test(code),
    "the week's read must not be narrowed to visit subjects — it would hide two whole detectors",
  );

  // 🔴 THE BOARD PAGES, AND SAYS SO WHEN IT STILL REACHES ITS CEILING. Both reads ran on a flat
  // `.limit(200)` until 2026-10-12: the capture read silently dropped the oldest cases, and the
  // behaviour read under-reported `behaviourNotChecked` — the one number on the board whose job is to
  // admit a blind spot.
  assert.equal(
    (code.match(/readEveryPage<Row>\(/g) ?? []).length,
    2,
    "both the capture read and the behaviour read must page",
  );
  // 🔴 COUNTED, NOT MERELY PRESENT. Written as `includes`, this pin was satisfied by EITHER read
  // carrying `uniqueBy` — dropping it from the capture read left the gate green, which was measured
  // on 2026-10-12 by deleting exactly that line.
  assert.equal(
    (code.match(/uniqueBy: \(row\) => String\(row\.id\)/g) ?? []).length,
    2,
    "BOTH walks must keep a row they met twice once — a repeated capture reads as two captures in the same second",
  );
  assert.equal(
    (code.match(/\.order\("id", \{ ascending: true \}\)/g) ?? []).length,
    2,
    "each paged read needs `id` last for a TOTAL order — `strong desc, captured_at desc` is not one",
  );
  assert.ok(
    /whenFull: "stop"/.test(code) && !/whenFull: "refuse"/.test(code),
    "this board PRESENTS: strongest and newest first means a ceiling loses the oldest, and `capped` says so",
  );
  assert.ok(/capped: boolean;/.test(board) && /\n    capped,\n/.test(code), "the board must carry `capped` out to the page");
  const page = read("../app/(admin)/admin/phoenix-crm/integrity/page.tsx");
  assert.ok(
    page.includes("board.capped ?"),
    "the page must say when the read was capped — every counter on it is a count of what was READ",
  );
  assert.ok(
    page.includes("!board.capped && board.cases.length === 0"),
    "and 'nothing flagged' must never be printed on a capped read",
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
    board.includes("const withdrawn = allCases.filter((entry) => entry.laterReading !== null && entry.laterReading.withdrawsFlag)"),
    "a withdrawn flag must leave the findings",
  );
  assert.ok(
    board.includes("const standing = allCases.filter((entry) => entry.laterReading === null || !entry.laterReading.withdrawsFlag)"),
    "a case stands unless a later reading ANSWERED it — the split must read withdrawsFlag",
  );
  // 🔴 The negation is the defect of 2026-10-12, in both files that ask the question. `unjudged` is
  // false on `supportsFlag` too, so `!supportsFlag` withdraws a case whose sign merely stopped being
  // legible — and legibility is the one thing known to move from one night to the next.
  const boardCode = stripComments(board);
  // 🔴 THE SETTLE BUTTON'S GATE MOVED WITH THE CASE LISTS (2026-10-13) — the three lists are a client
  // component now, and this pin follows the markup rather than the file it used to sit in. The page
  // keeps the gate's INPUT (`canSettleIntegrityCases`) and passes it through.
  const settleCode = stripComments(read("../src/components/crm-integrity/integrity-board-view.tsx"));
  // 🔴 THE THIRD READER IS PHOENIX RANKS, AND IT MUST AGREE WITH THE BOARD. A withdrawn case has no
  // settle button by design — nobody has anything left to decide — so a pillar that still charges it
  // charges a rep for a finding his own evidence has overturned, with no click anywhere that could
  // clear it. Three live cases on 2026-10-12, the night the pillar first counted place cases at all.
  const rankCode = stripComments(read("../src/lib/rep-ranks/server/compute.ts"));
  assert.ok(
    rankCode.includes("judgeLaterSignboardReading("),
    "Phoenix Ranks must ask this same rule — a case the board has withdrawn may not still cost the Integrity pillar",
  );
  for (const [label, code] of [
    ["the board's standing/withdrawn split", boardCode],
    ["the settle button's gate", settleCode],
    ["the rank pillar's place-case read", rankCode],
  ] as const) {
    assert.ok(
      !/!\s*\w+(?:\.\w+)*\.supportsFlag/.test(code),
      `${label} must never decide on !supportsFlag — that withdraws a case because the sign could not be read`,
    );
  }
  assert.ok(
    settleCode.includes("!entry.laterReading.withdrawsFlag"),
    "a case a later reading did not answer must keep its settle button — otherwise nobody can ever decide it",
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

/** The board: all three lists shown, the sign's own words shown, and nothing truncated. */
function runRenderTests() {
  // 🔴 TWO FILES SINCE 2026-10-13, AND THE SPLIT IS THE POINT. The PAGE still owns everything whose
  // answer is one number — the counters, the callouts, the capped warning — and the VIEW owns the
  // three case lists, because filtering, opening a case and selecting several are all interaction.
  // Every assertion below reads whichever file now holds the markup it is about; not one was dropped.
  const page = read("../app/(admin)/admin/phoenix-crm/integrity/page.tsx");
  const view = read("../src/components/crm-integrity/integrity-board-view.tsx");

  assert.ok(view.includes("<CaseList canSettle={canSettle} entries={shownCases} selection={selection} />"), "the live cases must render");
  assert.ok(
    view.includes('<CaseList canSettle={false} entries={filtered.filter((row) => row.standing === "withdrawn")} selection={null} />'),
    "the withdrawn flags must still be shown",
  );
  assert.equal(
    (view.match(/<CaseList canSettle=/g) ?? []).length,
    3,
    "one list component for all three, so they can never print different facts about one row",
  );
  assert.ok(
    page.includes("board.cases.length === 0 && board.withdrawn.length === 0 && board.settled.length === 0"),
    "'nothing flagged' must require every list to be empty — a settled case is still a case",
  );
  assert.ok(
    view.includes("The sign read:"),
    "a signboard case must show the words of the sign — the evidence was on the row and never rendered",
  );
  assert.ok(
    view.includes("Read again on {cairo(later.checkedAt)}"),
    "the later reading must carry its Cairo date, not a bare claim",
  );
  // Arabic and Latin on the same board: direction belongs to the LINE, never to the block — and it
  // is pinned per paragraph rather than by counting, because a count passes while the one paragraph
  // that carries Arabic is the one that lost it.
  assert.ok(
    /dir="auto">\s*The sign read:/.test(view),
    "the transcribed sign needs its own direction",
  );
  assert.ok(
    /dir="auto">\s*That reading read:/.test(view),
    "the later reading's transcription needs its own direction too",
  );
  // 🔴 BOTH FILES, because the story paragraph is the longest string this board has ever printed and
  // it lives in the view. A sweep that still read only the page would pass while the one paragraph
  // that must never be cut short was being cut short.
  for (const [label, code] of [
    ["the page", stripComments(page)],
    ["the board view", stripComments(view)],
  ] as const) {
    assert.ok(
      !code.includes("…") && !/\btruncate\b|\bline-clamp-/.test(code),
      `nothing on ${label} may be truncated — a half-printed sign names the wrong person`,
    );
  }
  // The withdrawn section must say, in words, that nothing was deleted and nobody decided anything.
  // 🔴 Since settling exists (2026-10-09) it must also say why there is nothing to settle here: the
  // evidence gave way on its own, which is not a decision and must not read as one.
  assert.ok(
    /Nothing here has been deleted and no decision was taken on them/.test(view),
    "the section must state that a withdrawn flag is neither deleted nor decided on",
  );
  assert.ok(
    /nothing to settle/.test(view),
    "the section must say why a withdrawn case offers no settle button",
  );
}

export function runCrmIntegritySignboardCaseTests() {
  runJudgeTests();
  runLoaderTests();
  runRenderTests();
}
