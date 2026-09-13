/**
 * HR LETTER, ENGLISH — the salary certificate an employee takes to a bank, an embassy or a landlord.
 *
 * 🔴 IT STATES THE BASIC SALARY, AND ONLY THE BASIC SALARY. The owner, 2026-09-13: "salary we put
 * basic not net". The figure is `calculateBasicSalary` off the base salary on record — the payroll
 * policy's own formula, imported and never restated here, so the letter cannot quote a different
 * basic from the one payroll pays. Net and gross are deliberately absent: net moves every month with
 * allowances and deductions, and a letter a bank files is read as a standing fact.
 *
 * IT WEARS THE ARABIC CERTIFICATE'S DOCUMENT LAYOUT, in English and left to right. The owner compared
 * the first draft — prose under a letterhead, like the English certificate of experience — with the
 * Arabic certificate and chose the Arabic one: "this is better". So the page is drawn the way
 * `render-hr-paper.ts` draws that paper — masthead, purpose band, the company block, the employee's
 * details in a ruled grid, the certifying paragraphs, and a signature table whose Company stamp box
 * carries the seal. The stylesheet below is that one's, mirrored; read the notes there before
 * changing a metric here, so the two papers keep reading as one family.
 *
 * WHAT THE ARABIC PAPER PRINTS AND THIS ONE DOES NOT. The legal form, the register office, the head
 * office address and the department are held in Arabic only. An Arabic line inside an English
 * letter read at a visa window is worse than no line — the English certificate's own reasoning —
 * so the company block carries the three registration NUMBERS, which read the same in any language.
 *
 * WHAT IT ADDS IS THE SALARY SENTENCE — the figure, and the figure in words. Both are derived from
 * the base salary and neither is bound for editing on the page (see `paper-fields.ts`): typing over
 * the words alone would print a letter that contradicts itself, and typing over the figure would
 * save nowhere. Correct the base salary and both follow.
 */

import type { CompanyDetails } from "@/lib/hiring-pack/company-details";
import {
  honorific,
  pronounsFor,
  sentenceCase,
  value,
} from "@/lib/hiring-pack/experience-certificate-en";
import { flowFieldLayer, type DocumentFieldRow } from "@/lib/hiring-pack/field-layout";
import {
  HOUSE_COLORS,
  HOUSE_MARK_SRC,
  HOUSE_SEALED_ATTRS,
  houseBandBackground,
  houseSealImg,
} from "@/lib/hiring-pack/house-identity";
import {
  escapeHtml,
  formatLongDateEn,
  PRINT_BANNER_CSS,
  printBanner,
  todayInCairo,
} from "@/lib/hiring-pack/render-shared";
import { resolveServicePeriod } from "@/lib/hiring-pack/service-period";
import type { HiringPackData } from "@/lib/hiring-pack/types";
import { BASIC_SALARY_RATE, calculateBasicSalary } from "@/lib/payroll/policy";

/** The version id, as the template registry knows it. Never renamed — a reprint resolves through it. */
export const SALARY_LETTER_EN_ID = "salary-letter-en-v1";

const SMALL_NUMBERS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
  "nineteen",
];

const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function underThousandWords(n: number): string {
  const words: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds > 0) words.push(`${SMALL_NUMBERS[hundreds]} hundred`);
  if (rest > 0) {
    if (rest < 20) {
      words.push(SMALL_NUMBERS[rest]);
    } else {
      const tens = TENS[Math.floor(rest / 10)];
      words.push(rest % 10 === 0 ? tens : `${tens}-${SMALL_NUMBERS[rest % 10]}`);
    }
  }
  return words.join(" ");
}

function wholeNumberWords(n: number): string {
  if (n === 0) return "zero";
  const parts: string[] = [];
  let remaining = n;
  for (const [size, name] of [
    [1_000_000_000, "billion"],
    [1_000_000, "million"],
    [1_000, "thousand"],
  ] as const) {
    const count = Math.floor(remaining / size);
    if (count > 0) {
      parts.push(`${wholeNumberWords(count)} ${name}`);
      remaining %= size;
    }
  }
  if (remaining > 0) parts.push(underThousandWords(remaining));
  return parts.join(" ");
}

/**
 * "Twelve thousand six hundred Egyptian pounds only".
 *
 * Counted in whole piastres first, so 0.1 + 0.2 cannot become "twenty-nine piastres". The closing
 * "only" is how an Egyptian letter fences an amount in words, so nothing can be written after it.
 */
export function amountInWordsEn(amount: number): string {
  const totalPiastres = Math.round(Math.max(0, amount) * 100);
  const pounds = Math.floor(totalPiastres / 100);
  const piastres = totalPiastres % 100;
  let text = `${wholeNumberWords(pounds)} Egyptian ${pounds === 1 ? "pound" : "pounds"}`;
  if (piastres > 0) {
    text += ` and ${wholeNumberWords(piastres)} ${piastres === 1 ? "piastre" : "piastres"}`;
  }
  return `${text.charAt(0).toUpperCase()}${text.slice(1)} only`;
}

/** "EGP 12,600.00" — the figure as a bank reads it, with the currency named. */
export function formatEgpAmount(amount: number): string {
  return `EGP ${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  }).format(amount)}`;
}

export type SalaryLetterEnValues = {
  employeeName: string;
  honorific: string;
  nationalId: string;
  hrId: string;
  jobTitle: string;
  hireDate: string;
  serviceEnd: string;
  issueDate: string;
  departed: boolean;
  /** The base salary on record, or null when none is. Shown on the print banner, never on the page. */
  baseSalary: number | null;
  /** The basic salary the letter states, or null when there is no base salary to derive it from. */
  basicSalary: number | null;
  basicSalaryFigure: string;
  basicSalaryWords: string;
};

/**
 * Every value the letter states, resolved once.
 *
 * NO BASE SALARY MEANS A BLANK, NEVER ZERO. `calculateBasicSalary` answers 0 for a missing base,
 * and "EGP 0.00" on a letter to a bank is a statement that the employee is unpaid. A missing figure
 * prints as a rule for a pen, the rule every paper in this module follows.
 */
export function buildSalaryLetterEnValues(data: HiringPackData): SalaryLetterEnValues {
  const today = todayInCairo();
  const service = resolveServicePeriod(data, today);
  const base = data.employee.baseSalary;
  const baseSalary = typeof base === "number" && Number.isFinite(base) && base > 0 ? base : null;
  const basicSalary = baseSalary === null ? null : calculateBasicSalary({ baseSalary });

  return {
    employeeName: data.employee.fullName,
    honorific: honorific(data.employee.gender),
    nationalId: data.employee.nationalId ?? "",
    hrId: data.employee.hrId,
    jobTitle: data.employee.jobTitle ?? "",
    hireDate: formatLongDateEn(service.startsOn),
    serviceEnd: service.departed ? formatLongDateEn(service.endsOn) : "",
    issueDate: formatLongDateEn(today),
    departed: service.departed,
    baseSalary,
    basicSalary,
    basicSalaryFigure: basicSalary === null ? "" : formatEgpAmount(basicSalary),
    basicSalaryWords: basicSalary === null ? "" : amountInWordsEn(basicSalary),
  };
}

/** The employee's details, two pairs to a row — the Arabic certificate's grid. */
function detailsGrid(values: SalaryLetterEnValues): string {
  const pair = (label: string, cell: string, span = false) =>
    `<th class="doc-ident__label">${escapeHtml(label)}</th>` +
    `<td class="doc-ident__value"${span ? ' colspan="3"' : ""}>${cell}</td>`;

  const rows = [
    pair("Full name", value("EMPLOYEE_NAME_EN", values.employeeName), true),
    pair("National ID", value("NATIONAL_ID", values.nationalId)) +
      pair("Employee code", value("HR_ID", values.hrId)),
    pair("Position", value("JOB_TITLE_EN", values.jobTitle), true),
    pair("Date of joining", value("HIRE_DATE_EN", values.hireDate)) +
      (values.departed
        ? pair("Last working day", value("SERVICE_END_EN", values.serviceEnd))
        : pair("Date of issue", value("ISSUE_DATE_EN", values.issueDate))),
  ];
  if (values.departed) {
    rows.push(pair("Date of issue", value("ISSUE_DATE_EN", values.issueDate), true));
  }
  return `<table class="doc-ident"><tbody>${rows.map((row) => `<tr>${row}</tr>`).join("")}</tbody></table>`;
}

/**
 * The signature table — one row for the company, and the seal in its own Company stamp box.
 *
 * The same impression, from the same helper, as the Arabic certificate — so it is one seal on the
 * company's side and never over the line somebody signs.
 */
function signatureTable(): string {
  const head = ["Name and title", "Signature", "Company stamp"]
    .map((label) => `<th class="doc-sig__head">${escapeHtml(label)}</th>`)
    .join("");
  return `<table class="doc-sig">
      <thead><tr><td class="doc-sig__corner"></td>${head}</tr></thead>
      <tbody><tr><th class="doc-sig__party">For the company — Human Resources</th>` +
    `<td class="doc-sig__cell"></td><td class="doc-sig__cell"></td>` +
    `<td class="doc-sig__cell"${HOUSE_SEALED_ATTRS}>${houseSealImg({ sizeMm: 34 })}</td></tr></tbody>
    </table>`;
}

/** The letter, as one printable copy. */
function renderCopy(values: SalaryLetterEnValues, company: CompanyDetails): string {
  const p = pronounsFor(values.honorific);
  const companyName = escapeHtml(company.legalNameEn);
  const recital = company.contractRecital;
  const who = `${escapeHtml(values.honorific)} ${value(
    "EMPLOYEE_NAME_EN",
    values.employeeName,
  )}, holder of National Identification Number ${value(
    "NATIONAL_ID",
    values.nationalId,
  )} and employee code ${value("HR_ID", values.hrId)}`;

  // Two tenses of one fact. A leaver's letter states the period and the LAST basic salary; it never
  // says "is employed" of somebody who has gone — the same safety property as the certificate.
  const employment = values.departed
    ? `This is to certify that ${who}, was employed by ${companyName} from ${value(
        "HIRE_DATE_EN",
        values.hireDate,
      )} to ${value("SERVICE_END_EN", values.serviceEnd)}, in the position of ${value(
        "JOB_TITLE_EN",
        values.jobTitle,
      )}.`
    : `This is to certify that ${who}, has been employed by ${companyName} since ${value(
        "HIRE_DATE_EN",
        values.hireDate,
      )} and currently holds the position of ${value("JOB_TITLE_EN", values.jobTitle)}.`;

  const salaryLead = values.departed
    ? `${sentenceCase(p.possessive)} last basic monthly salary was`
    : `${sentenceCase(p.possessive)} basic monthly salary is`;
  // The words are dropped rather than ruled when there is no figure: two rules in one sentence read
  // as a defect, and the one rule already says a figure is missing.
  const words = values.basicSalaryWords
    ? ` (${value("BASIC_SALARY_WORDS_EN", values.basicSalaryWords)})`
    : "";

  const number = (text: string) => `<span class="fill">${escapeHtml(text)}</span>`;

  // THE MARK FIRST, THE NAME BLOCK LAST — the mirror of the Arabic masthead, so on both papers the
  // mark sits at the left and the company's name at the right. The name block keeps
  // `doc-mast__side doc-mast__id` with a strong then a dir="ltr" span: that is the shape
  // `paper-reference.ts` looks for, and it writes the reference number under it.
  return `<article class="copy copy--document copy--salaryLetter">
    <table class="doc-sheet">
      <thead><tr><td class="doc-mastcell">
        <header class="doc-mast">
          <span class="doc-mast__side doc-mast__mark">
            <img src="${HOUSE_MARK_SRC}" alt="" width="401" height="158">
          </span>
          <span class="doc-mast__title">
            <strong>HR Letter</strong>
            <em>Salary certificate · شهادة راتب</em>
          </span>
          <span class="doc-mast__side doc-mast__id">
            <strong>${companyName}</strong>
            <span dir="ltr">${escapeHtml(company.legalNameAr)}</span>
          </span>
        </header>
        <p class="doc-purpose">Issued in two copies — one handed to the employee at ${p.possessive} request, one retained in the service file.</p>
      </td></tr></thead>
      <tbody><tr><td class="doc-body">
        <h2 class="doc-head">Issued by — the Company</h2>
        <p class="doc-recital"><strong class="fill">${companyName}</strong> · Commercial Register No. ${number(
          recital.commercialRegisterNumber,
        )} · Unified Register No. ${number(recital.unifiedRegisterNumber)} · Tax Card No. ${number(
          recital.taxCardNumber,
        )}</p>

        <h2 class="doc-head">Employee details</h2>
        ${detailsGrid(values)}

        <p class="doc-salute">To whom it may concern,</p>
        <p class="doc-para">${employment}</p>
        <p class="doc-para">${salaryLead} ${value("BASIC_SALARY_EN", values.basicSalaryFigure)}${words}. The amount stated is the basic salary only; it does not include allowances, incentives or any other variable pay.</p>
        <p class="doc-para">This letter has been issued at ${p.possessive} own request, to be presented to whom it may concern, without any liability on the company towards third parties.</p>

        <h2 class="doc-head">Signature and approval</h2>
        ${signatureTable()}
      </td></tr></tbody>
      <tfoot><tr><td class="doc-foot"><div class="doc-foot__row"><span>HR Letter · Salary certificate</span><span>Issued by Human Resources</span></div></td></tr></tfoot>
    </table>
  </article>`;
}

/** The printable page. `copies` stamps the same page out N times, as every paper in this module does. */
export function renderSalaryLetterEnHtml(
  data: HiringPackData,
  copies: number,
  _templateId?: string | null,
  fields: readonly DocumentFieldRow[] = [],
): string {
  const values = buildSalaryLetterEnValues(data);
  const total = Math.max(1, Math.trunc(copies));
  const body = Array.from({ length: total }, () => renderCopy(values, data.company)).join("\n");

  const banner = [
    `${values.employeeName || "This employee"} — HR Letter (salary), ${total} ${total === 1 ? "copy" : "copies"}.`,
    values.basicSalary !== null && values.baseSalary !== null
      ? `It states the BASIC monthly salary, ${values.basicSalaryFigure} — ${Math.round(
          BASIC_SALARY_RATE * 100,
        )}% of the base salary on record (${formatEgpAmount(values.baseSalary)}). Not the net salary and not the gross.`
      : "No base salary is on record, so the salary prints as a blank rule. Correct the record, or write the basic salary in, before it leaves the desk.",
    values.departed
      ? "This employee has LEFT: the letter states the period of service and the LAST basic salary."
      : "It states that this employee is currently employed, read from the employee record.",
  ];

  return `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(`HR Letter — ${values.employeeName}`)}</title>
<style>
  @page { size: A4; margin: 10.7mm 10.2mm 12.7mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #e2e8f0; }
  /* Keep the zebra bands when a browser prints — see the same line in render-hr-paper.ts.
     NO BACKTICKS IN THIS STYLESHEET — it is inside a template literal, and one ends the string. */
  html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    /* The English certificate's Latin stack. */
    font-family: "Segoe UI", Calibri, Candara, "Helvetica Neue", Arial, sans-serif;
    color: #111;
    font-size: 9.5pt;
    line-height: 1.5;
  }

  .copy {
    width: 210mm;
    min-height: 297mm;
    margin: 0 auto 8mm;
    background: #fff;
    box-shadow: 0 1px 3px rgba(15, 23, 42, 0.25);
  }
  .copy + .copy { page-break-before: always; break-before: page; }

  /* The Arabic certificate's document layout, mirrored left to right. Two blues and one hairline
     grey; everything separating one part from another is a RULE; the one filled element is the
     zebra on a grid. Every corner is square, by absence — nothing here draws one. */
  .copy--document { padding: 10.7mm 10.2mm 12.7mm; }
  .doc-sheet { width: 100%; border-collapse: collapse; }
  .doc-mastcell, .doc-body { padding: 0; vertical-align: top; }

  .doc-mast {
    display: flex;
    align-items: center;
    gap: 4mm;
    margin-bottom: 2.5mm;
    padding-bottom: 3.3mm;
    background: ${houseBandBackground("left bottom")};
  }
  .doc-mast__side { flex: 0 0 34mm; }
  .doc-mast__id { text-align: right; color: ${HOUSE_COLORS.muted}; font-size: 6.5pt; line-height: 1.5; }
  .doc-mast__id strong { display: block; color: ${HOUSE_COLORS.deep}; font-size: 8pt; font-weight: 700; }
  .doc-mast__id span { display: block; }
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
    margin: 3.5mm 0 1.4mm;
    padding-bottom: 0.8mm;
    border-bottom: 0.8pt solid ${HOUSE_COLORS.blue};
    color: ${HOUSE_COLORS.deep};
    font-size: 10.5pt;
    font-weight: 700;
  }
  .doc-body > .doc-head:first-child { margin-top: 0; }

  .doc-recital { margin: 0; text-align: left; }
  /* A registration number is read digit group by digit group; it never breaks at a hyphen. */
  .doc-recital .fill { white-space: nowrap; }
  .doc-salute { margin: 4mm 0 2mm; }
  .doc-para { margin: 0 0 2.5mm; text-align: justify; orphans: 3; widows: 3; }

  .doc-ident { width: 100%; margin-top: 0.5mm; border-collapse: collapse; table-layout: fixed; }
  .doc-ident th, .doc-ident td {
    padding: 1.1mm 2mm;
    border: 0.5pt solid #cfdce7;
    font-size: 8.5pt;
    text-align: left;
    vertical-align: middle;
  }
  .doc-ident__label { width: 34mm; color: ${HOUSE_COLORS.deep}; font-weight: 700; }
  .doc-ident tbody tr:nth-child(even) th,
  .doc-ident tbody tr:nth-child(even) td { background: ${HOUSE_COLORS.tint}; }

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
  .doc-sig__party { font-weight: 700; text-align: left; vertical-align: middle; color: ${HOUSE_COLORS.deep}; }
  /* Tall enough to hold the whole 34mm impression inside its own box. */
  .doc-sig__cell { height: 36mm; text-align: center; vertical-align: top; }

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
${flowFieldLayer(fields, {
  BASIC_SALARY_EN: values.basicSalaryFigure,
  BASIC_SALARY_WORDS_EN: values.basicSalaryWords,
  EMPLOYEE_NAME_EN: values.employeeName,
  HIRE_DATE_EN: values.hireDate,
  HR_ID: values.hrId,
  ISSUE_DATE_EN: values.issueDate,
  JOB_TITLE_EN: values.jobTitle,
  NATIONAL_ID: values.nationalId,
  SERVICE_END_EN: values.serviceEnd,
})}
</body>
</html>`;
}

/** The mark this page carries, so a test can assert the on-light file without parsing the HTML. */
export const SALARY_LETTER_EN_MARK = HOUSE_MARK_SRC;
