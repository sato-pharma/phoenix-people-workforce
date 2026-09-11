import { strict as assert } from "node:assert";

import { COMPANY_DETAILS_DEFAULT } from "../src/lib/hiring-pack/company-details.ts";
import {
  CUSTODY_BLANK_RULE,
  custodyDeviceTokens,
  custodyHolderTokens,
  custodyTemplateStrings,
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
  HOUSE_PAPER_DOCUMENTS,
  ONBOARDING_FORM_DOCUMENTS,
  RENEWAL_DOCUMENTS,
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
    // Left unrecorded so the fixtures exercise the national-ID derivation rather than masking it.
    gender: null,
    socialInsuranceNumber: "123456789",
    socialInsuranceWage: 6000,
    baseSalary: 11000,
    grossSalary: 14300,
    birthDate: "1997-09-09",
    hireDate: "2026-08-01",
    jobTitle: "Medical Representative",
    // The department, not the line.
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
    // Blank, which is the ordinary contract: the company's standing signatory signs it. A
    // value here means somebody else did, and replaces him everywhere the paper names him.
    contractSignatoryNameAr: null,
    contractSignatoryTitleAr: null,
    contractObjectiveReasonCode: null,
    ndaSignedDate: null,
    ndaPrintedAt: null,
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
  custodyDevice: HiringPackData["custodyDevice"] = null,
): HiringPackData {
  const employee = employeeFixture(employeeOverrides);
  const profile = profileFixture(profileOverrides);
  const offboarding = offboardingFixture();
  return {
    employee,
    profile,
    offboarding,
    exit: null,
    // NULL BY DEFAULT, and every existing test keeps that default deliberately: a custody receipt
    // is usually printed before the machine is in anybody's hand, so "no device chosen" is the
    // normal case and the one the blank-rules behaviour has to keep holding for.
    custodyDevice,
    renewal: null,
    company: COMPANY_DETAILS_DEFAULT,
    suggestedJobTitleAr: null,
    gaps: collectHiringPackGaps(employee, profile, offboarding, null),
    terms: resolveContractTerms(employee, profile, offboarding, null),
  };
}

/** A device as the register holds it, for the tests that print one. */
function deviceFixture(
  overrides: Partial<NonNullable<HiringPackData["custodyDevice"]>> = {},
): NonNullable<HiringPackData["custodyDevice"]> {
  return {
    assetTag: "PHX-LAP-0007",
    category: "laptop",
    itemValuesEgp: null,
    manufacturer: "Dell",
    model: "Latitude 5440",
    serialNumber: "7XKQ2V3",
    imei: null,
    deviceName: "SATO-LAP-0007",
    processor: "Intel Core i5-1345U",
    installedRam: "16.0 GB",
    systemType: "64-bit operating system",
    windowsDeviceId: "A1B2C3D4-1111-2222-3333-444455556666",
    windowsProductId: "00330-80000-00000-AA123",
    simNumber: null,
    lineNumber: null,
    ...overrides,
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
    // The DEPARTMENT that employs him, not his product line — «الجهاز العصبي» is CNS and used to
    // print here off `lines.name`. Owner's correction, 2026-08-31.
    assert.ok(html.includes("المبيعات"), "the department is filled");
    assert.ok(!html.includes("الجهاز العصبي"), "a product line must never print as the department");
    assert.ok(html.includes("H-3003"), "the employee code is filled");
    assert.ok(html.includes("01200000000"), "the phone number is filled");
    assert.ok(html.includes("5 شارع الجمهورية، وسط البلد"), "the address is filled");
  }
}

/**
 * WITH NO DEVICE CHOSEN the device half still prints blank, and that is the case this test now
 * guards — because it is the common one.
 *
 * THE DECISION THIS TEST INVITED HAS BEEN TAKEN. It used to read "Phoenix has no asset register…
 * if a custody register is ever built, this test is where the decision to change gets made
 * deliberately." The register was built (migration 20260907220000, `src/lib/devices/`), and the
 * decision taken was NOT "the device half is filled now". It was narrower, and the narrowness is
 * the whole of it:
 *
 *   - No device chosen  → ruled blanks, exactly as before. A pack is very often printed the evening
 *     before a joiner arrives, with no machine allocated yet; the form must still print, and a
 *     printed guess would be worse than a rule.
 *   - A device chosen   → its real serial, from the register row that is about to be issued to this
 *     person. Not invented, and not carried over from an older receipt.
 *
 * The original objection — "a signed acknowledgement of a device nobody checked" — is answered by
 * the print banner, which switches to telling the desk to CHECK what is printed against the machine
 * before signing. `testTheBannerTellsTheDeskWhichCaseItIsIn` pins that.
 */
function testTheDeviceHalfPrintsAsRuledBlanks(): void {
  const html = renderCustodyLaptopHtml(packFixture(), 1);
  assert.ok(
    html.includes(CUSTODY_BLANK_RULE),
    "unfilled boxes print a ruled line — an empty box on a signed instrument reads as " +
      "'does not apply', a rule reads as 'somebody still has to write here'",
  );
  for (const label of ["الرقم المسلسل", "تاريخ التسليم", "مكان التسليم"]) {
    assert.ok(html.includes(label), `${label} must be asked for`);
  }
  // The serial must not appear from ANYWHERE when no device was chosen. This file now carries a
  // device fixture, so "still blank" has to be asserted against a real value that could have leaked
  // in — not merely against a rule existing somewhere on a long page.
  assert.ok(
    !html.includes("7XKQ2V3"),
    "with no device chosen nothing may print a serial — there is no device to be right about",
  );
}

/**
 * WITH A DEVICE CHOSEN, the register's own numbers reach the paper.
 *
 * This is the half the register was built for. The number somebody signs for and the number the
 * company can hand to the police are then the same number by construction, instead of by somebody
 * copying seven characters off the underside of a laptop into a box.
 */
function testTheDeviceHalfFillsFromTheRegisterWhenADeviceIsChosen(): void {
  const html = renderCustodyLaptopHtml(packFixture({}, {}, deviceFixture()), 1);
  for (const value of [
    "Dell",
    "7XKQ2V3",
    "SATO-LAP-0007",
    "Intel Core i5-1345U",
    "16.0 GB",
    "64-bit operating system",
    "A1B2C3D4-1111-2222-3333-444455556666",
    "00330-80000-00000-AA123",
  ]) {
    assert.ok(html.includes(value), `${value} must print from the register`);
  }

  // نموذج رقم 2 asks different questions of a different device, and fills from the same row.
  const mobile = renderCustodyMobileHtml(
    packFixture(
      {},
      {},
      deviceFixture({
        assetTag: "PHX-TAB-0042",
        category: "tablet",
        manufacturer: "Samsung",
        model: "Galaxy Tab A9",
        serialNumber: null,
        imei: "356938035643809",
        simNumber: "8920011234567890123",
        lineNumber: "01001234567",
      }),
    ),
    1,
  );
  for (const value of [
    "356938035643809",
    "8920011234567890123",
    "01001234567",
    "Samsung Galaxy Tab A9",
  ]) {
    assert.ok(mobile.includes(value), `${value} must print on نموذج رقم 2 from the register`);
  }

  // THE VALUES AND THE HANDOVER DATE STAY RULED even here. They are counted and agreed at the desk
  // with the boxes open, and البند (1) has the holder accepting the goods as described on the form
  // — a pre-printed condition is a condition nobody inspected.
  assert.ok(
    mobile.includes(CUSTODY_BLANK_RULE),
    "the item values and the handover date print ruled whether or not the device is known",
  );
}

/**
 * The print banner has to describe the page it is stapled to.
 *
 * It said "the device details print blank by design" unconditionally, and that was true for as long
 * as they did. Left alone it would now tell the person at the desk to write into a box that already
 * carries the right serial — which is exactly how a correct number gets crossed out and replaced by
 * a hand-copied one.
 */
function testTheBannerTellsTheDeskWhichCaseItIsIn(): void {
  const blank = renderCustodyLaptopHtml(packFixture(), 1);
  assert.ok(
    blank.includes("The device details, values and handover date print blank by design."),
    "with no device chosen the banner still says the details print blank",
  );

  const filled = renderCustodyLaptopHtml(packFixture({}, {}, deviceFixture()), 1);
  assert.ok(
    filled.includes("CHECK them against the machine before signing"),
    "with a device chosen the banner must tell the desk to verify what is printed, not to write it",
  );
  assert.ok(
    !filled.includes("The device details, values and handover date print blank by design."),
    "the two banner lines are alternatives — printing both would contradict the page",
  );
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
/**
 * The opening tag of the span that wraps exactly this value, or null if nothing wraps it.
 *
 * Read this way rather than by pinning the whole serialization. The assertion's subject is that the
 * value is direction-pinned, and the tag now carries a second attribute — the marker that lets the
 * value be corrected on the printed page — which has nothing to do with direction. An exact-string
 * pin fails on that, reporting a direction bug that does not exist; a loose `includes` of just
 * `dir="ltr"` would pass even if the pin sat on some other value entirely. Finding the tag that
 * actually encloses this value and reading its attributes is what the test means.
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
  for (const [name, render] of [
    ["laptop", renderCustodyLaptopHtml],
    ["mobile", renderCustodyMobileHtml],
  ] as const) {
    const html = render(pack, 1);
    for (const value of ["29709091234567", "01200000000", "H-3003"]) {
      const tag = enclosingTag(html, value);
      assert.ok(tag, `${name}: ${value} does not appear on the receipt at all`);
      assert.ok(
        tag.includes('class="val"'),
        `${name}: ${value} must print as a value cell, not as loose text`,
      );
      assert.ok(
        tag.includes('dir="ltr"'),
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
  // signing was broken for everything. "Other" now means THREE classes of non-signable paper, not
  // one: the custody receipts above; the worker-data form — a service-file sheet filed in a drawer,
  // kept out of SIGNABLE_DOCUMENTS for the same reason; and, since 2026-09-05, the two renewal
  // papers. The renewal pair are out on the custody receipts' own reasoning rather than the worker
  // form's: a contract is renewed every year, so one date against the employee could record only
  // the newest of them, and `contract_renewal_requests` already holds one row per renewal with its
  // own `signed_at`. All three classes are skipped here.
  for (const document of HIRING_PACK_DOCUMENTS) {
    if (ASSET_DOCUMENTS.includes(document as (typeof ASSET_DOCUMENTS)[number])) continue;
    if (ONBOARDING_FORM_DOCUMENTS.includes(document as (typeof ONBOARDING_FORM_DOCUMENTS)[number])) {
      continue;
    }
    if (RENEWAL_DOCUMENTS.includes(document as (typeof RENEWAL_DOCUMENTS)[number])) continue;
    // FIVE of Sato's six are out on the same reasoning: the checklist, the service sheet and the
    // two appointment-documents forms are sheets filed in a drawer, and the absence notices are
    // issued repeatedly. THE NDA IS NOT SKIPPED — it got a real register on 2026-09-05, so it must
    // fall through to the assertion below and be signable like the contract. Naming it here rather
    // than filtering the whole group is what makes that difference visible.
    if (
      document !== "nda" &&
      HOUSE_PAPER_DOCUMENTS.includes(document as (typeof HOUSE_PAPER_DOCUMENTS)[number])
    ) {
      continue;
    }
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

/**
 * Both forms fill the same person-shaped tokens — the difference between them is the DEVICE.
 *
 * COMPARED PER HALF since the device register landed. This asserted equality over ALL tokens, which
 * was only true while the device half was empty on both forms — so it would have passed just as
 * happily if somebody had deleted a holder field from one of them, and it could only keep passing
 * by the device blocks staying blank. Split, it says what was meant: the same questions about the
 * PERSON, deliberately different ones about the DEVICE. Both halves are now load-bearing.
 */
function testBothFormsAskThePersonTheSameQuestions(): void {
  assert.deepEqual(
    custodyHolderTokens(CUSTODY_LAPTOP_V1),
    custodyHolderTokens(CUSTODY_MOBILE_V1),
    "the two forms differ in their device blocks, never in what they ask about the person",
  );

  const laptop = custodyDeviceTokens(CUSTODY_LAPTOP_V1);
  const mobile = custodyDeviceTokens(CUSTODY_MOBILE_V1);
  assert.notDeepEqual(
    laptop,
    mobile,
    "the device blocks are the whole reason there are two numbered forms",
  );
  assert.ok(
    laptop.includes("DEVICE_SERIAL") && !laptop.includes("DEVICE_IMEI"),
    "نموذج رقم 1 asks for a serial number and never an IMEI",
  );
  assert.ok(
    mobile.includes("DEVICE_IMEI") && !mobile.includes("DEVICE_SERIAL"),
    "نموذج رقم 2 asks for an IMEI and never a serial number",
  );
}

export function runHrFormsCustodyTests(): void {
  testBothFormsAreRegisteredAndCurrent();
  testEveryCustodyFormIsPrintableFromTheDocumentList();
  testEachFormPrintsItsOwnItemsAndNotTheOthers();
  testACrossFormVersionIdIsRefusedNotObeyed();
  testThePersonsHalfIsFilledFromTheRecord();
  testTheDeviceHalfPrintsAsRuledBlanks();
  testTheDeviceHalfFillsFromTheRegisterWhenADeviceIsChosen();
  testTheBannerTellsTheDeskWhichCaseItIsIn();
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
