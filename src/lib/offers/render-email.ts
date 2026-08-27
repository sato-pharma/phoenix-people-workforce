import { OFFER_DEFAULT_THEME } from "@/lib/offers/default-template";
import { buildOfferTokens, fillOfferTokens } from "@/lib/offers/render";
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
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/** Author HTML → email-safe paragraphs. Keeps <strong>/<em>; drops layout markup and classes. */
function safeRichText(html: string, theme: Required<OfferTheme>): string {
  const paragraphs = html
    .split(/<\/p>/i)
    .map((chunk) => chunk.replace(/<p[^>]*>/gi, "").trim())
    .filter((chunk) => textOf(chunk).length > 0);

  return paragraphs
    .map((chunk) => {
      const inline = chunk
        .replace(/<(?!\/?(strong|b|em|i|u|a)\b)[^>]*>/gi, "")
        .replace(/\sclass="[^"]*"/gi, "");
      return (
        `<p style="margin:0 0 10px;color:${theme.body};font-size:14px;line-height:1.6">${inline}</p>`
      );
    })
    .join("");
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

function renderEmailBlock(
  block: OfferBlock,
  tokens: Record<string, string>,
  theme: Required<OfferTheme>,
  options: { logoUrl?: string },
): string {
  const p = block.props ?? {};
  const f = (value: unknown) => fillOfferTokens(value, tokens);
  const items = Array.isArray(p.items) ? (p.items as Record<string, unknown>[]) : [];

  switch (block.type) {
    case "rail":
      return `<div style="height:5px;background:${theme.brand};font-size:0;line-height:0">&nbsp;</div>`;

    case "letterhead": {
      const logo = String(p.logo || options.logoUrl || "");
      // Only an https URL: Gmail and Outlook both strip `data:` image sources.
      const img = /^https:\/\//i.test(logo)
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
      const paragraphs = safeRichText(f(p.html), theme);
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
        items.map((i) =>
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
        "The signature page is in the attached PDF. Print it, sign it, and return a scanned copy.</div>" +
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

/** Blocks → an email body that survives Outlook, plus the plain-text alternative. */
export function renderOfferEmail(
  template: { blocks: OfferBlock[]; theme?: OfferTheme },
  fields: OfferFields,
  options: { logoUrl?: string } = {},
): RenderedOfferEmail {
  const tokens = buildOfferTokens(fields);
  const theme = { ...OFFER_DEFAULT_THEME, ...(template.theme ?? {}) } as Required<OfferTheme>;

  const body = template.blocks
    .map((block) => renderEmailBlock(block, tokens, theme, options))
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

  return { html, text: buildPlainText(template.blocks, tokens) };
}

/**
 * The plain-text alternative.
 *
 * Not optional: a multipart email with no text part scores worse with spam filters, and an offer
 * that lands in a candidate's junk folder is an offer that was never made.
 */
function buildPlainText(blocks: OfferBlock[], tokens: Record<string, string>): string {
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
        lines.push(f(p.html), "");
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
        for (const i of items) lines.push(`${f(i.n)} — ${f(i.h)}: ${f(i.t)}`);
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

  lines.push("", "The signed offer letter is attached as a PDF.");
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
