import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { STYLE } from "../src/lib/sales/master-map/sheet-render.ts";
import {
  LISTS_COLUMN_COUNT,
  listsRowCount,
  renderListsSheet,
  renderLookupSheet,
} from "../src/lib/sales/master-map/lookup-tab.ts";
import {
  MASTER_MAP_FLAT_COLUMNS,
  MASTER_MAP_MANAGER_LINES,
  buildMasterMapTree,
  flatShopCount,
  renderFlatRows,
} from "../src/lib/sales/master-map/tree.ts";

// "Find a pharmacy" is the tab the owner actually works in, and it died silently once already.
//
// The finder is a FILTER that spills one row per shop into the hidden Lists tab from F2, and both
// the count and the visible rows read that spill. A spill with nowhere to go does not truncate —
// it fails the whole tab: Lists!F2 becomes #REF!, the results table is empty, and the status line
// reads "Showing 1 of 1 matching shops", because COUNTA counts the single error cell as a match.
//
// The grid height was a fixed 55,000, chosen when the master held 50,622 shops. Measured live on
// 2026-09-09 the master held 63,510 and the finder had been returning nothing — with every other
// tab on the workbook correct and current, which is why nobody could see it from the data.
//
// Two properties keep that from recurring, and this file pins both:
//
//   1. The height is DERIVED from the shop count, never typed.
//   2. The shop count is IN THE TAB'S TEXT — the plan hashes each tab's text, so the hash moves
//      when the master grows, the tab repaints, and the height is recomputed. Without that the
//      height would change only when LAYOUT_VERSION does, which is the original bug.

/** The state of production on 2026-09-09, and the size the fixed constant could not hold. */
const SHOPS_TODAY = 63_510;
const THE_OLD_FIXED_HEIGHT = 55_000;

/** Just enough of a Sheets API request to read the grid a tab claims for itself. */
type GridClaim = {
  updateSheetProperties?: {
    properties?: { gridProperties?: { columnCount?: number; rowCount?: number } };
  };
};

function gridClaim(sheet: { requests: unknown[] }): { columnCount?: number; rowCount?: number } {
  for (const request of sheet.requests as GridClaim[]) {
    const grid = request?.updateSheetProperties?.properties?.gridProperties;
    if (grid) return grid;
  }
  throw new Error("the Lists tab claimed no grid at all");
}

function listsGridRowCount(shopCount: number): number {
  const rowCount = gridClaim(renderListsSheet(1, shopCount)).rowCount;
  if (typeof rowCount !== "number") throw new Error("the Lists tab claimed no grid height at all");
  return rowCount;
}

export function runMasterMapFinderGridTests() {
  // ---- The grid always outgrows the spill -------------------------------------------------------
  // +1 because the spill starts at row 2, under the header text in A1.
  for (const shops of [0, 1, 10_000, 50_622, SHOPS_TODAY, 90_000, 250_000]) {
    assert.ok(
      listsRowCount(shops) >= shops + 1,
      `a ${shops}-shop master needs at least ${shops + 1} rows; the spill fails the whole tab rather than clipping`,
    );
  }

  assert.ok(
    listsRowCount(SHOPS_TODAY) > THE_OLD_FIXED_HEIGHT,
    "the fixed 55,000 is what broke the finder in production — a derived height must clear it",
  );
  assert.ok(
    listsRowCount(THE_OLD_FIXED_HEIGHT) > THE_OLD_FIXED_HEIGHT,
    "and it must clear it at exactly the size that first overflowed it, not merely somewhere above",
  );

  // Headroom, because the grid can only grow when the tab repaints.
  assert.ok(
    listsRowCount(SHOPS_TODAY) >= Math.ceil(SHOPS_TODAY * 1.2),
    "a grid sized to the exact shop count would overflow again on the next pharmacy added",
  );

  // Never shrink below the floor: a small or half-loaded master must not paint a tiny grid that
  // the next real load then overflows.
  assert.equal(listsRowCount(0), 60_000, "an empty master still claims the floor");
  let previous = 0;
  for (const shops of [0, 1_000, 60_000, SHOPS_TODAY, 120_000]) {
    const height = listsRowCount(shops);
    assert.ok(height >= previous, "the height never goes down as the master grows");
    previous = height;
  }

  // ---- The rendered tab uses that height, and says what it was sized for ------------------------
  assert.equal(
    listsGridRowCount(SHOPS_TODAY),
    listsRowCount(SHOPS_TODAY),
    "the request pass has to claim the derived height — ensureTab only ever asks for 1,000 rows",
  );
  assert.notEqual(
    listsGridRowCount(SHOPS_TODAY),
    listsGridRowCount(SHOPS_TODAY * 2),
    "the height has to move with the master, or it is a constant wearing a function's clothes",
  );

  const rendered = renderListsSheet(1, SHOPS_TODAY);
  assert.ok(
    rendered.values[0][0].includes("63,510"),
    "the tab's TEXT names the shop count — that is what moves its content hash and triggers the repaint that resizes the grid",
  );
  assert.notEqual(
    renderListsSheet(1, SHOPS_TODAY).values[0][0],
    renderListsSheet(1, SHOPS_TODAY + 1).values[0][0],
    "one more shop must change the text, or the plan hashes the two states identically and the grid never grows",
  );
  assert.ok(
    rendered.values[0][0].startsWith("Master Map helper — do not edit."),
    "it is still the do-not-edit banner a person opening the hidden tab needs to read first",
  );

  // The width is the other half of the same failure: a grid one column short of the spill fails
  // the tab exactly as a short grid does.
  assert.equal(
    gridClaim(rendered).columnCount,
    LISTS_COLUMN_COUNT,
    "four dropdown columns plus one full width of the flat tab, derived rather than typed",
  );

  // ---- The count is the same population the spill holds -----------------------------------------
  const tree = buildMasterMapTree({
    areaManagers: [],
    areas: [
      { areaCode: "UE1", areaName: "Minia 1", regionCode: "UE" },
      { areaCode: "OT2", areaName: "Others bucket", regionCode: "OT" },
    ],
    bricks: [
      { areaCode: "UE1", brickId: "B-MINIA", brickName: "Minia Centre" },
      { areaCode: "OT2", brickId: "B-OTHER", brickName: "Other brick" },
    ],
    customers: [
      {
        address: "12 Corniche",
        brickId: "B-MINIA",
        customerCode: "1001",
        customerName: "صيدلية النور",
        distributorCode: "IS",
        source: "admin-import",
      },
      {
        address: "9 Nile St",
        brickId: "B-OTHER",
        customerCode: "1002",
        customerName: "صيدلية الشفاء",
        distributorCode: "IS",
        source: "admin-import",
      },
    ],
    regions: [
      { regionCode: "OT", regionName: "Others" },
      { regionCode: "UE", regionName: "Upper Egypt" },
    ],
  });

  assert.equal(
    flatShopCount(tree),
    renderFlatRows(tree, (code) => code).length,
    "the grid is sized from a count taken WITHOUT building the rows, so it has to agree with the rows exactly — an organogram view counted in would oversize harmlessly, one left out would overflow",
  );

  // ---- The Region box follows the organogram, not geography --------------------------------------
  // Measured live 2026-09-13: the box offered 7 regions and the organogram has 10. Column A of
  // "All customers" is geography, and Delta (3), Upper Egypt 1 and Upper Egypt 2 own no areas in the
  // area master, so a list read from A could neither offer them nor find a shop by them. The three
  // "<line> region" columns carry all ten.
  const lineRegionLetters = MASTER_MAP_MANAGER_LINES.map((line) => {
    const index = MASTER_MAP_FLAT_COLUMNS.indexOf(`${line} region`);
    assert.ok(index >= 0 && index < 26, `"All customers" carries a single-letter "${line} region" column`);
    return String.fromCharCode(65 + index);
  });
  const geographyRange = `'All customers'!A2:A`;

  const regionList = listsFormulaAt(rendered, 0);
  for (const letter of lineRegionLetters) {
    assert.ok(
      regionList.includes(`'All customers'!${letter}2:${letter}`),
      `the Region list reads the organogram's line region column ${letter}`,
    );
  }
  assert.ok(
    !regionList.includes(geographyRange),
    "the Region list must not read geography — that is the list that hid Delta (3), Upper Egypt 1 and Upper Egypt 2",
  );
  assert.ok(
    regionList.includes(`<>"Not in the organogram"`),
    "an area no line files is not a region, and must not be offered as one",
  );

  // Picking a region has to narrow by the same columns, everywhere a region narrows anything.
  for (const [column, what] of [
    [1, "the Area list"],
    [2, "the Brick list"],
    [5, "the results"],
  ] as const) {
    const formula = listsFormulaAt(rendered, column);
    for (const letter of lineRegionLetters) {
      assert.ok(
        formula.includes(`'All customers'!${letter}2:${letter}='Find a pharmacy'!$A$4`),
        `${what} matches the picked region against line region column ${letter}`,
      );
    }
    assert.ok(
      !formula.includes(`${geographyRange}='Find a pharmacy'!$A$4`),
      `${what} must not match the picked region against geography, or Upper Egypt 1 finds nothing`,
    );
  }

  // ---- The search box is handed to SEARCH as TEXT ------------------------------------------------
  // The second silent death of this tab, measured live on the production workbook 2026-09-28.
  // A customer code is all digits, so typing one stores a NUMBER in E4, and Google Sheets will not
  // coerce a number into SEARCH's first parameter: SEARCH errors on every row, ISNUMBER turns each
  // error into FALSE, the clause is 0 everywhere, and FILTER matches nothing. Region "Delta (3)"
  // plus 1547442 returned nothing while "All customers" held exactly one match, code 0001547442.
  // Nothing else on the workbook was wrong, and nothing else hands a typed value to SEARCH.
  const results = listsFormulaAt(rendered, 5);
  const searchKey = `TRIM(TO_TEXT('Find a pharmacy'!$E$4))`;

  assert.ok(
    results.includes(`(${searchKey}="")`),
    "the empty test reads the same normalised key, so a box holding only spaces means all of them",
  );
  for (const [letter, what] of [
    ["E", "the pharmacy name"],
    ["G", "the customer code"],
    ["D", "the brick code"],
    ["J", "the address"],
  ] as const) {
    assert.ok(
      results.includes(`ISNUMBER(SEARCH(${searchKey},'All customers'!${letter}2:${letter}))`),
      `${what} is searched through a key coerced to text — a digits-only entry reaches SEARCH as a number otherwise, and column ${letter} never matches`,
    );
  }
  assert.ok(
    !results.includes(`SEARCH('Find a pharmacy'!$E$4,`),
    "no column may be searched against the raw cell: that is the exact formula that killed the code search",
  );

  // ---- A finder that failed must not be reported as an unlucky search ----------------------------
  // The wrapper that used to sit here flattened "no shop matches" and "this formula could not run"
  // into one blank cell, which is why both deaths of this tab looked like the owner's filters.
  assert.ok(
    results.startsWith("=FILTER("),
    "the filter stays bare — wrapped in IFERROR it cannot tell the status line which of the two happened",
  );

  const status = formulaAt(renderLookupSheet(2), 5, 0);
  assert.ok(
    status.includes("ISNA(Lists!F2)"),
    "no matches is #N/A on the anchor cell, and it is tested FIRST",
  );
  assert.ok(
    status.includes("ISERROR(Lists!F2)"),
    "any other error is a broken finder, and the status line has to say so",
  );
  assert.ok(
    status.includes("could not run"),
    "and it has to say it in words that stop the owner retyping his filters",
  );
  assert.ok(
    status.includes(`COUNTA(Lists!F2:F)`),
    "the real total is still counted when the filter answered with rows",
  );
  assert.ok(
    status.indexOf("ISNA(") < status.indexOf("COUNTA("),
    "COUNTA counts an error cell as one match — it must be reached only after both error tests",
  );

  // The box itself is a TEXT cell, which is the layer that keeps a typed "0012345" from arriving
  // as 12345. Column E only: the four boxes left of it are filled from dropdown lists.
  const textFormat = (renderLookupSheet(2).requests as TextFormatClaim[]).find(
    (request) => request?.repeatCell?.cell?.userEnteredFormat?.numberFormat?.type === "TEXT",
  );
  assert.ok(textFormat, "the search box claims a TEXT number format");
  assert.equal(textFormat?.repeatCell?.range?.startColumnIndex, 4, "on column E");
  assert.equal(textFormat?.repeatCell?.range?.endColumnIndex, 5, "and on column E alone");

  // ---- The banners read from the left, because the tab is 4,000 pixels wide ----------------------
  // Each banner is one cell merged across all seventeen columns. Centred, it renders at about
  // x=2,000 — a screen and a half right of column A — so the title, the count and the hint were all
  // off the right-hand edge and the three rows showed as empty coloured bands. Measured live on the
  // production workbook 2026-09-28: the finder had found the shop and put it on screen, while
  // "Showing 1 of 1 matching shops" sat 2,000 pixels away where nobody would look, so a working
  // search read as a broken one.
  const lookup = renderLookupSheet(2);
  for (const [row, what] of [
    [0, "the title"],
    [1, "the freshness line"],
    [5, "the count"],
    [6, "the hint"],
  ] as const) {
    assert.equal(
      alignmentAt(lookup, row),
      "LEFT",
      `${what} is a merged banner across 17 columns — centred, it renders off the right-hand edge of any normal window and the row reads as an empty band`,
    );
  }

  // The same styles stay CENTRED where they belong. The grouped tabs are seven columns, about
  // 1,900 pixels, so their centre is on screen — the width of THIS tab is what makes centre wrong,
  // not the style, and changing the shared style would move every region band on the workbook.
  // ---- The sheet says when it last refreshed ITSELF ----------------------------------------------
  // The one thing on the workbook that can show the sheet has stopped. Every tab is painted from
  // Phoenix and then left alone, so a stopped script leaves fifteen correct-looking tabs and no
  // signal anywhere. On 2026-09-28 establishing that a sheet was stale took two hours of comparing
  // layout versions — this cell answers it at a glance.
  const freshness = formulaAt(lookup, 1, 0);
  assert.ok(
    freshness.includes("Lists!E1"),
    "the freshness line reads the cell the sheet's own script stamps",
  );
  assert.ok(
    freshness.includes("Cairo"),
    "and labels it Cairo, which is the only timezone the owner reads",
  );
  assert.ok(
    freshness.startsWith(`=IF(Lists!E1="",""`),
    "blank until the sheet has stamped itself once — a workbook on an older Code.gs shows nothing rather than an alarming line",
  );

  // A TIMESTAMP MUST NEVER REACH THE RENDERED VALUES. The plan hashes each tab's text, so a time
  // written into the values would move the hash on every plan fetch and repaint all fifteen tabs
  // once an hour, for ever, to change one line. It has to be a formula over a cell the script
  // writes, which is what the assertions above are really protecting.
  for (const row of lookup.values) {
    for (const cell of row) {
      assert.ok(
        !/\b(19|20)\d\d[-/]\d\d|\d\d:\d\d/.test(cell),
        `"${cell}" looks like a timestamp in the rendered TEXT — that moves the tab's content hash every hour and repaints the whole workbook for ever`,
      );
    }
  }

  // The stamp cell sits left of the spill, so the results can never overwrite it.
  const spillStartsAt = LISTS_COLUMN_COUNT - MASTER_MAP_FLAT_COLUMNS.length;
  assert.ok(
    4 < spillStartsAt,
    "column E is before the column the results spill from — a stamp inside the spill would be erased on every recalculation",
  );

  // The script half: only the sheet knows whether a paint HAPPENED, so it is the sheet that stamps.
  const script = readFileSync("google-apps-script/master-map/Code.gs", "utf8");
  assert.ok(
    /if \(queue\.length === 0\) \{[\s\S]{0,200}?stampRefreshedAt\(\)/.test(script),
    "the stamp is written only once the queue has DRAINED — stamping mid-repaint would claim freshness for a half-painted sheet, the one lie this cell exists to prevent",
  );
  assert.ok(
    script.includes('"Africa/Cairo"'),
    "formatted in Cairo by the script, because the spreadsheet's own timezone is neither set nor checked anywhere in this repository",
  );
  assert.ok(
    script.includes('getRange("E1")'),
    "into the cell the finder reads",
  );

  // ---- A truncated body is retried, not fatal ----------------------------------------------------
  // JSON.parse used to sit on fetchJson's return line, outside any catch, so a 200 whose body
  // arrived SHORT threw straight past the retry loop and killed the whole execution. Measured
  // 2026-09-28 on a values slice of "All customers": the endpoint served 1,156,437 bytes and parsed
  // perfectly when fetched independently, Apps Script received 57,476, and the run stopped halfway
  // through that tab — leaving the flat tab holding 28,000 of its 73,938 rows. The finder reads
  // that tab, so one cut connection quietly made the whole sheet wrong.
  assert.ok(
    !/return JSON\.parse\(response\.getContentText\(\)\)/.test(script),
    "fetchJson must not parse on the return line — a short body throws past the retry loop and takes the run down with it",
  );
  assert.ok(
    /try \{[\s\S]{0,120}?JSON\.parse\(body\)[\s\S]{0,400}?catch/.test(script),
    "the parse is inside a try, so a truncated body becomes a retry rather than a dead execution",
  );

  // ---- A crash mid-repaint must not lose the queue ------------------------------------------------
  // The deeper half of the same incident. runSync saved the queue and the hashes only AFTER the
  // loop, so an exception from paintTab skipped both and the remaining tabs vanished from Script
  // Properties — while planWork had already recorded the change stamp. Every tick afterwards found
  // an empty queue, probed, saw a matching stamp and returned in about ONE SECOND believing the
  // sheet was current. Measured 2026-09-28: the flat tab sat holding 28,000 of its 73,938 rows for
  // a quarter of an hour while three ticks reported success, and the finder reads that tab.
  assert.ok(
    /\} finally \{[\s\S]{0,400}?setProperty\(PROP_QUEUE/.test(script),
    "the queue is persisted in a finally — a crash mid-repaint must cost one tick, not the whole remaining queue",
  );
  assert.ok(
    /\} finally \{[\s\S]{0,400}?setProperty\(PROP_HASHES/.test(script),
    "and so are the hashes, or a resumed run repaints tabs it already finished",
  );

  assert.equal(
    (STYLE.area as { align?: string }).align,
    "CENTER",
    "the shared area-band style is untouched — only this tab overrides it",
  );
  assert.equal(
    (STYLE.region as { align?: string }).align,
    "CENTER",
    "and so is the shared region-band style",
  );
}

type AlignmentClaim = {
  repeatCell?: {
    cell?: { userEnteredFormat?: { horizontalAlignment?: string } };
    range?: { endRowIndex?: number; startColumnIndex?: number; startRowIndex?: number };
  };
};

/** The horizontal alignment the tab claims for a full-width row. */
function alignmentAt(sheet: { requests: unknown[] }, row: number): string {
  for (const request of sheet.requests as AlignmentClaim[]) {
    const cell = request?.repeatCell;
    if (!cell || cell.range?.startRowIndex !== row) continue;
    if (cell.range?.startColumnIndex) continue; // a boxed control, not the full-width banner
    const alignment = cell.cell?.userEnteredFormat?.horizontalAlignment;
    if (alignment) return alignment;
  }
  throw new Error(`the finder claims no alignment for row ${row + 1}`);
}

type TextFormatClaim = {
  repeatCell?: {
    cell?: { userEnteredFormat?: { numberFormat?: { type?: string } } };
    range?: { endColumnIndex?: number; startColumnIndex?: number };
  };
};

type FormulaWrite = {
  updateCells?: {
    range?: { startColumnIndex?: number; startRowIndex?: number };
    rows?: Array<{ values?: Array<{ userEnteredValue?: { formulaValue?: string } }> }>;
  };
};

/** The formula a rendered tab writes into one cell, by 0-based row and column. */
function formulaAt(sheet: { requests: unknown[] }, row: number, column: number): string {
  for (const request of sheet.requests as FormulaWrite[]) {
    const cells = request?.updateCells;
    if (cells?.range?.startRowIndex !== row || cells.range.startColumnIndex !== column) continue;
    const formula = cells.rows?.[0]?.values?.[0]?.userEnteredValue?.formulaValue;
    if (formula) return formula;
  }
  throw new Error(`that tab writes no formula into row ${row + 1}, column ${column}`);
}

/** The formula the Lists tab writes into row 2 of a column. */
function listsFormulaAt(sheet: { requests: unknown[] }, column: number): string {
  return formulaAt(sheet, 1, column);
}
