import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * 🔒 THE NEEDS YOU BOARD AGAINST THE OWNER'S TWO LOCKED LOOK RULES (AGENTS.md §4):
 *
 *  - THE FITS-THE-SCREEN GOLDEN RULE — never a horizontal scroll, always mobile AND desktop friendly.
 *    Fit by MERGING columns, never by shrinking type; `overflow-x-auto` over a `min-width` floor IS
 *    the bug rather than the fix.
 *  - THE SQUARE-EDGE GOLDEN RULE — no round or semi-round corners, anywhere.
 *
 *  ...plus the no-ellipsis rule: text is never truncated, and where that collides with the
 *  no-horizontal-scroll rule, wrapping wins.
 *
 * WHAT THIS FILE IS AND IS NOT. It is the CHEAP half, and it runs in the required `checks` job, which
 * has no browser. The authoritative reading is `scripts/measure-needs-you-fit.mjs`, which renders this
 * component's real emitted markup against the repo's real compiled Tailwind in headless Chromium and
 * measures `scrollWidth`, per-cell clipping and computed `border-radius` — because the house rule is
 * to verify the emitted artifact, never the source, and because on the admin shell
 * `.admin-shell { overflow-x: clip }` makes a page-level `scrollWidth` check INERT: it reads a clean
 * 375/375 while a cell hangs hundreds of pixels off the side. A required check cannot depend on a
 * browser being in the runner image, so the two halves exist for different reasons and neither
 * replaces the other. This one stops the CLASSES that cause it coming back.
 *
 * Class tokens are read from what the file APPLIES, never from a substring search over the whole
 * source: this component's own header explains in prose why there is no `overflow-x-auto` in it, and a
 * plain search would read that explanation as the defect it warns against.
 */

const BOARD = "src/components/admin/needs-you-board.tsx";

/**
 * Every class the file actually applies.
 *
 * Braces are scanned with a depth counter rather than matched with a regex, because one `className`
 * here is a conditional with a string literal in each arm — a `className="([^"]*)"` pass sees neither,
 * and a file can then carry a rounded or truncating class inside a ternary with this test green.
 */
function appliedClassTokens(source: string): Set<string> {
  const values: string[] = [];
  const marker = "className=";
  for (let at = source.indexOf(marker); at !== -1; at = source.indexOf(marker, at + 1)) {
    let cursor = at + marker.length;
    if (source[cursor] === '"') {
      const end = source.indexOf('"', cursor + 1);
      if (end === -1) continue;
      values.push(source.slice(cursor + 1, end));
      continue;
    }
    if (source[cursor] !== "{") continue;
    // Balanced braces, so a nested cn()/ternary/template is captured whole.
    let depth = 0;
    const start = cursor;
    for (; cursor < source.length; cursor += 1) {
      if (source[cursor] === "{") depth += 1;
      else if (source[cursor] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const expression = source.slice(start + 1, cursor);
    // Every literal inside the expression, in all three quotings.
    for (const match of expression.matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`/g)) {
      values.push(match[1] ?? match[2] ?? match[3] ?? "");
    }
  }
  return new Set(
    values
      .flatMap((value) => value.split(/\s+/))
      // Drop interpolation fragments, which are not classes.
      .filter((token) => token && !token.includes("${")),
  );
}

export function runNeedsYouFitsTheScreenTests() {
  const source = readFileSync(BOARD, "utf8");
  const tokens = appliedClassTokens(source);

  // A control on the instrument itself. If the extractor silently stopped finding classes, every
  // absence check below would pass for the wrong reason — the same trap as a harness that reports "no
  // overflow" because Tailwind never loaded.
  assert.ok(
    tokens.has("break-words") && tokens.has("min-w-0") && tokens.size > 20,
    `The class extractor found only ${tokens.size} tokens in ${BOARD}. Every assertion below is an ` +
      `ABSENCE check, so an extractor that finds nothing makes all of them pass. Fix the extractor ` +
      `before trusting this file.`,
  );

  // ── 1. The desktop grid is table-fixed with a colgroup, never a min-width floor ─────────────────
  assert.ok(
    tokens.has("table-fixed"),
    `${BOARD}: the desktop table must be "w-full table-fixed". Without table-fixed the browser sizes ` +
      `columns to content, which is how a long customer name widens the table past the viewport.`,
  );

  const colgroups = [...source.matchAll(/<colgroup>([\s\S]*?)<\/colgroup>/g)].map((match) => match[1] ?? "");
  assert.ok(colgroups.length > 0, `${BOARD}: table-fixed without a <colgroup> gives every column an equal share.`);
  for (const [index, colgroup] of colgroups.entries()) {
    const widths = [...colgroup.matchAll(/w-\[(\d+(?:\.\d+)?)%\]/g)].map((match) => Number(match[1]));
    assert.ok(widths.length > 0, `${BOARD}: colgroup ${index} declares no percentage widths.`);
    assert.equal(
      widths.reduce((sum, width) => sum + width, 0),
      100,
      `${BOARD}: colgroup ${index} widths ${JSON.stringify(widths)} do not sum to 100. Anything over ` +
        `100 is the sideways scroll written down; anything under it leaves a dead strip on the right.`,
    );
    assert.equal(
      widths.length,
      4,
      `${BOARD}: the board is FOUR columns, not ${widths.length}. The count shares its cell with ` +
        `OVERDUE and the names share theirs with "oldest <date> · <n> days" — that merge is how the ` +
        `board fits, and the rule is that you fit by merging columns, never by shrinking type.`,
    );
  }

  const minWidths = [...tokens].filter((token) => /^min-w-\[/.test(token)).sort();
  assert.deepEqual(
    minWidths,
    [],
    `${BOARD}: found min-width floors ${JSON.stringify(minWidths)}. A floor is exactly what forces the ` +
      `sideways scroll; cells wrap instead. ("min-w-0" is the opposite thing and stays.)`,
  );

  // ── 2. Nothing scrolls sideways, in any spelling ────────────────────────────────────────────────
  for (const spelling of ["overflow-x-auto", "overflow-x-scroll", "overflow-auto", "overflow-scroll"]) {
    assert.ok(
      !tokens.has(spelling),
      `${BOARD}: "${spelling}" is present. The golden rule names a scrolling wrapper over a min-width ` +
        `floor as the bug itself — and worse, the wrapper ABSORBS the overflow, so a page-level ` +
        `scrollWidth reading comes back clean while the board hangs off the side.`,
    );
  }

  // ── 3. Square edges ────────────────────────────────────────────────────────────────────────────
  const rounded = [...tokens].filter((token) => /^(?:md:|lg:|sm:|xl:)?rounded/.test(token)).sort();
  assert.deepEqual(
    rounded,
    [],
    `${BOARD}: found ${JSON.stringify(rounded)}. No round or semi-round corners, anywhere. This is also ` +
      `why @/components/ui/card is not used here — it carries --phx-radius — and why SectionShell, ` +
      `which is already square, is reused instead.`,
  );

  // ── 4. No ellipsis, ever ───────────────────────────────────────────────────────────────────────
  for (const banned of ["truncate", "text-ellipsis"]) {
    assert.ok(!tokens.has(banned), `${BOARD}: "${banned}" is present. Text is never cut here; it wraps.`);
  }
  const clamps = [...tokens].filter((token) => token.startsWith("line-clamp-")).sort();
  assert.deepEqual(clamps, [], `${BOARD}: found ${JSON.stringify(clamps)}. A clamp is an ellipsis with extra steps.`);

  // ── 5. A mobile card list beside EVERY desktop table ───────────────────────────────────────────
  //
  // Admin shell rule: desktop shows full tables, mobile gets cards. A `hidden md:block` table with no
  // `md:hidden` list beside it is a band that renders as nothing at all on a phone — which on THIS
  // page is the under-report rule broken by layout rather than by logic.
  const desktopOnly = source.split("hidden md:block").length - 1;
  const mobileOnly = source.split("md:hidden").length - 1;
  assert.ok(
    desktopOnly > 0,
    `${BOARD}: no "hidden md:block" table found. If the desktop table stopped being desktop-only, the ` +
      `phone is now rendering a four-column table.`,
  );
  assert.ok(
    mobileOnly >= desktopOnly,
    `${BOARD}: ${desktopOnly} desktop-only blocks against ${mobileOnly} mobile-only blocks. Every ` +
      `"hidden md:block" table needs an "md:hidden" card list carrying the SAME four facts — a band ` +
      `that disappears on a phone is worse than one that looks cramped.`,
  );
}
