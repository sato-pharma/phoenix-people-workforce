import assert from "node:assert/strict";

import {
  groupClosingCorrections,
  type ClosingCorrectionRow,
} from "../src/lib/sales/closing-corrections.ts";

function row(overrides: Partial<ClosingCorrectionRow>): ClosingCorrectionRow {
  return {
    kind: "net_negative",
    period: "2026-07",
    otherPeriod: null,
    line: "Anti Infective",
    distributorCode: "IS-S",
    distributorName: "Ibn Sina-Sato",
    areaCode: "GZ4",
    areaName: "Haram - Faisal",
    productCode: "SA001",
    productName: "Saginkgo",
    clientName: null,
    units: 0,
    value: 0,
    otherUnits: null,
    otherValue: null,
    ...overrides,
  };
}

export function runClosingCorrectionsTests() {
  // The GZ4 shape: +204 in June, −197 in July. Anchored on the positive month by the RPC.
  const pair = row({
    kind: "reversal_pair",
    period: "2026-06",
    otherPeriod: "2026-07",
    units: 204,
    value: 22674.6,
    otherUnits: -197,
    otherValue: -21896.55,
  });
  // The El-Borg shape: a July return whose purchase month was March.
  const late = row({
    kind: "late_return",
    period: "2026-07",
    otherPeriod: "2026-03",
    distributorCode: "PS",
    distributorName: "overseas",
    areaCode: "UE9",
    areaName: "Beni Suef",
    productCode: "LA001",
    productName: "Lacto 1 Advance",
    clientName: "El-Borg",
    units: -120,
    value: -32400,
    otherUnits: 120,
  });
  const lateNoOrigin = row({
    kind: "late_return",
    otherPeriod: null,
    clientName: "Unknown returner",
    units: -15,
    value: -1500,
  });
  const negative = row({ kind: "net_negative", units: -185, value: -20562.75 });

  const grouped = groupClosingCorrections([negative, pair, late, lateNoOrigin], "2026-07");

  assert.equal(grouped.isEmpty, false);
  assert.equal(grouped.reversalPairs.length, 1);
  assert.equal(grouped.netNegatives.length, 1);
  assert.equal(grouped.lateReturns.length, 2);

  const [reversal] = grouped.reversalPairs;
  assert.equal(reversal.positivePeriod, "2026-06", "the pair is anchored on the month that was inflated");
  assert.equal(reversal.negativePeriod, "2026-07");
  assert.ok(reversal.impact.includes("2026-06") && reversal.impact.includes("2026-07"), "the sentence names BOTH distorted months — that is the whole point of the page");
  assert.ok(reversal.impact.includes("Ibn Sina-Sato"), "the sentence names the distributor, never a code");

  const withOrigin = grouped.lateReturns.find((entry) => entry.clientName === "El-Borg");
  assert.ok(withOrigin, "the traced late return survives grouping");
  assert.equal(withOrigin?.originPeriod, "2026-03");
  assert.ok(withOrigin?.impact.includes("2026-03"), "a traced return names the month the sale actually happened");
  const withoutOrigin = grouped.lateReturns.find((entry) => entry.clientName === "Unknown returner");
  assert.ok(withoutOrigin?.impact.includes("no earlier purchase"), "an untraceable return says so instead of inventing an origin");
  assert.equal(
    grouped.lateReturns[0]?.clientName,
    "El-Borg",
    "sections sort biggest distortion first, so the reader's first row is the worst one",
  );

  assert.equal(groupClosingCorrections([], "2026-07").isEmpty, true, "an empty month yields one calm all-clear, not three empty tables pretending to be findings");
}
