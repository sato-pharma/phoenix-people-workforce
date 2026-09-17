import assert from "node:assert/strict";
import JSZip from "jszip";

import { checkWorkbook } from "../scripts/check-workbook-integrity.mjs";

// A workbook saved by Python's openpyxl is structurally valid and Excel opens it, but the integrity
// checker read one as badly broken: 14 PROBLEM(S) on the unmapped contacts and pharmacies workbook on
// 2026-09-16. openpyxl spells its relationships two ways ExcelJS never does, and each one broke a
// different rule:
//
//   - an ABSOLUTE target (`/xl/worksheets/sheet1.xml`), which OPC resolves from the package root. The
//     checker glued it onto the .rels folder and reported `xl/xl/worksheets/sheet1.xml` missing — once
//     for every worksheet, drawing and image.
//   - `Target` written BEFORE `Id`. The sheet map was read with a regex that wanted `Id` first, so it
//     came back empty and every autofilter "named an unknown sheet".
//
// A false alarm is not harmless. A checker that cries wolf on a correct file is the state in which a
// real defect stops being read, and the lazy fix — skip absolute targets — would have silenced it on
// every openpyxl file instead. So this pins both directions for both spellings of ONE package: it
// comes back CLEAN, and a dangling target, a defined name past the data and a table past the data are
// still reported, in the same words, however the relationships are written.
//
// The parts are openpyxl 3.1.5's own output for a two-sheet workbook (one merge, one autofilter, one
// image, one table), copied byte for byte; only styles.xml and theme1.xml are cut down, because the
// checker never reads inside them. The ExcelJS spelling is what exceljs writes for the same content:
// `Id` first and every target relative.

type Shape = "openpyxl" | "exceljs";
type Parts = Record<string, string | Uint8Array>;

const RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const DOC_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

/**
 * One relationship, with the target each writer puts in it. openpyxl makes every worksheet, drawing,
 * image and table target absolute but keeps styles, theme and the package's own targets relative —
 * so a single openpyxl package holds both kinds, and both have to resolve.
 */
type Relationship = { exceljs: string; id: string; openpyxl: string; type: string };

const RELATIONSHIPS: Record<string, Relationship[]> = {
  "_rels/.rels": [
    { exceljs: "xl/workbook.xml", id: "rId1", openpyxl: "xl/workbook.xml", type: `${DOC_REL}/officeDocument` },
    { exceljs: "docProps/core.xml", id: "rId2", openpyxl: "docProps/core.xml", type: `${RELS_NS}/metadata/core-properties` },
    { exceljs: "docProps/app.xml", id: "rId3", openpyxl: "docProps/app.xml", type: `${DOC_REL}/extended-properties` },
  ],
  "xl/_rels/workbook.xml.rels": [
    { exceljs: "worksheets/sheet1.xml", id: "rId1", openpyxl: "/xl/worksheets/sheet1.xml", type: `${DOC_REL}/worksheet` },
    { exceljs: "worksheets/sheet2.xml", id: "rId2", openpyxl: "/xl/worksheets/sheet2.xml", type: `${DOC_REL}/worksheet` },
    { exceljs: "styles.xml", id: "rId3", openpyxl: "styles.xml", type: `${DOC_REL}/styles` },
    { exceljs: "theme/theme1.xml", id: "rId4", openpyxl: "theme/theme1.xml", type: `${DOC_REL}/theme` },
  ],
  "xl/worksheets/_rels/sheet1.xml.rels": [
    { exceljs: "../drawings/drawing1.xml", id: "rId1", openpyxl: "/xl/drawings/drawing1.xml", type: `${DOC_REL}/drawing` },
  ],
  "xl/worksheets/_rels/sheet2.xml.rels": [
    { exceljs: "../tables/table1.xml", id: "rId1", openpyxl: "/xl/tables/table1.xml", type: `${DOC_REL}/table` },
  ],
  "xl/drawings/_rels/drawing1.xml.rels": [
    { exceljs: "../media/image1.png", id: "rId1", openpyxl: "/xl/media/image1.png", type: `${DOC_REL}/image` },
  ],
};

/** A .rels part in each writer's own attribute order: openpyxl writes Type, Target, Id; ExcelJS writes Id, Type, Target. */
function relsXml(shape: Shape, relationships: Relationship[]) {
  const rows = relationships.map((rel) =>
    shape === "openpyxl"
      ? `<Relationship Type="${rel.type}" Target="${rel.openpyxl}" Id="${rel.id}"/>`
      : `<Relationship Id="${rel.id}" Type="${rel.type}" Target="${rel.exceljs}"/>`,
  );
  return `<Relationships xmlns="${RELS_NS}">${rows.join("")}</Relationships>`;
}

const CT = "application/vnd.openxmlformats-officedocument";

const CONTENT_PARTS: Parts = {
  "[Content_Types].xml": [
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`,
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`,
    `<Default Extension="xml" ContentType="application/xml"/>`,
    `<Default Extension="png" ContentType="image/png"/>`,
    `<Override PartName="/xl/styles.xml" ContentType="${CT}.spreadsheetml.styles+xml"/>`,
    `<Override PartName="/xl/theme/theme1.xml" ContentType="${CT}.theme+xml"/>`,
    `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>`,
    `<Override PartName="/docProps/app.xml" ContentType="${CT}.extended-properties+xml"/>`,
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="${CT}.spreadsheetml.worksheet+xml"/>`,
    `<Override PartName="/xl/drawings/drawing1.xml" ContentType="${CT}.drawing+xml"/>`,
    `<Override PartName="/xl/worksheets/sheet2.xml" ContentType="${CT}.spreadsheetml.worksheet+xml"/>`,
    `<Override PartName="/xl/tables/table1.xml" ContentType="${CT}.spreadsheetml.table+xml"/>`,
    `<Override PartName="/xl/workbook.xml" ContentType="${CT}.spreadsheetml.sheet.main+xml"/>`,
    `</Types>`,
  ].join(""),
  "docProps/app.xml": [
    `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">`,
    `<Application>Microsoft Excel Compatible / Openpyxl 3.1.5</Application><AppVersion>3.1</AppVersion></Properties>`,
  ].join(""),
  "docProps/core.xml": [
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties">`,
    `<dc:creator xmlns:dc="http://purl.org/dc/elements/1.1/">openpyxl</dc:creator>`,
    `<dcterms:created xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="dcterms:W3CDTF">2026-09-16T13:47:36Z</dcterms:created>`,
    `<dcterms:modified xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="dcterms:W3CDTF">2026-09-16T13:47:36Z</dcterms:modified>`,
    `</cp:coreProperties>`,
  ].join(""),
  "xl/workbook.xml": [
    `<workbook xmlns="${MAIN_NS}"><workbookPr/><workbookProtection/><bookViews>`,
    `<workbookView visibility="visible" minimized="0" showHorizontalScroll="1" showVerticalScroll="1" showSheetTabs="1" tabRatio="600" firstSheet="0" activeTab="0" autoFilterDateGrouping="1"/>`,
    `</bookViews><sheets>`,
    `<sheet xmlns:r="${DOC_REL}" name="Localities" sheetId="1" state="visible" r:id="rId1"/>`,
    `<sheet xmlns:r="${DOC_REL}" name="Bricks" sheetId="2" state="visible" r:id="rId2"/>`,
    `</sheets><definedNames>`,
    `<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'Localities'!$A$1:$C$4</definedName>`,
    `</definedNames><calcPr calcId="124519" fullCalcOnLoad="1"/></workbook>`,
  ].join(""),
  "xl/styles.xml": [
    `<styleSheet xmlns="${MAIN_NS}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>`,
    `<fills count="1"><fill><patternFill/></fill></fills><borders count="1"><border/></borders>`,
    `<cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="1"><xf/></cellXfs></styleSheet>`,
  ].join(""),
  "xl/theme/theme1.xml": `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"/>`,
  // Localities: four data rows under an autofilter, a merged footnote on row 6, and a picture.
  "xl/worksheets/sheet1.xml": [
    `<worksheet xmlns="${MAIN_NS}"><sheetPr><outlinePr summaryBelow="1" summaryRight="1"/><pageSetUpPr/></sheetPr>`,
    `<dimension ref="A1:C6"/><sheetViews><sheetView workbookViewId="0"><selection activeCell="A1" sqref="A1"/></sheetView></sheetViews>`,
    `<sheetFormatPr baseColWidth="8" defaultRowHeight="15"/><sheetData>`,
    `<row r="1"><c r="A1" t="inlineStr"><is><t>Area</t></is></c><c r="B1" t="inlineStr"><is><t>Brick</t></is></c><c r="C1" t="inlineStr"><is><t>Units</t></is></c></row>`,
    `<row r="2"><c r="A2" t="inlineStr"><is><t>Giza</t></is></c><c r="B2" t="inlineStr"><is><t>GZ3</t></is></c><c r="C2" t="n"><v>1</v></c></row>`,
    `<row r="3"><c r="A3" t="inlineStr"><is><t>Cairo</t></is></c><c r="B3" t="inlineStr"><is><t>CA5</t></is></c><c r="C3" t="n"><v>2</v></c></row>`,
    `<row r="4"><c r="A4" t="inlineStr"><is><t>Delta</t></is></c><c r="B4" t="inlineStr"><is><t>D11</t></is></c><c r="C4" t="n"><v>3</v></c></row>`,
    `<row r="6"><c r="A6" t="inlineStr"><is><t>Footnote</t></is></c></row>`,
    `</sheetData><autoFilter ref="A1:C4"/><mergeCells count="1"><mergeCell ref="A6:C6"/></mergeCells>`,
    `<pageMargins left="0.75" right="0.75" top="1" bottom="1" header="0.5" footer="0.5"/>`,
    `<drawing xmlns:r="${DOC_REL}" r:id="rId1"/></worksheet>`,
  ].join(""),
  "xl/drawings/drawing1.xml": [
    `<wsDr xmlns="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"><oneCellAnchor>`,
    `<from><col>4</col><colOff>0</colOff><row>1</row><rowOff>0</rowOff></from><ext cx="38100" cy="38100"/>`,
    `<pic><nvPicPr><cNvPr id="1" name="Image 1" descr="Picture"/><cNvPicPr/></nvPicPr><blipFill>`,
    `<a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${DOC_REL}" cstate="print" r:embed="rId1"/>`,
    `<a:stretch xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:fillRect/></a:stretch></blipFill>`,
    `<spPr><a:prstGeom xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" prst="rect"/></spPr></pic>`,
    `<clientData/></oneCellAnchor></wsDr>`,
  ].join(""),
  "xl/media/image1.png": Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAE0lEQVR4nGPkCqplgAEmOAsvBwAq8wDhvoGYOwAAAABJRU5ErkJggg==",
    "base64",
  ),
  // Bricks: a header and two rows, all inside one table.
  "xl/worksheets/sheet2.xml": [
    `<worksheet xmlns="${MAIN_NS}"><sheetPr><outlinePr summaryBelow="1" summaryRight="1"/><pageSetUpPr/></sheetPr>`,
    `<dimension ref="A1:B3"/><sheetViews><sheetView workbookViewId="0"><selection activeCell="A1" sqref="A1"/></sheetView></sheetViews>`,
    `<sheetFormatPr baseColWidth="8" defaultRowHeight="15"/><sheetData>`,
    `<row r="1"><c r="A1" t="inlineStr"><is><t>Brick</t></is></c><c r="B1" t="inlineStr"><is><t>Area</t></is></c></row>`,
    `<row r="2"><c r="A2" t="inlineStr"><is><t>GZ3</t></is></c><c r="B2" t="inlineStr"><is><t>Giza</t></is></c></row>`,
    `<row r="3"><c r="A3" t="inlineStr"><is><t>CA5</t></is></c><c r="B3" t="inlineStr"><is><t>Cairo</t></is></c></row>`,
    `</sheetData><pageMargins left="0.75" right="0.75" top="1" bottom="1" header="0.5" footer="0.5"/>`,
    `<tableParts count="1"><tablePart xmlns:r="${DOC_REL}" r:id="rId1"/></tableParts></worksheet>`,
  ].join(""),
  "xl/tables/table1.xml": [
    `<table id="1" name="BrickTable" displayName="BrickTable" ref="A1:B3" headerRowCount="1" xmlns="${MAIN_NS}">`,
    `<autoFilter ref="A1:B3"/><tableColumns count="2"><tableColumn id="1" name="Brick"/><tableColumn id="2" name="Area"/></tableColumns></table>`,
  ].join(""),
};

/**
 * Change one part before it is zipped. The text has to be there: an edit that silently matched
 * nothing would hand the checker the CLEAN package, and a "still reported" assertion would then
 * be testing nothing. A replacer function, because `$A$1` in a replacement STRING is a pattern.
 */
function replaceIn(parts: Parts, name: string, from: string, to: string) {
  const body = parts[name];
  assert.ok(typeof body === "string" && body.includes(from), `fixture edit: ${name} must contain ${from}`);
  parts[name] = body.replace(from, () => to);
}

async function problemsFor(shape: Shape, edit: (parts: Parts) => void = () => {}) {
  const parts: Parts = { ...CONTENT_PARTS };
  for (const [name, relationships] of Object.entries(RELATIONSHIPS)) parts[name] = relsXml(shape, relationships);
  edit(parts);
  const zip = new JSZip();
  for (const [name, body] of Object.entries(parts)) zip.file(name, body);
  return checkWorkbook(await zip.generateAsync({ type: "nodebuffer" }), { quiet: true });
}

export async function runCheckWorkbookIntegrityAbsoluteTargetsTests() {
  for (const shape of ["openpyxl", "exceljs"] as const) {
    // ── 1. a correct package is CLEAN, however its relationships are spelled ──────────────────────
    const clean = await problemsFor(shape);
    assert.deepEqual(
      clean,
      [],
      `a correct workbook spelled the ${shape} way must come back CLEAN — an absolute target resolves from the package root, and Target may come before Id: ${clean.join("; ")}`,
    );

    // ── 2. a relationship to a part that is not there is still reported, at the part it names ────
    const dangling = await problemsFor(shape, (parts) =>
      replaceIn(parts, "xl/drawings/_rels/drawing1.xml.rels", "image1.png", "image9.png"),
    );
    assert.deepEqual(
      dangling,
      ["relationship in xl/drawings/_rels/drawing1.xml.rels points at missing xl/media/image9.png"],
      `a dangling ${shape} target must still be reported — resolving absolute targets must not mean skipping them`,
    );

    // ── 3. a defined name past the data is still measured against its own sheet ──────────────────
    const filter = await problemsFor(shape, (parts) => replaceIn(parts, "xl/workbook.xml", "$A$1:$C$4", "$A$1:$C$40"));
    assert.deepEqual(
      filter,
      ["defined name _xlnm._FilterDatabase ends at row 40 but Localities has 6 rows"],
      `the ${shape} workbook's sheet map must be built, so a defined name is measured against its sheet rather than reported as naming an unknown one`,
    );

    // ── 4. a table past the data is still measured against the sheet that owns it ────────────────
    const table = await problemsFor(shape, (parts) =>
      replaceIn(parts, "xl/tables/table1.xml", `ref="A1:B3"`, `ref="A1:B30"`),
    );
    assert.deepEqual(
      table,
      ["table BrickTable: ref ends at row 30 but Bricks has 3 rows"],
      `the ${shape} table must find the sheet whose relationships name it, or its row bound is never checked`,
    );
  }
}
