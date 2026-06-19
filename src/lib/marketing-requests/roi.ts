import type {
  MarketingRoiInputProduct,
  MarketingRoiPreview,
  MarketingRoiStatus,
} from "@/lib/marketing-requests/types";

export const marketingRoiMultiplier = 10;

function numberValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nonNegativeNumber(value: unknown) {
  return Math.max(0, numberValue(value));
}

function round(value: number, digits: number) {
  return Number(value.toFixed(digits));
}

export function roundMarketingMoney(value: number) {
  return round(numberValue(value), 2);
}

export function roundMarketingRatio(value: number) {
  return round(numberValue(value), 6);
}

// Required ROI = estimated_cost × 10 (flat, campaign duration has no effect on the target).
export function calculateRequiredMarketingRoi(estimatedCost: unknown) {
  return roundMarketingMoney(nonNegativeNumber(estimatedCost) * marketingRoiMultiplier);
}

export function resolveMarketingRoiStatus(params: {
  durationMonths?: unknown; // accepted for call-site compatibility; not used in the formula
  estimatedCost: unknown;
  expectedRoiValue: unknown;
}): MarketingRoiStatus {
  const estimatedCost = nonNegativeNumber(params.estimatedCost);
  const expectedRoiValue = nonNegativeNumber(params.expectedRoiValue);

  if (estimatedCost === 0 && expectedRoiValue === 0) return "not_calculated";
  if (estimatedCost === 0 && expectedRoiValue > 0) return "covers_required";

  return expectedRoiValue >= estimatedCost * marketingRoiMultiplier
    ? "covers_required"
    : "under_target";
}

export function calculateMarketingRoiPreview(params: {
  durationMonths?: unknown; // accepted for call-site compatibility; not used in the formula
  estimatedCost: unknown;
  products: MarketingRoiInputProduct[];
}): MarketingRoiPreview {
  const estimatedCost = nonNegativeNumber(params.estimatedCost);
  const products = params.products.map((product) => {
    const factoryPrice = nonNegativeNumber(product.factoryPrice);
    const quantity = nonNegativeNumber(product.quantity);
    const expectedValue = roundMarketingMoney(factoryPrice * quantity);

    return {
      ...product,
      factoryPrice,
      quantity,
      expectedValue,
      valueShare: 0,
    };
  });
  const expectedRoiValue = roundMarketingMoney(
    products.reduce((total, product) => total + product.expectedValue, 0),
  );
  const requiredRoiValue = calculateRequiredMarketingRoi(estimatedCost);
  const roiCoverageRatio = requiredRoiValue > 0
    ? roundMarketingRatio(expectedRoiValue / requiredRoiValue)
    : expectedRoiValue > 0
      ? 1
      : 0;
  const roiStatus = resolveMarketingRoiStatus({ estimatedCost, expectedRoiValue });

  return {
    expectedRoiValue,
    products: products.map((product) => ({
      ...product,
      valueShare: expectedRoiValue > 0
        ? roundMarketingRatio(product.expectedValue / expectedRoiValue)
        : 0,
    })),
    requiredRoiValue,
    roiCoverageRatio,
    roiStatus,
  };
}

export function normalizeMarketingRequestProductShares(
  products: MarketingRoiInputProduct[],
) {
  return calculateMarketingRoiPreview({
    estimatedCost: 0,
    products,
  }).products;
}
