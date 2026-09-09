import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The searchable dropdown clipped every option label with an ellipsis.
 *
 * Seen on production on 24 Aug 2026, in the Recruitment module's "Open a requisition" form: the
 * Hiring manager list offered "Ahmed Abdallah · District Sales Mana…", "Amgad Ibrahim Tawfik Farag
 * · District …" and "Mahmoud El Husseinin · District Sales …". Three of the six visible rows were
 * cut, and two of them were cut inside the job title — so a person picking a hiring manager was
 * choosing between names the screen would not finish saying.
 *
 * The cause was one Tailwind class on the option label, `truncate`, which is
 * `overflow: hidden; text-overflow: ellipsis; white-space: nowrap`. It is the second half of that
 * declaration that was wanted (one line, never wrapped) and the first half that broke the standing
 * rule: never truncate text with an ellipsis.
 *
 * `SearchableSelect` is used in 94 files, so this was every dropdown in the application, not a
 * recruitment defect. The first fix kept the one-line rule with `whitespace-nowrap` and let the
 * panel grow past its trigger to fit the longest label instead of cutting it.
 *
 * That fix then failed the OTHER way, and this file's own assertions pinned the failure in place.
 * The panel is capped at the viewport, so a row wider than the cap cannot grow — it scrolls. On
 * 2026-09-09 the Employee Master vacancy picker measured 708px of row inside a 491px panel, with
 * each row's district and manager sitting past the right edge, reachable only by dragging a
 * scrollbar most people never see. AGENTS.md §4 had already settled which rule wins: the
 * no-horizontal-scroll golden rule supersedes the old "never let text wrap" companion, and
 * wrapping is the permitted answer. So the assertions below now require the opposite class of the
 * two they used to require, and the panel is pinned as vertical-scroll-only. The ellipsis ban is
 * unchanged and absolute.
 *
 * This test reads the component's source rather than rendering it, because the defect IS the class
 * list — a rendering test that asserted on text content would have passed the whole time the
 * ellipsis was on screen, since `text-overflow` is painted by the browser and never enters the DOM.
 */
export function runSearchableSelectNoEllipsisTests() {
  const source = readFileSync("src/components/ui/searchable-select.tsx", "utf8");

  // ---------------------------------------------------------------------------
  // The headline: the class that produced the ellipsis is gone, and the class
  // that lets a long row wrap instead of scrolling is in its place.
  // ---------------------------------------------------------------------------
  const labelSpan = source.match(/<span className="([^"]*)">\{option\.label\}<\/span>/);
  assert.ok(labelSpan, "the option label is no longer rendered by a <span> with a plain className");
  const labelClasses = labelSpan[1].split(/\s+/);
  assert.ok(
    labelClasses.includes("whitespace-normal") && labelClasses.includes("break-words"),
    `the option label must WRAP rather than push the panel into a sideways scroll; className was "${labelSpan[1]}"`,
  );
  assert.ok(
    labelClasses.includes("min-w-0"),
    `the label sits in a flex row and needs min-w-0 to shrink at all, or the scroll comes straight back; className was "${labelSpan[1]}"`,
  );
  assert.ok(
    !labelClasses.includes("whitespace-nowrap"),
    "`whitespace-nowrap` is back on the option label — that is the sideways scroll, one step out from the ellipsis",
  );
  assert.ok(
    !labelClasses.includes("truncate"),
    "`truncate` is back on the option label — that is the ellipsis, verbatim",
  );

  // Nowhere else in the component either. `truncate` anywhere here clips something a person reads.
  // Comments are stripped first: the rule is about the class being APPLIED, not the word being
  // discussed, and the fix's own comment names the class it removed in order to explain itself.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.ok(
    !/\btruncate\b/.test(code),
    "`truncate` reappeared in searchable-select.tsx; it always ends as an ellipsis on screen",
  );

  // ---------------------------------------------------------------------------
  // Both option render paths, not just the selectable one. A disabled option is
  // still read by whoever is deciding, and one unwrappable row is enough to make
  // the whole panel scroll sideways.
  // ---------------------------------------------------------------------------
  const labelRenders = source.match(/\{option\.label\}/g) ?? [];
  assert.equal(
    labelRenders.length,
    2,
    `expected exactly two option-label render paths (selectable and disabled), found ${labelRenders.length} — a new one needs its own wrapping`,
  );
  const disabledRow = source.match(/"w-full ([^"]*)border-b border-slate-100 px-3 py-2 text-left text-sm text-slate-400"/);
  assert.ok(disabledRow, "the disabled option row's class list moved; re-check how it handles a long label");
  assert.ok(
    disabledRow[1].includes("whitespace-normal") && disabledRow[1].includes("break-words"),
    `a disabled option must wrap like a selectable one; className was "w-full ${disabledRow[1]}..."`,
  );

  // ---------------------------------------------------------------------------
  // And the panel itself may not offer a horizontal scrollbar. This is the check
  // that would have caught the 2026-09-09 measurement (708px of row inside a
  // 491px panel on the Employee Master vacancy picker): the rows were not
  // clipped and nothing was truncated, so every ellipsis assertion above passed
  // while the district and the manager sat off the right edge.
  // ---------------------------------------------------------------------------
  const panel = source.match(/className="fixed z-\[1000\] ([^"]*)"/);
  assert.ok(panel, "the dropdown panel's class list moved; re-check its overflow");
  const panelClasses = panel[1].split(/\s+/);
  assert.ok(
    panelClasses.includes("overflow-x-hidden"),
    `the panel may never scroll sideways — wrapping is the answer, per AGENTS.md §4; className was "${panel[1]}"`,
  );
  assert.ok(
    panelClasses.includes("overflow-y-auto"),
    `the panel still needs to scroll VERTICALLY, or a long list has nowhere to go; className was "${panel[1]}"`,
  );
  assert.ok(
    !panelClasses.includes("overflow-auto") && !panelClasses.includes("overflow-x-auto"),
    `\`overflow-auto\` on the panel is a horizontal scrollbar in waiting; className was "${panel[1]}"`,
  );

  // ---------------------------------------------------------------------------
  // The panel has to be able to grow, or removing the ellipsis just moves the
  // problem: a label wider than the trigger would overflow or wrap instead.
  // ---------------------------------------------------------------------------
  assert.ok(
    /className="fixed[^"]*\bw-max\b/.test(source),
    "the dropdown panel must size to its content (w-max), otherwise a long label has nowhere to go",
  );
  assert.ok(
    /minWidth: menuRect\.width/.test(source),
    "the panel must be at LEAST as wide as the field it hangs from",
  );
  assert.ok(
    /maxWidth: menuRect\.maxWidth/.test(source),
    "the panel must be capped, or a long label pushes it off-screen",
  );

  // The cap is measured from the viewport, not guessed at with a constant.
  assert.ok(
    /window\.innerWidth - rect\.left/.test(source),
    "the width cap must come from the real distance to the viewport's right edge",
  );
  assert.ok(
    /maxWidth: Math\.max\(rect\.width, roomToTheRight\)/.test(source),
    "the cap must never fall below the trigger's own width, or a narrow field near the right edge shrinks its own panel",
  );
}
