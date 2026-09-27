/**
 * The slice of `PortalHomeSnapshot` this app reads.
 *
 * Declared here rather than imported from `src/lib/employee-portal/home-snapshot.ts` on purpose.
 * That module is a server module — it pulls in the Supabase admin client, `next/headers` and the
 * whole permissions graph — and a React Native typecheck that reached into it would drag all of
 * that into a bundle that cannot run any of it.
 *
 * The cost of that separation is that this file can drift from the server's shape, so it is written
 * narrow and defensively: every field the app renders is optional or nullable, and a screen that
 * receives a snapshot missing a section renders the sections it did get. A field added on the server
 * appears here only when a screen actually needs it.
 *
 * `navigationMode` is added by `app/api/employee-portals/home/route.ts`, not by the snapshot itself.
 */

export type PortalEmployee = {
  area: string | null;
  department: string | null;
  fullName: string;
  hrId: string;
  line: string | null;
  manager: string | null;
  photoUrl?: string | null;
  roleLabel: string;
  status: string;
  territory: string | null;
};

/**
 * Field KPIs for a medical rep.
 *
 * NOTE ON THE CALL RATE: `amRate` and `pmRate` are reported apart and never averaged — AM is scored
 * against 2 calls and PM against 10, so a combined figure is meaningless. That is a locked rule in
 * this system, pinned by a test in the web app's required CI check. Never render them as one number
 * and never join them with a slash.
 */
export type MrFieldKpis = {
  amRate: number | null;
  amTarget: number;
  amVerified: number;
  coveragePct: number;
  frequencyPct: number;
  hasCallRate: boolean;
  hasMeasurablePlan: boolean;
  missedDoctors: number;
  monthLabel: string;
  plannedDoctors: number;
  pmRate: number | null;
  pmTarget: number;
  pmVerified: number;
  visitedDoctors: number;
  workingDays: number;
};

export type PortalHome = {
  navigationMode: string;
  role: string;
  shell: { employee: PortalEmployee };

  leaveEntitlementDays: number | null;
  mrFieldKpis: MrFieldKpis | null;
  mrPendingExpenseCount: number | null;
  mrSalesAchievement: { achievementPercent: number; salesValue: number; targetValue: number } | null;
  pendingCountsAvailable: boolean;
  pendingExcuseCount: number;
  pendingVacationCount: number;
  plansAwaitingManagerApproval: number | null;
  plansCountAvailable: boolean;

  // `latestPayslip` is deliberately absent. The server strips it from this endpoint: no payslip
  // appears on any overview or landing screen for any role — not the amount, not the month label.
  // If you find yourself wanting it here, the answer is a Payslips screen, not a home-screen tile.
};

/**
 * One of the caller's own outstation trips still owing its departure photo, from
 * `/api/outstation/departure-photo-due` — `OutstationDeparturePhotoDue` on the server, the same list
 * the portal's "Departure photo needed" card renders. The dates are calendar dates, `YYYY-MM-DD`.
 */
export type DeparturePhotoDue = {
  destination: string;
  id: number;
  tripEndDate: string;
  tripStartDate: string;
};

/**
 * One module in the portal's own module list, from `/api/employee-portals/navigation`.
 *
 * `icon` is an Ionicons glyph name chosen server-side, in
 * `src/lib/employee-portal/native-module-directory.ts`, because a Lucide component does not cross
 * JSON and React Native cannot render one. `badge` names a pending-count badge the web bottom bar
 * shows as a dot; the counts themselves come from the home snapshot.
 */
export type PortalModule = {
  badge: string | null;
  href: string;
  icon: string;
  label: string;
  /** Temporarily locked by an administrator. The row stays, wearing a padlock, as the sidebar keeps it. */
  locked: boolean;
};

export type PortalModuleSection = {
  modules: PortalModule[];
  title: string;
};

export type PortalModuleDirectory = {
  sections: PortalModuleSection[];
};
