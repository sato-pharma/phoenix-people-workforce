import { systemLegalEntity } from "@/config/system-settings";
import { spellEgyptianAmount } from "@/lib/hiring-pack/arabic-amount";
import {
  CONTRACT_ARTICLES_AR,
  CONTRACT_FIRST_PARTY_AR,
  CONTRACT_OPENING_AR,
  CONTRACT_PREAMBLE_AR,
  CONTRACT_PREAMBLE_HEADING_AR,
  CONTRACT_SECOND_PARTY_AR,
  CONTRACT_SIGNATURE_COLUMNS_AR,
  CONTRACT_SUBTITLE_AR,
  CONTRACT_TITLE_AR,
  fillContractTokens,
  type ContractToken,
} from "@/lib/hiring-pack/contract-text";
import {
  arabicDayName,
  ARABIC_FONT_STACK,
  describeDurationMonths,
  escapeHtml,
  formatDayMonthYear,
  PRINT_BANNER_CSS,
  printBanner,
} from "@/lib/hiring-pack/render-shared";
import type { HiringPackData } from "@/lib/hiring-pack/types";

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
 * The permanent address as a contract states it — prose, not codes.
 *
 * Form 1's قسم/مركز and محافظة fields are two-cell grids holding NUMERIC government codes, so
 * reusing them here would print something like "شارع كذا، 03، 01" in a legal document. The
 * free-text residence address on the employee record is what a contract wants; the structured
 * parts are only a fallback for when it is empty.
 */
function resolveContractAddress(data: HiringPackData): string {
  const direct = data.employee.residenceAddress?.trim();
  if (direct) return direct;

  return [
    data.profile.addressStreet,
    data.profile.addressBuilding ? `رقم ${data.profile.addressBuilding}` : null,
    data.employee.residenceCity,
  ]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join("، ");
}

/**
 * Every blank in the contract, resolved once.
 *
 * WATCH THE UNITS. Three of these tokens sit inside a sentence that already prints the unit, so the
 * value must be bare: مادة (2) writes "({{SALARY_FIGURES}}) جنيه", and مادة (10) writes
 * "({{UNDERPERFORMANCE_PCT}}%)" and "({{UNDERPERFORMANCE_MONTHS}}) شهرًا متتالية". Passing
 * "3 أشهر" into the last of those would print "3 أشهر شهرًا متتالية". The two tokens that carry no
 * printed unit — مادة (4)'s DURATION and مادة (14)'s TRAINING_BOND — take the spelled-out phrase.
 *
 * PROBATION IS NOT A TOKEN. مادة (4) states "مدة الثلاثة أشهر الأولى تحت الاختبار" verbatim, so a
 * probation period other than three months cannot be expressed by filling a blank — it would need
 * the clause itself rewritten, which is a legal change and not a rendering one.
 */
function buildContractValues(data: HiringPackData): Partial<Record<ContractToken, string>> {
  const { employee, profile, terms } = data;

  // The date the instrument bears. Deliberately NOT "today": a contract dated by whatever day the
  // print button happened to be pressed is a wrong date on a legal document, and a visible run of
  // dots for HR to complete by hand is the better failure.
  const contractDate = terms.contractStartDate ?? employee.hireDate;

  return {
    DAY_NAME: arabicDayName(contractDate),
    CONTRACT_DATE: formatDayMonthYear(contractDate),

    COMPANY_NAME: systemLegalEntity.legalNameAr,
    COMPANY_HEAD_OFFICE: systemLegalEntity.headOfficeAr,
    COMPANY_CITY: systemLegalEntity.contractCityAr,
    RESPONSIBLE_MANAGER: systemLegalEntity.responsibleManagerAr,
    RESPONSIBLE_MANAGER_TITLE: systemLegalEntity.responsibleManagerTitleAr,

    // The Arabic name governs: مادة (18) makes the Arabic text controlling, so the party named in
    // it has to be the Arabic name wherever the record carries one.
    EMPLOYEE_NAME: employee.nameAr ?? employee.fullName,
    NATIONALITY: profile.nationality ?? "",
    QUALIFICATION: profile.qualification ?? "",
    BIRTH_DATE: formatDayMonthYear(employee.birthDate),
    BIRTH_PLACE: profile.birthPlace ?? "",
    NATIONAL_ID: employee.nationalId ?? "",
    INSURANCE_NUMBER: employee.socialInsuranceNumber ?? "",
    ADDRESS: resolveContractAddress(data),
    PHONE: employee.mobileNumber ?? "",
    EMAIL: employee.workEmail ?? "",

    JOB_TITLE: profile.jobTitleAr ?? employee.jobTitle ?? "",
    DEPARTMENT: employee.departmentAr ?? "",

    SALARY_FIGURES: formatMoney(employee.grossSalary),
    SALARY_WORDS: spellEgyptianAmount(employee.grossSalary),
    INSURANCE_WAGE: formatMoney(employee.socialInsuranceWage),

    DURATION: describeDurationMonths(terms.durationMonths),
    START_DATE: formatDayMonthYear(terms.contractStartDate ?? employee.hireDate),

    UNDERPERFORMANCE_PCT: String(terms.underperformanceThresholdPct),
    UNDERPERFORMANCE_MONTHS: String(terms.underperformanceMonths),
    TRAINING_BOND: describeDurationMonths(terms.trainingBondMonths),
  };
}

/**
 * Escape a filled line, keeping the double spaces the source text uses to separate fields.
 *
 * The second party's three lines read "الاسم: (…)  الجنسية: (…)" — the gap is what tells the eye
 * where one field ends. HTML collapses runs of whitespace, so each pair becomes one hard space plus
 * one ordinary one: the gap survives, and the line can still wrap.
 */
function line(text: string): string {
  return escapeHtml(text).replace(/ {2}/g, "&nbsp; ");
}

/** "الرقم التأميني: (123456789)" — a label and the value in brackets that belongs to it. */
const LABELLED_FIELD = /^(.*?:)[  ]*(\([^()]*\))/u;

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

function renderCopy(values: Partial<Record<ContractToken, string>>): string {
  const secondParty = CONTRACT_SECOND_PARTY_AR.map(
    (part) => `<p class="party">${partyLine(fillContractTokens(part, values))}</p>`,
  ).join("");

  const articles = CONTRACT_ARTICLES_AR.map(
    (article) =>
      `<p class="article"><span class="article__number">${escapeHtml(article.number)}</span> ${line(
        fillContractTokens(article.body, values),
      )}</p>`,
  ).join("");

  const signatures = CONTRACT_SIGNATURE_COLUMNS_AR.map(
    (column) =>
      `<div class="sign__column">
        <p class="sign__role">${escapeHtml(column)}</p>
        <p class="sign__rule"></p>
        <p class="sign__hint">الاسم والتوقيع</p>
      </div>`,
  ).join("");

  return `<article class="copy">
    <h1 class="title">${escapeHtml(CONTRACT_TITLE_AR)}</h1>
    <p class="subtitle">${escapeHtml(CONTRACT_SUBTITLE_AR)}</p>

    <p class="opening">${line(fillContractTokens(CONTRACT_OPENING_AR, values))}</p>
    <p class="party">${partyLine(fillContractTokens(CONTRACT_FIRST_PARTY_AR, values))}</p>
    ${secondParty}

    <h2 class="heading">${escapeHtml(CONTRACT_PREAMBLE_HEADING_AR)}</h2>
    <p class="preamble">${line(fillContractTokens(CONTRACT_PREAMBLE_AR, values))}</p>

    ${articles}

    <div class="sign">${signatures}</div>
  </article>`;
}

export function renderContractHtml(data: HiringPackData, copies: number): string {
  const values = buildContractValues(data);
  const total = Math.max(1, copies);

  const body = Array.from({ length: total }, () => renderCopy(values)).join("\n");
  const employeeName = data.employee.nameAr ?? data.employee.fullName;

  // Blocking gaps are named on screen and never on paper — the person pressing Print is the last
  // one who can still go and find the missing value.
  const blocking = data.gaps.filter((gap) => gap.blocking && gap.document !== "form1");
  const gapWarning =
    blocking.length > 0
      ? [`Still blank: ${blocking.map((gap) => gap.labelEn).join(", ")} — these print as dotted rules.`]
      : [];

  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>عقد عمل — ${escapeHtml(employeeName)}</title>
<style>
  /* A4 with 18mm side margins — the source document's own page setup (11906 x 16838 twips). */
  @page { size: A4; margin: 20mm 18mm; }
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
    padding: 20mm 18mm;
    background: #fff;
    font-size: 10.5pt;
    line-height: 1.75;
    break-after: page;
    page-break-after: always;
  }
  .copy:last-of-type { break-after: auto; page-break-after: auto; margin-bottom: 0; }

  .title {
    margin: 0 0 2mm;
    font-size: 16pt;
    font-weight: 700;
    text-align: center;
    text-decoration: underline;
  }
  .subtitle {
    margin: 0 0 7mm;
    font-size: 10pt;
    font-weight: 600;
    text-align: center;
  }
  .heading {
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
    /* The three signature columns must land together on one page: a party signing a sheet that
       carries no clause above it is exactly the ambiguity a signature block exists to prevent. */
    break-inside: avoid;
    page-break-inside: avoid;
  }
  .sign__column { flex: 1 1 0; text-align: center; }
  .sign__role { margin: 0 0 14mm; font-weight: 700; }
  .sign__rule { margin: 0 0 1.5mm; border-bottom: 1px solid #000; }
  .sign__hint { margin: 0; font-size: 8.5pt; color: #333; }

  @media print {
    html, body { background: #fff; }
    .copy { width: auto; min-height: 0; margin: 0; padding: 0; box-shadow: none; }
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
</head>
<body>
${printBanner([
  "Print SINGLE-SIDED — turn OFF “Print on both sides”. Every page of the contract goes on its own sheet.",
  `Paper size: A4. ${total} copies are already laid out below — leave the dialog's copy count at 1.`,
  "All four copies are signed originals. Scale must stay at 100% / “Actual size”.",
  ...gapWarning,
])}
${body}
</body>
</html>`;
}
