import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The device register's desktop table, pinned against the owner's FITS-THE-SCREEN golden rule
 * (AGENTS.md §4): never a horizontal scroll, always mobile AND desktop friendly, and
 * `overflow-x-auto` over a `min-width` floor IS the bug rather than the fix.
 *
 * IT IS PINNED AT BIRTH, not after a defect. The Mailbox Revocation register shipped with nine
 * `whitespace-nowrap` columns under a scrolling wrapper and measured 1840px inside a 909px box
 * while `document.documentElement.scrollWidth > clientWidth` read FALSE at every viewport — the
 * scrolling wrapper absorbed the overflow, so the page certified itself while content hung off the
 * side. This table is the same shape of object, built from the same four-column design, and this
 * file exists so it cannot drift back into that.
 *
 * THE WIDTH THAT MATTERS IS 669px, NOT 1280. The shell's sidebar is `hidden lg:flex` at 292px, so
 * the content box NARROWS as the viewport crosses 1024px: 991px at 1023, 669px at 1024. The action
 * column takes the largest share (34% → ~227px at 669px) because it is the one holding a native
 * `<select>` — the employee picker — and a native `<select>` is the single control the golden rule
 * says may NOT be shrunk. A fifth column takes it below its ~192px natural width; merge into an
 * existing column instead, which is how this table got to four in the first place.
 */

const WORKSPACE = "src/components/devices/device-register-workspace.tsx";

export function runDeviceRegisterFitsTheScreenTests() {
  const source = readFileSync(WORKSPACE, "utf8");

  // Every class this file actually APPLIES. Scoped deliberately: the header comment above the
  // component names `overflow-x-auto` and `min-width` while explaining why they are gone, and a
  // plain substring search over the source reads that prose as the defect.
  const classValues = [
    ...[...source.matchAll(/className="([^"]*)"/g)].map((m) => m[1]),
    ...[...source.matchAll(/className=\{`([^`]*)`\}/g)].map((m) => m[1]),
  ];
  const classTokens = new Set(classValues.flatMap((value) => value.split(/\s+/)).filter(Boolean));

  // 1. Nothing in this file may scroll sideways.
  assert.ok(
    !classTokens.has("overflow-x-auto"),
    `${WORKSPACE}: "overflow-x-auto" is present. The golden rule names that class over a ` +
      `min-width floor as the bug itself — a scrolling wrapper absorbs the overflow, so the ` +
      `page-level check reads clean while the table hangs off the side. Fit by MERGING columns.`,
  );

  // 2. ...and nothing may set a min-width floor. `min-w-0` is the opposite thing and is required in
  //    several places; only a bracketed floor is the defect.
  const minWidths = [...classTokens].filter((token) => token.startsWith("min-w-[")).sort();
  assert.deepEqual(
    minWidths,
    [],
    `${WORKSPACE}: found min-width floors ${JSON.stringify(minWidths)}. A fixed floor inside a ` +
      `table-fixed cell is exactly how the horizontal scroll came back on the sibling register; ` +
      `use "w-full min-w-0" so an editor takes the column it is given.`,
  );

  // 3. The table is fixed-layout with an explicit colgroup.
  const table = source.match(/<table className="([^"]*)"/);
  assert.ok(table, `${WORKSPACE}: could not find the desktop <table> — has it been restructured?`);
  assert.ok(
    table[1].split(/\s+/).includes("table-fixed"),
    `${WORKSPACE}: the table is "${table[1]}" — it is missing "table-fixed". Without it the ` +
      `columns size to their content and the widest row decides the table's width again.`,
  );

  // 4. Four columns, totalling exactly 100%. The opening tag must be followed by <col> entries and
  //    nothing else — a lazy /<colgroup>[\s\S]*?<\/colgroup>/ would match from a backticked
  //    `<colgroup>` in a comment all the way to the real closing tag.
  const colgroup = source.match(/<colgroup>\s*((?:<col className="[^"]*" \/>\s*)+)<\/colgroup>/);
  assert.ok(
    colgroup,
    `${WORKSPACE}: the desktop table has no <colgroup> of plain <col className="w-[N%]" /> ` +
      `entries. Without it "table-fixed" divides the width evenly and the device column loses the ` +
      `room its asset tag, serial and value need.`,
  );
  const widths = [...colgroup[1].matchAll(/w-\[(\d+(?:\.\d+)?)%\]/g)].map((m) => Number(m[1]));
  assert.equal(
    widths.length,
    4,
    `${WORKSPACE}: the colgroup declares ${widths.length} percentage columns, expected 4. A fifth ` +
      `column takes the employee <select> below its ~192px natural width at a 1024px viewport, ` +
      `where the content box is only 669px. Merge into an existing column rather than adding one.`,
  );
  assert.equal(
    widths.reduce((sum, width) => sum + width, 0),
    100,
    `${WORKSPACE}: the colgroup widths ${JSON.stringify(widths)} do not total 100%. Over 100% the ` +
      `table overflows its wrapper; under it, the last column is short of what it needs.`,
  );

  // 5. The action column must stay the WIDEST, because it is the one holding the <select>.
  assert.equal(
    Math.max(...widths),
    widths[widths.length - 1],
    `${WORKSPACE}: the last column (${widths[widths.length - 1]}%) is no longer the widest of ` +
      `${JSON.stringify(widths)}. It carries the employee picker, and a native <select> is the one ` +
      `control the golden rule says cannot be fixed by narrowing it.`,
  );

  // 6. One <col> per heading. They must agree, or every column after the mismatch is sized by the
  //    wrong <col>.
  const headings = source.match(/\{\[((?:"[^"]*"(?:,\s*)?)+)\]\.map\(\(heading\) => \(/);
  assert.ok(headings, `${WORKSPACE}: could not find the mapped column headings.`);
  const headingCount = [...headings[1].matchAll(/"[^"]*"/g)].length;
  assert.equal(
    headingCount,
    widths.length,
    `${WORKSPACE}: ${headingCount} headings against ${widths.length} <col> entries.`,
  );

  // 7. The long free-text lines must be able to WRAP, and must be able to break mid-token. An asset
  //    tag, a serial and an IMEI are each ONE unbreakable run that ordinary wrapping cannot split,
  //    so they run out of the column on their own without `break-words`.
  //
  //    Anchored on each paragraph's OWN opening tag. A span running between two values passes while
  //    either one is nowrap, because the other still carries the class — that is how the sibling
  //    register's first version of this test reported green on the exact defect it existed to catch.
  for (const [what, expression] of [
    ["asset tag", "device.assetTag"],
    ["holder name", "device.holderName"],
  ] as const) {
    const line = source.match(
      new RegExp(`<p className="([^"]*)">\\s*\\{${expression.replace(".", "\\.")}\\}\\s*</p>`),
    );
    assert.ok(line, `${WORKSPACE}: could not find the ${what} paragraph ({${expression}}).`);
    assert.ok(
      !line[1].split(/\s+/).includes("whitespace-nowrap"),
      `${WORKSPACE}: the ${what} line is "${line[1]}" — "whitespace-nowrap" is back. Wrapping is ` +
        `the permitted answer here, and the ellipsis ban is untouched.`,
    );
    assert.ok(
      line[1].split(/\s+/).includes("break-words"),
      `${WORKSPACE}: the ${what} line is "${line[1]}" — it lost "break-words".`,
    );
  }

  // 8. The state chips wrap. "Holder not in the directory" is wider than the 14% state column at
  //    every desktop width; nowrap overflows the CELL rather than the table, which no
  //    wrapper-level measurement will show you.
  const chipBlock = source.slice(source.indexOf("function StatusChip"), source.indexOf("function Field"));
  assert.ok(chipBlock.length > 0, `${WORKSPACE}: could not find the chip components.`);
  assert.ok(
    !chipBlock.includes("whitespace-nowrap"),
    `${WORKSPACE}: StatusChip/LeaverFlag are "whitespace-nowrap" again. The leaver flag's own text ` +
      `is wider than the state column, so nowrap overflows the cell rather than the table.`,
  );

  // 9. The leaver block above the table is the same defect in a second place — it is the one the
  //    page LEADS with, it holds the longest strings on the screen (a name, a job title, an asset
  //    tag and a serial on one line), and unlike the table it sits in the document flow, so its
  //    overflow reaches the page's own scrollWidth at 375px.
  const leaverLine = source.match(
    /<li\s+key=\{device\.assignmentId\}\s+className="([^"]*)"\s*>/,
  );
  assert.ok(leaverLine, `${WORKSPACE}: could not find the leaver block's per-device row.`);
  assert.ok(
    !leaverLine[1].split(/\s+/).includes("whitespace-nowrap"),
    `${WORKSPACE}: the leaver device row is "${leaverLine[1]}" — nowrap there pushes the PAGE ` +
      `sideways at 375px, not merely a cell.`,
  );
  assert.ok(
    leaverLine[1].split(/\s+/).includes("break-words"),
    `${WORKSPACE}: the leaver device row is "${leaverLine[1]}" — it needs "break-words". It prints ` +
      `an asset tag and a serial, which are unbreakable tokens.`,
  );

  // 10. Mobile never gets the table, and desktop never gets only cards. The owner's standing rule.
  assert.ok(
    classTokens.has("md:hidden"),
    `${WORKSPACE}: the mobile card list is gone. Desktop shows full tables, mobile never does.`,
  );
  assert.ok(
    /className="mt-5 hidden md:block"/.test(source),
    `${WORKSPACE}: the desktop table is no longer hidden below md.`,
  );

  // 11. THE RESIGNATIONS BANNER is this feature's second surface, on somebody else's page.
  //
  //     It prints the longest string either page produces — a name, then every held device as
  //     "<asset tag> (<serial>)", joined. Those are unbreakable tokens, and unlike the table this
  //     block sits in the document flow, so its overflow reaches the PAGE's own scrollWidth rather
  //     than a scrolling wrapper. That is the shape that pushed a 375px viewport to 672px on the
  //     mailbox register.
  //
  //     Checked here rather than in a resignations test because the block, the risk and the reason
  //     are all this feature's.
  const resignations = readFileSync("src/components/resignations/resignations-workspace.tsx", "utf8");
  const leaverRow = resignations.match(
    /<li\s*\n\s*className="([^"]*)"\s*\n\s*key=\{record\.employeeHrId\}/,
  );
  assert.ok(
    leaverRow,
    "src/components/resignations/resignations-workspace.tsx: could not find the outstanding-devices row.",
  );
  assert.ok(
    !leaverRow[1].split(/\s+/).includes("whitespace-nowrap"),
    `the resignations device row is "${leaverRow[1]}" — nowrap there pushes the PAGE sideways.`,
  );
  for (const needed of ["break-words", "min-w-0"]) {
    assert.ok(
      leaverRow[1].split(/\s+/).includes(needed),
      `the resignations device row is "${leaverRow[1]}" — it needs "${needed}". It prints asset ` +
        `tags and serials, which are single unbreakable tokens.`,
    );
  }
  assert.ok(
    !/\btruncate\b|\btext-ellipsis\b/.test(leaverRow[1]),
    "the ellipsis ban reaches this block too — nothing on it is cut.",
  );

  // 12. The ellipsis ban, which wrapping does not weaken (AGENTS.md §4).
  for (const banned of ["truncate", "text-ellipsis"]) {
    assert.ok(
      !classTokens.has(banned),
      `${WORKSPACE}: "${banned}" is present. Text on this screen is never cut — the owner's rule ` +
        `is that nothing is truncated with an ellipsis. Let it wrap.`,
    );
  }

  // 12. THE SQUARE-EDGE GOLDEN RULE (AGENTS.md §4, owner 2026-09-04): no round or semi-round
  //     corners anywhere. `tokens.css` still ships a 4px default and a `pill`, so a component
  //     copied from a sibling inherits a radius silently — and a 4px corner is invisible in a
  //     screenshot and survives review. Counted here rather than eyeballed.
  const rounded = [...classTokens].filter((token) => /(^|:)rounded(-|$)/.test(token)).sort();
  assert.deepEqual(
    rounded,
    [],
    `${WORKSPACE}: found rounded corners ${JSON.stringify(rounded)}. The owner's rule is square ` +
      `edges everywhere — cards, buttons, tags, inputs, bars, avatars and badges.`,
  );
}
