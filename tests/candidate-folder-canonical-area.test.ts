import assert from "node:assert/strict";

import {
  normalizedAreaMatchKey,
  resolveCanonicalMedicalRepArea,
} from "../src/lib/recruitment/candidate-folder.ts";

/**
 * The Medical Representative shelf is one folder per AREA, and the area comes from free text — an
 * applicant either taps a live area in the WhatsApp menu or types one because theirs was "not
 * listed". Measured against production 2026-09-11: seven CVs had been filed under a folder key
 * that was that typed text VERBATIM, and every one of the seven matched none of the ~50 real areas
 * — "kafrelsheikh", "Qena north", "Minia Government", a curly-quoted "Haram", "Badr city",
 * "El Minya", "Qena". Each opened its own one-CV folder beside the real ones, so a recruiter
 * screening the real "Kafr El-Sheikh 1" folder never saw the CV sitting one letter away.
 *
 * `resolveCanonicalMedicalRepArea` is the one function both the propose-time suggestion
 * (candidate-folder-suggestion.ts) and the file-time write (candidates.ts, fileCandidateToFolder)
 * now route through, so this file pins its behaviour directly rather than through either caller —
 * both of those reach a live database for the canonical list and must not run inside this suite,
 * which runs with production credentials (AGENTS.md §2.1: "the test suite runs with production
 * credentials").
 *
 * The property under test is narrower than "recognise a typo": it is "never open a stray folder,
 * and never guess between two real ones". "Kafr El-Sheikh 1" and "Kafr El-Sheikh 2" are different
 * territories with different vacancies, so a typed "kafrelsheikh" — which does not say which one —
 * must be refused, not resolved to either sibling. That is the owner's standing rule that territory
 * is never inferred, applied to this one function.
 */

const CANONICAL_AREAS = [
  "Kafr El-Sheikh 1",
  "Kafr El-Sheikh 2",
  "Gharbia 1 (Tanta)",
  "Alex West",
  "Down town",
];

export function runCandidateFolderCanonicalAreaTests() {
  // ── 1 · The seven real production strays are all refused, none filed ──────
  const productionStrays = [
    "kafrelsheikh",
    "Qena north",
    "“Haram”", // curly quotes, exactly as the applicant's message carried them
    "Badr city",
    "El Minya",
    "Minia Government",
    "Qena",
  ];
  for (const stray of productionStrays) {
    const result = resolveCanonicalMedicalRepArea(stray, CANONICAL_AREAS);
    assert.equal(result.area, null, `"${stray}" filed a real production CV into a stray folder and must be refused`);
    assert.match(
      String(result.refusal),
      /not one of the current areas/i,
      `the refusal for "${stray}" must say why, so a screen can show a reason rather than a silent drop`,
    );
  }

  // ── 2 · Case and whitespace drift resolve to the EXACT canonical spelling ─
  // Never the caller's own casing — "alex west" and "Alex West" must land in ONE folder, the same
  // property candidateFolderKey already holds for the group key itself.
  assert.equal(
    resolveCanonicalMedicalRepArea("  alex WEST  ", CANONICAL_AREAS).area,
    "Alex West",
    "case and stray whitespace fold to the canonical spelling",
  );
  assert.equal(
    resolveCanonicalMedicalRepArea("GHARBIA 1 (tanta)", CANONICAL_AREAS).area,
    "Gharbia 1 (Tanta)",
    "digits and punctuation inside the name are preserved, only case/whitespace are folded",
  );

  // ── 3 · Ambiguous text is refused, never guessed onto a sibling area ──────
  // The load-bearing property. "Kafr El-Sheikh" alone does not say "1" or "2", and filing it as
  // either would put a CV in the wrong district's queue with nothing on screen to say so.
  const ambiguous = resolveCanonicalMedicalRepArea("Kafr El-Sheikh", CANONICAL_AREAS);
  assert.equal(ambiguous.area, null, "a family name with no disambiguating digit must never resolve to either sibling");
  assert.match(String(ambiguous.refusal), /not one of the current areas/i);

  // ── 4 · Empty, null and whitespace-only input are refused with a reason ───
  for (const empty of [null, undefined, "", "   "]) {
    const result = resolveCanonicalMedicalRepArea(empty, CANONICAL_AREAS);
    assert.equal(result.area, null, `${JSON.stringify(empty)} names no area and must be refused`);
    assert.ok(result.refusal, "the refusal is never blank — a screen must be able to show a reason");
  }

  // ── 5 · Negative control: a real area is never false-flagged ──────────────
  // "Down town" is real production data — a lowercase "t" in "town" — and must resolve cleanly, or
  // the matcher is too strict rather than too loose.
  assert.equal(
    resolveCanonicalMedicalRepArea("Down town", CANONICAL_AREAS).area,
    "Down town",
    "an exact canonical spelling must resolve, proving the matcher does not over-refuse real areas",
  );
  assert.equal(
    resolveCanonicalMedicalRepArea("down TOWN", CANONICAL_AREAS).area,
    "Down town",
    "and the same real area typed in a different case still resolves",
  );

  // ── 6 · normalizedAreaMatchKey folds case, whitespace and smart quotes ────
  assert.equal(normalizedAreaMatchKey("Alex West"), normalizedAreaMatchKey("  alex   west "));
  assert.equal(
    normalizedAreaMatchKey("“Haram”"),
    normalizedAreaMatchKey('"Haram"'),
    "curly quotes and straight quotes must compare equal, or a copy-pasted WhatsApp answer silently misses",
  );
  assert.equal(normalizedAreaMatchKey(null), "", "no input has no key, never a thrown error");
}
