import { OFFER_DEFAULT_THEME } from "@/lib/offers/default-template";
import { buildOfferTokens, fillOfferTokens } from "@/lib/offers/render";
import { safeOfferStyle } from "@/lib/offers/rich-text";
import type { OfferBlock, OfferFields, OfferTheme } from "@/lib/offers/types";

/**
 * The SECOND renderer: the same blocks, as an email body.
 *
 * Why two renderers rather than one shared piece of HTML — this is the decision to understand
 * before changing anything here:
 *
 *   The print design is built on CSS grid, flexbox, `pt` units and hairline borders. Outlook on
 *   Windows renders mail through Microsoft Word's layout engine, which does not implement grid or
 *   flex AT ALL. Sending the print HTML would not degrade it — it would collapse the four-column
 *   meta strip, the benefits grid, the step columns and the signature block into one ragged
 *   column, on the single document where presentation is part of the message.
 *
 *   So the email is nested tables with `role="presentation"`, inline styles, `px` units, and no
 *   `@font-face`, no `data:` URIs and no external stylesheet — Gmail strips all three.
 *
 * The pixel-accurate version still reaches the candidate: it is the attached PDF. The email body
 * is the readable summary that survives whatever client opens it.
 */

const MAX_WIDTH = 640;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Strip tags from author-written HTML so it can be re-emitted inside a table cell. */
function textOf(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    // Before the blanket tag strip, so a bulleted list still reads as a list once the markup is
    // gone. Only the OPENING tag is given the dash — both filters that call this measure the
    // inside of an `<li>`, never the tag itself, so an empty bullet stays empty here.
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(ul|ol)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/**
 * Inline markup an email client can be trusted with.
 *
 * The set is the same one `src/lib/offers/rich-text.ts` lets the designer's prose canvas store, and
 * the two have to stay that way: anything the canvas can produce but this drops would print on the
 * attached PDF and quietly go missing from the email body, so the letter a candidate reads would
 * differ from the letter they sign. `tests/offer-rich-text.test.ts` asserts the agreement.
 *
 * `<span>` and `<a>` are rebuilt before the generic pass so they carry only a sanitised `style` and,
 * for a link, a target the letter is willing to send somebody to. `safeOfferStyle` is the SAME
 * function the canvas stores through, which is what keeps the two ends in agreement by
 * construction rather than by two lists somebody has to remember to update together.
 */
function inlineSafe(chunk: string): string {
  return chunk
    .replace(/<(span|a)\b([^>]*)>/gi, (_tag, name: string, attributes: string) => {
      const styleMatch = /style\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attributes);
      const style = safeOfferStyle(styleMatch?.[2] ?? styleMatch?.[3] ?? "");
      const hrefMatch = /href\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attributes);
      const href = (hrefMatch?.[2] ?? hrefMatch?.[3] ?? "").trim();
      // A refused link keeps the anchor and loses the target: the words a candidate is reading
      // matter more than the click, and a missing sentence is the worse failure by far.
      const linked = name.toLowerCase() === "a" && /^(https?:\/\/|mailto:)/i.test(href);
      return (
        `<${name.toLowerCase()}` +
        (linked ? ` href="${href.replace(/"/g, "&quot;")}"` : "") +
        (style ? ` style="${style}"` : "") +
        ">"
      );
    })
    .replace(/<(?!\/?(strong|b|em|i|u|a|br|span)\b)[^>]*>/gi, "")
    .replace(/\sclass\s*=\s*("[^"]*"|'[^']*')/gi, "");
}

/** The paragraphs between — or either side of — any list. */
function safeParagraphs(html: string, theme: Required<OfferTheme>): string {
  return html
    .split(/<\/p>/i)
    .map((chunk) => chunk.replace(/<p[^>]*>/gi, "").trim())
    .filter((chunk) => textOf(chunk).length > 0)
    .map(
      (chunk) =>
        `<p style="margin:0 0 10px;color:${theme.body};font-size:14px;line-height:1.6">${inlineSafe(chunk)}</p>`,
    )
    .join("");
}

/**
 * A bulleted or numbered list.
 *
 * The indent is set on the list rather than left to the client's own default: Outlook's Word
 * renderer indents lists far harder than every other client, so an unstyled list is the one thing
 * on the page that visibly moves depending on who opens it.
 */
function safeList(tag: "ol" | "ul", inner: string, theme: Required<OfferTheme>): string {
  const items = [...inner.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
    .map((match) => inlineSafe(match[1]).trim())
    .filter((item) => textOf(item).length > 0);
  if (items.length === 0) return "";

  return (
    `<${tag} style="margin:0 0 10px;padding-left:22px;color:${theme.body};font-size:14px;line-height:1.6">` +
    items.map((item) => `<li style="margin:0 0 4px">${item}</li>`).join("") +
    `</${tag}>`
  );
}

/** Author HTML → email-safe blocks. Keeps emphasis, links, line breaks, colour and lists. */
function safeRichText(html: string, theme: Required<OfferTheme>): string {
  const out: string[] = [];
  let cursor = 0;

  // Lists are lifted out first so the paragraph splitter never sees one. Splitting on `</p>` while a
  // list is still in the string folds every bullet into whichever paragraph came before it.
  for (const match of html.matchAll(/<(ul|ol)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const index = match.index ?? 0;
    out.push(safeParagraphs(html.slice(cursor, index), theme));
    out.push(safeList(match[1].toLowerCase() as "ol" | "ul", match[2], theme));
    cursor = index + match[0].length;
  }
  out.push(safeParagraphs(html.slice(cursor), theme));

  return out.join("");
}

function cell(content: string, style: string): string {
  return `<td style="${style}">${content}</td>`;
}

/** A label/value pair as used by the meta and scope strips. */
function pairCell(label: string, value: string, theme: Required<OfferTheme>, background: string): string {
  return cell(
    `<div style="font-size:10px;letter-spacing:1.2px;text-transform:uppercase;font-weight:bold;color:${theme.soft}">${label}</div>` +
      `<div style="margin-top:4px;font-size:13px;font-weight:bold;color:${theme.ink}">${value}</div>`,
    `padding:9px 12px;background:${background};border:1px solid ${theme.frame};vertical-align:top`,
  );
}

/** Lay cells out in rows of `perRow`, because a wide table does not reflow on a phone. */
function grid(cells: string[], perRow: number): string {
  const rows: string[] = [];
  for (let i = 0; i < cells.length; i += perRow) {
    rows.push(`<tr>${cells.slice(i, i + perRow).join("")}</tr>`);
  }
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;margin-top:10px">${rows.join("")}</table>`;
}

/**
 * With the Accept button, the email asks for ONE way to accept (owner, 2026-10-08 "button only",
 * and 2026-10-15: "drop the sign-and-return wording from the offer email, button only").
 *
 * Two sentences in the letters send a candidate to a printer: the closing "confirm your acceptance
 * by signing below and returning a copy", and the first of the next steps, "Sign the acceptance
 * below and return a scanned copy … before the validity date shown on page 1". Both are right on
 * the attached PDF, which keeps its signature page untouched — but in the EMAIL the acceptance IS
 * the button, and a page number means nothing in a scrolling message.
 *
 * The closing sentence is DROPPED rather than rewritten. Until now it became "To accept this offer,
 * press the Accept button below.", which then landed directly above the answer panel's own lead and
 * told the candidate the same thing twice in a row (measured on the live Corporate letter,
 * 15 Oct 2026). The step is the one place that still has to say something, so it becomes the
 * button's step and keeps the deadline — the half of it that was never about signing.
 *
 * A closing or a step HR rewrote in a template matches neither pattern and is left as written.
 */
const SIGN_AND_RETURN_SENTENCE = /Please confirm your acceptance of this offer by signing below and\s+returning a copy of this letter\.\s*/i;
const SIGN_AND_RETURN_STEP = /^\s*Sign the acceptance below and return a scanned copy\b/i;
export const OFFER_ACCEPT_STEP_HEADING = "Accept online";
export const OFFER_ACCEPT_STEP_TEXT = "Use the Accept button below before the validity date shown in this email.";

function dropSignAndReturn(text: string, acceptUrl: string | undefined): string {
  return acceptUrl ? text.replace(SIGN_AND_RETURN_SENTENCE, "") : text;
}

/** A step that is only a sign-and-return instruction becomes the button's step. */
function acceptStep(item: Record<string, unknown>, acceptUrl: string | undefined): Record<string, unknown> {
  if (!acceptUrl || !SIGN_AND_RETURN_STEP.test(textOf(String(item.t ?? "")))) return item;
  return { ...item, h: OFFER_ACCEPT_STEP_HEADING, t: OFFER_ACCEPT_STEP_TEXT };
}

function renderEmailBlock(
  block: OfferBlock,
  tokens: Record<string, string>,
  theme: Required<OfferTheme>,
  options: { acceptUrl?: string; logoUrl?: string },
): string {
  const p = block.props ?? {};
  const f = (value: unknown) => fillOfferTokens(value, tokens);
  const items = Array.isArray(p.items) ? (p.items as Record<string, unknown>[]) : [];

  switch (block.type) {
    case "rail":
      return `<div style="height:5px;background:${theme.brand};font-size:0;line-height:0">&nbsp;</div>`;

    case "letterhead": {
      const logo = String(p.logo || options.logoUrl || "");
      // An https URL or a `cid:` part of this message, and nothing else. A `data:` source is the
      // one form Gmail and Outlook really do strip, so it must never reach here — and `cid:` is
      // what the real send uses, because a remote image the reader's client declines to fetch
      // leaves a torn-page placeholder on the letterhead of a binding offer (2026-09-17).
      const img = /^(?:https:\/\/|cid:)/i.test(logo)
        ? `<img src="${escapeHtml(logo)}" alt="${escapeHtml(textOf(f(p.name)))}" height="34" style="height:34px;display:block;border:0">`
        : `<div style="font-size:15px;font-weight:bold;letter-spacing:1.5px;color:${theme.brand}">${f(p.name)}</div>`;
      return (
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse"><tr>' +
        cell(img, "padding:14px 0;vertical-align:bottom") +
        cell(
          `<div style="font-size:10px;letter-spacing:1.6px;text-transform:uppercase;font-weight:bold;color:${theme.brand}">${f(p.name)}</div>` +
            `<div style="margin-top:3px;font-size:10px;letter-spacing:1.4px;text-transform:uppercase;color:${theme.soft}">${f(p.unit)}</div>` +
            (f(p.tagline)
              ? `<div style="margin-top:3px;font-size:9px;letter-spacing:1.3px;text-transform:uppercase;color:${theme.brand}">${f(p.tagline)}</div>`
              : ""),
          "padding:14px 0;text-align:right;vertical-align:bottom",
        ) +
        "</tr></table>"
      );
    }

    case "control":
      return grid(
        items.map((i) => pairCell(f(i.k), f(i.v), theme, "#ffffff")),
        2,
      );

    case "title": {
      const badge = [f(p.badgeK), f(p.badge)].filter(Boolean).join(" ");
      return (
        `<h1 style="margin:18px 0 0;font-size:24px;line-height:1.2;color:${theme.ink};font-weight:bold">${f(p.h1)}</h1>` +
        `<div style="margin-top:6px;font-size:14px;font-weight:bold;color:${theme.brand}">${f(p.sub)}</div>` +
        (badge
          ? `<div style="margin-top:10px"><span style="display:inline-block;padding:5px 10px;background:${theme.ink};` +
            `color:#ffffff;font-size:10px;letter-spacing:1.4px;text-transform:uppercase;font-weight:bold">${badge}</span></div>`
          : "") +
        `<div style="margin:12px 0;height:2px;width:72px;background:${theme.brand};font-size:0;line-height:0">&nbsp;</div>`
      );
    }

    case "text": {
      const paragraphs = safeRichText(dropSignAndReturn(f(p.html), options.acceptUrl), theme);
      const avatar = f(p.avatar);
      if (!avatar) return paragraphs;
      // A two-cell table rather than a flex row: the initials disc has to sit beside the greeting
      // in Outlook too, and Word's engine lays out tables and nothing else.
      return (
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse">' +
        "<tr>" +
        cell(
          `<div style="width:38px;height:38px;background:${theme.tint};color:${theme.brand};font-size:15px;` +
            'font-weight:bold;text-align:center;line-height:38px">' +
            `${avatar}</div>`,
          "padding:2px 12px 0 0;vertical-align:top;width:50px",
        ) +
        cell(paragraphs, "vertical-align:top") +
        "</tr></table>"
      );
    }

    case "scope":
      return grid(
        items.map((i) => pairCell(f(i.k), f(i.v), theme, theme.chip)),
        2,
      );

    case "heading":
      return (
        `<div style="margin-top:22px;font-size:11px;letter-spacing:1.8px;text-transform:uppercase;font-weight:bold;color:${theme.brand}">${f(p.text)}` +
        (f(p.sub)
          ? `<span style="margin-left:6px;font-weight:normal;color:${theme.faint}">${f(p.sub)}</span>`
          : "") +
        "</div>" +
        `<div style="margin:8px 0 0;height:1px;background:${theme.hair};font-size:0;line-height:0">&nbsp;</div>`
      );

    case "compensation": {
      const currency = f(p.currency) || "EGP";
      const rows = Array.isArray(p.rows) ? (p.rows as Record<string, unknown>[]) : [];
      const body = rows
        .map(
          (r) =>
            `<tr><td style="padding:8px 14px;border-bottom:1px solid ${theme.hair};color:${theme.ink};font-size:13px">${f(r.l)}</td>` +
            `<td style="padding:8px 14px;border-bottom:1px solid ${theme.hair};text-align:right;color:${theme.muted};font-size:13px">${f(r.m)}</td>` +
            `<td style="padding:8px 14px;border-bottom:1px solid ${theme.hair};text-align:right;color:${theme.muted};font-size:13px">${f(r.a)}</td></tr>`,
        )
        .join("");

      return (
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;margin-top:10px;border:1px solid ${theme["tint-line"]}">` +
        `<tr><td style="padding:16px;background:${theme.tint};border-bottom:1px solid ${theme["tint-line"]}">` +
        `<div style="font-size:10px;letter-spacing:1.3px;text-transform:uppercase;font-weight:bold;color:${theme.brand}">${f(p.heroK)}</div>` +
        `<div style="margin-top:6px;font-size:30px;font-weight:bold;color:${theme.brand};line-height:1.1">` +
        `<span style="font-size:17px">${currency}</span> ${tokens.totalMonthly}</div>` +
        `<div style="margin-top:6px;font-size:12px;color:${theme.soft}">${f(p.asideK)}: ${currency} ${tokens.totalAnnual} &middot; ${f(p.heroNote)}</div>` +
        "</td></tr>" +
        '<tr><td style="padding:0"><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse">' +
        `<tr><th align="left" style="padding:8px 14px;font-size:10px;letter-spacing:1.2px;text-transform:uppercase;color:${theme.soft};border-bottom:1px solid ${theme.line}">Component</th>` +
        `<th align="right" style="padding:8px 14px;font-size:10px;letter-spacing:1.2px;text-transform:uppercase;color:${theme.soft};border-bottom:1px solid ${theme.line}">Monthly</th>` +
        `<th align="right" style="padding:8px 14px;font-size:10px;letter-spacing:1.2px;text-transform:uppercase;color:${theme.soft};border-bottom:1px solid ${theme.line}">Annual</th></tr>` +
        body +
        `<tr><td style="padding:11px 14px;border-top:2px solid ${theme.brand};background:${theme.chip};font-weight:bold;color:${theme.ink};font-size:14px">${f(p.totalLabel)}</td>` +
        `<td style="padding:11px 14px;border-top:2px solid ${theme.brand};background:${theme.chip};text-align:right;font-weight:bold;color:${theme.ink};font-size:14px">${tokens.totalMonthly}</td>` +
        `<td style="padding:11px 14px;border-top:2px solid ${theme.brand};background:${theme.chip};text-align:right;font-weight:bold;color:${theme.ink};font-size:14px">${tokens.totalAnnual}</td></tr>` +
        "</table></td></tr>" +
        (p.note
          ? `<tr><td style="padding:9px 14px;border-top:1px solid ${theme.line};color:${theme.faint};font-size:11px;line-height:1.5">${f(p.note)}</td></tr>`
          : "") +
        "</table>"
      );
    }

    case "benefits":
      return grid(
        items.map((i) =>
          cell(
            `<div style="font-size:10px;letter-spacing:1.2px;text-transform:uppercase;font-weight:bold;color:${theme.brand}">${f(i.k)}</div>` +
              `<div style="margin-top:5px;font-size:13px;line-height:1.5;color:${theme.body}">${f(i.t)}</div>`,
            `padding:10px 12px;background:#ffffff;border:1px solid ${theme.frame};vertical-align:top`,
          ),
        ),
        2,
      );

    case "clauses":
      return (
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;margin-top:8px">' +
        items
          .map(
            (i, ix) =>
              "<tr>" +
              cell(
                `<div style="width:24px;height:24px;background:${theme.ink};color:#ffffff;font-size:12px;font-weight:bold;text-align:center;line-height:24px">${ix + 1}</div>`,
                `padding:11px 12px 11px 0;vertical-align:top;border-bottom:1px solid ${theme.hair};width:36px`,
              ) +
              cell(
                `<div style="font-size:14px;font-weight:bold;color:${theme.ink}">${f(i.h)}</div>` +
                  `<div style="margin-top:4px;font-size:13px;line-height:1.55;color:${theme.body}">${f(i.t)}</div>`,
                `padding:11px 0;vertical-align:top;border-bottom:1px solid ${theme.hair}`,
              ) +
              "</tr>",
          )
          .join("") +
        "</table>"
      );

    case "steps":
      return grid(
        items.map((raw) => acceptStep(raw, options.acceptUrl)).map((i) =>
          cell(
            `<div style="font-size:10px;letter-spacing:1.2px;text-transform:uppercase;font-weight:bold;color:${theme.brand}">${f(i.n)}</div>` +
              `<div style="margin-top:5px;font-size:13px;font-weight:bold;color:${theme.ink}">${f(i.h)}</div>` +
              `<div style="margin-top:3px;font-size:12px;line-height:1.5;color:${theme.muted}">${f(i.t)}</div>`,
            `padding:10px 12px;background:${theme.chip};border:1px solid ${theme.frame};vertical-align:top`,
          ),
        ),
        1,
      );

    case "signature":
      // No signature RULES in the email — a line to sign on belongs to the printable attachment,
      // and drawing one in a mail body invites somebody to reply "signed" without signing.
      return (
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;margin-top:16px;border:1px solid ${theme.frame}">` +
        `<tr><td style="padding:11px 16px;background:${theme.ink}">` +
        `<div style="font-size:10px;letter-spacing:1.7px;text-transform:uppercase;font-weight:bold;color:#ffffff">${f(p.title)}</div></td></tr>` +
        `<tr><td style="padding:14px 16px;background:#ffffff">` +
        `<div style="font-size:10px;letter-spacing:1.2px;text-transform:uppercase;font-weight:bold;color:${theme.soft}">${f(p.leftK)}</div>` +
        `<div style="margin-top:4px;font-size:14px;font-weight:bold;color:${theme.ink}">${f(p.leftName)}</div>` +
        `<div style="font-size:12px;color:${theme.soft}">${f(p.leftSub)}</div>` +
        `<div style="margin-top:12px;font-size:13px;line-height:1.6;color:${theme.body}">` +
        (options.acceptUrl
          ? "Your copy of this letter is attached as a PDF.</div>"
          : "The signature page is in the attached PDF. Print it, sign it, and return a scanned copy.</div>") +
        "</td></tr></table>"
      );

    case "footer":
      return (
        `<div style="margin-top:20px;padding-top:12px;border-top:1px solid ${theme.frame}">` +
        `<div style="font-size:11px;line-height:1.55;color:${theme.faint}">${f(p.text)}</div>` +
        `<div style="margin-top:8px;font-size:10px;letter-spacing:1.4px;text-transform:uppercase;font-weight:bold;color:${theme.faint}">${f(p.right)}</div></div>`
      );

    case "welcome":
      return (
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;margin-top:18px">` +
        `<tr><td style="padding:16px 18px;background:${theme.ink}">` +
        `<div style="font-size:10px;letter-spacing:1.5px;text-transform:uppercase;font-weight:bold;color:${theme.brand}">${f(p.k)}</div>` +
        `<div style="margin-top:6px;font-size:16px;font-weight:bold;color:#ffffff">${f(p.text)}</div>` +
        `</td><td style="width:56px;background:${theme.tint}">&nbsp;</td></tr></table>`
      );

    // A page break means nothing in a scrolling email, and raw HTML is the one thing that could
    // carry grid/flex straight past every guarantee this renderer makes. Both are dropped.
    case "pagebreak":
    case "html":
      return "";

    default:
      return "";
  }
}

export type RenderedOfferEmail = { html: string; text: string };

/** The button's words and the decline sentence — one place, so the HTML and the text part agree. */
export const OFFER_ACCEPT_BUTTON_LABEL = "Accept the offer — complete your joining form";
export const OFFER_ACCEPT_LEAD = "To accept this offer, press the button below and complete your joining form.";
export const OFFER_DECLINE_LINE = "If you wish to decline the offer, simply reply to this email.";

/**
 * The answer block (owner, 2026-10-08: "if you accept the offer, press here; and if you decline the
 * offer, reply on the email"). ONE button — there is deliberately no decline button: a mail scanner
 * opens every link in a message, and declining stays a reply a person reads.
 *
 * A bulletproof button — a table cell with its own background, not a styled link — because Outlook's
 * Word renderer ignores padding and background on an `<a>`. Square, in the letter's own brand blue,
 * so the frozen design gains a control and loses nothing.
 */
function renderAcceptBlock(acceptUrl: string, theme: Required<OfferTheme>): string {
  const href = escapeHtml(acceptUrl);
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;margin-top:20px;border:1px solid ${theme.frame}">` +
    `<tr><td style="padding:11px 16px;background:${theme.ink}">` +
    `<div style="font-size:10px;letter-spacing:1.7px;text-transform:uppercase;font-weight:bold;color:#ffffff">Your answer</div></td></tr>` +
    `<tr><td style="padding:16px 16px 18px;background:#ffffff">` +
    `<div style="font-size:14px;line-height:1.6;color:${theme.body}">${escapeHtml(OFFER_ACCEPT_LEAD)}</div>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin-top:12px"><tr>` +
    // The padding sits on the CELL: Word ignores it on the link and would draw a text-high strip.
    `<td bgcolor="${theme.brand}" style="background:${theme.brand};padding:13px 22px">` +
    `<a href="${href}" target="_blank" style="display:block;font-size:14px;font-weight:bold;color:#ffffff;text-decoration:none">${escapeHtml(OFFER_ACCEPT_BUTTON_LABEL)}</a>` +
    `</td></tr></table>` +
    `<div style="margin-top:12px;font-size:13px;line-height:1.6;color:${theme.body}">${escapeHtml(OFFER_DECLINE_LINE)}</div>` +
    // A short linked phrase, never the raw ~175-character URL: Word ignores word-break and would
    // widen the letter to fit it. The plain-text part still carries the full address.
    `<div style="margin-top:6px;font-size:11px;line-height:1.5;color:${theme.soft}">If the button does not open, <a href="${href}" target="_blank" style="color:${theme.brand};text-decoration:underline">use this link to your joining form</a>.</div>` +
    `</td></tr></table>`
  );
}

/** Blocks → an email body that survives Outlook, plus the plain-text alternative. */
export function renderOfferEmail(
  template: { blocks: OfferBlock[]; theme?: OfferTheme },
  fields: OfferFields,
  options: { acceptUrl?: string; logoUrl?: string } = {},
): RenderedOfferEmail {
  const tokens = buildOfferTokens(fields);
  const theme = { ...OFFER_DEFAULT_THEME, ...(template.theme ?? {}) } as Required<OfferTheme>;

  const rendered: Array<{ html: string; type: string }> = template.blocks.map((block) => ({
    html: renderEmailBlock(block, tokens, theme, options),
    type: String(block.type),
  }));
  // The answer sits just above the signature card — where the letter asks for an answer — or above
  // the footer when a design has no signature, or last of all.
  if (options.acceptUrl) {
    const at = rendered.findIndex((part) => part.type === "signature");
    const beforeFooter = rendered.findIndex((part) => part.type === "footer");
    const index = at >= 0 ? at : beforeFooter >= 0 ? beforeFooter : rendered.length;
    rendered.splice(index, 0, { html: renderAcceptBlock(options.acceptUrl, theme), type: "accept" });
  }
  const body = rendered
    .map((part) => part.html)
    .filter(Boolean)
    .join("");

  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>Offer of Employment</title></head>` +
    `<body style="margin:0;padding:0;background:#f2f5f7">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;border-collapse:collapse;background:#f2f5f7">` +
    `<tr><td align="center" style="padding:24px 12px">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="${MAX_WIDTH}" ` +
    `style="width:100%;max-width:${MAX_WIDTH}px;border-collapse:collapse;background:#ffffff;` +
    `font-family:'Segoe UI',Arial,Helvetica,sans-serif">` +
    `<tr><td style="padding:0 24px 28px">${body}</td></tr>` +
    "</table></td></tr></table></body></html>";

  return { html, text: buildPlainText(template.blocks, tokens, options.acceptUrl) };
}

/**
 * The plain-text alternative.
 *
 * Not optional: a multipart email with no text part scores worse with spam filters, and an offer
 * that lands in a candidate's junk folder is an offer that was never made.
 */
function buildPlainText(blocks: OfferBlock[], tokens: Record<string, string>, acceptUrl?: string): string {
  const lines: string[] = [];
  const f = (value: unknown) => textOf(fillOfferTokens(value, tokens));

  for (const block of blocks) {
    const p = block.props ?? {};
    const items = Array.isArray(p.items) ? (p.items as Record<string, unknown>[]) : [];

    switch (block.type) {
      case "title":
        lines.push(f(p.h1).toUpperCase(), f(p.sub), "");
        break;
      case "heading":
        lines.push("", f(p.text).toUpperCase(), "");
        break;
      case "text":
        lines.push(dropSignAndReturn(f(p.html), acceptUrl), "");
        break;
      case "control":
      case "scope":
        for (const i of items) lines.push(`${f(i.k)}: ${f(i.v)}`);
        lines.push("");
        break;
      case "compensation": {
        const currency = f(p.currency) || "EGP";
        lines.push(`${f(p.heroK)}: ${currency} ${tokens.totalMonthly} / month`);
        lines.push(`${f(p.asideK)}: ${currency} ${tokens.totalAnnual} / year`);
        for (const r of Array.isArray(p.rows) ? (p.rows as Record<string, unknown>[]) : []) {
          lines.push(`  - ${f(r.l)}: ${f(r.m)} monthly / ${f(r.a)} annual`);
        }
        lines.push("");
        break;
      }
      case "benefits":
        for (const i of items) lines.push(`- ${f(i.k)}: ${f(i.t)}`);
        lines.push("");
        break;
      case "clauses":
        items.forEach((i, ix) => lines.push(`${ix + 1}. ${f(i.h)} — ${f(i.t)}`));
        lines.push("");
        break;
      case "steps":
        for (const raw of items) {
          const i = acceptStep(raw, acceptUrl);
          lines.push(`${f(i.n)} — ${f(i.h)}: ${f(i.t)}`);
        }
        lines.push("");
        break;
      case "footer":
        lines.push("", f(p.text));
        break;
      case "welcome":
        lines.push("", `${f(p.k).toUpperCase()} — ${f(p.text)}`);
        break;
      default:
        break;
    }
  }

  if (acceptUrl) {
    lines.push("", "YOUR ANSWER", OFFER_ACCEPT_LEAD, `${OFFER_ACCEPT_BUTTON_LABEL}: ${acceptUrl}`, OFFER_DECLINE_LINE);
  }
  lines.push("", "The signed offer letter is attached as a PDF.");
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
