/**
 * The owner's decision sheet for the square-edge golden rule — every corner a session must not
 * decide on its own, in one workbook.
 *
 * WHY A WORKBOOK AND NOT A LIST IN CHAT. Standing owner rule (AGENTS.md §4): business-fact
 * questions are asked as an XLSX with dropdowns, one row per item, with the context that makes the
 * call easy and a free-text Note column. "Which of these is a corner and which is a circle" is
 * exactly that shape of question.
 *
 * WHY THESE ROWS AND NOT THE OTHERS. The 2026-09-05 audit found rounding in three kinds of place:
 *
 *   1. Things the rule names outright — cards, buttons, tags, inputs, bars, avatars, badges. Those
 *      were squared in the same branch as this script and are NOT in here. Asking about them would
 *      be asking the owner to re-state a rule he already locked.
 *   2. Things another branch already owns (the payslip route under PR #3200, the payroll glow bar
 *      under `codex/payroll-glow-bar-square-edge`). Not ours to ask about.
 *   3. THESE. A scrollbar handle, a decorative glow, a spinner ring, a design token, an email in a
 *      mail client. Squaring any of them would be a visible change nobody asked for, and reading
 *      the rule as covering them is an inference, not an instruction.
 *
 * NOTHING IS PADDED. Where one decision genuinely covers many declarations — every corner in one
 * email layout is one question about one medium — it is ONE row carrying the site count, not eleven
 * rows of the same question. Where the elements are genuinely distinct, they get a row each.
 *
 * Run:  node --experimental-strip-types --experimental-specifier-resolution=node \
 *         scripts/square-edge-questions.ts
 *
 * NO IMAGES AND NO OUTLINE GROUPS, deliberately. ExcelJS writes two schema-invalid OOXML fragments
 * that make Excel silently "repair" a workbook: `outlineProperties` together with
 * `pageSetup.fitToPage`, and `ws.addImage`. This sheet triggers neither, which is what keeps the
 * output openable without post-processing the zip. Do not add a logo here without reading that trap.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import ExcelJS from "exceljs";

const HEADER_FILL = "FF0F172A";
const ACCENT_FILL = "FFF97316";

/** Square it, or leave it alone. Two options, because there are two. */
const CORNER_OPTIONS = '"Square it,Leave it round"';

/** The token layer has a third answer: the token can go away entirely. */
const TOKEN_OPTIONS = '"Set it to 0,Keep as is,Retire the token"';

type SheetWithValidations = ExcelJS.Worksheet & {
  dataValidations: { add: (range: string, rule: ExcelJS.DataValidation) => void };
};

type CornerRow = {
  group: string;
  what: string;
  where: string;
  element: string;
  value: string;
  context: string;
  sites: number;
};

/**
 * Every corner still standing, with the reason it might legitimately stay.
 *
 * The `context` column is the whole point of the sheet: it is what makes each call answerable in a
 * few seconds without opening the code.
 */
const CORNERS: CornerRow[] = [
  // ── Scrollbars ────────────────────────────────────────────────────────────────────────────────
  {
    group: "Scrollbar",
    what: "Admin sidebar scrollbar handle",
    where: "app/globals.css",
    element: ".phoenix-admin-sidebar-scroll::-webkit-scrollbar-thumb",
    value: "999px",
    context:
      "The little draggable bar in the admin sidebar. A browser's own scrollbar is rounded on every "
      + "OS; squaring ours makes it look unlike every other scrollbar on the machine.",
    sites: 1,
  },
  {
    group: "Scrollbar",
    what: "Whole-page scrollbar handle, admin screens",
    where: "app/globals.css",
    element: 'html:has(.admin-shell)::-webkit-scrollbar-thumb',
    value: "999px",
    context: "The main page scrollbar on every admin screen. Same question as the row above.",
    sites: 1,
  },
  {
    group: "Scrollbar",
    what: "Portal sidebar scrollbar groove",
    where: "app/globals.css",
    element: ".phoenix-employee-sidebar-scroll::-webkit-scrollbar-track",
    value: "999px",
    context: "The channel the handle slides in, in the employee portal sidebar.",
    sites: 1,
  },
  {
    group: "Scrollbar",
    what: "Portal sidebar scrollbar handle",
    where: "app/globals.css",
    element: ".phoenix-employee-sidebar-scroll::-webkit-scrollbar-thumb",
    value: "999px",
    context: "The draggable bar in the employee portal sidebar.",
    sites: 1,
  },
  {
    group: "Scrollbar",
    what: "Horizontal scroller groove",
    where: "app/globals.css",
    element: ".phoenix-horizontal-scroll::-webkit-scrollbar-track",
    value: "999px",
    context: "Used where a wide strip scrolls sideways inside a page.",
    sites: 1,
  },
  {
    group: "Scrollbar",
    what: "Horizontal scroller handle",
    where: "app/globals.css",
    element: ".phoenix-horizontal-scroll::-webkit-scrollbar-thumb",
    value: "999px",
    context: "The draggable bar of that sideways scroller.",
    sites: 1,
  },

  // ── The login screen's decorations ────────────────────────────────────────────────────────────
  {
    group: "Login decoration",
    what: "Halo behind the Phoenix emblem",
    where: "app/globals.css",
    element: ".login-logo-glow::before, .login-logo-glow::after",
    value: "9999px",
    context:
      "A soft round glow behind the logo on the sign-in screen. At 9999px it is a CIRCLE, not a "
      + "rounded box — squaring it turns the halo into a glowing square. NOTE: this one rule paints "
      + "TWO layers (::before and ::after), so one answer moves both.",
    sites: 1,
  },
  {
    group: "Login decoration",
    what: "Drifting ember specks",
    where: "app/globals.css",
    element: ".login-ember",
    value: "9999px",
    context:
      "The small orange sparks that float up the sign-in screen. Circles by intent — square sparks "
      + "would read as falling confetti.",
    sites: 1,
  },
  {
    group: "Login decoration",
    what: "White dot inside the emblem",
    where: "src/components/auth/premium-login-page.tsx",
    element: "rounded-full on a 8×8px dot",
    value: "full circle",
    context: "A single glowing dot at the centre of the logo mark.",
    sites: 1,
  },
  {
    group: "Login decoration",
    what: "Sign-in button's loading spinner",
    where: "src/components/auth/premium-login-page.tsx",
    element: "rounded-full on the spinning ring",
    value: "full circle",
    context:
      "The ring that spins while signing in. A spinner has to be a circle to read as spinning — "
      + "squared, it looks like a glitching box. Same for the row below.",
    sites: 1,
  },
  {
    group: "Login decoration",
    what: "Fingerprint button's loading spinner",
    where: "src/components/auth/premium-login-page.tsx",
    element: "rounded-full on the spinning ring",
    value: "full circle",
    context: "The same spinner on the biometric sign-in button.",
    sites: 1,
  },

  // ── Company documents and the identity card ───────────────────────────────────────────────────
  {
    group: "Identity card",
    what: "Employee photo — outer frame",
    where: "src/components/phoenix-signature-card/EmployeePortrait.tsx",
    element: "the portrait's outer border",
    value: "10–18px (scales with the card)",
    context:
      "The photo frame on the employee identity card. The rule names avatars as square, but this is "
      + "a portrait on a printed-looking ID card, which is a different object from a round avatar "
      + "chip in a table.",
    sites: 1,
  },
  {
    group: "Identity card",
    what: "Employee photo — the image itself",
    where: "src/components/phoenix-signature-card/EmployeePortrait.tsx",
    element: "the portrait image inside the frame",
    value: "8–15px (scales with the card)",
    context: "Sits just inside the frame above. Normally answered the same way.",
    sites: 1,
  },
  {
    group: "Identity card",
    what: "Separator dot on the card",
    where: "src/components/phoenix-signature-card/PhoenixSignatureCard.tsx",
    element: "a 5×5px dot at 50%",
    value: "full circle",
    context: "A tiny orange dot used as a separator between two pieces of text. A dot, not a corner.",
    sites: 1,
  },
  {
    group: "Offer letter",
    what: "Circular mark beside each lead paragraph",
    where: "src/lib/offers/render.ts",
    element: ".lede-mark",
    value: "50% (a 34px circle)",
    context:
      "IMPORTANT: the PRINT stylesheet in the same file already squares this. So the offer letter on "
      + "PAPER is square today and only the on-screen preview is round — the two disagree. Squaring "
      + "it makes screen match paper.",
    sites: 1,
  },

  // ── Email — a different medium ────────────────────────────────────────────────────────────────
  {
    group: "Email",
    what: "The main Phoenix email layout",
    where: "src/emails/phoenix-email-layout.tsx",
    element: "card, hero panel, badge, buttons, glow bars",
    value: "8px–999px",
    context:
      "Every automated email the system sends uses this layout. Email is read in Outlook, Gmail and "
      + "phone mail apps, not in Phoenix — so it is a different medium from the app and from a "
      + "printed company document. Rounded buttons are ordinary there. One answer covers all 11.",
    sites: 11,
  },
  {
    group: "Email",
    what: "Telegram-connect email",
    where: "src/emails/telegram-connect.tsx",
    element: "the numbered step badges",
    value: "12px",
    context: "The little numbered circles in the 'connect your Telegram' walkthrough email.",
    sites: 1,
  },
  {
    group: "Email",
    what: "Google-style email template",
    where: "templates/phoenix-google-style-email.html",
    element: "card, button, two avatars",
    value: "4px–50%",
    context: "A standalone email template file. Same medium question as the rows above.",
    sites: 4,
  },
  {
    group: "Email",
    what: "Seeded email templates in the database",
    where: "supabase/20260517_seed_email_templates.sql",
    element: "the call-to-action buttons",
    value: "10px",
    context:
      "These are seed rows, so the live copies are in the database — changing the file alone would "
      + "NOT change what is sent. Answer this only if you want the sent emails changed too.",
    sites: 5,
  },

  // ── A standalone page ─────────────────────────────────────────────────────────────────────────
  {
    group: "Static guide",
    what: "Marketing user guide page",
    where: "public/marketing-guide.html",
    element: "cards, pills, badges, step circles",
    value: "4px–100px",
    context:
      "A standalone illustrated guide served at /marketing-guide.html. Nothing in the app links to "
      + "it — it is reachable only by typing the address — and it sits outside both shells, so no "
      + "sweep touches it. 37 corners; one answer covers the file.",
    sites: 37,
  },
];

type TokenRow = { token: string; value: string; drives: string };

/**
 * The token layer.
 *
 * tokens.css says in its own header that nothing consumes the --phx- system yet. FOR RADIUS THAT IS
 * NO LONGER TRUE: app/globals.css maps these straight into Tailwind, so `--phx-radius: 4px` IS what
 * `rounded-lg` renders, app-wide. Inside the admin shell and the employee portal the two sweeps
 * flatten the result to 0; everywhere else — sign-in, an error page, a generated document — it
 * renders as written. That is the mechanism AGENTS.md §4 describes when it says a session copying a
 * sibling component inherits a corner silently.
 */
const TOKENS: TokenRow[] = [
  { token: "--phx-radius-xs", value: "2px", drives: "Tailwind's rounded-sm" },
  { token: "--phx-radius-sm", value: "3px", drives: "Tailwind's rounded-md" },
  {
    token: "--phx-radius",
    value: "4px",
    drives: "Tailwind's rounded-lg — and the file calls this 'the default for cards, inputs and buttons'",
  },
  { token: "--phx-radius-lg", value: "6px", drives: "Tailwind's rounded-xl" },
  { token: "--phx-radius-xl", value: "10px", drives: "Tailwind's rounded-2xl" },
  {
    token: "--phx-radius-pill",
    value: "999px",
    drives: "nothing today — but it is a ready-made pill shape sitting in the token file",
  },
];

function styleHeader(sheet: ExcelJS.Worksheet, rowNumber: number): void {
  const row = sheet.getRow(rowNumber);
  row.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    cell.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
  });
  row.height = 30;
}

function addTitle(sheet: ExcelJS.Worksheet, columns: number, title: string, subtitle: string): void {
  sheet.mergeCells(1, 1, 1, columns);
  const titleCell = sheet.getCell("A1");
  titleCell.value = title;
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ACCENT_FILL } };
  titleCell.font = { bold: true, size: 14, color: { argb: "FFFFFFFF" } };
  titleCell.alignment = { vertical: "middle", horizontal: "left" };
  sheet.getRow(1).height = 30;

  sheet.mergeCells(2, 1, 2, columns);
  const subtitleCell = sheet.getCell("A2");
  subtitleCell.value = subtitle;
  subtitleCell.font = { size: 10, color: { argb: "FF475569" } };
  subtitleCell.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
  sheet.getRow(2).height = 46;
}

function buildReadMe(workbook: ExcelJS.Workbook): void {
  const sheet = workbook.addWorksheet("Read me", { properties: { tabColor: { argb: ACCENT_FILL } } });
  sheet.columns = [{ width: 30 }, { width: 108 }];

  addTitle(
    sheet,
    2,
    "Square edges — the calls only you can make",
    "Your rule is 'no round or semi-round corners, anywhere'. Everything the rule names outright — "
      + "cards, buttons, tags, inputs, bars, avatars, badges — has already been squared and is NOT "
      + "in here. What is left is the handful of places where squaring would change something you "
      + "may not have meant to change.",
  );

  const rows: [string, string][] = [
    [
      "What you are deciding",
      "Each row is one thing that is still round. Set Decision to 'Square it' or 'Leave it round'. "
        + "Anything you leave blank stays exactly as it is today, so a half-finished sheet is safe to "
        + "send back.",
    ],
    [
      "Why these were not just squared",
      "A scrollbar handle, a spinner and a glowing speck are circles, not corners. Squaring them "
        + "would be a visible change to the sign-in screen and every scrollbar in the app that you "
        + "did not ask for. Guessing either way is worse than asking once.",
    ],
    [
      "Corners (20 rows)",
      "Scrollbars, the sign-in screen's decorations, the identity card, the offer letter and email. "
        + "The 'What it looks like' column tells you what you are looking at without opening the code.",
    ],
    [
      "Radius tokens (6 rows)",
      "The design-token file still ships a rounding scale and calls 4px 'the default for cards, "
        + "inputs and buttons'. That default is why a corner keeps coming back: a new screen copied "
        + "from an old one inherits it silently. Deciding these once stops the leak at the source.",
    ],
    [
      "Where one row covers many",
      "Three rows carry a site count above 1 — one email layout (11), one email template (4), and the "
        + "marketing guide page (37). Those are one decision about one file, so they are one row each "
        + "rather than 52 copies of the same question.",
    ],
    [
      "What happens next",
      "Send the file back. Every 'Square it' becomes a code change; every 'Leave it round' is written "
        + "into the test that guards this, so nobody re-asks and no future session squares it by "
        + "accident.",
    ],
  ];

  let cursor = 4;
  for (const [label, body] of rows) {
    sheet.getCell(`A${cursor}`).value = label;
    sheet.getCell(`A${cursor}`).font = { bold: true, size: 11 };
    sheet.getCell(`A${cursor}`).alignment = { vertical: "top", wrapText: true };
    sheet.getCell(`B${cursor}`).value = body;
    sheet.getCell(`B${cursor}`).alignment = { vertical: "top", wrapText: true };
    sheet.getRow(cursor).height = 60;
    cursor += 1;
  }
}

function buildCorners(workbook: ExcelJS.Workbook): void {
  const sheet = workbook.addWorksheet("Corners");
  sheet.columns = [
    { width: 18 },
    { width: 34 },
    { width: 46 },
    { width: 12 },
    { width: 62 },
    { width: 20 },
    { width: 40 },
  ];

  addTitle(
    sheet,
    7,
    `Corners still standing — ${CORNERS.length} decisions`,
    "Set Decision on each row. Blank means 'leave it exactly as it is'.",
  );

  const headerRow = 4;
  sheet.getRow(headerRow).values = [
    "Group",
    "What it is",
    "What it looks like on screen",
    "Rounded by",
    "Where it lives",
    "Decision",
    "Note (anything you want to add)",
  ];
  styleHeader(sheet, headerRow);

  CORNERS.forEach((corner, index) => {
    const row = sheet.getRow(headerRow + 1 + index);
    row.values = [
      corner.group,
      corner.sites > 1 ? `${corner.what}  (${corner.sites} corners)` : corner.what,
      corner.context,
      corner.value,
      `${corner.where}\n${corner.element}`,
      "",
      "",
    ];
    row.alignment = { vertical: "top", wrapText: true };
    row.height = 54;
    row.getCell(6).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF7ED" } };
    row.getCell(7).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF7ED" } };
  });

  // ONE sheet-level validation over the whole column. Setting `cell.dataValidation` per row makes
  // ExcelJS coalesce them into OVERLAPPING sqref ranges, which puts two validations on one cell and
  // is its own "we found a problem with some content" repair on open.
  const lastRow = headerRow + CORNERS.length;
  (sheet as SheetWithValidations).dataValidations.add(`F${headerRow + 1}:F${lastRow}`, {
    type: "list",
    allowBlank: true,
    formulae: [CORNER_OPTIONS],
    showErrorMessage: true,
    errorTitle: "Square it, or leave it",
    error: "Choose 'Square it' to remove the rounding, or 'Leave it round' to keep it as it is today.",
  });

  sheet.views = [{ state: "frozen", ySplit: headerRow }];
  sheet.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: lastRow, column: 7 } };
}

function buildTokens(workbook: ExcelJS.Workbook): void {
  const sheet = workbook.addWorksheet("Radius tokens");
  sheet.columns = [{ width: 24 }, { width: 12 }, { width: 74 }, { width: 22 }, { width: 40 }];

  addTitle(
    sheet,
    5,
    "The rounding scale in the design-token file",
    "These six values are why a corner keeps coming back. They are wired into Tailwind, so they "
      + "decide what every rounded-* class renders as. Inside the admin shell and the employee "
      + "portal a sweep flattens them to square; everywhere else — sign-in, error pages, generated "
      + "documents — they render as written.",
  );

  const headerRow = 4;
  sheet.getRow(headerRow).values = ["Token", "Value", "What it controls", "Decision", "Note"];
  styleHeader(sheet, headerRow);

  TOKENS.forEach((token, index) => {
    const row = sheet.getRow(headerRow + 1 + index);
    row.values = [token.token, token.value, token.drives, "", ""];
    row.alignment = { vertical: "top", wrapText: true };
    row.height = 34;
    row.getCell(4).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF7ED" } };
    row.getCell(5).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF7ED" } };
  });

  const lastRow = headerRow + TOKENS.length;
  (sheet as SheetWithValidations).dataValidations.add(`D${headerRow + 1}:D${lastRow}`, {
    type: "list",
    allowBlank: true,
    formulae: [TOKEN_OPTIONS],
    showErrorMessage: true,
    errorTitle: "What should this token be?",
    error:
      "'Set it to 0' keeps the name but makes it square. 'Retire the token' removes it, so anything "
      + "still using it has to be rewritten. 'Keep as is' changes nothing.",
  });

  sheet.views = [{ state: "frozen", ySplit: headerRow }];
  sheet.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: lastRow, column: 5 } };
}

function nextFreePath(): string {
  const today = new Date().toISOString().slice(0, 10);
  const base = resolve("xlsx", `square-edge-decisions-${today}`);
  const first = `${base}.xlsx`;
  if (!existsSync(first)) return first;
  for (let attempt = 2; attempt < 100; attempt += 1) {
    const candidate = `${base}-${attempt}.xlsx`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error("Too many square-edge question workbooks written today — clear xlsx/ before rerunning.");
}

async function main(): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce — square-edge audit";
  workbook.created = new Date();

  buildReadMe(workbook);
  buildCorners(workbook);
  buildTokens(workbook);

  const outputPath = nextFreePath();
  mkdirSync(dirname(outputPath), { recursive: true });
  await workbook.xlsx.writeFile(outputPath);

  const totalSites = CORNERS.reduce((sum, corner) => sum + corner.sites, 0);
  console.log(`Wrote ${outputPath}`);
  console.log(`${CORNERS.length} corner decisions covering ${totalSites} declarations, plus ${TOKENS.length} radius tokens.`);
}

await main();
