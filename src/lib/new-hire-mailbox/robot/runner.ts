/**
 * One pass of the new-hire mailbox robot: queue → gates → console → sealed store.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE ORDER OF REFUSALS IS THE DESIGN. Creating a mailbox consumes a seat and makes a live account,
 * so everything that can be decided from Phoenix's own data is decided BEFORE a browser is launched:
 *
 *   1. not enabled              → read nothing, launch nothing
 *   2. no company password      → refuse the whole pass, launch nothing. A run that created a
 *                                 mailbox and then found it had no password to set would leave a live
 *                                 account on a one-time password nobody holds.
 *   3. the gates, per candidate → `evaluateProvisionSafety`, against the register and the employee
 *                                 record. An address anybody else holds never reaches the console.
 *   4. the per-run cap          → a runaway creates accounts, which cost money and seats. A hire
 *                                 whose mailbox the console shows ALREADY EXISTS takes no slot:
 *                                 nothing was created, so the run moves on to the next allowed hire
 *                                 (see "AN EXISTING MAILBOX TAKES NO SLOT" below).
 *
 * Only then does a driver appear, and on a dry run it is the one that touches nothing.
 *
 * 🔴 PARTIAL SUCCESS IS NOT SUCCESS. The three console steps are create → set password → mint the
 * app password, and the last has no retry: once the employee changes their password nobody but them
 * can mint one. So a candidate whose mailbox was created but whose app password was not minted is
 * counted as `partial` and is NEVER recorded as connected. The register keeps the task open, which
 * is the truthful state — the mailbox exists and Phoenix cannot read it — and a person can finish it
 * by hand. Recording it as connected would hide a mailbox nobody can reach.
 *
 * 🔴 AND A DRY RUN STORES NOTHING. Not the app password, not the initial password, not the status.
 * It reports the plan. That is what makes enabling the robot safe before trusting it.
 */

import { logError, logInfo } from "@/lib/observability/log";

import { createDryRunJoinerDriver, type JoinerConsoleDriver } from "./driver";
import { explainUnusableInitialPassword, isUsableInitialPassword } from "./initial-password";
import { TurbifyJoinerStepError } from "./turbify-joiner";
import {
  ROBOT_ACTOR,
  ROBOT_DEFAULT_MAX_CREATES_PER_RUN,
  ROBOT_MAX_CONSOLE_LOOKUPS_PER_RUN,
  evaluateProvisionSafety,
  isQuietRefusal,
  normalizeRunLimit,
  type ProvisionEmployeeFacts,
  type ProvisionRefusal,
  type ProvisionTaskFacts,
} from "./safety";

/** One row the robot might act on, with everything the gates need, resolved by the caller. */
export type JoinerCandidate = {
  employee: ProvisionEmployeeFacts;
  task: ProvisionTaskFacts;
  /** Who else holds or claims this address, or null when it is genuinely free. */
  addressHeldBy: string | null;
};

export type JoinerOutcome = {
  hrId: string;
  displayName: string;
  address: string | null;
  status: "provisioned" | "partial" | "refused" | "deferred" | "failed";
  /** The gate that refused it, when one did. */
  refusal?: ProvisionRefusal;
  detail?: string;
};

export type JoinerRunResult = {
  enabled: boolean;
  dryRun: boolean;
  /** Candidates the gates were run against. */
  considered: number;
  /** All three console steps landed and the task was recorded connected. */
  provisioned: number;
  /** The mailbox exists but Phoenix has no access — task left OPEN on purpose. */
  partial: number;
  /** A gate said no, for a reason worth reading. */
  refused: number;
  /** A gate said no for ordinary reasons — already done, not needed, too early. */
  deferred: number;
  /** The console failed in a way that is not a gate. */
  failed: number;
  /** Set when the whole pass refused before touching anything. */
  blocked: string | null;
  outcomes: JoinerOutcome[];
};

/** Everything the runner touches that is not pure logic, injected so this is provable. */
export type JoinerRunnerDeps = {
  loadCandidates: () => Promise<readonly JoinerCandidate[]>;
  /** The company pattern, from the environment. Null when unset. */
  companyPassword: () => string | null;
  /**
   * Record a fully provisioned mailbox: the app password (sealed by the store), the initial password
   * (sealed under its own context) and the task's status. Called ONLY after all three steps landed,
   * and never on a dry run.
   */
  record: (input: {
    hrId: string;
    address: string;
    appPassword: string;
    initialPassword: string;
    actor: string;
  }) => Promise<void>;
  today: () => string;
  /** Mailboxes the run may try to create. Defaults to ROBOT_DEFAULT_MAX_CREATES_PER_RUN (3). */
  maxPerRun?: number;
  /** Hires the run may look up in the console at all. Defaults to ROBOT_MAX_CONSOLE_LOOKUPS_PER_RUN. */
  maxLookupsPerRun?: number;
};

function emptyResult(enabled: boolean, dryRun: boolean, blocked: string | null = null): JoinerRunResult {
  return {
    blocked, considered: 0, deferred: 0, dryRun, enabled, failed: 0, outcomes: [],
    partial: 0, provisioned: 0, refused: 0,
  };
}

/**
 * Run one pass.
 *
 * `driver` is supplied for a live run. On a dry run one is built here that touches nothing, so a
 * caller cannot accidentally hand a live driver to a dry run and have it act.
 */
export async function runTurbifyJoinerRobot(options: {
  enabled: boolean;
  dryRun: boolean;
  driver?: JoinerConsoleDriver;
  deps: JoinerRunnerDeps;
}): Promise<JoinerRunResult> {
  const { deps, dryRun, enabled } = options;
  if (!enabled) return emptyResult(false, dryRun);

  // Gate 2 — the password, before anything is read or launched. Fail the PASS, not a candidate:
  // without it every candidate would fail identically, after a mailbox had been created.
  const companyPassword = deps.companyPassword();
  if (!companyPassword || !isUsableInitialPassword(companyPassword)) {
    const blocked = explainUnusableInitialPassword(companyPassword)
      ?? "The company mailbox password is not usable, so no mailbox was created.";
    logError("New hire mailbox robot refused the whole pass", {
      error: new Error(blocked),
      labels: { event: "new_hire_robot_blocked" },
    });
    return emptyResult(true, dryRun, blocked);
  }

  const candidates = await deps.loadCandidates();
  const result = emptyResult(true, dryRun);
  result.considered = candidates.length;

  // Gate 3 — the gates, before the browser. Allowed candidates are collected; refusals are recorded
  // and never reach the console.
  const allowed: Array<{ candidate: JoinerCandidate; address: string }> = [];
  for (const candidate of candidates) {
    const verdict = evaluateProvisionSafety({
      addressHeldBy: candidate.addressHeldBy,
      employee: candidate.employee,
      task: candidate.task,
      today: deps.today(),
    });
    if (verdict.allowed) {
      allowed.push({ address: verdict.address, candidate });
      continue;
    }
    const quiet = isQuietRefusal(verdict.refusal);
    if (quiet) result.deferred += 1;
    else result.refused += 1;
    result.outcomes.push({
      address: candidate.task.emailAddress,
      detail: verdict.detail,
      displayName: candidate.employee.displayName,
      hrId: candidate.employee.hrId,
      refusal: verdict.refusal,
      status: quiet ? "deferred" : "refused",
    });
  }

  // Gate 4 — the cap.
  //
  // 🔴 AN EXISTING MAILBOX TAKES NO SLOT. The cap used to be a `slice(0, 3)` over a stable order, and
  // `createMailbox` refuses a mailbox the console already holds (the `alreadyExists` throw, before
  // any create control is pressed). So the same three hires — Esraa Ibrahim Saad, Ahmed Abd-Elnaim
  // and Norhan Samir Selim Ramla, read in the production logs on 10 and 11 Nov 2026 — came first
  // every morning, were declined, and used up the whole run: the seven hires behind them were never
  // looked at. Now the slot is counted per hire the run actually tried to CREATE (provisioned,
  // partial or a real failure), and an already-exists hire hands its slot to the next allowed hire.
  // The cap of real create attempts is unchanged; `lookupLimit` bounds the read-only lookups.
  const createLimit = normalizeRunLimit(deps.maxPerRun ?? ROBOT_DEFAULT_MAX_CREATES_PER_RUN);
  const lookupLimit = normalizeRunLimit(deps.maxLookupsPerRun ?? ROBOT_MAX_CONSOLE_LOOKUPS_PER_RUN);
  if (allowed.length === 0 || createLimit === 0 || lookupLimit === 0) return result;

  const driver = dryRun ? createDryRunJoinerDriver() : options.driver;
  if (!driver) {
    result.blocked = "A live run was asked for without a console driver, so nothing was created.";
    return result;
  }

  try {
    await driver.signIn();

    let createSlotsTaken = 0;
    let lookups = 0;
    for (const { address, candidate } of allowed) {
      if (createSlotsTaken >= createLimit || lookups >= lookupLimit) break;
      lookups += 1;
      // Every attempt takes a slot unless the console proves the mailbox already existed.
      let tookCreateSlot = true;
      const { displayName, hrId } = candidate.employee;
      const local = address.slice(0, address.indexOf("@"));
      let created: { address: string; oneTimePassword: string } | null = null;
      try {
        created = await driver.createMailbox({ displayName, local });
        await driver.setMailboxPassword({
          address: created.address,
          newPassword: companyPassword,
          oneTimePassword: created.oneTimePassword,
        });
        const { appPassword } = await driver.generateAppPassword({ address: created.address, password: companyPassword });

        // A dry run proves the walk and stores nothing.
        if (!dryRun) {
          await deps.record({
            actor: ROBOT_ACTOR,
            address: created.address,
            appPassword,
            hrId,
            initialPassword: companyPassword,
          });
        }
        result.provisioned += 1;
        result.outcomes.push({ address: created.address, displayName, hrId, status: "provisioned" });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        // 🔴 The distinction that matters: did the mailbox get made? If it did, this is PARTIAL —
        // a live account Phoenix cannot read — and the task stays open so a person finishes it.
        const partial = created !== null;
        if (partial) result.partial += 1;
        else result.failed += 1;
        result.outcomes.push({
          address: created?.address ?? address,
          detail: partial
            ? `The mailbox was created but the run did not finish, so Phoenix has no access to it and the task stays open: ${detail}`
            : detail,
          displayName,
          hrId,
          status: partial ? "partial" : "failed",
        });
        // 🔴 THE ONE EXPECTED FAILURE IS NOT LOGGED AT ERROR. When `createMailbox` finds the mailbox
        // already exists in Turbify it throws with `alreadyExists`, and that is not a console failure
        // — the robot read the console correctly and declined. The task stays OPEN and surfaced on
        // the New Hire Mailboxes card for a Super Admin to finish (adoption and the invitation never
        // run on a sweep), so writing the same row to app_error_events every daily sweep was pure
        // duplication that buried genuinely-new failures. It logs at INFO instead, searchable via
        // `event=new_hire_robot_exists` — the identical treatment the outstation auto-release gives
        // its expected "awaiting a decision" skip (#5453). Every OTHER failure, partial or not, is a
        // real console problem and stays at ERROR. A partial can never be this case: `createMailbox`
        // throws its existence refusal before `created` is ever set, so `partial` is always false
        // here — the `!partial` guard only makes that explicit.
        const expectedExists =
          !partial && error instanceof TurbifyJoinerStepError && error.alreadyExists;
        if (expectedExists) {
          // Nothing was created, so the slot goes to the next allowed hire.
          tookCreateSlot = false;
          logInfo("New hire mailbox robot skipped a mailbox that already exists in Turbify", {
            labels: { event: "new_hire_robot_exists", hrId },
          });
        } else {
          logError("New hire mailbox robot could not finish a mailbox", {
            error: error instanceof Error ? error : new Error(detail),
            labels: { event: partial ? "new_hire_robot_partial" : "new_hire_robot_failed", hrId },
          });
        }
      }
      if (tookCreateSlot) createSlotsTaken += 1;
    }
  } finally {
    await driver.close().catch(() => {});
  }

  if (result.provisioned > 0 || result.partial > 0) {
    logInfo("New hire mailbox robot ran", {
      labels: {
        dryRun,
        event: "new_hire_robot_run",
        partial: result.partial,
        provisioned: result.provisioned,
        refused: result.refused,
      },
    });
  }
  return result;
}

export { ROBOT_ACTOR };
