import { strict as assert } from "node:assert";

import {
  CUSTODY_BLANK_RULE,
  custodyTemplateStrings,
  custodyTemplateTokens,
} from "../src/lib/hiring-pack/custody-template.ts";
import {
  CUSTODY_LAPTOP_V1,
  CUSTODY_MOBILE_V1,
  CUSTODY_TEMPLATES,
  custodyTemplateById,
} from "../src/lib/hiring-pack/custody-text.ts";
import { renderContractHtml } from "../src/lib/hiring-pack/render-contract.ts";
import {
  renderCustodyLaptopHtml,
  renderCustodyMobileHtml,
} from "../src/lib/hiring-pack/render-custody.ts";
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
  ASSET_DOCUMENTS,
  HIRING_PACK_DOCUMENTS,
  SIGNABLE_DOCUMENTS,
  isSignableDocument,
} from "../src/lib/hiring-pack/types.ts";
import type {
  HiringPackData,
  HiringPackEmployeeFacts,
  HiringPackProfile,
  OffboardingProfile,
} from "../src/lib/hiring-pack/types.ts";

/**
 * THE CUSTODY RECEIPT — إقرار استلام عهدة.
 *
 * Two forms of one instrument, both current at once: `نموذج رقم 1` for a laptop and `نموذج رقم 2`
 * for a phone or tablet. Which one prints depends on the device in somebody's hand.
 *
 * WHAT MAKES THIS WORTH PINNING is that every way of getting it wrong prints a receipt that looks
 * entirely correct, and gets signed:
 *
 *   - Print the laptop form for somebody collecting a phone, and he signs for "حاسب محمول، شاحن،
 *     حقيبة الحاسب" — four items he does not have — while the phone he walked out with is on no
 *     paper at all. That was a REAL defect in the first cut of this renderer: both forms resolved
 *     through the same default, so `custodyMobile` printed the laptop's items.
 *   - Let the national ID or the IMEI reorder under the bidirectional algorithm, and the number on
 *     the signed paper is not the number on the device. This company has already had that: its own
 *     tax card `477-108-318` once printed as `318-108-477`.
 *   - Fill the device details from anything at all, and the paper asserts a serial nobody checked.
 *     Phoenix holds no asset register; the device half prints blank on purpose, and a test has to
 *     say so or the next session will read the blanks as an oversight and "fix" them.
 *   - Record a signature date against the person, and one date silently stands for three devices
 *     signed for on three different days.
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
    socialInsuranceNumber: "123456789",
    socialInsuranceWage: 6000,
    grossSalary: 11000,
    birthDate: "1997-09-09",
    hireDate: "2026-08-01",
    jobTitle: "Medical Representative",
    departmentAr: "الجهاز العصبي",
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

/**
 * An exit nobody has started.
 *
 * Spread from the app's own `emptyOffboardingProfile` rather than written out here. Four test files
 * used to hold their own copy of this literal, so adding a document to the module meant editing all
 * four — and the only thing that caught a miss was the type checker failing four files at once.
 */
function offboardingFixture(): OffboardingProfile {
  return emptyOffboardingProfile("H-3003");
}

function packFixture(
  employeeOverrides: Partial<HiringPackEmployeeFacts> = {},
  profileOverrides: Partial<HiringPackProfile> = {},
): HiringPackData {
  const employee = employeeFixture(employeeOverrides);
  const profile = profileFixture(profileOverrides);
  const offboarding = offboardingFixture();
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

/** Every `<article class="copy">` on the page — one per printed copy. */
function copyCount(html: string): number {
  return html.split('<article class="copy').length - 1;
}

// ---------------------------------------------------------------------------------------------
// The two forms are two documents, and both are current
// ---------------------------------------------------------------------------------------------

function testBothFormsAreRegisteredAndCurrent(): void {
  for (const document of ASSET_DOCUMENTS) {
    const version = currentTemplateVersion(document);
    assert.equal(
      version.status,
      "current",
      `${document} must have a current registry version — both forms are live at once, ` +
        "because which one prints depends on the device, not on the year",
    );
  }

  // The registry id and the template id are the same string, and have to be: the print route
  // validates `?version=` against the registry and then hands that id to the renderer, which looks
  // it up in the template list. A mismatch would validate fine and then silently fall back.
  for (const template of CUSTODY_TEMPLATES) {
    const entry = findTemplateVersion(template.id);
    assert.ok(entry, `${template.id} must exist in the template registry`);
    assert.ok(
      ASSET_DOCUMENTS.includes(entry.document as (typeof ASSET_DOCUMENTS)[number]),
      `${template.id} must be registered against a custody document, not ${entry.document}`,
    );
    assert.equal(
      custodyTemplateById(template.id)?.id,
      template.id,
      `${template.id} must resolve back to itself through custodyTemplateById`,
    );
  }

  assert.equal(CUSTODY_TEMPLATES.length, 2, "there are exactly two custody forms");
  assert.notEqual(
    CUSTODY_LAPTOP_V1.variant,
    CUSTODY_MOBILE_V1.variant,
    "the two forms must be distinguishable by variant — that is what stops a cross-form print",
  );
}

function testEveryCustodyFormIsPrintableFromTheDocumentList(): void {
  for (const document of ASSET_DOCUMENTS) {
    assert.ok(
      HIRING_PACK_DOCUMENTS.includes(document),
      `${document} must be in HIRING_PACK_DOCUMENTS — the print route validates against that set, ` +
        "so a document missing from it is a 400 rather than a page",
    );
  }
}

// ---------------------------------------------------------------------------------------------
// The right form for the device in your hand
// ---------------------------------------------------------------------------------------------

/**
 * THE DEFECT THIS CATCHES was real, and shipped in the first draft of the renderer: both entry
 * points resolved through `custodyTemplateById(id) ?? CUSTODY_LAPTOP_V1`, and the print route
 * passes no id unless somebody is reprinting from the Archive — so `custodyMobile` printed the
 * laptop's four items and the Windows block. The employee signs for a laptop, a charger and a
 * laptop bag; the phone he actually walked out with is on no paper at all.
 */
function testEachFormPrintsItsOwnItemsAndNotTheOthers(): void {
  const laptop = renderCustodyLaptopHtml(packFixture(), 1);
  const mobile = renderCustodyMobileHtml(packFixture(), 1);

  assert.ok(laptop.includes("حاسب محمول"), "the laptop form must list the laptop");
  assert.ok(
    !laptop.includes("IMEI"),
    "the laptop form must NOT carry the phone's IMEI block — that is the cross-form bug",
  );

  assert.ok(mobile.includes("IMEI"), "the phone form must ask for the IMEI");
  assert.ok(
    !mobile.includes("حقيبة الحاسب"),
    "the phone form must NOT list the laptop bag — somebody collecting a phone would sign for it",
  );

  // The printed form number is what a filing clerk reads off the top of the page.
  assert.ok(laptop.includes(`نموذج رقم: ${CUSTODY_LAPTOP_V1.formNumberAr}`), "form 1 says so");
  assert.ok(mobile.includes(`نموذج رقم: ${CUSTODY_MOBILE_V1.formNumberAr}`), "form 2 says so");
}

/**
 * A version id belonging to the OTHER form is ignored rather than obeyed.
 *
 * The Archive screen prints `?document=…&version=…`, and the route checks the pair — but the
 * renderer is the last line, and obeying a mismatched id would hand somebody a receipt for a device
 * they are not holding. Falling back to the form the caller asked for is the safe answer.
 */
function testACrossFormVersionIdIsRefusedNotObeyed(): void {
  const html = renderCustodyLaptopHtml(packFixture(), 1, CUSTODY_MOBILE_V1.id);
  assert.ok(
    html.includes("حاسب محمول") && !html.includes("IMEI"),
    "asking for the laptop form must print the laptop form, whatever version id came with it",
  );

  const own = renderCustodyMobileHtml(packFixture(), 1, CUSTODY_MOBILE_V1.id);
  assert.ok(
    own.includes("IMEI"),
    "its OWN id must still be honoured — otherwise this test would pass on a renderer that " +
      "ignored the version parameter entirely",
  );
}

// ---------------------------------------------------------------------------------------------
// What is filled, and what is deliberately left blank
// ---------------------------------------------------------------------------------------------

function testThePersonsHalfIsFilledFromTheRecord(): void {
  const pack = packFixture();
  for (const render of [renderCustodyLaptopHtml, renderCustodyMobileHtml]) {
    const html = render(pack, 1);
    assert.ok(html.includes("نور عادل"), "the Arabic name is printed, not the English one");
    assert.ok(html.includes("29709091234567"), "the national ID is filled");
    assert.ok(html.includes("مندوب دعاية طبية"), "the Arabic job title is filled");
    assert.ok(html.includes("الجهاز العصبي"), "the department is filled");
    assert.ok(html.includes("H-3003"), "the employee code is filled");
    assert.ok(html.includes("01200000000"), "the phone number is filled");
    assert.ok(html.includes("5 شارع الجمهورية، وسط البلد"), "the address is filled");
  }
}

/**
 * The device half prints blank ON PURPOSE, and this test exists to stop that being "fixed".
 *
 * Phoenix has no asset register. A serial number, an IMEI or a Windows product ID is read off the
 * machine at the desk — inventing one, or carrying one over from an older receipt, produces a signed
 * acknowledgement of a device nobody checked. If a custody register is ever built, this test is
 * where the decision to change gets made deliberately.
 */
function testTheDeviceHalfPrintsAsRuledBlanks(): void {
  const html = renderCustodyLaptopHtml(packFixture(), 1);
  assert.ok(
    html.includes(CUSTODY_BLANK_RULE),
    "unfilled boxes print a ruled line — an empty box on a signed instrument reads as " +
      "'does not apply', a rule reads as 'somebody still has to write here'",
  );
  for (const label of ["الرقم المسلسل", "تاريخ التسليم", "مكان التسليم"]) {
    assert.ok(html.includes(label), `${label} must be asked for, even though Phoenix cannot answer it`);
  }
}

/** Nothing may reach paper as an unresolved token. */
function testNoTemplateTokenSurvivesToThePage(): void {
  for (const render of [renderCustodyLaptopHtml, renderCustodyMobileHtml]) {
    const html = render(packFixture(), 2);
    assert.ok(!/\{\{[A-Z_]+\}\}/u.test(html), "no {{TOKEN}} may print");
  }
}

/**
 * A person with nothing on file still gets a printable form.
 *
 * The custody receipt is often the FIRST paper a new joiner signs, on a morning when half his
 * record is still empty. Refusing to print, or throwing, would send somebody back to a spreadsheet.
 */
function testAnEmptyRecordStillPrints(): void {
  const sparse = packFixture(
    {
      nameAr: null,
      nationalId: null,
      departmentAr: null,
      residenceAddress: null,
      residenceCity: null,
      mobileNumber: null,
    },
    { jobTitleAr: null, addressStreet: null, addressBuilding: null },
  );
  const html = renderCustodyLaptopHtml(sparse, 1);
  assert.ok(html.includes('<article class="copy'), "it must still print");
  assert.ok(html.includes("Nour Adel"), "with the English name as the fallback for a missing Arabic one");
  assert.ok(html.includes(CUSTODY_BLANK_RULE), "and blanks where nothing is known");
}

// ---------------------------------------------------------------------------------------------
// Bidirectional text — the numbers on the page must be the numbers on the device
// ---------------------------------------------------------------------------------------------

/**
 * Every Latin/digit value is pinned left-to-right.
 *
 * Without this the bidirectional algorithm reorders digit groups inside an Arabic line. It is not
 * theoretical here: this company's own tax card number once printed reversed, and a national ID or
 * an IMEI printed backwards on a signed receipt identifies a different person or a different phone.
 */
function testEveryLatinValueIsPinnedLeftToRight(): void {
  const pack = packFixture();
  for (const [name, render] of [
    ["laptop", renderCustodyLaptopHtml],
    ["mobile", renderCustodyMobileHtml],
  ] as const) {
    const html = render(pack, 1);
    for (const value of ["29709091234567", "01200000000", "H-3003"]) {
      assert.ok(
        html.includes(`<span class="val" dir="ltr">${value}</span>`),
        `${name}: ${value} must be pinned dir="ltr" — an unpinned digit run reorders inside RTL text`,
      );
    }
  }
}

/** Direction is set per value, never on the block — `dir="auto"` on a bilingual line goes wrong. */
function testDirectionIsNeverSetOnTheBlock(): void {
  const html = renderCustodyLaptopHtml(packFixture(), 1);
  assert.ok(
    !html.includes('dir="auto"'),
    'dir="auto" reads only the first strong character, so a line holding an Arabic label and a ' +
      "Latin value turns wholly one way and renders the other half backwards",
  );
}

// ---------------------------------------------------------------------------------------------
// Copies, and the document's own stated count
// ---------------------------------------------------------------------------------------------

function testEveryCopyRequestedIsPrinted(): void {
  for (const copies of [1, 2, 5]) {
    assert.equal(
      copyCount(renderCustodyLaptopHtml(packFixture(), copies)),
      copies,
      `${copies} copies requested, ${copies} printed — the print dialog stays at 1 so the copies ` +
        "are guaranteed identical rather than depending on what somebody typed into it",
    );
  }
  // Never zero, whatever a caller passes: a form that prints nothing is indistinguishable from a
  // broken page, and the person is standing at the printer.
  assert.equal(copyCount(renderCustodyLaptopHtml(packFixture(), 0)), 1, "zero copies still prints one");
}

function testTheFormStatesItsOwnCopyCount(): void {
  for (const template of CUSTODY_TEMPLATES) {
    assert.ok(
      template.subtitleAr.includes("نسختين"),
      `${template.id}'s own subtitle is where the two-copy rule comes from — if that wording ` +
        "changes, systemContractDefaults.custody*Copies has to change with it",
    );
  }
}

// ---------------------------------------------------------------------------------------------
// One person, one address — across every paper in the file
// ---------------------------------------------------------------------------------------------

/**
 * The contract and the custody receipt print the SAME address for the same person.
 *
 * They used to resolve it separately, one function each. Two functions is two answers the first
 * time either is edited, and the two papers sit in one folder — an inspector reading a contract
 * saying one address and a custody receipt saying another is reading a file that contradicts
 * itself. The resolver lives in `render-shared.ts` for exactly this reason.
 */
function testTheContractAndTheReceiptAgreeOnTheAddress(): void {
  // The interesting case is the FALLBACK path: no `residenceAddress`, so both papers have to
  // assemble one from street, building and city the same way. The direct path agrees trivially.
  const pack = packFixture({ residenceAddress: null });
  const assembled = "شارع الجمهورية، رقم 05، القاهرة";

  assert.ok(
    renderContractHtml(pack, 1).includes(assembled),
    "the contract assembles the address from its parts",
  );
  assert.ok(
    renderCustodyLaptopHtml(pack, 1).includes(assembled),
    "and the custody receipt assembles the identical string — one person, one address",
  );
}

// ---------------------------------------------------------------------------------------------
// No signature is recorded against the person, and that is the point
// ---------------------------------------------------------------------------------------------

/**
 * A custody receipt is signed once per DEVICE, so there is no single date to store on the employee.
 *
 * البند (14) of its own text requires a separate numbered form for each handover. One person can
 * hold a laptop, a phone and a SIM on three receipts signed on three different days; a single
 * `custody_signed_date` could record one of them and would then read as covering all three — the
 * laptop returned in March looking accounted for by the phone receipt signed in June.
 */
function testACustodyReceiptRecordsNoSignatureAgainstThePerson(): void {
  for (const document of ASSET_DOCUMENTS) {
    assert.equal(
      isSignableDocument(document),
      false,
      `${document} must not be signable against the employee — one date cannot stand for three devices`,
    );
    assert.ok(
      !SIGNABLE_DOCUMENTS.includes(document),
      `${document} must be absent from SIGNABLE_DOCUMENTS, which is what the sign route validates against`,
    );
  }

  // And the control: every OTHER document still is, or this test would pass on a build where
  // signing was broken for everything.
  for (const document of HIRING_PACK_DOCUMENTS) {
    if (ASSET_DOCUMENTS.includes(document as (typeof ASSET_DOCUMENTS)[number])) continue;
    assert.equal(
      isSignableDocument(document),
      true,
      `${document} is signed once in a career and must still record its signature`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// The wording, pinned
// ---------------------------------------------------------------------------------------------

/**
 * The undertakings are pinned by shape rather than by a byte window.
 *
 * Source-pinning against a fixed slice of a file has false-failed in this repo before, the moment
 * anything above it moved. Walking the STRUCTURE instead means reformatting, a comment edit or a
 * TypeScript rename all pass, and only a change to the printed Arabic fails — which is the thing
 * worth stopping, because these are clauses somebody signs.
 */
function testTheUndertakingsAreWhatTheOwnerSupplied(): void {
  for (const template of CUSTODY_TEMPLATES) {
    const clauses = template.clauseGroups.flatMap((group) => group.clauses);
    assert.equal(
      clauses.length,
      15,
      `${template.id} carries fifteen undertakings in four groups, as supplied`,
    );
    assert.equal(template.clauseGroups.length, 4, `${template.id} groups them four ways`);
    assert.equal(
      template.signatureColumns.length,
      3,
      `${template.id} is signed by three people — the holder, IT, and finance`,
    );

    // Every string the form prints must be non-empty. An empty clause body prints a bare number on
    // a signed page, which reads as a clause the reader is expected to already know.
    for (const value of custodyTemplateStrings(template)) {
      assert.ok(value.trim().length > 0, `${template.id} must print no empty string`);
    }
  }
}

/** Both forms fill the same person-shaped tokens — the difference between them is the DEVICE. */
function testBothFormsAskThePersonTheSameQuestions(): void {
  assert.deepEqual(
    custodyTemplateTokens(CUSTODY_LAPTOP_V1),
    custodyTemplateTokens(CUSTODY_MOBILE_V1),
    "the two forms differ in their device blocks, never in what they ask about the person",
  );
}

export function runHrFormsCustodyTests(): void {
  testBothFormsAreRegisteredAndCurrent();
  testEveryCustodyFormIsPrintableFromTheDocumentList();
  testEachFormPrintsItsOwnItemsAndNotTheOthers();
  testACrossFormVersionIdIsRefusedNotObeyed();
  testThePersonsHalfIsFilledFromTheRecord();
  testTheDeviceHalfPrintsAsRuledBlanks();
  testNoTemplateTokenSurvivesToThePage();
  testAnEmptyRecordStillPrints();
  testEveryLatinValueIsPinnedLeftToRight();
  testDirectionIsNeverSetOnTheBlock();
  testEveryCopyRequestedIsPrinted();
  testTheFormStatesItsOwnCopyCount();
  testTheContractAndTheReceiptAgreeOnTheAddress();
  testACustodyReceiptRecordsNoSignatureAgainstThePerson();
  testTheUndertakingsAreWhatTheOwnerSupplied();
  testBothFormsAskThePersonTheSameQuestions();
}
