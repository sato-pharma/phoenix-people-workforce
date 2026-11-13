/**
 * THE HIRE HAND-OFF RECONCILER — re-runs a failed or stalled hand-off step until it is done, and gives
 * up visibly after five attempts (enterprise audit 2026-11-13, REC-027). The ledger is `./hire-handoff.ts`.
 *
 * EVERY RETRY IS THE SAME IDEMPOTENT WRITE THE DOOR MADE, OR A READ THAT SAYS IT IS ALREADY DONE:
 *
 *  - offer_link       `recordHireFromOfferLetter` again. It points a letter at the hire only while the
 *                     letter is accepted and unlinked, and a candidate already hired is left alone
 *                     ("already"), so a second run writes nothing twice.
 *  - candidate_hired  `recordHireFromCandidate` again. A hired candidate is "already"; a requisition
 *                     already filled is out of the fillable piles it reads.
 *  - login            DONE when the person already holds a login (any login, active or not — a login
 *                     somebody disabled stays disabled). Otherwise `provisionNewHireAccess` with the
 *                     same authority the door had: the create-only HR Operations door for the joining
 *                     form and an HR Operations add, the system flow for a Super Admin's add. A
 *                     create-only door answering "already exists" is DONE. The "retry now" route passes
 *                     the presser's own seat instead, exactly as Add Employee would.
 *  - cv               DONE when the record already holds a CV (nothing is ever overwritten). Otherwise
 *                     `attachEmployeeCvOnCreate` with the same sources. A staged upload is cleared
 *                     after a day; once it is gone the step gives up and says so.
 *  - mailbox_task     `openAndAnnounceNewHireMailboxes` again — the task's unique key on the HR id
 *                     means a second open is ignored, and its notice (in-app and Telegram, never
 *                     email) carries a per-hire idempotency key.
 *  - offer_stamp      DONE when the letter already names this employee. A letter naming SOMEBODY ELSE,
 *                     or no longer sent or accepted (declined, withdrawn), is never overwritten: the
 *                     step gives up and says why. Otherwise the same stamp, whose accepted-offer notice
 *                     is idempotent per offer and never email — then the letter link, as the door does.
 *  - acceptance_audit DONE when an audit row for this letter and hire exists. Otherwise ONE row that
 *                     says it was written by the retry: the answers he typed are not kept anywhere
 *                     but the employee record (the ledger never stores a national id), so this row
 *                     records the acceptance and points there.
 *
 * Nothing here sends an email of its own.
 */

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { hrIdLookupKeys, hrIdsMatch } from "@/lib/hr-id";
import { logError, logInfo } from "@/lib/observability/log";
import { claimJobLease, newJobLeaseHolderId, type JobLeaseRpcClient } from "@/lib/platform/job-lease";
import { provisionNewHireAccess } from "@/lib/employees/access-provisioning";
import { attachEmployeeCvOnCreate, getEmployeeCv } from "@/lib/employees/employee-cv";
import { openAndAnnounceNewHireMailboxes } from "@/lib/new-hire-mailbox/notify";
import { getOffer, isOfferNotFound, stampOfferAcceptedByJoiningForm } from "@/lib/offers/service";
import { recordHireFromCandidate, recordHireFromOfferLetter } from "@/lib/recruitment/offer-outcome-sync";
import {
  HIRE_HANDOFF_MAX_ATTEMPTS,
  cvAttachmentFailure,
  hireHandoffStore,
  loginProvisioningFailure,
  mailboxTaskFailure,
  runHandoffStep,
  shortHandoffError,
  syncOutcomeFailure,
  type HireHandoffRow,
  type HireHandoffStatus,
  type HireHandoffStep,
} from "@/lib/employees/hire-handoff";
import type { AccessActor } from "@/lib/admin/access-control";

/** The login the reconciler names itself by in every record it touches. */
export const HIRE_HANDOFF_ACTOR_ID = "hire-handoff";

/** The cron job's lease key and how long one run may hold it. */
export const HIRE_HANDOFF_LEASE_KEY = "hire-handoff-reconcile";
const LEASE_TTL_SECONDS = 10 * 60;

/** A `pending` row this old was left by a door that never finished (a crash, a deploy). */
export const HIRE_HANDOFF_STALE_PENDING_MS = 30 * 60 * 1000;
/** At most this many steps a run, and the run stops starting new ones after this long. */
export const HIRE_HANDOFF_STEPS_PER_RUN = 25;
const RUN_BUDGET_MS = 40_000;

/** A step that can never succeed by being run again — it is given up at once, with the reason. */
export class HandoffNotRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandoffNotRetryableError";
  }
}

/** How long a failed step waits before its next attempt: 15 min, 30 min, 1 h, 2 h, then 6 h at most. */
export function hireHandoffBackoffMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(15 * 60 * 1000 * 2 ** exponent, 6 * 60 * 60 * 1000);
}

/** Whether a row is due for a retry now. */
export function isHireHandoffDue(row: HireHandoffRow, now: Date): boolean {
  const updated = new Date(row.updatedAt).getTime();
  const age = Number.isFinite(updated) ? now.getTime() - updated : Number.POSITIVE_INFINITY;
  if (row.status === "pending") return age >= HIRE_HANDOFF_STALE_PENDING_MS;
  if (row.status === "failed") return age >= hireHandoffBackoffMs(row.attempts);
  return false;
}

type OfferForRetry = { employeeHrId: string | null; status: string };

/** Everything a retry reaches outside this file — the real modules, or a test's fakes. */
export type HireHandoffRetryDeps = {
  acceptanceAuditExists(offerId: string, hrId: string): Promise<boolean>;
  attachEmployeeCvOnCreate: typeof attachEmployeeCvOnCreate;
  employeeHasCv(hrId: string): Promise<boolean>;
  insertAcceptanceAudit(row: { employeeHrId: string; idPhotosFiled: boolean | null; offerId: string }): Promise<void>;
  loginExistsFor(hrId: string): Promise<boolean>;
  openAndAnnounceNewHireMailboxes: typeof openAndAnnounceNewHireMailboxes;
  provisionNewHireAccess: typeof provisionNewHireAccess;
  readOffer(offerId: string): Promise<OfferForRetry | null>;
  recordHireFromCandidate: typeof recordHireFromCandidate;
  recordHireFromOfferLetter: typeof recordHireFromOfferLetter;
  stampOfferAcceptedByJoiningForm(
    offerId: string,
    hire: { hrId: string; idPhotosFiled?: boolean; seated?: boolean; workEmail: string | null },
  ): Promise<unknown>;
};

export const defaultHireHandoffRetryDeps: HireHandoffRetryDeps = {
  async acceptanceAuditExists(offerId, hrId) {
    const { data, error } = await getSupabaseAdmin()
      .from("offer_acceptances")
      .select("id")
      .eq("offer_id", offerId)
      .in("employee_hr_id", hrIdLookupKeys(hrId))
      .limit(1);
    if (error) throw new Error(error.message);
    return (data ?? []).length > 0;
  },
  attachEmployeeCvOnCreate,
  async employeeHasCv(hrId) {
    return Boolean(await getEmployeeCv(hrId));
  },
  async insertAcceptanceAudit(row) {
    const { error } = await getSupabaseAdmin()
      .from("offer_acceptances")
      .insert({
        employee_hr_id: row.employeeHrId,
        ip_hash: null,
        offer_id: row.offerId,
        payload: {
          idPhotosFiled: row.idPhotosFiled,
          note:
            "Written by the hire hand-off retry: the joining form's own audit row could not be written at "
            + "submission. The answers given on the form are on the employee record.",
          recordedBy: HIRE_HANDOFF_ACTOR_ID,
        },
      });
    if (error) throw new Error(error.message);
  },
  async loginExistsFor(hrId) {
    const { data, error } = await getSupabaseAdmin()
      .from("app_auth_users")
      .select("login_id")
      .in("hr_id", hrIdLookupKeys(hrId))
      .limit(1);
    if (error) throw new Error(error.message);
    return (data ?? []).length > 0;
  },
  openAndAnnounceNewHireMailboxes,
  provisionNewHireAccess,
  async readOffer(offerId) {
    try {
      const offer = await getOffer(offerId);
      return { employeeHrId: offer.employeeHrId ?? null, status: String(offer.status ?? "") };
    } catch (error) {
      if (isOfferNotFound(error)) return null;
      throw error;
    }
  },
  recordHireFromCandidate,
  recordHireFromOfferLetter,
  stampOfferAcceptedByJoiningForm,
};

/**
 * The authority the login retry replays. The door's own, never more: HR Operations (and the joining
 * form, which runs as HR Operations) keep the create-only, rank-bounded door; a Super Admin's add
 * replays as the system flow `upsertAccessUser` allows; anything else keeps its own seat, so a door
 * that was refused is refused again and the step gives up visibly.
 */
function doorActor(role: string | null | undefined): AccessActor | null {
  if (role === "Super Admin") return null;
  return { loginId: HIRE_HANDOFF_ACTOR_ID, role: (role || "HR Operations") as AccessActor["role"] };
}

/**
 * Run one step again. Returns when the step is done; throws `HandoffNotRetryableError` when it never
 * can be, and any other error when it failed this time.
 */
export async function retryHireHandoffStep(
  row: HireHandoffRow,
  deps: HireHandoffRetryDeps = defaultHireHandoffRetryDeps,
  options: { actor?: AccessActor | null } = {},
): Promise<void> {
  const hrId = row.employeeHrId;
  const context = row.context;

  switch (row.step) {
    case "offer_link": {
      const offerId = context.offerId;
      if (!offerId) throw new HandoffNotRetryableError("No offer letter was recorded for this hire, so there is nothing to link.");
      const outcome = await deps.recordHireFromOfferLetter({ actorHrId: context.actorHrId ?? null, hrId, offerId });
      const failure = syncOutcomeFailure(outcome);
      if (failure) throw new Error(failure);
      return;
    }
    case "candidate_hired": {
      const candidateId = context.candidateId;
      if (!candidateId) throw new HandoffNotRetryableError("No candidate was recorded for this hire, so there is nobody to mark hired.");
      const outcome = await deps.recordHireFromCandidate({ actorHrId: context.actorHrId ?? null, candidateId, hrId });
      const failure = syncOutcomeFailure(outcome);
      if (failure) throw new Error(failure);
      return;
    }
    case "login": {
      if (await deps.loginExistsFor(hrId)) return;
      const actor = options.actor !== undefined ? options.actor : doorActor(context.actorRole);
      const summary = await deps.provisionNewHireAccess({ actor, hrIds: [hrId], source: "hire hand-off retry" });
      const failure = loginProvisioningFailure(summary);
      if (failure) throw new Error(failure);
      return;
    }
    case "cv": {
      if (await deps.employeeHasCv(hrId)) return;
      if (!context.cvDraftId && !context.applicationId && !context.candidateId) {
        throw new HandoffNotRetryableError("No CV source was recorded for this hire. Attach the CV on the employee record.");
      }
      const result = await deps.attachEmployeeCvOnCreate({
        actorHrId: context.actorHrId ?? null,
        applicationId: context.applicationId ?? null,
        candidateId: context.candidateId ?? null,
        cvDraftFileName: context.cvDraftFileName ?? null,
        cvDraftId: context.cvDraftId ?? null,
        hrId,
      });
      const failure = cvAttachmentFailure(result);
      if (!failure) return;
      if (context.cvDraftId && !context.applicationId && !context.candidateId && /could not be found/i.test(failure)) {
        throw new HandoffNotRetryableError(
          "The CV chosen on the form is no longer waiting to be attached (a chosen file is cleared after a day). "
            + "Attach the CV on the employee record.",
        );
      }
      throw new Error(failure);
    }
    case "mailbox_task": {
      const result = await deps.openAndAnnounceNewHireMailboxes({
        actorId: HIRE_HANDOFF_ACTOR_ID,
        hrIds: [hrId],
        source: context.mailboxSource ?? "manual_add",
      });
      const failure = mailboxTaskFailure(result);
      if (failure) throw new Error(failure);
      return;
    }
    case "offer_stamp": {
      const offerId = context.offerId;
      if (!offerId) throw new HandoffNotRetryableError("No offer letter was recorded for this hire, so there is nothing to stamp.");
      const offer = await deps.readOffer(offerId);
      if (!offer) throw new HandoffNotRetryableError("The offer letter no longer exists.");
      if (offer.employeeHrId && !hrIdsMatch(offer.employeeHrId, hrId)) {
        throw new HandoffNotRetryableError("The offer letter already names another employee, so it was not changed.");
      }
      if (!offer.employeeHrId) {
        if (offer.status !== "sent" && offer.status !== "accepted") {
          throw new HandoffNotRetryableError(`The offer letter is now ${offer.status || "in another state"}, so it was not marked accepted.`);
        }
        await deps.stampOfferAcceptedByJoiningForm(offerId, {
          hrId,
          idPhotosFiled: context.idPhotosFiled ?? undefined,
          seated: context.seated ?? undefined,
          workEmail: context.workEmail ?? null,
        });
      }
      // The door links the letter right after the stamp; a stamp that failed left that link with nothing
      // to point at, so it runs again here, on its own ledger row.
      await runHandoffStep(
        hrId,
        "joining_form",
        "offer_link",
        { offerId },
        () => deps.recordHireFromOfferLetter({ actorHrId: null, hrId, offerId }),
        { failureOf: syncOutcomeFailure },
      );
      return;
    }
    case "acceptance_audit": {
      const offerId = context.offerId;
      if (!offerId) throw new HandoffNotRetryableError("No offer letter was recorded for this hire, so there is no acceptance to record.");
      if (await deps.acceptanceAuditExists(offerId, hrId)) return;
      await deps.insertAcceptanceAudit({ employeeHrId: hrId, idPhotosFiled: context.idPhotosFiled ?? null, offerId });
      return;
    }
  }
}

export type HireHandoffAttemptOutcome = {
  attempts: number;
  hrId: string;
  lastError: string | null;
  status: Exclude<HireHandoffStatus, "pending">;
  step: HireHandoffStep;
};

/** One attempt at one row, recorded. Never throws: the outcome is the answer. */
export async function attemptHireHandoffRow(
  row: HireHandoffRow,
  deps: HireHandoffRetryDeps = defaultHireHandoffRetryDeps,
  options: { actor?: AccessActor | null } = {},
): Promise<HireHandoffAttemptOutcome> {
  const attempts = row.attempts + 1;
  let status: HireHandoffAttemptOutcome["status"] = "done";
  let lastError: string | null = null;
  try {
    await retryHireHandoffStep(row, deps, options);
  } catch (error) {
    lastError = shortHandoffError(error);
    status = error instanceof HandoffNotRetryableError || attempts >= HIRE_HANDOFF_MAX_ATTEMPTS ? "gave_up" : "failed";
  }
  try {
    await hireHandoffStore().write({
      attempts,
      context: row.context,
      employeeHrId: row.employeeHrId,
      lastError,
      source: row.source,
      status,
      step: row.step,
    });
  } catch (error) {
    logError("A hire hand-off retry ran but its outcome could not be recorded", {
      error: error instanceof Error ? error : new Error(String(error)),
      labels: { event: "hire_handoff_ledger_write_failed", status, step: row.step },
    });
  }
  return { attempts, hrId: row.employeeHrId, lastError, status, step: row.step };
}

export type HireHandoffLease = {
  claim(): Promise<boolean>;
  release(): Promise<void>;
};

function databaseLease(): HireHandoffLease {
  const holder = newJobLeaseHolderId();
  const client = () => getSupabaseAdmin() as unknown as JobLeaseRpcClient;
  return {
    async claim() {
      const result = await claimJobLease(client(), { holder, jobKey: HIRE_HANDOFF_LEASE_KEY, ttlSeconds: LEASE_TTL_SECONDS });
      return result.held;
    },
    async release() {
      // There is no release call: re-claiming for one second lets the lease run out at once.
      await claimJobLease(client(), { holder, jobKey: HIRE_HANDOFF_LEASE_KEY, ttlSeconds: 1, wasHeld: true });
    },
  };
}

export type HireHandoffReconcileResult = {
  /** False when another run held the lease — this one did nothing. */
  ran: boolean;
  examined: number;
  due: number;
  done: number;
  failed: number;
  gaveUp: number;
  outcomes: HireHandoffAttemptOutcome[];
};

/**
 * The hourly run: claim the lease, read the failed and stale pending steps, retry the due ones (at most
 * `HIRE_HANDOFF_STEPS_PER_RUN`, inside a time budget), record each outcome, release. A failed read of
 * the ledger throws, so the cron answers 500 and the heartbeat says so.
 */
export async function runHireHandoffReconciler(
  options: { deps?: HireHandoffRetryDeps; lease?: HireHandoffLease; limit?: number; now?: () => Date } = {},
): Promise<HireHandoffReconcileResult> {
  const now = options.now ?? (() => new Date());
  const deps = options.deps ?? defaultHireHandoffRetryDeps;
  const lease = options.lease ?? databaseLease();
  const limit = Math.max(1, options.limit ?? HIRE_HANDOFF_STEPS_PER_RUN);
  const result: HireHandoffReconcileResult = { done: 0, due: 0, examined: 0, failed: 0, gaveUp: 0, outcomes: [], ran: false };

  if (!(await lease.claim())) return result;
  result.ran = true;
  const started = Date.now();
  try {
    const rows = await hireHandoffStore().listByStatus(["pending", "failed"], limit * 8);
    result.examined = rows.length;
    const due = rows.filter((row) => isHireHandoffDue(row, now())).slice(0, limit);
    result.due = due.length;
    for (const row of due) {
      if (Date.now() - started > RUN_BUDGET_MS) break;
      const outcome = await attemptHireHandoffRow(row, deps);
      result.outcomes.push(outcome);
      if (outcome.status === "done") result.done += 1;
      else if (outcome.status === "gave_up") result.gaveUp += 1;
      else result.failed += 1;
    }
  } finally {
    try {
      await lease.release();
    } catch {
      // An unreleased lease simply runs out.
    }
  }
  if (result.outcomes.length > 0) {
    logInfo("Hire hand-off reconciler retried unfinished steps", {
      context: { done: result.done, failed: result.failed, gaveUp: result.gaveUp },
      labels: { event: "hire_handoff_reconciled" },
    });
  }
  return result;
}

export type HireHandoffRetryNowResult =
  | { found: false }
  | { found: true; alreadyDone: true }
  | { found: true; alreadyDone: false; outcome: HireHandoffAttemptOutcome };

/**
 * The "retry now" route's one step, through the same retry the reconciler runs. A step already done is
 * reported and left alone. `actor` is the presser's own seat, used by the login step only.
 */
export async function retryHireHandoffNow(
  input: { actor: AccessActor | null; hrId: string; step: HireHandoffStep },
  deps: HireHandoffRetryDeps = defaultHireHandoffRetryDeps,
): Promise<HireHandoffRetryNowResult> {
  const row = await hireHandoffStore().get(input.hrId, input.step);
  if (!row) return { found: false };
  if (row.status === "done") return { alreadyDone: true, found: true };
  return { alreadyDone: false, found: true, outcome: await attemptHireHandoffRow(row, deps, { actor: input.actor }) };
}
