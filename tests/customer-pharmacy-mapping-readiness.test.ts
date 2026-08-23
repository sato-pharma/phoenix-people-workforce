import assert from "node:assert/strict";

import {
  DESK_VALIDATION_MARKER,
  INFERRED_HISTORY_MARKER,
  buildCustomerPharmacyReadiness,
  isDeskValidated,
  isInferredFromHistory,
  isNotFieldValidated,
  type BuildCustomerPharmacyReadinessInput,
  type CustomerPharmacyReadinessRow,
  type CustomerPharmacyValidationStatus,
  type ReadinessCustomerInput,
  type ReadinessLinkInput,
} from "@/lib/customer-pharmacy-mapping/readiness.ts";

function customer(
  id: string,
  name: string,
  opts: Partial<Omit<ReadinessCustomerInput, "id" | "customerName">> = {},
): ReadinessCustomerInput {
  return {
    id,
    customerName: name,
    customerCode: opts.customerCode ?? null,
    customerType: opts.customerType ?? null,
    areaName: opts.areaName ?? null,
    governorateName: opts.governorateName ?? null,
  };
}

function link(
  id: string,
  customerId: string,
  status: CustomerPharmacyValidationStatus,
  opts: Partial<Pick<ReadinessLinkInput, "pharmacyId" | "distributorCodeId" | "validationNotes">> = {},
): ReadinessLinkInput {
  return {
    linkId: id,
    customerId,
    pharmacyId: opts.pharmacyId ?? `ph-${id}`,
    distributorCodeId: opts.distributorCodeId ?? `dc-${id}`,
    validationStatus: status,
    validationNotes: opts.validationNotes ?? null,
  };
}

function rowById(rows: CustomerPharmacyReadinessRow[], id: string): CustomerPharmacyReadinessRow {
  const found = rows.find((row) => row.customerId === id);
  assert.ok(found, `expected a readiness row for customer ${id}`);
  return found;
}

const APPROVED_INFERRED_NOTE =
  "Inferred from approved historical marketing requests — not GPS field-validated. Backfill script 2026-07-02.";
const REJECTED_INFERRED_NOTE =
  "Inferred from pending/rejected historical marketing requests — not GPS field-validated. Backfill script 2026-07-02.";
// The shape a desk validation actually writes in production, with the people's names taken out.
const DESK_NOTE =
  "Validated at the desk by an admin on behalf of a rep. Location chosen from map search — no field GPS or live photo.";

export async function runCustomerPharmacyMappingReadinessTests() {
  // ── isInferredFromHistory ─────────────────────────────────────────────────────
  assert.equal(isInferredFromHistory(APPROVED_INFERRED_NOTE), true, "approved backfill note is inferred");
  assert.equal(isInferredFromHistory(REJECTED_INFERRED_NOTE), true, "rejected backfill note is inferred");
  assert.equal(isInferredFromHistory(`prefix ${INFERRED_HISTORY_MARKER} suffix`), true, "raw marker substring is inferred");
  assert.equal(isInferredFromHistory("GPS field-validated on site by rep"), false, "GPS note is not inferred");
  assert.equal(isInferredFromHistory("Manually approved by SFE"), false, "manual note is not inferred");
  assert.equal(isInferredFromHistory(null), false, "null note is not inferred");
  assert.equal(isInferredFromHistory(undefined), false, "undefined note is not inferred");

  // ── isDeskValidated / isNotFieldValidated ──────────────────────────────────
  //
  // A desk validation says "no field GPS or live photo"; the backfill says "not GPS field-validated".
  // Different wording, same absence of evidence — and the two must stay SEPARATE, because the
  // Customer Pharmacy Mapping page's "Inferred" filter is about origin and would otherwise relabel
  // all 11 production desk links as backfill rows.
  assert.equal(isDeskValidated(DESK_NOTE), true, "the production desk note is a desk validation");
  assert.equal(isDeskValidated(`prefix ${DESK_VALIDATION_MARKER} suffix`), true, "raw desk marker substring is a desk validation");
  assert.equal(isDeskValidated(APPROVED_INFERRED_NOTE), false, "a backfill note is NOT a desk validation");
  assert.equal(isDeskValidated(null), false, "null note is not a desk validation");
  assert.equal(isInferredFromHistory(DESK_NOTE), false, "a desk note must NOT read as backfill-inferred");
  assert.equal(isNotFieldValidated(DESK_NOTE), true, "a desk note carries no field evidence");
  assert.equal(isNotFieldValidated(APPROVED_INFERRED_NOTE), true, "a backfill note carries no field evidence");
  assert.equal(isNotFieldValidated("GPS field-validated on site by rep"), false, "a real capture IS field-validated");
  assert.equal(isNotFieldValidated(null), false, "a note-less link makes no claim either way");

  // ── Bucket calculation ─────────────────────────────────────────────────────────
  const bucketInput: BuildCustomerPharmacyReadinessInput = {
    customers: [
      customer("c-ready-system", "A Ready System"),
      customer("c-ready-sfe", "B Ready SFE"),
      customer("c-pending", "C Pending Only"),
      customer("c-rejected", "D Rejected Only"),
      customer("c-none", "E No Links"),
    ],
    links: [
      link("l1", "c-ready-system", "system_validated"),
      link("l2", "c-ready-system", "pending"),
      link("l3", "c-ready-sfe", "sfe_validated"),
      link("l4", "c-pending", "pending"),
      link("l5", "c-pending", "pending"),
      link("l6", "c-rejected", "rejected"),
      // c-none has no links
    ],
    pharmacies: [],
    distributorCodes: [],
    distributors: [],
  };

  const bucketResult = buildCustomerPharmacyReadiness(bucketInput);

  assert.equal(rowById(bucketResult.rows, "c-ready-system").bucket, "ready", "system_validated link ⇒ ready");
  assert.equal(rowById(bucketResult.rows, "c-ready-sfe").bucket, "ready", "sfe_validated link ⇒ ready");
  assert.equal(rowById(bucketResult.rows, "c-pending").bucket, "pending_only", "only pending links ⇒ pending_only");
  assert.equal(
    rowById(bucketResult.rows, "c-rejected").bucket,
    "pending_only",
    "rejected-only links ⇒ pending_only (links exist, none validated)",
  );
  assert.equal(rowById(bucketResult.rows, "c-none").bucket, "no_links", "zero links ⇒ no_links");

  // ── Per-customer counts ──────────────────────────────────────────────────────
  const mixInput: BuildCustomerPharmacyReadinessInput = {
    customers: [customer("c-mix", "Mixed Customer")],
    links: [
      link("m1", "c-mix", "system_validated"),
      link("m2", "c-mix", "sfe_validated"),
      link("m3", "c-mix", "pending"),
      link("m4", "c-mix", "rejected"),
      link("m5", "c-mix", "pending", { validationNotes: APPROVED_INFERRED_NOTE }),
    ],
    pharmacies: [],
    distributorCodes: [],
    distributors: [],
  };
  const mixRow = rowById(buildCustomerPharmacyReadiness(mixInput).rows, "c-mix");
  assert.equal(mixRow.totalLinkCount, 5, "total link count");
  assert.equal(mixRow.validatedLinkCount, 2, "validated = system_validated + sfe_validated");
  assert.equal(mixRow.pendingLinkCount, 2, "pending = pending statuses (not rejected)");
  assert.equal(mixRow.rejectedLinkCount, 1, "rejected counted separately");
  assert.equal(mixRow.inferredLinkCount, 1, "one inferred link detected via notes");
  assert.equal(mixRow.bucket, "ready", "any validated link ⇒ ready even with a mix");

  // ── Display resolution via lookup maps + fallbacks ───────────────────────────
  const displayInput: BuildCustomerPharmacyReadinessInput = {
    customers: [customer("c-disp", "Display Customer")],
    links: [
      link("d1", "c-disp", "system_validated", { pharmacyId: "ph-1", distributorCodeId: "dc-1" }),
      link("d2", "c-disp", "pending", { pharmacyId: "ph-missing", distributorCodeId: "dc-missing" }),
    ],
    pharmacies: [{ id: "ph-1", pharmacyCode: "PH001", pharmacyName: "Nile Pharmacy" }],
    distributorCodes: [{ id: "dc-1", distributorId: 7, distributorPharmacyCode: "DPC-77" }],
    distributors: [{ id: 7, name: "Ibnsina" }],
  };
  const dispRow = rowById(buildCustomerPharmacyReadiness(displayInput).rows, "c-disp");
  const resolved = dispRow.links.find((l) => l.linkId === "d1");
  const fallback = dispRow.links.find((l) => l.linkId === "d2");
  assert.ok(resolved && fallback, "both links present");
  assert.equal(resolved.pharmacyName, "Nile Pharmacy", "pharmacy name resolved");
  assert.equal(resolved.pharmacyCode, "PH001", "pharmacy code resolved");
  assert.equal(resolved.distributorName, "Ibnsina", "distributor name resolved");
  assert.equal(resolved.distributorPharmacyCode, "DPC-77", "distributor pharmacy code resolved");
  assert.equal(resolved.distributorId, 7, "distributor id resolved");
  assert.equal(fallback.pharmacyName, "Unknown pharmacy", "missing pharmacy falls back");
  assert.equal(fallback.distributorName, "Unknown distributor", "missing distributor falls back");
  assert.equal(fallback.distributorId, null, "missing distributor code ⇒ null distributor id");

  // ── Summary aggregation + sorting ────────────────────────────────────────────
  const summaryResult = buildCustomerPharmacyReadiness(bucketInput);
  assert.equal(summaryResult.summary.ready, 2, "summary ready count");
  assert.equal(summaryResult.summary.pendingOnly, 2, "summary pendingOnly count (pending + rejected-only)");
  assert.equal(summaryResult.summary.noLinks, 1, "summary noLinks count");
  assert.equal(summaryResult.summary.total, 5, "summary total count");
  assert.equal(summaryResult.summary.inferredCustomers, 0, "no inferred links in bucket scenario");
  assert.deepEqual(
    summaryResult.rows.map((row) => row.customerName),
    ["A Ready System", "B Ready SFE", "C Pending Only", "D Rejected Only", "E No Links"],
    "rows sorted by customer name",
  );

  // inferredCustomers counts customers with ≥1 inferred link
  const inferredSummary = buildCustomerPharmacyReadiness({
    customers: [customer("c-inf", "Inferred Cust"), customer("c-plain", "Plain Cust")],
    links: [
      link("i1", "c-inf", "pending", { validationNotes: REJECTED_INFERRED_NOTE }),
      link("i2", "c-inf", "system_validated"),
      link("p1", "c-plain", "pending"),
    ],
    pharmacies: [],
    distributorCodes: [],
    distributors: [],
  }).summary;
  assert.equal(inferredSummary.inferredCustomers, 1, "exactly one customer has inferred links");
}
