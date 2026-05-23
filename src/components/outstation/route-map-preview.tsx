"use client";

import { OutstationReviewMap } from "@/components/outstation/outstation-review-map";
import type { OutstationCalculationResult, OutstationExpenseRequest } from "@/lib/outstation/types";

export function RouteMapPreview({
  request,
}: {
  request: OutstationCalculationResult | OutstationExpenseRequest | null;
}) {
  return <OutstationReviewMap request={request} />;
}
