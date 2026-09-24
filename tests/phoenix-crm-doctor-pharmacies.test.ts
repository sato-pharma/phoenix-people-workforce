import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { groupCustomerPharmacies, normalizePharmacyName, type PharmacyFeedback } from "../src/lib/phoenix-crm/server/list.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Phoenix CRM — the pharmacies a doctor's feedback came from.
//
// Owner, 2026-09-24, after the visit form began recording which pharmacy the rep took feedback from:
// "link doctors to their pharmacies next", and — asked how — "Both". So each doctor carries BOTH an
// auto-derived list of the pharmacies his own visits named, AND one the rep can pin as primary
// (primary_pharmacy_name on the customer row, set by phoenix_crm_set_primary_pharmacy).
//
// The derived list is the delicate half, because it is silent when it goes wrong — the screen keeps
// rendering and the pharmacies quietly split or merge. groupCustomerPharmacies is the pure core of
// loadCustomerPharmacies (the database read only shapes rows and calls it), so the grouping is pinned
// here without a database:
//
//   1. two spellings of one pharmacy that differ only in case or spacing are ONE pharmacy;
//   2. the display name and each product's Has/Doesn't-have answer are the MOST RECENT visit's;
//   3. the list is most-recent-first, and each doctor keeps his own pharmacies;
//   4. isPrimary is never decided here — the caller, which knows the pin, sets it.
// ─────────────────────────────────────────────────────────────────────────────

const LIST = "src/lib/phoenix-crm/server/list.ts";
const DOCTOR_A = "0b6f7a52-3c1d-4e8f-9a2b-5c6d7e8f9a0b";
const DOCTOR_B = "1c7f8b63-4d2e-5f90-ab3c-6d7e8f9a0b1c";

function feedback(over: Partial<PharmacyFeedback>): PharmacyFeedback {
  return { customerId: DOCTOR_A, pharmacyName: "El Ezaby", productAvailability: {}, capturedAt: "2026-09-01T09:00:00.000Z", ...over };
}

export function runPhoenixCrmDoctorPharmaciesTests() {
  // ── normalizePharmacyName folds case and collapses whitespace ─────────────────
  assert.equal(normalizePharmacyName("El Ezaby"), "el ezaby");
  assert.equal(normalizePharmacyName("  El   Ezaby  "), "el ezaby", "leading, trailing and repeated spaces collapse");
  assert.equal(normalizePharmacyName("EL EZABY"), normalizePharmacyName("el ezaby"), "case does not make a second pharmacy");

  // ── 1 + 2: case/spacing variants are one pharmacy; the latest visit wins ───────
  {
    const grouped = groupCustomerPharmacies([
      feedback({ pharmacyName: "el ezaby", productAvailability: { "Lacto Advanced": "has" }, capturedAt: "2026-09-01T09:00:00.000Z" }),
      feedback({ pharmacyName: "El  Ezaby", productAvailability: { "Lacto Advanced": "missing" }, capturedAt: "2026-09-10T09:00:00.000Z" }),
    ]);
    const pharmacies = grouped.get(DOCTOR_A) ?? [];
    assert.equal(pharmacies.length, 1, "two spellings that differ only in case and spacing are one pharmacy");
    const [pharmacy] = pharmacies;
    assert.equal(pharmacy.name, "El  Ezaby", "the display name is the most recent visit's spelling");
    assert.equal(pharmacy.visits, 2, "both visits are counted");
    assert.equal(pharmacy.lastFeedbackAt, "2026-09-10T09:00:00.000Z", "the last feedback is the latest visit's");
    assert.deepEqual(
      pharmacy.products,
      [{ product: "Lacto Advanced", answer: "missing" }],
      "the later visit's Has/Doesn't-have answer overwrites the earlier one",
    );
    assert.equal(pharmacy.isPrimary, false, "the pure grouping never decides the primary — the caller does");
  }

  // ── input order does not matter: it sorts by capturedAt before folding ────────
  {
    const grouped = groupCustomerPharmacies([
      feedback({ pharmacyName: "El Ezaby", productAvailability: { "Lacto Advanced": "missing" }, capturedAt: "2026-09-10T09:00:00.000Z" }),
      feedback({ pharmacyName: "el ezaby", productAvailability: { "Lacto Advanced": "has" }, capturedAt: "2026-09-01T09:00:00.000Z" }),
    ]);
    const [pharmacy] = grouped.get(DOCTOR_A) ?? [];
    assert.equal(pharmacy?.name, "El Ezaby", "the newest spelling wins even when it arrives first");
    assert.deepEqual(pharmacy?.products, [{ product: "Lacto Advanced", answer: "missing" }], "the newest answer wins whatever the input order");
  }

  // ── 3: most-recent-first, and each doctor keeps his own pharmacies ────────────
  {
    const grouped = groupCustomerPharmacies([
      feedback({ pharmacyName: "Seif", capturedAt: "2026-09-02T09:00:00.000Z" }),
      feedback({ pharmacyName: "El Ezaby", capturedAt: "2026-09-20T09:00:00.000Z" }),
      feedback({ customerId: DOCTOR_B, pharmacyName: "Roshdy", capturedAt: "2026-09-05T09:00:00.000Z" }),
    ]);
    const a = grouped.get(DOCTOR_A) ?? [];
    assert.deepEqual(a.map((p) => p.name), ["El Ezaby", "Seif"], "one doctor's pharmacies are most-recent-first");
    const b = grouped.get(DOCTOR_B) ?? [];
    assert.deepEqual(b.map((p) => p.name), ["Roshdy"], "another doctor's pharmacy is his alone, not mixed in");
  }

  // ── a blank pharmacy name is not a pharmacy ───────────────────────────────────
  {
    const grouped = groupCustomerPharmacies([feedback({ pharmacyName: "   " })]);
    assert.equal(grouped.has(DOCTOR_A), false, "a whitespace-only pharmacy name yields no pharmacy");
  }

  // ── the write path is a service-role SECURITY DEFINER RPC, not a table write ──
  const list = stripComments(readFileSync(LIST, "utf8"));
  assert.match(list, /callPhoenixCrm(?:<\w+>)?\(\s*"phoenix_crm_set_primary_pharmacy"/, "the primary pin goes through the seat-locked database function");
}
