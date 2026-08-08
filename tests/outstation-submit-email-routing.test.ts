import assert from "node:assert/strict";
import { buildOutstationSubmitRouting } from "../src/lib/outstation/submit-recipients.ts";

/**
 * Owner rule (2026-08-04) for the outstation submit email envelope:
 *   To   the submitting employee
 *   Cc   his direct manager
 *   Cc   his manager's manager — ONLY when that person is not the CEO
 *   Bcc  every active Super Admin
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
  assert.equal(normal.toHrId, "HR-REP", "the employee is the To — the mail is his confirmation");
  assert.deepEqual(normal.ccHrIds, ["HR-DM", "HR-NSM"], "both rungs of the reporting line are Cc'd, manager first");
  assert.deepEqual(normal.bccHrIds, ["HR-SA1", "HR-SA2"], "every active Super Admin is Bcc'd");

  // ── The rule that prompted the change: a CEO skip-level is dropped ───────────────
  const ceoSkipLevel = buildOutstationSubmitRouting({
    ceoHrIds: CEO,
    employeeHrId: "HR-REP",
    managerHrId: "HR-DM",
    managerOfManagerHrId: "HR-CEO",
    superAdminHrIds: ADMINS,
  });
  assert.deepEqual(
    ceoSkipLevel.ccHrIds,
    ["HR-DM"],
    "the CEO must NOT be Cc'd as manager-of-manager — that broadcast is exactly what was removed",
  );
  assert.ok(
    !ceoSkipLevel.bccHrIds.includes("HR-CEO"),
    "dropping the CEO from Cc must not quietly re-add him on Bcc",
  );

  // ── …but the CEO as a DIRECT manager is a real reporting line, so he stays ───────
  // 21 active people report straight to the CEO (DMs, reps, Finance, Marketing, SFE). Only the
  // NSM carve-out below changed; everyone else still copies him, and this pins that.
  const ceoIsDirectManager = buildOutstationSubmitRouting({
    ceoHrIds: CEO,
    employeeHrId: "HR-DM",
    managerHrId: "HR-CEO",
    managerOfManagerHrId: null,
    nationalSalesManagerHrIds: ["HR-NSM"],
    superAdminHrIds: ADMINS,
  });
  assert.deepEqual(
    ceoIsDirectManager.ccHrIds,
    ["HR-CEO"],
    "a NON-NSM direct report of the CEO still copies him — the carve-out must not leak to the other 18",
  );

  // ── Owner rule 2026-08-08: an NSM's submission goes to the NSM ALONE ─────────────
  // Every NSM reports directly to the CEO (A-12, AI-0008, B-122 → AA in production), so before
  // this the CEO was Cc'd on every single NSM submission via the direct-manager slot.
  const nsmSubmission = buildOutstationSubmitRouting({
    ceoHrIds: CEO,
    employeeHrId: "HR-NSM",
    managerHrId: "HR-CEO",
    managerOfManagerHrId: null,
    nationalSalesManagerHrIds: ["HR-NSM"],
    superAdminHrIds: ADMINS,
  });
  assert.equal(nsmSubmission.toHrId, "HR-NSM", "the NSM is the To");
  assert.deepEqual(
    nsmSubmission.ccHrIds,
    [],
    "an NSM's submission carries NO Cc at all — the CEO is dropped from the direct-manager slot too",
  );
  assert.ok(
    !nsmSubmission.bccHrIds.includes("HR-CEO"),
    "and dropping him from Cc must not quietly re-add him on Bcc",
  );
  assert.deepEqual(
    nsmSubmission.bccHrIds,
    ADMINS,
    "the Super Admin Bcc is untouched — that is how omar.anwar (B-10) keeps receiving his copy",
  );

  // A missing NSM list must not accidentally strip the CEO for everyone: absent means "no NSMs
  // known", so the pre-existing direct-manager behaviour has to survive unchanged.
  const noNsmListSupplied = buildOutstationSubmitRouting({
    ceoHrIds: CEO,
    employeeHrId: "HR-NSM",
    managerHrId: "HR-CEO",
    managerOfManagerHrId: null,
    superAdminHrIds: ADMINS,
  });
  assert.deepEqual(
    noNsmListSupplied.ccHrIds,
    ["HR-CEO"],
    "with no NSM list supplied nobody is treated as an NSM — the carve-out fails CLOSED, never broadening",
  );

  // ── One person, one slot: the most visible slot wins ─────────────────────────────
  const adminIsManager = buildOutstationSubmitRouting({
    ceoHrIds: CEO,
    employeeHrId: "HR-REP",
    managerHrId: "HR-SA1",
    managerOfManagerHrId: null,
    superAdminHrIds: ADMINS,
  });
  assert.deepEqual(adminIsManager.ccHrIds, ["HR-SA1"], "a Super Admin who manages the employee is Cc'd openly");
  assert.deepEqual(
    adminIsManager.bccHrIds,
    ["HR-SA2"],
    "and is NOT also Bcc'd — one mailbox must never appear in two headers of one message",
  );

  const selfManaged = buildOutstationSubmitRouting({
    ceoHrIds: CEO,
    employeeHrId: "HR-SA1",
    managerHrId: "HR-SA1",
    managerOfManagerHrId: null,
    superAdminHrIds: ADMINS,
  });
  assert.deepEqual(selfManaged.ccHrIds, [], "an employee who is his own manager is not Cc'd on his own mail");
  assert.deepEqual(selfManaged.bccHrIds, ["HR-SA2"], "nor Bcc'd on it, even though he is a Super Admin");

  // ── HR IDs differing only by case/whitespace are the same person ─────────────────
  const messyIds = buildOutstationSubmitRouting({
    ceoHrIds: [" hr-ceo "],
    employeeHrId: "hr-rep",
    managerHrId: "HR-DM",
    managerOfManagerHrId: "Hr-Ceo",
    superAdminHrIds: ["hr-dm", "HR-SA1"],
  });
  assert.deepEqual(
    messyIds.ccHrIds,
    ["HR-DM"],
    "the CEO exclusion must survive case/whitespace differences, or the broadcast silently returns",
  );
  assert.deepEqual(
    messyIds.bccHrIds,
    ["HR-SA1"],
    "a Super Admin already Cc'd under different casing must not be Bcc'd as if he were someone else",
  );

  // ── Degraded inputs must fail closed, never mail a partial envelope ──────────────
  const noEmployee = buildOutstationSubmitRouting({
    ceoHrIds: CEO,
    employeeHrId: null,
    managerHrId: "HR-DM",
    managerOfManagerHrId: "HR-NSM",
    superAdminHrIds: ADMINS,
  });
  assert.equal(noEmployee.toHrId, null, "an unidentifiable employee yields no To…");
  assert.deepEqual(noEmployee.ccHrIds, [], "…and no Cc — the managers must not receive an orphan confirmation");
  assert.deepEqual(noEmployee.bccHrIds, [], "…and no Bcc either");

  const noChain = buildOutstationSubmitRouting({
    ceoHrIds: CEO,
    employeeHrId: "HR-REP",
    managerHrId: null,
    managerOfManagerHrId: null,
    superAdminHrIds: ADMINS,
  });
  assert.equal(noChain.toHrId, "HR-REP", "a missing reporting line still confirms to the employee");
  assert.deepEqual(noChain.ccHrIds, [], "with nobody invented to fill the Cc slots");
  assert.deepEqual(noChain.bccHrIds, ADMINS, "and oversight is unaffected");

  // A skip-level with no direct manager between them is still the skip-level: it must not
  // get promoted into the (empty) manager slot or dropped for lack of one.
  const skipOnly = buildOutstationSubmitRouting({
    ceoHrIds: CEO,
    employeeHrId: "HR-REP",
    managerHrId: null,
    managerOfManagerHrId: "HR-NSM",
    superAdminHrIds: [],
  });
  assert.deepEqual(skipOnly.ccHrIds, ["HR-NSM"], "a skip-level manager is Cc'd even when the direct manager is missing");
}
