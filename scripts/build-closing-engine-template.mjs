#!/usr/bin/env node
// Build the EMPTY closing engine template from a real .xlsm closing workbook.
//
// The premium closing export does not build a workbook. It fills THIS one — the owner's own
// engine, with its two Excel Tables, three pivot tables, two slicers, the Rep Card's INDEX/MATCH
// formulas and the VBA button bar all intact. Rebuilding that machinery server-side is what
// shipped on 2026-08-30 and had to be undone; see AGENTS.md §4.
//
// What this script produces is deliberately EMPTY. A template pre-filled with a real month means a
// filler that misses a sheet hands a reader another line's real numbers under the correct heading.
// Blank is recoverable. Plausible-and-wrong is not.
//
// Two outputs:
//   assets/closing-engine/template.xlsm  — the emptied workbook
//   assets/closing-engine/template.json  — where each sheet's data starts, and the stamp row
//
// Usage:  node scripts/build-closing-engine-template.mjs <source.xlsm>

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const XLNS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

// ── Per-sheet emptying rules ──────────────────────────────────────────────────
//
// `keep` is the last row that is structure (title, KPI captions, column headings). `stamp` is the
// first data row: the filler clones it to make every row it writes, so its styles survive exactly.
// A pivot sheet has no stamp — Excel re-renders it from the cache on open.
//
// `trailer` is the owner's footnotes — the two or three explanatory lines UNDER the data. They were
// being deleted outright, which lost his own wording ("15 areas carry no target: they are listed and
// counted in the totals, but never ranked and never scored as zero") and left their merged cells
// stranded at July's row numbers, where a longer month would have merged a data row across the whole
// sheet. Kept here and re-placed under the data by the filler, which also rewrites those merges.
const SHEETS = {
  Overview: { keep: 8, stamp: 9, dataCols: "A:J", trailer: [18, 19, 20] },
  "Rep Ranking": { keep: 4, stamp: 5, dataCols: "A:J" },
  // The card is machinery: B5 is the PickList dropdown, N1 MATCHes it into AreaBook, and every
  // product row SUMIFS over SalesData keyed on its own $B cell. Keep row 17 as the product stamp
  // and the 32/34-36 trailer; the filler clones 17 per product and re-places the trailer.
  "Rep Card": { keep: 16, stamp: 17, trailer: [32, 33, 34, 35, 36], formulaSheet: true },
  "Top Achievers": { keep: 8, stamp: 9, dataCols: "A:I", trailer: [20, 21] },
  "Closing Matrix": { keep: 6, stamp: null, pivot: true },
  "Units Matrix": { keep: 6, stamp: null, pivot: true },
  "Area x Product": { keep: 1, stamp: null, pivot: true },
  "Family Performance": { keep: 4, stamp: 5, dataCols: "A:H", trailer: [12, 13] },
  Data: { keep: 1, stamp: 2, dataCols: "A:AC" },
  "Watch List": { keep: 4, stamp: 5, dataCols: "A:L" },
  "Top Customers": { keep: 4, stamp: 5, dataCols: "A:H", trailer: [10315, 10316, 10317] },
  Details: { keep: 4, stamp: 5, dataCols: "A:R" },
};

// Cells inside the kept region that carry the period, the line or a live number rather than a
// fixed caption. The filler rewrites them; the template must not ship them holding July's values.
// Overview G4/G8/I8 and Rep Ranking J4 are the "June" captions. They read as fixed headings and are
// not: each names whichever month came before the one being exported. Blanked here and written by
// the filler, so a September closing cannot ship a column headed June.
const VOLATILE = {
  Overview: ["A1", "B5", "D5", "F5", "I5", "B6", "D6", "F6", "I6", "I4", "H8", "I8"],
  "Rep Ranking": ["A1", "J4"],
  // B5 is the current selection; B14 names the month; B17 is the first product name.
  "Rep Card": ["A1", "B5", "B14", "B17"],
  "Top Achievers": ["A1", "B5", "G5", "B6"],
  "Closing Matrix": ["A1"],
  "Units Matrix": ["A1"],
  "Area x Product": ["A1"],
  "Family Performance": ["A1"],
  "Watch List": ["A1"],
  "Top Customers": ["A1"],
  Details: ["A1"],
  // AC1 is the first PickList entry — a rep's real name, not a heading.
  Data: ["AC1"],
};

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function readSharedStrings(xml) {
  const out = [];
  for (const si of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    let text = "";
    for (const t of si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) text += t[1];
    out.push(text);
  }
  return out;
}

function colOf(ref) {
  return (ref.match(/^[A-Z]+/) || [""])[0];
}

// Rewrite one <c> element: resolve any shared string into an inline string so the template can
// drop sharedStrings.xml entirely — no index table to keep in step, in the template or the filler.
function inlineCell(cellXml, strings) {
  const typeMatch = cellXml.match(/\st="(\w+)"/);
  if (!typeMatch || typeMatch[1] !== "s") return cellXml;
  const valueMatch = cellXml.match(/<v>([^<]*)<\/v>/);
  if (!valueMatch) return cellXml.replace(/\st="s"/, "");
  const text = strings[Number(valueMatch[1])] ?? "";
  const open = cellXml.slice(0, cellXml.indexOf(">") + 1).replace(/\st="s"/, ' t="inlineStr"');
  const preserve = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : "";
  return `${open}<is><t${preserve}>${xmlEscape(text)}</t></is></c>`;
}

// Strip a cell back to styling only — keeps `s=`, drops the value, the type and any formula.
function blankCell(cellXml) {
  const open = cellXml.slice(0, cellXml.indexOf(">") + 1);
  const bare = open.replace(/\st="\w+"/, "").replace(/\/>$/, ">").replace(/>$/, ">");
  return `${bare}</c>`;
}

// Keep the formula, drop the cached result. Excel recalculates on open; the cached <v> is the
// last month's answer and is exactly the kind of real number this template must not carry.
function dropCachedResult(cellXml) {
  if (!/<f[\s>/]/.test(cellXml)) return cellXml;
  return cellXml.replace(/<v>[^<]*<\/v>/, "").replace(/\st="(str|e)"/, "");
}

function splitRows(sheetXml) {
  const start = sheetXml.indexOf("<sheetData>");
  const selfClosing = start < 0 && sheetXml.includes("<sheetData/>");
  if (selfClosing) return { head: sheetXml.split("<sheetData/>")[0], rows: [], tail: sheetXml.split("<sheetData/>")[1] };
  const end = sheetXml.indexOf("</sheetData>");
  const head = sheetXml.slice(0, start + "<sheetData>".length);
  const body = sheetXml.slice(start + "<sheetData>".length, end);
  const tail = sheetXml.slice(end);
  const rows = [];
  for (const m of body.matchAll(/<row [^>]*?(?:\/>|>[\s\S]*?<\/row>)/g)) {
    rows.push({ xml: m[0], r: Number((m[0].match(/\sr="(\d+)"/) || [])[1]) });
  }
  return { head, rows, tail };
}

function cellsOf(rowXml) {
  return [...rowXml.matchAll(/<c [^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)].map((m) => m[0]);
}

function refOf(cellXml) {
  return (cellXml.match(/\sr="([A-Z]+\d+)"/) || [])[1] ?? "";
}

/** Replace whatever inline string a header cell holds, keeping its style and its `t` attribute. */
function setHeaderText(sheetXml, ref, text) {
  return sheetXml.replace(
    new RegExp(`(<c r="${ref}"[^>]*>)[\\s\\S]*?(</c>)`),
    `$1<is><t>${xmlEscape(text)}</t></is>$2`,
  );
}

/**
 * The thirteenth page: Family by Month.
 *
 * It is Family Performance's own sheet, cloned and re-aimed at the by-month series — the same
 * typography, banding, column widths and arrow column, because a new page in this module matches
 * its siblings rather than inventing a look.
 *
 * Four things about the clone are load-bearing, and each of the first three is a repair prompt if
 * it is put back:
 *
 *  1. **No `codeName`.** `vbaProject.bin` holds exactly twelve document modules, `Sheet1` to
 *     `Sheet12` (measured, not assumed). A thirteenth sheet naming a module the project does not
 *     have is a repair prompt on open, so the attribute is dropped and Excel assigns one itself.
 *  2. **No drawing.** `<drawing r:id="rId2"/>` points at sheet8's own part, and a relationship id
 *     that resolves to nothing is the same repair prompt.
 *  3. **No printerSettings relationship.** `pageSetup` keeps its paper size and scale — it only
 *     loses the `r:id` that pointed at sheet8's printer blob — so the page still prints as the
 *     owner set it up.
 *  4. **The colour rules move from achievement to growth.** Column F is no longer "did you make
 *     target" (green at 1.0, amber below 0.5) but "against the month before" (green at or above
 *     zero, amber below). Left alone, every family that grew 40% would be painted amber.
 */
async function addFamilyByMonth(zip, manifest) {
  const SOURCE = "Family Performance";
  const NAME = "Family by Month";
  const FILE = "xl/worksheets/sheet13.xml";
  const REL_ID = "rId20";
  const spec = manifest.sheets[SOURCE];
  if (!spec) throw new Error(`cannot clone ${SOURCE}: it is not in the manifest`);

  let sheet = await zip.file(spec.file).async("string");
  sheet = sheet.replace(/xr:uid="\{[^}]*\}"/, 'xr:uid="{00000000-0001-0000-0C00-000000000000}"');
  sheet = sheet.replace(/<sheetPr codeName="[^"]*"/, "<sheetPr");
  sheet = sheet.replace(/<drawing r:id="[^"]*"\s*\/>/, "");
  sheet = sheet.replace(/(<pageSetup [^>]*?)\s+r:id="[^"]*"/, "$1");
  // Freeze the four header rows rather than six: this page scrolls, and the owner's original split
  // was cut for a sheet that never ran past one screen.
  sheet = sheet.replace(/<pane xSplit="1" ySplit="\d+" topLeftCell="[A-Z]+\d+"/, '<pane xSplit="1" ySplit="4" topLeftCell="B5"');

  sheet = setHeaderText(sheet, "C4", "Month");
  sheet = setHeaderText(sheet, "E4", "Share of the month");
  sheet = setHeaderText(sheet, "F4", "Against the month before");
  sheet = setHeaderText(sheet, "H4", "Share of the family");

  // Column E stops being a second money column and becomes a percentage.
  const percentStyle = spec.stampCells.find((cell) => cell.col === "F")?.s;
  sheet = sheet.replace(/(<c r="E5" s=")\d+(")/, `$1${percentStyle}$2`);

  sheet = sheet.replaceAll("$F5&gt;=1)", "$F5&gt;=0)").replaceAll("$F5&lt;0.5)", "$F5&lt;0)");
  zip.file(FILE, sheet);

  const contentTypes = await zip.file("[Content_Types].xml").async("string");
  zip.file(
    "[Content_Types].xml",
    contentTypes.replace(
      "</Types>",
      `<Override PartName="/${FILE}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    ),
  );

  const rels = await zip.file("xl/_rels/workbook.xml.rels").async("string");
  if (rels.includes(`Id="${REL_ID}"`)) throw new Error(`${REL_ID} is already taken`);
  zip.file(
    "xl/_rels/workbook.xml.rels",
    rels.replace(
      "</Relationships>",
      `<Relationship Id="${REL_ID}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet13.xml"/></Relationships>`,
    ),
  );

  let workbook = await zip.file("xl/workbook.xml").async("string");
  const order = [...workbook.matchAll(/<sheet name="([^"]*)"[^>]*\/>/g)].map((m) => m[1]);
  const sibling = new RegExp(`<sheet name="${SOURCE}"[^>]*/>`).exec(workbook);
  if (!sibling) throw new Error(`cannot place ${NAME}: ${SOURCE} is not in workbook.xml`);
  const takenIds = [...workbook.matchAll(/sheetId="(\d+)"/g)].map((m) => Number(m[1]));
  const sheetId = Math.max(...takenIds) + 1;
  const at = order.indexOf(SOURCE) + 1;

  // `localSheetId` is a POSITION in the sheet order, not an id — inserting a sheet renumbers every
  // sheet after it, and every print area, print title and autofilter belonging to those sheets goes
  // on pointing at the position it used to occupy. Left alone, Watch List's print area lands on the
  // hidden Data sheet and Details' on Top Customers. It parses, it opens, and it prints the wrong
  // page: nothing in the file is invalid, so no integrity check can see it either.
  workbook = workbook.replace(
    /localSheetId="(\d+)"/g,
    (match, index) => (Number(index) >= at ? `localSheetId="${Number(index) + 1}"` : match),
  );
  workbook = workbook.replace(sibling[0], `${sibling[0]}<sheet name="${NAME}" sheetId="${sheetId}" r:id="${REL_ID}"/>`);

  // Its own print area and repeating header, cut to match the long sheets rather than the short
  // one it was cloned from: Family Performance is a single page and carries PhxOnePage, but this
  // page grows a row per family per month, so it prints like Watch List and Details do. The fill
  // step resizes the range by sheet NAME, so the row number here is only a starting point.
  const printArea = `<definedName name="_xlnm.Print_Area" localSheetId="${at}">'${NAME}'!$A$1:$H$${(spec.firstDataRow ?? 5)}</definedName>`;
  const printTitles = `<definedName name="_xlnm.Print_Titles" localSheetId="${at}">'${NAME}'!$${spec.headerRows}:$${spec.headerRows}</definedName>`;
  // Replacement FUNCTIONS, not strings: a print area is full of `$`, and `$A$1` read as a string
  // replacement means "capture group 1" — the range silently becomes the matched text.
  workbook = workbook.replace(
    /(<definedName name="_xlnm\.Print_Area"[^>]*>[^<]*<\/definedName>)(?![\s\S]*<definedName name="_xlnm\.Print_Area")/,
    (_match, last) => `${last}${printArea}`,
  );
  workbook = workbook.replace(
    /(<definedName name="_xlnm\.Print_Titles"[^>]*>[^<]*<\/definedName>)(?![\s\S]*<definedName name="_xlnm\.Print_Titles")/,
    (_match, last) => `${last}${printTitles}`,
  );
  if (!workbook.includes(printArea) || !workbook.includes(printTitles)) {
    throw new Error(`could not give ${NAME} a print area`);
  }
  zip.file("xl/workbook.xml", workbook);

  manifest.sheets[NAME] = {
    ...spec,
    file: FILE,
    stampCells: spec.stampCells.map((cell) => (cell.col === "E" ? { ...cell, s: percentStyle } : cell)),
  };
  console.log(`  ${NAME.padEnd(22)} cloned from ${SOURCE} -> ${FILE}  (sheetId ${sheetId}, ${REL_ID}, no codeName)`);
}

async function main() {
  const source = process.argv[2];
  if (!source) {
    console.error("usage: node scripts/build-closing-engine-template.mjs <source.xlsm>");
    process.exit(1);
  }
  // fileURLToPath, never `new URL(...).pathname` — the checkout lives under "Phoenix Workforce",
  // and a raw pathname keeps the space percent-encoded, which silently writes to a "Phoenix%20…"
  // sibling directory instead of the repo.
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const zip = await JSZip.loadAsync(readFileSync(source));

  const strings = readSharedStrings(await zip.file("xl/sharedStrings.xml").async("string"));
  const workbookXml = await zip.file("xl/workbook.xml").async("string");
  const relsXml = await zip.file("xl/_rels/workbook.xml.rels").async("string");

  const relTarget = {};
  for (const m of relsXml.matchAll(/Id="(rId\d+)"[^>]*Target="([^"]*)"/g)) relTarget[m[1]] = m[2];

  const sheetList = [];
  for (const m of workbookXml.matchAll(/<sheet name="([^"]*)" sheetId="(\d+)"(?: state="(\w+)")? r:id="(rId\d+)"/g)) {
    sheetList.push({ name: m[1], state: m[3] ?? "visible", file: `xl/${relTarget[m[4]]}` });
  }

  const manifest = { builtFrom: source.replace(/\\/g, "/").split("/").pop(), sheets: {} };

  for (const sheet of sheetList) {
    const rule = SHEETS[sheet.name];
    if (!rule) throw new Error(`no emptying rule for sheet "${sheet.name}"`);
    const original = await zip.file(sheet.file).async("string");
    const { head, rows, tail } = splitRows(original);

    // The Rep Card is machinery, not data: 89 formulas reading AreaBook through the PickList
    // dropdown. Keep every row; only the title carries the period.
    if (rule.formulaSheet) {
      const trailer = new Set(rule.trailer ?? []);
      const kept = [];
      let stamp = null;
      const clean = (rowXml) => {
        let xml = rowXml;
        for (const cell of cellsOf(xml)) {
          let next = dropCachedResult(inlineCell(cell, strings));
          if ((VOLATILE[sheet.name] ?? []).includes(refOf(cell))) next = blankCell(next);
          // "Rank 1 of 35" hardcodes July's targeted-area count into the formula text.
          next = next.replace(/&amp;" of \d+"/, '&amp;" of "&amp;$N$3');
          if (next !== cell) xml = xml.replace(cell, next);
        }
        return xml;
      };
      for (const row of rows) {
        if (row.r <= rule.keep) kept.push(clean(row.xml));
        else if (row.r === rule.stamp) stamp = clean(row.xml);
        else if (trailer.has(row.r)) kept.push(clean(row.xml));
      }
      const trailerRows = kept.filter((x) => trailer.has(Number((x.match(/\sr="(\d+)"/) || [])[1])));
      const headerRows = kept.filter((x) => !trailer.has(Number((x.match(/\sr="(\d+)"/) || [])[1])));
      zip.file(sheet.file, head + headerRows.join("") + (stamp ?? "") + trailerRows.join("") + tail);
      manifest.sheets[sheet.name] = {
        file: sheet.file,
        kind: "formula",
        state: sheet.state,
        headerRows: rule.keep,
        productStampRow: rule.stamp,
        trailerRows: rule.trailer ?? [],
        volatile: VOLATILE[sheet.name] ?? [],
      };
      console.log(`  ${sheet.name.padEnd(20)} ${String(rows.length).padStart(6)} rows -> ${headerRows.length} + 1 stamp + ${trailerRows.length} trailer`);
      continue;
    }

    const dataTrailer = new Set(rule.trailer ?? []);
    const keptRows = [];
    const trailerXml = [];
    let stampXml = null;
    let lastSourceDataRow = rule.stamp ?? rule.keep ?? 1;
    for (const row of rows) {
      if (rule.keep !== null && row.r <= rule.keep) {
        let xml = row.xml;
        for (const cell of cellsOf(xml)) {
          const ref = refOf(cell);
          const next = (VOLATILE[sheet.name] ?? []).includes(ref) ? blankCell(inlineCell(cell, strings)) : inlineCell(cell, strings);
          if (next !== cell) xml = xml.replace(cell, next);
        }
        keptRows.push(xml);
        continue;
      }
      if (dataTrailer.has(row.r)) {
        // The footnote keeps its words. Any figure inside one is July's, so the filler is given a
        // way to replace the whole line; a sheet that supplies nothing keeps the owner's wording.
        let xml = row.xml;
        for (const cell of cellsOf(xml)) {
          const next = inlineCell(cell, strings);
          if (next !== cell) xml = xml.replace(cell, next);
        }
        trailerXml.push(xml);
        continue;
      }
      lastSourceDataRow = Math.max(lastSourceDataRow, row.r);
      if (rule.stamp !== null && row.r === rule.stamp && stampXml === null) {
        // Keep this one row for its STYLES only — every value is stripped. The filler clones it.
        let xml = row.xml;
        for (const cell of cellsOf(xml)) {
          const blanked = blankCell(cell);
          if (blanked !== cell) xml = xml.replace(cell, blanked);
        }
        stampXml = xml;
      }
    }

    const rebuilt = head + keptRows.join("") + (stampXml ?? "") + trailerXml.join("") + tail;
    const lastKept = Math.max(rule.stamp ?? rule.keep ?? 1, ...(rule.trailer ?? [0]));
    zip.file(
      sheet.file,
      rebuilt.replace(/<dimension ref="([A-Z]+)\d+:([A-Z]+)\d+"\/>/, `<dimension ref="$1 1:$2${lastKept}"/>`.replace(" 1", "1")),
    );

    manifest.sheets[sheet.name] = {
      file: sheet.file,
      kind: rule.pivot ? "pivot" : "data",
      state: sheet.state,
      headerRows: rule.keep,
      firstDataRow: rule.stamp,
      dataCols: rule.dataCols ?? null,
      trailerRows: rule.trailer ?? [],
      // How far under the last data row the first footnote sat in the owner's own workbook, so the
      // gap he left is reproduced rather than guessed at.
      trailerGap: rule.trailer ? Math.min(...rule.trailer) - lastSourceDataRow : 0,
      volatile: VOLATILE[sheet.name] ?? [],
      stampCells: stampXml
        ? cellsOf(stampXml).map((c) => ({ col: colOf(refOf(c)), s: Number((c.match(/\ss="(\d+)"/) || [])[1] ?? 0) }))
        : [],
      // `r` and `spans` belong to the row being cloned, not to the style — drop both. The leading
      // \s cannot be required: `r="5"` is the FIRST attribute, so its space was already consumed.
      rowAttrs: stampXml
        ? ((stampXml.match(/<row ([^>]*?)\/?>/) || [])[1] ?? "")
            .replace(/\br="\d+"\s*/, "")
            .replace(/\bspans="[^"]*"\s*/, "")
            .trim()
        : "",
    };
    console.log(
      `  ${sheet.name.padEnd(20)} ${String(rows.length).padStart(6)} rows -> ${keptRows.length}${stampXml ? " + 1 stamp" : ""}${trailerXml.length ? ` + ${trailerXml.length} trailer` : ""}`,
    );
  }

  // ── Pivot cache: drop every cached record, and make Excel rebuild it on open ────────────────
  const cacheDefPath = "xl/pivotCache/pivotCacheDefinition1.xml";
  let cacheDef = await zip.file(cacheDefPath).async("string");
  cacheDef = cacheDef.replace(/\srefreshOnLoad="[^"]*"/, "").replace(/<pivotCacheDefinition /, '<pivotCacheDefinition refreshOnLoad="1" ');
  cacheDef = cacheDef.replace(/\srecordCount="\d+"/, ' recordCount="0"');
  // Cached shared items are July's values. Strip them; a refresh repopulates from SalesData.
  //
  // The PAIRED form is collapsed first, and its opening tag must be proven NOT self-closing. Done
  // the other way round — normalise `<sharedItems .../>` first, then collapse pairs — the pair
  // pattern ALSO matches the `<sharedItems/>` just produced, because `[^>]*?` happily matches the
  // `/`; `[\s\S]*?</sharedItems>` then runs on to the NEXT closing tag and eats every cacheField in
  // between. That silently deleted Medical rep, District manager and PRODUCT — the field the Units
  // Matrix puts on its columns — leaving a cache that declared 16 fields and held 13.
  cacheDef = cacheDef
    .replace(/<sharedItems\b(?![^>]*\/>)[^>]*>[\s\S]*?<\/sharedItems>/g, "<sharedItems/>")
    .replace(/<sharedItems\b[^>]*\/>/g, "<sharedItems/>");
  zip.file(cacheDefPath, cacheDef);
  zip.file(
    "xl/pivotCache/pivotCacheRecords1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<pivotCacheRecords xmlns="${XLNS_MAIN}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" count="0"/>`,
  );

  // ── Tables shrink to header + the one stamp row ─────────────────────────────────────────────
  for (const [path, endRow] of [["xl/tables/table1.xml", 2], ["xl/tables/table2.xml", 2]]) {
    let xml = await zip.file(path).async("string");
    xml = xml.replace(/ref="([A-Z]+)1:([A-Z]+)\d+"/g, `ref="$1 1:$2${endRow}"`.replace(" 1", "1"));
    zip.file(path, xml);
  }

  // ── "June Value" becomes "Prior Value" ──────────────────────────────────────────────────────
  // The owner built this engine in July, so the column that holds the month BEFORE the one on
  // screen is named for the month it happened to be. Left alone, a September export ships a table
  // column, a pivot cache field and a Rep Card sentence all saying June over August's numbers —
  // the plausible-and-wrong shape this whole template exists to avoid.
  //
  // The name is a KEY, so every part that spells it has to move together: the two table column
  // definitions, the pivot cache field, the two Data-sheet header cells the tables sit on, and the
  // Rep Card's structured reference into AreaBook. The visible captions are blanked by VOLATILE
  // and written by the filler; only the Rep Card's is a formula, so it reads its month from $N$4.
  const PRIOR_RENAME = [
    "xl/tables/table1.xml",
    "xl/tables/table2.xml",
    "xl/pivotCache/pivotCacheDefinition1.xml",
    "xl/worksheets/sheet9.xml",
    "xl/worksheets/sheet3.xml",
  ];
  let renamed = 0;
  for (const path of PRIOR_RENAME) {
    const before = await zip.file(path).async("string");
    // The replacement is a function, not a string: `$4` in a literal replacement is a capture-group
    // reference, and the `&` it joins with has to reach the XML escaped or the sheet will not parse.
    const after = before
      .replace(/June Value/g, "Prior Value")
      .replace(/"June was "/g, () => '$N$4&amp;" was "');
    renamed += (before.match(/June/g) || []).length;
    zip.file(path, after);
  }
  console.log(`  renamed ${renamed} "June" reference(s) to the month-neutral form`);

  // ── Defined names that carry a row count ────────────────────────────────────────────────────
  // Clamp every row-bearing name to the rows the sheet actually still has. A print area running
  // past the data is not fatal in Excel, but it makes a genuine mismatch invisible later.
  const lastRowOf = {};
  for (const [name, info] of Object.entries(manifest.sheets)) {
    const xml = await zip.file(info.file).async("string");
    const rows = [...xml.matchAll(/<row\b[^>]*?r="(\d+)"/g)].map((m) => Number(m[1]));
    lastRowOf[name] = rows.length ? Math.max(...rows) : 1;
  }
  const clampName = (_match, open, ref, close) => {
    const parsed = ref.match(/^('?)([^'!]+)\1!(\$[A-Z]+\$\d+):(\$[A-Z]+)\$(\d+)$/);
    if (!parsed) return `${open}${ref}${close}`;
    const [, quote, sheetName, first, lastCol] = parsed;
    const last = lastRowOf[sheetName];
    if (!last) return `${open}${ref}${close}`;
    return `${open}${quote}${sheetName}${quote}!${first}:${lastCol}$${last}${close}`;
  };
  let wb = workbookXml;
  wb = wb.replace(/(<definedName name="_xlnm\._FilterDatabase"[^>]*>)([^<]*)(<\/definedName>)/g, clampName);
  wb = wb.replace(/(<definedName name="_xlnm\.Print_Area"[^>]*>)([^<]*)(<\/definedName>)/g, clampName);
  wb = wb.replace(/(<definedName name="PhxPrintArea"[^>]*>)([^<]*)(<\/definedName>)/g, clampName);
  // A FUNCTION replacement, never a string: "$AC$1" in a string replacement is read as capture
  // group 1 and splices the opening tag into the middle of the value, producing a workbook.xml
  // that no longer parses.
  wb = wb.replace(/(<definedName name="PickList">)([^<]*)(<\/definedName>)/, (_m, open, _ref, close) =>
    `${open}Data!$AC$1:$AC$1${close}`);
  zip.file("xl/workbook.xml", wb);
  manifest.lastRowOf = lastRowOf;

  // ── sharedStrings is now unreferenced: every surviving cell became an inline string ─────────
  zip.file(
    "xl/sharedStrings.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<sst xmlns="${XLNS_MAIN}" count="0" uniqueCount="0"/>`,
  );
  // calcChain describes formulas that moved; Excel rebuilds it. A stale one triggers a repair.
  // All THREE references have to go together — the part, its content type, and the relationship.
  // A rel pointing at a part that is not in the zip is itself a repair prompt.
  zip.remove("xl/calcChain.xml");
  let contentTypes = await zip.file("[Content_Types].xml").async("string");
  contentTypes = contentTypes.replace(/<Override PartName="\/xl\/calcChain\.xml"[^>]*\/>/, "");
  zip.file("[Content_Types].xml", contentTypes);
  let workbookRels = relsXml;
  workbookRels = workbookRels.replace(/<Relationship [^>]*Target="calcChain\.xml"[^>]*\/>/, "");
  zip.file("xl/_rels/workbook.xml.rels", workbookRels);

  await addFamilyByMonth(zip, manifest);

  const outDir = resolve(root, "assets/closing-engine");
  mkdirSync(outDir, { recursive: true });
  const out = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
  writeFileSync(resolve(outDir, "template.xlsm"), out);
  writeFileSync(resolve(outDir, "template.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  // The app imports the base64 module, not the .xlsm. Next.js standalone tracing copies what it
  // can see in the import graph; a runtime fs.readFileSync of an asset path is exactly what it
  // cannot see, and the failure only shows up in production. Same reason the Sato logo is
  // embedded rather than read from disk.
  const generated = resolve(root, "src/lib/sales/closing-engine-template-generated.ts");
  const base64 = out.toString("base64");
  const chunks = base64.match(/.{1,120}/g) ?? [];
  writeFileSync(
    generated,
    [
      "// GENERATED FILE — do not edit by hand.",
      "//",
      "// Rebuild with:  node scripts/build-closing-engine-template.mjs <a real closing .xlsm>",
      "//",
      "// This is the owner's closing engine with every row of data removed: the SalesData and",
      "// AreaBook tables, three pivot tables reading the cache BY TABLE NAME, two Region slicers,",
      "// the Rep Card's INDEX/MATCH and SUMIFS formulas, and the VBA button bar — all intact, all",
      "// empty. src/lib/sales/closing-engine-fill.ts pours a month into it.",
      "//",
      `// Built from: ${manifest.builtFrom}`,
      `// Size: ${out.length} bytes`,
      "",
      // An ARRAY joined at load, never a chain of `+`. Concatenating this many string literals
      // builds a left-nested binary-expression tree one node deep per chunk, and at this size
      // ESLint's parser blows its call stack on it -- "Parsing error: Maximum call stack size
      // exceeded", which reads like a broken file rather than a shape it cannot walk. Array
      // elements are siblings at one level, so the tree stays flat however long the template gets.
      "export const CLOSING_ENGINE_TEMPLATE_BASE64 = [",
      ...chunks.map((line) => `  "${line}",`),
      '].join("");',
      "",
      "export const CLOSING_ENGINE_TEMPLATE_MANIFEST = ",
      `${JSON.stringify(manifest, null, 2)} as const;`,
      "",
      "export function closingEngineTemplateBytes(): Buffer {",
      '  return Buffer.from(CLOSING_ENGINE_TEMPLATE_BASE64, "base64");',
      "}",
      "",
    ].join("\n"),
  );

  console.log();
  console.log(`  template.xlsm  ${(out.length / 1024).toFixed(1)} KB   (source ${(readFileSync(source).length / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`  generated .ts  ${((base64.length + 4000) / 1024).toFixed(1)} KB`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
