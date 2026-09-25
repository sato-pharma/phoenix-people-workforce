import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "./support/comment-strip.ts";

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
 * The rep table's DESKTOP half used to be left alone here, on the reasoning that PortalDesktopTable's
 * horizontal behaviour belonged to that primitive rather than to this module. That was wrong, and
 * section 7 now pins the correction: the primitive scrolls an `overflow-x-auto` wrapper over a
 * 1100px `min-width` floor, which is the exact shape the golden rule names as the bug. Twelve
 * nowrap columns became eight wrapping ones under a `table-fixed` colgroup.
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
const PERIOD_SWITCHER = "src/components/early-birds/early-birds-period-switcher.tsx";
const REP_HISTORY = "src/components/early-birds/early-birds-rep-history-panel.tsx";
const CONTROLS = "src/components/early-birds/early-birds-controls.tsx";
const REP_LINK = "src/components/early-birds/early-birds-rep-link.tsx";
/** Read on its own in section 9 - it is a composition file, not one of the wrapping surfaces. */
const BOARD = "src/components/early-birds/early-birds-board.tsx";

/** Files with enough markup in them for the token-count floor in section 0 to mean something. */
const BOARD_FILES = [HALL_OF_FAME, WINNER_PANEL, RACE_PANEL, REP_TABLE, SWITCHER, PERIOD_SWITCHER, REP_HISTORY];

/**
 * Two files that are SHORT by design — a composition wrapper and a one-element link. A ten-token
 * floor would be unpassable for either, so they are anchored by shape in sections 6 and 8 instead,
 * and they still take the banned-utility and square-edge sweeps below.
 */
const SMALL_FILES = [CONTROLS, REP_LINK];

const ALL_FILES = [...BOARD_FILES, ...SMALL_FILES];

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
  const sources = new Map(ALL_FILES.map((file) => [file, stripComments(readFileSync(file, "utf8"))]));

  // ── 0. anti-vacuity ──────────────────────────────────────────────────────────
  // Every assertion below reads a className out of a file. If a file were renamed away or emptied,
  // the regexes would simply stop matching and this suite would pass on nothing.
  for (const file of BOARD_FILES) {
    const code = sources.get(file) ?? "";
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
      file: REP_HISTORY,
      expression: "name",
      why: "the rep's name at 20px/900 on his own record panel — the largest type there, holding " +
        "the longest string on it",
    },
    {
      file: REP_HISTORY,
      expression: "entry.periodLabel",
      why: "the fortnight label on a phone history card (\"September 1-15, 2026\")",
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

  // ── 6. every rep name on the board now breaks in ONE place ──────────────────
  // Since 2026-09-18 a name is a LINK into that rep's record, so the race row and the rep table no
  // longer render `{score.name}` themselves — they hand it to EarlyBirdsRepLink. That makes this
  // component the single node where the fix can live, and the single node where it can be lost.
  {
    const linkCode = sources.get(REP_LINK) ?? "";
    const breaking = linkCode.split("break-words").length - 1;
    assert.ok(
      breaking >= 2,
      `${REP_LINK}: "break-words" appears ${breaking} time(s). BOTH branches need it — the <Link> ` +
        `and the plain <span> fallback — or a five-part Egyptian name runs off whichever surface ` +
        `took the branch that lost it.`,
    );
    assert.ok(
      !isApplied(appliedTokens(linkCode), "whitespace-nowrap"),
      `${REP_LINK}: "whitespace-nowrap" is back on the one element that renders every rep name on ` +
        `this board. That is exactly what produced the overlapping names in the 2026-09-18 screenshot.`,
    );

    for (const file of [RACE_PANEL, REP_TABLE]) {
      const code = sources.get(file) ?? "";
      assert.match(
        code,
        /<EarlyBirdsRepLink/,
        `${file}: no <EarlyBirdsRepLink>. If the name is rendered some other way now, it is no ` +
          `longer covered by the break-words assertion above — re-point this check, do not drop it.`,
      );
      assert.match(
        code,
        /name=\{score\.name\}/,
        `${file}: the rep name is no longer passed as name={score.name}. A manager opens a rep by ` +
          `clicking his name; if that stopped being the name, the record is unreachable.`,
      );
    }
  }

  // ── 7. the rep table's DESKTOP half has to fit too ─────────────────────────
  // It was twelve `whitespace-nowrap` columns inside PortalDesktopTable, whose wrapper is
  // `overflow-x-auto` over `min-width: 1100px`. AGENTS.md §4 names that shape as THE BUG, and
  // inside the admin rail the content column is well under 1100px on a normal laptop — so the one
  // table on this page a manager reads across was the one that pushed sideways.
  {
    const code = sources.get(REP_TABLE) ?? "";
    assert.doesNotMatch(
      code,
      /PortalDesktopTable/,
      `${REP_TABLE}: PortalDesktopTable is back. Its wrapper scrolls horizontally over a min-width ` +
        `floor, which is the remedy the golden rule forbids. Fit by MERGING columns instead.`,
    );
    assert.doesNotMatch(
      code,
      /minWidth|min-w-\[/,
      `${REP_TABLE}: a minimum width is back on the desktop table. A floor is what forces the ` +
        `sideways scroll — the table must be free to be as narrow as its column.`,
    );
    assert.match(
      code,
      /table-fixed/,
      `${REP_TABLE}: the desktop table is no longer "table-fixed". Without it the browser sizes ` +
        `columns by content and one long name re-widens the whole table past its container.`,
    );
    assert.match(
      code,
      /<colgroup>/,
      `${REP_TABLE}: the <colgroup> is gone. AGENTS.md §4 asks for w-full table-fixed WITH a ` +
        `colgroup — table-fixed alone divides the width evenly and squeezes the name column.`,
    );

    // The table has to stay desktop-only, or the phone gets both the cards AND the table.
    const tableAt = code.indexOf("<table");
    assert.ok(tableAt > 0, `${REP_TABLE}: no <table> at all — the desktop view was dropped.`);
    assert.match(
      code.slice(Math.max(0, tableAt - 240), tableAt),
      /\bmd:block\b/,
      `${REP_TABLE}: the <table> is no longer inside a "hidden md:block" wrapper, so a phone renders ` +
        `it under the cards. The owner's rule is desktop tables, mobile cards — never both.`,
    );

    // A colgroup that does not match the header row silently mis-sizes every column after the
    // mismatch, which looks like a styling wobble rather than the structural bug it is.
    const cols = code.split("<col ").length - 1;
    const headers = code.split("<th ").length - 1;
    assert.equal(
      cols,
      headers,
      `${REP_TABLE}: ${cols} <col> against ${headers} <th>. Every column added or merged has to be ` +
        `made in both places, or table-fixed sizes the wrong columns.`,
    );

    const td = code.match(/const TD = "([^"]*)"/);
    assert.ok(td, `${REP_TABLE}: the shared TD class string was not found.`);
    assert.ok(
      td[1].includes("break-words") && !td[1].includes("whitespace-nowrap"),
      `${REP_TABLE}: TD is "${td[1]}". Every desktop cell has to be able to break now that the ` +
        `table can no longer grow sideways to fit its content.`,
    );
  }

  // ── 8. the two controls stay ONE object ─────────────────────────────────
  // A ranking only means something once BOTH questions are answered — whose reps, and which
  // fortnight. Two floating bars invite reading the board having answered one of them.
  {
    const code = sources.get(CONTROLS) ?? "";
    for (const child of ["EarlyBirdsDistrictSwitcher", "EarlyBirdsPeriodSwitcher"]) {
      assert.match(
        code,
        new RegExp(`<${child}`),
        `${CONTROLS}: <${child}> is no longer rendered here. Scope and fortnight belong in one ` +
          `hairline-divided card; splitting them is what this file exists to prevent.`,
      );
    }
  }

  // ── 9. the heading tells the truth about WHICH fortnight ───────────
  // The picker is what makes a closed fortnight reachable, so a hard-coded "This fortnight" now
  // tells a manager reading August in September that August is the fortnight he is in. The
  // wording lives in formatFortnightHeading, which tests/early-birds-period.test.ts pins; this
  // asserts the board actually CALLS it, because a correct formatter nothing calls fixes nothing.
  {
    const code = stripComments(readFileSync(BOARD, "utf8"));
    assert.match(
      code,
      /formatFortnightHeading\(/,
      BOARD + ": the fortnight heading no longer goes through formatFortnightHeading. Whatever " +
        "builds it must distinguish the live fortnight from a closed one.",
    );
    assert.doesNotMatch(
      code,
      /This fortnight/,
      BOARD + ": \"This fortnight\" is hard-coded here again. It is a claim about WHEN, and the " +
        "period picker can point this board at a fortnight that closed weeks ago.",
    );
  }
}
