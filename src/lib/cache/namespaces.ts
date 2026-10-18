/**
 * Report generations that more than one module bumps.
 *
 * A cache whose only writer sits beside its reader keeps its name in that module (the CRM visit
 * windows, the live teams). This file holds the ones whose WRITERS live elsewhere, so a Phoenix CRM,
 * marketing or direct-order write path can refresh a report without importing the report — the
 * Phoenix CRM boundary test forbids `src/lib/phoenix-crm/` from importing marketing or direct-order
 * code, and this file imports nothing at all.
 */

/**
 * Customer 360 (owner, 2026-10-18): every validated doctor and account, the pharmacies tied to each,
 * the visits, the marketing money and the closing's sales, assembled on read
 * (`src/lib/customer-360/server/report.ts`). Bumped by every app write that changes who is validated,
 * which pharmacy is tied to whom, a request's money, a direct order, an identity link, a pharmacy
 * match or a published closing.
 */
let customer360Generation = 0;

/** Ten minutes — the backstop for the writes this process never sees (the vendor sync, direct SQL). */
export const CUSTOMER_360_CACHE_TTL_MS = 10 * 60_000;

/** The generation a Customer 360 copy was built at; a copy from an older one is rebuilt. */
export function customer360CacheGeneration(): number {
  return customer360Generation;
}

/** Refresh Customer 360 after a write. Never throws: a cache bump must not fail the write it follows. */
export function bumpCustomer360Cache(_reason: string): void {
  customer360Generation += 1;
}
