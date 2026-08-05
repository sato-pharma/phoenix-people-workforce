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

### F1 — The registry does not declare `held` or `expired` (CRITICAL — caused a production outage)

`direct_order_requests_status_check` permits **8** statuses. The registry declares **6**. Missing:
`held`, `expired`.

They are not unused — two declared actions transition *into* them:

```
submit_held  -> held
expire_held  -> expired
```

**This assessment was wrong, and it cost an outage. Corrected 2026-08-05.**

The original note read: *"Nothing breaks at runtime… `resolveWorkflowRegistryTransition` validates
`action.from` and `action.allowedRoles`, but never validates `action.to` against
`module.statuses`."*

That is true of the RESOLVER — and I stopped there. I checked the layer I expected the check to be
in, found it absent, and downgraded a fatal defect to a documentation nit. The **LOADER** runs first
and does validate: `normalizeActions(row.actions, statusKeys)` throws
`Action N target status "held" is not defined`. `listWorkflowRegistryModules` catches that, logs it,
**skips the module**, and carries on.

So the module was not merely mis-described — it was **absent from the loaded set entirely**. Every
`direct_orders` transition returned `workflow_module_not_found`, surfacing to users as
*"Workflow Registry blocked direct_orders.submit: module is missing or inactive."* Including plain
`submit`, which has nothing to do with held orders. Reps could not raise a direct order at all.

Nothing errored, nothing paged. The single trace was a log line. It surfaced when a user complained.

**Fixed in production** by declaring both statuses (`expired` marked terminal): 8 statuses, 11
actions, zero undeclared references, verified by simulating the loader. A sweep of all 13 modules
confirmed `direct_orders` was the only one affected.

**The lesson is the skip-and-log design.** Not skipping is worse — one bad row would take down
payroll, resignations, probation and the rest. But it converts "this row is invalid" into "this
module does not exist", which is a lie in the direction that hides the cause. `/api/readyz` now
reports skipped modules by name and reason so the next one is a one-request diagnosis.

**Still worth doing:** make the RESOLVER reject a transition whose `to` is undeclared too. The
loader already refuses to load such a module, so the resolver check is redundant for correctness —
but it would have turned this into a clear error at the transition instead of a module that quietly
ceased to exist.

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

All **16** exported mutations in `service.ts` were enumerated and each one's guard read directly.

### Result: no new authorization holes

Beyond F4/F5 (already fixed), every mutation is properly gated:

| Guard | Functions |
|---|---|
| `assertPharmacyRegistryAccess` — System Admin or SFE Manager | `registerDirectOrderPharmacy`, `updateDirectOrderPharmacyDetails`, `replaceDirectOrderPharmacyCodes` |
| `canSetDirectOrderSalesMonth` — system, Super Admin, or the Finance HR ID | `setDirectOrderSalesMonth` |
| `canResolveGeoVariances` — System Admin | `resolvePharmacyGeoVariance` |
| inline Super Admin | `setDirectOrderProductPrices`, `rebuildDirectOrderApprovalChain`, `acknowledgeDirectOrderPharmacy`, `expireStaleHeldDirectOrders` |
| `assertPermission` | `submitDirectOrder`, `decideDirectOrder`, `createDirectOrderPharmacy`, `reverseDirectOrder`, `searchDirectOrderPharmacyDirectory` |

Notably `setDirectOrderSalesMonth` — the GOLDEN RULE path that injects sales — is correctly
restricted despite carrying only `direct_orders:read` as its coarse permission. The real gate is the
named helper immediately after it.

### Methodological warning (worth more than a finding)

An automated scan for `assertPermission(...)` and `access.role === "..."` reported **five** functions
as unguarded. **All five were false alarms.** This module's guards are overwhelmingly *named
helpers* — `assertPharmacyRegistryAccess`, `canSetDirectOrderSalesMonth`, `canResolveGeoVariances` —
which no grep for the obvious patterns will find.

Anyone repeating this audit with tooling will systematically under-report the guards and "discover"
holes that do not exist. Read the first ten lines of each function instead.

### Denial paths

Route handlers classify errors with `isForbiddenError(error)`, which matches
`message.toLowerCase().startsWith("forbidden:")` — so the **message prefix is the protocol**.
Checked across the module:

- **13** bare `throw new Error("Forbidden: …")` — all carry the prefix, all return **403** ✅
- **7** `throw forbiddenError(...)` — `toApiError` returns `ApiError` instances unchanged, so all
  return **403** regardless of message ✅

### F7 — one denial returns 500 instead of 400 (low)

`toApiError` classifies *bare* Errors by message pattern. One message in the module matches none:

```
src/lib/direct-orders/caps.ts:133   "The global cap cannot be deleted."
   -> falls through every pattern -> new ApiError(500, "internal_error")
```

A user who tries to delete the global cap is told the **server broke**, when in fact they were
correctly refused. The sibling message two lines up, `"… is required."`, matches ` is required` and
correctly returns 400.

**Fix:** throw `validationError("The global cap cannot be deleted.")` instead of a bare `Error`.

This is the fragility the prefix convention creates: correctness depends on wording. A typed error
does not.

---

## Summary

| # | Finding | Severity | Status |
|---|---|---|---|
| F5 | `reverse` had no ownership/scope check — any create-holder could reverse any approved order company-wide | medium-high | **fixed** (#1768) |
| F4 | `reverse` ungated, so Medical Rep / Financial Advisor could reverse | medium | **fixed** (#1768) |
| F3 | No action retires a held duplicate | medium | open |
| F2 | Validation flow bypasses the registry entirely | medium | open |
| F1 | Registry declares 6 statuses; the DB allows 8 | medium | open |
| F6 | Gate is passed a literal status, not the row's | low-medium | fixed at `reverse`; open at 3 sites |
| F7 | One denial returns 500 instead of 400 | low | open |

**Five suspicions were tested and cleared**, each recorded above rather than deleted: the cron can
run `expire_held`; PM/GPM submissions have a working approval path; `setDirectOrderSalesMonth` is
properly restricted; the pharmacy-registry mutations are properly restricted; and every
`forbiddenError` denial does return 403.

The most valuable output is arguably not a finding at all: **the guards in this module are named
helpers, so grep-based auditing of it produces false alarms.** Anyone repeating this should read the
functions.
