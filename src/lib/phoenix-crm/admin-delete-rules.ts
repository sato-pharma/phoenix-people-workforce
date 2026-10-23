/**
 * Phoenix CRM — the Super Admin deletes a plan, a visit or a day record as if it never happened.
 *
 * Owner, 2026-10-23: "in every weekly plan, every visit, every record, for the admin only, make admin
 * tools — delete this record or this plan as if it did not happen."
 *
 * The one existing removal (`removeMissedVisit`) takes back only a visit the Super Admin entered himself.
 * This is the general tool: ANY rep plan, manager plan, visit or day record, whoever made it. The record
 * and everything that hung off it leave every screen and every figure; a copy is kept in
 * `phoenix_crm_admin_deletions` because production has no point-in-time recovery.
 *
 * Pure: no I/O. `server/admin-delete.ts` does the deleting; `components/phoenix-crm/admin-delete.tsx`
 * asks twice before it goes.
 */

import { isUuid } from "@/lib/phoenix-crm/plan-rules";

export const ADMIN_DELETE_KINDS = ["rep_plan", "manager_plan", "visit", "day_activity"] as const;
export type AdminDeleteKind = (typeof ADMIN_DELETE_KINDS)[number];

export function isAdminDeleteKind(value: unknown): value is AdminDeleteKind {
  return typeof value === "string" && (ADMIN_DELETE_KINDS as ReadonlyArray<string>).includes(value);
}

/** What each kind is called on the button and in the confirmation, and what its deletion takes with it. */
export const ADMIN_DELETE_WORDS: Record<AdminDeleteKind, { button: string; thing: string; takes: string }> = {
  rep_plan: {
    button: "Delete this plan",
    thing: "this weekly plan",
    takes: "Its days, customers, activities, review history and requests to edit go with it, and any notice about it is withdrawn.",
  },
  manager_plan: {
    button: "Delete this plan",
    thing: "this manager's weekly plan",
    takes: "Its half-days, customers, review history and requests to edit go with it, and any notice about it is withdrawn. The visits made against it stay.",
  },
  visit: {
    button: "Delete this visit",
    thing: "this visit",
    takes: "It leaves the rep's record and every figure, with its off-plan approval, correction history and recordings, and any notice about it is withdrawn.",
  },
  day_activity: {
    button: "Delete this record",
    thing: "this day record",
    takes: "It leaves the day and every screen that shows it.",
  },
};

export type AdminDeleteInput = { kind: AdminDeleteKind; id: string };
export type AdminDeleteParse = { ok: true; value: AdminDeleteInput } | { ok: false; error: string };

export function parseAdminDelete(raw: unknown): AdminDeleteParse {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (!isAdminDeleteKind(body.kind)) return { ok: false, error: "Choose what to delete. Reload the page and try again." };
  if (!isUuid(body.id)) return { ok: false, error: "This record could not be read. Reload the page and try again." };
  return { ok: true, value: { kind: body.kind, id: String(body.id).toLowerCase() } };
}
