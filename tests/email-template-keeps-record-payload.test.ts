import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  getEmailTemplateHealth,
  requiredRecordPayloadTokens,
  validateEmailTemplatePayload,
} from "../src/lib/email-templates/service.ts";
import { resignationNoticeStatusLabel } from "../src/lib/resignations/view-model.ts";
import { stripComments } from "./support/comment-strip.ts";

// Audit F-COM-018 (19 Nov 2026). On 9 Sep 2026 the resignation template's body was replaced by
// one fixed sentence with no {{summary}}, {{detailsTable}} or {{status}}. A sender's record
// reaches an email only through {{detailsTable}}, so 155 resignation emails in 60 days went out
// with the workflow update and its details left out, while every layer reported them delivered.
// The owner chose "Bring details back"; the editor now refuses a body that drops the record token
// its template's default carries.

const SEP_9_RESIGNATION_BODY =
  "<p><strong>{{employeeName}}</strong> ({{employeeHrId}}) has submitted a resignation effective <strong>{{date}}</strong>.</p><p>Please initiate the offboarding workflow and ensure a smooth handover process.</p>";
const RESTORED_RESIGNATION_BODY = "<p>{{summary}}</p>{{detailsTable}}<p>{{status}}</p>";

const RULES = {
  bccRoles: [],
  bccStaticEmails: [],
  ccRoles: ["hr" as const],
  ccStaticEmails: [],
  targetLines: [],
  targetTitles: [],
  toRoles: ["manager_chain" as const],
  toStaticEmails: [],
};

export function runEmailTemplateKeepsRecordPayloadTests() {
  // 1. Which templates must keep a record token: exactly the ones whose own default carries one.
  assert.deepEqual(
    requiredRecordPayloadTokens("resignation_workflow"),
    ["detailsTable"],
    "the resignation default carries {{detailsTable}}, so a saved resignation body must keep it",
  );
  assert.deepEqual(
    requiredRecordPayloadTokens("resignation"),
    ["detailsTable"],
    "the legacy 'resignation' key resolves to resignation_workflow and carries the same requirement",
  );
  assert.deepEqual(
    requiredRecordPayloadTokens("direct_order_approved"),
    ["detailsSections"],
    "a grouped-details template must keep {{detailsSections}}",
  );
  assert.deepEqual(
    requiredRecordPayloadTokens("general"),
    [],
    "a template whose default never carried a record token is not held to one",
  );
  assert.deepEqual(requiredRecordPayloadTokens("not_a_template"), [], "an unknown key requires nothing");

  // 2. The 9 Sep body is refused for the resignation template, naming the missing token.
  const sep9 = validateEmailTemplatePayload({ bodyHtml: SEP_9_RESIGNATION_BODY }, new Set(), "resignation_workflow");
  assert.equal(sep9.isValid, false, "the body that dropped the details table must not save");
  const missing = sep9.issues.find((issue) => issue.token === "detailsTable");
  assert.ok(missing, "the refusal must name {{detailsTable}}");
  assert.equal(missing.field, "bodyHtml", "the refusal is pinned to the body, where the editor highlights it");
  assert.equal(missing.type, "required");

  // 3. The restored body saves.
  const restored = validateEmailTemplatePayload({ bodyHtml: RESTORED_RESIGNATION_BODY }, new Set(), "resignation_workflow");
  assert.equal(restored.isValid, true, "summary + details table + status is a valid resignation body");

  // 4. A partial update that sends no body is not judged: the saved body is kept as it is.
  const partial = validateEmailTemplatePayload({ subject: "Resignation Notice" }, new Set(), "resignation_workflow");
  assert.equal(partial.isValid, true, "a subject-only update keeps the saved body and must not be refused");

  // 5. Other templates are untouched by the rule: no record token in their default, nothing required.
  const general = validateEmailTemplatePayload({ bodyHtml: "<p>Hello</p>" }, new Set(), "general");
  assert.equal(general.isValid, true, "a template with no record token in its default saves a plain body");

  // 6. A grouped-details body that drops its sections is refused too.
  const directOrder = validateEmailTemplatePayload({ bodyHtml: "<p>{{summary}}</p>" }, new Set(), "direct_order_approved");
  assert.ok(
    directOrder.issues.some((issue) => issue.token === "detailsSections"),
    "a direct-order approval body without {{detailsSections}} must be refused",
  );

  // 7. The template health card flags a live body that already lost the table.
  const health = getEmailTemplateHealth(
    {
      bodyHtml: SEP_9_RESIGNATION_BODY,
      bodyText: "",
      closingText: "Please route this according to HR procedure.",
      description: "Resignation workflow updates.",
      greeting: "Dear {{honorific}}{{recipientName}},",
      isActive: true,
      previewText: "Resignation notice",
      subject: "Resignation Notice — {{employeeName}} ({{employeeHrId}})",
      templateKey: "resignation_workflow",
      templateName: "Resignation Notice",
    },
    RULES,
  );
  assert.ok(
    health.issues.some((issue) => issue.severity === "error" && issue.message.includes("{{detailsTable}}")),
    "the health card must show the missing details table as an error, not report the template good",
  );

  // 8. Every caller that knows the template hands its key to the validator, so the save, the test
  //    send, the draft check and the health card all apply the rule.
  const service = stripComments(readFileSync("src/lib/email-templates/service.ts", "utf8"));
  assert.match(service, /validateEmailTemplatePayload\(payload, customTokens, key\)/, "saveEmailTemplate passes the key");
  assert.match(
    service,
    /validateEmailTemplatePayload\(input\.template \?\? \{\}, customTokens, key\)/,
    "sendTemplateTestEmail passes the key",
  );
  assert.match(
    service,
    /validateEmailTemplatePayload\(\{ \.\.\.template, rules \}, extraAllowedTokens, template\.templateKey\)/,
    "getEmailTemplateHealth passes the key",
  );
  const designer = stripComments(readFileSync("src/lib/email/email-designer.ts", "utf8"));
  assert.match(
    designer,
    /validateEmailTemplatePayload\(template, customTokens, input\.templateKey\)/,
    "the editor's draft check passes the key",
  );

  // 9. The resignation notice shows a status a reader knows, never the stored code.
  assert.equal(resignationNoticeStatusLabel("under_review"), "Under review");
  assert.equal(resignationNoticeStatusLabel("declined_offer"), "Declined offer");
  assert.equal(resignationNoticeStatusLabel("submitted"), "Submitted");
  const resignations = stripComments(readFileSync("src/lib/resignations/service.ts", "utf8"));
  assert.match(
    resignations,
    /\{ label: "Status", value: statusLabel \}/,
    "the resignation notice's Status row carries the readable label",
  );
  assert.match(
    resignations,
    /const statusLabel = resignationNoticeStatusLabel\(record\.status\);/,
    "the readable label is built from the record's status",
  );
}
