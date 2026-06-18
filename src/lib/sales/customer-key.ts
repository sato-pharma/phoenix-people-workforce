// A Source-of-Sales customer is uniquely identified by the pair (distributorCode, customerCode):
// the SAME customerCode can recur under two different distributors. Any code that reconciles
// accept/saved state MUST key on this composite — keying on customerCode alone collapses the two
// rows and marks the wrong one as mapped (the cross-distributor collision bug).

/** Stable composite identity for a distributor's customer. */
export function customerKey(distributorCode: string, customerCode: string): string {
  return `${distributorCode}|${customerCode}`;
}

export type AcceptResultRow = { customerCode: string; distributorCode: string; ok: boolean };

/**
 * Given the per-row results echoed back by /accept-mappings, return the composite keys of the rows
 * that were saved successfully — so the caller marks exactly those rows (and no cross-distributor
 * twin) as mapped.
 */
export function savedCustomerKeys(results: readonly AcceptResultRow[]): string[] {
  return results.filter((r) => r.ok).map((r) => customerKey(r.distributorCode, r.customerCode));
}
