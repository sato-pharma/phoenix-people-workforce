import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  assertReachableEmailImage,
  buildManualComposerIdempotencyKey,
  sanitizeEmailTemplateHtml,
  validateManualEmailRecipientPolicy,
} from "../src/lib/email/email-safety.ts";
import { draftEmailWithAi } from "../src/lib/email/ai-assist.ts";
import {
  compileTemplateRecipientPresets,
  getEmailDesignerMetadata,
} from "../src/lib/email/email-designer.ts";
import {
  getEmailTemplateHealth,
} from "../src/lib/email-templates/service.ts";

export async function runEmailGovernanceTests() {
  const sanitized = sanitizeEmailTemplateHtml(
    '<p onclick="alert(1)">Hello</p><script>alert(1)</script><a href="javascript:alert(1)">Bad</a><iframe src="https://x.test"></iframe>',
  );
  assert.match(sanitized, /<p>Hello<\/p>/);
  assert.doesNotMatch(sanitized, /script|iframe|onclick|javascript:/i);

  const originalOpenAiFetch = globalThis.fetch;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const originalOpenAiModel = process.env.OPENAI_MODEL;
  try {
    process.env.OPENAI_API_KEY = "test-openai-key";
    delete process.env.OPENAI_MODEL;

    type AiDraftRequestBody = {
      input?: unknown;
      instructions?: unknown;
      model?: unknown;
      store?: unknown;
      text?: { format?: { schema?: { additionalProperties?: unknown }; strict?: unknown; type?: unknown } };
    };
    const requestBodies: AiDraftRequestBody[] = [];
    const outputText = JSON.stringify({
      bodyHtml: '<p onclick="alert(1)">Hello {{employeeName}} {{bad.token}}</p><script>alert(1)</script>',
      closingText: "Regards {{employeeName}} {{inventedToken}}",
      greeting: "Dear {{employeeName}},",
      previewText: "Preview",
      subject: "Subject for {{employeeName}} {{inventedToken}}",
    });
    globalThis.fetch = (async (url, init) => {
      assert.equal(url, "https://api.openai.com/v1/responses");
      requestBodies.push(JSON.parse(String(init?.body ?? "{}")) as AiDraftRequestBody);
      return new Response(
        JSON.stringify({
          output: [
            {
              content: [
                {
                  annotations: [],
                  text: outputText,
                  type: "output_text",
                },
              ],
              role: "assistant",
              status: "completed",
              type: "message",
            },
          ],
          output_text: outputText,
        }),
        { headers: { "content-type": "application/json", "x-request-id": "req_email_governance" }, status: 200 },
      );
    }) as typeof fetch;

    const aiDraft = await draftEmailWithAi({
      current: {
        bodyHtml: "<p>Old</p>",
        closingText: "Old close",
        greeting: "Dear Team,",
        previewText: "Old preview",
        subject: "Old subject",
      },
      instruction: "Rewrite this email",
      mode: "composer",
      variables: [{ label: "Employee Name", sampleValue: "Mariam Adel", token: "employeeName" }],
    });

    const requestBody = requestBodies[0];
    assert.ok(requestBody);
    assert.equal(requestBody?.model, "gpt-5.4-nano");
    assert.equal(requestBody?.store, false);
    assert.equal(requestBody?.text?.format?.type, "json_schema");
    assert.equal(requestBody?.text?.format?.strict, true);
    assert.equal(requestBody?.text?.format?.schema?.additionalProperties, false);
    assert.match(String(requestBody?.instructions ?? ""), /Return all five fields/);
    assert.match(String(requestBody?.input ?? ""), /User request:/);
    assert.match(aiDraft.draft.subject, /\{\{employeeName\}\}/);
    assert.doesNotMatch(aiDraft.draft.subject, /inventedToken/);
    assert.match(aiDraft.draft.bodyHtml, /\{\{employeeName\}\}/);
    assert.doesNotMatch(aiDraft.draft.bodyHtml, /script|onclick|bad\.token/i);
    assert.ok(aiDraft.warnings.some((warning) => warning.includes("inventedToken")));
    assert.ok(aiDraft.warnings.some((warning) => warning.includes("malformed placeholder")));
  } finally {
    globalThis.fetch = originalOpenAiFetch;
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
    if (originalOpenAiModel === undefined) delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL = originalOpenAiModel;
  }

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

  const designerMetadata = getEmailDesignerMetadata();
  const employeeNameVariable = designerMetadata.variables.find((variable) => variable.token === "employeeName");
  assert.equal(employeeNameVariable?.label, "Employee Name");
  assert.equal(employeeNameVariable?.category, "Employee");
  assert.ok(employeeNameVariable?.sampleValue);
  assert.ok(designerMetadata.recipientPresets.some((preset) => preset.key === "hr_team" && preset.role === "hr"));

  const healthyTemplate = getEmailTemplateHealth(
    {
      bodyHtml: "<p>Hello</p>",
      bodyText: "Hello",
      closingText: "Regards",
      description: "Test",
      greeting: "Dear Team,",
      isActive: true,
      previewText: "Preview",
      subject: "Subject",
      templateKey: "general",
      templateName: "General",
    },
    {
      bccRoles: [],
      bccStaticEmails: [],
      ccRoles: [],
      ccStaticEmails: [],
      targetLines: [],
      targetTitles: [],
      toRoles: ["hr"],
      toStaticEmails: [],
    },
  );
  assert.equal(healthyTemplate.status, "good");

  const compiledPresets = compileTemplateRecipientPresets({
    cc: ["hr_team"],
    to: ["employee", "direct_manager"],
  });
  assert.deepEqual(compiledPresets.toRoles, ["employee", "direct_manager"]);
  assert.deepEqual(compiledPresets.ccRoles, ["hr"]);

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

  const metadataRouteSource = readFileSync("app/api/admin/email-templates/designer-metadata/route.ts", "utf8");
  assert.match(metadataRouteSource, /getEmailDesignerMetadata/);
  assert.match(metadataRouteSource, /getEmailTemplateCategoryOptions/);

  const validateDraftRouteSource = readFileSync("app/api/admin/email-templates/validate-draft/route.ts", "utf8");
  assert.match(validateDraftRouteSource, /validateEmailTemplateDraft/);

  const templateManagerSource = readFileSync("src/components/admin/email-template-manager.tsx", "utf8");
  assert.match(templateManagerSource, /saveTemplate\(mode: "draft" \| "publish" \| "save"\)/);
  assert.match(templateManagerSource, /Save Changes/);
  assert.match(templateManagerSource, /action: mode === "publish" \? "publish" : mode === "save" \? "save" : "draft"/);
  assert.match(templateManagerSource, /isActive: mode === "publish" \? true : draft\.isActive/);

  const composerOptionsRouteSource = readFileSync("app/api/admin/email-composer/options/route.ts", "utf8");
  assert.match(composerOptionsRouteSource, /getEmailComposerOptions/);

  const composerResolveRouteSource = readFileSync("app/api/admin/email-composer/resolve-recipients/route.ts", "utf8");
  assert.match(composerResolveRouteSource, /resolveComposerRecipients/);

  const composerPreviewRouteSource = readFileSync("app/api/admin/email-composer/preview/route.ts", "utf8");
  assert.match(composerPreviewRouteSource, /previewManualEmail/);

  const composerSendRouteSource = readFileSync("app/api/admin/email-reply/send/route.ts", "utf8");
  assert.match(composerSendRouteSource, /resolveComposerRecipients/);
  assert.match(composerSendRouteSource, /recordManualEmailSendAudit/);

  const migration = readFileSync("supabase/migrations/20260531110416_email_template_governance_history.sql", "utf8");
  assert.match(migration, /create table if not exists public\.email_template_history/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /revoke all on public\.email_template_history from anon, authenticated/);
  assert.match(migration, /to service_role/);

  const manualAuditMigration = readFileSync("supabase/migrations/20260531130610_manual_email_send_audit.sql", "utf8");
  assert.match(manualAuditMigration, /create table if not exists public\.manual_email_send_audit/);
  assert.match(manualAuditMigration, /enable row level security/);
  assert.match(manualAuditMigration, /revoke all on public\.manual_email_send_audit from anon, authenticated/);
  assert.match(manualAuditMigration, /to service_role/);

  const designerUpgradeMigration = readFileSync("supabase/migrations/20260531164447_email_template_designer_upgrades.sql", "utf8");
  assert.match(designerUpgradeMigration, /create table if not exists public\.email_template_drafts/);
  assert.match(designerUpgradeMigration, /enable row level security/);
  assert.match(designerUpgradeMigration, /revoke all on public\.email_template_drafts from anon, authenticated/);
  assert.match(designerUpgradeMigration, /to service_role/);

  assert.match(templateServiceSource, /emailTemplateDraftsTable/);
  assert.match(templateServiceSource, /saveEmailTemplateDraft/);
  assert.match(templateServiceSource, /clearEmailTemplateDraft/);
  const composerServiceSource = readFileSync("src/lib/email/email-composer-service.ts", "utf8");
  assert.match(composerServiceSource, /getManualEmailDeliveryAnalytics/);
  assert.match(composerServiceSource, /manual_email_send_audit/);
}
