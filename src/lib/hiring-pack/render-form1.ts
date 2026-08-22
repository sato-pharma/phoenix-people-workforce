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
  type Form1Placement,
  type Form1WageGrid,
} from "@/lib/hiring-pack/form1-layout";
import {
  ARABIC_FONT_STACK,
  escapeHtml,
  PRINT_BANNER_CSS,
  printBanner,
  splitIsoDate,
  todayInCairo,
} from "@/lib/hiring-pack/render-shared";
import type { HiringPackData } from "@/lib/hiring-pack/types";

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

/**
 * A tax registration number laid out across the form's three printed segments.
 *
 * Egyptian tax numbers are written in three groups — 123/456/789 — and this form prints the slashes
 * itself. Whatever separators HR types are discarded and the digits are regrouped, so "123-456-789",
 * "123/456/789" and "123456789" all land the same way.
 */
function splitTaxRegistration(raw: string): [string, string, string] {
  const groups = raw.split(/[^0-9]+/u).filter(Boolean);
  if (groups.length >= 3) return [groups[0], groups[1], groups.slice(2).join("")];
  const digits = groups.join("");
  return [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6, 9)];
}

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
    nationality: profile.nationality ?? "",
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

function renderPlacement(placement: Form1Placement, values: Record<string, string>): string {
  const raw = values[placement.key] ?? "";
  if (!raw) return "";

  if (placement.kind === "tick") {
    return `<span class="f tick" style="left:${placement.x}pt;top:${placement.y}pt;width:${placement.w}pt;height:${placement.h}pt;line-height:${placement.h}pt">${escapeHtml(raw)}</span>`;
  }

  if (placement.kind === "digits") {
    // Digits are written left to right even inside an otherwise right-to-left form, and the grid is
    // clipped to its own cell count so an over-long value can never spill past the printed boxes.
    const characters = [...raw].slice(0, placement.cells);
    const cells = characters
      .map(
        (character, index) =>
          `<span class="cell" style="left:${(index * placement.pitch).toFixed(2)}pt;width:${placement.pitch.toFixed(2)}pt;line-height:${placement.h}pt">${escapeHtml(character)}</span>`,
      )
      .join("");
    const width = placement.pitch * placement.cells;
    const size = placement.size ?? 10;
    return `<span class="f grid" style="left:${placement.x}pt;top:${placement.y}pt;width:${width.toFixed(2)}pt;height:${placement.h}pt;font-size:${size}pt">${cells}</span>`;
  }

  const size = placement.size ?? 9;
  return `<span class="f txt" style="left:${placement.x}pt;top:${placement.y}pt;width:${placement.w}pt;height:${placement.h}pt;line-height:${placement.h}pt;text-align:${placement.align};font-size:${size}pt">${escapeHtml(raw)}</span>`;
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

function renderSheet(
  svg: string,
  placements: readonly Form1Placement[],
  values: Record<string, string>,
  extras: string,
): string {
  const fields = placements.map((placement) => renderPlacement(placement, values)).join("");
  return `<section class="sheet">
    <img class="artwork" src="${svg}" alt="" aria-hidden="true">
    ${fields}
    ${extras}
  </section>`;
}

export function renderForm1Html(data: HiringPackData, copies: number): string {
  const values = buildForm1Values(data);

  // All three wage grids are filled from the SAME insurance wage. That is deliberate: the basic and
  // comprehensive figures on this form are both derived from the subscription wage, and putting the
  // gross salary in one of them — which is what happens when a person fills it in by hand in a
  // hurry — overstates the contribution base.
  const wage = data.employee.socialInsuranceWage;
  const wageGrids = FORM1_WAGE_GRIDS.map((grid) => renderWageGrid(grid, wage)).join("");

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
  @page { size: ${FORM1_PAGE_WIDTH_PT}pt ${FORM1_PAGE_HEIGHT_PT}pt; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #e2e8f0; }
  body { font-family: ${ARABIC_FONT_STACK}; }
  ${PRINT_BANNER_CSS}

  .sheet {
    position: relative;
    width: ${FORM1_PAGE_WIDTH_PT}pt;
    height: ${FORM1_PAGE_HEIGHT_PT}pt;
    margin: 0 auto 18px;
    background: #fff;
    overflow: hidden;
    page-break-after: always;
    break-after: page;
  }
  .sheet:last-child { page-break-after: auto; break-after: auto; margin-bottom: 0; }

  .artwork {
    position: absolute; inset: 0;
    width: ${FORM1_PAGE_WIDTH_PT}pt; height: ${FORM1_PAGE_HEIGHT_PT}pt;
    /* The official artwork is a background, never a target: it must not intercept a click, and it
       must not be dragged out of the page as an image. */
    pointer-events: none; user-select: none;
  }

  /* Every filled value. Absolute, in the PDF's own points, so a coordinate measured off the source
     lands unchanged on the paper. */
  .f {
    position: absolute;
    display: block;
    color: #000;
    white-space: nowrap;     /* a wrapped value in a one-line slot is unreadable, never allowed */
    overflow: visible;
    font-family: ${ARABIC_FONT_STACK};
  }
  .txt { font-weight: 600; }
  .tick { text-align: center; font-size: 13pt; font-weight: 700; }
  /* One digit per printed cell, so no letter-spacing — it would push a centred digit off its box. */
  .wage { direction: ltr; text-align: center; font-size: 10pt; font-weight: 700; }
  .grid { direction: ltr; font-weight: 700; }
  .grid .cell { position: absolute; top: 0; display: block; text-align: center; }

  @media print {
    html, body { background: #fff; }
    .sheet { margin: 0; box-shadow: none; }
    /* Without this the browser drops the form's own rules and boxes to save toner, and what comes
       out is a page of floating values with no form around them. */
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
</head>
<body>
${printBanner([
  "MUST be printed DOUBLE-SIDED — tick “Print on both sides” in the dialog. Page 2 is the back of page 1, and the employee signs it.",
  `Paper size: US Legal (8.5in x 14in). ${copies} copies are already laid out below — leave the dialog's copy count at 1.`,
  "Scale must stay at 100% / “Actual size”. Fit-to-page shifts every value off its box.",
])}
${sheets.join("\n")}
</body>
</html>`;
}
