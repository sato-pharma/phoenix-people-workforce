import { canAccessSystemAdministratorWorkspace, type AccessContext } from "@/lib/auth/permissions";

/**
 * Who may reach the distribution lists screen, and WHICH lists they may see there.
 *
 * Super Admin, plus the **HR Business Partner** — the job title the `HR Advisory` seat is displayed
 * under (`HR_SEAT_JOB_TITLES`). Owner decision 2026-09-11: she should see that screen, scoped to
 * the HR-owned lists. Asked whether "all of it" included the Monthly Closing Cc, he answered
 * plainly: *"HR lists only, she shouldn't touch the closing cc."*
 *
 * WHY A BY-NAME SEAT CHECK RATHER THAN A PERMISSION. The natural resource would be
 * `communication`, but that gates the whole email composer, the email templates and the Telegram
 * templates (`access-registry.ts`), and no HR function grants it today — routing through it would
 * hand her three surfaces she was not given. A new `PermissionResource` is the textbook answer and
 * is worth doing the moment a second seat needs this; for one seat and one screen it would touch
 * the matrix for every role to express a single grant. The cost is that the permission matrix
 * cannot see this gate — which is exactly what Rule 10 of `tests/hr-function-governance.test.ts`
 * exists to catch, so this file is listed there with its verdict rather than arriving unnoticed.
 *
 * It grants nothing beyond those lists. No list can originate an email — they decide who an
 * existing send reaches — and the alias register cannot touch a mailbox at all, because Turbify has
 * no API.
 */
export function canManageDistributionLists(access: AccessContext): boolean {
  return canAccessSystemAdministratorWorkspace(access) || access.role === "HR Advisory";
}

/**
 * The lists the HR Business Partner owns.
 *
 * 🔴 FAIL-CLOSED, AND THAT DIRECTION IS THE WHOLE POINT. A list absent from this set is invisible
 * to her, so a list added later is private until somebody decides it is hers. The opposite shape —
 * "everything except a denylist" — would make each new list visible by default, and the first one
 * nobody remembered to deny would be a silent widening. `closing_fixed_cc` decides who is Cc'd on
 * every Monthly Closing publish, a sales email; `finance_team` is Finance's.
 */
const HR_OWNED_LIST_KEYS: ReadonlySet<string> = new Set(["hr_team"]);

/**
 * Which lists this viewer may read and edit: `"all"` for Super Admin, otherwise an explicit set.
 *
 * Returned as a SCOPE rather than applied by the screen, because a screen that merely hides a row
 * is not a boundary — `/api/admin/distribution-lists/[listKey]` is reachable by hand. Every reader
 * and every writer must narrow through this, and the route tests pin that they do.
 */
export function distributionListScopeFor(access: AccessContext): "all" | ReadonlySet<string> {
  if (canAccessSystemAdministratorWorkspace(access)) return "all";
  // A seat that cannot reach the screen holds NO list. Returning the HR set to everyone was safe
  // only because every caller checks the gate first — which is a property of today's callers, not
  // of this function. Answering honestly means a future reader that forgets the gate still gets
  // nothing rather than the HR Business Partner's lists.
  if (!canManageDistributionLists(access)) return EMPTY_SCOPE;
  return HR_OWNED_LIST_KEYS;
}

const EMPTY_SCOPE: ReadonlySet<string> = new Set();

/** True when this viewer may read and edit that one list. */
export function canManageDistributionList(access: AccessContext, listKey: string): boolean {
  if (!canManageDistributionLists(access)) return false;
  const scope = distributionListScopeFor(access);
  return scope === "all" || scope.has(listKey);
}
