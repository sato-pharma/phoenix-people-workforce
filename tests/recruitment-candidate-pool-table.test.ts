import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { candidateAppliedFor, candidateDisplayName, isShortenedCandidateName } from "../src/lib/recruitment/candidate-display.ts";

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

  // ── 8 · "Applying for" answers, instead of saying "Not stated" 97% of the time ─
  //
  // Only 15 of the 555 production rows store a title. 198 carry a Subject( … ) in the intake
  // envelope, and those subjects are real answers — measured 2026-08-21, reading them lifts the
  // column from 15 populated rows to 186.
  assert.deepEqual(
    candidateAppliedFor("Medical Representative", "anything at all"),
    { source: "stated", text: "Medical Representative" },
    "a stored title always wins — it was entered by a person",
  );
  assert.deepEqual(
    candidateAppliedFor(null, "file 754C From(Islam Mostafa (a@b com)) Subject(Apply for Hr)"),
    { source: "subject", text: "Hr" },
    "the subject line answers it when nothing was stored, with the 'apply for' boilerplate stripped",
  );
  assert.deepEqual(
    candidateAppliedFor(null, "X From(A B (a@b com)) Subject(Personnel & Recruitment Specialist)"),
    { source: "subject", text: "Personnel & Recruitment Specialist" },
    "the single most common subject in production — 22 rows — must come through verbatim",
  );

  // Never invent a role: a wrong job title routes a CV to the wrong hiring manager.
  for (const empty of [
    "X From(A B (a@b com)) Subject(CV)",
    "X From(A B (a@b com)) Subject(resume)",
    "X From(A B (a@b com)) Subject()",
    "Rwan Safaa",
  ]) {
    assert.deepEqual(
      candidateAppliedFor(null, empty),
      { source: null, text: null },
      `"${empty}" names no role — the column must read Not stated rather than guess`,
    );
  }
  assert.equal(
    candidateAppliedFor(null, `X From(A B (a@b com)) Subject(${"a".repeat(80)})`).text,
    null,
    "a subject longer than any real job title is a sentence, not a role",
  );

  // Shown as inferred, never as fact — the recruiter has to know which of the two they are reading.
  assert.match(
    workspace,
    /appliedFor\.source === "subject" \? "italic text-slate-500" : "text-slate-900"/,
    "a role read off a subject line must not be styled like one somebody stated",
  );
  assert.match(
    workspace,
    /Read from the subject line of the message this CV arrived on/,
    "the tooltip has to say where an inferred role came from",
  );

  // ── 9 · Closing the profile returns you to the row you opened it from ─────────
  //
  // The panel renders below a 555-row table, so opening it throws the page to the bottom. Without
  // a remembered position, getting back to row 300 means scrolling for it.
  assert.match(workspace, /returnScrollYRef\.current = typeof window === "undefined" \? null : window\.scrollY/,
    "the pool position must be captured when the profile is opened");
  assert.match(workspace, /const returnToPool = \(\) => \{/, "there must be one way back, shared by both controls");
  assert.match(workspace, /window\.scrollTo\(\{ behavior: "auto", top: returnTo \}\)/, "closing must scroll back to it");
  assert.match(workspace, /Back to the pool/, "and the way back must be visible without scrolling the profile");

  const profilePanel = workspace.slice(workspace.indexOf("{profile ? ("));
  assert.match(
    profilePanel.slice(0, 1600),
    /className="sticky top-0/,
    "the profile's own header must stay put — the panel is long enough to scroll on its own",
  );

  // ── 10 · Neither scroll may be "smooth" ─────────────────────────────────────
  //
  // This is the whole defect, and it is invisible in review — the smooth version reads fine and
  // does nothing. Measured on production 2026-08-21 with the panel 15,489px below the fold:
  // `scrollIntoView({ behavior: "smooth" })` left window.scrollY at 18402 after 1.8s; the identical
  // call with `behavior: "auto"` landed on the panel; a plain `window.scrollTo` moved the page
  // freely. There is no scrollable ancestor to blame — Chrome abandons a programmatic smooth scroll
  // over that distance. So the recruiter pressed the eye, nothing moved, and the profile had opened
  // sixteen screens away. Restoring "smooth" on either scroll silently restores that.
  assert.doesNotMatch(
    workspace,
    /behavior: "smooth"/,
    'a "smooth" scroll does not run over the length of this page — it looks like the button did nothing',
  );
  assert.match(
    workspace,
    /panel\.getBoundingClientRect\(\)\.top \+ window\.scrollY/,
    "the landing position must be computed here, not delegated to scrollIntoView",
  );

  // ── 11 · A way back that survives the page not scrolling at all ─────────────
  //
  // The sticky header only helps once the panel is on screen. The fixed pill is what answers the
  // owner's actual words — "i am pushed to the bottom … need a thing that pulles me from where i
  // was pushed" — because it is anchored to the viewport rather than to the page.
  assert.match(
    workspace,
    /const \[wayBackOffScreen, setWayBackOffScreen\] = useState\(false\)/,
    "the floating way back is state, driven by whether the profile's header is on screen",
  );
  assert.match(
    workspace,
    /new IntersectionObserver\(\(\[entry\]\) => setWayBackOffScreen\(!entry\.isIntersecting\)\)/,
    "an observer, not a scroll handler — a scroll handler on this page runs against 555 rows",
  );
  assert.match(
    profilePanel,
    /\{wayBackOffScreen \? \([\s\S]{0,400}?className="fixed bottom-6 right-6/,
    "and it must be position:fixed, or it is just one more thing below the fold",
  );

  // ── 12 · "Applying for" is the column that gets the room ────────────────────
  //
  // Measured per column across all 555 production rows on 2026-08-21, as the width the text wants
  // at its own computed font: Candidate p99 261px, Applying-for p99 301px, Status 50px,
  // Received 60px. The first cut of this table gave Candidate 443px and Applying-for 140px — so
  // the one fact that decides who a CV goes to was the only starved column, and every longer role
  // read "Personnel and Recruitment Speci…". The flexible slot belongs to it.
  const colgroup = workspace.slice(workspace.indexOf("<colgroup>"), workspace.indexOf("</colgroup>"));
  assert.match(
    colgroup,
    /<col className="w-\[280px\]" \/>\s*<col \/>/,
    "Candidate is pinned and Applying-for takes what is left — not the other way round",
  );
  assert.equal(
    (colgroup.match(/<col \/>/g) ?? []).length,
    1,
    "exactly one flexible column, or the measured widths stop meaning anything",
  );
}
