/**
 * CERTIFICATE OF EXPERIENCE, ARABIC — شهادة خبرة, in the certificate's own design.
 *
 * The owner chose the design on 2026-10-28 (Cairo) and asked for it to be the certificate HR prints
 * from the HR forms module. It replaces this paper's earlier dress — the contract's document layout,
 * which he had ticked "keep" on 2026-10-13 — with the same anatomy as the English certificate
 * (`experience-certificate-design.ts`), so a pair printed minutes apart for one person reads as one
 * instrument in two languages.
 *
 * 🔴 THE WORDS ARE THE TEMPLATE'S, UNCHANGED. Every sentence, heading and label on this page is read
 * from `HR_PAPER_EXPERIENCE_CERTIFICATE_V1` (`hr-paper-text.ts`) and filled by the same
 * `buildHrPaperValues` as before — including «السيد / السيدة المبيّنة بياناته». Only the dress is
 * this file's. A wording change belongs in the template, as a new version, never here.
 *
 * The facts are resolved where they always were: `service-period.ts` answers whether the employee has
 * left and what the period is, and the English certificate reads the same answer.
 *
 * THE SIGNING BOXES ARE BLANK, and no seal is drawn (owner, 2026-10-28: "Blank box, sign by hand").
 *
 * AN ARCHIVED VERSION KEEPS ITS OWN DRESS. Only version 1 exists today and it is the current one; a
 * later version asked for from the Archive screen is drawn by `renderHrPaperHtml` exactly as it was
 * signed.
 */

import { copiesClauseAr } from "@/lib/hiring-pack/copies-clause";
import {
  certificateMonthYear,
  certificateSignCellsHtml,
  certificateSpanHtml,
  EXPERIENCE_CERTIFICATE_DESIGN_CSS,
} from "@/lib/hiring-pack/experience-certificate-design";
import { flowFieldLayer, type DocumentFieldRow } from "@/lib/hiring-pack/field-layout";
import type { HrPaperTemplate, HrPaperToken } from "@/lib/hiring-pack/hr-paper-template";
import { HR_PAPER_EXPERIENCE_CERTIFICATE_V1, hrPaperById } from "@/lib/hiring-pack/hr-paper-text";
import {
  premiumDocumentStylesheet,
  premiumMasthead,
  premiumPageChrome,
} from "@/lib/hiring-pack/premium-identity";
import {
  buildHrPaperValues,
  fillMarkedHtml,
  gridValue,
  renderHrPaperHtml,
} from "@/lib/hiring-pack/render-hr-paper";
import {
  ARABIC_FONT_STACK,
  escapeHtml,
  PRINT_BANNER_CSS,
  printBanner,
  todayInCairo,
} from "@/lib/hiring-pack/render-shared";
import { resolveServicePeriod, type ServicePeriod } from "@/lib/hiring-pack/service-period";
import type { HiringPackData } from "@/lib/hiring-pack/types";

type Values = Partial<Record<HrPaperToken, string>>;

/** «شهادة خبرة» → «شهادة <b>خبرة</b>»: the title's last word set heavy, as the English sets "Experience." */
function heroTitle(title: string): string {
  const words = title.trim().split(/\s+/u);
  if (words.length < 2) return `<b>${escapeHtml(title)}</b>`;
  const last = words.pop() as string;
  return `${escapeHtml(words.join(" "))} <b>${escapeHtml(last)}</b>`;
}

/** The certificate, as one printable copy. */
function renderCopy(
  template: HrPaperTemplate,
  values: Values,
  service: ServicePeriod,
  issuedOn: string,
): string {
  const [salutation = "", ...paragraphs] = template.bodyParagraphsAr;
  const column = template.signatureColumns[0];
  const [nameCell = "", signatureCell = "", stampCell = ""] = column?.fieldsAr ?? [];
  const issuedMonth = certificateMonthYear(issuedOn, "ar");

  // The period in figures sits under the paragraph that states it — the first after the salutation.
  const span = certificateSpanHtml({
    lang: "ar",
    startsOn: service.startsOn,
    endsOn: service.endsOn,
    departed: service.departed,
    countable: service.countable,
  });
  const body = paragraphs
    .map((text, index) => `<p>${fillMarkedHtml(text, values)}</p>${index === 0 ? span : ""}`)
    .join("\n      ");

  const party = template.secondPartyFields
    .map(
      (field) =>
        `<div${field.wide ? ' class="xc-wide"' : ""}><dt>${escapeHtml(field.labelAr)}</dt><dd>${gridValue(field, values)}</dd></div>`,
    )
    .join("\n        ");

  // THE ORDER OF THE CHILDREN IS LOAD-BEARING, and it is the English certificate's: the hero and the
  // party block are `div`s, the words and the signing block are the only two `section`s, the signing
  // row is the signing section's only `div`, and the chrome is appended LAST — so a hand-placed mark
  // measured as `section:nth-of-type(2) > div:nth-of-type(1) > span:nth-of-type(3)` is the stamp box
  // on both papers.
  return `<article class="copy xc xc--ar">
    ${premiumMasthead({
      legalNameAr: "",
      legalNameEn: null,
      title: "إدارة الموارد البشرية",
      titleLang: "ar",
      subtitles: [{ text: `المركز العام · القاهرة${issuedMonth ? ` · ${issuedMonth}` : ""}`, lang: "ar" }],
    })}

    <div class="xc-hero">
      <div>
        <p class="xc-kicker xc-micro"><i class="xc-dia"></i>${escapeHtml(template.footerAr)}</p>
        <h2>${heroTitle(template.titleAr)}</h2>
        <p class="xc-law">${escapeHtml(template.subtitleAr)}</p>
        <div class="xc-tick"><i></i><i></i><i></i></div>
        <p class="xc-purpose">${escapeHtml(template.purposeAr)}</p>
      </div>
      <div class="xc-issuer">
        ${template.firstPartyHeadingAr ? `<span class="xc-micro">${escapeHtml(template.firstPartyHeadingAr)}</span>` : ""}
        ${template.firstPartyLinesAr.map((line) => `<p>${fillMarkedHtml(line, values)}</p>`).join("\n        ")}
      </div>
    </div>

    <div class="xc-party">
      ${template.secondPartyHeadingAr ? `<p class="pm-shead xc-micro">${escapeHtml(template.secondPartyHeadingAr)}</p>` : ""}
      <dl class="xc-facts xc-fields">
        ${party}
      </dl>
    </div>

    <section class="xc-text">
      <h2 class="xc-salute">${escapeHtml(salutation)}</h2>
      ${body}
    </section>

    <section class="cert__sign xc-sign">
      ${template.signaturesHeadingAr ? `<p class="pm-shead xc-micro">${escapeHtml(template.signaturesHeadingAr)}</p>` : ""}
      ${column ? `<p class="cert__signfor">${escapeHtml(column.headingAr)}</p>` : ""}
      ${certificateSignCellsHtml([nameCell, signatureCell, stampCell])}
    </section>
    ${premiumPageChrome()}
  </article>`;
}

/**
 * The printable paper. Same signature as the house papers' renderer, so the dispatcher can hand it
 * the same arguments.
 */
export function renderExperienceCertificateArHtml(
  data: HiringPackData,
  copies: number,
  templateId?: string | null,
  fields: readonly DocumentFieldRow[] = [],
  statedCopies?: number,
): string {
  const template = HR_PAPER_EXPERIENCE_CERTIFICATE_V1;
  // A different version of THIS paper, asked for from the Archive, keeps the dress it was signed in.
  const requested = hrPaperById(templateId);
  if (requested && requested.kind === template.kind && requested.id !== template.id) {
    return renderHrPaperHtml(data, copies, template, templateId, fields, statedCopies);
  }

  const total = Math.max(1, Math.trunc(copies));
  const today = todayInCairo();
  const service = resolveServicePeriod(data, today);
  const values: Values = {
    ...buildHrPaperValues(data),
    COPIES_CLAUSE: copiesClauseAr(statedCopies ?? total),
  };
  const body = Array.from({ length: total }, () =>
    renderCopy(template, values, service, today),
  ).join("\n");
  const employeeName = data.employee.nameAr ?? data.employee.fullName;

  // The house papers' banner for a certificate, word for word.
  const banner = [
    `${employeeName} — ${template.titleAr}, ${total} ${total === 1 ? "copy" : "copies"}.`,
    data.employee.departed
      ? "It states that their service ENDED. Check the last working day above before it leaves the desk — this paper goes to their next employer."
      : "It states that they are STILL EMPLOYED here, and closes the period at today's date. That is read from their employee record, not from the exit form.",
    "No salary, no reason for leaving, and no statement of conduct — each left out on purpose, not pending. A recommendation is written and signed by a person, never printed from a button.",
  ];

  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(template.titleAr)} — ${escapeHtml(employeeName)}</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #e2e8f0; }
  /* Keep the rules and the zebra when a browser prints: Chrome's dialog ships with "Background
     graphics" unticked. NO BACKTICKS IN THIS BLOCK — it is inside a template literal. And no
     corner-rounding property, not even to say it is absent: the tests read this stylesheet for it. */
  html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    font-family: ${ARABIC_FONT_STACK};
    color: #111;
    font-size: 9pt;
    line-height: 1.4;
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

  /* A filled blank and a ruled one, as on every house paper — the preview screen finds both by their
     data-hp-key. */
  .fill { padding: 0; background: none; color: inherit; font-weight: 700; }
  .rule-line { color: #91a4b7; letter-spacing: 0.2mm; }

  @media print {
    html, body { background: #fff; }
    .copy { width: auto; min-height: 0; margin: 0; box-shadow: none; }
  }
${PRINT_BANNER_CSS}
${premiumDocumentStylesheet(".copy")}
${EXPERIENCE_CERTIFICATE_DESIGN_CSS}
</style>
</head>
<body>
${printBanner(banner)}
${body}
${flowFieldLayer(fields, values)}
</body>
</html>`;
}
