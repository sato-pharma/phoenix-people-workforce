---
name: never-fix-a-published-and-announced-month
description: "🔒 OWNER RULE 2026-09-07, restated 2026-10-09 as \"never cange a publkished month\" — a closing that has been PUBLISHED is never corrected, however wrong it is. A ruling that arrives late applies to UPCOMING months only. Said first about a correct, measured, owner-ruled fix to July Anti Infective — he refused it; said again the moment a session quoted a pre-July bulk repair in a Next step box. Mechanical for bulk repairs since: src/lib/sales/published-month-guard.ts."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: eb852d60-f518-4906-813c-3edc70fb29da
  modified: 2026-10-09T18:54:11.193Z
---

**His words, 2026-09-07:** *"no donot fix any already published an announced month implement this to be
considered in the upcomings"*

**His words again, 2026-10-09:** *"never cange a publkished month"* — typed the instant a session put
“re-resolve the January to June CNS rows against the customer map” in a `Next step:` box, after a
September repair he had ordered himself. He did not argue the measurement; he refused the shape of the
proposal. **So the trigger is not only "has it been announced" — proposing a bulk rewrite of a closed
month is itself the error**, and the pre-July repair was withdrawn unrun, not parked.

## What it settles

A closing that has been **published and announced to the team** is FINAL. Not "final unless the fix
is small", not "final unless the owner himself ruled the other way" — final. A ruling that arrives
after the announcement is a rule for **upcoming months**, never a correction to a past one.

## Why this one is load-bearing rather than obvious

He was not refusing a speculative change. Every argument for fixing was already made and accepted:

* The placement contradicted **his own ruling** of 2026-08-06 (client `441164`
  ريونيون للتجارةوالاستثمار — the July return belongs across Dakahlia 2 and Port Said – Domiat, not
  Dakahlia 1 where its account sits).
* The correction had been applied once and was **silently destroyed by a re-import** on 2026-08-09,
  the day after July Anti Infective was published — so the published number was an accident, not a
  decision.
* The impact was measured to the piastre and was **line-neutral**: Dakahlia 1 +34,370.00, Dakahlia 2
  −17,185.00, Port Said −17,185.00. Region total, DM total and line total all unchanged.
* One rep's July achievement moved **−22.0% → +41.9%**.

He still said no. **So the trigger for this rule is PUBLISHED-AND-ANNOUNCED, not "is the fix
justified" — and being able to prove the number is wrong is not an exception to it.** A session that
re-derives the justification will reach "we should fix it" every time; the justification is not the
question.

## How to apply

* Never propose retro-fixing a published month again. Present the finding, then propose it as a
  forward rule.
* The reps' numbers are the reason: a published closing has been read, discussed and acted on. Moving
  someone from +20.7% to −12.2% after the fact costs more trust than the wrong number does.
* 🔴 **A LOCK AND A PUBLICATION ARE TWO SWITCHES AND NOTHING PAIRS THEM** — so "the repair skips
  locked files" was never the same promise as "a published month is safe". Since 2026-10-09 the bulk
  customer-map repair reads `monthly_closing_publications` itself
  (`src/lib/sales/published-month-guard.ts`) and refuses an `--apply` that would write into a
  published month, **including the rows it reaches in months nobody asked about** — the repair RPC is
  keyed on (distributor, customer) and ignores the period, so clearing the target month proves
  nothing. It fails CLOSED when the table cannot be read, and a dry run still measures, because
  measuring a month is not changing it. Verified live the same evening: a dry run on published July
  printed the refusal and listed rows in six other months. Pinned by
  `tests/published-month-guard.test.ts`.
* **Unpublished is not the same as open for business.** January–June 2026 carry no publication row at
  all, so the guard does not block them — his 2026-10-09 words still do. Do not re-propose a bulk
  repair of a closed month on the ground that nothing refuses it.
* `monthly_closing_locks` already enforces this mechanically for `source_of_sales_import_rows` and
  `source_of_sales_fact_rollup` — a locked (line, period) refuses every insert, update and delete
  including direct SQL and migrations. **Treat a lock as the owner's decision, not an obstacle to
  route around.** Unlocking one needs him to say so about that specific month, in the live
  conversation.
* Corollary for anything that recomputes live: a rule change is retroactive by default, so it needs a
  start period. See `WAREHOUSE_RULE_FROM_PERIOD` and `STORE_CITY_SPLIT_FROM_PERIOD` in
  [[the-old-monthly-closing-export-is-never-touched]]'s neighbourhood — both exist for this reason.

Related: [[sos-monthly-closing-is-the-only-sales-truth]],
[[a-price-fix-silently-restates-every-published-closing]].

## Confirmed a third time, 2026-10-10 — and this time he was shown exactly what it costs

**His words:** *"leave July and August as published"* — answering a measured, named remainder, not a
proposal to rewrite anything. His five Mapping Guard brick approvals of that night re-pointed 38 CNS
rows (28,762.91 EGP) across January–June and September, and the repair froze three files whole
because July and August CNS are both locked and published. What stayed deliberately wrong:

- **عاطف جرجس محارب** (Ibn sina / 431648) keeps **688.50 EGP in July and 10,361.25 in August** filed
  in مدينة قنا - قنا 2, an area that carries no CNS target at all — see
  [[qena-2-carries-no-cns-target-at-all]]. That money reports against nobody and stays that way.
- **ص : د . سلوى العجمى** (sofico / 1500018109) keeps **448.54 EGP in August** in البساتين instead of
  المعادى — same area, same rep, so nothing but the brick label is wrong.

**11,498.29 EGP total, left wrong on purpose.** So the rule holds even when the correction is proven,
his own approval caused it, the money reports to no one, and the fix is one unlock away. **Never
re-open this** — and when a repair freezes rows in a published month, report the remainder and
recommend leaving it rather than offering the unlock.
