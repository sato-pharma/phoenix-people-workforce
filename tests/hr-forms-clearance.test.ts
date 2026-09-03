import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  CLEARANCE_BLANK_RULE,
  CLEARANCE_BLANK_RULE_WIDE,
  clearanceTemplateStrings,
  clearanceTemplateTokens,
} from "../src/lib/hiring-pack/clearance-template.ts";
import type { ClearanceTemplate } from "../src/lib/hiring-pack/clearance-template.ts";
import {
  CLEARANCE_COMPANY_V1,
  CLEARANCE_EMPLOYEE_V1,
  CLEARANCE_TEMPLATES,
  clearanceTemplateById,
} from "../src/lib/hiring-pack/clearance-text.ts";
import {
  renderClearanceCompanyHtml,
  renderClearanceEmployeeHtml,
} from "../src/lib/hiring-pack/render-clearance.ts";
import { renderContractHtml } from "../src/lib/hiring-pack/render-contract.ts";
import { buildForm6Values } from "../src/lib/hiring-pack/render-form6.ts";
import {
  collectHiringPackGaps,
  emptyOffboardingProfile,
  resolveContractTerms,
} from "../src/lib/hiring-pack/service.ts";
import {
  currentTemplateVersion,
  findTemplateVersion,
} from "../src/lib/hiring-pack/template-registry.ts";
import {
  CLEARANCE_DOCUMENTS,
  EXIT_DOCUMENTS,
  HIRING_PACK_DOCUMENTS,
  SIGNABLE_DOCUMENTS,
  isSignableDocument,
} from "../src/lib/hiring-pack/types.ts";
import type {
  ExitFacts,
  HiringPackData,
  HiringPackEmployeeFacts,
  HiringPackProfile,
  OffboardingProfile,
} from "../src/lib/hiring-pack/types.ts";

/**
 * THE CLEARANCE PAIR — إخلاء طرف.
 *
 * Two papers with almost the same title, which run in OPPOSITE directions. That is the whole
 * subject of this file, because every serious way of getting this wrong comes from reading them as
 * one document:
 *
 *   - Read them as ALTERNATIVES, the way the resignation and the mutual-termination agreement
 *     genuinely are, and you sign one and file it. Each paper protects the party who does not keep
 *     it, so signing only إخلاء طرف موظف leaves the company with no release, and signing only
 *     إخلاء طرف شركة leaves the employee with no certificate that he owes nothing. There is a
 *     CHECK constraint one table over that refuses two signed labour forms; if it ever grew to
 *     cover these two it would enforce the exact opposite of what they are for.
 *   - Print the wrong one for the wrong keeper and the same thing happens on paper.
 *   - Fill in the settlement amount from anywhere at all. The company's copy is a full and final
 *     release: the employee signs that the printed figure discharges everything owed for the whole
 *     period of employment. Phoenix does not compute a final settlement, so a figure printed there
 *     would be a number with no authority on a paper whose entire legal effect is agreement to the
 *     number — a signed waiver of money the employee is still owed. It prints blank, and a test has
 *     to say so, or the next session reads the blank as an oversight and "fixes" it.
 *   - Let a national ID or a date reorder under the bidirectional algorithm and the number on the
 *     signed paper is not the number anybody checked. This company has already had that: its own
 *     tax card `477-108-318` once printed as `318-108-477`.
 *
 * None of these is visible on a screenshot. All of them are visible here.
 */

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

const LAST_WORKING_DATE = "2026-08-24";

function employeeFixture(
  overrides: Partial<HiringPackEmployeeFacts> = {},
): HiringPackEmployeeFacts {
  return {
    hrId: "H-4004",
    fullName: "Nour Adel",
    nameAr: "نور عادل",
    nationalId: "29709091234567",
    // Left unrecorded so the fixtures exercise the national-ID derivation rather than masking it.
    gender: null,
    socialInsuranceNumber: "123456789",
    socialInsuranceWage: 6000,
    baseSalary: 11000,
    grossSalary: 14300,
    birthDate: "1997-09-09",
    hireDate: "2024-03-01",
    jobTitle: "Medical Representative",
    // The department, not the line.
    departmentAr: "المبيعات",
    departmentId: 1,
    lineId: 1,
    residenceAddress: "5 شارع الجمهورية، وسط البلد",
    residenceCity: "القاهرة",
    mobileNumber: "01200000000",
    workEmail: "nour@example.com",
    employmentStatus: "resigned",
    lastWorkingDate: LAST_WORKING_DATE,
    departed: true,
    ...overrides,
  };
}

function profileFixture(overrides: Partial<HiringPackProfile> = {}): HiringPackProfile {
  return {
    hrId: "H-4004",
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
    contractStartDate: "2024-03-01",
    contractEndDate: "2025-02-28",
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

function offboardingFixture(overrides: Partial<OffboardingProfile> = {}): OffboardingProfile {
  return {
    ...emptyOffboardingProfile("H-4004"),
    exitRoute: "resignation",
    endReasonAr: "ظروف خاصة",
    endReasonCode: "1",
    ...overrides,
  };
}

function packFixture(
  employeeOverrides: Partial<HiringPackEmployeeFacts> = {},
  offboardingOverrides: Partial<OffboardingProfile> = {},
  profileOverrides: Partial<HiringPackProfile> = {},
  exit: ExitFacts | null = null,
): HiringPackData {
  const employee = employeeFixture(employeeOverrides);
  const profile = profileFixture(profileOverrides);
  const offboarding = offboardingFixture(offboardingOverrides);
  return {
    employee,
    profile,
    offboarding,
    exit,
    suggestedJobTitleAr: null,
    gaps: collectHiringPackGaps(employee, profile, offboarding, exit),
    terms: resolveContractTerms(employee, profile, offboarding, exit),
  };
}

/** Every `<article class="copy">` on the page — one per printed copy. */
function copyCount(html: string): number {
  return html.split('<article class="copy').length - 1;
}

const MIGRATION = readFileSync(
  "supabase/migrations/20260830183000_employee_offboarding_profile.sql",
  "utf8",
);

// ---------------------------------------------------------------------------------------------
// Both papers exist, both are current, and both belong to the leaving half
// ---------------------------------------------------------------------------------------------

function testBothPapersAreRegisteredAndCurrent(): void {
  for (const document of CLEARANCE_DOCUMENTS) {
    const version = currentTemplateVersion(document);
    assert.equal(
      version.status,
      "current",
      `${document} must have exactly one current registry version`,
    );
    assert.ok(
      HIRING_PACK_DOCUMENTS.includes(document),
      `${document} must be one of the documents this module prints`,
    );
    assert.ok(
      EXIT_DOCUMENTS.includes(document),
      `${document} belongs to the leaving half — an employee still working is not cleared of anything`,
    );
  }

  // The registry id and the template id are the same string, and have to be: the print route
  // validates `?version=` against the registry and then hands that id to the renderer, which looks
  // it up in the template list. A mismatch would validate fine and then silently fall back.
  for (const template of CLEARANCE_TEMPLATES) {
    const entry = findTemplateVersion(template.id);
    assert.ok(entry, `${template.id} must exist in the template registry`);
    assert.ok(
      CLEARANCE_DOCUMENTS.includes(entry.document as (typeof CLEARANCE_DOCUMENTS)[number]),
      `${template.id} must be registered against a clearance document, not ${entry.document}`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// THE HEADLINE: the pair are COMPLEMENTS, not alternatives
// ---------------------------------------------------------------------------------------------

/**
 * Both are signed, independently, and nothing anywhere treats one as excluding the other.
 *
 * Checked at four levels because each catches a different way of collapsing them into a choice:
 * the type layer (both signable), the storage layer (two distinct columns, two distinct checklist
 * rows), the database layer (the CHECK constraint names the labour pair and only the labour pair),
 * and the screen (both cards render unconditionally, outside the exit-route branch that correctly
 * hides one of the two labour forms).
 */
function testTheClearancePairAreComplementsNotAlternatives(): void {
  for (const document of CLEARANCE_DOCUMENTS) {
    assert.ok(
      isSignableDocument(document),
      `${document} must be signable — a clearance that records no signature records nothing`,
    );
    assert.ok(
      SIGNABLE_DOCUMENTS.includes(document),
      `${document} must be in SIGNABLE_DOCUMENTS, which is what the sign route validates against`,
    );
  }

  // Two columns, not one. A single `clearance_signed_date` would make them alternatives by
  // construction: whichever was signed second would overwrite the first.
  const columns = [
    "clearance_employee_signed_date",
    "clearance_company_signed_date",
    "clearance_employee_printed_at",
    "clearance_company_printed_at",
  ];
  for (const column of columns) {
    assert.ok(
      MIGRATION.includes(column),
      `the offboarding migration must create ${column} — the service writes it by name`,
    );
  }

  // THE CONSTRAINT MUST NOT REACH THEM. It exists to stop two contradictory labour forms being
  // signed for one departure; applied here it would refuse the normal, required outcome.
  const constraint = MIGRATION.slice(
    MIGRATION.indexOf("employee_offboarding_profile_one_signed_exit_form"),
  ).slice(0, 400);
  assert.ok(
    constraint.includes("resignation_signed_date")
      && constraint.includes("mutual_termination_signed_date"),
    "the one-signed-exit-form CHECK must still cover the two labour alternatives",
  );
  assert.ok(
    !constraint.includes("clearance_"),
    "the one-signed-exit-form CHECK must NOT name a clearance column — the pair are complements, "
      + "and constraining them would refuse the outcome every departure is supposed to reach",
  );

  // Two checklist rows, so an employee file shows which half is outstanding.
  assert.ok(
    MIGRATION.includes("'Signed employee clearance'")
      && MIGRATION.includes("'Signed company clearance'"),
    "each half of the pair completes its own hiring-document checklist row",
  );

  // The screen. The two labour cards sit inside an `exitRoute === ...` ternary on purpose; these
  // two must not, or the paper that protects the other side disappears when nobody has yet chosen
  // a route.
  const manager = readFileSync("src/components/hiring-pack/hiring-pack-manager.tsx", "utf8");
  for (const document of CLEARANCE_DOCUMENTS) {
    assert.ok(
      manager.includes(`onPrint={() => openPrint("${document}")}`),
      `the manager screen must offer ${document}`,
    );
  }
  const ternaryStart = manager.indexOf('exitRoute === "resignation" ?');
  const ternaryEnd = manager.indexOf("</AdminCallout>", ternaryStart);
  const insideTheChoice = manager.slice(ternaryStart, ternaryEnd);
  for (const document of CLEARANCE_DOCUMENTS) {
    assert.ok(
      !insideTheChoice.includes(`openPrint("${document}")`),
      `${document} must render outside the exit-route choice — it is not an alternative to anything`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Each paper prints its OWN content
// ---------------------------------------------------------------------------------------------

/**
 * The employee's copy carries the departmental sign-off table; the company's carries the amount
 * block and the four undertakings. Neither carries the other's.
 *
 * This is the test that would have caught the real defect the custody pair had in their first cut,
 * where both forms resolved through the same default and one printed the other's items.
 */
function testEachPaperPrintsItsOwnBodyAndNotTheOthers(): void {
  const pack = packFixture();
  const employeeHtml = renderClearanceEmployeeHtml(pack, 1);
  const companyHtml = renderClearanceCompanyHtml(pack, 1);

  assert.match(employeeHtml, /إخلاء طرف موظف/u, "the employee's copy must carry its own title");
  assert.match(companyHtml, /إخلاء طرف شركة/u, "the company's copy must carry its own title");

  // The seven desks belong to the employee's copy alone.
  for (const row of CLEARANCE_EMPLOYEE_V1.blocks.flatMap((block) =>
    block.kind === "stations" ? block.rows : [],
  )) {
    assert.ok(
      employeeHtml.includes(row.departmentAr),
      `the employee's clearance must list ${row.departmentAr} as a signing desk`,
    );
    assert.ok(
      !companyHtml.includes(row.scopeAr),
      `${row.scopeAr} is a departmental sign-off scope and must not appear on the company's release`,
    );
  }

  // The four undertakings belong to the company's copy alone.
  const clauses = CLEARANCE_COMPANY_V1.blocks.flatMap((block) =>
    block.kind === "clauses" ? block.clauses : [],
  );
  assert.equal(clauses.length, 4, "the company's release is four numbered undertakings");
  for (const clause of clauses) {
    assert.ok(companyHtml.includes(clause.body), `the release must print undertaking ${clause.number}`);
    assert.ok(
      !employeeHtml.includes(clause.body),
      `undertaking ${clause.number} is the employee releasing the company — it must not appear on `
        + "the certificate the COMPANY issues, which would make him release it by signing a receipt",
    );
  }

  // And each names its own keeper, on the page, in a strip nobody has to read the title to see.
  assert.ok(
    employeeHtml.includes(CLEARANCE_EMPLOYEE_V1.keeperAr),
    "the employee's copy must say on its face who keeps it",
  );
  assert.ok(
    companyHtml.includes(CLEARANCE_COMPANY_V1.keeperAr),
    "the company's copy must say on its face who keeps it",
  );
  assert.notEqual(
    CLEARANCE_EMPLOYEE_V1.keeperAr,
    CLEARANCE_COMPANY_V1.keeperAr,
    "the two keeper strips must differ — an identical strip on both is the confusion, not the fix",
  );
}

/**
 * A version id belonging to the OTHER paper is ignored, not obeyed.
 *
 * The print route validates the pair before the renderer is reached, so this is the second line of
 * defence rather than the first — and it is the one that matters, because obeying such an id would
 * hand the employee the paper that releases the company.
 */
function testACrossPaperVersionIdIsRefusedNotObeyed(): void {
  const pack = packFixture();

  const employeeHtml = renderClearanceEmployeeHtml(pack, 1, CLEARANCE_COMPANY_V1.id);
  assert.match(
    employeeHtml,
    /إخلاء طرف موظف/u,
    "asking for the employee's clearance at the company clearance's version must still print the "
      + "employee's clearance",
  );
  assert.ok(
    !employeeHtml.includes(CLEARANCE_COMPANY_V1.keeperAr),
    "the wrong paper's keeper strip must not reach the page",
  );

  const companyHtml = renderClearanceCompanyHtml(pack, 1, CLEARANCE_EMPLOYEE_V1.id);
  assert.match(companyHtml, /إخلاء طرف شركة/u, "and the same in the other direction");

  // An id nobody recognises is not a crash either.
  const unknown = renderClearanceEmployeeHtml(pack, 1, "clearance-employee-v99");
  assert.match(unknown, /إخلاء طرف موظف/u, "an unknown version falls back to the current paper");
  assert.equal(clearanceTemplateById("clearance-employee-v99"), null);
}

// ---------------------------------------------------------------------------------------------
// THE AMOUNT IS NEVER FILLED IN
// ---------------------------------------------------------------------------------------------

/**
 * Not from the salary, not from anywhere.
 *
 * The company's copy is a full and final release. Phoenix does not compute a final settlement, so
 * there is no correct figure for it to print — and a wrong one is not a typo, it is a signed waiver
 * of money the employee is still owed.
 *
 * Pinned at the shape as well as the output: no token exists for it, so there is nothing for a
 * future edit to wire up by accident.
 */
function testTheSettlementAmountIsNeverPrinted(): void {
  for (const template of CLEARANCE_TEMPLATES) {
    for (const token of clearanceTemplateTokens(template)) {
      assert.ok(
        !/AMOUNT|SETTLEMENT|DUES|SALARY|WAGE|NET|GROSS/u.test(token),
        `${template.id} carries a token "${token}" that looks like money — the settlement figure is `
          + "written by the person who paid it, never by Phoenix",
      );
    }
  }

  // Rendered from a pack that holds a salary, so this cannot pass merely because the fixture is
  // empty. The salary must not appear anywhere on either paper.
  const pack = packFixture();
  assert.equal(pack.employee.baseSalary, 11000, "the fixture must carry a salary for this to mean anything");
  for (const html of [renderClearanceEmployeeHtml(pack, 1), renderClearanceCompanyHtml(pack, 1)]) {
    assert.ok(!html.includes("11000"), "no salary figure may reach a clearance paper");
    assert.ok(!html.includes("11,000"), "no salary figure may reach a clearance paper, formatted either");
  }

  // And the amount block is a rule for the pen, in figures AND in words.
  const companyHtml = renderClearanceCompanyHtml(pack, 1);
  assert.ok(
    companyHtml.includes("المبلغ بالأرقام") && companyHtml.includes("المبلغ كتابةً"),
    "the release must ask for the amount in figures and in words",
  );
  assert.ok(
    companyHtml.includes(CLEARANCE_BLANK_RULE) || companyHtml.includes(CLEARANCE_BLANK_RULE_WIDE),
    "the amount must print as a blank rule",
  );
}

// ---------------------------------------------------------------------------------------------
// The person's half fills, and fills correctly
// ---------------------------------------------------------------------------------------------

function testThePersonsHalfIsFilledFromTheRecord(): void {
  const pack = packFixture();

  for (const html of [renderClearanceEmployeeHtml(pack, 1), renderClearanceCompanyHtml(pack, 1)]) {
    assert.ok(html.includes("نور عادل"), "the person's Arabic name must be printed, not ruled");
    assert.ok(html.includes("29709091234567"), "the national ID must be printed");
    assert.ok(html.includes("مندوب دعاية طبية"), "the Arabic job title must be printed");
    assert.ok(html.includes("24 / 08 / 2026"), "the last working day must be printed, day / month / year");
  }

  // Each paper's own extras.
  const employeeHtml = renderClearanceEmployeeHtml(pack, 1);
  // The DEPARTMENT that employed him, not his product line — «الجهاز العصبي» is CNS and used to
  // print here off `lines.name`. Owner's correction, 2026-08-31.
  assert.ok(employeeHtml.includes("المبيعات"), "the employee's copy names the department");
  assert.ok(
    !employeeHtml.includes("الجهاز العصبي"),
    "a product line must never print as the department",
  );
  assert.ok(employeeHtml.includes("01 / 03 / 2024"), "the employee's copy prints the hire date");

  const companyHtml = renderClearanceCompanyHtml(pack, 1);
  assert.ok(
    companyHtml.includes("5 شارع الجمهورية، وسط البلد"),
    "the company's copy prints the address a claim would be served to",
  );
}

/**
 * The confirmed last working day outranks the recorded one, and every exit paper agrees.
 *
 * `employee_resignations` copies a single date into four of its columns, so the record agreeing
 * with itself proves nothing. What must hold is that when a human confirms a different date, Form 6
 * and both clearance papers print the SAME confirmed date — a departure with two end dates on two
 * signed papers is a dispute waiting to be had.
 */
function testEveryExitPaperPrintsTheSameDepartureDate(): void {
  const confirmed = "2026-08-31";
  const pack = packFixture({}, { lastWorkingDate: confirmed }, {}, {
    lastWorkingDate: "2026-08-20",
    resignationDate: "2026-08-20",
    effectiveDate: "2026-08-20",
    status: "approved",
    jobTitle: "Medical Representative",
  });

  assert.equal(pack.terms.lastWorkingDate, confirmed, "the confirmed override must win");

  for (const html of [renderClearanceEmployeeHtml(pack, 1), renderClearanceCompanyHtml(pack, 1)]) {
    assert.ok(html.includes("31 / 08 / 2026"), "a clearance paper must print the confirmed date");
    assert.ok(
      !html.includes("20 / 08 / 2026"),
      "the superseded record date must not reach a signed paper",
    );
  }

  // And Form 6 — filed with a different authority — reads the same value. Checked at the resolved
  // values rather than in its HTML, because Form 6 is placed over artwork: it puts the day, month
  // and year into three separate boxes, and searching the page for "31 / 08 / 2026" would find
  // nothing whether it were right or wrong.
  const form6 = buildForm6Values(pack);
  assert.equal(form6.endDay, "31", "Form 6 must file the same confirmed day");
  assert.equal(form6.endMonth, "08", "Form 6 must file the same confirmed month");
  assert.equal(form6.endYear, "2026", "Form 6 must file the same confirmed year");
}

/**
 * The contract, the custody receipt and both clearance papers print ONE address for one person.
 *
 * They resolve it through the same helper for exactly this reason. Four papers with four addresses
 * for the same employee is the failure this replaced.
 */
function testTheAddressIsTheSameOnEveryPaperThatPrintsIt(): void {
  const pack = packFixture();
  const contract = renderContractHtml(pack, 1);
  const clearance = renderClearanceCompanyHtml(pack, 1);

  const address = "5 شارع الجمهورية، وسط البلد";
  assert.ok(contract.includes(address), "the contract must print the resolved address");
  assert.ok(clearance.includes(address), "and the clearance release must print the identical string");
}

// ---------------------------------------------------------------------------------------------
// Direction, tokens and blanks
// ---------------------------------------------------------------------------------------------

/**
 * Every Latin or digit run is pinned `dir="ltr"`, and `dir="auto"` appears nowhere.
 *
 * `auto` reads only the first strong character, so on a line holding an Arabic label and a Latin
 * value it turns the whole line one way and renders the other half backwards. On a national ID that
 * means the number on the signed paper is not the number on the card.
 */
/**
 * The opening tag of the span wrapping exactly this value — see the same helper in
 * tests/hr-forms-custody.test.ts for why the tag is read rather than pinned whole.
 */
function enclosingTag(html: string, value: string): string | null {
  const at = html.indexOf(`>${value}</span>`);
  if (at < 0) return null;
  const open = html.lastIndexOf("<span", at);
  if (open < 0) return null;
  return html.slice(open, at + 1);
}

function testEveryLatinValueIsPinnedLeftToRight(): void {
  const pack = packFixture();

  for (const html of [renderClearanceEmployeeHtml(pack, 1), renderClearanceCompanyHtml(pack, 1)]) {
    assert.ok(
      !html.includes('dir="auto"'),
      'dir="auto" on a bilingual line is the bug, not the fix — direction is pinned per value',
    );

    for (const value of ["29709091234567", "24 / 08 / 2026"]) {
      const tag = enclosingTag(html, value);
      assert.ok(tag, `${value} does not appear on the clearance at all`);
      assert.ok(tag.includes('class="val"'), `${value} must print as a value cell`);
      assert.ok(
        tag.includes('dir="ltr"'),
        `${value} must be pinned left-to-right, or the bidirectional algorithm reorders its groups`,
      );
    }
  }
}

function testNoPlaceholderSurvivesToPaper(): void {
  for (const copies of [1, 2]) {
    for (const html of [
      renderClearanceEmployeeHtml(packFixture(), copies),
      renderClearanceCompanyHtml(packFixture(), copies),
      // And from an empty record, which is the case a placeholder is most likely to survive.
      renderClearanceEmployeeHtml(emptyPack(), copies),
      renderClearanceCompanyHtml(emptyPack(), copies),
    ]) {
      assert.ok(!/\{\{[A-Z_]+\}\}/u.test(html), "an unresolved {{TOKEN}} reached the page");
      assert.ok(!html.includes("undefined"), '"undefined" reached the page');
      assert.ok(!html.includes("null"), '"null" reached the page');
    }
  }
}

/** A record with nothing in it still prints — a half-filled pack must not block a departure. */
function emptyPack(): HiringPackData {
  return packFixture({
    nameAr: null,
    nationalId: null,
    departmentAr: null,
    residenceAddress: null,
    residenceCity: null,
    hireDate: null,
    lastWorkingDate: null,
  }, { lastWorkingDate: null }, { jobTitleAr: null });
}

function testAnEmptyRecordStillPrintsARuledForm(): void {
  for (const html of [renderClearanceEmployeeHtml(emptyPack(), 1), renderClearanceCompanyHtml(emptyPack(), 1)]) {
    assert.equal(copyCount(html), 1, "an empty record still produces a printable page");
    assert.ok(
      html.includes(CLEARANCE_BLANK_RULE),
      "a missing value prints a rule for the pen, never a guess",
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Copies
// ---------------------------------------------------------------------------------------------

function testEveryCopyRequestedIsPrinted(): void {
  const pack = packFixture();
  for (const copies of [1, 2, 3, 5]) {
    assert.equal(
      copyCount(renderClearanceEmployeeHtml(pack, copies)),
      copies,
      `${copies} copies were asked for and a different number were produced`,
    );
    assert.equal(copyCount(renderClearanceCompanyHtml(pack, copies)), copies);
  }
  // Nobody prints zero copies of a paper they asked to print.
  assert.equal(copyCount(renderClearanceEmployeeHtml(pack, 0)), 1);
  assert.equal(copyCount(renderClearanceCompanyHtml(pack, 0)), 1);
}

// ---------------------------------------------------------------------------------------------
// Nothing is decided for the person signing
// ---------------------------------------------------------------------------------------------

/**
 * No sign-off is pre-ticked, and no signature line is pre-filled.
 *
 * Phoenix's Clearance module holds each desk's recorded decision, and printing it here was
 * considered and refused: these rows carry a signature column, so "لا مستحقات: نعم" beside an
 * unsigned line asserts a sign-off nobody put a pen to.
 */
function testNothingIsDecidedForThePersonSigning(): void {
  const pack = packFixture();
  const employeeHtml = renderClearanceEmployeeHtml(pack, 1);

  // Every tick pair is offered unmarked — both boxes empty, on every row.
  const ticks = employeeHtml.split('<td class="tick">').length - 1;
  assert.equal(ticks, 7, "all seven desks must be offered a decision");
  assert.equal(
    employeeHtml.split("نعم ☐").length - 1,
    7,
    "every desk's ☐ must be empty — a pre-ticked box is a decision Phoenix did not make",
  );
  assert.ok(!employeeHtml.includes("☑"), "no box may be printed already ticked");

  for (const html of [employeeHtml, renderClearanceCompanyHtml(pack, 1)]) {
    // A signature block is three empty rules, not a typed name.
    assert.ok(html.includes("الاسم: <span"), "the signature name is a rule, not a printed name");
    assert.ok(!html.includes("نور عادل</span></p>"), "no signature line may be pre-filled");
  }
}

// ---------------------------------------------------------------------------------------------
// The gaps say which paper is waiting for what
// ---------------------------------------------------------------------------------------------

/**
 * The address is reported against the company's copy and NOT the employee's, because only one of
 * them prints it.
 *
 * A gap list that names a document the value never reaches sends HR chasing something for a form
 * that does not ask for it — and a gap list people stop reading is how forms got filled in blank in
 * the first place.
 */
function testGapsNameOnlyThePaperThatActuallyPrintsTheValue(): void {
  const pack = packFixture({ residenceAddress: null, residenceCity: null }, {}, { jobTitleAr: null });

  const address = pack.gaps.find((gap) => gap.field === "residenceAddress");
  assert.ok(address, "a missing address must be reported");
  assert.ok(
    address.documents.includes("clearanceCompany"),
    "the company's release prints محل الإقامة — a blank one must be chased",
  );
  assert.ok(
    !address.documents.includes("clearanceEmployee"),
    "the employee's certificate does not print an address, so it must not be listed as waiting for one",
  );

  const jobTitle = pack.gaps.find((gap) => gap.field === "jobTitleAr");
  assert.ok(jobTitle, "a missing Arabic job title must be reported");
  for (const document of CLEARANCE_DOCUMENTS) {
    assert.ok(
      jobTitle.documents.includes(document),
      `both clearance papers print الوظيفة, so ${document} is waiting for it`,
    );
  }

  // And the departure date reaches every leaving paper, clearance included.
  const departed = packFixture({ lastWorkingDate: null }, { lastWorkingDate: null });
  const lastWorking = departed.gaps.find((gap) => gap.field === "lastWorkingDate");
  assert.ok(lastWorking, "a departure with no end date must be reported");
  for (const document of CLEARANCE_DOCUMENTS) {
    assert.ok(
      lastWorking.documents.includes(document),
      `${document} prints آخر يوم عمل and is waiting for it too`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// The transcribed text is the owner's text
// ---------------------------------------------------------------------------------------------

/**
 * Every string in either template reaches the page, and every one of them is Arabic.
 *
 * Walks the STRUCTURE rather than a byte window of the source file — a byte-window pin false-fails
 * the moment anything above it moves, which has cost time in this repository before.
 */
function testEveryTranscribedStringReachesThePage(): void {
  const pack = packFixture();
  const rendered: Array<[ClearanceTemplate, string]> = [
    [CLEARANCE_EMPLOYEE_V1, renderClearanceEmployeeHtml(pack, 1)],
    [CLEARANCE_COMPANY_V1, renderClearanceCompanyHtml(pack, 1)],
  ];

  for (const [template, html] of rendered) {
    const strings = clearanceTemplateStrings(template);
    assert.ok(strings.length > 10, `${template.id} must carry its transcribed text, not a stub`);
    for (const value of strings) {
      if (value.trim().length === 0) continue;
      assert.ok(
        html.includes(value),
        `"${value}" is in ${template.id} and never reached the printed page`,
      );
    }
    assert.ok(
      /[؀-ۿ]/u.test(template.titleAr),
      `${template.id}'s title must be Arabic — these are Arabic-language instruments`,
    );
  }
}

/**
 * The paper never says HOW MANY departments have to sign.
 *
 * It used to. The certification read "the six departments above", and on 2026-08-30 the owner added
 * a seventh - fleet - which made that sentence false the moment the row landed. The table grew, the
 * sentence did not, and a paper that contradicts itself still looks finished: nobody reads a
 * certification clause counting the rows above it.
 *
 * The number of desks lives in Phoenix's Clearance module (`hr_clearance_stations`), which is a
 * table someone can add a row to. So the paper must not restate it. This asserts the printed prose
 * carries no Arabic count-word at all, which is a rule that keeps working however many desks there
 * are - unlike updating the number, which only works until the next time.
 */
function testTheCertificationNeverCountsTheDepartments(): void {
  const html = renderClearanceEmployeeHtml(packFixture(), 1);
  const countWords = ["الست", "السبع", "الخمس", "الثمان", "التسع", "العشر"];
  for (const word of countWords) {
    assert.ok(
      !html.includes("الإدارات " + word),
      `the certification prints "الإدارات ${word}" — a hard-coded count of the departments. ` +
        "How many desks sign is decided by hr_clearance_stations, not by this paper, so a number " +
        "here goes silently wrong the next time a desk is added. Say \"جميع الإدارات\" instead.",
    );
  }

  // And the count it must agree with is the one actually printed: every row gets a decision box.
  const rows = html.split('<td class="num">').length - 1;
  const ticks = html.split('<td class="tick">').length - 1;
  assert.equal(rows, ticks, "every department row must carry exactly one sign-off box");
}

export function runHrFormsClearanceTests() {
  testBothPapersAreRegisteredAndCurrent();
  testTheClearancePairAreComplementsNotAlternatives();
  testEachPaperPrintsItsOwnBodyAndNotTheOthers();
  testACrossPaperVersionIdIsRefusedNotObeyed();
  testTheSettlementAmountIsNeverPrinted();
  testThePersonsHalfIsFilledFromTheRecord();
  testEveryExitPaperPrintsTheSameDepartureDate();
  testTheAddressIsTheSameOnEveryPaperThatPrintsIt();
  testEveryLatinValueIsPinnedLeftToRight();
  testNoPlaceholderSurvivesToPaper();
  testAnEmptyRecordStillPrintsARuledForm();
  testEveryCopyRequestedIsPrinted();
  testNothingIsDecidedForThePersonSigning();
  testGapsNameOnlyThePaperThatActuallyPrintsTheValue();
  testEveryTranscribedStringReachesThePage();
  testTheCertificationNeverCountsTheDepartments();
}
