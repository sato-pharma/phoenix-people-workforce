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

  // --- Offer consolidated onto a template ------------------------------------------
  const emailSource = readFileSync("src/lib/notifications/email.ts", "utf8");
  assert.match(
    emailSource,
    /notificationType === "offer"\) return EMAIL_TEMPLATE_KEYS\.GENERAL/,
    "offer status notifications must render via the GENERAL template",
  );

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
  assert.match(envExample, /NOTIFICATION_EMAIL_FROM=Phoenix Workforce <phoenix@mail\.satopharma\.com>/, "From must match the in-code identity");

  // --- External scheduler ----------------------------------------------------------
  const processRoute = readFileSync("app/api/notifications/process/route.ts", "utf8");
  assert.match(processRoute, /searchParams\.get\("limit"\)/, "the drain route must accept a limit param");
  const workflow = readFileSync(".github/workflows/notification-drain.yml", "utf8");
  assert.match(workflow, /cron:\s*"\*\/5 \* \* \* \*"/, "scheduler must run every ~5 minutes");
  assert.match(workflow, /Bearer \$\{CRON_SECRET\}/, "scheduler must authenticate with CRON_SECRET");
  assert.match(workflow, /\/api\/notifications\/process/, "scheduler must hit the process route");
  assert.match(workflow, /cancel-in-progress: false/, "in-flight drains must not be cancelled");
}
