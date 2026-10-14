import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { emailTemplateKeys } from "@/lib/email-templates/key-resolution.ts";
import { TOKEN_REGISTRY } from "@/lib/email-templates/token-registry.ts";

/**
 * The seven emails that used to build their body in code (2026-09-09).
 *
 * Each was assembled inline by its own module and could not be edited from
 * /admin/email-templates at all. They now render from a template key. This pins the three
 * things that would silently undo that:
 *
 *  1. A sender quietly going back to sendPhoenixEmail — the email stops being editable and
 *     nothing fails, because a direct send is still a perfectly valid send.
 *  2. A token in one of the new bodies that is not in TOKEN_REGISTRY. interpolate() resolves
 *     ONLY from the registry, so an unregistered token renders EMPTY — that is exactly what
 *     shipped the blank probation emails on 2026-07-14.
 *  3. A sender losing its own idempotency key. sendTemplatedEmail otherwise derives one by
 *     hashing the subject, recipients and context, so a run whose data shifted slightly would
 *     hash differently and send a SECOND copy — a second monthly report, a second daily
 *     probation sweep, a second CV digest to the same manager.
 */

const CONVERTED: ReadonlyArray<{
  file: string;
  key: string;
  /** The dedupe guarantee this sender must keep. */
  idempotencyPrefix: string;
}> = [
  { file: "src/lib/direct-orders/approved-email.ts", key: "direct_order_approved", idempotencyPrefix: "direct-order-approved:" },
  { file: "src/lib/direct-orders/phantom-report.ts", key: "direct_order_probation_report", idempotencyPrefix: "direct-orders-phantom-report:" },
  { file: "src/lib/sales/closing-publish-notification.ts", key: "monthly_closing_published", idempotencyPrefix: "closing-published:" },
  { file: "src/lib/sales/sos-report-delivery.ts", key: "sos_executive_report", idempotencyPrefix: "sos-bi-report:" },
  { file: "src/lib/recruitment/inbound/cv-intake-digest-6h.ts", key: "cv_intake_digest", idempotencyPrefix: "cv-intake-digest-6h:" },
  { file: "src/lib/notifications/telegram-onboarding.ts", key: "telegram_connect", idempotencyPrefix: "telegram-onboard:" },
  { file: "src/lib/sales/weekly/upload-notification.ts", key: "weekly_sales_uploaded", idempotencyPrefix: "weekly-upload:" },
  { file: "src/lib/sales/targets-uploaded-notification.ts", key: "targets_uploaded", idempotencyPrefix: "targets-uploaded:" },
];

function templateDefaultBlock(source: string, key: string) {
  const start = source.indexOf(`\n  ${key}: {\n`);
  assert.notEqual(start, -1, `templateDefaults is missing an entry for ${key}`);
  const end = source.indexOf("\n  },\n", start);
  assert.notEqual(end, -1, `templateDefaults entry for ${key} is not terminated`);
  return source.slice(start, end);
}

export function runEmailTemplatesForCodeBuiltSendersTests() {
  const service = readFileSync("src/lib/email-templates/service.ts", "utf8");
  const registered = new Set<string>(TOKEN_REGISTRY.map((t) => t.token));
  // The two projection siblings and the greeting name are resolved by contextVariables rather
  // than being registry entries of their own — see render-core.ts.
  const alsoResolvable = new Set<string>(["recipientName", "honorific"]);

  for (const { file, key, idempotencyPrefix } of CONVERTED) {
    // --- 1. the key is a real, routable template ------------------------------------
    assert.ok(
      (emailTemplateKeys as readonly string[]).includes(key),
      `${key} must be in emailTemplateKeys or nothing can resolve it`,
    );
    assert.match(
      service,
      new RegExp(`^  ${key}: "`, "m"),
      `${key} must have a templateCategories entry, or its send is bucketed as unknown`,
    );
    assert.match(
      service,
      new RegExp(`^  ${key}: emptyRules\\(`, "m"),
      `${key} must have a defaultRules entry so the admin sees editable routing`,
    );

    const block = templateDefaultBlock(service, key);
    assert.match(block, /isActive: true/, `${key} must ship active — an inactive template sends nothing`);
    assert.match(block, /bodyHtml: "[^"]+"/, `${key} must ship a non-empty bodyHtml`);

    // --- 2. every token in the body actually resolves --------------------------------
    for (const [, token] of block.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
      assert.ok(
        registered.has(token) || alsoResolvable.has(token),
        `${key} uses {{${token}}}, which is not in TOKEN_REGISTRY — it would render EMPTY`,
      );
    }

    // --- 3. the sender is template-driven and keeps its dedupe -----------------------
    const sender = readFileSync(file, "utf8");
    assert.match(
      sender,
      new RegExp(`templateKey: "${key}"`),
      `${file} must dispatch through the ${key} template`,
    );
    assert.ok(
      !/\bsendPhoenixEmail\s*\(/.test(sender),
      `${file} must not call sendPhoenixEmail directly — that is the email becoming uneditable again`,
    );
    assert.ok(
      sender.includes(idempotencyPrefix),
      `${file} must keep its own idempotency key (${idempotencyPrefix}…) — the derived hash does not guarantee one send`,
    );
    assert.match(
      sender,
      /idempotencyKey[,:]/,
      `${file} must pass idempotencyKey through to sendTemplatedEmail`,
    );
  }

  // --- The engine passthroughs these conversions depend on ----------------------------
  // Each is generated content rather than wording, so it rides BESIDE the template. Losing
  // any one of them is silent: the mail still goes, just without the file or the figure.
  assert.match(service, /attachments: input\.attachments,/, "sendTemplatedEmail must forward attachments — the SoS workbook rides on it");
  assert.match(service, /heroStat: options\.heroStat/, "renderEmailTemplate must forward the hero stat to the layout");
  assert.match(
    service,
    /idempotencyKey: input\.idempotencyKey\?\.trim\(\) \|\| `template-/,
    "sendTemplatedEmail must prefer the caller's idempotency key over the derived hash",
  );

  // --- The weekly notice's own rule: NAMES ONLY, never a figure ----------------------
  // One weekly-upload mail reaches every District Manager on the line off a NATIONAL sheet, so a
  // sales figure would be wider than the region each reader is scoped to everywhere else. Making
  // the wording admin-editable must not open a route to one, so no figure-bearing token may
  // appear in the template body. tests/weekly-upload-line-notification.test.ts pins the sender
  // side of the same rule.
  const weeklyBlock = templateDefaultBlock(service, "weekly_sales_uploaded");
  for (const figure of ["salesQty", "netQty", "returnQty", "bonusQty", "salesValue", "stockQty", "amount"]) {
    assert.ok(
      !weeklyBlock.includes(`{{${figure}}}`),
      `the Weekly Sales Uploaded template must never render {{${figure}}} — one shared mail cannot carry a number scoped to one reader`,
    );
  }

  // The SoS workbook is the only attachment in the set, and an attachment that never reaches
  // the sender is invisible: the email arrives, just with nothing attached.
  const sos = readFileSync("src/lib/sales/sos-report-delivery.ts", "utf8");
  assert.match(sos, /attachments:\s*\[/, "the SoS report must still attach its workbook");
  assert.match(sos, /\.xlsx`/, "the SoS attachment must still be the xlsx workbook");
}
