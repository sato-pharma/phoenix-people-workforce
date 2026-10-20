// HR Reminders — who is on the team and who is looking.
//
// The module is for the HR team and nobody else: the HR Manager (the Super Admin seat), HR
// Operations (shown as HR Generalist), HR Resourcing (Talent Acquisition) and, since 2026-10-20,
// HR Administration (HR Operations Specialist), whose bundle carries `team_reminders`. The seats are
// named here once; `tests/hr-reminders.test.ts` pins this list to the matrix grant, so a seat that
// gains the permission cannot be left off the team picker and a seat on the picker cannot lack the
// permission.

import { canonicalPersonHrId } from "@/lib/auth/identity-aliases";
import type { AccessContext } from "@/lib/auth/permissions";
import type { ReminderAudience } from "@/lib/hr-reminders/logic";

/** The roles whose holders make up the team a note can be shared with. */
export const REMINDER_TEAM_ROLES = ["Super Admin", "HR Operations", "HR Resourcing", "HR Administration"] as const;

/** The seat that reads every item whatever its sharing — the HR Manager's, per the brief. */
export const REMINDER_OVERSEER_ROLE = "Super Admin" as const;

export function isReminderTeamRole(role: string | null | undefined): boolean {
  return (REMINDER_TEAM_ROLES as readonly string[]).includes(String(role ?? ""));
}

/**
 * The person looking, as the rules in ./logic.ts understand them — or null when the session carries
 * no HR id at all (the guest session), which can see nothing.
 *
 * The id is folded onto the PERSON (the console login PHX-1 is B-10) in stored casing, so an item
 * written from either login belongs to the same author.
 */
export function reminderAudienceFor(access: Pick<AccessContext, "hrId" | "role">): ReminderAudience | null {
  const hrId = canonicalPersonHrId(access.hrId);
  if (!hrId) return null;
  return { hrId, isOverseer: access.role === REMINDER_OVERSEER_ROLE };
}
