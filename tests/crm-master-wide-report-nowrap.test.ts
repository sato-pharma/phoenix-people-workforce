import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { stripCssComments } from "./support/comment-strip.ts";

/**
 * 🔒 THE CRM MASTER REPORT SCROLLS SIDEWAYS, AND ITS CELLS NEVER WRAP — owner, 2026-09-26:
 *
 *   "this report only is the accepted horizontal scrolling because it's too wide.
 *    So I accept horizontal scrolling here."
 *
 * /admin/crm is the raw 44-column mirror of the iReports360 feed — every column, every record's
 * full payload — read inside its own scroller with a synced top scrollbar above the sticky header.
 * It is the one table in the app that is deliberately wider than `main`, and it is exempt from the
 * fits-the-screen golden rule by the owner's own words above.
 *
 * WHAT BROKE IT. #4400 made `PortalDesktopTable` fit instead of scroll, and carried a global rule
 * in app/globals.css to go with it:
 *
 *     [data-portal-desktop-table] :where(td, th) { white-space: normal; overflow-wrap: anywhere }
 *
 * That rule is correct for every table it was written for — they are `table-fixed` with a
 * `<colgroup>`, where a `whitespace-nowrap` cell would spill its own box and clip the text, so
 * wrapping IS the fit. The CRM Master grid is the single table wearing `data-portal-desktop-table`
 * that is NOT `table-fixed`: it carries the attribute only so the employee-portal shell's
 * `max-width:767px { display: none }` reaches it. Unlayered, the rule beat every
 * `whitespace-nowrap` in the component, and an auto-layout table holding 44 columns inside `w-full`
 * had nowhere to put the text but downwards — measured in the browser on 2026-09-26:
 *
 *     header height 227px (one word per line, read vertically), data rows 525px tall
 *
 * i.e. about 26,000px of scrolling for fifty records. Nothing in this repo could see it: the class
 * sat in the DOM, the rule sat in the stylesheet, and only `getComputedStyle` in a real browser
 * reported `white-space: normal` on a `th` whose class string says `whitespace-nowrap` — the same
 * shape of defect as the `min-w-0` one this file's neighbour in globals.css documents.
 *
 * THE FIX, AND WHAT THIS FILE PINS. `data-wide-report` on the table opts it out
 * (`:not([data-wide-report])` in the selector). So:
 *
 *   1. the rule must stay OPT-OUTABLE — a plain `[data-portal-desktop-table] :where(td, th)` is
 *      the regression, and it is the spelling a future "tidy the selector" would restore;
 *   2. the CRM Master grid must carry BOTH attributes and keep its `whitespace-nowrap` cells;
 *   3. nothing `table-fixed` may take the opt-out — there, wrapping is the fit, and hanging this
 *      escape hatch on a fitted table clips text instead of wrapping it.
 *
 * Fixing a red assertion here by deleting the `:not(...)` re-breaks /admin/crm; fixing it by
 * spreading `data-wide-report` over fitted tables re-breaks the eighty tables #4400 fixed.
 */

const GLOBALS_CSS = stripCssComments(
  readFileSync(fileURLToPath(new URL("../app/globals.css", import.meta.url)), "utf8"),
);

const MASTER_TABLE_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/components/crm/crm-master-table.tsx", import.meta.url)),
  "utf8",
);

const PORTAL_TABLE_ATTR = "data-portal-desktop-table";
const WIDE_REPORT_ATTR = "data-wide-report";

/** Every selector in globals.css whose block sets `white-space` on portal-table cells. */
function wrapRuleSelectors(): string[] {
  const selectors: string[] = [];
  const blocks = GLOBALS_CSS.matchAll(/([^{}]*\[data-portal-desktop-table\][^{}]*)\{([^{}]*)\}/g);
  for (const block of blocks) {
    const [, selector, body] = block;
    if (/white-space\s*:/.test(body)) selectors.push(selector.trim().replace(/\s+/g, " "));
  }
  return selectors;
}

/**
 * The opening tag of the wide report's `<table>`, read forwards from its `ref={tableRef}` — the
 * one marker that is unique to that element and survives the tag being reformatted across lines.
 */
function wideReportTableTag(): string {
  const ref = MASTER_TABLE_SOURCE.indexOf("ref={tableRef}");
  assert.notEqual(
    ref,
    -1,
    "crm-master-table.tsx no longer has a `ref={tableRef}` table — that ref is the wide report's " +
      "scroll-sync anchor; if it was renamed, re-point this test at the new marker rather than " +
      "deleting the pin.",
  );
  const open = MASTER_TABLE_SOURCE.lastIndexOf("<table", ref);
  const close = MASTER_TABLE_SOURCE.indexOf(">", ref);
  assert.ok(open !== -1 && close !== -1, "could not read the wide report's <table> opening tag");
  return MASTER_TABLE_SOURCE.slice(open, close + 1);
}

export async function runCrmMasterWideReportNowrapTests(): Promise<void> {
  // 1. The global wrap rule exists, and it is opt-outable.
  const selectors = wrapRuleSelectors();
  assert.ok(
    selectors.length > 0,
    "app/globals.css no longer sets `white-space` on [data-portal-desktop-table] cells — if that " +
      "rule was removed on purpose, remove this test with it and re-check the portal tables fit.",
  );
  for (const selector of selectors) {
    assert.ok(
      selector.includes(`:not([${WIDE_REPORT_ATTR}])`),
      `app/globals.css: \`${selector}\` wraps EVERY portal desktop table's cells, including the ` +
        "CRM Master report on /admin/crm, which the owner ruled on 2026-09-26 may scroll " +
        `sideways. Restore the \`:not([${WIDE_REPORT_ATTR}])\` opt-out — wrapping that table ` +
        "does not make it fit, it makes its headers 227px of vertical text.",
    );
  }

  // 2. The wide report opts out, and keeps its nowrap cells.
  const tag = wideReportTableTag();
  assert.ok(
    tag.includes(PORTAL_TABLE_ATTR),
    `crm-master-table.tsx: the wide report lost \`${PORTAL_TABLE_ATTR}\`, the employee-portal ` +
      "shell's own below-768px gate.",
  );
  assert.ok(
    tag.includes(WIDE_REPORT_ATTR),
    `crm-master-table.tsx: the wide report lost \`${WIDE_REPORT_ATTR}\`, so the global wrap rule ` +
      "in app/globals.css reaches its 44 columns again and stacks every cell vertically.",
  );
  assert.ok(
    !/\btable-fixed\b/.test(tag),
    "crm-master-table.tsx: the wide report became `table-fixed`. A fixed table cannot size to its " +
      "44 columns, so its nowrap cells would spill and clip instead of scrolling — drop " +
      `\`${WIDE_REPORT_ATTR}\` at the same time if this is deliberate.`,
  );
  for (const cell of ["<th className=\"whitespace-nowrap", "<td className=\"whitespace-nowrap"]) {
    assert.ok(
      MASTER_TABLE_SOURCE.includes(cell),
      `crm-master-table.tsx: \`${cell}…\` is gone — the wide report's header and body cells must ` +
        "stay on one line each; that is what the accepted sideways scroll is for.",
    );
  }

  // 3. The opt-out never lands on a fitted table.
  const optedOut = MASTER_TABLE_SOURCE.matchAll(/<table[^>]*>/g);
  for (const match of optedOut) {
    const openingTag = match[0];
    if (!openingTag.includes(WIDE_REPORT_ATTR)) continue;
    assert.ok(
      !/\btable-fixed\b/.test(openingTag),
      `crm-master-table.tsx: a \`table-fixed\` table took \`${WIDE_REPORT_ATTR}\`. On a fitted ` +
        "table wrapping IS the fit — opting it out clips the text instead.",
    );
  }
}
