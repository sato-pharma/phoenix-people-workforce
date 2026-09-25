---
name: postgrest-neq-on-an-absent-jsonb-key-matches-nothing
description: "A PostgREST .neq() filter on a jsonb key that is ABSENT on most rows returns ZERO rows, not the rows lacking the key — measured 0 of 390 vs 19 of 390 on production ats_cv_intake_events."
metadata:
  type: reference
---

Flags stamped into `raw_metadata` (`bulkImport`, `historyImport`, …) are written **only when true**
and are **absent**, not `false`, on every other row. So:

```
raw_metadata->>bulkImport=neq.true          ->  0 of 390 rows   (NULL <> 'true' is NULL, not true)
or=(raw_metadata->>bulkImport.is.null,
    raw_metadata->>bulkImport.neq.true)     -> 19 of 390 rows   (390 total - 371 stamped)
```

Measured live against production (`ozucdzovmcqvepbozvqf`) on 2026-08-23, not reasoned about.

**Why it is dangerous here:** the naive form fails *silently and totally*. In
`whatsapp-health.ts` it would make `lastInboundWhatsAppAt()` return null forever, so the intake
health check would report "no inbound message, ever" — an alarm state that looks like a finding
rather than a bug. Any "exclude the flagged rows" filter must carry the explicit `is.null` branch.

**How to apply:** never write a bare `.neq()`/`.not(...,"eq",...)` against a `raw_metadata->>key`
that is conditionally stamped. Use `.or("<path>.is.null,<path>.neq.<value>")`, and prove it with a
`Prefer: count=exact` REST call before trusting it — the counts must add up to the table total.

Related: [[optional-field-written-unconditionally-is-a-silent-erase]] ·
[[a-narrowed-select-disarms-every-gate-downstream-of-it]] ·
[[whatsapp-silence-alert-is-a-weekend-false-positive]]
