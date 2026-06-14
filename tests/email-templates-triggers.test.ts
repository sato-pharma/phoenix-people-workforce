import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { bidiIsolate } from "@/emails/bidi.ts";

/**
 * Phase 3/4 — templates, triggers, bidi rendering, scheduler.
 */
export function runEmailTemplatesTriggersTests() {
  // --- Behavioral: bidi isolation --------------------------------------------------
  assert.equal(bidiIsolate("abc"), "⁨abc⁩", "bidiIsolate wraps in FSI…PDI");
  // An Arabic name stays intact and isolated (so surrounding LTR text is not reordered).
  const arabic = "محمد";
  assert.equal(bidiIsolate(arabic), `⁨${arabic}⁩`);

  // --- Bidi-safe rendering (layout) ------------------------------------------------
  assert.match(readFileSync("src/emails/bidi.ts", "utf8"), /export function bidiIsolate/, "bidiIsolate must be exported");
  const layout = readFileSync("src/emails/phoenix-email-layout.tsx", "utf8");
  assert.match(layout, /function escapeAndIsolate/, "escapeAndIsolate helper must exist");
  assert.match(layout, /<html lang="en">/, "html must declare a language");
  assert.match(layout, /unicode-bidi:isolate/, "the metadata value cell must isolate direction");
  assert.match(layout, /escapeAndIsolate\(input\.title\)/, "title must be bidi-isolated");
  assert.match(layout, /escapeAndIsolate\(row\.value\)/, "metadata values must be bidi-isolated");

  // --- Offer status on its own editable template ------------------------------------
  const emailSource = readFileSync("src/lib/notifications/email.ts", "utf8");
  assert.match(
    emailSource,
    /notificationType === "offer"\)[\s\S]{0,260}EMAIL_TEMPLATE_KEYS\.OFFER_STATUS/,
    "offer status notifications must render via the dedicated Offer Status template",
  );
  // External candidates have no Phoenix login: candidate-addressed offer/recruitment
  // sends must stay on the audience-neutral GENERAL template.
  assert.match(
    emailSource,
    /notificationType === "offer"\)[\s\S]{0,260}input\.candidateEmail[\s\S]{0,120}EMAIL_TEMPLATE_KEYS\.GENERAL/,
    "candidate-addressed offer emails must stay on GENERAL",
  );
  assert.match(
    emailSource,
    /moduleLabel === "recruitment"[\s\S]{0,420}input\.candidateEmail[\s\S]{0,160}EMAIL_TEMPLATE_KEYS\.GENERAL/,
    "candidate-addressed recruitment emails must stay on GENERAL",
  );
  // Every business module must route to a dedicated /admin/email-templates key —
  // GENERAL is reserved for genuinely generic system notices.
  for (const expectation of [
    ["marketing requests", "MARKETING_REQUEST"],
    ["excuse", "EXCUSE_REQUEST"],
    ["coaching", "COACHING_REPORT"],
    ["payroll", "PAYROLL_UPDATE"],
    ["recruitment", "RECRUITMENT_UPDATE"],
  ] as const) {
    assert.match(
      emailSource,
      new RegExp(`moduleLabel === "${expectation[0]}"[\\s\\S]{0,420}EMAIL_TEMPLATE_KEYS\\.${expectation[1]}`),
      `${expectation[0]} module emails must render via ${expectation[1]}`,
    );
  }
  // Domains may pin a template explicitly; unknown keys must fall through, not drop mail.
  assert.match(emailSource, /input\.templateKey/, "the hub must honor an explicit per-send templateKey");

  // --- Vacation manager-stage email wired (dead code removed) ----------------------
  const vacationSource = readFileSync("src/lib/vacation/service.ts", "utf8");
  assert.doesNotMatch(vacationSource, /void dispatchVacationManagerReview/, "the dead `void` must be gone");
  assert.match(
    vacationSource,
    /await dispatchVacationManagerReview\(\{/,
    "the manager-stage hand-off email must actually be dispatched",
  );

  // --- Loud template history -------------------------------------------------------
  const templateService = readFileSync("src/lib/email-templates/service.ts", "utf8");
  assert.match(templateService, /Email template history (not recorded|insert skipped)/, "history swallow must be observable");

  // --- From-name consistency -------------------------------------------------------
  const envExample = readFileSync(".env.example", "utf8");
  assert.doesNotMatch(envExample, /noreply@yourdomain/, "the misleading noreply placeholder must be gone");
  assert.match(envExample, /NOTIFICATION_EMAIL_FROM=Phoenix Workforce <phoenix@send\.satopharma\.com>/, "From must match the in-code identity");

  // --- External scheduler ----------------------------------------------------------
  const processRoute = readFileSync("app/api/notifications/process/route.ts", "utf8");
  assert.match(processRoute, /searchParams\.get\("limit"\)/, "the drain route must accept a limit param");
  const workflow = readFileSync(".github/workflows/notification-drain.yml", "utf8");
  assert.match(workflow, /cron:\s*"\*\/30 \* \* \* \*"/, "scheduler must run every ~30 minutes (kept within the Actions minute budget)");
  assert.match(workflow, /Bearer \$\{CRON_SECRET\}/, "scheduler must authenticate with CRON_SECRET");
  assert.match(workflow, /\/api\/notifications\/process/, "scheduler must hit the process route");
  assert.match(workflow, /cancel-in-progress: false/, "in-flight drains must not be cancelled");
}
