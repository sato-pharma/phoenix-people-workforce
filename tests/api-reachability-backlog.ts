import type { ApiAuthMode } from "./support/api-caller-census";

/**
 * THE API REVERSE GUARD'S BACKLOG — every route handler nothing in this repository calls.
 *
 * This is the API-surface twin of tests/navigation-reachability-backlog.ts, and it exists for the
 * same reason, one layer down. That file answers *a page a role can open that no surface links to*;
 * this one answers **a handler that serves perfectly and that no line of code asks for**. Both fail
 * silently, and both look exactly like a feature nobody happens to use yet.
 *
 * Forward coverage was already total and could never have found these. src/lib/security/access-registry.ts
 * declares all 1,061 routes and CI forces it to stay complete, so the registry answers *is this
 * route accounted for?* — never *does anything call it?*. A handler whose caller was deleted keeps
 * its registry row, its permission and its green check for ever.
 *
 * ## It is asserted BY IDENTITY, so this file cannot rot
 *
 * tests/api-granted-but-uncalled.test.ts measures the live census and asserts it equals exactly this
 * record. A new uncalled handler fails here, and a handler that GAINS a caller fails here too until
 * its now-stale row is deleted. A ceiling would have let those two cancel out; identity does not.
 *
 * ## Recording a route here is not a to-do, and deleting one is not a fix
 *
 * 26 of the 66 uncalled routes are not in this file at all: a route whose declared `authMode` is
 * `cron-secret`, `webhook-secret`, `machine-token` or `public-token` is called from OUTSIDE this
 * repository by definition — the production scheduler at cron-job.org, a provider's webhook, the
 * attendance agent, a share link in somebody's inbox — so having no in-repo caller is the correct
 * state for all of them and recording it would be noise. They are excluded mechanically by mode, the
 * way the navigation backlog excludes redirect-only stubs. Only `session` routes land here, because
 * only a session route needs a browser, and a browser needs a line of code.
 *
 * And the single biggest group below — 22 of 40 — is not a defect either. It is what a
 * server-rendered app looks like from this angle: the page is a server component that imports the
 * domain service directly (which CLAUDE.md's domain-first rule asks for), so the GET handler
 * wrapping that same service is a second door into the same room. `/api/sales/truth-check` sits
 * beside `app/(admin)/sales/truth-check/page.tsx` and both call `@/lib/sales/sales-truth-report`.
 * Deleting those handlers is a real option and so is keeping them, but it is a judgement about
 * surface area that belongs to the owner, not a cleanup a session performs on its own authority —
 * every one of them is a live permissioned endpoint today.
 *
 * Measured 2026-10-08 on 1,061 route handlers: 857 called by a line that names them, 138 reached by
 * a URL built at runtime, 66 reached by nothing — 26 of those external-by-declaration, 40 recorded
 * here, and 37 route handlers that the earlier sweeps had wrongly accused before the census learned
 * to read nested template literals, interpolated origins and callers outside `app/` and `src/`.
 */
export type ApiReachabilityGapKind =
  /**
   * The server half of a feature whose UI is deliberately switched off. All seven workflow-control
   * handlers work; the buttons that would call them render `disabled` with titles like "Phase 3
   * persistence required", and no workflow-control component contains a single `fetch(`.
   */
  | "disabled-ui-server-half"
  /**
   * The owner retired the UI by ruling, and the handler stayed. **Not dead code** — the retirement
   * was a decision, and reversing it is his, so these must survive any cleanup.
   */
  | "delisted-by-ruling"
  /**
   * A GET handler wrapping a domain service the feature's own server page already imports. The page
   * renders the data server-side; the handler is a parallel door nobody walks through.
   */
  | "server-page-reads-the-service"
  /**
   * A mutation fired by hand — a sync, a backfill, a test send. No UI wires it, by design, and the
   * route is how an operator reaches it.
   */
  | "operator-only-mutation"
  /** Nothing anywhere names it and no page is its twin. The finding this guard exists to surface. */
  | "no-caller-anywhere";

export type ApiReachabilityGap = {
  /** The URL the handler serves, dynamic segments as `[param]`, exactly as the census reports it. */
  readonly route: string;
  /** As src/lib/security/access-registry.ts declares it. Always `session` — see the header. */
  readonly authMode: ApiAuthMode;
  readonly kind: ApiReachabilityGapKind;
  /** Why it has no caller, in terms a reader can go and check. */
  readonly reason: string;
  readonly recorded: string;
};

export const API_REACHABILITY_GAP_KINDS: readonly ApiReachabilityGapKind[] = [
  "disabled-ui-server-half",
  "delisted-by-ruling",
  "server-page-reads-the-service",
  "operator-only-mutation",
  "no-caller-anywhere",
];

export const API_REACHABILITY_BACKLOG: readonly ApiReachabilityGap[] = [
  // ── the server half of a UI that is deliberately switched off ────────────────────────────────
  {
    route: "/api/admin/workflow-control/compare",
    authMode: "session",
    kind: "disabled-ui-server-half",
    reason:
      "Workflow Control's entire API family is unreached: no component under src/components/workflow-control/ contains a `fetch(`, and the editor's Save, Publish and Rollback buttons are hard-coded `disabled` with titles 'Phase 3 persistence required' and 'Requires Phase 3 versioning + approval'. The handlers are finished and waiting for that phase.",
    recorded: "2026-10-08",
  },
  {
    route: "/api/admin/workflow-control/definitions",
    authMode: "session",
    kind: "disabled-ui-server-half",
    reason:
      "Read-only listing of the static workflow domains. app/(admin)/admin/workflow-control/page.tsx is a server component that gets the same data by importing the service, so even the enabled half of this screen never calls the API.",
    recorded: "2026-10-08",
  },
  {
    route: "/api/admin/workflow-control/drafts/[domainKey]/[subflowKey]",
    authMode: "session",
    kind: "disabled-ui-server-half",
    reason:
      "GET loads a draft, PUT saves one. The editor's save button is `disabled title=\"Phase 3 persistence required\"`, so nothing can reach either method yet.",
    recorded: "2026-10-08",
  },
  {
    route: "/api/admin/workflow-control/drafts/by-id/[draftId]",
    authMode: "session",
    kind: "disabled-ui-server-half",
    reason:
      "DELETE for a saved draft. Saved drafts cannot exist while persistence is off — the button that would list them reads 'Saved drafts unavailable until persistence is enabled'.",
    recorded: "2026-10-08",
  },
  {
    route: "/api/admin/workflow-control/publish/[draftId]",
    authMode: "session",
    kind: "disabled-ui-server-half",
    reason:
      "Publishes a draft version. Its button is `disabled title=\"Requires Phase 3 versioning + approval\"`.",
    recorded: "2026-10-08",
  },
  {
    route: "/api/admin/workflow-control/rollback",
    authMode: "session",
    kind: "disabled-ui-server-half",
    reason:
      "Rolls back to a published version. Its button is `disabled title=\"Rollback requires published versions\"`, and no version can be published while publish is off.",
    recorded: "2026-10-08",
  },
  {
    route: "/api/admin/workflow-control/versions/[domainKey]/[subflowKey]",
    authMode: "session",
    kind: "disabled-ui-server-half",
    reason:
      "Lists published versions of a subflow — the read side of the same disabled publish/rollback pair.",
    recorded: "2026-10-08",
  },

  // ── retired by the owner's own ruling: keep ──────────────────────────────────────────────────
  {
    route: "/api/crm/doctor-coverage/config",
    authMode: "session",
    kind: "delisted-by-ruling",
    reason:
      "The server half of /admin/doctor-coverage-settings, one of the three doctor-coverage cards the owner retired from navigation on 2026-08-28 (the ruling is written out at src/config/system-navigation.ts:4184). The UI went, the GET/PATCH handler stayed. Reversing that retirement is his call, so this is not dead code to be swept.",
    recorded: "2026-10-08",
  },
  {
    route: "/api/phoenix-crm/double-visit-plans",
    authMode: "session",
    kind: "delisted-by-ruling",
    reason:
      "The district manager's double-visit planner, replaced on 2026-10-16 by his weekly plan in Phoenix CRM (the owner's ruling: it REPLACES the old district-manager plan). Its screen, src/components/phoenix-crm/double-visit-plan-section.tsx, was deleted in that change; POST now answers 410 and GET stays so the one week already filed can still be read. The Visit report reads those rows server-side (readDoubleVisitPlansForReport in src/lib/phoenix-crm/server/double-visit-plans.ts, called from visit-report.ts), never through this route.",
    recorded: "2026-10-17",
  },

  // ── a GET beside a server page that imports the very same service ────────────────────────────
  {
    route: "/api/admin/distribution-lists",
    authMode: "session",
    kind: "server-page-reads-the-service",
    reason:
      "app/(admin)/admin/distribution-lists/page.tsx imports @/lib/distribution-lists/service directly. The only client call in the feature is `fetch(`/api/admin/distribution-lists/${listKey}`)` — the item route, never this collection.",
    recorded: "2026-10-08",
  },
  {
    route: "/api/admin/email-templates",
    authMode: "session",
    kind: "server-page-reads-the-service",
    reason:
      "app/(admin)/admin/email-templates/page.tsx imports @/lib/email-templates/service. The template manager calls eight children of this path (designer-metadata, custom-variables, validate-draft, test, /[templateKey]) and never the collection itself.",
    recorded: "2026-10-08",
  },
  {
    route: "/api/admin/notification-confidence",
    authMode: "session",
    kind: "server-page-reads-the-service",
    reason:
      "app/(admin)/admin/notification-confidence/page.tsx imports @/lib/notifications/confidence-gate. The workspace's one call is `fetch(`/api/admin/notification-confidence/${review.id}/${action}`)`, an item action.",
    recorded: "2026-10-08",
  },
  {
    route: "/api/admin/notification-confidence/pending",
    authMode: "session",
    kind: "server-page-reads-the-service",
    reason:
      "The pending queue the same server page already resolves through @/lib/notifications/confidence-gate before it renders.",
    recorded: "2026-10-08",
  },
  {
    route: "/api/admin/notification-recipients",
    authMode: "session",
    kind: "server-page-reads-the-service",
    reason:
      "app/(admin)/admin/notification-recipients/page.tsx imports @/lib/notifications/role-recipients and hands the result to notification-role-recipients-center.tsx as props.",
    recorded: "2026-10-08",
  },
  {
    route: "/api/admin/synthetic-journeys/latest",
    authMode: "session",
    kind: "server-page-reads-the-service",
    reason:
      "app/(admin)/admin/synthetic-journeys/page.tsx imports `getLatestRun, listRuns` from @/lib/synthetic-journeys/service — the exact two functions this route and its sibling wrap.",
    recorded: "2026-10-08",
  },
  {
    route: "/api/admin/synthetic-journeys/runs",
    authMode: "session",
    kind: "server-page-reads-the-service",
    reason:
      "Same page, same `listRuns` import. The dashboard's only call is `fetch(`/api/admin/synthetic-journeys/runs/${runId}`)` — one run, never the list.",
    recorded: "2026-10-08",
  },
  {
    route: "/api/attendance/disputes",
    authMode: "session",
    kind: "server-page-reads-the-service",
    reason:
      "app/(admin)/attendance/disputes/page.tsx imports @/lib/attendance/digest-service. The review inbox calls only `fetch(`/api/attendance/disputes/${lineId}/review`)`. The access registry grants this collection `readOnly`, which is the gate the handler's own comment warns about — a matrix grant alone once let a Regional Manager export 69 employees' deductions — so it stays guarded whether or not it is called.",
    recorded: "2026-10-08",
  },
  {
    route: "/api/contracts",
    authMode: "session",
    kind: "server-page-reads-the-service",
    reason:
      "app/(admin)/contracts/page.tsx and app/employee-portals/contracts/page.tsx both import @/lib/contracts/service. The action centre's only call is `callApi(`/api/contracts/${selected.id}/workflow`)`.",
    recorded: "2026-10-08",
  },
  {
    route: "/api/customer-identity/suggestions",
    authMode: "session",
    kind: "server-page-reads-the-service",
    reason:
      "app/(admin)/admin/customer-links/page.tsx imports @/lib/customer-identity/server/reads, the module this route wraps, and renders the suggestions server-side.",
    recorded: "2026-10-08",
  },
  {
    route: "/api/direct-orders/held",
    authMode: "session",
    kind: "server-page-reads-the-service",
    reason:
      "The held desk is a server page — app/(admin)/admin/direct-orders/(desks)/held/page.tsx — importing @/lib/direct-orders/service and passing rows into held-desk.tsx.",
    recorded: "2026-10-08",
  },
  {
    route: "/api/direct-orders/rep-counters",
    authMode: "session",
    kind: "server-page-reads-the-service",
    reason:
      "app/(admin)/admin/direct-orders/(desks)/rep-counters/page.tsx imports @/lib/direct-orders/rep-counters. The route's only other mention is tests/direct-orders-rep-counters.test.ts.",
    recorded: "2026-10-08",
  },
  {
    route: "/api/employee-portals/territory-drilldown",
    authMode: "session",
    kind: "server-page-reads-the-service",
    reason:
      "app/employee-portals/territory-drilldown/page.tsx imports @/lib/sales/territory/service. use-territory-tree.ts fetches children of this path, not the path itself.",
    recorded: "2026-10-08",
  },
  {
    route: "/api/probation/analytics",
    authMode: "session",
    kind: "server-page-reads-the-service",
    reason:
      "app/(admin)/probation/analytics/page.tsx imports @/lib/probation/intelligence/outcomes-analytics. Every other mention is a probation test.",
    recorded: "2026-10-08",
  },
  {
    route: "/api/probation/dashboard",
    authMode: "session",
    kind: "server-page-reads-the-service",
    reason:
      "app/(admin)/probation/dashboard/page.tsx imports @/lib/probation/intelligence/dashboard — an exact page-and-handler pair on one module.",
    recorded: "2026-10-08",
  },
  {
    route: "/api/probation/feedback-tasks",
    authMode: "session",
    kind: "server-page-reads-the-service",
    reason:
      "app/employee-portals/probation/page.tsx and .../feedback/[dvDayId]/page.tsx import @/lib/probation/intelligence/feedback-workflow and render the task list server-side.",
    recorded: "2026-10-08",
  },
  {
    route: "/api/recruitment/hiring-manager/candidates",
    authMode: "session",
    kind: "server-page-reads-the-service",
    reason:
      "app/(admin)/recruitment/candidates/page.tsx imports @/lib/recruitment/candidate-call-claims and @/lib/recruitment/candidates. The portal's candidate components call children of this path — call control, comments, CV actions — never the list.",
    recorded: "2026-10-08",
  },
  {
    route: "/api/recruitment/hiring-manager/team",
    authMode: "session",
    kind: "server-page-reads-the-service",
    reason:
      "app/(admin)/recruitment/candidates/page.tsx and app/employee-portals/recruitment-candidates/page.tsx both import @/lib/recruitment/hiring-manager-team.",
    recorded: "2026-10-08",
  },
  {
    route: "/api/recruitment/intake/analytics",
    authMode: "session",
    kind: "server-page-reads-the-service",
    reason:
      "app/(admin)/recruitment/intake-health/page.tsx and app/employee-portals/intake-health/page.tsx both import @/lib/recruitment/inbound/intake-analytics and pass the result to intake-health-view.tsx.",
    recorded: "2026-10-08",
  },
  {
    route: "/api/sales/closing-corrections",
    authMode: "session",
    kind: "server-page-reads-the-service",
    reason:
      "app/(admin)/sales/closing-corrections/page.tsx imports @/lib/sales/closing-corrections. Nothing else in the repository names this path.",
    recorded: "2026-10-08",
  },
  {
    route: "/api/sales/truth-check",
    authMode: "session",
    kind: "server-page-reads-the-service",
    reason:
      "app/(admin)/sales/truth-check/page.tsx imports @/lib/sales/sales-truth-report. Nothing else in the repository names this path.",
    recorded: "2026-10-08",
  },
  {
    route: "/api/spotlight/options",
    authMode: "session",
    kind: "server-page-reads-the-service",
    reason:
      "app/(admin)/spotlight/page.tsx and app/employee-portals/spotlight/page.tsx import @/lib/spotlight/org and @/lib/spotlight/period, so the period and org pickers are built server-side.",
    recorded: "2026-10-08",
  },

  // ── fired by hand, by design ─────────────────────────────────────────────────────────────────
  {
    route: "/api/attendance/sync-now",
    authMode: "session",
    kind: "operator-only-mutation",
    reason:
      "POST that pulls the local attendance agent on demand. Nothing in the repository mentions the path at all — it is reached by hand when a device falls behind.",
    recorded: "2026-10-08",
  },
  {
    route: "/api/notifications/test",
    authMode: "session",
    kind: "operator-only-mutation",
    reason:
      "POST that sends one test notification. Its only mention is scripts/phase21-security-readiness-smoke.ts, which READS app/api/notifications/test/route.ts as a file to assert on its source — a static check, not a call. Never fire it from a session: real outbound email from a business system is the owner's own decision, and every automated email also reaches his Telegram.",
    recorded: "2026-10-08",
  },
  {
    route: "/api/probation/backfill",
    authMode: "session",
    kind: "operator-only-mutation",
    reason:
      "POST that backfills probation intelligence and syncs double-visit data. Mentioned only by tests/probation-audit-fixes.test.ts and its round-2 sibling; run by hand after a data correction.",
    recorded: "2026-10-08",
  },

  // ── nothing names it, and no page is its twin ────────────────────────────────────────────────
  {
    route: "/api/admin/daily-deductions/publish",
    authMode: "session",
    kind: "no-caller-anywhere",
    reason:
      "The replace-everything publish that /admin/daily-deductions used before 2026-10-12. The page now releases one deduction at a time through /api/admin/daily-deductions/release and /withdraw, so nothing calls this route. It is kept (with phx_publish_daily_deductions behind it) rather than swept: deleting a live permissioned write endpoint is the owner's call. docs/daily-deductions-release.md.",
    recorded: "2026-10-12",
  },
  {
    route: "/api/attendance/agent/health",
    authMode: "session",
    kind: "no-caller-anywhere",
    reason:
      "GET wrapping `checkAttendanceAgentHealth` from @/lib/attendance/local-agent. Nothing names the path and no page imports that module, so the agent's health is not surfaced anywhere — the device-user mapping screen shows mappings, not agent health.",
    recorded: "2026-10-08",
  },
  {
    route: "/api/cv-database/template",
    authMode: "session",
    kind: "no-caller-anywhere",
    reason:
      "GET that builds the CV import template from @/lib/cv/cv-template. Mentioned only by tests/cv-database-recruiting-boundary.test.ts: no page links the download and no page imports the builder, so there is currently no way to get the template out of the system.",
    recorded: "2026-10-08",
  },
  {
    route: "/api/outstation/workload-evidence",
    authMode: "session",
    kind: "no-caller-anywhere",
    reason:
      "GET over @/lib/outstation/expenses and @/lib/double-visit-analytics/service. Both services are imported directly by server pages — the outstation expenses dashboard and the double-visit analytics screens — but no page is this route's twin and nothing names the path.",
    recorded: "2026-10-08",
  },
  {
    route: "/api/sales/weekly/pos-region-mappings",
    authMode: "session",
    kind: "no-caller-anywhere",
    reason:
      "GET lists the POS-to-region mappings and POST imports a spreadsheet of them (@/lib/uploads/spreadsheets). No page, component or script names the path — the weekly stock page does not, and the three weekly export routes that sit next to it reach the mappings by importing the library instead. So the upload has no form behind it.",
    recorded: "2026-10-08",
  },
  {
    route: "/api/sales/weekly/pos-region-mappings/template",
    authMode: "session",
    kind: "no-caller-anywhere",
    reason:
      "The download that would give someone the spreadsheet to fill in for the POST above. Nothing links it either, so the pair is a complete import workflow with no entry point.",
    recorded: "2026-10-08",
  },
];

export const API_REACHABILITY_BACKLOG_SIZE = API_REACHABILITY_BACKLOG.length;

/** The routes the guard's identity assertion compares its live census against. */
export function apiReverseGuardRecordedRoutes(): string[] {
  return API_REACHABILITY_BACKLOG.map((gap) => gap.route);
}

export function apiReachabilityGapsByKind(kind: ApiReachabilityGapKind): ApiReachabilityGap[] {
  return API_REACHABILITY_BACKLOG.filter((gap) => gap.kind === kind);
}
