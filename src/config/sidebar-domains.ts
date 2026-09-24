import {
  CalendarClock,
  ChartColumnBig,
  ClipboardList,
  Database,
  Inbox,
  LayoutDashboard,
  Megaphone,
  ReceiptText,
  Settings2,
  UserPlus,
  UsersRound,
  type LucideIcon,
} from "lucide-react";

/**
 * The admin rail's DOMAIN layer: eleven groups over the flat section list.
 *
 * This file is presentation only. It holds no rows, no hrefs and no gates — every one of those
 * still lives in `adminNavigationSectionSeeds` (system-navigation.ts) and is still resolved by
 * `getSections` (active-path.ts), which this layer runs strictly after. Nothing here can make a
 * row visible to a role that `navigationItemVisible` refused, and nothing here can hide one it
 * allowed; `groupAdminSections` asserts exactly that.
 *
 * WHY it exists. The admin sidebar had 37 sections holding 54 rows, and 24 of those sections held
 * a single row whose label repeated the heading directly above it — the rail printed the same
 * words twice, 24 times, and a role seeing most of them scrolled a wall of headings. The grouping
 * merges those into headed bands under a handful of domains.
 *
 * THE HEADING PASS (owner, 2026-09-04, after reviewing the measured rail). The merge above left a
 * second-order version of the same stutter it was built to remove. `groupAdminSections` blanks a
 * heading that repeats one of its own visible rows, so "PEOPLE MANAGEMENT / People Management" did
 * not print twice — it printed the heading as nothing at all, and FIVE of the 14 came out blank on
 * the Super Admin's rail. Blanking is a fallback, not a layout, so every heading below is chosen
 * to say something its own rows do not, measured against the union of every row label every admin
 * role can see. The outcome is pinned by role in tests/sidebar-domains.test.ts: no heading blanks
 * for anybody, and the assertion is what keeps it that way.
 *
 * THE REBALANCE (owner, 2026-09-05, from the three scenarios in the navigation review workbook —
 * he picked this one). Two problems, both measured on the Super Admin's own rail:
 *
 *   1. TWO DOMAINS HELD MORE THAN HALF THE RAIL. People was 48 rows of 164 and Sales 42 — 90
 *      between them — while Overview and Requests held 6 each. Opening People filled the screen
 *      and kept scrolling; opening Overview showed six rows and stopped. The imbalance, not the
 *      total, is what made the rail tiring. Hiring, Time & Leave, Orders & CRM and Master Data are
 *      now domains of their own, and the biggest domain is 25 rows instead of 48.
 *
 *   2. THE WIDEST BAND WAS 17 ROWS. Admin Tools, then Source of Sales at 15, then Marketing & ROI,
 *      Recruitment & Hiring and Attendance at 12 apiece. Ten hubs are now split into several bands
 *      by `AdminHubPromotion.split` (system-navigation.ts) — real sections, not a subset taken
 *      here — so no band is longer than six rows.
 *
 * ELEVEN DOORS, SHORTER ROOMS is the trade, and it was made deliberately: eleven closed accordions
 * are more to scan than seven, and each one opens onto something a person can read without
 * scrolling. Do not "simplify" it back by merging domains without re-measuring the row counts.
 *
 * No row label, permission, gate or section moves in this file. This layer runs strictly AFTER
 * `getSections`, so it cannot grant or hide anything — it decides only what the bands are called
 * and which domain they sit in.
 *
 * TWO RULES, both mechanical, both tested in tests/sidebar-domains.test.ts:
 *
 *   1. Every admin section id appears in exactly one group. A section added to the seeds and not
 *      placed here is a build-time-invisible mistake — it would render, but at the bottom under
 *      "More", away from its siblings. The test names it instead. The same assertion, read the
 *      other way, is what catches a `split` band whose hrefs stopped matching its hub: its id is
 *      named here and exists nowhere in `adminNavigationSections`, and the test calls it a phantom.
 *   2. An unmapped section is NEVER dropped. `UNGROUPED_DOMAIN` catches it. A nav row silently
 *      ceasing to exist is the one failure mode this layer could plausibly introduce, and it is
 *      the failure mode nobody notices: the page still works, the link is simply unreachable.
 *
 * Order matters twice over. The domains render top to bottom in the order written here, and inside
 * a group the sections render in the order their ids are listed — which is how several one-row
 * sections come to sit under one heading in a deliberate reading order rather than the order they
 * happen to occupy in the seeds.
 */
export type SidebarDomainGroup = {
  /** The heading rendered above these rows. Merges one or more real sections. */
  heading: string;
  /** Section ids from `adminNavigationSectionSeeds`, rendered in this order. */
  sectionIds: readonly string[];
};

export type SidebarDomain = {
  id: string;
  /** What the rail calls it. */
  name: string;
  /** One sentence, shown under the name while the domain is open. */
  desc: string;
  icon: LucideIcon;
  groups: readonly SidebarDomainGroup[];
};

export const adminSidebarDomains: readonly SidebarDomain[] = [
  {
    id: "overview",
    name: "Overview",
    desc: "Where the day starts — dashboards, the org chart and the 360 views.",
    icon: LayoutDashboard,
    groups: [
      // Not "Command Center": that is the label of a row inside this very group (the generic
      // /admin one), and a heading repeating a row is blanked. Its rows are five different
      // overview dashboards — CEO, SFE, Finance, Business Review and the admin-wide one.
      { heading: "Dashboards", sectionIds: ["command-center"] },
      {
        heading: "Explore",
        sectionIds: ["organogram", "employee-360", "customer-360", "company-activity-report"],
      },
    ],
  },
  {
    id: "requests",
    name: "Requests",
    desc: "What is waiting on a decision — yours, and everyone else's.",
    icon: Inbox,
    groups: [
      { heading: "My Requests", sectionIds: ["my-requests"] },
      { heading: "Approvals", sectionIds: ["approvals-hub"] },
    ],
  },
  {
    id: "people",
    // Hiring and Time & Leave used to live here too, which is how this domain reached 48 rows.
    // What is left is the employee record itself, the reports about it, and probation.
    name: "People",
    desc: "Employee records, the reports about them, probation, and service milestones.",
    icon: UsersRound,
    groups: [
      { heading: "Employee Records", sectionIds: ["hub-people-management", "finance-resignations"] },
      { heading: "HR Reports", sectionIds: ["hub-people-reports", "people-management"] },
      { heading: "Plans & Support", sectionIds: ["hub-people-plans"] },
      { heading: "Probation Tools", sectionIds: ["hub-probation-tools", "ceo-probation"] },
      // Milestones is about the person rather than the sales line, which is why it sits here and
      // not beside Spotlight under Sales. It is its own heading because a keepsake is not a report.
      { heading: "Recognition", sectionIds: ["people-milestones-module"] },
    ],
  },
  {
    id: "hiring",
    name: "Hiring",
    desc: "The pipeline from an inbound CV to a signed offer.",
    icon: UserPlus,
    groups: [
      { heading: "Recruitment & Hiring", sectionIds: ["hub-recruitment-hiring"] },
      { heading: "CV Pipeline", sectionIds: ["hub-recruitment-pipeline", "recruitment-hiring"] },
      { heading: "Hiring Managers", sectionIds: ["ceo-recruitment-candidates"] },
    ],
  },
  {
    id: "time",
    name: "Time & Leave",
    desc: "Attendance, the calendars, leave and field coaching.",
    icon: CalendarClock,
    groups: [
      { heading: "Attendance Reports", sectionIds: ["attendance-management", "finance-fingerprint-report"] },
      // Five calendars in one place, which is the point: two of them read almost alike and used to
      // sit in different domains. See the rename at `ceo-company-calendar` in system-navigation.ts.
      { heading: "Calendars", sectionIds: ["attendance-management-calendars", "ceo-company-calendar"] },
      { heading: "Attendance Setup", sectionIds: ["attendance-management-setup"] },
      // "Leave", not "Leave Management": `finance-leave-management` carries a row called exactly
      // "Leave Management", and groupAdminSections blanks a heading that repeats one of its own
      // rows — which tests/sidebar-domains.test.ts fails on.
      { heading: "Leave", sectionIds: ["leave-management", "finance-leave-management", "vacation-sources"] },
      // `early-birds` moved here from "Attendance Setup" on 2026-09-18. Owner Ruling 6
      // (2026-08-28) is "Early Birds with Field Force", and system-navigation.ts's own note on the
      // section says it in as many words: "Early Birds is field-force recognition and Field
      // Coaching is the row it belongs beside." The domain map had it filed under a heading that
      // reads as a settings screen, which is where the owner could not find it. Nothing about
      // visibility changes — this layer runs after getSections and can only decide where a
      // surviving row is drawn. The heading does not blank: field-coaching's four rows are
      // Coaching Evaluations / Coaching Analytics / Import History / Resigned Evaluations, and
      // "Early Birds" is the fifth — none of them repeats the words "Field Coaching".
      { heading: "Field Coaching", sectionIds: ["field-coaching", "early-birds"] },
    ],
  },
  {
    id: "money",
    name: "Payroll",
    desc: "Salaries, the payroll runs and outstation expenses.",
    icon: ReceiptText,
    groups: [
      { heading: "Payroll Management", sectionIds: ["payroll", "finance-payslips-center"] },
      { heading: "Expense Desk", sectionIds: ["expenses-outstation"] },
      { heading: "Expense Records", sectionIds: ["expenses-outstation-records"] },
      // Both rows ARE the automated-payroll module (/admin/automated-payroll and its
      // /finance sibling), so the heading names the capability rather than repeating the row.
      { heading: "Automation", sectionIds: ["automated-payroll"] },
    ],
  },
  {
    id: "sales",
    // Direct orders and the CRM left for their own domain; what stays is the closing and the data
    // that feeds it.
    name: "Sales",
    desc: "The closing, the imports behind it, the mapping and the weekly feed.",
    icon: ChartColumnBig,
    groups: [
      { heading: "Closing & Achievement", sectionIds: ["sales-source-of-sales"] },
      { heading: "Sales Imports", sectionIds: ["sales-sos-imports"] },
      { heading: "Sales Mapping", sectionIds: ["sales-sos-mapping"] },
      { heading: "Sales Integrity", sectionIds: ["sales-sos-integrity"] },
      {
        heading: "Targets & Closing",
        sectionIds: ["sales-vs-target-module", "sales-targets-module", "monthly-closing", "sales-spotlight-module", "pm-product-master"],
      },
      { heading: "Weekly Sales", sectionIds: ["sales-weekly-module"] },
    ],
  },
  {
    id: "orders",
    name: "Orders & CRM",
    desc: "Direct orders, the pharmacies behind them, and the CRM boards.",
    icon: ClipboardList,
    groups: [
      // "Order Desk", not "Direct Orders". This band leads with the workspace row, which IS called
      // "Direct Orders", and a heading repeating one of its own rows is blanked by
      // `groupAdminSections`. The row keeps the module's name; the heading gives way.
      { heading: "Order Desk", sectionIds: ["sales-direct-orders"] },
      { heading: "Direct Order Pharmacies", sectionIds: ["sales-direct-orders-pharmacies"] },
      { heading: "Direct Order Setup", sectionIds: ["sales-direct-orders-setup"] },
      { heading: "CRM Boards", sectionIds: ["crm"] },
      // Not "CRM Integrity": that is the label of a row inside this very group.
      { heading: "CRM Data Quality", sectionIds: ["crm-integrity"] },
      // The Super-Admin gallery of field-captured customers spans both this domain's direct orders
      // and Marketing's validated requests; it sits here beside the order desk and pharmacies whose
      // captures it reviews. "Field Evidence", not "Verified Captures": that is the one row inside
      // this band, and a heading repeating its own row is blanked by `groupAdminSections`.
      { heading: "Field Evidence", sectionIds: ["verified-captures"] },
    ],
  },
  {
    id: "marketing",
    name: "Marketing",
    desc: "Marketing spend and ROI, the request desk, and adverse-event reporting.",
    icon: Megaphone,
    groups: [
      { heading: "ROI", sectionIds: ["hub-marketing-roi"] },
      // Not "Marketing Requests" and not "Marketing Control": both are row labels in this domain.
      { heading: "Requests & Inbox", sectionIds: ["hub-marketing-requests", "workspace-marketing-requests"] },
      { heading: "Validation & Control", sectionIds: ["hub-marketing-control"] },
      { heading: "Pharmacovigilance", sectionIds: ["hub-pharmacovigilance", "pharmacovigilance"] },
    ],
  },
  {
    id: "system",
    // Named "Platform" rather than "System" since the rebalance: the master data left for its own
    // domain, so what is here is the running of the platform rather than everything technical.
    // The id stays "system" — `domainIdForHref` hands it to the rail as the open-accordion key.
    name: "Platform",
    desc: "Health, delivery, maintenance, access control and the comms templates.",
    icon: Settings2,
    groups: [
      { heading: "Platform Health", sectionIds: ["admin-tools"] },
      { heading: "Email & Notifications", sectionIds: ["admin-tools-comms"] },
      { heading: "Data & Maintenance", sectionIds: ["admin-tools-data"] },
      { heading: "My Tools", sectionIds: ["admin-tools-personal"] },
      { heading: "Access Control", sectionIds: ["access-communication"] },
      { heading: "Comms Templates", sectionIds: ["access-communication-templates"] },
    ],
  },
  {
    id: "master-data",
    name: "Master Data",
    desc: "The customer, pharmacy and area catalogues every report reads from.",
    icon: Database,
    groups: [
      { heading: "Master Data", sectionIds: ["master-data"] },
      // A band because the "Customers Database" row inside Master Data was itself a hub door, and
      // the owner's 2026-09-05 rule leaves none. Its own heading rather than six more rows under
      // Master Data: the six are one module (directory, mapping, pharmacy master, marketing's
      // customer database), and folding them in would make Master Data an eight-row list of
      // unrelated things.
      { heading: "Customers Database", sectionIds: ["hub-customers-database"] },
    ],
  },
];

/**
 * Where a section with no home goes. Renders last, under its own heading, with every row intact.
 *
 * This is the safety net for rule 2 above, not a category anyone should be using: the test fails
 * on a section that lands here, so in a green repo it is always empty.
 */
export const UNGROUPED_DOMAIN: SidebarDomain = {
  id: "more",
  name: "More",
  desc: "Modules not yet placed in a domain.",
  icon: Settings2,
  groups: [],
};
