import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The Mailbox Offboarding register's desktop table, pinned against the owner's FITS-THE-SCREEN
 * golden rule (AGENTS.md §4): never a horizontal scroll, always mobile AND desktop friendly, and
 * `overflow-x-auto` over a `min-width` floor IS the bug rather than the fix.
 *
 * It was exactly that: `<div className="mt-5 hidden overflow-x-auto md:block">` wrapping a
 * `<table className="w-full min-w-[1240px]">` whose nine columns were all `whitespace-nowrap`.
 * Measured on a verbatim-markup harness carrying the real longest production values — a 52-char
 * employee name, a 39-char work_email, "Forwarding to someone else → manager@satopharma.com", and
 * a "126 days since last day" overdue chip — inside the real shell chain:
 *
 *     1280px viewport   table 1840px in a  909px wrapper   (+931px)
 *     1024px viewport   table 1840px in a  669px wrapper  (+1171px)
 *      768px viewport   table 1840px in a  721px wrapper  (+1119px)
 *
 * and `document.documentElement.scrollWidth > clientWidth` read FALSE at every one of them,
 * because the scrolling wrapper absorbed the overflow. That is the blindness the golden rule warns
 * about, and it is why this test pins the SOURCE rather than trusting a page-level measurement.
 *
 * The fix merged nine columns into four — job title, mailbox and last day into the person cell,
 * the three steps into one self-labelling column, the two corrections under the state chips — and
 * let long values wrap. Nothing was shrunk and nothing was truncated.
 *
 * THE WIDTH THAT MATTERS IS 669px, NOT 1280. The shell's sidebar is `hidden lg:flex` at 292px, so
 * the content box NARROWS as the viewport crosses 1024px: 991px at 1023, 669px at 1024. At 669px
 * the four columns give step 3's `<select>` 217px against a 192px natural width — a native
 * `<select>` is the one control the golden rule says may not be shrunk, and a fifth column would
 * take it below that. Merge into an existing column instead.
 */

const WORKSPACE = "src/components/mailbox-offboarding/mailbox-offboarding-workspace.tsx";

export function runMailboxOffboardingTableFitsTheScreenTests() {
  const source = readFileSync(WORKSPACE, "utf8");

  // Every class this file actually applies. Scoped deliberately: the header comment above the
  // component NAMES `overflow-x-auto` and `min-width` while explaining why they are gone, and a
  // plain substring search over the source reads that prose as the defect — this test failed that
  // way on its first run.
  const classValues = [
    ...[...source.matchAll(/className="([^"]*)"/g)].map((m) => m[1]),
    ...[...source.matchAll(/className=\{`([^`]*)`\}/g)].map((m) => m[1]),
  ];
  const classTokens = new Set(classValues.flatMap((value) => value.split(/\s+/)).filter(Boolean));

  // 1. The desktop wrapper must not scroll horizontally, anywhere in this file.
  assert.ok(
    !classTokens.has("overflow-x-auto"),
    `${WORKSPACE}: "overflow-x-auto" is back. The golden rule names that class over a min-width ` +
      `floor as the bug itself — the table measured 1840px inside a 669px wrapper while the ` +
      `page-level overflow check still read clean. Fit by MERGING columns instead.`,
  );

  // 2. ...and nothing may set a min-width floor, in the table or in either in-cell editor. The
  //    two draft editors carried `min-w-[210px]`, which is what pushed the step columns wide.
  const minWidths = [...classTokens].filter((token) => token.startsWith("min-w-[")).sort();
  assert.deepEqual(
    minWidths,
    [],
    `${WORKSPACE}: found min-width floors ${JSON.stringify(minWidths)}. A fixed floor inside a ` +
      `table-fixed cell is how the horizontal scroll came back last time; use "w-full min-w-0" so ` +
      `the editor takes the column it is given.`,
  );

  // 3. The table itself is fixed-layout with an explicit colgroup.
  const table = source.match(/<table className="([^"]*)"/);
  assert.ok(table, `${WORKSPACE}: could not find the desktop <table> — has it been restructured?`);
  assert.ok(
    table[1].split(/\s+/).includes("table-fixed"),
    `${WORKSPACE}: the table is "${table[1]}" — it is missing "table-fixed". Without it the ` +
      `columns size to their content and the widest row decides the table's width again.`,
  );

  // 4. The colgroup's percentages must total 100%, and there must be one <col> per header cell.
  //    The opening tag must be followed by <col> entries and nothing else. A bare
  //    /<colgroup>[\s\S]*?<\/colgroup>/ matches from the BACKTICKED `<colgroup>` in this file's own
  //    header comment all the way down to the real closing tag — 46KB of component, read as if it
  //    were the column definition.
  const colgroup = source.match(
    /<colgroup>\s*((?:<col className="[^"]*" \/>\s*)+)<\/colgroup>/,
  );
  assert.ok(
    colgroup,
    `${WORKSPACE}: the desktop table has no <colgroup> of plain <col className="w-[N%]" /> entries. ` +
      `Without it "table-fixed" divides the width evenly and the person column loses the room it ` +
      `needs.`,
  );
  const widths = [...colgroup[1].matchAll(/w-\[(\d+(?:\.\d+)?)%\]/g)].map((m) => Number(m[1]));
  assert.equal(
    widths.length,
    4,
    `${WORKSPACE}: the colgroup declares ${widths.length} percentage columns, expected 4. A fifth ` +
      `column takes step 3's <select> below its 192px natural width at a 1024px viewport, where ` +
      `the content box is only 669px. Merge into an existing column rather than adding one.`,
  );
  const total = widths.reduce((sum, w) => sum + w, 0);
  assert.equal(
    total,
    100,
    `${WORKSPACE}: the colgroup widths ${JSON.stringify(widths)} total ${total}%, not 100%. Over ` +
      `100% the table overflows its wrapper; under it, the last column is short of what it needs.`,
  );

  // The header row is one literal <th> for the select-all checkbox plus a mapped array of the
  // rest, so count the array's entries rather than the <th> tokens — there are only two of those.
  const headings = source.match(/\{\[((?:"[^"]*"(?:,\s*)?)+)\]\.map\(\(heading\) => \(/);
  assert.ok(headings, `${WORKSPACE}: could not find the mapped column headings.`);
  const headingCount = [...headings[1].matchAll(/"[^"]*"/g)].length;
  assert.equal(
    headingCount + 1,
    widths.length,
    `${WORKSPACE}: ${headingCount} mapped headings plus the checkbox column is ` +
      `${headingCount + 1} cells, against ${widths.length} <col> entries. They must agree, or ` +
      `every column after the mismatch is sized by the wrong <col>.`,
  );

  // 5. The person cell's three lines must be able to wrap. Re-adding `whitespace-nowrap` to them
  //    is precisely the change that reproduced the defect: +165px past the cell on the harness.
  //    Anchor on each paragraph's OWN opening tag. A span running between the two values passes
  //    while either one is nowrap, because the other still carries "break-words" — that is how the
  //    first version of this test reported green on the exact defect it exists to catch.
  for (const [what, value] of [["name", "employeeName"], ["mailbox", "workEmail"]] as const) {
    const line = source.match(
      new RegExp(`<p className="([^"]*)">\\s*\\{task\\.${value}\\}\\s*</p>`),
    );
    assert.ok(
      line,
      `${WORKSPACE}: could not find the person cell's ${what} paragraph ({task.${value}}) — has ` +
        `the row been restructured?`,
    );
    assert.ok(
      !line[1].split(/\s+/).includes("whitespace-nowrap"),
      `${WORKSPACE}: the ${what} line is "${line[1]}" — "whitespace-nowrap" is back. The longest ` +
        `employee name is 52 characters and the longest work_email 39; nowrap put them 165px past ` +
        `their own cell at a 1024px viewport. Wrapping is the permitted answer here, and the ` +
        `ellipsis ban is untouched.`,
    );
    assert.ok(
      line[1].split(/\s+/).includes("break-words"),
      `${WORKSPACE}: the ${what} line is "${line[1]}" — it lost "break-words". A work_email is one ` +
        `unbreakable token, so ordinary wrapping cannot split it and it runs out of the column on ` +
        `its own.`,
    );
  }

  // 6. The status chips wrap too. "126 days since last day" is 23 characters of 10px uppercase
  //    with letter-spacing — nowrap, it does not fit the state column at any desktop width.
  const chipBlock = source.slice(
    source.indexOf("function StatusChip"),
    source.indexOf("type DraftKind"),
  );
  assert.ok(
    chipBlock.length > 0 && !chipBlock.includes("whitespace-nowrap"),
    `${WORKSPACE}: StatusChip/OverdueFlag are "whitespace-nowrap" again. The overdue chip's own ` +
      `text is wider than the state column, so nowrap overflows the cell rather than the table — ` +
      `which no wrapper-level measurement will show you.`,
  );

  // 7. The "leavers with a mailbox and no record" list is the same defect in a second place: it
  //    nowrapped "<name> — <email>" (95 characters) inside a flex row. Unlike the table, that one
  //    reached the document — the page itself scrolled sideways by 297px at 375px.
  const awaiting = source.match(/\{leaver\.employeeName\} — \{leaver\.workEmail\}/);
  assert.ok(awaiting, `${WORKSPACE}: could not find the awaiting-list row.`);
  const awaitingSpan = source.match(
    /<span className="([^"]*)">\s*\{leaver\.employeeName\} — \{leaver\.workEmail\}/,
  );
  assert.ok(awaitingSpan, `${WORKSPACE}: the awaiting-list row is no longer a <span> with classes.`);
  assert.ok(
    !awaitingSpan[1].includes("whitespace-nowrap"),
    `${WORKSPACE}: the awaiting-list row is "${awaitingSpan[1]}" — "whitespace-nowrap" is back. ` +
      `At 375px that pushed the page's own scrollWidth to 672px against a 375px viewport.`,
  );
  assert.ok(
    awaitingSpan[1].split(/\s+/).includes("min-w-0"),
    `${WORKSPACE}: the awaiting-list row is "${awaitingSpan[1]}" — it needs "min-w-0" to shrink ` +
      `below its content inside the flex row that holds it.`,
  );

  // 8. The ellipsis ban, which wrapping does not weaken (AGENTS.md §4).
  for (const banned of ["text-ellipsis", "truncate"]) {
    assert.ok(
      !classTokens.has(banned),
      `${WORKSPACE}: "${banned}" is present. Text on this screen is never cut — the owner's rule ` +
        `is that nothing is truncated with an ellipsis. Let it wrap.`,
    );
  }
}
