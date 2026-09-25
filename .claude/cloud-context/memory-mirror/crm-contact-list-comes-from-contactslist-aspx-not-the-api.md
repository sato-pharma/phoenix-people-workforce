---
name: crm-contact-list-comes-from-contactslist-aspx-not-the-api
description: "The rep's doctor list lives on the CRM WEB page ContactsList.aspx (site10), not in the Reporting API — server login works, it carries contact ID/address/grade/specialty, and all 82 current agents were pulled in one sweep"
metadata: 
  node_type: memory
  type: project
  originSessionId: 9fb33483-9e95-4e1b-b031-175186fde22c
  modified: 2026-08-28T17:34:38.318Z
---

**Proven live 2026-08-28, then swept company-wide the same day.** The iReports360 **Reporting API has
no contacts endpoint** — see [[crm-api-contacts-endpoint-exists-address-is-ours]]. The real list is on
the CRM **web app**, and Phoenix can log into it server-side with credentials it already holds.

**Two different hosts. Do not confuse them.**

| | Host | What it is |
| --- | --- | --- |
| Reporting API | `hmaxhmax-001-site7` (`IREPORTS360_BASE_URL`) | 9 JSON paths, visits/checkins/plans only |
| CRM web app | **`hmaxhmax-001-site10`** | ASP.NET WebForms + Telerik RadGrid, holds the contact lists |

**The login that works** (same `IREPORTS360_USERNAME` / `IREPORTS360_PASSWORD`): GET `/Login.aspx`,
carry `ASP.NET_SessionId`, POST back `__VIEWSTATE` + `__VIEWSTATEGENERATOR` + `__EVENTVALIDATION`
with `ctl00$ContentPlaceHolder1$username` / `…$password` / `…$Button1=Login`. Success is a **302 to
`/Main.aspx`**. The form also posts `txtAddress`/`txtLatitude`/`txtLongitude` — empty is accepted.

## The two traps

**1. The list type is `t=Pharmacy`, NOT `t=PH` — and a wrong `t` returns an EMPTY GRID, not an
error.** A `t=PH` sweep reported "0 pharmacies for all five reps" and looked entirely credible; the
agent grid's own counter said 45–59 for four of them. **Always cross-check a fetched count against
the counter column before believing a zero.** Valid values: `PM`, `AM`, `Pharmacy`.

**2. The CRM's own Yes/No active column is NOT Phoenix's roster.** It marks **121** medical-rep
accounts "Yes" against **67** active Medical Representatives in `employees`. That is the
never-delete/clone habit in [[crm-resigned-slot-reused-for-new-hire]] — leaver accounts stay "Yes".
**Drive any sweep from Phoenix's `employees` + `agent_crm_id`, never from the CRM's flag.**

## How to fetch

`GET /ContactsList.aspx?t=PM|AM|Pharmacy&q=<agentCrmId>` returns a 14-column grid:
`ID · AM/PM · City · Zone · Region · Contact Name · Grade · Spec. · Contact Name Ar · phone# · Address`.
**It returns the LIVE list only** — already filtered to non-ended.

`/Agents.aspx` lists agents **50 at a time** (page-size combo offers only 10/20/50). Page it with the
`Next Page` submit button **`ctl00$ContentPlaceHolder1$RadGrid1$ctl00$ctl03$ctl01$ctl20`**, reposting
every hidden field — 7 pages, **305 agents**. Its rows also carry the **PM / AM / Pharmacy counts per
agent for free**, plus job title, line, hiring date and the `( Area / Line )` label — so a census
needs no per-agent fetch at all.

## What the full sweep found (82 current agents, 246 requests, 0 failures)

**9,521 contact rows — 6,797 PM, 872 AM, 1,852 Pharmacy — 7,667 distinct doctors.**

- **94.2% (7,219) already known to Phoenix; 448 have never been planned or visited by anyone.**
- Attribution is near-perfect: of the doctor rows Phoenix knows, **99.2% are under the same rep.**
- Field fill on 7,669 doctor rows: **Grade 100%, Region 100%, Specialty 99.7%, Arabic name 99.9%,
  Address 94.8%, phone# 35.6%.** Address/grade/specialty are dependable; **phone is not.**
- **59 of 67 active reps land in the owner's 90–120 PM band** (see
  [[crm-boards-key-the-same-rep-two-different-ways]] for why counts look different elsewhere).
- **`Adel.Srour ( Down-town / C )` (CN-0006) has no list at all** — 0 PM, 0 AM, 0 Pharmacy.
- District Managers hold no list of their own; only `Nermeen.Salah` (B-154) had one, 25 doctors,
  and planned none of them in August.
- **August coverage of the real list: 6,788 of 7,667 = 88.5%.** Two agents planned none of theirs.
- Reverse gap: **599 contacts (6.8%) worked in August by a current agent are on nobody's current
  list** — the CRM list is a snapshot, so a page must not treat "not on the list" as "not his".

**`ID` is `ireports360_visits.contact_crm_id` — the join is exact.** Never re-derive a rep's list by
matching contact NAMES; that earlier approach scored 85.6% and is strictly worse.

## It is a TABLE in production now, not a one-off sweep (2026-08-28, 19:37 Cairo)

`public.ireports360_contacts` holds the mirror — 18 columns, RLS on, service-role only, PK
`(agent_crm_id, contact_crm_id, list_type)`. Written by exactly one thing:
`GET /api/cron/crm-contact-lists`, guarded by `CRON_SECRET`, refreshing every rep daily.

**IT IS SLICED INTO TWELVE, AND THE SCHEDULE IS PART OF THE CODE.** A full sweep is ~156 s and
cron-job.org cuts every request at 30 s — a platform cap that ignores `requestTimeout`. The work
itself DOES complete after the cut (the audit row proved it: all 82 agents, ~70 s past the kill),
so this is not a data-integrity fix — it is so the job reports the truth instead of a permanent
`Failed (timeout)` nobody reads, and so completion never depends on a detached request surviving a
container restart. See [[cron-job-org-is-managed-by-a-rest-api-not-just-the-web-ui]] for the
mid-sweep-snapshot trap that made this look like data loss.

The route serves **one twelfth of the roster per call, chosen from the Cairo MINUTE**, so the cron
entry MUST fire **every 5 minutes across one whole hour** — job **8344730**, `hour 5`,
`minute 0,5,…,55`, `Africa/Cairo`, `requestTimeout 30`, set 2026-08-28. Fire it hourly or once a
day and it sweeps the same twelfth forever while looking perfectly green. `?slice=N` re-runs a
missed tick; `?all=1` is the by-hand backfill only. The partition is round-robin over the id-sorted
roster, never `agentCrmId % 12` — that modulo put 11 of the 82 agents in one slice against 4 in
another. **Measured live on production: 7 agents, ~1,000 rows, 8-10 s per tick, 0 skipped.**
Read by the **Doctor List** board at `/admin/doctor-list` (Super Admin only for now — a district
manager must see HIS reps first, and that scope does not exist yet).

**First production run: 82 accounts swept, 156 seconds, 9,518 rows, 0 failures, 0 refusals.**
6,795 PM + 872 AM + 1,851 Pharmacy; 9,116 carry an address; **every `contact_crm_id` is unique, so
no doctor sits on two reps' lists.**

**68 of the 82 accounts returned rows, and that is CORRECT — do not chase the other 14.** They are
13 of the 17 District Sales Managers (a DSM holds no list of his own; only 2 do, 25 doctors each)
plus `Adel.Srour` CN-0006, who is genuinely working — 24 visits, last 2026-08-27 — against a list
the CRM never registered. He has ONE agent id (1521), so it is not a wrong-account problem. A rep
with no rows does not appear in the board's picker at all.

**An empty answer NEVER empties the mirror.** `decideContactReplacement` refuses to apply an empty
fetch against a non-empty mirror, so a vendor outage or an expired session degrades to "yesterday's
list", not "no doctors". `tests/crm-contact-lists.test.ts` pins that rule.

**Name and phone shapes, measured on all 9,518 rows:** 9,459 contact names contain Arabic, longest
50 chars; longest address 42; **41 phones contain a literal `?` typed into the CRM** — those are the
vendor's own characters, not an encoding fault (checked: zero bidirectional control marks anywhere).

---

## The Agents grid's `username` field holds the SUPERVISOR, not the login (2026-09-03)

`parseAgentGrid` in `src/lib/crm/contacts-web-client.ts` maps `cells[9]` to a field called
`username`. **It is not the account's username — it is the person the account reports to.** Slot
1485's label is `Manar.Sadek ( Behira 2 / C )` and its `username` reads `Saad.Mohamed`, who is B-119,
her district manager; slots 1453 (`Mariam.Mohamed ( KFS / C )`) and 1399 (`Omar.Tamer ( Tanta / A )`)
carry `Saad.Mohamed` and `Dina.Fadel`, both DMs, the same way. Four managers account for most of the
column.

**Why it matters: matching accounts to people on that field is silently self-cancelling.** Building
the deactivation sheet, keying `employees.crm_username` off `label` *or* `username` credited **22
dormant accounts to the live managers above them** and reported them as in service — 19 candidates
instead of 48. The failure is invisible: every one of those 22 resolves to a real, currently employed
person, so nothing looks wrong. **Match on `label` only.**

**Nothing in the app consumes this** — `git grep crmWebFetchAgents -- src app` returns only the
module itself, so it is a naming defect in an ad-hoc-script-only surface, not a live bug. The field
name is what misleads; fix the name before trusting it.

**Resolving an account to a person needs four routes, in this order**, because a released slot has
neither a link nor a stored username: `employees.crm_id` = slot; then `employees.crm_username` = the
label; then **the person's name read out of the label itself** (`Mohamed.Eldomiaty ( Dom-Port.Said /
P )` → tokens `mohamed` + `eldomiaty`, accepted only when they match exactly ONE employee's full
name); then the `agent_hr_id` on the account's last real visit. Route 3 is the only one that finds a
slot whose link *and* username were both cleared — PD-0011 and AI-0004 had both, and route 4 names
the wrong person on a reused slot, because the visits under it are the previous holder's.

**Excluding the 27 August stamps is mandatory when judging "has this account been used".** Every
account received a company-wide Public Holiday entry that day (`visit_type = -5`, `contact_crm_id =
0`), so the raw last-visit date reads 2026-08-27 for essentially every dormant account. Filter
`contact_crm_id > 0 AND visit_type <> -5`. See [[crm-resigned-slot-reused-for-new-hire]].

## The Agents grid cannot deactivate an account — the Update never persists (2026-09-03)

Setting **"Is Working?"** (`RadComboBox6`, the last control in the inline edit row) to `No` and
pressing Update closes the row with no error and **saves nothing**. Confirmed on slots 1453 and
1399 by the owner in his own browser, and verified from a fresh login three ways: the grid's
Active column, the edit form's own control, and the active/total counts (171/305, unchanged).

**Do not spend a session rediscovering this.** What was already ruled out:

- Both entry points fail — the Edit link and the row double-click that calls `editItem()`.
- **No client-side validators exist on the page** (`Page_Validators` absent, zero
  `evaluationfunction`), so nothing is silently refusing the click.
- `HrID` is empty in the edit form on a healthy active account too, so it is not the blocker.
- There is **no other agent-edit surface**. Agents.aspx links only seven pages —
  `AgentsArea`, `AgentsTarget`, `ContactsList`, `ContactsListFull`, `Login`, `Profile`,
  `Settings` — and the second tab is a hierarchy chart, while `ImageButton1/2/3` are just
  PDF/Word/Excel exports.

**The likely cause:** the page-level hidden `ContentPlaceHolder1_AgentID` is empty and no
JavaScript ever assigns it (the only functions on the page are `RowDblClick`, `RowClick`,
`onPopUpShowing`, `KeepNew`, `ExitNew` — the last two set `IsNew` only). An update keyed on
`WHERE AgentID = @AgentID` matches zero rows and returns quietly.

**Never script a save through this form.** It round-trips `RadTextBox5`, the account
**password**, which the page serves in clear text — a malformed post rewrites credentials.
134 of 305 accounts are already inactive, so the flag is settable somehow, but not from here:
it is a vendor fix. Report written to
`scratchpad/CRM bug - deactivating an agent does not save.md`.
