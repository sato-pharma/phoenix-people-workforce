/**
 * Phoenix CRM — the Super Admin corrects a visit a rep submitted: who was on it, its products, its comment.
 *
 * Owner, 2026-10-06 — "make the admin able to edit a visit submitted by an employee. Example, if he
 * chooses a wrong double visit, make me able to enter and edit it." The rules are pure and live in
 * `@/lib/phoenix-crm/visit-edit-rules` and `@/lib/phoenix-crm/visit-company`; this file is their I/O.
 *
 * 🔴 THE PEOPLE ARE RE-CHECKED HERE, NEVER TRUSTED FROM THE SCREEN. A manager is checked against the
 * territory's own chain and a product manager against the line's own list (`loadLineProductManagers`),
 * exactly as the rep's own save checks them (`resolveVisitParticipants`) — the Super Admin gets no
 * wider list than the rep had, and a visit can never be filed with somebody the territory does not have.
 *
 * 🔴 AND A VISIT WHOSE WHO HE DID NOT TOUCH IS NOT RE-CHECKED AT ALL. `who` is null on the wire when he
 * only corrected the comment, so a manager who has since left the territory's chain cannot make a typo
 * in a comment unfixable.
 *
 * 🔴 IT NEVER TOUCHES THE CUSTOMER, THE DAY, THE TIME, THE LOCATION, THE PHOTO OR THE VOICE NOTE, and it
 * notifies nobody (Golden Rule #1): `phoenix_crm_admin_edit_visit` updates exactly three things, after
 * keeping what they said before.
 */

import { notFoundError, validationError } from "@/lib/http/api-errors";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import { managerChain, personKey, resolveVisitParticipants, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { readTestFlag, territoryForVisitEdit, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm, textOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { lineProductsByFamily } from "@/lib/phoenix-crm/server/products";
import { seatTierTitle } from "@/lib/phoenix-crm/server/territory";
import { loadLineProductManagers } from "@/lib/phoenix-crm/server/visit-asks";
import { loadVisitCompanionIds } from "@/lib/phoenix-crm/server/visit-companions";
import type { PhoenixCrmVisitKind } from "@/lib/phoenix-crm/types";
import { companyFromStorage, companyToStorage, type CompanyOffer, type VisitCompanyChoice } from "@/lib/phoenix-crm/visit-company";
import { parseVisitEdit, visitWhoEditable } from "@/lib/phoenix-crm/visit-edit-rules";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

function record(raw: unknown): Row {
  return (raw && typeof raw === "object" ? raw : {}) as Row;
}

// ── The form ────────────────────────────────────────────────────────────────────────────────────

/** One person the picker offers: a manager above the territory, or one of the line's product managers. */
export type VisitEditPerson = {
  hrId: string;
  name: string;
  /** A manager's title in the organogram; a product manager's app role — the tree has no seat for him. */
  title: string;
  role: "manager" | "product_manager";
  /** A manager's place above the territory, nearest first; null for a product manager. */
  position: number | null;
};

export type VisitEditForm = {
  visitId: string;
  customerName: string;
  visitDate: string;
  /** Everyone on the visit as it stands, the rep first — read aloud above the picker. */
  onTheVisit: Array<{ name: string; title: string | null }>;
  /** The choice the stored visit reads as, and who is ticked: what the picker opens on. */
  current: { choice: VisitCompanyChoice; picked: string[] };
  /** False when who was on the visit stays as recorded, with the sentence that says why. */
  whoEditable: boolean;
  whoBlockedReason: string | null;
  people: VisitEditPerson[];
  /** The line's products, plus any the visit already carries that the line no longer lists. */
  products: string[];
  chosenProducts: string[];
  comment: string;
};

export type SavedVisitEdit = { visitId: string; changed: boolean };

const VISIT_COLUMNS =
  "id, seat_id, is_test, visit_date, kind, rep_hr_id, manager_hr_id, senior_hr_id, product_manager_hr_id, entered_by_hr_id, " +
  "capture_source, products, comment, customer:phoenix_crm_customers!customer_id(name)";

function kindOf(value: unknown): PhoenixCrmVisitKind {
  return value === "double" || value === "chain" || value === "product_manager" ? value : "single";
}

async function readVisit(seatId: string, visitId: unknown, isTest: boolean): Promise<Row> {
  if (!isUuid(visitId)) throw validationError("Reload the page and try again.");
  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_visits")
    .select(VISIT_COLUMNS)
    .eq("id", String(visitId).toLowerCase())
    .eq("seat_id", seatId)
    .eq("is_test", isTest)
    .maybeSingle();
  throwIfError(error);
  if (!data) throw notFoundError("This visit is no longer there. Reload the page.");
  return record(data);
}

/**
 * Who the picker offers for one territory — the SAME two lists the rep's own form offers: the occupied
 * manager seats above the territory (district, regional where the line has one, national), and the
 * product side of the territory's line (product, group product, training). Shared with the Super
 * Admin's missed-visit entry, so the three doors never offer different people.
 */
export async function loadVisitCompanyOffers(
  viewer: PhoenixCrmViewer,
  seat: OrgSeat,
): Promise<{ people: VisitEditPerson[]; offers: CompanyOffer[]; productManagers: Array<{ hrId: string }> }> {
  const chain = managerChain(viewer.org, seat.seatId);
  const productManagers = await loadLineProductManagers(seat);
  const names = await loadPeopleNames([...chain.map((member) => member.hrId), ...productManagers.map((manager) => manager.hrId)]);
  const people: VisitEditPerson[] = [
    ...chain.map((member) => ({
      hrId: member.hrId,
      name: nameOf(names, member.hrId),
      title: seatTierTitle(member.seat.tier),
      role: "manager" as const,
      position: member.position,
    })),
    ...productManagers.map((manager) => ({
      hrId: manager.hrId,
      name: nameOf(names, manager.hrId),
      title: manager.role,
      role: "product_manager" as const,
      position: null,
    })),
  ];
  return {
    people,
    offers: people.map((person) => ({ hrId: person.hrId, role: person.role, position: person.position })),
    productManagers,
  };
}

export async function loadVisitEditForm(viewer: PhoenixCrmViewer, raw: { seatId: unknown; visitId: unknown; test: unknown }): Promise<VisitEditForm> {
  const { seat, isTest } = territoryForVisitEdit(viewer, raw.seatId, readTestFlag(raw.test));
  const visit = await readVisit(seat.seatId, raw.visitId, isTest);

  const kind = kindOf(visit.kind);
  const slots = {
    kind,
    managerHrId: textOrNull(visit.manager_hr_id),
    seniorHrId: textOrNull(visit.senior_hr_id),
    productManagerHrId: textOrNull(visit.product_manager_hr_id),
  };
  const [{ people }, families, companionIds] = await Promise.all([
    loadVisitCompanyOffers(viewer, seat),
    lineProductsByFamily(seat.lineName),
    loadVisitCompanionIds([String(visit.id)]),
  ]);
  const companionHrIds = companionIds.get(String(visit.id)) ?? [];

  // Everyone on the visit as it stands, by name — including a person the picker no longer offers.
  const onIds = [
    ...new Set(
      [textOrNull(visit.rep_hr_id), slots.managerHrId, slots.seniorHrId, slots.productManagerHrId, ...companionHrIds]
        .map((id) => personKey(id))
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const names = await loadPeopleNames(onIds);
  const titleOf = (hrId: string): string | null => {
    const key = personKey(hrId);
    return people.find((person) => personKey(person.hrId) === key)?.title ?? null;
  };
  const rep = personKey(textOrNull(visit.rep_hr_id));

  const editable = visitWhoEditable({
    repHrId: rep,
    enteredByHrId: textOrNull(visit.entered_by_hr_id),
    captureSource: textOrNull(visit.capture_source),
  });
  const company = companyFromStorage({ ...slots, companionHrIds });
  const chosenProducts = Array.isArray(visit.products) ? visit.products.map(String) : [];
  const line = families.map((entry) => entry.family);

  return {
    visitId: String(visit.id),
    customerName: textOrNull(record(visit.customer).name) ?? "Customer",
    visitDate: String(visit.visit_date),
    onTheVisit: onIds.map((hrId) => ({ name: nameOf(names, hrId), title: hrId === rep ? "Medical Representative" : titleOf(hrId) })),
    // Only the people the picker still offers are ticked, so it never opens on someone it cannot show.
    current: { choice: company.choice, picked: company.picked.filter((hrId) => people.some((person) => personKey(person.hrId) === personKey(hrId))) },
    whoEditable: editable.editable,
    whoBlockedReason: editable.editable ? null : editable.reason,
    people,
    products: [...line, ...chosenProducts.filter((product) => !line.includes(product))],
    chosenProducts,
    comment: textOrNull(visit.comment) ?? "",
  };
}

// ── Saving the correction ───────────────────────────────────────────────────────────────────────

export async function saveVisitEdit(viewer: PhoenixCrmViewer, raw: unknown): Promise<SavedVisitEdit> {
  const body = record(raw);
  const { seat, isTest } = territoryForVisitEdit(viewer, body.seatId, readTestFlag(body.test));
  const parsed = parseVisitEdit(body);
  if (!parsed.ok) throw validationError(parsed.error);
  const entry = parsed.value;

  const visit = await readVisit(seat.seatId, entry.visitId, isTest);
  const current = Array.isArray(visit.products) ? visit.products.map(String) : [];

  // The products come from the line's own list, as on a rep's visit — plus the ones the visit already
  // carries, so a family the line has since dropped never makes a typo in the comment unfixable.
  const families = await lineProductsByFamily(seat.lineName);
  const allowed = new Set([...families.map((family) => family.family), ...current]);
  if (entry.products.some((product) => !allowed.has(product))) {
    throw validationError("Choose the products discussed from the line's products. Reload the page.");
  }

  // Who was on the visit: only when he changed it, and then through the SAME resolver the rep's own save
  // uses, with the rep as the actor, so the territory's chain and the line's list are the whole truth.
  let slots: {
    kind: PhoenixCrmVisitKind;
    managerHrId: string | null;
    seniorHrId: string | null;
    productManagerHrId: string | null;
    companions: Array<{ hrId: string; side: "manager" | "product" }>;
  } | null = null;
  if (entry.who) {
    const editable = visitWhoEditable({
      repHrId: textOrNull(visit.rep_hr_id),
      enteredByHrId: textOrNull(visit.entered_by_hr_id),
      captureSource: textOrNull(visit.capture_source),
    });
    if (!editable.editable) throw validationError(editable.reason);

    const { offers, productManagers } = await loadVisitCompanyOffers(viewer, seat);
    const stored = companyToStorage({ choice: entry.who.choice, picked: entry.who.picked, offers });
    if (!stored.ok) throw validationError(stored.error);
    const checked = resolveVisitParticipants({
      index: viewer.org,
      territorySeatId: seat.seatId,
      actorHrId: String(visit.rep_hr_id),
      enteredAs: "rep",
      kind: stored.value.kind,
      managerHrId: stored.value.managerHrId,
      seniorHrId: stored.value.seniorHrId,
      productManagerHrId: stored.value.productManagerHrId,
      productManagers,
      companions: stored.value.companions,
    });
    if (!checked.ok) throw validationError(checked.error);
    slots = {
      kind: stored.value.kind,
      managerHrId: checked.value.managerHrId,
      seniorHrId: checked.value.seniorHrId,
      productManagerHrId: checked.value.productManagerHrId,
      companions: checked.value.companions,
    };
  }

  const result = await callPhoenixCrm<Row>("phoenix_crm_admin_edit_visit", {
    p: {
      visit_id: entry.visitId,
      seat_id: seat.seatId,
      actor_hr_id: viewer.hrId,
      is_test: isTest,
      change_who: slots !== null,
      kind: slots?.kind ?? null,
      manager_hr_id: slots?.managerHrId ?? null,
      senior_hr_id: slots?.seniorHrId ?? null,
      product_manager_hr_id: slots?.productManagerHrId ?? null,
      // Everyone on the visit (2026-10-27); the database rewrites phoenix_crm_visit_companions from it.
      companions: slots ? slots.companions.map((person) => ({ hr_id: person.hrId, side: person.side })) : null,
      products: entry.products,
      comment: entry.comment,
    },
  });
  return { visitId: String(result.visit_id), changed: result.changed === true };
}
