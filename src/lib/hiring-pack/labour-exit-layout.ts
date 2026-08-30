// Where every value sits on the two Ministry of Labour exit forms.
//
// WHAT THESE TWO DOCUMENTS ARE, AND WHY THEY ARE ONE FILE. Egyptian labour law recognises two
// lawful ways for an employment relationship to end by agreement rather than by dismissal, and the
// Ministry issues a template for each:
//
//   • طلب استقالة — a resignation request under مادة 167 of Labour Law 14/2025. One page. The
//     employee asks; the employer accepts; the competent administrative authority endorses it.
//   • نموذج إنهاء علاقة العمل بالتوافق بين الطرفين — a mutual-termination agreement. Three pages,
//     seven clauses, signed by both parties.
//
// THEY ARE ALTERNATIVES, NEVER BOTH. The owner's instruction (2026-08-30) is explicit: "not the two
// should be signed, either this or this". The two forms describe incompatible facts — one says the
// employee asked to leave, the other says both parties agreed to end it — so a file holding both
// signed is a file that contradicts itself. `exitRoute` on the offboarding profile records which
// one was taken, and the screen prints one route at a time.
//
// HOW THESE NUMBERS WERE OBTAINED. Same method as the social-insurance forms: the source is a
// vector PDF, every dotted rule was located by rasterising at 300 DPI and finding the row of pixels
// the rule actually prints on, and each value is seated on its rule with the same 9.4pt offset that
// the shipped Form 1 uses. Nothing here is estimated.
//
// THE COORDINATE SYSTEM is the PDF's own: points, origin top-left. Both forms are US Letter
// (612 x 792pt) — NOT the US Legal the social-insurance forms use, and not A4. `@page` states it.
//
// NOTHING IS WRITTEN IN A GOVERNMENT BLOCK. On the resignation the whole right-hand column —
// تاريخ الاعتماد, رقم المسلسل, توقيع المسئول, خاتم الجهة الإدارية المختصة — belongs to the labour
// office, and the "بتاريخ / /" on the اعتماد line is stamped there too. Signature rules on both
// forms are for a pen. A typed signature date is a date nobody checked.

import type { Placement } from "@/lib/hiring-pack/render-placement";

export const LABOUR_PAGE_WIDTH_PT = 612;
export const LABOUR_PAGE_HEIGHT_PT = 792;

export const RESIGNATION_SVG = "/forms/labour-resignation-request.svg";
export const MUTUAL_PAGE_1_SVG = "/forms/labour-mutual-termination-page1.svg";
export const MUTUAL_PAGE_2_SVG = "/forms/labour-mutual-termination-page2.svg";
export const MUTUAL_PAGE_3_SVG = "/forms/labour-mutual-termination-page3.svg";

/**
 * طلب استقالة — the resignation request, one page.
 *
 * The body is a letter the employee writes in the first person, and the block at the foot repeats
 * his identity for the file. Both are filled from the same employee record, so the name in the
 * letter and the name in the block cannot disagree — which is the transcription error this feature
 * exists to end.
 */
export const RESIGNATION_PLACEMENTS: readonly Placement[] = [
  // ── The letter ────────────────────────────────────────────────────────────────────────────
  // "السيد الأستاذ الفاضل / .........." — who the resignation is addressed to, and his title on
  // the "مدير / .........." line beneath it.
  { kind: "text", key: "addresseeName", x: 96.0, y: 191.2, w: 333.4, h: 13, align: "right", size: 11 },
  { kind: "text", key: "addresseeTitle", x: 83.3, y: 221.0, w: 256.8, h: 13, align: "right", size: 11 },
  // "مقدمه لسيادتكم السيد / .......... من العاملين بالشركة"
  { kind: "text", key: "employeeName", x: 234.7, y: 250.8, w: 162.7, h: 13, align: "right", size: 10 },
  // "بوظيفة .......... بعقد عمل .......... (محدد المدة / غير محدد المدة)"
  { kind: "text", key: "jobTitle", x: 332.6, y: 280.8, w: 162.5, h: 13, align: "right", size: 10 },
  { kind: "text", key: "contractType", x: 234.5, y: 280.8, w: 33.4, h: 13, align: "center", size: 7 },
  // "ونظراً لـ .......... (ظروف خاصة / دواعي السفر / نقل محل اقامتي / أي سبب اخر)" — the printed
  // parenthetical is the menu of accepted reasons; the rule takes the one that applies.
  { kind: "text", key: "resignationReason", x: 409.7, y: 310.5, w: 79.0, h: 13, align: "center", size: 8 },
  // "علماً بأن أخر يوم عمل لي هو .........."
  { kind: "text", key: "lastWorkingDate", x: 237.8, y: 370.3, w: 148.6, h: 13, align: "center", size: 10 },
  // The "وقد قمت باعتماد الاستقالة من الجهة الإدارية المختصة بتاريخ ../../...." date is left blank:
  // it is written when the labour office endorses the paper, which has not happened yet when this
  // prints. Measured all the same — day x=173.5 w=26.2, month x=139.0 w=22.8, year x=104.4 w=23.0,
  // all at y=400.0.

  // ── "مقدمه لسيادتكم :" — the employee's own block at the foot ──────────────────────────────
  { kind: "text", key: "employeeName", x: 90.0, y: 501.6, w: 158.9, h: 13, align: "right", size: 10 },
  { kind: "text", key: "jobTitle", x: 93.1, y: 521.5, w: 158.9, h: 13, align: "right", size: 10 },
  { kind: "text", key: "nationalId", x: 93.6, y: 541.4, w: 138.0, h: 13, align: "center", size: 10 },
  { kind: "text", key: "address", x: 91.7, y: 561.3, w: 162.7, h: 13, align: "right", size: 7 },
  { kind: "text", key: "phone", x: 92.2, y: 581.2, w: 138.2, h: 13, align: "center", size: 10 },
  // التوقيع ( .......... ) at ink y=610.56 stays blank — it is signed by hand.
];

/**
 * Page 1 of the mutual-termination agreement — the parties and the تمهيد.
 *
 * "إنه في يوم <weekday> الموافق <dd>/<mm>/<yyyy>" dates the AGREEMENT, which is not the last
 * working day: the two parties sign on one date and service ends on another, and clause 3 on page 2
 * carries the second one. Conflating them is the error this layout keeps apart by naming them
 * differently.
 */
export const MUTUAL_PAGE_1_PLACEMENTS: readonly Placement[] = [
  { kind: "text", key: "agreementWeekday", x: 433.0, y: 216.2, w: 50.6, h: 13, align: "center", size: 10 },
  { kind: "text", key: "agreementDay", x: 361.4, y: 216.2, w: 33.1, h: 13, align: "center", size: 10 },
  { kind: "text", key: "agreementMonth", x: 311.0, y: 216.2, w: 43.9, h: 13, align: "center", size: 10 },
  { kind: "text", key: "agreementYear", x: 250.3, y: 216.2, w: 54.2, h: 13, align: "center", size: 10 },

  // الطرف الأول — the employer's legal representative, and the company he represents.
  { kind: "text", key: "employerRepName", x: 254.4, y: 275.7, w: 162.5, h: 13, align: "right", size: 10 },
  { kind: "text", key: "companyName", x: 88.6, y: 305.7, w: 298.8, h: 13, align: "right", size: 10 },
  // الطرف الثاني — the employee, and the job he holds.
  { kind: "text", key: "employeeName", x: 240.0, y: 335.5, w: 172.8, h: 13, align: "right", size: 10 },
  { kind: "text", key: "jobTitle", x: 79.7, y: 365.5, w: 347.8, h: 13, align: "right", size: 10 },

  // ( تمهيد ) — restates the job and the contract it runs under.
  { kind: "text", key: "jobTitle", x: 72.7, y: 462.9, w: 207.8, h: 13, align: "right", size: 10 },
  { kind: "text", key: "contractType", x: 381.1, y: 492.7, w: 92.6, h: 13, align: "center", size: 9 },
  // "منذ تاريخ ../../...." — when the contract started. Day, month, year, right to left.
  { kind: "text", key: "contractStartDay", x: 138.2, y: 492.7, w: 15.8, h: 13, align: "center", size: 8 },
  { kind: "text", key: "contractStartMonth", x: 109.0, y: 492.7, w: 22.8, h: 13, align: "center", size: 8 },
  { kind: "text", key: "contractStartYear", x: 72.5, y: 492.7, w: 30.0, h: 13, align: "center", size: 8 },
];

/**
 * Page 2 — clauses two to five. Only clause 3 has a blank, and it is the important one on the whole
 * document: "يقر الطرفان أن اخر يوم عمل تم الاتفاق عليه هو يوم <weekday> الموافق <dd>/<mm>/<yyyy>".
 */
export const MUTUAL_PAGE_2_PLACEMENTS: readonly Placement[] = [
  { kind: "text", key: "lastWorkingWeekday", x: 205.9, y: 301.9, w: 33.4, h: 13, align: "center", size: 9 },
  { kind: "text", key: "lastWorkingDay", x: 148.1, y: 301.9, w: 19.2, h: 13, align: "center", size: 9 },
  { kind: "text", key: "lastWorkingMonth", x: 106.6, y: 301.9, w: 29.8, h: 13, align: "center", size: 9 },
  { kind: "text", key: "lastWorkingYear", x: 74.6, y: 301.9, w: 23.0, h: 13, align: "center", size: 9 },
];

/**
 * Page 3 — clauses six and seven, then the two signature blocks.
 *
 * The blocks sit side by side: ممثل صاحب العمل او المنشأة on the RIGHT (x≈340..500) and العامل أو
 * ممثله القانوني on the LEFT (x≈90..255). They ask for different things — the employer's side wants
 * the company's name and premises where the worker's side wants a national ID and an address — so
 * the two columns are not mirror images and swapping them is invisible on the printed page.
 */
export const MUTUAL_PAGE_3_PLACEMENTS: readonly Placement[] = [
  // ── ممثل صاحب العمل او المنشأة (right) ────────────────────────────────────────────────────
  { kind: "text", key: "employerRepName", x: 340.1, y: 544.8, w: 158.9, h: 13, align: "right", size: 9 },
  { kind: "text", key: "employerRepTitle", x: 342.0, y: 564.4, w: 141.6, h: 13, align: "right", size: 9 },
  { kind: "text", key: "companyName", x: 343.2, y: 584.4, w: 113.8, h: 13, align: "right", size: 8 },
  /**
   * مقر المنشأة. The printed rule is the shortest in this column and the value it holds is the
   * longest — Sato Pharma's registered premises run to 74 characters, against a measured rule of
   * 117.4pt starting at x=342. Right-aligned text extends LEFTWARDS from its right edge, so the
   * surplus ran out of the employer's column and printed across the EMPLOYEE's labels opposite:
   * two parties' details overprinted on the page a labour inspector reads.
   *
   * The box therefore grows to the LEFT and not to the right. Its right edge stays at 459.4, where
   * the printed label "مقر الشركة :" ends — moving that edge would print the address over the
   * label itself, which is the mistake the first attempt at this made. The left edge stops at
   * x=310, which clears the employee column: its VALUE rules end at 254.4 and its printed labels
   * (العنـوان:, رقم التليفون:) sit to the right of those, running to roughly x=305. Writing past
   * the end of a short rule but inside one's own column is what a person does by hand with a long
   * address; writing over the other party's labels is not, and 254.4 was not far enough — that was
   * measured against the wrong thing, the employee's rules rather than the employee's labels.
   * `FIT_TO_BOX_SCRIPT` compresses whatever still does not fit, so nothing leaves this box.
   */
  { kind: "text", key: "companyHeadOffice", x: 310.0, y: 604.3, w: 149.4, h: 13, align: "right", size: 5 },
  // التوقيع at ink y=633.60 and خاتم جهة العمل below it stay blank — pen and stamp.

  // ── العامل أو ممثله القانوني (left) ───────────────────────────────────────────────────────
  { kind: "text", key: "employeeName", x: 90.0, y: 544.8, w: 158.9, h: 13, align: "right", size: 9 },
  { kind: "text", key: "jobTitle", x: 90.5, y: 564.4, w: 158.9, h: 13, align: "right", size: 9 },
  { kind: "text", key: "nationalId", x: 91.0, y: 584.4, w: 138.0, h: 13, align: "center", size: 9 },
  { kind: "text", key: "address", x: 91.7, y: 604.3, w: 162.7, h: 13, align: "right", size: 6 },
  { kind: "text", key: "phone", x: 89.5, y: 624.2, w: 138.2, h: 13, align: "center", size: 9 },
  // التوقيع at ink y=653.52 stays blank.
];
