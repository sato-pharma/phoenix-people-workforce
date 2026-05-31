import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  assertReachableEmailImage,
  buildManualComposerIdempotencyKey,
  sanitizeEmailTemplateHtml,
  validateManualEmailRecipientPolicy,
} from "../src/lib/email/email-safety.ts";

export async function runEmailGovernanceTests() {
  const sanitized = sanitizeEmailTemplateHtml(
    '<p onclick="alert(1)">Hello</p><script>alert(1)</script><a href="javascript:alert(1)">Bad</a><iframe src="https://x.test"></iframe>',
  );
  assert.match(sanitized, /<p>Hello<\/p>/);
  assert.doesNotMatch(sanitized, /script|iframe|onclick|javascript:/i);

  const externalPolicy = validateManualEmailRecipientPolicy({
    externalJustification: "",
    to: ["hr@satopharma.com", "candidate@example.com"],
  });
  assert.equal(externalPolicy.externalRecipients.length, 1);
  assert.equal(externalPolicy.issues[0]?.code, "external_justification_required");

  const cappedPolicy = validateManualEmailRecipientPolicy({
    externalJustification: "Approved external candidate communication",
    to: Array.from({ length: 26 }, (_unused, index) => `person${index}@satopharma.com`),
  });
  assert.equal(cappedPolicy.issues[0]?.code, "too_many_recipients");

  const idempotencyInput = {
    bcc: [] as string[],
    cc: ["cc@satopharma.com"],
    clientRequestId: "request-1",
    recipientName: "Recipient",
    replyMessage: "Message",
    senderName: "HR",
    subject: "Subject",
    to: ["to@satopharma.com"],
    tone: "professional",
  };
  assert.equal(buildManualComposerIdempotencyKey(idempotencyInput), buildManualComposerIdempotencyKey(idempotencyInput));
  assert.notEqual(
    buildManualComposerIdempotencyKey(idempotencyInput),
    buildManualComposerIdempotencyKey({ ...idempotencyInput, clientRequestId: "request-2" }),
  );

  const originalFetch = globalThis.fetch;
  try {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response(null, { headers: { "content-type": "image/png" }, status: 200 });
    }) as typeof fetch;
    await assertReachableEmailImage("https://assets.example.com/signature.png", { cacheTtlMs: 60_000 });
    await assertReachableEmailImage("https://assets.example.com/signature.png", { cacheTtlMs: 60_000 });
    assert.equal(fetchCalls, 1);

    globalThis.fetch = (async () => new Response(null, { status: 500 })) as typeof fetch;
    const staleResult = await assertReachableEmailImage("https://assets.example.com/signature.png", { cacheTtlMs: -1 });
    assert.equal(staleResult.verified, true);
    assert.match(staleResult.warning ?? "", /previous success/);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const templateServiceSource = readFileSync("src/lib/email-templates/service.ts", "utf8");
  assert.match(templateServiceSource, /simulateTemplateRecipients/);
  assert.match(templateServiceSource, /recordTemplateHistory/);
  assert.match(templateServiceSource, /rollbackEmailTemplate/);
  assert.match(templateServiceSource, /sanitizeEmailTemplateHtml/);

  const simulationRouteSource = readFileSync("app/api/admin/email-templates/simulate-recipients/route.ts", "utf8");
  assert.match(simulationRouteSource, /simulateTemplateRecipients/);

  const historyRouteSource = readFileSync("app/api/admin/email-templates/[templateKey]/history/route.ts", "utf8");
  assert.match(historyRouteSource, /getEmailTemplateHistory/);

  const rollbackRouteSource = readFileSync("app/api/admin/email-templates/[templateKey]/rollback/route.ts", "utf8");
  assert.match(rollbackRouteSource, /rollbackEmailTemplate/);

  const migration = readFileSync("supabase/migrations/20260531105230_email_template_governance_history.sql", "utf8");
  assert.match(migration, /create table if not exists public\.email_template_history/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /revoke all on public\.email_template_history from anon, authenticated/);
  assert.match(migration, /to service_role/);
}
