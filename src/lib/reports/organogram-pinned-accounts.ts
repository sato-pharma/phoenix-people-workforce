// Accounts pinned to the FULL company organogram (Head Office included) by HR_ID rather than by role.
//
// Dependency-free on purpose: the two enforcing gates in src/lib/reports/organogram.ts and the
// portal sidebar flag in src/lib/employee-portal/navigation.ts both read THIS list, so the page that
// admits a pinned account and the link that offers it can never disagree. See the long account on
// isFullOrganogramPinnedAccount in organogram.ts for why the pin names people, never the role.

import { hrIdsMatch } from "@/lib/hr-id";

/**
 * A-3 — Samaa Mosaad Khalil, QPPV, Head Office (owner, 2026-09-02: "show the full organogram to
 * sama mosaad account").
 *
 * AB — Dr. Sahar Khalil, R&D Manager, the person the QPPV reports to (owner, 2026-10-20: give the
 * R&D Manager the same company chart the QPPV has, Head Office included).
 *
 * Both hold the legacy Head-Office `Manager` app role. The third account on that rung, A-14
 * Regulatory Affairs, is deliberately NOT listed: the owner has named two people, not the rung.
 */
export const FULL_ORGANOGRAM_PINNED_HR_IDS: readonly string[] = ["A-3", "AB"];

/** True when this HR id (or login id) is one of the pinned accounts. Mixed-case safe. */
export function isFullOrganogramPinnedHrId(value: string | null | undefined): boolean {
  return FULL_ORGANOGRAM_PINNED_HR_IDS.some((pinned) => hrIdsMatch(value, pinned));
}
