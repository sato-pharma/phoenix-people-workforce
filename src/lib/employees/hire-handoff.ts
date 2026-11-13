/**
 * THE HIRE HAND-OFF LEDGER — every follow-up step after a new employee row is written leaves a row,
 * so a step that fails is retried and, if it keeps failing, seen (enterprise audit 2026-11-13, REC-027).
 *
 * WHY. Both hiring doors — HR's Add Employee (`app/api/employees/route.ts`) and the candidate's offer
 * joining form (`src/lib/offers/joining-form-service.ts` plus `app/api/public/offer-acceptance/[token]`)
 * — write the employee and then run a chain: the offer letter pointed at the hire, the candidate
 * marked hired, the portal login, the CV, the mailbox task, the offer stamped accepted, the joining
 * form's audit row. Each of those only LOGGED its failure. Nothing retried it and nothing showed it,
 * so a hire with no login or an offer pointing at nobody was found by a person noticing.
 *
 * WHAT THIS FILE DOES AND DOES NOT DO.
 *  - `startHireHandoff(hrId, source)` returns a tracker; `tracker.run(step, context, fn, options)` records
 *    the step `pending`, runs `fn`, and records `done` or `failed`. `runHandoffStep` is the one-step form.
 *  - 🔴 IT NEVER CHANGES A DOOR'S REPLY. What `fn` threw is re-thrown unchanged, and what it returned is
 *    returned unchanged — a step that only logged before still only logs, a step that failed the
 *    request before still fails it. `failureOf` reads a step that reports failure in its RESULT (the
 *    offer and candidate syncs return `candidate: "error"`, the login returns `status: "failed"`) and
 *    records it, without touching the result.
 *  - 🔴 THE LEDGER CAN NEVER BREAK A HIRE. Every ledger write is queued behind the previous one (so a
 *    `done` can never land before its own `pending`), runs off the hot path, and is caught and logged
 *    (`hire_handoff_ledger_write_failed`). `flush()` waits for the queue and never throws; the Add
 *    Employee door flushes AFTER its reply, the joining form at its end.
 *  - The retries live in `./hire-handoff-reconciler.ts`. This file imports nothing from recruitment,
 *    because the offers module imports it and the offers module never learns about candidates
 *    (`tests/candidate-offer-pointer.test.ts`).
 *
 * `context` holds ONLY the ids a retry needs, through a whitelist — never a password, token, salary
 * figure or national id (`sanitizeHandoffContext`).
 */

import { hrIdLookupKeys } from "@/lib/hr-id";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const HIRE_HANDOFF_TABLE = "hire_handoff_steps";

/** Which door made the hire. */
export type HireHandoffSource = "add_employee" | "joining_form";

export const hireHandoffSteps = [
  "offer_link",
  "candidate_hired",
  "login",
  "cv",
  "mailbox_task",
  "offer_stamp",
  "acceptance_audit",
] as const;

export type HireHandoffStep = (typeof hireHandoffSteps)[number];

export type HireHandoffStatus = "pending" | "done" | "failed" | "gave_up";

/** After this many attempts (the door's own run included) a failing step is marked `gave_up`. */
export const HIRE_HANDOFF_MAX_ATTEMPTS = 5;

/**
 * What each step IS, in the sentence a person reads on the Needs You board ("<name>: <this>").
 * A `Record` over the closed union, so a new step nobody described is a compile error.
 */
export const hireHandoffStepProblems: Record<HireHandoffStep, string> = {
  offer_link: "the offer letter was not linked to the new employee",
  candidate_hired: "the candidate was not marked hired and the seat's requisition not closed",
  login: "the portal login was not created",
  cv: "the CV was not attached to the employee record",
  mailbox_task: "the company mailbox task was not opened",
  offer_stamp: "the offer letter was not marked accepted",
  acceptance_audit: "the joining form's audit record was not written",
};

/** The ids a retry may need. Anything else handed to the ledger is dropped before it is stored. */
export type HireHandoffContext = {
  actorHrId?: string | null;
  /** The role of whoever ran the door — the login retry replays the same authority, never more. */
  actorRole?: string | null;
  applicationId?: string | null;
  candidateId?: string | null;
  cvDraftFileName?: string | null;
  cvDraftId?: string | null;
  idPhotosFiled?: boolean | null;
  mailboxSource?: "manual_add" | "employee_import" | null;
  offerId?: string | null;
  seated?: boolean | null;
  workEmail?: string | null;
};

const CONTEXT_STRING_KEYS = [
  "actorHrId",
  "actorRole",
  "applicationId",
  "candidateId",
  "cvDraftFileName",
  "cvDraftId",
  "mailboxSource",
  "offerId",
  "workEmail",
] as const;
const CONTEXT_BOOLEAN_KEYS = ["idPhotosFiled", "seated"] as const;

/**
 * Keep only the whitelisted keys, as short strings or booleans. A key that is not on the list — a
 * password, a token, a salary, a national id — never reaches the table, whatever a caller passes.
 */
export function sanitizeHandoffContext(input: unknown): HireHandoffContext {
  const source = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of CONTEXT_STRING_KEYS) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) out[key] = value.trim().slice(0, 200);
  }
  for (const key of CONTEXT_BOOLEAN_KEYS) {
    if (typeof source[key] === "boolean") out[key] = source[key];
  }
  return out as HireHandoffContext;
}

/** A short, single-line error for `last_error` — never a stack, never a payload. */
export function shortHandoffError(value: unknown): string {
  const raw = value instanceof Error ? value.message : typeof value === "string" ? value : JSON.stringify(value);
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  return (text || "The step failed without saying why.").slice(0, 300);
}

/** One ledger row, as the application reads it. */
export type HireHandoffRow = {
  attempts: number;
  context: HireHandoffContext;
  createdAt: string;
  employeeHrId: string;
  lastError: string | null;
  source: HireHandoffSource;
  status: HireHandoffStatus;
  step: HireHandoffStep;
  updatedAt: string;
};

/** One write: the whole row for (employee, step), inserted or overwritten. */
export type HireHandoffWrite = {
  attempts: number;
  context?: HireHandoffContext;
  employeeHrId: string;
  lastError: string | null;
  source: HireHandoffSource;
  status: HireHandoffStatus;
  step: HireHandoffStep;
};

/**
 * The slice of storage the ledger needs. The database is the real one; a test hands in a fake through
 * `setHireHandoffStoreForTests`, because this suite runs with production credentials.
 */
export type HireHandoffStore = {
  write(row: HireHandoffWrite): Promise<void>;
  get(employeeHrId: string, step: HireHandoffStep): Promise<HireHandoffRow | null>;
  /** Rows in any of these statuses, oldest `updated_at` first, at most `limit`. Throws on a failed read. */
  listByStatus(statuses: readonly HireHandoffStatus[], limit: number): Promise<HireHandoffRow[]>;
  /** Employees (by HR id as stored) that hold a row for this step in any of these statuses. */
  hrIdsWithStep(step: HireHandoffStep, statuses: readonly HireHandoffStatus[]): Promise<string[]>;
};

type DbRow = {
  attempts?: number | null;
  context?: unknown;
  created_at?: string | null;
  employee_hr_id?: string | null;
  last_error?: string | null;
  source?: string | null;
  status?: string | null;
  step?: string | null;
  updated_at?: string | null;
};

const COLUMNS = "employee_hr_id,source,step,status,attempts,last_error,context,created_at,updated_at";

function isStep(value: unknown): value is HireHandoffStep {
  return typeof value === "string" && (hireHandoffSteps as readonly string[]).includes(value);
}

function toRow(row: DbRow): HireHandoffRow | null {
  if (!isStep(row.step) || !row.employee_hr_id) return null;
  const status = row.status === "done" || row.status === "failed" || row.status === "gave_up" ? row.status : "pending";
  return {
    attempts: Number(row.attempts ?? 0) || 0,
    context: sanitizeHandoffContext(row.context),
    createdAt: String(row.created_at ?? ""),
    employeeHrId: String(row.employee_hr_id),
    lastError: row.last_error ?? null,
    source: row.source === "joining_form" ? "joining_form" : "add_employee",
    status,
    step: row.step,
    updatedAt: String(row.updated_at ?? ""),
  };
}

const databaseStore: HireHandoffStore = {
  async write(row) {
    const { error } = await getSupabaseAdmin()
      .from(HIRE_HANDOFF_TABLE)
      .upsert(
        {
          attempts: row.attempts,
          ...(row.context ? { context: sanitizeHandoffContext(row.context) } : {}),
          employee_hr_id: row.employeeHrId,
          last_error: row.lastError,
          source: row.source,
          status: row.status,
          step: row.step,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "employee_hr_id,step" },
      );
    if (error) throw new Error(error.message);
  },
  async get(employeeHrId, step) {
    const { data, error } = await getSupabaseAdmin()
      .from(HIRE_HANDOFF_TABLE)
      .select(COLUMNS)
      .in("employee_hr_id", hrIdLookupKeys(employeeHrId))
      .eq("step", step)
      .limit(1);
    if (error) throw new Error(error.message);
    const first = ((data ?? []) as DbRow[])[0];
    return first ? toRow(first) : null;
  },
  async listByStatus(statuses, limit) {
    const { data, error } = await getSupabaseAdmin()
      .from(HIRE_HANDOFF_TABLE)
      .select(COLUMNS)
      .in("status", [...statuses])
      .order("updated_at", { ascending: true })
      .limit(limit);
    if (error) throw new Error(error.message);
    return ((data ?? []) as DbRow[]).map(toRow).filter((row): row is HireHandoffRow => row !== null);
  },
  async hrIdsWithStep(step, statuses) {
    const { data, error } = await getSupabaseAdmin()
      .from(HIRE_HANDOFF_TABLE)
      .select("employee_hr_id")
      .eq("step", step)
      .in("status", [...statuses])
      .limit(5000);
    if (error) throw new Error(error.message);
    return ((data ?? []) as DbRow[]).map((row) => String(row.employee_hr_id ?? "")).filter(Boolean);
  },
};

let storeOverride: HireHandoffStore | null = null;

/** Tests only: route every ledger read and write to a fake. Pass null to restore the database. */
export function setHireHandoffStoreForTests(store: HireHandoffStore | null): void {
  storeOverride = store;
}

export function hireHandoffStore(): HireHandoffStore {
  return storeOverride ?? databaseStore;
}

/** A ledger write that cannot be made is logged and swallowed — the hire it describes is already saved. */
async function writeQuietly(row: HireHandoffWrite): Promise<void> {
  try {
    await hireHandoffStore().write(row);
  } catch (error) {
    logError("A hire hand-off step could not be recorded in the ledger", {
      error: error instanceof Error ? error : new Error(String(error)),
      labels: { event: "hire_handoff_ledger_write_failed", status: row.status, step: row.step },
    });
  }
}

export type HireHandoffRunOptions<T> = {
  /**
   * For a step that reports failure in its result instead of throwing: return a short reason when the
   * result is a failure, null when it is done. The result itself is returned to the caller unchanged.
   */
  failureOf?: (result: T) => string | null;
  /** The attempt number to record (the door's own run is 1). */
  attempt?: number;
  /** False runs `fn` and records nothing — a step with nothing to hand off (no CV was given). */
  record?: boolean;
};

export type HireHandoffTracker = {
  readonly hrId: string;
  readonly source: HireHandoffSource;
  /** Record `step` pending, run `fn`, record done or failed. Returns or throws exactly what `fn` did. */
  run<T>(step: HireHandoffStep, context: HireHandoffContext, fn: () => Promise<T>, options?: HireHandoffRunOptions<T>): Promise<T>;
  /** Wait for every queued ledger write. Never throws. */
  flush(): Promise<void>;
};

/**
 * A tracker for one hire through one door. Ledger writes are QUEUED, one behind the other, and never
 * awaited by `run` — so a step's answer is never late for its ledger, and a `done` can never be
 * overtaken by its own `pending`.
 */
export function startHireHandoff(hrId: string | null | undefined, source: HireHandoffSource): HireHandoffTracker {
  const employeeHrId = String(hrId ?? "").trim();
  let tail: Promise<void> = Promise.resolve();
  const enqueue = (row: HireHandoffWrite) => {
    if (!employeeHrId) return;
    tail = tail.then(() => writeQuietly(row));
  };

  return {
    hrId: employeeHrId,
    source,
    async run<T>(
      step: HireHandoffStep,
      context: HireHandoffContext,
      fn: () => Promise<T>,
      options: HireHandoffRunOptions<T> = {},
    ): Promise<T> {
      if (options.record === false) return fn();
      const safeContext = sanitizeHandoffContext(context);
      const attempts = Math.max(1, options.attempt ?? 1);
      const base = { attempts, context: safeContext, employeeHrId, source, step } as const;
      enqueue({ ...base, lastError: null, status: "pending" });
      let result: T;
      try {
        result = await fn();
      } catch (error) {
        enqueue({ ...base, lastError: shortHandoffError(error), status: "failed" });
        throw error;
      }
      let failure: string | null = null;
      try {
        failure = options.failureOf ? options.failureOf(result) : null;
      } catch (error) {
        // A classifier that cannot read the result must not turn a returned answer into a thrown one.
        failure = `The step's result could not be read: ${shortHandoffError(error)}`;
      }
      enqueue({ ...base, lastError: failure ? shortHandoffError(failure) : null, status: failure ? "failed" : "done" });
      return result;
    },
    async flush(): Promise<void> {
      try {
        await tail;
      } catch {
        // writeQuietly never rejects; this is only a seat belt.
      }
    },
  };
}

/** One step, recorded and awaited — `startHireHandoff(...).run(...)` and then a flush. */
export async function runHandoffStep<T>(
  hrId: string,
  source: HireHandoffSource,
  step: HireHandoffStep,
  context: HireHandoffContext,
  fn: () => Promise<T>,
  options?: HireHandoffRunOptions<T>,
): Promise<T> {
  const tracker = startHireHandoff(hrId, source);
  try {
    return await tracker.run(step, context, fn, options);
  } finally {
    await tracker.flush();
  }
}

// ── How each door's step reports failure in its result ─────────────────────────────────────────────

/** The offer-letter and candidate syncs answer `candidate: "error"` instead of throwing. */
export function syncOutcomeFailure(outcome: { candidate?: unknown } | null | undefined): string | null {
  return outcome?.candidate === "error"
    ? "The offer letter or the candidate could not be brought into line; the reason is in the log."
    : null;
}

/** Whether a login provisioning message says the login is already there — which is DONE, not failed. */
export function isLoginAlreadyThere(message: string | null | undefined): boolean {
  return /already exists/i.test(String(message ?? ""));
}

/**
 * `provisionNewHireAccess` answers per HR id: created, skipped (not active — nothing to create), or
 * failed. A failure saying the account ALREADY EXISTS is done: the create-only HR Operations door
 * refuses an existing login, and that login is what the step was for.
 */
export function loginProvisioningFailure(
  summary: { results?: ReadonlyArray<{ message?: string; status: string }> } | null | undefined,
): string | null {
  const failed = (summary?.results ?? []).filter((result) => result.status === "failed" && !isLoginAlreadyThere(result.message));
  if (failed.length === 0) return null;
  return failed.map((result) => result.message || "The login could not be created.").join(" ");
}

/** `attachEmployeeCvOnCreate` never throws: a CV that was asked for and did not land comes back as warnings. */
export function cvAttachmentFailure(result: { attached: boolean; warnings: readonly string[] } | null | undefined): string | null {
  if (!result || result.attached || result.warnings.length === 0) return null;
  return result.warnings.join(" ");
}

/** `openAndAnnounceNewHireMailboxes` never throws: no task opened, with a reason, is the failure. */
export function mailboxTaskFailure(result: { opened: number; warnings: readonly string[] } | null | undefined): string | null {
  if (!result || result.opened > 0) return null;
  return result.warnings.length > 0 ? result.warnings.join(" ") : "No mailbox task was opened for the new hire.";
}

// ── Reading the unfinished ones ────────────────────────────────────────────────────────────────────

/** The rows the Needs You board shows: failed and given up. Throws on a failed read (amber, never calm). */
export async function loadUnfinishedHireHandoffSteps(limit = 200): Promise<HireHandoffRow[]> {
  return hireHandoffStore().listByStatus(["failed", "gave_up"], limit);
}
