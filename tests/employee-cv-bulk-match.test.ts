import assert from "node:assert/strict";

import {
  employeeNameTokens,
  fileNameTokens,
  matchCvFileName,
  matchCvFolder,
  type BulkCvEmployee,
} from "../src/lib/employees/employee-cv-bulk.ts";

/**
 * Filing a folder of CVs: what may be PRE-SELECTED, and what must wait for a person.
 *
 * This module never files anything. It decides whether a row in a review table starts with an
 * employee already chosen, and every assertion here is about keeping that bar high — because the
 * failure it guards against is not a wrong number on a screen. A CV carries a person's address,
 * education and salary history; filed under the wrong employee it is permanent, downloadable from
 * the organogram by the SFE Manager, and nothing anywhere says it is the wrong document.
 *
 * The numbers behind the caution are real: of the 8 employees on production whose mobile matched a
 * candidate with a CV, three were a different person. Names are no safer — two real reps here share
 * a full name, and "Samaa Shalaby" and "Samaa AbdelRahman AbdelRaouf Shalabi" are one person who
 * do not match on most of their words.
 */

const STAFF: BulkCvEmployee[] = [
  { displayName: "Mohamed Hamed Salem Hamed Goda", hasCv: false, hrId: "AI-0016" },
  { displayName: "Mohamed Alaa Eleiwa Abozaid", hasCv: false, hrId: "PD-0012" },
  { displayName: "Samaa AbdelRahman AbdelRaouf Shalabi", hasCv: false, hrId: "AI-0014" },
  { displayName: "Ahmed Nashaat Ali Ahmed", hasCv: false, hrId: "AI-0031" },
  { displayName: "Ahmed Ayman Khedr Hamouda", hasCv: false, hrId: "PD-0033" },
  { displayName: "Salim Salim Abdo Ibrahim Gomaa", hasCv: true, hrId: "AI-0002" },
];

export function runEmployeeCvBulkMatchTests() {
  // ── 1. THE TOKENISER DROPS WHAT IS NOT A NAME ─────────────────────────────────────────────
  // Every second file in a CV folder is called "CV", "resume", "final" or "copy (2)". Counted as
  // evidence, those would make every file look like a match for everybody and the certainty test
  // below would fire on noise alone.
  assert.deepEqual(
    fileNameTokens("Mohamed_Hamed_Salem_Medical Rep CV.pdf"),
    ["mohamed", "hamed", "salem", "medical"],
    "the extension, the noise words and short fragments must all be dropped",
  );
  assert.deepEqual(fileNameTokens("CV (2) final.pdf"), [], "a file named only noise carries nothing");
  assert.deepEqual(fileNameTokens("Samaa_Shalaby_ATS_Optimized_CV.pdf"), ["samaa", "shalaby"]);

  // ── 2. EXACT TOKENS, NEVER SUBSTRINGS ─────────────────────────────────────────────────────
  // "ali" is a substring of "salim" and "sam" of "samaa". A substring match pairs unrelated people
  // who share a common Egyptian name fragment, which is the quiet half of this failure mode.
  const salim = STAFF.find((person) => person.hrId === "AI-0002");
  assert.ok(salim);
  assert.ok(
    !employeeNameTokens(salim).has("ali"),
    "name tokens must be whole words — 'ali' inside 'salim' is not a match",
  );

  // ── 3. AN HR ID IS DECISIVE; A NAME NEEDS TWO WORDS AND NO RIVAL ──────────────────────────
  const byId = matchCvFileName("AI-0016 scan.pdf", STAFF);
  assert.equal(byId.hrId, "AI-0016", "an HR id in the filename identifies the person outright");
  assert.equal(byId.certain, true);

  assert.equal(
    matchCvFileName("ai0016.pdf", STAFF).hrId,
    "AI-0016",
    "the id must be recognised without its separator too",
  );

  const twoWords = matchCvFileName("Mohamed Hamed CV.pdf", STAFF);
  assert.equal(twoWords.hrId, "AI-0016", "two matching name words with no rival is enough");
  assert.equal(twoWords.certain, true);

  // THE HEADLINE. One shared first name is not identification, and this folder has three Mohameds
  // and two Ahmeds. A single-word match must never pre-select anybody.
  const oneWord = matchCvFileName("Mohamed CV.pdf", STAFF);
  assert.equal(
    oneWord.hrId,
    null,
    "a single matching name word must leave the row unassigned — three people here are a Mohamed",
  );
  assert.equal(oneWord.certain, false);
  assert.ok(
    oneWord.candidates.length >= 2,
    "the row must still OFFER the people it could be, so somebody can choose in one click",
  );

  // AND ONE WORD IS NOT ENOUGH EVEN WHEN IT MATCHES NOBODY ELSE. "Nashaat" belongs to exactly one
  // person in this company, so the tie rule above does not catch it and only the two-word floor
  // does — which is the whole reason that floor exists. A lone surname on a file is not
  // identification: it is as likely to be a relative, a candidate of the same family, or a
  // different Nashaat entirely. Without this case the floor could be lowered to one word and every
  // other assertion here would still pass.
  const oneUniqueWord = matchCvFileName("Nashaat.pdf", STAFF);
  assert.equal(
    oneUniqueWord.hrId,
    null,
    "one distinctive word matching exactly one person is still not identification",
  );
  assert.equal(oneUniqueWord.candidates[0]?.hrId, "AI-0031", "he must still be the first offer");

  // A tie on two words is still a tie: "Ahmed ... Ahmed" matches one person twice over, but if two
  // people scored the same the row must wait for a human.
  const tie = matchCvFileName("Ahmed Ahmed.pdf", STAFF);
  assert.equal(tie.certain, false, "a tied score must never pre-select");

  // Nobody at all: no row, no guess.
  const stranger = matchCvFileName("Khaled Zaki.pdf", STAFF);
  assert.equal(stranger.hrId, null);
  assert.deepEqual(stranger.candidates, []);

  // ── 4. A PRE-SELECTION NEVER REPLACES AN EXISTING CV ──────────────────────────────────────
  // Salim already has one. Pre-selecting him would let one careless press overwrite a document
  // somebody attached deliberately, and the old file is not recoverable from the app afterwards.
  const replacing = matchCvFileName("Salim Salim Abdo.pdf", STAFF);
  assert.equal(
    replacing.certain,
    false,
    "a person who already has a CV must never be pre-selected: that press would REPLACE it",
  );
  assert.equal(replacing.hrId, null);
  assert.equal(
    replacing.wouldReplace,
    true,
    "the row must say so, or the reason it is unassigned looks like a failed match",
  );
  assert.equal(replacing.candidates[0]?.hrId, "AI-0002", "he must still be offered, just not chosen");

  // ── 5. TWO FILES CANNOT BE PRE-SELECTED ONTO ONE PERSON ───────────────────────────────────
  // "Ahmed Nashaat CV.pdf" and "Ahmed Nashaat CV final.pdf" both resolve to the same man. Left
  // alone, both would upload and the second would silently replace the first — he would end up
  // with whichever the loop happened to send last, with nothing to show which.
  const folder = matchCvFolder(
    ["Mohamed Hamed CV.pdf", "Ahmed Nashaat CV.pdf", "Ahmed Nashaat CV final.pdf"],
    STAFF,
  );
  assert.equal(folder[0]?.hrId, "AI-0016", "an unambiguous row is unaffected by the duplicate rule");
  assert.equal(folder[1]?.hrId, null, "both duplicates must drop to unassigned…");
  assert.equal(folder[2]?.hrId, null, "…not just the second one");
  assert.equal(
    folder[1]?.candidates[0]?.hrId,
    "AI-0031",
    "and both must still offer him, so choosing the real document is one click",
  );
}
