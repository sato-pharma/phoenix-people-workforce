import { systemLegalEntity } from "@/config/system-settings";
import {
  FORM6_PAGE_1_PLACEMENTS,
  FORM6_PAGE_1_SVG,
  FORM6_PAGE_2_PLACEMENTS,
  FORM6_PAGE_2_SVG,
  FORM6_PAGE_HEIGHT_PT,
  FORM6_PAGE_WIDTH_PT,
} from "@/lib/hiring-pack/form6-layout";
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
} from "@/lib/hiring-pack/render-shared";
import type { HiringPackData } from "@/lib/hiring-pack/types";

// Rendering government Form 6: the official artwork as a vector background, the values placed over
// it at measured coordinates. The mechanism is Form 1's, unchanged — see `render-placement.ts` for
// why the artwork is embedded rather than rebuilt, and `render-shared.ts` for why these documents
// are browser-printed HTML rather than a server-built PDF.
//
// WHAT MAKES THIS FORM DIFFERENT FROM FORM 1 is only what it asserts. Form 1 opens a social
// insurance file; Form 6 closes one. The single most consequential value on it is تاريخ انتهاء
// الاشتراك — the date the subscription ends — because the Authority calculates the final
// contribution from it, and its own back-page instruction 2 charges the employer a 20% penalty per
// month of delay in filing. That date is the employee's LAST WORKING DAY, resolved once in
// `terms.lastWorkingDate` so this form and the Ministry of Labour form cannot disagree about it.

/**
 * The values every placement key resolves against. Missing keys simply print nothing.
 *
 * Exported for the test that pins every placement key against it: a placement whose key this
 * function never produces can never print, and nothing else in the repo can see that — the form
 * simply comes out of the printer with one box empty.
 */
export function buildForm6Values(data: HiringPackData): Record<string, string> {
  const { employee, profile, terms } = data;
  const registration = systemLegalEntity.registration;

  const end = splitIsoDate(terms.lastWorkingDate);
  const [taxRegPart1, taxRegPart2, taxRegPart3] = splitTaxRegistration(
    registration.taxRegistrationNumber,
  );

  return {
    insuranceOffice: profile.insuranceOffice ?? registration.defaultInsuranceOffice,

    establishmentNumber: registration.insuranceEstablishmentNumber,
    companyName: systemLegalEntity.legalNameAr,
    taxRegPart1,
    taxRegPart2,
    taxRegPart3,

    insuranceNumber: employee.socialInsuranceNumber ?? "",
    nationalId: employee.nationalId ?? "",
    // The Arabic name, never the English one — this is a document for an Arabic-language registry.
    insuredName: employee.nameAr ?? "",

    endDay: end?.day ?? "",
    endMonth: end?.month ?? "",
    endYear: end?.year ?? "",
    endReason: data.offboarding.endReasonAr ?? "",
    endReasonCode: (data.offboarding.endReasonCode ?? "").replace(/[^0-9]/gu, ""),

    // The address block is the one Form 1 already captured at hiring. It is read from the hiring
    // profile rather than re-asked, so the two forms in one person's file carry one address.
    addressBuilding: profile.addressBuilding ?? "",
    addressStreet: profile.addressStreet ?? employee.residenceAddress ?? "",
    addressDistrict: profile.addressDistrict ?? "",
    addressMarkaz: profile.addressMarkaz ?? "",
    addressGovernorate: profile.addressGovernorate ?? "",

    phone: employee.mobileNumber ?? "",
    email: employee.workEmail ?? "",
  };
}

export function renderForm6Html(data: HiringPackData, copies: number): string {
  const values = buildForm6Values(data);

  const sheets: string[] = [];
  for (let copy = 0; copy < Math.max(1, copies); copy += 1) {
    sheets.push(renderSheet(FORM6_PAGE_1_SVG, FORM6_PAGE_1_PLACEMENTS, values));
    sheets.push(renderSheet(FORM6_PAGE_2_SVG, FORM6_PAGE_2_PLACEMENTS, values));
  }

  const employeeName = data.employee.nameAr ?? data.employee.fullName;

  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>نموذج 6 — ${escapeHtml(employeeName)}</title>
<style>
  /*
   * US Legal, because that is the size of the official form: the source PDF measures
   * 612.12 x 1008.12pt exactly — the same paper Form 1 is printed on. A4 would shrink it by roughly
   * 16% vertically or clip the bottom, and neither is a form an insurance office accepts.
   */
${placedFormCss(FORM6_PAGE_WIDTH_PT, FORM6_PAGE_HEIGHT_PT, ARABIC_FONT_STACK)}
  ${PRINT_BANNER_CSS}
</style>
</head>
<body>
${printBanner([
  "MUST be printed DOUBLE-SIDED — tick “Print on both sides” in the dialog. Page 2 is the back of page 1: page 1 ends “أنظر خلفه”, and both the employee and the responsible manager sign the back.",
  `Paper size: US Legal (8.5in x 14in). ${copies} copies are already laid out below — leave the dialog's copy count at 1.`,
  "Scale must stay at 100% / “Actual size”. Fit-to-page shifts every value off its box.",
  "The signatures, the dates beside them and the stamp are written by hand. Nothing below the address block is filled by Phoenix.",
])}
${sheets.join("\n")}
${FIT_TO_BOX_SCRIPT}
</body>
</html>`;
}
