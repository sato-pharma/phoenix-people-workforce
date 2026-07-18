import assert from "node:assert/strict";

import {
  validateTargetRows,
  type TargetInputRow,
  type TargetValidationRefs,
} from "../src/lib/sales/monthly-targets.ts";

// Hand-built canonical reference model (no DB). Keys mirror loadTargetValidationRefs:
// lineByKey/areaByKey/productByKey/confidentialByKey are keyed by normKey (lower, alnum,
// space-collapsed); lineAreaCarriesTarget is keyed by the resolved `${line_code}|${area_code}`.
function makeRefs(): TargetValidationRefs {
  return {
    lineByKey: new Map([
      ["cns", "cns"],
      ["pedia", "pedia"],
      ["anti infective", "anti_infective"],
    ]),
    areaByKey: new Map([
      ["ab1", "AB1"],
      ["alex east", "AB1"],
      ["ot1", "OT1"],
    ]),
    lineAreaCarriesTarget: new Map([
      ["cns|AB1", true],
      ["cns|OT1", false], // an "Other" area — carries no target
    ]),
    productByKey: new Map([
      ["teb", "TEB"],
      ["tebofortine", "TEB"],
    ]),
    confidentialByKey: new Set(["la003", "la004", "ss001", "satoslim"]),
  };
}

function row(overrides: Partial<TargetInputRow>): TargetInputRow {
  return {
    rowNumber: 1,
    period: "2026-01",
    line: "CNS",
    area: "AB1",
    product: "Tebofortine",
    targetUnits: 100,
    targetValue: null,
    ...overrides,
  };
}

export function runAuTargetsValidationTests(): void {
  const refs = makeRefs();

  // A clean row resolves to canonical codes.
  {
    const { valid, errors } = validateTargetRows([row({})], refs);
    assert.equal(errors.length, 0, "clean row should have no errors");
    assert.equal(valid.length, 1);
    assert.deepEqual(
      { l: valid[0].line_code, a: valid[0].area_code, p: valid[0].product_code },
      { l: "cns", a: "AB1", p: "TEB" },
    );
  }

  // Confidential product BY CODE is rejected (never resolvable to a target).
  {
    const { valid, errors } = validateTargetRows([row({ product: "LA003" })], refs);
    assert.equal(valid.length, 0, "confidential product must not become a valid target");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, "confidential_product");
    assert.equal(errors[0].field, "product");
  }

  // Confidential product BY NAME (Satoslim) is rejected too.
  {
    const { valid, errors } = validateTargetRows([row({ product: "Satoslim" })], refs);
    assert.equal(valid.length, 0);
    assert.equal(errors[0].code, "confidential_product");
  }

  // A genuinely unknown product is rejected as unknown (distinct from confidential).
  {
    const { errors } = validateTargetRows([row({ product: "Zzz Unknown" })], refs);
    assert.equal(errors[0].code, "unknown_product");
  }

  // An "Other" area carries no target and is rejected.
  {
    const { errors } = validateTargetRows([row({ area: "OT1" })], refs);
    assert.equal(errors[0].code, "area_not_targetable");
  }

  // A non-canonical area is rejected.
  {
    const { errors } = validateTargetRows([row({ area: "ZZ9" })], refs);
    assert.equal(errors[0].code, "unknown_area");
  }

  // A negative target is rejected.
  {
    const { errors } = validateTargetRows([row({ targetUnits: -5 })], refs);
    assert.equal(errors[0].code, "negative_target");
  }

  // A malformed period is rejected before anything else.
  {
    const { errors } = validateTargetRows([row({ period: "2026/01" })], refs);
    assert.equal(errors[0].code, "invalid_period");
  }
}
