import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  insertTelegramPlaceholder,
  renderTelegramCtaUrl,
  renderTelegramTemplateText,
  validateTelegramTemplateButtons,
  validateTelegramCta,
  validateTelegramTemplateText,
} from "../src/lib/notifications/telegram-template-placeholders.ts";
import { selectTemplateRow } from "../src/lib/notifications/templates.ts";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

export function runTelegramTemplateManagementTests() {
  const service = source("src/lib/notifications/telegram-templates.ts");
  const centralTemplates = source("src/lib/notifications/templates.ts");
  const placeholders = source("src/lib/notifications/telegram-template-placeholders.ts");
  const telegramAdapter = source("src/lib/notifications/telegram.ts");
  const system = source("src/lib/notifications/system.ts");
  const route = source("app/api/admin/notifications/telegram/templates/route.ts");
  const page = source("app/(admin)/admin/notifications/telegram/templates/page.tsx");
  const component = source("src/components/admin/telegram-template-manager.tsx");
  const accessRegistry = source("src/lib/security/access-registry.ts");
  const navigation = source("src/config/system-navigation.ts");

  assert.equal(insertTelegramPlaceholder("Hello ", "employeeName", 6), "Hello {{employeeName}}");
  assert.equal(insertTelegramPlaceholder("Hello name", "employeeName", 6, 10), "Hello {{employeeName}}");

  const validation = validateTelegramTemplateText("Hello {{employeeName}} {{badToken}}", ["employeeName"]);
  assert.deepEqual(validation.unknownPlaceholders, ["badToken"]);
  assert.match(validation.errors.join(" "), /Unknown placeholders: badToken/);

  const htmlValidation = validateTelegramTemplateText("<b>Hello</b> {{employeeName}}", ["employeeName"]);
  assert.match(htmlValidation.errors.join(" "), /HTML is not allowed/);

  assert.equal(
    renderTelegramTemplateText("Employee: {{employeeName}}\nOpen: {{actionUrl}}", {
      actionUrl: "/admin/notifications/telegram/templates",
      employeeName: "Phoenix Admin",
    }, ["employeeName", "actionUrl"]),
    "Employee: Phoenix Admin\nOpen: /admin/notifications/telegram/templates",
  );
  assert.throws(
    () => renderTelegramTemplateText("Employee: {{employeeName}} {{eventDate}}", { employeeName: "Phoenix Admin" }, ["employeeName", "eventDate"]),
    /Missing required variables: eventDate/,
  );
  assert.equal(
    renderTelegramCtaUrl("{{requestUrl}}", { requestUrl: "/admin/vacations/REQ-1001" }, ["requestUrl"]),
    "/admin/vacations/REQ-1001",
  );
  assert.deepEqual(
    validateTelegramCta({ allowedPlaceholders: ["requestUrl"], ctaEnabled: true, ctaLabel: "View Request", ctaUrl: "{{badUrl}}" }).unknownPlaceholders,
    ["badUrl"],
  );
  assert.match(
    validateTelegramCta({ allowedPlaceholders: ["requestUrl"], ctaEnabled: true, ctaLabel: "Approve", ctaUrl: "{{requestUrl}}" }).errors.join(" "),
    /cannot be approval or rejection actions/,
  );
  assert.throws(
    () => renderTelegramCtaUrl("not a valid url", {}, []),
    /CTA URL must be a Phoenix path or a valid web URL/,
  );
  assert.deepEqual(
    validateTelegramTemplateButtons({
      allowedPlaceholders: ["requestUrl"],
      buttons: [{ enabled: true, label: "View Details", type: "view_details", url: "{{requestUrl}}" }],
    }).errors,
    [],
  );
  assert.match(
    validateTelegramTemplateButtons({
      allowedPlaceholders: ["requestUrl"],
      buttons: [{ enabled: true, label: "Approve", type: "custom", url: "{{requestUrl}}" }],
    }).errors.join(" "),
    /cannot approve or reject unless they open a Phoenix confirmation page/,
  );
  assert.deepEqual(
    validateTelegramTemplateButtons({
      allowedPlaceholders: ["approveUrl"],
      buttons: [{ enabled: true, label: "Approve in Phoenix", type: "custom", url: "{{approveUrl}}" }],
    }).errors,
    [],
  );

  assert.match(service, /telegramTemplateDefinitions/);
  // Module-wide templates: every workflow card matches ALL of its module's Telegram
  // events via the "*" eventType, so editing one card governs the whole module.
  assert.match(service, /templateKey: "contract_renewal"/);
  assert.match(service, /templateKey: "probation"/);
  assert.match(service, /templateKey: "vacation"/);
  assert.match(service, /templateKey: "outstation"/);
  assert.match(service, /templateKey: "weekly_plans"/);
  assert.match(service, /templateKey: "marketing_requests"/);
  assert.match(service, /templateKey: "general_admin_test"/);
  assert.match(service, /eventType: "\*"/, "workflow templates must be module-wide");
  assert.match(service, /contentPlaceholders = \["title", "message"\]/, "templates must expose the event wording placeholders");
  // Regression guard (2026-07-11 audit): "birthday" was long treated as a phantom card
  // because the June audit found no matching governance policy — but the real bug was a
  // module-name mismatch (governance said "birthdays", every real send uses singular
  // "birthday"), not the absence of a caller. birthday now has both a fixed governance
  // entry and a real card. anniversary/payslip remain genuine phantoms: no code anywhere
  // sends a notification for either.
  assert.match(service, /templateKey: "birthday"/, "birthday has a real live caller (app/api/notifications/birthdays/route.ts) and must have a card");
  assert.doesNotMatch(service, /templateKey: "anniversary"/);
  assert.doesNotMatch(service, /payslip_available/);
  // Coverage added by the same audit: real live senders that previously fell back to
  // hard-coded wording because no admin-editable card existed for their module.
  for (const key of ["excuse", "recruitment", "internal_messages", "support_requests", "attendance", "field_workforce_compliance", "holiday_confirmation"]) {
    assert.match(service, new RegExp(`templateKey: "${key}"`), `${key} must have a Telegram template card`);
  }
  assert.match(service, /recipientName/);
  assert.match(service, /requesterName/);
  assert.match(service, /department/);
  assert.match(service, /approvalStep/);
  assert.match(service, /requestId/);
  assert.match(service, /renderTelegramTemplateText\(cleanText\(row\.title_template\)/, "Telegram titles must support safe placeholders too");
  assert.match(service, /\.from\("notification_templates"\)/, "Telegram templates must use the central notification template table");
  assert.match(service, /channel: "telegram"/, "Telegram templates must be channel-specific");
  assert.match(service, /metadata:[\s\S]*buttons,[\s\S]*cta:/, "Button config must be stored in template metadata, not mixed into message body");
  assert.match(service, /renderTelegramCtaUrl/);
  assert.match(service, /validateTelegramTemplateButtons/);
  assert.match(service, /row\.is_active !== true/, "business render must fail safely for inactive templates");
  assert.match(service, /throw new TelegramTemplateError\("template_missing"/, "missing templates must fail safely");
  assert.match(service, /createSystemNotification/);
  assert.match(service, /channels: \["telegram"\]/);
  assert.match(service, /recipientUserId = actor\(access\)/, "admin preview must target signed-in admin only");
  assert.match(service, /idempotencyKey: `telegram-template-preview:\$\{definition\.templateKey\}:\$\{recipientUserId\}:/, "each template preview must create a fresh delivery attempt");
  assert.match(service, /telegram:[\s\S]*buttons: preview\.buttons[\s\S]*ctaLabel: preview\.ctaLabel[\s\S]*ctaUrl: preview\.ctaUrl/, "admin preview must include rendered button config");
  assert.match(service, /eventType: "telegram_template_preview"/);
  assert.match(service, /writeAuditLog/);
  assert.match(service, /Telegram template saved\./);
  assert.match(service, /Telegram template admin preview sent\/skipped\./);
  assert.doesNotMatch(service, /salary|deduction|amount|compensation/i, "Telegram template defaults must not expose sensitive payroll/offer values");
  assert.match(placeholders, /extractTelegramPlaceholders/);
  assert.match(placeholders, /HTML is not allowed/);
  assert.match(placeholders, /validateTelegramCta/);
  assert.match(placeholders, /validateTelegramTemplateButtons/);
  assert.match(placeholders, /approvalLabelAllowedInPhoenix/);
  assert.match(placeholders, /Telegram action buttons cannot approve or reject unless they open a Phoenix confirmation page/);
  assert.match(placeholders, /isSafeTelegramCtaUrl/);

  assert.match(telegramAdapter, /buttons\?: Array<\{ label: string; url: string \}> \| null/);
  assert.match(telegramAdapter, /ctaLabel\?: string \| null/);
  assert.match(telegramAdapter, /ctaUrl\?: string \| null/);
  assert.match(telegramAdapter, /inline_keyboard: actionButtons\.buttons\.map/, "Telegram adapter must send safe buttons as inline keyboard");
  assert.match(centralTemplates, /select\("title_template,message_template,is_active,metadata,event_type"\)/, "central renderer must load Telegram template metadata");
  assert.match(centralTemplates, /\.in\("event_type", \[input\.eventType, "\*"\]\)/, "central renderer must match module-wide templates");

  // Executable coverage for the selection contract (exact beats "*", inactive never wins).
  const exactRow = { event_type: "plan_submitted", is_active: true, title_template: "exact" };
  const starRow = { event_type: "*", is_active: true, title_template: "star" };
  const inactiveExact = { event_type: "plan_submitted", is_active: false, title_template: "off" };
  assert.equal(selectTemplateRow([starRow, exactRow], "plan_submitted"), exactRow, "exact active row must win over the module-wide row");
  assert.equal(selectTemplateRow([inactiveExact, starRow], "plan_submitted"), starRow, "inactive exact rows must yield to the active module-wide row");
  assert.equal(selectTemplateRow([starRow], "plan_manager_approved"), starRow, "any event of the module must match the module-wide row");
  assert.equal(selectTemplateRow([inactiveExact], "plan_submitted"), null, "all-inactive must fall back to hardcoded wording");

  // {{title}}/{{message}} always mean the channel-composed wording - metadata keys with
  // those names (e.g. probation reminders) must not shadow them.
  assert.match(centralTemplates, /if \(key === "title" \|\| key === "message"\) return cleanText\(direct\[key\]\);/, "content placeholders must resolve from the composed fallbacks");
  // A broken saved button must degrade to a buttonless send, never skip the delivery.
  assert.match(centralTemplates, /degraded to buttonless/, "telegram action rendering must degrade instead of throwing");
  // The quiet-hours deferral mirrors the live branch's skip semantics on template errors.
  assert.match(system, /Mirror the live branch: a broken saved template/, "quiet-hours deferral must not reject the notification on template errors");
  // genericOnly governance must strip the title and buttons, not just the message.
  assert.match(system, /GENERIC_NOTIFICATION_TITLE/, "generic-only sends must genericize the title too");
  // Save-time dry-render rejects button URLs that could not render on live sends.
  assert.match(service, /Dry-render every enabled button\/CTA URL/, "saves must dry-render button URLs");
  // Legacy per-event rows must not prefill (or be re-scoped into) module-wide cards.
  assert.match(service, /const stale = Boolean\(savedRow\)/, "stale per-event rows must surface defaults, not legacy wording");
  assert.match(centralTemplates, /validateTelegramTemplateButtons/, "central renderer must validate editable Telegram buttons");
  assert.match(centralTemplates, /renderTelegramCtaUrl/, "central renderer must render safe Telegram button URLs");
  assert.match(centralTemplates, /throw new TelegramTemplateError\("invalid_buttons"/, "invalid template buttons must fail safely before Telegram send");
  assert.match(system, /telegram\?:[\s\S]*buttons\?: Array<\{ label: string; url: string \}> \| null[\s\S]*ctaLabel\?: string \| null[\s\S]*ctaUrl\?: string \| null/);
  assert.match(system, /sendTelegramNotification\({[\s\S]*buttons: genericTelegram \? null : input\.telegram\?\.buttons \?\? telegramContent\.buttons \?\? null/, "central engine must pass rendered template buttons to Telegram adapter (generic-only strips them)");
  assert.match(system, /error instanceof TelegramTemplateError/, "invalid Telegram templates must skip Telegram without failing the whole notification");
  assert.match(system, /skippedBy: "telegram_template_governance"/, "Telegram template skips must be auditable");

  assert.match(route, /assertPermission\(access, "communication", action\)/);
  assert.match(route, /body\?\.action === "preview"/);
  assert.match(route, /body\?\.action === "send_admin_preview"/);
  assert.match(route, /sendTelegramTemplateAdminPreview\(access/);
  assert.doesNotMatch(route, /recipientUserId|hrId|employeeId/, "route must not accept arbitrary preview recipients");
  assert.doesNotMatch(route, /approve|reject/i, "Telegram template route must not introduce Telegram approvals");

  assert.match(page, /canAccess\(access, "communication", "read"\)/);
  assert.match(page, /TelegramTemplateManager/);
  assert.match(component, /textarea/);
  assert.match(component, /Available placeholders/);
  assert.match(component, /Smart Action Buttons/);
  assert.match(component, /Smart Button Preview/);
  assert.match(component, /Add View Details/);
  assert.match(component, /Approve and Reject buttons are intentionally blocked/);
  assert.match(component, /Recommended placeholders/);
  assert.match(component, /qualityScore/);
  assert.match(component, /Reset to Default/);
  assert.match(component, /insertTelegramPlaceholder/);
  assert.match(component, /insertTitlePlaceholder/);
  assert.match(component, /buttonUrlRefs/);
  assert.match(component, /placeholderDragType/);
  assert.match(component, /startPlaceholderDrag/);
  assert.match(component, /dropMessagePlaceholder/);
  assert.match(component, /dropTitlePlaceholder/);
  assert.match(component, /dropButtonPlaceholder/);
  assert.match(component, /draggable=\{canUpdate\}/);
  assert.match(component, /Live preview/);
  assert.match(component, /Send Admin-Only Preview/);
  assert.match(component, /Global Telegram OFF still blocks Telegram delivery/);
  assert.doesNotMatch(component, /contentEditable|dangerouslySetInnerHTML|rich text/i, "UI must remain plain text, not HTML editor based");

  assert.match(accessRegistry, /pattern: "\/api\/admin\/notifications\/telegram\/templates"[\s\S]*resource: "communication", action: "read"/);
  assert.match(accessRegistry, /pattern: "\/api\/admin\/notifications\/telegram\/templates"[\s\S]*resource: "communication", action: "update"/);
  assert.match(navigation, /href: "\/admin\/notifications\/telegram\/templates"/);
}
