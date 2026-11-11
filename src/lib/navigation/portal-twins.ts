import type { PhoenixRole } from "@/lib/auth/permissions";

/**
 * Where a portal-mode viewer belongs when they ask for an admin-shell address.
 *
 * ── The defect this fixes ────────────────────────────────────────────────────
 * `app/(admin)/layout.tsx` sends every portal-mode viewer to `/employee-portals` before
 * it returns its children, so no page in that group ever runs for one. Forty-one of those
 * pages nonetheless name the exact portal page such a viewer should have landed on —
 * `/admin/approvals/plan` names `/employee-portals/approvals/plan`, `/sales/targets` names
 * `/employee-portals/source-of-sales`. Not one of those lines could execute. Measured
 * 2026-08-30 against a real Medical Rep session: every request landed on the portal home.
 *
 * `app/(admin)/admin/direct-orders/[id]/page.tsx` even carries a comment explaining that
 * the hop "is meant to be invisible; dropping the return context here would make it
 * visible in the worst way — by losing their place." Losing their place is exactly what
 * happened, at every one of these addresses, for as long as the layout redirect has
 * existed.
 *
 * ── Why the answer lives here and not in the pages ───────────────────────────
 * The layout cannot be made to run second, and it cannot be removed: 79 pages in that
 * group have NO other server-side gate — no navigation-mode check and no permission check
 * — so the blanket redirect is the only thing in front of them. Deleting it to let the
 * pages speak for themselves would open all 79.
 *
 * So the destination has to be resolvable from the requested address alone, before any
 * page runs. It is: `proxy.ts` sets `x-phoenix-path` on every matched request and deletes
 * any incoming copy first, so the value cannot be forged by a client.
 *
 * ── This table invents nothing ───────────────────────────────────────────────
 * Every rule is a destination a page already names in its own source, under the guard it
 * already uses. `tests/portal-twin-forwarding.test.ts` re-derives the whole set from the
 * pages and fails if the two ever disagree, in either direction — a new page that names a
 * twin and forgets this table turns the build red, and so does a rule here for a page that
 * no longer says it. Two rules have a different provenance and are marked `nav-declared`
 * below; the test knows about exactly those two and no others.
 *
 * A page whose only portal redirect is the bare `/employee-portals` is deliberately absent:
 * it already gets what it asks for.
 *
 * ── This is routing, never permission ────────────────────────────────────────
 * Resolving a twin decides only WHICH portal address a portal-mode viewer is sent to. It
 * grants nothing — the destination enforces its own access exactly as when it is reached
 * from the portal sidebar. Every destination is inside `/employee-portals`, so the worst a
 * wrong rule can do is land someone on the wrong portal page, never on an admin one.
 */

type TwinRule = {
  /**
   * Path template. A `:name` segment matches exactly one segment and captures it; every
   * other segment must match literally. When several rules match, the one with the most
   * literal segments wins, so `/coaching/new` beats `/coaching/:id` whatever the order.
   */
  readonly from: string;
  /** Destination template. `:name` is substituted with the captured segment, verbatim. */
  readonly to: string;
  /**
   * Restrict the rule to these roles. Present only where the PAGE branches on role — the
   * coaching pages send a Training Manager somewhere different from a Medical Rep, and a
   * table that flattened that would be inventing an answer for one of them.
   */
  readonly roles?: readonly PhoenixRole[];
  /**
   * Query parameters to carry across the hop, by name. An allowlist rather than a flag,
   * because the pages themselves use one: the approvals hub keeps `module`/`id`/`tab`, and
   * a direct order keeps `from` — its return context, whose loss is the whole complaint
   * that page's own comment makes. Everything else is dropped, so no admin-side query is
   * replayed against a portal screen that would read it differently.
   */
  readonly carryQuery?: readonly string[];
};

/**
 * The portal's single sales surface. Many distinct admin sales tools name it; that is
 * their own answer, not a shortcut taken here.
 */
const SOS = "/employee-portals/source-of-sales";

/** Mirrors `isEmployeePortalRole` in the coaching pages, which is what branches there. */
const COACHING_PORTAL_ROLES: readonly PhoenixRole[] = ["Employee", "Medical Rep"];
/**
 * Mirrors `PORTAL_PERFORMANCE_REVIEW_ROLES`, which is what the admin Performance Review branches on.
 * Written out rather than imported because this module is a routing table with one import by
 * design, and the closing-performance-review-access module reaches the permissions engine.
 */
const PERFORMANCE_REVIEW_PORTAL_ROLES: readonly PhoenixRole[] = [
  "District Manager",
  "Regional Manager",
  "National Sales Manager",
];
/**
 * The other portal-mode sales roles, who have no scoped review of their own and so keep the Source of
 * Sales hub the page still names for them. Spelled out because the two rules share one `from`: an
 * unscoped sibling would swallow the three tiers above, which is the shadowing
 * `tests/portal-twin-forwarding.test.ts` checks for rule by rule.
 */
const PERFORMANCE_REVIEW_OTHER_PORTAL_ROLES: readonly PhoenixRole[] = [
  "Medical Rep",
  "Product Manager",
  "Group Product Manager",
  "Marketing Manager",
];
const TRAINING_MANAGER: readonly PhoenixRole[] = ["Training Manager"];

const TWIN_RULES: readonly TwinRule[] = [
  // ── Approvals ──────────────────────────────────────────────────────────────
  // Market Awareness ships in BOTH shells (owner answer 5), so a portal-mode viewer who follows
  // an admin link belongs on the portal half rather than at the portal root. `activity` is
  // carried so a deep link to one activity survives the hop.
  { from: "/admin/market-awareness", to: "/employee-portals/market-awareness", carryQuery: ["activity"] },
  // The admin door to the approvals inbox. Only the CEO and Super Admin are drawn it, but the Needs
  // You card is shared, so a Marketing Manager or National Sales Manager following it lands on his
  // own inbox instead of the workspace.
  { from: "/admin/market-awareness/inbox", to: "/employee-portals/market-awareness/inbox" },
  { from: "/admin/marketing-functions", to: "/employee-portals/marketing-functions", carryQuery: ["month", "author"] },
  { from: "/admin/marketing-feedback", to: "/employee-portals/marketing-feedback", carryQuery: ["tab"] },
  { from: "/admin/marketing-feedback/:id", to: "/employee-portals/marketing-feedback/:id" },
  // The Doctor-List Check's card is shared, and the Marketing Manager reads it in the portal.
  { from: "/admin/marketing-requests/list-check", to: "/employee-portals/marketing-requests/list-check" },
  // CEO Approvals is the Marketing Manager's report (owner, 2026-11-08), and she reads it in the portal.
  { from: "/admin/marketing-requests/ceo-approvals", to: "/employee-portals/marketing-requests/ceo-approvals", carryQuery: ["from", "to"] },
  { from: "/admin/approvals-hub", to: "/employee-portals/approvals-hub", carryQuery: ["module", "id", "tab"] },
  // An admin-only view of the same queue; the portal has no `stuck` page, so the page's
  // own source sends the viewer to the hub instead.
  { from: "/admin/approvals/stuck", to: "/employee-portals/approvals-hub" },
  { from: "/admin/approvals/excuse", to: "/employee-portals/approvals/excuse" },
  { from: "/admin/approvals/excuse/:id", to: "/employee-portals/approvals/excuse/:id" },
  { from: "/admin/approvals/plan", to: "/employee-portals/approvals/plan" },
  { from: "/admin/approvals/plan/:id", to: "/employee-portals/approvals/plan/:id" },
  { from: "/admin/approvals/vacation", to: "/employee-portals/approvals/vacation" },
  { from: "/admin/approvals/vacation/:id", to: "/employee-portals/approvals/vacation/:id" },
  // Vacation-day work (CRM phase 6): the administrator answers on the admin page; reps ask and
  // managers answer on the portal page, which the admin page's own source also names.
  { from: "/admin/approvals/vacation-day-work", to: "/employee-portals/visits/vacation-day-requests" },
  // Doctor lists (CRM phase 7): the SFE Manager and administrator edit on the admin page; reps ask and
  // managers answer on the portal page.
  { from: "/admin/doctor-list-changes", to: "/employee-portals/visits/doctor-list" },
  // The retired 2026-09-14 Phoenix CRM pilot (the owner, 2026-09-25). Its portal page is only a
  // forward now: it maps the pilot's tab (planning → plan, kpis → reports) and lands on the field app.
  { from: "/admin/phoenix-crm", to: "/employee-portals/phoenix-crm", carryQuery: ["tab"] },
  // Phoenix CRM, the clean module (the owner, 2026-09-16): customer lists, weekly plans, visits and
  // reports. Only the tab crosses, as the admin page's own preservedQuery does.
  { from: "/admin/field-crm", to: "/employee-portals/field-crm", carryQuery: ["tab"] },
  // A team-calendar square opens the day in the shell the calendar was read in (owner, 2026-10-24); a
  // portal-mode viewer handed an admin day address lands on the same day in the portal, test mode kept.
  { from: "/admin/field-crm/day/:seatId/:date", to: "/employee-portals/field-crm/day/:seatId/:date", carryQuery: ["test"] },
  {
    from: "/admin/field-crm/manager-day/:seatId/:date",
    to: "/employee-portals/field-crm/manager-day/:seatId/:date",
    carryQuery: ["test"],
  },
  // Plan verification (audit, 2026-09-21). The roles that hold `crm_plans:approve` — District and
  // Regional Manager — are PORTAL seats, and the plan notification links straight to the admin page.
  // The (admin) layout bounced them to the portal home, so the only screen their grant unlocks was
  // unreachable from its own notification. The portal Reps List plans tab IS that screen; `plan` and
  // `week` ride across so the link lands on the plan they were told about, and the plans tab opens
  // when a `plan` is present. The admin page names this destination in its own source.
  { from: "/admin/plan-verification", to: "/employee-portals/reps-list", carryQuery: ["plan", "week"] },
  // Field Activity (#4647, corrected here). Five of its eight roles — DM, RM, NSM, PM and GPM — are
  // PORTAL seats, and the module shipped with only an /admin/ page, so the layout bounced every one
  // of them to the portal home: the sidebar row they were given pointed at an address their own
  // shell refuses. The portal half is a real page with the same gate; the admin page names it.
  { from: "/admin/field-activity", to: "/employee-portals/field-activity" },
  { from: "/admin/field-absence", to: "/employee-portals/field-absence" },

  // ── Direct orders ──────────────────────────────────────────────────────────
  { from: "/admin/direct-orders", to: "/employee-portals/direct-orders" },
  { from: "/admin/direct-orders/new", to: "/employee-portals/direct-orders/new" },
  { from: "/admin/direct-orders/report", to: "/employee-portals/direct-orders/report" },
  { from: "/admin/direct-orders/:id", to: "/employee-portals/direct-orders/:id", carryQuery: ["from"] },

  // ── Team Coaching Skills Survey (owner, 2026-10-31) — ahead of the coaching block, whose
  // `/coaching/:id` would otherwise read "skills-survey", "new" or "import" as a report id. The old
  // form's create and import pages now land on the survey, for every role.
  { from: "/coaching/skills-survey", to: "/employee-portals/coaching-skills-survey", carryQuery: ["quarter", "tab"] },
  { from: "/coaching/skills-survey/:hrId", to: "/employee-portals/coaching-skills-survey/:hrId", carryQuery: ["quarter"] },
  { from: "/coaching/new", to: "/employee-portals/coaching-skills-survey" },
  { from: "/coaching/import", to: "/employee-portals/coaching-skills-survey" },

  // ── Coaching: the pages branch on role, so these rules do too ──────────────
  { from: "/coaching", to: "/employee-portals/training-manager/field-coaching", roles: TRAINING_MANAGER },
  { from: "/coaching", to: "/employee-portals/coaching", roles: COACHING_PORTAL_ROLES },
  { from: "/coaching/analytics", to: "/employee-portals/training-manager", roles: TRAINING_MANAGER },
  { from: "/coaching/analytics", to: "/employee-portals/coaching", roles: COACHING_PORTAL_ROLES },
  { from: "/coaching/:id", to: "/employee-portals/training-manager/field-coaching/:id", roles: TRAINING_MANAGER },
  { from: "/coaching/:id", to: "/employee-portals/coaching/:id", roles: COACHING_PORTAL_ROLES },
  { from: "/coaching/:id/edit", to: "/employee-portals/training-manager/field-coaching/:id/edit", roles: TRAINING_MANAGER },
  // Deliberately drops `/edit`: the portal coaching screen is read-only for these roles,
  // and dropping it is what the page itself does. Not a typo — the drift test pins it.
  { from: "/coaching/:id/edit", to: "/employee-portals/coaching/:id", roles: COACHING_PORTAL_ROLES },

  // ── One-to-one pages ───────────────────────────────────────────────────────
  // Contract Renewal (owner, 2026-11-11). The renewal reminder reaches the employee's manager chain,
  // and its button — /contracts, and now /contracts/recommend/<hrId> — sent every portal-shell
  // manager to the portal home. The portal page shows a manager his team's renewals; the
  // recommend page takes his Renew / Do not renew.
  { from: "/contracts", to: "/employee-portals/contracts" },
  { from: "/contracts/recommend/:hrId", to: "/employee-portals/contracts/recommend/:hrId" },
  { from: "/admin/report-it", to: "/employee-portals/report-it" },
  { from: "/admin/visual-aids", to: "/employee-portals/visual-aids" },
  // The Production Planner is dual-surface because two of the five people the owner named for it
  // are portal-shell viewers — including its main user, the Toll Manufacturing Manager.
  { from: "/admin/production-planning", to: "/employee-portals/production-planning" },
  // Guarded by capability rather than by navigation mode, so unlike the rest this one is
  // still live today for an admin-mode viewer who lacks the capability. For a PORTAL-mode
  // viewer the layout gets there first either way, and the portal's own private calendar
  // is where they belong.
  { from: "/admin/private-calendars", to: "/employee-portals/private-calendar" },
  { from: "/organogram", to: "/employee-portals/organogram" },
  // Spotlight: the admin page at /spotlight is Super Admin + CEO, company-wide; a portal-mode viewer
  // (a medical rep) is sent to his own self-only twin (owner, 2026-09-30). Backed by the redirect in
  // the admin page's portal branch, which tests/portal-twin-forwarding.test.ts checks in both directions.
  { from: "/spotlight", to: "/employee-portals/spotlight" },
  { from: "/probation", to: "/employee-portals/probation" },
  { from: "/recruitment/contact-review", to: "/employee-portals/contact-review" },
  // The interview calendar. Shared with a portal-mode person (a manager sitting in on interviews),
  // a link to it — from the share notice, or behind a name in an exported PDF — lands them on the
  // portal twin with the same week open and the same interview's CV up.
  { from: "/recruitment/interview-calendar", to: "/employee-portals/interview-calendar", carryQuery: ["week", "open"] },
  // The silent manager-engagement report. Its admin page sends a portal-mode viewer (a National
  // Sales Manager) to the portal twin, which scopes him to his own line — this table is what makes
  // that hop resolve before the (admin) layout's blanket redirect drops him on the portal home.
  { from: "/recruitment/manager-engagement", to: "/employee-portals/recruitment-engagement" },
  { from: "/reports/vacancies", to: "/employee-portals/vacancies" },
  { from: "/reports/vacancies/empty-seats", to: "/employee-portals/vacancies/empty-seats" },
  // nav-declared: these two pages carried a portal branch that RENDERED the portal shell
  // inline instead of redirecting — which the group layout had already made unreachable —
  // and it was deleted 2026-08-30 (PR #2777). The destinations are the rows the portal
  // sidebar itself links for these two features in `employee-portal-nav-registry.ts`, not
  // a guess made here.
  { from: "/leave-management/vacation-report", to: "/employee-portals/vacation-report" },
  { from: "/leave-management/vacation-request", to: "/employee-portals/vacation-request" },

  // ── Sales ──────────────────────────────────────────────────────────────────
  // Customer 360 is a sales surface that lives at its own root path rather than under
  // /sales, so it is grouped here by subject rather than by prefix. Both the picker and a
  // single customer resolve to the portal's one sales screen — the same answer every other
  // admin sales tool gives, and the destination both pages already name in their own source.
  { from: "/customer-360", to: SOS },
  { from: "/customer-360/:subjectId", to: SOS },
  { from: "/customer-360/marketing-customer/:customerId", to: SOS },
  { from: "/sales", to: SOS },
  { from: "/sales/closing-corrections", to: SOS },
  { from: "/sales/customer-directory", to: SOS },
  { from: "/sales/customer-directory/:distributor/:clientCode", to: SOS },
  { from: "/sales/customer-mapping", to: SOS },
  { from: "/sales/database-mapping", to: SOS },
  { from: "/sales/diagnostics", to: SOS },
  { from: "/sales/distributor-profiles", to: SOS },
  { from: "/sales/import", to: SOS },
  { from: "/sales/mapping-database", to: SOS },
  { from: "/sales/missing-data", to: SOS },
  { from: "/sales/make-it-happen", to: "/employee-portals/make-it-happen" },
  { from: "/sales/monthly-closing", to: SOS },
  // The Performance Review has a portal twin since 2026-10-13 (owner: "show performance review tab
  // in each district manager account"), and the admin page branches on exactly these three roles —
  // the ones that have a scoped copy to be sent to. Every other portal-mode viewer keeps the Source
  // of Sales hub, which is what that page's source still names for them. Routing only: the
  // destination refuses anyone outside PORTAL_PERFORMANCE_REVIEW_ROLES on its own.
  {
    from: "/sales/monthly-closing/performance-review",
    to: "/employee-portals/monthly-closing/performance-review",
    roles: PERFORMANCE_REVIEW_PORTAL_ROLES,
  },
  {
    from: "/sales/monthly-closing/performance-review",
    to: SOS,
    roles: PERFORMANCE_REVIEW_OTHER_PORTAL_ROLES,
  },
  { from: "/sales/normalizer", to: SOS },
  // The Rankings board reads the same published closing figures as Sales vs Target and is gated on
  // the same `sales:read`, so a portal-mode viewer asking for it belongs on the portal's own Sales
  // vs Target — the destination `app/(admin)/sales/rankings/page.tsx` already names.
  { from: "/sales/rankings", to: "/employee-portals/sales-vs-target" },
  { from: "/sales/targets", to: SOS },
  { from: "/sales/truth-check", to: SOS },
  { from: "/sales/upload", to: SOS },
  { from: "/sales/vs-target", to: "/employee-portals/sales-vs-target" },
  { from: "/sales/weekly/distributor-editor", to: SOS },
  { from: "/sales/weekly/stock", to: "/employee-portals/weekly-stock" },
];

/** Exported for the drift test, which re-derives this whole set from the pages. */
export const portalTwinRules = TWIN_RULES;

/**
 * Where a portal-mode viewer goes when no rule matches — the behaviour that existed
 * before this table, kept deliberately as the fallback.
 */
export const PORTAL_HOME = "/employee-portals";

const HR_PREFIX = "/hr";

/**
 * Strip the `/hr` namespace. `proxy.ts` records the address the BROWSER asked for, so an
 * HR seat on `/hr/probation` arrives spelled that way even though the page that runs is
 * `/probation`. HR seats resolve to the admin shell and so never reach this code today —
 * but a table that silently depends on that staying true is one that breaks quietly when
 * it stops.
 */
function stripHrNamespace(pathname: string): string {
  if (pathname === HR_PREFIX) return "/";
  return pathname.startsWith(`${HR_PREFIX}/`) ? pathname.slice(HR_PREFIX.length) : pathname;
}

function segmentsOf(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

/** Literal-segment count: the specificity score. More literals beats fewer. */
function literalCount(template: string): number {
  return segmentsOf(template).filter((segment) => !segment.startsWith(":")).length;
}

function matchTemplate(template: string, pathSegments: readonly string[]): Record<string, string> | null {
  const templateSegments = segmentsOf(template);
  if (templateSegments.length !== pathSegments.length) return null;
  const captured: Record<string, string> = {};
  for (let index = 0; index < templateSegments.length; index += 1) {
    const templateSegment = templateSegments[index];
    const pathSegment = pathSegments[index];
    if (templateSegment.startsWith(":")) {
      if (!pathSegment) return null;
      captured[templateSegment.slice(1)] = pathSegment;
      continue;
    }
    if (templateSegment !== pathSegment) return null;
  }
  return captured;
}

function fillTemplate(template: string, captured: Record<string, string>): string {
  return template
    .split("/")
    .map((segment) => (segment.startsWith(":") ? (captured[segment.slice(1)] ?? segment) : segment))
    .join("/");
}

/**
 * The portal address a portal-mode viewer asking for `requested` should land on, or `null`
 * when no page names one — in which case the caller sends them to `PORTAL_HOME`, exactly
 * as it did before this table existed.
 *
 * `requested` is the raw `x-phoenix-path` value, so it may carry a query string and may be
 * absent altogether (a request the proxy matcher skips). Both mean "no twin".
 *
 * Captured segments are substituted verbatim: `nextUrl.pathname` is already URL-encoded,
 * so encoding again here would double-encode an id holding a space or a slash.
 */
export function resolvePortalTwin(
  requested: string | null | undefined,
  role: PhoenixRole | null | undefined,
): string | null {
  if (!requested || !requested.startsWith("/")) return null;

  const queryAt = requested.indexOf("?");
  const rawPath = queryAt === -1 ? requested : requested.slice(0, queryAt);
  const rawSearch = queryAt === -1 ? "" : requested.slice(queryAt + 1);
  const pathSegments = segmentsOf(stripHrNamespace(rawPath));

  let best: { rule: TwinRule; captured: Record<string, string>; score: number } | null = null;
  for (const rule of TWIN_RULES) {
    if (rule.roles && !(role && rule.roles.includes(role))) continue;
    const captured = matchTemplate(rule.from, pathSegments);
    if (!captured) continue;
    const score = literalCount(rule.from);
    // Strictly greater, so an exact tie keeps the rule declared first. The drift test
    // forbids such a tie outright, for precisely this reason.
    if (!best || score > best.score) best = { rule, captured, score };
  }
  if (!best) return null;

  const destination = fillTemplate(best.rule.to, best.captured);
  if (!best.rule.carryQuery?.length || !rawSearch) return destination;

  const incoming = new URLSearchParams(rawSearch);
  const carried = new URLSearchParams();
  for (const name of best.rule.carryQuery) {
    const value = incoming.get(name);
    if (value && value.trim()) carried.set(name, value);
  }
  const text = carried.toString();
  return text ? `${destination}?${text}` : destination;
}
