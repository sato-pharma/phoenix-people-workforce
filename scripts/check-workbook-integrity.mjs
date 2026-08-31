#!/usr/bin/env node
// Structural integrity check for a generated .xlsx / .xlsm.
//
// Excel does not tell you WHICH part it repaired — it says "We found a problem with some content"
// and silently drops whatever offended it, which for this workbook means the pivots, the slicers or
// the VBA. So every defect that produces that dialog gets caught here instead, before anyone opens
// the file:
//
//   1. every XML part actually parses, and no tag repeats an attribute
//   2. every part has a content type
//   3. every relationship points at a part that exists   <- a dangling calcChain rel lives here
//   4. rows ascend, and cells ascend within their row     <- Excel is strict about this
//   5. table refs, defined names and the pivot cache agree with the sheet they describe
//
// Usage:  node scripts/check-workbook-integrity.mjs <workbook> [--quiet]

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import JSZip from "jszip";

const require = createRequire(import.meta.url);

// sax is present in the pnpm store but not hoisted to the top level; resolve it directly rather
// than adding a dependency for a check script.
function loadSax() {
  try {
    return require("sax");
  } catch {
    /* not hoisted — look it up in the pnpm store */
  }
  try {
    const { readdirSync } = require("node:fs");
    const { resolve, dirname } = require("node:path");
    const { fileURLToPath } = require("node:url");
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const store = resolve(root, "node_modules/.pnpm");
    const entry = readdirSync(store).find((name) => /^sax@/.test(name));
    if (entry) return require(resolve(store, entry, "node_modules/sax"));
  } catch {
    /* fall through to the balance check */
  }
  return null;
}

const colIndex = (letters) => [...letters].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0);

export async function checkWorkbook(bytes, { quiet = false } = {}) {
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  const problems = [];
  const note = (message) => problems.push(message);
  const say = (line) => {
    if (!quiet) console.log(line);
  };

  const text = {};
  for (const name of names) {
    if (name.endsWith(".xml") || name.endsWith(".rels")) text[name] = await zip.file(name).async("string");
  }

  // ── 1. parse ────────────────────────────────────────────────────────────────
  const sax = loadSax();
  for (const [name, xml] of Object.entries(text)) {
    if (!sax) break;
    const parser = sax.parser(true);
    let failure = null;
    parser.onerror = (error) => {
      failure = error.message.split("\n")[0];
      parser.resume();
    };
    parser.write(xml).close();
    if (failure) note(`XML parse: ${name}: ${failure}`);
  }
  say(`  1. parse             ${sax ? `${Object.keys(text).length} parts` : "SKIPPED (no sax)"}`);

  // ── 1b. no tag repeats an attribute ─────────────────────────────────────────
  // A tag carrying the same attribute twice is not well-formed XML, but a lenient parser simply
  // keeps the last one and says nothing — so it has to be looked for on purpose. It is exactly
  // what a row-cloning bug produces: `<row r="10" spans="2:10" r="9">` carries the STAMP row's
  // number alongside the new one, every row reads as row 9, and Excel repairs the sheet rather
  // than opening it. Check 4 below cannot see this — its own regex stops at the first `r`.
  const attribute = /([A-Za-z_:][\w.:-]*)\s*=\s*"/g;
  let tagCount = 0;
  for (const [name, xml] of Object.entries(text)) {
    for (const tag of xml.matchAll(/<[A-Za-z_][\w.:-]*(\s+[A-Za-z_:][\w.:-]*\s*=\s*"[^"]*")+\s*\/?>/g)) {
      tagCount += 1;
      const seen = new Set();
      for (const attr of tag[0].matchAll(attribute)) {
        if (seen.has(attr[1])) note(`${name}: a tag repeats the attribute ${attr[1]} — ${tag[0].slice(0, 140)}`);
        seen.add(attr[1]);
      }
    }
  }
  say(`  1b. attributes       ${tagCount} tags`);

  // ── 2. content types ────────────────────────────────────────────────────────
  const ct = text["[Content_Types].xml"] ?? "";
  const defaults = new Set([...ct.matchAll(/<Default Extension="([^"]*)"/g)].map((m) => m[1].toLowerCase()));
  const overrides = new Set([...ct.matchAll(/<Override PartName="([^"]*)"/g)].map((m) => m[1]));
  for (const name of names) {
    if (name === "[Content_Types].xml") continue;
    const ext = (name.split(".").pop() ?? "").toLowerCase();
    if (!overrides.has(`/${name}`) && !defaults.has(ext)) note(`no content type: ${name}`);
  }
  for (const part of overrides) if (!names.includes(part.slice(1))) note(`content type names a missing part: ${part}`);
  say(`  2. content types     ${overrides.size} overrides`);

  // ── 3. relationships ────────────────────────────────────────────────────────
  let relCount = 0;
  for (const name of names.filter((n) => n.endsWith(".rels"))) {
    const base = name.replace(/_rels\/[^/]*$/, "");
    for (const m of text[name].matchAll(/<Relationship\b[^>]*>/g)) {
      const target = (m[0].match(/Target="([^"]*)"/) ?? [])[1];
      if (!target || /TargetMode="External"/.test(m[0]) || /^https?:/.test(target)) continue;
      relCount += 1;
      const joined = base + target;
      const resolved = joined.split("/").reduce((acc, part) => {
        if (part === "..") acc.pop();
        else if (part !== "." && part !== "") acc.push(part);
        return acc;
      }, []).join("/");
      if (!names.includes(resolved)) note(`relationship in ${name} points at missing ${resolved}`);
    }
  }
  say(`  3. relationships     ${relCount} internal`);

  // ── 4. row and cell ordering ────────────────────────────────────────────────
  let rowCount = 0;
  for (const name of names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))) {
    let lastRow = 0;
    for (const rm of text[name].matchAll(/<row\b[^>]*?r="(\d+)"[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const r = Number(rm[1]);
      rowCount += 1;
      if (r <= lastRow) note(`${name}: row ${r} follows row ${lastRow}`);
      lastRow = r;
      let lastCol = 0;
      for (const cm of (rm[2] ?? "").matchAll(/<c\b[^>]*?r="([A-Z]+)(\d+)"/g)) {
        const ci = colIndex(cm[1]);
        if (ci <= lastCol) note(`${name}: cell ${cm[1]}${r} is out of column order`);
        if (Number(cm[2]) !== r) note(`${name}: cell ${cm[1]}${cm[2]} sits inside row ${r}`);
        lastCol = ci;
      }
    }
  }
  say(`  4. row/cell order    ${rowCount} rows`);

  // ── 5. tables, defined names and the pivot cache agree with their sheets ─────
  const lastRowOf = (sheetFile) => {
    const rows = [...(text[sheetFile] ?? "").matchAll(/<row\b[^>]*?r="(\d+)"/g)].map((m) => Number(m[1]));
    return rows.length ? Math.max(...rows) : 0;
  };
  const workbook = text["xl/workbook.xml"] ?? "";
  const wbRels = text["xl/_rels/workbook.xml.rels"] ?? "";
  const relTarget = Object.fromEntries([...wbRels.matchAll(/Id="(rId\d+)"[^>]*Target="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  const sheetFileByName = {};
  for (const m of workbook.matchAll(/<sheet name="([^"]*)"[^>]*r:id="(rId\d+)"/g)) {
    sheetFileByName[m[1]] = `xl/${relTarget[m[2]]}`;
  }

  for (const name of names.filter((n) => /^xl\/tables\/table\d+\.xml$/.test(n))) {
    const tableName = (text[name].match(/\sname="([^"]*)"/) ?? [])[1];
    const ref = (text[name].match(/\sref="([A-Z]+\d+:[A-Z]+\d+)"/) ?? [])[1];
    const columns = Number((text[name].match(/<tableColumns count="(\d+)"/) ?? [])[1] ?? 0);
    if (!ref) {
      note(`${name}: no ref`);
      continue;
    }
    const [, startCol, , endCol] = ref.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/) ?? [];
    const span = colIndex(endCol) - colIndex(startCol) + 1;
    if (span !== columns) note(`table ${tableName}: ref ${ref} spans ${span} columns but declares ${columns}`);
    // The table must live inside the sheet that owns it.
    const owner = Object.entries(sheetFileByName).find(([, file]) => {
      const relFile = file.replace("worksheets/", "worksheets/_rels/") + ".rels";
      return (text[relFile] ?? "").includes(name.replace("xl/", "../"));
    });
    if (owner) {
      const last = lastRowOf(owner[1]);
      const end = Number(ref.match(/(\d+)$/)[1]);
      if (end > last) note(`table ${tableName}: ref ends at row ${end} but ${owner[0]} has ${last} rows`);
    }
  }

  const cacheDef = text["xl/pivotCache/pivotCacheDefinition1.xml"];
  if (cacheDef) {
    const source = (cacheDef.match(/<worksheetSource[^>]*\/>/) ?? [])[0] ?? "";
    if (!/name="/.test(source)) note("pivot cache source is not a named table — it will not grow with the data");
    const records = text["xl/pivotCache/pivotCacheRecords1.xml"] ?? "";
    const declared = Number((cacheDef.match(/recordCount="(\d+)"/) ?? [])[1] ?? 0);
    const actual = (records.match(/<r>/g) ?? []).length;
    if (declared !== actual) note(`pivot cache declares ${declared} records but holds ${actual}`);
    if (!/refreshOnLoad="1"/.test(cacheDef)) note("pivot cache is not set to refresh on load — pivots open stale");

    // A cache that declares more fields than it holds is how a pivot loses the field it lays out
    // on. It is invisible from the sheet — the pivot renders from its own stale layout until the
    // refresh, and only then collapses — so the counts are compared here instead.
    const declaredFields = Number((cacheDef.match(/<cacheFields count="(\d+)"/) ?? [])[1] ?? 0);
    const heldFields = ((cacheDef.match(/<cacheFields[^>]*>([\s\S]*?)<\/cacheFields>/) ?? [])[1] ?? "")
      .match(/<cacheField\b/g);
    const held = heldFields ? heldFields.length : 0;
    if (declaredFields !== held) note(`pivot cache declares ${declaredFields} fields but holds ${held}`);
    for (const name of names.filter((n) => /^xl\/pivotTables\/pivotTable\d+\.xml$/.test(n))) {
      const wants = Number((text[name].match(/<pivotFields count="(\d+)"/) ?? [])[1] ?? 0);
      if (wants && wants !== held) {
        const table = (text[name].match(/<pivotTableDefinition[^>]*\sname="([^"]*)"/) ?? [])[1] ?? name;
        note(`pivot ${table} lays out ${wants} fields but the cache holds ${held}`);
      }
    }
  }

  for (const m of workbook.matchAll(/<definedName name="([^"]*)"(?: localSheetId="\d+")?[^>]*>([^<]*)<\/definedName>/g)) {
    const [, dnName, value] = m;
    const sheetRef = value.match(/^'?([^'!]+)'?!\$[A-Z]+\$\d+:\$[A-Z]+\$(\d+)$/);
    if (!sheetRef) continue;
    const file = sheetFileByName[sheetRef[1]];
    if (!file) {
      note(`defined name ${dnName} names unknown sheet ${sheetRef[1]}`);
      continue;
    }
    const last = lastRowOf(file);
    if (Number(sheetRef[2]) > last) note(`defined name ${dnName} ends at row ${sheetRef[2]} but ${sheetRef[1]} has ${last} rows`);
  }
  say(`  5. refs agree        tables, cache, defined names`);

  // ── 6. every localSheetId points at the sheet its own range names ────────────
  // `localSheetId` is a POSITION in the sheet order, not an id. Insert or reorder a sheet and every
  // print area, print title and autofilter after it keeps the number it had — so it stays attached
  // to the position, and quietly moves to a different sheet. Nothing above can see it: the file is
  // valid, every part resolves, every range is in bounds, and Excel opens it without a murmur. It
  // shows up only as the wrong page coming out of a printer, which is the one place a reader will
  // not think to blame the export.
  const sheetOrder = [...workbook.matchAll(/<sheet name="([^"]*)"/g)].map((m) => m[1]);
  let misplaced = 0;
  for (const m of workbook.matchAll(/<definedName name="([^"]*)" localSheetId="(\d+)"[^>]*>([^<]*)<\/definedName>/g)) {
    const [, dnName, index, value] = m;
    const named = value.match(/^'?([^'!]+)'?!/);
    if (!named) continue;
    const owner = sheetOrder[Number(index)];
    if (owner !== named[1]) {
      misplaced += 1;
      note(`defined name ${dnName} is attached to sheet ${index} (${owner ?? "out of range"}) but its range names ${named[1]}`);
    }
  }
  say(`  6. sheet-local names ${sheetOrder.length} sheets${misplaced ? `, ${misplaced} misplaced` : ", all on their own sheet"}`);

  return problems;
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("check-workbook-integrity.mjs");
if (invokedDirectly) {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: node scripts/check-workbook-integrity.mjs <workbook>");
    process.exit(1);
  }
  const problems = await checkWorkbook(readFileSync(target));
  console.log();
  if (problems.length === 0) {
    console.log(`  CLEAN — ${target}`);
  } else {
    console.log(`  ${problems.length} PROBLEM(S) — ${target}`);
    for (const problem of problems) console.log(`    - ${problem}`);
    process.exit(1);
  }
}
