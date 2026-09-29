import type { CompanyDetails } from "@/lib/hiring-pack/company-details";
import { flowFieldLayer, type DocumentFieldRow } from "@/lib/hiring-pack/field-layout";
import {
  HOUSE_COLORS,
  HOUSE_MARK_SRC,
  houseBandBackground,
} from "@/lib/hiring-pack/house-identity";
import { insuranceWageFromBase } from "@/lib/hiring-pack/insurance-wage";
import { renewalObjectiveReasonClause } from "@/lib/hiring-pack/renewal-reasons";
import { spellEgyptianAmount } from "@/lib/hiring-pack/arabic-amount";
import {
  RENEWAL_BLANK_RULE,
  RENEWAL_BLANK_RULE_WIDE,
  type RenewalField,
  type RenewalSignatureColumn,
  type RenewalTemplate,
  type RenewalToken,
} from "@/lib/hiring-pack/renewal-template";
import {
  NON_RENEWAL_NOTICE_V1,
  RENEWAL_ANNEX_V1,
  renewalTemplateById,
} from "@/lib/hiring-pack/renewal-text";
import {
  ARABIC_FONT_STACK,
  arabicDayName,
  describeDurationMonths,
  escapeHtml,
  formatDayMonthYear,
  formatMoney,
  pinLtr,
  PRINT_BANNER_CSS,
  printBanner,
  todayInCairo,
} from "@/lib/hiring-pack/render-shared";
import type { HiringPackData } from "@/lib/hiring-pack/types";

// The two renewal papers, laid out for A4 and printed by the browser.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THIS IS THE CONTRACT'S `document` LAYOUT, DELIBERATELY AND EXACTLY. Same repeating masthead, same
// brand rule, same `.doc-*` class names, same type scale, same zebra on the identity grid, same
// signature table. The owner's standing rule is to inspect the sibling pages and match their design
// identity rather than invent a one-off look — and here the sibling is not merely adjacent, it is
// the document this one AMENDS. An annex is read stapled to its contract; a reader turning from
// page 3 of the contract to page 1 of the annex must not be able to tell that a different piece of
// code drew it.
//
// It is a copy rather than an import because those functions are private to `render-contract.ts`
// and typed against `ContractToken`. Exporting them to share here would couple the contract's
// renderer to this one, and the contract has been redrafted four times in three weeks: the archive
// exists precisely so a change to one paper cannot reach into another. `tests/hr-forms-renewal.test.ts`
// pins the shared furniture — the brand rule, the mark, the masthead — so the two cannot drift
// apart silently, which is the one real cost of the duplication.
//
// WHAT IS FILLED AND WHAT IS RULED, on the same principle as the custody receipt. Phoenix answers
// everything it holds a record of — the person, the original contract's dates, the job, the
// department, the pay, the insurance wage, and the new term when a renewal request has been raised
// through the workflow.
//
// The ANNEX NUMBER still rules, because it is assigned by hand out of the company's own paper
// register and nothing here can know it. The OBJECTIVE REASON no longer does: the owner asked on
// 2026-09-05 for a dropdown of standard grounds, so it is now a code on the hiring profile resolved
// through `renewal-reasons.ts`. It still rules when nothing has been chosen, which is the important
// half — an unanswered legal ground must look unanswered, because the alternative is a guess that
// gets signed.
//
// The reason is stored per EMPLOYEE and not per renewal, deliberately: Article 87 asks why the
// nature of THIS WORK requires a term, which is a fact about the post that does not change between
// one year's annex and the next.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The day after an ISO date, as ISO.
 *
 * Used for one thing only: the new term starts the day after the old one ends. THE ARITHMETIC IS
 * DONE IN UTC and never in local time — `new Date("2026-08-31")` is midnight UTC, and adding a day
 * in a machine-local calendar can land back on the same date or skip one, depending on which side
 * of a DST boundary the server happens to be. The date has no time in it and must not acquire one.
 */
function dayAfter(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!match) return null;
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1),
  );
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

/**
 * `months` after an ISO date, minus one day — the last day of a term that begins on it.
 *
 * A twelve-month term beginning 2026-09-01 ends 2027-08-31, not 2027-09-01: the end date named in
 * the annex is the last day the contract RUNS, and stating the following day instead gives the
 * employee one more day of service than the company agreed and one fewer than he thinks he has.
 * Returns null on a month overflow rather than rolling into the next month — 31 January plus one
 * month has no honest answer, and a rolled date on a signed instrument is a wrong date.
 */
function termEnd(startIso: string | null, months: number | null | undefined): string | null {
  if (!startIso || !months || !Number.isFinite(months) || months <= 0) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startIso.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const target = new Date(Date.UTC(year, month + Math.trunc(months), day));
  if (Number.isNaN(target.getTime())) return null;
  // A rolled month — 31 Jan + 1 month lands on 2 or 3 March — is refused rather than printed.
  if (target.getUTCDate() !== day) return null;
  target.setUTCDate(target.getUTCDate() - 1);
  return target.toISOString().slice(0, 10);
}

/**
 * Every blank either paper can fill, resolved once.
 *
 * THE NEW TERM COMES FROM THE RENEWAL REQUEST WHERE THERE IS ONE, and is derived from the expiring
 * contract where there is not. That order matters and is not a fallback for tidiness: a renewal
 * request carries dates a manager and HR have both reviewed and a decision was taken against, so it
 * is a RECORD; the derivation — the day after the old term, for the same number of months — is a
 * SUGGESTION. Preferring the record means the annex prints the dates somebody actually approved,
 * and the derivation only fills a page being printed ahead of the workflow.
 */
export function buildRenewalValues(
  data: HiringPackData,
  template: RenewalTemplate,
): Partial<Record<RenewalToken, string>> {
  const { employee, profile, terms, renewal } = data;
  const recital = data.company.contractRecital;

  // The expiring contract's own dates — the ones printed on the paper being amended.
  const contractStart = terms.contractStartDate ?? employee.hireDate;
  const contractEnd = terms.contractEndDate ?? termEnd(contractStart, terms.durationMonths);

  // The new term. The request's proposed dates first; the derivation second.
  const newStart = renewal?.proposedStartDate ?? dayAfter(contractEnd);
  const newEnd = renewal?.proposedEndDate ?? termEnd(newStart, terms.durationMonths);

  // The last working day on a NON-RENEWAL is the contract's own end date, and nothing else. It is
  // deliberately NOT `terms.lastWorkingDate`: that is the exit machinery's date, which is set when
  // somebody resigns or is terminated, and this notice exists to say precisely that neither of
  // those happened — the contract is running out on the date it always named. Reading the exit date
  // here would print a resignation's date on a paper whose third paragraph denies there was one.
  const lastWorkingDate = contractEnd;

  // The annex bears the date it is drawn up, which for a paper printed to be signed today IS today.
  // The contract deliberately does the opposite — it is dated by its start date, not by the day the
  // print button was pressed — and the difference is real: a contract's date is a fact about the
  // engagement, while an annex's date is a fact about the signing, and the signing is now. مادة (2)
  // then asserts the annex was signed before the old term expired, which is the whole point of the
  // instrument; HR can overwrite the date on the preview screen when it is signed on another day.
  const annexDate = todayInCairo();

  return {
    // ANNEX_NUMBER is deliberately absent — see the header note. It rules, and a pen fills it.
    ANNEX_DAY_NAME: arabicDayName(annexDate),
    ANNEX_DATE: pinLtr(formatDayMonthYear(annexDate)),

    COMPANY_NAME: data.company.legalNameAr,
    COMPANY_LEGAL_FORM: recital.legalFormAr,
    COMPANY_HEAD_OFFICE_FULL: recital.headOfficeAr,
    COMPANY_CITY: data.company.contractCityAr,
    COMMERCIAL_REGISTER: pinLtr(recital.commercialRegisterNumber),
    COMMERCIAL_REGISTER_OFFICE: recital.commercialRegisterOfficeAr,
    UNIFIED_REGISTER: pinLtr(recital.unifiedRegisterNumber),
    TAX_CARD: pinLtr(recital.taxCardNumber),
    // The same override the contract honours, and it has to be the same or the annex and the
    // contract it amends name two different people as the company's representative.
    CONTRACT_SIGNATORY: profile.contractSignatoryNameAr ?? recital.signatoryNameAr,
    CONTRACT_SIGNATORY_TITLE: profile.contractSignatoryTitleAr ?? recital.signatoryTitleAr,

    // The Arabic name governs, exactly as it does on the contract: the annex is part of an Arabic
    // instrument whose own text is controlling, so the party it names must be the Arabic name.
    EMPLOYEE_NAME: employee.nameAr ?? employee.fullName,
    HR_ID: employee.hrId,
    NATIONAL_ID: employee.nationalId ?? "",
    // ARABIC ONLY — no fallback to the English title off the employee record. Same rule as the
    // contract (owner, 2026-08-31): an English job title on an Arabic instrument is the job the
    // paper binds him to, written in the language the paper says does not govern.
    JOB_TITLE: profile.jobTitleAr ?? "",
    DEPARTMENT: employee.departmentAr ?? "",
    // The territory as the renewal request recorded it. Phoenix's own sales geography is not read
    // here on purpose: `employees.line_id` is the product LINE, which is a different thing from the
    // النطاق الجغرافي this clause assigns, and printing one under the other's label would put a
    // wrong territory on a signed instrument. Absent, it rules.
    TERRITORY: renewal?.areaName ?? "",

    CONTRACT_DATE: pinLtr(formatDayMonthYear(contractStart)),
    CONTRACT_START_DATE: pinLtr(formatDayMonthYear(contractStart)),
    CONTRACT_END_DATE: pinLtr(formatDayMonthYear(contractEnd)),
    ORIGINAL_HIRE_DATE: pinLtr(formatDayMonthYear(employee.hireDate)),

    RENEWAL_DURATION: describeDurationMonths(terms.durationMonths),
    RENEWAL_START_DATE: pinLtr(formatDayMonthYear(newStart)),
    RENEWAL_END_DATE: pinLtr(formatDayMonthYear(newEnd)),
    // WHY THIS POST IS ON A FIXED TERM — Article 87's own requirement, and the sentence that
    // makes the term lawful. Resolved from the code stored on the hiring profile; an absent or
    // unrecognised code prints the dotted rule, which is what this line did for every annex
    // before the owner asked for a dropdown on 2026-09-05. A blank somebody still has to answer
    // is honest; a guessed legal ground would be signed.
    OBJECTIVE_REASON: renewalObjectiveReasonClause(profile.contractObjectiveReasonCode) ?? "",

    // The base salary, not the gross — owner, 2026-08-31, and the same figure مادة (4) of the
    // contract states. An annex that renews on a different number from the one the contract carries
    // would read as a pay change nobody agreed.
    SALARY_FIGURES: formatMoney(employee.baseSalary),
    SALARY_WORDS: spellEgyptianAmount(employee.baseSalary),
    INSURANCE_WAGE: formatMoney(insuranceWageFromBase(employee.baseSalary)),

    NOTICE_DATE: pinLtr(formatDayMonthYear(annexDate)),
    LAST_WORKING_DATE:
      template.variant === "nonRenewal" ? pinLtr(formatDayMonthYear(lastWorkingDate)) : "",
  };
}

/** A value that IS there, marked so the preview screen can offer it for correction. */
function filledMarker(token: string, text: string): string {
  return `<span class="fill" data-hp-key="${escapeHtml(token)}">${escapeHtml(text)}</span>`;
}

/**
 * A value that is NOT there: a run of dots carrying its token.
 *
 * The token travels on the blank as well as on the filled value, deliberately — an empty rule is
 * the single most useful thing to be able to complete from the preview screen, and a blank with no
 * key is a box the fill screen cannot see.
 */
function blankMarker(token: string, rule: string): string {
  return `<span class="rule-line" data-hp-key="${escapeHtml(token)}">${escapeHtml(rule)}</span>`;
}

/** Substitute the blanks in a run of prose, marking each one. */
function fillMarkedHtml(
  template: string,
  values: Partial<Record<RenewalToken, string>>,
): string {
  const pattern = /\{\{([A-Z_]+)\}\}/g;
  let out = "";
  let last = 0;
  let match: RegExpExecArray | null = pattern.exec(template);
  while (match !== null) {
    out += escapeHtml(template.slice(last, match.index));
    const token = match[1];
    const raw = values[token as RenewalToken];
    const text = typeof raw === "string" ? raw.trim() : "";
    out += text.length > 0 ? filledMarker(token, text) : blankMarker(token, RENEWAL_BLANK_RULE);
    last = match.index + match[0].length;
    match = pattern.exec(template);
  }
  return out + escapeHtml(template.slice(last));
}

/**
 * One filled grid value, laid out in the direction its CONTENT needs.
 *
 * `dir="ltr"` on a national ID, an employee code, a date or a money figure is not decoration. Those
 * are runs of Latin digits inside a right-to-left page, and the bidirectional algorithm reorders the
 * groups around them — the defect that once printed this company's own tax card number `477-108-318`
 * as `318-108-477`. Applied PER FIELD and never to the block: `dir="auto"` on a whole line reads
 * only its first strong character, so a line holding an Arabic label and a Latin value would turn
 * wholly one way and render the other half backwards.
 */
function gridValue(
  field: RenewalField,
  values: Partial<Record<RenewalToken, string>>,
): string {
  const raw = field.token ? values[field.token] : undefined;
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text.length === 0) {
    const rule = field.wide ? RENEWAL_BLANK_RULE_WIDE : RENEWAL_BLANK_RULE;
    return field.token
      ? blankMarker(field.token, rule)
      : `<span class="rule-line">${escapeHtml(rule)}</span>`;
  }
  const marked = filledMarker(field.token as string, text);
  return field.ltr ? `<span dir="ltr">${marked}</span>` : marked;
}

/**
 * A labelled grid, two pairs to a row, with a wide field taking the whole row.
 *
 * FOUR COLUMNS, and a wide value spans three of them so its label keeps the same width as every
 * other label on the page. A grid whose label column jumps about between rows reads as two grids.
 */
function identityGrid(
  fields: readonly RenewalField[],
  values: Partial<Record<RenewalToken, string>>,
): string {
  const rows: string[] = [];
  let pending: string[] = [];

  const flush = () => {
    if (pending.length === 0) return;
    // A lone narrow field at the end of the grid still has to fill the row, or the table draws a
    // ragged edge that reads as a missing box rather than as an empty half-row.
    const cells =
      pending.length === 1
        ? pending[0].replace('<td class="doc-ident__value">', '<td class="doc-ident__value" colspan="3">')
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

/** One article row: the numbered label beside the clause, on a hair rule. */
function articleRow(number: string, titleAr: string | null, bodyHtml: string): string {
  const title = titleAr ? `<span class="doc-art__title">${escapeHtml(titleAr)}</span>` : "";
  return `<div class="doc-art">
      <div class="doc-art__label"><span class="doc-art__no">${escapeHtml(number)}</span>${title}</div>
      <div class="doc-art__body">${bodyHtml}</div>
    </div>`;
}

/**
 * The signature block: one ruled row per party, one column per signing field.
 *
 * THE COLUMNS ARE READ OFF THE TEMPLATE, never hard-coded — the same rule the contract's block
 * follows. A version that signs with different fields gets its own columns instead of being forced
 * into these, which is what keeps an archived version reprintable as the paper that was signed.
 */
function signatureTable(columns: readonly RenewalSignatureColumn[]): string {
  const first = columns[0];
  if (!first) return "";
  const head = first.fieldsAr
    .map((label) => `<th class="doc-sig__head">${escapeHtml(label)}</th>`)
    .join("");
  const body = columns
    .map(
      (column) =>
        `<tr><th class="doc-sig__party">${escapeHtml(column.headingAr)}</th>` +
        // NO PRINTED SEAL — owner, 2026-09-29. Every cell is blank; التوقيع والختم is a label
        // telling the signatory where the real stamp goes, not a slot the renderer fills.
        column.fieldsAr.map(() => `<td class="doc-sig__cell"></td>`).join("") +
        "</tr>",
    )
    .join("");
  return `<table class="doc-sig">
      <thead><tr><td class="doc-sig__corner"></td>${head}</tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

/** The two witness pairs on the notice — name and signature, twice. */
function witnessBlock(template: RenewalTemplate): string {
  if (!template.witnessNoteAr && template.witnessFields.length === 0) return "";
  const note = template.witnessNoteAr
    ? `<p class="doc-witness__note">${escapeHtml(template.witnessNoteAr)}</p>`
    : "";
  const cells = template.witnessFields
    .map(
      (field) =>
        `<div class="doc-witness__cell"><span class="doc-witness__label">${escapeHtml(
          field.labelAr,
        )}</span><span class="rule-line">${escapeHtml(RENEWAL_BLANK_RULE)}</span></div>`,
    )
    .join("");
  return `<section class="doc-witness">${note}<div class="doc-witness__grid">${cells}</div></section>`;
}

/** One printed copy. */
function renderCopy(
  template: RenewalTemplate,
  values: Partial<Record<RenewalToken, string>>,
  // The letterhead names the company in both languages, and only one of those is a document
  // TOKEN — so the resolved record is passed rather than read from the module, which is what
  // makes the masthead follow an edited company name instead of the compiled one.
  company: CompanyDetails,
): string {
  const heading = (text: string | null) =>
    text ? `<h2 class="doc-head">${escapeHtml(text)}</h2>` : "";

  const binding = template.bindingLineAr
    ? `<p class="doc-binding">${fillMarkedHtml(template.bindingLineAr, values)}</p>`
    : "";

  const recital = template.firstPartyLinesAr
    .map((text) => `<p class="doc-recital">${fillMarkedHtml(text, values)}</p>`)
    .join("");

  const preamble = template.preambleAr
    ? `<p class="doc-recital doc-recital--preamble">${fillMarkedHtml(template.preambleAr, values)}</p>`
    : "";

  const articles = template.articles.length
    ? `<div class="doc-arts">${template.articles
        .map((article) =>
          articleRow(article.number, article.titleAr, fillMarkedHtml(article.body, values)),
        )
        .join("")}</div>`
    : "";

  const paragraphs = template.bodyParagraphsAr
    .map((text) => `<p class="doc-para">${fillMarkedHtml(text, values)}</p>`)
    .join("");

  const termsGrid = template.termsFields.length
    ? `${heading(template.termsHeadingAr)}${identityGrid(template.termsFields, values)}`
    : "";

  // Who signs for the company, on ONE row under the signature table. The parts stay separate
  // strings — the version file states the name and the capacity as two facts — so no punctuation of
  // this layout's invention ends up inside text that belongs to the instrument.
  const signNote = template.signatoryNoteLinesAr.length
    ? `<p class="doc-signnote">${template.signatoryNoteLinesAr
        .map((text) => `<span>${fillMarkedHtml(text, values)}</span>`)
        .join("")}</p>`
    : "";

  // Deliberately NOT token-filled: the line exists to be signed by hand, and marking it would flag
  // a pen rule as a blank Phoenix ought to have filled.
  const receipt = template.receiptAcknowledgmentAr
    ? `<p class="doc-receipt">${escapeHtml(template.receiptAcknowledgmentAr)} <span class="rule-line">${escapeHtml(
        RENEWAL_BLANK_RULE_WIDE,
      )}</span></p>`
    : "";

  const foot = `<tfoot><tr><td class="doc-foot"><div class="doc-foot__row">${template.footerAr
    .split(/ {2,}/u)
    .map((part) => `<span>${escapeHtml(part)}</span>`)
    .join("")}</div></td></tr></tfoot>`;

  return `<article class="copy copy--document">
    <table class="doc-sheet">
      <thead><tr><td class="doc-mastcell">
        <header class="doc-mast">
          <span class="doc-mast__side doc-mast__id">
            <strong>${escapeHtml(company.legalNameAr)}</strong>
            <span dir="ltr">${escapeHtml(company.legalNameEn)}</span>
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
        ${identityGrid(template.secondPartyFields, values)}
        ${heading(template.preambleHeadingAr)}
        ${preamble}
        ${paragraphs}
        ${articles}
        ${termsGrid}
        ${heading(template.signaturesHeadingAr)}
        ${signatureTable(template.signatureColumns)}
        ${signNote}
        ${receipt}
        ${witnessBlock(template)}
      </td></tr></tbody>
      ${foot}
    </table>
  </article>`;
}

/**
 * The printable paper.
 *
 * `fallback` is the document ASKED FOR — the annex or the notice — and `requestedTemplateId` is an
 * explicit archived version, which only the Archive screen ever passes. The requested id is honoured
 * only when it is a version of the SAME paper: a renewal print carrying the notice's id is a caller
 * error, and answering it would hand somebody a non-renewal notice when they asked to renew a
 * contract. Falling back rather than throwing is deliberate — the print route validates the id
 * against the registry before it reaches here, so anything that gets this far is already known-good
 * and a stack trace would only lose somebody their document.
 */
function renderRenewal(
  data: HiringPackData,
  copies: number,
  requestedTemplateId: string | null | undefined,
  fallback: RenewalTemplate,
  fields: readonly DocumentFieldRow[],
): string {
  const requested = renewalTemplateById(requestedTemplateId);
  const template = requested && requested.variant === fallback.variant ? requested : fallback;
  const values = buildRenewalValues(data, template);
  const total = Math.max(1, copies);
  const body = Array.from({ length: total }, () =>
    renderCopy(template, values, data.company),
  ).join("\n");
  const employeeName = data.employee.nameAr ?? data.employee.fullName;

  const banner =
    template.variant === "renewal"
      ? [
          `${employeeName} — annual renewal annex, ${total} ${total === 1 ? "copy" : "copies"}.`,
          "The annex number and the objective reason for the fixed term print blank by design — the number comes from the company's own register, and the reason is a legal judgement about this post under مادة (87).",
          "SIGN IT BEFORE THE CURRENT TERM EXPIRES. Under مادة (88) of Law 14/2025 a fixed-term contract the parties keep performing after expiry, with no written agreement, is treated as indefinite from the day it was made.",
        ]
      : [
          `${employeeName} — non-renewal notice, ${total} ${total === 1 ? "copy" : "copies"}.`,
          "Hand it over before the term ends and take the employee's signature on the company's copy. If he will not sign, the witness block at the foot is the record.",
          "This is not a dismissal and the notice says so — the contract simply expires on the date it always named.",
        ];

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
  /* 🔴 KEEP THE ZEBRA BANDS WHEN A BROWSER PRINTS — see the same note in render-hr-paper.ts.
     Chrome's "Background graphics" is unticked by default and every tint here is a background, so
     Print dropped them while the saved PDF kept them. The renewal pair keep their own stylesheet
     rather than importing HOUSE_IDENTITY_CSS, so the line has to be here too.

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
  /* Each copy starts its own sheet — they are signed separately and must be identical. */
  .copy + .copy { page-break-before: always; break-before: page; }

  /* ── the contract's own document layout, matched exactly ──────────────────────────────────────
     Two blues and one hairline grey, and nothing else is coloured: no panel, no band, no highlight.
     Everything separating one part from another is a RULE, which is why this prints correctly
     whether or not the browser's "Background graphics" box is ticked. The one filled element is the
     zebra on the identity grid — the owner's single stated exception to the ink rule.
     SQUARE EDGES THROUGHOUT: every corner on this page is square, per the owner's rule of
     2026-09-04, and testBothPapersRenderCompletely greps the emitted CSS to prove it. Note it
     greps for the PROPERTY NAME, so do not write that name here even to say it is absent — the
     comment ships inside the stylesheet and the test cannot tell a comment from a declaration.
     NO BACKTICKS IN THIS BLOCK EITHER — it is inside a template literal, and one ends the string. */
  .copy--document {
    padding: 10.7mm 10.2mm 12.7mm;
  }
  .doc-sheet { width: 100%; border-collapse: collapse; }
  .doc-mastcell, .doc-body { padding: 0; vertical-align: top; }

  .doc-mast {
    display: flex;
    align-items: center;
    gap: 4mm;
    margin-bottom: 2.5mm;
    padding-bottom: 3.3mm;
    /* THE BRAND RULE, now the engine-turned band — the one element on every house document. Taken
       from houseBandBackground() rather than re-typed: this is the FOURTH masthead in the codebase,
       and testTheMastheadStillMatchesTheContractItAmends exists because they drift. */
    background: ${houseBandBackground("left bottom")};
  }
  .doc-mast__side { flex: 0 0 34mm; }
  .doc-mast__id { text-align: right; color: ${HOUSE_COLORS.muted}; font-size: 6.5pt; line-height: 1.5; }
  .doc-mast__id strong { display: block; color: ${HOUSE_COLORS.deep}; font-size: 8pt; font-weight: 700; }
  .doc-mast__mark { display: flex; justify-content: flex-start; }
  .doc-mast__mark img { width: 100%; max-width: 30mm; height: auto; }
  .doc-mast__title { flex: 1 1 auto; text-align: center; }
  .doc-mast__title strong { display: block; color: ${HOUSE_COLORS.deep}; font-size: 13pt; font-weight: 700; }
  .doc-mast__title em {
    display: block;
    margin-top: 1mm;
    color: #5b6b7a;
    font-size: 8pt;
    font-style: normal;
    font-weight: 600;
  }

  /* Who keeps this copy — ruled, never filled. It is the one line that stops the employee's copy
     and the company's copy being confused, so it gets its own band rather than a footnote. */
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

  /* The line that binds the annex to its contract. It sits above everything, because an annex read
     without its contract is the one way this instrument can be misread. */
  .doc-binding {
    margin: 0 0 2mm;
    padding: 1.6mm 2.5mm;
    border: 0.5pt solid ${HOUSE_COLORS.light};
    color: ${HOUSE_COLORS.deep};
    font-weight: 700;
    text-align: center;
  }

  .doc-recital { margin: 0; text-align: justify; orphans: 3; widows: 3; }
  .doc-recital--preamble { margin-top: 0.5mm; }
  .doc-para { margin: 0 0 2mm; text-align: justify; orphans: 3; widows: 3; }
  .doc-para:last-of-type { margin-bottom: 0; }

  .doc-ident { width: 100%; margin-top: 0.5mm; border-collapse: collapse; table-layout: fixed; }
  .doc-ident th, .doc-ident td {
    padding: 1.1mm 2mm;
    border: 0.5pt solid #cfdce7;
    font-size: 8.5pt;
    text-align: right;
    vertical-align: middle;
  }
  .doc-ident__label { width: 32mm; color: ${HOUSE_COLORS.deep}; font-weight: 700; }
  /* The zebra, at 6% of Brand Blue — the owner's one stated exception to the ink rule. */
  .doc-ident tbody tr:nth-child(even) th,
  .doc-ident tbody tr:nth-child(even) td { background: ${HOUSE_COLORS.tint}; }

  .doc-arts { margin-top: 1mm; }
  .doc-art {
    display: flex;
    align-items: flex-start;
    gap: 3mm;
    padding: 1.2mm 0;
    border-top: 0.5pt solid #dce6ee;
    orphans: 3;
    widows: 3;
  }
  .doc-art:first-child { border-top: 0; }
  .doc-art__label { flex: 0 0 34mm; text-align: right; }
  .doc-art__no { display: block; color: ${HOUSE_COLORS.deep}; font-size: 9pt; font-weight: 700; }
  .doc-art__title {
    display: block;
    color: #0f6ea8;
    font-size: 8pt;
    font-weight: 700;
    line-height: 1.25;
  }
  .doc-art__body { flex: 1 1 auto; text-align: justify; }

  .doc-sig {
    width: 100%;
    margin-top: 0.5mm;
    border-collapse: collapse;
    table-layout: fixed;
    /* The parties must sign a sheet that carries the instrument above it. */
    break-inside: avoid;
    page-break-inside: avoid;
  }
  .doc-sig th, .doc-sig td { padding: 1.2mm 2mm; border: 0.5pt solid #b9cad9; font-size: 8.5pt; }
  .doc-sig__corner { width: 34mm; }
  .doc-sig__head { color: ${HOUSE_COLORS.deep}; font-weight: 700; text-align: center; }
  .doc-sig__party { font-weight: 700; text-align: right; vertical-align: middle; color: ${HOUSE_COLORS.deep}; }
  .doc-sig tbody tr:nth-child(even) th,
  .doc-sig tbody tr:nth-child(even) td { background: ${HOUSE_COLORS.tint}; }
  /* Room for a pen. The cell IS the blank. */
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

  /* The refusal-to-sign protocol on the notice. It must stay whole and stay with the signatures:
     it is the record that the notice was served on somebody who would not acknowledge it. */
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

  /* A typed value is set one weight heavier so it can be told from the standing clause — no
     highlight, because a legal instrument that arrives at a signing table with coloured boxes on it
     reads as a draft. The data-hp-key on each is untouched: that, not the colour, is what the
     preview screen corrects through. */
  .fill { padding: 0; background: none; color: inherit; font-weight: 700; }
  .rule-line { color: #91a4b7; letter-spacing: 0.2mm; }

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

/** The annual renewal annex — ملحق تجديد سنوي. */
export function renderContractRenewalHtml(
  data: HiringPackData,
  copies: number,
  templateId?: string | null,
  fields: readonly DocumentFieldRow[] = [],
): string {
  return renderRenewal(data, copies, templateId, RENEWAL_ANNEX_V1, fields);
}

/** The non-renewal notice — إخطار بعدم تجديد. */
export function renderContractNonRenewalHtml(
  data: HiringPackData,
  copies: number,
  templateId?: string | null,
  fields: readonly DocumentFieldRow[] = [],
): string {
  return renderRenewal(data, copies, templateId, NON_RENEWAL_NOTICE_V1, fields);
}
