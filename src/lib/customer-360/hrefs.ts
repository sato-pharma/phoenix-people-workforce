import { encodeCustomerSubjectId } from "@/lib/customer-360/subject";

/** A direct-order pharmacy has its own Customer 360 page, named by its register. */
export function directOrderCustomer360Href(pharmacyId: string): string {
  return `/customer-360/${encodeCustomerSubjectId({ recordId: pharmacyId, register: "direct-order" })}`;
}

/** A marketing customer sits inside a validated doctor or account, which the resolver route finds. */
export function marketingCustomer360Href(customerId: string): string {
  return `/customer-360/marketing-customer/${encodeURIComponent(customerId)}`;
}

/** Which of the viewer's own hubs holds this marketing customer. Null when none does. */
export function findHubHoldingMarketingCustomer<T extends { marketingCustomerIds: readonly string[] }>(
  hubs: readonly T[],
  customerId: string,
): T | null {
  return hubs.find((hub) => hub.marketingCustomerIds.includes(customerId)) ?? null;
}
