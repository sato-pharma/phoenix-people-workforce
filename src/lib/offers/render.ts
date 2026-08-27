import { OFFER_DEFAULT_FONT, OFFER_DEFAULT_FONT_SIZE_PT, OFFER_DEFAULT_THEME } from "@/lib/offers/default-template";
import { deriveOfferPay, formatOfferAmount } from "@/lib/offers/pay";
import { systemLegalEntity } from "@/config/system-settings";
import type { OfferBlock, OfferFields, OfferTemplateVariant, OfferTheme } from "@/lib/offers/types";

/**
 * Blocks → the printable offer document.
 *
 * This is the print/PDF renderer. It emits the design exactly as drawn: CSS grid, flexbox, `pt`
 * units, hairline rules. That is safe here because the only thing that ever renders it is a
 * headless Chromium (see `pdf.ts`) or a browser preview — both of which are modern engines.
 *
 * It is NOT safe to email. Outlook's word-processor rendering engine ignores `display:grid` and
 * `display:flex` outright, which would collapse the four-column meta strip, the benefits grid and
 * the signature block into a single unstyled column. `render-email.ts` is the second renderer for
 * that target, built on nested tables. Two renderers is the deliberate cost of having both a
 * pixel-accurate PDF and a body that survives Outlook.
 */

/** HTML-escape a value being substituted into the document. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * "SAMAA SHALABY" → "SS", for the initials disc in the executive design.
 *
 * First and last word only. A three-part Arabic name rendered as three letters overflows the disc,
 * and a one-word name still has to produce something rather than an empty circle.
 */
export function offerInitials(name: string): string {
  const words = name
    .split(/[\s.]+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((word) => word !== "");
  if (words.length === 0) return "";
  const first = words[0]?.[0] ?? "";
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

/**
 * Every token a template may reference.
 *
 * The eight money tokens are DERIVED, never stored on the row and never typed — that is the
 * "magic formula" the owner asked for. Whoever writes the offer types the total package; basic,
 * transport and both annual columns compute from it.
 */
export function buildOfferTokens(fields: OfferFields): Record<string, string> {
  const pay = deriveOfferPay({
    costOfLiving: fields.costOfLiving,
    totalMonthly: fields.totalMonthly,
  });

  return {
    basicAnnual: formatOfferAmount(pay.basic.annual),
    basicMonthly: formatOfferAmount(pay.basic.monthly),
    candidateEmail: fields.candidateEmail,
    candidateName: fields.candidateName,
    // The employer's own identity, read from the same `systemLegalEntity` the employment contract
    // and Form 1 read. Retyping it into a template is how an offer and the contract that follows it
    // end up naming two different companies.
    companyAddress: systemLegalEntity.headOfficeAr,
    companyName: systemLegalEntity.legalNameEn,
    companyNameAr: systemLegalEntity.legalNameAr,
    contractTerm: fields.contractTerm,
    costOfLivingAnnual: formatOfferAmount(pay.costOfLiving.annual),
    costOfLivingMonthly: formatOfferAmount(pay.costOfLiving.monthly),
    dateOfIssue: fields.dateOfIssue,
    initials: offerInitials(fields.candidateName),
    reference: fields.reference,
    reportsTo: fields.reportsTo,
    salutationName: fields.salutationName,
    startDate: fields.startDate,
    territory: fields.territory,
    title: fields.title,
    totalAnnual: formatOfferAmount(pay.total.annual),
    totalMonthly: formatOfferAmount(pay.total.monthly),
    transportAnnual: formatOfferAmount(pay.transport.annual),
    transportMonthly: formatOfferAmount(pay.transport.monthly),
    validUntil: fields.validUntil,
  };
}

/**
 * Substitute `{{token}}` placeholders.
 *
 * An UNKNOWN token is left standing, not blanked. A misspelt `{{reprotsTo}}` then shows as itself
 * on the preview — visible, and fixable before sending. Blanking it would print a legal document
 * with a silent hole in it, which is the failure that actually costs something.
 */
export function fillOfferTokens(source: unknown, tokens: Record<string, string>): string {
  return String(source ?? "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key: string) => {
    const value = tokens[key];
    return value === undefined ? match : escapeHtml(value);
  });
}

type Item = Record<string, unknown>;

function items(props: Record<string, unknown>): Item[] {
  const raw = props.items;
  return Array.isArray(raw) ? (raw as Item[]) : [];
}

/**
 * The logo for the letterhead: the block's own prop wins, the caller's default fills in.
 *
 * A designer who clears the logo field is choosing a wordmark-only letterhead, so an empty string
 * in the block must NOT fall through to the caller's default — only an absent prop does.
 */
function letterheadLogo(prop: unknown, fallback: string | undefined): string {
  if (typeof prop === "string") return prop;
  return fallback ?? "";
}

/**
 * The mark the executive letter carries inside its welcome band. Hidden by the base stylesheet,
 * because the classic letter has no logo there; the executive skin reveals it.
 */
function markImg(logoUrl: string | undefined): string {
  return logoUrl ? `<img class="mark" src="${escapeHtml(logoUrl)}" alt="">` : "";
}

/**
 * The authorised signatory's signature, drawn onto the left-hand rule of the acceptance panel.
 *
 * Resolved exactly like the letterhead logo: the block's own prop wins, the caller's default fills
 * in, and an EMPTY string is a deliberate clearing rather than a miss. Clearing it in the designer
 * is how you produce a letter to be signed by hand — so the empty case has to survive, and must not
 * fall through to the default.
 */
function signatureInk(prop: unknown, fallback: string | undefined): string {
  const src = typeof prop === "string" ? prop : (fallback ?? "");
  return src ? `<img class="sigink" src="${escapeHtml(src)}" alt="">` : "";
}

/** Render one block. Unknown block types render as nothing rather than throwing. */
export function renderOfferBlock(
  block: OfferBlock,
  tokens: Record<string, string>,
  options: { logoUrl?: string; signatureUrl?: string } = {},
): string {
  const p = block.props ?? {};
  const f = (value: unknown) => fillOfferTokens(value, tokens);

  switch (block.type) {
    case "rail":
      return '<div class="rail"></div>';

    case "letterhead": {
      const logo = letterheadLogo(p.logo, options.logoUrl);
      const img = logo ? `<img src="${escapeHtml(logo)}" alt="">` : '<span class="logo-gap"></span>';
      const tagline = f(p.tagline);
      return (
        `<header class="letterhead keep">${img}<div class="org">` +
        `<div class="micro micro-wide name">${f(p.name)}</div>` +
        `<div class="micro unit">${f(p.unit)}</div>` +
        (tagline ? `<div class="micro tagline">${tagline}</div>` : "") +
        "</div></header>"
      );
    }

    case "control":
      return (
        '<div class="control keep">' +
        items(p)
          .map(
            (i) =>
              `<div><div class="micro k">${f(i.k)}</div>` +
              `<div class="v${i.brand ? " brandv" : ""}">${f(i.v)}</div></div>`,
          )
          .join("") +
        "</div>"
      );

    case "title": {
      const badge = f(p.badge);
      const badgeK = f(p.badgeK);
      // The badge is two lines because the uploaded executive letter draws it that way — a tinted
      // label over a white one. Both are optional; with neither set the box is not emitted at all,
      // which is why the classic design is unaffected by this.
      const chip =
        badge || badgeK
          ? `<div class="appt keep">${badgeK ? `<div class="micro k">${badgeK}</div>` : ""}` +
            `${badge ? `<div class="micro v">${badge}</div>` : ""}</div>`
          : "";
      return (
        `<div class="title-row"><div class="title-main"><h1>${f(p.h1)}</h1>` +
        `<div class="role-line">${f(p.sub)}</div></div>${chip}</div><div class="divider-micro"></div>`
      );
    }

    case "text": {
      const avatar = f(p.avatar);
      const html = f(p.html);
      // With no avatar this returns the paragraphs exactly as before — no wrapper, no class, so
      // nothing about the classic design changes.
      if (!avatar) return html;
      return (
        `<div class="lede keep"><div class="lede-mark">${avatar}</div>` +
        `<div class="lede-body">${html}</div></div>`
      );
    }

    case "scope":
      return (
        '<div class="scope keep">' +
        items(p)
          .map((i) => `<div><div class="micro k">${f(i.k)}</div><div class="v">${f(i.v)}</div></div>`)
          .join("") +
        "</div>"
      );

    case "heading": {
      const sub = f(p.sub);
      return (
        '<div class="section-h"><div class="micro micro-wide">' +
        `${f(p.text)}${sub ? `<span class="sub">${sub}</span>` : ""}` +
        '</div><div class="divider-micro"></div></div>'
      );
    }

    case "compensation": {
      const currency = f(p.currency) || "EGP";
      const rows = Array.isArray(p.rows) ? (p.rows as Item[]) : [];
      // The hero and the total row read the SAME derived tokens the body rows do, so the headline
      // figure can never disagree with the table beneath it.
      return (
        '<div class="comp keep"><div class="comp-hero"><div>' +
        `<div class="micro k">${f(p.heroK)}</div>` +
        `<div class="big tnum"><span class="cur">${currency}</span>${tokens.totalMonthly}</div></div>` +
        `<div class="aside"><div class="micro k">${f(p.asideK)}</div>` +
        `<div class="v tnum">${currency} ${tokens.totalAnnual}</div>` +
        `<div class="n">${f(p.heroNote)}</div></div></div>` +
        '<table><thead><tr><th class="micro">Compensation Component</th>' +
        `<th class="micro r">Monthly (${currency})</th>` +
        `<th class="micro r">Annual (${currency})</th></tr></thead><tbody>` +
        rows
          .map(
            (r) =>
              `<tr><td class="lbl">${f(r.l)}</td>` +
              `<td class="r tnum">${f(r.m)}</td><td class="r tnum">${f(r.a)}</td></tr>`,
          )
          .join("") +
        `<tr class="total"><td>${f(p.totalLabel)}</td>` +
        `<td class="r tnum">${tokens.totalMonthly}</td>` +
        `<td class="r tnum">${tokens.totalAnnual}</td></tr></tbody></table>` +
        (p.note ? `<div class="comp-note">${f(p.note)}</div>` : "") +
        "</div>"
      );
    }

    case "benefits":
      return (
        '<div class="benefits keep">' +
        items(p)
          .map((i) => `<div><div class="micro k">${f(i.k)}</div><div class="t">${f(i.t)}</div></div>`)
          .join("") +
        "</div>"
      );

    case "clauses":
      // The parity class is written out rather than left to `:nth-child`, because each clause is a
      // sibling of every OTHER block in the sheet — `:nth-child(even)` would count the letterhead
      // and the salary table too, and the executive design's alternating numeral tiles would land
      // on whichever clauses happened to fall on an even overall position.
      return items(p)
        .map(
          (i, ix) =>
            `<div class="clause keep ${ix % 2 === 0 ? "cl-a" : "cl-b"}${ix === 0 ? " first" : ""}">` +
            `<div class="no tnum">${ix + 1}</div>` +
            `<div class="bd"><div class="h">${f(i.h)}</div><div class="t">${f(i.t)}</div></div></div>`,
        )
        .join("");

    case "steps":
      return (
        '<div class="steps keep">' +
        items(p)
          .map(
            (i) =>
              `<div><div class="micro n">${f(i.n)}</div><div class="h">${f(i.h)}</div>` +
              `<div class="t">${f(i.t)}</div></div>`,
          )
          .join("") +
        "</div>"
      );

    case "signature": {
      // The company's side is pre-signed; the candidate's side is not, and must not be.
      //
      // The headroom, though, goes on BOTH panels. Every cell carries the same ink box and the
      // `signed` class is driven by the block, not by which cell holds the image — otherwise the
      // company's rule would sit 14px lower than the candidate's rule beside it, and four rules at
      // two different heights read as a broken document rather than a signed one. The candidate
      // gets the same room to sign in, which a 17px gap never really gave them anyway.
      const ink = signatureInk(p.leftSignature, options.signatureUrl);
      const row = `sigrow${ink ? " signed" : ""}`;
      const sigRow = (signature: string) =>
        `<div class="${row}">` +
        `<div><div class="sigink-box">${signature}</div><div class="sigline"></div>` +
        '<div class="siglabel">Signature</div></div>' +
        '<div><div class="sigink-box"></div><div class="sigline"></div>' +
        '<div class="siglabel">Date</div></div></div>';

      return (
        `<div class="accept keep"><div class="accept-h"><div class="micro micro-wide">${f(p.title)}</div></div>` +
        `<div class="accept-b"><div><div class="micro k">${f(p.leftK)}</div>` +
        `<div class="party">${f(p.leftName)}</div><div class="sub">${f(p.leftSub)}</div>${sigRow(ink)}</div>` +
        `<div><div class="micro k">${f(p.rightK)}</div><div class="party">${f(p.rightName)}</div>` +
        `<div class="sub">${f(p.rightSub)}</div>${sigRow("")}</div></div></div>`
      );
    }

    // No mark here, by the owner's instruction (2026-08-27). The uploaded letter repeats the logo
    // beside this note as well as inside the welcome band below it, but stacked two lines apart the
    // upper one reads as floating loose on the page. The welcome band keeps its mark; this one goes.
    case "footer":
      return `<footer class="foot"><p>${f(p.text)}</p><div class="micro pg">${f(p.right)}</div></footer>`;

    case "welcome":
      return (
        '<div class="welcome keep"><div class="welcome-b">' +
        `<div class="micro k">${f(p.k)}</div><div class="t">${f(p.text)}</div></div>` +
        `<div class="welcome-cap">${markImg(options.logoUrl)}</div></div>`
      );

    case "pagebreak":
      return '<div class="page-break"></div>';

    case "html":
      return f(p.raw);

    default:
      return "";
  }
}

/**
 * The design system. Twelve custom properties drive every colour in the document.
 *
 * `variant` chooses the SKIN, not the content: both variants render exactly the same block HTML,
 * and the executive rules below are overrides appended after the base sheet. That is what lets the
 * two built-in designs share one editor, one preview and one PDF path — and it is why adding a
 * property here has to be done in the base rules first, or the executive letter silently keeps the
 * old value.
 */
export function offerDocumentCss(
  theme: OfferTheme,
  fontFamily: string,
  fontSizePt: number,
  variant: OfferTemplateVariant = "classic",
): string {
  const merged = { ...OFFER_DEFAULT_THEME, ...theme };
  const vars = Object.entries(merged)
    .filter(([, value]) => typeof value === "string" && value.trim() !== "")
    .map(([key, value]) => `--${key}:${value}`)
    .join(";");

  const base = `
:root{${vars}}
*{margin:0;padding:0;box-sizing:border-box;border-radius:0}
html{-webkit-text-size-adjust:100%}
body{background:#fff;color:var(--ink);font-family:${fontFamily};
  -webkit-font-smoothing:antialiased;font-size:${fontSizePt}pt;line-height:1.48}
@page{size:A4;margin:12mm 13mm 14mm}
.sheet,.sheet *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
.keep{break-inside:avoid}
.page-break{break-before:page}
.rail{height:6px;background:var(--brand)}
.divider-micro{display:flex;align-items:center;margin:11px 0}
.divider-micro::before{content:"";width:72px;height:2px;background:var(--brand);flex:none}
.divider-micro::after{content:"";height:1px;background:var(--hair);flex:1}
.micro{font-size:7.8pt;line-height:1.35;font-weight:700;letter-spacing:1.4px;text-transform:uppercase}
.micro-wide{letter-spacing:1.8px}
.tnum{font-variant-numeric:tabular-nums}
.letterhead{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;padding:10px 0 9px}
.letterhead img{height:40px;width:auto;display:block}
.letterhead .logo-gap{display:block;height:40px}
.letterhead .org{text-align:right}
.letterhead .org .name{color:var(--brand)}
.letterhead .org .unit{color:var(--soft);margin-top:4px}
.letterhead .org .tagline{color:var(--brand);margin-top:3px;font-size:7pt}
.control{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--frame);border:1px solid var(--frame)}
.control > div{background:#fff;padding:7px 10px}
.control .k{color:var(--soft)}
.control .v{margin-top:3px;font-size:9.1pt;font-weight:700;color:var(--ink)}
.control .v.brandv{color:var(--brand)}
h1{font-size:19.5pt;line-height:1.1;font-weight:700;letter-spacing:-0.9px;color:var(--ink);margin-top:14px}
.role-line{margin-top:6px;font-size:9.9pt;color:var(--brand);font-weight:700;letter-spacing:.2px}
.title-row{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}
.title-main{min-width:0;flex:1}
.appt{flex:none;margin-top:16px;padding:7px 11px;background:var(--chip);border:1px solid var(--frame);text-align:right}
.appt .k{color:var(--soft)}
.appt .v{color:var(--brand);margin-top:2px}
p{color:var(--body)}
p + p{margin-top:7px}
.lead{font-size:10.1pt}
strong{color:var(--ink);font-weight:700}
.lede{display:flex;align-items:flex-start;gap:14px}
.lede-mark{flex:none;width:34px;height:34px;border-radius:50%;background:var(--tint);color:var(--brand);
  display:flex;align-items:center;justify-content:center;font-size:11pt;font-weight:700;letter-spacing:.5px}
.lede-body{flex:1;min-width:0}
.scope{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--frame);border:1px solid var(--frame);margin-top:12px}
.scope > div{background:var(--chip);padding:8px 11px}
.scope .k{color:var(--soft)}
.scope .v{margin-top:4px;font-size:9.7pt;font-weight:700;color:var(--ink);line-height:1.3}
.comp{border:1px solid var(--tint-line);margin-top:8px}
.comp-hero{background:var(--tint);padding:12px 16px;display:flex;align-items:flex-end;justify-content:space-between;gap:20px;border-bottom:1px solid var(--tint-line)}
.comp-hero .k{color:var(--brand)}
.comp-hero .big{font-size:24pt;line-height:1;font-weight:700;letter-spacing:-1.4px;color:var(--brand);margin-top:6px}
.comp-hero .big .cur{font-size:14pt;letter-spacing:0;margin-right:5px}
.comp-hero .aside{text-align:right;padding-bottom:3px}
.comp-hero .aside .k{color:var(--soft)}
.comp-hero .aside .v{font-size:14pt;font-weight:700;color:var(--ink);margin-top:5px;letter-spacing:-.4px}
.comp-hero .aside .n{font-size:8.6pt;color:var(--soft);margin-top:3px;font-weight:400;letter-spacing:0;text-transform:none}
table{width:100%;border-collapse:collapse}
.comp th{padding:6px 16px;text-align:left;color:var(--soft);border-bottom:1px solid var(--line);background:#fff}
.comp th.r,.comp td.r{text-align:right}
.comp td{padding:5.5px 16px;border-bottom:1px solid var(--hair);color:var(--muted);font-size:9.3pt}
.comp td.lbl{color:var(--ink)}
.comp tr.total td{border-bottom:0;border-top:2px solid var(--brand);background:var(--chip);font-weight:700;color:var(--ink);font-size:10.2pt;padding-top:8px;padding-bottom:8px}
.comp-note{padding:7px 16px;border-top:1px solid var(--line);color:var(--faint);font-size:8.8pt;background:#fff}
.benefits{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--frame);border:1px solid var(--frame);margin-top:8px}
.benefits > div{background:#fff;padding:8px 12px}
.benefits .k{color:var(--brand)}
.benefits .t{margin-top:4px;color:var(--body);font-size:9.1pt;line-height:1.45}
.section-h{margin-top:15px}
.section-h .micro{color:var(--brand)}
.section-h .sub{margin-left:7px;font-weight:400;letter-spacing:1.2px;color:var(--faint)}
.clause{display:flex;gap:14px;padding:9px 0;border-bottom:1px solid var(--hair)}
.clause.first{border-top:1px solid var(--line)}
.clause .no{flex:none;width:26px;height:26px;background:var(--ink);color:#fff;font-size:9.4pt;font-weight:700;display:flex;align-items:center;justify-content:center;font-variant-numeric:tabular-nums}
.clause .bd{flex:1}
.clause .h{font-size:9.8pt;font-weight:700;color:var(--ink);letter-spacing:.1px}
.clause .t{margin-top:4px;color:var(--body);font-size:9.2pt;line-height:1.5}
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--frame);border:1px solid var(--frame);margin-top:8px}
.steps > div{background:var(--chip);padding:9px 12px}
.steps .n{color:var(--brand)}
.steps .h{margin-top:5px;font-size:9.4pt;font-weight:700;color:var(--ink)}
.steps .t{margin-top:3px;font-size:8.6pt;color:var(--muted);line-height:1.45}
.accept{border:1px solid var(--frame);margin-top:10px}
.accept-h{background:var(--ink);padding:9px 16px}
.accept-h .micro{color:#fff}
.accept-b{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--frame)}
.accept-b > div{background:#fff;padding:12px 15px}
.accept .k{color:var(--soft)}
.accept .party{margin-top:5px;font-size:9.9pt;font-weight:700;color:var(--ink)}
.accept .sub{font-size:8.8pt;color:var(--soft);margin-top:2px}
/* The headroom a signature needs. Zero by default, so an unsigned letter keeps the 17px gap it
   always had; the signed class moves that gap into the ink box rather than adding to it, which is
   what stops a pre-signed panel from growing taller than the unsigned one beside it.
   (No backticks in this comment — the whole stylesheet is one template literal.) */
.sigink-box{height:0}
.sigrow.signed .sigink-box{height:35px;display:flex;align-items:flex-end}
/* Negative, so the rule rides UP into the ink and the signature sits ON the line with its flourish
   crossing it, the way a signed page looks — not hovering in the gap above it. It is set on the row
   rather than the cell, so the Date rule and the candidate's two rules move with it and all four
   stay level. */
.sigrow.signed .sigline{margin-top:-5px}
/* 35px is the signature file's OWN pixel height, so one source pixel lands on one CSS pixel and it
   prints as sharply as the file allows (~96dpi). Enlarging it past its natural size is the one
   change guaranteed to make it look worse — a bigger signature needs a bigger scan, not more CSS. */
.sigink{max-height:35px;max-width:62%;width:auto;display:block;margin-left:5px}
.sigline{margin-top:17px;border-bottom:1px solid var(--ink);height:1px}
.siglabel{margin-top:5px;color:var(--faint);font-size:8pt;letter-spacing:1.2px;text-transform:uppercase;font-weight:700}
.sigrow{display:flex;gap:16px}
.sigrow > div:first-child{flex:1}
.sigrow > div:last-child{width:104px}
.foot{margin-top:14px;padding-top:10px;border-top:1px solid var(--frame);display:flex;justify-content:space-between;gap:20px;align-items:flex-start}
.foot p{font-size:8.4pt;color:var(--faint);line-height:1.5;max-width:66%}
.foot .pg{text-align:right;color:var(--faint)}
/* The classic letter sets its identity in type and carries no mark here. The executive skin shows
   these two; leaving them out of the markup entirely would make the skin unable to reach them. */
.welcome-cap .mark{display:none}
.welcome{display:flex;align-items:stretch;margin-top:12px;border:1px solid var(--frame)}
.welcome-b{flex:1;padding:11px 16px;background:var(--chip)}
.welcome .k{color:var(--brand)}
.welcome .t{margin-top:4px;font-size:11pt;font-weight:700;color:var(--ink);letter-spacing:-.2px}
.welcome-cap{flex:none;width:64px;background:var(--tint)}
.sheet{max-width:210mm;margin:0 auto;padding:0 13mm 14mm;background:#fff}
.sheet .rail{margin:0 -13mm}
@media print{.sheet{max-width:none;padding:0;margin:0}.sheet .rail{margin:0}}
`.trim();

  return variant === "executive" ? `${base}\n${EXECUTIVE_SKIN}` : base;
}

/**
 * The executive skin — the uploaded "Ultra Premium" letter, reproduced from its own content stream.
 *
 * Every measurement here came out of that PDF: US Letter at 612x792pt, a 45pt text margin with the
 * salary table and hero bleeding 7.5pt wider on each side, a 2.8pt two-tone rule under the
 * letterhead, a 4pt three-segment rule under the title, 37.3pt numeral tiles beside the clauses,
 * and a 108pt tinted cap on the closing band. They are written as `pt` because the source is a
 * print document and every one of them is a print measurement.
 *
 * The two `color:` pairs are deliberate, not duplicates: the first is the colour measured in the
 * PDF, the second re-derives it from the brand token so that recolouring the template moves the
 * on-dark text with it. An engine without `color-mix` keeps the measured value.
 */
const EXECUTIVE_SKIN = `
/* The masthead repeats on every page of the uploaded letter, so it is page furniture here rather
   than flow content — Chromium paints it from the same letterhead block via \`offerPageHeaderHtml\`.
   The top margin is what reserves the room for it. */
@page{size:letter;margin:26mm 45pt 34pt}
.sheet{max-width:216mm;padding:0}
.sheet .rail{margin:0}
body{line-height:1.45}
.letterhead{display:none}
.rail{height:2.8pt;background:var(--frame);position:relative}
.rail::before{content:"";position:absolute;left:0;top:0;bottom:0;width:79pt;background:var(--brand)}
.control{gap:0;background:transparent;border:0}
.control > div{background:var(--hair);padding:6pt 9pt}
.control > div:nth-child(even){background:var(--chip)}
.control .k{font-size:6.5pt;color:var(--faint)}
.control .v{font-size:8.5pt;margin-top:3pt}
.title-row{align-items:flex-end}
/* Set in capitals in the uploaded letter, not title case. */
h1{font-size:26pt;letter-spacing:-.9px;margin-top:14pt;text-transform:uppercase}
.role-line{font-size:12pt;margin-top:7pt}
.appt{width:111.6pt;min-height:52pt;margin:0;padding:9pt 11pt;background:var(--ink);border:0;text-align:right;
  display:flex;flex-direction:column;justify-content:center}
.appt .k{font-size:6.5pt;color:#9ab6c7;color:color-mix(in srgb,var(--brand) 45%,#ffffff)}
.appt .v{font-size:9.5pt;color:#fff;margin-top:2pt}
.divider-micro{margin:10pt 0 0;height:4pt}
.divider-micro::before{width:72pt;height:4pt}
.divider-micro::after{height:4pt;background:linear-gradient(90deg,var(--ink) 0 11.4pt,var(--frame) 11.4pt)}
.lede{gap:0;margin-top:0;border:1px solid var(--frame);border-bottom:0}
.lede-mark{width:44.6pt;height:auto;border-radius:0;background:var(--tint);color:var(--brand);
  font-size:13pt;align-items:flex-start;justify-content:center;padding-top:20pt}
.lede-body{padding:12pt 12pt 10pt 7pt}
.lead{font-size:10.5pt;margin-top:6pt}
/* The salutation is set bold in full in the uploaded letter, not just the name inside it. */
.lede-body .lead:first-child{font-weight:700;color:var(--ink);margin-top:0}
.scope{gap:0;background:transparent;border:0;margin-top:0}
.scope > div{background:var(--tint);padding:8pt 10pt}
.scope{border:1px solid var(--frame)}
.scope > div:nth-child(even){background:var(--chip)}
.scope .k{font-size:6.5pt;color:var(--faint)}
.scope .v{font-size:8.5pt;margin-top:3pt}
.section-h{margin-top:15pt;padding-left:12pt;position:relative}
.section-h::before{content:"";position:absolute;left:0;top:1pt;width:6pt;height:12.4pt;background:var(--brand)}
.section-h .micro{font-size:10.5pt;letter-spacing:.4px;color:var(--ink)}
/* "/ NET PACKAGE", "/ CORE CONDITIONS" and the rest are brand blue in the uploaded letter. */
.section-h .sub{font-size:8.5pt;letter-spacing:.4px;color:var(--brand)}
.section-h .divider-micro{display:none}
.comp{border:0;margin-top:10pt;margin-left:-7.5pt;margin-right:-7.5pt}
.comp-hero{background:transparent;border:0;padding:0;gap:1.6pt;align-items:stretch}
.comp-hero > div:first-child{flex:1;background:var(--tint);padding:8pt 7.5pt}
.comp-hero .k{font-size:7pt}
.comp-hero .big{font-size:23.5pt;margin-top:7pt;letter-spacing:-1.1px}
.comp-hero .big .cur{font-size:11pt}
.comp-hero .aside{width:244.4pt;background:var(--chip);padding:9pt 12pt;text-align:right}
.comp-hero .aside .v{font-size:15pt}
.comp-hero .aside .n{font-size:7.5pt}
.comp th{background:var(--ink);color:#fff;border:0;padding:5pt 12pt;font-size:6.5pt}
.comp td{border:0;padding:5pt 12pt;font-size:8pt}
.comp tbody tr td{background:#fff}
.comp tbody tr:nth-child(even) td{background:var(--hair)}
.comp tr.total td{background:var(--tint);border-top:0;font-size:8pt;padding:6pt 12pt}
.comp-note{background:var(--chip);border:0;padding:6pt 12pt;font-size:7pt;line-height:1.4}
.benefits{gap:0;background:transparent;border:1px solid var(--frame);margin-top:8pt}
.benefits > div{background:#fff;padding:8pt 11pt}
.benefits > div:nth-child(even){background:var(--chip)}
.benefits .k{font-size:7pt}
.benefits .t{font-size:8pt;margin-top:5pt}
.clause{gap:0;padding:0;align-items:stretch;border:1px solid var(--frame);border-top:0}
.clause.first{border-top:1px solid var(--frame)}
.clause .no{width:37.3pt;height:auto;font-size:12pt;background:var(--ink);align-items:flex-start;padding-top:11pt}
.clause.cl-b .no{background:var(--brand)}
.clause .bd{background:#fff;padding:9pt 12pt}
.clause.cl-b .bd{background:var(--chip)}
.clause .h{font-size:9pt}
.clause .t{font-size:8pt;margin-top:5pt}
.steps{gap:0;background:transparent;border:1px solid var(--frame);margin-top:8pt}
.steps > div{background:var(--chip);padding:9pt 11pt}
.steps > div:nth-child(even){background:var(--tint)}
.steps .n{font-size:6.5pt;color:var(--brand)}
.steps .h{font-size:9pt;margin-top:5pt;text-transform:uppercase;letter-spacing:.2px}
.steps .t{font-size:8pt;margin-top:5pt}
.accept{border:0;margin-top:14pt}
.accept-h{padding:5pt 12pt}
.accept-b{gap:0;background:transparent}
.accept-b > div{background:#fff;padding:10pt 12pt}
.accept-b > div:nth-child(even){background:var(--chip)}
.accept .party{font-size:9pt}
.accept .sub{font-size:7.5pt}
.foot{margin-top:9pt;padding-top:0;border-top:0}
.foot p{font-size:6.5pt;max-width:100%;line-height:1.35}
.foot .pg{display:none}
.welcome{border:0;margin-top:16pt}
.welcome-b{background:var(--ink);padding:14pt 16pt}
.welcome .k{font-size:7pt;color:#8ed4ef;color:color-mix(in srgb,var(--brand) 40%,#ffffff)}
.welcome .t{color:#fff;font-size:11pt;margin-top:7pt}
.welcome-cap{width:108pt;background:var(--tint);display:flex;align-items:center;justify-content:center}
.welcome-cap .mark{display:block;height:26pt}
`.trim();

export type RenderedOffer = {
  body: string;
  css: string;
  html: string;
  /** Chromium's repeated page furniture. Empty when the design does not ask for any. */
  pageFooterHtml: string;
  /** The masthead Chromium repeats at the top of every page. Empty for designs without one. */
  pageHeaderHtml: string;
  pageSize: "A4" | "Letter";
};

/**
 * The masthead the executive design prints on EVERY page.
 *
 * Same reasoning as the running foot below: the uploaded letter carries the logo and the two-line
 * label at the top of both pages, and flow content cannot repeat itself across a page break. The
 * text and the logo still come from the letterhead BLOCK, so editing it in the designer moves the
 * masthead on every page — the block is simply hidden in the flow by the skin.
 *
 * Chromium renders this in a SEPARATE document that inherits none of the page's CSS, so every rule
 * here has to be inline and every colour a literal.
 */
export function offerPageHeaderHtml(
  blocks: OfferBlock[],
  tokens: Record<string, string>,
  theme: OfferTheme,
  logoUrl?: string,
): string {
  const head = blocks.find((block) => block.type === "letterhead");
  if (!head) return "";

  const unit = escapeHtml(fillOfferTokens(head.props?.unit, tokens).trim());
  const tagline = escapeHtml(fillOfferTokens(head.props?.tagline, tokens).trim());
  const logo = letterheadLogo(head.props?.logo, logoUrl);
  if (!unit && !tagline && !logo) return "";

  const merged = { ...OFFER_DEFAULT_THEME, ...theme };
  const brand = merged.brand ?? "#0b86be";
  const ink = merged.ink ?? "#111820";

  const img = logo
    ? `<img src="${escapeHtml(logo)}" alt="" style="height:34pt;display:block">`
    : "<span></span>";
  // Both lines are set in capitals in the uploaded letter regardless of how they are typed in the
  // designer, so the transform belongs here rather than in the stored prop.
  const cap = "text-transform:uppercase;font-weight:700";
  const label =
    `<div style="text-align:right;line-height:1.55">` +
    (unit
      ? `<div style="font-size:9pt;${cap};letter-spacing:.7px;color:${ink}">${unit}</div>`
      : "") +
    (tagline
      ? `<div style="font-size:8pt;${cap};letter-spacing:.6px;color:${brand}">${tagline}</div>`
      : "") +
    "</div>";

  // `-webkit-print-color-adjust` is what stops Chromium dropping the coloured label in the header
  // document, which prints with backgrounds off by default.
  return (
    `<div style="-webkit-print-color-adjust:exact;width:100%;padding:0 45pt;margin:0;` +
    `font-family:'Segoe UI',Arial,sans-serif;display:flex;align-items:flex-start;` +
    `justify-content:space-between">${img}${label}</div>`
  );
}

/**
 * The running foot the executive design prints on EVERY page.
 *
 * It is page furniture, not a block: the uploaded letter repeats it on both pages with a live
 * page number, and no amount of HTML inside the sheet can do that. Chromium fills `.pageNumber`
 * and `.totalPages` itself when `displayHeaderFooter` is on (see `pdf.ts`). The text still comes
 * from the footer BLOCK's own props, so it stays editable in the designer rather than becoming a
 * hard-coded string nobody can find.
 */
export function offerPageFooterHtml(
  blocks: OfferBlock[],
  tokens: Record<string, string>,
  theme: OfferTheme,
): string {
  const footer = blocks.find((block) => block.type === "footer");
  const mark = fillOfferTokens(footer?.props?.pageMark, tokens).trim();
  if (!mark) return "";

  const right = fillOfferTokens(footer?.props?.right, tokens).trim();
  const merged = { ...OFFER_DEFAULT_THEME, ...theme };
  const faint = merged.faint ?? "#8a959d";
  const ink = merged.ink ?? "#111820";
  const label =
    "font-size:6.5pt;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;" +
    `color:${faint}`;

  // Inline styles only, and no custom properties: Chromium renders header/footer templates in a
  // SEPARATE document that inherits nothing from the page — a `var(--faint)` here resolves to
  // nothing and prints black.
  return (
    `<div style="width:100%;padding:0 45pt;font-family:Arial,Helvetica,sans-serif;` +
    `display:flex;align-items:center;justify-content:space-between;gap:12pt">` +
    `<span style="${label}">${mark}</span>` +
    `<span style="${label}">Page <b style="color:${ink};font-size:9pt" class="pageNumber"></b>` +
    ` / <b style="color:${ink};font-size:9pt" class="totalPages"></b></span>` +
    `<span style="${label}">${right}</span></div>`
  );
}

/** The complete standalone document — what Chromium prints and what the preview shows. */
export function renderOfferDocument(
  template: {
    blocks: OfferBlock[];
    fontFamily?: string;
    fontSizePt?: number;
    theme?: OfferTheme;
    variant?: OfferTemplateVariant;
  },
  fields: OfferFields,
  options: { logoUrl?: string; signatureUrl?: string } = {},
): RenderedOffer {
  const variant: OfferTemplateVariant = template.variant === "executive" ? "executive" : "classic";
  const tokens = buildOfferTokens(fields);
  const body = template.blocks.map((block) => renderOfferBlock(block, tokens, options)).join("");
  const css = offerDocumentCss(
    template.theme ?? {},
    template.fontFamily || OFFER_DEFAULT_FONT,
    template.fontSizePt || OFFER_DEFAULT_FONT_SIZE_PT,
    variant,
  );

  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    `<title>Offer of Employment — ${escapeHtml(fields.candidateName)}</title>` +
    `<style>${css}</style></head><body><div class="sheet">${body}</div></body></html>`;

  return {
    body,
    css,
    html,
    pageFooterHtml: offerPageFooterHtml(template.blocks, tokens, template.theme ?? {}),
    // Only the executive design hides its letterhead from the flow and repeats it as furniture.
    // Emitting one for the classic letter would print its masthead twice on page one.
    pageHeaderHtml:
      variant === "executive"
        ? offerPageHeaderHtml(template.blocks, tokens, template.theme ?? {}, options.logoUrl)
        : "",
    pageSize: variant === "executive" ? "Letter" : "A4",
  };
}
