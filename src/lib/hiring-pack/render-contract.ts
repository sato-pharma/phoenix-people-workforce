import { systemLegalEntity } from "@/config/system-settings";
import { spellEgyptianAmount } from "@/lib/hiring-pack/arabic-amount";
import {
  CONTRACT_BLANK_RULE,
  fillContractTokens,
  type ContractTemplate,
  type ContractToken,
} from "@/lib/hiring-pack/contract-template";
import { resolveContractTemplate } from "@/lib/hiring-pack/contract-text";
import { insuranceWageFromBase } from "@/lib/hiring-pack/insurance-wage";
import {
  arabicDayName,
  ARABIC_FONT_STACK,
  describeDurationMonths,
  escapeHtml,
  formatDayMonthYear,
  pinLtr,
  PRINT_BANNER_CSS,
  printBanner,
  resolvePermanentAddress,
} from "@/lib/hiring-pack/render-shared";
import type { HiringPackData } from "@/lib/hiring-pack/types";
import { resolveNationality } from "@/lib/hiring-pack/nationality";

// The employment contract, laid out for A4 and printed by the browser.
//
// UNLIKE FORM 1 THERE IS NO ARTWORK. Form 1 is a government document whose boxes have to match a
// printed original an insurance office recognises by sight; this contract is our own instrument, so
// it is typeset from its text rather than positioned over a scan. That also means it reflows: a
// longer name or a longer salary in words pushes the following text down instead of colliding with
// a fixed box.
//
// SINGLE-SIDED, FOUR COPIES — the owner's instruction. The four copies are laid out one after the
// other with a forced break between them, so the dialog's copy count stays at 1. They are four
// identical originals, all of which get signed; none of them is marked as a copy, because writing
// "copy 2 of 4" on a signed instrument would suggest three of them are duplicates when all four
// carry an original signature.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THREE LAYOUTS, ONE RENDERER. Since 2026-08-30 there is more than one version of the contract:
// the current one (`document` — the owner's own Word typesetting, a white page with a repeating
// letterhead and headings over hair rules) and the two it succeeded (`banded` — a navy title panel,
// blue party bands and a zebra article grid; `prose` — a run-in opening sentence and a continuous
// flow). All three are rendered here, by the same code, on purpose. A renderer per version means the
// archived ones are never exercised until the day somebody reprints a contract signed against one,
// which is the worst possible moment to discover it no longer works.
//
// `banded` IS NOT DEAD CODE — a contract in production was signed against version 2 and reprints
// through it. Nothing that is signed uses `prose`, but it stays for the same reason: a version is
// archived, never deleted.
//
// The prose path below is the behaviour that shipped with version 1, deliberately left alone. An
// archived contract has to reproduce as the document that was signed, so "improving" how it renders
// is not an improvement — it is a change to the record.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A money figure in the form the contract prints it: digits only — مادة (2) supplies "جنيه".
 *
 * Piastres print as two digits or not at all. "12,750.5" on a salary clause is the kind of figure
 * that gets read as five piastres by one party and fifty by the other, and مادة (2) prints the same
 * amount again in words directly beside it, so the two have to agree exactly.
 */
function formatMoney(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "";
  const hasPiastres = Math.round(value * 100) % 100 !== 0;
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: hasPiastres ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(value);
}

/**
 * Every blank in the contract, resolved once — for every version at the same time.
 *
 * WATCH THE UNITS. Three of these tokens sit inside a sentence that already prints the unit, so the
 * value must be bare: مادة (2) writes "({{SALARY_FIGURES}}) جنيه", and مادة (10) writes
 * "({{UNDERPERFORMANCE_PCT}} %)" and "({{UNDERPERFORMANCE_MONTHS}}) شهرًا متتالية". Passing
 * "3 أشهر" into the last of those would print "3 أشهر شهرًا متتالية". The two tokens that carry no
 * printed unit — مادة (4)'s DURATION and مادة (14)'s TRAINING_BOND — take the spelled-out phrase.
 *
 * PROBATION IS NOT A TOKEN. مادة (4) states "مدة الثلاثة أشهر الأولى تحت الاختبار" verbatim, so a
 * probation period other than three months cannot be expressed by filling a blank — it would need
 * the clause itself rewritten, which is a legal change and not a rendering one.
 *
 * THE FOUR PAIRED TOKENS ARE NOT DUPLICATES. `COMPANY_HEAD_OFFICE` / `COMPANY_HEAD_OFFICE_FULL` and
 * `RESPONSIBLE_MANAGER*` / `CONTRACT_SIGNATORY*` hold the same two facts in the two forms the two
 * contract versions state them in. Both are filled here whichever version is printing, because a
 * version only ever reads its own — and collapsing them would let today's wording reach a contract
 * somebody signed under the old one.
 */
function buildContractValues(data: HiringPackData): Partial<Record<ContractToken, string>> {
  const { employee, profile, terms } = data;
  const recital = systemLegalEntity.contractRecital;

  // The date the instrument bears. Deliberately NOT "today": a contract dated by whatever day the
  // print button happened to be pressed is a wrong date on a legal document, and a visible run of
  // dots for HR to complete by hand is the better failure.
  const contractDate = terms.contractStartDate ?? employee.hireDate;

  return {
    DAY_NAME: arabicDayName(contractDate),
    CONTRACT_DATE: pinLtr(formatDayMonthYear(contractDate)),

    COMPANY_NAME: systemLegalEntity.legalNameAr,
    COMPANY_HEAD_OFFICE: systemLegalEntity.headOfficeAr,
    COMPANY_CITY: systemLegalEntity.contractCityAr,
    RESPONSIBLE_MANAGER: systemLegalEntity.responsibleManagerAr,
    RESPONSIBLE_MANAGER_TITLE: systemLegalEntity.responsibleManagerTitleAr,

    COMPANY_LEGAL_FORM: recital.legalFormAr,
    COMPANY_HEAD_OFFICE_FULL: recital.headOfficeAr,
    COMPANY_BRANCH_REGISTRY: recital.branchRegistryAr,
    COMMERCIAL_REGISTER: pinLtr(recital.commercialRegisterNumber),
    COMMERCIAL_REGISTER_OFFICE: recital.commercialRegisterOfficeAr,
    UNIFIED_REGISTER: pinLtr(recital.unifiedRegisterNumber),
    TAX_CARD: pinLtr(recital.taxCardNumber),
    CONTRACT_SIGNATORY: recital.signatoryNameAr,
    CONTRACT_SIGNATORY_TITLE: recital.signatoryTitleAr,

    // The Arabic name governs: مادة (18) makes the Arabic text controlling, so the party named in
    // it has to be the Arabic name wherever the record carries one.
    EMPLOYEE_NAME: employee.nameAr ?? employee.fullName,
    NATIONALITY: resolveNationality(profile.nationality, employee).value,
    QUALIFICATION: profile.qualification ?? "",
    BIRTH_DATE: pinLtr(formatDayMonthYear(employee.birthDate)),
    BIRTH_PLACE: profile.birthPlace ?? "",
    NATIONAL_ID: employee.nationalId ?? "",
    INSURANCE_NUMBER: employee.socialInsuranceNumber ?? "",
    ADDRESS: resolvePermanentAddress({
      addressBuilding: data.profile.addressBuilding,
      addressStreet: data.profile.addressStreet,
      residenceAddress: data.employee.residenceAddress,
      residenceCity: data.employee.residenceCity,
    }),
    PHONE: employee.mobileNumber ?? "",
    EMAIL: employee.workEmail ?? "",

    // ARABIC ONLY — no fallback to `employee.jobTitle`, which is the English title off the employee
    // record ("Medical Rep", "District Manager"). مادة (18) makes the Arabic text controlling, so an
    // English title in مادة (1) is not a cosmetic blemish: it is the job the contract binds him to,
    // written in the language the contract says does not govern. Owner, 2026-08-31: the job title
    // must be written in the contract in Arabic, not English. Missing prints the dotted rule and the
    // fill screen already flags `jobTitleAr` as a required field, which is the better failure.
    JOB_TITLE: profile.jobTitleAr ?? "",
    DEPARTMENT: employee.departmentAr ?? "",

    // The base salary, not the gross — owner, 2026-08-31. Gross carries the allowances on top, so
    // printing it here committed the company in مادة (2) to about 1.29× the salary it meant.
    SALARY_FIGURES: formatMoney(employee.baseSalary),
    SALARY_WORDS: spellEgyptianAmount(employee.baseSalary),
    INSURANCE_WAGE: formatMoney(insuranceWageFromBase(employee.baseSalary)),

    DURATION: describeDurationMonths(terms.durationMonths),
    START_DATE: pinLtr(formatDayMonthYear(terms.contractStartDate ?? employee.hireDate)),

    UNDERPERFORMANCE_PCT: String(terms.underperformanceThresholdPct),
    UNDERPERFORMANCE_MONTHS: String(terms.underperformanceMonths),
    TRAINING_BOND: describeDurationMonths(terms.trainingBondMonths),
  };
}

/**
 * Escape a filled line, keeping the double spaces the source text uses to separate fields.
 *
 * The party lines read "الاسم: (…)  الجنسية: (…)" — the gap is what tells the eye where one field
 * ends. HTML collapses runs of whitespace, so each pair becomes one hard space plus one ordinary
 * one: the gap survives, and the line can still wrap.
 */
function line(text: string): string {
  return escapeHtml(text).replace(/ {2}/g, "&nbsp; ");
}

/** "الرقم التأميني: (123456789)" — a label and the value in brackets that belongs to it. */
const LABELLED_FIELD = /^(.*?:)[  ]*(\([^()]*\))/u;

/** Longest label+value pair kept unbreakable. Past this a hard line is worse than a wrap. */
const MAX_UNBREAKABLE = 44;

/**
 * A party line, with each "label: (value)" pair held together on one line.
 *
 * The identity block is the one place in the contract where a wrap actually costs something: left
 * alone, "الرقم التأميني:" ends a line and its number starts the next one, and a reader checking an
 * ID against a passport has to join them up by eye. The source separates fields with a double
 * space, so that is what the pairs are split on.
 */
function partyLine(text: string): string {
  return text
    .split(/ {2,}/u)
    .map((chunk) => {
      const match = LABELLED_FIELD.exec(chunk);
      if (!match || match[0].length > MAX_UNBREAKABLE) return escapeHtml(chunk);
      return `<span class="field">${escapeHtml(match[1])}&nbsp;${escapeHtml(
        match[2],
      )}</span>${escapeHtml(chunk.slice(match[0].length))}`;
    })
    .join("&nbsp; ");
}

/**
 * Fill a line and MARK what was filled, the way the source document marks it.
 *
 * The Word original prints every blank on a pale amber highlight. That is not decoration: it is how
 * a reader tells, at a glance, which words are the standing legal text and which were written in
 * for this person. Phoenix types those values instead of leaving them for a pen, so keeping the
 * highlight is what preserves the distinction — and a value that is still missing keeps both the
 * highlight and the dotted rule, which makes an incomplete contract obvious from across a desk
 * rather than something found by reading all four pages.
 *
 * Used by the banded layout only. The prose layout keeps the plain substitution it shipped with,
 * because an archived contract must reproduce as the document that was signed.
 *
 * EACH FILLED SPAN CARRIES ITS TOKEN as `data-hp-key`, which is what lets the preview screen offer
 * that value for correction on the page itself. A data attribute is inert in print and changes
 * nothing about the rendered document. Note this is a property of the BANDED layout only, for the
 * same archive reason as the highlight above: the prose layout substitutes into plain text with no
 * element to hang an attribute on, and introducing one would alter a document already signed.
 */
function fillMarkedHtml(template: string, values: Partial<Record<ContractToken, string>>): string {
  const pattern = /\{\{([A-Z_]+)\}\}/g;
  let out = "";
  let last = 0;
  let match: RegExpExecArray | null = pattern.exec(template);
  while (match !== null) {
    out += line(template.slice(last, match.index));
    const token = match[1];
    const raw = values[token as ContractToken];
    const text = typeof raw === "string" ? raw.trim() : "";
    const key = ` data-hp-key="${escapeHtml(token)}"`;
    out +=
      text.length > 0
        ? `<span class="fill"${key}>${escapeHtml(text)}</span>`
        : `<span class="fill fill--blank"${key}>${CONTRACT_BLANK_RULE}</span>`;
    last = match.index + match[0].length;
    match = pattern.exec(template);
  }
  return out + line(template.slice(last));
}

/**
 * A party line for the banded layout: fill-marked, with each "label: ( value )" pair unbreakable.
 *
 * `partyLine` does the binding and `fillMarkedHtml` does the amber marking, and the party rows need
 * both — so this is the one place they meet. It cannot simply call `partyLine`, because that escapes
 * plain text and would print the marking spans as literal angle brackets.
 *
 * The pair is measured on the FILLED string, never on the template: `{{NATIONAL_ID}}` is 17
 * characters and the number it stands for is 14, so measuring the template would judge the wrong
 * line, and a missing value expands to the dotted rule, which is longer than either. A chunk is
 * bound only when it is ENTIRELY one pair — a chunk that carries trailing prose is left wrappable,
 * since binding it would push a whole sentence onto the next line to keep a label with its value.
 */
function markedPartyLine(
  template: string,
  values: Partial<Record<ContractToken, string>>,
): string {
  return template
    .split(/ {2,}/u)
    .map((chunk) => {
      const html = fillMarkedHtml(chunk, values);
      const filled = fillContractTokens(chunk, values).trim();
      const match = LABELLED_FIELD.exec(filled);
      if (!match || match[0].length !== filled.length || filled.length > MAX_UNBREAKABLE) {
        return html;
      }
      return `<span class="field">${html}</span>`;
    })
    .join("&nbsp; ");
}

/** Version 1's layout: a run-in opening, numbered parties, articles in a continuous flow. */
function renderProseCopy(
  template: ContractTemplate,
  values: Partial<Record<ContractToken, string>>,
): string {
  const parties = [...template.firstPartyLinesAr, ...template.secondPartyLinesAr]
    .map((part) => `<p class="party">${partyLine(fillContractTokens(part, values))}</p>`)
    .join("");

  const articles = template.articles
    .map(
      (article) =>
        `<p class="article"><span class="article__number">${escapeHtml(
          article.number,
        )}</span> ${line(fillContractTokens(article.body, values))}</p>`,
    )
    .join("");

  const signatures = template.signatureColumns
    .map(
      (column) =>
        `<div class="sign__column">
        <p class="sign__role">${escapeHtml(column.headingAr)}</p>
        <p class="sign__rule"></p>
        <p class="sign__hint">الاسم والتوقيع</p>
      </div>`,
    )
    .join("");

  const opening = template.openingAr
    ? `<p class="opening">${line(fillContractTokens(template.openingAr, values))}</p>`
    : "";

  return `<article class="copy copy--prose">
    <h1 class="title">${escapeHtml(template.titleAr)}</h1>
    <p class="subtitle">${escapeHtml(template.subtitleAr)}</p>

    ${opening}
    ${parties}

    <h2 class="heading">${escapeHtml(template.preambleHeadingAr)}</h2>
    <p class="preamble">${line(fillContractTokens(template.preambleAr, values))}</p>

    ${articles}

    <div class="sign">${signatures}</div>
  </article>`;
}

/** One row of the article grid — the label column, then the clause. */
function articleRow(number: string, titleAr: string | null, bodyHtml: string): string {
  const title = titleAr ? `<span class="grid__title">${escapeHtml(titleAr)}</span>` : "";
  return `<div class="grid__row">
      <div class="grid__label"><span class="grid__number">${escapeHtml(number)}</span>${title}</div>
      <div class="grid__body">${bodyHtml}</div>
    </div>`;
}

/** Version 2's layout: a navy title panel, blue party bands, and the articles as a bordered grid. */
function renderBandedCopy(
  template: ContractTemplate,
  values: Partial<Record<ContractToken, string>>,
): string {
  const partyBlock = (heading: string | null, lines: readonly string[]) =>
    (heading ? `<p class="band">${escapeHtml(heading)}</p>` : "") +
    lines
      .map(
        (text, index) =>
          `<p class="row ${index % 2 === 0 ? "row--even" : "row--odd"}">${markedPartyLine(
            text,
            values,
          )}</p>`,
      )
      .join("");

  const rows = [
    articleRow(template.preambleHeadingAr, null, fillMarkedHtml(template.preambleAr, values)),
    ...template.articles.map((article) =>
      articleRow(article.number, article.titleAr, fillMarkedHtml(article.body, values)),
    ),
  ].join("");

  const closing = template.closingAr
    ? `<p class="closing">${fillMarkedHtml(template.closingAr, values)}</p>`
    : "";

  const signatures = template.signatureColumns
    .map(
      (column) =>
        `<div class="signcol">
        <p class="signcol__head">${escapeHtml(column.headingAr)}</p>
        <div class="signcol__body">${column.fieldsAr
          .map((field) => `<p class="signcol__field">${fillMarkedHtml(field, values)}</p>`)
          .join("")}</div>
      </div>`,
    )
    .join("");

  // The running footer rides in a <tfoot>. That is the ONE technique Chrome actually repeats on
  // every printed page — `@page` margin boxes are unimplemented, and a `position: fixed` footer can
  // overlap the text it is meant to sit below, which on a legal instrument is not a cosmetic bug.
  const footer = template.footerAr
    ? `<tfoot><tr><td class="sheet__foot">${line(
        fillContractTokens(template.footerAr, values),
      )}</td></tr></tfoot>`
    : "";

  return `<article class="copy copy--banded">
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

        <section class="parties">
          ${partyBlock(template.firstPartyHeadingAr, template.firstPartyLinesAr)}
          ${partyBlock(template.secondPartyHeadingAr, template.secondPartyLinesAr)}
        </section>

        <section class="grid">${rows}</section>

        ${closing}

        <section class="sign2">${signatures}</section>
      </td></tr></tbody>
      ${footer}
    </table>
  </article>`;
}

/**
 * Split "label<sep>value" once, and unwrap the brackets the source uses to stand in for a box.
 *
 * The contract text writes a blank as "الجنسية: ( {{NATIONALITY}} )" because in a flowing paragraph
 * the brackets ARE the box. The document layout draws a real one, so keeping them would draw the
 * box twice. Returns null when the chunk carries no separator, which is the caller's signal to
 * print it whole rather than guess at it.
 */
function splitLabelled(
  chunk: string,
  separator: string,
): { label: string; value: string } | null {
  const at = chunk.indexOf(separator);
  if (at < 0) return null;
  const label = chunk.slice(0, at).trim();
  let value = chunk.slice(at + separator.length).trim();
  if (value.startsWith("(") && value.endsWith(")")) value = value.slice(1, -1).trim();
  return label.length > 0 ? { label, value } : null;
}

/**
 * A value that is nothing but a pen rule — dots, an ellipsis, or tatweel.
 *
 * In a flowing line those characters are the blank. Inside a ruled cell the CELL is the blank, and
 * printing both gives a box with a row of dots stranded at the top of it.
 */
const PEN_BLANK = /^[.…ـ\s]*$/u;

/**
 * The second party's identity block as the source draws it: a ruled grid, two label/value pairs to
 * a row, and a row carrying a single pair spanned across the rest.
 *
 * The pairs come from the same double-space convention the banded layout splits on, so one string
 * in the version file serves both layouts and neither needs its own copy of the identity fields.
 */
function documentIdentityGrid(
  lines: readonly string[],
  values: Partial<Record<ContractToken, string>>,
): string {
  const rows = lines
    .map((text) => {
      const chunks = text.split(/ {2,}/u);
      const pairs = chunks.map((chunk) => splitLabelled(chunk, ":"));
      if (pairs.some((pair) => pair === null) || pairs.length === 0) {
        // Unreadable as pairs — print the line whole. A dropped identity field on a contract is
        // far worse than one row that does not sit in the grid.
        return `<tr><td class="doc-ident__value" colspan="4">${markedPartyLine(text, values)}</td></tr>`;
      }
      const cells = pairs
        .map((pair) => {
          const { label, value } = pair as { label: string; value: string };
          const span = pairs.length === 1 ? ' colspan="3"' : "";
          return (
            `<th class="doc-ident__label">${escapeHtml(label)}</th>` +
            `<td class="doc-ident__value"${span}>${fillMarkedHtml(value, values)}</td>`
          );
        })
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");
  return `<table class="doc-ident">${rows}</table>`;
}

/**
 * The signature block as the source draws it: one ruled row per party, one column per signing field.
 *
 * THE COLUMNS ARE READ OFF THE TEMPLATE, never hard-coded. Each signature field is written
 * "التاريخ / ……" — label, separator, blank — so the column set is the labels in the order the
 * parties state them, and the leading column carries the party itself. A version that signs with
 * different fields therefore gets its own columns instead of being forced into these.
 */
function documentSignatureTable(
  columns: ContractTemplate["signatureColumns"],
  values: Partial<Record<ContractToken, string>>,
): string {
  const labels: string[] = [];
  for (const column of columns) {
    for (const field of column.fieldsAr) {
      const pair = splitLabelled(field, " / ");
      if (pair !== null && !labels.includes(pair.label)) labels.push(pair.label);
    }
  }

  const head =
    `<tr><th class="doc-sig__corner"></th>` +
    labels.map((label) => `<th class="doc-sig__head">${escapeHtml(label)}</th>`).join("") +
    `</tr>`;

  const body = columns
    .map((column) => {
      const byLabel = new Map<string, string>();
      for (const field of column.fieldsAr) {
        const pair = splitLabelled(field, " / ");
        if (pair !== null) byLabel.set(pair.label, pair.value);
      }
      const cells = labels
        .map((label) => {
          const field = byLabel.get(label);
          const filled = field === undefined ? "" : fillContractTokens(field, values);
          const html =
            field === undefined || PEN_BLANK.test(filled) ? "" : fillMarkedHtml(field, values);
          return `<td class="doc-sig__cell">${html}</td>`;
        })
        .join("");
      return `<tr><th class="doc-sig__party">${escapeHtml(column.headingAr)}</th>${cells}</tr>`;
    })
    .join("");

  return `<table class="doc-sig"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

/** One article of the document layout: the numbered label beside the clause, on a hair rule. */
function documentArticleRow(number: string, titleAr: string | null, bodyHtml: string): string {
  const title = titleAr ? `<span class="doc-art__title">${escapeHtml(titleAr)}</span>` : "";
  return `<div class="doc-art">
      <div class="doc-art__label"><span class="doc-art__no">${escapeHtml(number)}</span>${title}</div>
      <div class="doc-art__body">${bodyHtml}</div>
    </div>`;
}

/**
 * Version 3's layout: the owner's own Word typesetting.
 *
 * WHAT MAKES THIS DIFFERENT FROM `banded`, AND WHY. The banded layout was read off an earlier Word
 * file that used filled panels and a highlight on every blank. This one is read off the file the
 * owner supplied on 2026-09-03, and it is the opposite: a white page, the mark on a light ground,
 * headings as blue text over a hair rule, and nothing shaded or highlighted at all. That last point
 * is not a preference — a contract that prints with a coloured background on every typed value
 * looks like a draft, and it goes to a signing table.
 *
 * THE LETTERHEAD AND THE SIGNING RULE REPEAT ON EVERY PAGE, because they do in the source: Word
 * carries them in its header and footer parts. `<thead>` and `<tfoot>` on the outer table are the
 * only technique Chrome actually repeats across a page break — `@page` margin boxes are
 * unimplemented — so both ride there. See the version file for the one thing that cannot follow:
 * "صفحة N من M" has no mechanism in a browser at all.
 */
function renderDocumentCopy(
  template: ContractTemplate,
  values: Partial<Record<ContractToken, string>>,
): string {
  const heading = (text: string | null) =>
    text ? `<h2 class="doc-head">${escapeHtml(text)}</h2>` : "";

  const opening = template.openingAr
    ? `<p class="doc-recital">${fillMarkedHtml(template.openingAr, values)}</p>`
    : "";

  // Rendered as consecutive zero-margin paragraphs, which is what the source's single justified
  // recital paragraph looks like. Joining the strings instead would bake this layout's punctuation
  // into text that belongs to the version file.
  const recital = template.firstPartyLinesAr
    .map((text) => `<p class="doc-recital">${fillMarkedHtml(text, values)}</p>`)
    .join("");

  const articles = template.articles
    .map((article) =>
      documentArticleRow(article.number, article.titleAr, fillMarkedHtml(article.body, values)),
    )
    .join("");

  const closing = template.closingAr
    ? `<p class="doc-closing">${fillMarkedHtml(template.closingAr, values)}</p>`
    : "";

  // The footer's halves are separated in the source by a long run of spaces — one signing rule at
  // each margin. Splitting on that run and spreading the parts reproduces it without this layout
  // needing to know what the parts say.
  const foot = template.footerAr
    ? `<tfoot><tr><td class="doc-foot"><div class="doc-foot__row">${fillContractTokens(
        template.footerAr,
        values,
      )
        .split(/ {2,}/u)
        .map((part) => `<span>${escapeHtml(part)}</span>`)
        .join("")}</div></td></tr></tfoot>`
    : "";

  return `<article class="copy copy--document">
    <table class="doc-sheet">
      <thead><tr><td class="doc-mastcell">
        <header class="doc-mast">
          <span class="doc-mast__side"></span>
          <span class="doc-mast__title">
            <strong>${escapeHtml(template.titleAr)}</strong>
            <em>${escapeHtml(template.subtitleAr)}</em>
          </span>
          <span class="doc-mast__side doc-mast__mark">
            <img src="/brand/sato-pharma-logo-on-light.png" alt="" width="401" height="158">
          </span>
        </header>
      </td></tr></thead>
      <tbody><tr><td class="doc-body">
        ${opening}
        ${heading(template.firstPartyHeadingAr)}
        ${recital}
        ${heading(template.secondPartyHeadingAr)}
        ${documentIdentityGrid(template.secondPartyLinesAr, values)}
        ${heading(template.preambleHeadingAr)}
        <p class="doc-recital">${fillMarkedHtml(template.preambleAr, values)}</p>
        <div class="doc-arts">${articles}</div>
        ${closing}
        ${documentSignatureTable(template.signatureColumns, values)}
      </td></tr></tbody>
      ${foot}
    </table>
  </article>`;
}

/**
 * Which function draws which layout.
 *
 * A record rather than a chain of ternaries so adding a layout has one obvious place to land — but
 * a missing key is checked at RUNTIME below and not left to the compiler, because this repo builds
 * with `ignoreBuildErrors` and an incomplete Record compiles, builds and deploys perfectly happily.
 */
const CONTRACT_RENDERERS: Record<
  ContractTemplate["layout"],
  (template: ContractTemplate, values: Partial<Record<ContractToken, string>>) => string
> = {
  prose: renderProseCopy,
  banded: renderBandedCopy,
  document: renderDocumentCopy,
};

export function renderContractHtml(
  data: HiringPackData,
  copies: number,
  requestedTemplateId?: string | null,
): string {
  // Which text this person's contract is. A signed contract reprints the version that was SIGNED;
  // an explicit request (from the Archive screen) wins over both, because looking at an archived
  // template is exactly the case where "helpfully" substituting the current one defeats the point.
  const storedVersionId = data.profile.contractTemplateVersion;
  const { template } = resolveContractTemplate(requestedTemplateId ?? storedVersionId);
  const current = resolveContractTemplate(null).template;

  // Whether this print is a FAITHFUL REPRODUCTION of a signed contract, which is a claim about the
  // employee's file and not about how the version was chosen. Asking the resolver would conflate
  // the two: it only sees an id, so a version picked off the Archive for somebody who has signed
  // nothing would come back "reproduced from signature" and the banner would tell the reader this
  // is the contract that person put their name to. It is answered here instead, from what the file
  // actually stores — an explicit request for the version somebody DID sign still counts.
  const reproducedFromSignature = storedVersionId !== null && template.id === storedVersionId;

  const values = buildContractValues(data);
  const total = Math.max(1, copies);
  const renderCopy = CONTRACT_RENDERERS[template.layout];
  if (typeof renderCopy !== "function") {
    // Refusing to print is the safe failure. The alternative — falling back to another layout —
    // would hand somebody a legal instrument typeset as a different version of itself.
    throw new Error(
      `contract layout "${template.layout}" (${template.id}) has no renderer in CONTRACT_RENDERERS`,
    );
  }

  const body = Array.from({ length: total }, () => renderCopy(template, values)).join("\n");
  const employeeName = data.employee.nameAr ?? data.employee.fullName;

  // Blocking gaps are named on screen and never on paper — the person pressing Print is the last
  // one who can still go and find the missing value.
  const blocking = data.gaps.filter((gap) => gap.blocking && gap.documents.includes("contract"));
  const gapWarning =
    blocking.length > 0
      ? [`Still blank: ${blocking.map((gap) => gap.labelEn).join(", ")} — these print as dotted rules.`]
      : [];

  // An archived text is a legitimate thing to print and a dangerous thing to print by ACCIDENT, so
  // it says so on the screen banner — which never reaches paper — rather than staying silent.
  const archivedNotice =
    template.id === current.id
      ? []
      : [
          reproducedFromSignature
            ? `ARCHIVED TEXT (${template.id}) — this reproduces the contract this employee actually signed, not the current one.`
            : `ARCHIVED TEXT (${template.id}) — a superseded version was asked for. A new hire must sign the current contract.`,
        ];

  // Background graphics matter only where the design carries meaning. Version 1 is black on white,
  // and version 3 deliberately went back to that — its rules are borders and its mark is an image,
  // both of which print whether or not the box is ticked, so it is told to leave the setting alone
  // rather than given an instruction that changes nothing.
  const colourNotice =
    template.layout === "banded"
      ? [
          "Turn ON “Background graphics” — the title panel, the party bands and the highlight on every filled value are part of the document.",
        ]
      : [];

  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>عقد عمل — ${escapeHtml(employeeName)}</title>
<style>
  /* A4 with the current version's own page setup — 576 twips (10.2mm) at the sides, 604 (10.7mm)
     top, 720 (12.7mm) bottom. Version 1 was drawn on 18mm side margins and keeps them in its own
     padding, so the two versions print at the size each was designed for. */
  @page { size: A4; margin: 10.7mm 10.2mm 12.7mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #e2e8f0; }
  body {
    font-family: ${ARABIC_FONT_STACK};
    color: #000;
    direction: rtl;
    text-align: right;
  }
  ${PRINT_BANNER_CSS}

  .copy {
    width: 210mm;
    min-height: 297mm;
    margin: 0 auto 18px;
    background: #fff;
    break-after: page;
    page-break-after: always;
  }
  .copy:last-of-type { break-after: auto; page-break-after: auto; margin-bottom: 0; }

  /* ── version 1, the archived prose layout ─────────────────────────────────────────────────── */
  .copy--prose { padding: 20mm 18mm; font-size: 10.5pt; line-height: 1.75; }
  .copy--prose .title {
    margin: 0 0 2mm;
    font-size: 16pt;
    font-weight: 700;
    text-align: center;
    text-decoration: underline;
  }
  .copy--prose .subtitle {
    margin: 0 0 7mm;
    font-size: 10pt;
    font-weight: 600;
    text-align: center;
  }
  .copy--prose .heading {
    margin: 6mm 0 2mm;
    font-size: 12pt;
    font-weight: 700;
    text-align: center;
  }
  .opening, .party, .preamble, .article {
    margin: 0 0 3mm;
    text-align: justify;
    /* Never strand one line of a clause on its own page — a legal document read across a break is
       hard enough without a single orphaned line carrying the operative words. */
    orphans: 3;
    widows: 3;
  }
  /* Field lists, not prose: justifying them stretches the gaps between unrelated fields. */
  .party { margin-bottom: 1.5mm; text-align: right; }
  .field { white-space: nowrap; }
  .article__number { font-weight: 700; }

  .sign {
    display: flex;
    gap: 8mm;
    margin-top: 12mm;
    /* The signature columns must land together on one page: a party signing a sheet that carries no
       clause above it is exactly the ambiguity a signature block exists to prevent. */
    break-inside: avoid;
    page-break-inside: avoid;
  }
  .sign__column { flex: 1 1 0; text-align: center; }
  .sign__role { margin: 0 0 14mm; font-weight: 700; }
  .sign__rule { margin: 0 0 1.5mm; border-bottom: 1px solid #000; }
  .sign__hint { margin: 0; font-size: 8.5pt; color: #333; }

  /* ── version 2, the current banded layout ─────────────────────────────────────────────────── */
  /* Palette read off the source document: a navy title panel and article numbers, a mid blue for
     the rule and the band headings, a pale zebra on alternating rows, and the amber the original
     uses to highlight everything that gets filled in. */
  .copy--banded { padding: 10.7mm 10.2mm 12.7mm; color: #1a1a1a; font-size: 11.5pt; }
  .sheet { width: 100%; border-collapse: collapse; }
  .sheet__body { padding: 0; vertical-align: top; }
  .sheet__foot {
    padding: 2.5mm 0 0;
    border-top: 0.5pt solid #c9d6e2;
    color: #4a5b6b;
    font-size: 8pt;
    text-align: center;
  }

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
  /* The white-wordmark logo, which is the on-dark variant — the same artwork the source document
     places on this panel. The light-background variant would disappear here. */
  .masthead__mark img { width: 100%; max-width: 32mm; height: auto; }
  .rule { height: 1.6mm; background: #1b7fbf; }

  .parties { margin: 0 0 4mm; border: 0.5pt solid #c9d6e2; border-top: 0; }
  .band {
    margin: 0;
    padding: 1.6mm 3mm;
    background: #1b7fbf;
    color: #fff;
    font-size: 9pt;
    font-weight: 700;
    text-align: center;
  }
  .row { margin: 0; padding: 1.8mm 3mm; font-size: 10pt; line-height: 1.45; }
  .row--even { background: #f2f6fa; }
  .row--odd { background: #fff; }

  .grid { border: 0.5pt solid #c9d6e2; }
  .grid__row {
    display: flex;
    align-items: stretch;
    border-bottom: 0.5pt solid #c9d6e2;
    background: #fff;
    /* A clause may break across pages — they are long — but never on its first or last line. */
    orphans: 3;
    widows: 3;
  }
  /* Zebra by position, matching the source. Positional rather than a class so an article inserted
     or removed can never leave two identical stripes touching. */
  .grid__row:nth-child(even) { background: #f2f6fa; }
  .grid__row:last-child { border-bottom: 0; }
  .grid__label {
    display: flex;
    flex: 0 0 13.9%;
    flex-direction: column;
    gap: 1mm;
    padding: 2.4mm 2mm;
    border-inline-start: 0.5pt solid #c9d6e2;
    text-align: center;
  }
  .grid__number { color: #0b2a4a; font-size: 11.5pt; font-weight: 700; }
  .grid__title { color: #1b7fbf; font-size: 9.5pt; font-weight: 700; line-height: 1.25; }
  .grid__body {
    flex: 1 1 auto;
    padding: 2.4mm 3mm;
    font-size: 11.5pt;
    line-height: 1.5;
    text-align: justify;
  }

  .closing {
    margin: 5mm 0 4mm;
    color: #0b2a4a;
    font-size: 10.5pt;
    font-weight: 700;
    text-align: right;
  }

  .sign2 {
    display: flex;
    border-top: 1pt solid #0b2a4a;
    border-bottom: 0.5pt solid #c9d6e2;
    break-inside: avoid;
    page-break-inside: avoid;
  }
  .signcol { flex: 1 1 50%; }
  .signcol + .signcol { border-inline-end: 0.5pt solid #c9d6e2; }
  .signcol__head {
    margin: 0;
    padding: 1.8mm 3mm;
    background: #0b2a4a;
    color: #fff;
    font-size: 10pt;
    font-weight: 700;
    text-align: center;
  }
  .signcol__body { padding: 2mm 3mm 4mm; background: #f2f6fa; }
  .signcol__field { margin: 2.4mm 0 0; font-size: 10pt; }

  /* What Phoenix typed, on the amber the source document uses for its blanks. */
  .fill { padding: 0 0.6mm; background: #ffedbe; color: #8a5a00; font-weight: 700; }
  .fill--blank { letter-spacing: 0.4pt; }

  /* ── version 3, the current document layout ───────────────────────────────────────────────── */
  /* Read off the owner's Word file. Two blues and one hairline grey, and nothing else is coloured:
     no panel, no band, no zebra, no highlight. Everything that separates one part of the contract
     from another here is a rule, which is why this layout prints correctly whether or not the
     browser's “Background graphics” box is ticked. */
  .copy--document {
    padding: 10.7mm 10.2mm 12.7mm;
    color: #111;
    font-size: 9pt;
    line-height: 1.4;
  }
  .doc-sheet { width: 100%; border-collapse: collapse; }
  .doc-mastcell, .doc-body { padding: 0; vertical-align: top; }

  /* The letterhead. The mark sits on the left and the title is centred ON THE PAGE, not in what is
     left over beside the mark — which is what the empty span on the other side is for. */
  .doc-mast {
    display: flex;
    align-items: center;
    gap: 4mm;
    margin-bottom: 2.5mm;
    padding-bottom: 1.5mm;
    border-bottom: 0.6pt solid #b9cad9;
  }
  .doc-mast__side { flex: 0 0 30mm; }
  .doc-mast__mark { display: flex; justify-content: flex-start; }
  /* The blue-on-light variant — the same artwork, byte for byte, that the source document embeds.
     The white-wordmark file used by the banded layout would vanish on this page. */
  .doc-mast__mark img { width: 100%; max-width: 30mm; height: auto; }
  .doc-mast__title { flex: 1 1 auto; text-align: center; }
  .doc-mast__title strong { display: block; color: #0f6ea8; font-size: 13pt; font-weight: 700; }
  .doc-mast__title em {
    display: block;
    margin-top: 1mm;
    color: #5b6b7a;
    font-size: 8pt;
    font-style: normal;
    font-weight: 600;
  }

  .doc-foot { padding: 2.5mm 0 0; border-top: 0.6pt solid #b9cad9; font-size: 8pt; }
  /* One signing rule at each margin, as the source sets them. */
  .doc-foot__row { display: flex; justify-content: space-between; color: #33414f; }

  .doc-head {
    margin: 3mm 0 1.2mm;
    padding-bottom: 0.8mm;
    border-bottom: 0.6pt solid #cfdce7;
    color: #0f6ea8;
    font-size: 10.5pt;
    font-weight: 700;
  }
  .doc-body > .doc-head:first-child { margin-top: 0; }
  /* Zero margins on purpose: the version file states the company recital as two strings and the
     source states it as one justified paragraph, and with no gap between them these read as one. */
  .doc-recital { margin: 0; text-align: justify; orphans: 3; widows: 3; }

  .doc-ident { width: 100%; margin-top: 0.5mm; border-collapse: collapse; table-layout: fixed; }
  .doc-ident th, .doc-ident td {
    padding: 1.1mm 2mm;
    border: 0.5pt solid #cfdce7;
    font-size: 8.5pt;
    text-align: right;
    vertical-align: middle;
  }
  .doc-ident__label { width: 32mm; color: #33414f; font-weight: 700; }

  .doc-arts { margin-top: 1mm; }
  .doc-art {
    display: flex;
    align-items: flex-start;
    gap: 3mm;
    padding: 1.2mm 0;
    border-top: 0.5pt solid #dce6ee;
    /* A clause may break across pages — they are long — but never on its first or last line. */
    orphans: 3;
    widows: 3;
  }
  .doc-art:first-child { border-top: 0; }
  .doc-art__label { flex: 0 0 34mm; text-align: right; }
  .doc-art__no { display: block; color: #0f6ea8; font-size: 9pt; font-weight: 700; }
  .doc-art__title {
    display: block;
    color: #0f6ea8;
    font-size: 8pt;
    font-weight: 700;
    line-height: 1.25;
  }
  .doc-art__body { flex: 1 1 auto; text-align: justify; }

  .doc-closing { margin: 3mm 0 2.5mm; text-align: justify; }

  .doc-sig {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
    /* The parties must sign a sheet that carries clauses above it. */
    break-inside: avoid;
    page-break-inside: avoid;
  }
  .doc-sig th, .doc-sig td { padding: 1.2mm 2mm; border: 0.5pt solid #b9cad9; font-size: 8.5pt; }
  .doc-sig__corner { width: 34mm; }
  .doc-sig__head { color: #0f6ea8; font-weight: 700; text-align: center; }
  .doc-sig__party { font-weight: 700; text-align: right; }
  /* Room for a pen. The cell IS the blank, which is why a field holding nothing but dots prints
     empty here rather than printing a rule inside a box. */
  .doc-sig__cell { height: 12mm; text-align: center; vertical-align: top; }

  /* A typed value on this layout is set in the text, one weight heavier so it can still be told
     from the standing clause — no highlight, because the source has none and a contract that
     arrives at a signing table with coloured boxes on it reads as a draft. The data-hp-key on
     each is untouched: that, not the colour, is what the preview screen corrects through.
     NO BACKTICKS IN THIS BLOCK — it is inside a template literal, and one ends the string. */
  .copy--document .fill { padding: 0; background: none; color: inherit; font-weight: 700; }
  .copy--document .fill--blank { color: #55677a; font-weight: 400; letter-spacing: 0.4pt; }

  @media print {
    html, body { background: #fff; }
    .copy { width: auto; min-height: 0; margin: 0; box-shadow: none; }
    .copy--prose, .copy--banded, .copy--document { padding: 0; }
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
</head>
<body>
${printBanner([
  "Print SINGLE-SIDED — turn OFF “Print on both sides”. Every page of the contract goes on its own sheet.",
  `Paper size: A4. ${total} copies are already laid out below — leave the dialog's copy count at 1.`,
  "Every copy is a signed original. Scale must stay at 100% / “Actual size”.",
  ...colourNotice,
  ...archivedNotice,
  ...gapWarning,
])}
${body}
</body>
</html>`;
}
