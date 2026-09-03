import { strict as assert } from "node:assert";

import { systemContractDefaults, systemLegalEntity } from "../src/config/system-settings.ts";
import { spellEgyptianAmount, splitPoundsAndPiastres } from "../src/lib/hiring-pack/arabic-amount.ts";
import {
  FORM1_PAGE_1_PLACEMENTS,
  FORM1_PAGE_2_PLACEMENTS,
  FORM1_PAGE_HEIGHT_PT,
  FORM1_PAGE_WIDTH_PT,
  FORM1_WAGE_GRIDS,
} from "../src/lib/hiring-pack/form1-layout.ts";
import {
  renderClearanceCompanyHtml,
  renderClearanceEmployeeHtml,
} from "../src/lib/hiring-pack/render-clearance.ts";
import { renderContractHtml } from "../src/lib/hiring-pack/render-contract.ts";
import {
  renderCustodyLaptopHtml,
  renderCustodyMobileHtml,
} from "../src/lib/hiring-pack/render-custody.ts";
import { renderForm1Html } from "../src/lib/hiring-pack/render-form1.ts";
import { renderForm6Html } from "../src/lib/hiring-pack/render-form6.ts";
import {
  renderMutualTerminationHtml,
  renderResignationHtml,
} from "../src/lib/hiring-pack/render-labour-exit.ts";
import {
  DEFAULT_NATIONALITY_AR,
  DEFAULT_NATIONALITY_AR_FEMALE,
} from "../src/lib/hiring-pack/nationality.ts";
import { resolveFixedSalaryAmounts } from "../src/lib/payroll/policy.ts";
import {
  addMonthsToIsoDate,
  COMPANY_REGISTRATION_GAPS,
  collectHiringPackGaps,
  emptyOffboardingProfile,
  resolveContractTerms,
  resolveFactsCompensationFields,
} from "../src/lib/hiring-pack/service.ts";
import type {
  ExitFacts,
  HiringPackData,
  HiringPackEmployeeFacts,
  HiringPackProfile,
  OffboardingProfile,
} from "../src/lib/hiring-pack/types.ts";

/**
 * The hiring pack — the printed employment contract and government Form 1.
 *
 * These two documents are handed to a new employee to sign and then filed with the National
 * Organization for Social Insurance. Nothing here is cosmetic: a value in the wrong box on Form 1
 * is a form the office rejects, and a salary spelled wrong in the contract is, in Egyptian contract
 * practice, a DIFFERENT SALARY — the words control when they disagree with the digits.
 *
 * So this file pins three things that a later edit could plausibly and invisibly break:
 *
 *   1. THE COORDINATE MAP. Every box grid on Form 1 was measured off the source PDF's own drawing
 *      operators. Cell counts and column order are asserted here because both have already been
 *      got wrong once during construction — the occupation code was counted as seven boxes when it
 *      is six, and the جنيه and قرش columns were rendered the wrong way round.
 *
 *   2. THE BLANK BACK PAGE. The owner's instruction on 2026-08-22 was that the government form
 *      prints exactly as the Authority issues it, with nothing of Phoenix's own written on it. Page
 *      2 therefore carries no placements at all, and no rendered value. That is a product decision
 *      a future session cannot reverse by accident.
 *
 *   3. THE تفقيط. Arabic number-agreement, with the two cases that were wrong when written: 11 and
 *      above take the singular accusative (اثنا عشر ألفاً, not اثنا عشر ألف), and a scale word or a
 *      dual sitting directly against the counted noun goes into إضافة and loses its ending
 *      (اثنا عشر ألف جنيه, مائتا جنيه, ألفا جنيه).
 */

function employeeFixture(overrides: Partial<HiringPackEmployeeFacts> = {}): HiringPackEmployeeFacts {
  return {
    hrId: "H-1001",
    fullName: "Mona Abdelrahman",
    nameAr: "منى عبد الرحمن",
    // Fourteen digits, which is the real length of an Egyptian national ID and the number of boxes
    // the form prints for it.
    nationalId: "29801011234567",
    // Left unrecorded so the fixtures exercise the national-ID derivation rather than masking it.
    gender: null,
    socialInsuranceNumber: "123456789",
    socialInsuranceWage: 6000,
    // 12,750.50 is the figure the Arabic amount-in-words cases above are written against, and the
    // contract prints the BASE salary — so it is the base that carries it.
    baseSalary: 12750.5,
    grossSalary: 16000,
    birthDate: "1998-01-01",
    hireDate: "2026-08-01",
    jobTitle: "Medical Representative",
    // The DEPARTMENT, not the line: this person is in Sales and works the CNS line.
    departmentAr: "المبيعات",
    departmentId: 1,
    lineId: 1,
    residenceAddress: "12 شارع النيل، المعادي",
    residenceCity: "القاهرة",
    mobileNumber: "01000000000",
    workEmail: "mona@example.com",
    employmentStatus: "active",
    // Employed, so no departure date. The exit half of the module reads this to decide
    // whether somebody is leaving at all — see tests/hr-forms-exit-documents.test.ts.
    lastWorkingDate: null,
    departed: false,
    ...overrides,
  };
}

function profileFixture(overrides: Partial<HiringPackProfile> = {}): HiringPackProfile {
  return {
    hrId: "H-1001",
    nationality: "مصرية",
    qualification: "بكالوريوس صيدلة",
    birthPlace: "القاهرة",
    jobTitleAr: "مندوب دعاية طبية",
    occupationCode: "123456",
    insuranceOffice: "المعادي",
    addressBuilding: "12",
    addressDistrict: "01",
    addressStreet: "شارع النيل",
    addressMarkaz: "02",
    addressGovernorate: "01",
    contractDurationMonths: null,
    contractStartDate: null,
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
 * An exit nobody has started.
 *
 * Spread from the app's own `emptyOffboardingProfile` rather than written out here. Four test files
 * used to hold their own copy of this literal, so adding a document to the module meant editing all
 * four — and the only thing that caught a miss was the type checker failing four files at once.
 */
function offboardingFixture(overrides: Partial<OffboardingProfile> = {}): OffboardingProfile {
  return { ...emptyOffboardingProfile("H-1001"), ...overrides };
}

function packFixture(
  employeeOverrides: Partial<HiringPackEmployeeFacts> = {},
  profileOverrides: Partial<HiringPackProfile> = {},
  offboardingOverrides: Partial<OffboardingProfile> | null = null,
  exit: ExitFacts | null = null,
): HiringPackData {
  const employee = employeeFixture(employeeOverrides);
  const profile = profileFixture(profileOverrides);
  const offboarding = offboardingFixture(offboardingOverrides ?? {});
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

/** Every `<section class="sheet">` in a rendered Form 1, in print order. */
function form1Sheets(html: string): string[] {
  return html.split('<section class="sheet">').slice(1);
}

type WageCell = { digit: string; left: string; top: string; width: string };

function wageCells(html: string): WageCell[] {
  const pattern =
    /<span class="f wage" style="left:([\d.]+)pt;top:([\d.]+)pt;width:([\d.]+)pt;height:[\d.]+pt;line-height:[\d.]+pt">(.)<\/span>/g;
  return [...html.matchAll(pattern)].map((match) => ({
    left: match[1],
    top: match[2],
    width: match[3],
    digit: match[4],
  }));
}

function testForm1LayoutIsTheMeasuredForm() {
  const byKey = new Map(FORM1_PAGE_1_PLACEMENTS.map((placement) => [placement.key, placement]));
  assert.equal(
    byKey.size,
    FORM1_PAGE_1_PLACEMENTS.length,
    "two placements share a key — the second would print on top of the first",
  );

  // The cell counts read straight off the form's own printed boxes. A wrong count does not fail
  // visibly: it silently clips the last digit of a national ID or leaves a box empty.
  const cellCounts: Record<string, number> = {
    nationalId: 14,
    insuranceNumber: 9,
    establishmentNumber: 8,
    sectorCode: 2,
    occupationCodeLeft: 3,
    occupationCodeRight: 3,
    addressBuilding: 4,
    addressDistrict: 2,
    addressMarkaz: 2,
    addressGovernorate: 2,
    startDay: 2,
    startMonth: 2,
    startYear: 4,
  };
  for (const [key, cells] of Object.entries(cellCounts)) {
    const placement = byKey.get(key);
    assert.ok(placement, `Form 1 has no placement for ${key}`);
    assert.equal(placement.kind, "digits", `${key} must be a box grid`);
    if (placement.kind !== "digits") return;
    assert.equal(placement.cells, cells, `${key} must cover ${cells} printed boxes`);
  }

  // كود المهنة is six boxes in TWO groups with a printed gap between them. The two grids must not
  // run into each other, or three digits land on the divider.
  const left = byKey.get("occupationCodeLeft");
  const right = byKey.get("occupationCodeRight");
  assert.ok(left?.kind === "digits" && right?.kind === "digits");
  if (left.kind !== "digits" || right.kind !== "digits") return;
  assert.ok(
    left.x + left.pitch * left.cells <= right.x,
    "the two occupation-code groups overlap — the left group would print over the gap",
  );

  // Nothing may sit off the paper.
  for (const placement of FORM1_PAGE_1_PLACEMENTS) {
    const width = placement.kind === "digits" ? placement.pitch * placement.cells : placement.w;
    assert.ok(placement.x >= 0, `${placement.key} starts left of the page`);
    assert.ok(
      placement.x + width <= FORM1_PAGE_WIDTH_PT,
      `${placement.key} runs off the right edge of the page`,
    );
    assert.ok(
      placement.y + placement.h <= FORM1_PAGE_HEIGHT_PT,
      `${placement.key} runs off the bottom of the page`,
    );
  }
}

function testWagePoundsAreOnTheLeft() {
  assert.equal(FORM1_WAGE_GRIDS.length, 3, "the form has three wage grids");

  for (const grid of FORM1_WAGE_GRIDS) {
    assert.equal(grid.pounds.cells, 5, `${grid.key}: جنيه is five printed cells`);
    assert.equal(grid.piastres.length, 2, `${grid.key}: قرش is two printed cells`);

    // The pounds column is the WIDER one and it is on the LEFT — read off the printed header
    // labels' own bounding boxes. Getting this backwards puts the piastres where the thousands go.
    const poundsEnd = grid.pounds.x + grid.pounds.pitch * grid.pounds.cells;
    assert.ok(
      poundsEnd <= grid.piastres[0].x,
      `${grid.key}: the جنيه block must end before the قرش block begins`,
    );
    assert.ok(
      grid.piastres[0].x + grid.piastres[0].w <= grid.piastres[1].x,
      `${grid.key}: the two قرش cells overlap`,
    );
  }
}

function testTheBackOfForm1IsPrintedBlank() {
  // The owner's instruction, 2026-08-22: the government form prints exactly as the Authority
  // issues it. Nothing of Phoenix's goes on the back.
  assert.deepEqual(
    FORM1_PAGE_2_PLACEMENTS,
    [],
    "page 2 of Form 1 must carry no Phoenix-written values — it is the government's own back page",
  );

  const html = renderForm1Html(packFixture(), 2);
  const sheets = form1Sheets(html);
  assert.equal(sheets.length, 4, "two copies of a two-sided form is four sheets");

  for (const [index, sheet] of sheets.entries()) {
    const isBack = index % 2 === 1;
    assert.ok(
      sheet.includes(isBack ? "form1-page2.svg" : "form1-page1.svg"),
      `sheet ${index + 1} carries the wrong side of the artwork`,
    );
    if (isBack) {
      assert.ok(
        !sheet.includes('class="f'),
        `sheet ${index + 1} is the back page and must carry no written value`,
      );
    }
  }
}

function testForm1PrintsOneSheetPairPerCopy() {
  const html = renderForm1Html(packFixture(), systemContractDefaults.form1Copies);

  assert.equal(
    form1Sheets(html).length,
    systemContractDefaults.form1Copies * 2,
    "three copies of Form 1 is six pages — three duplex sheets",
  );

  // US Legal, in the source PDF's own points. A4 would shrink or clip the form.
  assert.ok(
    html.includes(`@page { size: ${FORM1_PAGE_WIDTH_PT}pt ${FORM1_PAGE_HEIGHT_PT}pt; margin: 0; }`),
    "Form 1 must ask for US Legal at the source document's exact size",
  );
  // The duplex instruction is the owner's standing requirement and reaches the person at the
  // printer only through this banner.
  assert.ok(
    html.includes("DOUBLE-SIDED"),
    "the print banner must tell the operator to print both sides",
  );
  assert.ok(
    html.includes("US Legal"),
    "the print banner must name the paper size",
  );
}

function testForm1ClipsToItsPrintedBoxes() {
  // Fourteen boxes hold fourteen digits. A longer value must be clipped, never spilled across the
  // form — so a 20-digit id renders EXACTLY the same page as its first 14 digits alone.
  const fourteen = renderForm1Html(packFixture({ nationalId: "29801011234567" }), 1);
  const twenty = renderForm1Html(packFixture({ nationalId: "29801011234567890123" }), 1);
  assert.equal(twenty, fourteen, "a national ID longer than 14 digits must be clipped to the boxes");
}

function testForm1WritesTheWageIntoTheRightColumns() {
  // THE THREE COLUMNS CARRY THREE DIFFERENT FIGURES (owner, 2026-08-31). With a base of 7,800:
  //   الأجر الشامل  = the base salary itself     = 7,800
  //   أجر الاشتراك   = base ÷ 1.3, capped         = 6,000
  //   الأجر الأساسي = the flat statutory figure  = 2,450
  //
  // 7,800 is chosen because it divides evenly, so these expectations test the COLUMN MAPPING rather
  // than the rounding rule. `socialInsuranceWage` is overridden to a value appearing nowhere in the
  // expected output: the fixture stores 6,000, and leaving it there would let a renderer that
  // wrongly read the stored column pass the أجر الاشتراك assertion by coincidence.
  const html = renderForm1Html(packFixture({ baseSalary: 7800, socialInsuranceWage: 4321 }), 1);
  const cells = wageCells(html);

  assert.equal(cells.length, 18, "three wage grids of six cells each");

  /** The six digits of one grid, read left to right: four pounds, then the two piastres. */
  const digitsBetween = (from: number, to: number): string =>
    cells
      .filter((cell) => Number(cell.left) >= from && Number(cell.left) < to)
      .sort((a, b) => Number(a.left) - Number(b.left))
      .map((cell) => cell.digit)
      .join("");

  // The grids sit side by side across the page — الشامل on the left, الاشتراك in the middle,
  // الأساسي on the right. Reading them by x is what proves each value landed in its OWN column.
  assert.equal(digitsBetween(0, 200), "780000", "الأجر الشامل must carry the base salary, 7,800");
  assert.equal(digitsBetween(200, 400), "600000", "أجر الاشتراك must carry base ÷ 1.3, 6,000");
  assert.equal(digitsBetween(400, 999), "245000", "الأجر الأساسي must carry the flat 2,450");

  assert.ok(
    !html.includes("4321") && !html.includes("4,321"),
    "the stored social_insurance_wage must not reach Form 1 — أجر الاشتراك is derived from the base",
  );

  // Every grid was filled from the subscription wage until 2026-08-31, which printed ONE number
  // three times and understated الأجر الشامل by the whole ÷1.3. These two catch that regression.
  assert.notEqual(
    digitsBetween(0, 200),
    digitsBetween(200, 400),
    "الأجر الشامل and أجر الاشتراك must differ — they are not the same wage",
  );
  assert.notEqual(
    digitsBetween(200, 400),
    digitsBetween(400, 999),
    "أجر الاشتراك and الأجر الأساسي must differ — the basic wage is a flat figure",
  );

  // أجر أساسي is the only grid whose value row sits at y=448.2 — the other two are at 448.1. Its
  // exact cell positions stay pinned here, because a shifted column is invisible in a digit string.
  assert.deepEqual(
    cells.filter((cell) => cell.top === "448.2").map((cell) => `${cell.left}:${cell.digit}`),
    [
      // Pounds, right-aligned so the units digit lands in the LAST of the five cells. 2,450 is four
      // digits, so the leading cell at 440.70 stays empty rather than reading ten times too large.
      "451.80:2",
      "462.90:4",
      "474.00:5",
      "485.10:0",
      // Piastres, always two digits — an empty قرش column reads as an unfinished form.
      "496.70:0",
      "510.20:0",
    ],
    "the جنيه digits must fill the left block from the right, and the قرش block must follow it",
  );

  // The GROSS salary must never reach this form — none of the three columns is the gross.
  assert.ok(
    !html.includes(">12750<") && !html.includes("12,750"),
    "the gross salary must not appear on Form 1",
  );
}

function testForm1WageGridKeysAreAllMapped() {
  // An exhaustive mapping does NOT gate the build here — `ignoreBuildErrors` lets a missing case
  // compile, build and deploy. So the union in `form1-layout.ts` is backed by this runtime check:
  // if a fourth grid is added or a key renamed, this fails instead of printing an empty column on
  // a government form.
  assert.deepEqual(
    [...FORM1_WAGE_GRIDS].map((grid) => grid.key).sort(),
    ["basicWage", "comprehensiveWage", "subscriptionWage"],
    "Form 1 has exactly three wage grids and the renderer maps each one by name",
  );

  const cells = wageCells(renderForm1Html(packFixture({ baseSalary: 7800 }), 1));
  assert.equal(
    cells.length,
    FORM1_WAGE_GRIDS.length * 6,
    "every wage grid must render its six cells — an unmapped key silently prints an empty column",
  );
}

function testContractPrintsFourCopiesOnA4() {
  const data = packFixture();
  const html = renderContractHtml(data, systemContractDefaults.contractCopies);

  // Match the class PREFIX, not the whole attribute: a copy carries a layout modifier beside
  // `copy` (`copy--prose` for the archived text, `copy--banded` for the current one), so pinning
  // the closing quote counts zero copies the moment a version renders in anything but the
  // original layout — which reads as "the contract printed nothing", not as a stale selector.
  assert.equal(
    html.split('<article class="copy').length - 1,
    4,
    'مادة (19) says "حُرر هذا العقد من أربع نسخ" — four copies',
  );
  assert.ok(html.includes("@page { size: A4;"), "the contract prints on A4");

  // The salary appears twice in مادة (2): once in digits and once in words, and the words control.
  assert.ok(html.includes("12,750.50"), "the salary figure must carry its piastres");
  assert.ok(
    html.includes(spellEgyptianAmount(12750.5)),
    "the salary must also be spelled out — the words are what control in Egyptian practice",
  );
  // A field label and its value must never be split across a line break.
  assert.ok(html.includes('class="field"'), "party field lines must be kept unbreakable");
}

function testTafqitAgreement() {
  // The four shapes of the counted noun.
  assert.equal(spellEgyptianAmount(1), "جنيه مصري");
  assert.equal(spellEgyptianAmount(2), "جنيهان مصريان");
  assert.equal(spellEgyptianAmount(3), "ثلاثة جنيهات مصرية");
  assert.equal(spellEgyptianAmount(11), "أحد عشر جنيهاً مصرياً");
  assert.equal(spellEgyptianAmount(100), "مائة جنيه مصري");

  // Eleven and above take the SINGULAR ACCUSATIVE, and a scale word directly against the counted
  // noun is in إضافة and loses that ending. Both were wrong when this module was written.
  assert.equal(spellEgyptianAmount(12000), "اثنا عشر ألف جنيه مصري");
  assert.equal(spellEgyptianAmount(12750.5), "اثنا عشر ألفاً وسبعمائة وخمسون جنيهاً مصرياً وخمسون قرشاً");

  // A dual in إضافة drops its nūn: ألفان alone, ألفا جنيه with the noun; مائتان alone, مائتا جنيه.
  assert.equal(spellEgyptianAmount(2000), "ألفا جنيه مصري");
  assert.equal(spellEgyptianAmount(2000000), "مليونا جنيه مصري");
  assert.equal(spellEgyptianAmount(200), "مائتا جنيه مصري");
  assert.equal(spellEgyptianAmount(200000), "مائتا ألف جنيه مصري");
  // ...but only when nothing separates them. 250 keeps the nūn.
  assert.equal(spellEgyptianAmount(250), "مائتان وخمسون جنيهاً مصرياً");

  // A blank, never "صفر جنيه" — a spelled zero on a contract gets signed, a blank gets questioned.
  assert.equal(spellEgyptianAmount(0), "");
  assert.equal(spellEgyptianAmount(null), "");
  assert.equal(spellEgyptianAmount(1_000_000_000), "");

  // Form 1 has no decimal point anywhere — جنيه and قرش are physically different boxes.
  assert.deepEqual(splitPoundsAndPiastres(6250.5), { pounds: "6250", piastres: "50" });
  assert.deepEqual(splitPoundsAndPiastres(6250), { pounds: "6250", piastres: "00" });
  assert.equal(splitPoundsAndPiastres(null), null);
}

function testContractTermsFallBackToTheCompanyDefault() {
  const plain = resolveContractTerms(employeeFixture(), profileFixture());
  assert.equal(plain.durationMonths, systemContractDefaults.durationMonths);
  assert.equal(plain.probationMonths, systemContractDefaults.probationMonths);
  assert.equal(plain.trainingBondMonths, systemContractDefaults.trainingBondMonths);
  // A contract with no start date is not a contract; the hire date is what the paper version has
  // always carried.
  assert.equal(plain.contractStartDate, "2026-08-01");
  assert.equal(plain.contractEndDate, "2027-08-01");

  const overridden = resolveContractTerms(
    employeeFixture(),
    profileFixture({ contractDurationMonths: 6, contractStartDate: "2026-09-15" }),
  );
  assert.equal(overridden.durationMonths, 6);
  assert.equal(overridden.contractStartDate, "2026-09-15");
  assert.equal(overridden.contractEndDate, "2027-03-15");

  // The end date is DERIVED unless deliberately overridden, so a corrected start date can never
  // leave a stale end date behind it.
  const pinned = resolveContractTerms(
    employeeFixture(),
    profileFixture({ contractEndDate: "2027-12-31" }),
  );
  assert.equal(pinned.contractEndDate, "2027-12-31");

  // Month arithmetic clamps the day rather than rolling into the next month.
  assert.equal(addMonthsToIsoDate("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonthsToIsoDate("2026-08-22", 12), "2027-08-22");
  assert.equal(addMonthsToIsoDate(null, 12), null);
  assert.equal(addMonthsToIsoDate("2026-08-22", null), null);
}

function testGapsSeparateBlockingFromChaseLater() {
  const complete = collectHiringPackGaps(employeeFixture(), profileFixture());
  const byField = new Map(complete.map((gap) => [gap.field, gap]));

  // Nothing is missing on the person, so every remaining gap is the company's own registration —
  // and those are blocking, because an insurance office will not accept the form without them.
  for (const gap of complete) {
    assert.equal(
      gap.source,
      "company-settings",
      `${gap.field} should be filled by the fixture but is reported as a gap`,
    );
    assert.equal(gap.blocking, true, `${gap.field} is a company registration number and blocks`);
  }
  if (!systemLegalEntity.registration.taxRegistrationNumber) {
    assert.ok(byField.has("taxRegistrationNumber"), "a blank tax registration number must be reported");
  }

  // An unnamed party or a contract with no salary is wrong to hand over.
  const missingIdentity = collectHiringPackGaps(
    employeeFixture({ nameAr: null, baseSalary: null }),
    profileFixture(),
  );
  for (const field of ["nameAr", "baseSalary"]) {
    const gap = missingIdentity.find((candidate) => candidate.field === field);
    assert.ok(gap, `${field} must be reported as a gap`);
    assert.equal(gap.blocking, true, `${field} must block`);
  }

  // A missing occupation code is untidy, not wrong: HR should be able to print a contract today
  // and chase the code tomorrow.
  const missingCode = collectHiringPackGaps(
    employeeFixture(),
    profileFixture({ occupationCode: null }),
  );
  const codeGap = missingCode.find((gap) => gap.field === "occupationCode");
  assert.ok(codeGap, "a missing occupation code must still be reported");
  assert.equal(codeGap.blocking, false, "a missing occupation code must not block printing");

  // Whatever is missing, both documents still print — the blanks stay blank rather than guessed.
  const sparse = packFixture({ nameAr: null, nationalId: null }, { nationality: null });
  assert.ok(renderForm1Html(sparse, 1).includes("<section class=\"sheet\">"));
  assert.ok(
    renderContractHtml(sparse, 1).includes('<article class="copy'),
    "the contract must still print when fields are missing — the blanks stay blank",
  );
}

/**
 * A gap tells HR "chase this before you print". It is only worth chasing if the value reaches paper.
 *
 * This caught a real one. The company insurance number was reported as BLOCKING while its only
 * placement sat on page 2 — and Phoenix writes nothing on page 2, by the owner's instruction — so
 * the number could never appear on a printed form. HR would have been told Form 1 was incomplete
 * because of a value the form, as Phoenix prints it, does not ask for. The other half of the same
 * mistake was قطاع المنشأة: two printed boxes at the top of page 1 that nothing ever chased.
 *
 * Both directions are pinned, because fixing one and not the other is how it happened.
 */
/**
 * A DEFAULT IS ONLY SAFE IF IT REACHES THE PAPER AND THE SCREEN AGREES WITH IT.
 *
 * Nationality stopped blocking on 2026-09-03 because every paper now prints مصري when nobody has
 * recorded one. That trade is only sound while the printing half actually happens: a board saying
 * "ready" over a contract that prints "الجنسية: (  )" is a worse failure than the block it replaced,
 * because nothing would ever tell anybody. The renderers are asserted here rather than the helper,
 * since the helper being right is not the part that was ever in doubt.
 */
// Both are valid IDs for 1998-01-01 in Dakahlia (digits 8-9 = "12"), differing in ONE character —
// digit 13, the Authority's sex digit, odd male and even female. Keeping them one character apart
// is what makes the assertions below about the sex digit and nothing else.
const FEMALE_NATIONAL_ID = "29801011234567";
const MALE_NATIONAL_ID = "29801011234577";

function testAnUnrecordedNationalityStillPrintsOnEveryPaper() {
  const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

  // TWO SUBSTRING TRAPS SIT ON THIS TEST, both measured, and each makes the obvious assertion pass
  // on a paper that is wrong:
  //
  //   1. The contract cites قانون العمل المصري, so المصري — and with it مصري — is in every copy
  //      whatever the nationality is. `includes(DEFAULT_NATIONALITY_AR)` was written first, the
  //      default was then removed to check the test bites, and it stayed GREEN while the contract
  //      printed "الجنسية: (  )".
  //   2. مصرية CONTAINS مصري as a prefix. So counting the masculine form also counts every feminine
  //      one, and a masculine assertion alone passes on a WOMAN's contract — precisely the defect
  //      this gendering exists to fix.
  //
  // So nothing here searches. Every check is a DIFFERENCE against a control varying in nationality
  // and nothing else, and a masculine claim pins the feminine delta at 0 too: masculine +1 with
  // feminine +0 is the only combination that means a standalone مصري reached the page.
  const deltas = (paper: (nationality: string | null) => string) => {
    const withDefault = paper(null);
    const control = paper("سوداني");
    return {
      masculine:
        occurrences(withDefault, DEFAULT_NATIONALITY_AR) - occurrences(control, DEFAULT_NATIONALITY_AR),
      feminine:
        occurrences(withDefault, DEFAULT_NATIONALITY_AR_FEMALE) -
        occurrences(control, DEFAULT_NATIONALITY_AR_FEMALE),
    };
  };

  const contract =
    (employee: Partial<HiringPackEmployeeFacts>) =>
    (nationality: string | null): string =>
      renderContractHtml(packFixture(employee, { nationality }), 1);

  // A RECORDED nationality always wins, and is never re-gendered. Recruitment is Egyptians only,
  // but the candidate pool has held Pakistani, Sudanese and Syrian applicants — a default that
  // overrode a stated nationality would put a false fact on an instrument somebody signs.
  assert.ok(
    contract({ nationalId: FEMALE_NATIONAL_ID })("سوداني").includes("سوداني"),
    "a recorded nationality must print exactly as recorded",
  );

  // A woman gets مصرية. This is the case that was wrong until 2026-09-03: 41 of the 94 employees
  // with a readable national ID are women, and every one was printing the masculine form.
  const woman = deltas(contract({ nationalId: FEMALE_NATIONAL_ID, gender: null }));
  assert.equal(woman.feminine, 1, "a woman's contract must print مصرية exactly once more than the control");

  // A man gets مصري — and the feminine delta of 0 is what proves it is the standalone masculine
  // form rather than the prefix of a مصرية that trap 2 would otherwise have hidden.
  const man = deltas(contract({ nationalId: MALE_NATIONAL_ID, gender: null }));
  assert.equal(man.masculine, 1, "a man's contract must print مصري exactly once more than the control");
  assert.equal(man.feminine, 0, "a man's contract must not print the feminine form at all");

  // THE RECORDED FIELD OUTRANKS THE DERIVED ONE — the rule `national-id.ts` already keeps for the
  // birth date. `employees.gender` is the wider source (106 of 125 active employees carry one,
  // against 94 with a readable ID) and the two agreed in 93 of 93 where both exist, so this is an
  // ordering, not a conflict to reconcile.
  const storedBeatsId = deltas(contract({ nationalId: FEMALE_NATIONAL_ID, gender: "male" }));
  assert.equal(storedBeatsId.masculine, 1, "a stored gender must outrank the sex digit in the ID");
  assert.equal(storedBeatsId.feminine, 0, "a stored gender of male must not print the feminine form");

  // Neither source answers. 18 people on production are in this state, every one with no national
  // ID at all — so they are already blocked from printing any paper and this fallback is currently
  // unreachable. It is the owner's stated default, kept for correctness rather than for use.
  const unknown = deltas(contract({ nationalId: null, gender: null }));
  assert.equal(unknown.masculine, 1, "an unknown sex must fall back to the masculine default");
  assert.equal(unknown.feminine, 0, "an unknown sex must not guess the feminine form");

  // Form 1 is the other paper the owner actually prints, and it is filed with the Social Insurance
  // Authority under somebody's real identity. Same cases, same traps.
  const form1 =
    (employee: Partial<HiringPackEmployeeFacts>) =>
    (nationality: string | null): string =>
      renderForm1Html(packFixture(employee, { nationality }), 1);

  assert.equal(
    deltas(form1({ nationalId: FEMALE_NATIONAL_ID, gender: null })).feminine,
    1,
    "Form 1 must print مصرية for a woman rather than leaving الجنسية blank",
  );
  const form1Man = deltas(form1({ nationalId: MALE_NATIONAL_ID, gender: null }));
  assert.equal(form1Man.masculine, 1, "Form 1 must print مصري for a man");
  assert.equal(form1Man.feminine, 0, "Form 1 must not print the feminine form for a man");
}

function testEveryCompanySettingsGapReachesThePage() {
  const placedKeys = new Set(
    [...FORM1_PAGE_1_PLACEMENTS, ...FORM1_PAGE_2_PLACEMENTS].map((placement) => placement.key),
  );

  /** Which printed value each company registration setting feeds. */
  const printedKeyByGapField: Readonly<Record<string, string>> = {
    insuranceEstablishmentNumber: "establishmentNumber",
    insuranceSectorCode: "sectorCode",
    taxRegistrationNumber: "taxRegPart1",
  };

  const companyGaps = collectHiringPackGaps(employeeFixture(), profileFixture()).filter(
    (gap) => gap.source === "company-settings",
  );

  // WALK THE DECLARED LIST, not the gaps that happen to be open. This guarded itself with "at least
  // one company registration field is blank", which tied the pin's strength to the company being
  // half-configured — and on 2026-09-03 the owner supplied the last blank number (the sector code),
  // which turned that guard red AND would have left the loop below iterating nothing. A check that
  // only holds while the data is incomplete is not a check.
  assert.ok(COMPANY_REGISTRATION_GAPS.length > 0, "no company registration setting is declared at all");
  assert.equal(
    Object.keys(printedKeyByGapField).length,
    COMPANY_REGISTRATION_GAPS.length,
    "the printed-key map and the declared registration gaps have drifted apart",
  );

  for (const entry of COMPANY_REGISTRATION_GAPS) {
    const printedKey = printedKeyByGapField[entry.field];
    assert.ok(printedKey, `${entry.field} blocks printing but nothing maps it onto the form`);
    assert.ok(
      placedKeys.has(printedKey),
      `${entry.field} blocks printing but "${printedKey}" has no placement — it can never print`,
    );
  }

  for (const [field, printedKey] of Object.entries(printedKeyByGapField)) {
    assert.ok(placedKeys.has(printedKey), `${printedKey} lost its placement on Form 1`);
    // Each value here is real company config, so a field may legitimately be filled — the
    // establishment number was set 2026-09-01. The invariant is directional: a BLANK field must be
    // chased as a gap, and a FILLED one must NOT be, or HR is sent chasing a number already on the
    // form. This reads the live setting rather than assuming blank, so setting one cannot silently
    // turn this pin red — while a field that prints but is never reported when blank still fails.
    const isBlank = !systemLegalEntity.registration[
      field as keyof typeof systemLegalEntity.registration
    ];
    const reported = companyGaps.some((gap) => gap.field === field);
    if (isBlank) {
      assert.ok(reported, `${field} prints on Form 1 but is never reported when it is blank`);
    } else {
      assert.ok(!reported, `${field} is filled in company settings but still reported as a blank gap`);
    }
  }
}

/**
 * ── THE ONE DEFECT NOTHING IN THIS REPOSITORY CAN SEE ────────────────────────────────────────
 *
 * A number made of parts — `477-108-318`, `24 / 08 / 2026` — is not one number to the
 * bidirectional algorithm. In Arabic prose every digit run resolves to an ARABIC number, the rule
 * that would fuse the runs back together across the separator applies only to EUROPEAN ones, and a
 * right-to-left paragraph then lays the parts out right to left. Measured in a browser on
 * 2026-08-30, on this module's own output:
 *
 *     477-108-318      painted as   318-108-477      the company's tax card, on three papers
 *     24 / 08 / 2026   painted as   2026 / 08 / 24   the last working day, on the resignation
 *
 * The second one is the Ministry of Labour form's most consequential value, printed backwards.
 *
 * The string is right, the HTML is right, `escapeHtml` is right, and every test that compares
 * strings passes — including every test in this file. Only a real layout engine reorders the runs,
 * which is why the browser check on these documents is not a formality.
 *
 * SO THIS TEST DOES NOT CHECK THE ORDER. It cannot see order. It checks the only thing a string
 * can carry: that every such value is PINNED — either inside an element declaring `dir="ltr"`, or
 * wrapped in the directional isolates `pinLtr` adds. A pinned value cannot reverse. An unpinned one
 * is one layout engine away from printing backwards on a document somebody signs.
 *
 * WHY THE PATTERN IS NARROWER THAN "ANY NUMBER WITH A SEPARATOR". `14/2025` — Labour Law 14/2025,
 * written into these templates as prose — is safe and must never be flagged: a single slash with no
 * space beside it fuses its two numbers into one, and `24/08/2026` was measured rendering correctly
 * for that exact reason. What is unsafe is a DASH of any kind, or a separator with whitespace next
 * to it. Both were measured reversing; changing the dash character was measured NOT to help.
 *
 * A SPACED FULL STOP OR COMMA IS A SENTENCE BOUNDARY, NOT A SEPARATOR, so those are excluded as
 * well — and the first run of this test proved why. It flagged "4. 1", out of the on-screen print
 * banner: "Paper size: A4. 1 copies are already laid out below". Two unrelated numbers either side
 * of a full stop are not one value, and the browser confirmed that pair paints as written.
 */

/** What a reader sees, with everything that pins its own direction removed. */
function unpinnedText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gu, " ")
    .replace(/<script[\s\S]*?<\/script>/gu, " ")
    .replace(/<(\w+)\b[^>]*\sdir="ltr"[^>]*>[\s\S]*?<\/\1>/gu, " ")
    .replace(/\u2066[^\u2069]*\u2069/gu, " ")
    .replace(/<[^>]*>/gu, " ");
}

/** Digit groups joined by a dash, or by a separator with a space beside it. Measured unsafe. */
const REVERSIBLE_NUMBER =
  /\d+(?:(?:\s*[-\u2010-\u2015\u2212]\s*|\s+[/:]\s*|\s*[/:]\s+)\d+)+/gu;

function testNoNumberCanPrintBackwards() {
  // A leaver, with every date the exit papers print actually filled in — an empty date prints a
  // blank rule and would let this test pass by having nothing to reverse.
  const pack = packFixture(
    { employmentStatus: "resigned", lastWorkingDate: "2026-08-24" },
    {},
    {
      exitRoute: "resignation",
      lastWorkingDate: "2026-08-24",
      agreementDate: "2026-08-20",
      endReasonAr: "ظروف خاصة",
      endReasonCode: "1",
    },
  );

  const documents: ReadonlyArray<readonly [string, string]> = [
    ["the employment contract", renderContractHtml(pack, 1)],
    ["Form 1", renderForm1Html(pack, 1)],
    ["Form 6", renderForm6Html(pack, 1)],
    ["the resignation request", renderResignationHtml(pack, 1)],
    ["the mutual termination agreement", renderMutualTerminationHtml(pack, 1)],
    ["the laptop custody receipt", renderCustodyLaptopHtml(pack, 1)],
    ["the phone custody receipt", renderCustodyMobileHtml(pack, 1)],
    ["the employee clearance", renderClearanceEmployeeHtml(pack, 1)],
    ["the company clearance", renderClearanceCompanyHtml(pack, 1)],
  ];

  for (const [name, html] of documents) {
    const unpinned = unpinnedText(html).match(REVERSIBLE_NUMBER) ?? [];
    assert.deepEqual(
      unpinned,
      [],
      `${name} prints ${JSON.stringify(unpinned)} with nothing holding it left-to-right. ` +
        "In Arabic prose the parts of such a number lay out right to left, so this prints " +
        "backwards on paper while every string comparison in this repository still passes. " +
        "Wrap the value in pinLtr(), or give it an element carrying dir=\"ltr\".",
    );
  }
}

/**
 * The bug reported 2026-08-31, the day after the facts screen became editable: editing the salary
 * and saving it successfully, then finding the printed contract still carries the OLD figure.
 *
 * `upsertEmployee` re-derives base/basic/gross/net together from whichever ONE is supplied, and
 * base outranks the rest in that derivation (`calculateBaseSalary`). The field is the BASE salary
 * since the owner's correction later the same day, which makes it the anchor the derivation reads
 * first rather than one it overwrites — but the round trip still has to be proven, because the
 * failure mode is a save that reports success and changes nothing.
 */
function testFactsSaveAnchorsBaseSalaryEditThroughTheRealFormula() {
  // Self-consistent under the formula: base 8000, +500 social insurance, +200 tax = gross 8700;
  // basic is 70% of base; net carries no cost-of-living/fuel here, so it equals base.
  const current = { baseSalary: 8000, basicSalary: 5600, grossSalary: 8700, netSalary: 8000 };
  const socialInsurance = 500;
  const taxes = 200;

  // An edit: the user typed a new base salary.
  const edited = resolveFactsCompensationFields(current, 15000);
  assert.equal(edited.baseSalary, 15000);
  assert.equal(edited.basicSalary, null, "basic must not ride along unchanged once base was edited");
  assert.equal(edited.grossSalary, null, "gross must not ride along unchanged once base was edited");
  assert.equal(edited.netSalary, null);

  // The headline assertion: run the anchored fields through the REAL payroll derivation —
  // the same one `upsertEmployee` calls — and confirm the edit survives it.
  const derived = resolveFixedSalaryAmounts({ ...edited, socialInsurance, taxes });
  assert.equal(
    derived.baseSalary,
    15000,
    "the derivation must reproduce the newly typed base salary, not silently revert to the old one",
  );
  assert.equal(derived.basicSalary, 10500, "basic is 70% of the NEW base, not of the old one");

  // Saving without touching the salary (the form resubmits the current figure verbatim) must
  // round-trip to the same base through that same derivation.
  const unedited = resolveFactsCompensationFields(current, current.baseSalary);
  const uneditedDerived = resolveFixedSalaryAmounts({ ...unedited, socialInsurance, taxes });
  assert.equal(uneditedDerived.baseSalary, current.baseSalary);
  assert.equal(uneditedDerived.grossSalary, current.grossSalary);

  // A blank submission must never zero out a real salary.
  assert.deepEqual(resolveFactsCompensationFields(current, null), current);
}

export function runHiringPackTests() {
  testForm1LayoutIsTheMeasuredForm();
  testWagePoundsAreOnTheLeft();
  testTheBackOfForm1IsPrintedBlank();
  testForm1PrintsOneSheetPairPerCopy();
  testForm1ClipsToItsPrintedBoxes();
  testForm1WritesTheWageIntoTheRightColumns();
  testForm1WageGridKeysAreAllMapped();
  testContractPrintsFourCopiesOnA4();
  testTafqitAgreement();
  testContractTermsFallBackToTheCompanyDefault();
  testGapsSeparateBlockingFromChaseLater();
  testAnUnrecordedNationalityStillPrintsOnEveryPaper();
  testEveryCompanySettingsGapReachesThePage();
  testNoNumberCanPrintBackwards();
  testFactsSaveAnchorsBaseSalaryEditThroughTheRealFormula();
}
