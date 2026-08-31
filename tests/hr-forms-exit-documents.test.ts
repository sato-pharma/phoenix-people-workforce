import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { systemContractDefaults } from "../src/config/system-settings.ts";
import {
  FORM6_PAGE_1_PLACEMENTS,
  FORM6_PAGE_1_SVG,
  FORM6_PAGE_2_PLACEMENTS,
  FORM6_PAGE_2_SVG,
  FORM6_PAGE_HEIGHT_PT,
  FORM6_PAGE_WIDTH_PT,
} from "../src/lib/hiring-pack/form6-layout.ts";
import {
  LABOUR_PAGE_HEIGHT_PT,
  LABOUR_PAGE_WIDTH_PT,
  MUTUAL_PAGE_1_PLACEMENTS,
  MUTUAL_PAGE_2_PLACEMENTS,
  MUTUAL_PAGE_3_PLACEMENTS,
  RESIGNATION_PLACEMENTS,
} from "../src/lib/hiring-pack/labour-exit-layout.ts";
import { renderForm1Html } from "../src/lib/hiring-pack/render-form1.ts";
import { buildForm6Values, renderForm6Html } from "../src/lib/hiring-pack/render-form6.ts";
import {
  buildExitValues,
  renderMutualTerminationHtml,
  renderResignationHtml,
} from "../src/lib/hiring-pack/render-labour-exit.ts";
import { FIT_TO_BOX_SCRIPT } from "../src/lib/hiring-pack/render-placement.ts";
import type { Placement } from "../src/lib/hiring-pack/render-placement.ts";
import {
  collectHiringPackGaps,
  emptyOffboardingProfile,
  resolveContractTerms,
} from "../src/lib/hiring-pack/service.ts";
import { EXIT_DOCUMENTS, HIRING_PACK_DOCUMENTS } from "../src/lib/hiring-pack/types.ts";
import type {
  ExitFacts,
  HiringPackData,
  HiringPackEmployeeFacts,
  HiringPackProfile,
  OffboardingProfile,
} from "../src/lib/hiring-pack/types.ts";

/**
 * The LEAVING half of HR Forms: social insurance Form 6, and the two Ministry of Labour exit
 * templates that are alternatives to each other.
 *
 * These three papers are filed with two different authorities on the way out, and each of them
 * fails expensively and quietly:
 *
 *   - FORM 6 IS A DEADLINE. Its own back page charges the employer 20% per month of delay, and the
 *     date it turns on — تاريخ انتهاء الاشتراك — is the employee's LAST WORKING DAY. Typing the
 *     date the form was written there instead is the single most likely mistake, so the last
 *     working day is resolved once, in `terms`, and both authorities' forms read that one value.
 *
 *   - THE TWO LABOUR FORMS CONTRADICT EACH OTHER. A resignation says the employee asked to leave; a
 *     mutual termination says both parties agreed to end the contract. The owner's instruction on
 *     2026-08-30 was "not the two should be signed, either this or this". A file holding both signed
 *     contradicts itself in front of the one reader who matters, a labour inspector.
 *
 *   - ALL THREE ARE GOVERNMENT TEMPLATES. The owner's instruction was "do not change anything in the
 *     template because this is a governmental template must be as is". Nothing here edits a word of
 *     one: the artwork is the authority's own page and every value is positioned over it. What that
 *     turns into a testable property is WHERE Phoenix is allowed to write — never on a signature
 *     line, never on the back of Form 6, never in the labour office's own endorsement column.
 *
 * So this file pins the things a later edit could plausibly and invisibly break.
 */

const LAST_WORKING_DATE = "2026-08-31";

function employeeFixture(overrides: Partial<HiringPackEmployeeFacts> = {}): HiringPackEmployeeFacts {
  return {
    hrId: "H-2002",
    fullName: "Kareem Fouad",
    nameAr: "كريم فؤاد",
    nationalId: "29505054321098",
    socialInsuranceNumber: "98765432",
    socialInsuranceWage: 6000,
    grossSalary: 9000,
    birthDate: "1995-05-05",
    hireDate: "2024-03-01",
    jobTitle: "Medical Representative",
    departmentAr: "الجهاز العصبي",
    lineId: 1,
    residenceAddress: "8 شارع الهرم، الجيزة",
    residenceCity: "الجيزة",
    mobileNumber: "01100000000",
    workEmail: "kareem@example.com",
    employmentStatus: "resigned",
    lastWorkingDate: LAST_WORKING_DATE,
    departed: true,
    ...overrides,
  };
}

function profileFixture(overrides: Partial<HiringPackProfile> = {}): HiringPackProfile {
  return {
    hrId: "H-2002",
    nationality: "مصرية",
    qualification: "بكالوريوس صيدلة",
    birthPlace: "الجيزة",
    jobTitleAr: "مندوب دعاية طبية",
    occupationCode: "123456",
    insuranceOffice: "الهرم",
    addressBuilding: "08",
    addressDistrict: "01",
    addressStreet: "شارع الهرم",
    addressMarkaz: "02",
    addressGovernorate: "03",
    contractDurationMonths: null,
    contractStartDate: "2024-03-01",
    contractEndDate: null,
    underperformanceThresholdPct: null,
    underperformanceMonths: null,
    trainingBondMonths: null,
    notes: null,
    contractSignedDate: null,
    form1SignedDate: null,
    contractPrintedAt: null,
    form1PrintedAt: null,
    // Nothing signed, so no version is stamped. Null is the ordinary state and means "print the
    // current contract"; a value only appears once somebody signs one.
    contractTemplateVersion: null,
    updatedAt: null,
    ...overrides,
  };
}

/**
 * A resignation in progress — the shape the exit documents are actually printed from.
 *
 * The nulls come from the app's own `emptyOffboardingProfile`, so a column added to the module
 * reaches this fixture without an edit here; only the values this suite deliberately sets are
 * written out.
 */
function offboardingFixture(overrides: Partial<OffboardingProfile> = {}): OffboardingProfile {
  return {
    ...emptyOffboardingProfile("H-2002"),
    exitRoute: "resignation",
    lastWorkingDate: LAST_WORKING_DATE,
    endReasonAr: "ظروف خاصة",
    endReasonCode: "1",
    addresseeNameAr: "الدكتور/ أنور إبراهيم",
    addresseeTitleAr: "المدير المسئول",
    agreementDate: "2026-08-25",
    ...overrides,
  };
}

function packFixture(
  employeeOverrides: Partial<HiringPackEmployeeFacts> = {},
  offboardingOverrides: Partial<OffboardingProfile> = {},
  exit: ExitFacts | null = null,
): HiringPackData {
  const employee = employeeFixture(employeeOverrides);
  const profile = profileFixture();
  const offboarding = offboardingFixture(offboardingOverrides);
  return {
    employee,
    profile,
    offboarding,
    exit,
    gaps: collectHiringPackGaps(employee, profile, offboarding, exit),
    terms: resolveContractTerms(employee, profile, offboarding, exit),
  };
}

/** Every `<section class="sheet">` in a rendered document, in print order. */
function sheets(html: string): string[] {
  return html.split('<section class="sheet">').slice(1);
}

/**
 * The printed width of a placement, whichever kind it is.
 *
 * A digit grid states its width as a cell pitch and a cell count rather than a `w`, so a geometry
 * check written against `w` alone silently stops covering a column the day somebody puts a national
 * ID grid in it — which is exactly the value most likely to appear beside a name.
 */
function boxWidth(placement: Placement): number {
  return placement.kind === "digits" ? placement.pitch * placement.cells : placement.w;
}

/** One entry per placement that actually printed something. Empty values render nothing at all. */
function printedFields(sheet: string): string[] {
  return [...sheet.matchAll(/<span class="f (?:txt|grid|tick)"/g)].map((match) => match[0]);
}

// ---------------------------------------------------------------------------------------------
// The coordinate map
// ---------------------------------------------------------------------------------------------

function testForm6LayoutIsTheMeasuredForm() {
  const byKey = new Map(FORM6_PAGE_1_PLACEMENTS.map((placement) => [placement.key, placement]));
  assert.equal(
    byKey.size,
    FORM6_PAGE_1_PLACEMENTS.length,
    "two placements share a key — the second would print on top of the first",
  );

  // Cell counts read straight off the form's own printed boxes. A wrong count does not fail
  // visibly: it silently clips the last digit of a national ID, or leaves a box empty.
  //
  // The insurance number is EIGHT here where Form 1 prints NINE. That is not a typo and not a
  // mistake to tidy up — the two forms genuinely differ, which is exactly why every grid on this
  // page was measured again rather than copied from the form beside it.
  const cellCounts: Record<string, number> = {
    establishmentNumber: 8,
    insuranceNumber: 8,
    nationalId: 14,
    endDay: 2,
    endMonth: 2,
    endYear: 4,
    endReasonCode: 1,
    addressBuilding: 4,
    addressDistrict: 2,
    addressMarkaz: 2,
    addressGovernorate: 2,
  };
  for (const [key, cells] of Object.entries(cellCounts)) {
    const placement = byKey.get(key);
    assert.ok(placement, `Form 6 has no placement for ${key}`);
    assert.equal(placement.kind, "digits", `${key} must be a box grid`);
    if (placement.kind !== "digits") return;
    assert.equal(placement.cells, cells, `${key} must cover ${cells} printed boxes`);
  }

  // سبب انتهاء الاشتراك has one box for the Authority's numeric code. One cell means it can hold a
  // code and never a word — and the renderer strips everything that is not a digit before it gets
  // there, so a reason typed into the code field prints nothing rather than a stray letter.
  const values = buildForm6Values(packFixture({}, { endReasonCode: "خ4" }));
  assert.equal(values.endReasonCode, "4", "the reason code box takes digits only");

  // Nothing may sit off the paper.
  for (const placement of FORM6_PAGE_1_PLACEMENTS) {
    const width = placement.kind === "digits" ? placement.pitch * placement.cells : placement.w;
    assert.ok(placement.x >= 0, `${placement.key} starts left of the page`);
    assert.ok(
      placement.x + width <= FORM6_PAGE_WIDTH_PT,
      `${placement.key} runs off the right edge of the page`,
    );
    assert.ok(
      placement.y + placement.h <= FORM6_PAGE_HEIGHT_PT,
      `${placement.key} runs off the bottom of the page`,
    );
  }

  for (const placements of [
    RESIGNATION_PLACEMENTS,
    MUTUAL_PAGE_1_PLACEMENTS,
    MUTUAL_PAGE_2_PLACEMENTS,
    MUTUAL_PAGE_3_PLACEMENTS,
  ]) {
    for (const placement of placements) {
      const width = placement.kind === "digits" ? placement.pitch * placement.cells : placement.w;
      assert.ok(placement.x >= 0, `${placement.key} starts left of the page`);
      assert.ok(
        placement.x + width <= LABOUR_PAGE_WIDTH_PT,
        `${placement.key} runs off the right edge of the labour form`,
      );
      assert.ok(
        placement.y + placement.h <= LABOUR_PAGE_HEIGHT_PT,
        `${placement.key} runs off the bottom of the labour form`,
      );
    }
  }
}

/**
 * Every placement key must be a key the value builder produces.
 *
 * A placement whose key is never built is invisible: no error, no warning, no failed render — the
 * form simply comes out of the printer with one box empty, and the first person to notice is
 * whoever is handed it at the insurance office. A renamed value is the way this happens.
 */
function testEveryPlacementKeyIsBuilt() {
  const pack = packFixture();

  const form6Values = buildForm6Values(pack);
  for (const placement of FORM6_PAGE_1_PLACEMENTS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(form6Values, placement.key),
      `Form 6 places "${placement.key}" but nothing builds it — that box can never be filled`,
    );
  }

  const exitValues = buildExitValues(pack);
  const labourPlacements = [
    ...RESIGNATION_PLACEMENTS,
    ...MUTUAL_PAGE_1_PLACEMENTS,
    ...MUTUAL_PAGE_2_PLACEMENTS,
    ...MUTUAL_PAGE_3_PLACEMENTS,
  ];
  for (const placement of labourPlacements) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(exitValues, placement.key),
      `A labour form places "${placement.key}" but nothing builds it`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Where Phoenix is allowed to write on a government template
// ---------------------------------------------------------------------------------------------

/**
 * The back of Form 6 prints blank — the same standing rule Form 1's back page runs under.
 *
 * The reverse carries the Authority's own إرشادات and two declarations signed in the first person,
 * one by the employee and one by the responsible manager. What belongs there is a pen.
 */
function testTheBackOfForm6IsPrintedBlank() {
  assert.equal(
    FORM6_PAGE_2_PLACEMENTS.length,
    0,
    "the back of Form 6 must carry no placements at all",
  );

  const html = renderForm6Html(packFixture(), 1);
  const [front, back] = sheets(html);
  assert.ok(front?.includes(FORM6_PAGE_1_SVG), "the first sheet must be page 1");
  assert.ok(back?.includes(FORM6_PAGE_2_SVG), "the second sheet must be page 2");
  assert.equal(printedFields(back ?? "").length, 0, "Phoenix wrote a value on the back of Form 6");
  assert.ok(printedFields(front ?? "").length > 0, "the front of Form 6 printed nothing at all");
}

/**
 * Nothing is typed on, or below, a line somebody signs.
 *
 * Measured as ink off each source PDF: Form 6's two إقرار signature blocks start at y=588, the
 * resignation's التوقيع rule is at y=610.56, and the mutual-termination agreement's two signature
 * blocks are at y=633.60 (employer) and y=653.52 (employee). A value that drifts down into one of
 * those is not a layout bug on the screen — it is a printed document with a typed signature.
 *
 * The resignation's whole right-hand اعتماد الجهة الإدارية المختصة column is the labour office's
 * own endorsement, filled at the office. Phoenix's own placements all sit in the letter above it.
 */
function testNothingIsTypedOnASignatureLine() {
  const form6SignatureInk = 588;
  for (const placement of FORM6_PAGE_1_PLACEMENTS) {
    assert.ok(
      placement.y + placement.h <= form6SignatureInk,
      `Form 6 writes "${placement.key}" at y=${placement.y}, on or below the إقرار signature blocks`,
    );
  }

  const resignationSignatureInk = 610.56;
  for (const placement of RESIGNATION_PLACEMENTS) {
    assert.ok(
      placement.y + placement.h <= resignationSignatureInk,
      `the resignation writes "${placement.key}" at y=${placement.y}, on or below التوقيع`,
    );
  }

  // Page 3 carries TWO signature blocks side by side at different heights — ممثل صاحب العمل on the
  // right signs at y=633.60, العامل on the left at y=653.52 — so the ceiling depends on which column
  // a value sits in. A single threshold across both would have to be the lower of the two, which
  // reads as a rule about the page and is really a rule about a column.
  const employerColumnStart = 300;
  for (const placement of MUTUAL_PAGE_3_PLACEMENTS) {
    const signatureInk = placement.x >= employerColumnStart ? 633.6 : 653.52;
    const column = placement.x >= employerColumnStart ? "employer" : "employee";
    assert.ok(
      placement.y + placement.h <= signatureInk,
      `the agreement writes "${placement.key}" at y=${placement.y}, on or below the ${column} signature line`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// The owner's two printing instructions
// ---------------------------------------------------------------------------------------------

/**
 * Form 6 prints three double-sided copies.
 *
 * Both halves are the owner's instruction of 2026-08-30 — "the form six should be printed also on
 * both sides, three copies" — and the form's own back page says من أصل وصورتين. A copy count that
 * silently reverts to one is a person driving back to the insurance office.
 */
function testForm6PrintsThreeDoubleSidedCopies() {
  assert.equal(
    systemContractDefaults.form6Copies,
    3,
    "Form 6 is filed as an original and two copies",
  );

  const html = renderForm6Html(packFixture(), systemContractDefaults.form6Copies);
  const rendered = sheets(html);
  assert.equal(rendered.length, 6, "three copies of a two-sided form is six sheets");
  for (let index = 0; index < rendered.length; index += 1) {
    const expected = index % 2 === 0 ? FORM6_PAGE_1_SVG : FORM6_PAGE_2_SVG;
    assert.ok(
      rendered[index]?.includes(expected),
      `sheet ${index + 1} is the wrong side — the pages must alternate, or the duplex pairing breaks`,
    );
  }

  // The instruction has to reach the person at the printer, because a browser's print dialog
  // defaults to single-sided and page 2 is the back of page 1, not a second sheet.
  assert.match(
    html,
    /DOUBLE-SIDED/,
    "the print banner must tell the operator to print on both sides",
  );
  assert.match(html, /US Legal/, "the print banner must name the paper size");
}

/**
 * The two labour forms are alternatives — one is signed, never both.
 *
 * Owner, 2026-08-30: "not the two should be signed, either this or this". Enforced in three places
 * because each catches a different route to the same broken file: the database refuses to record
 * both signatures, the service refuses before it writes, and the screen only offers the route that
 * was chosen. This pins the first and the printed instruction that carries the rule onto paper.
 */
function testTheTwoLabourFormsAreAlternatives() {
  assert.deepEqual(
    [...EXIT_DOCUMENTS],
    ["form6", "resignation", "mutualTermination", "clearanceEmployee", "clearanceCompany"],
    "the leaving half is Form 6, the two labour alternatives, and the clearance pair",
  );
  // NOT a count of all documents any more. That assertion read `length, 5` and went red the moment
  // the custody receipts were added — it was pinning the size of the module, which grows, when what
  // it means to pin is that the leaving half is exactly the list above and that nothing appears in
  // it twice. A count is a fact about today; this is a fact about the shape.
  assert.equal(
    new Set(HIRING_PACK_DOCUMENTS).size,
    HIRING_PACK_DOCUMENTS.length,
    "no document may appear twice — a duplicate would print, and record, the same paper under two names",
  );
  for (const document of EXIT_DOCUMENTS) {
    assert.ok(
      HIRING_PACK_DOCUMENTS.includes(document),
      `${document} is in the leaving half but not in the module's document list`,
    );
  }

  const migration = readFileSync(
    "supabase/migrations/20260830183000_employee_offboarding_profile.sql",
    "utf8",
  );
  assert.match(
    migration,
    /check\s*\(\s*resignation_signed_date is null or mutual_termination_signed_date is null\s*\)/i,
    "the database must refuse to record both exit forms as signed",
  );

  const pack = packFixture();
  for (const html of [
    renderResignationHtml(pack, systemContractDefaults.resignationCopies),
    renderMutualTerminationHtml(pack, systemContractDefaults.mutualTerminationCopies),
  ]) {
    assert.match(
      html,
      /Sign ONE exit form, never both/,
      "each labour form must say on its face that it is an alternative to the other",
    );
    assert.match(html, /US Letter/, "the labour forms print on Letter, not the Legal Form 6 uses");
  }
}

// ---------------------------------------------------------------------------------------------
// The last working day — the value both authorities read
// ---------------------------------------------------------------------------------------------

/**
 * Form 6 and the labour form can never disagree about the day service ended.
 *
 * They ask for the same date in three different shapes — boxed digits on Form 6, a written phrase
 * on the resignation, a weekday plus boxed digits on the agreement — and they go to two different
 * authorities. Resolving the date once, in `terms`, is what makes the three shapes one fact.
 */
function testBothAuthoritiesReadTheSameLastWorkingDay() {
  const pack = packFixture();
  assert.equal(pack.terms.lastWorkingDate, LAST_WORKING_DATE);

  const form6 = buildForm6Values(pack);
  const exit = buildExitValues(pack);

  assert.equal(form6.endDay, "31");
  assert.equal(form6.endMonth, "08");
  assert.equal(form6.endYear, "2026");

  assert.equal(exit.lastWorkingDay, form6.endDay, "the agreement's day must match Form 6's");
  assert.equal(exit.lastWorkingMonth, form6.endMonth, "the agreement's month must match Form 6's");
  assert.equal(exit.lastWorkingYear, form6.endYear, "the agreement's year must match Form 6's");
  assert.match(
    exit.lastWorkingDate,
    /31\s*\/\s*08\s*\/\s*2026/u,
    `the resignation's written date must carry the same day: got "${exit.lastWorkingDate}"`,
  );

  // 2026-08-31 is a Monday. The weekday is computed from the date rather than typed, so the two
  // cannot drift — and a hand-typed weekday that disagrees with the date is precisely the sort of
  // discrepancy a labour inspector reads as a document prepared after the fact.
  assert.equal(exit.lastWorkingWeekday, "الاثنين", "the weekday is derived from the date");

  // The agreement is dated when it is SIGNED, which is not the last working day. Conflating the two
  // would date the paper to the day the employment ended, and back-date the parties' consent.
  assert.equal(exit.agreementDay, "25");
  assert.notEqual(exit.agreementDay, exit.lastWorkingDay);
}

/**
 * Three sources for that one date, in a deliberate order.
 *
 * The confirmed override outranks everything, because `employee_resignations` copies a single date
 * into four columns — `submitted_date`, `resignation_date`, `last_working_date`, `effective_date` —
 * so all four agreeing is one value repeated, not four confirmations of it. The employee record is
 * the widest fallback: measured on production 2026-08-30, all 57 people who have left carry
 * `employees.last_working_date`, while 3 of them have no resignation row at all.
 */
function testTheConfirmedDateOutranksTheRecordedOne() {
  const withOverride = packFixture(
    { lastWorkingDate: "2026-01-01" },
    { lastWorkingDate: "2026-08-31" },
    { lastWorkingDate: "2026-06-30", resignationDate: null, effectiveDate: null, status: "approved", jobTitle: null },
  );
  assert.equal(
    withOverride.terms.lastWorkingDate,
    "2026-08-31",
    "a date somebody confirmed must outrank both recorded ones",
  );

  const recordOnly = packFixture(
    { lastWorkingDate: "2026-01-01" },
    { lastWorkingDate: null },
    { lastWorkingDate: "2026-06-30", resignationDate: null, effectiveDate: null, status: "approved", jobTitle: null },
  );
  assert.equal(
    recordOnly.terms.lastWorkingDate,
    "2026-06-30",
    "the resignation record answers when nobody has confirmed a date",
  );

  // The three leavers with no resignation row. Without this fallback the one screen that prints
  // their Form 6 would report the date missing while it sat on the employee row it had just read.
  const employeeRowOnly = packFixture({ lastWorkingDate: "2026-05-31" }, { lastWorkingDate: null }, null);
  assert.equal(
    employeeRowOnly.terms.lastWorkingDate,
    "2026-05-31",
    "the employee record answers when there is no resignation row",
  );
  assert.ok(
    !employeeRowOnly.gaps.some((gap) => gap.field === "lastWorkingDate"),
    "a last working day that is already on the employee record must not be reported missing",
  );
}

/**
 * The exit gaps stay out of a new hire's way, and arrive on their own for a leaver.
 *
 * A screen that told everybody their last working day was missing would be a screen HR learns to
 * ignore — and the one warning that costs money if ignored is on this list.
 */
function testExitGapsOnlyAppearOnceSomebodyIsLeaving() {
  const exitSources = new Set(["offboarding-profile", "resignation-record"]);

  const newHire = packFixture(
    { employmentStatus: "active", lastWorkingDate: null },
    {
      exitRoute: null,
      lastWorkingDate: null,
      endReasonAr: null,
      endReasonCode: null,
      agreementDate: null,
    },
    null,
  );
  assert.equal(
    newHire.gaps.filter((gap) => exitSources.has(gap.source)).length,
    0,
    "somebody who has not left must not be told their exit paperwork is incomplete",
  );

  // The employee record alone is enough to start the exit half: `employment_status` flips to
  // "resigned" before anybody opens this screen.
  const leaver = packFixture(
    { employmentStatus: "resigned", lastWorkingDate: null },
    {
      exitRoute: null,
      lastWorkingDate: null,
      endReasonAr: null,
      endReasonCode: null,
      agreementDate: null,
    },
    null,
  );
  const leaverGaps = leaver.gaps.filter((gap) => exitSources.has(gap.source));
  assert.ok(leaverGaps.length > 0, "a departed employee's exit paperwork must be chased");

  const lastWorkingGap = leaverGaps.find((gap) => gap.field === "lastWorkingDate");
  assert.ok(lastWorkingGap, "the last working day must be reported when nothing carries it");
  assert.equal(
    lastWorkingGap.blocking,
    true,
    "Form 6 with a blank end date costs 20% a month — that is not a chase-later gap",
  );
  for (const document of EXIT_DOCUMENTS) {
    assert.ok(
      lastWorkingGap.documents.includes(document),
      `the last working day is missing from ${document} too`,
    );
  }
  assert.ok(
    !lastWorkingGap.documents.includes("contract"),
    "the employment contract does not print a last working day",
  );
}

// ---------------------------------------------------------------------------------------------
// A long value stays inside its own rule
// ---------------------------------------------------------------------------------------------

/**
 * Every text value is rendered so it CAN be compressed, and every placed document carries the
 * script that compresses it.
 *
 * A printed rule is as long as the authority drew it, never as long as the value it has to hold.
 * The placement CSS is `white-space: nowrap` with `overflow: visible`, and both halves are
 * deliberate — the owner's standing rule forbids wrapping text and forbids truncating it with an
 * ellipsis — so a value longer than its rule neither wraps nor disappears: it prints straight
 * across the page. On page 3 of the mutual-termination agreement Sato Pharma's 74-character head
 * office did exactly that, over the EMPLOYEE's printed labels opposite.
 *
 * NOTHING IN THIS REPOSITORY CAN SEE THAT, which is why the mechanism is pinned rather than the
 * outcome. It is not a type error and not a lint error, the HTML is valid, and the defect only
 * exists once a browser has laid the glyphs out — which is also the only place a fix can run, since
 * Arabic shaping means text width is not a sum of character widths and the server cannot compute
 * it. So this pins the inner span that gives the script something to scale, and the script's
 * presence in each of the four placed documents. A fifth added later without it spills in silence.
 */
function testALongValueIsCompressedNotSpilled() {
  const documents: Array<readonly [string, string]> = [
    ["Form 1", renderForm1Html(packFixture(), 1)],
    ["Form 6", renderForm6Html(packFixture(), 1)],
    ["the resignation", renderResignationHtml(packFixture(), 1)],
    ["the agreement", renderMutualTerminationHtml(packFixture(), 1)],
  ];

  for (const [name, html] of documents) {
    assert.ok(
      html.includes(FIT_TO_BOX_SCRIPT),
      `${name} places values on a form but does not carry FIT_TO_BOX_SCRIPT — a long value prints across the page`,
    );

    const openings = [...html.matchAll(/<span class="f txt"/gu)].length;
    assert.ok(openings > 0, `${name} printed no text values at all`);

    const wrapped = [...html.matchAll(/<span class="f txt"[^>]*>(<span class="ff">)/gu)].length;
    assert.equal(
      wrapped,
      openings,
      `${name} has a text value with no inner .ff span — FIT_TO_BOX_SCRIPT silently skips it`,
    );

    // Digit grids and ticks are ONE character per printed box. Compressing one would slide it off
    // the box the authority drew for it, so they are deliberately left alone.
    assert.ok(
      !/<span class="f (?:grid|tick)"[^>]*><span class="ff">/u.test(html),
      `${name} wrapped a digit box — a compressed digit no longer sits in its printed box`,
    );
  }

  assert.match(
    FIT_TO_BOX_SCRIPT,
    /scaleX\(/u,
    "the fit must compress horizontally — wrapping and truncating are both ruled out",
  );
  assert.ok(
    !/ellipsis|textOverflow|substring|\.slice\(/u.test(FIT_TO_BOX_SCRIPT),
    "the fit must never drop a character from a legal document",
  );
}

/**
 * The two parties' columns on page 3 never overlap.
 *
 * Page 3 sets ممثل صاحب العمل and العامل side by side, each with its own printed labels and rules.
 * A right-aligned value extends LEFTWARDS from its right edge, so an employer box that starts too
 * far left fails nowhere visible in the layout file — it prints over the labels of the party
 * opposite, on the one page a labour inspector reads. Two attempts at this shipped wrong before the
 * third: one widened the box rightwards, over its OWN printed label; one measured the employee
 * column at its value rules (x=254.4) when what has to be cleared is its printed LABELS (~x=305).
 *
 * Classified by KEY and not by x, because classifying by x is exactly what a box that has drifted
 * into the wrong column would pass.
 */
function testThePartiesColumnsNeverOverlapOnPage3() {
  const employeeColumnRightEdge = 305;
  const employerKeys = new Set([
    "employerRepName",
    "employerRepTitle",
    "companyName",
    "companyHeadOffice",
  ]);
  const employeeKeys = new Set(["employeeName", "jobTitle", "nationalId", "address", "phone"]);

  for (const placement of MUTUAL_PAGE_3_PLACEMENTS) {
    if (employerKeys.has(placement.key)) {
      assert.ok(
        placement.x >= employeeColumnRightEdge,
        `the employer's "${placement.key}" starts at x=${placement.x}, inside the employee's printed labels`,
      );
      assert.ok(
        placement.x + boxWidth(placement) <= LABOUR_PAGE_WIDTH_PT,
        `the employer's "${placement.key}" runs off the right edge of the page`,
      );
    } else if (employeeKeys.has(placement.key)) {
      assert.ok(
        placement.x + boxWidth(placement) <= employeeColumnRightEdge,
        `the employee's "${placement.key}" ends at x=${placement.x + boxWidth(placement)}, inside the employer's column`,
      );
    } else {
      assert.fail(
        `page 3 gained an unclassified placement "${placement.key}" — which party's column is it in?`,
      );
    }
  }

  const headOffice = MUTUAL_PAGE_3_PLACEMENTS.find(
    (placement) => placement.key === "companyHeadOffice",
  );
  assert.ok(headOffice, "the agreement must print the company's registered premises");
  assert.equal(
    Number((headOffice.x + boxWidth(headOffice)).toFixed(1)),
    459.4,
    "the head-office box's RIGHT edge is where the printed “مقر الشركة :” label ends — the box grows leftwards, never over its own label",
  );
}

export function runHrFormsExitDocumentTests() {
  testForm6LayoutIsTheMeasuredForm();
  testEveryPlacementKeyIsBuilt();
  testTheBackOfForm6IsPrintedBlank();
  testNothingIsTypedOnASignatureLine();
  testForm6PrintsThreeDoubleSidedCopies();
  testTheTwoLabourFormsAreAlternatives();
  testBothAuthoritiesReadTheSameLastWorkingDay();
  testTheConfirmedDateOutranksTheRecordedOne();
  testExitGapsOnlyAppearOnceSomebodyIsLeaving();
  testALongValueIsCompressedNotSpilled();
  testThePartiesColumnsNeverOverlapOnPage3();
}
