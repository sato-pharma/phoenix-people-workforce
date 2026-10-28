/**
 * HR LETTER, ENGLISH — the salary certificate an employee takes to a bank, an embassy or a landlord.
 *
 * 🔴 IT STATES THE BASE SALARY ON RECORD, AND ONLY THE BASE SALARY. The owner, 2026-10-28: "PUT THE
 * BASE NOT THE BASIC SALARY". It stated the BASIC from its first day (2026-09-13, "salary we put basic
 * not net"); that rule is reversed, and the English letter now states the same figure as the Arabic
 * one has since 2026-09-20 — `employee.baseSalary`, as it is, never run through the payroll policy's
 * basic formula. A pair printed minutes apart for one person can no longer state two different
 * salaries. Net and gross stay absent: net moves every month with allowances and deductions, and a
 * letter a bank files is read as a standing fact.
 *
 * IT WEARS THE CERTIFICATE OF EXPERIENCE'S DESIGN (owner, 2026-10-28: "SHOW ME HR LETTER WITH SAME
 * IDENTITY", then "Make it the HR letter … both languages"). The anatomy is
 * `experience-certificate-design.ts`'s — the two-weight title beside the issuing company, the
 * employee's details as a ruled list, the words, the salary at a glance, and BLANK signing boxes —
 * with the letter's own overrides in `SALARY_LETTER_DESIGN_CSS`. The Arabic letter
 * (`salary-letter-ar.ts`) wears the same parts, so the pair reads as one instrument.
 *
 * WHAT THE ARABIC PAPER PRINTS AND THIS ONE DOES NOT. The legal form, the register office, the head
 * office address and the department are held in Arabic only. An Arabic line inside an English
 * letter read at a visa window is worse than no line — the English certificate's own reasoning —
 * so the company block carries the three registration NUMBERS, which read the same in any language.
 *
 * WHAT IT ADDS IS THE SALARY SENTENCE — the figure, and the figure in words. Both are the base salary
 * and neither is bound for editing on the page (see `paper-fields.ts`): typing over the words alone
 * would print a letter that contradicts itself, and typing over the figure would save nowhere.
 * Correct the base salary and both follow.
 *
 * NO SEAL, AND THE SIGNING BOXES ARE BLANK (owner, 2026-09-29 and 2026-10-28). The Company stamp
 * heading stays: it tells whoever signs where to press the real stamp.
 */

import type { CompanyDetails } from "@/lib/hiring-pack/company-details";
import {
  certificateMonthYear,
  certificatePayStripHtml,
  certificateSignCellsHtml,
  EXPERIENCE_CERTIFICATE_DESIGN_CSS,
  SALARY_LETTER_DESIGN_CSS,
} from "@/lib/hiring-pack/experience-certificate-design";
import {
  honorific,
  pronounsFor,
  sentenceCase,
  value,
} from "@/lib/hiring-pack/experience-certificate-en";
import { flowFieldLayer, type DocumentFieldRow } from "@/lib/hiring-pack/field-layout";
import { HOUSE_MARK_SRC } from "@/lib/hiring-pack/house-identity";
import {
  premiumDocumentStylesheet,
  premiumMasthead,
  premiumPageChrome,
} from "@/lib/hiring-pack/premium-identity";
import {
  escapeHtml,
  formatLongDateEn,
  PRINT_BANNER_CSS,
  printBanner,
  todayInCairo,
} from "@/lib/hiring-pack/render-shared";
import { resolveServicePeriod } from "@/lib/hiring-pack/service-period";
import type { HiringPackData } from "@/lib/hiring-pack/types";

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
  /** The service period's ISO dates, for the salary strip's figures. */
  startsOn: string | null;
  endsOn: string | null;
  issuedOn: string;
  departed: boolean;
  /** The base salary on record — the figure the letter states — or null when none is. */
  baseSalary: number | null;
  baseSalaryFigure: string;
  baseSalaryWords: string;
};

/**
 * Every value the letter states, resolved once.
 *
 * NO BASE SALARY MEANS A BLANK, NEVER ZERO. "EGP 0.00" on a letter to a bank is a statement that the
 * employee is unpaid. A missing figure prints as a rule for a pen, the rule every paper in this
 * module follows.
 */
export function buildSalaryLetterEnValues(data: HiringPackData): SalaryLetterEnValues {
  const today = todayInCairo();
  const service = resolveServicePeriod(data, today);
  const base = data.employee.baseSalary;
  const baseSalary = typeof base === "number" && Number.isFinite(base) && base > 0 ? base : null;

  return {
    employeeName: data.employee.fullName,
    honorific: honorific(data.employee.gender),
    nationalId: data.employee.nationalId ?? "",
    hrId: data.employee.hrId,
    jobTitle: data.employee.jobTitle ?? "",
    hireDate: formatLongDateEn(service.startsOn),
    serviceEnd: service.departed ? formatLongDateEn(service.endsOn) : "",
    issueDate: formatLongDateEn(today),
    startsOn: service.startsOn,
    endsOn: service.endsOn,
    issuedOn: today,
    departed: service.departed,
    baseSalary,
    baseSalaryFigure: baseSalary === null ? "" : formatEgpAmount(baseSalary),
    baseSalaryWords: baseSalary === null ? "" : amountInWordsEn(baseSalary),
  };
}

/** The letter, as one printable copy. */
function renderCopy(values: SalaryLetterEnValues, company: CompanyDetails): string {
  const p = pronounsFor(values.honorific);
  const companyName = escapeHtml(company.legalNameEn);
  const recital = company.contractRecital;
  const number = (text: string) => `<span class="fill">${escapeHtml(text)}</span>`;
  const who = `${escapeHtml(values.honorific)} ${value(
    "EMPLOYEE_NAME_EN",
    values.employeeName,
  )}, holder of National Identification Number ${value(
    "NATIONAL_ID",
    values.nationalId,
  )} and employee code ${value("HR_ID", values.hrId)}`;

  // Two tenses of one fact. A leaver's letter states the period and the LAST base salary; it never
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
    ? `${sentenceCase(p.possessive)} last base monthly salary was`
    : `${sentenceCase(p.possessive)} base monthly salary is`;
  // The words are dropped rather than ruled when there is no figure: two rules in one sentence read
  // as a defect, and the one rule already says a figure is missing.
  const words = values.baseSalaryWords
    ? ` (${value("BASE_SALARY_WORDS_EN", values.baseSalaryWords)})`
    : "";

  const field = (label: string, cell: string, wide = false) =>
    `<div${wide ? ' class="xc-wide"' : ""}><dt>${escapeHtml(label)}</dt><dd>${cell}</dd></div>`;
  const fields = [
    field("Full name", value("EMPLOYEE_NAME_EN", values.employeeName), true),
    field("National ID", value("NATIONAL_ID", values.nationalId)),
    field("Employee code", value("HR_ID", values.hrId)),
    field("Position", value("JOB_TITLE_EN", values.jobTitle)),
    field("Date of joining", value("HIRE_DATE_EN", values.hireDate)),
    ...(values.departed ? [field("Last working day", value("SERVICE_END_EN", values.serviceEnd))] : []),
    field("Date of issue", value("ISSUE_DATE_EN", values.issueDate)),
  ].join("\n        ");

  const issuedMonth = certificateMonthYear(values.issuedOn, "en");

  // THE ORDER OF THE CHILDREN IS LOAD-BEARING, and it is the certificate's: the hero and the details
  // block are `div`s, the words and the signing block are the only two `section`s, the signing row is
  // the signing section's only `div`, and the chrome is appended LAST — so a hand-placed mark
  // measured as `section:nth-of-type(2) > div:nth-of-type(1) > span:nth-of-type(3)` is the stamp box.
  // The masthead keeps its `pm-mast__ref` slot: `paper-reference.ts` writes the reference number there.
  return `<article class="copy xc xl xl--en">
    ${premiumMasthead({
      legalNameAr: "",
      legalNameEn: null,
      title: "Human Resources",
      titleLang: "en",
      subtitles: [{ text: `Head Office · Cairo${issuedMonth ? ` · ${issuedMonth}` : ""}`, lang: "en" }],
    })}

    <div class="xc-hero">
      <div>
        <p class="xc-kicker xc-micro"><i class="xc-dia"></i>HR Letter · Issued by Human Resources</p>
        <h2>Salary<b>Certificate.</b></h2>
        <p class="xc-tar" lang="ar" dir="rtl">شهادة راتب</p>
        <div class="xc-tick"><i></i><i></i><i></i></div>
        <p class="xc-purpose">Issued in two copies — one handed to the employee at ${p.possessive} request, one retained in the service file.</p>
      </div>
      <div class="xc-issuer">
        <span class="xc-micro">Issued by — the Company</span>
        <p class="xl-co">${companyName}</p>
        <p>Commercial Register No. ${number(recital.commercialRegisterNumber)}</p>
        <p>Unified Register No. ${number(recital.unifiedRegisterNumber)}</p>
        <p>Tax Card No. ${number(recital.taxCardNumber)}</p>
      </div>
    </div>

    <div class="xc-party">
      <p class="pm-shead xc-micro">Employee details</p>
      <dl class="xc-facts xc-fields">
        ${fields}
      </dl>
    </div>

    <section class="cert__body xc-text">
      <h2 class="cert__salutation xc-salute">To whom it may concern,</h2>
      <p>${employment}</p>
      <p>${salaryLead} ${value("BASE_SALARY_EN", values.baseSalaryFigure)}${words}. The amount stated is the base salary only; it does not include allowances, incentives or any other variable pay.</p>
      ${certificatePayStripHtml("en", values.startsOn, values.endsOn, values.departed, values.baseSalary)}
      <p>This letter has been issued at ${p.possessive} own request, to be presented to whom it may concern, without any liability on the company towards third parties.</p>
    </section>

    <section class="cert__sign xc-sign">
      <p class="pm-shead xc-micro">Signature and approval</p>
      <p class="cert__signfor">For the company — Human Resources</p>
      ${certificateSignCellsHtml(["Name and title", "Signature", "Company stamp"])}
    </section>
    ${premiumPageChrome()}
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
    values.baseSalary !== null
      ? `It states the BASE monthly salary on record, ${values.baseSalaryFigure}. Not the basic, not the net and not the gross.`
      : "No base salary is on record, so the salary prints as a blank rule. Correct the record, or write the base salary in, before it leaves the desk.",
    values.departed
      ? "This employee has LEFT: the letter states the period of service and the LAST base salary."
      : "It states that this employee is currently employed, read from the employee record.",
  ];

  return `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(`HR Letter — ${values.employeeName}`)}</title>
<style>
  /* THE SQUARE-EDGE GOLDEN RULE, asserted rather than inherited — the English certificate's guard.
     NO BACKTICKS IN THIS STYLESHEET — it is inside a template literal, and one ends the string. */
  *, *::before, *::after { box-sizing: border-box; border-radius: 0 !important; }
  html, body { margin: 0; padding: 0; background: #e2e8f0; }
  html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    /* The English certificate's Latin stack; the design file sets the premium one on the sheet. */
    font-family: "Segoe UI", Calibri, Candara, "Helvetica Neue", Arial, sans-serif;
    color: #1A1A1A;
    font-size: 10.5pt;
    line-height: 1.6;
  }

  /* The sheet on screen; the premium stylesheet below adds its padding and the A4 page with no
     margin, which is what lets the frame and the foot reach the edges. */
  .copy {
    width: 210mm;
    min-height: 297mm;
    margin: 0 auto 8mm;
    background: #fff;
    box-shadow: 0 1px 3px rgba(15, 23, 42, 0.25);
  }
  .copy + .copy { page-break-before: always; break-before: page; }

  /* A filled blank and a ruled one — the preview screen finds both by their data-hp-key. */
  .fill { padding: 0; background: none; color: inherit; font-weight: 700; }
  .rule-line { color: #91a4b7; letter-spacing: 0.2mm; }

  @media print {
    html, body { background: #fff; }
    .copy { width: auto; min-height: 0; margin: 0; box-shadow: none; }
  }
${PRINT_BANNER_CSS}
${premiumDocumentStylesheet(".copy")}
${EXPERIENCE_CERTIFICATE_DESIGN_CSS}
${SALARY_LETTER_DESIGN_CSS}
</style>
</head>
<body>
${printBanner(banner)}
${body}
${flowFieldLayer(fields, {
  BASE_SALARY_EN: values.baseSalaryFigure,
  BASE_SALARY_WORDS_EN: values.baseSalaryWords,
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
