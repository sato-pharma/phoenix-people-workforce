/**
 * A PER-ADDRESS LIMIT FOR A PUBLIC BEACON, COUNTED ACROSS EVERY INSTANCE (REC-083).
 *
 * The page-timing beacon and the CSP report route counted each address in THIS process only, so every
 * instance gave an address its own allowance and every deploy reset all of them. They now count in the
 * shared bucket store (`api_rate_limit_consume`, through assertApiRateLimit) under their own scope, with
 * the same limit and the same key — the address the edge saw, hashed by the store, never stored raw.
 *
 * TWO THINGS STAY IN PROCESS, AND NEITHER IS THE LIMIT:
 *
 * 1. A FLOOD SHIELD. These routes are public and unauthenticated, so a store query per request would turn
 *    a flood into database writes. The bounded in-process counter (memory-rate-buckets.ts) runs first
 *    with the SAME limit: an address already over it HERE is over it everywhere (the shared count can
 *    only be higher), so it is refused without a query. It can never admit what the store refuses.
 * 2. THE OUTAGE FALLBACK. When the store cannot be read, assertApiRateLimit counts in its own bounded
 *    in-process map (`onStoreError: "memory"`), as the crash report does — a beacon must keep answering
 *    through a database outage, and must never run unlimited while it does.
 */

import { assertApiRateLimit, isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { createMemoryRateBuckets } from "@/lib/security/memory-rate-buckets";

export type SharedAddressLimitConsume = (input: {
  identifier: string;
  limit: number;
  onStoreError: "memory";
  scope: string;
  windowMs: number;
}) => Promise<void>;

export function createSharedAddressLimit(input: {
  limit: number;
  /** How many addresses the in-process flood shield holds at once (a full one evicts, never refuses). */
  maxAddresses: number;
  /** The bucket store's scope — one per route, so two routes never share an allowance. */
  scope: string;
  windowMs: number;
  /** Test seam only: the shared store. Production always counts through assertApiRateLimit. */
  consume?: SharedAddressLimitConsume;
}) {
  const shield = createMemoryRateBuckets(input.maxAddresses);
  const consume: SharedAddressLimitConsume = input.consume ?? assertApiRateLimit;

  return {
    /** True when this address may be answered; false when it is over its limit across every instance. */
    async allow(address: string): Promise<boolean> {
      if (shield.consume(address, input.limit, input.windowMs) > 0) return false;
      try {
        await consume({ identifier: address, limit: input.limit, onStoreError: "memory", scope: input.scope, windowMs: input.windowMs });
        return true;
      } catch (error) {
        if (isApiRateLimitError(error)) return false;
        // With onStoreError "memory" the limiter answers a store failure itself, so nothing else
        // reaches here; anything that does is answered rather than turned into a 500 on a beacon.
        return true;
      }
    },
  };
}
