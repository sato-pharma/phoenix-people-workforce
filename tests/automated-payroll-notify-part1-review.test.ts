import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Guards the owner-requested Part 1 review email (2026-07-26): "an email to
 * adel.elsayed & ahmed.elmaraghy cc anwar.gaweesh that the hr have submitted
 * the july payroll part 1 pending ur review". Real HR_IDs resolved live from
 * production: OF-0002 (Adel El Sayed, Financial Advisor), B-185 (Ahmed El
 * Maraghy, Admin Manager), AA (Anwar Gaweesh, CEO).
 *
 * notifyPart1SubmittedForReview calls createSystemNotification (external
 * Supabase + email provider), so this is a source-scan test rather than a
 * live-send assertion — pinning the exact To/Cc HR_IDs, the module/channel
 * shape, and the authorizedRecipient bypass so a future refactor can't
 * silently drop a recipient or reintroduce the same governance-skip bug
 * automated-payroll-notify-governance.test.ts guards in fanOut().
 */
export function runAutomatedPayrollNotifyPart1ReviewTests() {
  const notifySource = readFileSync(new URL("../src/lib/automated-payroll/notify.ts", import.meta.url), "utf8");

  assert.ok(
    notifySource.includes(`const PART1_REVIEW_TO_HR_IDS = ["OF-0002", "B-185"] as const;`),
    "To list must be exactly Adel El Sayed (OF-0002) and Ahmed El Maraghy (B-185)",
  );
  assert.ok(
    notifySource.includes(`const PART1_REVIEW_CC_HR_ID = "AA";`),
    "Cc must be Anwar Gaweesh (AA)",
  );

  const fnStart = notifySource.indexOf("export async function notifyPart1SubmittedForReview");
  assert.ok(fnStart >= 0, "notifyPart1SubmittedForReview must be exported from notify.ts");
  const fnBody = notifySource.slice(fnStart, notifySource.indexOf("/** Part 2 confirmed", fnStart));

  assert.ok(fnBody.includes('module: "payroll"'), "must stay in the payroll module");
  assert.ok(fnBody.includes('channels: ["email"]'), "this is an email-only notification, not a milestone fan-out");
  assert.ok(fnBody.includes("authorizedRecipient: true"), "must set the sanctioned explicit-recipient bypass");
  assert.ok(fnBody.includes("recipients,"), "must pass the resolved To addresses via email.recipients");
  assert.ok(fnBody.includes("cc: ccEmail"), "must pass the resolved Cc address via email.cc");

  const runServiceSource = readFileSync(new URL("../src/lib/automated-payroll/run-service.ts", import.meta.url), "utf8");
  assert.ok(
    runServiceSource.includes("notifyPart1SubmittedForReview"),
    "confirmPart1 must call notifyPart1SubmittedForReview alongside notifyPart1Ready",
  );
  const confirmStart = runServiceSource.indexOf("export async function confirmPart1");
  assert.ok(confirmStart >= 0, "confirmPart1 must exist in run-service.ts");
  const confirmBody = runServiceSource.slice(confirmStart, confirmStart + 2000);
  assert.ok(
    confirmBody.includes("await notifyPart1Ready(updated);") && confirmBody.includes("await notifyPart1SubmittedForReview(updated);"),
    "both notifications must fire on Part 1 confirm, additive to each other",
  );
}
