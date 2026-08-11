/**
 * THE single boundary for Finance's direct-order authority: who may act, and when.
 *
 * WHY THIS MODULE EXISTS (second-review finding 6, 2026-08-11). Finance's direct-order duties are
 * bound to one HR_ID rather than to the "Finance Manager" role. That restriction is deliberate and
 * is NOT relaxed here — moving money between months must not be inherited silently by the next
 * person given the Finance Manager title. But the literal was reachable from several call sites,
 * so re-homing the duty later meant hunting for it. Every "may this person do Finance's job"
 * question now resolves through this file, so reassigning the duty is a change to ONE module.
 *
 * WHAT WOULD CHANGE IF THE OWNER LATER WANTS A ROLE/CAPABILITY ASSIGNMENT: replace the body of
 * `isDirectOrderFinanceOfficer` with a lookup (a capability grant, a config row, a role check).
 * Nothing else in the codebase needs to move, because nothing else names the person.
 *
 * The `when` half is equally deliberate. Both money duties are gated on the order actually being
 * approved, and both rules are pure functions so they can be proven without a database.
 */

import { canonicalHrIdKey } from "@/lib/hr-id";
import type { AccessContext } from "@/lib/auth/permissions";

/**
 * The one person the owner named for Finance's direct-order duties (2026-08-03): Ahmed El Maraghy.
 * An HR_ID and not the "Finance Manager" ROLE, deliberately — see the module header. This is the
 * ONLY place the literal appears; `collection-rules.ts` and `service.ts` both re-export from here.
 */
export const DIRECT_ORDER_FINANCE_HR_ID = "B-185";

/** The subset of an access context these rules read. Keeps them callable from tests with a literal. */
export type DirectOrderFinanceAccess = Pick<AccessContext, "scope" | "role" | "hrId">;

/**
 * Is this the person who holds Finance's direct-order duties?
 *
 * SINGLE POINT OF REASSIGNMENT. To move the duty to a role, a capability grant or a config row,
 * change this function body and nothing else.
 */
function isDirectOrderFinanceOfficer(access: DirectOrderFinanceAccess): boolean {
  return canonicalHrIdKey(access.hrId) === canonicalHrIdKey(DIRECT_ORDER_FINANCE_HR_ID);
}

/** System admins act for anyone; kept separate so the Finance test above stays a single concern. */
function isSystemAdmin(access: DirectOrderFinanceAccess): boolean {
  return access.scope === "system" || access.role === "Super Admin";
}

/**
 * Who may book a direct order into a Source-of-Sales month.
 *
 * The CEO and SFE Manager can SEE the month but never set it — approving an order and deciding
 * which month its sales land in are different authorities on purpose.
 */
export function canAssignDirectOrderSalesMonth(access: DirectOrderFinanceAccess): boolean {
  return isSystemAdmin(access) || isDirectOrderFinanceOfficer(access);
}

/**
 * Who may record that money actually arrived.
 *
 * A SEPARATE predicate from `canAssignDirectOrderSalesMonth` even though both resolve to the same
 * person today. They are different duties — booking a month decides which period the SALES count
 * in, recording a collection says what has been PAID — and the owner may split them once someone
 * else handles receivables.
 */
export function canRecordDirectOrderCollection(access: DirectOrderFinanceAccess): boolean {
  return isSystemAdmin(access) || isDirectOrderFinanceOfficer(access);
}

export type DirectOrderSalesMonthOutcome =
  | { ok: true; nextMonth: string | null }
  | { ok: false; message: string };

/**
 * May this sales-month change be written, given the order's current state?
 *
 * WHY A SERVER-SIDE STATUS RULE EXISTS AT ALL (second-review finding 5, 2026-08-11). Until this
 * function, `setDirectOrderSalesMonth` validated only the month's FORMAT and the caller's identity,
 * then wrote the column. Nothing stopped an authorized caller stamping a month onto a `draft`,
 * `pending_approval`, `returned` or `held` row through the API directly; only the UI declined to
 * offer the control. The injection RPC filters `status = 'approved'`, so this could never inject
 * money incorrectly — but it could leave a request row asserting a Finance decision that no
 * approval chain had ever authorised, which is a data-integrity defect in its own right and
 * exactly the kind of thing UI-only enforcement is not allowed to be responsible for.
 *
 * ASSIGNING requires an approved order. CLEARING is also permitted when the row already carries a
 * month regardless of status — otherwise a month stamped before this guard existed, or one left on
 * a row that was later reversed, would be permanently unfixable through the product.
 */
export function deriveDirectOrderSalesMonthChange(input: {
  status: string;
  currentMonth: string | null;
  requestedMonth: string | null;
}): DirectOrderSalesMonthOutcome {
  const requested = input.requestedMonth === null ? null : String(input.requestedMonth).trim();

  if (requested !== null && !/^\d{4}-\d{2}$/.test(requested)) {
    return { ok: false, message: "Pick a month in YYYY-MM form, e.g. 2026-07." };
  }

  if (requested !== null && input.status !== "approved") {
    return {
      ok: false,
      message:
        "Only an approved direct order can be booked into a sales month. " +
        "This order has not completed its approval chain yet.",
    };
  }

  // Clearing: allowed on an approved order, and allowed as a correction wherever a month is
  // already stored — see the header. Clearing a row that has no month is a no-op the caller
  // short-circuits before reaching here, but refusing it explicitly keeps the rule total.
  if (requested === null && input.status !== "approved" && input.currentMonth === null) {
    return {
      ok: false,
      message: "This order has no sales month to clear.",
    };
  }

  return { ok: true, nextMonth: requested };
}
