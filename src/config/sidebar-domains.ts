import {
  ChartColumnBig,
  Inbox,
  LayoutDashboard,
  Megaphone,
  ReceiptText,
  Settings2,
  UsersRound,
  type LucideIcon,
} from "lucide-react";

/**
 * The admin rail's DOMAIN layer: seven groups over the flat section list.
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
 * merges those into 13 headings under 7 domains — 14 until the heading pass below.
 *
 * THE HEADING PASS (owner, 2026-09-04, after reviewing the measured rail). The merge above left a
 * second-order version of the same stutter it was built to remove. `groupAdminSections` blanks a
 * heading that repeats one of its own visible rows, so "PEOPLE MANAGEMENT / People Management" did
 * not print twice — it printed the heading as nothing at all, and FIVE of the 14 came out blank on
 * the Super Admin's rail. His People domain read as two unlabelled bands followed by a third with a
 * heading, which is harder to scan than the stutter was.
 *
 * Blanking is a fallback, not a layout. The five headings are renamed here so each says something
 * its rows do not, and the two hiring groups are merged into one — measured against the union of
 * every row label every admin role can see, so a rename cannot collide for some other seat. The
 * outcome is pinned by role in tests/sidebar-domains.test.ts: no heading blanks for anybody now,
 * and the assertion is what keeps it that way.
 *
 *   overview  "Command Center"      -> "Dashboards"      (row "Command Center" was the collision)
 *   people    "People Management"   -> "Employees"       (row "People Management")
 *   people    "Recruitment & Hiring"-> "Recruitment"     (row "Recruitment & Hiring"), and the
 *                                                        separate "Hiring" group folds into it —
 *                                                        two adjacent hiring bands in one domain
 *   money     "Automated Payroll"   -> "Automation"      (row "Automated Payroll")
 *   marketing "Marketing & ROI"     -> "Requests & ROI"  (row "Marketing & ROI")
 *
 * No row label, permission, gate or section moves. This layer runs strictly AFTER `getSections`,
 * so it cannot grant or hide anything — it decides only what the bands are called.
 *
 * TWO RULES, both mechanical, both tested in tests/sidebar-domains.test.ts:
 *
 *   1. Every admin section id appears in exactly one group. A section added to the seeds and not
 *      placed here is a build-time-invisible mistake — it would render, but at the bottom under
 *      "More", away from its siblings. The test names it instead.
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
    name: "People",
    desc: "Employees, attendance, leave and the hiring pipeline.",
    icon: UsersRound,
    groups: [
      { heading: "Employees", sectionIds: ["people-management"] },
      // One recruitment band, not two. "Recruitment & Hiring" blanked (it repeats its own first
      // row) and "Hiring" sat directly beneath it, so the Super Admin read an unlabelled pair of
      // rows followed by a headed pair, all four about hiring. The CEO-gated candidate section
      // keeps its own gate; only the heading above it changes.
      {
        heading: "Recruitment",
        sectionIds: ["recruitment-hiring", "ceo-recruitment-candidates"],
      },
      {
        heading: "Workforce",
        // The four finance-* sections and vacation-sources are the ones the owner never saw while
        // reviewing this grouping: they are gated away from Super Admin, so they were absent from
        // the rail he was looking at. Placed by subject — leave with leave, attendance with
        // attendance — rather than left to fall through to "More".
        sectionIds: [
          "ceo-probation",
          "field-coaching",
          "attendance-management",
          "early-birds",
          "leave-management",
          "ceo-company-calendar",
          "finance-leave-management",
          "vacation-sources",
          "finance-resignations",
          "finance-fingerprint-report",
        ],
      },
    ],
  },
  {
    id: "money",
    name: "Payroll",
    desc: "Salaries, the payroll runs and outstation expenses.",
    icon: ReceiptText,
    groups: [
      {
        heading: "Payroll",
        sectionIds: ["payroll", "expenses-outstation", "finance-payslips-center"],
      },
      // Both rows ARE the automated-payroll module (/admin/automated-payroll and its
      // /finance sibling), so the heading names the capability rather than repeating the row.
      { heading: "Automation", sectionIds: ["automated-payroll"] },
    ],
  },
  {
    id: "sales",
    name: "Sales",
    desc: "Closings, targets, the source of sales and the CRM.",
    icon: ChartColumnBig,
    groups: [
      {
        heading: "Sales",
        sectionIds: [
          "sales-source-of-sales",
          "sales-vs-target-module",
          "monthly-closing",
          "sales-weekly-module",
          "sales-direct-orders",
          "sales-targets-module",
          "crm",
          "pm-product-master",
        ],
      },
    ],
  },
  {
    id: "marketing",
    name: "Marketing",
    desc: "Marketing spend and ROI, and adverse-event reporting.",
    icon: Megaphone,
    groups: [
      // The row "Marketing & ROI" is inside this group; the heading says what the three rows
      // have in common instead of repeating the first one.
      { heading: "Requests & ROI", sectionIds: ["workspace-marketing-requests"] },
      { heading: "Safety", sectionIds: ["pharmacovigilance"] },
    ],
  },
  {
    id: "system",
    name: "System",
    desc: "Master data, access control and the admin tooling.",
    icon: Settings2,
    groups: [
      {
        heading: "Administration",
        sectionIds: ["admin-tools", "master-data", "access-communication"],
      },
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
