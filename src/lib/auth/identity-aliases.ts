// Shared-person identity — the single source of truth for "these HR_IDs are the same human".
//
// Phoenix has accounts that are separate LOGINS but one physical person. The canonical case
// (owner confirmation 2026-07-04, re-confirmed system-wide 2026-07-25) is the HR Manager, who
// is also the Phoenix system super admin: he signs in either as his own employee account or as
// the shared system-administrator console, and the two write different HR_IDs into decision,
// recipient, and audit columns.
//
// Before this module the concept was re-implemented per feature — vacation separation-of-duties,
// the private-calendar global-viewer list, weekly-sales full access, the probation CC target, and
// the probation notification cap each carried their own hardcoded list, and they disagreed (the
// probation cap exempted the console account while the probation mailer targeted the employee
// account, so the same human was both exempt and capped). Every one of those now derives from
// the groups declared here.
//
// DELIBERATELY NOT wired into `canonicalHrIdKey`/`hrIdsMatch` in `@/lib/hr-id`. Those drive
// employee-row lookups and what gets PERSISTED; collapsing the aliases there would make the
// system-admin employee row unreachable and would silently rewrite stored HR_IDs. This module
// answers a narrower question — "is this the same person?" — for permission, separation-of-duties,
// notification-routing, and display decisions only. Historic rows keep their original HR_ID, so
// an audit trail still shows which console an action came from.

import { canonicalHrIdForDisplay, canonicalHrIdKey } from "@/lib/hr-id";

export type SharedIdentityGroup = {
  /** Aliases of the canonical HR_ID. Casing is irrelevant — matching is canonicalized. */
  readonly aliasHrIds: readonly string[];
  /** The real employee HR_ID this person is known by. */
  readonly canonicalHrId: string;
  /** Name shown for the alias accounts in UI/report surfaces (never in legal/payroll documents). */
  readonly displayName: string;
  /** Why the group exists — surfaced in code review, not at runtime. */
  readonly reason: string;
};

/**
 * The declared groups. Add an entry only on explicit owner confirmation that two accounts are
 * operated by one human; removing an entry re-splits them everywhere at once.
 */
export const sharedIdentityGroups: readonly SharedIdentityGroup[] = [
  {
    aliasHrIds: ["PHX-1", "admin-HR"],
    canonicalHrId: "B-10",
    displayName: "Omar Anwar Gawish",
    reason:
      "HR Manager (B-10) and the Phoenix system-administrator console (PHX-1, login admin-HR) are "
      + "the same person. Requiring a login switch between two accounts controlled by one human is "
      + "not a real second actor. Revisit if a second real HR/Super Admin is ever hired.",
  },
];

function groupFor(hrId: string | null | undefined): SharedIdentityGroup | null {
  const key = canonicalHrIdKey(hrId);
  if (!key) return null;
  return (
    sharedIdentityGroups.find(
      (group) =>
        canonicalHrIdKey(group.canonicalHrId) === key
        || group.aliasHrIds.some((alias) => canonicalHrIdKey(alias) === key),
    ) ?? null
  );
}

/**
 * Every HR_ID belonging to the same person as `hrId`, as canonical lowercase lookup keys
 * (the form `normalizeHrId`/`canonicalHrIdKey` produce). Returns just the ID's own key when it
 * is not part of a group, and an empty set for a blank/unparseable value — so callers can use
 * it unconditionally.
 */
export function sharedIdentityKeys(hrId: string | null | undefined): Set<string> {
  const key = canonicalHrIdKey(hrId);
  if (!key) return new Set();
  const group = groupFor(key);
  if (!group) return new Set([key]);
  return new Set(
    [group.canonicalHrId, ...group.aliasHrIds]
      .map((id) => canonicalHrIdKey(id))
      .filter((id): id is string => Boolean(id)),
  );
}

/**
 * The HR_ID this person should be known by, in stored display casing (e.g. "PHX-1" -> "B-10").
 * Non-grouped IDs are returned unchanged apart from canonical casing.
 */
export function canonicalPersonHrId(hrId: string | null | undefined): string | null {
  const group = groupFor(hrId);
  return group ? canonicalHrIdForDisplay(group.canonicalHrId) : canonicalHrIdForDisplay(hrId);
}

/** True when both HR_IDs belong to the same physical person (including plain equality). */
export function isSamePerson(left: string | null | undefined, right: string | null | undefined) {
  const rightKey = canonicalHrIdKey(right);
  return Boolean(rightKey && sharedIdentityKeys(left).has(rightKey));
}

/**
 * Display name to show for an alias account, or null when the HR_ID is not an alias. The canonical
 * account keeps its own stored name — only the secondary console accounts are relabelled, so the
 * underlying `employees.full_name` (used by identity matching and legal/payroll documents) is
 * never overridden.
 */
export function sharedIdentityDisplayName(hrId: string | null | undefined): string | null {
  const key = canonicalHrIdKey(hrId);
  const group = groupFor(key);
  if (!group || !key) return null;
  if (canonicalHrIdKey(group.canonicalHrId) === key) return null;
  return group.displayName;
}

/** True when this HR_ID is a secondary (non-canonical) account of a grouped person. */
export function isSharedIdentityAlias(hrId: string | null | undefined) {
  return sharedIdentityDisplayName(hrId) !== null;
}
