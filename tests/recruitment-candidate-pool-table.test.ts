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
      "Rajesh Kandala Resume From(Rajesh Kandala (rajeshkandala4@gmail com)) Subject(Experienced Health Information Specialist)",
    ),
    "Rajesh Kandala",
    "the sender inside From( … ) is the person",
  );
  assert.equal(
    candidateDisplayName("file 754C9140 8AD3 404A 8339 AFC0892A9BFF From(Ayman Sabry (ayman sabry4207@gmail com)) Subject(Apply for Hr)"),
    "Ayman Sabry",
    "a meaningless attachment filename must not become somebody's name",
  );
  assert.equal(
    candidateDisplayName("Sameh Wahba Recruitment CV 2026 5 From(Wahba Wahba (samehwahba506@gmail com)) Subject(CV)"),
    "Wahba Wahba",
    "the sender wins even when the filename disagrees — a human reconciles it, we do not guess",
  );

  // ── 2 · A real name is left exactly alone ───────────────────────────────────
  assert.equal(candidateDisplayName("Malak Refaat"), "Malak Refaat", "335 of the 555 rows must pass through untouched");
  assert.equal(candidateDisplayName("  Malak Refaat  "), "Malak Refaat", "only whitespace is trimmed");
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
  assert.equal(isShortenedCandidateName("Malak Refaat"), false, "no hover text is needed when nothing was hidden");
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
  // and on the mobile card, but the desktop table — the surface HR Advisory actually works
  // in — never showed it.
  const duplicateSites = workspace.match(/possibleDuplicate/g) ?? [];
  assert.ok(
    duplicateSites.length >= 2,
    `the possible-duplicate flag belongs on the desktop row as well as the mobile card — found ${duplicateSites.length}`,
  );

  // ── 8 · "Applying for" answers, instead of saying "Not stated" 97% of the time ─
  //
  // Only 15 of the 555 production rows store a title. The rest of the evidence ladder lives in
  // src/lib/recruitment/applied-for.ts and is tested there; what this file pins is that the TABLE
  // reads it, and reads it through the one shared resolver rather than re-deriving its own answer.
  assert.match(
    workspace,
    /const appliedFor = candidateRowAppliedFor\(candidate\);/,
    "the desktop row must resolve the role through the shared ladder, not from appliedForJobTitle alone",
  );

  // Shown as inferred, never as fact — the recruiter has to know which of the two they are reading.
  assert.match(
    workspace,
    /appliedFor\.source === "stated" \? "text-slate-900" : "italic text-slate-500"/,
    "a role derived from a message must not be styled like one somebody stated",
  );
  assert.match(
    workspace,
    /APPLIED_FOR_SOURCE_LABEL\[appliedFor\.source \?\? "subject"\]/,
    "the tooltip has to name which source the role was derived from",
  );
  assert.match(
    workspace,
    /appliedFor\.evidence \?\? appliedFor\.text/,
    "and carry the untouched wording, so a recruiter can overrule it without opening the mail",
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

  // Two byte counts replaced by two real edges. The panel is bounded by its own branch end, and
  // the HEADER is found by the ref the component already puts on it rather than by "somewhere in
  // the first 1600 bytes" — the panel is 21,070 bytes long, so that window was only ever asserting
  // that some sticky element appeared early, and it would have reported the header as missing the
  // moment anything was inserted above it.
  const panelAt = workspace.indexOf("{profile ? (");
  const panelEnd = workspace.slice(panelAt).search(/^ {6}\) : \(/m);
  const profilePanel = workspace.slice(panelAt, panelEnd >= 0 ? panelAt + panelEnd : workspace.length);
  const headerRefAt = profilePanel.indexOf("ref={profileHeaderRef}");
  assert.ok(headerRefAt >= 0, "the profile panel's header must still be the element carrying profileHeaderRef");
  // This header used to be `sticky top-0 z-20` so the way back stayed reachable down a long panel.
  // The app's own topbar is ALSO `sticky top-0 z-20` and earlier in the DOM, so the profile header
  // painted straight over the global search box and the role chip — reported from production
  // 2026-08-24. The guarantee is kept, by the mechanism already written for it that had never once
  // run: the floating pill is shown when an IntersectionObserver on this very element stops
  // intersecting, and a sticky element never stops intersecting.
  assert.doesNotMatch(
    profilePanel.slice(profilePanel.lastIndexOf("<", headerRefAt), headerRefAt),
    /className="sticky top-0/,
    "the profile header must not be sticky — it shares top-0 and z-20 with the global topbar",
  );
  assert.match(
    workspace,
    /setWayBackOffScreen\(!entry\.isIntersecting\)/,
    "the way back must still be reachable down a long panel, via the observer on that header",
  );
  assert.match(
    profilePanel,
    /wayBackOffScreen[\s\S]{0,600}?fixed bottom-6 right-6/,
    "the floating way-back pill must be what appears once the header scrolls away",
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
  // Anchored on the candidate pool table's own rebuild comment, not the file's first `<colgroup>`
  // — the fits-the-screen conversion (2026-09-25) gave the two sibling tables in this same file
  // (Applications, Requisitions) their own `cols` colgroups too, so "first colgroup in the file"
  // stopped meaning "the candidate pool's colgroup".
  const poolSection = workspace.slice(workspace.indexOf("Rebuilt 2026-08-20, re-cut 2026-08-24"));
  const colgroup = poolSection.slice(poolSection.indexOf("<colgroup>"), poolSection.indexOf("</colgroup>"));
  // The shape is the invariant; the pin's exact number is re-measured whenever the table is
  // re-cut (280px on 2026-08-21, 332px on 2026-08-24 once the clipped cells were counted per
  // column rather than assumed). Pinning the figure itself only turns a deliberate width change
  // into a red build, so what is asserted is the shape plus the floor the measurement gives.
  const candidatePin = colgroup.match(/<col className="w-\[(\d+)px\]" \/>\s*<col \/>/);
  assert.ok(
    candidatePin,
    "Candidate is pinned and Applying-for takes what is left — not the other way round",
  );
  const candidateWidth = Number(candidatePin?.[1] ?? 0);
  assert.ok(
    candidateWidth >= 323,
    `Candidate needs 323px before its longest production name stops clipping (44 characters, `
      + `measured across 574 rows on 2026-08-24, plus 24px of cell padding); found ${candidateWidth}px`,
  );
  assert.equal(
    (colgroup.match(/<col \/>/g) ?? []).length,
    1,
    "exactly one flexible column, or the measured widths stop meaning anything",
  );

  // ── 13 · The Source column says WhatsApp or email, in words ────────────────
  //
  // The owner's report: "i cannot know whatsapp or email source nothing says this". The cell only
  // ever rendered `sourceContext.shortLabel` — the sender's own wording — which is blank for a
  // WhatsApp image with no caption, and on the rows that do have it is a whole forwarded message
  // clipped inside 116px. The channel was never printed anywhere.
  assert.match(
    workspace,
    /const channel = candidateSourceChannel\(candidate\.source, candidate\.sourceContext\);/,
    "the channel must come from the shared domain helper, not from a ternary re-derived in the table",
  );
  assert.match(
    workspace,
    /<StagePill tone=\{sourceChannelTone\[channel\.key\]\}>/,
    "and render as a pill, which is the one shape that stays legible in a 116px column",
  );

  // Every channel the domain can return needs a colour here, or the pill renders undefined.
  const sourceContext = read("src/lib/recruitment/candidate-source-context.ts");
  const toneMap = workspace.slice(
    workspace.indexOf("const sourceChannelTone"),
    workspace.indexOf("const stageToneMap"),
  );
  for (const key of sourceContext.match(/key: "(\w+)", label/g) ?? []) {
    const channelKey = key.slice('key: "'.length, key.indexOf('", label'));
    assert.ok(toneMap.includes(`${channelKey}: "`), `channel "${channelKey}" has no pill colour`);
  }

  // The Source column is the badge and nothing else. That one sub-line was 173 of the 223 clipped
  // cells on this tab — `shortLabel` is whatever the sender wrote first, reaching 1,546 characters,
  // with a single cell overflowing by 7,094px. Measured in the real font on 2026-08-24, only 38 of
  // the 225 lines fit the 80px of content box this column has, and what fits is "Cv.pdf" and
  // "Bassem cv". A length threshold was tried first and is the wrong shape: it admits the filenames
  // and wraps the other 187, and wrapping breaks the same rule the ellipsis did.
  const sourceCellStart = workspace.indexOf('title={candidate.sourceContext?.detailLines.join("\\n") || undefined}');
  assert.ok(
    sourceCellStart > 0,
    "the sender's words must survive as the Source cell's hover title once the sub-line is gone",
  );
  const sourceCell = workspace.slice(sourceCellStart, workspace.indexOf("</td>", sourceCellStart));
  assert.ok(
    !sourceCell.includes("shortLabel"),
    "the desktop Source cell must not render shortLabel — it does not fit, and it wraps when it cannot",
  );
  assert.ok(
    !/sourceLabelFits|SOURCE_LABEL_MAX_CHARS/.test(workspace),
    'the character threshold came back — it admits "Cv.pdf" and wraps everything longer',
  );

  // Mobile: the channel is unconditional. It used to be the shortLabel wearing the "Source" label,
  // so a captionless WhatsApp CV showed no source at all — exactly the row the owner was looking at.
  assert.match(
    workspace,
    /\{ label: "Source", value: candidateSourceChannel\(candidate\.source, candidate\.sourceContext\)\.label \}/,
    "the mobile card must name the channel on every row, not only when the sender wrote something",
  );
  assert.doesNotMatch(
    workspace,
    /\[\{ label: "Source", value: candidate\.sourceContext\.shortLabel \}\]/,
    "the sender's wording is not the source — it must not be relabelled back onto that row",
  );

  // ── 14 · A certificate says so, instead of looking like a failed read ──────
  //
  // 23 "WhatsApp Import" rows in production are photographs of ICDL certificates, training diplomas
  // and Saudi experience letters — 13 distinct images, 10 of them imported twice. The extractor asks
  // "is this a CV?" on the same call as the 38 fields, and its own prompt permits nulling every
  // field once the answer is no, so those rows came back correctly empty. Nothing on any screen
  // said why, so the same thirteen images were re-read three separate times at full vision price.
  const notACvModule = read("src/lib/recruitment/not-a-cv.ts");
  assert.ok(
    notACvModule.includes("return candidate?.notACv === true;"),
    "isNotACv must gate on the explicit true — absent means nobody has judged the file, which is the state of every row read before the column existed, and flagging those would paint most of the pool",
  );

  const candidatesService = read("src/lib/recruitment/candidates.ts");
  assert.ok(
    candidatesService.includes('.select("candidate_id,created_at,is_cv")'),
    "the pool's verdict loader must select those three columns and no more — extracted_fields is 1.1 MB across the table, and this query crosses the Atlantic to fetch one boolean",
  );
  assert.ok(
    candidatesService.includes("if (row.is_cv === false) notACv.add(candidateId);"),
    "only an explicit false is a verdict; NULL means no judgement on record and must never flag a row",
  );
  assert.ok(
    candidatesService.includes("loadNotACvCandidates(candidates.map((candidate) => candidate.id)),") &&
      candidatesService.includes("const [, , , , latestSends, notACv] = await Promise.all(["),
    "listCandidates must actually call the loader, or the flag is computed nowhere and every badge below is dead markup",
  );

  // Desktop. The badge sits in the role cell — the cell whose emptiness raises the question — and
  // it takes the place of "Not stated" rather than stacking on top of it.
  //
  // Matched as a shape, not as one exact line. On 2026-08-24 the cell gained a first line for the
  // candidate's own job title, so the guard grew a `!facts.roleTitle &&` in front of it, and an
  // exact-substring pin went red while the behaviour it protects had become strictly stronger.
  // What must hold is that "Not stated" prints only when the cell has nothing else to show AND the
  // badge is not about to say the same nothing directly underneath it.
  const notStatedGuard = workspace.match(
    /\{([^{}]*)\?\s*\(\s*<span className="text-slate-300">Not stated<\/span>/,
  );
  assert.ok(notStatedGuard, "the desktop 'Not stated' fallback must still be a guarded branch");
  assert.match(
    notStatedGuard?.[1] ?? "",
    /!appliedFor\.text/,
    "'Not stated' must not print over a row that does have an applied-for answer",
  );
  assert.match(
    notStatedGuard?.[1] ?? "",
    /!isNotACv\(candidate\)/,
    "'Not stated' must give way to the badge, not sit above it saying the same nothing twice",
  );
  assert.ok(
    workspace.includes("<span title={NOT_A_CV_TITLE}>{NOT_A_CV_LABEL}</span>"),
    "the desktop badge needs the explaining sentence on hover — two words alone do not say why the row is empty",
  );

  // The profile panel is where "Read the CV again" sits, which is the button that paid for those
  // re-reads. It reads the verdict off the stored extraction, the freshest copy there is.
  assert.ok(
    workspace.includes("{storedExtraction?.isCv === false ? ("),
    "the profile must show the verdict the retry button would re-ask, or the wasted re-read stays one click away",
  );

  // Mobile: a phone has no hover, so the sentence has to become a field of its own.
  assert.ok(
    workspace.includes('{isNotACv(candidate) ? <StagePill tone="amber">{NOT_A_CV_LABEL}</StagePill> : null}'),
    "the mobile pill row must carry the flag too",
  );
  assert.ok(
    workspace.includes('...(isNotACv(candidate) ? [{ label: "CV file", value: NOT_A_CV_TITLE }] : []),'),
    "and carry the reason, because a card cannot hide it in a tooltip",
  );

  // Rose means "this candidate cannot be hired" — it is what the non-Egyptian flag uses. The
  // attachment being the wrong document is not a judgement on the person.
  assert.ok(
    !workspace.includes('<StagePill tone="rose">{NOT_A_CV_LABEL}</StagePill>'),
    "Not a CV is amber, never rose",
  );
}
