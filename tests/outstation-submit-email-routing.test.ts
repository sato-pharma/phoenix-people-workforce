import assert from "node:assert/strict";
import { buildOutstationSubmitRouting } from "../src/lib/outstation/submit-recipients.ts";

/**
 * Owner rule (2026-09-04) for the outstation submit email envelope — REVERSES the 2026-08-13
 * email-reduction project below, which excluded the submitting employee from every slot:
 *   To   the employee himself         — it is his own submission
 *   Cc   his direct manager           — unless that is the CEO, or missing/self-managed
 *   Bcc  every active Super Admin     — silent oversight, unchanged
 *
 * Fallback when the direct manager cannot ride Cc (missing, self-managed, or the CEO — who is
 * NEVER on this email, in any slot, since 2026-08-08): the skip-level manager steps into Cc
 * instead of leaving it empty. If neither rung is available, Cc simply stays empty — Bcc still
 * carries oversight, so nothing is silently dropped to zero recipients.
 *
 * History (2026-08-13 → 2026-09-04, superseded): To was the direct manager, falling back to the
 * skip-level manager and then to a Super Admin promoted from Bcc, with the employee excluded
 * from every slot on the reasoning that a copy confirmed nothing he did not already know.
 *
 * These are behavioural assertions against the pure decision function, not source inspection:
 * the sibling outstation-notifications.test.ts pins that service.ts CALLS this, but only the
 * cases below prove the envelope is actually right.
 */
export function runOutstationSubmitEmailRoutingTests() {
  const CEO = ["HR-CEO"];
  const ADMINS = ["HR-SA1", "HR-SA2"];

  // ── The ordinary shape: rep confirmed, DM copied, none of them the CEO ───────────
  const normal = buildOutstationSubmitRouting({
    ceoHrIds: CEO,
    employeeHrId: "HR-REP",
    managerHrId: "HR-DM",
    managerOfManagerHrId: "HR-NSM",
    superAdminHrIds: ADMINS,
  });
  assert.equal(normal.toHrId, "HR-REP", "the submitting employee is the To — it is his own submission");
  assert.deepEqual(normal.ccHrIds, ["HR-DM"], "the direct manager rides Cc as a courtesy copy");
  assert.deepEqual(normal.bccHrIds, ["HR-SA1", "HR-SA2"], "every active Super Admin is Bcc'd");
  assert.notEqual(normal.ccHrIds[0], "HR-NSM", "the skip-level manager is not consulted when the direct manager is usable");

  // ── Owner instruction 2026-08-08: the CEO is NEVER on this email, in any slot ────
  // When the direct manager IS the CEO, the skip-level manager steps into Cc instead — the
  // owner's explicit answer to "what happens to Cc when the manager is the CEO" (2026-09-04).
  const ceoIsDirectManagerWithSkipLevel = buildOutstationSubmitRouting({
    ceoHrIds: CEO,
    employeeHrId: "HR-NSM",
    managerHrId: "HR-CEO",
    managerOfManagerHrId: "HR-NSM2",
    superAdminHrIds: ADMINS,
  });
  assert.equal(ceoIsDirectManagerWithSkipLevel.toHrId, "HR-NSM", "the employee is still To even when his manager is the CEO");
  assert.deepEqual(
    ceoIsDirectManagerWithSkipLevel.ccHrIds,
    ["HR-NSM2"],
    "the skip-level manager takes the Cc slot the CEO is barred from",
  );
  assert.ok(
    !ceoIsDirectManagerWithSkipLevel.bccHrIds.includes("HR-CEO"),
    "dropping the CEO from Cc must not quietly re-add him on Bcc",
  );

  // Same shape, but with no skip-level manager to fall back to — Cc simply stays empty; Bcc
  // still carries oversight, so nothing is silently dropped to zero recipients.
  const ceoIsDirectManagerNoSkipLevel = buildOutstationSubmitRouting({
    ceoHrIds: CEO,
    employeeHrId: "HR-NSM",
    managerHrId: "HR-CEO",
    managerOfManagerHrId: null,
    superAdminHrIds: ADMINS,
  });
  assert.equal(ceoIsDirectManagerNoSkipLevel.toHrId, "HR-NSM", "the employee is still addressed even with no usable Cc at all");
  assert.deepEqual(ceoIsDirectManagerNoSkipLevel.ccHrIds, [], "no skip-level to fall back to, so Cc stays empty rather than inventing a recipient");
  assert.deepEqual(ceoIsDirectManagerNoSkipLevel.bccHrIds, ["HR-SA1", "HR-SA2"], "Bcc still carries full oversight");

  // The real manager is still Cc'd when he is NOT the CEO — the exclusion is about one person,
  // not about emptying the envelope whenever there is no skip-level given.
  const nonCeoManagerNoSkipLevel = buildOutstationSubmitRouting({
    ceoHrIds: CEO,
    employeeHrId: "HR-REP",
    managerHrId: "HR-DM",
    managerOfManagerHrId: null,
    superAdminHrIds: ADMINS,
  });
  assert.equal(nonCeoManagerNoSkipLevel.toHrId, "HR-REP");
  assert.deepEqual(nonCeoManagerNoSkipLevel.ccHrIds, ["HR-DM"], "a non-CEO direct manager needs no fallback to be Cc'd");

  // Even if the CEO were also granted Super Admin, he must not reappear on Bcc — "removed from
  // Cc" must never silently mean "moved to a quieter header".
  const ceoIsAlsoSuperAdmin = buildOutstationSubmitRouting({
    ceoHrIds: CEO,
    employeeHrId: "HR-REP",
    managerHrId: "HR-CEO",
    managerOfManagerHrId: null,
    superAdminHrIds: ["HR-CEO", "HR-SA1"],
  });
  assert.deepEqual(ceoIsAlsoSuperAdmin.ccHrIds, [], "no skip-level given, so Cc is empty");
  assert.deepEqual(
    ceoIsAlsoSuperAdmin.bccHrIds,
    ["HR-SA1"],
    "a CEO who is also a Super Admin is still off the email entirely, not silently Bcc'd",
  );

  // ── One person, one slot: the most visible slot wins ─────────────────────────────
  const managerIsSuperAdmin = buildOutstationSubmitRouting({
    ceoHrIds: CEO,
    employeeHrId: "HR-REP",
    managerHrId: "HR-SA1",
    managerOfManagerHrId: null,
    superAdminHrIds: ADMINS,
  });
  assert.equal(managerIsSuperAdmin.toHrId, "HR-REP");
  assert.deepEqual(managerIsSuperAdmin.ccHrIds, ["HR-SA1"], "a Super Admin who manages the employee is still Cc'd openly as the manager");
  assert.deepEqual(
    managerIsSuperAdmin.bccHrIds,
    ["HR-SA2"],
    "and is NOT also Bcc'd — one mailbox must never appear in two headers of one message",
  );

  // An employee who is his own manager has no real manager to Cc at all — the fallback moves to
  // the skip-level (also absent here), so Cc stays empty; he is still To.
  const selfManaged = buildOutstationSubmitRouting({
    ceoHrIds: CEO,
    employeeHrId: "HR-SA1",
    managerHrId: "HR-SA1",
    managerOfManagerHrId: null,
    superAdminHrIds: ["HR-SA1", "HR-SA2"],
  });
  assert.equal(selfManaged.toHrId, "HR-SA1", "the employee is To regardless of his own reporting-line oddities");
  assert.deepEqual(selfManaged.ccHrIds, [], "he cannot Cc himself as his own manager, and there is no skip-level either");
  assert.deepEqual(selfManaged.bccHrIds, ["HR-SA2"], "he is not Bcc'd on his own mail either, even though he is a Super Admin");

  // The employee who is also a Super Admin must never appear twice — To only, never also Bcc.
  const employeeIsSuperAdmin = buildOutstationSubmitRouting({
    ceoHrIds: CEO,
    employeeHrId: "HR-SA1",
    managerHrId: "HR-DM",
    managerOfManagerHrId: null,
    superAdminHrIds: ["HR-SA1", "HR-SA2"],
  });
  assert.equal(employeeIsSuperAdmin.toHrId, "HR-SA1");
  assert.deepEqual(employeeIsSuperAdmin.ccHrIds, ["HR-DM"], "the real manager still rides Cc");
  assert.deepEqual(
    employeeIsSuperAdmin.bccHrIds,
    ["HR-SA2"],
    "the employee is excluded from his own oversight Bcc copy even though he is a Super Admin",
  );

  // ── HR IDs differing only by case/whitespace are the same person ─────────────────
  // A manager who also appears in the Super Admin list under different casing must be Cc'd
  // once, not Cc'd AND Bcc'd as if he were two different people.
  const messyIdsDedupe = buildOutstationSubmitRouting({
    ceoHrIds: [" hr-ceo "],
    employeeHrId: "hr-rep",
    managerHrId: "HR-DM",
    managerOfManagerHrId: null,
    superAdminHrIds: ["hr-dm", "HR-SA1"],
  });
  assert.equal(messyIdsDedupe.toHrId, "hr-rep", "toHrId is emitted verbatim, not normalized");
  assert.deepEqual(messyIdsDedupe.ccHrIds, ["HR-DM"], "the manager is Cc'd under his original casing");
  assert.deepEqual(
    messyIdsDedupe.bccHrIds,
    ["HR-SA1"],
    "the same manager under different casing in the admin list must not be Bcc'd a second time",
  );

  // The CEO exclusion must survive case/whitespace differences, or the broadcast silently
  // returns whenever the CEO's HR ID reaches this function in a different case.
  const messyIdsCeoExclusion = buildOutstationSubmitRouting({
    ceoHrIds: ["HR-CEO"],
    employeeHrId: "HR-REP",
    managerHrId: "hr-ceo",
    managerOfManagerHrId: "HR-NSM",
    superAdminHrIds: ["HR-SA1"],
  });
  assert.deepEqual(
    messyIdsCeoExclusion.ccHrIds,
    ["HR-NSM"],
    "a direct manager who normalizes to the CEO is excluded from Cc regardless of casing, and the skip-level steps in",
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

  // Missing reporting line entirely, but Super Admins exist — oversight still reaches them, and
  // the employee is still confirmed since To no longer depends on the reporting chain at all.
  const noChain = buildOutstationSubmitRouting({
    ceoHrIds: CEO,
    employeeHrId: "HR-REP",
    managerHrId: null,
    managerOfManagerHrId: null,
    superAdminHrIds: ADMINS,
  });
  assert.equal(noChain.toHrId, "HR-REP", "To never depends on the reporting chain being resolvable");
  assert.deepEqual(noChain.ccHrIds, [], "nobody to put in Cc");
  assert.deepEqual(noChain.bccHrIds, ["HR-SA1", "HR-SA2"], "Bcc is unaffected by a missing reporting chain");
}
