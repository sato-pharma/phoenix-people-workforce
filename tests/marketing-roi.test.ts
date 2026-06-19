import assert from "node:assert/strict";

import {
  calculateMarketingRoiPreview,
  calculateRequiredMarketingRoi,
  normalizeMarketingRequestProductShares,
  resolveMarketingRoiStatus,
} from "@/lib/marketing-requests/roi";

export function runMarketingRoiTests() {
  assert.equal(calculateRequiredMarketingRoi(1000), 10000);
  assert.equal(calculateRequiredMarketingRoi(-1000), 0);

  // Required ROI is flat: estimated_cost × 10. Campaign duration has no effect on the target.
  assert.equal(calculateRequiredMarketingRoi(1000), 10000);

  // A forecast that covers the flat target is "covers_required" regardless of duration.
  const oneMonth = calculateMarketingRoiPreview({
    durationMonths: 1,
    estimatedCost: 1000,
    products: [{ factoryPrice: 10, productName: "P", quantity: 1500 }],
  });
  assert.equal(oneMonth.requiredRoiValue, 10000);
  assert.equal(oneMonth.roiStatus, "covers_required");
  const threeMonth = calculateMarketingRoiPreview({
    durationMonths: 3,
    estimatedCost: 1000,
    products: [{ factoryPrice: 10, productName: "P", quantity: 1500 }],
  });
  assert.equal(threeMonth.requiredRoiValue, 10000);
  assert.equal(threeMonth.expectedRoiValue, 15000);
  assert.equal(threeMonth.roiCoverageRatio, 1.5);
  assert.equal(threeMonth.roiStatus, "covers_required");
  assert.equal(
    resolveMarketingRoiStatus({ estimatedCost: 1000, expectedRoiValue: 10000 }),
    "covers_required",
  );
  assert.equal(
    resolveMarketingRoiStatus({ estimatedCost: 1000, expectedRoiValue: 9999 }),
    "under_target",
  );

  const preview = calculateMarketingRoiPreview({
    estimatedCost: 1000,
    products: [
      {
        factoryPrice: 6,
        productId: 1,
        productName: "Saginko",
        quantity: 500,
      },
      {
        factoryPrice: 14,
        productId: 2,
        productName: "Royafloxacin",
        quantity: 500,
      },
    ],
  });

  assert.equal(preview.requiredRoiValue, 10000);
  assert.equal(preview.expectedRoiValue, 10000);
  assert.equal(preview.roiCoverageRatio, 1);
  assert.equal(preview.roiStatus, "covers_required");
  assert.equal(preview.products[0].expectedValue, 3000);
  assert.equal(preview.products[1].expectedValue, 7000);
  assert.equal(preview.products[0].valueShare, 0.3);
  assert.equal(preview.products[1].valueShare, 0.7);

  const underTarget = calculateMarketingRoiPreview({
    estimatedCost: 1000,
    products: [
      {
        factoryPrice: 9.5,
        productName: "Under target product",
        quantity: 800,
      },
    ],
  });

  assert.equal(underTarget.expectedRoiValue, 7600);
  assert.equal(underTarget.roiCoverageRatio, 0.76);
  assert.equal(underTarget.roiStatus, "under_target");

  const zeroCostWithValue = calculateMarketingRoiPreview({
    estimatedCost: 0,
    products: [
      {
        factoryPrice: 10,
        productName: "Sample",
        quantity: 2,
      },
    ],
  });

  assert.equal(zeroCostWithValue.requiredRoiValue, 0);
  assert.equal(zeroCostWithValue.roiCoverageRatio, 1);
  assert.equal(zeroCostWithValue.roiStatus, "covers_required");

  assert.equal(
    resolveMarketingRoiStatus({ estimatedCost: 0, expectedRoiValue: 0 }),
    "not_calculated",
  );

  const normalizedShares = normalizeMarketingRequestProductShares([
    { factoryPrice: 5, productName: "A", quantity: 1 },
    { factoryPrice: 15, productName: "B", quantity: 1 },
  ]);

  assert.equal(normalizedShares[0].valueShare, 0.25);
  assert.equal(normalizedShares[1].valueShare, 0.75);

  const coerced = calculateMarketingRoiPreview({
    estimatedCost: "100",
    products: [
      { factoryPrice: "10" as unknown as number, productName: "String number", quantity: "12" as unknown as number },
      { factoryPrice: Number.NaN, productName: "Bad number", quantity: 10 },
      { factoryPrice: 20, productName: "Negative quantity", quantity: -2 },
    ],
  });

  assert.equal(coerced.expectedRoiValue, 120);
  assert.equal(coerced.requiredRoiValue, 1000);
  assert.equal(coerced.roiStatus, "under_target");
}
