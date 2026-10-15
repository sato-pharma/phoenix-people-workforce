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
//   4b. no two merged ranges share a cell                <- it discards ALL merges on the sheet
//   5. table refs, defined names and the pivot cache agree with the sheet they describe
//
// EVERY rule here was added AFTER a workbook shipped broken, and each one covers exactly the defect
// that shipped. That is the honest description of this file and the reason the dialog keeps coming
// back: a CLEAN verdict means "none of the five things we have already been bitten by", never "Excel
// will open this". When the next one gets through, read Excel's own recovery log — it names the
// part and the record kind, and it is written to %TEMP%\error<digits>_01.xml the moment the reader
// clicks Yes — then add the rule here before fixing the cause, so the class cannot come back
// silently.
//
// Usage:  node scripts/check-workbook-integrity.mjs <workbook> [--quiet]

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import JSZip from "jszip";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "check-workbook-integrity",
  entry: import.meta.url,
  known: [],
});

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

/** XML entities, decoded. Sheet names reach these parts escaped; the comparisons below do not. */
const decodeEntities = (text) =>
  String(text)
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/**
 * The `<sheet>` entries of workbook.xml, in order.
 *
 * ATTRIBUTE ORDER IS NOT FIXED IN OOXML and ExcelJS writes `sheetId` before `name`, so the two
 * regexes this replaced — both anchored on `<sheet name=` — matched nothing at all against an
 * ExcelJS workbook. That did not fail loudly: the sheet list came back EMPTY, so every defined
 * name reported an unknown sheet and every localSheetId reported as out of range. Seven false
 * alarms on a correct file, which is the state in which a real one stops being read.
 */
const sheetTags = (workbookXml) =>
  [...workbookXml.matchAll(/<sheet\s[^>]*>/g)].map((match) => ({
    name: decodeEntities((match[0].match(/(?:^|\s)name="([^"]*)"/) ?? [])[1] ?? ""),
    rid: (match[0].match(/r:id="(rId\d+)"/) ?? [])[1] ?? null,
  }));

/** A part path with `.` and `..` walked and empty segments dropped: `xl/worksheets/../tables/t.xml` is `xl/tables/t.xml`. */
const normalizePart = (path) =>
  path
    .split("/")
    .reduce((acc, part) => {
      if (part === "..") acc.pop();
      else if (part !== "." && part !== "") acc.push(part);
      return acc;
    }, [])
    .join("/");

/**
 * The `<Relationship>` entries of one .rels part, each with the zip entry its target names — `part`
 * is null for a target that is not a part of this package.
 *
 * ATTRIBUTE ORDER IS NOT FIXED HERE EITHER. ExcelJS writes `Id` first; openpyxl writes `Type`, then
 * `Target`, then `Id`. The regex this replaced in rule 5 — `Id="…"[^>]*Target="…"` — matched nothing
 * in an openpyxl workbook.xml.rels, the sheet map came back EMPTY, and every autofilter reported
 * "defined name _xlnm._FilterDatabase names unknown sheet" on a correct file. It is the trap
 * `sheetTags` above records for `<sheet>`, one part further along.
 *
 * A TARGET THAT STARTS WITH `/` IS AN ABSOLUTE PART NAME and resolves from the PACKAGE ROOT — valid
 * OPC (ECMA-376 Part 2), and Excel opens it. Only a relative target resolves against the folder of
 * the part the .rels describes. openpyxl writes every worksheet, drawing, image and table target
 * absolute, and rule 3 glued that onto the folder: `xl/` + `/xl/worksheets/sheet1.xml` became
 * `xl/xl/worksheets/sheet1.xml`, reported missing. The unmapped contacts and pharmacies workbook
 * (openpyxl, 2026-09-16) printed 14 PROBLEM(S) — ten of these and the four unknown sheets — and the
 * same parts with the targets rewritten relative and `Id` moved first came back CLEAN. One package
 * holds both kinds: openpyxl writes its styles and theme targets relative.
 */
const relationshipsOf = (relsName, relsXml = "") => {
  // A .rels part describes the part it is named after: `xl/_rels/workbook.xml.rels` belongs to
  // `xl/workbook.xml`, so its relative targets start in `xl/`; the package's own `_rels/.rels`
  // starts at the root.
  const folder = relsName.replace(/_rels\/[^/]*$/, "");
  return [...relsXml.matchAll(/<Relationship\b[^>]*>/g)].map((match) => {
    const attributes = Object.fromEntries(
      [...match[0].matchAll(/([A-Za-z_:][\w.:-]*)\s*=\s*"([^"]*)"/g)].map((attr) => [attr[1], decodeEntities(attr[2])]),
    );
    const target = attributes.Target ?? "";
    // `#'Sheet'!A1` is a FRAGMENT target: it names a place in the document, not a part in the
    // package, and legitimately carries no TargetMode because it never leaves the file. Excel
    // writes these for a shape that jumps to another sheet. Resolved as a path it becomes
    // `xl/drawings/#'Sheet'!A1` and is reported missing — which reads as a corrupt workbook when
    // the workbook is fine.
    const internal =
      target !== "" && attributes.TargetMode !== "External" && !/^https?:/.test(target) && !target.startsWith("#");
    return {
      id: attributes.Id ?? null,
      part: internal ? normalizePart(target.startsWith("/") ? target : folder + target) : null,
    };
  });
};

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
    for (const { part } of relationshipsOf(name, text[name])) {
      if (!part) continue;
      relCount += 1;
      if (!names.includes(part)) note(`relationship in ${name} points at missing ${part}`);
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

  // ── 4b. no two merged ranges touch the same cell ────────────────────────────
  //
  // Excel refuses a sheet whose merges overlap. It does not repair the offending record — it
  // discards EVERY merge on that sheet and says so in its recovery log: "Removed Records: Merge
  // cells from /xl/worksheets/sheet1.xml part". The reader gets the "We found a problem with some
  // content" dialog, then a page whose headings and footnotes have all snapped back to one column.
  //
  // Nothing above sees it. Repeated merges parse, carry a content type, break no relationship and
  // leave the rows in order, so a workbook holding three copies of one range passes rules 1–6 and
  // prints CLEAN — which is exactly what this script said about the premium closing export the
  // owner could not open on 2026-09-08.
  //
  // Equality is not the test. `B21:J21` twice is the shape that shipped, but a partial overlap
  // (`B21:J21` against `A21:C21`) is refused just the same, so what is asked is whether two
  // rectangles share a cell at all.
  let mergeCount = 0;
  const beforeMerges = problems.length;
  for (const name of names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))) {
    const block = (text[name].match(/<mergeCells\b[^>]*>[\s\S]*?<\/mergeCells>/) ?? [])[0];
    if (!block) continue;
    const declared = Number((block.match(/<mergeCells\b[^>]*count="(\d+)"/) ?? [])[1] ?? NaN);
    const refs = [...block.matchAll(/<mergeCell\b[^>]*\sref="([A-Z]+\d+:[A-Z]+\d+)"/g)].map((m) => m[1]);
    if (Number.isFinite(declared) && declared !== refs.length) {
      note(`${name}: mergeCells declares ${declared} but holds ${refs.length}`);
    }
    mergeCount += refs.length;
    const boxes = [];
    for (const ref of refs) {
      const [, c1, r1, c2, r2] = ref.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/) ?? [];
      const box = {
        bottom: Math.max(Number(r1), Number(r2)),
        left: Math.min(colIndex(c1), colIndex(c2)),
        ref,
        right: Math.max(colIndex(c1), colIndex(c2)),
        top: Math.min(Number(r1), Number(r2)),
      };
      const hit = boxes.find(
        (other) =>
          box.left <= other.right && other.left <= box.right && box.top <= other.bottom && other.top <= box.bottom,
      );
      if (hit) {
        note(
          hit.ref === box.ref
            ? `${name}: merge ${box.ref} appears more than once`
            : `${name}: merge ${box.ref} overlaps ${hit.ref}`,
        );
      }
      boxes.push(box);
    }
  }
  const mergeFaults = problems.length - beforeMerges;
  say(`  4b. merged ranges    ${mergeCount} merges${mergeFaults ? `, ${mergeFaults} overlapping` : ", none overlapping"}`);

  // ── 5. tables, defined names and the pivot cache agree with their sheets ─────
  const lastRowOf = (sheetFile) => {
    const rows = [...(text[sheetFile] ?? "").matchAll(/<row\b[^>]*?r="(\d+)"/g)].map((m) => Number(m[1]));
    return rows.length ? Math.max(...rows) : 0;
  };
  const workbook = text["xl/workbook.xml"] ?? "";
  const partByRid = Object.fromEntries(
    relationshipsOf("xl/_rels/workbook.xml.rels", text["xl/_rels/workbook.xml.rels"]).map((rel) => [rel.id, rel.part]),
  );
  const sheetFileByName = {};
  for (const tag of sheetTags(workbook)) {
    if (tag.rid && partByRid[tag.rid]) sheetFileByName[tag.name] = partByRid[tag.rid];
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
    // The table must live inside the sheet that owns it: the sheet whose own relationships resolve
    // to this table part. This used to look for the substring `../tables/table1.xml` in the sheet's
    // .rels, which an openpyxl sheet never contains (it writes `/xl/tables/table1.xml`) — so an
    // openpyxl table found no owner and its row bound was skipped without a word.
    const owner = Object.entries(sheetFileByName).find(([, file]) => {
      const relsFile = file.replace(/[^/]*$/, (base) => `_rels/${base}.rels`);
      return relationshipsOf(relsFile, text[relsFile]).some((rel) => rel.part === name);
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
    const [, dnName, rawValue] = m;
    // A defined name whose sheet has a space is written quoted, and XML escapes that quote as
    // &apos;. Matching the raw text made EVERY such name read as pointing at a sheet called
    // "&apos;Lookup Data&apos;" — 6 false alarms on a workbook that was correct, which is how a
    // real one gets waved through.
    const value = decodeEntities(rawValue);
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
  // Attribute ORDER is not fixed in OOXML, and ExcelJS writes sheetId before name — so a regex
  // anchored on `<sheet name=` matched nothing at all, and this whole check silently passed on an
  // empty list while reporting every localSheetId as "out of range".
  const sheetOrder = sheetTags(workbook).map((tag) => tag.name);
  let misplaced = 0;
  for (const m of workbook.matchAll(/<definedName name="([^"]*)" localSheetId="(\d+)"[^>]*>([^<]*)<\/definedName>/g)) {
    const [, dnName, index, value] = m;
    const named = decodeEntities(value).match(/^'?([^'!]+)'?!/);
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
