import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// ─────────────────────────────────────────────────────────────────────────────
// THE DAILY CHART MUST BE IN ITS BAND, AND MUST PUT ITSELF BACK IF IT IS NOT.
//
// Reported from the live sheet on 2026-09-05, and it read as "the style is awful" rather than as a
// bug — which is why it survived. One defect produced both symptoms:
//
//   · rows 1-13 are RESERVED for the chart and FROZEN by styleHeader_, so with the chart missing
//     the sheet showed thirteen frozen blank rows permanently occupying the top of the screen;
//   · and the chart itself floated below the table, covering the data rows it summarises.
//
// The cause was that buildDailyChart_ ran only inside `if (fresh)` — i.e. only when the HEADER
// changed, which is almost never. Once the chart was missing or dragged out of the band, nothing
// in a refresh ever put it back.
//
// Executed against the real docs/cv-lifecycle-live-sheet.gs, because that file is not built, linted
// or imported by anything: a source-text assertion here would prove only that a line exists, not
// that a refresh repairs the sheet.
// ─────────────────────────────────────────────────────────────────────────────

const GS = "../docs/cv-lifecycle-live-sheet.gs";

/** Rows 1-13 are the reserved band; the table's header sits at 14. Mirrors DAILY_HEADER_ROW. */
const DAILY_HEADER_ROW = 14;

type ChartRecord = { anchorColumn: number; anchorRow: number };

/**
 * A fake sheet, rich enough to run writeDaily_ out of the real file.
 *
 * `insertChart` records the anchor the builder asked for, and `getCharts` replays it — which is the
 * whole point: the assertion is about WHERE the chart lands, so the anchor has to survive the round
 * trip through the builder rather than be read back off the object under test.
 */
function fakeSheet(seedCharts: ChartRecord[] = [], layoutAlreadyCurrent = false) {
  const charts: ChartRecord[] = [...seedCharts];
  const removed: ChartRecord[] = [];
  const values = new Map<string, unknown[][]>();
  let frozenRows = 0;
  // THE STATE THE LIVE SHEET WAS IN, and the one this whole file exists to reproduce: the header is
  // already correct, so layoutIsCurrent_ returns true and `fresh` is FALSE. A fake that starts empty
  // makes `fresh` true, the old `if (fresh)` branch runs, and the regression passes the test —
  // which is exactly what happened on the first version of this file.
  let lastRow = layoutAlreadyCurrent ? DAILY_HEADER_ROW + 5 : 0;
  if (layoutAlreadyCurrent) {
    values.set(`${DAILY_HEADER_ROW}:1:1:${HEADER.length}`, [HEADER]);
  }

  const range = (row: number, col: number, numRows = 1, numCols = 1) => {
    const key = `${row}:${col}:${numRows}:${numCols}`;
    const api: Record<string, unknown> = {
      clearContent: () => api,
      getValues: () => values.get(key) ?? [new Array(numCols).fill("")],
      setBackground: () => api,
      setFontColor: () => api,
      setFontWeight: () => api,
      setNumberFormat: () => api,
      setValues(next: unknown[][]) {
        values.set(key, next);
        lastRow = Math.max(lastRow, row + next.length - 1);
        return api;
      },
      setVerticalAlignment: () => api,
      setWrap: () => api,
    };
    return api;
  };

  const builder: Record<string, unknown> = {};
  let pending: ChartRecord = { anchorColumn: 1, anchorRow: 1 };
  for (const method of ["addRange", "setChartType", "setOption"]) {
    builder[method] = () => builder;
  }
  builder.setPosition = (anchorRow: number, anchorColumn: number) => {
    pending = { anchorColumn, anchorRow };
    return builder;
  };
  builder.build = () => ({ ...pending });

  return {
    charts,
    getCharts: () => charts.map((c) => ({ getContainerInfo: () => ({ getAnchorColumn: () => c.anchorColumn, getAnchorRow: () => c.anchorRow }) })),
    getFrozenRows: () => frozenRows,
    getLastColumn: () => 7,
    getLastRow: () => lastRow,
    getRange: range,
    insertChart: (chart: ChartRecord) => {
      charts.push(chart);
    },
    newChart: () => builder,
    removed,
    removeChart: (chart: unknown) => {
      const index = charts.findIndex((_, i) => i === charts.length - 1 - (charts.length - 1 - i));
      removed.push(charts[index === -1 ? 0 : 0]!);
      charts.shift();
      void chart;
    },
    setColumnWidth: () => undefined,
    setFrozenRows: (rows: number) => {
      frozenRows = rows;
    },
    setRowHeight: () => undefined,
  };
}

function loadSheetScript(sheet: ReturnType<typeof fakeSheet>) {
  const sandbox: Record<string, unknown> = {
    Array,
    Charts: { ChartType: { COLUMN: "COLUMN" } },
    ContentService: { MimeType: { TEXT: "TEXT" }, createTextOutput: () => ({ setMimeType: () => ({}) }) },
    Date,
    JSON,
    Math,
    Number,
    Object,
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty: () => undefined }) },
    RegExp,
    ScriptApp: {},
    SpreadsheetApp: { getActive: () => ({}) },
    String,
    UrlFetchApp: {},
    Utilities: {},
    console: { error: () => {}, log: () => {} },
    isNaN,
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL(GS, import.meta.url), "utf8"), sandbox);
  // sheetFor_ resolves the tab; the fake IS the tab, so short-circuit it.
  sandbox.sheetFor_ = () => sheet;
  return sandbox as {
    writeDaily_: (ss: unknown, rows: unknown[][]) => void;
  };
}

const HEADER = ["Day", "WhatsApp", "Email", "Uploaded by hand", "Total received", "Reached Google Drive", "Still missing from Drive"];
const ROWS = [HEADER, ["2026-09-04", 26, 2, 0, 28, 28, 0]];

export function runCvLifecycleSheetChartPlacementTests() {
  // ── 1. A first render puts the chart in the reserved band ──────────────────
  {
    const sheet = fakeSheet();
    loadSheetScript(sheet).writeDaily_({}, ROWS);
    assert.equal(sheet.charts.length, 1, "a refresh must leave exactly one chart");
    assert.deepEqual(
      sheet.charts[0],
      { anchorColumn: 1, anchorRow: 1 },
      "the chart belongs at A1, inside the band rows 1-13 that styleHeader_ freezes",
    );
    assert.equal(
      sheet.getFrozenRows(),
      DAILY_HEADER_ROW,
      "…and those band rows plus the header are frozen, which is WHY an empty band is so costly",
    );
  }

  // ── 2. THE DEFECT: a drifted chart is put back ─────────────────────────────
  //
  // This is the case the live sheet was in. The header was already correct, so the old code's
  // `if (fresh)` guard meant buildDailyChart_ never ran and the chart stayed where it had drifted —
  // over the data, with a frozen white void above it, on every refresh forever.
  {
    const sheet = fakeSheet([{ anchorColumn: 1, anchorRow: 30 }], true);
    loadSheetScript(sheet).writeDaily_({}, ROWS);
    assert.equal(sheet.charts.length, 1, "the drifted chart is replaced, not duplicated");
    assert.deepEqual(
      sheet.charts[0],
      { anchorColumn: 1, anchorRow: 1 },
      "a chart found outside the band must be returned to it — there is no position outside the band worth preserving, because outside it means covering data and leaving a frozen void",
    );
  }

  // ── 3. A chart already in place is left completely alone ───────────────────
  //
  // The other half, and it is not optional. This file's governing rule is "a refresh writes values
  // and touches nothing else"; the marketing sheet learned that the hard way by flickering while it
  // was being read. Repairing drift must not become rebuilding on every tick.
  {
    const sheet = fakeSheet([{ anchorColumn: 1, anchorRow: 1 }], true);
    loadSheetScript(sheet).writeDaily_({}, ROWS);
    assert.equal(sheet.removed.length, 0, "a healthy chart must never be removed and rebuilt");
    assert.equal(sheet.charts.length, 1);
    assert.deepEqual(sheet.charts[0], { anchorColumn: 1, anchorRow: 1 });
  }

  // ── 4. The repair runs on EVERY refresh, not only a fresh layout ───────────
  //
  // Pinned as source because it is the actual regression risk: moving this call back inside the
  // `if (fresh)` block restores the original bug exactly, and every behavioural test above would
  // still pass on a first render.
  const source = readFileSync(new URL(GS, import.meta.url), "utf8");
  const writeDaily = source.slice(
    source.indexOf("function writeDaily_"),
    source.indexOf("function ensureDailyChart_"),
  );
  // Brace-matched, NOT bounded by the last occurrence of the symbol being searched for — that
  // spelling ends the slice at the very call it is looking for, so it can never find one. It was
  // written that way first and passed against the regression.
  const freshStart = writeDaily.indexOf("if (fresh) {");
  assert.notEqual(freshStart, -1, "writeDaily_ must still have a fresh-layout branch");
  let depth = 0;
  let freshEnd = freshStart;
  for (let i = writeDaily.indexOf("{", freshStart); i < writeDaily.length; i += 1) {
    if (writeDaily[i] === "{") depth += 1;
    else if (writeDaily[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        freshEnd = i;
        break;
      }
    }
  }
  const freshBlock = writeDaily.slice(freshStart, freshEnd + 1);
  assert.ok(
    !freshBlock.includes("ensureDailyChart_") && !freshBlock.includes("buildDailyChart_"),
    "the chart repair must sit OUTSIDE the `if (fresh)` block — inside it, a sheet whose header is already correct can never heal, which is precisely the reported defect",
  );
  assert.ok(
    writeDaily.slice(freshEnd).includes("ensureDailyChart_"),
    "…and it must still be called after that block",
  );
}
