/**
 * Doctor lists maintained in Phoenix — the pure rules (CRM phase 7).
 *
 * The owner's rule, 2026-09-14: "Rep asks, DM approves, SFE and system admin can edit, add or delete."
 * A rep asks for a change to his own AM or PM list; his nearest active manager, stored on the request,
 * approves or refuses it with his own click. The SFE Manager and the administrator apply a change
 * directly. Nothing here decides for anyone.
 *
 * IN FORCE PER REP, FROM HIS OWN TEAM'S PHOENIX CRM START (the live rule since 2026-10-04), or from a
 * global CRM cutover date if one is ever set. Before that, iReports360 still owns that rep's list and
 * the hourly contact refresh would undo a change the next morning — so the rule is not a formality.
 *
 * The windows handed in are the DOCTOR-LIST door's (`loadDoctorListRepWindows`), which since 2026-10-15
 * also covers a rep who holds a Phoenix CRM list and has no iReports360 account at all: no vendor pass
 * can reach him, so nothing would ever write his list and his droplist stayed empty. That is the mirror
 * of the rule below — a rep with no Phoenix list keeps his vendor list — and it moves nothing about who
 * is COUNTED from Phoenix CRM.
 *
 * Pure: no database, no clock. The service is contact-lists/service.ts.
 */

import { isOnOrAfterCrmCutover, type CrmCutoverSetting } from "@/lib/crm/cutover";
import { KNOWN_SP_SPECIALITIES, isPharmacySpeciality } from "@/lib/crm/contact-taxonomy";
import { startedWindowCovers, type StartedRepWindow } from "@/lib/crm/phoenix-team-starts";

export const CONTACT_LIST_REASON_MAX = 1000;
export const CONTACT_LIST_NOTE_MAX = 500;
export const CONTACT_LIST_NAME_MAX = 200;
export const CONTACT_LIST_ADDRESS_MAX = 500;

export type ContactListAction = "add" | "remove" | "regrade";
/** A pharmacy is not a contact: AM and PM lists only. */
export type ContactListShift = "AM" | "PM";
export type ContactListGrade = "A" | "B" | "C";
export type ContactListChangeStatus = "pending" | "approved" | "rejected" | "cancelled";
export type ContactListDecision = "approved" | "rejected";

export const CONTACT_LIST_SHIFTS: readonly ContactListShift[] = ["AM", "PM"];
export const CONTACT_LIST_GRADES: readonly ContactListGrade[] = ["A", "B", "C"];

export const CONTACT_LIST_NOT_IN_FORCE_MESSAGE =
  "Doctor lists still come from iReports360 until the CRM cutover date. Changes open on that day.";

/**
 * What someone is told about a rep whose team is still counted from iReports360. The sentence the
 * DATABASE raises verbatim, so the screen and the refusal behind it can never say different things.
 *
 * NEUTRAL, like everything this app shows anybody (tests/neutral-wording.test.ts). The database's own
 * copy said "his team" until 2026-10-06, and it reaches the screen as a conflict message — it was
 * unreachable only because the service refused first, which is the gate this change removed.
 */
export const CONTACT_LIST_TEAM_NOT_STARTED_MESSAGE =
  "Doctor lists for this rep still come from iReports360 — their team has not started in Phoenix CRM yet.";

export function parseContactListAction(value: unknown): ContactListAction | null {
  return value === "add" || value === "remove" || value === "regrade" ? value : null;
}

export function parseContactListShift(value: unknown): ContactListShift | null {
  return value === "AM" || value === "PM" ? value : null;
}

export function parseContactListGrade(value: unknown): ContactListGrade | null {
  const folded = String(value ?? "").trim().toUpperCase();
  return folded === "A" || folded === "B" || folded === "C" ? folded : null;
}

export function parseContactListDecision(value: unknown): ContactListDecision | null {
  return value === "approved" || value === "rejected" ? value : null;
}

/** Changes open on the cutover date itself, and never while no date is set. */
export function contactListChangesInForce(setting: CrmCutoverSetting, cairoToday: string): boolean {
  return isOnOrAfterCrmCutover(setting, cairoToday);
}

export type DoctorListOwnership = {
  cairoToday: string;
  cutover: CrmCutoverSetting;
  rep: { crmId: number | null | undefined; hrId: string | null | undefined };
  windows: readonly StartedRepWindow[];
};

/**
 * Whether ONE rep's doctor list is Phoenix's today. THE rule — the rep's request, the manager's
 * approval, the SFE Manager's direct edit and the screen all ask this one function, and it is the same
 * rule `crm_contact_list_change_apply` applies in SQL as `v_phoenix_owns`.
 *
 * TWO PATHS, either enough: his own TEAM has started in Phoenix CRM (the live one — Delta (1) from
 * Saturday 3 October 2026), or a global CRM cutover date has passed (kept so a future global cutover
 * still works). The team path is what the database learned on 2026-10-04; until 2026-10-06 this file
 * asked only the global one, and with `crm_cutover.cutover_date` NULL on production that refused every
 * change for everyone — `crm_contact_list_changes` held 0 rows and had never held one. The SFE
 * Manager's direct edit, the owner's rule since 2026-09-14, could not be made at all.
 *
 * The rep is matched on his HR id, falling back to his CRM account only when he has no HR id on the
 * row — the same two legs, in the same order, as the SQL.
 */
export function doctorListOwnedByPhoenix(ownership: DoctorListOwnership): boolean {
  return (
    startedWindowCovers(ownership.windows, ownership.rep, ownership.cairoToday) ||
    contactListChangesInForce(ownership.cutover, ownership.cairoToday)
  );
}

/** Why this rep's list cannot be changed today, in his own words, or null when it can. */
export function doctorListRefusal(ownership: DoctorListOwnership): string | null {
  if (doctorListOwnedByPhoenix(ownership)) return null;
  return ownership.cutover.cutoverDate ? CONTACT_LIST_NOT_IN_FORCE_MESSAGE : CONTACT_LIST_TEAM_NOT_STARTED_MESSAGE;
}

/** Whether ANY team is counted from Phoenix CRM today — what decides if the page is linked at all. */
export function anyDoctorListLive(windows: readonly StartedRepWindow[], cairoToday: string): boolean {
  return windows.some((window) => cairoToday >= window.from && (window.until === null || cairoToday < window.until));
}

/** The doctor specialities offered for a doctor first added in Phoenix, as people write them. */
export function contactListSpecialityOptions(): string[] {
  return KNOWN_SP_SPECIALITIES.map((value) =>
    value.length <= 4
      ? value.toUpperCase()
      : value.replace(/\b\w/g, (letter) => letter.toUpperCase()),
  ).sort((left, right) => left.localeCompare(right));
}

export type ContactListChangeInput = {
  action: ContactListAction | null;
  listType: ContactListShift | null;
  /** A doctor already known to Phoenix. */
  contactCrmId: number | null;
  /** A doctor first added in Phoenix: only for an add, and only without a contact id. */
  newContact: { name: string; speciality: string; address: string } | null;
  grade: ContactListGrade | null;
  reason: string;
};

/** Why the change as typed cannot be sent, or null. Checks the shape only, not the list. */
export function contactListChangeRefusal(input: ContactListChangeInput): string | null {
  if (!input.action) return "Choose whether to add a doctor, remove one or change a grade.";
  if (!input.listType) return "Choose the AM or the PM list.";
  const reason = input.reason.trim();
  if (!reason) return "Say why the list should change.";
  if (reason.length > CONTACT_LIST_REASON_MAX) return `Keep the reason under ${CONTACT_LIST_REASON_MAX} characters.`;

  const hasContact = input.contactCrmId != null;
  if (hasContact && (!Number.isInteger(input.contactCrmId) || (input.contactCrmId ?? 0) <= 0 || input.contactCrmId === 100000)) {
    return "Choose a doctor from the search.";
  }

  if (input.action === "add") {
    if (!input.grade) return "Choose the doctor's grade.";
    if (hasContact && input.newContact) return "Choose a doctor from the search or describe a new one, not both.";
    if (!hasContact) {
      if (!input.newContact) return "Choose a doctor from the search, or describe a new one.";
      const name = input.newContact.name.trim();
      const speciality = input.newContact.speciality.trim();
      if (!name) return "Type the new doctor's name.";
      if (name.length > CONTACT_LIST_NAME_MAX) return `Keep the name under ${CONTACT_LIST_NAME_MAX} characters.`;
      if (!speciality) return "Choose the new doctor's speciality.";
      if (isPharmacySpeciality(speciality)) return "A pharmacy is not a contact, so it cannot go on a doctor list.";
      if (!contactListSpecialityOptions().some((option) => option.toLowerCase() === speciality.toLowerCase())) {
        return "Choose the speciality from the list.";
      }
      if (input.newContact.address.trim().length > CONTACT_LIST_ADDRESS_MAX) {
        return `Keep the address under ${CONTACT_LIST_ADDRESS_MAX} characters.`;
      }
    }
    return null;
  }

  if (!hasContact) return "Choose the doctor on the list.";
  if (input.newContact) return "Only a new doctor being added is described by hand.";
  if (input.action === "regrade" && !input.grade) return "Choose the new grade.";
  if (input.action === "remove" && input.grade) return "A removal carries no grade.";
  return null;
}

/** Why the change does not fit the rep's list as it stands today, or null. */
export function contactListStateRefusal(input: {
  action: ContactListAction;
  onList: boolean;
  currentGrade: string | null;
  newGrade: ContactListGrade | null;
  contactSpeciality: string | null;
}): string | null {
  if (input.action === "add") {
    if (isPharmacySpeciality(input.contactSpeciality)) return "A pharmacy is not a contact, so it cannot go on a doctor list.";
    return input.onList ? "That doctor is already on this list." : null;
  }
  if (!input.onList) return "That doctor is not on this list any more.";
  if (input.action === "regrade" && (input.currentGrade ?? "").toUpperCase() === input.newGrade) {
    return "That doctor already has this grade.";
  }
  return null;
}

/**
 * Why this viewer may not decide this request, or null. Only the manager the request was sent to
 * decides it, for a rep beneath him, once, and never his own. A refusal says why.
 */
export function contactListDecisionRefusal(input: {
  viewerHrKey: string | null;
  repHrKey: string;
  managerHrKey: string | null;
  direct: boolean;
  status: ContactListChangeStatus;
  repInViewerScope: boolean;
  decision: ContactListDecision;
  note: string | null;
}): string | null {
  if (!input.viewerHrKey) return "you need an employee record to answer.";
  if (input.direct || !input.managerHrKey) return "this change was applied directly and needs no answer.";
  if (input.status !== "pending") return "this change has already been decided or withdrawn.";
  if (input.viewerHrKey === input.repHrKey) return "nobody answers their own request.";
  if (input.viewerHrKey !== input.managerHrKey) return "only the manager this request was sent to can answer it.";
  if (!input.repInViewerScope) return "this rep is not beneath you.";
  if (input.decision === "rejected" && !(input.note ?? "").trim()) return "say why you are refusing.";
  if ((input.note ?? "").length > CONTACT_LIST_NOTE_MAX) return `keep the note under ${CONTACT_LIST_NOTE_MAX} characters.`;
  return null;
}

export function contactListActionLabel(action: ContactListAction): string {
  if (action === "add") return "Add";
  if (action === "remove") return "Remove";
  return "Change grade";
}

export function contactListStatusLabel(status: ContactListChangeStatus, direct: boolean): string {
  if (status === "approved") return direct ? "Applied" : "Approved: on the list";
  if (status === "rejected") return "Refused";
  if (status === "cancelled") return "Withdrawn";
  return "Waiting for the manager";
}
