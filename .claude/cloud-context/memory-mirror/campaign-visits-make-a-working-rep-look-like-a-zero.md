---
name: campaign-visits-make-a-working-rep-look-like-a-zero
description: "It is 15 people in Aug 2026, not two: they log ALL field work as campaign (-8), so every measure built on visit_type 0 shows them at 0% while working. RULED 2026-08-27 (#2448, live 7c46bb6a): campaign is counted BESIDE Doctor Coverage, never inside it. Plan-vs-actual still counts type 0 only - that half is unchanged."
metadata: 
  node_type: memory
  type: project
  originSessionId: 041380be-16bd-4e62-ae56-78a31b8b9046
  modified: 2026-08-27T08:22:52.750Z
---

Measured on production 2026-08-21 for August 2026, on the new Rep Doctor Lists board
(`/admin/rep-doctor-lists`, PR #2259):

| CRM agent | vendor name | Aug visits | type 0 | type -8 (campaign) |
| --- | --- | --- | --- | --- |
| 1523 | Mohamed.Khaled ( Fayum / A ) | 113 | **0** | 112 (+1 type -2) |
| 1550 | Hanan.Safwat ( Bani Sweif / A ) | 62 | **0** | 62 |

`CAMPAIGN_TYPE = -8` (`src/lib/crm/visit-types.ts`).

**CORRECTED 2026-08-21 (same day, verified against production):** only **1550** ever renders on
this board. **1523 does not appear on it at all** — `crm_id 1523` is on the hard-floor
`CRM_RESIGNED_AGENT_CRM_IDS` list in `src/lib/crm/reads.ts`, so the CRM reads door drops him from
BOTH sides before the board sees him. He is an ACTIVE employee (AI-0011, Mohamed Khaled, Medical
Representative) and that exclusion is the sixth instance of the reused-slot bug — see
[[crm-resigned-slot-reused-for-new-hire]], which now carries the evidence. His real plan is 21
contacts, not the 51 first recorded here.

1550 has 59 planned doctors across 63 plan rows and renders at **0% adherence**. That is literally
true — no *regular customer visits* to planned doctors — but it reads as "did nothing" when they
worked a full month.

**Why:** every plan-vs-actual measure in this codebase counts `visit_type = 0` only, matching
Doctor Coverage and DV Analytics. That was a deliberate choice for consistency, NOT an owner ruling
about campaigns.

**How to apply:** before showing anyone a low-adherence rep, check whether their month is campaign
work. Do not "fix" the type-0 filter to include -8 on your own — whether a campaign call satisfies a
planned doctor call is a business decision only the owner can make, and changing the filter would
silently move Doctor Coverage's numbers too. Ask him; the same question also decides whether
[[ireports360-undocumented-visit-type-codes]] should feed adherence at all.

Two knock-on effects seen on the same board:
- Agent 1550 displays as "Unmapped CRM agent 1550" because they have no `agent_hr_id` AND no type-0
  visit in the window, so neither the directory nor the vendor-name fallback can name them. 9 agents
  in total had a NULL `agent_hr_id` on the August plan (854 of 18,645 planned calls).
- A rep with visits but NO plan sorts into the worst-first rep table at 0%, which is an accusation
  the data does not support — a rep with nothing planned is not a 0% performer.

Related: [[crm-visit-type-maps-there-are-three-not-two]] ·
[[public-holiday-and-casual-leave-are-working-days]]

## RE-MEASURED 2026-08-27 — it is 15 people this month, not two

The count in this file's own headline was two. Measured live against
`ireports360_visits_effective`, people with **zero** regular visits and non-zero campaign work:

| Month | People reading as a flat zero | Largest single case |
| --- | --- | --- |
| June 2026 | 24 | Batool.Rafiq (Dakahlia 1) — 320 campaign calls |
| July 2026 | 22 | Engy.Said (Cairo East 1) — 374 campaign calls |
| August 2026 | 15 | Mohamed.Khaled (Fayum) — 160 campaign calls |

**A stale count in a memory is more dangerous than no count**, because it reads as measured fact.
Re-measure before quoting any figure from this file.

**The fix was NOT simply "count campaign too" — and that reasoning is exactly what shipped.** Coverage
is scored by doctor GRADE, and `src/lib/crm/sfe-doctor-coverage.ts` states the constraint: grade and
speciality are NULL on every visit type except 0. So campaign rows cannot be graded — counting them
would need a different measure, not a wider filter. `src/lib/crm/rep-doctor-lists.ts` takes the same
type-0-only actual side.

Some of these names are product managers, not medical reps (`( PM / P )`, `( P.M / F )`), so the
headline number is an upper bound on affected FIELD staff. Do not quote it as "15 reps" — the two
boards key a rep differently, and joining CRM agent names to employees is its own trap. See
[[crm-boards-key-the-same-rep-two-different-ways]].

## RULED AND SHIPPED 2026-08-27 — beside coverage, never inside it

The open question above is **closed**. PR #2448 merged as `7c46bb6a` and was verified live in
production at 08:01 Cairo (`/api/healthz` → `revision: 7c46bb6a`). The ruling: **campaign calls are
counted BESIDE doctor coverage, never inside it.**

What that means in the code (`src/lib/crm/sfe-doctor-coverage.ts`):

- `campaignCalls` per rep and `repsAllCampaign` in the totals, as their **own column**.
- `hasPanel` is false when a rep has no graded doctors, so the board says **"no panel"** instead of
  printing a `0%` that reads as a grade. That was the actual defect — not the filter.
- Coverage itself is **untouched and asserted so**: `coveragePct`, `panelSize`, `activePanel`,
  `visitsCounted` and `ungradedContacts` are all pinned unchanged when campaign visits are folded in.
- Contact id `0` / blank name is the campaign **sentinel**, not an ungraded doctor for anyone to
  chase.
- A rep with no HR mapping is kept, keyed by CRM id, rather than dropped.

**Still true, do not undo:** plan-vs-actual (`rep-doctor-lists.ts`) counts `visit_type = 0` only.
This ruling covered Doctor Coverage, **not** adherence — the "How to apply" advice above still holds
for every other measure, and whether a campaign call satisfies a *planned* doctor call remains the
owner's to decide.

Guarded by 123 lines in `tests/sfe-doctor-coverage.test.ts` (registered `tests/run-tests.ts:779`,
invoked `:2009`). Related: [[crm-coverage-and-frequency-are-two-kpis-that-disagree]].
