import { systemLegalEntity } from "@/config/system-settings";
import { layeredPages, type DocumentFieldRow } from "@/lib/hiring-pack/field-layout";
import {
  LABOUR_PAGE_HEIGHT_PT,
  LABOUR_PAGE_WIDTH_PT,
  MUTUAL_PAGE_1_PLACEMENTS,
  MUTUAL_PAGE_1_SVG,
  MUTUAL_PAGE_2_PLACEMENTS,
  MUTUAL_PAGE_2_SVG,
  MUTUAL_PAGE_3_PLACEMENTS,
  MUTUAL_PAGE_3_SVG,
  RESIGNATION_PLACEMENTS,
  RESIGNATION_SVG,
} from "@/lib/hiring-pack/labour-exit-layout";
import {
  FIT_TO_BOX_SCRIPT,
  placedFormCss,
  renderSheet,
} from "@/lib/hiring-pack/render-placement";
import {
  ARABIC_FONT_STACK,
  arabicDayName,
  escapeHtml,
  formatDayMonthYear,
  pinLtr,
  PRINT_BANNER_CSS,
  printBanner,
  splitIsoDate,
  todayInCairo,
} from "@/lib/hiring-pack/render-shared";
import type { HiringPackData } from "@/lib/hiring-pack/types";

// The two Ministry of Labour exit templates, rendered from one set of values.
//
// WHY ONE FILE FOR TWO DOCUMENTS. They are alternatives — one is signed, never both — and they ask
// for very nearly the same facts about the same person on the same day. Building their values twice
// would let the two drift, so that the resignation and the mutual-termination agreement in one
// person's file could name different job titles or different last working days. One builder, two
// page sets.
//
// THE TEMPLATES ARE NOT EDITED. Both are government templates and the owner's instruction is that
// they print exactly as issued. Nothing here changes a word, a rule or a box: the artwork is the
// Ministry's own page, and every value is positioned over it.

/**
 * Every value both templates draw from. Missing keys simply print nothing.
 *
 * Exported for the same reason `buildForm6Values` is: it is what the placement keys are pinned
 * against, and an unbuilt key is invisible on the printed page.
 */
export function buildExitValues(data: HiringPackData): Record<string, string> {
  const { employee, profile, terms } = data;

  const lastWorking = terms.lastWorkingDate;
  const lastWorkingParts = splitIsoDate(lastWorking);
  // The agreement is dated the day it is signed. Absent a confirmed date that is today, in Cairo —
  // never `new Date()` in UTC, which after 22:00 local would date the paper yesterday.
  const agreement = data.offboarding.agreementDate ?? todayInCairo();
  const agreementParts = splitIsoDate(agreement);
  const contractStart = splitIsoDate(terms.contractStartDate ?? employee.hireDate);

  return {
    // ── The resignation letter's addressee ──────────────────────────────────────────────────
    // Defaults to the manager who signs as الطرف الأول on the employment contract: the resignation
    // is addressed to the person with authority to accept it, and that is the same person.
    addresseeName: data.offboarding.addresseeNameAr ?? systemLegalEntity.responsibleManagerAr,
    addresseeTitle:
      data.offboarding.addresseeTitleAr ?? systemLegalEntity.responsibleManagerTitleAr,

    // ── The person leaving ──────────────────────────────────────────────────────────────────
    // The Arabic name and the Arabic job title: these are Arabic-language legal documents, and
    // `employees.job_title` is English ("Medical Rep"). It used to be printed as a last resort so
    // the form was not blank where a reader expects a job — the owner ruled against that on
    // 2026-08-31: the title goes on in Arabic or the box is left for the pen.
    employeeName: employee.nameAr ?? employee.fullName,
    jobTitle: profile.jobTitleAr ?? "",
    nationalId: employee.nationalId ?? "",
    address: employee.residenceAddress ?? "",
    phone: employee.mobileNumber ?? "",

    /**
     * نوع العقد — both forms print "(محدد المدة / غير محدد المدة)" as a menu and expect the
     * applicable one on the rule beside it. Every Sato Pharma contract is fixed-term by
     * construction — its own title is "عقد عمل محدد المدة" — so this is stated, not guessed.
     */
    contractType: "محدد المدة",
    contractStartDay: contractStart?.day ?? "",
    contractStartMonth: contractStart?.month ?? "",
    contractStartYear: contractStart?.year ?? "",

    // ── Why, and when ───────────────────────────────────────────────────────────────────────
    resignationReason: data.offboarding.endReasonAr ?? "",
    // The resignation writes the last working day as one phrase on a single rule; the agreement
    // splits the same date into a weekday and three boxed groups. Same date, two shapes.
    lastWorkingDate: lastWorking
      ? `${arabicDayName(lastWorking)} ${pinLtr(formatDayMonthYear(lastWorking))}`
      : "",
    lastWorkingWeekday: arabicDayName(lastWorking),
    lastWorkingDay: lastWorkingParts?.day ?? "",
    lastWorkingMonth: lastWorkingParts?.month ?? "",
    lastWorkingYear: lastWorkingParts?.year ?? "",

    // ── The employer's side of the agreement ────────────────────────────────────────────────
    agreementWeekday: arabicDayName(agreement),
    agreementDay: agreementParts?.day ?? "",
    agreementMonth: agreementParts?.month ?? "",
    agreementYear: agreementParts?.year ?? "",
    employerRepName: terms.employerRepNameAr,
    employerRepTitle: terms.employerRepTitleAr,
    companyName: systemLegalEntity.legalNameAr,
    companyHeadOffice: systemLegalEntity.headOfficeAr,
  };
}

/** The shell both templates print inside — US Letter, right-to-left, artwork-backed. */
function renderLabourDocument(title: string, banner: string[], sheets: string[]): string {
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  /*
   * US Letter (8.5in x 11in) — the size the Ministry issues these two templates at, and NOT the US
   * Legal the social-insurance forms use. Printing either at the wrong size moves every value off
   * its rule.
   */
${placedFormCss(LABOUR_PAGE_WIDTH_PT, LABOUR_PAGE_HEIGHT_PT, ARABIC_FONT_STACK)}
  ${PRINT_BANNER_CSS}
</style>
</head>
<body>
${printBanner(banner)}
${sheets.join("\n")}
${FIT_TO_BOX_SCRIPT}
</body>
</html>`;
}

/** طلب استقالة — the resignation request under مادة 167 of Labour Law 14/2025. One page. */
/**
 * @param fields The operator's own field layer — what has been moved, hidden or added on this request.
 *   Empty is the norm and means "print the compiled coordinates", which is what this did before the
 *   layer existed and what it still does wherever the layer's table is absent.
 */
export function renderResignationHtml(
  data: HiringPackData,
  copies: number,
  _templateVersionId?: string | null,
  fields: readonly DocumentFieldRow[] = [],
): string {
  const values = buildExitValues(data);
  const pages = layeredPages([{ svg: RESIGNATION_SVG, placements: RESIGNATION_PLACEMENTS }], values, fields);

  const sheets: string[] = [];
  for (let copy = 0; copy < Math.max(1, copies); copy += 1) {
    for (const page of pages) sheets.push(renderSheet(page.svg, page.placements, page.values));
  }

  const employeeName = data.employee.nameAr ?? data.employee.fullName;
  return renderLabourDocument(
    `طلب استقالة — ${employeeName}`,
    [
      `Paper size: US Letter (8.5in x 11in). ${copies} copies are already laid out below — leave the dialog's copy count at 1.`,
      "Scale must stay at 100% / “Actual size”. Fit-to-page shifts every value off its rule.",
      "Sign ONE exit form, never both: this OR the mutual-termination agreement.",
      "The signature, and the whole right-hand “اعتماد الجهة الإدارية المختصة” column, are filled at the labour office — not by Phoenix.",
    ],
    sheets,
  );
}

/** نموذج إنهاء علاقة العمل بالتوافق بين الطرفين — the mutual-termination agreement. Three pages. */
/**
 * @param fields The operator's own field layer — what has been moved, hidden or added on this agreement.
 *   Empty is the norm and means "print the compiled coordinates", which is what this did before the
 *   layer existed and what it still does wherever the layer's table is absent.
 */
export function renderMutualTerminationHtml(
  data: HiringPackData,
  copies: number,
  _templateVersionId?: string | null,
  fields: readonly DocumentFieldRow[] = [],
): string {
  const values = buildExitValues(data);
  const pages = layeredPages(
    [
      { svg: MUTUAL_PAGE_1_SVG, placements: MUTUAL_PAGE_1_PLACEMENTS },
      { svg: MUTUAL_PAGE_2_SVG, placements: MUTUAL_PAGE_2_PLACEMENTS },
      { svg: MUTUAL_PAGE_3_SVG, placements: MUTUAL_PAGE_3_PLACEMENTS },
    ],
    values,
    fields,
  );

  const sheets: string[] = [];
  for (let copy = 0; copy < Math.max(1, copies); copy += 1) {
    for (const page of pages) sheets.push(renderSheet(page.svg, page.placements, page.values));
  }

  const employeeName = data.employee.nameAr ?? data.employee.fullName;
  return renderLabourDocument(
    `إنهاء علاقة العمل بالتوافق — ${employeeName}`,
    [
      `Paper size: US Letter (8.5in x 11in). ${copies} copies of all three pages are laid out below — leave the dialog's copy count at 1.`,
      "Scale must stay at 100% / “Actual size”. Fit-to-page shifts every value off its rule.",
      "Sign ONE exit form, never both: this OR the resignation request.",
      "البند السابع gives each party a copy, so both sides sign every copy. Signatures and the company stamp on page 3 are written by hand.",
    ],
    sheets,
  );
}
