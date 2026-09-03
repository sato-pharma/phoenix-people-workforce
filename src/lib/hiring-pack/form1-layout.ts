// Where every value sits on government Form 1 — نموذج ١، طلب اشتراك مؤمن عليه.
//
// HOW THESE NUMBERS WERE OBTAINED. They are not eyeballed. The official form is a vector PDF, so
// its box grids are real rectangles with real coordinates; every `digits` placement below was read
// straight out of the PDF's drawing operators, and every `text` placement off the bounding box of
// the dotted rule it writes on. That is why the cell counts are exactly right — 14 for the national
// ID, 9 for the insurance number, 4 for the building number — rather than approximately right.
//
// THE COORDINATE SYSTEM is the PDF's own: points, origin at the top-left of the page, 612.12 wide
// by 1008.12 tall. That is US Legal (8.5in × 14in), which is the paper this form is printed on and
// what `@page` therefore asks for. The rendered page places the official artwork as an SVG of
// exactly those dimensions and positions each value over it in the same units, so a value that
// measures at x=311 lands at x=311 with no scaling arithmetic anywhere in between.
//
// A NOTE ON THE BOXED CODE FIELDS. Four fields on this form are two-cell grids that want a NUMERIC
// government code, not a name: شياخة/قرية, قسم/مركز, محافظة and قطاع المنشأة. Two cells cannot
// hold "القاهرة". Whatever is captured is placed as-is and clipped to the cell count, and the UI
// labels those inputs as codes so the right thing gets typed in the first place.
//
// TWO FIELDS ARE SPLIT ACROSS PRINTED SEPARATORS and therefore appear here as more than one
// placement, with the renderer dividing the captured value between them: كود المهنة is six boxes in
// two groups of three with a gap between, and رقم التسجيل الضريبي is three dotted runs with printed
// slashes between them. Writing either as one wide field would put ink on top of the form's own
// separators.

import type { Placement } from "@/lib/hiring-pack/render-placement";

export const FORM1_PAGE_WIDTH_PT = 612.12;
export const FORM1_PAGE_HEIGHT_PT = 1008.12;

export const FORM1_PAGE_1_SVG = "/forms/social-insurance-form1-page1.svg";
export const FORM1_PAGE_2_SVG = "/forms/social-insurance-form1-page2.svg";

/**
 * Form 1's placements are ordinary placements — the shared kind every government form here uses.
 * The alias is kept so this file and `render-form1.ts` read as they always have.
 */
export type Form1Placement = Placement;

/**
 * The three wage grids, each a جنيه | قرش table with a header strip above a row of printed cells.
 *
 * WHICH COLUMN IS WHICH. The pounds column is the WIDER one and it is on the LEFT — confirmed by
 * reading the printed header labels' own bounding boxes: "جنيــــه" centres over the five-cell
 * block and "قرش" over the two-cell block to its right. That is the opposite of what a right-to-left
 * form suggests at a glance, and getting it backwards would put the piastres where the thousands
 * belong. Arabic numerals run left to right even inside Arabic text, so the amount reads across the
 * grid in the ordinary order.
 *
 * FIVE POUND CELLS caps a printable figure at 99,999 EGP. That is far above the statutory maximum
 * subscription wage, so it constrains nothing in practice, but a longer value is clipped rather
 * than allowed to spill across the form.
 *
 * Every number below is the value row only — the strip beneath the header, which is the part that
 * gets written in. All of them were read out of the PDF's own hairline rectangles.
 */
export type Form1WageGrid = {
  /**
   * Which of the three wage columns this is. A literal union rather than `string` on purpose: the
   * renderer feeds each column a DIFFERENT figure, so a typo or a newly added grid must fail the
   * typecheck rather than silently fall through to a default and print the wrong wage on a
   * government form. `tests/hiring-pack.test.ts` asserts at runtime that every key is handled too,
   * because an exhaustive mapping alone does not gate the build in this repo.
   */
  key: "basicWage" | "subscriptionWage" | "comprehensiveWage";
  /** جنيه — five evenly pitched cells, filled right-aligned so the units digit lands in the last. */
  pounds: { x: number; pitch: number; cells: number };
  /** قرش — two cells, printed at different widths, so each is given explicitly. */
  piastres: readonly { x: number; w: number }[];
  /** Top and height of the value row. */
  y: number;
  h: number;
};

export const FORM1_WAGE_GRIDS: readonly Form1WageGrid[] = [
  /** أجر أساسي — basic wage, rightmost on the page. */
  {
    key: "basicWage",
    pounds: { x: 440.7, pitch: 11.1, cells: 5 },
    piastres: [{ x: 496.7, w: 13 }, { x: 510.2, w: 14.9 }],
    y: 448.2,
    h: 14.7,
  },
  /** أجر / دخل الاشتراك — the wage social insurance is actually calculated on. */
  {
    key: "subscriptionWage",
    pounds: { x: 235.7, pitch: 11.12, cells: 5 },
    piastres: [{ x: 291.8, w: 12.9 }, { x: 305.2, w: 14.9 }],
    y: 448.1,
    h: 14.7,
  },
  /** الأجر الشامل — comprehensive wage, for the health-insurance contribution. */
  {
    key: "comprehensiveWage",
    pounds: { x: 47.3, pitch: 11.12, cells: 5 },
    piastres: [{ x: 103.4, w: 13 }, { x: 116.9, w: 14.8 }],
    y: 448.1,
    h: 14.7,
  },
];

export const FORM1_PAGE_1_PLACEMENTS: readonly Form1Placement[] = [
  // ── Header ────────────────────────────────────────────────────────────────────────────────
  /**
   * ".......... مكتب" — the NOSI branch office holding this file. The printed word مكتب occupies
   * x=561.2..589.3, so the writable rule is only what runs to its left: x=444.2..558.2.
   */
  { kind: "text", key: "insuranceOffice", x: 444.2, y: 39, w: 114, h: 14, align: "right", size: 9 },

  // ── الفئة — which class of insured person this is ─────────────────────────────────────────
  /**
   * Category 1, عاملين لدى الغير: employed by another party. Every Sato Pharma hire is this one,
   * so it is ticked unconditionally rather than offered as a choice nobody would ever change.
   */
  { kind: "tick", key: "categoryEmployee", x: 397, y: 108.2, w: 19.9, h: 19.9 },

  // ── The establishment ─────────────────────────────────────────────────────────────────────
  { kind: "digits", key: "establishmentNumber", x: 337, y: 165.7, pitch: 19.71, cells: 8, h: 19.9 },
  { kind: "digits", key: "sectorCode", x: 128, y: 165.7, pitch: 18.4, cells: 2, h: 19.9 },
  { kind: "text", key: "companyName", x: 325, y: 196, w: 167, h: 13, align: "right", size: 9 },
  // رقم التسجيل الضريبي — three dotted runs with the form's own "/" printed between them, at
  // x=120.6..126.2 and x=151.5..157.0. The number reads left to right across them.
  { kind: "text", key: "taxRegPart1", x: 95.2, y: 196, w: 25.4, h: 13, align: "center", size: 8 },
  { kind: "text", key: "taxRegPart2", x: 126.1, y: 196, w: 25.4, h: 13, align: "center", size: 8 },
  { kind: "text", key: "taxRegPart3", x: 157, y: 196, w: 19.3, h: 13, align: "center", size: 8 },

  // ── بيانات المؤمن عليه — the insured person ───────────────────────────────────────────────
  { kind: "digits", key: "insuranceNumber", x: 311, y: 256.4, pitch: 19.88, cells: 9, h: 19.9 },
  { kind: "digits", key: "nationalId", x: 211, y: 283.9, pitch: 19.85, cells: 14, h: 19.9 },
  { kind: "text", key: "insuredName", x: 313, y: 313, w: 181, h: 13, align: "right", size: 9 },
  { kind: "text", key: "nationality", x: 104, y: 313, w: 88, h: 13, align: "center", size: 9 },
  { kind: "text", key: "qualification", x: 429, y: 339, w: 101, h: 13, align: "right", size: 9 },
  // كود المهنة — six boxes in two groups of three, with a 14.7pt gap at x=282.5..297.2 between
  // them. The first three digits go in the left group, the last three in the right.
  { kind: "digits", key: "occupationCodeLeft", x: 223, y: 331.3, pitch: 19.83, cells: 3, h: 19.8 },
  { kind: "digits", key: "occupationCodeRight", x: 297.2, y: 331.3, pitch: 19.87, cells: 3, h: 19.8 },
  { kind: "text", key: "jobTitleAr", x: 64, y: 339, w: 101, h: 13, align: "center", size: 9 },

  // ── تاريخ بدء الاشتراك — day, month, year, right to left as the boxes run ─────────────────
  { kind: "digits", key: "startDay", x: 415, y: 358.2, pitch: 17, cells: 2, h: 17 },
  { kind: "digits", key: "startMonth", x: 368, y: 358.2, pitch: 17, cells: 2, h: 17 },
  { kind: "digits", key: "startYear", x: 289, y: 358.2, pitch: 17, cells: 4, h: 17 },

  // ── The three المسمى rules on the نوع المدة / كود الاشتراك / القطاع row ────────────────────
  { kind: "text", key: "periodTypeLabel", x: 329, y: 391, w: 99, h: 13, align: "right", size: 8 },
  { kind: "text", key: "subscriptionCodeLabel", x: 156, y: 391, w: 43, h: 13, align: "center", size: 8 },
  { kind: "text", key: "sectorLabel", x: 80, y: 391, w: 35, h: 13, align: "center", size: 8 },

  // ── بيانات محل إقامة المؤمن عليه — address inside Egypt ───────────────────────────────────
  { kind: "digits", key: "addressBuilding", x: 434, y: 592.6, pitch: 19.7, cells: 4, h: 19.9 },
  // شياخة / قرية and قسم / مركز are two SEPARATE two-box grids, twenty-five points apart. They
  // ask for different codes, and swapping them is invisible on the printed page.
  { kind: "digits", key: "addressDistrict", x: 467, y: 617.4, pitch: 19, cells: 2, h: 19.9 },
  { kind: "text", key: "addressStreet", x: 306, y: 648, w: 207, h: 13, align: "right", size: 9 },
  { kind: "digits", key: "addressMarkaz", x: 481, y: 668.6, pitch: 20, cells: 2, h: 19.8 },
  { kind: "digits", key: "addressGovernorate", x: 353, y: 668.6, pitch: 19, cells: 2, h: 19.8 },

  // ── Contact and the date of writing ───────────────────────────────────────────────────────
  { kind: "text", key: "phone", x: 374, y: 722, w: 123, h: 13, align: "center", size: 9 },
  { kind: "text", key: "email", x: 374, y: 746, w: 123, h: 13, align: "center", size: 8 },
  // "تحريرًا في: .. / .. / ...." — the label ends at x=538.8 and the colon is printed at
  // x=535.5..538.5, with the two slashes at x=501.8..504.8 and x=480.3..483.4. Day sits nearest the
  // label, then month, then year, which is how the row is read.
  { kind: "text", key: "writtenDay", x: 505, y: 770, w: 30, h: 13, align: "center", size: 9 },
  { kind: "text", key: "writtenMonth", x: 483.4, y: 770, w: 18.4, h: 13, align: "center", size: 9 },
  { kind: "text", key: "writtenYear", x: 440, y: 770, w: 40, h: 13, align: "center", size: 9 },
];

/**
 * Page 2 — the إرشادات and the إقرار on the back. NOW PRINTED WITH DATA.
 *
 * THE OWNER REVERSED HIS OWN INSTRUCTION ON 2026-09-03: "the insurance form 1 back page should have
 * printable data". It had printed blank since 2026-08-22, when he asked that the back come off the
 * printer exactly as the Authority issues it. The blank version was not a defect somebody fixed —
 * it was his earlier decision, and this is his later one.
 *
 * THE COORDINATES DID NOT NEED FINDING AGAIN. Whoever emptied this list wrote all four measurements
 * into the note they left behind, against exactly this possibility, so the reversal cost a placement
 * list rather than a re-measure of the artwork. They are transcriptions out of the source PDF, like
 * every other number in this file.
 *
 * `establishmentNumber` IS THE COMPANY'S INSURANCE NUMBER, and it is reused here rather than given a
 * `companyInsuranceNumber` of its own as the old note suggested. The إقرار asks for the same number
 * page 1 already carries in its box grid, and two keys for one fact are two things that can
 * disagree — a form whose front and back state different insurance numbers is worse than one that
 * states neither. The same value prints in both places: digits on the front, text on the back.
 *
 * The artwork itself was verified against the source PDF at 200 DPI: with a one-pixel tolerance,
 * zero ink in the rendered page is absent from the original.
 */
export const FORM1_PAGE_2_PLACEMENTS: readonly Form1Placement[] = [
  // The إقرار's establishment identification — "اسم المنشأة ... ورقمها التأميني ...".
  { kind: "text", key: "companyName", x: 249, y: 510, w: 241, h: 13, align: "right", size: 9 },
  {
    kind: "text",
    key: "establishmentNumber",
    x: 31,
    y: 510,
    w: 130,
    h: 13,
    align: "center",
    size: 9,
  },
  { kind: "text", key: "companyAddress", x: 30, y: 536, w: 468, h: 13, align: "right", size: 9 },

  // "أقر أنا ..." — the employee's own declaration, in his Arabic name, as on the front.
  { kind: "text", key: "insuredName", x: 320, y: 714, w: 210, h: 13, align: "center", size: 9 },
];
