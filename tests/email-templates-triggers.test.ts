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
    ["attendance", "ATTENDANCE_WORKFLOW"],
  ] as const) {
    assert.match(
      emailSource,
      new RegExp(`moduleLabel === "${expectation[0]}"[\\s\\S]{0,700}EMAIL_TEMPLATE_KEYS\\.${expectation[1]}`),
      `${expectation[0]} module emails must render via ${expectation[1]}`,
    );
  }
  // Domains may pin a template explicitly; unknown keys must fall through, not drop mail.
  assert.match(emailSource, /input\.templateKey/, "the hub must honor an explicit per-send templateKey");

  // --- Candidate-audience gate must actually receive candidateEmail ----------------
  // Regression guard: migratedTemplateKeyForNotification's candidate gate (above) is only
  // effective if createSystemNotification actually plumbs `email.candidateEmail` through to
  // the NotificationEmailInput it builds. It previously did not — every candidate-addressed
  // offer/recruitment send routed through createSystemNotification (offer accepted/rejected
  // confirmations, interview cancellation notices) silently landed on the STAFF template
  // (OFFER_STATUS / RECRUITMENT_UPDATE) instead of GENERAL, because the gate always saw
  // candidateEmail as undefined.
  const systemSource = readFileSync("src/lib/notifications/system.ts", "utf8");
  assert.match(
    systemSource,
    /candidateEmail:\s*input\.email\?\.candidateEmail/,
    "buildChannelEmailInput must copy email.candidateEmail through so the candidate-audience gate can see it",
  );

  // --- Vacation manager-stage email wired (dead code removed) ----------------------
  const vacationSource = readFileSync("src/lib/vacation/service.ts", "utf8");
  assert.doesNotMatch(vacationSource, /void dispatchVacationManagerReview/, "the dead `void` must be gone");
  assert.match(
    vacationSource,
    /task:\s*\(\)\s*=>\s*dispatchVacationManagerReview\(\{/,
    "the manager-stage hand-off email must actually be dispatched (inside deferVacationNotice, after the reply)",
  );

  // --- Loud template history -------------------------------------------------------
  const templateService = readFileSync("src/lib/email-templates/service.ts", "utf8");
  assert.match(templateService, /Email template history (not recorded|insert skipped)/, "history swallow must be observable");

  // --- From-name consistency -------------------------------------------------------
  const envExample = readFileSync(".env.example", "utf8");
  assert.doesNotMatch(envExample, /noreply@yourdomain/, "the misleading noreply placeholder must be gone");
  assert.match(envExample, /NOTIFICATION_EMAIL_FROM=Phoenix Workforce <phoenix@send\.satopharma\.com>/, "From must match the in-code identity");

  // --- Sub-daily drain scheduler (Vercel cron, not GitHub Actions) -----------------
  // The drain runs as a Vercel cron so it does not consume GitHub Actions minutes.
  // Vercel auto-attaches the CRON_SECRET bearer; the route enforces it.
  const processRoute = readFileSync("app/api/notifications/process/route.ts", "utf8");
  assert.match(processRoute, /searchParams\.get\("limit"\)/, "the drain route must accept a limit param");
  // Pinned to the CONSTANT-TIME form on purpose. This assertion used to require the literal
  // `authorization") === `Bearer ${secret}`` — a plain string compare, which short-circuits on the
  // first wrong byte and so leaks how much of the secret's prefix was right. The route now uses
  // bearerSecretMatches (src/lib/security/constant-time.ts, timingSafeEqual). Matching the new
  // call keeps the original intent — the drain route must authenticate cron via CRON_SECRET —
  // while also making a silent regression back to `===` fail here.
  //
  // Repointed 2026-08-29 (A2). The comparison moved one level down: the route now calls
  // assertCronAuthorized, which calls bearerSecretMatches. The `===` regression this line was
  // written to catch is now caught at the source by tests/cron-auth-single-guard.test.ts, which
  // fails if ANY route under app/api compares a secret itself. What stays here is this route's
  // own half — that the drain is guarded, under its own job slug.
  assert.match(
    processRoute,
    /assertCronAuthorized\(request, "notifications\/process"/,
    "the drain route must authenticate cron via CRON_SECRET, compared in constant time",
  );
  
}
