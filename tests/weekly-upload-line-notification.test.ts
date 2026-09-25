import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { groupWeeklyProductsByTrackedLine } from "../src/lib/sales/weekly/upload-notification.ts";
import type { WeeklyProductSummary } from "../src/lib/sales/weekly/types.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * A WEEKLY UPLOAD TELLS EXACTLY THE LINES WHOSE PRODUCTS IT CARRIES — AND NOBODY ELSE.
 *
 * Owner, 2026-09-09: when SFE or a system administrator uploads a weekly sheet, the District
 * Managers and National Sales Manager of every line in that sheet are emailed that their products
 * were read from it. His own example: a sheet holding Saginko, Royafloxacin and Tebofortin mails
 * Anti Infective and CNS.
 *
 * TWO INVARIANTS CARRY THE WHOLE FEATURE, AND BOTH FAIL QUIETLY IF BROKEN.
 *
 * 1. WHICH LINES. The audience is derived from the sheet's own products, so a grouping bug does not
 *    produce an error — it produces a mail to the wrong managers, or none at all. Head Office is the
 *    sharp edge: it is 90% of weekly VALUE and it has no DM seat and no NSM seat, so a sheet whose
 *    products are mostly Head Office must still mail only the tracked lines beside it. Letting Head
 *    Office through would not throw; resolveWeeklyUploadLineRecipients would simply find no seat and
 *    return empty, which looks identical to a healthy no-op.
 *
 * 2. NO FIGURES IN THE BODY. One email reaches every District Manager on a line at once, and a
 *    weekly sheet is national — so any quantity or value in it is wider than the region each reader
 *    is scoped to on every screen he can open. Product NAMES are what he was promised. A number
 *    added to the body later would be a silent widening of what a DM can see, with no error and no
 *    access check to catch it, which is why it is pinned here rather than left to review.
 *
 * The notify opt-out is the same shape, and the same one-directional risk, as the monthly closing's
 * silent publish (tests/closing-publish-silently.test.ts): the guard must be `!== false`, because a
 * truthiness test would make every caller that FORGETS the argument upload in silence, and silence
 * is the failure nobody can see.
 */

const SERVICE_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/sales/weekly/service.ts", import.meta.url)),
  "utf8",
);

const NOTIFIER_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/sales/weekly/upload-notification.ts", import.meta.url)),
  "utf8",
);

/** Source with comments stripped, so a rule quoted in prose cannot satisfy a check. */
function code(source: string): string {
  return stripComments(source);
}

/**
 * Body of one exported function, sliced from its signature to the next top-level export. Scoped to
 * the function deliberately, never a fixed byte window — a source-pinning test that slices a fixed
 * range false-fails the moment anything above it shifts.
 */
function exportedFunctionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  assert.ok(start > 0, `expected to find ${name}`);
  const rest = source.slice(start + 1);
  const next = rest.indexOf("\nexport ");
  return next === -1 ? rest : rest.slice(0, next);
}

/** A byProduct row — only the three fields the grouping reads carry meaning. */
function product(productCode: string, productName: string, officialLine: string): WeeklyProductSummary {
  return {
    productCode,
    productName,
    officialLine,
    rowCount: 1,
    salesQty: 10,
    returnQty: 0,
    netQty: 10,
    bonusQty: 0,
    salesValue: 1000,
    stockQty: 5,
  };
}

export function runWeeklyUploadLineNotificationTests() {
  // ── The owner's own example, end to end ──────────────────────────────────────────────────────
  // Saginko and Royafloxacin are Anti Infective; "Tibo 14" is the Tebofortin family, which is CNS.
  const example = groupWeeklyProductsByTrackedLine([
    product("SA001", "Saginko", "Anti Infective"),
    product("RO001", "Royafloxacin", "Anti Infective"),
    product("TE001", "Tebofortin 120 mg Intens", "CNS"),
  ]);
  assert.deepEqual(
    [...example.byLine.keys()].sort(),
    ["Anti Infective", "CNS"],
    "his example must reach exactly Anti Infective and CNS — the two lines the sheet's products belong to",
  );
  assert.deepEqual(
    example.byLine.get("CNS")?.map((row) => row.productName),
    ["Tebofortin 120 mg Intens"],
    "each line's mail lists that line's OWN products — a CNS manager reading an Anti Infective list has learnt nothing",
  );
  assert.equal(
    example.byLine.get("Anti Infective")?.length,
    2,
    "both Anti Infective products belong to the one Anti Infective mail",
  );

  // ── Head Office never mails, and never suppresses the tracked lines beside it ────────────────
  const withHeadOffice = groupWeeklyProductsByTrackedLine([
    product("LA003", "Lacto Basic 1", "Head Office"),
    product("RY001", "ROYANOXICAM 8MG 20 TAB", "Head Office"),
    product("GU001", "Guamusin", "Pedia"),
  ]);
  assert.deepEqual(
    [...withHeadOffice.byLine.keys()],
    ["Pedia"],
    "Head Office has no DM seat and no NSM seat and is not tracked weekly — only Pedia is mailed",
  );
  assert.deepEqual(
    withHeadOffice.skippedUntrackedLines,
    ["Head Office"],
    "an untracked line is REPORTED as skipped, not silently dropped — the caller can say why nothing was sent",
  );

  const headOfficeOnly = groupWeeklyProductsByTrackedLine([product("LA003", "Lacto Basic 1", "Head Office")]);
  assert.equal(
    headOfficeOnly.byLine.size,
    0,
    "a Head-Office-only sheet mails nobody — that is the golden rule holding, not a failure to resolve seats",
  );

  // ── One product, one row, however many times the sheet names it ──────────────────────────────
  const duplicated = groupWeeklyProductsByTrackedLine([
    product("SA001", "Saginko", "Anti Infective"),
    product("sa001", "Saginko", "Anti Infective"),
    product("SA001", "Saginko", "Anti Infective"),
  ]);
  assert.equal(
    duplicated.byLine.get("Anti Infective")?.length,
    1,
    "a product code is deduped case-insensitively — a sheet listing one product twice must not print it twice",
  );

  // ── Sorted by name, so the same sheet always reads the same way ──────────────────────────────
  const sorted = groupWeeklyProductsByTrackedLine([
    product("C2", "Conviban 50 mg", "CNS"),
    product("C1", "Conviban 100 mg", "CNS"),
    product("D1", "Dolabactin", "CNS"),
  ]);
  assert.deepEqual(
    sorted.byLine.get("CNS")?.map((row) => row.productName),
    ["Conviban 100 mg", "Conviban 50 mg", "Dolabactin"],
    "products are name-sorted, so two uploads of one sheet cannot produce two different-looking mails",
  );

  // ── Junk rows cannot invent a line or a blank bullet ─────────────────────────────────────────
  const junk = groupWeeklyProductsByTrackedLine([
    product("", "No code", "CNS"),
    product("X1", "No line", ""),
    product("D1", "Dolabactin", "CNS"),
  ]);
  assert.deepEqual(
    junk.byLine.get("CNS")?.map((row) => row.productCode),
    ["D1"],
    "a row missing its code or its line is skipped — never rendered as an empty bullet in somebody's inbox",
  );
  assert.equal(junk.byLine.has(""), false, "a blank line is never an audience");

  // ── The send fires only where a batch actually persisted ─────────────────────────────────────
  const importer = code(exportedFunctionBody(SERVICE_SOURCE, "importWeeklySalesFile"));
  assert.match(
    importer,
    /notify\?\s*:\s*boolean/,
    "notify must be OPTIONAL — every existing caller keeps mailing without being changed",
  );
  assert.match(
    importer,
    /input\.notify\s*!==\s*false/,
    "the send must be guarded by `input.notify !== false`",
  );
  assert.doesNotMatch(
    importer,
    /if\s*\(\s*input\.notify\s*\)/,
    "a truthiness check would make a FORGOTTEN argument upload in silence — the one failure nobody sees",
  );
  assert.equal(
    importer.split("notifyWeeklyUploadLines(").length - 1,
    1,
    "exactly one send site, so the guard cannot be bypassed by a second call",
  );

  const persistIndex = importer.indexOf("persistWeeklyUpload(");
  const guardIndex = importer.indexOf("input.notify !== false");
  const sendIndex = importer.indexOf("notifyWeeklyUploadLines(");
  assert.ok(persistIndex > 0, "expected the persist call to still be here");
  assert.ok(
    persistIndex < guardIndex && guardIndex < sendIndex,
    "the send sits AFTER the persist and behind the guard — a dry-run validate must never be able to mail anybody",
  );

  // ── The notifier itself stays unconditional: silence belongs to the caller ───────────────────
  const notifier = code(NOTIFIER_SOURCE);
  assert.doesNotMatch(
    notifier,
    /\bnotify\s*[?!]?\s*[:=]/,
    "notifyWeeklyUploadLines must NOT learn about notify — a future caller must not inherit a silence it never asked for",
  );

  // ── No sales figures in the body, ever ───────────────────────────────────────────────────────
  // One mail reaches every DM on the line and the sheet is national, so a figure here is wider than
  // the region each reader is scoped to everywhere else. Names only.
  for (const field of ["salesQty", "netQty", "returnQty", "bonusQty", "salesValue", "stockQty"]) {
    assert.doesNotMatch(
      notifier,
      new RegExp(`\\b${field}\\b`),
      `${field} must never reach the email body — one shared mail cannot carry a number scoped to one reader`,
    );
  }

  // ── The wizard is told the audience before the operator presses Confirm ──────────────────────
  assert.match(
    code(SERVICE_SOURCE),
    /notifiableLines\s*=/,
    "the result must carry notifiableLines, so the upload wizard can NAME who is about to be mailed",
  );
}
