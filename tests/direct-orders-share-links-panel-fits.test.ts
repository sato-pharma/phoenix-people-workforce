import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// THE DIRECT-ORDER REPORT SHARE-LINKS PANEL, AGAINST THE FITS-THE-SCREEN GOLDEN RULE.
//
// This panel broke the rule (AGENTS.md §4) in three places until 2026-10-13, and all three are the
// kind of defect that is invisible in review and invisible in a screenshot — which is why they are
// pinned as text rather than left to a reader's eye:
//
//   1. The existing-links list was `overflow-x-auto` wrapped around a plain content-sized table of
//      SIX columns. The rule names that exact shape as the bug itself.
//   2. The Sheets formula and the live URL were `overflow-x-auto whitespace-nowrap`, so the one
//      string the reader came to copy scrolled out of sight instead of wrapping.
//   3. There was no mobile layout at all — six columns at 375px.
//
// The sibling screen `src/components/recruitment/cv-lifecycle-share-links-view.tsx` is the worked
// example each fix follows, and section 6 of `tests/cv-lifecycle-share-links-screen.test.ts` is the
// shape these assertions are copied from. A second copy is the point, not duplication: the two
// screens are edited independently, and a pin on one says nothing about the other.
//
// Two further things are pinned because fixing the layout is exactly when they get lost: the
// module's depth tokens (`.claude/rules/direct-orders.md`), and the fact that one verdict serves
// both widths.
// ─────────────────────────────────────────────────────────────────────────────

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

export function runDirectOrdersShareLinksPanelFitsTests() {
  // Read INSIDE the function, never at module load: a source-pinning test whose target is read
  // once per process cannot be break-tested, because every break comes back silent.
  const source = read("../src/components/direct-orders/report-share-links-panel.tsx");

  // Comments stripped for every assertion below. These are "this string must not appear" guards,
  // and the file explains itself by NAMING what it must not do — "`break-all`, not a scroll
  // container", "no `rounded-*` anywhere". Scanning raw text would fail on the documentation of
  // the very rule being kept, teaching the next author to delete the explanation instead of the
  // violation.
  const markup = stripComments(source);

  // ── 1. The desktop list declares its widths ────────────────────────────────

  assert.ok(
    markup.includes('className="w-full table-fixed'),
    "the desktop table must be table-fixed — declared widths are what make a sideways scroll impossible",
  );
  assert.ok(markup.includes("<colgroup>"), "table-fixed without a colgroup declares nothing");

  // Fit by MERGING columns, never by shrinking type. Six headers became four, so the count is the
  // assertion: a session that re-adds Type and Status as their own columns has undone the fix
  // while leaving table-fixed in place, and `table-fixed` with too many columns squeezes text
  // rather than scrolling — the failure the owner's rule calls shrinking.
  const headerCells = [...markup.matchAll(/<th\b/g)].length;
  assert.equal(headerCells, 4, "the merged desktop table has exactly four columns");
  const declaredCols = [...markup.matchAll(/<col\b/g)].length;
  assert.equal(declaredCols, headerCells, "every column must have a declared width, and no extra");

  // ── 2. No scroll, no floor, no cut ─────────────────────────────────────────

  assert.ok(
    !markup.includes("overflow-x-auto") && !markup.includes("overflow-x-scroll"),
    "never a horizontal scroll — the golden rule calls overflow-x-auto over a content-sized table the BUG",
  );
  assert.ok(!markup.includes("min-w-["), "no min-width floor to scroll over");
  assert.ok(
    !markup.includes("whitespace-nowrap"),
    "nothing here may refuse to wrap: a nowrap <code> block is what made the URL scroll",
  );
  assert.ok(
    !/\btruncate\b/.test(markup) && !/text-ellipsis/.test(markup),
    "the owner's rule: never truncate text with an ellipsis — wrap instead",
  );
  assert.ok(
    markup.includes("break-words") || markup.includes("break-all"),
    "fitting is done by WRAPPING, which is the permitted answer",
  );

  // The two copyable strings specifically. They are the longest text on the panel — a feed URL
  // plus `=IMPORTDATA("…")` around it — so they are the first thing to scroll if anyone reaches
  // for a scroll container again.
  const codeBlocks = [...markup.matchAll(/<code className="([^"]+)"/g)].map((match) => match[1]!);
  assert.equal(codeBlocks.length, 2, "the panel shows exactly two copyable strings: the formula and the live URL");
  for (const className of codeBlocks) {
    assert.ok(
      className.includes("break-all"),
      `a copyable string must wrap, not scroll — got "${className}"`,
    );
  }

  // ── 3. Mobile gets cards ───────────────────────────────────────────────────

  assert.ok(
    markup.includes("md:hidden"),
    "mobile gets cards — the admin shell never shows a table there, and six facts do not fit 375px as columns",
  );
  assert.ok(
    markup.includes('className="hidden md:block"'),
    "…and the table is hidden below md, or both layouts paint at once",
  );

  // ── 4. Square corners ──────────────────────────────────────────────────────
  //
  // Pinned as text because `tokens.css` ships `--phx-radius: 4px`, so a rounded corner reads as
  // house style to anyone who did not read the rule.

  assert.ok(!/\brounded(-|\b)/.test(markup), "the square-edge golden rule: no rounded corners anywhere");

  // ── 5. The module's own ground, kept ───────────────────────────────────────
  //
  // A layout pass is exactly when a panel loses its depth: the markup around the tokens changes,
  // and hand-writing the band back is easier than keeping the composition. `--phx-line` is warm
  // #e0dcd4 against slate-200's cool #e2e8f0, so this is not interchangeable with a local border.

  assert.ok(
    markup.includes("adminPanelClassName") && markup.includes("adminPanelHeaderClassName"),
    "the panel keeps the module's depth tokens — the dark band is never hand-written here",
  );
  // Matched by ELEMENT, not by class: `bg-slate-900 … text-white` is also the two "Copy" buttons,
  // which are filled controls and not bands (the module rule records the same trap for pressed tabs).
  assert.ok(
    !/<(header|thead|tr)\b[^>]*bg-slate-900/.test(markup),
    "a dark band must come from adminPanelHeaderClassName, never from an inline bg-slate-900",
  );
  assert.ok(
    /<header className=\{`\$\{adminPanelHeaderClassName\}/.test(markup),
    "the panel's header element wears adminPanelHeaderClassName",
  );

  // ── 6. One verdict, both widths ────────────────────────────────────────────
  //
  // The desktop row and the mobile card show the same link. Computing "is this dead" twice is two
  // answers to one question, and nobody opens both widths at once to notice they disagree.

  assert.ok(
    markup.includes("function linkState("),
    "the active/expired/revoked verdict lives in one helper",
  );
  const verdictReads = [...markup.matchAll(/linkState\(link, loadedAtMs\)/g)].length;
  assert.equal(verdictReads, 2, "both the desktop row and the mobile card read that one helper");
  assert.ok(
    !/const dead =/.test(markup),
    "no layout may recompute the verdict inline — that is what the helper replaced",
  );

  // ── 7. Cairo, always ───────────────────────────────────────────────────────

  assert.ok(
    source.includes('timeZone: "Africa/Cairo"'),
    "every date is reported in Cairo local time, never raw UTC",
  );
}
