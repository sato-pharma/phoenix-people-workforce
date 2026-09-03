import { systemLegalEntity } from "@/config/system-settings";
import { flowFieldLayer, type DocumentFieldRow } from "@/lib/hiring-pack/field-layout";
import {
  CUSTODY_BLANK_RULE,
  CUSTODY_BLANK_RULE_WIDE,
  type CustodyField,
  type CustodyTemplate,
  type CustodyToken,
} from "@/lib/hiring-pack/custody-template";
import {
  CUSTODY_LAPTOP_V1,
  CUSTODY_MOBILE_V1,
  custodyTemplateById,
} from "@/lib/hiring-pack/custody-text";
import {
  ARABIC_FONT_STACK,
  escapeHtml,
  formatDayMonthYear,
  pinLtr,
  PRINT_BANNER_CSS,
  printBanner,
  resolvePermanentAddress,
  todayInCairo,
} from "@/lib/hiring-pack/render-shared";
import type { HiringPackData } from "@/lib/hiring-pack/types";

// The custody receipt (إقرار استلام عهدة), laid out for A4 and printed by the browser.
//
// Like the contract and unlike Form 1, this is OUR OWN instrument rather than a government form, so
// it is typeset from its text instead of positioned over a scan of an original. It reflows: a long
// Arabic name or a long address pushes what follows down rather than colliding with a fixed box.
//
// TWO COPIES — the document says so itself, in its own subtitle: "يُحرَّر من نسختين". One is handed
// to the employee and one is filed. As with the contract the copies are laid out one after another
// with a forced page break between them, so the print dialog's copy count stays at 1 and the two
// are guaranteed identical rather than depending on what somebody typed into the dialog.
//
// WHAT IS FILLED AND WHAT IS RULED. Phoenix answers the half of this page that is about the PERSON
// — name, national ID, job title, department, employee code, phone, address — because it already
// holds every one of those and because copying them off an ID card by hand is where the errors are.
// It answers nothing about the DEVICE, because there is no asset register in this system: the item
// table, the technical block, the values and the handover date print as ruled blanks, exactly as
// the owner's own blank templates do, and are completed at the desk with the device in hand. That
// is not a shortcut — a serial number is checked off the back of the machine, not recalled.

/** Every blank this document can fill, resolved once. */
function buildCustodyValues(data: HiringPackData): Partial<Record<CustodyToken, string>> {
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

    // تاريخ التحرير — the day the form is drawn up, which IS the day it is printed. This is the one
    // date on the page Phoenix can honestly answer. The handover date below it is deliberately left
    // ruled: the form is often printed before the device is collected, and a printed date somebody
    // then signs under is worse than a blank they have to complete.
    ISSUE_DATE: formatDayMonthYear(todayInCairo()),

    // The Arabic name governs wherever the record carries one — the same rule the contract follows,
    // so the two papers in one person's file name the same party the same way.
    EMPLOYEE_NAME: employee.nameAr ?? employee.fullName,
    NATIONAL_ID: employee.nationalId ?? "",
    // Arabic only — the English title off the employee record does not belong on an Arabic
    // instrument. Same rule as the contract; see `render-contract.ts`.
    JOB_TITLE: profile.jobTitleAr ?? "",
    DEPARTMENT: employee.departmentAr ?? "",
    HR_ID: employee.hrId,
    PHONE: employee.mobileNumber ?? "",
    ADDRESS: resolvePermanentAddress({
      addressBuilding: profile.addressBuilding,
      addressStreet: profile.addressStreet,
      residenceAddress: employee.residenceAddress,
      residenceCity: employee.residenceCity,
    }),
  };
}

/**
 * One filled value, laid out in the direction its CONTENT needs.
 *
 * `dir="ltr"` on a national ID, a phone number or a serial is not decoration. Those are runs of
 * Latin digits inside a right-to-left page, and the bidirectional algorithm reorders the groups
 * around them — the defect that once printed this company's own tax card number `477-108-318` as
 * `318-108-477`. The Word original defends the same runs with U+202A/U+202C embedding controls.
 *
 * Note it is applied PER FIELD and never to the block: `dir="auto"` on a whole line reads only its
 * first strong character, so a line holding an Arabic label and a Latin value would turn wholly
 * one way and render the other half backwards.
 */
function fieldValue(field: CustodyField, values: Partial<Record<CustodyToken, string>>): string {
  const raw = field.token ? values[field.token] : undefined;
  const text = typeof raw === "string" ? raw.trim() : "";
  // The token travels into the markup so the preview screen can offer this value for correction on
  // the page itself. Inert in print. Carried on the BLANK rule too, deliberately — an empty dotted
  // rule is the single most useful thing to be able to fill in from the page.
  const key = field.token ? ` data-hp-key="${escapeHtml(field.token)}"` : "";

  if (text.length === 0) {
    const rule = field.wide ? CUSTODY_BLANK_RULE_WIDE : CUSTODY_BLANK_RULE;
    return `<span class="rule-line"${key}>${escapeHtml(rule)}</span>`;
  }
  if (field.ltr) {
    return `<span class="val" dir="ltr"${key}>${escapeHtml(text)}</span>`;
  }
  return `<span class="val"${key}>${escapeHtml(text)}</span>`;
}

/** A labelled box. `wide` ones take the whole row instead of sharing it. */
function fieldCell(field: CustodyField, values: Partial<Record<CustodyToken, string>>): string {
  return `<div class="cell${field.wide ? " cell--wide" : ""}">
      <span class="cell__label">${escapeHtml(field.labelAr)}</span>
      <span class="cell__value">${fieldValue(field, values)}</span>
    </div>`;
}

function sectionHeading(text: string): string {
  return `<h2 class="sec">${escapeHtml(text)}</h2>`;
}

/** The item table — every cell after the item name is a blank, completed with the device present. */
function itemTable(template: CustodyTemplate): string {
  const head = template.itemColumnsAr
    .map((column) => `<th>${escapeHtml(column)}</th>`)
    .join("");

  const body = template.itemRows
    .map((row) => {
      // Four open cells per row: model, serial, count, condition, notes, value. They are rendered as
      // empty bordered boxes rather than dotted rules — inside a ruled table a row of dots reads as
      // a struck-through line, which on this form means "this item was not handed over".
      const open = template.itemColumnsAr.length - 2;
      const cells = Array.from({ length: open }, () => `<td class="open"></td>`).join("");
      return `<tr><td class="num">${escapeHtml(row.number)}</td><td class="item">${escapeHtml(
        row.itemAr,
      )}</td>${cells}</tr>`;
    })
    .join("");

  return `<table class="items">
      <thead><tr>${head}</tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr>
        <td class="total" colspan="${template.itemColumnsAr.length - 1}">${escapeHtml(
          template.itemTotalLabelAr,
        )}</td>
        <td class="open"></td>
      </tr></tfoot>
    </table>`;
}

function clauseGroups(template: CustodyTemplate): string {
  return template.clauseGroups
    .map(
      (group) => `<div class="cgroup">
        <p class="cgroup__head">${escapeHtml(group.headingAr)}</p>
        ${group.clauses
          .map(
            (clause) => `<div class="clause">
            <span class="clause__no">${escapeHtml(clause.number)}</span>
            <span class="clause__body">${escapeHtml(clause.body)}</span>
          </div>`,
          )
          .join("")}
      </div>`,
    )
    .join("");
}

/** The three-column signature block, used by both the receipt and the return protocol. */
function signatureBlock(
  columns: readonly { headingAr: string; attestationAr: string }[],
): string {
  const cells = columns
    .map(
      (column) => `<div class="sig">
        <p class="sig__head">${escapeHtml(column.headingAr)}</p>
        <div class="sig__body">
          <p class="sig__line">الاسم: <span class="rule-line">..........................</span></p>
          <p class="sig__line">التوقيع: <span class="rule-line">........................</span></p>
          <p class="sig__line">التاريخ: <span class="rule-line">........................</span></p>
          <p class="sig__attest">${escapeHtml(column.attestationAr)}</p>
        </div>
      </div>`,
    )
    .join("");
  return `<section class="sigs">${cells}</section>`;
}

function returnProtocol(template: CustodyTemplate): string {
  const fields = template.returnFields
    .map((field) => {
      const value = field.fixedAr
        ? `<span class="fixed">${escapeHtml(field.fixedAr)}</span>`
        : `<span class="rule-line">${escapeHtml(
            field.wide ? CUSTODY_BLANK_RULE_WIDE : CUSTODY_BLANK_RULE,
          )}</span>`;
      return `<div class="cell${field.wide ? " cell--wide" : ""}">
        <span class="cell__label">${escapeHtml(field.labelAr)}</span>
        <span class="cell__value">${value}</span>
      </div>`;
    })
    .join("");

  return `<section class="ret">
      <h2 class="sec sec--ret">${escapeHtml(template.returnHeadingAr)}</h2>
      <p class="ret__intro">${escapeHtml(template.returnIntroAr)}</p>
      <div class="grid2">${fields}</div>
      ${signatureBlock(template.returnSignatureColumns)}
    </section>`;
}

/** One printed copy of the receipt. */
function renderCopy(
  template: CustodyTemplate,
  values: Partial<Record<CustodyToken, string>>,
): string {
  const header = [
    `${template.headerLabelsAr[0]}: ${template.formNumberAr}`,
    template.headerLabelsAr[1],
    template.headerLabelsAr[2],
    `${template.headerLabelsAr[3]}: ${template.departmentAr}`,
  ];

  // The declaration number and the issue date are the only two header boxes that take a value: the
  // number is assigned by hand from the company's own register — البند (14) requires a separate
  // numbered form per handover — and the date is today.
  const headerCells = [
    `<span class="hdr__fixed">${escapeHtml(header[0])}</span>`,
    `<span class="hdr__label">${escapeHtml(header[1])}</span><span class="rule-line">............................</span>`,
    `<span class="hdr__label">${escapeHtml(header[2])}</span><span class="val" dir="ltr">${escapeHtml(
      values.ISSUE_DATE ?? "",
    )}</span>`,
    `<span class="hdr__fixed">${escapeHtml(header[3])}</span>`,
  ]
    .map((cell) => `<div class="hdr__cell">${cell}</div>`)
    .join("");

  const registry =
    `${values.COMPANY_NAME ?? ""} — ${values.COMPANY_LEGAL_FORM ?? ""}`.trim();
  const registryLine =
    `السجل التجاري رقم ${values.COMMERCIAL_REGISTER ?? ""} (${
      values.COMMERCIAL_REGISTER_OFFICE ?? ""
    }) · الرقم الموحد ${values.UNIFIED_REGISTER ?? ""} · البطاقة الضريبية رقم ${
      values.TAX_CARD ?? ""
    }`;

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

    <section class="recital">
      <p class="recital__name">${escapeHtml(registry)}</p>
      <p class="recital__line">${escapeHtml(registryLine)}</p>
      <p class="recital__line">المركز العام: ${escapeHtml(values.COMPANY_HEAD_OFFICE_FULL ?? "")}</p>
    </section>

    <div class="hdr">${headerCells}</div>

    ${sectionHeading(template.holderHeadingAr)}
    <div class="grid2">${template.holderFields
      .map((field) => fieldCell(field, values))
      .join("")}</div>

    ${sectionHeading(template.itemsHeadingAr)}
    ${itemTable(template)}
    <p class="note">${escapeHtml(template.itemNoteAr)}</p>

    ${sectionHeading(template.technicalHeadingAr)}
    <div class="grid2">${template.technicalFields
      .map((field) => fieldCell(field, values))
      .join("")}</div>

    ${sectionHeading(template.clausesHeadingAr)}
    <section class="clauses">${clauseGroups(template)}</section>
    <p class="closing">${escapeHtml(template.closingAr)}</p>

    ${sectionHeading(template.signaturesHeadingAr)}
    ${signatureBlock(template.signatureColumns)}

    ${returnProtocol(template)}
  </article>`;
}

/**
 * The printable custody receipt.
 *
 * `fallback` is the form the DOCUMENT asks for — a laptop receipt or a phone/tablet receipt — and
 * `requestedTemplateId` is an explicit archived version, which only the Archive screen ever passes.
 * The requested id is honoured only when it is a version of the SAME form: a laptop print carrying
 * the tablet form's id is a caller error, and answering it with the tablet form would hand somebody
 * a receipt for a device they are not holding. Falling back rather than throwing is deliberate —
 * the print route validates the id against the registry before it reaches here, so anything that
 * gets this far is already known-good and a stack trace would only lose somebody their document.
 */
function renderCustody(
  data: HiringPackData,
  copies: number,
  requestedTemplateId: string | null | undefined,
  fallback: CustodyTemplate,
  fields: readonly DocumentFieldRow[],
): string {
  const requested = custodyTemplateById(requestedTemplateId);
  const template = requested && requested.variant === fallback.variant ? requested : fallback;
  const values = buildCustodyValues(data);
  const total = Math.max(1, copies);
  const body = Array.from({ length: total }, () => renderCopy(template, values)).join("\n");
  const employeeName = data.employee.nameAr ?? data.employee.fullName;

  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>إقرار استلام عهدة — ${escapeHtml(employeeName)}</title>
<style>
  @page { size: A4; margin: 10.7mm 10.2mm 12.7mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #e2e8f0; }
  body {
    font-family: ${ARABIC_FONT_STACK};
    color: #1a1a1a;
    font-size: 8.5pt;
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
  /* Each copy starts its own sheet. Two copies, and neither may begin halfway down a page. */
  .copy + .copy { page-break-before: always; break-before: page; }

  /* Palette read off the source document: the same navy, blue and zebra the contract uses, because
     they are the same house style — measured, not assumed (0B2A4A, 1B7FBF, F2F6FA, A8C6E2). */
  .masthead { display: flex; align-items: stretch; background: #0b2a4a; }
  .masthead__title { flex: 1 1 auto; padding: 3.5mm 5mm; text-align: center; }
  .masthead__title h1 { margin: 0; color: #fff; font-size: 15pt; font-weight: 700; }
  .masthead__title p { margin: 1.5mm 0 0; color: #a8c6e2; font-size: 8pt; font-weight: 600; }
  .masthead__mark {
    flex: 0 0 36mm;
    display: flex; align-items: center; justify-content: center;
    padding: 2mm 3mm;
  }
  /* NO WHITE PANEL BEHIND THE LOGO, and this is not a style preference. The artwork is the on-dark
     variant: its "SATO" wordmark is WHITE, so on a white panel that half of the mark disappears and
     the masthead reads "PHARMA". It sits directly on the navy, exactly as the contract's does — the
     -on-light file is the variant for a pale background, and neither is safe on the other. */
  .masthead__mark img { width: 100%; max-width: 30mm; height: auto; }
  .rule { height: 1.6mm; background: #1b7fbf; }

  .recital { padding: 2.5mm 3mm; background: #f2f6fa; text-align: center; }
  .recital__name { margin: 0; color: #0b2a4a; font-size: 9.5pt; font-weight: 700; }
  .recital__line { margin: 0.8mm 0 0; color: #5a6b7c; font-size: 7.5pt; }

  .hdr { display: flex; margin-top: 2.5mm; border: 0.3mm solid #c9d8e8; }
  .hdr__cell {
    flex: 1 1 0; padding: 1.6mm 2.5mm; border-inline-start: 0.3mm solid #c9d8e8;
    font-size: 8pt; text-align: center;
  }
  .hdr__cell:first-child { border-inline-start: 0; }
  .hdr__fixed { font-weight: 700; color: #0b2a4a; }
  .hdr__label { color: #5a6b7c; margin-inline-end: 1.5mm; }

  .sec {
    margin: 3.5mm 0 0; padding: 1.5mm 3mm;
    background: #0b2a4a; color: #fff;
    font-size: 9pt; font-weight: 700;
  }
  .sec--ret { background: #1b7fbf; }

  /* Two boxes to a row, with a wide one taking both. A field label and its value must never end up
     on separate lines, which is what the flex row plus nowrap on the label prevents. */
  .grid2 { display: flex; flex-wrap: wrap; border: 0.3mm solid #c9d8e8; border-top: 0; }
  .cell {
    flex: 1 1 50%; min-width: 50%; max-width: 50%;
    display: flex; gap: 2mm; align-items: baseline;
    padding: 1.6mm 2.5mm;
    border-top: 0.3mm solid #e3ecf5;
  }
  .cell--wide { flex-basis: 100%; min-width: 100%; max-width: 100%; }
  .cell__label { flex: 0 0 auto; color: #5a6b7c; font-size: 7.5pt; white-space: nowrap; }
  .cell__value { flex: 1 1 auto; }
  .val { font-weight: 700; color: #0b2a4a; }
  .rule-line { color: #91a4b7; letter-spacing: 0.2mm; }
  .fixed { font-size: 7.5pt; }

  .items { width: 100%; border-collapse: collapse; font-size: 7.5pt; }
  .items th {
    padding: 1.4mm 1mm; background: #f2f6fa; color: #0b2a4a;
    border: 0.3mm solid #c9d8e8; font-weight: 700; text-align: center;
  }
  .items td { padding: 1.8mm 1.5mm; border: 0.3mm solid #c9d8e8; }
  .items .num { width: 7mm; text-align: center; color: #5a6b7c; }
  .items .item { width: 34mm; font-weight: 700; color: #0b2a4a; }
  .items .open { background: #fff; }
  .items .total { background: #f2f6fa; font-weight: 700; color: #0b2a4a; text-align: start; }

  .note { margin: 1.5mm 0 0; color: #5a6b7c; font-size: 7pt; line-height: 1.45; }

  .clauses { border: 0.3mm solid #c9d8e8; border-top: 0; }
  .cgroup__head {
    margin: 0; padding: 1.4mm 3mm;
    background: #e7eef6; color: #0b2a4a; font-size: 8pt; font-weight: 700;
  }
  .clause { display: flex; gap: 2mm; padding: 1.6mm 3mm; border-top: 0.3mm solid #e3ecf5; }
  .clause__no { flex: 0 0 auto; color: #1b7fbf; font-weight: 700; }
  .clause__body { flex: 1 1 auto; text-align: justify; }
  .closing { margin: 2.5mm 0 0; font-weight: 700; color: #0b2a4a; }

  .sigs { display: flex; gap: 3mm; margin-top: 2mm; }
  .sig { flex: 1 1 0; border: 0.3mm solid #c9d8e8; }
  .sig__head {
    margin: 0; padding: 1.4mm 2mm;
    background: #0b2a4a; color: #fff; font-size: 7.5pt; font-weight: 700; text-align: center;
  }
  .sig__body { padding: 2mm; background: #f2f6fa; }
  .sig__line { margin: 0 0 1.4mm; font-size: 7.5pt; }
  .sig__attest { margin: 1.5mm 0 0; color: #5a6b7c; font-size: 7pt; }

  /* The return protocol starts a fresh sheet. It is completed months later, by different people,
     and it is the only proof a device came back — البند (8) — so it must never be the tail end of
     a page whose top half is about the handover. */
  .ret { page-break-before: always; break-before: page; }
  .ret__intro {
    margin: 0; padding: 2mm 3mm;
    background: #f2f6fa; color: #5a6b7c; font-size: 7.5pt; line-height: 1.5;
  }

  /* A clause, a signature column or a labelled box must not be split across two sheets. */
  .clause, .sig, .cell, .cgroup__head, .items tr { page-break-inside: avoid; break-inside: avoid; }

  @media print {
    html, body { background: #fff; }
    .copy { width: auto; min-height: 0; margin: 0; padding: 0; box-shadow: none; }
  }
${PRINT_BANNER_CSS}
</style>
</head>
<body>
${printBanner([
  `${employeeName} — ${template.formNumberAr === "1" ? "laptop" : "phone or tablet"} custody receipt, ${total} ${
    total === 1 ? "copy" : "copies"
  }.`,
  "Turn ON “Background graphics” — the title panel, the section bars and the table rules are part of the document.",
  "The device details, values and handover date print blank by design. Complete them with the device in hand.",
])}
${body}
${flowFieldLayer(fields, values)}
</body>
</html>`;
}

/** The laptop receipt — نموذج رقم 1. */
export function renderCustodyLaptopHtml(
  data: HiringPackData,
  copies: number,
  templateId?: string | null,
  fields: readonly DocumentFieldRow[] = [],
): string {
  return renderCustody(data, copies, templateId, CUSTODY_LAPTOP_V1, fields);
}

/** The phone-or-tablet receipt — نموذج رقم 2. */
export function renderCustodyMobileHtml(
  data: HiringPackData,
  copies: number,
  templateId?: string | null,
  fields: readonly DocumentFieldRow[] = [],
): string {
  return renderCustody(data, copies, templateId, CUSTODY_MOBILE_V1, fields);
}
