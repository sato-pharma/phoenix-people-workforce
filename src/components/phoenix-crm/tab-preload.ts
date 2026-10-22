/**
 * Phoenix CRM — start downloading one module's screen before it is needed.
 *
 * 🔴 WHY THIS EXISTS (owner, 2026-10-01: "slow to transfer between page and page", Phoenix CRM first).
 * `phoenix-crm-app.tsx` used to import every module's screen statically — Visits, List, Plan, Team,
 * Calendar, Directory, Reports and the Super Admin's Settings — so every module page shipped all of
 * them as ONE 108 KB (gzip) chunk, 140 KB with its neighbours, measured on the production build. A rep
 * opening Visits downloaded Reports, Team and Settings too, and any deploy that touched one of them made
 * him download the whole lot again. The screens are now `next/dynamic`, one chunk each.
 *
 * The one cost of splitting is order: on a client navigation a lazy screen's chunk would only be asked
 * for once the page has arrived and rendered. These thunks close that gap — the chooser card calls one
 * at the touch, and `openTab` calls one beside `router.push` — so the chunk downloads alongside the
 * page instead of after it. Each thunk is the SAME specifier `phoenix-crm-app.tsx` hands `dynamic()`,
 * so the bundler resolves both to one chunk and the browser fetches it once.
 *
 * Deliberately a separate module with nothing else in it: the chooser imports this, and importing the
 * app itself would put the whole app back into the chooser's bundle.
 */

import type { PhoenixCrmModuleKey } from "@/lib/phoenix-crm/modules";

const TAB_CHUNKS: Record<PhoenixCrmModuleKey, () => Promise<unknown>> = {
  visits: () => import("@/components/phoenix-crm/visits-tab"),
  list: () => import("@/components/phoenix-crm/list-tab"),
  plan: () => import("@/components/phoenix-crm/plan-board"),
  forecast: () => import("@/components/phoenix-crm/forecast-tab"),
  team: () => import("@/components/phoenix-crm/team-tab"),
  calendar: () => import("@/components/phoenix-crm/calendar-tab"),
  "doctors": () => import("@/components/phoenix-crm/doctors-tab"),
  reports: () => import("@/components/phoenix-crm/reports-tab"),
  settings: () => import("@/components/phoenix-crm/settings-tab"),
  testAccounts: () => import("@/components/phoenix-crm/test-accounts-tab"),
};

/** Begins the download of a module's screen. Never throws: a failed preload just means the page asks again. */
export function preloadPhoenixCrmTab(key: PhoenixCrmModuleKey): void {
  void TAB_CHUNKS[key]().catch(() => undefined);
}
