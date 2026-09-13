// THE GOVERNMENT FORMS FROM THE OWNER'S LETTERS PACK (2026-09-13) — printed exactly as issued.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// "Move them onto the Sato Pharma template, but governmental leave as is." The company's own letters
// in that pack were rebuilt on the house identity; these eight were not, and must never be. Each is
// the Authority's or the Labour Office's own sheet, and an office window refuses a form that has been
// restyled — the rule Form 1 already lives under.
//
// SO THEY WORK LIKE AN UPLOADED COMPANY TEMPLATE: a page surface with NO compiled placements. The
// artwork prints; anything written onto it is a field somebody placed in the Template Studio, or
// ink. Nobody has measured these sheets with a ruler the way Form 1 was, and inventing coordinates
// for a government form is how a value lands on the wrong box.
//
// THE ARTWORK is the owner's own files, converted page for page to vector SVG with every glyph drawn
// as a path, so the Arabic prints in the face it was set in whether or not that font is installed.
// Two of them are PHOTOGRAPHS of a copy rather than the original file — the car insurance
// certificate and the penalty-regulations approval request — and say so on the print banner until
// the clean originals replace them.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

import type { OfficialPackFormDocument } from "@/lib/hiring-pack/types";

/** A4 as the Word originals were set — 595.3 × 841.89pt. */
const A4_WIDTH_PT = 595.30398;
const A4_HEIGHT_PT = 841.8898;

export type OfficialPackForm = {
  titleAr: string;
  /** Who issues the form, for the print banner. */
  issuerEn: string;
  widthPt: number;
  heightPt: number;
  /** The public artwork, one path per printed side, in order. */
  pages: readonly string[];
  /** Set while the artwork is a photograph of a copy, not the clean original. */
  provisional: boolean;
};

const INSURANCE = "the National Organization for Social Insurance";
const LABOUR_OFFICE = "the Labour Office";

export const OFFICIAL_PACK_FORMS: Readonly<Record<OfficialPackFormDocument, OfficialPackForm>> = {
  maternityCompensation: {
    titleAr: "طلب تعويض عن إجازة الوضع",
    issuerEn: INSURANCE,
    widthPt: A4_WIDTH_PT,
    heightPt: A4_HEIGHT_PT,
    pages: ["/forms/insurance-maternity-compensation.svg"],
    provisional: false,
  },
  // Landscape. The owner's workbook repeats the same sheet on every printed page — only the first
  // carries «رقم المنشأة» in a second colour — so one side is the whole form.
  insuranceForm2: {
    titleAr: "استمارة 2 تأمينات",
    issuerEn: INSURANCE,
    widthPt: A4_HEIGHT_PT,
    heightPt: A4_WIDTH_PT,
    pages: ["/forms/insurance-form2.svg"],
    provisional: false,
  },
  carInsuranceCertificate: {
    titleAr: "شهادة تأمين سيارة — طلب تسجيل",
    issuerEn: INSURANCE,
    widthPt: A4_WIDTH_PT,
    heightPt: A4_HEIGHT_PT,
    pages: [
      "/forms/insurance-car-certificate-page1.svg",
      "/forms/insurance-car-certificate-page2.svg",
    ],
    provisional: true,
  },
  wageProgressSheet: {
    titleAr: "صحيفة تدرج الأجور",
    issuerEn: LABOUR_OFFICE,
    widthPt: A4_WIDTH_PT,
    heightPt: A4_HEIGHT_PT,
    pages: ["/forms/labour-office-wage-progress.svg"],
    provisional: false,
  },
  officialHolidaysSheet: {
    titleAr: "صحيفة الإجازات الرسمية",
    issuerEn: LABOUR_OFFICE,
    widthPt: A4_WIDTH_PT,
    heightPt: A4_HEIGHT_PT,
    pages: ["/forms/labour-office-official-holidays.svg"],
    provisional: false,
  },
  sickLeaveSheet: {
    titleAr: "صحيفة الإجازات المرضية",
    issuerEn: LABOUR_OFFICE,
    widthPt: A4_WIDTH_PT,
    heightPt: A4_HEIGHT_PT,
    pages: ["/forms/labour-office-sick-leave.svg"],
    provisional: false,
  },
  penaltiesSheet: {
    titleAr: "صحيفة الجزاءات",
    issuerEn: LABOUR_OFFICE,
    widthPt: A4_WIDTH_PT,
    heightPt: A4_HEIGHT_PT,
    pages: ["/forms/labour-office-penalties.svg"],
    provisional: false,
  },
  // The two scans were placed on an A4 sheet of 595.28 × 841.89pt, which is what they print at.
  penaltyRegulationsApproval: {
    titleAr: "طلب اعتماد لوائح الجزاءات ونظام العمل الأساسي للمنشآت",
    issuerEn: LABOUR_OFFICE,
    widthPt: 595.28,
    heightPt: 841.89,
    pages: [
      "/forms/labour-office-penalty-regulations-page1.svg",
      "/forms/labour-office-penalty-regulations-page2.svg",
    ],
    provisional: true,
  },
};
