import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { candidateDisplayName, isShortenedCandidateName } from "../src/lib/recruitment/candidate-display.ts";

/**
 * The candidate pool table, and the intake blob that broke it.
 *
 * Measured against production on 2026-08-20, 555 rows:
 *
 *   • 220 rows (40%) carry the forwarder's whole envelope in `full_name` — filename, sender and
 *     email subject in one string. They average 100+ characters and reach 185.
 *   • The other 335 carry a real name: p95 of 28 characters, longest 40.
 *   • The Actions cell held eight separate controls per row, two of them full-width dropdowns.
 *
 * Together those two facts are why the pool scrolled sideways and every row stood eight lines
 * tall. Capping widths alone could not fix it — a narrower cell just wraps the same eight controls
 * onto more lines. This file pins the two things that actually shortened the row: a display name
 * derived from the envelope, and a single-line action strip.
 */

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

export async function runRecruitmentCandidatePoolTableTests() {
  // ── 1 · The envelope becomes a person ───────────────────────────────────────
  //
  // Verbatim production shapes. The sender name is what the forwarder had, which is not always
  // how the CV spells it — that is why the stored value is never overwritten, only shortened for
  // display.
  assert.equal(
    candidateDisplayName(
      "Diwakar Mogarala Resume From(Diwakar Mogarala (diwakarmogarala7@gmail com)) Subject(Experienced Health Information Specialist)",
    ),
    "Diwakar Mogarala",
    "the sender inside From( … ) is the person",
  );
  assert.equal(
    candidateDisplayName("file 754C9140 8AD3 404A 8339 AFC0892A9BFF From(Islam Mostafa (islam most3011@gmail com)) Subject(Apply for Hr)"),
    "Islam Mostafa",
    "a meaningless attachment filename must not become somebody's name",
  );
  assert.equal(
    candidateDisplayName("Mohamed Dawood Recruitment CV 2026 5 From(Dawood Dawood (mohameddawood831@gmail com)) Subject(CV)"),
    "Dawood Dawood",
    "the sender wins even when the filename disagrees — a human reconciles it, we do not guess",
  );

  // ── 2 · A real name is left exactly alone ───────────────────────────────────
  assert.equal(candidateDisplayName("Rwan Safaa"), "Rwan Safaa", "335 of the 555 rows must pass through untouched");
  assert.equal(candidateDisplayName("  Rwan Safaa  "), "Rwan Safaa", "only whitespace is trimmed");
  assert.equal(candidateDisplayName(null), "", "a missing name is empty, never the string 'null'");
  assert.equal(candidateDisplayName(undefined), "");
  assert.equal(candidateDisplayName(""), "");

  // ── 3 · Never return something worse than what was stored ───────────────────
  //
  // A malformed envelope must fall back to the full string rather than produce a blank cell or an
  // address. A row with no name at all is the one shape a recruiter cannot act on.
  assert.equal(
    candidateDisplayName("Some CV From(  (only@address com)) Subject(x)"),
    "Some CV From(  (only@address com)) Subject(x)",
    "an address in the sender slot is not a name — keep the original",
  );
  assert.equal(
    candidateDisplayName("Broken From( ) Subject(x)"),
    "Broken From( ) Subject(x)",
    "an empty sender slot must not blank the cell",
  );
  assert.equal(candidateDisplayName("From(No Closing Paren"), "From(No Closing Paren", "an unterminated envelope is left as-is");

  // ── 4 · The caller can tell when it shortened something ─────────────────────
  assert.equal(isShortenedCandidateName("Rwan Safaa"), false, "no hover text is needed when nothing was hidden");
  assert.equal(
    isShortenedCandidateName("X Resume From(Real Person (a@b com)) Subject(y)"),
    true,
    "a shortened row must be able to offer the full envelope on hover",
  );
  assert.equal(isShortenedCandidateName(null), false);
  assert.equal(isShortenedCandidateName(""), false);

  // ── 5 · The pool renders the derived name, and keeps the original reachable ─
  const workspace = read("src/components/recruitment/recruitment-workspace.tsx");
  assert.match(
    workspace,
    /candidateDisplayName\(candidate\.fullName\)/,
    "the table must show the derived name — the stored envelope is what broke the layout",
  );
  assert.match(
    workspace,
    /title=\{candidate\.fullName\}/,
    "the full stored value must stay reachable on hover, so nothing is actually hidden from a recruiter",
  );

  // ── 6 · The action strip is one line, not eight ─────────────────────────────
  //
  // The regression this guards: reintroducing a `w-full` field into the row's action flex row.
  // A full-width flex item claims an entire line, which is what stacked the buttons in the first
  // place and what made the row eight lines tall.
  const actionsControl = workspace.slice(
    workspace.indexOf("function CandidateActionsControl("),
    workspace.indexOf("function CandidatePoolCard("),
  );
  assert.ok(actionsControl.length > 0, "CandidateActionsControl must still exist");
  assert.doesNotMatch(
    actionsControl,
    /className=\{fieldClass\}/,
    "a bare fieldClass is w-full — inside the row's flex strip that forces one control per line",
  );

  // Every control in the strip is a 28px square with no visible text, so the only thing naming it
  // is the label — required on PoolIconButton, and rendered as both aria-label and the hover title.
  const iconButtons = actionsControl.match(/<PoolIconButton\b/g) ?? [];
  assert.ok(iconButtons.length >= 4, `the strip should be icon buttons, found ${iconButtons.length}`);
  for (const call of actionsControl.split("<PoolIconButton").slice(1)) {
    // Up to the button's own children — props only, never the next button's.
    assert.match(
      call.slice(0, call.indexOf("</PoolIconButton>")),
      /\blabel=/,
      "an unlabelled icon button is a mystery square — every one needs its name",
    );
  }
  const iconButtonDefinition = workspace.slice(workspace.indexOf("function PoolIconButton("));
  assert.match(
    iconButtonDefinition.slice(0, iconButtonDefinition.indexOf("\n}\n")),
    /aria-label=\{label\}[\s\S]*title=\{label\}/,
    "the label must reach both the screen reader and the hovering recruiter",
  );

  // ── 7 · The duplicate flag reaches the desktop row too ──────────────────────
  //
  // 132 of the 555 production rows share a person with another row. The flag existed on the data
  // and on the mobile card, but the desktop table — the surface Talent Acquisition actually works
  // in — never showed it.
  const duplicateSites = workspace.match(/possibleDuplicate/g) ?? [];
  assert.ok(
    duplicateSites.length >= 2,
    `the possible-duplicate flag belongs on the desktop row as well as the mobile card — found ${duplicateSites.length}`,
  );
}
