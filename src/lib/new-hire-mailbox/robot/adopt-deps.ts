/**
 * The real data an adoption pass runs against.
 *
 * Kept apart from `adopt.ts` and `adopt-runner.ts` for the same reason the joiner's ports are: the
 * gates stay provable without a database or a browser, and filling them in cannot quietly change
 * what a gate decides.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * 🔴 `hasAppPassword` IS ASKED OF THE CREDENTIAL STORE, NOT OF THE TASK'S STATUS. The tempting
 * shortcut is `task.status === "connected"`, since connecting a task requires an app password — but
 * then the gate and the thing it is guarding against are the same fact read twice, and a task left
 * open by an earlier half-finished run would read as "no app password" while Phoenix in fact holds a
 * working one. `getPersonalMailboxState` answers from the stored credential itself.
 *
 * It is also read CONSERVATIVELY: any stored connection for that person counts, including one whose
 * address has since changed and now needs reconnecting. That refuses a few adoptions that might have
 * been fine, and the asymmetry is deliberate — a refusal costs a question, while a wrong allow
 * resets the password of a mailbox somebody is reading right now.
 *
 * 🔴 AND AN ADDRESS NOBODY HOLDS IS REPORTED, NEVER SILENTLY DROPPED. A typo in the list would
 * otherwise come back as a pass that considered nothing and refused nothing, which reads exactly
 * like a success. Every named address leaves here as a candidate, so every one gets a verdict.
 */

import { canonicalHrIdKey } from "@/lib/hr-id";
import { getEmployeeDirectoryRows, isActiveLifecycleStatus } from "@/lib/employees/employee-directory";
import { getPersonalMailboxState } from "@/lib/personal-mailbox/service";

import { getNewHireMailboxQueue } from "../service";
import { readCompanyInitialPassword } from "./initial-password";
import { recordProvisionedMailbox } from "./sweep-deps";
import type { AdoptionCandidate } from "./adopt";
import type { AdoptionDeps } from "./adopt-runner";

function lower(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * Build one candidate per named address.
 *
 * The grain is the ADDRESS, not the queue: a caller names mailboxes, and each one has to come back
 * with its own verdict even when nothing in the database matches it.
 */
export async function loadAdoptionCandidates(
  named: readonly string[],
): Promise<AdoptionCandidate[]> {
  const wanted = [...new Set(named.map(lower).filter((value) => value.length > 0))];
  if (wanted.length === 0) return [];

  const everyone = await getEmployeeDirectoryRows({ includeInactive: true });
  const queue = await getNewHireMailboxQueue();
  // A missing table means no task can be open, which every candidate below then refuses on. It is
  // not an error here: the refusal is the correct answer and it names the real reason.
  const openByKey = new Set(
    queue.schemaMissing
      ? []
      : queue.pending.map((task) => canonicalHrIdKey(task.subject.hrId) ?? ""),
  );

  const candidates: AdoptionCandidate[] = [];
  for (const address of wanted) {
    const employee = everyone.find((row) => lower(row.workEmail) === address);

    if (!employee) {
      candidates.push({
        address,
        displayName: address,
        employeeFound: false,
        hasAppPassword: false,
        hrId: "",
        isActiveEmployee: false,
        taskOpen: false,
        workEmail: null,
      });
      continue;
    }

    const key = canonicalHrIdKey(employee.hrId) ?? "";
    const state = await getPersonalMailboxState({
      displayName: employee.displayName || employee.fullName,
      emailAddress: employee.workEmail,
      hrId: employee.hrId,
      key,
      // The owner of the mailbox, not the Super Admin who asked: this read is about whether a
      // credential exists for THEM.
      loginId: employee.hrId,
    });

    candidates.push({
      address,
      displayName: employee.displayName || employee.fullName,
      employeeFound: true,
      hasAppPassword: state.connected === true,
      hrId: employee.hrId,
      isActiveEmployee: isActiveLifecycleStatus(employee.employmentStatus),
      taskOpen: openByKey.has(key),
      workEmail: employee.workEmail,
    });
  }
  return candidates;
}

/**
 * The ports, filled with the real world.
 *
 * `record` is the joiner's own `recordProvisionedMailbox` deliberately: an adopted mailbox is
 * recorded through exactly the path a created one is, so the app password is proved over IMAP before
 * anything is written and the sealed hand-over password lands the same way.
 */
export function defaultAdoptionDeps(): AdoptionDeps {
  return {
    companyPassword: () => readCompanyInitialPassword(),
    loadCandidates: loadAdoptionCandidates,
    record: recordProvisionedMailbox,
  };
}
