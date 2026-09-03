import { systemLegalEntity } from "@/config/system-settings";
import { splitPoundsAndPiastres } from "@/lib/hiring-pack/arabic-amount";
import {
  FORM1_PAGE_1_PLACEMENTS,
  FORM1_PAGE_1_SVG,
  FORM1_PAGE_2_PLACEMENTS,
  FORM1_PAGE_2_SVG,
  FORM1_PAGE_HEIGHT_PT,
  FORM1_PAGE_WIDTH_PT,
  FORM1_WAGE_GRIDS,
  type Form1WageGrid,
} from "@/lib/hiring-pack/form1-layout";
import {
  FIT_TO_BOX_SCRIPT,
  placedFormCss,
  renderSheet,
} from "@/lib/hiring-pack/render-placement";
import {
  ARABIC_FONT_STACK,
  escapeHtml,
  PRINT_BANNER_CSS,
  printBanner,
  splitIsoDate,
  splitTaxRegistration,
  todayInCairo,
} from "@/lib/hiring-pack/render-shared";
import { STATUTORY_BASIC_WAGE, insuranceWageFromBase } from "@/lib/hiring-pack/insurance-wage";
import type { HiringPackData } from "@/lib/hiring-pack/types";
import { resolveNationality } from "@/lib/hiring-pack/nationality";

// Rendering government Form 1: the official artwork as a vector background, the values placed over
// it at measured coordinates.
//
// WHY THE ARTWORK IS AN SVG AND NOT A REBUILD. The owner's instruction was to print the whole form,
// data and layout together, on blank paper. Reproducing the form's own boxes and rules in HTML
// would be an approximation of a document an insurance office already knows by sight; embedding the
// original as vector makes it identical, stays crisp at any printer resolution, and cannot drift
// when someone adjusts a stylesheet.
//
// WHY IT IS ONE PAGE OF ARTWORK PER SIDE. Page 1 says "أنظر خلفه" — see the back — and page 2
// carries both the إرشادات and the إقرار the employee signs. They are two sides of one sheet, not
// two documents, which is exactly why this must be printed duplex.

/** The values every placement key resolves against. Missing keys simply print nothing. */
function buildForm1Values(data: HiringPackData): Record<string, string> {
  const { employee, profile, terms } = data;
  const registration = systemLegalEntity.registration;

  const start = splitIsoDate(terms.contractStartDate ?? employee.hireDate);
  const today = splitIsoDate(todayInCairo());

  const [taxRegPart1, taxRegPart2, taxRegPart3] = splitTaxRegistration(
    registration.taxRegistrationNumber,
  );
  // كود المهنة runs left to right across two groups of three boxes.
  const occupationCode = (profile.occupationCode ?? "").replace(/[^0-9]/gu, "");

  const values: Record<string, string> = {
    insuranceOffice: profile.insuranceOffice ?? registration.defaultInsuranceOffice,
    categoryEmployee: "✔",

    establishmentNumber: registration.insuranceEstablishmentNumber,
    sectorCode: registration.insuranceSectorCode,
    companyName: systemLegalEntity.legalNameAr,
    taxRegPart1,
    taxRegPart2,
    taxRegPart3,
    // The back page's إقرار also asks for the company's insurance number and address. It is not
    // written here, because Phoenix writes nothing on that page — see FORM1_PAGE_2_PLACEMENTS.

    insuranceNumber: employee.socialInsuranceNumber ?? "",
    nationalId: employee.nationalId ?? "",
    // The Arabic name, never the English one — this is a document for an Arabic-language registry.
    insuredName: employee.nameAr ?? "",
    nationality: resolveNationality(profile.nationality, employee).value,
    qualification: profile.qualification ?? "",
    occupationCodeLeft: occupationCode.slice(0, 3),
    occupationCodeRight: occupationCode.slice(3, 6),
    jobTitleAr: profile.jobTitleAr ?? "",

    startDay: start?.day ?? "",
    startMonth: start?.month ?? "",
    startYear: start?.year ?? "",

    // نوع المدة is knowable: this is a fixed-term contract by definition — its own title is
    // "عقد عمل محدد المدة". The other two rules on that row want government classification codes
    // (كود الاشتراك, القطاع) that only the insurance office issues, so they stay blank rather than
    // carry a guess. Their boxed code cells are deliberately unplaced for the same reason.
    periodTypeLabel: "محدد المدة",
    subscriptionCodeLabel: "",
    sectorLabel: "",

    addressBuilding: profile.addressBuilding ?? "",
    addressDistrict: profile.addressDistrict ?? "",
    addressStreet: profile.addressStreet ?? employee.residenceAddress ?? "",
    addressMarkaz: profile.addressMarkaz ?? "",
    addressGovernorate: profile.addressGovernorate ?? "",

    phone: employee.mobileNumber ?? "",
    email: employee.workEmail ?? "",

    writtenDay: today?.day ?? "",
    writtenMonth: today?.month ?? "",
    writtenYear: today?.year ?? "",
  };

  return values;
}

/** One digit centred in one printed wage cell. */
function wageCell(x: number, w: number, y: number, h: number, digit: string): string {
  return `<span class="f wage" style="left:${x.toFixed(2)}pt;top:${y}pt;width:${w.toFixed(2)}pt;height:${h}pt;line-height:${h}pt">${escapeHtml(digit)}</span>`;
}

/** The جنيه | قرش pair for one wage grid, one digit per printed cell. */
function renderWageGrid(grid: Form1WageGrid, amount: number | null): string {
  const split = splitPoundsAndPiastres(amount);
  if (!split) return "";

  // Pounds fill from the RIGHT: the units digit belongs in the last cell, so a four-digit salary
  // leaves the leading cell blank instead of sitting a whole column adrift and reading ten times
  // too large. An over-long figure is clipped at the high end rather than allowed to spill.
  const poundDigits = [...split.pounds].slice(-grid.pounds.cells);
  const offset = grid.pounds.cells - poundDigits.length;
  const pounds = poundDigits
    .map((digit, index) =>
      wageCell(
        grid.pounds.x + (offset + index) * grid.pounds.pitch,
        grid.pounds.pitch,
        grid.y,
        grid.h,
        digit,
      ),
    )
    .join("");

  // Piastres are always two digits, "00" included — an empty قرش column reads as an unfinished form.
  const piastreDigits = [...split.piastres].slice(-grid.piastres.length);
  const piastres = grid.piastres
    .slice(grid.piastres.length - piastreDigits.length)
    .map((box, index) => wageCell(box.x, box.w, grid.y, grid.h, piastreDigits[index]))
    .join("");

  return pounds + piastres;
}

export function renderForm1Html(data: HiringPackData, copies: number): string {
  const values = buildForm1Values(data);

  // THE THREE COLUMNS CARRY THREE DIFFERENT FIGURES — owner, 2026-08-31, naming each one:
  //   الأجر الشامل   (comprehensiveWage) — the base salary itself
  //   أجر الاشتراك    (subscriptionWage)  — base ÷ 1.3 capped, what contributions are computed on
  //   الأجر الأساسي  (basicWage)         — the flat statutory 2,450, identical for every employee
  //
  // Until this was corrected all three were filled from the subscription wage, on the reasoning that
  // the other two were derived from it. They are not. That printed ONE number three times on a
  // government form whose three columns exist precisely BECAUSE they differ, and it understated
  // الأجر الشامل — the comprehensive wage — by the whole ÷1.3 on every form issued.
  //
  // Form 1 and the contract still agree on أجر الاشتراك, which is why that one runs the owner's rule
  // off the base salary rather than reading the stored `social_insurance_wage`: the declaration a
  // person is subscribed on and the contract he signed must never name two different figures.
  const base = data.employee.baseSalary;
  const wageForGrid = (key: Form1WageGrid["key"]): number | null => {
    // Every column stays blank when there is no base salary, the flat one included. A form with a
    // single column filled reads as a filling mistake; all three blank reads as unfinished, which is
    // what it is — and the fill screen already warns that the base salary is missing.
    if (base === null) return null;
    switch (key) {
      case "comprehensiveWage":
        return base;
      case "subscriptionWage":
        return insuranceWageFromBase(base);
      case "basicWage":
        return STATUTORY_BASIC_WAGE;
    }
  };
  const wageGrids = FORM1_WAGE_GRIDS.map((grid) =>
    renderWageGrid(grid, wageForGrid(grid.key)),
  ).join("");

  const sheets: string[] = [];
  for (let copy = 0; copy < Math.max(1, copies); copy += 1) {
    sheets.push(renderSheet(FORM1_PAGE_1_SVG, FORM1_PAGE_1_PLACEMENTS, values, wageGrids));
    sheets.push(renderSheet(FORM1_PAGE_2_SVG, FORM1_PAGE_2_PLACEMENTS, values, ""));
  }

  const employeeName = data.employee.nameAr ?? data.employee.fullName;

  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>نموذج 1 — ${escapeHtml(employeeName)}</title>
<style>
  /*
   * US Legal, because that is the size of the official form: the source PDF measures
   * 612.12 x 1008.12pt exactly. Printing it on A4 would shrink it by roughly 16% vertically or clip
   * the bottom, and neither is a form an insurance office accepts.
   */
${placedFormCss(FORM1_PAGE_WIDTH_PT, FORM1_PAGE_HEIGHT_PT, ARABIC_FONT_STACK)}
  ${PRINT_BANNER_CSS}
</style>
</head>
<body>
${printBanner([
  "MUST be printed DOUBLE-SIDED — tick “Print on both sides” in the dialog. Page 2 is the back of page 1, and the employee signs it.",
  `Paper size: US Legal (8.5in x 14in). ${copies} copies are already laid out below — leave the dialog's copy count at 1.`,
  "Scale must stay at 100% / “Actual size”. Fit-to-page shifts every value off its box.",
])}
${sheets.join("\n")}
${FIT_TO_BOX_SCRIPT}
</body>
</html>`;
}
