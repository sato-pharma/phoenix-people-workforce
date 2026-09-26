import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "./support/comment-strip.ts";

/**
 * The four desktop tables on /admin/activity-control, pinned against the owner's FITS-THE-SCREEN
 * golden rule (AGENTS.md §4): never a horizontal scroll, fit by MERGING columns and never by
 * shrinking the type, and wrapping wins over an ellipsis.
 *
 *   Role benchmarks          RoleBenchmarksTable
 *   Who's online now         OnlineTable        (its card list lives in OnlineCards)
 *   People — engagement      PeopleUsage
 *   Adoption                 AdoptionList
 *
 * Before 2026-09-26 all four were a bare `w-full text-sm` table inside an `overflow-auto` wrapper —
 * the exact shape the rule names as the bug — and the People table had NINE columns. It now has
 * five: the name carries the timeline control (an action column gone), session span + active + last
 * seen merged into "Time", logins + modules into "Usage". The role-benchmarks table lost a stray
 * `colSpan={2}` header and a second progress bar that was permanently invisible underneath it, by
 * merging the score and its bar into one column.
 *
 * WHAT THIS TEST DOES
 * It re-does the width arithmetic from the SOURCE: it reads each table's `<colgroup>` and header
 * cells, works out what each column is worth in pixels at the NARROWEST width that table is ever
 * drawn at, and requires it to hold the widest thing in it that cannot wrap. Re-splitting the
 * percentages, or adding a column back, fails here instead of on the owner's screen.
 *
 * THE NARROWEST STATES (admin shell: a 272px sidebar from 1024px up, 16px of page padding a side)
 *   full-width card   1024 - 272 - 32 = 720px. Role benchmarks shows from `md` and People from
 *                     `lg`; below 1024 there is no sidebar, so 768 - 32 = 736px is wider and 720
 *                     is the floor for both.
 *   half-width card   Who's online and Adoption sit in a `xl:grid-cols-2` grid, so they are 720px
 *                     wide until 1280 and then halve: (1280 - 272 - 32 - 20 gap) / 2 = 478px.
 *
 * WHAT THE "NEEDS" BELOW ARE, HONESTLY
 * They are DERIVED, not measured in a browser. Two anchors from the measurements recorded in
 * tests/sales-target-tables-fit-the-screen.test.ts, taken on real pages in the same typeface stack:
 * "ACHIEVEMENT" at 100.9px (11 characters of 10px black capitals with tracking, 9.17px a character)
 * and "13,087,666" at 72.3px (10 characters of 14px bold tabular, 7.23px a character). The two
 * shapes that bind here are costed from those at 7.7px and 9.6px a character, both rounded UP, so
 * every figure errs wide.
 *
 * So this test cannot prove the page fits — only a browser can, by measuring `scrollWidth >
 * clientWidth` over `main` at desktop and at 375px. It proves the arithmetic that has to hold
 * first, and it catches the edit that would break it.
 *
 * Pinned on comment-stripped source, so this prose can never satisfy it.
 */

const DASHBOARD = "src/components/admin/activity-control-dashboard.tsx";

/** A full-width admin card at a 1024px viewport — the narrowest either full-width table is drawn in. */
const FULL_WIDTH_TABLE_PX = 720;
/** A half-width card in the two-up grid at 1280px — the narrowest either half-width table is drawn in. */
const HALF_WIDTH_TABLE_PX = 478;

/** px per character for a 14px word, derived above. Deliberately generous. */
const CHAR_14PX = 7.7;
/** px per character for 11px bold capitals with `tracking-wide` — the engagement band chip. */
const CHAR_11PX_CAPS = 9.6;
/** px per character for 11px semibold mixed case — the Logout chip's label. */
const CHAR_11PX = 6.0;

/** Tailwind `px-2.5` both sides plus a 1px border each side: what an inline-flex chip costs empty. */
const CHIP_CHROME_PX = 20 + 2;

function word14(text: string): number {
  return Math.round(text.length * CHAR_14PX * 10) / 10;
}

function caps11(text: string): number {
  return Math.round(text.length * CHAR_11PX_CAPS * 10) / 10;
}

type Need = { px: number; what: string };

type TableSpec = {
  /** The component the desktop table lives in. */
  component: string;
  /** The component its mobile card list lives in — the same one, unless the table was split out. */
  mobileComponent: string;
  /** Human name for failure messages. */
  title: string;
  tablePx: number;
  /** The breakpoint its desktop wrapper and its mobile card list must agree on. */
  breakpoint: "md" | "lg";
  /** Header label → the widest thing in that column that cannot wrap. */
  needs: Record<string, Need>;
};

const TABLES: TableSpec[] = [
  {
    component: "function RoleBenchmarksTable",
    mobileComponent: "function RoleBenchmarksTable",
    title: "Role benchmarks",
    tablePx: FULL_WIDTH_TABLE_PX,
    breakpoint: "md",
    needs: {
      Role: { px: word14("Role"), what: 'the "Role" header' },
      People: { px: word14("People"), what: 'the "People" header' },
      "Avg session span": { px: word14("session"), what: 'the longest word of the "Avg session span" header' },
      "Avg active": { px: word14("active"), what: 'the longest word of the "Avg active" header' },
      "Avg engagement": { px: word14("engagement"), what: 'the longest word of the "Avg engagement" header' },
    },
  },
  {
    component: "function OnlineTable",
    mobileComponent: "function OnlineCards",
    title: "Who's online now",
    tablePx: HALF_WIDTH_TABLE_PX,
    breakpoint: "md",
    needs: {
      // The avatar is `h-7 w-7 shrink-0` with a `gap-2` beside it — 36px before a single letter of
      // the name, and none of it can wrap.
      User: { px: 28 + 8 + word14("User"), what: "the shrink-0 avatar, its gap, and the header beside it" },
      "Current module": { px: word14("Recruitment"), what: "the longest single word a module label can be" },
      // The Logout chip: a 12px icon, a 4px gap, "Logout", and the chip's own chrome.
      Session: {
        px: Math.round((12 + 4 + 6 * CHAR_11PX) * 10) / 10 + CHIP_CHROME_PX,
        what: "the Logout chip, an inline-flex box that cannot wrap",
      },
    },
  },
  {
    component: "function PeopleUsage",
    mobileComponent: "function PeopleUsage",
    title: "People — engagement & usage",
    tablePx: FULL_WIDTH_TABLE_PX,
    breakpoint: "lg",
    needs: {
      // The name is the timeline button: a 14px `shrink-0` eye icon and a 4px gap before the name.
      Employee: { px: 14 + 4 + word14("Employee"), what: "the timeline button's shrink-0 icon, its gap, and the header" },
      Time: { px: word14("session"), what: 'the unwrappable word "session" in the Time cell' },
      Usage: { px: word14("modules"), what: 'the word "modules" in the Usage cell' },
      "Top module": { px: word14("Recruitment"), what: "the longest single word a module label can be" },
      // The band chip wraps between its score and its band, but "MODERATE" itself cannot break.
      Engagement: { px: caps11("MODERATE") + CHIP_CHROME_PX, what: 'the "MODERATE" band chip, an inline-flex box' },
    },
  },
  {
    component: "function AdoptionList",
    mobileComponent: "function AdoptionList",
    title: "Adoption — who isn't using the system",
    tablePx: HALF_WIDTH_TABLE_PX,
    breakpoint: "md",
    needs: {
      Employee: { px: word14("Employee"), what: 'the "Employee" header' },
      Status: { px: word14("dormant"), what: 'the longest status word, "dormant"' },
      "Last seen": { px: word14("15/06/2026"), what: "the absolute date the relative label falls back to" },
    },
  },
];

function tokens(className: string): string[] {
  return className.split(/\s+/).filter(Boolean);
}

/**
 * The body of one top-level component, up to its closing brace in column 1.
 *
 * The brace has to be followed by a NEWLINE, not merely sit at the start of a line: a component
 * whose props are destructured over several lines closes that destructure with `}: {` and `}) {`
 * in column 1 first, and a plain `indexOf("\n}")` stops at the signature — which is how the first
 * run of this test read `PeopleUsage` as four lines long and reported its desktop gate missing.
 */
function componentBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `${DASHBOARD}: "${signature}" is gone. Re-point this test; do not drop it.`);
  const rest = source.slice(start);
  const end = /\n\}(?=\n|$)/.exec(rest);
  assert.ok(end, `${DASHBOARD}: could not find the end of "${signature}".`);
  return rest.slice(0, end.index + 2);
}

function horizontalPaddingPx(className: string): number {
  const px = tokens(className).find((token) => /^px-\d+(?:\.\d+)?$/.test(token));
  return px ? Number(px.slice(3)) * 4 * 2 : 0;
}

type Column = { label: string; percent: number; paddingPx: number };

function columnsOf(block: string, title: string): Column[] {
  const colgroup = block.match(/<colgroup>\s*((?:<col className="w-\[\d+(?:\.\d+)?%\]" \/>\s*)+)<\/colgroup>/);
  assert.ok(
    colgroup,
    `${title}: the desktop table has no <colgroup> of percentage <col> entries. Without one, "table-fixed" ` +
      `splits the width evenly and the column holding an unwrappable chip loses its room.`,
  );
  const percents = [...colgroup[1].matchAll(/w-\[(\d+(?:\.\d+)?)%\]/g)].map((match) => Number(match[1]));

  const head = block.match(/<thead[^>]*>([\s\S]*?)<\/thead>/);
  assert.ok(head, `${title}: the desktop table has no <thead>.`);
  const cells = [...head[1].matchAll(/<th className="([^"]*)"\s*(?:\/>|>([\s\S]*?)<\/th>)/g)].map((match) => ({
    className: match[1],
    label: (match[2] ?? "").trim(),
  }));

  assert.equal(
    cells.length,
    percents.length,
    `${title}: ${cells.length} header cells against ${percents.length} <col> entries. They must agree, or every ` +
      `column after the mismatch is sized by the wrong <col>.`,
  );

  const total = Math.round(percents.reduce((sum, value) => sum + value, 0) * 10) / 10;
  assert.equal(
    total,
    100,
    `${title}: the <colgroup> percentages add up to ${total}, not 100. A short total leaves a column unsized; ` +
      `an over-total is how a table-fixed table starts overflowing again.`,
  );

  return cells.map((cell, index) => ({
    label: cell.label,
    paddingPx: horizontalPaddingPx(cell.className),
    percent: percents[index],
  }));
}

export function runActivityControlTablesFitTheScreenTests() {
  const source = stripComments(readFileSync(DASHBOARD, "utf8"));

  // Nothing anywhere in this file may buy a sideways scroll or cut text — the two classes of defect
  // the whole pass exists to retire. Checked over the WHOLE file rather than per table, because the
  // two heatmaps and the timeline drawer sit outside any table and carried the same constructs.
  // Matched as bare tokens rather than inside `className="…"`, so a class built in a template
  // literal is caught too.
  for (const banned of [
    "overflow-x-auto",
    "overflow-x-scroll",
    "overflow-auto",
    "overflow-scroll",
    "truncate",
    "text-ellipsis",
  ]) {
    assert.doesNotMatch(
      source,
      new RegExp(`\\b${banned}\\b`),
      `${DASHBOARD}: "${banned}" is back. The golden rule names a sideways scroll as the bug, and text is never ` +
        `cut with an ellipsis — buy the width by merging columns, and let the text wrap.`,
    );
  }

  const floors = [...new Set([...source.matchAll(/\bmin-w-\[[^\]]*\]/g)].map((match) => match[0]))];
  assert.deepEqual(
    floors,
    [],
    `${DASHBOARD}: min-width floors ${JSON.stringify(floors)}. A floor under a table-fixed table is exactly how ` +
      `the page starts scrolling sideways again.`,
  );

  for (const spec of TABLES) {
    const body = componentBody(source, spec.component);
    const mobileBody = componentBody(source, spec.mobileComponent);

    // 1. A phone never gets a table: every desktop table has a card list at the same breakpoint, or
    //    the rule is satisfied on a laptop and broken on a phone.
    assert.match(
      body,
      new RegExp(`<div className="hidden ${spec.breakpoint}:block"`),
      `${spec.title}: the desktop table must be hidden below ${spec.breakpoint} — a phone never gets a table.`,
    );
    assert.match(
      mobileBody,
      new RegExp(`<ul className="[^"]*\\b${spec.breakpoint}:hidden\\b`),
      `${spec.title}: no mobile card list in ${spec.mobileComponent}. Hiding the table below ${spec.breakpoint} ` +
        `without one leaves a phone with nothing at all.`,
    );

    const tableTag = body.match(/<table className="([^"]*)"/);
    assert.ok(tableTag, `${spec.title}: no <table> found in ${spec.component}.`);
    assert.ok(
      tokens(tableTag[1]).includes("table-fixed"),
      `${spec.title}: the desktop table lost "table-fixed", so its widest row decides its width again and the ` +
        `<colgroup> below it stops meaning anything.`,
    );

    // 2. A merged column never leaves a colSpan behind. Role benchmarks carried one over a column
    //    that no longer existed, which is what hid a dead second progress bar for months.
    assert.doesNotMatch(
      body,
      /colSpan=/,
      `${spec.title}: a colSpan is back in the header. Each header cell must own exactly one <col>, or the ` +
        `percentages stop describing the table.`,
    );

    // 3. HEADLINE — every column holds the widest thing in it that cannot wrap.
    const columns = columnsOf(body, spec.title);
    for (const [label, need] of Object.entries(spec.needs)) {
      const column = columns.find((candidate) => candidate.label === label);
      assert.ok(
        column,
        `${spec.title}: no "${label}" column. If it was renamed or merged, redo the arithmetic for the new ` +
          `shape in this test's needs; do not delete the check.`,
      );
      const available = Math.round(((column.percent / 100) * spec.tablePx - column.paddingPx) * 10) / 10;
      assert.ok(
        available >= need.px,
        `${spec.title}: the "${label}" column is ${column.percent}% of a ${spec.tablePx}px table = ` +
          `${((column.percent / 100) * spec.tablePx).toFixed(1)}px, and ${column.paddingPx}px of that is cell ` +
          `padding, leaving ${available}px — but ${need.what} needs ${need.px}px and cannot wrap. Merge a column ` +
          `to free the width; never shrink the type.`,
      );
    }
  }
}
