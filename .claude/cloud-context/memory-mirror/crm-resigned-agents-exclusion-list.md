---
name: crm-resigned-agents-exclusion-list
description: "~80 iReports360 CRM agent display-names the owner flagged as RESIGNED — must be excluded everywhere in CRM data (incl. CRM Issues), as if invisible."
metadata: 
  node_type: memory
  type: project
  originSessionId: 76130c78-51c5-4485-975a-3e70161783c6
---

Owner (2026-07-17) gave a list of **resigned** CRM agents to **skip when pulling CRM data and remove from CRM Issues** ("as if you cannot see them"). Excluded at the CRM read layer by resolving each display-name → `agent_crm_id` and filtering `agent_crm_id NOT IN (...)` on every master query (DB-level, keeps counts/paging). Code-level because staging Supabase MCP blocks writes, so the proper "resigned" resolution-status route isn't applicable here.

Display-names (verbatim, trimmed):
( Heliopolis / A ) · ( Haram-Faisal / A ) · ( Cairo East 1 / F ) · (Cairo DSM / P) · ( Nasr City / P ) · ( Sharkia / E ) · ( Cairo East 2 / F ) · ( Nasr City / A ) · ( Sohag 2 / A ) · ( Others DM / C ) · Others ( Fighters DM ) · Others ( Eagles DM ) · ( Luxor - Aswan / C ) · ( Fayum / A ) · ( Ismailia-Suez MR / A ) · ( Downtown / C ) · ( Sharkia 2 / C ) · ( Dakahlia 3 / C ) · ( Main Store / C ) · ( Fayum / C ) · ( Ismailia-Suez / C ) · ( Bani Sweif / C ) · ( Cairo Others / C ) · ( Heliopolis / P ) · ( Dokki / P ) · ( Cairo West / F ) · ( Helwan-Maadi / P ) · ( Sharkia 3 / F ) · ( Minia 2 / F ) · ( Ismailia-Suez MR / F ) · Main Store ( Others MR / F ) · Luxor - Aswan ( Others MR / F ) · October - Zayed ( MR / E ) · Down town ( Cairo MR / E ) · Main Store ( Others MR / E ) · ( Sharkia 1 / F ) · ( Mohanden / E ) · ( Alex West / E ) · Maram Zakaria · Esraa Salah El Dien · Mohamed.Ahmad ( Qena 1 / E ) · ( Ismailia-Suez / E ) · ( Downtown-Shoubra Masr / F ) · ( Dokki / E ) · Mayar.Elmorsy ( Mahalla / E ) · ( Alex Center / E ) · ( Shoubra / E ) · ( Bani Sweif / F) · ( Qal / E ) · ( Behira 2 ) · ( Behera 1 / E ) · ( Alex East / E ) · ( Qena 2 / E ) · ( Assuit 1 / E ) · ( Sharkia 2 / F ) · ( Imbaba - Imbaba Centers ) · Shobra · Tanta · ( Fayoum / C ) · Tayseer.Khaled ( Ain Shams ) · Suhail.Omara · Nermeen.Nagih · Heba.Ramadan ( Fayoum ) · Mahalla MR Line 4 · Aliaa.Ehab · Dar El-Salam · Nahla.Kamal · Cairo Others ( MR / F ) · Giza Others ( MR / E ) · ( Bani Sweif / E ) · Sherif El-Sawaf · Mohamed.Aboelnil · Aswan ( Others MR / E ) · Mahmoud.Gamal · Ahmed Kaoud

**Owner-excluded (2026-07-17, not necessarily resigned)** — added to the SAME `CRM_RESIGNED_AGENT_CRM_IDS`
list (agent-side only): Ahmed Amer `667`, Adel.Sayed `1436`, CEO `1474`, George.Rafaat (Sharkia 1/C)
`1500`. (Mahmoud.Gamal `1272` was already in the list.) The list is agent-side only, so Mahmoud's 72
appearances as a DV-**partner** (double_crm_id=1272 on other reps' visits) stay — owner chose to KEEP
the reps' visits (don't remove other people's DV rows). If ever asked to fully purge a double-appearing
agent, that needs a separate double_crm_id filter and removes the reps' rows.

**Exclusion coverage (2026-07-17 audit + gap-close):** the agent-side filter
(`.not("agent_crm_id","in",CRM_RESIGNED_IN_LIST)`) is applied by crm/reads consumers,
double-visit-analytics, FWC ireports360-source, crm/master, and — after closing the gap —
**crm-integrity/service** (visits + agent-name dropdown) and probation **feedback-service**
(tickDvCheckboxesFromSync), **dv-source** (applyDoubleVisitFilter), **sfe-evidence** (visits+checkins).
Deliberately NOT added to probation **dashboard.ts** line 125 — that query is the "crmUnmapped"
identity-presence check ("does this rep appear as a CRM agent?"), where hiding resigned agents would
wrongly flag a present agent as unmapped. Filter is AGENT-SIDE only; excluded agents can still appear
as a DV **double** (owner chose to keep the reps' rows — see [[staging-churn-pin-branch-with-cloud-run-tag]] Amira note).

See [[amira-samy-crm-identity-cn-0005]] (map, don't exclude — she's active).

**2026-09-21 — the 14 "resigned" identity resolutions were traced to holders (owner asked "map the 14
resigned accounts to their real holders").** 8 are now `mapped`, stamped only up to each holder's last
real call: 1382→Hagar Hashim, 1402→Mahmoud Hosny, 1284→Mayar El Morsy (Jan–11 Mar only; the 30 Sep
calls are Nour Ahmed's, after her 09-01 exit, left uncredited), 1493→Nada Essam, 1216→Haitham Afifi,
1426→Ahmed Abdelazim, 1272→Mahmoud Gamal (`B-HIST-MG`), 1476→Ahmed Saeid Kaoud. Evidence = Jan–May
`salary_records` area+line+months (most holders are `historical_payroll_record` rows with no dates), and
for manager accounts the reps they double-visited. Pre-image: `crm_backup_20260921.resigned14_*`.
**OWNER DECISION, same day: 1134 (Sharkia 2 / Pedia — Mostafa Saeed, no employee row), 1528
(Haram-Faisal / A) and 1496 (Dr Ezzat Sedrak) STAY `resigned` — never re-propose mapping them.** 1373,
1510, 1512 (8 rows, no person evidence) also stay. Adding an employee row to map one fires the new-hire
triggers (probation case, vacancy autofill) — never do it for a CRM mapping.
