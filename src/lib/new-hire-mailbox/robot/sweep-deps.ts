/**
 * The real data the new-hire mailbox robot runs against.
 *
 * Kept apart from `runner.ts` and `sweep-hook.ts` so both stay provable without a database or a
 * browser: those two take ports, and this is the one place the ports are filled with Supabase and
 * Turbify. A change here cannot quietly alter a gate, and a gate cannot quietly start reading
 * something new.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE TWO READS THAT DECIDE SAFETY, and why each is done the way it is:
 *
 *   - `isActiveEmployee` comes from `isActiveLifecycleStatus`, the same predicate every other scope
 *     in this app uses. Not a hand-rolled status comparison: a declined offer and a resignation both
 *     have to drop out, and that logic already exists in one place.
 *   - `addressHeldBy` asks TWO questions, because the address is derived from a name and two
 *     employees legitimately share one. It is held if any OTHER employee already carries it as their
 *     work email, or if any OTHER open task claims it. Either one means the robot must not create
 *     it, and the gate reports whose it is.
 *
 * 🔴 HR IDS ARE MIXED CASE in this database, so every comparison here goes through
 * `canonicalHrIdKey`. A plain `===` has silently under-matched before — and here a missed match
 * reads as "nobody holds this address", which is the one answer that lets one employee's mail reach
 * another.
 */

import { canonicalHrIdKey } from "@/lib/hr-id";
import { getEmployeeDirectoryRows, isActiveLifecycleStatus } from "@/lib/employees/employee-directory";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { logError } from "@/lib/observability/log";

import { connectNewHireMailboxTask, getNewHireMailboxQueue, NEW_HIRE_MAILBOX_TABLE } from "../service";
import { initialPasswordRecord } from "../initial-password-store";
import { createTurbifyJoinerDriver } from "./turbify-joiner";
import { readCompanyInitialPassword } from "./initial-password";
import { runTurbifyJoinerRobot, type JoinerCandidate, type JoinerRunnerDeps } from "./runner";
import { resolveJoinerSweepConfig, type JoinerSweepDeps } from "./sweep-hook";

/** Today in Cairo, as `YYYY-MM-DD` — the gates compare calendar days, never instants. */
function cairoToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit", month: "2-digit", timeZone: "Africa/Cairo", year: "numeric",
  }).format(new Date());
}

function lower(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

/** The pending queue, joined to the employee record, with the address-collision question answered. */
export async function loadJoinerCandidates(): Promise<JoinerCandidate[]> {
  const queue = await getNewHireMailboxQueue();
  if (queue.schemaMissing || queue.pending.length === 0) return [];

  const everyone = await getEmployeeDirectoryRows({ includeInactive: true });
  const byKey = new Map(everyone.map((row) => [canonicalHrIdKey(row.hrId) ?? "", row]));

  // Who already carries each company address as their work email.
  const holderByAddress = new Map<string, { key: string; name: string }>();
  for (const row of everyone) {
    const address = lower(row.workEmail);
    if (!address) continue;
    if (!holderByAddress.has(address)) {
      holderByAddress.set(address, { key: canonicalHrIdKey(row.hrId) ?? "", name: row.displayName || row.fullName });
    }
  }

  const candidates: JoinerCandidate[] = [];
  for (const task of queue.pending) {
    // The task's identity and proposed address live on its `subject`, not on the row.
    const key = canonicalHrIdKey(task.subject.hrId) ?? "";
    const employee = byKey.get(key);
    const address = lower(task.subject.emailAddress);

    // An employee the directory cannot find is not provisioned: the gates need a real record, and
    // guessing one would be exactly the kind of invention that creates a mailbox for nobody.
    if (!employee) continue;

    // 🔴 No Phoenix login, no provisioning. `connectNewHireMailboxTask` refuses to connect a mailbox
    // for a hire with no active login, so creating one here would make a live Turbify account that
    // the robot then could not record — the partial state, reached deliberately. Leave it for the
    // next run, by which time the login exists.
    if (!task.hasLogin) continue;

    // Held by another EMPLOYEE, or claimed by another open TASK. `key` excludes this person.
    const holder = address ? holderByAddress.get(address) : undefined;
    const otherTask = address
      ? queue.pending.find((row) => lower(row.subject.emailAddress) === address && (canonicalHrIdKey(row.subject.hrId) ?? "") !== key)
      : undefined;
    const otherTaskHolder = otherTask
      ? byKey.get(canonicalHrIdKey(otherTask.subject.hrId) ?? "")
      : undefined;

    const addressHeldBy = holder && holder.key !== key
      ? holder.name
      : otherTask
        ? (otherTaskHolder?.displayName || otherTaskHolder?.fullName || "another new hire")
        : null;

    candidates.push({
      addressHeldBy,
      employee: {
        displayName: employee.displayName || employee.fullName,
        hireDate: employee.hireDate,
        hrId: employee.hrId,
        isActiveEmployee: isActiveLifecycleStatus(employee.employmentStatus),
        workEmail: employee.workEmail,
      },
      task: { emailAddress: task.subject.emailAddress, status: task.status },
    });
  }
  return candidates;
}

/**
 * Record a fully provisioned mailbox.
 *
 * Reuses `connectNewHireMailboxTask`, which already verifies the app password against Turbify over
 * IMAP, sets the employee's work email and closes the task — so the robot proves its own work
 * through the same path a person's paste goes through, rather than writing `connected` on its own
 * say-so. Only then is the initial password sealed onto the row.
 *
 * 🔴 The order matters: if the app password does not actually work, `connectNewHireMailboxTask`
 * throws and the task stays open. Writing the initial password first would leave a password recorded
 * against a task that never connected.
 */
export async function recordProvisionedMailbox(input: {
  hrId: string;
  address: string;
  appPassword: string;
  initialPassword: string;
  actor: string;
}): Promise<void> {
  await connectNewHireMailboxTask({
    actorHrId: input.actor,
    appPassword: input.appPassword,
    emailAddress: input.address,
    hrId: input.hrId,
  });

  const key = canonicalHrIdKey(input.hrId) ?? "";
  const { error } = await getSupabaseAdmin()
    .from(NEW_HIRE_MAILBOX_TABLE)
    .update(initialPasswordRecord({ actor: input.actor, plaintext: input.initialPassword }))
    .eq("employee_hr_id_key", key);

  if (error) {
    // The mailbox IS connected and usable; only the hand-over password failed to store. Reporting a
    // failure would invite a second provisioning run against an address that now exists. Log it so
    // the System Administrator knows to read the password from Railway instead for this one.
    logError("New hire mailbox connected but its initial password could not be stored", {
      error: error instanceof Error ? error : new Error(JSON.stringify(error)),
      labels: { address: input.address, event: "new_hire_initial_password_store_failed", hrId: input.hrId },
    });
  }
}

/** The ports, filled with the real world. */
export function defaultJoinerRunnerDeps(): JoinerRunnerDeps {
  return {
    companyPassword: () => readCompanyInitialPassword(),
    loadCandidates: loadJoinerCandidates,
    record: recordProvisionedMailbox,
    today: cairoToday,
  };
}

/** What the sweep passes to `runJoinerSweepPass`. */
export function defaultJoinerSweepDeps(): JoinerSweepDeps {
  return {
    createDriver: async () => {
      const username = String(process.env.PHOENIX_TURBIFY_ADMIN_USER ?? "").trim();
      const password = String(process.env.PHOENIX_TURBIFY_ADMIN_PASSWORD ?? "");
      if (!username || !password) {
        throw new Error(
          "PHOENIX_TURBIFY_ADMIN_USER and PHOENIX_TURBIFY_ADMIN_PASSWORD are not both set, so the "
          + "new-hire mailbox robot cannot sign in to the Turbify console.",
        );
      }
      return createTurbifyJoinerDriver({ password, username });
    },
    resolveConfig: () => resolveJoinerSweepConfig(),
    runnerDeps: defaultJoinerRunnerDeps,
    runRobot: runTurbifyJoinerRobot,
  };
}
