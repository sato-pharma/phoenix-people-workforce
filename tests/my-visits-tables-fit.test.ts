import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripComments } from "./support/comment-strip.ts";

/**
 * My Visits must FIT the screen, and its tab strip must never scroll.
 *
 * ## The defect this pins
 *
 * The Medical Rep portal's My Visits page (/employee-portals/visits) rendered its four desktop
 * tables — My visits, Double visits, Check-ins and a manager's Team visits — through
 * PortalDesktopTable, whose wrapper is `overflow-x-auto` over a 720–1040px `min-width`. That is the
 * exact shape the owner's fits-the-screen golden rule names as THE BUG (AGENTS.md §4: "overflow-x-auto
 * over a min-width IS the bug"). Measured on the 2026-09-25 audit: 286px of sideways scroll at 768px,
 * 386px at 1024px with the sidebar open, ~130–145px at 1280px.
 *
 * The tab strip failed the same rule on a phone: three `flex-1 whitespace-nowrap` uppercase
 * "LABEL (n)" buttons needed about 400px and got 285–355px, so the Check-ins tab sat off the right
 * edge behind a hidden scrollbar, with nothing to show it was there.
 *
 * ## The fix, and what is asserted
 *
 * Each table is `w-full table-fixed` over a percentage `<colgroup>`, fitted by MERGING columns (the
 * day carries its AM/PM and the time chip; the contact carries the visit type), with every cell able
 * to wrap. The tabs are an equal grid with the label stacked over its count, in sentence case.
 *
 * Pinned by SHAPE, on comment-stripped source (the file explains the banned utilities in prose, and a
 * pin that matched its own explanation would pin the anti-pattern — see early-birds-board-wraps).
 *
 * The owner's "Do NOT change" items for this page ride along: the UTC date-only pin, no Customer
 * column, and the manager-only Team tab (the last is pinned in crm-visits-self-scope.test.ts).
 */

const FILE = "src/components/employee-portal/my-visits-workspace.tsx";

/** Every `<table …>…</table>` block in the source, in order. */
function tableBlocks(code: string): string[] {
  const blocks: string[] = [];
  let from = code.indexOf("<table");
  while (from >= 0) {
    const end = code.indexOf("</table>", from);
    assert.ok(end > from, `${FILE}: a <table> is never closed — the source could not be read as tables.`);
    blocks.push(code.slice(from, end));
    from = code.indexOf("<table", end);
  }
  return blocks;
}

/** The value of a top-level `const NAME = "…";` class string. */
function constString(code: string, name: string): string {
  const match = code.match(new RegExp(`const ${name} = "([^"]*)"`));
  assert.ok(match, `${FILE}: the shared ${name} class string was not found.`);
  return match[1];
}

export function runMyVisitsTablesFitTests() {
  const raw = readFileSync(FILE, "utf8");
  const code = stripComments(raw);

  // ── 0. the floor: the strip must leave the markup this test reads ─────────
  assert.ok(code.includes("<table"), `${FILE}: no <table> after stripping comments — the desktop view was dropped, or the stripper ate it.`);

  // ── 1. no floor, no scroll box, no ellipsis ──────────────────────────────
  assert.doesNotMatch(
    code,
    /PortalDesktopTable/,
    `${FILE}: PortalDesktopTable is back. Its wrapper scrolls sideways over a min-width floor, which is ` +
      `the remedy the golden rule forbids. Fit by MERGING columns instead.`,
  );
  assert.doesNotMatch(
    code,
    /minWidth|min-w-\[|max-w-\[/,
    `${FILE}: a width floor or a fixed cap is back on a table cell. A floor is what forces the sideways ` +
      `scroll; a cap on a cell of a table-fixed table only fights the colgroup.`,
  );
  assert.doesNotMatch(
    code,
    /\boverflow-(?:x-)?(?:auto|scroll)\b/,
    `${FILE}: a class that permits a sideways scroll is back. Nothing on this page may scroll sideways.`,
  );
  assert.doesNotMatch(
    code,
    /\bwhitespace-nowrap\b/,
    `${FILE}: whitespace-nowrap is back. Every name, comment and tab label here has to be able to wrap — ` +
      `on the tab strip it is exactly what pushed the Check-ins tab off a phone's edge.`,
  );
  assert.doesNotMatch(
    code,
    /\b(?:truncate|line-clamp-\d|text-ellipsis)\b/,
    `${FILE}: an ellipsis utility is back. Where no-ellipsis and no-scroll collide, wrapping wins.`,
  );

  // ── 2. every desktop table is fixed, desktop-only, and has a colgroup that matches it ───────
  const table = constString(code, "TABLE");
  for (const required of ["w-full", "table-fixed", "hidden", "md:table"]) {
    assert.ok(
      table.split(/\s+/).includes(required),
      `${FILE}: the shared TABLE class is "${table}" and has lost "${required}". ` +
        (required === "table-fixed"
          ? "Without it the browser sizes columns by content and one long comment re-widens the table."
          : required === "md:table" || required === "hidden"
            ? "The table must stay desktop-only — below md a phone gets the cards, never both."
            : "The table must take its container's width, no more."),
    );
  }
  const td = constString(code, "TD");
  assert.ok(
    td.includes("break-words") && !td.includes("whitespace-nowrap"),
    `${FILE}: TD is "${td}". Every desktop cell has to be able to break now that the table can no ` +
      `longer grow sideways to fit its content.`,
  );

  // The four visit tables share the TABLE class. A fifth, "Days not in the field" (#4409: leave,
  // holidays, meetings and training listed apart from the field visits), is its own fitted table with
  // conditional column widths; it is held to the same shape by the checks after this loop.
  const allBlocks = tableBlocks(code);
  const blocks = allBlocks.filter((block) => /className=\{TABLE\}/.test(block.slice(0, block.indexOf(">"))));
  assert.equal(
    blocks.length,
    4,
    `${FILE}: ${blocks.length} <table className={TABLE}> block(s); expected four — My visits, Double visits, ` +
      `Check-ins and a manager's Team visits. A table that was dropped lost its desktop view.`,
  );
  const otherBlocks = allBlocks.filter((block) => !blocks.includes(block));
  assert.equal(
    otherBlocks.length,
    1,
    `${FILE}: ${otherBlocks.length} table(s) outside the shared TABLE class; expected one, the "Days not in ` +
      `the field" group. A new table must be fitted and pinned here, not slip past this test.`,
  );
  for (const block of otherBlocks) {
    const opening = block.slice(0, block.indexOf(">"));
    assert.match(opening, /className="w-full table-fixed\b/, `${FILE}: the Days-not-in-the-field table must be w-full table-fixed.`);
    assert.match(opening, /data-portal-desktop-table/, `${FILE}: the Days-not-in-the-field table lost data-portal-desktop-table.`);
    assert.match(block, /<colgroup>/, `${FILE}: the Days-not-in-the-field table has no <colgroup>.`);
    assert.doesNotMatch(block, /whitespace-nowrap|overflow-x-auto|min-w-\[/, `${FILE}: the Days-not-in-the-field table can no longer wrap.`);
    // Its widths are chosen by `showRep`; both sets must fill the table exactly.
    const pairs = [...block.matchAll(/width: showRep \? "(\d+)%" : "(\d+)%"/g)].map((m) => [Number(m[1]), Number(m[2])]);
    const repOnly = [...block.matchAll(/showRep \? <col style=\{\{ width: "(\d+)%" \}\} \/> : null/g)].map((m) => Number(m[1]));
    assert.ok(pairs.length > 0, `${FILE}: the Days-not-in-the-field colgroup no longer reads as showRep-conditional widths.`);
    const withRep = repOnly.reduce((t, w) => t + w, 0) + pairs.reduce((t, [w]) => t + w, 0);
    const withoutRep = pairs.reduce((t, [, w]) => t + w, 0);
    assert.equal(withRep, 100, `${FILE}: the Days-not-in-the-field colgroup totals ${withRep}% with the Rep column, not 100%.`);
    assert.equal(withoutRep, 100, `${FILE}: the Days-not-in-the-field colgroup totals ${withoutRep}% without the Rep column, not 100%.`);
  }
  blocks.forEach((block, index) => {
    const opening = block.slice(0, block.indexOf(">"));
    assert.match(opening, /className=\{TABLE\}/, `${FILE}: table ${index + 1} does not use the shared TABLE class.`);
    assert.match(
      opening,
      /data-portal-desktop-table/,
      `${FILE}: table ${index + 1} lost data-portal-desktop-table, the portal shell's own below-768px gate.`,
    );
    assert.match(block, /<colgroup>/, `${FILE}: table ${index + 1} has no <colgroup> — table-fixed alone divides the width evenly.`);

    const widths = [...block.matchAll(/<col style=\{\{ width: "(\d+(?:\.\d+)?)%" \}\} \/>/g)].map((m) => Number(m[1]));
    const cols = block.split("<col ").length - 1;
    const heads = block.split("<th ").length - 1;
    assert.equal(widths.length, cols, `${FILE}: table ${index + 1} has a <col> without a percentage width.`);
    assert.equal(
      cols,
      heads,
      `${FILE}: table ${index + 1} has ${cols} <col> against ${heads} <th>. Every column added or merged ` +
        `has to be made in both places, or table-fixed sizes the wrong columns.`,
    );
    const total = widths.reduce((sum, width) => sum + width, 0);
    assert.ok(Math.abs(total - 100) < 1e-9, `${FILE}: table ${index + 1}'s colgroup totals ${total}%, not 100%.`);
  });

  // ── 3. the tab strip is a grid, label over count, sentence case ─────────────
  assert.match(
    code,
    /<PortalSegmentedTabs className=\{[^}]*"grid grid-cols-3"/,
    `${FILE}: the tab strip is no longer an equal grid. A row of nowrap tabs is what ran the Check-ins ` +
      `tab off a 360px phone.`,
  );
  assert.match(code, /<span className="block[^"]*">\{item\.label\}<\/span>/, `${FILE}: the tab label must sit on its own line.`);
  assert.doesNotMatch(
    code,
    /\{item\.label\} \(\{count\}\)/,
    `${FILE}: the count is back in brackets beside the label, which is the width the phone did not have.`,
  );
  for (const label of ["My visits", "Double visits", "Check-ins", "Team visits"]) {
    assert.ok(code.includes(`label: "${label}"`), `${FILE}: the tab "${label}" must be in sentence case.`);
  }

  // ── 4. the owner's "do not change" items on this page ─────────────────────
  assert.doesNotMatch(
    code,
    /<th[^>]*>\s*Customer\s*<\/th>/,
    `${FILE}: a Customer column is back. The vendor's customerName is empty on every visit ever synced.`,
  );
  assert.match(code, /utcDate\(/, `${FILE}: the date-only values must keep going through utcDate — the UTC pin is what stops a calendar day shifting.`);
  assert.match(code, /timeZone: "UTC"/, `${FILE}: the vendor-local time must keep its UTC (no shift) formatter.`);
}
