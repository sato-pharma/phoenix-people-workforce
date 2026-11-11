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

import { isPharmacyListType } from "@/lib/phoenix-crm/pharmacy-call-rules";
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

// ── Returned to the rep for a comment (owner, 2026-10-12) ────────────────────────────────────────
//
// SFE can send a waiting request back to the rep to explain. It stays pending, its stored stage is
// 'rep' (the rep owes the next move), and when the rep answers it goes STRAIGHT BACK to SFE at the step
// it was returned from — never through the district manager again. The database is the authority
// (`phoenix_crm_return_request`, `phoenix_crm_answer_request`); this is what each screen offers.

/** The stored stage of a request that is with the rep. It is never a step anybody DECIDES. */
export const WITH_REP_STAGE = "rep";

/** What the pill says while the request is with the rep, on SFE's screen and the rep's alike. */
export const WITH_REP_LABEL = "Waiting for the rep's comment";

export const RETURN_NOTE_MAX = 500;
export const RETURN_NOTE_REQUIRED = "Write what you want the rep to explain.";
export const RETURN_REPLY_REQUIRED = "Write your comment before sending it.";

export function isWithRep(storedStage: unknown): boolean {
  return storedStage === WITH_REP_STAGE;
}

/**
 * The step a request returns to once the rep has answered: SFE's, for a drop, an add or a bring-back;
 * none for a grade change, which is one step and has no stage. Mirrors `phoenix_crm_answer_request`.
 */
export function stageAfterReply(kind: PhoenixCrmRequestKind): PhoenixCrmRequestStage | null {
  return kind === "grade" ? null : "sfe";
}

/**
 * Whether the viewer may return this request for a comment: only the step SFE holds, and only by someone
 * who decides it. That is the second step of a two-step kind, or a grade change on a territory with no
 * district manager at all (the only time SFE decides one). Never the district manager's own step, never a
 * request already with the rep, never one that is decided.
 */
export function canReturnForComment(request: {
  kind: PhoenixCrmRequestKind;
  status: string;
  /** The stage the request is ON (null for a grade change), as `isRequestStage` reads it. */
  stage: PhoenixCrmRequestStage | null;
  withRep: boolean;
  canDecide: boolean;
  /** The territory has a reviewing district manager. */
  hasReviewer: boolean;
}): boolean {
  if (request.status !== "pending" || request.withRep || !request.canDecide) return false;
  if (request.kind === "grade") return request.stage === null && !request.hasReviewer;
  return request.stage === "sfe";
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
  /**
   * The Google Maps check on his place (2026-10-03). While it is `checking` the place is already
   * captured, so there is nothing to validate — the row offers Open, never a second Validate.
   */
  locationCheck?: "checking" | "not_confirmed" | null;
  /** AM, PM or Pharmacy, as stored. Only a pharmacy changes anything here (`awaitsValidation`). */
  listType?: unknown;
};

/**
 * Whether the customer is waiting to be validated at the door.
 *
 * 🔴 NEVER A PHARMACY (owner, 2026-10-03: "Pharmacy don't need a validation. It is visit is logged
 * normally."). The pharmacies came in from iReports360 as `pending` like the doctors — 568 of 570 were
 * still pending the day he ruled — and a pending row offered Validate and sat under To validate, so
 * the rep was asked for a signboard photo, a location and the hours of every pharmacy before its
 * visits counted. A pending pharmacy is simply on his list: Open, never Validate, under Your list.
 */
export function awaitsValidation(customer: Pick<ListCustomerFacts, "status" | "listType">): boolean {
  return customer.status === "pending" && !isPharmacyListType(customer.listType);
}

/** On the list and counting: validated, or a pharmacy, which needs no validation. */
export function onTheList(customer: Pick<ListCustomerFacts, "status" | "listType">): boolean {
  return customer.status === "active" || (customer.status === "pending" && !awaitsValidation(customer));
}

/** Never admitted: met outside the list, and not (yet) approved onto it. */
export function neverAdmitted(customer: ListCustomerFacts): boolean {
  return customer.origin === "new" && customer.validatedAt === null;
}

/**
 * The section of the List a customer sits in.
 *
 *   to_validate — carried over, waiting for the rep to validate him at the clinic;
 *   your_list   — validated, on the list — and every pharmacy he has not dropped, validated or not;
 *   outside     — met and validated at the door, waiting for the rep to ask to add him (or for the
 *                 district manager and SFE, once he has);
 *   archive     — dropped, frozen; the SFE manages it.
 */
export type ListSection = "to_validate" | "your_list" | "outside" | "archive";

export function listSectionOf(customer: ListCustomerFacts): ListSection {
  if (awaitsValidation(customer)) return "to_validate";
  if (onTheList(customer)) return "your_list";
  if (customer.status === "outside") return "outside";
  return "archive";
}

/**
 * Whether the person deciding THIS step of an add sets the customer's grade and his potential.
 *
 * It is the district manager's job (owner, 2026-09-29): he confirms or changes the rep's proposed A/B/C
 * and MUST set a potential grade, and the rep never sets either.
 *
 * 🔴 ON A TERRITORY WITH NO MANAGER AT ALL IT IS SFE'S (owner's pick, 2026-10-02). Such an add is filed
 * straight at the SFE step (`firstRequestStage`), and SFE's card offered a plain Approve — so the
 * customer was admitted on the REP's own proposal, with no potential grade at all, and the rule that a
 * rep never sets a grade quietly stopped holding on exactly the territories nobody is managing. The test
 * is not "the stage is sfe" but "the stage is sfe AND the manager's step was never taken": a normal add
 * that SFE sees second has already been graded by the district manager, and SFE must not re-grade it.
 */
export function setsAdmissionGrades(request: {
  kind: PhoenixCrmRequestKind;
  stage: PhoenixCrmRequestStage | null;
  /** The district manager's step, once taken — null while it never happened. */
  managerDecidedAt: string | null;
}): boolean {
  if (request.kind !== "add") return false;
  if (request.stage === "manager") return true;
  return request.stage === "sfe" && request.managerDecidedAt === null;
}

/** The one action a list row carries (owner, 2026-09-29: "Validate, or Open — nothing else"). */
export type ListRowAction = "validate" | "open";

export function listRowAction(customer: ListCustomerFacts): ListRowAction | null {
  if (awaitsValidation(customer)) return customer.locationCheck === "checking" ? "open" : "validate";
  if (onTheList(customer) || customer.status === "outside" || customer.status === "dropped") return "open";
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
  // A doctor the rep visited in iReports360 that Phoenix did not have (20261029212200).
  if (reason === "imported_history") return "Visited in the old system, not on your Phoenix list";
  return null;
}

/**
 * What the district manager and SFE read on an add whose name is already on the territory (sweep of 11 Nov 2026:
 * 47 same-seat pairs shared one name key, 5 of them both active and visited). The rep's "a different person" was
 * never saved and never reached them, so the card now says it from the list itself, by the database's own key.
 * Names only, never a code.
 */
export function sameNameOnSeatText(names: ReadonlyArray<string>): string {
  const listed = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${listed} ${names.length === 1 ? "is" : "are"} on this territory already, under the same name. Approve only if this is a different person; if it is the same one, refuse and say so.`;
}
