/**
 * The pure half of the marketing customer merge (owner, 2026-11-03). The database function
 * `phx_merge_marketing_customers` enforces every refusal; these words let the screen say the same thing
 * before anyone presses, and a test holds the two in step.
 */

export type MarketingCustomerMergeOption = {
  areaName: string | null;
  code: string;
  contacts: number;
  customerType: string;
  evidenceComplete: boolean;
  evidenceStatus: string;
  id: string;
  lineName: string | null;
  links: number;
  liveTransfer: boolean;
  name: string;
  normalizedName: string;
  ownerName: string | null;
  requests: number;
  validationStatus: string;
};

/**
 * Two rows sharing a normalized name. Offered as "same name, check", never called duplicates: two doctors
 * on one seat can share a name, and a name scan misses an Arabic and a Latin spelling of one person. The
 * identity is a person's judgement.
 */
export function sameNameGroups(options: readonly MarketingCustomerMergeOption[]): MarketingCustomerMergeOption[][] {
  const groups = new Map<string, MarketingCustomerMergeOption[]>();
  for (const option of options) {
    const key = option.normalizedName.trim();
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), option]);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

/** The sentence the database would refuse this pair with, or null when the pair can be merged. */
export function customerMergeRefusal(survivor: MarketingCustomerMergeOption, retired: MarketingCustomerMergeOption): string | null {
  if (survivor.id === retired.id) return "A customer cannot be merged into itself.";
  if (survivor.validationStatus === "rejected") return `${survivor.name} was rejected, so it cannot be the customer that stays. Keep the other one.`;
  if (survivor.lineName !== retired.lineName) return "These two are on different lines, and this screen merges only within one line.";
  if (survivor.customerType !== retired.customerType) return "These two are different kinds of customer.";
  if (survivor.areaName !== retired.areaName) return "These two are in different areas, and this screen merges only within one area.";
  if (survivor.liveTransfer && retired.liveTransfer) return "Both customers have a live Direct Orders transfer. Revert one of them first.";
  return null;
}

/** Evidence is a photo of one place, so it moves only on a person's tick, and only where it adds something. */
export function evidenceCanCarry(survivor: MarketingCustomerMergeOption, retired: MarketingCustomerMergeOption): boolean {
  return retired.evidenceComplete && survivor.evidenceStatus !== "complete";
}
