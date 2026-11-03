import type { PhoenixRole } from "@/lib/auth/permissions";

/**
 * ONE navigation reachability backlog — the single record of every route that a role can open but
 * navigation offers a link to nobody, together with the reason it is acceptable that it does.
 *
 * ## Why this file exists
 *
 * Before it, the same fact — "this page is reachable-but-unlinked, and that is on purpose" — was
 * recorded in three different shapes across three test files, and a fourth (the 4-entry
 * KNOWN_STRANDED_FROM_SUPER_ADMIN) had already been retired by hand when the owner finished the CRM
 * expansion (crm-hub-cards-are-reachable-by-the-roles-they-name.test.ts). What was left:
 *
 *   · a Set of 13 route strings   — KNOWN_CATALOG_OMISSIONS, in employee-portal-nav-catalog-sync
 *   · a bare count, BASELINE = 10  — in navigation-page-findability-ratchet
 *   · and the 52 the reverse guard prints into the CI log — navigation-granted-but-unreachable,
 *     which shipped in report mode precisely so this file could be assembled from a real measurement
 *     rather than adjudicated by hand.
 *
 * They are consolidated here so there is one list to read, one number to watch, and one place to
 * record a reason. Each of the three guards now asserts its live measurement equals its slice of
 * this backlog BY IDENTITY, so the file cannot rot: a stale entry (route the code no longer strands)
 * fails just as loudly as a new strand nobody recorded.
 *
 * ## The kinds, and which guard owns each
 *
 * The first five are the reverse guard's own mechanical buckets (navigation-granted-but-unreachable
 * measured them against the real code; two of them — shell-mirror-of-a-linked-route and
 * linked-from-a-component — did not exist when this program was planned). The last two belong to the
 * other two guards.
 *
 *   delisted-by-ruling            reverse guard  a page an owner ruling took off navigation on purpose
 *   shell-mirror-of-a-linked-route reverse guard portal twin of an admin route the nav already offers
 *   linked-from-a-component       reverse guard  reached from hand-written JSX / a notification link
 *   second-gate-unreadable        reverse guard  a role/scope gate the reader cannot evaluate
 *   no-link-anywhere              reverse guard  reached from nothing at all — the real findings
 *   absent-from-portal-catalog    catalog sync   rendered by the portal, absent from the Cmd+K catalog
 *   invisible-to-literal-scan     findability    reachable via a runtime-assembled href a literal scan cannot see
 *   gate-unreadable-and-unlinked  reverse guard  the guard's own BLIND SPOT — see below
 *
 * ## The blind spot, added 2026-09-04
 *
 * The reverse guard opens its per-role loop with `if (!gate.readable) continue` — an unreadable gate
 * cannot support a conclusion about who can open the page, so the route is skipped. That is correct
 * for the question it asks and silent for every other one: on 2026-09-04 **137 of 356 static routes**
 * were being skipped that way, and a page added tomorrow whose gate the reader cannot parse would
 * join them without a word.
 *
 * Most of those 137 are linked and fine — the skip only hides something when the route is ALSO
 * offered to nobody. That intersection is what `gate-unreadable-and-unlinked` records, and the guard
 * now asserts it by identity like every other slice. Redirect-only stubs are excluded mechanically
 * (`isRedirectOnlyStub`) rather than recorded: a stub that renders nothing is a link, not a page.
 *
 * 2026-09-05: 134 of 357, after the shared reader learned the two entry-gate shapes it had been
 * under-reading — a bare `access.role !== "X"` inequality (25 pages) and a predicate hoisted into a
 * const (8 pages). **No row below changed.** The three routes that left the blind spot
 * (/admin/dev-preview, /admin/notification-confidence, /admin/sfe-command-center) turned out to be
 * properly linked once they could be measured at all, and every other slice — the orphan routes,
 * each one's role count, each one's bucket, and the eleven `gate-unreadable-and-unlinked` rows —
 * came out byte-identical. That is the expected shape rather than a surprise: a narrower admit list
 * removes a route from the orphan set only if it leaves NOBODY able to open it, and Super Admin is
 * admitted by every one of those gates.
 *
 * These rows are NOT role-scoped — the whole point is that the roles cannot be computed — so every
 * one carries `roles: "all"`.
 *
 * A route may legitimately appear once and be claimed by two guards: /employee/outstation/new is a
 * no-link-anywhere row the reverse guard owns AND the one literal-scan strand that is a real gap, so
 * the findability guard reads it from here too rather than duplicating it.
 *
 * ## Adding or removing a row
 *
 * Never add a row to make a red guard go green without understanding which guard turned red and why —
 * a new strand is the finding these guards exist to surface. A row needs a route, the roles that can
 * open it (or "all" for a route-level record that is not role-scoped), a kind, a written reason, and
 * the date it was recorded. "known failure" is not a reason.
 */

export type ReachabilityGapKind =
  | "delisted-by-ruling"
  | "shell-mirror-of-a-linked-route"
  | "linked-from-a-component"
  | "second-gate-unreadable"
  | "no-link-anywhere"
  | "absent-from-portal-catalog"
  | "invisible-to-literal-scan"
  | "gate-unreadable-and-unlinked";

export type ReachabilityGap = {
  readonly route: string;
  /** The roles that can open the route but are offered no link to it. "all" = a route-level record, not role-scoped. */
  readonly roles: readonly PhoenixRole[] | "all";
  readonly kind: ReachabilityGapKind;
  readonly reason: string;
  readonly recorded: string;
};

/** The kinds the reverse guard (navigation-granted-but-unreachable) produces and owns. */
export const REVERSE_GUARD_GAP_KINDS: readonly ReachabilityGapKind[] = [
  "delisted-by-ruling",
  "shell-mirror-of-a-linked-route",
  "linked-from-a-component",
  "second-gate-unreadable",
  "no-link-anywhere",
];

export const NAVIGATION_REACHABILITY_BACKLOG: readonly ReachabilityGap[] = [
  // ── The 15 hub pages, delisted 2026-09-05 ───────────────────────────────────────────────────────
  //
  // The owner: "I do not want any subtitle to be the one that when I press, it redirects me to a
  // page with big modules. I want a recruitment and its modules under it." So every rail row that
  // opened a hub was replaced by that hub's cards, promoted onto the rail under the hub's own
  // heading. The pages are untouched and still serve — nothing on any rail opens one.
  //
  // Recorded as delisted-by-ruling for the same reason the Sales Analytics rows that stood above them
  // were (29 routes, gone since the owner retired that module on 2026-09-17): an owner decision took
  // the links away on purpose. Each row names the bucket the guard's own mechanics
  // would have chosen, because six of these are still reached from a hand-written link somewhere and
  // that is worth knowing before anyone "cleans up" a hub page. Roles are the guard's measurement of
  // 2026-09-05, not a judgement.
  //
  // The right way to clear one of these rows is to delete the hub page, not to give it a link back.
  { route: "/admin/admin-tools", roles: ["Super Admin"], kind: "delisted-by-ruling", reason: "The Admin Tools hub. Its only link was the sidebar row that opened it, removed 2026-09-05 when the owner ruled that no rail row may open a page of modules; its cards are rail rows now. The page still serves by direct URL. Guard's mechanical bucket: linked-from-a-component.", recorded: "2026-09-05" },
  { route: "/admin/crm-tools", roles: ["CEO","Finance Manager","Financial Advisor","HR Advisory","HR Operations","SFE Manager","Super Admin"], kind: "delisted-by-ruling", reason: "The CRM hub. Its only link was the sidebar row that opened it, removed 2026-09-05 when the owner ruled that no rail row may open a page of modules; its cards are rail rows now. The page still serves by direct URL. Guard's mechanical bucket: linked-from-a-component.", recorded: "2026-09-05" },
  { route: "/admin/field-coaching", roles: ["CEO","Finance Manager","Financial Advisor","HR Advisory","HR Operations","SFE Manager","Super Admin"], kind: "delisted-by-ruling", reason: "The Field Coaching hub. Its only link was the sidebar row that opened it, removed 2026-09-05 when the owner ruled that no rail row may open a page of modules; its cards are rail rows now. The page still serves by direct URL. Guard's mechanical bucket: no-link-anywhere.", recorded: "2026-09-05" },
  { route: "/admin/marketing-roi", roles: ["CEO","Finance Manager","Financial Advisor","HR Advisory","HR Operations","SFE Manager","Super Admin"], kind: "delisted-by-ruling", reason: "The Marketing & ROI hub. Its only link was the sidebar row that opened it, removed 2026-09-05 when the owner ruled that no rail row may open a page of modules; its cards are rail rows now. The page still serves by direct URL. Guard's mechanical bucket: linked-from-a-component.", recorded: "2026-09-05" },
  { route: "/admin/master-data", roles: ["CEO","Finance Manager","Financial Advisor","HR Advisory","HR Operations","SFE Manager","Super Admin"], kind: "delisted-by-ruling", reason: "The Master Data hub. Its only link was the sidebar row that opened it, removed 2026-09-05 when the owner ruled that no rail row may open a page of modules; its cards are rail rows now. The page still serves by direct URL. Guard's mechanical bucket: linked-from-a-component.", recorded: "2026-09-05" },
  { route: "/admin/outstation-expenses", roles: ["CEO","Finance Manager","Financial Advisor","HR Advisory","HR Operations","SFE Manager","Super Admin"], kind: "delisted-by-ruling", reason: "The Outstation Expenses hub. Its only link was the sidebar row that opened it, removed 2026-09-05 when the owner ruled that no rail row may open a page of modules; its cards are rail rows now. The page still serves by direct URL. Guard's mechanical bucket: no-link-anywhere.", recorded: "2026-09-05" },
  { route: "/admin/payroll-management", roles: ["CEO","Finance Manager","Financial Advisor","HR Advisory","HR Operations","SFE Manager","Super Admin"], kind: "delisted-by-ruling", reason: "The Payroll Management hub. Its only link was the sidebar row that opened it, removed 2026-09-05 when the owner ruled that no rail row may open a page of modules; its cards are rail rows now. The page still serves by direct URL. Guard's mechanical bucket: no-link-anywhere.", recorded: "2026-09-05" },
  { route: "/admin/people-management", roles: ["CEO","Finance Manager","Financial Advisor","HR Advisory","HR Operations","SFE Manager","Super Admin"], kind: "delisted-by-ruling", reason: "The People Management hub. Its only link was the sidebar row that opened it, removed 2026-09-05 when the owner ruled that no rail row may open a page of modules; its cards are rail rows now. The page still serves by direct URL. Guard's mechanical bucket: linked-from-a-component.", recorded: "2026-09-05" },
  { route: "/admin/pharmacovigilance", roles: ["CEO","Finance Manager","Financial Advisor","HR Advisory","HR Operations","SFE Manager","Super Admin"], kind: "delisted-by-ruling", reason: "The Pharmacovigilance hub. Its only link was the sidebar row that opened it, removed 2026-09-05 when the owner ruled that no rail row may open a page of modules; its cards are rail rows now. The page still serves by direct URL. Guard's mechanical bucket: no-link-anywhere.", recorded: "2026-09-05" },
  { route: "/admin/probation-tools", roles: ["CEO","HR Advisory","HR Operations","SFE Manager","Super Admin"], kind: "delisted-by-ruling", reason: "The Probation Tools hub. Its only link was the sidebar row that opened it, removed 2026-09-05 when the owner ruled that no rail row may open a page of modules; its cards are rail rows now. The page still serves by direct URL. Guard's mechanical bucket: no-link-anywhere.", recorded: "2026-09-05" },
  { route: "/admin/recruitment-hiring", roles: ["CEO","Finance Manager","Financial Advisor","HR Advisory","HR Operations","SFE Manager","Super Admin"], kind: "delisted-by-ruling", reason: "The Recruitment & Hiring hub. Its only link was the sidebar row that opened it, removed 2026-09-05 when the owner ruled that no rail row may open a page of modules; its cards are rail rows now. The page still serves by direct URL. Guard's mechanical bucket: second-gate-unreadable.", recorded: "2026-09-05" },
  { route: "/attendance", roles: ["CEO","Finance Manager","Financial Advisor","HR Advisory","HR Operations","SFE Manager","Super Admin"], kind: "delisted-by-ruling", reason: "The Attendance Management hub. Its only link was the sidebar row that opened it, removed 2026-09-05 when the owner ruled that no rail row may open a page of modules; its cards are rail rows now. The page still serves by direct URL. Guard's mechanical bucket: linked-from-a-component.", recorded: "2026-09-05" },
  { route: "/leave-management", roles: ["CEO","Finance Manager","Financial Advisor","HR Advisory","HR Operations","SFE Manager","Super Admin"], kind: "delisted-by-ruling", reason: "The Leave Management hub. Its only link was the sidebar row that opened it, removed 2026-09-05 when the owner ruled that no rail row may open a page of modules; its cards are rail rows now. The page still serves by direct URL. Guard's mechanical bucket: no-link-anywhere.", recorded: "2026-09-05" },
  { route: "/sales/source-of-sales-tools", roles: ["CEO","Finance Manager","SFE Manager","Super Admin"], kind: "delisted-by-ruling", reason: "The Source of Sales hub. Its only link was the sidebar row that opened it, removed 2026-09-05 when the owner ruled that no rail row may open a page of modules; its cards are rail rows now. The page still serves by direct URL. Guard's mechanical bucket: no-link-anywhere.", recorded: "2026-09-05" },
  { route: "/sales/weekly-tools", roles: ["CEO","SFE Manager","Super Admin"], kind: "delisted-by-ruling", reason: "The Weekly Sales hub. Its only link was the sidebar row that opened it, removed 2026-09-05 when the owner ruled that no rail row may open a page of modules; its cards are rail rows now. The page still serves by direct URL. Guard's mechanical bucket: no-link-anywhere.", recorded: "2026-09-05" },
  // ── The Phoenix CRM pilot, delisted 2026-09-17 ───────────────────────────────────────────────────
  // The owner, 2026-09-16: the clean Phoenix CRM (/admin/field-crm, /employee-portals/field-crm)
  // takes the name, and the 2026-09-14 pilot's link is hidden when it ships; the pilot is removed
  // after go-live. Its rail card now opens the clean module, so the pilot's admin page is reached by
  // typed address only. Clear this row by deleting the pilot's pages, never by linking them again —
  // its portal twin is recorded in the blind-spot rows below and goes with it.
  { route: "/admin/phoenix-crm", roles: ["CEO","Finance Manager","Financial Advisor","HR Advisory","HR Operations","SFE Manager","Super Admin"], kind: "delisted-by-ruling", reason: "The 2026-09-14 Phoenix CRM pilot's admin page. Its only link was the Phoenix CRM rail card, handed to the clean module at /admin/field-crm when the owner ruled on 2026-09-16 that the pilot's link is hidden once that module ships; since the owner retired the pilot on 2026-09-25 the page is only a forward to /admin/field-crm, on the tab doing the same work. Guard's mechanical bucket: no-link-anywhere.", recorded: "2026-09-17" },
  // ── My List, delisted 2026-09-25 ────────────────────────────────────────────────────────────────
  // My List's board moved into Phoenix CRM's List tab. The owner hid its sidebar row on 2026-09-25
  // (#4355, "hide the my-list board") and had the dormant board code deleted the same day ("delete the
  // dormant My List board code"): the MyListBoardView component, the getMyListScope resolver, the
  // showMyListTab flag and this catalog entry are all gone. The /employee-portals/my-list route
  // survives ONLY as a redirect onto /employee-portals/field-crm?tab=list, so a saved bookmark or a
  // stale link still lands on the live board. The reverse guard read this catalog entry as the route's
  // one nav home (the real sidebar is the flag-gated layout, which #4355 had already switched off), so
  // removing it is what strands the route — on purpose. Clear this row by deleting the page, never by
  // linking it again. Guard's mechanical bucket: shell-mirror-of-a-linked-route (its not-in-portal-mode
  // redirect points at /overview, which navigation offers).
  { route: "/employee-portals/my-list", roles: ["District Manager","Employee","Group Product Manager","Manager","Marketing Manager","Medical Rep","National Sales Manager","Product Manager","Regional Manager","Training Manager"], kind: "delisted-by-ruling", reason: "My List's board moved into Phoenix CRM's List tab; its sidebar row was hidden 2026-09-25 (#4355) and its dormant board code deleted the same day (owner: 'hide the my-list board', 'delete the dormant My List board code'). The route survives only as a redirect onto /employee-portals/field-crm?tab=list, so a saved bookmark still lands on the live board. Delisted on purpose — clear this row only by deleting the page, never by linking it again. Guard's mechanical bucket: shell-mirror-of-a-linked-route.", recorded: "2026-09-25" },
  { route: "/admin/direct-orders/new", roles: ["CEO", "Finance Manager", "Financial Advisor", "HR Advisory", "HR Operations", "SFE Manager", "Super Admin"], kind: "linked-from-a-component", reason: "Reached from a hand-written link in app/employee-portals/direct-orders/new/page.tsx, not the sidebar rail or a hub card — a recorded decision.", recorded: "2026-08-29" },
  { route: "/admin/email-notifications", roles: ["Super Admin"], kind: "linked-from-a-component", reason: "Reached from a hand-written link in src/lib/notifications/email-control-center.ts, not the sidebar rail or a hub card — a recorded decision.", recorded: "2026-08-29" },
  { route: "/admin/field-sales/dsm-performance", roles: ["CEO", "Finance Manager", "SFE Manager", "Super Admin"], kind: "linked-from-a-component", reason: "Reached from a hand-written link in src/components/admin/ceo-command-center.tsx, not the sidebar rail or a hub card — a recorded decision.", recorded: "2026-08-29" },
  { route: "/admin/field-sales/med-reps-performance", roles: ["CEO", "Finance Manager", "SFE Manager", "Super Admin"], kind: "linked-from-a-component", reason: "Reached from a hand-written link in src/components/admin/ceo-command-center.tsx, not the sidebar rail or a hub card — a recorded decision.", recorded: "2026-08-29" },
  { route: "/admin/field-sales/source-of-sales", roles: ["CEO", "Finance Manager", "SFE Manager", "Super Admin"], kind: "linked-from-a-component", reason: "Reached from a hand-written link in src/components/admin/ceo-command-center.tsx, not the sidebar rail or a hub card — a recorded decision.", recorded: "2026-08-29" },
  { route: "/admin/field-sales/weekly-sales", roles: ["CEO", "Finance Manager", "SFE Manager", "Super Admin"], kind: "linked-from-a-component", reason: "Reached from a hand-written link in src/components/admin/ceo-command-center.tsx, not the sidebar rail or a hub card — a recorded decision.", recorded: "2026-08-29" },
  { route: "/employee-portals/direct-orders/new", roles: ["District Manager", "Employee", "Group Product Manager", "Manager", "Marketing Manager", "Medical Rep", "National Sales Manager", "Product Manager", "Regional Manager", "Training Manager"], kind: "linked-from-a-component", reason: "Reached from a hand-written link in app/(admin)/admin/direct-orders/new/page.tsx, not the sidebar rail or a hub card — a recorded decision.", recorded: "2026-08-29" },
  // RETIRED 2026-09-07. The row recorded /recruitment/screening as reachable only from a
  // hand-written link, "not the sidebar rail or a hub card — a recorded decision". It now has a
  // sidebar row ("Screening Queue", the recruitment-hiring section of system-navigation.ts), so the
  // reverse guard no longer sees it as an orphan and this entry had to go with it.
  //
  // The decision was recorded in good faith and the reasoning was sound — a hub card trips four
  // unrelated CI gates. What was never measured is whether the hand-written link actually carried
  // anyone there. Measured 2026-09-07 by calling the page's own loader against production: the
  // workstation holds 400 CVs needing a first review, 8 unreviewed duplicate pairs and 13 overdue
  // manager sends, while 658 of 874 candidates had no decision recorded against them at all, some
  // since 24 July. A plain sidebar row costs one measured label and none of the four gates, so the
  // trade the original decision was avoiding was never the only one available.
  { route: "/employee/outstation/new", roles: ["District Manager", "Employee", "Group Product Manager", "Manager", "Marketing Manager", "Medical Rep", "National Sales Manager", "Product Manager", "Regional Manager", "Training Manager"], kind: "no-link-anywhere", reason: "No content of its own — it reads the caller's outstation-expense state and forwards to one of three pages, so nothing should link it. The literal-scan findability ratchet surfaces it too.", recorded: "2026-08-29" },
  // The Production Planner's portal twin (2026-10-06). Its link IS drawn — by the hand-built rail in
  // buildEmployeePortalSections, from `showProductionPlanningTab`, which carries a NAMED LIST OF HR
  // IDS rather than a role (src/lib/production-planning/access.ts). Neither the seed catalog nor this
  // guard's reader can see that builder, so the route reads as offered to nobody. It is not a twin row
  // either: the admin spelling exists and is linked, but the two people the module is FOR — the R&D
  // Manager and the R&D Supervisor — are portal-shell seats that the admin group would bounce, so this
  // address is their real door and not a mirror of one. Clear this row only by giving the catalog a way
  // to gate by person; never by granting `production_planning` to `Manager` or `Employee`, which would
  // offer it to the QPPV and to the whole company.
  { route: "/employee-portals/production-planning", roles: "all", kind: "linked-from-a-component", reason: "The Production Planner's portal twin. Linked from the hand-built portal rail (buildEmployeePortalSections) by showProductionPlanningTab, which is keyed to the five HR ids the owner named on 2026-10-05, not to a role — a gate neither the seed catalog nor this guard's reader can evaluate. The page re-asks the database itself (resolveProductionPlanningLevel).", recorded: "2026-10-06" },
  { route: "/recruitment/previous", roles: ["HR Resourcing", "Super Admin"], kind: "second-gate-unreadable", reason: "The old Recruitment pool, kept for Release 1 of the rebuilt workspace (owner, 2026-10-20: \"two releases\"). Reached from the workspace header's \"Previous workspace\" link, never a rail row; Release 2 deletes the page and this record with it. Gated on isHrAuthorityRole, which the gate reader cannot evaluate.", recorded: "2026-10-20" },
  { route: "/admin/approvals/stuck", roles: ["CEO", "Finance Manager", "Financial Advisor", "HR Advisory", "HR Operations", "SFE Manager", "Super Admin"], kind: "second-gate-unreadable", reason: "Gated on isAllVacationVisibility, a role/scope predicate the gate reader cannot evaluate, so whether it is truly stranded is deferred until the gate is machine-readable (B7).", recorded: "2026-08-29" },
  { route: "/admin/approvals/vacation-day-work", roles: ["CEO", "Finance Manager", "Financial Advisor", "HR Advisory", "HR Operations", "SFE Manager", "Super Admin"], kind: "linked-from-a-component", reason: "Vacation-Day Work (CRM phase 6, rule 9): the administrator's answers to reps asking to work on an approved vacation day. Deliberately no sidebar row — the Leave Approvals page links it once the CRM cutover date is set, and its own gate sends anyone who cannot answer back to Leave Approvals.", recorded: "2026-09-13" },
  { route: "/employee-portals/contact-review", roles: ["District Manager", "Employee", "Group Product Manager", "Manager", "Marketing Manager", "Medical Rep", "National Sales Manager", "Product Manager", "Regional Manager", "Training Manager"], kind: "shell-mirror-of-a-linked-route", reason: "Portal-shell twin of /recruitment/contact-review, which navigation already offers; an admin-shell role opening this address is bounced to the twin, so the portal spelling needs no link of its own.", recorded: "2026-08-29" },
  // RETIRED 2026-09-01. The row named seven sales and marketing roles — District Manager, Group
  // Product Manager, Marketing Manager, National Sales Manager, Product Manager, Regional Manager,
  // Training Manager — as granted-but-unlinked on /employee-portals/cv-database. They read as
  // granted because the page asserted `vacancies:read`, which all seven hold for the vacancy board;
  // none could actually open it, because the same gate also demands isHrAuthorityRole. The page
  // moved to `recruitment:read` that day (the CV Database shows the candidate pool, and the owner
  // ruled it off the HR Operations seat), and with it the phantom grant went too. Nothing lost
  // access: the seven were always bounced.
  { route: "/employee-portals/direct-orders/report", roles: ["District Manager", "Employee", "Group Product Manager", "Manager", "Marketing Manager", "Medical Rep", "National Sales Manager", "Product Manager", "Regional Manager", "Training Manager"], kind: "shell-mirror-of-a-linked-route", reason: "Portal-shell twin of /admin/direct-orders/report, which navigation already offers; an admin-shell role opening this address is bounced to the twin, so the portal spelling needs no link of its own.", recorded: "2026-08-29" },
  { route: "/employee-portals/expense-submissions", roles: ["District Manager", "Employee", "Group Product Manager", "Manager", "Marketing Manager", "National Sales Manager", "Product Manager", "Regional Manager", "Training Manager"], kind: "linked-from-a-component", reason: "Owner, 2026-11-03: the tab is gone for anyone who can submit, because this page only forwards them to Submit Expense, which holds My claims. The address stays for old links and the claim notifications in service.ts.", recorded: "2026-11-03" },
  { route: "/employee-portals/hiring-documents", roles: ["District Manager", "Employee", "Group Product Manager", "Manager", "Marketing Manager", "Medical Rep", "National Sales Manager", "Product Manager", "Regional Manager", "Training Manager"], kind: "shell-mirror-of-a-linked-route", reason: "Portal-shell twin of /hiring-documents, which navigation already offers; an admin-shell role opening this address is bounced to the twin, so the portal spelling needs no link of its own.", recorded: "2026-08-29" },
  { route: "/employee-portals/hiring-pack", roles: ["District Manager", "Employee", "Group Product Manager", "Manager", "Marketing Manager", "Medical Rep", "National Sales Manager", "Product Manager", "Regional Manager", "Training Manager"], kind: "shell-mirror-of-a-linked-route", reason: "Portal-shell twin of /hiring-pack, which navigation already offers; an admin-shell role opening this address is bounced to the twin, so the portal spelling needs no link of its own.", recorded: "2026-08-29" },
  { route: "/employee-portals/intake-health", roles: ["District Manager", "Employee", "Group Product Manager", "Manager", "Marketing Manager", "Medical Rep", "National Sales Manager", "Product Manager", "Regional Manager", "Training Manager"], kind: "shell-mirror-of-a-linked-route", reason: "Portal-shell twin of /recruitment/intake-health, which navigation already offers; an admin-shell role opening this address is bounced to the twin, so the portal spelling needs no link of its own.", recorded: "2026-08-29" },
  { route: "/employee-portals/offers", roles: ["District Manager", "Employee", "Group Product Manager", "Manager", "Marketing Manager", "Medical Rep", "National Sales Manager", "Product Manager", "Regional Manager", "Training Manager"], kind: "shell-mirror-of-a-linked-route", reason: "Portal-shell twin of /offers, which navigation already offers; an admin-shell role opening this address is bounced to the twin, so the portal spelling needs no link of its own.", recorded: "2026-08-29" },
  { route: "/employee-portals/payroll", roles: ["District Manager", "Employee", "Group Product Manager", "Manager", "Marketing Manager", "Medical Rep", "National Sales Manager", "Product Manager", "Regional Manager", "Training Manager"], kind: "shell-mirror-of-a-linked-route", reason: "Portal-shell twin of /payroll, which navigation already offers; an admin-shell role opening this address is bounced to the twin, so the portal spelling needs no link of its own.", recorded: "2026-08-29" },
  { route: "/employee-portals/support-requests", roles: ["District Manager", "Employee", "Group Product Manager", "Manager", "Marketing Manager", "Medical Rep", "National Sales Manager", "Product Manager", "Regional Manager", "Training Manager"], kind: "shell-mirror-of-a-linked-route", reason: "Portal-shell twin of /admin/support-requests, which navigation already offers; an admin-shell role opening this address is bounced to the twin, so the portal spelling needs no link of its own.", recorded: "2026-08-29" },
  { route: "/employee-portals/vacation-control", roles: ["Employee", "Group Product Manager", "Marketing Manager", "Medical Rep", "Product Manager"], kind: "shell-mirror-of-a-linked-route", reason: "Portal-shell twin of /leave-management/vacation-control, which navigation already offers; an admin-shell role opening this address is bounced to the twin, so the portal spelling needs no link of its own.", recorded: "2026-08-29" },
  { route: "/employee-portals/training-manager/field-coaching/archived", roles: ["Training Manager"], kind: "shell-mirror-of-a-linked-route", reason: "Portal-shell twin of /coaching/archived, the resigned reps' evaluations the owner opened to the Training Manager on 2026-10-24; reached from the Resigned Evaluations action on her Field Coaching list, so it needs no rail link of its own.", recorded: "2026-10-24" },
  { route: "/employee-portals/payslips", roles: "all", kind: "absent-from-portal-catalog", reason: "An always-visible core employee page, deliberately absent from the searchable/titled nav catalog since before it existed; the real portal nav renders it directly.", recorded: "2026-08-29" },
  { route: "/employee-portals/profile", roles: "all", kind: "absent-from-portal-catalog", reason: "An always-visible core employee page, deliberately absent from the searchable/titled nav catalog since before it existed; the real portal nav renders it directly.", recorded: "2026-08-29" },
  { route: "/employee-portals/excuses", roles: "all", kind: "absent-from-portal-catalog", reason: "An always-visible core employee page, deliberately absent from the searchable/titled nav catalog since before it existed; the real portal nav renders it directly.", recorded: "2026-08-29" },
  { route: "/employee-portals/vacation-request", roles: "all", kind: "absent-from-portal-catalog", reason: "An always-visible core employee page, deliberately absent from the searchable/titled nav catalog since before it existed; the real portal nav renders it directly.", recorded: "2026-08-29" },
  { route: "/employee-portals/vacation-report", roles: "all", kind: "absent-from-portal-catalog", reason: "An always-visible core employee page, deliberately absent from the searchable/titled nav catalog since before it existed; the real portal nav renders it directly.", recorded: "2026-08-29" },
  { route: "/employee-portals/incentive", roles: "all", kind: "absent-from-portal-catalog", reason: "An always-visible core employee page, deliberately absent from the searchable/titled nav catalog since before it existed; the real portal nav renders it directly.", recorded: "2026-08-29" },
  { route: "/employee-portals/business-cards", roles: "all", kind: "absent-from-portal-catalog", reason: "An always-visible core employee page — every employee's own business card, edit and request — reached from the sidebar, the bottom nav and the profile grid; deliberately absent from the Cmd+K catalog like the other core pages here.", recorded: "2026-09-30" },
  { route: "/employee-portals/email-signature", roles: "all", kind: "absent-from-portal-catalog", reason: "An always-visible core employee page — every employee's own email signature, copied once and pasted into a mail app — reached from the sidebar, the bottom nav and the profile grid; deliberately absent from the Cmd+K catalog like the business card beside it.", recorded: "2026-10-17" },
  { route: "/employee-portals/field-crm/forecast", roles: "all", kind: "absent-from-portal-catalog", reason: "The CNS Daily Forecast — a Phoenix CRM tab given its own sidebar row under Forecast & Target (owner, 2026-10-01). Deliberately absent from the Cmd+K catalog: the catalog gates by role and permission only and cannot see the LINE, so it would offer every phoenix_crm holder — a Pedia or Anti Infective rep included — a door the module refuses. The sidebar row is gated by forecastIsOffered instead; the browser tab title falls back to its parent, Phoenix CRM.", recorded: "2026-10-01" },
  { route: "/employee-portals/production-planning", roles: "all", kind: "absent-from-portal-catalog", reason: "The Production Planner (owner, 2026-10-05: five people by name). Deliberately absent from the Cmd+K catalog for the same reason as the Daily Forecast above — the catalog gates by role and permission only, and the module's gate is a named list of HR ids, so a catalog row would have to grant `Manager` or `Employee` and would then offer the QPPV and the whole company a door the module refuses. The rail row is gated by showProductionPlanningTab instead; the browser tab title falls back to the address.", recorded: "2026-10-06" },
  { route: "/employee-portals/dsms-performance", roles: "all", kind: "absent-from-portal-catalog", reason: "A role-specific / performance tab that predates the nav catalog and was never added to it; the real portal nav renders it directly.", recorded: "2026-08-29" },
  { route: "/employee-portals/med-reps-performance", roles: "all", kind: "absent-from-portal-catalog", reason: "A role-specific / performance tab that predates the nav catalog and was never added to it; the real portal nav renders it directly.", recorded: "2026-08-29" },
  { route: "/employee-portals/team-performance", roles: "all", kind: "absent-from-portal-catalog", reason: "A role-specific / performance tab that predates the nav catalog and was never added to it; the real portal nav renders it directly.", recorded: "2026-08-29" },
  { route: "/employee-portals/team-calendar", roles: "all", kind: "absent-from-portal-catalog", reason: "A role-specific / performance tab that predates the nav catalog and was never added to it; the real portal nav renders it directly.", recorded: "2026-08-29" },
  { route: "/employee-portals/fingerprint-analytics", roles: "all", kind: "absent-from-portal-catalog", reason: "A role-specific / performance tab that predates the nav catalog and was never added to it; the real portal nav renders it directly.", recorded: "2026-08-29" },
  { route: "/employee-portals/plans/calendar", roles: "all", kind: "absent-from-portal-catalog", reason: "A role-specific / performance tab that predates the nav catalog and was never added to it; the real portal nav renders it directly.", recorded: "2026-08-29" },
  { route: "/employee-portals/training-manager/coaching", roles: "all", kind: "absent-from-portal-catalog", reason: "A role-specific / performance tab that predates the nav catalog and was never added to it; the real portal nav renders it directly.", recorded: "2026-08-29" },
  { route: "/employee-portals/interview-calendar", roles: "all", kind: "absent-from-portal-catalog", reason: "Shown only to the people the calendar's owner shares it with (showInterviewCalendarTab, read from the share table). No role or permission describes that set, so the role-filtered Cmd+K catalog could only offer it to people it would then refuse; the real portal nav renders it for exactly the right people.", recorded: "2026-09-18" },
  { route: "/admin/action-center", roles: "all", kind: "invisible-to-literal-scan", reason: "Reached via hrefs built by actionCenterHref() and workspace tabs, never as a full route literal; the semantic reverse-guard does not flag it.", recorded: "2026-08-28" },
  { route: "/admin/outstation/heatmaps", roles: "all", kind: "invisible-to-literal-scan", reason: "An outstation-admin workspace tab reached via a runtime-built href; no full-route literal, so the literal scan cannot see the link.", recorded: "2026-08-28" },
  { route: "/admin/outstation/requests", roles: "all", kind: "invisible-to-literal-scan", reason: "An outstation-admin workspace tab reached via a runtime-built href; no full-route literal, so the literal scan cannot see the link.", recorded: "2026-08-28" },
  { route: "/admin/private-calendar-disputes", roles: "all", kind: "invisible-to-literal-scan", reason: "Rendered inside the action-center workspace (PrivateCalendarDisputesWorkspace) and reached via a workspace tab, not a route literal.", recorded: "2026-08-28" },
  { route: "/sales/weekly/missing", roles: "all", kind: "invisible-to-literal-scan", reason: "A weekly-planning sub-route reached via a runtime-assembled href from the weekly workspace; no full-route literal.", recorded: "2026-08-28" },
  { route: "/sales/weekly/missing-products", roles: "all", kind: "invisible-to-literal-scan", reason: "A weekly-planning sub-route reached via a runtime-assembled href from the weekly workspace; no full-route literal.", recorded: "2026-08-28" },
  { route: "/whatsapp-connect", roles: "all", kind: "invisible-to-literal-scan", reason: "Public WhatsApp-coexistence onboarding page reached from the external Meta signup flow, not from in-app navigation — correctly carries no sidebar link.", recorded: "2026-08-28" },
  // ── THE BLIND SPOT, opened 2026-09-04 ─────────────────────────────────────────────────────────
  // The reverse guard skipped 137 of 356 static routes for an unreadable gate. Eleven of them were
  // real pages nothing links, and this is the first time any check has looked at them. Every one
  // turned out to be deliberate — the blind spot was hiding no defect — but it could have hidden any
  // of them indefinitely, which is the reason the roll-call now exists.
  //
  // Five of the eleven are reachable through a string constant the link scan cannot see (a ternary,
  // a map value, a named export). Broadening the scan's patterns to catch them was considered and
  // rejected: a looser pattern invents links as readily as it finds them, and the whole value of
  // this program is that a link it reports is a link that exists. Recorded instead.
  { route: "/admin/hr-command-center", roles: "all", kind: "gate-unreadable-and-unlinked", reason: "Not a second page — the SAME file as /hr/admin/hr-command-center, which the HR sidebar does link. The HR shell mounts app/(admin)/… under /hr (see stripHrPrefix in tests/support/page-gate-reader.ts), so the un-prefixed path is the mount's underlying route and correctly has no link of its own. Gate is hrBundleForRole, which the reader does not parse.", recorded: "2026-09-04" },
  { route: "/admin/profile", roles: "all", kind: "gate-unreadable-and-unlinked", reason: "Reached from the topbar account menu — src/components/layout/topbar.tsx:48 assigns it in a ternary (`const profileHref = isAdminMode ? \"/admin/profile\" : …`), which is not one of the four literal shapes the link sweep matches. The link is real; the scan cannot see this shape.", recorded: "2026-09-04" },
  { route: "/dev/employee-portals", roles: "all", kind: "gate-unreadable-and-unlinked", reason: "A developer preview that calls notFound() when NODE_ENV === \"production\" — it does not exist on the production domain, so having no link there is the correct state, not a gap.", recorded: "2026-09-04" },
  { route: "/dev/employee-portals/sales", roles: "all", kind: "gate-unreadable-and-unlinked", reason: "A developer preview that calls notFound() when NODE_ENV === \"production\" — it does not exist on the production domain, so having no link there is the correct state, not a gap.", recorded: "2026-09-04" },
  { route: "/dev/identity-preview", roles: "all", kind: "gate-unreadable-and-unlinked", reason: "A developer preview that calls notFound() when NODE_ENV === \"production\" — it does not exist on the production domain, so having no link there is the correct state, not a gap.", recorded: "2026-09-04" },
  { route: "/employee-portals/approvals/early-bird", roles: "all", kind: "gate-unreadable-and-unlinked", reason: "The Early Birds notification action URL — EARLY_BIRDS_ACTION_URL in src/lib/early-birds/notify.ts. A notification you tap is a link; it is spelled as a named constant rather than an href key, so the sweep misses it.", recorded: "2026-09-04" },
  { route: "/marketing-requests", roles: "all", kind: "gate-unreadable-and-unlinked", reason: "The marketing-request notification deep-link base — MARKETING_REQUEST_LINK_BASE in src/lib/marketing-requests/notification-link.ts. Reached by tapping a notification, never from a rail.", recorded: "2026-09-04" },
  { route: "/terms", roles: "all", kind: "gate-unreadable-and-unlinked", reason: "Public Terms of Service, unauthenticated. It governs the WhatsApp Business channel and is submitted to Meta as a legal URL — reached from outside the app, like /whatsapp-connect and /privacy. An in-app link would be wrong, not missing.", recorded: "2026-09-04" },
  { route: "/whatsapp-connect", roles: "all", kind: "gate-unreadable-and-unlinked", reason: "Public WhatsApp-coexistence onboarding, reached from the external Meta signup flow. Already recorded as invisible-to-literal-scan for the findability ratchet; this row is the same fact stated for the blind-spot roll-call, which reads a different helper.", recorded: "2026-09-04" },
  { route: "/workspace/marketing-requests/inbox", roles: "all", kind: "gate-unreadable-and-unlinked", reason: "The Financial Advisor's landing page — src/lib/auth/landing.ts:25 returns it at sign-in. A landing destination is reached before any navigation is rendered, so no rail offers it.", recorded: "2026-09-04" },
  { route: "/workspace/vacancies", roles: "all", kind: "gate-unreadable-and-unlinked", reason: "Reached through the portal-to-workspace href map in src/components/employee-portal/employee-portal-dashboard.tsx:840, where it is a map VALUE rather than an href key — a shape the literal sweep does not match.", recorded: "2026-09-04" },
  // ── CLEARED 2026-08-30 ────────────────────────────────────────────────────────────────────────
  // /workspace/deductions and /workspace/payslips sat here from 2026-08-28, both recorded as
  // "reached via the workspace shell's basePath prop, never as a full-route literal". That reading
  // was too generous: the literal scan could not see a link because there was no link. Both pages
  // were reachable only by typing the URL, and they were two of THIRTEEN personal /workspace pages
  // in that state.
  //
  // They are now real literals in src/lib/workspace/personal-workspace-nav.ts, which the tab strip
  // and the account menu both render, so the scan finds them the ordinary way. Removed rather than
  // re-worded, per this ratchet's own rule: ground that was won cannot be given back.
  // ── CLEARED 2026-09-14 ────────────────────────────────────────────────────────────────────────
  // The native visit and plan pilot pages (log, plan, confirmations, plan-reviews, for-reps) sat here
  // from 2026-09-13, each reached only from a button on My Visits. They are now redirects into Phoenix
  // CRM (/employee-portals/phoenix-crm), which the scan finds as a link on its own, so no row replaces
  // them. Removed rather than re-worded, per this ratchet's own rule.
  //
  // 2026-09-17: the same five redirects (and /admin/visit-entry) now land in the clean Phoenix CRM at
  // /employee-portals/field-crm (/admin/field-crm), which is what links that module.
  //
  // 2026-09-25: the pilot itself is retired (the owner). /employee-portals/phoenix-crm is now a
  // redirect-only stub into the field app, which the reverse guard exempts mechanically, so its
  // gate-unreadable-and-unlinked row was removed rather than re-worded.
  //
  // 2026-10-31: the old coaching report form takes no new reports (owner) — the Team Coaching Skills
  // Survey replaced it. The two rows below are the form's old addresses, kept as redirect-only stubs so
  // a bookmark, an old notification or the portal coaching pages' admin redirect lands on the survey.
  // Each declares its portal twin with a shell check (src/lib/navigation/portal-twins.ts), which makes
  // its gate readable, so the guard counts it as a page; nothing should link to a forwarder.
  { route: "/coaching/new", roles: ["CEO", "Finance Manager", "Financial Advisor", "HR Administration", "HR Advisory", "HR Operations", "HR Resourcing", "SFE Manager", "Super Admin"], kind: "linked-from-a-component", reason: "A redirect-only stub onto the Team Coaching Skills Survey since the old coaching form stopped taking new reports (owner, 2026-10-31). Its only remaining links are the admin-shell redirects in app/employee-portals/coaching/page.tsx and app/employee-portals/coaching/[id]/page.tsx; nothing should offer a forwarder in the rail.", recorded: "2026-10-31" },
  { route: "/coaching/import", roles: ["CEO", "Finance Manager", "Financial Advisor", "HR Administration", "HR Advisory", "HR Operations", "HR Resourcing", "SFE Manager", "Super Admin"], kind: "no-link-anywhere", reason: "A redirect-only stub onto the Team Coaching Skills Survey since the old coaching form stopped taking new reports, imported ones included (owner, 2026-10-31). Its hub card was replaced by the survey's; the address stays so old bookmarks land on the survey.", recorded: "2026-10-31" },
];

export const NAVIGATION_REACHABILITY_BACKLOG_SIZE = NAVIGATION_REACHABILITY_BACKLOG.length;

/** Routes the reverse guard is responsible for — its live orphan set must equal exactly these. */
export function reverseGuardRecordedRoutes(): string[] {
  return NAVIGATION_REACHABILITY_BACKLOG.filter((gap) => REVERSE_GUARD_GAP_KINDS.includes(gap.kind)).map((gap) => gap.route);
}

/**
 * The reverse guard's BLIND SPOT — routes it skips for an unreadable gate AND that nothing links.
 *
 * Kept separate from `reverseGuardRecordedRoutes` because the two answer different questions and
 * must not be able to cancel each other out: those rows are routes whose openers ARE known, these
 * are routes whose openers are not. A route that gains a readable gate moves from this list to that
 * one, and both assertions fail until someone moves it.
 */
export function reverseGuardBlindSpotRoutes(): string[] {
  return NAVIGATION_REACHABILITY_BACKLOG.filter((gap) => gap.kind === "gate-unreadable-and-unlinked").map((gap) => gap.route);
}

/** Portal pages deliberately absent from the searchable/titled nav catalog. */
export function portalCatalogRecordedRoutes(): string[] {
  return NAVIGATION_REACHABILITY_BACKLOG.filter((gap) => gap.kind === "absent-from-portal-catalog").map((gap) => gap.route);
}

/**
 * Admin routes the literal-scan findability ratchet cannot see a link to — the runtime-assembled
 * hrefs it is blind to, plus the one genuine no-link admin page (/employee/outstation/new), which is
 * recorded once as a reverse-guard no-link-anywhere row and read from there. Portal routes are
 * excluded because the findability walk skips app/employee-portals entirely.
 */
export function literalScanFindabilityRecordedRoutes(): string[] {
  return NAVIGATION_REACHABILITY_BACKLOG.filter(
    (gap) =>
      gap.kind === "invisible-to-literal-scan" ||
      (gap.kind === "no-link-anywhere" && !gap.route.startsWith("/employee-portals")),
  ).map((gap) => gap.route);
}
