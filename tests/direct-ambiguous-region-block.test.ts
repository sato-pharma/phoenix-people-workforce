import assert from "node:assert/strict";

import { ambiguousDirectRegion } from "../src/lib/sales/monthly-distributor-import.ts";

// Blocking an ambiguous Direct region at UPLOAD.
//
// A Direct row carries a region but never an area, so its District Manager is resolved from the
// region alone. Anti Infective splits Upper Egypt into UE-1 (Nosiba Salah) and UE-2 (Ahmed
// Nashaat), so a Direct row tagged plain "UE" belongs to two managers and reaches neither.
//
// 3,110 units / 208,652.40 EGP accumulated that way over six months before anyone noticed. 19
// rows were recoverable from a place name buried in the customer text; the other 16 — five with
// no customer name at all — could only be split by an owner-set 1:2 territory rule. This block
// exists so a seventh month never joins them.
//
// The rule is PER LINE. CNS and Pedia have a single Upper Egypt region with one DM, so "UE" is
// correct for them — blocking it there would stop valid uploads for no reason. That asymmetry is
// the thing most likely to be "tidied up" into a global rule later, so it is asserted explicitly.

export function runDirectAmbiguousRegionBlockTests() {
  // ── The ambiguous pair is caught ────────────────────────────────────────────
  {
    const rule = ambiguousDirectRegion("Anti Infective", "UE");
    assert.ok(rule, "Anti Infective + UE is the pair that reaches no DM");
    assert.equal(rule.choices, "UE-1 or UE-2");
    assert.match(rule.detail, /Minia/, "the message must name the governorates, so the uploader can act on it");
    assert.match(rule.detail, /Assuit|Sohag|Qena/);
  }

  // ── Matching is tolerant of how the line is written ─────────────────────────
  // The line arrives from the product reference, and production carries both "Anti Infective"
  // and "Anti Inf" spellings across sheets.
  for (const line of ["anti infective", "ANTI INFECTIVE", "  Anti   Infective  ", "Anti-Infective"]) {
    assert.ok(ambiguousDirectRegion(line, "UE"), `must match the line written as "${line}"`);
  }
  for (const region of ["ue", " UE ", "Ue"]) {
    assert.ok(ambiguousDirectRegion("Anti Infective", region), `must match the region written as "${region}"`);
  }

  // ── Already-district-specific rows pass ─────────────────────────────────────
  // The whole point is to push uploaders here; these must never be blocked.
  assert.equal(ambiguousDirectRegion("Anti Infective", "UE-1"), null, "UE-1 is unambiguous — it names one DM");
  assert.equal(ambiguousDirectRegion("Anti Infective", "UE-2"), null, "UE-2 is unambiguous");

  // ── OTHER LINES KEEP USING "UE" ─────────────────────────────────────────────
  // CNS and Pedia map Upper Egypt to a single DM, so "UE" is correct for them. Generalising this
  // rule across lines would block valid uploads for two of the three lines.
  assert.equal(ambiguousDirectRegion("CNS", "UE"), null, "CNS has ONE Upper Egypt DM — 'UE' is unambiguous");
  assert.equal(ambiguousDirectRegion("Pedia", "UE"), null, "Pedia has ONE Upper Egypt DM — 'UE' is unambiguous");

  // ── Other regions on the same line are untouched ────────────────────────────
  for (const region of ["CA", "GZ", "D1", "D2", "AB", "OT", "NATIONAL"]) {
    assert.equal(
      ambiguousDirectRegion("Anti Infective", region),
      null,
      `region ${region} maps to a single Anti Infective DM and must not be blocked`,
    );
  }

  // ── Missing input never fabricates a block ──────────────────────────────────
  // A row with no product match has no line; it already fails its own validation, and this rule
  // must not pile a second, misleading error on top of it.
  assert.equal(ambiguousDirectRegion(null, "UE"), null);
  assert.equal(ambiguousDirectRegion("Anti Infective", null), null);
  assert.equal(ambiguousDirectRegion("", ""), null);
  assert.equal(ambiguousDirectRegion(undefined, undefined), null);
  assert.equal(ambiguousDirectRegion("Unknown", "UE"), null, "an unresolved line must not be blocked by this rule");
}
