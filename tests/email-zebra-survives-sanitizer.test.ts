import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { sanitizeEmailTemplateHtml } from "@/lib/email/email-safety.ts";

/**
 * The zebra striping has to survive the SANITIZER, not just be emitted.
 *
 * Most emails reach a recipient with their summary table inlined into the template body as the
 * {{detailsTable}} token, and the whole interpolated body then goes through
 * sanitizeEmailTemplateHtml. The striping was lost there twice over: the layout wrote the
 * `background` shorthand, which is not in allowedStyles (only `background-color` is), and
 * `bgcolor` was not on the allow-list for a table cell. Both were dropped silently — the table
 * still rendered, just flat — and the token's own description still called it
 * "a premium zebra-striped label/value summary table".
 *
 * Measured on the rendered artifact 2026-09-10: of 10 alternate-row colour references emitted,
 * 10 reached the sanitizer and 0 came out.
 *
 * The first half below is behavioural against the real sanitizer. The second is a source check,
 * because the layout is a .tsx file that this runner cannot import — tests/stubs substitutes a
 * plain-string stand-in for it, and asserting on the stub would prove nothing about the email.
 */
export function runEmailZebraSurvivesSanitizerTests() {
  // --- The sanitizer must keep both striping mechanisms --------------------------------
  const striped =
    '<table width="100%"><tbody>' +
    '<tr bgcolor="#ffffff"><td bgcolor="#ffffff" style="background-color:#ffffff;padding:16px">Line</td>' +
    '<td bgcolor="#ffffff" style="background-color:#ffffff;padding:16px">Pedia</td></tr>' +
    '<tr bgcolor="#f1f5f9"><td bgcolor="#f1f5f9" style="background-color:#f1f5f9;padding:16px">Distributor</td>' +
    '<td bgcolor="#f1f5f9" style="background-color:#f1f5f9;padding:16px">Ibn Sina</td></tr>' +
    "</tbody></table>";

  const clean = sanitizeEmailTemplateHtml(striped);
  const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

  assert.ok(
    count(clean, "#f1f5f9") > 0,
    "the alternate row colour must survive sanitising — without it every details table renders flat",
  );
  assert.equal(
    count(clean, "#f1f5f9"),
    count(striped, "#f1f5f9"),
    "every alternate-row reference must survive, not merely some",
  );
  assert.ok(
    count(clean, 'bgcolor="#f1f5f9"') > 0,
    "bgcolor must survive on a cell — Outlook's Word engine ignores CSS backgrounds, so it is what stripes the row there",
  );
  assert.ok(
    count(clean, "background-color:#f1f5f9") > 0,
    "the background-color declaration must survive for every client that does honour CSS",
  );

  // The shorthand is still NOT allowed, which is exactly why the layout must not write it.
  const shorthand = sanitizeEmailTemplateHtml('<td style="background:#f1f5f9;padding:16px">x</td>');
  assert.ok(
    !shorthand.includes("#f1f5f9"),
    "the `background` shorthand is still dropped — this is the trap the layout must avoid, not a regression",
  );

  // --- The layout must emit what the sanitizer allows -----------------------------------
  const layout = readFileSync("src/emails/phoenix-email-layout.tsx", "utf8");
  assert.ok(
    !/style="padding:16px 20px;background:\$\{rowBg\}/.test(layout),
    "the metadata cells must not write the `background` shorthand — the sanitizer drops it",
  );
  const metadataTable = layout.slice(
    layout.indexOf("export function renderPhoenixMetadataTable("),
    layout.indexOf("export function renderPhoenixMetadataTableText("),
  );
  assert.equal(
    metadataTable.split("background-color:${rowBg}").length - 1,
    2,
    "both metadata cells (label and value) must set background-color from the row colour",
  );
  assert.ok(
    layout.includes('bgcolor="${rowBg}"'),
    "the rows must keep their bgcolor attribute for the clients that ignore CSS",
  );

  // --- The COLUMNAR grid, added 2026-10-09, is held to exactly the same two mechanisms ---
  //
  // It carries the production planner's reorder and expiry alarms, which reach their four readers
  // through a stored template body — so it is sanitised on the same path, and a `background`
  // shorthand or a dropped bgcolor would flatten it the same way.
  const grid = layout.slice(
    layout.indexOf("export function renderPhoenixDataGrid("),
    layout.indexOf("export function renderPhoenixDataGridText("),
  );
  assert.ok(grid.length > 0, "renderPhoenixDataGrid must still exist — the two alarm emails render through it");
  assert.ok(
    !/style="[^"]*background:/.test(grid),
    "the grid must not write the `background` shorthand anywhere — the sanitizer drops it",
  );
  assert.equal(
    grid.split("background-color:${rowBg.css}").length - 1,
    1,
    "the grid's body cell must set background-color from the row's own tint",
  );
  assert.ok(
    grid.includes('bgcolor="${rowBg.attr}"'),
    "the grid's rows and cells must keep an OPAQUE bgcolor attribute — it is all Outlook's Word engine reads",
  );
  assert.ok(
    grid.includes("${hairline}") && !grid.includes("border-bottom:"),
    "the grid must draw its hairlines with `border`, not `border-bottom` — border-bottom is not an allowed style",
  );
  // 🔴 The grid may not declare its own text colour: `.phoenix-text td, .phoenix-text span` carry
  // `color: … !important` in BOTH schemes and an inline declaration loses to them, while an inline
  // `!important` is dropped here (the value stops matching the pattern). Every fill is therefore a
  // translucent wash and the ink is inherited — a hard-coded colour would be a lie in one scheme.
  assert.ok(
    !/color:#[0-9a-f]{3,8}/i.test(grid),
    "the grid must not hard-code a text colour — the reader's colour scheme owns the ink",
  );
  assert.ok(
    /rgba\(/.test(grid),
    "the grid's fills must be translucent, so they read on a white body and on a dark one",
  );
  // And the two dark-mode blocks must re-tint by the bgcolor ATTRIBUTE, because class is stripped.
  for (const selector of ['tr[bgcolor="#ffffff"]', 'td[bgcolor="#f1f5f9"]', 'th[bgcolor="#e2e8f0"]']) {
    assert.equal(
      layout.split(selector).length - 1,
      2,
      `both dark-mode blocks must re-tint ${selector} — a sanitised table has no class left to match`,
    );
  }
  const translucent = sanitizeEmailTemplateHtml(
    '<td bgcolor="#f1f5f9" style="background-color:rgba(100,116,139,0.10);border:1px solid rgba(100,116,139,0.35)">x</td>',
  );
  assert.ok(translucent.includes("rgba(100,116,139,0.10)"), "a translucent fill must survive sanitising");
  assert.ok(translucent.includes("border:1px solid rgba(100,116,139,0.35)"), "a translucent border must survive too");
  for (const dropped of ["text-transform", "vertical-align", "white-space", "border-radius", "box-shadow"]) {
    assert.ok(!grid.includes(dropped), `the grid writes ${dropped}, which the sanitizer drops — it must not rely on it`);
  }

  // And behaviourally: a HEADER row has to survive, or the columns lose their headings.
  const headed = sanitizeEmailTemplateHtml(
    '<table width="100%"><thead><tr bgcolor="#e2e8f0">' +
      '<th bgcolor="#e2e8f0" style="background-color:rgba(100,116,139,0.18);border:1px solid rgba(100,116,139,0.35);padding:10px 12px;text-align:right">HELD NOW</th>' +
      "</tr></thead><tbody><tr><td>x</td></tr></tbody></table>",
  );
  assert.ok(headed.includes("HELD NOW"), "a column heading must survive sanitising");
  assert.ok(headed.includes("background-color:rgba(100,116,139,0.18)"), "the header band's fill must survive");
  assert.ok(headed.includes('bgcolor="#e2e8f0"'), "the header band must keep its bgcolor for Outlook");
  assert.ok(headed.includes("text-align:right"), "a numeric column must keep its right alignment");
}
