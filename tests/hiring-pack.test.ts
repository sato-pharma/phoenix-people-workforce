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
  addMonthsToIsoDate,
  collectHiringPackGaps,
  emptyOffboardingProfile,
  resolveContractTerms,
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
    socialInsuranceNumber: "123456789",
    socialInsuranceWage: 6000,
    grossSalary: 12750.5,
    birthDate: "1998-01-01",
    hireDate: "2026-08-01",
    jobTitle: "Medical Representative",
    departmentAr: "الجهاز العصبي",
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
  const html = renderForm1Html(packFixture({ socialInsuranceWage: 6000 }), 1);
  const cells = wageCells(html);

  assert.equal(cells.length, 18, "three wage grids of six cells each");

  // أجر أساسي is the only grid whose value row sits at y=448.2 — the other two are at 448.1.
  const basic = cells.filter((cell) => cell.top === "448.2");
  assert.deepEqual(
    basic.map((cell) => `${cell.left}:${cell.digit}`),
    [
      // Pounds, right-aligned so the units digit lands in the LAST of the five cells. 6000 is four
      // digits, so the leading cell at 440.70 stays empty rather than reading ten times too large.
      "451.80:6",
      "462.90:0",
      "474.00:0",
      "485.10:0",
      // Piastres, always two digits — an empty قرش column reads as an unfinished form.
      "496.70:0",
      "510.20:0",
    ],
    "the جنيه digits must fill the left block from the right, and the قرش block must follow it",
  );

  // All three grids carry the SAME insurance wage. The gross salary must never reach this form:
  // it would overstate the contribution base, which is the mistake hand-filling makes in a hurry.
  assert.ok(
    !html.includes(">12750<") && !html.includes("12,750"),
    "the gross salary must not appear on Form 1 — every grid is the insurance wage",
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
    employeeFixture({ nameAr: null, grossSalary: null }),
    profileFixture(),
  );
  for (const field of ["nameAr", "grossSalary"]) {
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
  assert.ok(companyGaps.length > 0, "the fixture leaves the company registration blank on purpose");

  for (const gap of companyGaps) {
    const printedKey = printedKeyByGapField[gap.field];
    assert.ok(printedKey, `${gap.field} blocks printing but nothing maps it onto the form`);
    assert.ok(
      placedKeys.has(printedKey),
      `${gap.field} blocks printing but "${printedKey}" has no placement — it can never print`,
    );
  }

  for (const [field, printedKey] of Object.entries(printedKeyByGapField)) {
    assert.ok(placedKeys.has(printedKey), `${printedKey} lost its placement on Form 1`);
    assert.ok(
      companyGaps.some((gap) => gap.field === field),
      `${field} prints on Form 1 but is never reported when it is blank`,
    );
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

export function runHiringPackTests() {
  testForm1LayoutIsTheMeasuredForm();
  testWagePoundsAreOnTheLeft();
  testTheBackOfForm1IsPrintedBlank();
  testForm1PrintsOneSheetPairPerCopy();
  testForm1ClipsToItsPrintedBoxes();
  testForm1WritesTheWageIntoTheRightColumns();
  testContractPrintsFourCopiesOnA4();
  testTafqitAgreement();
  testContractTermsFallBackToTheCompanyDefault();
  testGapsSeparateBlockingFromChaseLater();
  testEveryCompanySettingsGapReachesThePage();
  testNoNumberCanPrintBackwards();
}
