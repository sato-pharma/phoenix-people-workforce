// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE ADDITIONS AND DELETIONS EMAIL TO LIBANO-SUISSE: AN EMAIL, SIGNED IN THE BEYOND LETTER'S GOLD.
//
// Owner, 27 Nov 2026: "make it like the HR premium identity … the BOR we signed for Beyond, make it the same
// identity and style", then, on seeing it as a full letter: "It very looks like a PDF. I wanted email … remove
// the part above the Dear Libano-Suisse."
//
// So it is a plain email: no masthead, title, facts block, framed sheet or grey ground. It opens at "Dear
// Libano-Suisse team,". The signed letter's identity lives only where an email carries one:
//   * the people table's gold-ruled header;
//   * the sign-off, a signature block (the Sato mark behind a gold keyline, the name in navy, the title, a
//     small gold letterspaced line, the reply address);
//   * a quiet running foot (the Phoenix mark and the document code).
//
// 🔴 OUTLOOK FIRST. Tables, inline styles and absolute image URLs only: no grid, no SVG, no web fonts. Flat
// colour, square corners, no shadow or gradient. PURE: the tests render it with no network.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { escapeHtml } from "@/lib/hiring-pack/render-shared";

/** The signed letter's gold layer (build-bor-gold): rules and keylines. */
export const LETTER_GOLD = "#A8843F";
/** The light keyline. */
export const LETTER_GOLD_LIGHT = "#C9A45C";
/** Gold dark enough to be read as type. */
export const LETTER_GOLD_INK = "#8A6A2C";
/** The house navy. */
export const LETTER_NAVY = "#0A527D";
const INK = "#1F2933";
const SOFT = "#5B6B7A";
const HAIR = "#D7E0E8";

const FONT = "Aptos,'Segoe UI',Arial,Helvetica,sans-serif";
export const LETTER_DOCUMENT_CODE = 'Sato Pharma &middot; Human Resources &middot; <span style="white-space:nowrap">SATO-DIS-2026-01 v1.0</span>';

export type LibanoLetterSigner = {
  /** Set in two weights, as the owner's own signature sets it: "Omar Anwar" light, "Gawish" bold. */
  nameLight: string;
  nameBold: string;
  /** "HR Manager". */
  title: string;
  /** "Human Resources · Sato Pharma · Head Office, Cairo". */
  line: string;
  /** Shown as written ("+20 12 8095 5558"); dialled as its digits. */
  phone: string;
  replyTo: string;
};

export type LibanoLetterContent = {
  /** The absolute base the two marks are read from (the production site). */
  assetBaseUrl: string;
  subject: string;
  salutation: string;
  /** Already-escaped paragraphs. */
  paragraphsHtml: readonly string[];
  /** The people, as the table's header and rows of already-escaped cells. */
  table: { head: readonly string[]; rows: ReadonlyArray<readonly string[]> };
  closing: string;
  /** "Kind regards,". */
  valediction: string;
  signer: LibanoLetterSigner;
  automatedNote: string;
  /** Set on a test send: a gold-keyline notice above the greeting. Already escaped. */
  testNoticeHtml?: string | null;
  /** The plain-text body, written by the caller. */
  text: string;
};

const cell = (style: string, inner: string, attrs = "") => `<td${attrs ? ` ${attrs}` : ""} style="${style}">${inner}</td>`;
const row = (inner: string) => `<tr>${inner}</tr>`;
const table = (inner: string, style = "", attrs = "") =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"${attrs ? ` ${attrs}` : ""} style="border-collapse:collapse;mso-table-lspace:0;mso-table-rspace:0;${style}">${inner}</table>`;

const paragraph = (inner: string, extra = "") => `<p style="margin:0 0 15px;color:${INK};font-family:${FONT};font-size:14.5px;line-height:23px;${extra}">${inner}</p>`;

const HEAD_CELL = `padding:9px 8px 8px;border-top:1.5px solid ${LETTER_GOLD};border-bottom:1px solid ${LETTER_GOLD_LIGHT};color:${LETTER_GOLD_INK};font-family:${FONT};font-size:9.5px;line-height:13px;letter-spacing:1.4px;font-weight:700;text-transform:uppercase;text-align:left`;

function peopleTable(content: LibanoLetterContent): string {
  // The first column is the signed letter's light gold numeral: 01, 02, 03.
  const head = row(cell(`${HEAD_CELL};width:30px;padding-left:0`, "&nbsp;", 'width="30"') + content.table.head.map((label) => cell(HEAD_CELL, label)).join(""));
  const body = content.table.rows
    .map((cells, index) =>
      row(
        cell(
          `width:30px;padding:10px 8px 10px 0;border-bottom:1px solid ${HAIR};color:${LETTER_GOLD_LIGHT};font-family:${FONT};font-size:15px;line-height:18px;font-weight:300;vertical-align:top`,
          String(index + 1).padStart(2, "0"),
          'width="30"',
        ) +
          cells
            .map((value, column) =>
              cell(
                `padding:10px 8px;border-bottom:1px solid ${HAIR};color:${column === 0 ? LETTER_NAVY : INK};font-family:${FONT};font-size:13px;line-height:18px;${column === 0 ? "font-weight:700;" : ""}vertical-align:top`,
                value,
              ),
            )
            .join(""),
      ),
    )
    .join("");
  return table(head + body, "margin:4px 0 20px");
}

/** The gold tick: a short gold stroke run into a light hairline (the signed letter's tick, drawn as table cells). */
function goldTick(margin: string): string {
  return table(
    row(
      cell(`width:28px;height:2px;background:${LETTER_GOLD};font-size:1px;line-height:1px;mso-line-height-rule:exactly`, "&nbsp;", `width="28" height="2" bgcolor="${LETTER_GOLD}"`) +
        cell(
          "height:2px;font-size:1px;line-height:1px;vertical-align:bottom",
          table(row(cell(`height:1px;background:${HAIR};font-size:1px;line-height:1px;mso-line-height-rule:exactly`, "&nbsp;", `height="1" bgcolor="${HAIR}"`))),
        ),
    ),
    `margin:${margin}`,
  );
}

function contactRow(label: string, valueHtml: string): string {
  return row(
    cell(
      `width:58px;padding:0 0 5px;vertical-align:baseline;color:${LETTER_GOLD_INK};font-family:${FONT};font-size:9px;line-height:17px;letter-spacing:1.6px;font-weight:700;text-transform:uppercase;white-space:nowrap`,
      label,
      'width="58"',
    ) + cell(`padding:0 0 5px;vertical-align:baseline;color:${INK};font-family:${FONT};font-size:12.5px;line-height:17px`, valueHtml),
  );
}

/**
 * The signature, set as the owner's own (two-weight name, the mark at the right, a small-capital title, a tick
 * rule, the contact lines), with the signed Beyond letter's gold where his own uses orange.
 */
function signature(content: LibanoLetterContent): string {
  const { signer } = content;
  const base = content.assetBaseUrl.replace(/\/+$/, "");
  const dial = signer.phone.replace(/[^\d+]/g, "");
  const link = `color:${INK};text-decoration:none`;
  return table(
    row(
      cell(
        "",
        table(
          row(
            cell(
              `vertical-align:bottom;padding:0 0 1px;font-family:${FONT};font-size:22px;line-height:26px;mso-line-height-rule:exactly;color:${LETTER_NAVY};letter-spacing:-0.2px`,
              `<span style="font-weight:300">${escapeHtml(signer.nameLight)}</span> <span style="font-weight:700">${escapeHtml(signer.nameBold)}</span>`,
            ) +
              cell(
                "width:96px;vertical-align:bottom;padding:0 0 0 12px;text-align:right",
                `<img src="${escapeHtml(`${base}/assets/branding/sato-pharma-signature-logo-clear.png`)}" width="96" height="38" alt="Sato Pharma" style="display:block;border:0;outline:none;text-decoration:none;width:96px;height:38px">`,
                'width="96" align="right"',
              ),
          ),
        ) +
          `<div style="padding:5px 0 0;color:${LETTER_GOLD_INK};font-family:${FONT};font-size:9px;line-height:14px;letter-spacing:1.8px;font-weight:700;text-transform:uppercase">${escapeHtml(signer.title)}</div>` +
          `<div style="padding:1px 0 0;color:${SOFT};font-family:${FONT};font-size:12px;line-height:18px">${escapeHtml(signer.line).replace(/ &middot; | · /g, `<span style="color:${LETTER_GOLD}">&nbsp;&nbsp;&middot;&nbsp;&nbsp;</span>`)}</div>` +
          goldTick("11px 0 10px") +
          table(
            contactRow("Mobile", `<a href="tel:${escapeHtml(dial)}" style="${link};white-space:nowrap">${escapeHtml(signer.phone).replace(/ /g, "&nbsp;")}</a>`) +
              // A narrow phone wraps the address after its @, never inside a word.
              contactRow("Email", `<a href="mailto:${escapeHtml(signer.replyTo)}" style="${link}">${escapeHtml(signer.replyTo).replace("@", "@<wbr>")}</a>`),
            "width:auto",
          ),
      ),
    ),
    "max-width:440px",
  );
}

function runningFoot(content: LibanoLetterContent): string {
  const base = content.assetBaseUrl.replace(/\/+$/, "");
  return table(
    row(
      cell(
        "padding:10px 8px 0 0;vertical-align:middle;width:20px",
        `<img src="${escapeHtml(`${base}/brand/phoenix-bird-icon.png`)}" width="14" height="14" alt="" style="display:block;border:0;width:14px;height:14px">`,
        'width="20"',
      ) +
        cell(
          `padding:10px 0 0;vertical-align:middle;color:${SOFT};font-family:${FONT};font-size:10px;line-height:14px`,
          `<b style="color:${LETTER_NAVY};letter-spacing:1.4px">PHOENIX WORKFORCE</b> &middot; ${LETTER_DOCUMENT_CODE}`,
        ),
    ),
    `margin:22px 0 0;border-top:1px solid ${HAIR}`,
  );
}

function preheader(text: string): string {
  const opening = text.replace(/\s+/g, " ").trim().slice(0, 140);
  return (
    '<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#ffffff">' +
    `${escapeHtml(opening)}${"&#847;&zwnj;&nbsp;".repeat(24)}</div>`
  );
}

export function renderLibanoMovementLetter(content: LibanoLetterContent): { html: string; text: string } {
  const testNotice = content.testNoticeHtml
    ? table(
        row(
          cell(
            `padding:12px 14px;border:1px solid ${LETTER_GOLD};border-left:4px solid ${LETTER_GOLD};color:${LETTER_GOLD_INK};font-family:${FONT};font-size:13px;line-height:19px`,
            content.testNoticeHtml,
          ),
        ),
        "margin:0 0 20px",
      )
    : "";

  const body =
    testNotice +
    paragraph(escapeHtml(content.salutation)) +
    content.paragraphsHtml.map((html) => paragraph(html)).join("") +
    peopleTable(content) +
    paragraph(escapeHtml(content.closing)) +
    paragraph(escapeHtml(content.valediction), "margin:0 0 16px") +
    signature(content) +
    `<p style="margin:20px 0 0;color:${SOFT};font-family:${FONT};font-size:11px;line-height:17px">${escapeHtml(content.automatedNote)}</p>` +
    runningFoot(content);

  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"><title>${escapeHtml(content.subject)}</title></head>` +
    `<body style="margin:0;padding:0;background:#ffffff">` +
    preheader(content.text) +
    table(row(cell("padding:16px 16px 24px", table(row(cell("", body)), "max-width:640px"))), "background:#ffffff") +
    `</body></html>`;
  return { html, text: content.text };
}
