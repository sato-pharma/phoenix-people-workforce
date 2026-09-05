import assert from "node:assert/strict";

import { suggestOrgTitleCasing } from "../src/lib/imports/org-title-case.ts";

// The Employees screen offers a casing correction for a hand-typed job title; it never applies one.
//
// WHY A SUGGESTION AND NOT THE CASER. The importer normalizes `employees.job_title` outright, and is
// right to: a spreadsheet cell is bulk data with no author standing behind it. A form is the
// opposite — one person typing one title, where the casing IS the intent. Running `toOrgTitleCase()`
// over free text damages it, because per-word title case cannot know that "QA/QC" and "eCommerce"
// are deliberate. Measured before this was built: it renders them "Qa/qc" and "Ecommerce".
//
// So the bar here is not "does it fix Ceo" — it is "does it ever propose something WORSE than what
// was typed". A hint that fires on a title it cannot improve is the defect this test exists to
// catch, which is why the silent half below is the longer of the two.

export function runEmployeeJobTitleCasingHintTests() {
  // ── Fires on the vocabulary it actually knows ────────────────────────────────────────────────
  //
  // The first four are the exact production titles that were hand-repaired on 2026-09-05; typing
  // any of them back into the form is the path that would otherwise reintroduce them one row at a
  // time, below the importer entirely.
  const shouldSuggest: ReadonlyArray<{ typed: string; expected: string; note: string }> = [
    { typed: "Ceo", expected: "CEO", note: "AA — the CEO's own record" },
    { typed: "Qppv", expected: "QPPV", note: "A-3" },
    { typed: "Sfe Manager", expected: "SFE Manager", note: "A-2" },
    {
      typed: "R And D Manager",
      expected: "R&D Manager",
      note: "AB — needs the phrase rule, not a word rule",
    },
    { typed: "Hr Manager", expected: "HR Manager", note: "the 2026-08-28 position-title mangling" },
    {
      typed: "Finance And Admin Manager",
      expected: "Finance and Admin Manager",
      note: "B-185 — a minor word wrongly capitalised mid-title",
    },
  ];

  const suggestionFailures: string[] = [];

  for (const { typed, expected, note } of shouldSuggest) {
    const actual = suggestOrgTitleCasing(typed);

    if (actual !== expected) {
      suggestionFailures.push(
        `"${typed}" suggested ${JSON.stringify(actual)}, expected "${expected}" (${note})`,
      );
    }
  }

  assert.equal(
    suggestionFailures.join(" | "),
    "",
    `the hint failed to offer a correction for ${suggestionFailures.length} of ${shouldSuggest.length} known-bad titles`,
  );

  // ── Stays silent on everything it could only make worse ──────────────────────────────────────
  //
  // THIS IS THE HALF THAT MATTERS. Every entry is a title the full caser would rewrite, or one that
  // is already correct — proposing a change to any of them would train the reader to dismiss the
  // hint, and taking one would corrupt a correct title through the UI.
  const shouldStaySilent: ReadonlyArray<{ typed: string; note: string }> = [
    { typed: "CEO", note: "already correct — must not propose what is already in the box" },
    { typed: "R&D Manager", note: "already correct; a second pass must not degrade it to R&d" },
    { typed: "Finance and Admin Manager", note: "B-185's real stored title, already correct" },
    { typed: "Medical Representative", note: "126 employees — the common case must never blink" },
    { typed: "QA/QC Supervisor", note: "the caser would offer 'Qa/qc Supervisor' — strictly worse" },
    { typed: "eCommerce Manager", note: "deliberate intra-word capital; caser offers 'Ecommerce'" },
    { typed: "McKinsey Fellow", note: "deliberate intra-word capital" },
    { typed: "Sales Rep (Delta 3)", note: "caser offers '(delta 3)' — a bracketed word is not a word" },
    { typed: "Regulatory Affairs Supervisior", note: "a real typo is NOT this hint's business" },
    { typed: "اخصائي موارد بشرية", note: "Arabic carries no [a-z]; must pass through untouched" },
    { typed: "", note: "an empty box must not raise a hint" },
    { typed: "   ", note: "whitespace only is still an empty box" },
  ];

  const silenceFailures: string[] = [];

  for (const { typed, note } of shouldStaySilent) {
    const actual = suggestOrgTitleCasing(typed);

    if (actual !== null) {
      silenceFailures.push(`"${typed}" wrongly offered "${actual}" (${note})`);
    }
  }

  assert.equal(
    silenceFailures.join(" | "),
    "",
    `the hint offered a correction on ${silenceFailures.length} title(s) it cannot improve — a suggestion worse than the typed value is worse than no hint at all`,
  );

  // ── Taking the suggestion is a fixed point ───────────────────────────────────────────────────
  //
  // Pressing "Use it" writes the suggestion back into the same box, which recomputes the hint. If a
  // suggestion were not its own fixed point the hint would reappear immediately and the button
  // would look broken — or worse, oscillate.
  const unstable: string[] = [];

  for (const { typed } of shouldSuggest) {
    const once = suggestOrgTitleCasing(typed);

    if (once !== null && suggestOrgTitleCasing(once) !== null) {
      unstable.push(`"${typed}" -> "${once}" -> "${suggestOrgTitleCasing(once)}"`);
    }
  }

  assert.equal(
    unstable.join(" | "),
    "",
    "accepting a suggestion must silence the hint, not raise a new one",
  );
}
