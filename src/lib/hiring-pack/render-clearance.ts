import { systemLegalEntity } from "@/config/system-settings";
import {
  CLEARANCE_BLANK_RULE,
  CLEARANCE_BLANK_RULE_WIDE,
  type ClearanceBlock,
  type ClearanceField,
  type ClearanceTemplate,
  type ClearanceToken,
} from "@/lib/hiring-pack/clearance-template";
import {
  CLEARANCE_COMPANY_V1,
  CLEARANCE_EMPLOYEE_V1,
  clearanceTemplateById,
} from "@/lib/hiring-pack/clearance-text";
import {
  ARABIC_FONT_STACK,
  escapeHtml,
  formatDayMonthYear,
  PRINT_BANNER_CSS,
  pinLtr,
  printBanner,
  resolvePermanentAddress,
} from "@/lib/hiring-pack/render-shared";
import type { HiringPackData } from "@/lib/hiring-pack/types";

// The two clearance papers — إخلاء طرف — laid out for A4 and printed by the browser.
//
// They run in OPPOSITE directions: one is the company certifying the employee is clear and the
// employee keeps it; the other is the employee releasing the company and the company keeps it. The
// full account is at the top of `clearance-template.ts`. What matters here is that the keeper is
// printed on the page, in a strip under the masthead, because the pair is otherwise easy to
// confuse and handing each side the wrong one leaves both unprotected.
//
// Typeset rather than placed over artwork, like the contract and the custody receipt and unlike
// Form 1 and Form 6: these are Sato's own instruments, so they reflow and a long Arabic name
// pushes what follows down instead of colliding with a fixed box.

/** Every blank these forms can fill. The settlement amount is not among them — see the template. */
function buildClearanceValues(data: HiringPackData): Partial<Record<ClearanceToken, string>> {
  const { employee, profile, offboarding, exit } = data;
  const recital = systemLegalEntity.contractRecital;

  // THE THREE SOURCES OF A LAST WORKING DAY, in the order the rest of this module reads them: the
  // human's override first, then the resignation record, then the employee row. They are not
  // competing answers — the exit form that writes `employee_resignations` copies ONE date into four
  // of its columns, so the record agreeing with itself proves nothing, and the override exists for
  // the case where the date on the paper is not the date in the table.
  const lastWorkingDate =
    offboarding.lastWorkingDate ?? exit?.lastWorkingDate ?? employee.lastWorkingDate;

  return {
    COMPANY_NAME: systemLegalEntity.legalNameAr,
    COMPANY_LEGAL_FORM: recital.legalFormAr,
    COMMERCIAL_REGISTER: pinLtr(recital.commercialRegisterNumber),
    COMMERCIAL_REGISTER_OFFICE: recital.commercialRegisterOfficeAr,
    UNIFIED_REGISTER: pinLtr(recital.unifiedRegisterNumber),
    TAX_CARD: pinLtr(recital.taxCardNumber),
    COMPANY_HEAD_OFFICE_FULL: recital.headOfficeAr,

    EMPLOYEE_NAME: employee.nameAr ?? employee.fullName,
    NATIONAL_ID: employee.nationalId ?? "",
    JOB_TITLE: profile.jobTitleAr ?? employee.jobTitle ?? "",
    DEPARTMENT: employee.departmentAr ?? "",
    HIRE_DATE: employee.hireDate ? formatDayMonthYear(employee.hireDate) : "",
    LAST_WORKING_DATE: lastWorkingDate ? formatDayMonthYear(lastWorkingDate) : "",
    ADDRESS: resolvePermanentAddress({
      addressBuilding: profile.addressBuilding,
      addressStreet: profile.addressStreet,
      residenceAddress: employee.residenceAddress,
      residenceCity: employee.residenceCity,
    }),
  };
}

/**
 * One value, laid out in the direction its CONTENT needs.
 *
 * `dir="ltr"` per value, never `dir="auto"` on the line: `auto` reads only the first strong
 * character, so a line holding an Arabic label and a Latin value turns wholly one way and renders
 * the other half backwards — the exact mirror of the bug being fixed.
 */
function fieldValue(field: ClearanceField, values: Partial<Record<ClearanceToken, string>>): string {
  if (field.fixedAr) return `<span class="fixed">${escapeHtml(field.fixedAr)}</span>`;

  const raw = field.token ? values[field.token] : undefined;
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text.length === 0) {
    const rule = field.wide ? CLEARANCE_BLANK_RULE_WIDE : CLEARANCE_BLANK_RULE;
    return `<span class="rule-line">${escapeHtml(rule)}</span>`;
  }
  if (field.ltr) return `<span class="val" dir="ltr">${escapeHtml(text)}</span>`;
  return `<span class="val">${escapeHtml(text)}</span>`;
}

function fieldsBlock(
  fields: readonly ClearanceField[],
  values: Partial<Record<ClearanceToken, string>>,
): string {
  const cells = fields
    .map(
      (field) => `<div class="cell${field.wide ? " cell--wide" : ""}">
      <span class="cell__label">${escapeHtml(field.labelAr)}</span>
      <span class="cell__value">${fieldValue(field, values)}</span>
    </div>`,
    )
    .join("");
  return `<div class="grid2">${cells}</div>`;
}

/**
 * The departmental sign-off table.
 *
 * Every cell after the department and its scope is open for the pen. Phoenix's Clearance module
 * holds each desk's recorded decision, and printing it here was considered and refused: this row
 * carries a signature column, and a form that says "لا مستحقات: نعم" beside an unsigned line
 * asserts a sign-off nobody put a pen to. The recorded decision belongs on the screen, where it
 * already is.
 */
function stationsBlock(block: Extract<ClearanceBlock, { kind: "stations" }>): string {
  const head = block.columnsAr.map((column) => `<th>${escapeHtml(column)}</th>`).join("");
  const body = block.rows
    .map(
      (row) => `<tr>
        <td class="num">${escapeHtml(row.number)}</td>
        <td class="dept">${escapeHtml(row.departmentAr)}</td>
        <td class="scope">${escapeHtml(row.scopeAr)}</td>
        <td class="tick">نعم ☐&nbsp; لا ☐</td>
        <td class="open"></td>
        <td class="open sign"></td>
      </tr>`,
    )
    .join("");
  return `<table class="stations"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function clausesBlock(block: Extract<ClearanceBlock, { kind: "clauses" }>): string {
  const rows = block.clauses
    .map(
      (clause) => `<div class="clause">
        <span class="clause__no">${escapeHtml(clause.number)}</span>
        <span class="clause__body">${escapeHtml(clause.body)}</span>
      </div>`,
    )
    .join("");
  return `<section class="clauses">${rows}</section>`;
}

function proseBlock(block: Extract<ClearanceBlock, { kind: "prose" }>): string {
  const paragraphs = block.paragraphs
    .map((paragraph) => `<p class="prose__p">${escapeHtml(paragraph)}</p>`)
    .join("");
  return `<section class="prose">${paragraphs}</section>`;
}

function renderBlock(
  block: ClearanceBlock,
  values: Partial<Record<ClearanceToken, string>>,
): string {
  const heading = block.headingAr ? `<h2 class="sec">${escapeHtml(block.headingAr)}</h2>` : "";
  if (block.kind === "fields") return heading + fieldsBlock(block.fields, values);
  if (block.kind === "stations") return heading + stationsBlock(block);
  if (block.kind === "clauses") return heading + clausesBlock(block);
  return heading + proseBlock(block);
}

function signatureBlock(template: ClearanceTemplate): string {
  const cells = template.signatureColumns
    .map(
      (column) => `<div class="sig">
        <p class="sig__head">${escapeHtml(column.headingAr)}</p>
        <div class="sig__body">
          <p class="sig__line">الاسم: <span class="rule-line">........................</span></p>
          <p class="sig__line">التوقيع: <span class="rule-line">......................</span></p>
          <p class="sig__line">التاريخ: <span class="rule-line">......................</span></p>
        </div>
      </div>`,
    )
    .join("");
  return `<section class="sigs">${cells}</section>`;
}

/** One printed copy. */
function renderCopy(
  template: ClearanceTemplate,
  values: Partial<Record<ClearanceToken, string>>,
): string {
  const registry = `${values.COMPANY_NAME ?? ""} — ${values.COMPANY_LEGAL_FORM ?? ""}`.trim();
  const registryLine = `السجل التجاري رقم ${values.COMMERCIAL_REGISTER ?? ""} (${
    values.COMMERCIAL_REGISTER_OFFICE ?? ""
  }) · الرقم الموحد ${values.UNIFIED_REGISTER ?? ""} · البطاقة الضريبية رقم ${values.TAX_CARD ?? ""}`;

  return `<article class="copy">
    <header class="masthead">
      <div class="masthead__title">
        <h1>${escapeHtml(template.titleAr)}</h1>
        <p>${escapeHtml(template.subtitleAr)}</p>
      </div>
      <div class="masthead__mark">
        <img src="/brand/sato-pharma-logo.png" alt="" width="401" height="158">
      </div>
    </header>
    <div class="rule"></div>
    <p class="keeper">${escapeHtml(template.keeperAr)}</p>

    <section class="recital">
      <p class="recital__name">${escapeHtml(registry)}</p>
      <p class="recital__line">${escapeHtml(registryLine)}</p>
      <p class="recital__line">المركز العام: ${escapeHtml(values.COMPANY_HEAD_OFFICE_FULL ?? "")}</p>
    </section>

    ${template.blocks.map((block) => renderBlock(block, values)).join("\n    ")}
    ${template.closingAr ? `<p class="closing">${escapeHtml(template.closingAr)}</p>` : ""}
    ${signatureBlock(template)}
  </article>`;
}

/**
 * The printable clearance form.
 *
 * `fallback` is the form the DOCUMENT asks for; `requestedTemplateId` is an explicit archived
 * version, which only the Archive screen passes. A version id belonging to the OTHER form is
 * ignored rather than obeyed — the two run in opposite directions, so obeying it would hand the
 * employee the paper that releases the company, or file the paper he was supposed to walk out with.
 * The print route validates the pair before this is reached, so falling back beats throwing.
 */
function renderClearance(
  data: HiringPackData,
  copies: number,
  requestedTemplateId: string | null | undefined,
  fallback: ClearanceTemplate,
): string {
  const requested = clearanceTemplateById(requestedTemplateId);
  const template = requested && requested.variant === fallback.variant ? requested : fallback;
  const values = buildClearanceValues(data);
  const total = Math.max(1, copies);
  const body = Array.from({ length: total }, () => renderCopy(template, values)).join("\n");
  const employeeName = data.employee.nameAr ?? data.employee.fullName;
  const keptBy = template.variant === "employeeKeeps" ? "the employee keeps it" : "the company files it";

  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(template.titleAr)} — ${escapeHtml(employeeName)}</title>
<style>
  @page { size: A4; margin: 10.7mm 10.2mm 12.7mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #e2e8f0; }
  body {
    font-family: ${ARABIC_FONT_STACK};
    color: #1a1a1a;
    font-size: 9pt;
    line-height: 1.5;
  }

  .copy {
    width: 210mm;
    min-height: 297mm;
    margin: 0 auto 8mm;
    padding: 10.7mm 10.2mm 12.7mm;
    background: #fff;
    box-shadow: 0 1px 3px rgba(15, 23, 42, 0.25);
  }
  .copy + .copy { page-break-before: always; break-before: page; }

  /* The house palette, the same navy, blue and zebra the contract and the custody receipt use —
     read off the source documents rather than chosen here (0B2A4A, 1B7FBF, F2F6FA, A8C6E2). */
  .masthead { display: flex; align-items: stretch; background: #0b2a4a; }
  .masthead__title { flex: 1 1 auto; padding: 3.5mm 5mm; text-align: center; }
  .masthead__title h1 { margin: 0; color: #fff; font-size: 16pt; font-weight: 700; }
  .masthead__title p { margin: 1.5mm 0 0; color: #a8c6e2; font-size: 8.5pt; font-weight: 600; }
  .masthead__mark {
    flex: 0 0 36mm;
    display: flex; align-items: center; justify-content: center;
    padding: 2mm 3mm;
  }
  /* NO WHITE PANEL BEHIND THE LOGO. The artwork is the on-dark variant and its "SATO" wordmark is
     WHITE, so on a white panel that half of the mark disappears and the masthead reads "PHARMA".
     It sits directly on the navy, exactly as the contract's does. */
  .masthead__mark img { width: 100%; max-width: 30mm; height: auto; }
  .rule { height: 1.6mm; background: #1b7fbf; }

  /* WHO KEEPS THIS COPY — the one line that stops the pair being confused, so it is given its own
     full-width band rather than a footnote. */
  .keeper {
    margin: 0; padding: 1.8mm 3mm;
    background: #1b7fbf; color: #fff;
    font-size: 8.5pt; font-weight: 700; text-align: center;
  }

  .recital { padding: 2.5mm 3mm; background: #f2f6fa; text-align: center; }
  .recital__name { margin: 0; color: #0b2a4a; font-size: 10pt; font-weight: 700; }
  .recital__line { margin: 0.8mm 0 0; color: #5a6b7c; font-size: 7.5pt; }

  .sec {
    margin: 3.5mm 0 0; padding: 1.5mm 3mm;
    background: #0b2a4a; color: #fff;
    font-size: 9.5pt; font-weight: 700;
  }

  .grid2 { display: flex; flex-wrap: wrap; border: 0.3mm solid #c9d8e8; border-top: 0; }
  .cell {
    flex: 1 1 50%; min-width: 50%; max-width: 50%;
    display: flex; gap: 2mm; align-items: baseline;
    padding: 1.8mm 2.5mm;
    border-top: 0.3mm solid #e3ecf5;
  }
  .cell--wide { flex-basis: 100%; min-width: 100%; max-width: 100%; }
  .cell__label { flex: 0 0 auto; color: #5a6b7c; font-size: 8pt; white-space: nowrap; }
  .cell__value { flex: 1 1 auto; }
  .val { font-weight: 700; color: #0b2a4a; }
  .rule-line { color: #91a4b7; letter-spacing: 0.2mm; }
  .fixed { font-size: 8pt; }

  .stations { width: 100%; border-collapse: collapse; font-size: 8pt; }
  .stations th {
    padding: 1.5mm 1mm; background: #f2f6fa; color: #0b2a4a;
    border: 0.3mm solid #c9d8e8; font-weight: 700; text-align: center;
  }
  .stations td { padding: 2.4mm 1.5mm; border: 0.3mm solid #c9d8e8; }
  .stations .num { width: 7mm; text-align: center; color: #5a6b7c; }
  .stations .dept { width: 30mm; font-weight: 700; color: #0b2a4a; }
  .stations .scope { color: #34485c; }
  .stations .tick { width: 24mm; text-align: center; white-space: nowrap; }
  .stations .open { width: 22mm; }
  .stations .sign { width: 34mm; }

  .prose { padding: 2.5mm 3mm; border: 0.3mm solid #c9d8e8; border-top: 0; }
  .prose__p { margin: 0 0 1.8mm; text-align: justify; line-height: 1.6; }
  .prose__p:last-child { margin-bottom: 0; }

  .clauses { border: 0.3mm solid #c9d8e8; border-top: 0; }
  .clause { display: flex; gap: 2mm; padding: 2mm 3mm; border-top: 0.3mm solid #e3ecf5; }
  .clause:first-child { border-top: 0; }
  .clause__no { flex: 0 0 auto; color: #1b7fbf; font-weight: 700; }
  .clause__body { flex: 1 1 auto; text-align: justify; }
  .closing { margin: 3mm 0 0; font-weight: 700; color: #0b2a4a; }

  .sigs { display: flex; gap: 3mm; margin-top: 4mm; }
  .sig { flex: 1 1 0; border: 0.3mm solid #c9d8e8; }
  .sig__head {
    margin: 0; padding: 1.6mm 2mm;
    background: #0b2a4a; color: #fff; font-size: 8pt; font-weight: 700; text-align: center;
  }
  .sig__body { padding: 2.5mm; background: #f2f6fa; }
  .sig__line { margin: 0 0 2mm; font-size: 8pt; }
  .sig__line:last-child { margin-bottom: 0; }

  /* A clause, a signature column, a labelled box or a departmental row must not split across two
     sheets — half a sign-off row at a page break is a row somebody skips. */
  .clause, .sig, .cell, .stations tr, .prose__p { page-break-inside: avoid; break-inside: avoid; }

  @media print {
    html, body { background: #fff; }
    .copy { width: auto; min-height: 0; margin: 0; padding: 0; box-shadow: none; }
  }
${PRINT_BANNER_CSS}
</style>
</head>
<body>
${printBanner([
  `${employeeName} — ${template.titleAr}: ${keptBy}. ${total} ${total === 1 ? "copy" : "copies"}.`,
  "Turn ON “Background graphics” — the title panel, the keeper strip and the table rules are part of the document.",
  template.variant === "employeeKeeps"
    ? "Every departmental sign-off is signed by hand — the paper is not valid until all of them are on it and the company stamp is applied."
    : "The settlement amount prints blank by design, in figures and in words. It is a release of claims: the figure has to be the one finance actually paid.",
])}
${body}
</body>
</html>`;
}

/** إخلاء طرف موظف — the company certifies him clear, and he takes it with him. */
export function renderClearanceEmployeeHtml(
  data: HiringPackData,
  copies: number,
  templateId?: string | null,
): string {
  return renderClearance(data, copies, templateId, CLEARANCE_EMPLOYEE_V1);
}

/** إخلاء طرف شركة — he releases the company, and the company files it. */
export function renderClearanceCompanyHtml(
  data: HiringPackData,
  copies: number,
  templateId?: string | null,
): string {
  return renderClearance(data, copies, templateId, CLEARANCE_COMPANY_V1);
}
