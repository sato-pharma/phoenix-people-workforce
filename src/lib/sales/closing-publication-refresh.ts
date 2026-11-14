import { bumpCustomer360Cache } from "@/lib/cache/namespaces";
import {
  invalidateAchievementStampedCaches,
  invalidateClosingStoreSplitCache,
  invalidateCrmDailyForecastCache,
} from "@/lib/dashboard/invalidation";

// ─────────────────────────────────────────────────────────────────────────────
// WHEN A CLOSING IS PUBLISHED OR WITHDRAWN, EVERY CACHE THAT HOLDS ITS FIGURES IS REFRESHED HERE
// (enterprise audit REC-030, F-SAL-009; 14 Nov 2026).
//
// Publishing and unpublishing (monthly-closing-publication.ts) are the only two writes to
// `monthly_closing_publications`, and both call `onClosingPublicationChanged` right after the write.
// Before this file each kept its own copy of the list below, so a cache added to one could be missed
// by the other.
//
// What it refreshes, and why each one needs it:
//   - the Closing Matrix's store-split overlay (`closing-store-split`): it reads which months are frozen;
//   - Phoenix CRM's daily forecast (`phoenix-crm-daily-forecast`): it reads the published achievement;
//   - everything keyed on the achievement stamp (`sales-achievement-stamped`): Sales vs Target, its
//     page, the platform tile and the Business Review bundle. The stamp does not see a publication;
//   - Customer 360's in-process cache: it shows only published months.
//
// What it deliberately does NOT refresh (checked 14 Nov 2026, pinned by
// tests/closing-publication-refresh.test.ts):
//   - Weekly Stock (`weekly-stock-payload`) reads weekly distributor stock, never the closing.
//   - The Source of Sales dashboard (`sos-dashboard`) caches the imported rows, which a publication
//     does not change; which months a viewer may see is read on every request, outside the cache.
//   - Brick coverage reads the published months on every request, outside its cache.
// A new cache that holds a publication-dependent figure is added here. A new cache that reads the
// publication inside itself fails the test until it is.
// ─────────────────────────────────────────────────────────────────────────────

/** The cache tags this refresh expires (the Customer 360 cache is in-process and has no tag). */
export const CLOSING_PUBLICATION_CACHE_TAGS = [
  "closing-store-split",
  "phoenix-crm-daily-forecast",
  "sales-achievement-stamped",
] as const;

/** Refresh every cache that holds a closing's published figures. Best-effort, like each call inside it. */
export function onClosingPublicationChanged(reason: string): void {
  invalidateClosingStoreSplitCache(reason);
  invalidateCrmDailyForecastCache(reason);
  invalidateAchievementStampedCaches(reason);
  bumpCustomer360Cache(reason);
}
