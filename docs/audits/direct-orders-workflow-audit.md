# Direct Orders — deep workflow audit (spec C6)

Started 2026-08-05. Method: compare the TypeScript approval chain against the **live production**
workflow registry in both directions, then walk every status, transition, coupling and role gate.

Every claim below was checked against running code or the production database. Where a hypothesis
turned out to be wrong it is recorded as such rather than deleted — a cleared suspicion is a result.

---

## C6.1 — TS chain vs DB workflow registry

Registry source: `workflow_registry_modules` where `module_key = 'direct_orders'`, version 4, active.
Declares **6 statuses** and **11 actions**.

### Verified clean

| Check | Result |
|---|---|
| Every TS action key exists in the registry | ✅ all 9 |
| Cron can run `expire_held` | ✅ `systemAccessContext.role` is `Super Admin`, which is the action's only allowed role |
| Product Manager / Group Product Manager submissions have a working approval path | ✅ their ladder is `[]`, so the chain is SFE Manager → CEO and both roles are permitted on the actions they perform |

The last two were live suspicions. Both were wrong, and finding that out cost less than reporting
them would have.

### F1 — The registry does not declare `held` or `expired` (medium)

`direct_order_requests_status_check` permits **8** statuses. The registry declares **6**. Missing:
`held`, `expired`.

They are not unused — two declared actions transition *into* them:

```
submit_held  -> held
expire_held  -> expired
```

Nothing breaks at runtime, and the reason is worth recording: `resolveWorkflowRegistryTransition`
validates `action.from` and `action.allowedRoles`, but **never validates `action.to` against
`module.statuses`**. So a transition can legally target a status the registry has never heard of.

Why it still matters: the registry exists to *be* the description of the workflow. Anything reading
`statuses` — a governance report, an admin UI, a future validator — sees a Direct Orders workflow
with no held lane at all. `expired` is also genuinely terminal but has no `terminal: true` flag, so
any consumer reasoning about terminality gets it wrong.

**Fix:** add both statuses to the registry definition, `expired` with `terminal: true`, `held` with
`terminal: false`. Optionally make the resolver reject a transition whose `to` is undeclared, which
would have caught this on the day it was introduced.

### F2 — The pharmacy-validation flow bypasses the registry entirely (medium)

The registry declares two actions that **no code path invokes**:

- `request_pharmacy_validation` — allowed to DM / RM / NSM / PM / GPM / Super Admin
- `decide_pharmacy_validation` — allowed to Super Admin only

Neither `requestDirectOrderPharmacyValidation` nor `decideDirectOrderPharmacyValidation` calls
`assertDirectOrderWorkflowTransition`. The mechanical reason is visible in the type:
`DirectOrderWorkflowActionKey` lists 9 keys and excludes both, so the gate could not be called for
them without changing the union.

This is not an open door — each service enforces its own check (`assertValidationDeskAccess` on the
decide side; `assertPermission` plus the requester-ownership check on the request side). But the
registry is the module's governance layer, and the entire door out of the held lane sits outside it.
The registry currently claims coverage it does not have.

**Fix:** add both keys to `DirectOrderWorkflowActionKey` and call the gate in both services, so the
coarse role/status check applies to the validation flow like every other transition.

### F3 — There is no way to retire a held duplicate (medium, operationally real)

No registry action moves a request out of `held` except `revive_held` (validation) and `expire_held`
(the 14-day sweep). Nothing lets a requester or an admin **cancel** one.

This is not hypothetical. On 2026-08-04 a District Manager submitted the same order twice, 22
minutes apart — byte-identical product, quantity, deal, discount and value — because the first
attempt could not find a valid pharmacy code. The first submission sat `held`; the second, against
the correctly coded pharmacy, entered the approval chain. The duplicate had no exit but the 14-day
clock, and retiring it on 2026-08-05 required raw SQL against production, which bypassed the
registry precisely because the registry has no vocabulary for it.

A retry that leaves a permanent duplicate behind is a normal, repeatable user action. It will happen
again.

**Fix:** add a `cancel_held` action (`from: [held]`, `to: rejected` or a new `cancelled`), allowed to
the requester and Super Admin, requiring a reason — then surface it on the held-order view next to
the validation capture.

---

## C6.2 — Status/transition matrix and `expectedNextStatus` couplings

The registry gate is called from exactly **four** sites in `service.ts`:

| Line | Action | expectedNextStatus | status passed |
|---|---|---|---|
| 810 | `revive_held` | `pending_approval` | `"held"` |
| 925 | `expire_held` | `expired` | `"held"` |
| 1924 | `submit` / `submit_held` | `pending_approval` / `held` | `"draft"` |
| 2118 | decision (4 actions) | from `directOrderDecisionAction` | `"pending_approval"` |

Every `expectedNextStatus` matches the registry's `to` for that action. **No coupling mismatch.**

### F4 — `reverse` never reaches the registry gate (medium)

`reverseDirectOrder` is the one declared action with no `assertDirectOrderWorkflowTransition` call.
It gates on `assertPermission(access, "direct_orders", "create")` instead.

That is not the same rule, and the difference is not academic:

| Role | Holds `direct_orders:create` | Registry lists for `reverse` |
|---|---|---|
| District / Regional / National Sales Manager | yes | yes |
| Product Manager / Group Product Manager | yes | yes |
| Super Admin | yes | yes |
| **Financial Advisor** | **yes** | **no** |
| **Medical Rep** | **yes** | **no** |

Two roles can reverse an approved direct order that the registry never intended to allow. Reversing
retires the order's Source-of-Sales injection — it removes booked sales.

### F5 — `reverse` has no ownership or scope check (medium-high)

Worse than the role list. `reverseDirectOrder` reads the original through `getSupabaseAdmin()` — the
service-role client, so no RLS applies — and then checks only:

```ts
if (original.status !== "approved") badRequest(...)
if (original.reversedByRequestId) badRequest(...)
```

It never verifies the caller raised the order, sits in its approval chain, or works its area. **Any
holder of `direct_orders:create` can reverse any approved direct order in the company**, given its
id.

Bounding it honestly: the reversal is created as `pending_approval`, so it does not retire sales by
itself — it must pass SFE Manager and CEO first. The immediate damage is that it stamps
`reversed_by_request_id` on the original (blocking a legitimate reversal) and injects work into
senior approvers' queues. The real risk is an approver assuming a reversal in their queue is
legitimate because it exists.

Note also that the reversal's chain is built from the REVERSER's role, not the original requester's
(`buildApprovalChain({ requesterHrId: actorHrId, requesterRole: access.role })`), so a Medical Rep's
reversal of a District Manager's order is reviewed as if the rep had raised it.

**Fix:** call the registry gate for `reverse`, and add a scope check — requester, chain member, or
Super Admin.

### F6 — The gate is told a constant, not the row (low-medium, defence-in-depth)

All four call sites pass a **literal** status string rather than the request's actual status. The
gate's `action.from.includes(status)` check is therefore validating what the code expects, not what
the database holds, and can never detect a status anomaly.

In fairness this is not currently a live bug: each service verifies the real status independently
just above the call (`decideDirectOrder` rejects anything that is not `pending_approval`;
`reverseDirectOrder` requires `approved`). But the registry gate exists as belts-and-suspenders, and
right now both belts are the same buckle — if a service's own check were ever removed, the gate
would not catch it.

**Fix:** pass the row's real status. It costs nothing and makes the second check independent.

## C6.3 — Role gates including denial paths

*Not started.*

## C6.3 — Role gates including denial paths

*Not started.*
