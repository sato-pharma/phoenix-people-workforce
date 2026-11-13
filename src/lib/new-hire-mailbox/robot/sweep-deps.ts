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
import { listMonitors, listMonitorMessages, openMonitorMessage } from "@/lib/mailbox-monitor/service";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { logError } from "@/lib/observability/log";
import { assertRobotDriverAllowedHere } from "@/lib/platform/robot-service";

import { connectNewHireMailboxTask, getNewHireMailboxQueue, NEW_HIRE_MAILBOX_TABLE } from "../service";
import { initialPasswordRecord } from "../initial-password-store";
import { createTurbifyJoinerDriver } from "./turbify-joiner";
import { pollForInvitation, type InviteInboxReaderDeps } from "./invite-inbox-reader";
import { readCompanyInitialPassword } from "./initial-password";
import { ROBOT_ACTOR } from "./safety";
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

    // 🔴 NO ADDRESS, NO CANDIDATE (owner, 2026-10-03). The address the robot creates in Turbify is
    // the one typed into the Employee Master, verbatim — nothing derives it any more, because a
    // derivation created a mailbox at `el.sayed@satopharma.com` for a hire whose first name is
    // "Elsayed", one word. A task opened before that field was filled therefore has no address, and
    // the right behaviour is to WAIT: it costs one more sweep, where inventing one costs a real
    // mailbox at the wrong address on the live domain and a deletion to undo it.
    if (!address) continue;

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

/**
 * The invite inbox, filled with the real mailbox monitor.
 *
 * 🔴 EVERY READ HERE IS AUDITED AND ATTRIBUTED TO THE ROBOT, not to whoever triggered the sweep.
 * `withMonitorRead` writes a `mailbox_access` row per call with the actor it is handed, so passing
 * `ROBOT_ACTOR` is what makes "Phoenix opened this mailbox and read a message out of it" answerable
 * afterwards — a `null` actor records the same reads as nobody's.
 *
 * The monitor is resolved by ADDRESS rather than from a stored id because the invite inbox is
 * connected by hand on the Mailbox Monitor page (it needs an app password only a human can mint
 * inside the mailbox), so Phoenix never chooses its id. `listMonitors` never returns a password,
 * sealed or otherwise.
 */
export function defaultInviteInboxReaderDeps(): InviteInboxReaderDeps {
  return {
    findMonitorId: async (address) => {
      const wanted = lower(address);
      const monitors = await listMonitors();
      // Identity, not `includes`: this chooses which mailbox Phoenix is about to READ.
      return monitors.find((monitor) => lower(monitor.emailAddress) === wanted)?.id ?? null;
    },
    listMessages: (monitorId, folder, limit) => listMonitorMessages(monitorId, folder, ROBOT_ACTOR, limit),
    openMessage: (monitorId, folder, uid) => openMonitorMessage(monitorId, folder, uid, ROBOT_ACTOR),
  };
}

/**
 * A real console driver from the environment's admin credentials.
 *
 * Shared by the sweep and the adoption route so there is ONE place that decides what counts as
 * usable Turbify credentials — a second copy would eventually disagree with this one about the
 * missing-credential message, and that message is what a Super Admin reads when nothing happens.
 *
 * 🔴 IT IS ALSO THE ONE PLACE THE INVITATION READER IS ATTACHED. Turbify's create hands its password
 * over by email rather than through the dialog a RESET raises, so a driver built WITHOUT the reader
 * cannot finish a create at all — it can only report the PENDING mailbox it left behind. Attaching
 * it here means every real caller has it and no caller has to remember to, while the tests still
 * drive the driver with no inbox at all and see that honest refusal.
 */
export async function createJoinerDriverFromEnv() {
  // FIRST, before the credentials are read or anything is launched (audit REC-075): once
  // PHOENIX_ROBOT_SERVICE_URL is set, a robot browser opens on the robot service and nowhere else.
  assertRobotDriverAllowedHere();
  const username = String(process.env.PHOENIX_TURBIFY_ADMIN_USER ?? "").trim();
  const password = String(process.env.PHOENIX_TURBIFY_ADMIN_PASSWORD ?? "");
  if (!username || !password) {
    throw new Error(
      "PHOENIX_TURBIFY_ADMIN_USER and PHOENIX_TURBIFY_ADMIN_PASSWORD are not both set, so the "
      + "new-hire mailbox robot cannot sign in to the Turbify console.",
    );
  }
  return createTurbifyJoinerDriver(
    { password, username },
    { readInvitation: (address) => pollForInvitation({ address, deps: defaultInviteInboxReaderDeps() }) },
  );
}

/** What the sweep passes to `runJoinerSweepPass`. */
export function defaultJoinerSweepDeps(): JoinerSweepDeps {
  return {
    createDriver: createJoinerDriverFromEnv,
    resolveConfig: () => resolveJoinerSweepConfig(),
    runnerDeps: defaultJoinerRunnerDeps,
    runRobot: runTurbifyJoinerRobot,
  };
}
