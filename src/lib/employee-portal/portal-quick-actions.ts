// ─────────────────────────────────────────────────────────────────────────────
// The employee portal's quick actions — the things a person STARTS, in one place.
//
// React-free and DOM-free on purpose, like portal-chrome.ts beside it, so the Node test harness can
// call these rules directly. Icons stay in React-land (a lucide import here would break every node
// test that loads this file); the components map an action's `id` to its glyph.
//
// WHY THIS FILE EXISTS. The same five actions were written out twice inside
// employee-portal-layout.tsx — once for the top bar's "+ New" menu and once for the command bar's
// action list — and the copies had already drifted on the Report It gate. Worse, the duplicate put
// `href: "/employee-portals/direct-orders/new"` into the layout file, which turned
// tests/employee-portal-bottom-nav.test.ts RED: its reverse guard reads EVERY `href:` literal in the
// layout and demands each be a phone-bar registry entry. A quick-action target never was a sidebar
// row, so the guard's premise was violated by construction. Keeping these hrefs out of the layout
// fixes that for the right reason, rather than by widening a set named `desktopOnlyPortalRoutes`.
// ─────────────────────────────────────────────────────────────────────────────

import type { EmployeePortalNavVisibility } from "@/lib/employee-portal/navigation";

/** The actions the portal offers. The id is what a component maps to an icon. */
export type PortalQuickActionKey = "crm-visit" | "crm-plan" | "vacation" | "expense" | "direct-order" | "report-it" | "support";

/**
 * Phoenix CRM's two quick actions (owner, 2026-09-29: "the + in the bottom bar and the top bar — Add
 * visit and Make weekly plan; Phoenix CRM is the module medical reps use most"). They open the module's
 * OWN page with the ask on it (`/field-crm/<module>?add=…`, read by phoenix-crm-app.tsx); nothing is
 * saved by the tap.
 *
 * 🔴 THE MODULE'S OWN ADDRESS, NEVER THE CHOOSER'S `?tab=` (2026-10-01, "slow to transfer between page
 * and page", Phoenix CRM first). /employee-portals/field-crm answers a `?tab=` only by REDIRECTING to
 * exactly these addresses, so every tap on "+" paid two server round trips — the chooser's, then the
 * module's — before the form could open. The chooser still forwards `?tab=` for the notification links
 * and saved addresses that carry it.
 */
export const PHOENIX_CRM_ADD_VISIT_HREF = "/employee-portals/field-crm/visits?add=visit";
export const PHOENIX_CRM_WEEKLY_PLAN_HREF = "/employee-portals/field-crm/plan?add=week";

export type PortalQuickAction = {
  /** The section this action lands in — the command bar shows it beside the label. */
  hint: string;
  href: string;
  id: PortalQuickActionKey;
  /** Extra words the command bar's filter should match. */
  keywords: string;
  label: string;
};

/**
 * The actions THIS viewer can start, in the order every surface shows them.
 *
 * Each is gated by the same visibility flag that decides its sidebar row, so a surface built from
 * this list can never offer something the person cannot do. Requesting vacation is ungated — every
 * portal role has it — so the list is never empty; callers still guard for empty rather than
 * assuming, because a future gate could change that.
 *
 * Report It is gated on the raw flags rather than "is it on the sidebar". The two forms coincide for
 * every portal role today (each role holds one flag or the other, and the destination is on their
 * sidebar), and the flags are the same thing the row itself reads.
 */
export function portalQuickActions(visibility: EmployeePortalNavVisibility): PortalQuickAction[] {
  // A medical rep with Phoenix CRM open gets its two actions FIRST — they are what he starts most.
  const phoenixCrm: PortalQuickAction[] =
    visibility.showPhoenixCrmTab && visibility.showMedicalRepExpensesTab
      ? [
        {
          hint: "Phoenix CRM",
          href: PHOENIX_CRM_ADD_VISIT_HREF,
          id: "crm-visit",
          keywords: "visit customer call crm log",
          label: "Add visit",
        },
        {
          hint: "Phoenix CRM",
          href: PHOENIX_CRM_WEEKLY_PLAN_HREF,
          id: "crm-plan",
          keywords: "plan week weekly schedule crm",
          label: "Make weekly plan",
        },
      ]
      : [];
  return [
    ...phoenixCrm,
    {
      hint: "Leave & HR",
      href: "/employee-portals/vacation-request",
      id: "vacation",
      keywords: "leave holiday time off",
      label: "Request vacation",
    },
    ...(visibility.showExpenseActionTab
      ? [
        {
          hint: "Outstation Expenses",
          href: "/employee-portals/submit-expense",
          id: "expense" as const,
          keywords: "outstation claim",
          label: "Submit an expense",
        },
      ]
      : []),
    ...(visibility.showDirectOrdersTab
      ? [
        {
          hint: "Sales Data",
          href: "/employee-portals/direct-orders/new",
          id: "direct-order" as const,
          keywords: "order pharmacy",
          label: "New direct order",
        },
      ]
      : []),
    ...(visibility.showReportItDashboardTab || visibility.showReportItTab
      ? [
        {
          hint: "Other",
          href: "/employee-portals/report-it",
          id: "report-it" as const,
          keywords: "report it adverse event side effect",
          label: "Report a side effect",
        },
      ]
      : []),
    ...(visibility.showSupportTab
      ? [
        {
          hint: "Other",
          href: "/employee-portals/contact-hr-support",
          id: "support" as const,
          keywords: "help request hr",
          label: "Ask HR for support",
        },
      ]
      : []),
  ];
}
