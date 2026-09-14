import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The Weekly Plan table clipped the value a dropdown was showing.
 *
 * Measured 2026-09-14 in the in-app browser on /employee-portals/plans as a Group Product Manager,
 * at a 1024px window: each field column was about 164px, and an <input> can only paint one line, so
 * "Marketing Double Visit" read as "Marketing Doubl" (136 of 171px) and a Marketing Double Visit
 * partner, "name · Product Manager", showed 136 of 361px — still clipped at 1280 and 1504. The
 * table's `px-3` also overrode the dropdown's `pr-9`, so the text ran under the magnifier.
 *
 * AGENTS.md §4: wrapping wins over clipping, and the table may never scroll sideways. So the fields
 * opt into `wrapValue`: while closed, the chosen value is painted as wrapping text in the same grid
 * cell as the input, and the cell grows to fit it. This reads source, like
 * tests/searchable-select-no-ellipsis.test.ts, because the defect is a class list and an attribute —
 * clipped text never enters the DOM, so a text assertion would pass with the value cut in half.
 */
export function runPlanTableValuesWrapTests() {
  const select = readFileSync("src/components/ui/searchable-select.tsx", "utf8");
  const code = select.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  // ---------------------------------------------------------------------------
  // Headline: in wrapValue mode the closed input paints NO text, and a sibling
  // paints the value on as many lines as it needs.
  // ---------------------------------------------------------------------------
  assert.ok(
    /value=\{open \? query : wrapValue \? "" : selectedLabel \|\| ""\}/.test(code),
    "a wrapValue field's input must hold an empty value while closed — an input's value is one line, which is the clip",
  );
  const valueBlock = code.match(/\{wrapValue \? \(\s*<button([\s\S]*?)<\/button>/);
  assert.ok(valueBlock, "the wrapping value element moved or is no longer rendered for wrapValue");
  const valueClasses = valueBlock[1].match(/"(pointer-events-none[^"]*)"/);
  assert.ok(valueClasses, "the wrapping value element's class list moved; re-check that it wraps");
  const classes = valueClasses[1].split(/\s+/);
  for (const needed of ["whitespace-normal", "break-words", "pointer-events-none", "pr-9", "h-auto"]) {
    assert.ok(classes.includes(needed), `the wrapping value needs \`${needed}\`; className was "${valueClasses[1]}"`);
  }
  assert.ok(!classes.includes("truncate") && !classes.includes("whitespace-nowrap"), "the wrapping value must never clip");
  assert.ok(/\{selectedLabel \|\| placeholder/.test(valueBlock[1]), "the wrapping value must show the chosen label");
  assert.ok(/disabled=\{disabled\}/.test(valueBlock[1]), "the value must carry `disabled`, or a locked row stops looking locked");

  // The cell grows with the value and never sideways: one fr column that may shrink to zero.
  assert.ok(
    /wrapValue \? "relative grid grid-cols-\[minmax\(0,1fr\)\]"/.test(code),
    "a wrapValue wrapper must be a single minmax(0,1fr) grid cell, or a long word widens the table",
  );
  // And the magnifier never sits over the text, whatever padding the caller passed.
  assert.ok(
    /cn\(fieldClassName, "col-start-1 row-start-1 h-auto self-stretch pr-9"/.test(code),
    "a wrapValue input must stretch to the cell and re-apply pr-9 after the caller's px-*",
  );
  assert.ok(/aria-describedby=\{describedBy\}/.test(code), "the input must still announce the chosen value");

  // ---------------------------------------------------------------------------
  // Every dropdown in the Weekly activities table and the row edit sheet opts in.
  // ---------------------------------------------------------------------------
  const workspace = readFileSync("src/components/employee-portal/plans-workspace.tsx", "utf8");
  const tableSelects = [...workspace.matchAll(/<SearchableSelect\n\s*className=\{(tableSelectClass|mobileField)\}([\s\S]*?)\n\s*>/g)];
  assert.equal(tableSelects.length, 10, `expected the 5 table and 5 sheet dropdowns, found ${tableSelects.length}`);
  for (const match of tableSelects) {
    assert.ok(/\n\s*wrapValue$/.test(match[2]), `a ${match[1]} dropdown in the plan does not wrap its value:${match[2]}`);
  }
  const partner = workspace.match(/function MarketingPartnerSelect[\s\S]*?<SearchableSelect([\s\S]*?)\n\s*>/);
  assert.ok(partner && /\n\s*wrapValue$/.test(partner[1]), "the Marketing Double Visit partner dropdown must wrap — its name and title are the longest value");
  assert.ok(
    !/className=\{`\$\{tableSelectClass\} mb-1\.5`\}/.test(workspace),
    "the line dropdown's margin is back in its className; on a wrapValue field it shrinks the field",
  );
}
