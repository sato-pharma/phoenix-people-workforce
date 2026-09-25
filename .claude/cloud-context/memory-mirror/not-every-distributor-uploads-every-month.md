---
name: not-every-distributor-uploads-every-month
description: "A distributor absent from a month's Source of Sales uploads is NORMAL - only some are monthly, so \"N of 17 missing\" is never a finding. Measure the every-month set instead."
metadata: 
  node_type: memory
  type: project
  originSessionId: 08cdc799-599e-461f-8ca6-00dd2a838ee1
  modified: 2026-09-04T20:07:40.383Z
---

**OWNER RULE, stated 2026-09-04: it is not a concept that every distributor uploads every
month.** The big ones are monthly - he named Ibn Sina, overseas (PS), epda and EGD. The rest
send when they send. **So counting a month's uploads against the full distributor list and
reporting the shortfall is a FALSE ALARM**, and it is the shape a session naturally produces:
17 distributors in July, 4 in August, "14 missing" - which reads as a broken month when
nothing is wrong.

**Measure the every-month set instead.** Group `source_of_sales_import_batches`
(`status = 'validated'`) by distributor and period, keep the distributors present in EVERY
prior month, and ask which of those are absent. On 2026-09-04 that was 12 every-month
distributors (Jan-Jul), 2 already in for August, **10 outstanding worth ~6.6M EGP** of typical
monthly import value - Marcyrl 2.55M, Ibn Sina 1.64M and Direct (Company) 1.50M being 5.7M of
it. That is a real, rankable answer; "14 of 17" was not.

**Cadence: files land across the first two weeks, not on the 1st.** July's seventeen arrived
between 2 and 12 August. So a thin upload count in the first week of the following month is
mid-collection, never lateness - do not raise it as one. The closing follows the last file,
not the calendar (the [[closing golden rule]] sets the earliest date, not the actual one).

**Two distributors have simply STOPPED and are not missing files:** `chimipharm` last appeared
in May, `EPDA-BULK` in June. EPDA-BULK averaged 4.83M/month, and EPDA-Pharmacies came in for
August at 12.0M against its own 2.83M average - consistent with one feed folding into the
other, but unconfirmed. Never read a stopped feed as an outstanding one.

Related: [[sos-monthly-closing-is-the-only-sales-truth]] ·
[[head-office-products-are-not-tracked-weekly-golden-rule]] (why import value ~60M collapses to
a ~10M tracked-line rollup, so the two figures are not comparable).
