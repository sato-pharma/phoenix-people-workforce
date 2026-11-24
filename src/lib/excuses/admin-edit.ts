/**
 * The Super Admin's tools on one excuse request — edit it or delete it — the rules only, with no
 * database and no session, so the client panel and the unit suite read the very same lists.
 *
 * Owner, 2026-11-24: "in excuse approvals add admin tools". Leave Approvals has carried the same two
 * tools on every request's page since 2026-10-08 (`vacation-admin-controls.tsx`); an excuse had
 * none, so a wrong date, a wrong half or a decision recorded by mistake could only be fixed by hand
 * in the database.
 *
 * What it is NOT: a turn-jumping approval. The direct manager still decides an excuse in the
 * Action Center (`decideExcuseRequestAsManager`, no Super Admin stand-in), and the bulk bar never
 * reaches this. An admin edit is a correction to the record, written to the audit log with the old
 * and the new values, and it tells nobody — exactly as a leave request's admin edit tells nobody.
 */

export type ExcuseAdminStatus = "pending_manager" | "approved" | "rejected" | "returned_to_employee";

export const EXCUSE_ADMIN_STATUS_OPTIONS: ReadonlyArray<{ label: string; value: ExcuseAdminStatus }> = [
  { label: "Pending manager", value: "pending_manager" },
  { label: "Approved", value: "approved" },
  { label: "Rejected", value: "rejected" },
  { label: "Returned to employee", value: "returned_to_employee" },
];

export const EXCUSE_ADMIN_TYPE_OPTIONS: ReadonlyArray<{ label: string; value: "morning" | "afternoon" }> = [
  { label: "Morning excuse", value: "morning" },
  { label: "Afternoon excuse", value: "afternoon" },
];

export function parseExcuseAdminStatus(value: unknown): ExcuseAdminStatus | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  return EXCUSE_ADMIN_STATUS_OPTIONS.some((option) => option.value === normalized)
    ? (normalized as ExcuseAdminStatus)
    : null;
}

/** The Super Admin, or a background system actor — the same door `reassignExcuseManager` uses. */
export function canManageExcuseRecordsFor(access: { role?: string | null; scope?: string | null }): boolean {
  return access.scope === "system" || String(access.role ?? "").trim() === "Super Admin";
}

export type ExcuseAdminCurrent = {
  excuseDate: string;
  excuseType: "morning" | "afternoon";
  managerDecisionComment: string | null;
  status: ExcuseAdminStatus;
};

export type ExcuseAdminChange = {
  excuseDate: string;
  excuseType: "morning" | "afternoon";
  /** The reply the employee reads on the request. */
  reply: string | null;
  status: ExcuseAdminStatus;
};

/**
 * The columns an admin edit writes, beside the type and the date.
 *
 * - Status unchanged: the decision columns are left exactly as they are, the reply excepted.
 * - Back to `pending_manager`: the decision is cleared, as a resubmission clears it, so the request
 *   is in the assigned manager's queue again with nothing pre-decided.
 * - To a decided status: the decision is recorded as the admin's, now — the record must never say
 *   the manager decided what he did not.
 */
export function excuseAdminDecisionColumns(input: {
  adminHrId: string | null;
  current: ExcuseAdminCurrent;
  next: ExcuseAdminChange;
  now: string;
}): Record<string, string | null> {
  const { current, next } = input;
  if (next.status === "pending_manager") {
    return {
      manager_decision: null,
      manager_decision_at: null,
      manager_decision_by_hr_id: null,
      manager_decision_comment: null,
      status: "pending_manager",
    };
  }
  if (next.status === current.status) {
    return { manager_decision_comment: next.reply, status: next.status };
  }
  return {
    manager_decision: next.status,
    manager_decision_at: input.now,
    manager_decision_by_hr_id: input.adminHrId,
    manager_decision_comment: next.reply,
    status: next.status,
  };
}

/**
 * Why an admin edit is refused before anything is written, or null when it may go ahead.
 * `ownRequest` — the Super Admin may correct his own request's date or half, never its status:
 * changing it would be deciding his own excuse.
 */
export function excuseAdminEditRefusal(input: {
  current: ExcuseAdminCurrent;
  next: ExcuseAdminChange;
  ownRequest: boolean;
}): string | null {
  const { current, next } = input;
  const unchanged =
    current.excuseDate === next.excuseDate &&
    current.excuseType === next.excuseType &&
    current.status === next.status &&
    (current.managerDecisionComment ?? null) === (next.status === "pending_manager" ? current.managerDecisionComment ?? null : next.reply);
  if (unchanged) return "Nothing was changed.";
  if (input.ownRequest && next.status !== current.status) {
    return "Forbidden: you cannot change the status of your own excuse request.";
  }
  if (next.status === "returned_to_employee" && !next.reply) {
    return "A reply to the employee is required when an excuse is returned.";
  }
  return null;
}
