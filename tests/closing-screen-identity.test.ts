import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { EXECUTIVE_PALETTE } from "../src/lib/sales/closing-executive-look.ts";
import {
  CLOSING_COLUMN_TINT,
  CLOSING_FONT_STACK,
  CLOSING_GRID_LINE,
  CLOSING_IDENTITY,
} from "../src/lib/sales/closing-identity.ts";

// ─────────────────────────────────────────────────────────────────────────────
// THE CLOSING SCREEN WEARS THE PREMIUM CLOSING WORKBOOK'S IDENTITY.
//
// Owner, 2026-09-12: "brand the front end closing as the premium xlsx sato identity", and then
// "add other colours for special columns for identification". The premium Monthly Closing workbook
// already carries an approved executive look (owner 2026-09-08, pinned by
// `closing-executive-look.test.ts`); the screen a manager reads is now painted from the same
// palette, so the page and the download are visibly one document.
//
// WHY A TEST AND NOT A COMMENT. `src/lib/sales/closing-identity.ts` COPIES the eleven colours rather
// than importing them, because `closing-executive-look.ts` is a server module carrying JSZip and a
// base64 emblem and a "use client" component must not pull that into the browser bundle. A copy with
// nothing holding it to its original drifts silently: somebody adjusts the workbook's navy, the
// screen keeps the old one, and the two documents stop matching with no error anywhere. This test is
// what makes the copy safe, and it runs in the required CI `validate` job.
//
// THE SECOND HALF IS A SWEEP, NOT A PIN. The three closing components are checked for colour
// literals that belong to no palette at all — a stray `slate-500`, an invented hex — because that is
// how the page looked before this work: five unrelated hues (sky, orange, amber, violet and a green
// the owner rejected on sight) doing the job the identity does with two navies and a blue.
// ─────────────────────────────────────────────────────────────────────────────

const SALES_UI = "../src/components/sales/";

function readComponent(name: string) {
  return fs.readFileSync(fileURLToPath(new URL(SALES_UI + name, import.meta.url)), "utf8");
}

/**
 * The comparator, extracted so the negative control below can run the SAME code against a
 * deliberately corrupted palette. A pinning test that only ever sees the passing case proves the
 * assertion executed, never that it can fail.
 */
function diffAgainstWorkbook(screen: Record<string, string>, workbook: Record<string, string>) {
  const problems: string[] = [];
  for (const [role, css] of Object.entries(screen)) {
    const argb = workbook[role];
    if (!argb) {
      problems.push(`${role}: the screen has this colour, the workbook does not`);
      continue;
    }
    // The workbook spells every colour with an FF alpha prefix (FF0A1F33); CSS does not. That
    // prefix is the ONLY difference allowed.
    const expected = `#${argb.slice(2)}`;
    if (css.toUpperCase() !== expected.toUpperCase()) {
      problems.push(`${role}: screen ${css} vs workbook ${expected}`);
    }
  }
  for (const role of Object.keys(workbook)) {
    if (!(role in screen)) problems.push(`${role}: the workbook has this colour, the screen does not`);
  }
  return problems;
}

/** `rgba(r, g, b, a)` → `#RRGGBB`, so a tint can be checked against the hex it was derived from. */
function rgbaToHex(value: string) {
  const m = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/.exec(value);
  assert.ok(m, `not an rgba() colour: ${value}`);
  const hex = [m[1], m[2], m[3]]
    .map((n) => Number(n).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
  return { hex: `#${hex}`, alpha: Number(m[4]) };
}

/**
 * Comments are stripped before the colour sweep. Several of these files EXPLAIN a colour they must
 * not use — `closing-identity-styles.tsx` quotes the shell's own `#000000` header rule to say why it
 * is overriding it — and a sweep that reads prose would fail on the explanation while the code it
 * describes is correct.
 */
function stripComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

export async function runClosingScreenIdentityTests() {
  // ── 1. Every colour on the screen is the workbook's, role for role ─────────
  const problems = diffAgainstWorkbook(
    CLOSING_IDENTITY as unknown as Record<string, string>,
    EXECUTIVE_PALETTE as unknown as Record<string, string>,
  );
  assert.deepEqual(problems, [], `the closing screen's palette has drifted from the workbook's:\n${problems.join("\n")}`);
  assert.equal(
    Object.keys(CLOSING_IDENTITY).length,
    Object.keys(EXECUTIVE_PALETTE).length,
    "the screen and the workbook must carry the SAME set of roles — a colour added to one and not the other is exactly the drift this test exists to catch",
  );

  // ── 2. Negative control ───────────────────────────────────────────────────
  // Break the pin and watch the comparator fire. Without this, a comparator that silently returned
  // [] — a renamed key, an early return — would report a perfect match forever.
  const corrupted = { ...(EXECUTIVE_PALETTE as unknown as Record<string, string>), primaryNavy: "FF0B2A4A" };
  const control = diffAgainstWorkbook(CLOSING_IDENTITY as unknown as Record<string, string>, corrupted);
  assert.ok(
    control.some((p) => p.startsWith("primaryNavy:")),
    "the comparator did not notice a changed navy — it cannot be trusted to notice a real one either",
  );
  assert.equal(control.length, 1, `only the corrupted role should differ, got: ${control.join(", ")}`);

  // ── 3. The derived colours are derived, not invented ──────────────────────
  // The hairline and the two column tints are the only colours on the page that are not a literal
  // palette entry. Each must still BE a palette entry, at an alpha — that is what keeps the page on
  // the approved eleven rather than on eleven plus whatever looked right on the day.
  const line = rgbaToHex(CLOSING_GRID_LINE);
  assert.equal(line.hex, CLOSING_IDENTITY.mutedText.toUpperCase(), "the grid hairline must be the identity's mutedText, not an invented grey");
  assert.ok(line.alpha > 0 && line.alpha < 1, "a hairline at full alpha is a cage, not a rule");

  const officeTint = rgbaToHex(CLOSING_COLUMN_TINT.office);
  assert.equal(officeTint.hex, CLOSING_IDENTITY.secondaryNavy.toUpperCase(), "the 'of which Office' column ground must be a tint of secondaryNavy");
  const achTint = rgbaToHex(CLOSING_COLUMN_TINT.achievement);
  assert.equal(achTint.hex, CLOSING_IDENTITY.corporateBlue.toUpperCase(), "the 'Ach %' column ground must be a tint of corporateBlue");
  for (const [name, tint] of [["office", officeTint], ["achievement", achTint]] as const) {
    assert.ok(
      tint.alpha > 0 && tint.alpha < 0.25,
      `the ${name} column tint must stay a TINT (alpha ${tint.alpha}): these grounds sit over a zebra band on some rows and a region subtotal's fill on others, and at high alpha they erase whichever they land on`,
    );
  }
  // Compared through the widened values rather than `office !== achievement`: the object is `as
  // const`, so TypeScript reads that as two non-overlapping literal types and rejects the
  // comparison outright (TS2367) instead of letting it run.
  const tintValues: string[] = Object.values(CLOSING_COLUMN_TINT);
  assert.equal(
    new Set(tintValues).size,
    tintValues.length,
    "two special columns sharing one ground identifies neither",
  );

  // accentCyan is spent on exactly ONE control (Export Premium XLSX), the way the workbook spends it
  // on exactly one (the Rep Card's Export PDF). A column wearing it would take that away.
  for (const [name, tint] of Object.entries(CLOSING_COLUMN_TINT)) {
    assert.notEqual(
      rgbaToHex(tint).hex,
      CLOSING_IDENTITY.accentCyan.toUpperCase(),
      `the ${name} column may not wear accentCyan — it is the one loud colour and it belongs to a single control`,
    );
  }

  // ── 4. The typeface ───────────────────────────────────────────────────────
  assert.ok(
    CLOSING_FONT_STACK.startsWith('"Segoe UI"'),
    "every font in closing-executive-look.ts is Segoe UI; the screen must lead with it or the two documents do not match",
  );

  // ── 5. No colour on these screens belongs to another palette ──────────────
  // The identity's own eleven, plus the two things that are deliberately NOT identity:
  const allowedHex = new Set<string>([
    ...Object.values(CLOSING_IDENTITY).map((c) => c.toUpperCase()),
    // 🔒 AGENTS.md §4: "THE OLD MONTHLY CLOSING EXPORT IS FROZEN ... the black Export XLSX button —
    // no restyle, no refactor. It is the auditor's file." Its near-black is not a palette drift; it
    // is a lock, and §6 below asserts it is still there.
    "#0B0B0B",
  ]);
  // A FAILURE is not chrome. The portal's error strip stays red, because an error rendered in the
  // house navy reads as part of the report rather than as the report having failed.
  const allowedPaletteClasses = new Set(["bg-rose-50", "border-rose-100", "text-rose-700"]);
  const PALETTE_CLASS =
    /\b(?:text|bg|border|from|to|via|ring|divide|outline|decoration|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g;

  const components = [
    "closing-matrix-table.tsx",
    "closing-identity-styles.tsx",
    "monthly-closing-workspace.tsx",
    "closing-summary-fits.tsx",
    "portal-monthly-closing-view.tsx",
  ];
  for (const name of components) {
    const code = stripComments(readComponent(name));
    for (const hex of code.match(/#[0-9a-fA-F]{6}\b/g) ?? []) {
      assert.ok(
        allowedHex.has(hex.toUpperCase()),
        `${name} paints with ${hex}, which is in no approved palette — the closing screen carries the premium workbook's identity and nothing else`,
      );
    }
    for (const cls of code.match(PALETTE_CLASS) ?? []) {
      assert.ok(
        allowedPaletteClasses.has(cls),
        `${name} uses the Tailwind palette class "${cls}" — that is the five-unrelated-hues look the identity replaced`,
      );
    }
  }

  // ── 6. The frozen Export XLSX button survived the rebrand ─────────────────
  const workspace = readComponent("monthly-closing-workspace.tsx");
  assert.ok(
    workspace.includes("border border-[#0B0B0B] bg-[#0B0B0B] px-4 text-sm font-bold text-white transition hover:bg-phx-accent"),
    "the OLD monthly closing export's black button has been restyled — it is frozen by the owner's own rule (AGENTS.md §4) and is the auditor's file",
  );

  // ── 7. Every special column has a colour, and keeps it inside the Grand Total ──
  const grid = readComponent("closing-matrix-table.tsx");
  const styleBlock = /<style>\{`([\s\S]*?)`\}<\/style>/.exec(grid)?.[1];
  assert.ok(styleBlock, "the closing matrix's scoped stylesheet is gone — the grid is then painted by the shell's black-and-orange table rules");

  for (const role of ["phx-band", "phx-family", "phx-gt", "phx-office", "phx-contr", "phx-tgt", "phx-ach"]) {
    assert.ok(styleBlock.includes(`thead th.${role}`), `the header class "${role}" is used in the markup but has no rule — that column renders as an ordinary one`);
    assert.ok(grid.includes(role), `the rule for "${role}" is dead — no header carries the class`);
  }

  // ORDER IS LOAD-BEARING, and it is the one thing here that cannot be seen by reading a colour.
  // Every column role also appears inside the Grand Total block, where its header carries `phx-gt`
  // as well. The two selectors have equal specificity, so SOURCE ORDER decides: a role listed after
  // `phx-gt` keeps its own colour there, and one listed before it silently hands the column back to
  // the block — which is precisely the "Tgt Value in the grand total has no colour of its own"
  // complaint that started this work.
  const gtAt = styleBlock.indexOf("thead th.phx-gt");
  for (const role of ["phx-tgt", "phx-ach", "phx-office", "phx-contr"]) {
    assert.ok(
      styleBlock.indexOf(`thead th.${role}`) > gtAt,
      `"${role}" is declared BEFORE phx-gt, so inside the Grand Total block that column loses its own colour`,
    );
  }
}
