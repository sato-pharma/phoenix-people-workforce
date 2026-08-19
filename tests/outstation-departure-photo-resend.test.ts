import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { outstationDeparturePhotoReminderDue } from "../src/lib/outstation/expense-gate.ts";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

/** Slice one function body so an assertion is scoped to it, not to the whole 5k-line service. */
function functionSlice(src: string, declaration: string) {
  const start = src.indexOf(declaration);
  assert.notEqual(start, -1, `expected to find ${declaration}`);
  const rest = src.slice(start + declaration.length);
  const nextExport = rest.indexOf("\nexport ");
  const nextFn = rest.indexOf("\nasync function ");
  const ends = [nextExport, nextFn].filter((index) => index !== -1);
  return rest.slice(0, ends.length > 0 ? Math.min(...ends) : rest.length);
}

/**
 * The by-hand resend of the departure-photo reminder.
 *
 * It exists because delivery dedupe is deliberately unrepeatable. `claimDelivery` upserts the
 * idempotency key with `ignoreDuplicates`, so the FIRST attempt claims it and every later attempt
 * on that key is skipped — whether or not the first one actually reached anybody. That property is
 * what stops a retro-blast when this code is repaired, and it is also what silenced eight real
 * reminders before 2026-08-19: the key was claimed, the email was then refused by the identity
 * guard, and no re-run of the daily job could ever ask again. The only way out is a NEW key.
 *
 * So this action is a loaded one — it is the single place in the system that can deliberately step
 * around dedupe and put mail in front of an employee on demand. Everything below is about keeping
 * that narrow:
 *
 *   - it may only be pressed by someone who could already approve the money;
 *   - it may only be pointed at a request actually held on its departure photo;
 *   - it obeys the same timing rule as the automatic reminder, so it cannot nag mid-trip;
 *   - it writes the same words the system writes, with no admin-supplied text;
 *   - and its fresh key is dated in CAIRO, so "once a day" means once a day.
 */
export function runOutstationDeparturePhotoResendTests() {
  const service = source("src/lib/outstation/service.ts");
  const resendSlice = functionSlice(
    service,
    "export async function resendOutstationDeparturePhotoReminder",
  );
  const sendSlice = functionSlice(
    service,
    "export async function sendOutstationDeparturePhotoReminder",
  );

  // ── The automatic key stays the default ──────────────────────────────────────────
  // This is the retro-blast guard and it is the most important line in the change. The daily job
  // and the submit path pass no options, so they must still land on the undated, two-per-request
  // key. If the override ever became unconditional, the next deploy would mail every employee who
  // has ever been held behind a photo.
  assert.match(
    sendSlice,
    /options\?\.idempotencyKey \?\?\s*`outstation:\$\{String\(row\.id\)\}:departure-photo:\$\{overdue \? "overdue" : "due"\}`/,
    "the caller-supplied key must be an OVERRIDE with the automatic key as the fallback — an unconditional override re-sends every historic reminder the moment it ships",
  );
  // `idempotencyKey?:` (the option's type) and `options?.idempotencyKey` (the read) carry no colon
  // after the name, so this counts only the places a key is actually SET. There must be one.
  assert.equal(
    (sendSlice.match(/idempotencyKey:/g) ?? []).length,
    1,
    "exactly one place in the sender sets a key — a second is a second dedupe identity for the same message, and the two would not deduplicate against each other",
  );

  // ── The resend mints a NEW key, dated, in Cairo ──────────────────────────────────
  assert.match(
    resendSlice,
    /idempotencyKey: `outstation:\$\{String\(requestId\)\}:departure-photo:resend-\$\{today\}`/,
    "the resend must supply its own key — re-running the automatic one is deduplicated into silence, which is the whole failure this action exists to escape",
  );
  assert.match(
    resendSlice,
    /const today = cairoTodayIso\(\)/,
    "the date in that key must be the CAIRO date. On UTC the day rolls at 02:00 Cairo, so a button pressed at 02:30 would send a second copy of a reminder sent hours earlier the same evening",
  );
  // Dated, therefore repeatable tomorrow and not today. Both halves are intended, and both are
  // stated to the admin in the returned message rather than left to be discovered.
  assert.match(
    resendSlice,
    /Pressing this again today will not send a second copy/,
    "the admin must be told the button is idempotent for the day — otherwise a message that appears not to have arrived gets pressed repeatedly",
  );

  // ── Approve-level access, not read ───────────────────────────────────────────────
  // The CEO is an execution-only outstation role: he can see the held list, and he must not be
  // able to send mail to an employee in the owner's name. `"read"` here would hand him exactly
  // that, and nothing else in the stack would stop it — the route delegates this check entirely.
  assert.match(
    resendSlice,
    /await assertOutstationAdminAccess\(access, "approve"\)/,
    "the resend sits at approve level, alongside the waiver — a read-level check would let the read-only finance roles mail employees",
  );
  assert.ok(
    resendSlice.indexOf('assertOutstationAdminAccess(access, "approve")') <
      resendSlice.indexOf("getOutstationRequestById"),
    "and it must be asserted BEFORE the request is read, so an unauthorised caller cannot use this endpoint to probe which request ids exist",
  );

  // ── It reuses the system's own reminder, and composes nothing ────────────────────
  // One wording and one timing rule. If this ever built its own notification it would become a
  // way to message an employee freely, and it would drift from what the daily job says.
  assert.match(
    resendSlice,
    /await sendOutstationDeparturePhotoReminder\(request, today, \{/,
    "the resend must delegate to the shared sender rather than raising its own notification",
  );
  assert.equal(
    /createSystemNotificationForRecipients/.test(resendSlice),
    false,
    "it must never build a notification of its own — that is how an admin action turns into an open mail channel",
  );

  // ── It cannot be pointed at somebody who owes nothing ────────────────────────────
  // The sender returns false rather than throwing when nothing is due, so a resend that ignored
  // the return value would report success while sending nothing at all.
  assert.match(
    resendSlice,
    /if \(!sent\) \{/,
    "a false return must be handled — the sender says 'not due' by returning false, never by throwing",
  );
  assert.match(
    resendSlice,
    /if \(gate\.blocker !== "departure_photo"\) \{/,
    "the refusal must distinguish 'this row owes no photo' from 'the trip is still running' — they need different answers from the admin",
  );
  assert.match(
    resendSlice,
    /not waiting on its departure photo/,
    "…and say the first one in words the admin can act on",
  );
  assert.match(
    resendSlice,
    /The trip has not finished yet/,
    "…and the second, which is not a fault at all — the photo is simply not due until he leaves",
  );

  // The timing rule those refusals rest on is the same pure function the automatic reminder uses,
  // so an admin pressing the button on day one of a five-day trip sends nothing.
  assert.deepEqual(
    outstationDeparturePhotoReminderDue({
      gateBlocker: "departure_photo",
      todayCairo: "2026-08-19",
      tripEndDate: "2026-08-23",
    }),
    { due: false, overdue: false },
    "a running trip is not due — the button must not become a way to nag an employee before he could act",
  );
  assert.deepEqual(
    outstationDeparturePhotoReminderDue({
      gateBlocker: "workload",
      todayCairo: "2026-08-19",
      tripEndDate: "2026-08-01",
    }),
    { due: false, overdue: false },
    "a request held on the CRM workload is not a photo problem, however long ago the trip ended",
  );

  // ── The send is on the record ────────────────────────────────────────────────────
  // A by-hand message to an employee, sent by an administrator, with no trace of who sent it is
  // exactly the kind of action an audit log exists for.
  assert.match(
    resendSlice,
    /await writeRequiredAuditLog\(\{/,
    "a by-hand send must be audited — this is a human deciding to mail an employee, not a scheduled job",
  );
  assert.match(
    resendSlice,
    /entityType: "outstation_request"/,
    "and filed against the request, so it appears on that request's history rather than only in a global feed",
  );
  assert.ok(
    resendSlice.indexOf("writeRequiredAuditLog") > resendSlice.indexOf("if (!sent) {"),
    "the audit row is written only after a send actually happened — logging a refusal as a send is how a history stops being evidence",
  );

  // ── The route ────────────────────────────────────────────────────────────────────
  const route = source("app/api/admin/outstation/[id]/reminder/route.ts");
  assert.match(
    route,
    /const csrfError = assertSameOriginMutation\(request\);/,
    "a POST that sends mail must be same-origin — without it any page on the internet can make an admin's browser fire reminders",
  );
  assert.match(
    route,
    /await resendOutstationDeparturePhotoReminder\(id, access\)/,
    "the route hands off to the domain service",
  );
  // No body is read at all. There is nothing to vary, and nothing an administrator types reaches
  // the employee — which is what keeps this from being a free-text message channel.
  assert.equal(
    /request\.json\(\)/.test(route),
    false,
    "the route must take no body — an accepted field is a field that will eventually carry admin-supplied text into an employee's inbox",
  );
  assert.equal(
    /canUseAdminOutstationWorkspace|assertPermission/.test(route),
    false,
    "the route must not re-implement the access check — two copies of an authority rule drift, and the domain one is the enforced one",
  );
  assert.match(
    route,
    /if \(!Number\.isFinite\(id\)\)/,
    "a non-numeric id is refused before it reaches the service",
  );
  assert.match(
    route,
    /if \(message\.includes\("not waiting on its departure photo"\) \|\| message\.includes\("has not finished yet"\)\)\s*\{\s*return 409;/,
    "the two refusals are 409, not 500 — they are correct answers about the wrong row, and a 500 tells the admin the system is broken when it is working",
  );
  assert.match(
    route,
    /if \(isForbiddenError\(error\)\) return 403;/,
    "and a forbidden caller gets 403",
  );

  // ── The button ───────────────────────────────────────────────────────────────────
  const panel = source("src/components/outstation/held-requests-panel.tsx").replace(/\s+/g, " ");
  assert.ok(
    panel.includes('{request.blocker === "departure_photo" ? ('),
    "the button appears only on a row actually held on the departure photo — offering it elsewhere invites a 409 the admin cannot do anything about",
  );
  assert.ok(
    panel.includes('void act(request.id, {}, "reminder")'),
    "it posts an empty body to the reminder endpoint",
  );
  assert.ok(
    panel.includes('endpoint: "workload" | "evidence" | "reminder" = "workload"'),
    "the shared action helper must keep defaulting to workload — a new endpoint may not silently redirect the two buttons that already existed",
  );
  assert.ok(
    panel.includes("disabled={busyId === request.id}"),
    "and it must disable while in flight, or an impatient double-press becomes two requests",
  );
}
