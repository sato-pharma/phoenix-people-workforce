import type { CompanyDetails } from "@/lib/hiring-pack/company-details";
import {
  houseLetterhead,
  HOUSE_COLORS,
  HOUSE_IDENTITY_CSS,
} from "@/lib/hiring-pack/house-identity";
import { flowFieldLayer, type DocumentFieldRow } from "@/lib/hiring-pack/field-layout";
import {
  premiumDocumentStylesheet,
  premiumLetterhead,
  premiumPageChrome,
} from "@/lib/hiring-pack/premium-identity";
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
//
// It answers the DEVICE half too, since the device register landed (migration 20260907220000) —
// but ONLY when a device has been chosen for this handover. `data.custodyDevice` null is the normal
// case and prints exactly what this form has always printed: ruled blanks through the technical
// block, completed at the desk with the machine in hand. A pack run the evening before a joiner
// arrives has no device allocated yet, and refusing to print — or printing a guess — would both be
// worse than a rule.
//
// THE ITEM TABLE AND THE HANDOVER DATE STAY RULED IN EVERY CASE, and that is not an omission. The
// model, serial, count, condition and damage notes are OBSERVATIONS, made at the desk with the
// boxes open, and البند (1) has the holder accepting the goods «بحالتها المدونة بهذا الإقرار» — a
// pre-printed condition is a condition nobody inspected.
//
// THE VALUE COLUMN IS THE ONE EXCEPTION, since the owner asked for it on 2026-09-11, and the
// exception is principled rather than a carve-out. A value is not an observation: البند (9) calls
// it «قيمة تقديرية متفق عليها» — an agreed estimate — and البند (10) caps any wage deduction at it.
// It is decided before the handover, not discovered during it, which is exactly the kind of fact a
// register should carry and a pen should not. An item nobody priced still prints an empty box, so
// the form keeps saying "write it here" wherever the register has nothing to say.

/** Every blank this document can fill, resolved once. */
export function buildCustodyValues(data: HiringPackData): Partial<Record<CustodyToken, string>> {
  const { employee, profile } = data;
  const recital = data.company.contractRecital;

  return {
    COMPANY_NAME: data.company.legalNameAr,
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

    ...buildCustodyDeviceValues(data.custodyDevice),
  };
}

/**
 * The device half, when a device has been chosen — and NOTHING when one has not.
 *
 * Returning an empty object rather than a record of empty strings is deliberate. `fieldValue`
 * prints the ruled rule for anything absent or blank, so either shape renders the same page today;
 * but an empty string is a VALUE, and the paper editor's field layer offers a value for correction
 * while it leaves an absent token as the blank it is. Spreading nothing keeps "no device chosen"
 * and "a device whose serial nobody typed in" distinguishable everywhere downstream.
 *
 * `pinLtr` is on every one of these for the reason `custody-template.ts` gives at length: a serial,
 * an IMEI, a SIM and a line number are all runs of Latin digits inside a right-to-left page, and
 * the bidirectional algorithm reorders the groups around them — the defect that once printed this
 * company's own tax card number `477-108-318` as `318-108-477`. The `ltr` flag on the field styles
 * the box; this pins the characters inside it, and both are needed.
 */
function buildCustodyDeviceValues(
  device: HiringPackData["custodyDevice"],
): Partial<Record<CustodyToken, string>> {
  if (!device) return {};

  const pin = (value: string | null): string | undefined => {
    const text = String(value ?? "").trim();
    return text.length > 0 ? pinLtr(text) : undefined;
  };

  return {
    // نموذج رقم 1
    DEVICE_MANUFACTURER: pin(device.manufacturer),
    DEVICE_SERIAL: pin(device.serialNumber),
    DEVICE_NAME: pin(device.deviceName),
    DEVICE_PROCESSOR: pin(device.processor),
    DEVICE_RAM: pin(device.installedRam),
    DEVICE_SYSTEM_TYPE: pin(device.systemType),
    DEVICE_ID: pin(device.windowsDeviceId),
    DEVICE_PRODUCT_ID: pin(device.windowsProductId),

    // نموذج رقم 2. «نوع الجهاز» is the make and model as a human would say it, which is what the
    // box asks for — not the register's `category`, which is a filing bucket.
    DEVICE_TYPE: pin([device.manufacturer, device.model].filter(Boolean).join(" ") || null),
    DEVICE_IMEI: pin(device.imei),
    DEVICE_SIM: pin(device.simNumber),
    DEVICE_LINE: pin(device.lineNumber),
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

/** Egyptian pounds as the form shows money: grouped, no decimals unless the figure has them. */
function egp(amount: number): string {
  return amount.toLocaleString("en-US", {
    maximumFractionDigits: 2,
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
  });
}

/**
 * The item table. Every cell after the item name is a blank completed with the device present,
 * EXCEPT the value column, which is filled from the custody record when the items have been priced.
 *
 * WHY ONLY THAT COLUMN. البند (9) is about the value beside each item — «القيمة المدونة قرين كل
 * صنف» — and البند (10) caps any wage deduction at those figures, so they are the cells where a
 * handwritten number costs somebody money if it is wrong. The model, serial, count, condition and
 * damage notes stay open on purpose: they are observations made while looking at the object, and a
 * register cannot make them.
 *
 * AN UNPRICED ROW STAYS AN EMPTY BOX rather than printing a zero. `itemNoteAr` strikes the row of
 * any item not actually handed over and excludes it from the total, so a blank is the form's own
 * way of saying "not supplied". A zero would assert the item WAS handed over and is worth nothing.
 */
export function renderCustodyItemTable(
  template: CustodyTemplate,
  itemValues: Record<string, number> | null,
): string {
  const head = template.itemColumnsAr
    .map((column) => `<th>${escapeHtml(column)}</th>`)
    .join("");

  const body = template.itemRows
    .map((row) => {
      // Open cells per row: model, serial, count, condition, notes, value. They are rendered as
      // empty bordered boxes rather than dotted rules — inside a ruled table a row of dots reads as
      // a struck-through line, which on this form means "this item was not handed over".
      const open = template.itemColumnsAr.length - 2;
      const priced = itemValues?.[row.number];
      const cells = Array.from({ length: open }, (_unused, index) =>
        // The value column is the LAST one, so it is the last open cell of the row.
        index === open - 1 && typeof priced === "number"
          ? `<td class="open val-cell" dir="ltr">${escapeHtml(egp(priced))}</td>`
          : `<td class="open"></td>`,
      ).join("");
      return `<tr><td class="num">${escapeHtml(row.number)}</td><td class="item">${escapeHtml(
        row.itemAr,
      )}</td>${cells}</tr>`;
    })
    .join("");

  // Summed from the rows PRESENT, which is what the label itself promises: «لا تُحتسب قيمة صنف لم
  // يُسلَّم فعليًا». Null when nothing is priced, so the cell stays the blank it has always been.
  const amounts = Object.values(itemValues ?? {}).filter((amount) => Number.isFinite(amount));
  const total = amounts.length > 0 ? amounts.reduce((sum, amount) => sum + amount, 0) : null;

  return `<table class="items">
      <thead><tr>${head}</tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr>
        <td class="total" colspan="${template.itemColumnsAr.length - 1}">${escapeHtml(
          template.itemTotalLabelAr,
        )}</td>
        ${
          total === null
            ? `<td class="open"></td>`
            : `<td class="open val-cell val-cell--total" dir="ltr">${escapeHtml(egp(total))}</td>`
        }
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

/**
 * The three-column signature block, used by both the receipt and the return protocol.
 *
 * NO PRINTED SEAL on either half — owner, 2026-09-29. It was already forbidden on the return
 * protocol for a reason worth keeping on the record: that block is signed when the device actually
 * comes back, which is usually months later and may never happen at all, so a seal printed there
 * certifies a return that has not occurred. The owner extended the same objection to every hiring
 * paper, the receipt half included.
 */
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
  itemValues: Record<string, number> | null,
  // The letterhead names the company in both languages, and only one of those is a document
  // TOKEN — so the resolved record is passed rather than read from the module, which is what
  // makes the masthead follow an edited company name instead of the compiled one.
  company: CompanyDetails,
  // The HR premium identity dresses the CURRENT version only. An archived version keeps the dress it
  // was signed in, so a reprint from the Archive screen still matches the paper on file.
  premium = false,
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

  const letterhead = {
    titleAr: template.titleAr,
    subtitleAr: template.subtitleAr,
    legalNameAr: company.legalNameAr,
    legalNameEn: company.legalNameEn,
  };
  return `<article class="copy">
    ${premium ? premiumLetterhead(letterhead) : houseLetterhead(letterhead)}

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
    ${renderCustodyItemTable(template, itemValues)}
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

    ${returnProtocol(template)}${premium ? premiumPageChrome() : ""}
  </article>`;
}

/**
 * The HR premium identity over this receipt's own stylesheet, for the current version. APPENDED,
 * never merged, so an archived version renders exactly the stylesheet it always did.
 */
const CUSTODY_PREMIUM_CSS = `
${premiumDocumentStylesheet(".copy")}
`;

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
  // The receipt the pack prints today wears the HR premium identity; a version asked for from the
  // Archive keeps the dress it was signed in.
  const premium = template.id === fallback.id;
  const body = Array.from({ length: total }, () =>
    renderCopy(template, values, data.custodyDevice?.itemValuesEgp ?? null, data.company, premium),
  ).join("\n");
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

  /* The house identity — SATO-DIS-2026-01, shared by every document. */
  ${HOUSE_IDENTITY_CSS}

  /* The recital keeps its own words and its own order; only the filled tint behind it goes. */
  .recital { padding: 2.5mm 3mm; text-align: center; }
  .recital__name { margin: 0; color: var(--phx-doc-deep); font-size: 9.5pt; font-weight: 700; }
  .recital__line { margin: 0.8mm 0 0; color: var(--phx-doc-muted); font-size: 7.5pt; }

  .hdr { display: flex; margin-top: 2.5mm; border: 0.3mm solid #c9d8e8; }
  .hdr__cell {
    flex: 1 1 0; padding: 1.6mm 2.5mm; border-inline-start: 0.3mm solid #c9d8e8;
    font-size: 8pt; text-align: center;
  }
  .hdr__cell:first-child { border-inline-start: 0; }
  .hdr__fixed { font-weight: 700; color: ${HOUSE_COLORS.deep}; }
  .hdr__label { color: #5a6b7c; margin-inline-end: 1.5mm; }

  .sec {
    margin: 3.5mm 0 0; padding: 1.5mm 3mm 1.1mm;
    border-bottom: 0.8pt solid ${HOUSE_COLORS.blue}; color: ${HOUSE_COLORS.deep};
    font-size: 9pt; font-weight: 700;
  }
  /* The return section reads as the second half of the receipt. It was a lighter FILL; it is now a
     lighter RULE, which is the same signal for none of the toner. */
  .sec--ret { border-bottom-color: ${HOUSE_COLORS.light}; }

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
  .val { font-weight: 700; color: ${HOUSE_COLORS.deep}; }
  .rule-line { color: #91a4b7; letter-spacing: 0.2mm; }
  .fixed { font-size: 7.5pt; }

  .items { width: 100%; border-collapse: collapse; font-size: 7.5pt; }
  .items th {
    padding: 1.4mm 1mm; background: ${HOUSE_COLORS.tint}; color: ${HOUSE_COLORS.deep};
    border: 0.3mm solid #c9d8e8; font-weight: 700; text-align: center;
  }
  .items td { padding: 1.8mm 1.5mm; border: 0.3mm solid #c9d8e8; }
  .items .num { width: 7mm; text-align: center; color: #5a6b7c; }
  .items .item { width: 34mm; font-weight: 700; color: ${HOUSE_COLORS.deep}; }
  .items .open { background: #fff; }
  /* A printed amount, not a blank. Right-aligned and tabular so a column of figures lines up on
     the decimal, which is how somebody checks a total by eye without adding it up. */
  .items .val-cell { text-align: right; font-weight: 700; color: ${HOUSE_COLORS.deep}; font-variant-numeric: tabular-nums; }
  .items .val-cell--total { background: ${HOUSE_COLORS.tint}; }
  .items .total { background: ${HOUSE_COLORS.tint}; font-weight: 700; color: ${HOUSE_COLORS.deep}; text-align: start; }

  .note { margin: 1.5mm 0 0; color: #5a6b7c; font-size: 7pt; line-height: 1.45; }

  .clauses { border: 0.3mm solid #c9d8e8; border-top: 0; }
  .cgroup__head {
    margin: 0; padding: 1.4mm 3mm;
    background: #e7eef6; color: ${HOUSE_COLORS.deep}; font-size: 8pt; font-weight: 700;
  }
  .clause { display: flex; gap: 2mm; padding: 1.6mm 3mm; border-top: 0.3mm solid #e3ecf5; }
  .clause__no { flex: 0 0 auto; color: ${HOUSE_COLORS.blue}; font-weight: 700; }
  .clause__body { flex: 1 1 auto; text-align: justify; }
  .closing { margin: 2.5mm 0 0; font-weight: 700; color: ${HOUSE_COLORS.deep}; }

  .sigs { display: flex; gap: 3mm; margin-top: 2mm; }
  .sig { flex: 1 1 0; border: 0.3mm solid #c9d8e8; }
  .sig__head {
    margin: 0; padding: 1.4mm 2mm 1.1mm;
    border-bottom: 0.8pt solid ${HOUSE_COLORS.blue}; color: ${HOUSE_COLORS.deep};
    font-size: 7.5pt; font-weight: 700; text-align: center;
  }
  .sig__body { padding: 2mm; background: ${HOUSE_COLORS.tint}; }
  .sig__line { margin: 0 0 1.4mm; font-size: 7.5pt; }
  .sig__attest { margin: 1.5mm 0 0; color: #5a6b7c; font-size: 7pt; }

  /* The return protocol starts a fresh sheet. It is completed months later, by different people,
     and it is the only proof a device came back — البند (8) — so it must never be the tail end of
     a page whose top half is about the handover. */
  .ret { page-break-before: always; break-before: page; }
  .ret__intro {
    margin: 0; padding: 2mm 3mm;
    background: ${HOUSE_COLORS.tint}; color: #5a6b7c; font-size: 7.5pt; line-height: 1.5;
  }

  /* A clause, a signature column or a labelled box must not be split across two sheets. */
  .clause, .sig, .cell, .cgroup__head, .items tr { page-break-inside: avoid; break-inside: avoid; }

  @media print {
    html, body { background: #fff; }
    .copy { width: auto; min-height: 0; margin: 0; padding: 0; box-shadow: none; }
  }
${PRINT_BANNER_CSS}${premium ? CUSTODY_PREMIUM_CSS : ""}
</style>
</head>
<body>
${printBanner([
  `${employeeName} — ${template.formNumberAr === "1" ? "laptop" : "phone or tablet"} custody receipt, ${total} ${
    total === 1 ? "copy" : "copies"
  }.`,
  "Turn ON “Background graphics” — the title panel, the section bars and the table rules are part of the document.",
  // The banner has to match the page it is stapled to. It said "the device details print blank by
  // design" unconditionally, which was true until the register could fill them — and a banner that
  // tells the person at the desk to write in a box that already has a serial in it is how a correct
  // number gets crossed out and replaced by a hand-copied one.
  data.custodyDevice
    ? "The device details come from the register — CHECK them against the machine before signing. The values and the handover date print blank by design."
    : "The device details, values and handover date print blank by design. Complete them with the device in hand.",
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
