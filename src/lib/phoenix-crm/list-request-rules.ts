/**
 * Phoenix CRM — a customer's life on the rep's list, and the requests that move him, with no I/O.
 *
 * Owner, 2026-09-29 (the rep's flow rebuilt):
 *   - The list row has ONE action: Validate while the customer is not validated, Open once he is. There
 *     is no "Add visit" on the list — visits start from Visits, from Today, or from the portal's "+".
 *   - A rep never puts a customer on his own list. A customer he met outside it (an out-of-list visit,
 *     or "Add new customer") is validated at the door and then WAITS outside the list; the rep asks to
 *     add him, the district manager approves and sets the grade and the potential grade, then SFE.
 *   - Dropping a customer, and bringing one back from the Archive, take the same two steps.
 *   - A grade change stays one step, the district manager's.
 *
 *   iReports360 row ─▶ pending ──Validate──▶ active (on the list)
 *                                              └ Ask to drop ─▶ [manager ▶ SFE] ─▶ Archive
 *   Out of list / Add new customer (validated at the door) ─▶ outside
 *      ├ Request to add ─▶ [manager: A/B/C + potential ▶ SFE] ─▶ active
 *      └ Drop (the rep, no approval) ─▶ Archive
 *   Archive ─▶ Ask to bring back ─▶ [manager ▶ SFE] ─▶ active, or pending if never validated
 *            · a customer who was never admitted shows "Request to add" instead
 *
 * The database is the authority for every transition (phoenix_crm_create_request,
 * phoenix_crm_decide_request, phoenix_crm_archive_outside); this module only decides what each screen
 * offers, so a screen can never offer a step the database would refuse.
 */

import type {
  PhoenixCrmCustomerStatus,
  PhoenixCrmRequestKind,
  PhoenixCrmRequestStage,
} from "@/lib/phoenix-crm/types";

/** The kinds that go the district manager, then SFE. A grade is one step. */
export function isTwoStepKind(kind: PhoenixCrmRequestKind): boolean {
  return kind !== "grade";
}

/**
 * Where a two-step request starts: with the territory's own manager when it has one, else with SFE —
 * the same rule an off-plan visit's approval follows (`unplannedFirstStatus`).
 */
export function firstRequestStage(hasReviewer: boolean): PhoenixCrmRequestStage {
  return hasReviewer ? "manager" : "sfe";
}

/** The step after this one, or null when this one is the last. */
export function nextRequestStage(stage: PhoenixCrmRequestStage | null): PhoenixCrmRequestStage | null {
  return stage === "manager" ? "sfe" : null;
}

export function isRequestStage(value: unknown): value is PhoenixCrmRequestStage {
  return value === "manager" || value === "sfe";
}

/** What a waiting request says about where it is, in the rep's words and the manager's. */
export function requestStageLabel(stage: PhoenixCrmRequestStage | null): string | null {
  if (stage === "manager") return "Waiting for the district manager";
  if (stage === "sfe") return "Waiting for SFE";
  return null;
}

export function requestKindLabel(kind: PhoenixCrmRequestKind): string {
  if (kind === "grade") return "Grade change";
  if (kind === "drop") return "Drop from the list";
  if (kind === "add") return "Add to the list";
  return "Bring back to the list";
}

// ── The customer on the rep's list ──────────────────────────────────────────────────────────────

export type ListCustomerFacts = {
  status: PhoenixCrmCustomerStatus;
  origin: "reference" | "new";
  /** Set when the customer was validated AND admitted to the list; null otherwise. */
  validatedAt: string | null;
};

/** Never admitted: met outside the list, and not (yet) approved onto it. */
export function neverAdmitted(customer: ListCustomerFacts): boolean {
  return customer.origin === "new" && customer.validatedAt === null;
}

/**
 * The section of the List a customer sits in.
 *
 *   to_validate — carried over, waiting for the rep to validate him at the clinic;
 *   your_list   — validated, on the list;
 *   outside     — met and validated at the door, waiting for the rep to ask to add him (or for the
 *                 district manager and SFE, once he has);
 *   archive     — dropped, frozen; the SFE manages it.
 */
export type ListSection = "to_validate" | "your_list" | "outside" | "archive";

export function listSectionOf(customer: ListCustomerFacts): ListSection {
  if (customer.status === "pending") return "to_validate";
  if (customer.status === "active") return "your_list";
  if (customer.status === "outside") return "outside";
  return "archive";
}

/** The one action a list row carries (owner, 2026-09-29: "Validate, or Open — nothing else"). */
export type ListRowAction = "validate" | "open";

export function listRowAction(customer: ListCustomerFacts): ListRowAction | null {
  if (customer.status === "pending") return "validate";
  if (customer.status === "active" || customer.status === "outside" || customer.status === "dropped") return "open";
  return null;
}

/**
 * What the customer's own page offers the REP about the list itself.
 *
 * `waiting` is the kind of the two-step request already waiting on this customer, if any — a second
 * one of the same purpose is never offered while the first waits.
 */
export type ListMove = "request_add" | "drop_outside" | "ask_to_drop" | "ask_to_bring_back";

export function listMovesFor(customer: ListCustomerFacts, waiting: ReadonlySet<PhoenixCrmRequestKind>): ListMove[] {
  if (customer.status === "outside") {
    return waiting.has("add") ? [] : ["request_add", "drop_outside"];
  }
  if (customer.status === "active" || customer.status === "pending") {
    return waiting.has("drop") ? [] : ["ask_to_drop"];
  }
  if (customer.status === "dropped") {
    if (waiting.has("add") || waiting.has("restore")) return [];
    return neverAdmitted(customer) ? ["request_add"] : ["ask_to_bring_back"];
  }
  return [];
}

/** Why a customer is in the Archive, in the rep's words. */
export function archiveReasonLabel(reason: string | null): string | null {
  if (reason === "not_added") return "Dropped instead of added to your list";
  if (reason === "not_admitted") return "Adding this customer to your list was not approved";
  return null;
}
