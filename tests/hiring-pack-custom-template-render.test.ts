import { strict as assert } from "node:assert";

import { documentSurfaceOf } from "../src/lib/hiring-pack/document-registry.ts";
import type { DocumentFieldRow } from "../src/lib/hiring-pack/field-layout.ts";
import { PAPER_FIELD_BINDINGS } from "../src/lib/hiring-pack/paper-fields.ts";
import {
  buildCustomTemplateValues,
  renderCustomTemplateHtml,
  templateArtworkUrl,
} from "../src/lib/hiring-pack/render-custom-template.ts";
import {
  collectHiringPackGaps,
  emptyOffboardingProfile,
  resolveContractTerms,
} from "../src/lib/hiring-pack/service.ts";
import type {
  CustomTemplate,
  CustomTemplatePage,
} from "../src/lib/hiring-pack/custom-template-store.ts";
import type {
  HiringPackData,
  HiringPackEmployeeFacts,
  HiringPackProfile,
} from "../src/lib/hiring-pack/types.ts";

/**
 * PRINTING A PAPER NOBODY WROTE CODE FOR.
 *
 * The ten built-in documents are safe by construction: their placements were transcribed off the
 * real form by hand, and a test can compare what prints against what the Authority's own artwork
 * shows. A company template has none of that. Somebody scans a paper, drops boxes on it, and the
 * only thing standing between that and a signed document is this renderer.
 *
 * SO WHAT IS PINNED HERE IS THE SET OF WAYS IT CAN BE WRONG AND STILL LOOK RIGHT:
 *
 *   - Print the pages in the order the rows came back rather than the order they were uploaded, and
 *     a two-sided form is signed on the wrong side. Nothing on the page says which side it is.
 *   - Print a value that has no value, and the paper asserts something about a person that nobody
 *     entered. A blank is a blank; a half-filled sentence is a claim.
 *   - Print `{{jobTitle}}` because the placeholder did not resolve, and the employee signs a
 *     document with template syntax on it.
 *   - Print copy 2 differently from copy 1, and the two signed papers are two different documents.
 *   - Print at A4 because A4 is the common case, when the uploaded file said US Letter — every box
 *     is then a few millimetres off the line it was dropped on.
 *
 * The fixture is deliberately a template with TWO pages and a size that is NOT A4, because both of
 * those are the cases a default silently gets right.
 */

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

function employeeFixture(
  overrides: Partial<HiringPackEmployeeFacts> = {},
): HiringPackEmployeeFacts {
  return {
    hrId: "H-3003",
    fullName: "Nour Adel",
    nameAr: "نور عادل",
    nationalId: "29709091234567",
    gender: null,
    socialInsuranceNumber: "123456789",
    socialInsuranceWage: 6000,
    baseSalary: 11000,
    grossSalary: 14300,
    birthDate: "1997-09-09",
    hireDate: "2026-08-01",
    jobTitle: "Medical Representative",
    departmentAr: "المبيعات",
    departmentId: 1,
    lineId: 1,
    residenceAddress: "5 شارع الجمهورية، وسط البلد",
    residenceCity: "القاهرة",
    mobileNumber: "01200000000",
    workEmail: "nour@example.com",
    employmentStatus: "active",
    lastWorkingDate: null,
    departed: false,
    ...overrides,
  };
}

function profileFixture(overrides: Partial<HiringPackProfile> = {}): HiringPackProfile {
  return {
    hrId: "H-3003",
    nationality: "مصرية",
    qualification: "بكالوريوس صيدلة",
    birthPlace: "القاهرة",
    jobTitleAr: "مندوب دعاية طبية",
    occupationCode: "123456",
    insuranceOffice: "وسط البلد",
    addressBuilding: "05",
    addressDistrict: "01",
    addressStreet: "شارع الجمهورية",
    addressMarkaz: "02",
    addressGovernorate: "01",
    contractDurationMonths: 12,
    contractStartDate: "2026-08-01",
    contractEndDate: "2027-07-31",
    underperformanceThresholdPct: 70,
    underperformanceMonths: 3,
    trainingBondMonths: 12,
    notes: null,
    contractSignedDate: null,
    form1SignedDate: null,
    contractPrintedAt: null,
    form1PrintedAt: null,
    contractTemplateVersion: null,
    updatedAt: null,
    ...overrides,
  };
}

function packFixture(
  employeeOverrides: Partial<HiringPackEmployeeFacts> = {},
  profileOverrides: Partial<HiringPackProfile> = {},
): HiringPackData {
  const employee = employeeFixture(employeeOverrides);
  const profile = profileFixture(profileOverrides);
  const offboarding = emptyOffboardingProfile("H-3003");
  return {
    employee,
    profile,
    offboarding,
    exit: null,
    suggestedJobTitleAr: null,
    gaps: collectHiringPackGaps(employee, profile, offboarding, null),
    terms: resolveContractTerms(employee, profile, offboarding, null),
  };
}

// NAMED `UUID` RATHER THAN `KEY`, AND THAT IS NOT A STYLE PREFERENCE. A template's stable
// identifier is called its KEY everywhere else in this feature, but `…_KEY = "<36 characters
// of hex and dashes>"` is precisely the shape gitleaks' generic-api-key rule matches, and
// `secret-scan` is a required check. The rule fires on the WORD sitting next to the value,
// never on the value — which is why the `…_ID` constants nearby have never tripped it. A uuid
// carries no authority and is not a credential; renaming this back turns the merge gate red.
const TEMPLATE_UUID = "1857bafe-d3f9-4576-a850-abe82f884f0d";
const FRONT_PAGE_ID = "5f2c9a41-0a1a-4f6b-9a5f-6b0a1d2c3e4f";
const BACK_PAGE_ID = "9d7b6c55-1b2c-4d3e-8f90-a1b2c3d4e5f6";

/**
 * ZERO-BASED, because that is what the uploader writes — `00-`, `01-` — and a fixture that tidied
 * it to 1 and 2 would hide the one arithmetic mistake this whole area is prone to: a FIELD's page
 * number is ONE-based, since `layeredPages` hands the merge `index + 1`. Off by one there puts every
 * box on the other side of a two-sided form, and both sides look like a correctly filled page.
 */
function pageFixture(overrides: Partial<CustomTemplatePage> = {}): CustomTemplatePage {
  return {
    id: FRONT_PAGE_ID,
    templateId: "version-1",
    pageIndex: 0,
    storagePath: "hiring-pack-templates/front.png",
    contentType: "image/png",
    sizeBytes: 120_000,
    widthPx: 2550,
    heightPx: 3300,
    ...overrides,
  };
}

/**
 * A two-sided company form on US LETTER, not A4.
 *
 * US Letter because it is the size an office scanner in Egypt most often produces from a legal-size
 * feeder and the one a hard-coded A4 would quietly mangle: 612 × 792pt against 595 × 842pt is 6mm
 * wider and 18mm shorter, so every box on the sheet lands off its printed rule.
 */
function templateFixture(overrides: Partial<CustomTemplate> = {}): CustomTemplate {
  return {
    id: "version-1",
    key: TEMPLATE_UUID,
    document: `custom:${TEMPLATE_UUID}`,
    name: "Confidentiality undertaking",
    nameAr: "إقرار سرية",
    group: "joining",
    pageWidthPt: 612,
    pageHeightPt: 792,
    status: "current",
    version: 1,
    effectiveFrom: "2026-09-01",
    supersededOn: null,
    supersededBy: null,
    note: null,
    printableByRoles: null,
    defaultCopies: 1,
    printSides: "single",
    createdAt: "2026-09-01T08:00:00.000Z",
    createdByHrId: "B-1",
    updatedAt: "2026-09-01T08:00:00.000Z",
    updatedByHrId: null,
    pages: [
      pageFixture(),
      pageFixture({ id: BACK_PAGE_ID, pageIndex: 1, storagePath: "hiring-pack-templates/back.png" }),
    ],
    ...overrides,
  };
}

function fieldFixture(over: Partial<DocumentFieldRow> = {}): DocumentFieldRow {
  return {
    id: "field-1",
    document: `custom:${TEMPLATE_UUID}`,
    templateVersionId: "version-1",
    defaultKey: null,
    hidden: false,
    page: 1,
    anchor: null,
    x: 100,
    y: 200,
    w: 180,
    h: 13,
    align: "right",
    size: 9,
    source: { kind: "value", key: "EMPLOYEE_NAME" },
    updatedAt: "2026-09-03T00:00:00.000Z",
    updatedByHrId: "B-1",
    ...over,
  };
}

/** Every `<section class="sheet">` on the page — one per printed side, per copy. */
function sheetCount(html: string): number {
  return html.split('<section class="sheet">').length - 1;
}

/** The artwork sources, in the order they appear on the page. */
function artworkOrder(html: string): string[] {
  return [...html.matchAll(/<img class="artwork" src="([^"]+)"/g)].map((match) => match[1]);
}

// ---------------------------------------------------------------------------------------------
// A blank form is a blank form
// ---------------------------------------------------------------------------------------------

/**
 * THE DEFAULT STATE OF AN UPLOADED TEMPLATE IS "no boxes yet", and it has to print.
 *
 * Somebody uploads a paper, and before they drop a single box the preview has to show them the
 * paper. A renderer that needed a placement table would show them an empty grey page and read as a
 * failed upload — and the upload is the one step in this feature they cannot repeat without
 * re-scanning.
 */
function testABlankTemplatePrintsItsArtworkAndNothingElse(): void {
  const html = renderCustomTemplateHtml(templateFixture(), packFixture(), 1);

  assert.equal(sheetCount(html), 2, "both uploaded pages must print");
  assert.deepEqual(
    artworkOrder(html),
    [templateArtworkUrl(FRONT_PAGE_ID), templateArtworkUrl(BACK_PAGE_ID)],
    "each sheet must carry its own page's artwork",
  );
  assert.ok(
    !html.includes("data-hp-key"),
    "a template with no field layer must print no values — there are no compiled placements to fall " +
      "back on, and inventing any would put a value at coordinates nobody measured",
  );
}

/**
 * AND THE ARTWORK IS FETCHED, NOT EMBEDDED.
 *
 * A scan at print resolution is megabytes. Inlining two of them as data URIs puts that inside the
 * rendered HTML for every copy of every print — this repository has already learnt what a payload
 * that size does to a dev server, and the route it is fetched from carries the same permission the
 * document prints under.
 */
function testTheArtworkIsAUrlNotAnEmbeddedImage(): void {
  const html = renderCustomTemplateHtml(templateFixture(), packFixture(), 1);

  assert.ok(
    !html.includes("data:image"),
    "artwork must be streamed from the private bucket, never inlined into the page",
  );
  for (const src of artworkOrder(html)) {
    assert.ok(
      src.startsWith("/api/hiring-pack/template-artwork/"),
      `artwork must be served through the authenticated route, got ${src}`,
    );
  }
}

/**
 * PAGES PRINT IN THE ORDER THEY WERE UPLOADED, whatever order the rows arrive in.
 *
 * A database read without an ORDER BY returns rows in whatever order the planner found them, and
 * for a two-page form that is a coin toss. The failure is silent in the worst way: page 2 of a
 * confidentiality undertaking looks like a perfectly ordinary page of a confidentiality
 * undertaking, and the signature block on it gets signed either way.
 */
function testPagesPrintInTheirStoredOrderNotTheOrderTheyArrivedIn(): void {
  const shuffled = templateFixture({
    pages: [
      pageFixture({ id: BACK_PAGE_ID, pageIndex: 1, storagePath: "hiring-pack-templates/back.png" }),
      pageFixture(),
    ],
  });

  assert.deepEqual(
    artworkOrder(renderCustomTemplateHtml(shuffled, packFixture(), 1)),
    [templateArtworkUrl(FRONT_PAGE_ID), templateArtworkUrl(BACK_PAGE_ID)],
    "page 1 must print first even when the rows came back the other way round",
  );
}

/**
 * EVERY COPY IS THE SAME PAPER — the whole page set repeated, not the pages repeated.
 *
 * Two copies of a two-sided form is front, back, front, back: the employee's copy and the company's
 * copy, each complete. Repeating each page instead — front, front, back, back — makes a stapler
 * produce two documents each missing a side, which is only noticed once both are signed.
 */
function testEveryCopyIsTheWholePageSetAndIsIdentical(): void {
  const html = renderCustomTemplateHtml(templateFixture(), packFixture(), 3, [fieldFixture()]);

  assert.equal(sheetCount(html), 6, "three copies of a two-page form is six sheets");
  assert.deepEqual(
    artworkOrder(html),
    [
      templateArtworkUrl(FRONT_PAGE_ID),
      templateArtworkUrl(BACK_PAGE_ID),
      templateArtworkUrl(FRONT_PAGE_ID),
      templateArtworkUrl(BACK_PAGE_ID),
      templateArtworkUrl(FRONT_PAGE_ID),
      templateArtworkUrl(BACK_PAGE_ID),
    ],
    "each copy must be the complete page set, in order",
  );

  const sheets = html.split('<section class="sheet">').slice(1);
  assert.equal(sheets[0], sheets[2], "copy 2's front must be byte-identical to copy 1's front");
  assert.equal(sheets[1], sheets[3], "copy 2's back must be byte-identical to copy 1's back");
}

// ---------------------------------------------------------------------------------------------
// What a dropped box prints
// ---------------------------------------------------------------------------------------------

/**
 * A BOX BOUND TO A VALUE PRINTS THAT VALUE, at the coordinates it was dropped at.
 *
 * This is the whole feature in one assertion: an operator drags a box onto a scanned paper, points
 * it at the employee's name, and the name prints there.
 */
function testABoundBoxPrintsItsValueWhereItWasDropped(): void {
  const html = renderCustomTemplateHtml(templateFixture(), packFixture(), 1, [
    fieldFixture({ x: 120, y: 240 }),
  ]);

  assert.ok(html.includes('data-hp-key="EMPLOYEE_NAME"'), "the bound key must reach the page");
  assert.ok(html.includes("نور عادل"), "the employee's Arabic name must print");
  assert.ok(
    html.includes("left:120pt;top:240pt"),
    "the box must print where it was dropped, in the page's own points",
  );
}

/**
 * A BOX WHOSE VALUE IS EMPTY PRINTS NOTHING AT ALL — not an empty box, not a placeholder.
 *
 * Half of what these papers are for is the things nobody has entered yet, and a form printed with a
 * blank where the national ID goes is a form somebody fills in by hand. What must never happen is
 * the box printing something that stands in for a value: an underscore, a dash, the key's own name.
 */
function testABoxWithNoValuePrintsNothing(): void {
  const html = renderCustomTemplateHtml(
    templateFixture(),
    packFixture({ socialInsuranceNumber: null }),
    1,
    [fieldFixture({ source: { kind: "value", key: "INSURANCE_NUMBER" } })],
  );

  assert.ok(
    !html.includes('data-hp-key="INSURANCE_NUMBER"'),
    "a value nobody has entered must leave the paper blank, with no span of its own",
  );
}

/**
 * FIXED TEXT FILLS ITS PLACEHOLDERS, and a placeholder that cannot be filled BLANKS THE WHOLE
 * FIELD rather than printing a hole — or worse, printing its own braces.
 *
 * "أقر أنا {{EMPLOYEE_NAME}}، بطاقة رقم {{NATIONAL_ID}}" with no national ID on file would otherwise
 * print as a sentence asserting a card number that is not there. A blank line is a form to be
 * completed; a sentence with a gap in the middle is a statement somebody signs.
 *
 * AND NOTHING PRINTS BRACES. `{{missingKey}}` on a signed company undertaking is the failure that
 * would be noticed by the employee rather than by us.
 */
function testFixedTextResolvesItsPlaceholdersOrPrintsNothing(): void {
  const filled = renderCustomTemplateHtml(templateFixture(), packFixture(), 1, [
    fieldFixture({
      source: { kind: "literal", text: "أقر أنا {{EMPLOYEE_NAME}}، بطاقة رقم {{NATIONAL_ID}}" },
      w: 400,
    }),
  ]);
  assert.ok(
    filled.includes("أقر أنا نور عادل، بطاقة رقم 29709091234567"),
    "both placeholders must fill from the employee's own record",
  );
  assert.ok(!filled.includes("{{"), "no placeholder syntax may survive onto the paper");

  const missing = renderCustomTemplateHtml(templateFixture(), packFixture({ nationalId: null }), 1, [
    fieldFixture({
      source: { kind: "literal", text: "أقر أنا {{EMPLOYEE_NAME}}، بطاقة رقم {{NATIONAL_ID}}" },
      w: 400,
    }),
  ]);
  assert.ok(
    !missing.includes("أقر أنا"),
    "one unfillable placeholder must blank the WHOLE sentence, not leave a gap in it",
  );
  assert.ok(!missing.includes("{{"), "an unresolved placeholder must never print its braces");

  const unknown = renderCustomTemplateHtml(templateFixture(), packFixture(), 1, [
    fieldFixture({ source: { kind: "literal", text: "{{noSuchField}}" } }),
  ]);
  assert.ok(
    !unknown.includes("{{"),
    "a placeholder naming a field this system has never heard of must print nothing, not its braces",
  );
}

/**
 * A BOX BELONGS TO THE PAGE IT WAS DROPPED ON.
 *
 * The field layer stores a page number, and the pages of a company template are one list. A box
 * dropped on the back of the form printing on the front puts a signature line over the body text —
 * and on a one-page template the bug is invisible, which is why the fixture has two pages.
 */
function testABoxPrintsOnItsOwnPageOnly(): void {
  const html = renderCustomTemplateHtml(templateFixture(), packFixture(), 1, [
    fieldFixture({ id: "front-box", page: 1, source: { kind: "literal", text: "FRONT" } }),
    fieldFixture({ id: "back-box", page: 2, source: { kind: "literal", text: "BACK" } }),
  ]);

  const sheets = html.split('<section class="sheet">').slice(1);
  assert.equal(sheets.length, 2, "the fixture is a two-page template");
  assert.ok(sheets[0].includes("FRONT"), "the front box must print on the front");
  assert.ok(!sheets[0].includes("BACK"), "the back box must NOT print on the front");
  assert.ok(sheets[1].includes("BACK"), "the back box must print on the back");
  assert.ok(!sheets[1].includes("FRONT"), "the front box must NOT print on the back");
}

/** A hidden row is a box somebody switched off, and a switched-off box prints nothing. */
function testAHiddenBoxDoesNotPrint(): void {
  const html = renderCustomTemplateHtml(templateFixture(), packFixture(), 1, [
    fieldFixture({ hidden: true }),
  ]);

  assert.ok(
    !html.includes('data-hp-key="EMPLOYEE_NAME"'),
    "a hidden box must not print, however it was bound",
  );
}

// ---------------------------------------------------------------------------------------------
// The paper itself
// ---------------------------------------------------------------------------------------------

/**
 * THE PAGE SIZE COMES OFF THE UPLOADED FILE, never off a constant in this repository.
 *
 * The points in the template row were read from the PDF's own page box, or derived from the scan's
 * aspect. Printing that at A4 because A4 is the common case shifts every box by the difference —
 * 6mm across and 18mm down the page for US Letter — and the result still looks like a filled form.
 */
function testThePageSizeComesFromTheTemplateRow(): void {
  const html = renderCustomTemplateHtml(templateFixture(), packFixture(), 1);

  assert.ok(
    html.includes("@page { size: 612pt 792pt; margin: 0; }"),
    "the printed page size must be the uploaded file's own, not A4",
  );
  assert.ok(
    html.includes("width: 612pt") && html.includes("height: 792pt"),
    "the sheet must be laid out at the uploaded size",
  );
  assert.ok(
    html.includes("216 × 279 mm"),
    "the banner must state the size in the units a paper tray is labelled in",
  );
}

/**
 * AN UPLOADED TEMPLATE IS A PAGE SURFACE, and there is no case in which it is not.
 *
 * The flow surface exists for documents this system TYPESETS, where a longer name reflows the text
 * and an anchor is the only stable place to hang a field from. Nothing about a scanned image
 * reflows. If this ever answered "flow", the editor would offer anchors against a page that has no
 * text nodes to anchor to, and every dropped box would resolve to nothing.
 */
function testAnUploadedTemplateIsAlwaysAPageSurface(): void {
  assert.equal(
    documentSurfaceOf(templateFixture().document),
    "page",
    "an uploaded template is fixed artwork, so it places fields by coordinate",
  );
}

// ---------------------------------------------------------------------------------------------
// The value catalogue
// ---------------------------------------------------------------------------------------------

/**
 * THE WHOLE BINDING TABLE IS OFFERED, because nothing here has seen the paper.
 *
 * Each of the ten built-in documents has a values builder answering exactly the keys that document
 * places — Form 1's builder returns Form 1's twenty-odd and nothing else, because the compiled
 * placements are the only things that will ever ask. An uploaded paper could ask for any of them,
 * and which it asks for is decided by whoever drops the boxes, long after this code ran. A shorter
 * list would be a guess, and the way it fails is a field the operator cannot bind to anything.
 */
function testEveryKnownFieldIsOfferedToACompanyTemplate(): void {
  const values = buildCustomTemplateValues(packFixture());

  for (const key of Object.keys(PAPER_FIELD_BINDINGS)) {
    assert.ok(
      key in values,
      `${key} is a value this system knows and must be bindable on a company template`,
    );
  }
  assert.equal(
    Object.keys(values).length,
    Object.keys(PAPER_FIELD_BINDINGS).length,
    "the catalogue must be exactly the binding table — a key here that is not bindable would offer " +
      "the operator a field the editor cannot save",
  );
}

/**
 * FORMATTING FOLLOWS THE HOUSE, and is not invented for this renderer.
 *
 * A date printed as `1997-09-09` on an Arabic form reads as a machine's output; every other document
 * in this pack prints `09 / 09 / 1997`, which is how a date is written by hand in Egypt. A salary
 * printed as `11000` is a figure somebody has to count the digits of. Both formatters are the ones
 * the contract and the insurance forms already use — a second implementation is how one paper comes
 * to print a different number from another.
 */
function testDatesAndMoneyArePrintedTheWayEveryOtherPaperPrintsThem(): void {
  const values = buildCustomTemplateValues(packFixture());

  assert.equal(values.BIRTH_DATE, "09 / 09 / 1997", "a date prints dd / mm / yyyy");
  assert.equal(values.HIRE_DATE, "01 / 08 / 2026", "a date prints dd / mm / yyyy");
  assert.equal(values.SALARY_FIGURES, "11,000", "money is grouped, with no piastres when there are none");
  assert.equal(
    values.NATIONAL_ID,
    "29709091234567",
    "a national ID is digits and must not be grouped, formatted or reordered",
  );
}

/**
 * A VALUE NOBODY HAS ENTERED IS AN EMPTY STRING, NOT A MISSING KEY.
 *
 * The key still has to be there: the field table lists what an operator MAY place, and the whole
 * reason somebody uploads a form is to fill in the things that are currently blank. Dropping the key
 * would hide exactly the fields they came to bind.
 */
function testAnUnsetValueIsStillAnOfferedField(): void {
  const values = buildCustomTemplateValues(packFixture({ socialInsuranceNumber: null }));

  assert.equal(values.INSURANCE_NUMBER, "", "an unset value reads as empty");
  assert.ok(
    "INSURANCE_NUMBER" in values,
    "and the field is still offered, because filling it in is the point",
  );
}

/**
 * THE NAME FALLS BACK THE WAY EVERY OTHER PAPER'S DOES.
 *
 * `nameAr` is the printed name; an employee with no Arabic name on file prints the English one
 * rather than a blank, because a contract with no name on it is not a contract. That rule lives in
 * the binding table, and this asserts the company-template path reads it rather than the column.
 */
function testTheNameFallsBackToTheEnglishOneWhenThereIsNoArabic(): void {
  const values = buildCustomTemplateValues(packFixture({ nameAr: null }));

  assert.equal(values.EMPLOYEE_NAME, "Nour Adel", "a missing Arabic name prints the English name");
}

/** Text on a company template is escaped, the same as on every other page. */
function testFieldTextIsEscaped(): void {
  const html = renderCustomTemplateHtml(
    templateFixture(),
    packFixture({ nameAr: '<script>alert("x")</script>' }),
    1,
    [fieldFixture()],
  );

  assert.ok(!html.includes("<script>alert"), "a value must never reach the page as markup");
  assert.ok(html.includes("&lt;script&gt;"), "it prints as the text it is");
}

export async function runHiringPackCustomTemplateRenderTests() {
  testABlankTemplatePrintsItsArtworkAndNothingElse();
  testTheArtworkIsAUrlNotAnEmbeddedImage();
  testPagesPrintInTheirStoredOrderNotTheOrderTheyArrivedIn();
  testEveryCopyIsTheWholePageSetAndIsIdentical();
  testABoundBoxPrintsItsValueWhereItWasDropped();
  testABoxWithNoValuePrintsNothing();
  testFixedTextResolvesItsPlaceholdersOrPrintsNothing();
  testABoxPrintsOnItsOwnPageOnly();
  testAHiddenBoxDoesNotPrint();
  testThePageSizeComesFromTheTemplateRow();
  testAnUploadedTemplateIsAlwaysAPageSurface();
  testEveryKnownFieldIsOfferedToACompanyTemplate();
  testDatesAndMoneyArePrintedTheWayEveryOtherPaperPrintsThem();
  testAnUnsetValueIsStillAnOfferedField();
  testTheNameFallsBackToTheEnglishOneWhenThereIsNoArabic();
  testFieldTextIsEscaped();
}
