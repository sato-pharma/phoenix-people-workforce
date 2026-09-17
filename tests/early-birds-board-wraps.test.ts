import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The Early Birds BOARD must wrap, and must keep square corners.
 *
 * ## The incident this pins
 *
 * 2026-09-18, a screenshot from the owner: the Hall of Fame band printing four winners' names ON
 * TOP OF one another. "Hassan Mohamed Raffat Mohamed Elsherbiny" overlapped its neighbours twice
 * over, and the band was unreadable — on a DESKTOP screen, not a phone.
 *
 * The mechanism was two classes a line apart in early-birds-hall-of-fame.tsx: each winner sat in a
 * fixed `w-36` / `sm:w-40` column and the name carried `whitespace-nowrap`. A five-part Egyptian
 * name — the normal case in this company, not the long tail — renders ~330px wide at 12px/700, so
 * it bled symmetrically out of a 144px box into the columns on both sides. `flex-wrap` on the row
 * could not help: every item measured exactly 144px, so the row never wrapped and the overflow had
 * nowhere to go. It is the same failure early-bird-of-the-fortnight-card.tsx was fixed for on
 * 2026-09-02; the board it links to never got the same pass.
 *
 * The owner's fits-the-screen golden rule (AGENTS.md §4) allows exactly one remedy: WRAPPING.
 * Explicitly NOT a smaller type scale, NOT an ellipsis or `truncate`, and NOT `overflow-x-auto`
 * over a min-width floor — the rule names that last one as the bug rather than the fix.
 *
 * ## What is asserted, and what is deliberately NOT
 *
 * Every string on this board that is a NAME or a SENTENCE must be able to break. Short tokens are
 * left alone on purpose and this test does not ban `whitespace-nowrap` file-wide: a clock ("08:42"),
 * a points figure, a "×4" chip and a day cell are all better held together than broken, and a
 * blanket ban would be a rule nobody could follow. So the check is per NODE, anchored on the
 * expression each one renders.
 *
 * The desktop `<table>` inside PortalDesktopTable is also left alone: the owner's rule is
 * desktop-tables / mobile-cards, and that primitive's own horizontal behaviour belongs to it, not
 * to this module.
 *
 * Pinned by SHAPE, not by a byte window, so an edit elsewhere in a file cannot false-fail it.
 * Comments are stripped first — every one of these files explains the banned utilities in prose,
 * and a pinning test that matched its own explanation would pin the anti-pattern.
 */

const HALL_OF_FAME = "src/components/early-birds/early-birds-hall-of-fame.tsx";
const WINNER_PANEL = "src/components/early-birds/early-birds-winner-panel.tsx";
const RACE_PANEL = "src/components/early-birds/early-birds-race-panel.tsx";
const REP_TABLE = "src/components/early-birds/early-birds-rep-table.tsx";
const SWITCHER = "src/components/early-birds/early-birds-district-switcher.tsx";

const BOARD_FILES = [HALL_OF_FAME, WINNER_PANEL, RACE_PANEL, REP_TABLE, SWITCHER];

/** Drop block comments and whole-line `//` comments. Never touches a `//` inside a string. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

/**
 * Every class token actually applied in a file — from both `className="…"` and the template-literal
 * form `className={`…`}`, because this module uses both and reading only the first would certify a
 * file whose real classes it never saw.
 */
function appliedTokens(code: string): Set<string> {
  const quoted = [...code.matchAll(/className="([^"]*)"/g)].map((match) => match[1]);
  const templated = [...code.matchAll(/className=\{`([^`]*)`\}/g)].map((match) => match[1]);
  return new Set(
    [...quoted, ...templated]
      .join(" ")
      // `${…}` interpolations carry classes chosen at runtime; their literal halves are still
      // plain tokens once the braces are gone, so strip the syntax rather than the content.
      .replace(/\$\{|\}/g, " ")
      .split(/\s+/)
      .filter(Boolean),
  );
}

/** True when `utility` is applied bare or behind any variant prefix (`sm:`, `@3xl:`, `hover:`). */
function isApplied(tokens: Set<string>, utility: string): boolean {
  return [...tokens].some((token) => token === utility || token.endsWith(`:${utility}`));
}

/**
 * The className of the element that renders `expression`, or null.
 *
 * Deliberately anchored on the expression rather than on a line number: a source-pinning test that
 * slices a byte window false-fails the moment the file above it shifts (AGENTS.md §2.1).
 */
function classOfNodeRendering(code: string, expression: string): string | null {
  const escaped = expression.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = code.match(
    new RegExp(`<(?:p|span|div)\\s+className="([^"]*)"[^>]*>\\s*\\{${escaped}\\}`),
  );
  return match ? match[1] : null;
}

export function runEarlyBirdsBoardWrapsTests() {
  const sources = new Map(BOARD_FILES.map((file) => [file, stripComments(readFileSync(file, "utf8"))]));

  // ── 0. anti-vacuity ──────────────────────────────────────────────────────────
  // Every assertion below reads a className out of a file. If a file were renamed away or emptied,
  // the regexes would simply stop matching and this suite would pass on nothing.
  for (const [file, code] of sources) {
    assert.ok(
      appliedTokens(code).size > 10,
      `${file}: fewer than ten class tokens found — the file is gone, empty, or no longer written ` +
        `with literal classNames. Re-point this test at whatever renders the board now; do not ` +
        `drop the check.`,
    );
  }

  // ── 1. the three remedies the golden rule forbids, across the whole board ─────
  for (const [file, code] of sources) {
    const tokens = appliedTokens(code);
    for (const banned of ["truncate", "text-ellipsis", "overflow-x-auto"]) {
      assert.ok(
        !isApplied(tokens, banned),
        `${file}: "${banned}" is not an allowed remedy here. AGENTS.md §4 bans the ellipsis outright ` +
          `and names overflow-x-auto over a min-width floor as the bug, not the fix. Wrap, or merge ` +
          `columns — never shrink type and never clip.`,
      );
    }
  }

  // ── 2. every NAME and every SENTENCE on the board can break ───────────────────
  // `whitespace-nowrap` is not banned file-wide on purpose: a clock, a "×4" chip and a day cell are
  // better held together. These nodes are the ones that hold a person's name or a full sentence.
  const mustBreak: { file: string; expression: string; why: string }[] = [
    {
      file: HALL_OF_FAME,
      expression: "winner.employeeName",
      why: "the winner name in the Hall of Fame grid — THE line in the owner's screenshot, which " +
        "overlapped its neighbours on both sides",
    },
    {
      file: HALL_OF_FAME,
      expression: "entry.name",
      why: "the repeat-winner name in the Most stars ladder",
    },
    {
      file: WINNER_PANEL,
      expression: "winner.employeeName",
      why: "the winner's name at 20px/900 — the largest type on the board holding its longest string",
    },
    {
      file: RACE_PANEL,
      expression: "score.name",
      why: "the rep's name in a race row, in a column ~150px wide on a phone",
    },
    {
      file: REP_TABLE,
      expression: "score.name",
      why: "the rep's name on the phone card (the desktop table is a separate, deliberate surface)",
    },
  ];

  for (const { file, expression, why } of mustBreak) {
    const code = sources.get(file);
    assert.ok(code, `${file}: not loaded`);
    const className = classOfNodeRendering(code, expression);
    assert.ok(
      className !== null,
      `${file}: could not find the element rendering {${expression}} (${why}). Re-point this ` +
        `assertion at whatever renders it now — do not delete it.`,
    );
    const tokens = className.split(/\s+/);
    assert.ok(
      tokens.includes("break-words"),
      `${file}: the element rendering {${expression}} is "${className}" — missing "break-words". ` +
        `${why}, and Egyptian names run four and five parts long, so it has to break rather than ` +
        `run off or overlap.`,
    );
    assert.ok(
      !tokens.includes("whitespace-nowrap"),
      `${file}: the element rendering {${expression}} carries "whitespace-nowrap". That is exactly ` +
        `what produced the overlapping names in the 2026-09-18 screenshot.`,
    );
  }

  // ── 3. the Hall of Fame's fixed-width columns must stay gone ──────────────────
  // Wrapping alone was not the whole fix. Inside a fixed `w-36` box a wrapped name still cannot use
  // the space beside it, and `flex-wrap` on the row is inert when every item measures the same
  // fixed width — which is why the row never broke and the overflow had nowhere to go.
  const hallTokens = appliedTokens(sources.get(HALL_OF_FAME) ?? "");
  for (const fixed of ["w-36", "w-40"]) {
    assert.ok(
      !isApplied(hallTokens, fixed),
      `${HALL_OF_FAME}: "${fixed}" is back on a winner cell. A fixed column cannot be wrapped out ` +
        `of — the name overflows it and lands on the cells either side. Use the grid's ` +
        `minmax(0,1fr) columns instead.`,
    );
  }
  assert.ok(
    isApplied(hallTokens, "grid") && isApplied(hallTokens, "grid-cols-1"),
    `${HALL_OF_FAME}: the winners are no longer laid out as a grid starting at one column. A grid ` +
      `of minmax(0,1fr) columns is what makes a cell unable to exceed its own share, whatever name ` +
      `is inside it.`,
  );

  // ── 4. breakpoints read the BAND, not the window ──────────────────────────────
  // early-bird-of-the-fortnight-card.tsx learned this on 2026-09-05: this component renders
  // full-width in the admin shell and inside the portal page shell, and those are different widths.
  assert.ok(
    isApplied(hallTokens, "@container"),
    `${HALL_OF_FAME}: the root has lost "@container", so every "@" variant below it matches nothing ` +
      `and the band renders one column everywhere.`,
  );
  const hallGrid = (sources.get(HALL_OF_FAME) ?? "").match(/className="(grid grid-cols-1[^"]*)"/);
  assert.ok(hallGrid, `${HALL_OF_FAME}: could not find the winners grid's className.`);
  const viewportPrefixed = hallGrid[1].split(/\s+/).filter((token) => /^(sm|md|lg|xl|2xl):/.test(token));
  assert.deepEqual(
    viewportPrefixed,
    [],
    `${HALL_OF_FAME}: the winners grid carries viewport breakpoints ${JSON.stringify(viewportPrefixed)}. ` +
      `A window-sized query cannot see how wide this band actually is — use the "@" container variants.`,
  );

  // ── 5. the square-edge golden rule ────────────────────────────────────────────
  // AGENTS.md §4: no round or semi-round corners, anywhere. Three chips on this board shipped with
  // one (`rounded-md` on the winner star and the ×N badge, `rounded` on the source badge).
  for (const [file, code] of sources) {
    const rounded = [...appliedTokens(code)].filter((token) =>
      /(^|:)rounded(-|$)/.test(token) || token === "rounded" || token.endsWith(":rounded"),
    );
    assert.deepEqual(
      rounded,
      [],
      `${file}: ${JSON.stringify(rounded)} — the owner's square-edge golden rule (AGENTS.md §4) is ` +
        `"no round or semi-round corners, anywhere". Drop the utility; do not soften it.`,
    );
  }
}
