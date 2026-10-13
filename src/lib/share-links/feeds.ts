// The three live Google Sheets that read Phoenix through a share-link token, named once.
//
// Each one has its own table and its own service, for good reasons that are not going away — the
// scope rules, the column sets and the report engines are genuinely different. What they share is
// the failure mode in `dead-token-polling.ts`: a copy of the sheet, a token that has since been
// rotated out, and a refresh trigger nobody stopped. The sweep has to read all three, so the pairs
// live here rather than being re-typed in the alarm, where a mistyped table name would silently
// read nothing and report "healthy" for ever.
//
// NO IMPORTS, deliberately. `tests/share-link-dead-token-polling.test.ts` checks these table names
// against the ones the three services actually query, and it can only do that without dragging the
// Supabase client into a unit test if this file stays data.

export type ShareLinkFeed = {
  /**
   * The screen where this sheet's links can be read and revoked, or `null` where there is none.
   *
   * Every sheet has one now. Marketing's was API-only until its links panel landed on the All
   * Marketing Requests register (13 Oct 2026); `null` stays a legal value for a feed added without
   * a screen, because an alert whose button opens a page that cannot act on the thing it is about
   * is worse than an alert with no button, and the message carries the real instruction either way.
   */
  screen: string | null;
  /** Human name of the sheet, for the message the owner reads. Never a table name. */
  sheet: string;
  /** The table holding that sheet's share links. */
  table: string;
};

export const SHARE_LINK_FEEDS: readonly ShareLinkFeed[] = [
  {
    screen: "/admin/direct-orders/report",
    sheet: "Direct Orders",
    table: "direct_order_report_share_links",
  },
  {
    screen: "/admin/marketing-requests/all",
    sheet: "Marketing Requests",
    table: "marketing_request_report_share_links",
  },
  {
    screen: "/recruitment/cv-lifecycle-sheet",
    sheet: "CV Lifecycle",
    table: "ats_cv_lifecycle_share_links",
  },
];
