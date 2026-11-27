// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE ADDITIONS AND DELETIONS EMAIL, DRESSED AS THE SIGNED BEYOND AUTHORISATION (owner, 27 Nov 2026:
// "make it like the HR premium identity … you know the BOR we signed for Beyond, make it the same identity
// and style", and "the email's sign-off" for the signature).
//
// The letter Sato Pharma signed on 26 Nov 2026 appointing Beyond as its broker with Libano-Suisse is the HR
// premium identity with a flat gold layer (the certificate of experience's anatomy, built from
// src/lib/hiring-pack/premium-identity.ts). This is the same letter, rebuilt for a mail client:
//   * the microtext band top and bottom, with the corner diamonds;
//   * the masthead (the Sato mark, "Human Resources", the gold rule-diamond-rule, the place and month)
//     over the gold double rule;
//   * the kicker with its diamond, the two-weight title, the three-stroke tick, the facts under a gold rule;
//   * the figures row (light gold numerals, the policy number in navy), the salutation behind a gold bar;
//   * the "Name and title" sign-off block, and the Phoenix Workforce running foot with the document code.
//
// 🔴 OUTLOOK FIRST. Tables, inline styles and absolute image URLs only: no grid, no SVG, no web fonts, no
// text-stroke (Outlook for Windows drops all four). The outline numerals become light gold figures, the SVG
// frame becomes a gold keyline. Flat colour, square corners, no shadow or gradient (the house ink rule).
// PURE: the tests render it with no network.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { escapeHtml } from "@/lib/hiring-pack/render-shared";

/** The signed letter's gold layer (build-bor-gold): rules, keylines and ornaments. */
export const LETTER_GOLD = "#A8843F";
/** The inner keyline and the light figures. */
export const LETTER_GOLD_LIGHT = "#C9A45C";
/** Gold dark enough to be read as type. */
export const LETTER_GOLD_INK = "#8A6A2C";
/** The house navy: every word that is not gold. */
export const LETTER_NAVY = "#0A527D";
const LABEL_BLUE = "#1482C2";
const INK = "#1A1A1A";
const SOFT = "#5B6B7A";
const HAIR = "#D7E0E8";
const PAPER_GROUND = "#EEF1F5";
const TICK_PALE = "#B9C7D4";

const FONT = "Aptos,'Segoe UI',Arial,Helvetica,sans-serif";
const MICROTEXT = "SATO PHARMA L.L.C. &middot; HUMAN RESOURCES &middot; HEAD OFFICE &middot; PHOENIX WORKFORCE";
export const LETTER_DOCUMENT_CODE = 'Sato Pharma &middot; Human Resources &middot; <span style="white-space:nowrap">SATO-DIS-2026-01 v1.0</span>';

export type LibanoLetterFigure = { label: string; value: string; note?: string; strong?: boolean };
export type LibanoLetterFact = { label: string; value: string };
export type LibanoLetterSigner = { name: string; title: string; line: string; replyTo: string };

export type LibanoLetterContent = {
  /** The absolute base the two marks are read from (the production site). */
  assetBaseUrl: string;
  subject: string;
  /** "Medical and life insurance". */
  kicker: string;
  /** "Medical insurance" + the bold word, "deletions". */
  titleLight: string;
  titleBold: string;
  law: string;
  purpose: string;
  /** "Head Office · Cairo · November 2026". */
  placeLine: string;
  facts: readonly LibanoLetterFact[];
  figures: readonly LibanoLetterFigure[];
  salutation: string;
  /** Already-escaped paragraphs. */
  paragraphsHtml: readonly string[];
  /** The people, as the table's header and rows of already-escaped cells. */
  table: { head: readonly string[]; rows: ReadonlyArray<readonly string[]> };
  closing: string;
  signer: LibanoLetterSigner;
  automatedNote: string;
  /** Set on a test send: a gold-keyline notice above the masthead. Already escaped. */
  testNoticeHtml?: string | null;
  /** The plain-text body, written by the caller. */
  text: string;
};

const cell = (style: string, inner: string, attrs = "") => `<td${attrs ? ` ${attrs}` : ""} style="${style}">${inner}</td>`;
const row = (inner: string) => `<tr>${inner}</tr>`;
const table = (inner: string, style = "", attrs = "") =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"${attrs ? ` ${attrs}` : ""} style="border-collapse:collapse;mso-table-lspace:0;mso-table-rspace:0;${style}">${inner}</table>`;

function microtextBand(): string {
  return table(
    row(
      cell(`width:14px;padding:6px 0;color:${LETTER_GOLD};font-size:9px;line-height:9px;text-align:left`, "&#9670;") +
        cell(
          `padding:6px 4px;color:${LETTER_GOLD_INK};font-family:${FONT};font-size:7px;line-height:9px;letter-spacing:1.6px;font-weight:700;text-align:center;mso-line-height-rule:exactly`,
          MICROTEXT,
        ) +
        cell(`width:14px;padding:6px 0;color:${LETTER_GOLD};font-size:9px;line-height:9px;text-align:right`, "&#9670;"),
    ),
  );
}

/** The gold double rule under the masthead: a gold line over a light gold one. */
function doubleRule(margin = "14px 0 0"): string {
  return table(
    row(cell(`border-top:1px solid ${LETTER_GOLD};border-bottom:1px solid ${LETTER_GOLD_LIGHT};height:2px;font-size:0;line-height:0`, "&nbsp;")),
    `margin:${margin}`,
  );
}

function hairline(color: string, space: string): string {
  return table(row(cell(`padding:${space};font-size:0;line-height:0`, `<div style="border-top:1px solid ${color};font-size:0;line-height:0">&nbsp;</div>`)));
}

function masthead(content: LibanoLetterContent): string {
  const base = content.assetBaseUrl.replace(/\/+$/, "");
  return (
    table(
      row(
        cell(
          "vertical-align:middle;width:150px",
          `<img src="${escapeHtml(`${base}/brand/sato-pharma-logo-on-light.png`)}" width="130" height="51" alt="Sato Pharma" style="display:block;border:0;outline:none;text-decoration:none;width:130px;height:51px">`,
        ) +
          cell(
            "vertical-align:middle;text-align:right",
            `<div style="color:${LETTER_NAVY};font-family:${FONT};font-size:16px;line-height:20px;font-weight:700">Human Resources</div>` +
              `<div style="padding:5px 0 4px;color:${LETTER_GOLD};font-family:${FONT};font-size:8px;line-height:8px;letter-spacing:0">&#8212;&#8212;&#8212;&nbsp;&#9671;&nbsp;&#8212;&#8212;&#8212;</div>` +
              `<div style="color:${SOFT};font-family:${FONT};font-size:12px;line-height:16px">${escapeHtml(content.placeLine)}</div>`,
          ),
      ),
    ) + doubleRule()
  );
}

function hero(content: LibanoLetterContent): string {
  const tick =
    table(
      row(
        cell(`width:22px;border-top:2px solid ${LETTER_GOLD};font-size:0;line-height:0`, "&nbsp;") +
          cell("width:5px;font-size:0;line-height:0", "&nbsp;") +
          cell(`width:22px;border-top:2px solid ${LETTER_GOLD_LIGHT};font-size:0;line-height:0`, "&nbsp;") +
          cell("width:5px;font-size:0;line-height:0", "&nbsp;") +
          cell(`width:22px;border-top:2px solid ${TICK_PALE};font-size:0;line-height:0`, "&nbsp;") +
          cell("font-size:0;line-height:0", "&nbsp;"),
      ),
      "margin:12px 0 0;width:auto",
      'width="76"',
    );
  return (
    `<div style="padding:26px 0 0;color:${LETTER_GOLD_INK};font-family:${FONT};font-size:10px;line-height:14px;letter-spacing:1.8px;font-weight:700;text-transform:uppercase">` +
    `<span style="color:${LETTER_GOLD}">&#9670;</span>&nbsp;&nbsp;${escapeHtml(content.kicker)}</div>` +
    `<div style="padding:8px 0 0;color:${LETTER_NAVY};font-family:${FONT};font-size:32px;line-height:38px;font-weight:300">${escapeHtml(content.titleLight)} <b style="font-weight:800">${escapeHtml(content.titleBold)}</b></div>` +
    `<div style="padding:4px 0 0;color:${SOFT};font-family:${FONT};font-size:13px;line-height:18px">${escapeHtml(content.law)}</div>` +
    tick +
    `<div style="padding:10px 0 0;color:${INK};font-family:${FONT};font-size:12px;line-height:18px">${escapeHtml(content.purpose)}</div>`
  );
}

function facts(content: LibanoLetterContent): string {
  const rows = content.facts
    .map(
      (fact, index) =>
        row(
          cell(
            `width:110px;padding:9px 0;${index > 0 ? `border-top:1px solid ${HAIR};` : ""}color:${LABEL_BLUE};font-family:${FONT};font-size:11px;line-height:16px;font-weight:700;vertical-align:top`,
            escapeHtml(fact.label),
          ) +
            cell(
              `padding:9px 0;${index > 0 ? `border-top:1px solid ${HAIR};` : ""}color:${INK};font-family:${FONT};font-size:13px;line-height:18px;vertical-align:top`,
              escapeHtml(fact.value),
            ),
        ),
    )
    .join("");
  return table(rows, `margin:22px 0 0;border-top:1.5px solid ${LETTER_GOLD}`);
}

function sectionHead(label: string): string {
  return table(
    row(
      cell(
        `padding:0 10px 0 0;white-space:nowrap;color:${LABEL_BLUE};font-family:${FONT};font-size:11px;line-height:14px;font-weight:700;letter-spacing:.4px`,
        escapeHtml(label),
        'width="1"',
      ) + cell(`vertical-align:middle;font-size:0;line-height:0`, `<div style="border-top:1px solid ${LETTER_GOLD_LIGHT};font-size:0;line-height:0">&nbsp;</div>`),
    ),
    "margin:28px 0 0",
  );
}

function figures(content: LibanoLetterContent): string {
  const count = content.figures.length;
  const cells = content.figures
    .map((figure, index) => {
      const divider = index > 0 ? `border-left:1px solid ${HAIR};` : "";
      const number = figure.strong
        ? `<span style="color:${LETTER_NAVY};font-size:26px;line-height:36px;font-weight:800">${escapeHtml(figure.value)}</span>`
        : `<span style="color:${LETTER_GOLD_LIGHT};font-size:34px;line-height:36px;font-weight:300">${escapeHtml(figure.value)}</span>`;
      const note = figure.note ? ` <span style="white-space:nowrap;color:${LETTER_NAVY};font-size:12px;line-height:16px;font-weight:700">${escapeHtml(figure.note)}</span>` : "";
      return cell(
        `width:${Math.floor(100 / count)}%;padding:10px 10px 12px;${divider}vertical-align:top;font-family:${FONT}`,
        `<div style="color:${LABEL_BLUE};font-size:11px;line-height:14px;font-weight:700">${escapeHtml(figure.label)}</div><div style="padding:6px 0 0"><span style="white-space:nowrap">${number}</span>${note}</div>`,
      );
    })
    .join("");
  return table(row(cells), `margin:12px 0 0;border-top:1.5px solid ${LETTER_GOLD};border-bottom:1px solid ${HAIR}`);
}

function peopleTable(content: LibanoLetterContent): string {
  const head = row(
    content.table.head
      .map((label) =>
        cell(
          `padding:8px 8px 7px;border-bottom:1px solid ${LETTER_GOLD_LIGHT};color:${LETTER_GOLD_INK};font-family:${FONT};font-size:10px;line-height:13px;letter-spacing:1.2px;font-weight:700;text-transform:uppercase;text-align:left`,
          label,
        ),
      )
      .join(""),
  );
  const body = content.table.rows
    .map((cells, index) =>
      row(
        cells
          .map((value, column) =>
            cell(
              `padding:8px;border-bottom:1px solid ${HAIR};${index % 2 === 1 ? "background:#F6F8FA;" : ""}color:${column === 0 ? LETTER_NAVY : INK};font-family:${FONT};font-size:13px;line-height:18px;${column === 0 ? "font-weight:700;" : ""}vertical-align:top`,
              value,
            ),
          )
          .join(""),
      ),
    )
    .join("");
  return table(head + body, "margin:14px 0 0");
}

function signOff(content: LibanoLetterContent): string {
  const { signer } = content;
  return (
    `<div style="padding:30px 0 10px;color:${LETTER_NAVY};font-family:${FONT};font-size:13px;line-height:18px;font-weight:700">For Sato Pharma</div>` +
    table(
      row(
        cell(
          `padding:12px 14px 14px 0;vertical-align:top;font-family:${FONT}`,
          `<div style="color:${LABEL_BLUE};font-size:11px;line-height:14px;font-weight:700">Name and title</div>` +
            `<div style="padding:8px 0 0;color:${LETTER_NAVY};font-size:19px;line-height:24px;font-weight:700">${escapeHtml(signer.name)}</div>` +
            `<div style="padding:3px 0 0;color:${INK};font-size:13px;line-height:18px">${escapeHtml(signer.title)}</div>` +
            `<div style="padding:5px 0 0;color:${LETTER_GOLD_INK};font-size:9px;line-height:12px;letter-spacing:1.6px;font-weight:700;text-transform:uppercase">${escapeHtml(signer.line)}</div>`,
          'width="58%"',
        ) +
          cell(
            `padding:12px 0 14px 14px;border-left:1px solid ${HAIR};vertical-align:top;font-family:${FONT}`,
            `<div style="color:${LABEL_BLUE};font-size:11px;line-height:14px;font-weight:700">Replies</div>` +
              // A narrow phone wraps the address after its @, never inside a word.
              `<div style="padding:8px 0 0;color:${INK};font-size:13px;line-height:18px">${escapeHtml(signer.replyTo).replace("@", "@<wbr>")}</div>` +
              `<div style="padding:3px 0 0;color:${SOFT};font-size:12px;line-height:17px">A reply to this email reaches the HR Manager directly.</div>`,
          ),
      ),
      `border-top:1.5px solid ${LETTER_GOLD};border-bottom:1px solid ${HAIR}`,
    )
  );
}

function runningFoot(content: LibanoLetterContent): string {
  const base = content.assetBaseUrl.replace(/\/+$/, "");
  return table(
    row(
      cell(
        "padding:10px 0 0;vertical-align:middle;width:44%",
        table(
          row(
            cell(
              "width:24px;vertical-align:middle",
              `<img src="${escapeHtml(`${base}/brand/phoenix-bird-icon.png`)}" width="18" height="18" alt="" style="display:block;border:0;width:18px;height:18px">`,
            ) +
              cell(
                `vertical-align:middle;color:${LETTER_NAVY};font-family:${FONT};font-size:9px;line-height:12px;letter-spacing:1.8px;font-weight:800`,
                "PHOENIX WORKFORCE",
              ),
          ),
          "width:auto",
        ),
      ) +
        cell(`padding:10px 0 0;vertical-align:middle;color:${SOFT};font-family:${FONT};font-size:10px;line-height:14px`, LETTER_DOCUMENT_CODE) +
        cell(`padding:10px 0 0;vertical-align:middle;width:16px;color:${LETTER_GOLD};font-size:11px;line-height:12px;text-align:right`, "&#9671;"),
    ),
    `margin:24px 0 0;border-top:1px solid ${LETTER_GOLD_LIGHT}`,
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
        "margin:18px 0 0",
      )
    : "";

  const paragraphs = content.paragraphsHtml
    .map((paragraph) => `<p style="margin:12px 0 0;color:${INK};font-family:${FONT};font-size:14px;line-height:23px">${paragraph}</p>`)
    .join("");

  const page =
    microtextBand() +
    table(
      row(
        cell(
          "padding:22px 24px 18px",
          testNotice +
            `<div style="padding:${testNotice ? "18px" : "0"} 0 0">${masthead(content)}</div>` +
            hero(content) +
            facts(content) +
            sectionHead("The people on the attached sheet") +
            figures(content) +
            table(
              row(
                cell(
                  `padding:0 0 0 12px;border-left:2px solid ${LETTER_GOLD};color:${LETTER_NAVY};font-family:${FONT};font-size:17px;line-height:23px;font-weight:700`,
                  escapeHtml(content.salutation),
                ),
              ),
              "margin:30px 0 0",
            ) +
            paragraphs +
            peopleTable(content) +
            `<p style="margin:20px 0 0;color:${LETTER_NAVY};font-family:${FONT};font-size:14px;line-height:22px;font-weight:700">${escapeHtml(content.closing)}</p>` +
            signOff(content) +
            `<p style="margin:18px 0 0;color:${SOFT};font-family:${FONT};font-size:11px;line-height:17px">${escapeHtml(content.automatedNote)}</p>` +
            runningFoot(content),
        ),
      ),
    ) +
    microtextBand();

  // The sheet: a gold keyline, a white gutter, a light gold keyline (the signed letter's double frame).
  const sheet = table(
    row(
      cell(
        `padding:5px;border:1px solid ${LETTER_GOLD};background:#ffffff`,
        table(row(cell(`border:1px solid ${LETTER_GOLD_LIGHT};background:#ffffff`, page)), "background:#ffffff"),
      ),
    ),
    "max-width:680px;background:#ffffff",
    'align="center"',
  );

  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"><title>${escapeHtml(content.subject)}</title></head>` +
    `<body style="margin:0;padding:0;background:${PAPER_GROUND}">` +
    preheader(content.text) +
    table(row(cell(`padding:16px 6px;background:${PAPER_GROUND}`, sheet)), `background:${PAPER_GROUND}`) +
    `</body></html>`;
  return { html, text: content.text };
}
