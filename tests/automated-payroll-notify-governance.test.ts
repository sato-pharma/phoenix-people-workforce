import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Guards a real, previously-silent bug (owner-reported 2026-07-26): every
 * Automated Payroll milestone notification (Part 1 ready, Part 2 ready,
 * published) was skipped on EVERY channel (email/push/in-app) because
 * fanOut() in notify.ts calls createSystemNotification with an explicit
 * recipientHrId for the "payroll" module without opting into
 * metadata.authorizedRecipient — src/lib/notifications/system.ts's
 * explicitRecipientAllowed() requires that flag (or recipientHrId ===
 * subjectHrId) for any explicit-recipient send in the "payroll" module,
 * since it's also used for per-employee payslip content. fanOut() already
 * does its own trusted, role-gated recipient resolution (resolveRecipients())
 * — it isn't a payslip, there's no subject to protect — so it must set the
 * flag, exactly as system.ts's own doc comment describes for a trusted
 * server caller.
 *
 * fanOut() is not pure (it calls Supabase / external notification
 * providers), so this is a source-scan test rather than a live-send
 * assertion — pinning the literal fix so a future refactor can't silently
 * drop it and reintroduce a 100%-silent notification failure.
 */
export function runAutomatedPayrollNotifyGovernanceTests() {
  const source = readFileSync(new URL("../src/lib/automated-payroll/notify.ts", import.meta.url), "utf8");

  const fanOutBody = source.slice(source.indexOf("async function fanOut"), source.indexOf("/** Part 1 confirmed"));
  assert.ok(fanOutBody.includes("createSystemNotification("), "fanOut must still call createSystemNotification");
  assert.ok(
    fanOutBody.includes("authorizedRecipient: true"),
    "fanOut must set metadata.authorizedRecipient — without it every payroll milestone notification is silently skipped on every channel (real incident, 2026-07-26)",
  );

  // The flag must live inside the SAME metadata object passed to
  // createSystemNotification, not just appear anywhere in the function.
  const callStart = fanOutBody.indexOf("createSystemNotification({");
  const callEnd = fanOutBody.indexOf("}).catch(", callStart);
  assert.ok(callStart >= 0 && callEnd > callStart, "must find the createSystemNotification({...}) call body");
  const callBody = fanOutBody.slice(callStart, callEnd);
  assert.ok(
    callBody.includes("authorizedRecipient: true"),
    "authorizedRecipient must be set on the actual createSystemNotification call, not elsewhere in the file",
  );
}
