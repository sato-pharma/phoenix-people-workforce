/**
 * Phoenix CRM — the rep fills in his OWN saved visit's detail: the reading and the saving.
 *
 * Owner, 2026-10-15 — a rep walks from door to door and has no time between two of them for the
 * company's full report, so the visit is logged in one tap and the detail is written afterwards. The
 * rules are pure and live in `@/lib/phoenix-crm/visit-detail-edit-rules`; this file is their I/O.
 *
 * 🔴 THE GATE IS HIS OWN SEAT, NEVER THE DAY. `territoryForRepWrite` — the gate the rep's own
 * commitments read already uses — admits the territory's own rep and refuses the Super Admin by name.
 * It is NOT `territoryForVisitEdit`, which is the Super Admin alone and belongs to his separate
 * correction door (`server/visit-edit.ts`, owner 2026-10-06). There is no deadline: the owner was
 * asked and answered "any time", so nothing here reads a visit day.
 *
 * 🔴 THE READ NAMES NO MEASUREMENT AT ALL. `VISIT_COLUMNS` below simply never selects
 * `distance_meters`, `accuracy_meters`, `location_flag`, `capture_source` or `device_skew_minutes`,
 * exactly as `loadVisitEditForm` does it — a field the browser receives counts as shown, even where
 * React draws nothing from it (Golden Rule #1, `tests/phoenix-crm-blind-payloads.test.ts`).
 *
 * 🔴 IT NEVER TOUCHES THE EVIDENCE OR THE TWO SETTLED RULINGS: the customer, the day, the time, the
 * location, the photo and the voice note; AM/PM, which is the customer's own list; single/double/chain
 * and who was on it; and the products discussed. `phoenix_crm_edit_visit_detail` updates exactly the
 * six soft things, after keeping what they said before.
 *
 * 🔴 AND IT NOTIFIES NOBODY, in either direction: a rep completing his own report is not a check on
 * him, and his managers simply read the visit as it now stands.
 */

import { notFoundError, validationError } from "@/lib/http/api-errors";
import type { ProductAvailability } from "@/lib/phoenix-crm/entry-rules";
import { linkedPharmaciesNote, linkNamedPharmacies, type ListedPharmacy } from "@/lib/phoenix-crm/pharmacy-call-rules";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import { narrowSamplesToLine, type SamplesGiven } from "@/lib/phoenix-crm/samples";
import { readTestFlag, territoryForRepWrite, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm, textOrNull, throwIfError } from "@/lib/phoenix-crm/server/db";
import { loadListedPharmacies } from "@/lib/phoenix-crm/server/list";
import { lineProductsByFamily, type LineProductFamily } from "@/lib/phoenix-crm/server/products";
import { loadSeatPharmacies } from "@/lib/phoenix-crm/server/visits";
import {
  parseVisitDetailEdit,
  pharmacyNameAddable,
  visitDetailEditable,
} from "@/lib/phoenix-crm/visit-detail-edit-rules";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

function record(raw: unknown): Row {
  return (raw && typeof raw === "object" ? raw : {}) as Row;
}

// ── The form ────────────────────────────────────────────────────────────────────────────────────────

export type VisitDetailForm = {
  visitId: string;
  customerName: string;
  visitDate: string;
  capturedAt: string;
  /** False when this visit's detail is not his to fill in, with the one sentence that says why. */
  editable: boolean;
  blockedReason: string | null;
  /** What he wrote at the door, read aloud above the box and never editable here. */
  doorComment: string;
  detailComment: string;
  nextStep: string | null;
  nextStepOn: string | null;
  objection: string | null;
  objectionNote: string | null;
  samples: SamplesGiven;
  availability: Record<string, ProductAvailability>;
  /** The line's products grouped by family: the samples list, and the per-product stock check. */
  productFamilies: LineProductFamily[];
  /** The pharmacy already named on the visit. Shown, never editable — the name is add-only. */
  pharmacyName: string | null;
  /** False when no name may be added, with the sentence that says why. */
  pharmacyAddable: boolean;
  pharmacyBlockedReason: string | null;
  /** Names to suggest as he types. Empty whenever no name may be added. */
  pharmacies: string[];
  /** When he last changed the detail, for the "Edited · <date and time>" line. */
  detailEditedAt: string | null;
};

export type SavedVisitDetail = {
  visitId: string;
  changed: boolean;
  detailEditedAt: string | null;
  /** What became of a pharmacy he just named, in his own reading. Null when he named none. */
  pharmacyNote: string | null;
};

/**
 * Deliberately narrow, and the narrowness IS the blindness: every measurement on the row is absent
 * because it is never asked for. Add a column here only after asking whether the rep may see it.
 */
const VISIT_COLUMNS =
  "id, seat_id, is_test, visit_date, captured_at, list_type, rep_hr_id, linked_from_visit_id, imported_from_ireports360_at, " +
  "comment, detail_comment, detail_edited_at, pharmacy_name, product_availability, samples_given, " +
  "next_step, next_step_on, objection, objection_note, customer:phoenix_crm_customers!customer_id(name)";

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

function availabilityOf(raw: unknown): Record<string, ProductAvailability> {
  const out: Record<string, ProductAvailability> = {};
  for (const [product, answer] of Object.entries(record(raw))) {
    if (answer === "has" || answer === "missing") out[product] = answer;
  }
  return out;
}

function samplesOf(raw: unknown): SamplesGiven {
  const out: SamplesGiven = {};
  for (const [item, count] of Object.entries(record(raw))) {
    if (typeof count === "number" && Number.isFinite(count) && count > 0) out[item] = Math.round(count);
  }
  return out;
}

export async function loadVisitDetailForm(
  viewer: PhoenixCrmViewer,
  raw: { seatId: unknown; visitId: unknown; test: unknown },
): Promise<VisitDetailForm> {
  const { seat, isTest } = territoryForRepWrite(viewer, raw.seatId, readTestFlag(raw.test));
  const visit = await readVisit(seat.seatId, raw.visitId, isTest);

  const editable = visitDetailEditable({
    repHrId: textOrNull(visit.rep_hr_id),
    linkedFromVisitId: textOrNull(visit.linked_from_visit_id),
    actorHrId: viewer.hrId,
    importedAt: textOrNull(visit.imported_from_ireports360_at),
  });
  const pharmacy = pharmacyNameAddable({
    listType: String(visit.list_type ?? ""),
    pharmacyName: textOrNull(visit.pharmacy_name),
  });

  // The suggestions are read only when there is a name to add, so an edit of the stock answers alone
  // costs no extra query.
  const [productFamilies, pharmacies] = await Promise.all([
    lineProductsByFamily(seat.lineName),
    editable.editable && pharmacy.addable ? loadSeatPharmacies(seat.seatId, isTest) : Promise.resolve([] as string[]),
  ]);

  return {
    visitId: String(visit.id),
    customerName: textOrNull(record(visit.customer).name) ?? "Customer",
    visitDate: String(visit.visit_date),
    capturedAt: String(visit.captured_at),
    editable: editable.editable,
    blockedReason: editable.editable ? null : editable.reason,
    doorComment: textOrNull(visit.comment) ?? "",
    detailComment: textOrNull(visit.detail_comment) ?? "",
    nextStep: textOrNull(visit.next_step),
    nextStepOn: textOrNull(visit.next_step_on),
    objection: textOrNull(visit.objection),
    objectionNote: textOrNull(visit.objection_note),
    samples: samplesOf(visit.samples_given),
    availability: availabilityOf(visit.product_availability),
    productFamilies,
    pharmacyName: textOrNull(visit.pharmacy_name),
    pharmacyAddable: pharmacy.addable,
    pharmacyBlockedReason: pharmacy.addable ? null : pharmacy.reason,
    pharmacies,
    detailEditedAt: textOrNull(visit.detail_edited_at),
  };
}

// ── Saving the detail ───────────────────────────────────────────────────────────────────────────────

export async function saveVisitDetail(viewer: PhoenixCrmViewer, raw: unknown): Promise<SavedVisitDetail> {
  const body = record(raw);
  const { seat, isTest } = territoryForRepWrite(viewer, body.seatId, readTestFlag(body.test));
  const parsed = parseVisitDetailEdit(body);
  if (!parsed.ok) throw validationError(parsed.error);
  const entry = parsed.value;

  const visit = await readVisit(seat.seatId, entry.visitId, isTest);

  const editable = visitDetailEditable({
    repHrId: textOrNull(visit.rep_hr_id),
    linkedFromVisitId: textOrNull(visit.linked_from_visit_id),
    actorHrId: viewer.hrId,
    importedAt: textOrNull(visit.imported_from_ireports360_at),
  });
  if (!editable.editable) throw validationError(editable.reason);

  // ADD-ONLY (owner, 2026-10-15). Answered with a sentence rather than a silent drop: he would
  // otherwise believe he had changed the pharmacy his visit is filed against.
  const pharmacy = pharmacyNameAddable({
    listType: String(visit.list_type ?? ""),
    pharmacyName: textOrNull(visit.pharmacy_name),
  });
  if (entry.pharmacyName && !pharmacy.addable) throw validationError(pharmacy.reason);

  // Narrowed to the line's own products, exactly as `saveVisit` narrows them, and for the same reason:
  // a product dropped from the line since the panel loaded is quietly left out rather than blocking the
  // save. The stock answers are per PRODUCT (concentration), the samples per product or material.
  const productFamilies = await lineProductsByFamily(seat.lineName);
  const allowedProducts = new Set(productFamilies.flatMap((family) => family.products));
  const productAvailability: Record<string, ProductAvailability> = {};
  for (const [product, answer] of Object.entries(entry.productAvailability)) {
    if (allowedProducts.has(product)) productAvailability[product] = answer;
  }
  const samplesGiven = narrowSamplesToLine(entry.samplesGiven, allowedProducts);

  // The pharmacy he just named is a visit to that pharmacy too (owner, 2026-10-03): his list's
  // pharmacies decide WHICH, one box can name several, and each is matched on its own and sent in
  // `linked_pharmacies` — the same contract `saveVisit` already uses.
  const listedPharmacies: ListedPharmacy[] = entry.pharmacyName ? await loadListedPharmacies(seat.seatId, isTest) : [];
  const pharmacyLinks = linkNamedPharmacies(entry.pharmacyName, listedPharmacies);

  const result = await callPhoenixCrm<Row>("phoenix_crm_edit_visit_detail", {
    p: {
      visit_id: entry.visitId,
      seat_id: seat.seatId,
      actor_hr_id: viewer.hrId,
      is_test: isTest,
      detail_comment: entry.detailComment,
      next_step: entry.outcome.nextStep,
      next_step_on: entry.outcome.nextStepOn,
      objection: entry.outcome.objection,
      objection_note: entry.outcome.objectionNote,
      samples_given: samplesGiven,
      product_availability: productAvailability,
      pharmacy_name: entry.pharmacyName,
      linked_pharmacies: pharmacyLinks.map(({ name, link }) => ({
        name,
        id: link.kind === "existing" ? link.customerId : null,
        new: link.kind === "new",
      })),
    },
  });

  const filed = (Array.isArray(result.linked_pharmacies) ? result.linked_pharmacies : [])
    .filter((linked): linked is Row => Boolean(linked) && typeof linked === "object" && textOrNull((linked as Row).visit_id) !== null)
    .map((linked) => ({ name: textOrNull(linked.name) ?? "The pharmacy", created: linked.created === true }));

  return {
    visitId: String(result.visit_id),
    changed: result.changed === true,
    detailEditedAt: textOrNull(result.detail_edited_at),
    pharmacyNote: linkedPharmaciesNote(filed),
  };
}
