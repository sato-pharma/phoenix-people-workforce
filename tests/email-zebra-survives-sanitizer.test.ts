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
  assert.equal(
    layout.split("background-color:${rowBg}").length - 1,
    2,
    "both metadata cells (label and value) must set background-color from the row colour",
  );
  assert.ok(
    layout.includes('bgcolor="${rowBg}"'),
    "the rows must keep their bgcolor attribute for the clients that ignore CSS",
  );
}
