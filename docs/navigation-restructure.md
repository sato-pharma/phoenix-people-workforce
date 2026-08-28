# Navigation restructure — the owner's eleven rulings

**Status: model only. Zero lines of `src/config/system-navigation.ts` have changed.**

This file exists because the last model didn't. An earlier session modelled this restructure in
full — 21 modules over 234 pages — and never wrote it down, so it died with that session's context
and had to be rebuilt from the transcript. Whatever happens to this work, the model now survives on
disk and in git.

## The eleven rulings, verbatim

Recovered from the owner's own message. These are decisions, not suggestions.

| # | Ruling |
|---|---|
| 1 | Sales = 5 blocks; **Monthly Closing alone**, **Targets alone** |
| 2 | Direct Orders separate from Sales; Direct Order Exceptions is **not** an approval |
| 3 | Marketing Requests its own module, Marketing ROI folded in |
| 4 | Payroll and Expenses **totally** separate |
| 5 | Weekly/Monthly Plans **not** under Attendance & Leave |
| 6 | Field Force splits: field **visits** vs field **coaching**; Early Birds with Field Force |
| 7 | Workforce Compliance and Double Visit **not** training-manager-only |
| 8 | Attendance separate from Leave |
| 9 | **New HR module** — employees, organogram, resignations, contracts |
| 10 | Layer 1 = **Approvals + Organogram only** |
| 11 | **No analytics module, no sales analytics** (said three times) |

## What ships today (as-is)

Read from the real config, not from memory: **35 sections, 60 items** in
`adminNavigationSectionSeeds` (lines 197–1046). The employee portal is a separate tree
(1048–1347) and is **out of scope** — the portal also builds its own sidebar and line picker, which
`system-navigation.ts` does not drive at all.

Defects visible in the as-is, independent of the rulings:

- **`/organogram` appears twice** — in `command-center` and in `people-management`.
- **`/admin/weekly-plans/calendar` appears twice** — `ceo-company-calendar` and
  `finance-events-calendar`, same href, two sections, two labels ("Company Calendar" both times).
- **Leave Management exists twice** — `finance-leave-management` (`/admin/finance-leave-management`)
  and `leave-management` (`/leave-management`). Different pages, identical section label.
- **Probation is scattered across five entries** in `people-management` plus a sixth in
  `ceo-probation`.
- **`/admin/crm` and `/admin/crm-tools` both render as "CRM"** in the same section.

## Proposed to-be

Ruling 11 removes `sales-analytics` (`/admin/analytics`) as a navigation module. Note the Monthly
Closing page lives at `/admin/analytics/monthly-closing/details` — the **href** contains the word,
the **module** does not. Ruling 11 is about modules and labels; the route is not being renamed here.

### Layer 1 — ruling 10
| module | items |
|---|---|
| Approvals | Leave Approvals, Excuse Approvals, Plan Approvals, Other Approvals |
| Organogram | `/organogram` (single entry — the duplicate is removed) |

### Sales — ruling 1 (five blocks), ruling 2, ruling 11
| module | items |
|---|---|
| Source of Sales | Source of Sales, Territory Management ⚠️ |
| Weekly Sales | Weekly Sales |
| Sales vs Target | Sales vs Target |
| Monthly Closing | Monthly Closing — **alone**, per ruling 1 |
| Targets | Targets — **alone**, per ruling 1 |
| Direct Orders | Direct Orders — **outside Sales**, per ruling 2 |

`sales-analytics` is **deleted** as a module (ruling 11).

### People — rulings 4, 5, 6, 7, 8, 9
| module | items |
|---|---|
| HR | People Management, Resignations, Contracts ⚠️, Probation (all six entries consolidated) |
| Attendance | Attendance, Fingerprint Report |
| Leave | Leave Management, Finance Leave Management, Vacation Sources, Request Vacation, Submit Excuse |
| Plans | Weekly/Monthly Plans, Company Calendar (single entry — the duplicate is removed) |
| Field Force | Field Visits ⚠️, Field Coaching, Early Birds ⚠️ |
| Workforce Compliance | Workforce Compliance, Double Visit ⚠️ — **not** training-manager-only |
| Payroll | Payroll Management, Automated Payroll, Payroll — Finance, Payslips Center |
| Expenses | Outstation Expenses — **totally separate from Payroll**, per ruling 4 |
| Recruitment | Recruitment & Hiring, My Candidates |

### Unchanged by any ruling
Command Center, Employee 360, CRM, Marketing (ruling 3: Requests + ROI folded in), Master Data,
Access & Communication, Pharmacovigilance, Admin Tools.

## ⚠️ Four calls the rulings do not settle

These are judgement calls, flagged rather than buried. Each changes what someone sees.

1. **Territory Management.** Ruling 1 says Sales is five blocks and names two of them. Territory
   Management would be a sixth. Folded into Source of Sales here, on the grounds that it *is* the
   SoS geography — and all SoS sales attribute to today's geography, so the two are one subject.
   If it should stand alone, Sales becomes six blocks.
2. **Organogram in two places.** Ruling 10 puts Organogram in Layer 1; ruling 9 lists it inside the
   new HR module. Modelled as Layer 1 only, with HR linking to it rather than duplicating it —
   because the as-is duplicate is already a defect.
3. **Contracts, Double Visit, Early Birds, Field Visits** have **no nav entry today.** Ruling 6, 7
   and 9 name them, so either they are pages that exist but were never linked, or they need
   building. This model reserves the slots; it does not invent routes.
4. **Which roles see the new modules.** Every item carries `roles`/`permissions`, and splitting one
   section into two means deciding the gate for each half. The rulings say what the *structure* is,
   not who sees it. Default taken: each half inherits the gate of the section it came from, except
   ruling 7, which explicitly widens Workforce Compliance and Double Visit beyond Training Manager.

## Safety

Navigation is **UX only** — `system-navigation.ts` hiding a link is not a security boundary, and
every page re-checks with `assertPermission`. So an error here makes a page hard to *find*, not
reachable by the wrong person. That is the difference between this and a permissions change.

Verification available without a browser: 30 nav-related test files, 23 registered in
`tests/run-tests.ts` — including `sfe-manager-nav-dead-links`,
`organogram-nav-link-exists-for-every-role-that-can-open-it`, `sidebar-label-width` (which enforces
the owner's no-truncation, no-wrap rule against a measured pixel budget),
`sidebar-role-scoped-headings`, `navigation-active-path` and `phase22-role-matrix-security`.

A restructure of this size should also add a test that pins the eleven rulings themselves — no
section id or label matching `/analytic/`, Payroll and Expenses as separate sections, Monthly
Closing and Targets each alone — so the structure cannot drift back without a red PR.
