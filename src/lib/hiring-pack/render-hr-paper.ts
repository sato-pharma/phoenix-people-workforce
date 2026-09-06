import { systemLegalEntity } from "@/config/system-settings";
import { flowFieldLayer, type DocumentFieldRow } from "@/lib/hiring-pack/field-layout";
import { HOUSE_COLORS, HOUSE_MARK_SRC } from "@/lib/hiring-pack/house-identity";
import {
  HR_PAPER_BLANK_RULE,
  HR_PAPER_BLANK_RULE_WIDE,
  hrPaperTemplateTokens,
  type HrPaperField,
  type HrPaperSignatureColumn,
  type HrPaperTemplate,
  type HrPaperToken,
} from "@/lib/hiring-pack/hr-paper-template";
import { hrPaperById } from "@/lib/hiring-pack/hr-paper-text";
import { resolveNationality } from "@/lib/hiring-pack/nationality";
import { resolveServicePeriod } from "@/lib/hiring-pack/service-period";
import {
  ARABIC_FONT_STACK,
  arabicDayName,
  describeServiceDuration,
  escapeHtml,
  formatDayMonthYear,
  pinLtr,
  PRINT_BANNER_CSS,
  printBanner,
  resolvePermanentAddress,
  todayInCairo,
} from "@/lib/hiring-pack/render-shared";
import type { HiringPackData } from "@/lib/hiring-pack/types";

// Sato's own HR papers — the confidentiality undertaking, the two appointment-documents forms, the
// two absence notices, the service-file sheet and the certificate of experience.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE CONTRACT'S `document` LAYOUT AGAIN, and for the third time deliberately. These papers live in
// the same folder as the contract and the renewal annex and are read next to them; a reader turning
// from one to another must not be able to tell that different code drew them.
//
// `render-contract.ts` keeps its own private copy of this stylesheet and MUST keep it: an archived
// contract version has to reproduce byte-identically forever, so it cannot share a stylesheet with
// papers that are still being designed. `render-renewal.ts` has the second copy. This is the third
// and last — if a fourth is ever wanted, extract the shared block into `house-identity.ts` FIRST and
// leave only the contract on its own.
//
// WHAT IS FILLED AND WHAT IS RULED. Phoenix answers what it holds a record of and rules the rest,
// the same principle the custody receipt established. Three things rule on purpose:
//   · every CHECKLIST verdict box — there is no register of which certificates were handed over, and
//     a ticked box on a signed form asserts that a document was seen;
//   · the DEPENDANTS table — the insurance file is a different set of people for a different purpose;
//   · the ABSENCE DATES on both warnings — attendance is not resolved here, and a wrong date on a
//     notice that ends somebody's service is the one error on these pages that cannot be walked back.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Every blank any of these papers can fill, resolved once. */
export function buildHrPaperValues(
  data: HiringPackData,
): Partial<Record<HrPaperToken, string>> {
  const { employee, profile, terms } = data;
  const recital = systemLegalEntity.contractRecital;
  const today = todayInCairo();

  // THE CERTIFICATE'S PERIOD OF SERVICE. Resolved in `service-period.ts` rather than here, because
  // the ENGLISH certificate states the same period and the two must never be able to disagree about
  // one employment — see that module for why it reads the departure flag and not the presence of a
  // date, which is the whole safety property of both papers.
  const service = resolveServicePeriod(data, today);
  const serviceEnd = service.departed
    ? pinLtr(formatDayMonthYear(service.endsOn))
    : // Not a date, on purpose: a certificate for somebody still serving closes the period with the
      // day it was issued, and the sentence below says in words that he has not left.
      "تاريخه";

  return {
    ISSUE_DATE: pinLtr(formatDayMonthYear(today)),
    ISSUE_DAY_NAME: arabicDayName(today),

    COMPANY_NAME: systemLegalEntity.legalNameAr,
    COMPANY_LEGAL_FORM: recital.legalFormAr,
    COMPANY_HEAD_OFFICE_FULL: recital.headOfficeAr,
    COMPANY_CITY: systemLegalEntity.contractCityAr,
    COMMERCIAL_REGISTER: pinLtr(recital.commercialRegisterNumber),
    COMMERCIAL_REGISTER_OFFICE: recital.commercialRegisterOfficeAr,
    UNIFIED_REGISTER: pinLtr(recital.unifiedRegisterNumber),
    TAX_CARD: pinLtr(recital.taxCardNumber),
    // The establishment's own insurance registration. Phoenix does not hold it — it belongs to the
    // insurance file rather than to any table here — so it rules on the service-file sheet.
    CONTRACT_SIGNATORY: profile.contractSignatoryNameAr ?? recital.signatoryNameAr,
    CONTRACT_SIGNATORY_TITLE: profile.contractSignatoryTitleAr ?? recital.signatoryTitleAr,

    // The Arabic name governs, as on every other Arabic instrument this module prints.
    EMPLOYEE_NAME: employee.nameAr ?? employee.fullName,
    HR_ID: employee.hrId,
    NATIONAL_ID: employee.nationalId ?? "",
    INSURANCE_NUMBER: employee.socialInsuranceNumber ?? "",
    // ARABIC ONLY — no fallback to the English title off the employee record. Owner, 2026-08-31.
    JOB_TITLE: profile.jobTitleAr ?? "",
    DEPARTMENT: employee.departmentAr ?? "",
    ADDRESS: resolvePermanentAddress({
      addressBuilding: profile.addressBuilding,
      addressStreet: profile.addressStreet,
      residenceAddress: employee.residenceAddress,
      residenceCity: employee.residenceCity,
    }),
    PHONE: employee.mobileNumber ?? "",
    EMAIL: employee.workEmail ?? "",
    NATIONALITY: resolveNationality(profile.nationality, employee).value,
    // RELIGION, MILITARY_STATUS and MARITAL_STATUS are deliberately absent. The service-file sheet
    // asks for them and this system holds none of the three: they are not on `employees`, they are
    // not on the hiring profile, and inventing them on a sheet the employee signs as true would be
    // the one thing this module never does. They rule, and he completes them.
    GENDER: arabicGender(employee.gender),
    BIRTH_DATE: pinLtr(formatDayMonthYear(employee.birthDate)),
    BIRTH_PLACE: profile.birthPlace ?? "",
    QUALIFICATION: profile.qualification ?? "",

    HIRE_DATE: pinLtr(formatDayMonthYear(employee.hireDate)),
    CONTRACT_DATE: pinLtr(formatDayMonthYear(terms.contractStartDate ?? employee.hireDate)),
    LAST_WORKING_DATE: pinLtr(formatDayMonthYear(terms.lastWorkingDate)),

    // The certificate of experience. See `service-period.ts` for why these read the departure flag
    // rather than the presence of a date.
    SERVICE_END: serviceEnd,
    SERVICE_STATUS: service.departed
      ? "وقد انتهت خدمته لدى الشركة بنهاية المدة المبيّنة عاليه."
      : "ولا يزال على رأس العمل لدى الشركة حتى تاريخ صدور هذه الشهادة.",
    // Blank — and so a dotted rule on the page — when either end is missing, which for a leaver
    // means no last-working date was ever recorded. A span the company cannot count is one a human
    // writes in, not one this file guesses.
    SERVICE_DURATION: describeServiceDuration(service.startsOn, service.endsOn),

    // ABSENCE_FROM / ABSENCE_TO / FIRST_WARNING_* are absent on purpose — see the header note.
    // COMPLETION_DEADLINE likewise: it is a date the desk sets when it hands the checklist over.
  };
}

/**
 * ذكر / أنثى from whatever `employees.gender` holds, or nothing.
 *
 * Nothing rather than a guess: the sheet is signed as true by the person it describes, and this is
 * the one field on it where being wrong is both obvious and insulting.
 */
function arabicGender(gender: string | null): string {
  const value = (gender ?? "").trim().toLowerCase();
  if (value === "male") return "ذكر";
  if (value === "female") return "أنثى";
  return "";
}

/** A value that IS there, marked so the preview screen can offer it for correction. */
function filledMarker(token: string, text: string): string {
  return `<span class="fill" data-hp-key="${escapeHtml(token)}">${escapeHtml(text)}</span>`;
}

/** A value that is NOT there: a run of dots carrying its token, so the fill screen can see it. */
function blankMarker(token: string, rule: string): string {
  return `<span class="rule-line" data-hp-key="${escapeHtml(token)}">${escapeHtml(rule)}</span>`;
}

/** Substitute the blanks in a run of prose, marking each one. */
function fillMarkedHtml(
  template: string,
  values: Partial<Record<HrPaperToken, string>>,
): string {
  const pattern = /\{\{([A-Z_]+)\}\}/g;
  let out = "";
  let last = 0;
  let match: RegExpExecArray | null = pattern.exec(template);
  while (match !== null) {
    out += escapeHtml(template.slice(last, match.index));
    const token = match[1];
    const raw = values[token as HrPaperToken];
    const text = typeof raw === "string" ? raw.trim() : "";
    out += text.length > 0 ? filledMarker(token, text) : blankMarker(token, HR_PAPER_BLANK_RULE);
    last = match.index + match[0].length;
    match = pattern.exec(template);
  }
  return out + escapeHtml(template.slice(last));
}

/**
 * One grid value, in the direction its CONTENT needs.
 *
 * `dir="ltr"` per field and never on the block: a line holding an Arabic label and a Latin value
 * would otherwise turn wholly one way and render the other half backwards. This company has already
 * printed its own tax card `477-108-318` as `318-108-477`.
 */
function gridValue(
  field: HrPaperField,
  values: Partial<Record<HrPaperToken, string>>,
): string {
  const raw = field.token ? values[field.token] : undefined;
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text.length === 0) {
    const rule = field.wide ? HR_PAPER_BLANK_RULE_WIDE : HR_PAPER_BLANK_RULE;
    return field.token
      ? blankMarker(field.token, rule)
      : `<span class="rule-line">${escapeHtml(rule)}</span>`;
  }
  const marked = filledMarker(field.token as string, text);
  return field.ltr ? `<span dir="ltr">${marked}</span>` : marked;
}

/** A labelled grid, two pairs to a row, a wide field taking the whole row. */
function grid(
  fields: readonly HrPaperField[],
  values: Partial<Record<HrPaperToken, string>>,
): string {
  if (fields.length === 0) return "";
  const rows: string[] = [];
  let pending: string[] = [];

  const flush = () => {
    if (pending.length === 0) return;
    // A lone narrow field still fills its row, or the table draws a ragged edge that reads as a
    // missing box rather than as an empty half-row.
    const cells =
      pending.length === 1
        ? pending[0].replace(
            '<td class="doc-ident__value">',
            '<td class="doc-ident__value" colspan="3">',
          )
        : pending.join("");
    rows.push(`<tr>${cells}</tr>`);
    pending = [];
  };

  for (const field of fields) {
    if (field.wide) {
      flush();
      rows.push(
        `<tr><th class="doc-ident__label">${escapeHtml(field.labelAr)}</th>` +
          `<td class="doc-ident__value" colspan="3">${gridValue(field, values)}</td></tr>`,
      );
      continue;
    }
    pending.push(
      `<th class="doc-ident__label">${escapeHtml(field.labelAr)}</th>` +
        `<td class="doc-ident__value">${gridValue(field, values)}</td>`,
    );
    if (pending.length === 2) flush();
  }
  flush();

  return `<table class="doc-ident"><tbody>${rows.join("")}</tbody></table>`;
}

/** The checklist — rows down the side, empty verdict boxes across. */
function checklistTable(
  template: HrPaperTemplate,
  values: Partial<Record<HrPaperToken, string>>,
): string {
  const list = template.checklist;
  if (!list) return "";
  const head =
    `<th class="doc-list__no">م</th><th class="doc-list__item">${escapeHtml(list.itemHeadingAr)}</th>` +
    list.columnsAr.map((column) => `<th>${escapeHtml(column)}</th>`).join("");
  const body = list.rows
    .map(
      (row) =>
        `<tr><td class="doc-list__no">${escapeHtml(row.number)}</td>` +
        `<td class="doc-list__item">${escapeHtml(row.labelAr)}</td>` +
        list.columnsAr.map(() => `<td class="doc-list__box"></td>`).join("") +
        "</tr>",
    )
    .join("");
  const note = list.footNoteAr
    ? `<p class="doc-note">${fillMarkedHtml(list.footNoteAr, values)}</p>`
    : "";
  return `<h2 class="doc-head">${escapeHtml(list.headingAr)}</h2>
    <table class="doc-list"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${note}`;
}

/** An empty table the signer fills by hand. */
function openTable(template: HrPaperTemplate): string {
  const table = template.openTable;
  if (!table) return "";
  const head = table.columnsAr.map((column) => `<th>${escapeHtml(column)}</th>`).join("");
  const body = Array.from(
    { length: table.rows },
    (unused, index) =>
      `<tr><td class="doc-list__no">${index + 1}</td>` +
      table.columnsAr
        .slice(1)
        .map(() => `<td class="doc-list__box doc-list__box--tall"></td>`)
        .join("") +
      "</tr>",
  ).join("");
  return `<h2 class="doc-head">${escapeHtml(table.headingAr)}</h2>
    <table class="doc-list"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/** The signature block: one ruled row per party, one column per signing field. */
function signatureTable(columns: readonly HrPaperSignatureColumn[]): string {
  const first = columns[0];
  if (!first) return "";
  const head = first.fieldsAr
    .map((label) => `<th class="doc-sig__head">${escapeHtml(label)}</th>`)
    .join("");
  const body = columns
    .map(
      (column) =>
        `<tr><th class="doc-sig__party">${escapeHtml(column.headingAr)}</th>` +
        column.fieldsAr.map(() => `<td class="doc-sig__cell"></td>`).join("") +
        "</tr>",
    )
    .join("");
  return `<table class="doc-sig">
      <thead><tr><td class="doc-sig__corner"></td>${head}</tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

/** The refusal-to-sign protocol, on a paper that is served rather than agreed. */
function serviceBlock(template: HrPaperTemplate): string {
  if (!template.serviceNoteAr && template.serviceFields.length === 0) return "";
  const note = template.serviceNoteAr
    ? `<p class="doc-witness__note">${escapeHtml(template.serviceNoteAr)}</p>`
    : "";
  const cells = template.serviceFields
    .map(
      (field) =>
        `<div class="doc-witness__cell"><span class="doc-witness__label">${escapeHtml(
          field.labelAr,
        )}</span><span class="rule-line">${escapeHtml(HR_PAPER_BLANK_RULE)}</span></div>`,
    )
    .join("");
  return `<section class="doc-witness">${note}<div class="doc-witness__grid">${cells}</div></section>`;
}

/** One printed copy. */
function renderCopy(
  template: HrPaperTemplate,
  values: Partial<Record<HrPaperToken, string>>,
): string {
  const heading = (text: string | null) =>
    text ? `<h2 class="doc-head">${escapeHtml(text)}</h2>` : "";

  const binding = template.bindingLineAr
    ? `<p class="doc-binding">${fillMarkedHtml(template.bindingLineAr, values)}</p>`
    : "";

  const recital = template.firstPartyLinesAr
    .map((text) => `<p class="doc-recital">${fillMarkedHtml(text, values)}</p>`)
    .join("");

  const paragraphs = template.bodyParagraphsAr
    .map((text) => `<p class="doc-para">${fillMarkedHtml(text, values)}</p>`)
    .join("");

  // The operative half of a notice, set apart. On a paper that ends somebody's service the sentence
  // that does the ending must not read as one more paragraph among several.
  const operative = template.operativeParagraphsAr.length
    ? `<section class="doc-operative">
        ${template.operativeHeadingAr ? `<p class="doc-operative__head">${escapeHtml(template.operativeHeadingAr)}</p>` : ""}
        ${template.operativeParagraphsAr
          .map((text) => `<p class="doc-para">${fillMarkedHtml(text, values)}</p>`)
          .join("")}
      </section>`
    : "";

  const sections = template.sections
    .map((section) => `${heading(section.headingAr)}${grid(section.fields, values)}`)
    .join("");

  const declaration = template.declarationAr
    ? `<p class="doc-declaration">${fillMarkedHtml(template.declarationAr, values)}</p>`
    : "";

  const signNote = template.signatoryNoteLinesAr.length
    ? `<p class="doc-signnote">${template.signatoryNoteLinesAr
        .map((text) => `<span>${fillMarkedHtml(text, values)}</span>`)
        .join("")}</p>`
    : "";

  // Never token-filled: the line exists to be signed by hand, and marking it would flag a pen rule
  // as a blank Phoenix ought to have filled.
  const receipt = template.receiptAcknowledgmentAr
    ? `<p class="doc-receipt">${escapeHtml(template.receiptAcknowledgmentAr)} <span class="rule-line">${escapeHtml(
        HR_PAPER_BLANK_RULE_WIDE,
      )}</span></p>`
    : "";

  const foot = `<tfoot><tr><td class="doc-foot"><div class="doc-foot__row">${template.footerAr
    .split(/ {2,}/u)
    .map((part) => `<span>${escapeHtml(part)}</span>`)
    .join("")}</div></td></tr></tfoot>`;

  return `<article class="copy copy--document copy--${template.kind}">
    <table class="doc-sheet">
      <thead><tr><td class="doc-mastcell">
        <header class="doc-mast">
          <span class="doc-mast__side doc-mast__id">
            <strong>${escapeHtml(systemLegalEntity.legalNameAr)}</strong>
            <span dir="ltr">${escapeHtml(systemLegalEntity.legalNameEn)}</span>
          </span>
          <span class="doc-mast__title">
            <strong>${escapeHtml(template.titleAr)}</strong>
            <em>${escapeHtml(template.subtitleAr)}</em>
          </span>
          <span class="doc-mast__side doc-mast__mark">
            <img src="${HOUSE_MARK_SRC}" alt="" width="401" height="158">
          </span>
        </header>
        <p class="doc-purpose">${escapeHtml(template.purposeAr)}</p>
      </td></tr></thead>
      <tbody><tr><td class="doc-body">
        ${binding}
        ${heading(template.firstPartyHeadingAr)}
        ${recital}
        ${heading(template.secondPartyHeadingAr)}
        ${grid(template.secondPartyFields, values)}
        ${sections}
        ${paragraphs}
        ${operative}
        ${checklistTable(template, values)}
        ${openTable(template)}
        ${declaration}
        ${heading(template.signaturesHeadingAr)}
        ${signatureTable(template.signatureColumns)}
        ${signNote}
        ${receipt}
        ${serviceBlock(template)}
      </td></tr></tbody>
      ${foot}
    </table>
  </article>`;
}

/**
 * The printable paper.
 *
 * `fallback` is the paper asked for; `requestedTemplateId` is an explicit archived version, which
 * only the Archive screen ever passes. A requested id is honoured only when it is a version of the
 * SAME paper — asking for the NDA and receiving the absence warning would be a caller error with a
 * signature page attached. Falling back rather than throwing is deliberate: the print route has
 * already validated the id, so anything reaching here is known-good and a stack trace would only
 * lose somebody their document.
 */
export function renderHrPaperHtml(
  data: HiringPackData,
  copies: number,
  fallback: HrPaperTemplate,
  requestedTemplateId?: string | null,
  fields: readonly DocumentFieldRow[] = [],
): string {
  const requested = hrPaperById(requestedTemplateId);
  const template = requested && requested.kind === fallback.kind ? requested : fallback;
  const values = buildHrPaperValues(data);
  const total = Math.max(1, copies);
  const body = Array.from({ length: total }, () => renderCopy(template, values)).join("\n");
  const employeeName = data.employee.nameAr ?? data.employee.fullName;

  const banner = [
    `${employeeName} — ${template.titleAr}, ${total} ${total === 1 ? "copy" : "copies"}.`,
  ];
  if (template.checklist) {
    banner.push(
      "Every verdict box prints blank by design — Phoenix holds no register of which certificates were handed over, and a ticked box on a signed form asserts that a document was seen.",
    );
  }
  if (template.openTable) {
    banner.push(
      "The dependants table prints blank: the insurance file is a different set of people for a different purpose. The employee completes it and signs that it is true.",
    );
  }
  // KEYED ON THE TOKENS, NOT ON THE KIND. It read `kind === "letter"` while both letters happened to
  // be absence notices; the next letter that is not one would have carried a warning about dates it
  // does not print, and a warning that does not apply is one a reader learns to skip past.
  if (hrPaperTemplateTokens(template).includes("ABSENCE_FROM")) {
    banner.push(
      "The absence dates print blank. Attendance is not resolved here, and a wrong date on a notice that ends somebody's service is the one error on this page that cannot be walked back.",
    );
  }
  if (template.kind === "certificate") {
    banner.push(
      data.employee.departed
        ? "It states that his service ENDED. Check the last working day above before it leaves the desk — this paper goes to his next employer."
        : "It states that he is STILL EMPLOYED here, and closes the period at today's date. That is read from his employee record, not from the exit form.",
    );
    banner.push(
      "No salary, no reason for leaving, and no statement of conduct — each left out on purpose, not pending. A recommendation is written and signed by a person, never printed from a button.",
    );
  }

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
  /* 🔴 KEEP THE ZEBRA BANDS WHEN A BROWSER PRINTS. Chrome's print dialog ships with "Background
     graphics" UNTICKED, and every tint on these papers is a CSS background — so Print produced a
     black-and-white page while the preview beside it was blue. The saved PDF was never affected
     (paper-pdf.ts passes printBackground: true), which is why the two paths agreed on screen and
     disagreed on paper. These papers keep their own stylesheet rather than importing
     HOUSE_IDENTITY_CSS, so the line has to be here as well as there.

     NO BACKTICKS IN THIS COMMENT — it is inside a template literal and one would close the string. */
  html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    font-family: ${ARABIC_FONT_STACK};
    color: #111;
    font-size: 9pt;
    line-height: 1.4;
  }

  .copy {
    width: 210mm;
    min-height: 297mm;
    margin: 0 auto 8mm;
    background: #fff;
    box-shadow: 0 1px 3px rgba(15, 23, 42, 0.25);
  }
  .copy + .copy { page-break-before: always; break-before: page; }

  /* ── the contract's own document layout ───────────────────────────────────────────────────────
     Two blues and one hairline grey; nothing else is coloured. Everything separating one part from
     another is a RULE, so these print correctly whether or not "Background graphics" is ticked. The
     one filled element is the zebra on a grid — the owner's single stated exception to the ink rule.
     Every corner is square, per the rule of 2026-09-04, and the test greps the emitted CSS for the
     property name — so do not write that name here even to say it is absent.
     NO BACKTICKS IN THIS BLOCK — it is inside a template literal, and one ends the string. */
  .copy--document { padding: 10.7mm 10.2mm 12.7mm; }
  .doc-sheet { width: 100%; border-collapse: collapse; }
  .doc-mastcell, .doc-body { padding: 0; vertical-align: top; }

  .doc-mast {
    display: flex;
    align-items: center;
    gap: 4mm;
    margin-bottom: 2.5mm;
    padding-bottom: 1.5mm;
    border-bottom: 0.7mm solid ${HOUSE_COLORS.blue};
  }
  .doc-mast__side { flex: 0 0 34mm; }
  .doc-mast__id { text-align: right; color: ${HOUSE_COLORS.muted}; font-size: 6.5pt; line-height: 1.5; }
  .doc-mast__id strong { display: block; color: ${HOUSE_COLORS.deep}; font-size: 8pt; font-weight: 700; }
  .doc-mast__mark { display: flex; justify-content: flex-start; }
  .doc-mast__mark img { width: 100%; max-width: 30mm; height: auto; }
  .doc-mast__title { flex: 1 1 auto; text-align: center; }
  .doc-mast__title strong { display: block; color: ${HOUSE_COLORS.deep}; font-size: 12.5pt; font-weight: 700; line-height: 1.25; }
  .doc-mast__title em {
    display: block;
    margin-top: 1mm;
    color: #5b6b7a;
    font-size: 8pt;
    font-style: normal;
    font-weight: 600;
  }

  .doc-purpose {
    margin: 0 0 2.5mm;
    padding: 1.4mm 0;
    border-top: 0.5pt solid ${HOUSE_COLORS.hair};
    border-bottom: 0.5pt solid ${HOUSE_COLORS.hair};
    color: ${HOUSE_COLORS.deep};
    font-size: 8pt;
    font-weight: 700;
    text-align: center;
  }

  .doc-foot { padding: 2.5mm 0 0; border-top: 0.6pt solid #b9cad9; font-size: 8pt; }
  .doc-foot__row { display: flex; justify-content: space-between; color: #33414f; }

  .doc-head {
    margin: 3mm 0 1.2mm;
    padding-bottom: 0.8mm;
    border-bottom: 0.8pt solid ${HOUSE_COLORS.blue};
    color: ${HOUSE_COLORS.deep};
    font-size: 10.5pt;
    font-weight: 700;
  }
  .doc-body > .doc-head:first-child { margin-top: 0; }

  .doc-binding {
    margin: 0 0 2mm;
    padding: 1.6mm 2.5mm;
    border: 0.5pt solid ${HOUSE_COLORS.light};
    color: ${HOUSE_COLORS.deep};
    font-weight: 700;
    text-align: center;
  }

  .doc-recital { margin: 0; text-align: justify; orphans: 3; widows: 3; }
  .doc-para { margin: 0 0 2mm; text-align: justify; orphans: 3; widows: 3; }
  .doc-para:last-child { margin-bottom: 0; }

  /* The operative half of a notice. Ruled top and bottom rather than filled — it has to be found at
     a glance on a page somebody is reading in a hurry, and it costs no toner to say so. */
  .doc-operative {
    margin: 3mm 0;
    padding: 2mm 0;
    border-top: 0.5pt solid ${HOUSE_COLORS.hair};
    border-bottom: 0.5pt solid ${HOUSE_COLORS.hair};
    break-inside: avoid;
    page-break-inside: avoid;
  }
  .doc-operative__head {
    margin: 0 0 1.5mm;
    color: ${HOUSE_COLORS.deep};
    font-size: 10pt;
    font-weight: 700;
    text-align: center;
    letter-spacing: 0.4mm;
  }

  .doc-ident { width: 100%; margin-top: 0.5mm; border-collapse: collapse; table-layout: fixed; }
  .doc-ident th, .doc-ident td {
    padding: 1.1mm 2mm;
    border: 0.5pt solid #cfdce7;
    font-size: 8.5pt;
    text-align: right;
    vertical-align: middle;
  }
  .doc-ident__label { width: 34mm; color: ${HOUSE_COLORS.deep}; font-weight: 700; }
  .doc-ident tbody tr:nth-child(even) th,
  .doc-ident tbody tr:nth-child(even) td { background: ${HOUSE_COLORS.tint}; }

  .doc-list { width: 100%; margin-top: 0.5mm; border-collapse: collapse; table-layout: fixed; }
  .doc-list th, .doc-list td {
    padding: 1.2mm 2mm;
    border: 0.5pt solid #cfdce7;
    font-size: 8.5pt;
    text-align: center;
    vertical-align: middle;
  }
  .doc-list thead th { color: ${HOUSE_COLORS.deep}; font-weight: 700; }
  .doc-list__no { width: 10mm; color: ${HOUSE_COLORS.muted}; }
  .doc-list__item { text-align: right; }
  /* The verdict box IS the blank. Nothing is printed inside it — see the header note. */
  .doc-list__box { height: 6mm; }
  .doc-list__box--tall { height: 8mm; }
  .doc-list tbody tr:nth-child(even) td { background: ${HOUSE_COLORS.tint}; }
  .doc-list tr { break-inside: avoid; page-break-inside: avoid; }

  .doc-note { margin: 1.5mm 0 0; color: ${HOUSE_COLORS.muted}; font-size: 8pt; text-align: justify; }
  .doc-declaration { margin: 3mm 0 2mm; text-align: justify; font-weight: 700; }

  .doc-sig {
    width: 100%;
    margin-top: 0.5mm;
    border-collapse: collapse;
    table-layout: fixed;
    break-inside: avoid;
    page-break-inside: avoid;
  }
  .doc-sig th, .doc-sig td { padding: 1.2mm 2mm; border: 0.5pt solid #b9cad9; font-size: 8.5pt; }
  .doc-sig__corner { width: 40mm; }
  .doc-sig__head { color: ${HOUSE_COLORS.deep}; font-weight: 700; text-align: center; }
  .doc-sig__party { font-weight: 700; text-align: right; vertical-align: middle; color: ${HOUSE_COLORS.deep}; }
  .doc-sig tbody tr:nth-child(even) th,
  .doc-sig tbody tr:nth-child(even) td { background: ${HOUSE_COLORS.tint}; }
  .doc-sig__cell { height: 12mm; text-align: center; vertical-align: top; }

  .doc-signnote {
    display: flex;
    flex-wrap: wrap;
    gap: 0 8mm;
    margin: 1.8mm 0 0;
    font-size: 8.5pt;
    line-height: 1.5;
    color: #33414f;
    break-inside: avoid;
    page-break-inside: avoid;
  }
  .doc-receipt { margin: 2.5mm 0 0; break-inside: avoid; page-break-inside: avoid; }

  .doc-witness { margin-top: 3mm; break-inside: avoid; page-break-inside: avoid; }
  .doc-witness__note {
    margin: 0 0 1.5mm;
    padding-top: 1.5mm;
    border-top: 0.5pt solid ${HOUSE_COLORS.hair};
    color: ${HOUSE_COLORS.muted};
    font-size: 8pt;
    text-align: justify;
  }
  .doc-witness__grid { display: flex; flex-wrap: wrap; }
  .doc-witness__cell {
    flex: 1 1 50%;
    min-width: 50%;
    max-width: 50%;
    display: flex;
    gap: 2mm;
    align-items: baseline;
    padding: 1.4mm 2mm;
    border: 0.5pt solid #cfdce7;
    border-top: 0;
    font-size: 8.5pt;
  }
  .doc-witness__cell:nth-child(-n + 2) { border-top: 0.5pt solid #cfdce7; }
  .doc-witness__label { flex: 0 0 auto; color: ${HOUSE_COLORS.deep}; font-weight: 700; white-space: nowrap; }

  .fill { padding: 0; background: none; color: inherit; font-weight: 700; }
  .rule-line { color: #91a4b7; letter-spacing: 0.2mm; }

  /* THE SERVICE-FILE SHEET IS ONE SHEET, and that is worth two millimetres of padding. It carries
     eighteen labelled fields, a six-row dependants table and a signature block; at the shared
     metrics it spilled its signatures onto a second page that was otherwise blank — a wasted sheet
     on a form printed for every hire, and a signature block detached from the declaration it is
     signing. Nothing here changes what the sheet SAYS; the row count and every label are untouched. */
  .copy--dataSheet .doc-ident th,
  .copy--dataSheet .doc-ident td { padding: 0.8mm 2mm; }
  .copy--dataSheet .doc-list th,
  .copy--dataSheet .doc-list td { padding: 0.9mm 2mm; }
  .copy--dataSheet .doc-list__box--tall { height: 6.5mm; }
  .copy--dataSheet .doc-head { margin: 2.2mm 0 1mm; }
  .copy--dataSheet .doc-declaration { margin: 2.2mm 0 1.5mm; }
  /* A pen needs less room here than on an instrument: this block is initialled at a desk, not
     signed and stamped at a table. */
  .copy--dataSheet .doc-sig__cell { height: 9mm; }
  .copy--dataSheet .doc-mast { margin-bottom: 1.8mm; padding-bottom: 1.2mm; }
  /* The purpose band is dropped on this one paper because its own footer already says the same
     thing — "تُحفظ بملف خدمة العامل" — and repeating it costs a band this page cannot spare. */
  .copy--dataSheet .doc-purpose { display: none; }

  @media print {
    html, body { background: #fff; }
    .copy { width: auto; min-height: 0; margin: 0; box-shadow: none; }
  }
${PRINT_BANNER_CSS}
</style>
</head>
<body>
${printBanner(banner)}
${body}
${flowFieldLayer(fields, values)}
</body>
</html>`;
}
