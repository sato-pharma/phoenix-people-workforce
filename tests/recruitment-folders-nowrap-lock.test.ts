import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// THE FITS-THE-SCREEN GOLDEN RULE, pinned for the Recruitment → Folders tab.
//
// WHY THIS FILE EXISTS. On 2026-09-12 that tab was measured on production at 375x812 and `main`
// came back scrollWidth 440 against clientWidth 375 — a 65px sideways scroll, the golden rule
// broken. Walking every descendant put the whole 65px on ONE element: a `<p>` holding
// "N more already rejected — a rejection is a settled decision, not shown here." at
// `whitespace-nowrap`, laid out 415px wide inside a 351px box. Removing that one class took the
// page to 375 = 375.
//
// It was the third such break on this one tab. The first two had already been fixed the same way
// on 2026-09-02 — the shelf description (441px inside 325px) and a candidate's five-part name
// (335px inside 325px). Sweeping the rest of the tab on 2026-09-12 turned up four more that had
// not bitten yet only by luck:
//
//   - the folder chip, which held its whole label at `whitespace-nowrap` behind a comment about a
//     26-character AREA name. "Other positions" now mints one folder per declared JOB TITLE, and
//     production already holds "Technical Support and infrastructure Engineer" — that chip is
//     311px inside a 349px row, five characters from painting off the side of the phone.
//   - the `Filed: <kind> · <folder>` badge in the degrees-review panel. Fed that same real folder
//     label, the live page went to scrollWidth 413 against clientWidth 375 — a 38px scroll. It
//     had not fired only because that folder had not yet co-occurred with a review row.
//   - "Nobody here reaches a district manager until you answer." — 314px inside a 349px row, so
//     it fitted, with 35px to spare, while being a sentence.
//   - "N answered but cannot be placed" — fitted too, and is one wording change from not.
//
// SEVEN elements on this one tab have had the class taken off them across those two nights, and
// no check could see any of them. Nothing in CI measures a rendered width, `whitespace-nowrap` is
// correct on most of the elements that carry it, and a reviewer reading a diff cannot tell a
// label from a sentence by looking. Hence a pin.
//
// WHAT THIS TEST DOES, AND WHAT IT DELIBERATELY DOES NOT. It does not try to compute a rendered
// width — that needs a font and a layout engine, and a test that invents character advances would
// be worse than no test, because it would read as a measurement. Instead:
//
//   1. It pins the INVENTORY. Every `whitespace-nowrap` in these three files is recorded below.
//      Adding one turns this red, and the failure tells you to go and measure at 375x812 before
//      recording it. The point is not that the pin knows anything — it is that the class cannot
//      be added silently, which is exactly how all seven got in.
//   2. It asserts the SENTENCE RULE independently: literal text ending in a full stop is prose,
//      and prose never carries `whitespace-nowrap`. That catches the two worst of the seven —
//      including the one that actually broke production — without any reference to the pin, so a
//      file added to GOVERNED_FILES is guarded from its first run.
//
// AGENTS.md §4 settles the remedy when this fires: where the no-horizontal-scroll rule collides
// with the no-wrap habit, WRAPPING WINS. Never reach for `truncate` — text on these screens is
// never cut with an ellipsis. The fix is always to delete the class, never to pin the new value.

/** The three components that render the Folders tab, and the only files this pin governs. */
const GOVERNED_FILES = [
  "candidate-folders-tab.tsx",
  "background-review-panel.tsx",
  "cv-folder-cabinet.tsx",
] as const;

type NowrapUse = {
  file: string;
  line: number;
  /** The element's literal text, whitespace-collapsed — "" when it renders only expressions. */
  literal: string;
  /** Each interpolated expression, source-collapsed, in order. */
  expressions: string[];
};

/**
 * Every `whitespace-nowrap` allowed on this tab, as `file :: literal :: expressions`.
 *
 * A row earns its place ONLY by being a short label, a count, or a section heading — something
 * with a length a reader can bound by looking at it. Three of these were measured on the live
 * page at 375x812 on 2026-09-12 and are annotated with what they came back as; the rest are
 * pinned rather than measured, which is the honest description of what this list is.
 */
const PINNED_NOWRAP = new Set<string>([
  // ── candidate-folders-tab.tsx ────────────────────────────────────────────────────────────────
  "candidate-folders-tab.tsx :: filed · in the pool :: filedCount | pool.length",
  "candidate-folders-tab.tsx :: archived :: archived.length",
  "candidate-folders-tab.tsx ::  :: shelf.label",
  'candidate-folders-tab.tsx ::  :: shelf.candidateCount | shelf.candidateCount === 1 ? "CV" : "CVs"',
  "candidate-folders-tab.tsx ::  :: candidateStatusLabel(candidate.status)",
  // "filed <stamp> by <name>" — a name has no length bound, but it sits alone on its own line of a
  // `flex-wrap` row, so it wraps as a unit rather than widening the row. Measured 2026-09-12: the
  // page stayed at 375 with it present.
  'candidate-folders-tab.tsx :: filed :: cairoDateTime(candidate.folder.filedAt) | candidate.folder.filedByHrId ? ` by ${personLabel(candidate.folder.filedByName, UNNAMED_FILER_LABEL)}` : ""',
  // "They told us where they belong" lost its class in the 2026-10-19 premium sweep: it is now the
  // title on a panel's dark band, set in spaced capitals, where held at `whitespace-nowrap` it would
  // take about the full width of a phone with nothing left beside it. A heading that wraps is the fix.
  "candidate-folders-tab.tsx ::  :: group.label",
  'candidate-folders-tab.tsx ::  :: group.names.length | group.names.length === 1 ? "CV" : "CVs"',
  "candidate-folders-tab.tsx ::  :: candidateDisplayName(row.fullName)",
  "candidate-folders-tab.tsx ::  :: folder.candidates.length",

  // ── background-review-panel.tsx ──────────────────────────────────────────────────────────────
  // The SENTENCE under the heading — "Nobody here reaches a district manager until you answer." —
  // was 314px inside a 349px row, 35px from breaking, and lost its class on 2026-09-12. The heading
  // itself, "Degrees waiting for you to check", lost its class in the 2026-10-19 premium sweep for
  // the same reason as "They told us where they belong" above: it is a band title in spaced capitals.
  'background-review-panel.tsx ::  :: total | total === 1 ? "CV" : "CVs"',
  "background-review-panel.tsx ::  :: heading",
  "background-review-panel.tsx ::  :: rows.length",
  "background-review-panel.tsx ::  :: candidateStatusLabel(candidate.status)",

  // ── cv-folder-cabinet.tsx ────────────────────────────────────────────────────────────────────
  "cv-folder-cabinet.tsx :: Your folders :: ",
  'cv-folder-cabinet.tsx :: folder · CV :: cabinet.rows.length | cabinet.rows.length === 1 ? "" : "s" | filedTotal | filedTotal === 1 ? "" : "s"',
  'cv-folder-cabinet.tsx :: here :: openFolder.directCount | openFolder.totalCount !== openFolder.directCount ? ` · ${openFolder.totalCount} with subfolders` : ""',
  "cv-folder-cabinet.tsx :: picked :: selectedIds.length",
  "cv-folder-cabinet.tsx ::  :: node.totalCount",
]);

/** Collapse a source fragment to one line so a reformat does not move the pin. */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Every JSX element in one file whose className mentions `whitespace-nowrap`. */
function nowrapUses(file: string): NowrapUse[] {
  const path = fileURLToPath(new URL(`../src/components/recruitment/${file}`, import.meta.url));
  const source = readFileSync(path, "utf8");
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX);

  assert.equal(
    (parsed as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics?.length ?? 0,
    0,
    `${file} does not parse — fix the syntax error before reading anything into this pin`,
  );

  const found: NowrapUse[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      // A spread attribute has no name at all, so it can never be the className — skipping it
      // here is what keeps `property.name` safe to read below.
      const className = opening.attributes.properties.find(
        (property): property is ts.JsxAttribute =>
          ts.isJsxAttribute(property) && property.name.getText() === "className",
      );

      if (className && className.getText().includes("whitespace-nowrap")) {
        let literal = "";
        const expressions: string[] = [];

        if (ts.isJsxElement(node)) {
          for (const child of node.children) {
            if (ts.isJsxText(child)) literal += child.text;
            else if (ts.isJsxExpression(child) && child.expression) {
              expressions.push(collapse(child.expression.getText()));
            }
          }
        }

        found.push({
          file,
          line: parsed.getLineAndCharacterOfPosition(opening.getStart()).line + 1,
          literal: collapse(literal),
          expressions,
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(parsed);
  return found;
}

function key(use: NowrapUse): string {
  return `${use.file} :: ${use.literal} :: ${use.expressions.join(" | ")}`;
}

export function runRecruitmentFoldersNowrapLockTests() {
  const uses = GOVERNED_FILES.flatMap((file) => nowrapUses(file));

  assert.ok(
    uses.length > 0,
    "found no `whitespace-nowrap` at all in the Folders tab components — the parser or the file " +
      "list is wrong, and a pin that reads nothing passes forever",
  );

  // ── 1. THE SENTENCE RULE ─────────────────────────────────────────────────────────────────────
  // Independent of the pin below: prose never carries `whitespace-nowrap`. A full stop in the
  // element's own literal text is the tell that it is a sentence rather than a label, and a
  // sentence has no width a reader can bound. This is the shape that broke the tab three times.
  for (const use of uses) {
    assert.ok(
      !/[.]$/.test(use.literal),
      `${use.file}:${use.line} holds a SENTENCE at \`whitespace-nowrap\`: "${use.literal}". ` +
        "Prose wraps — delete the class. AGENTS.md §4: where the no-horizontal-scroll rule " +
        "collides with the no-wrap habit, wrapping wins, and never swap it for `truncate` " +
        "because text on these screens is never cut. An identical sentence took this tab to " +
        "scrollWidth 440 against clientWidth 375 on production at 375x812.",
    );
  }

  // ── 2. THE INVENTORY PIN ─────────────────────────────────────────────────────────────────────
  // The pin does not know whether a new element is safe. It knows that nobody looked.
  const seen = new Set<string>();
  for (const use of uses) {
    const id = key(use);
    seen.add(id);
    assert.ok(
      PINNED_NOWRAP.has(id),
      `${use.file}:${use.line} carries a \`whitespace-nowrap\` that is not pinned:\n` +
        `  ${id}\n` +
        "Measure it first: load the Folders tab at 375x812 and read `main`.scrollWidth against " +
        "`main`.clientWidth, and walk the descendants for scrollWidth > clientWidth. If the page " +
        "still fits AND the text is a short label, a count or a heading, add that exact line to " +
        "PINNED_NOWRAP with what you measured. If it is prose, or it interpolates a name, an " +
        "area or a job title — anything a person types, which has no length bound — delete the " +
        "class instead. Seven elements on this tab have already had to have it taken off.",
    );
  }

  for (const pinned of PINNED_NOWRAP) {
    assert.ok(
      seen.has(pinned),
      `a pinned \`whitespace-nowrap\` is gone from the source:\n  ${pinned}\n` +
        "If you removed the class deliberately — which is the usual fix when this rule bites — " +
        "delete this line from PINNED_NOWRAP in the same change. The pin is only worth having " +
        "while it matches what the components actually render.",
    );
  }
}
