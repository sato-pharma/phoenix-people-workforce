// Phoenix Workforce — the numbers on the owner's seven queue shortcuts (owner, 27 Nov 2026: shortcuts in
// his sidebar "that show how many items are waiting in each, so he can work his queues from the sidebar").
//
//   Add to List          → "Add a customer to the list"                       countListAddRequestsWaiting
//   Visits Held for SFE  → "Visits held for SFE (far visits)"                 countFarVisitHoldsWaiting
//   Double Visits        → "Double-visit request (up to 3 days)"              countDoubleVisitRequestsWaiting
//   Visit Asks           → "Visit ask: double, product manager or chain"      countVisitAsksWaiting
//   Probation            → "Probation"                                        countProbationDecisionsDue
//   Contract Renewal     → "Contract renewal"                                 countOpenContractRenewals
//   Held Emails          → "Held emails (a check stopped the send)"           countHeldNotificationReviews
//
// Every count is the domain's own function — none is re-counted here — and each is asked under the SAME
// server-side gate as the page its row opens (assertPermission first, then the page's own check), so a
// number is never computed for a page the viewer could not open. The rows themselves are the Super Admin's
// alone, and anyone else returns empty slots before a single read.
//
// 🔴 A COUNT THAT CANNOT BE READ IS "UNAVAILABLE", NEVER 0 (owner, 27 Nov 2026). Each slot settles on its
// own: a refusal (the viewer may not open that page) is an empty slot, any other failure is
// `{ count: 0, unavailable: true }`, which the badge draws as a dash instead of nothing, and which keeps the
// whole response out of the batched poll's 20 s memory (`available: false`).

import type { AccessContext } from "@/lib/auth/permissions";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError } from "@/lib/auth/server";
import { countOpenContractRenewals } from "@/lib/contracts/service";
import { countHeldNotificationReviews } from "@/lib/notifications/confidence-gate";
import { logError } from "@/lib/observability/log";
import { resolvePhoenixCrmViewer, doubleVisitReportAudience, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { countListAddRequestsWaiting } from "@/lib/phoenix-crm/server/decision-queues";
import { countDoubleVisitRequestsWaiting } from "@/lib/phoenix-crm/server/double-visit-requests";
import { countFarVisitHoldsWaiting } from "@/lib/phoenix-crm/server/far-visit-safeguards";
import { countVisitAsksWaiting } from "@/lib/phoenix-crm/server/visit-asks";
import { countProbationDecisionsDue } from "@/lib/probation/decisions-due";
import { forbiddenError } from "@/lib/http/api-errors";

/** One shortcut's number. `unavailable` is set only when the read failed — never for a refusal. */
export type OwnerQueueSlot = { count: number; unavailable?: true };

export const OWNER_QUEUE_KEYS = [
  "ownerListAdds",
  "ownerFarVisitHolds",
  "ownerDoubleVisitRequests",
  "ownerVisitAsks",
  "ownerProbation",
  "ownerContractRenewals",
  "ownerHeldEmails",
] as const;

export type OwnerQueueKey = (typeof OWNER_QUEUE_KEYS)[number];

export type OwnerQueueBadges = Record<OwnerQueueKey, OwnerQueueSlot> & {
  /** False when any slot could not be read, so the batched poll never remembers a failed read. */
  available: boolean;
};

/** The `?queue=` name each slot answers to on /api/approvals/owner-queues/pending-count. */
export const OWNER_QUEUE_SLOT_BY_NAME: Readonly<Record<string, OwnerQueueKey>> = {
  "list-adds": "ownerListAdds",
  "far-visit-holds": "ownerFarVisitHolds",
  "double-visit-requests": "ownerDoubleVisitRequests",
  "visit-asks": "ownerVisitAsks",
  probation: "ownerProbation",
  "contract-renewals": "ownerContractRenewals",
  "held-emails": "ownerHeldEmails",
};

/** Every slot read as unavailable — what a failure of the whole read answers with. */
export function unavailableOwnerQueueBadges(): OwnerQueueBadges {
  const slots = Object.fromEntries(OWNER_QUEUE_KEYS.map((key) => [key, { count: 0, unavailable: true }])) as Record<OwnerQueueKey, OwnerQueueSlot>;
  return { ...slots, available: false };
}

/** The seven slots alone, as the badge payload carries them — without the `available` flag. */
export function ownerQueueSlots(badges: OwnerQueueBadges): Record<OwnerQueueKey, OwnerQueueSlot> {
  return Object.fromEntries(OWNER_QUEUE_KEYS.map((key) => [key, badges[key]])) as Record<OwnerQueueKey, OwnerQueueSlot>;
}

function emptyOwnerQueueBadges(): OwnerQueueBadges {
  const slots = Object.fromEntries(OWNER_QUEUE_KEYS.map((key) => [key, { count: 0 }])) as Record<OwnerQueueKey, OwnerQueueSlot>;
  return { ...slots, available: true };
}

/** Each count, behind the gate of the page its row opens. A refusal throws a Forbidden error. */
type CountReaders = Record<OwnerQueueKey, (access: AccessContext, viewer: () => Promise<PhoenixCrmViewer>) => Promise<number>>;

const READERS: CountReaders = {
  // /admin/field-crm — loadPhoenixCrmPage admits phoenix_crm:read.
  ownerListAdds: async (access) => {
    await assertPermission(access, "phoenix_crm", "read");
    return countListAddRequestsWaiting();
  },
  // /admin/phoenix-crm/far-visit-holds — phoenix_crm:read, then canDecideFarVisitHolds (inside the count).
  ownerFarVisitHolds: async (access, viewer) => {
    await assertPermission(access, "phoenix_crm", "read");
    return countFarVisitHoldsWaiting(await viewer());
  },
  // /admin/phoenix-crm/double-visit-requests — phoenix_crm:read, then doubleVisitReportAudience.
  ownerDoubleVisitRequests: async (access, viewer) => {
    await assertPermission(access, "phoenix_crm", "read");
    const crmViewer = await viewer();
    if (doubleVisitReportAudience(crmViewer) === null) throw forbiddenError("The double-visit report is not open to this viewer.");
    return countDoubleVisitRequestsWaiting(crmViewer.cairoToday);
  },
  // /admin/field-crm (Team tab, Double visits) — phoenix_crm:read.
  ownerVisitAsks: async (access) => {
    await assertPermission(access, "phoenix_crm", "read");
    return countVisitAsksWaiting();
  },
  // /probation — probation:read, then canReadAllProbation (inside the count).
  ownerProbation: async (access) => {
    await assertPermission(access, "probation", "read");
    return countProbationDecisionsDue(access);
  },
  // /contracts — contracts:read, the page's own gate.
  ownerContractRenewals: async (access) => {
    await assertPermission(access, "contracts", "read");
    return countOpenContractRenewals(access);
  },
  // /admin/notification-confidence — Super Admin only (asserted inside the count).
  ownerHeldEmails: (access) => countHeldNotificationReviews(access),
};

/**
 * The seven shortcut numbers for one viewer. Never throws: each slot settles on its own (see the header).
 * `readers` is for tests only.
 */
export async function loadOwnerQueueBadges(access: AccessContext, readers: CountReaders = READERS): Promise<OwnerQueueBadges> {
  if (access.role !== "Super Admin") return emptyOwnerQueueBadges();
  // One Phoenix CRM viewer for the slots that need it, built only when one asks.
  let viewerPromise: Promise<PhoenixCrmViewer> | null = null;
  const viewer = () => (viewerPromise ??= resolvePhoenixCrmViewer(access));
  const settled = await Promise.allSettled(OWNER_QUEUE_KEYS.map((key) => readers[key](access, viewer)));
  const out = emptyOwnerQueueBadges();
  settled.forEach((result, index) => {
    const key = OWNER_QUEUE_KEYS[index];
    if (result.status === "fulfilled") {
      out[key] = { count: result.value };
      return;
    }
    if (isForbiddenError(result.reason)) return;
    out[key] = { count: 0, unavailable: true };
    out.available = false;
    logError("Owner queue badge count failed", { labels: { event: "owner_queue_badge_count_failed", queue: key }, error: result.reason });
  });
  return out;
}
