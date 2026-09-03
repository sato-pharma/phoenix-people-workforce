import { systemLegalEntity } from "@/config/system-settings";
import { flowFieldLayer, type DocumentFieldRow } from "@/lib/hiring-pack/field-layout";
import {
  ARABIC_FONT_STACK,
  escapeHtml,
  formatDayMonthYear,
  pinLtr,
  PRINT_BANNER_CSS,
  printBanner,
  resolvePermanentAddress,
} from "@/lib/hiring-pack/render-shared";
import type { HiringPackData } from "@/lib/hiring-pack/types";
import { resolveNationality } from "@/lib/hiring-pack/nationality";
import {
  WORKER_FORM_BLANK_RULE,
  WORKER_FORM_TEMPLATE_V1,
  type WorkerFormField,
  type WorkerFormSection,
  type WorkerFormTemplate,
  type WorkerFormToken,
} from "@/lib/hiring-pack/worker-form-text";

// The worker-data form (استمارة بيانات العامل), laid out for A4 and printed by the browser.
//
// SAME PLUMBING AS THE CONTRACT, DIFFERENT SHAPE. It is HTML printed by the browser for the same
// reason (`render-shared.ts`): Arabic needs a real bidirectional layout engine, and the desktops
// this prints from all carry the fonts. It wears the current contract's banded identity on purpose —
// the navy masthead, the blue section bands, the amber highlight on everything Phoenix filled — so a
// new hire's papers read as one set rather than as forms from three different offices.
//
// But it is a FORM, not a contract. There are no articles and no standing legal clauses to preserve
// verbatim beyond the worker's declaration; the body is a grid of labelled fields. So it does not
// reuse the contract's article renderer — it has its own, smaller one below — and it is filled from
// its own value bag rather than `buildContractValues`, because it asks for facts the contract never
// does (an employee number, a hire date, a governorate).
//
// ONE COPY. Its own header says "تُحفظ بملف الخدمة" — it is filed once in the personnel file, unlike
// the contract's four signed originals. The copy count comes from `systemContractDefaults`.

/** Which tokens hold a Latin or numeric value, so their field cell is laid out left-to-right. */
const LTR_VALUE_TOKENS = new Set<WorkerFormToken>([
  "NATIONAL_ID",
  "PHONE",
  "EMAIL",
  "EMPLOYEE_NUMBER",
  "HIRE_DATE",
  "INSURANCE_NUMBER",
]);

/** Fields that take the full width of the grid rather than sharing a row. */
const WIDE_VALUE_TOKENS = new Set<WorkerFormToken>(["ADDRESS"]);

/**
 * The date and place of birth as one field — "24 / 08 / 1990 — القاهرة".
 *
 * The date is pinned left-to-right (`pinLtr`): a run of digits inside an Arabic cell otherwise
 * resolves to an Arabic number and the day/month/year segments paint in reverse — the exact bug
 * `render-shared.ts` documents. The place is Arabic and needs no pinning.
 */
function birthDatePlace(iso: string | null, place: string | null): string {
  const date = formatDayMonthYear(iso);
  const cleanPlace = place?.trim() ?? "";
  if (date && cleanPlace) return `${pinLtr(date)} — ${cleanPlace}`;
  if (date) return pinLtr(date);
  return cleanPlace;
}

/**
 * Every value the form can fill, resolved once from what Phoenix already knows.
 *
 * The company block's three tokens carry Latin/numeric registry numbers pinned left-to-right,
 * exactly as the contract recital pins them, because they sit inside an Arabic sentence. The field
 * tokens are left bare here — each field cell sets its own direction — so a national id is not
 * double-wrapped.
 *
 * A token this map leaves undefined (or empty) prints the dotted rule. The `null`-token fields in
 * the template — marital status, military position, bank and IBAN, next of kin — are never in this
 * map at all: Phoenix holds no record of them, so they are always a blank for a pen.
 */
function buildWorkerFormValues(data: HiringPackData): Partial<Record<WorkerFormToken, string>> {
  const { employee, profile } = data;
  const recital = systemLegalEntity.contractRecital;

  return {
    COMPANY_NAME: systemLegalEntity.legalNameAr,
    COMPANY_LEGAL_FORM: recital.legalFormAr,
    COMMERCIAL_REGISTER: pinLtr(recital.commercialRegisterNumber),
    COMMERCIAL_REGISTER_OFFICE: recital.commercialRegisterOfficeAr,
    UNIFIED_REGISTER: pinLtr(recital.unifiedRegisterNumber),
    TAX_CARD: pinLtr(recital.taxCardNumber),
    COMPANY_HEAD_OFFICE_FULL: recital.headOfficeAr,

    // The Arabic name governs the whole hiring pack — the contract's مادة (18) makes the Arabic text
    // controlling — so the person is named here in Arabic wherever the record carries it.
    EMPLOYEE_NAME: employee.nameAr ?? employee.fullName,
    NATIONAL_ID: employee.nationalId ?? "",
    NATIONALITY: resolveNationality(profile.nationality, employee).value,
    BIRTH_DATE_PLACE: birthDatePlace(employee.birthDate, profile.birthPlace),
    QUALIFICATION: profile.qualification ?? "",

    ADDRESS: resolvePermanentAddress({
      addressBuilding: profile.addressBuilding,
      addressStreet: profile.addressStreet,
      residenceAddress: employee.residenceAddress,
      residenceCity: employee.residenceCity,
    }),
    GOVERNORATE: profile.addressGovernorate ?? "",
    MARKAZ: profile.addressMarkaz ?? "",
    PHONE: employee.mobileNumber ?? "",
    EMAIL: employee.workEmail ?? "",

    EMPLOYEE_NUMBER: employee.hrId,
    HIRE_DATE: pinLtr(formatDayMonthYear(employee.hireDate)),
    // ARABIC ONLY, for the same reason the contract fills مادة (1) in Arabic: the English title off
    // the employee record ("Medical Rep") is not the language the hiring pack is written in. Missing
    // prints the dotted rule, and the fill screen already flags a missing Arabic job title.
    JOB_TITLE: profile.jobTitleAr ?? "",
    DEPARTMENT: employee.departmentAr ?? "",
    INSURANCE_NUMBER: employee.socialInsuranceNumber ?? "",
  };
}

/** Substitute the tokens in a company-block line, escaping each value; empty prints the rule. */
function fillLine(template: string, values: Partial<Record<WorkerFormToken, string>>): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, token: string) => {
    const raw = values[token as WorkerFormToken];
    const text = typeof raw === "string" ? raw.trim() : "";
    return text.length > 0 ? escapeHtml(text) : escapeHtml(WORKER_FORM_BLANK_RULE);
  });
}

/**
 * One value, as a filled amber span or a dotted-rule blank.
 *
 * The amber highlight is the same signal the contract uses: it tells a reader which words Phoenix
 * typed and which are the standing form. Unlike the contract this carries NO `data-hp-key` — the
 * paper editor is keyed on the contract's tokens, and a key it does not recognise would offer an
 * edit that goes nowhere.
 */
function valueHtml(text: string): string {
  const clean = text.trim();
  return clean.length > 0
    ? `<span class="wf-fill">${escapeHtml(clean)}</span>`
    : `<span class="wf-fill wf-fill--blank">${escapeHtml(WORKER_FORM_BLANK_RULE)}</span>`;
}

/** One labelled field cell — label above, value below, direction set by the token. */
function fieldCell(field: WorkerFormField, values: Partial<Record<WorkerFormToken, string>>): string {
  const value = field.token ? (values[field.token] ?? "") : "";
  const wide = field.token && WIDE_VALUE_TOKENS.has(field.token) ? " wf-cell--wide" : "";
  const ltr = field.token && LTR_VALUE_TOKENS.has(field.token);
  const dir = ltr ? ' dir="ltr"' : "";
  const align = ltr ? " wf-value--ltr" : "";
  return `<div class="wf-cell${wide}">
      <span class="wf-label">${escapeHtml(field.labelAr)}</span>
      <span class="wf-value${align}"${dir}>${valueHtml(value)}</span>
    </div>`;
}

/** One section — a blue band heading over a two-column grid of fields. */
function sectionHtml(
  section: WorkerFormSection,
  values: Partial<Record<WorkerFormToken, string>>,
): string {
  const cells = section.fields.map((field) => fieldCell(field, values)).join("");
  return `<section class="wf-section">
      <p class="wf-band">${escapeHtml(section.headingAr)}</p>
      <div class="wf-grid">${cells}</div>
    </section>`;
}

/** The signature table — a capacity column, then name / signature / date. */
function signatureHtml(
  template: WorkerFormTemplate,
  values: Partial<Record<WorkerFormToken, string>>,
): string {
  const head = `<div class="wf-sigrow wf-sigrow--head">
      <span class="wf-sigcell wf-sigcell--role">الصفة</span>
      ${template.signatureColumnsAr
        .map((column) => `<span class="wf-sigcell">${escapeHtml(column)}</span>`)
        .join("")}
    </div>`;
  const rows = template.signatureRows
    .map((row) => {
      const name = row.nameToken ? (values[row.nameToken] ?? "") : "";
      const nameCell = name.trim().length > 0 ? valueHtml(name) : "";
      return `<div class="wf-sigrow">
        <span class="wf-sigcell wf-sigcell--role">${escapeHtml(row.roleAr)}</span>
        <span class="wf-sigcell">${nameCell}</span>
        <span class="wf-sigcell"></span>
        <span class="wf-sigcell"></span>
      </div>`;
    })
    .join("");
  return `<section class="wf-sign">${head}${rows}</section>`;
}

/** One printed copy of the form. */
function renderCopy(
  template: WorkerFormTemplate,
  values: Partial<Record<WorkerFormToken, string>>,
): string {
  const company = template.companyLinesAr
    .map((text) => `<p class="wf-company__line">${fillLine(text, values)}</p>`)
    .join("");
  const sections = template.sections.map((section) => sectionHtml(section, values)).join("");

  return `<article class="copy">
    <table class="sheet">
      <tbody><tr><td class="sheet__body">
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

        <p class="wf-note">${escapeHtml(template.noteAr)}</p>
        <div class="wf-company">${company}</div>

        ${sections}

        <section class="wf-section wf-section--decl">
          <p class="wf-band">${escapeHtml(template.declarationHeadingAr)}</p>
          <p class="wf-decl">${escapeHtml(template.declarationAr)}</p>
        </section>

        ${signatureHtml(template, values)}
      </td></tr></tbody>
      <tfoot><tr><td class="sheet__foot">${fillLine(template.footerAr, values)}</td></tr></tfoot>
    </table>
  </article>`;
}

/**
 * @param _templateVersionId Unused today — this form has only ever had one version — kept so the
 *   call this receives through the shared renderer map matches every other document's.
 * @param fields The operator's own field layer for this form.
 */
export function renderWorkerFormHtml(
  data: HiringPackData,
  copies: number,
  _templateVersionId?: string | null,
  fields: readonly DocumentFieldRow[] = [],
): string {
  const template = WORKER_FORM_TEMPLATE_V1;
  const values = buildWorkerFormValues(data);
  const total = Math.max(1, copies);
  const body = Array.from({ length: total }, () => renderCopy(template, values)).join("\n");
  const employeeName = data.employee.nameAr ?? data.employee.fullName;

  // Blocking gaps are named on the screen banner and never on paper — the person pressing Print is
  // the last one who can still go and find the missing value before it prints as a dotted rule.
  const blocking = data.gaps.filter(
    (gap) => gap.blocking && gap.documents.includes("workerDataForm"),
  );
  const gapWarning =
    blocking.length > 0
      ? [`Still blank: ${blocking.map((gap) => gap.labelEn).join(", ")} — these print as dotted rules.`]
      : [];

  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>استمارة بيانات العامل — ${escapeHtml(employeeName)}</title>
<style>
  @page { size: A4; margin: 10.7mm 10.2mm 12.7mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #e2e8f0; }
  body {
    font-family: ${ARABIC_FONT_STACK};
    color: #1a1a1a;
    direction: rtl;
    text-align: right;
  }
  ${PRINT_BANNER_CSS}

  .copy {
    width: 210mm;
    min-height: 297mm;
    margin: 0 auto 18px;
    padding: 10.7mm 10.2mm 12.7mm;
    background: #fff;
    font-size: 11pt;
    break-after: page;
    page-break-after: always;
  }
  .copy:last-of-type { break-after: auto; page-break-after: auto; margin-bottom: 0; }

  .sheet { width: 100%; border-collapse: collapse; }
  .sheet__body { padding: 0; vertical-align: top; }
  .sheet__foot {
    padding: 2.5mm 0 0;
    border-top: 0.5pt solid #c9d6e2;
    color: #4a5b6b;
    font-size: 8pt;
    text-align: center;
  }

  /* The banded identity, read off the current contract so a new hire's papers match. */
  .masthead { display: flex; align-items: stretch; background: #0b2a4a; }
  .masthead__title { flex: 1 1 auto; padding: 4mm 5mm; text-align: center; }
  .masthead__title h1 { margin: 0; color: #fff; font-size: 15pt; font-weight: 700; }
  .masthead__title p { margin: 1.5mm 0 0; color: #a8c6e2; font-size: 8.5pt; font-weight: 600; }
  .masthead__mark {
    display: flex;
    flex: 0 0 20.5%;
    align-items: center;
    justify-content: center;
    padding: 3mm;
  }
  .masthead__mark img { width: 100%; max-width: 32mm; height: auto; }
  .rule { height: 1.6mm; background: #1b7fbf; }

  .wf-note {
    margin: 2.5mm 0 0;
    color: #4a5b6b;
    font-size: 8.5pt;
    font-weight: 600;
    text-align: center;
  }
  .wf-company { margin: 1.5mm 0 4mm; text-align: center; }
  .wf-company__line { margin: 0.6mm 0; font-size: 9pt; color: #33475b; }

  .wf-section { margin: 0 0 3.5mm; border: 0.5pt solid #c9d6e2; }
  .wf-band {
    margin: 0;
    padding: 1.6mm 3mm;
    background: #1b7fbf;
    color: #fff;
    font-size: 9.5pt;
    font-weight: 700;
    text-align: center;
  }
  /* Two fields to a row on paper and on a wide screen; one to a row on a phone — the fits-the-screen
     rule. Fields wrap, they never scroll sideways. */
  .wf-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .wf-cell {
    display: flex;
    flex-direction: column;
    gap: 0.8mm;
    padding: 2mm 3mm;
    border-top: 0.5pt solid #e2ebf2;
    border-inline-start: 0.5pt solid #e2ebf2;
    min-width: 0;
  }
  /* The first cell of each printed row carries no inner start-border, and the first two no top one. */
  .wf-cell:nth-child(odd) { border-inline-start: 0; }
  .wf-cell:nth-child(1), .wf-cell:nth-child(2) { border-top: 0; }
  .wf-cell--wide { grid-column: 1 / -1; border-inline-start: 0; }
  .wf-label { color: #0b2a4a; font-size: 8.5pt; font-weight: 700; }
  .wf-value { font-size: 10.5pt; line-height: 1.4; word-break: break-word; }
  .wf-value--ltr { direction: ltr; text-align: right; unicode-bidi: plaintext; }

  .wf-section--decl { margin-top: 4.5mm; break-inside: avoid; page-break-inside: avoid; }
  .wf-decl {
    margin: 0;
    padding: 2.5mm 3mm;
    font-size: 9.5pt;
    line-height: 1.6;
    text-align: justify;
  }

  .wf-sign {
    margin-top: 4mm;
    border: 0.5pt solid #c9d6e2;
    break-inside: avoid;
    page-break-inside: avoid;
  }
  .wf-sigrow { display: grid; grid-template-columns: 1.4fr 1fr 1fr 1fr; }
  .wf-sigrow--head .wf-sigcell {
    background: #0b2a4a;
    color: #fff;
    font-weight: 700;
    font-size: 9pt;
  }
  .wf-sigcell {
    padding: 2mm 2.5mm;
    min-height: 12mm;
    border-top: 0.5pt solid #c9d6e2;
    border-inline-start: 0.5pt solid #c9d6e2;
    font-size: 10pt;
    text-align: center;
  }
  .wf-sigrow--head .wf-sigcell { min-height: 0; border-top: 0; }
  .wf-sigcell--role { text-align: right; font-weight: 700; color: #0b2a4a; }
  .wf-sigrow--head .wf-sigcell--role { color: #fff; }
  .wf-sigcell:nth-child(1) { border-inline-start: 0; }

  /* What Phoenix typed, on the amber the source document uses for its blanks. */
  .wf-fill { padding: 0 0.6mm; background: #ffedbe; color: #8a5a00; font-weight: 700; }
  .wf-fill--blank { letter-spacing: 0.4pt; background: #fff6e0; }

  @media (max-width: 640px) {
    .copy { width: auto; min-height: 0; padding: 4mm; }
    .wf-grid { grid-template-columns: 1fr; }
    .wf-cell { border-inline-start: 0; }
    .wf-cell:nth-child(2) { border-top: 0.5pt solid #e2ebf2; }
    .wf-sigrow { grid-template-columns: 1fr; }
    .wf-sigcell { border-inline-start: 0; }
  }

  @media print {
    html, body { background: #fff; }
    .copy { width: auto; min-height: 0; margin: 0; padding: 0; box-shadow: none; }
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
</head>
<body>
${printBanner([
  `Paper size: A4. ${total} ${total === 1 ? "copy is" : "copies are"} laid out below — leave the dialog's copy count at 1.`,
  "Turn ON “Background graphics” — the masthead, the section bands and the highlight on every filled value are part of the form.",
  "This form is filed in the service file. The blank fields — marital and military status, bank and IBAN, next of kin — are completed by hand on the day of hire.",
  ...gapWarning,
])}
${body}
${flowFieldLayer(fields, values)}
</body>
</html>`;
}
