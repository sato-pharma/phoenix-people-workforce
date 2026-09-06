/**
 * CERTIFICATE OF EXPERIENCE, ENGLISH — the copy an employee takes to an embassy, a Gulf employer or
 * a bank.
 *
 * The Arabic certificate (`hr-paper-text.ts`) is the same instrument for an Egyptian reader. Both
 * are current at once and HR prints whichever is being asked for; they are two documents rather than
 * two versions of one for the reason the custody pair are, set out in `custody-template.ts` — the
 * archive's rule is exactly one CURRENT version per document, so filing the English one as a version
 * of the Arabic would tell HR the Arabic had been withdrawn.
 *
 * THE FACTS ARE NOT RESOLVED HERE. `service-period.ts` answers whether he has left and what the
 * period is, and both certificates read it, because the two are routinely printed minutes apart for
 * the same person and a pair that disagrees is worse than either being wrong alone.
 *
 * The three omissions are the Arabic paper's, for the same reasons, and they are listed beside that
 * template: NO SALARY, NO REASON FOR LEAVING, NO STATEMENT OF CONDUCT. They matter more here, not
 * less — this is the copy that goes to a stranger in another country.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT AN `HrPaperTemplate`. Every field on that type is `...Ar` and its renderer emits
 * `<html lang="ar" dir="rtl">`; an English paper is not a translation slot in it, it is a different
 * direction, a different face stack and a different shape. Adding an English twin of all twenty-odd
 * fields would put a nullable second language into six papers that will never have one. This
 * follows `payslip-document.ts` instead — the house identity's English-facing mode, which exists
 * for exactly this — and leaves the Arabic family untouched.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 🔴 IT IS BUILT TO SURVIVE A PDF IMPORT INTO CANVA, at the owner's request, 2026-09-06. Three
 * choices below are that requirement and not house style, and a later session tidying them will
 * break the thing they were for without anything going red:
 *
 *   1. PROSE, NOT A FACTS GRID. The Arabic certificate carries a bordered identity table; every
 *      cell border in it becomes its own vector rectangle on import, and every cell its own text
 *      box, so a seven-row grid arrives as roughly forty separate elements somebody has to drag.
 *      The same facts read perfectly well inside the sentence, which is how an English certificate
 *      of experience is written anyway — this is the rare case where the import-friendly shape and
 *      the correct shape are the same one.
 *
 *   2. REAL TEXT, NEVER OUTLINES OR AN IMAGE. Chromium keeps text as text with the font embedded,
 *      which is what makes it editable on the other side. Nothing here may be rasterised, and the
 *      page must not be rebuilt as an SVG.
 *
 *   3. ONE PAGE, and the content is trimmed to hold that. A certificate spilling onto a second
 *      sheet imports as two artboards.
 *
 * What could NOT be verified from here is Canva itself, which needs the owner's account: the PDF is
 * confirmed to be single-page A4 with extractable text and embedded fonts — the properties an
 * importer needs — and the import was not exercised. Canva substitutes any face it does not carry,
 * so expect the type to shift slightly; the text stays editable, which is the point.
 */

import { systemLegalEntity } from "@/config/system-settings";
import { flowFieldLayer, type DocumentFieldRow } from "@/lib/hiring-pack/field-layout";
import {
  HOUSE_IDENTITY_CSS,
  HOUSE_MARK_SRC,
  houseLetterhead,
} from "@/lib/hiring-pack/house-identity";
import {
  describeServiceDurationEn,
  escapeHtml,
  formatLongDateEn,
  PRINT_BANNER_CSS,
  printBanner,
  todayInCairo,
} from "@/lib/hiring-pack/render-shared";
import { resolveServicePeriod } from "@/lib/hiring-pack/service-period";
import type { HiringPackData } from "@/lib/hiring-pack/types";

/** The version id, as the template registry knows it. Never renamed — a reprint resolves through it. */
export const EXPERIENCE_CERTIFICATE_EN_ID = "experience-certificate-en-v1";

/** The rule an absent value prints as. The Latin twin of the Arabic papers' run of dots. */
export const EN_BLANK_RULE = "……………………";

/**
 * How to address him.
 *
 * "Mr./Ms." when nobody recorded a gender, rather than a guess. This is the one field on the page
 * where being wrong is both immediately visible and insulting, and the combined form is what a
 * careful letter uses when it does not know — it reads as a form, not as an error.
 */
function honorific(gender: string | null): string {
  const value = (gender ?? "").trim().toLowerCase();
  if (value === "male") return "Mr.";
  if (value === "female") return "Ms.";
  return "Mr./Ms.";
}

/**
 * He / she / they, derived from the SAME value as the honorific so the two cannot disagree on one
 * page — "Ms. … he held the position" is the kind of error a reader notices before anything else.
 *
 * "They" when nobody recorded a gender. It is the only pronoun that is not a guess about a real
 * person, and it costs nothing here: the document names him in full one line above, so there is no
 * ambiguity about who is meant.
 */
function pronounsFor(honorificValue: string): { subject: string; possessive: string } {
  if (honorificValue === "Mr.") return { subject: "he", possessive: "his" };
  if (honorificValue === "Ms.") return { subject: "she", possessive: "her" };
  return { subject: "they", possessive: "their" };
}

/** "he" → "He", for a sentence that opens on the pronoun. */
function sentenceCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** A value that IS there, marked so the preview screen can offer it for correction. */
function fill(token: string, text: string): string {
  return `<span class="fill" data-hp-key="${escapeHtml(token)}">${escapeHtml(text)}</span>`;
}

/** A value that is NOT there: a rule carrying its token, so the fill screen can see it. */
function rule(token: string): string {
  return `<span class="rule-line" data-hp-key="${escapeHtml(token)}">${EN_BLANK_RULE}</span>`;
}

/** Either, on one rule: never an empty string, which would close the sentence up around a gap. */
function value(token: string, text: string | null | undefined): string {
  const clean = typeof text === "string" ? text.trim() : "";
  return clean.length > 0 ? fill(token, clean) : rule(token);
}

export type ExperienceCertificateEnValues = {
  employeeName: string;
  honorific: string;
  nationalId: string;
  hrId: string;
  jobTitle: string;
  hireDate: string;
  serviceEnd: string;
  serviceDuration: string;
  issueDate: string;
  departed: boolean;
  /** Whether the period can be stated at all — see `service-period.ts`. */
  countable: boolean;
};

/**
 * Every value the English certificate states, resolved once.
 *
 * THE ENGLISH NAME AND THE ENGLISH JOB TITLE, which is the inverse of the Arabic papers' rule and
 * not a departure from it. The owner's instruction of 2026-08-31 was that the ARABIC contract must
 * never fall back to the English job title off the employee record — an Arabic legal instrument
 * carrying an English word in its وظيفة box. Here the English one is the correct value and the
 * Arabic would be the wrong one, for the same reason in the other direction.
 *
 * THE DEPARTMENT IS DELIBERATELY ABSENT. The pack carries it only in Arabic (`departmentAr`), and
 * an Arabic department name inside an English sentence read at a visa window is worse than no
 * department at all. A certificate of experience certifies a person, a position and a period; the
 * position is the load-bearing fact and it is here in English.
 */
export function buildExperienceCertificateEnValues(
  data: HiringPackData,
): ExperienceCertificateEnValues {
  const today = todayInCairo();
  const service = resolveServicePeriod(data, today);

  return {
    employeeName: data.employee.fullName,
    honorific: honorific(data.employee.gender),
    nationalId: data.employee.nationalId ?? "",
    hrId: data.employee.hrId,
    jobTitle: data.employee.jobTitle ?? "",
    hireDate: formatLongDateEn(service.startsOn),
    // A leaver's last working day, spelled out. Somebody still serving closes the period at the day
    // the certificate is issued, and the sentence after it says in words that he has not left.
    serviceEnd: service.departed
      ? formatLongDateEn(service.endsOn)
      : "the date of this certificate",
    serviceDuration: describeServiceDurationEn(service.startsOn, service.endsOn),
    issueDate: formatLongDateEn(today),
    departed: service.departed,
    countable: service.countable,
  };
}

/** The certificate, as one printable copy. */
function renderCopy(values: ExperienceCertificateEnValues): string {
  const p = pronounsFor(values.honorific);

  // The period sentence. `serviceEnd` is already either a date or the words that close it for
  // somebody still serving, so one sentence covers both and cannot be assembled wrongly. The span
  // is dropped entirely rather than ruled when it cannot be counted — a dash and a run of dots
  // mid-sentence reads as a defect, and the two dates on either side already state the period.
  const duration = values.countable
    ? ` — a total period of ${value("SERVICE_DURATION", values.serviceDuration)}`
    : "";

  const status = values.departed
    ? `${sentenceCase(p.subject)} is no longer in the employment of the company.`
    : `${sentenceCase(p.subject)} remains in the employment of the company as at the date of this certificate.`;

  return `<article class="cert">
    ${houseLetterhead({
      legalNameAr: systemLegalEntity.legalNameAr,
      legalNameEn: systemLegalEntity.legalNameEn,
      purposeEn: "Issued at the employee's request · One copy retained in the service file",
      subtitleEn: `Issued on ${values.issueDate}`,
      titleAr: "شهادة خبرة",
      titleEn: "Certificate of Experience",
    })}

    <section class="cert__body">
      <h2 class="cert__salutation">To whom it may concern,</h2>

      <p>This is to certify that ${escapeHtml(values.honorific)} ${value(
        "EMPLOYEE_NAME_EN",
        values.employeeName,
      )}, holder of National Identification Number ${value(
        "NATIONAL_ID",
        values.nationalId,
      )} and employee code ${value(
        "HR_ID",
        values.hrId,
      )}, was employed by ${escapeHtml(systemLegalEntity.legalNameEn)} from ${value(
        "HIRE_DATE_EN",
        values.hireDate,
      )} to ${value("SERVICE_END_EN", values.serviceEnd)}${duration}.</p>

      <p>Throughout this period ${p.subject} held the position of ${value(
        "JOB_TITLE_EN",
        values.jobTitle,
      )}. ${escapeHtml(status)}</p>

      <p>This certificate has been issued at ${p.possessive} own request, to be presented to whom
      it may concern, without any liability on the company towards third parties.</p>
    </section>

    <section class="cert__sign">
      <p class="cert__signfor">For ${escapeHtml(systemLegalEntity.legalNameEn)} — Human Resources</p>
      <div class="cert__signrow">
        <span><em>Name and title</em></span>
        <span><em>Signature</em></span>
        <span><em>Company stamp</em></span>
      </div>
    </section>

    <p class="cert__foot">Certificate of Experience · Issued by Human Resources</p>
  </article>`;
}

/**
 * The printable page.
 *
 * `copies` stamps the same page out N times, as every other paper in this module does, so the
 * PDF driver's per-copy page numbering counts against each copy rather than the whole file.
 */
export function renderExperienceCertificateEnHtml(
  data: HiringPackData,
  copies: number,
  _templateId?: string | null,
  fields: readonly DocumentFieldRow[] = [],
): string {
  const values = buildExperienceCertificateEnValues(data);
  const total = Math.max(1, Math.trunc(copies));
  const body = Array.from({ length: total }, () => renderCopy(values)).join("\n");

  const banner = [
    `${values.employeeName} — Certificate of Experience, ${total} ${total === 1 ? "copy" : "copies"}.`,
    values.departed
      ? "It states that this employee's service ENDED. Check the last working day before it leaves the desk — this paper goes to a reader outside the company."
      : "It states that this employee is STILL EMPLOYED here, and closes the period at today's date. That is read from the employee record, not from the exit form.",
    "No salary, no reason for leaving, and no statement of conduct — each left out on purpose, not pending. A recommendation is written and signed by a person, never printed from a button.",
    "Saving this as a PDF keeps the text editable if it is later imported into a design tool. Do not flatten it to an image.",
  ];

  return `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(`Certificate of Experience — ${values.employeeName}`)}</title>
<style>
${HOUSE_IDENTITY_CSS}

/* THE SQUARE-EDGE GOLDEN RULE, asserted rather than inherited. This page may be rendered under a
   stylesheet that ships a 4 px default radius; nothing here sets one, and this makes sure nothing
   picks one up either. Same guard, and the same reason, as the payslip's. */
*, *::before, *::after { box-sizing: border-box; border-radius: 0 !important; }

@page { size: A4; margin: 18mm 20mm 16mm; }

html, body { margin: 0; padding: 0; background: #e2e8f0; }
body {
  /* A LATIN STACK, and every face in it is one Windows already has, so HR's own printout matches
     what the server produces as closely as two machines can. The Arabic papers' stack is not used
     here: it leads with Tahoma for Arabic metrics, which is not the face an English letter wants.
     HOUSE_TYPE is deliberately NOT read — it names Aptos, which is the WORKBOOK face; see the
     note on that constant for why it does not reach the documents. */
  font-family: "Segoe UI", Calibri, Candara, "Helvetica Neue", Arial, sans-serif;
  color: var(--phx-doc-body);
  font-size: 10.5pt;
  line-height: 1.6;
}

.cert {
  width: 210mm;
  min-height: 297mm;
  margin: 0 auto 8mm;
  padding: 18mm 20mm 16mm;
  background: #fff;
  box-shadow: 0 1px 3px rgba(15, 23, 42, .25);
}
.cert + .cert { page-break-before: always; break-before: page; }

.cert__body { margin-top: 9mm; }

.cert__salutation {
  margin: 0 0 5mm;
  color: var(--phx-doc-deep);
  font-size: 11.5pt; font-weight: 700; letter-spacing: .01em;
}

/* Justified, with generous leading. This is the whole document — four paragraphs — so it can afford
   the space, and a certificate that fills its page reads as a considered letter rather than a
   receipt. */
.cert__body p { margin: 0 0 5mm; text-align: justify; }
.cert__body p:last-child { margin-bottom: 0; }

/* A filled value and an empty one. The fill is Brand Deep and semibold — carried by TYPE, never by
   a highlight, which is the ink rule: a tinted box behind every value would put a fill on two
   thirds of the page. */
.fill { color: var(--phx-doc-deep); font-weight: 600; }
.rule-line { color: var(--phx-doc-muted); letter-spacing: .04em; }

.cert__sign { margin-top: 14mm; border-top: .5pt solid var(--phx-doc-hair); padding-top: 4mm; }
.cert__signfor {
  margin: 0 0 10mm;
  color: var(--phx-doc-deep); font-size: 10pt; font-weight: 700;
}
/* Three signing spaces on one row. A grid rather than a table: a table draws cell borders that
   become their own elements in an imported PDF, and the rule under each space is all that is
   wanted. */
.cert__signrow { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8mm; }
.cert__signrow span {
  display: block;
  border-top: .5pt solid var(--phx-doc-hair);
  padding-top: 1.5mm;
}
.cert__signrow em {
  color: var(--phx-doc-muted); font-size: 8pt; font-style: normal; font-weight: 600;
}

.cert__foot {
  margin: 12mm 0 0;
  color: var(--phx-doc-muted); font-size: 7.5pt; font-weight: 600; text-align: center;
}

@media print {
  html, body { background: #fff; }
  .cert { width: auto; min-height: 0; margin: 0; padding: 0; box-shadow: none; }
}

${PRINT_BANNER_CSS}
</style>
</head>
<body>
${printBanner(banner)}
${body}
${flowFieldLayer(fields, {
  EMPLOYEE_NAME_EN: values.employeeName,
  HIRE_DATE_EN: values.hireDate,
  HR_ID: values.hrId,
  JOB_TITLE_EN: values.jobTitle,
  NATIONAL_ID: values.nationalId,
  SERVICE_DURATION: values.serviceDuration,
  SERVICE_END_EN: values.serviceEnd,
})}
</body>
</html>`;
}

/** The mark this page carries, so a test can assert the on-light file without parsing the HTML. */
export const EXPERIENCE_CERTIFICATE_EN_MARK = HOUSE_MARK_SRC;
