---
name: crm-contact-list-comes-from-contactslist-aspx-not-the-api
description: "The rep's doctor list lives on the CRM WEB app ContactsList.aspx (host site10), NOT the Reporting API (site7, which has no contacts endpoint). Phoenix logs in server-side with the iReports360 credentials it already holds. Two traps: list type is t=Pharmacy not t=PH (a wrong t returns an EMPTY grid, not an error), and the CRM's own Yes/No active flag is NOT Phoenix's roster (leavers stay Yes) — drive every sweep from employees + agent_crm_id. ID = contact_crm_id, an exact join; never name-match a rep's list. Mirrored to public.ireports360_contacts by a cron that MUST fire every 5 min across one hour (12 slices)."
metadata:
  node_type: memory
  type: project
  originSessionId: 9fb33483-9e95-4e1b-b031-175186fde22c
  modified: 2026-09-26T00:03:47.056Z
---

The iReports360 **Reporting API has no contacts endpoint** ([[crm-api-contacts-endpoint-exists-address-is-ours]]).
The real doctor/pharmacy list is on the CRM **web app**, which Phoenix can log into server-side with the
credentials it already holds. **Two different hosts — do not confuse them:**

| | Host | What it is |
| --- | --- | --- |
| Reporting API | `hmaxhmax-001-site7` (`IREPORTS360_BASE_URL`) | 9 JSON paths — visits/checkins/plans only |
| CRM web app | **`hmaxhmax-001-site10`** | ASP.NET WebForms + Telerik RadGrid — the contact lists |

**The login that works** (same `IREPORTS360_USERNAME` / `IREPORTS360_PASSWORD`): GET `/Login.aspx`, carry
`ASP.NET_SessionId`, POST back `__VIEWSTATE` + `__VIEWSTATEGENERATOR` + `__EVENTVALIDATION` with
`ctl00$ContentPlaceHolder1$username` / `…$password` / `…$Button1=Login`. Success is a **302 to
`/Main.aspx`**. The form also posts `txtAddress`/`txtLatitude`/`txtLongitude` — empty is accepted.

## The two traps

1. 🔴 **The list type is `t=Pharmacy`, NOT `t=PH` — and a wrong `t` returns an EMPTY GRID, not an
   error.** A `t=PH` sweep reported "0 pharmacies for all reps" and looked entirely credible while the
   grid's own counter said 45–59. Valid values: `PM`, `AM`, `Pharmacy`. **Always cross-check a fetched
   count against the counter column before believing a zero.**
2. 🔴 **The CRM's own Yes/No active flag is NOT Phoenix's roster** — leaver accounts stay "Yes" (the
   never-delete/clone habit, [[crm-resigned-slot-reused-for-new-hire]]), so it marks far more reps active
   than `employees` does. **Drive any sweep from Phoenix's `employees` + `agent_crm_id`, never from the
   CRM's flag.**

## How to fetch

- `GET /ContactsList.aspx?t=PM|AM|Pharmacy&q=<agentCrmId>` → a 14-column grid
  (`ID · AM/PM · City · Zone · Region · Contact Name · Grade · Spec. · Contact Name Ar · phone# ·
  Address`). It returns the **LIVE list only** (already filtered to non-ended).
- `/Agents.aspx` lists agents **50 at a time**; page it with the Next-Page submit button
  `ctl00$ContentPlaceHolder1$RadGrid1$ctl00$ctl03$ctl01$ctl20`, reposting every hidden field — 7 pages,
  **305 agents**. Its rows carry the **PM / AM / Pharmacy counts per agent for free**, plus job title,
  line, hiring date and the `( Area / Line )` label — **so a census needs no per-agent fetch at all.**
- 🔴 **`ID` is `ireports360_visits.contact_crm_id` — an EXACT join. Never re-derive a rep's list by
  matching contact NAMES** (name-matching scored 85.6% and is strictly worse).
- **Data quality:** Grade / Region / Specialty / Arabic name / Address are dependable (all ≥94.8%);
  **phone is not (~36% filled)**, and a phone can contain a literal `?` typed into the CRM — the vendor's
  own character, not an encoding fault.

## The production mirror and its cron schedule

`public.ireports360_contacts` holds the mirror (18 columns, RLS on, service-role only, PK
`(agent_crm_id, contact_crm_id, list_type)`), written by exactly one thing: `GET /api/cron/crm-contact-lists`
(guarded by `CRON_SECRET`), refreshing every rep daily. Read by the **Doctor List** board at
`/admin/doctor-list` (Super Admin only for now — a DM must see his reps first, and that scope does not
exist yet).

🔴 **IT IS SLICED INTO TWELVE, AND THE SCHEDULE IS PART OF THE CODE.** A full sweep is ~156 s and
cron-job.org cuts every request at 30 s (a platform cap that ignores `requestTimeout`; the work itself
still completes past the cut). The route serves **one twelfth of the roster per call, chosen from the
Cairo MINUTE**, so the cron entry MUST fire **every 5 minutes across one whole hour** — job **8344730**,
`hour 5`, `minute 0,5,…,55`, `Africa/Cairo`, `requestTimeout 30`. Fire it hourly or daily and it sweeps
the same twelfth forever while looking perfectly green. `?slice=N` re-runs a missed tick; `?all=1` is the
by-hand backfill only. The partition is **round-robin over the id-sorted roster, never `agentCrmId % 12`**
(that modulo put 11 of 82 agents in one slice against 4 in another). See
[[cron-job-org-is-managed-by-a-rest-api-not-just-the-web-ui]].

- **An empty answer NEVER empties the mirror** — `decideContactReplacement` refuses to apply an empty
  fetch against a non-empty mirror, so a vendor outage or an expired session degrades to "yesterday's
  list", not "no doctors". `tests/crm-contact-lists.test.ts` pins that rule.
- **~68 of 82 accounts return rows and that is CORRECT — do not chase the other ~14.** They are the DSMs
  (a DSM holds no list of his own; only two do, ~25 doctors each) plus `Adel.Srour` CN-0006, who is
  genuinely working against a list the CRM never registered (one agent id, 1521 — not a wrong-account
  problem). A rep with no rows never appears in the board's picker. Every `contact_crm_id` is unique, so
  no doctor sits on two reps' lists. **The CRM list is a SNAPSHOT** — contacts worked in a month can be on
  nobody's current list, so a page must never treat "not on the list" as "not his".
- **When counting "PM band" or comparing to other boards**, [[crm-boards-key-the-same-rep-two-different-ways]]
  explains why counts look different elsewhere.

## The Agents grid — two more traps (2026-09-03)

- **The grid's `username` column holds the SUPERVISOR, not the login.** `parseAgentGrid`
  (`src/lib/crm/contacts-web-client.ts`) maps `cells[9]` to a field called `username`, but it is the
  person the account **reports to** (a DM). Matching accounts to people on it is silently
  self-cancelling — it credited dozens of dormant accounts to the live managers above them and reported
  them as in service, and every one resolved to a real employed person so nothing looked wrong. **Match on
  `label` only.** Nothing in the app consumes this field (`crmWebFetchAgents` is script-only), so it is a
  naming defect, not a live bug — fix the name before trusting it.
- **Resolving an account to a person needs four routes, IN THIS ORDER**, because a released slot has
  neither a link nor a stored username: (1) `employees.crm_id` = slot; (2) `employees.crm_username` = the
  label; (3) **the person's name read out of the label itself** (tokens accepted only when they match
  exactly ONE employee's full name); (4) the `agent_hr_id` on the account's last real visit. **Route 3 is
  the only one that finds a slot whose link AND username were both cleared, and route 4 names the WRONG
  person on a reused slot** (the visits under it are the previous holder's).
- **Excluding the company-wide 27-Aug stamps is mandatory when judging "has this account been used."**
  Every account got a Public Holiday entry that day (`visit_type = -5`, `contact_crm_id = 0`), so the raw
  last-visit date reads 2026-08-27 for essentially every dormant account. Filter
  `contact_crm_id > 0 AND visit_type <> -5`.
- 🔴 **The Agents grid CANNOT deactivate an account — the "Is Working?" Update never persists** (confirmed
  by the owner in his own browser; the active/total counts do not move). Likely cause: the page-level
  hidden `ContentPlaceHolder1_AgentID` is empty and nothing assigns it, so an update keyed on it matches
  zero rows and returns quietly. There is no other agent-edit surface. **NEVER script a save through this
  form — it round-trips `RadTextBox5`, the account PASSWORD, in clear text, so a malformed post rewrites
  credentials.** Deactivation is a vendor fix; do not spend a session rediscovering this.
