// Where every value sits on government Form 6 — نموذج ٦، إخطار بإنتهاء اشتراك مؤمن عليه.
//
// WHAT THIS DOCUMENT IS. Form 1 tells the National Organization for Social Insurance that somebody
// has STARTED; Form 6 tells it that somebody has STOPPED. They are the two ends of one file, issued
// by the same authority, printed on the same US Legal paper, laid out to the same conventions — so
// this file is the mirror of `form1-layout.ts` and deliberately reads like it.
//
// HOW THESE NUMBERS WERE OBTAINED. They are not eyeballed. The official form is a vector PDF, so
// its box grids are real rectangles: every `digits` placement below is the leftmost cell's own
// rectangle, and its `pitch` is the measured centre-to-centre distance across that grid. Every
// `text` placement was fixed by rasterising the source at 300 DPI and finding the row of pixels the
// dotted rule actually prints on, then seating the text on it — the same 9.4pt offset between a
// placement's top and its rule that the shipped Form 1 uses, measured back off Form 1's own artwork
// so the two documents put ink in the same place relative to a rule.
//
// THE COORDINATE SYSTEM is the PDF's own: points, origin at the top-left, 612.12 wide by 1008.12
// tall — US Legal (8.5in x 14in), which is what `@page` therefore asks for.
//
// THREE RULES ARE DELIBERATELY LEFT BLANK. Beside each of شياخة/قرية, قسم/مركز and محافظة the form
// prints BOTH a dotted rule for the name and a two-cell grid for the government code. Phoenix
// captures only the code — `employee_hiring_profile` stores these three as codes because Form 1
// asks for them that way, and two cells cannot hold "القاهرة". Rather than invent a second address
// vocabulary that would drift from the first, the codes are placed and the name rules are left for
// the pen. They were measured all the same and need no finding again: شياخة/قرية at x=435.12 w=94.6,
// قسم/مركز at x=250.56 w=80.9, محافظة at x=88.08 w=73.9, all on the rule at ink y=462 (so y=452.6,
// h=13, align right). Filling them means listing them below and adding the three names to the
// hiring profile — it is a data-capture change, not a rendering one.

import type { Placement } from "@/lib/hiring-pack/render-placement";

export const FORM6_PAGE_WIDTH_PT = 612.12;
export const FORM6_PAGE_HEIGHT_PT = 1008.12;

export const FORM6_PAGE_1_SVG = "/forms/social-insurance-form6-page1.svg";
export const FORM6_PAGE_2_SVG = "/forms/social-insurance-form6-page2.svg";

export const FORM6_PAGE_1_PLACEMENTS: readonly Placement[] = [
  // ── Header ────────────────────────────────────────────────────────────────────────────────
  /**
   * ".......... مكتب" — the NOSI branch office holding this file, the same office Form 1 was filed
   * with. The printed word مكتب sits to the right of the rule, which runs x=452.88..539.04.
   */
  { kind: "text", key: "insuranceOffice", x: 452.9, y: 44.4, w: 86.2, h: 13, align: "right", size: 9 },

  // ── The establishment ─────────────────────────────────────────────────────────────────────
  // رقــم المنشـأة — eight cells, x=343.08..501.96.
  { kind: "digits", key: "establishmentNumber", x: 343.08, y: 120.72, pitch: 19.86, cells: 8, h: 19.92 },
  // مسمــى — the establishment's name, on the rule at x=84.72..235.44.
  { kind: "text", key: "companyName", x: 84.7, y: 126.4, w: 150.7, h: 13, align: "right", size: 9 },
  /**
   * رقم التسجيل الضريبي للمنشأة — three dash groups with the form's own "/" printed between them.
   * Measured as ink: 379.44..401.52, 414.48..427.20 and 436.08..449.04. The number reads left to
   * right across them, which is the order Form 1 also uses.
   */
  { kind: "text", key: "taxRegPart1", x: 379.4, y: 144.0, w: 22.1, h: 13, align: "center", size: 8 },
  { kind: "text", key: "taxRegPart2", x: 414.5, y: 144.0, w: 12.7, h: 13, align: "center", size: 8 },
  { kind: "text", key: "taxRegPart3", x: 436.1, y: 144.0, w: 13.0, h: 13, align: "center", size: 8 },

  // ── بيانات المؤمن عليه — the insured person ───────────────────────────────────────────────
  // الرقم التأميني — eight cells here, where Form 1 prints nine. Measured, not assumed.
  { kind: "digits", key: "insuranceNumber", x: 340.8, y: 217.32, pitch: 19.86, cells: 8, h: 19.8 },
  { kind: "digits", key: "nationalId", x: 223.08, y: 252.12, pitch: 19.84, cells: 14, h: 19.8 },
  { kind: "text", key: "insuredName", x: 306.7, y: 290.6, w: 211.4, h: 13, align: "right", size: 9 },

  // ── تاريخ انتهاء الاشتراك — the date the subscription ends ────────────────────────────────
  /**
   * Day, month, year, right to left as the printed boxes run — the form draws its own slashes
   * between the three groups. This is the employee's LAST WORKING DAY: the date service ended, not
   * the date the notification is written, and putting today's date here is the mistake this form
   * exists to prevent.
   */
  { kind: "digits", key: "endDay", x: 430.32, y: 324.48, pitch: 19.86, cells: 2, h: 21.24 },
  { kind: "digits", key: "endMonth", x: 370.8, y: 324.48, pitch: 19.86, cells: 2, h: 21.24 },
  { kind: "digits", key: "endYear", x: 271.56, y: 324.48, pitch: 19.88, cells: 4, h: 21.24 },
  /**
   * سبب انتهاء الاشتراك — the reason in words on the rule, and the Authority's own numeric reason
   * code in the single box at the far left. The code box is one cell, so it holds a code and never
   * a word.
   */
  { kind: "text", key: "endReason", x: 78.2, y: 326.6, w: 85.7, h: 13, align: "right", size: 8 },
  { kind: "digits", key: "endReasonCode", x: 44.04, y: 322.8, pitch: 19.92, cells: 1, h: 19.92 },

  // ── بيانات محل إقامة المؤمن عليه — the address, as Form 1 already captured it ──────────────
  { kind: "digits", key: "addressBuilding", x: 437.64, y: 411.84, pitch: 19.86, cells: 4, h: 19.92 },
  { kind: "text", key: "addressStreet", x: 53.0, y: 416.6, w: 321.1, h: 13, align: "right", size: 9 },
  // The three code grids. Their name rules are left for the pen — see the note at the top.
  { kind: "digits", key: "addressDistrict", x: 383.28, y: 447.12, pitch: 19.92, cells: 2, h: 19.92 },
  { kind: "digits", key: "addressMarkaz", x: 201.36, y: 447.12, pitch: 19.92, cells: 2, h: 19.92 },
  { kind: "digits", key: "addressGovernorate", x: 32.4, y: 443.04, pitch: 19.92, cells: 2, h: 19.92 },

  // ── Contact ───────────────────────────────────────────────────────────────────────────────
  { kind: "text", key: "phone", x: 138.5, y: 470.6, w: 285.8, h: 13, align: "center", size: 9 },
  { kind: "text", key: "email", x: 210.7, y: 488.6, w: 286.1, h: 13, align: "center", size: 9 },

  // ── NOTHING BELOW THE ADDRESS BLOCK IS WRITTEN BY PHOENIX ──────────────────────────────────
  // Everything further down page 1 is signed or stamped by a person at the moment it happens:
  // the two إقرار blocks (توقيع المؤمن عليه and توقيع المدير المسئول, each with its own "٢٠ / /"
  // date, at ink y=588 and y=606), the registered-letter number and date used only when there is a
  // dispute (ink y=696 and y=732), the خاتم, and the Authority's own receipt table at the foot. A
  // signature date typed in advance is a date nobody checked; these stay blank on purpose.
];

/**
 * Page 2 — the إرشادات and the إقرار on the back. PRINTED BLANK, BY THE OWNER'S INSTRUCTION.
 *
 * This is the same standing rule that governs Form 1's back page (2026-08-22): the reverse of a
 * social-insurance form comes off the printer exactly as the Authority issues it, with no value
 * written on it by Phoenix. The back carries the government's instructions and two declarations
 * that are signed in the first person by the employee and the responsible manager — the إقرار about
 * the البطاقة العلاجية, the treatment card — so what belongs there is a pen, not a database.
 *
 * Page 1 ends with "( أنظـر خلفه )" — see the back. The two sides are one sheet, which is exactly
 * why this document must be printed double-sided.
 */
export const FORM6_PAGE_2_PLACEMENTS: readonly Placement[] = [];
