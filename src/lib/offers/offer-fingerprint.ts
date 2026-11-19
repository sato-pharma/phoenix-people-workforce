import { createHash } from "node:crypto";

import type { OfferRecord } from "@/lib/offers/types";

/**
 * A fingerprint of an offer exactly as it was read (REC-048 phase 2, 19 Nov 2026).
 *
 * A letter the outbox retries was rendered at the press. Before the drain sends it late, the offer is
 * read again and fingerprinted the same way: ANY change since the press — a field edited, a status, the
 * approval, the copies, a revision — gives a different fingerprint, and the stored letter is not sent
 * (src/lib/offers/outbox-retry.ts). The record is read by one function (`getOffer` → `toOffer`), which
 * builds its keys in the same order every time, so an unchanged offer always gives the same answer.
 * Pure; nothing about the offer is stored but the digest.
 */
export function offerRetryFingerprint(offer: OfferRecord): string {
  return createHash("sha256").update(JSON.stringify(offer)).digest("hex").slice(0, 32);
}
