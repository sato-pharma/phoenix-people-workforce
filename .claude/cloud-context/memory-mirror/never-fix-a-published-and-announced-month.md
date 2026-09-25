---
name: never-fix-a-published-and-announced-month
description: "🔒 OWNER RULE 2026-09-07 — a closing that has been PUBLISHED AND ANNOUNCED is never corrected, however wrong it is. A ruling that arrives late applies to UPCOMING months only. Said in response to a correct, measured, owner-ruled fix to July Anti Infective — he refused it."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: eb852d60-f518-4906-813c-3edc70fb29da
  modified: 2026-09-06T21:37:20.228Z
---

**His words, 2026-09-07:** *"no donot fix any already published an announced month implement this to be
considered in the upcomings"*

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
