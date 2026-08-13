import assert from "node:assert/strict";
import { buildOutstationSubmitRouting } from "../src/lib/outstation/submit-recipients.ts";

/**
 * Owner rule (email-reduction project, 2026-08-13) for the outstation submit email envelope —
 * REPLACES the 2026-08-04 rule, which put the submitting employee on To (a self-confirmation he
 * did not need, since he was just on the submission screen):
 *   To   his direct manager                     — the person who actually needs to see it
 *   Cc   his manager's manager                   — ONLY when that person is not the CEO
 *   Bcc  every active Super Admin                — oversight, unchanged
 *   (nobody) the submitting employee — never on this email, in any slot
 *
 * Fallback when the direct manager cannot be addressed (missing, or the CEO — who is NEVER on
 * this email, in any slot, since 2026-08-08): the skip-level manager steps up to To instead of
 * sitting in Cc with the To slot empty. If neither rung of the reporting line is available, the
 * first active Super Admin is promoted from Bcc to To, so oversight is never silently dropped to
 * zero recipients.
 *
 * These are behavioural assertions against the pure decision function, not source
 * inspection: the sibling outstation-notifications.test.ts pins that service.ts CALLS this,
 * but only the cases below prove the envelope is actually right.
 */
export function runOutstationSubmitEmailRoutingTests() {
  const CEO = ["HR-CEO"];
  const ADMINS = ["HR-SA1", "HR-SA2"];

  // ── The ordinary shape: rep → DM → NSM, none of them the CEO ────────────────────
  const normal = buildOutstationSubmitRouting({
    ceoHrIds: CEO,
    employeeHrId: "HR-REP",
    managerHrId: "HR-DM",
    managerOfManagerHrId: "HR-NSM",
    superAdminHrIds: ADMINS,
  });
  assert.equal(normal.toHrId, "HR-DM", "the direct manager is the To — he is the one who needs to see it");
  assert.deepEqual(normal.ccHrIds, ["HR-NSM"], "the skip-level manager rides Cc");
  assert.deepEqual(normal.bccHrIds, ["HR-SA1", "HR-SA2"], "every active Super Admin is Bcc'd");
  assert.notEqual(normal.toHrId, "HR-REP", "the submitting employee must never be the To recipient");

  // ── The rule that prompted the 2026-08-04 change: a CEO skip-level is dropped ────
  const ceoSkipLevel = buildOutstationSubmitRouting({
    ceoHrIds: CEO,
    employeeHrId: "HR-REP",
    managerHrId: "HR-DM",
    managerOfManagerHrId: "HR-CEO",
    superAdminHrIds: ADMINS,
  });
  assert.equal(ceoSkipLevel.toHrId, "HR-DM", "the direct manager is still To even when the skip-level is the CEO");
  assert.deepEqual(
    ceoSkipLevel.ccHrIds,
    [],
    "the CEO must NOT be Cc'd as manager-of-manager — that broadcast is exactly what was removed",
  );
  assert.ok(
    !ceoSkipLevel.bccHrIds.includes("HR-CEO"),
    "dropping the CEO from Cc must not quietly re-add him on Bcc",
  );

  // ── Owner rule 2026-08-08: the CEO is NEVER on an outstation submission ──────────
  // Widened from the 2026-08-04 skip-level-only exclusion, which still copied him on every
  // submission by one of his 21 direct reports (all three NSMs, plus DMs, reps, Finance,
  // Marketing and SFE) — the same broadcast the earlier change set out to stop. When the CEO is
  // the direct manager AND there is no skip-level to fall back to, the first active Super Admin
  // is promoted into To so the submission still reaches a real person.
  const ceoIsDirectManager = buildOutstationSubmitRouting({
    ceoHrIds: CEO,
    employeeHrId: "HR-NSM",
    managerHrId: "HR-CEO",
    managerOfManagerHrId: null,
    superAdminHrIds: ADMINS,
  });
  assert.equal(
    ceoIsDirectManager.toHrId,
    "HR-SA1",
    "neither the CEO (excluded) nor a skip-level (none) is addressable, so the first Super Admin steps up to To",
  );
  assert.deepEqual(ceoIsDirectManager.ccHrIds, [], "there is still no Cc — nobody to put there");
  assert.ok(
    !ceoIsDirectManager.bccHrIds.includes("HR-CEO"),
    "the CEO must never appear on Bcc either",
  );
  assert.deepEqual(
    ceoIsDirectManager.bccHrIds,
    ["HR-SA2"],
    "the REMAINING Super Admins stay on Bcc — only the one promoted to To leaves that list",
  );

  // The real manager is still addressed when he is NOT the CEO — the exclusion is about one
  // person, not about emptying the envelope.
  const ceoIsNeitherRung = buildOutstationSubmitRouting({
    ceoHrIds: CEO,
    employeeHrId: "HR-REP",
    managerHrId: "HR-DM",
    managerOfManagerHrId: null,
    superAdminHrIds: ADMINS,
  });
  assert.equal(ceoIsNeitherRung.toHrId, "HR-DM", "a non-CEO direct manager is still addressed, now as To");
  assert.deepEqual(ceoIsNeitherRung.ccHrIds, [], "no skip-level manager was given, so Cc stays empty");

  // Even if the CEO were also granted Super Admin, he must not reappear on To or Bcc — "removed
  // from the direct-manager slot" must never silently mean "moved to a quieter header".
  const ceoIsAlsoSuperAdmin = buildOutstationSubmitRouting({
    ceoHrIds: CEO,
    employeeHrId: "HR-REP",
    managerHrId: "HR-CEO",
    managerOfManagerHrId: null,
    superAdminHrIds: ["HR-CEO", "HR-SA1"],
  });
  assert.equal(
    ceoIsAlsoSuperAdmin.toHrId,
    "HR-SA1",
    "the CEO is skipped even inside the Super Admin fallback list — HR-SA1 is promoted instead",
  );
  assert.deepEqual(ceoIsAlsoSuperAdmin.ccHrIds, [], "still no Cc");
  assert.deepEqual(
    ceoIsAlsoSuperAdmin.bccHrIds,
    [],
    "a CEO who is also a Super Admin is still off the email entirely, not silently Bcc'd",
  );

  // ── One person, one slot: the most visible slot wins ─────────────────────────────
  const adminIsManager = buildOutstationSubmitRouting({
    ceoHrIds: CEO,
    employeeHrId: "HR-REP",
    managerHrId: "HR-SA1",
    managerOfManagerHrId: null,
    superAdminHrIds: ADMINS,
  });
  assert.equal(adminIsManager.toHrId, "HR-SA1", "a Super Admin who manages the employee is addressed openly as To");
  assert.deepEqual(
    adminIsManager.bccHrIds,
    ["HR-SA2"],
    "and is NOT also Bcc'd — one mailbox must never appear in two headers of one message",
  );

  // An employee who is his own manager has no real manager to address at all — the fallback
  // chain moves past him (he is excluded, being the employee) to the next Super Admin.
  const selfManaged = buildOutstationSubmitRouting({
    ceoHrIds: CEO,
    employeeHrId: "HR-SA1",
    managerHrId: "HR-SA1",
    managerOfManagerHrId: null,
    superAdminHrIds: ["HR-SA1", "HR-SA2"],
  });
  assert.equal(
    selfManaged.toHrId,
    "HR-SA2",
    "an employee who is his own manager yields no usable manager, so the next Super Admin steps up to To",
  );
  assert.deepEqual(selfManaged.ccHrIds, [], "no skip-level manager either");
  assert.deepEqual(selfManaged.bccHrIds, [], "he is not Bcc'd on his own mail either, even though he is a Super Admin");

  // The employee himself must never appear in Bcc even when he is a Super Admin and someone else
  // is properly addressed as To — exclusion is about the person, not about which slot is open.
  const employeeIsSuperAdmin = buildOutstationSubmitRouting({
    ceoHrIds: CEO,
    employeeHrId: "HR-SA1",
    managerHrId: "HR-DM",
    managerOfManagerHrId: null,
    superAdminHrIds: ["HR-SA1", "HR-SA2"],
  });
  assert.equal(employeeIsSuperAdmin.toHrId, "HR-DM", "the real manager is still To");
  assert.deepEqual(
    employeeIsSuperAdmin.bccHrIds,
    ["HR-SA2"],
    "the employee is excluded from his own oversight Bcc copy even though he is a Super Admin",
  );

  // ── HR IDs differing only by case/whitespace are the same person ─────────────────
  const messyIds = buildOutstationSubmitRouting({
    ceoHrIds: [" hr-ceo "],
    employeeHrId: "hr-rep",
    managerHrId: "HR-DM",
    managerOfManagerHrId: "Hr-Ceo",
    superAdminHrIds: ["hr-dm", "HR-SA1"],
  });
  assert.equal(messyIds.toHrId, "HR-DM", "the direct manager is To regardless of casing elsewhere in the input");
  assert.deepEqual(
    messyIds.ccHrIds,
    [],
    "the CEO exclusion must survive case/whitespace differences, or the broadcast silently returns",
  );
  assert.deepEqual(
    messyIds.bccHrIds,
    ["HR-SA1"],
    "a Super Admin already addressed as To under different casing must not be Bcc'd as if he were someone else",
  );

  // ── Degraded inputs must fail closed, never mail a partial envelope ──────────────
  const noEmployee = buildOutstationSubmitRouting({
    ceoHrIds: CEO,
    employeeHrId: null,
    managerHrId: "HR-DM",
    managerOfManagerHrId: "HR-NSM",
    superAdminHrIds: ADMINS,
  });
  assert.equal(noEmployee.toHrId, null, "an unidentifiable submitter yields no To…");
  assert.deepEqual(noEmployee.ccHrIds, [], "…and no Cc — nobody is mailed about an unattributed submission");
  assert.deepEqual(noEmployee.bccHrIds, [], "…and no Bcc either");

  // Missing reporting line, but Super Admins exist — oversight still reaches someone.
  const noChain = buildOutstationSubmitRouting({
    ceoHrIds: CEO,
    employeeHrId: "HR-REP",
    managerHrId: null,
    managerOfManagerHrId: null,
    superAdminHrIds: ADMINS,
  });
  assert.equal(
    noChain.toHrId,
    "HR-SA1",
    "a missing reporting line falls all the way through to the first Super Admin, not to nobody",
  );
  assert.deepEqual(noChain.ccHrIds, [], "with nobody invented to fill the Cc slot");
  assert.deepEqual(noChain.bccHrIds, ["HR-SA2"], "the remaining Super Admin still gets the oversight copy");

  // A skip-level with no direct manager between them steps into To directly — it must not sit in
  // an empty Cc while nobody is addressed, and it must not be dropped for lack of a direct manager.
  const skipOnly = buildOutstationSubmitRouting({
    ceoHrIds: CEO,
    employeeHrId: "HR-REP",
    managerHrId: null,
    managerOfManagerHrId: "HR-NSM",
    superAdminHrIds: [],
  });
  assert.equal(
    skipOnly.toHrId,
    "HR-NSM",
    "a skip-level manager steps up to To when the direct manager is missing, rather than riding an empty-To Cc",
  );
  assert.deepEqual(skipOnly.ccHrIds, [], "the skip-level occupies To, not Cc, so Cc is empty");
  assert.deepEqual(skipOnly.bccHrIds, [], "no Super Admins were given");

  // Genuinely nobody available anywhere — the only case that yields a fully empty envelope for a
  // real (non-null) employee.
  const nobodyAvailable = buildOutstationSubmitRouting({
    ceoHrIds: CEO,
    employeeHrId: "HR-REP",
    managerHrId: null,
    managerOfManagerHrId: null,
    superAdminHrIds: [],
  });
  assert.equal(nobodyAvailable.toHrId, null, "with no manager, no skip-level and no Super Admin, nobody can be addressed");
  assert.deepEqual(nobodyAvailable.ccHrIds, []);
  assert.deepEqual(nobodyAvailable.bccHrIds, []);
}
