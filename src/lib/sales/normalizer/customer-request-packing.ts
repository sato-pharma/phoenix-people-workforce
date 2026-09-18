import { customerPharmacyKey } from "@/lib/sales/normalizer/customer-normalize";

// How the normalizer workspace (normalizer-workspace.tsx) packs customers into requests for the AI
// pass. Pure — no I/O.
//
// Customer codes with the same pharmacy text (customerPharmacyKey, the key the server groups by in
// customer-free-steps.ts) always travel in the same request, so the server asks the AI about that
// pharmacy once and copies the answer to every code (owner, 2026-09-18: "group them and don't
// duplicate the work"). Split across two requests running side by side, the same pharmacy would be
// paid for twice, because neither request would find the other's answer stored yet.
//
// A request holds at most `maxPharmacies` distinct pharmacies (one AI call's worth) and at most
// `maxCodes` codes (what one route call reads). A pharmacy with more codes than `maxCodes` is split
// across requests, never cut.

export type CustomerPharmacyText = { rawName?: string; rawAddress?: string; rawTerritory?: string };

export function packCustomersByPharmacy<T extends CustomerPharmacyText>(list: readonly T[], maxPharmacies: number, maxCodes: number): T[][] {
  const pharmacyLimit = Math.max(1, Math.floor(maxPharmacies));
  const codeLimit = Math.max(1, Math.floor(maxCodes));

  // One entry per pharmacy, in first-seen order. A customer whose name normalizes to nothing is its
  // own pharmacy, exactly as groupIdenticalPharmacies treats it on the server.
  const pharmacies: T[][] = [];
  const byKey = new Map<string, T[]>();
  for (const customer of list) {
    const key = customerPharmacyKey(customer.rawName ?? "", customer.rawAddress ?? "", customer.rawTerritory ?? "");
    const same = key ? byKey.get(key) : undefined;
    if (same) {
      same.push(customer);
      continue;
    }
    const codes = [customer];
    if (key) byKey.set(key, codes);
    pharmacies.push(codes);
  }

  const requests: T[][] = [];
  let current: T[] = [];
  let pharmaciesInCurrent = 0;
  for (const codes of pharmacies) {
    for (let start = 0; start < codes.length; start += codeLimit) {
      const part = codes.slice(start, start + codeLimit);
      if (current.length > 0 && (pharmaciesInCurrent >= pharmacyLimit || current.length + part.length > codeLimit)) {
        requests.push(current);
        current = [];
        pharmaciesInCurrent = 0;
      }
      current.push(...part);
      pharmaciesInCurrent += 1;
    }
  }
  if (current.length > 0) requests.push(current);
  return requests;
}
