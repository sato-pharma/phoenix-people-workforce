import {
  PORTAL_NAV_REGISTRY,
  isEntryVisible,
  type PortalNavEntry,
} from "@/components/employee-portal/employee-portal-nav-registry";
import type { EmployeePortalNavVisibility } from "@/lib/employee-portal/navigation";
import { resolveLockedModuleForPath } from "@/lib/navigation/module-catalog";

/**
 * The portal's whole module list, as the native app can render it.
 *
 * WHY THIS EXISTS. The app had three screens — Home, CRM, Profile — against the portal's sixty-odd
 * modules, so on a tablet it read as a different, smaller product than the one the same person opens
 * in a browser. The owner's instruction (2026-09-28) was plain: same modules, same design, same
 * everything. This is the "same modules" half — the app asks the server which modules THIS viewer
 * has, and gets back exactly what the sidebar would have drawn for him, in the sidebar's own
 * sections and the sidebar's own order.
 *
 * ONE SOURCE, NOT A SECOND LIST. Every entry comes from `PORTAL_NAV_REGISTRY` filtered by
 * `isEntryVisible` against the same `EmployeePortalNavVisibility` the shell computes — the registry
 * that already feeds the web bottom nav and the profile quick-nav grid, and that
 * `employee-portal-bottom-nav.test.ts` holds level with the sidebar in BOTH directions. So a module
 * added to the sidebar cannot reach the browser and miss the phone.
 *
 * What this file adds is the two things a registry row cannot carry across JSON:
 *
 *   - `section`: which sidebar group the row belongs to. The sidebar builds its sections inside a
 *     `"use client"` component whose rows are Lucide components, so the grouping cannot be imported
 *     here — it is mirrored, and `tests/mobile-module-directory.test.ts` re-derives the grouping from
 *     `employee-portal-layout.tsx` itself and fails on any disagreement, in either direction.
 *   - `icon`: an Ionicons name. A Lucide component does not serialise, and React Native does not
 *     render one. Every registry href must have one, which the same test enforces, so a new module
 *     cannot arrive on the phone as a blank row.
 *
 * NO BUSINESS LOGIC, and no second opinion about access: `visible` is the registry's own flag test,
 * and the page behind every row still asserts its own permission when it opens. A row here is a door
 * the viewer can see, never a grant.
 */

/** The sidebar's section titles, in the sidebar's order (buildEmployeePortalSections). */
export const NATIVE_MODULE_SECTION_ORDER = [
  "Training Manager",
  "Phoenix CRM",
  "My Workspace",
  "Social",
  "Approvals Hub",
  "Sales Data",
  "Performance",
  "Forecast & Target",
  "Recruitment",
  "iReports 360",
  "KPIs",
  "Marketing & ROI",
  "Payroll",
  "Outstation Expenses",
  "Leaves Management",
  "Other",
] as const;

export type NativeModuleSection = (typeof NATIVE_MODULE_SECTION_ORDER)[number];

/**
 * href → the sidebar section it sits in, and the Ionicons glyph the app draws.
 *
 * A module the sidebar lists under two labels (My Coaching Reports) is filed here once, under its
 * FIRST section — the same de-duplication `visiblePortalNavEntries` already does by href.
 */
const MODULE_PLACEMENT: Readonly<Record<string, { icon: string; section: NativeModuleSection }>> = {
  // ── Training Manager ──────────────────────────────────────────────────────────────────────────
  "/employee-portals/training-manager": { icon: "school-outline", section: "Training Manager" },
  "/employee-portals/training-manager/coaching": { icon: "easel-outline", section: "Training Manager" },
  "/employee-portals/training-manager/create-coaching-report": { icon: "create-outline", section: "Training Manager" },
  "/employee-portals/training-manager/field-coaching": { icon: "walk-outline", section: "Training Manager" },
  "/employee-portals/training-manager/rep-achievement": { icon: "trophy-outline", section: "Training Manager" },
  // Her Phoenix CRM weekly plan sits in her own section, since the Phoenix CRM row is never hers.
  "/employee-portals/field-crm/plan": { icon: "calendar-outline", section: "Training Manager" },
  // ── Phoenix CRM ───────────────────────────────────────────────────────────────────────────────
  // Its own band above My Workspace on the sidebar (owner, 2026-09-30), so its own section here too,
  // or the drift test fails on the mismatch.
  "/employee-portals/field-crm": { icon: "briefcase-outline", section: "Phoenix CRM" },
  // Place checks sits in the same band on the sidebar, so it is filed under the same section here —
  // the section is not a choice, it is whichever one `buildEmployeePortalSections` puts the href in,
  // and the drift test re-derives it from that builder rather than trusting this line.
  "/employee-portals/place-checks": { icon: "location-outline", section: "Phoenix CRM" },
  // The district manager's Visit report rides the same flag and band as Place checks.
  "/employee-portals/visit-report": { icon: "clipboard-outline", section: "Phoenix CRM" },
  // The Double visit requests report rides the same band, with its own flag (owner, 2026-10-16).
  "/employee-portals/double-visit-requests": { icon: "people-outline", section: "Phoenix CRM" },
  // ── My Workspace ──────────────────────────────────────────────────────────────────────────────
  "/employee-portals/interview-calendar": { icon: "videocam-outline", section: "My Workspace" },
  "/employee-portals/organogram": { icon: "business-outline", section: "My Workspace" },
  "/employee-portals/employee-360": { icon: "id-card-outline", section: "My Workspace" },
  "/employee-portals/business-cards": { icon: "id-card-outline", section: "Social" },
  "/employee-portals/email-signature": { icon: "mail-outline", section: "Social" },
  "/employee-portals/milestones": { icon: "ribbon-outline", section: "Social" },
  "/employee-portals/business-review": { icon: "analytics-outline", section: "My Workspace" },
  "/employee-portals/plans": { icon: "calendar-outline", section: "My Workspace" },
  "/employee-portals/plans/calendar": { icon: "calendar-number-outline", section: "My Workspace" },
  "/employee-portals/production-planning": { icon: "flask-outline", section: "My Workspace" },
  // ── Approvals Hub ─────────────────────────────────────────────────────────────────────────────
  "/employee-portals/approvals/vacation": { icon: "sunny-outline", section: "Approvals Hub" },
  "/employee-portals/approvals/excuse": { icon: "time-outline", section: "Approvals Hub" },
  "/employee-portals/approvals/plan": { icon: "calendar-clear-outline", section: "Approvals Hub" },
  "/employee-portals/marketing-requests/inbox": { icon: "mail-outline", section: "Approvals Hub" },
  "/employee-portals/market-awareness/inbox": { icon: "mail-unread-outline", section: "Approvals Hub" },
  "/employee-portals/approvals-hub": { icon: "file-tray-full-outline", section: "Approvals Hub" },
  // ── Sales Data ────────────────────────────────────────────────────────────────────────────────
  "/employee-portals/source-of-sales": { icon: "bar-chart-outline", section: "Sales Data" },
  "/employee-portals/weekly-sales": { icon: "stats-chart-outline", section: "Sales Data" },
  "/employee-portals/weekly-stock": { icon: "cube-outline", section: "Sales Data" },
  "/employee-portals/territory-drilldown": { icon: "git-branch-outline", section: "Sales Data" },
  "/employee-portals/direct-orders": { icon: "cart-outline", section: "Sales Data" },
  "/employee-portals/direct-orders-in-my-area": { icon: "search-outline", section: "Sales Data" },
  // ── Performance ───────────────────────────────────────────────────────────────────────────────
  "/employee-portals/sales-vs-target": { icon: "speedometer-outline", section: "Performance" },
  "/employee-portals/monthly-closing": { icon: "checkmark-done-outline", section: "Performance" },
  "/employee-portals/monthly-closing/performance-review": { icon: "podium-outline", section: "Performance" },
  "/employee-portals/team-performance": { icon: "trophy-outline", section: "Performance" },
  "/employee-portals/med-reps-performance": { icon: "ribbon-outline", section: "Performance" },
  "/employee-portals/dsms-performance": { icon: "medal-outline", section: "Performance" },
  "/employee-portals/incentive": { icon: "gift-outline", section: "Performance" },
  "/employee-portals/probation": { icon: "checkbox-outline", section: "Performance" },
  // ── Forecast & Target ─────────────────────────────────────────────────────────────────────────
  "/employee-portals/make-it-happen": { icon: "sparkles-outline", section: "Forecast & Target" },
  "/employee-portals/field-crm/forecast": { icon: "today-outline", section: "Forecast & Target" },
  "/employee-portals/targets": { icon: "locate-outline", section: "Forecast & Target" },
  // Filed in the same section the sidebar puts it in, beside Targets — the placement is derived from
  // buildEmployeePortalSections, so a registry entry without one drops out of the list silently.
  "/employee-portals/spotlight": { icon: "trophy-outline", section: "Social" },
  // ── Recruitment ───────────────────────────────────────────────────────────────────────────────
  "/employee-portals/vacancies": { icon: "person-add-outline", section: "Recruitment" },
  "/employee-portals/recruitment-candidates": { icon: "person-circle-outline", section: "Recruitment" },
  "/employee-portals/territory-management": { icon: "map-outline", section: "Recruitment" },
  // ── iReports 360 ──────────────────────────────────────────────────────────────────────────────
  "/employee-portals/visits": { icon: "navigate-outline", section: "iReports 360" },
  "/employee-portals/early-birds": { icon: "partly-sunny-outline", section: "iReports 360" },
  "/employee-portals/ranks": { icon: "star-outline", section: "iReports 360" },
  "/employee-portals/crm": { icon: "server-outline", section: "iReports 360" },
  "/employee-portals/reps-list": { icon: "people-outline", section: "iReports 360" },
  "/employee-portals/dv-planner": { icon: "duplicate-outline", section: "iReports 360" },
  "/employee-portals/double-visit-report": { icon: "document-attach-outline", section: "iReports 360" },
  // Field Activity arrived on main (#4700) after the owner filled in his placement sheet, so the
  // sheet has no answer for it and it keeps the seat main gave it — under the DV rows, here.
  "/employee-portals/field-activity": { icon: "map-outline", section: "iReports 360" },
  "/employee-portals/team-calendar": { icon: "people-circle-outline", section: "iReports 360" },
  "/employee-portals/field-absence": { icon: "calendar-clear-outline", section: "iReports 360" },
  // ── KPIs ──────────────────────────────────────────────────────────────────────────────────────
  // A heading of its own on the sidebar since 2026-10-14; the Summary keeps the pulse glyph it had.
  "/employee-portals/kpis": { icon: "pulse-outline", section: "KPIs" },
  "/employee-portals/kpis/frequency": { icon: "repeat-outline", section: "KPIs" },
  "/employee-portals/kpis/coverage": { icon: "radio-outline", section: "KPIs" },
  "/employee-portals/kpis/call-rate": { icon: "call-outline", section: "KPIs" },
  // ── Marketing & ROI ───────────────────────────────────────────────────────────────────────────
  "/employee-portals/market-awareness": { icon: "megaphone-outline", section: "Marketing & ROI" },
  "/employee-portals/marketing-requests/validation": { icon: "shield-checkmark-outline", section: "Marketing & ROI" },
  "/employee-portals/marketing-requests": { icon: "send-outline", section: "Marketing & ROI" },
  "/employee-portals/marketing-requests/control": { icon: "options-outline", section: "Marketing & ROI" },
  "/employee-portals/marketing-requests/all": { icon: "list-outline", section: "Marketing & ROI" },
  "/employee-portals/marketing-requests/customer-database": { icon: "library-outline", section: "Marketing & ROI" },
  "/employee-portals/roi": { icon: "trending-up-outline", section: "Marketing & ROI" },
  "/employee-portals/roi-tracker": { icon: "flag-outline", section: "Marketing & ROI" },
  // ── Payroll ───────────────────────────────────────────────────────────────────────────────────
  "/employee-portals/payslips": { icon: "document-text-outline", section: "Payroll" },
  "/employee-portals/deductions": { icon: "receipt-outline", section: "Payroll" },
  "/employee-portals/disputes": { icon: "chatbubble-ellipses-outline", section: "Payroll" },
  // ── Outstation Expenses ───────────────────────────────────────────────────────────────────────
  "/employee-portals/expenses": { icon: "car-outline", section: "Outstation Expenses" },
  "/employee-portals/expense-dashboard": { icon: "cash-outline", section: "Outstation Expenses" },
  "/employee-portals/expense-submissions": { icon: "albums-outline", section: "Outstation Expenses" },
  "/employee-portals/submit-expense": { icon: "add-circle-outline", section: "Outstation Expenses" },
  "/employee-portals/team-expenses": { icon: "wallet-outline", section: "Outstation Expenses" },
  // ── Leaves Management ─────────────────────────────────────────────────────────────────────────
  "/employee-portals/vacation-request": { icon: "airplane-outline", section: "Leaves Management" },
  "/employee-portals/vacation-report": { icon: "reader-outline", section: "Leaves Management" },
  "/employee-portals/excuses": { icon: "alarm-outline", section: "Leaves Management" },
  "/employee-portals/fingerprint-analytics": { icon: "finger-print-outline", section: "Leaves Management" },
  // ── Other ─────────────────────────────────────────────────────────────────────────────────────
  "/employee-portals/report-it": { icon: "medkit-outline", section: "Other" },
  "/employee-portals/contact-hr-support": { icon: "headset-outline", section: "Other" },
};

/** What the app renders for one module. */
export type NativePortalModule = {
  /** The live pending-count badge this destination carries, or null. Mirrors the web bottom bar's dot. */
  badge: PortalNavEntry["navBadge"] | null;
  href: string;
  /** Ionicons glyph name. */
  icon: string;
  /** The descriptive name — the app has room for it, so it never shows the bottom bar's short form. */
  label: string;
  /**
   * True when an administrator has temporarily locked this module. The row stays, wearing a padlock,
   * exactly as the web sidebar keeps it: removing it would say "this was removed", which is a harsher
   * message than the administrator chose to send.
   */
  locked: boolean;
};

export type NativePortalModuleSection = {
  modules: NativePortalModule[];
  title: NativeModuleSection;
};

/** Every placement, for the drift test. Not for rendering — the viewer's own list comes from below. */
export function nativeModulePlacements(): Readonly<
  Record<string, { icon: string; section: NativeModuleSection }>
> {
  return MODULE_PLACEMENT;
}

/**
 * The viewer's modules, grouped and ordered as the sidebar groups and orders them.
 *
 * `lockedModuleKeys` is what `resolveModuleLocksForAccess` returned for this viewer — pass an empty
 * array when locks could not be read, which is how the portal shell already fails (a lock read that
 * goes wrong must never be able to take the portal away from an employee).
 *
 * An entry with no placement is DROPPED rather than guessed into a section: the test below makes that
 * unreachable in a merged build, and silently mis-filing a live module is worse than a build-time
 * failure.
 */
export function buildNativePortalModuleDirectory(input: {
  lockedModuleKeys: readonly string[];
  visibility: EmployeePortalNavVisibility;
}): NativePortalModuleSection[] {
  const locked = [...input.lockedModuleKeys];
  const bySection = new Map<NativeModuleSection, NativePortalModule[]>();
  const seen = new Set<string>();

  for (const entry of PORTAL_NAV_REGISTRY) {
    if (seen.has(entry.href)) continue;
    if (!isEntryVisible(entry, input.visibility)) continue;

    const placement = MODULE_PLACEMENT[entry.href];
    if (!placement) continue;

    seen.add(entry.href);

    const modules = bySection.get(placement.section) ?? [];
    modules.push({
      badge: entry.navBadge ?? null,
      href: entry.href,
      icon: placement.icon,
      label: entry.fullLabel,
      locked: locked.length > 0 && resolveLockedModuleForPath(entry.href, locked) !== null,
    });
    bySection.set(placement.section, modules);
  }

  return NATIVE_MODULE_SECTION_ORDER.map((title) => ({
    modules: bySection.get(title) ?? [],
    title,
  })).filter((section) => section.modules.length > 0);
}
