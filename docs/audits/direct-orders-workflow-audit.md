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

*In progress.*

## C6.3 — Role gates including denial paths

*Not started.*
