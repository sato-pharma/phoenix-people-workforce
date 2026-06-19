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

/** Campaign length in whole months, floored to a minimum of 1 (mirrors the DB column default). */
export function marketingRoiDurationMonths(value: unknown) {
  return Math.max(1, Math.floor(nonNegativeNumber(value)) || 1);
}

export function calculateRequiredMarketingRoi(estimatedCost: unknown, durationMonths: unknown = 1) {
  return roundMarketingMoney(
    nonNegativeNumber(estimatedCost) * marketingRoiMultiplier * marketingRoiDurationMonths(durationMonths),
  );
}

export function resolveMarketingRoiStatus(params: {
  durationMonths?: unknown;
  estimatedCost: unknown;
  expectedRoiValue: unknown;
}): MarketingRoiStatus {
  const estimatedCost = nonNegativeNumber(params.estimatedCost);
  const expectedRoiValue = nonNegativeNumber(params.expectedRoiValue);
  const months = marketingRoiDurationMonths(params.durationMonths);

  if (estimatedCost === 0 && expectedRoiValue === 0) return "not_calculated";
  if (estimatedCost === 0 && expectedRoiValue > 0) return "covers_required";

  return expectedRoiValue >= estimatedCost * marketingRoiMultiplier * months
    ? "covers_required"
    : "under_target";
}

export function calculateMarketingRoiPreview(params: {
  durationMonths?: unknown;
  estimatedCost: unknown;
  products: MarketingRoiInputProduct[];
}): MarketingRoiPreview {
  const estimatedCost = nonNegativeNumber(params.estimatedCost);
  const months = marketingRoiDurationMonths(params.durationMonths);
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
  const requiredRoiValue = calculateRequiredMarketingRoi(estimatedCost, months);
  const roiCoverageRatio = requiredRoiValue > 0
    ? roundMarketingRatio(expectedRoiValue / requiredRoiValue)
    : expectedRoiValue > 0
      ? 1
      : 0;
  const roiStatus = resolveMarketingRoiStatus({
    durationMonths: months,
    estimatedCost,
    expectedRoiValue,
  });

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
