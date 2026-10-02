---
name: canonical-person-hr-id-is-not-a-validity-test
description: "`canonicalPersonHrId` hands an id it does not recognise straight back, UPPER-cased — so using it to resolve a login would have written `OPS-CONSOLE` into an employees(hr_id) FK. Only a DECLARED alias may stand in for a missing hr_id."
metadata:
  node_type: memory
  type: project
  originSessionId: 08f11fd9-5353-4d59-9fba-bc86e4eec1c4
  modified: 2026-10-02T21:26:36.090Z
---

Nearly shipped on 2026-10-02 in the fix for the resignation SLA reminder; caught by a test written
in the same change, before it reached a PR.

```ts
// src/lib/auth/identity-aliases.ts
export function canonicalPersonHrId(hrId: string | null | undefined): string | null {
  const group = groupFor(hrId);
  return group ? canonicalHrIdForDisplay(group.canonicalHrId) : canonicalHrIdForDisplay(hrId);
}
```

**The `else` branch is the trap.** For an id in no declared group it returns the input,
display-canonicalised. Measured: `canonicalPersonHrId("ops-console")` is `"OPS-CONSOLE"`, not null.
The name reads like "resolve this to the person, or nothing", and it is not — it is "give me the
canonical FORM of this id", which always succeeds.

So resolving a login with no `hr_id` through it would have written a **login name** into
`notification_events.employee_hr_id`, which FKs `employees(hr_id)` — the identical SQLSTATE 23503
the change was fixing, one step further along. This is
[[marketing-approver-hrid-casing-fk]]'s class reached through a *different* helper.

**The narrow question has to be asked narrowly.** `sharedIdentityGroups` is exported, so membership
is checkable directly:

```ts
const key = canonicalHrIdKey(login);
const group = sharedIdentityGroups.find((g) => g.aliasHrIds.some((a) => canonicalHrIdKey(a) === key));
return group ? canonicalHrIdForDisplay(group.canonicalHrId) : null;   // null for everything else
```

That is `declaredAliasCanonicalHrId` in `src/lib/notifications/role-recipients.ts`. There is exactly
one declared group — aliases `PHX-1` and `admin-HR`, canonical `B-10`, one person (owner-confirmed,
"B-10 & ADMIN-HR ARE ME", 2026-10-02) — so every other login answers null and is reported as
unresolved rather than forced into a foreign key.

`isSamePerson` is the right helper for "are these two the same human". `canonicalPersonHrId` is only
safe where you already know the input is a real HR id and you want its canonical spelling.
